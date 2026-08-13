#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{
    self, BurnChecked, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use deal_core::state::{DealAccount, DealRegistry, DealStatus, DepositKind, Vote};
use deal_credit_graph::{CreditScore, SCORE_SEED};
use deal_identity::{DealIdentityBinding, IdentityRecord};
use deal_terminal_guard::{validate_current_and_following, ExpectedInstruction};

pub mod errors;
pub mod state;

use errors::AssetControllerError;
use state::*;

declare_id!("7XAP5nhk6tsEkwHRuXDvKEobRVw9YLstALs2ZCJZmv5T");

pub const CONTROLLER_SEED: &[u8] = b"asset-controller";
pub const TERMS_SEED: &[u8] = b"asset-terms";
const FINALIZER_PROGRAM_ID: Pubkey = pubkey!("7m8WXGUfwnuyxi2GmzNepfkrXgsCAurTKvANSdPqZXzG");
const CAST_VOTE_AND_RESOLVE_DISC: [u8; 8] = [0xe6, 0x79, 0x53, 0x08, 0xf9, 0x17, 0x5a, 0x2d];
const RESOLVE_VOTES_DISC: [u8; 8] = [0xdf, 0xfd, 0xb5, 0xb0, 0x54, 0x97, 0xee, 0xea];
const FORCE_COMPLETE_DISC: [u8; 8] = [0x55, 0x74, 0x16, 0x56, 0xef, 0xa8, 0x69, 0x66];
const ABANDON_DISC: [u8; 8] = [0xb2, 0xc5, 0xa5, 0xe3, 0x02, 0x4e, 0xb5, 0xc2];
const ROUTE_DC_FEES_DISC: [u8; 8] = [0x77, 0xd1, 0x03, 0xe7, 0x72, 0xd7, 0x7d, 0x4a];
const FINALIZE_COMPLETED_DISC: [u8; 8] = [0x85, 0xfe, 0x5c, 0x8c, 0xd1, 0xca, 0x2c, 0xe9];
const FINALIZE_NON_COMPLETED_DISC: [u8; 8] = [0x42, 0x54, 0xf8, 0x26, 0xd8, 0xf9, 0x1b, 0x49];

#[program]
pub mod deal_asset_controller {
    use super::*;

    pub fn initialize_controller(
        ctx: Context<InitializeController>,
        treasury: Pubkey,
        dc_mint: Pubkey,
        fee_numerator: u32,
        fee_denominator: u32,
    ) -> Result<()> {
        require!(
            treasury != Pubkey::default() && dc_mint != Pubkey::default(),
            AssetControllerError::ZeroAuthority
        );
        ControllerConfig::validate_fee(fee_numerator, fee_denominator)?;
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.treasury = treasury;
        config.dc_mint = dc_mint;
        config.fee_numerator = fee_numerator;
        config.fee_denominator = fee_denominator;
        config.terminal_guard_enabled = false;
        config.paused = true;
        config.bump = ctx.bumps.config;
        emit!(ControllerInitialized {
            authority: config.authority,
            treasury,
            dc_mint,
            fee_numerator,
            fee_denominator,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.paused = paused;
        emit!(PauseUpdated { paused });
        Ok(())
    }

    pub fn set_fee(ctx: Context<AdminConfig>, numerator: u32, denominator: u32) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ControllerConfig::validate_fee(numerator, denominator)?;
        ctx.accounts.config.fee_numerator = numerator;
        ctx.accounts.config.fee_denominator = denominator;
        emit!(FeeUpdated {
            numerator,
            denominator,
        });
        Ok(())
    }

    pub fn set_terminal_guard(ctx: Context<AdminConfig>, enabled: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.terminal_guard_enabled = enabled;
        emit!(TerminalGuardUpdated { enabled });
        Ok(())
    }

    pub fn set_treasury(ctx: Context<AdminConfig>, treasury: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            treasury != Pubkey::default(),
            AssetControllerError::ZeroAuthority
        );
        let old_treasury = ctx.accounts.config.treasury;
        ctx.accounts.config.treasury = treasury;
        emit!(TreasuryUpdated {
            old_treasury,
            new_treasury: treasury,
        });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            AssetControllerError::ZeroAuthority
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(AuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            AssetControllerError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = Pubkey::default();
        emit!(AuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority,
        });
        Ok(())
    }

    pub fn configure_terms(
        ctx: Context<ConfigureTerms>,
        params: ConfigureTermsParams,
    ) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        let deal = &ctx.accounts.deal;
        require_keys_eq!(
            deal.creator,
            ctx.accounts.creator.key(),
            AssetControllerError::InvalidCreator
        );
        params.a_swap.validate_for_amount(deal.a_swap_amount)?;
        params.a_margin.validate_for_amount(deal.a_margin_amount)?;
        params.b_swap.validate_for_amount(deal.b_swap_amount)?;
        params.b_margin.validate_for_amount(deal.b_margin_amount)?;
        params.a_asset_nft.validate_nft(deal.a_asset_required)?;
        params.b_asset_nft.validate_nft(deal.b_asset_required)?;
        ctx.accounts
            .terms
            .initialize(deal.key(), deal.creator, ctx.bumps.terms, params);
        emit!(TermsConfigured {
            deal: deal.key(),
            creator: deal.creator,
        });
        Ok(())
    }

    pub fn join_gated_deal(ctx: Context<JoinGatedDeal>) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        require_keys_eq!(
            ctx.accounts.core_registry.identity_controller,
            ctx.accounts.config.key(),
            AssetControllerError::InvalidIdentityController
        );
        require_keys_eq!(
            ctx.accounts.owner_identity.owner,
            ctx.accounts.participant.key(),
            AssetControllerError::InvalidIdentityOwner
        );
        require_keys_eq!(
            ctx.accounts.owner_identity.mint,
            ctx.accounts.identity.mint,
            AssetControllerError::InvalidIdentityOwner
        );
        require_eq!(
            ctx.accounts.owner_identity.amount,
            1,
            AssetControllerError::InvalidIdentityOwner
        );
        let seeds = controller_signer_seeds(&ctx.accounts.config);
        deal_core::cpi::join_gated_deal(CpiContext::new_with_signer(
            ctx.accounts.core_program.key(),
            deal_core::cpi::accounts::JoinGatedDeal {
                participant: ctx.accounts.participant.to_account_info(),
                identity_controller: ctx.accounts.config.to_account_info(),
                registry: ctx.accounts.core_registry.to_account_info(),
                deal: ctx.accounts.deal.to_account_info(),
            },
            &[&seeds],
        ))?;
        ctx.accounts.deal.reload()?;
        Ok(())
    }

    pub fn lock_identity(ctx: Context<ManageIdentity>) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        validate_identity_controller(&ctx.accounts.config, &ctx.accounts.identity_config)?;
        let tracked_identity = tracked_identity_for_actor_mut(
            &ctx.accounts.deal,
            ctx.accounts.deal.key(),
            &mut ctx.accounts.terms,
            ctx.accounts.actor.key(),
        )?;
        require!(
            *tracked_identity == Pubkey::default()
                || *tracked_identity == ctx.accounts.identity_mint.key(),
            AssetControllerError::IdentityAlreadyTracked
        );
        let seeds = controller_signer_seeds(&ctx.accounts.config);
        deal_identity::cpi::lock_identity(CpiContext::new_with_signer(
            ctx.accounts.identity_program.key(),
            deal_identity::cpi::accounts::LockIdentity {
                config: ctx.accounts.identity_config.to_account_info(),
                payer: ctx.accounts.actor.to_account_info(),
                controller: ctx.accounts.config.to_account_info(),
                deal: ctx.accounts.deal.to_account_info(),
                owner: ctx.accounts.actor.to_account_info(),
                identity_mint: ctx.accounts.identity_mint.to_account_info(),
                owner_identity: ctx.accounts.owner_identity.to_account_info(),
                identity: ctx.accounts.identity.to_account_info(),
                binding: ctx.accounts.binding.to_account_info(),
                lock: ctx.accounts.lock.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[&seeds],
        ))?;
        *tracked_identity = ctx.accounts.identity_mint.key();
        Ok(())
    }

    pub fn unlock_identity(ctx: Context<ManageIdentity>) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        validate_identity_controller(&ctx.accounts.config, &ctx.accounts.identity_config)?;
        require!(
            matches!(
                ctx.accounts.deal.status,
                DealStatus::Completed | DealStatus::Canceled | DealStatus::Abandoned
            ),
            AssetControllerError::DealNotTerminal
        );
        let tracked_identity = tracked_identity_for_mint_mut(
            &mut ctx.accounts.terms,
            ctx.accounts.identity_mint.key(),
        )?;
        let seeds = controller_signer_seeds(&ctx.accounts.config);
        deal_identity::cpi::unlock_identity(CpiContext::new_with_signer(
            ctx.accounts.identity_program.key(),
            deal_identity::cpi::accounts::UnlockIdentity {
                config: ctx.accounts.identity_config.to_account_info(),
                controller: ctx.accounts.config.to_account_info(),
                deal: ctx.accounts.deal.to_account_info(),
                identity_mint: ctx.accounts.identity_mint.to_account_info(),
                owner_identity: ctx.accounts.owner_identity.to_account_info(),
                identity: ctx.accounts.identity.to_account_info(),
                binding: ctx.accounts.binding.to_account_info(),
                lock: ctx.accounts.lock.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
            &[&seeds],
        ))?;
        *tracked_identity = Pubkey::default();
        Ok(())
    }

    pub fn deposit_funds(ctx: Context<DepositFunds>, is_party_a: bool) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        require!(
            !ctx.accounts.terms.resolved,
            AssetControllerError::AlreadyResolved
        );
        validate_actor_side(&ctx.accounts.deal, ctx.accounts.actor.key(), is_party_a)?;
        let already = if is_party_a {
            ctx.accounts.terms.a_funds_escrowed
        } else {
            ctx.accounts.terms.b_funds_escrowed
        };
        require!(!already, AssetControllerError::FundsAlreadyEscrowed);

        let (swap, swap_amount, margin, margin_amount) = if is_party_a {
            (
                ctx.accounts.terms.a_swap,
                ctx.accounts.deal.a_swap_amount,
                ctx.accounts.terms.a_margin,
                ctx.accounts.deal.a_margin_amount,
            )
        } else {
            (
                ctx.accounts.terms.b_swap,
                ctx.accounts.deal.b_swap_amount,
                ctx.accounts.terms.b_margin,
                ctx.accounts.deal.b_margin_amount,
            )
        };

        transfer_component_in(
            swap,
            swap_amount,
            &ctx.accounts.actor.to_account_info(),
            &ctx.accounts.swap_source,
            &ctx.accounts.swap_vault,
            &ctx.accounts.swap_mint,
            &ctx.accounts.token_program,
            &ctx.accounts.system_program,
            &ctx.accounts.terms.to_account_info(),
        )?;
        transfer_component_in(
            margin,
            margin_amount,
            &ctx.accounts.actor.to_account_info(),
            &ctx.accounts.margin_source,
            &ctx.accounts.margin_vault,
            &ctx.accounts.margin_mint,
            &ctx.accounts.token_program,
            &ctx.accounts.system_program,
            &ctx.accounts.terms.to_account_info(),
        )?;

        cpi_record_deposit(
            &ctx.accounts.config,
            &ctx.accounts.actor,
            &ctx.accounts.core_registry,
            &ctx.accounts.deal,
            &ctx.accounts.core_program,
            is_party_a,
            DepositKind::Funds,
        )?;
        ctx.accounts.deal.reload()?;
        if is_party_a {
            ctx.accounts.terms.a_funds_escrowed = true;
        } else {
            ctx.accounts.terms.b_funds_escrowed = true;
            ctx.accounts.terms.b_depositor = ctx.accounts.actor.key();
        }
        emit!(FundsDeposited {
            deal: ctx.accounts.deal.key(),
            actor: ctx.accounts.actor.key(),
            is_party_a,
            swap_amount,
            margin_amount,
        });
        Ok(())
    }

    pub fn deposit_asset_nft(ctx: Context<DepositNft>, is_party_a: bool) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        require!(
            !ctx.accounts.terms.resolved,
            AssetControllerError::AlreadyResolved
        );
        validate_actor_side(&ctx.accounts.deal, ctx.accounts.actor.key(), is_party_a)?;
        let (spec, already) = if is_party_a {
            (
                ctx.accounts.terms.a_asset_nft,
                ctx.accounts.terms.a_nft_escrowed,
            )
        } else {
            (
                ctx.accounts.terms.b_asset_nft,
                ctx.accounts.terms.b_nft_escrowed,
            )
        };
        require!(!already, AssetControllerError::NftAlreadyEscrowed);
        require!(
            spec.kind == AssetKind::Spl,
            AssetControllerError::InvalidNftSpec
        );
        validate_nft_mint(&ctx.accounts.mint, &ctx.accounts.token_program)?;
        transfer_spl_in(
            spec,
            1,
            &ctx.accounts.actor.to_account_info(),
            &ctx.accounts.source,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            &ctx.accounts.token_program,
        )?;
        cpi_record_deposit(
            &ctx.accounts.config,
            &ctx.accounts.actor,
            &ctx.accounts.core_registry,
            &ctx.accounts.deal,
            &ctx.accounts.core_program,
            is_party_a,
            DepositKind::AssetNft,
        )?;
        ctx.accounts.deal.reload()?;
        if is_party_a {
            ctx.accounts.terms.a_nft_escrowed = true;
        } else {
            ctx.accounts.terms.b_nft_escrowed = true;
            ctx.accounts.terms.b_depositor = ctx.accounts.actor.key();
        }
        emit!(NftDeposited {
            deal: ctx.accounts.deal.key(),
            actor: ctx.accounts.actor.key(),
            is_party_a,
            mint: spec.mint,
        });
        Ok(())
    }

    pub fn withdraw_side(ctx: Context<ResolveAssets>, is_party_a: bool) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        validate_actor_side(&ctx.accounts.deal, ctx.accounts.caller.key(), is_party_a)?;
        require!(
            side_has_escrow(&ctx.accounts.terms, is_party_a),
            AssetControllerError::NothingEscrowed
        );
        cpi_record_withdrawal(
            &ctx.accounts.config,
            &ctx.accounts.caller,
            &ctx.accounts.core_registry,
            &ctx.accounts.deal,
            &ctx.accounts.core_program,
            is_party_a,
        )?;
        ctx.accounts.deal.reload()?;
        refund_side(ctx.accounts, is_party_a)?;
        emit!(SideRefunded {
            deal: ctx.accounts.deal.key(),
            recipient: ctx.accounts.caller.key(),
            is_party_a,
            reason: 0,
        });
        Ok(())
    }

    pub fn exit_by_b(ctx: Context<ResolveAssets>) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        require_keys_eq!(
            ctx.accounts.deal.participant,
            ctx.accounts.caller.key(),
            AssetControllerError::InvalidParticipant
        );
        cpi_exit_by_b(ctx.accounts)?;
        ctx.accounts.deal.reload()?;
        refund_side(ctx.accounts, true)?;
        refund_side(ctx.accounts, false)?;
        Ok(())
    }

    pub fn kick_b_by_a(ctx: Context<ResolveAssets>) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        require_keys_eq!(
            ctx.accounts.deal.creator,
            ctx.accounts.caller.key(),
            AssetControllerError::InvalidCreator
        );
        cpi_kick_b_by_a(ctx.accounts)?;
        ctx.accounts.deal.reload()?;
        refund_side(ctx.accounts, true)?;
        refund_side(ctx.accounts, false)?;
        Ok(())
    }

    pub fn replace_inactive_b(ctx: Context<ResolveAssets>) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        let old_participant = ctx.accounts.deal.participant;
        require_keys_eq!(
            old_participant,
            ctx.accounts.participant.key(),
            AssetControllerError::InvalidParticipant
        );
        cpi_replace_inactive_b(ctx.accounts)?;
        ctx.accounts.deal.reload()?;
        refund_side_to(ctx.accounts, false, old_participant)?;
        Ok(())
    }

    pub fn replace_non_voting_b(ctx: Context<ResolveAssets>) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        let old_participant = ctx.accounts.deal.participant;
        require_keys_eq!(
            old_participant,
            ctx.accounts.participant.key(),
            AssetControllerError::InvalidParticipant
        );
        cpi_replace_non_voting_b(ctx.accounts)?;
        ctx.accounts.deal.reload()?;
        refund_side_to(ctx.accounts, false, old_participant)?;
        Ok(())
    }

    pub fn abandon(ctx: Context<ResolveAssets>) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        require_keys_eq!(
            ctx.accounts.deal.creator,
            ctx.accounts.caller.key(),
            AssetControllerError::InvalidCreator
        );
        validate_terminal_sequence(ctx.accounts, ABANDON_DISC, false)?;
        cpi_abandon(ctx.accounts)?;
        ctx.accounts.deal.reload()?;
        refund_side(ctx.accounts, true)?;
        refund_side(ctx.accounts, false)?;
        ctx.accounts.terms.resolved = true;
        Ok(())
    }

    pub fn cast_vote_and_resolve(ctx: Context<ResolveAssets>, vote: Vote) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        cpi_cast_vote(ctx.accounts, vote)?;
        ctx.accounts.deal.reload()?;
        resolve_if_ready(ctx.accounts)?;
        validate_if_terminal(ctx.accounts, CAST_VOTE_AND_RESOLVE_DISC)
    }

    pub fn resolve_votes(ctx: Context<ResolveAssets>) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        resolve_if_ready(ctx.accounts)?;
        validate_if_terminal(ctx.accounts, RESOLVE_VOTES_DISC)
    }

    pub fn force_complete(ctx: Context<ResolveAssets>) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        validate_terminal_sequence(ctx.accounts, FORCE_COMPLETE_DISC, true)?;
        cpi_force_complete(ctx.accounts)?;
        ctx.accounts.deal.reload()?;
        complete_assets(ctx.accounts)
    }

    pub fn route_dc_fees(ctx: Context<RouteDcFees>) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        require!(
            ctx.accounts.deal.status == DealStatus::Completed && ctx.accounts.terms.resolved,
            AssetControllerError::DcFeesNotPending
        );
        require!(
            !ctx.accounts.terms.dc_fees_routed,
            AssetControllerError::DcFeesAlreadyRouted
        );
        require!(
            is_dc_to_dc(
                &ctx.accounts.config,
                &ctx.accounts.terms,
                &ctx.accounts.deal
            ),
            AssetControllerError::DcFeesNotPending
        );
        require_keys_eq!(
            ctx.accounts.dc_mint.key(),
            ctx.accounts.config.dc_mint,
            AssetControllerError::InvalidTokenAccount
        );

        let a = validate_fee_identity_side(
            ctx.accounts.deal.key(),
            &ctx.accounts.deal,
            &ctx.accounts.terms,
            true,
            ctx.accounts.a_identity.as_ref().map(|value| value.key()),
            ctx.accounts.a_identity.as_deref().map(|value| &**value),
            ctx.accounts
                .a_identity_token
                .as_deref()
                .map(|value| &**value),
            ctx.accounts.a_binding.as_ref().map(|value| value.key()),
            ctx.accounts.a_binding.as_deref().map(|value| &**value),
            ctx.accounts.a_credit.as_ref(),
        )?;
        let b = validate_fee_identity_side(
            ctx.accounts.deal.key(),
            &ctx.accounts.deal,
            &ctx.accounts.terms,
            false,
            ctx.accounts.b_identity.as_ref().map(|value| value.key()),
            ctx.accounts.b_identity.as_deref().map(|value| &**value),
            ctx.accounts
                .b_identity_token
                .as_deref()
                .map(|value| &**value),
            ctx.accounts.b_binding.as_ref().map(|value| value.key()),
            ctx.accounts.b_binding.as_deref().map(|value| &**value),
            ctx.accounts.b_credit.as_ref(),
        )?;
        let (c_identity_mint, c_score) = resolve_fee_c(a, b);
        let c_recipient = validate_fee_c_recipient(
            c_identity_mint,
            ctx.accounts.c_identity.as_ref().map(|value| value.key()),
            ctx.accounts.c_identity.as_deref().map(|value| &**value),
            ctx.accounts
                .c_identity_token
                .as_deref()
                .map(|value| &**value),
            ctx.accounts
                .c_dc_destination
                .as_deref()
                .map(|value| &**value),
            ctx.accounts.config.dc_mint,
        )?;

        if c_identity_mint == Pubkey::default() {
            burn_fee_out(
                ctx.accounts.terms.a_swap,
                ctx.accounts.terms.a_fee_paid,
                &ctx.accounts.a_swap_vault,
                &ctx.accounts.dc_mint.to_account_info(),
                &ctx.accounts.token_program,
                &ctx.accounts.config,
            )?;
            burn_fee_out(
                ctx.accounts.terms.b_swap,
                ctx.accounts.terms.b_fee_paid,
                &ctx.accounts.b_swap_vault,
                &ctx.accounts.dc_mint.to_account_info(),
                &ctx.accounts.token_program,
                &ctx.accounts.config,
            )?;
        } else {
            let destination = ctx
                .accounts
                .c_dc_destination
                .as_deref()
                .ok_or_else(|| error!(AssetControllerError::InvalidCRecipient))?;
            transfer_spl_out(
                ctx.accounts.terms.a_swap,
                ctx.accounts.terms.a_fee_paid,
                c_recipient,
                &ctx.accounts.a_swap_vault,
                &ctx.accounts.dc_mint.to_account_info(),
                &destination.to_account_info(),
                &ctx.accounts.token_program,
                &ctx.accounts.config,
            )?;
            transfer_spl_out(
                ctx.accounts.terms.b_swap,
                ctx.accounts.terms.b_fee_paid,
                c_recipient,
                &ctx.accounts.b_swap_vault,
                &ctx.accounts.dc_mint.to_account_info(),
                &destination.to_account_info(),
                &ctx.accounts.token_program,
                &ctx.accounts.config,
            )?;
        }
        ctx.accounts.terms.dc_fees_routed = true;
        emit!(DcFeesRouted {
            deal: ctx.accounts.deal.key(),
            c_identity_mint,
            c_recipient,
            c_score,
            amount: ctx
                .accounts
                .terms
                .a_fee_paid
                .checked_add(ctx.accounts.terms.b_fee_paid)
                .ok_or_else(|| error!(AssetControllerError::MathOverflow))?,
            burned: c_identity_mint == Pubkey::default(),
        });
        validate_routed_fee_sequence(ctx.accounts)
    }
}

fn validate_if_terminal(
    accounts: &ResolveAssets<'_>,
    current_discriminator: [u8; 8],
) -> Result<()> {
    match accounts.deal.status {
        DealStatus::Completed => validate_terminal_sequence(accounts, current_discriminator, true),
        DealStatus::Canceled | DealStatus::Abandoned => {
            validate_terminal_sequence(accounts, current_discriminator, false)
        }
        _ => Ok(()),
    }
}

fn validate_terminal_sequence(
    accounts: &ResolveAssets<'_>,
    current_discriminator: [u8; 8],
    completed: bool,
) -> Result<()> {
    if !accounts.config.terminal_guard_enabled {
        return Ok(());
    }
    let next = if completed && is_dc_to_dc(&accounts.config, &accounts.terms, &accounts.deal) {
        ExpectedInstruction::anchor(crate::ID, ROUTE_DC_FEES_DISC).account(3, accounts.deal.key())
    } else if completed {
        ExpectedInstruction::anchor(FINALIZER_PROGRAM_ID, FINALIZE_COMPLETED_DISC)
            .account(2, accounts.deal.key())
    } else {
        ExpectedInstruction::anchor(FINALIZER_PROGRAM_ID, FINALIZE_NON_COMPLETED_DISC)
            .account(2, accounts.deal.key())
    };
    validate_current_and_following(
        &accounts.instructions_sysvar.to_account_info(),
        crate::ID,
        current_discriminator,
        &[next],
    )
    .map_err(Into::into)
}

fn resolve_if_ready(accounts: &mut ResolveAssets<'_>) -> Result<()> {
    let a_vote = accounts.deal.a_vote;
    let b_vote = accounts.deal.b_vote;
    if a_vote == Vote::Accept && b_vote == Vote::Accept {
        cpi_settle_votes(accounts)?;
        accounts.deal.reload()?;
        return complete_assets(accounts);
    }
    if a_vote == Vote::Reject && b_vote == Vote::Reject {
        cpi_settle_votes(accounts)?;
        accounts.deal.reload()?;
        refund_side(accounts, true)?;
        refund_side(accounts, false)?;
        accounts.terms.resolved = true;
        return Ok(());
    }
    if accounts.deal.open_token_token_fast && b_vote == Vote::Reject {
        let old_participant = accounts.deal.participant;
        cpi_settle_votes(accounts)?;
        accounts.deal.reload()?;
        refund_side_to(accounts, false, old_participant)?;
        return Ok(());
    }
    Ok(())
}

fn complete_assets(accounts: &mut ResolveAssets<'_>) -> Result<()> {
    require!(
        accounts.deal.status == DealStatus::Completed,
        AssetControllerError::NothingToResolve
    );
    require!(
        !accounts.terms.resolved,
        AssetControllerError::AlreadyResolved
    );
    let (a_fee, b_fee) = accounts.config.swap_fees(
        accounts.terms.a_swap,
        accounts.deal.a_swap_amount,
        accounts.terms.b_swap,
        accounts.deal.b_swap_amount,
    )?;
    let both_dc = is_dc_to_dc(&accounts.config, &accounts.terms, &accounts.deal);
    let a_net = accounts
        .deal
        .a_swap_amount
        .checked_sub(a_fee)
        .ok_or_else(|| error!(AssetControllerError::MathOverflow))?;
    let b_net = accounts
        .deal
        .b_swap_amount
        .checked_sub(b_fee)
        .ok_or_else(|| error!(AssetControllerError::MathOverflow))?;

    if accounts.terms.a_funds_escrowed {
        transfer_component_out(
            accounts.terms.a_swap,
            a_net,
            accounts.deal.participant,
            &accounts.a_swap_vault,
            &accounts.a_swap_mint,
            &accounts.a_swap_user,
            &accounts.token_program,
            &accounts.config,
            &accounts.terms.to_account_info(),
        )?;
        if !both_dc {
            transfer_fee_out(
                accounts.terms.a_swap,
                a_fee,
                &accounts.a_swap_vault,
                &accounts.a_swap_mint,
                &accounts.a_swap_fee,
                &accounts.token_program,
                &accounts.config,
                &accounts.terms.to_account_info(),
            )?;
        }
        transfer_component_out(
            accounts.terms.a_margin,
            accounts.deal.a_margin_amount,
            accounts.deal.creator,
            &accounts.a_margin_vault,
            &accounts.a_margin_mint,
            &accounts.a_margin_user,
            &accounts.token_program,
            &accounts.config,
            &accounts.terms.to_account_info(),
        )?;
        accounts.terms.a_funds_escrowed = false;
    }
    if accounts.terms.b_funds_escrowed {
        transfer_component_out(
            accounts.terms.b_swap,
            b_net,
            accounts.deal.creator,
            &accounts.b_swap_vault,
            &accounts.b_swap_mint,
            &accounts.b_swap_user,
            &accounts.token_program,
            &accounts.config,
            &accounts.terms.to_account_info(),
        )?;
        if !both_dc {
            transfer_fee_out(
                accounts.terms.b_swap,
                b_fee,
                &accounts.b_swap_vault,
                &accounts.b_swap_mint,
                &accounts.b_swap_fee,
                &accounts.token_program,
                &accounts.config,
                &accounts.terms.to_account_info(),
            )?;
        }
        transfer_component_out(
            accounts.terms.b_margin,
            accounts.deal.b_margin_amount,
            accounts.deal.participant,
            &accounts.b_margin_vault,
            &accounts.b_margin_mint,
            &accounts.b_margin_user,
            &accounts.token_program,
            &accounts.config,
            &accounts.terms.to_account_info(),
        )?;
        accounts.terms.b_funds_escrowed = false;
    }
    if accounts.terms.a_nft_escrowed {
        transfer_spl_out(
            accounts.terms.a_asset_nft,
            1,
            accounts.deal.participant,
            &accounts.a_nft_vault,
            &accounts.a_nft_mint,
            &accounts.a_nft_user,
            &accounts.token_program,
            &accounts.config,
        )?;
        accounts.terms.a_nft_escrowed = false;
    }
    if accounts.terms.b_nft_escrowed {
        transfer_spl_out(
            accounts.terms.b_asset_nft,
            1,
            accounts.deal.creator,
            &accounts.b_nft_vault,
            &accounts.b_nft_mint,
            &accounts.b_nft_user,
            &accounts.token_program,
            &accounts.config,
        )?;
        accounts.terms.b_nft_escrowed = false;
    }
    accounts.terms.b_depositor = Pubkey::default();
    accounts.terms.a_fee_paid = a_fee;
    accounts.terms.b_fee_paid = b_fee;
    accounts.terms.resolved = true;
    accounts.terms.dc_fees_routed = !both_dc;
    emit!(AssetsSettled {
        deal: accounts.deal.key(),
        a_fee,
        b_fee,
    });
    Ok(())
}

fn is_dc_to_dc(config: &ControllerConfig, terms: &AssetTerms, deal: &DealAccount) -> bool {
    deal.a_swap_amount > 0
        && deal.b_swap_amount > 0
        && terms.a_swap.kind == AssetKind::Spl
        && terms.b_swap.kind == AssetKind::Spl
        && terms.a_swap.mint == config.dc_mint
        && terms.b_swap.mint == config.dc_mint
}

fn refund_side(accounts: &mut ResolveAssets<'_>, is_party_a: bool) -> Result<()> {
    let recipient = if is_party_a {
        accounts.deal.creator
    } else if accounts.terms.b_depositor != Pubkey::default() {
        accounts.terms.b_depositor
    } else {
        accounts.deal.participant
    };
    refund_side_to(accounts, is_party_a, recipient)
}

fn refund_side_to(
    accounts: &mut ResolveAssets<'_>,
    is_party_a: bool,
    recipient: Pubkey,
) -> Result<()> {
    if is_party_a {
        if accounts.terms.a_funds_escrowed {
            transfer_component_out(
                accounts.terms.a_swap,
                accounts.deal.a_swap_amount,
                recipient,
                &accounts.a_swap_vault,
                &accounts.a_swap_mint,
                &accounts.a_swap_user,
                &accounts.token_program,
                &accounts.config,
                &accounts.terms.to_account_info(),
            )?;
            transfer_component_out(
                accounts.terms.a_margin,
                accounts.deal.a_margin_amount,
                recipient,
                &accounts.a_margin_vault,
                &accounts.a_margin_mint,
                &accounts.a_margin_user,
                &accounts.token_program,
                &accounts.config,
                &accounts.terms.to_account_info(),
            )?;
            accounts.terms.a_funds_escrowed = false;
        }
        if accounts.terms.a_nft_escrowed {
            transfer_spl_out(
                accounts.terms.a_asset_nft,
                1,
                recipient,
                &accounts.a_nft_vault,
                &accounts.a_nft_mint,
                &accounts.a_nft_user,
                &accounts.token_program,
                &accounts.config,
            )?;
            accounts.terms.a_nft_escrowed = false;
        }
    } else {
        if accounts.terms.b_funds_escrowed {
            transfer_component_out(
                accounts.terms.b_swap,
                accounts.deal.b_swap_amount,
                recipient,
                &accounts.b_swap_vault,
                &accounts.b_swap_mint,
                &accounts.b_swap_user,
                &accounts.token_program,
                &accounts.config,
                &accounts.terms.to_account_info(),
            )?;
            transfer_component_out(
                accounts.terms.b_margin,
                accounts.deal.b_margin_amount,
                recipient,
                &accounts.b_margin_vault,
                &accounts.b_margin_mint,
                &accounts.b_margin_user,
                &accounts.token_program,
                &accounts.config,
                &accounts.terms.to_account_info(),
            )?;
            accounts.terms.b_funds_escrowed = false;
        }
        if accounts.terms.b_nft_escrowed {
            transfer_spl_out(
                accounts.terms.b_asset_nft,
                1,
                recipient,
                &accounts.b_nft_vault,
                &accounts.b_nft_mint,
                &accounts.b_nft_user,
                &accounts.token_program,
                &accounts.config,
            )?;
            accounts.terms.b_nft_escrowed = false;
        }
        accounts.terms.b_depositor = Pubkey::default();
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn transfer_component_in<'info>(
    spec: AssetSpec,
    amount: u64,
    actor: &AccountInfo<'info>,
    source: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
    system_program: &Program<'info, System>,
    terms: &AccountInfo<'info>,
) -> Result<()> {
    match spec.kind {
        AssetKind::None => {
            require_eq!(amount, 0, AssetControllerError::InvalidAssetSpec);
            Ok(())
        }
        AssetKind::Native => {
            if amount == 0 {
                return Ok(());
            }
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    system_program.key(),
                    anchor_lang::system_program::Transfer {
                        from: actor.clone(),
                        to: terms.clone(),
                    },
                ),
                amount,
            )
        }
        AssetKind::Spl => transfer_spl_in(spec, amount, actor, source, vault, mint, token_program),
    }
}

fn transfer_spl_in<'info>(
    spec: AssetSpec,
    amount: u64,
    actor: &AccountInfo<'info>,
    source: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    validate_spl_accounts(spec, source, vault, mint, token_program, actor.key, None)?;
    let before = read_token_account(vault)?.amount;
    let decimals = read_mint(mint)?.decimals;
    token_interface::transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from: source.clone(),
                mint: mint.clone(),
                to: vault.clone(),
                authority: actor.clone(),
            },
        ),
        amount,
        decimals,
    )?;
    let after = read_token_account(vault)?.amount;
    require_eq!(
        after
            .checked_sub(before)
            .ok_or_else(|| error!(AssetControllerError::MathOverflow))?,
        amount,
        AssetControllerError::InvalidTokenAccount
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn transfer_component_out<'info>(
    spec: AssetSpec,
    amount: u64,
    recipient: Pubkey,
    vault: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
    config: &Account<'info, ControllerConfig>,
    terms: &AccountInfo<'info>,
) -> Result<()> {
    match spec.kind {
        AssetKind::None => {
            require_eq!(amount, 0, AssetControllerError::InvalidAssetSpec);
            Ok(())
        }
        AssetKind::Native => move_native_out(terms, destination, recipient, amount),
        AssetKind::Spl => transfer_spl_out(
            spec,
            amount,
            recipient,
            vault,
            mint,
            destination,
            token_program,
            config,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn transfer_spl_out<'info>(
    spec: AssetSpec,
    amount: u64,
    recipient: Pubkey,
    vault: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
    config: &Account<'info, ControllerConfig>,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    validate_spl_accounts(
        spec,
        vault,
        destination,
        mint,
        token_program,
        &config.key(),
        Some(recipient),
    )?;
    let before = read_token_account(destination)?.amount;
    let decimals = read_mint(mint)?.decimals;
    let bump = [config.bump];
    let signer_seeds: &[&[u8]] = &[CONTROLLER_SEED, &bump];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: vault.clone(),
                mint: mint.clone(),
                to: destination.clone(),
                authority: config.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
        decimals,
    )?;
    let after = read_token_account(destination)?.amount;
    require_eq!(
        after
            .checked_sub(before)
            .ok_or_else(|| error!(AssetControllerError::MathOverflow))?,
        amount,
        AssetControllerError::InvalidTokenAccount
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn transfer_fee_out<'info>(
    spec: AssetSpec,
    amount: u64,
    vault: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
    config: &Account<'info, ControllerConfig>,
    terms: &AccountInfo<'info>,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    transfer_component_out(
        spec,
        amount,
        config.treasury,
        vault,
        mint,
        destination,
        token_program,
        config,
        terms,
    )
}

fn burn_fee_out<'info>(
    spec: AssetSpec,
    amount: u64,
    vault: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
    config: &Account<'info, ControllerConfig>,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    require!(
        spec.kind == AssetKind::Spl,
        AssetControllerError::InvalidAssetSpec
    );
    require_keys_eq!(
        spec.mint,
        config.dc_mint,
        AssetControllerError::InvalidTokenAccount
    );
    require_keys_eq!(
        spec.mint,
        mint.key(),
        AssetControllerError::InvalidTokenAccount
    );
    require_keys_eq!(
        spec.vault,
        vault.key(),
        AssetControllerError::InvalidTokenAccount
    );
    require_keys_eq!(
        *vault.owner,
        token_program.key(),
        AssetControllerError::InvalidTokenProgram
    );
    require_keys_eq!(
        *mint.owner,
        token_program.key(),
        AssetControllerError::InvalidTokenProgram
    );
    let vault_state = read_token_account(vault)?;
    require_keys_eq!(
        vault_state.owner,
        config.key(),
        AssetControllerError::InvalidTokenOwner
    );
    require_keys_eq!(
        vault_state.mint,
        config.dc_mint,
        AssetControllerError::InvalidTokenAccount
    );
    let decimals = read_mint(mint)?.decimals;
    let bump = [config.bump];
    let signer_seeds: &[&[u8]] = &[CONTROLLER_SEED, &bump];
    token_interface::burn_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            BurnChecked {
                mint: mint.clone(),
                from: vault.clone(),
                authority: config.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
        decimals,
    )
}

#[derive(Clone, Copy, Default)]
struct FeeIdentityCandidate {
    mint: Pubkey,
    owner: Pubkey,
    candidate_mint: Pubkey,
    score: u128,
}

#[allow(clippy::too_many_arguments)]
fn validate_fee_identity_side(
    deal_key: Pubkey,
    deal: &DealAccount,
    terms: &AssetTerms,
    is_a: bool,
    identity_key: Option<Pubkey>,
    identity: Option<&IdentityRecord>,
    owner_token: Option<&TokenAccount>,
    binding_key: Option<Pubkey>,
    binding: Option<&DealIdentityBinding>,
    credit_account: Option<&UncheckedAccount<'_>>,
) -> Result<FeeIdentityCandidate> {
    let expected_mint = if is_a {
        terms.a_identity_mint
    } else {
        terms.b_identity_mint
    };
    if expected_mint == Pubkey::default() {
        require!(
            identity.is_none()
                && identity_key.is_none()
                && owner_token.is_none()
                && binding_key.is_none()
                && binding.is_none()
                && credit_account.is_none(),
            AssetControllerError::IncompleteIdentityAccounts
        );
        return Ok(FeeIdentityCandidate::default());
    }
    let (
        Some(identity_key),
        Some(identity),
        Some(owner_token),
        Some(binding_key),
        Some(binding),
        Some(credit_account),
    ) = (
        identity_key,
        identity,
        owner_token,
        binding_key,
        binding,
        credit_account,
    )
    else {
        return err!(AssetControllerError::IncompleteIdentityAccounts);
    };
    require_keys_eq!(
        identity.mint,
        expected_mint,
        AssetControllerError::InvalidIdentityBinding
    );
    let (expected_identity, _) = Pubkey::find_program_address(
        &[deal_identity::IDENTITY_SEED, expected_mint.as_ref()],
        &deal_identity::id(),
    );
    require_keys_eq!(
        identity_key,
        expected_identity,
        AssetControllerError::InvalidIdentityBinding
    );
    let party = if is_a { deal.creator } else { deal.participant };
    require_keys_eq!(
        owner_token.mint,
        expected_mint,
        AssetControllerError::InvalidIdentityOwner
    );
    require_keys_eq!(
        owner_token.owner,
        party,
        AssetControllerError::InvalidIdentityOwner
    );
    require_eq!(
        owner_token.amount,
        1,
        AssetControllerError::InvalidIdentityOwner
    );
    let (expected_binding, _) = Pubkey::find_program_address(
        &[
            deal_identity::BINDING_SEED,
            deal_key.as_ref(),
            party.as_ref(),
        ],
        &deal_identity::id(),
    );
    require_keys_eq!(
        binding_key,
        expected_binding,
        AssetControllerError::InvalidIdentityBinding
    );
    require_keys_eq!(
        binding.deal,
        deal_key,
        AssetControllerError::InvalidIdentityBinding
    );
    require_keys_eq!(
        binding.party,
        party,
        AssetControllerError::InvalidIdentityBinding
    );
    require_keys_eq!(
        binding.identity_mint,
        expected_mint,
        AssetControllerError::InvalidIdentityBinding
    );
    require!(
        binding.lock_count > 0 && identity.lock_count > 0,
        AssetControllerError::InvalidIdentityBinding
    );
    let (candidate_mint, score) = load_fee_candidate(expected_mint, credit_account)?;
    Ok(FeeIdentityCandidate {
        mint: expected_mint,
        owner: party,
        candidate_mint,
        score,
    })
}

fn load_fee_candidate(
    identity_mint: Pubkey,
    credit_account: &UncheckedAccount<'_>,
) -> Result<(Pubkey, u128)> {
    let (expected_credit, _) = Pubkey::find_program_address(
        &[SCORE_SEED, identity_mint.as_ref()],
        &deal_credit_graph::id(),
    );
    require_keys_eq!(
        credit_account.key(),
        expected_credit,
        AssetControllerError::InvalidCredit
    );
    if credit_account.data_is_empty() {
        return Ok((identity_mint, 0));
    }
    require_keys_eq!(
        *credit_account.owner,
        deal_credit_graph::id(),
        AssetControllerError::InvalidCredit
    );
    let data = credit_account.try_borrow_data()?;
    let credit = CreditScore::try_deserialize(&mut data.as_ref())
        .map_err(|_| error!(AssetControllerError::InvalidCredit))?;
    require_keys_eq!(
        credit.identity_mint,
        identity_mint,
        AssetControllerError::InvalidCredit
    );
    let mut candidate_mint = identity_mint;
    let mut score = credit.score;
    for peer in credit.top_peers {
        if peer.identity_mint != Pubkey::default() && peer.credit_snapshot > score {
            candidate_mint = peer.identity_mint;
            score = peer.credit_snapshot;
        }
    }
    Ok((candidate_mint, score))
}

fn resolve_fee_c(a: FeeIdentityCandidate, b: FeeIdentityCandidate) -> (Pubkey, u128) {
    if a.mint == Pubkey::default() && b.mint == Pubkey::default() {
        return (Pubkey::default(), 0);
    }
    if a.mint != Pubkey::default() && b.mint != Pubkey::default() && a.owner == b.owner {
        return (Pubkey::default(), 0);
    }
    if a.score == 0 && b.score == 0 {
        return (Pubkey::default(), 0);
    }
    if a.score > b.score {
        return (a.candidate_mint, a.score);
    }
    if b.score > a.score {
        return (b.candidate_mint, b.score);
    }
    (Pubkey::default(), 0)
}

fn validate_fee_c_recipient(
    expected_mint: Pubkey,
    identity_key: Option<Pubkey>,
    identity: Option<&IdentityRecord>,
    owner_token: Option<&TokenAccount>,
    dc_destination: Option<&TokenAccount>,
    dc_mint: Pubkey,
) -> Result<Pubkey> {
    if expected_mint == Pubkey::default() {
        require!(
            identity_key.is_none()
                && identity.is_none()
                && owner_token.is_none()
                && dc_destination.is_none(),
            AssetControllerError::InvalidCRecipient
        );
        return Ok(Pubkey::default());
    }
    let (Some(identity_key), Some(identity), Some(owner_token), Some(dc_destination)) =
        (identity_key, identity, owner_token, dc_destination)
    else {
        return err!(AssetControllerError::InvalidCRecipient);
    };
    require_keys_eq!(
        identity.mint,
        expected_mint,
        AssetControllerError::InvalidCRecipient
    );
    let (expected_identity, _) = Pubkey::find_program_address(
        &[deal_identity::IDENTITY_SEED, expected_mint.as_ref()],
        &deal_identity::id(),
    );
    require_keys_eq!(
        identity_key,
        expected_identity,
        AssetControllerError::InvalidCRecipient
    );
    require_keys_eq!(
        owner_token.mint,
        expected_mint,
        AssetControllerError::InvalidCRecipient
    );
    require_eq!(
        owner_token.amount,
        1,
        AssetControllerError::InvalidCRecipient
    );
    require_keys_eq!(
        dc_destination.mint,
        dc_mint,
        AssetControllerError::InvalidCRecipient
    );
    require_keys_eq!(
        dc_destination.owner,
        owner_token.owner,
        AssetControllerError::InvalidCRecipient
    );
    Ok(owner_token.owner)
}

fn validate_routed_fee_sequence(accounts: &RouteDcFees<'_>) -> Result<()> {
    if !accounts.config.terminal_guard_enabled {
        return Ok(());
    }
    let following = [
        ExpectedInstruction::anchor(FINALIZER_PROGRAM_ID, FINALIZE_COMPLETED_DISC)
            .account(2, accounts.deal.key()),
    ];
    validate_current_and_following(
        &accounts.instructions_sysvar.to_account_info(),
        crate::ID,
        ROUTE_DC_FEES_DISC,
        &following,
    )
    .map_err(Into::into)
}

fn move_native_out(
    terms: &AccountInfo<'_>,
    destination: &AccountInfo<'_>,
    recipient: Pubkey,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    require_keys_eq!(
        destination.key(),
        recipient,
        AssetControllerError::InvalidTokenOwner
    );
    let rent_floor = Rent::get()?.minimum_balance(terms.data_len());
    let current = terms.lamports();
    let remaining = current
        .checked_sub(amount)
        .ok_or_else(|| error!(AssetControllerError::NativeEscrowInsolvent))?;
    require!(
        remaining >= rent_floor,
        AssetControllerError::NativeEscrowInsolvent
    );
    **terms.try_borrow_mut_lamports()? = remaining;
    **destination.try_borrow_mut_lamports()? = destination
        .lamports()
        .checked_add(amount)
        .ok_or_else(|| error!(AssetControllerError::MathOverflow))?;
    Ok(())
}

fn validate_spl_accounts(
    spec: AssetSpec,
    source: &AccountInfo<'_>,
    destination: &AccountInfo<'_>,
    mint: &AccountInfo<'_>,
    token_program: &Interface<'_, TokenInterface>,
    source_owner: &Pubkey,
    destination_owner: Option<Pubkey>,
) -> Result<()> {
    require!(
        spec.kind == AssetKind::Spl,
        AssetControllerError::InvalidAssetSpec
    );
    require_keys_eq!(
        spec.mint,
        mint.key(),
        AssetControllerError::InvalidTokenAccount
    );
    require_keys_eq!(
        spec.vault,
        if destination_owner.is_some() {
            source.key()
        } else {
            destination.key()
        },
        AssetControllerError::InvalidTokenAccount
    );
    require_keys_eq!(
        *source.owner,
        token_program.key(),
        AssetControllerError::InvalidTokenProgram
    );
    require_keys_eq!(
        *destination.owner,
        token_program.key(),
        AssetControllerError::InvalidTokenProgram
    );
    require_keys_eq!(
        *mint.owner,
        token_program.key(),
        AssetControllerError::InvalidTokenProgram
    );
    let source_data = read_token_account(source)?;
    let destination_data = read_token_account(destination)?;
    require_keys_eq!(
        source_data.mint,
        spec.mint,
        AssetControllerError::InvalidTokenAccount
    );
    require_keys_eq!(
        destination_data.mint,
        spec.mint,
        AssetControllerError::InvalidTokenAccount
    );
    require_keys_eq!(
        source_data.owner,
        *source_owner,
        AssetControllerError::InvalidTokenOwner
    );
    if let Some(expected) = destination_owner {
        require_keys_eq!(
            destination_data.owner,
            expected,
            AssetControllerError::InvalidTokenOwner
        );
    }
    Ok(())
}

fn validate_nft_mint(
    mint: &AccountInfo<'_>,
    token_program: &Interface<'_, TokenInterface>,
) -> Result<()> {
    require_keys_eq!(
        *mint.owner,
        token_program.key(),
        AssetControllerError::InvalidTokenProgram
    );
    let mint_data = read_mint(mint)?;
    require!(
        mint_data.decimals == 0 && mint_data.supply == 1,
        AssetControllerError::InvalidNftMint
    );
    Ok(())
}

fn read_token_account(account: &AccountInfo<'_>) -> Result<TokenAccount> {
    let data = account.try_borrow_data()?;
    TokenAccount::try_deserialize(&mut data.as_ref())
        .map_err(|_| error!(AssetControllerError::InvalidTokenAccount))
}

fn read_mint(account: &AccountInfo<'_>) -> Result<Mint> {
    let data = account.try_borrow_data()?;
    Mint::try_deserialize(&mut data.as_ref())
        .map_err(|_| error!(AssetControllerError::InvalidTokenAccount))
}

fn side_has_escrow(terms: &AssetTerms, is_party_a: bool) -> bool {
    if is_party_a {
        terms.a_funds_escrowed || terms.a_nft_escrowed
    } else {
        terms.b_funds_escrowed || terms.b_nft_escrowed
    }
}

fn validate_actor_side(deal: &DealAccount, actor: Pubkey, is_party_a: bool) -> Result<()> {
    let expected = if is_party_a {
        deal.creator
    } else {
        deal.participant
    };
    require_keys_eq!(actor, expected, AssetControllerError::Unauthorized);
    Ok(())
}

fn tracked_identity_for_actor_mut<'a>(
    deal: &DealAccount,
    deal_key: Pubkey,
    terms: &'a mut AssetTerms,
    actor: Pubkey,
) -> Result<&'a mut Pubkey> {
    require_keys_eq!(
        terms.deal,
        deal_key,
        AssetControllerError::InvalidAssetAccounts
    );
    if actor == deal.creator {
        return Ok(&mut terms.a_identity_mint);
    }
    require!(
        deal.participant != Pubkey::default() && actor == deal.participant,
        AssetControllerError::InvalidIdentityOwner
    );
    Ok(&mut terms.b_identity_mint)
}

fn tracked_identity_for_mint_mut(
    terms: &mut AssetTerms,
    identity_mint: Pubkey,
) -> Result<&mut Pubkey> {
    if terms.a_identity_mint == identity_mint {
        return Ok(&mut terms.a_identity_mint);
    }
    if terms.b_identity_mint == identity_mint {
        return Ok(&mut terms.b_identity_mint);
    }
    err!(AssetControllerError::IdentityNotTracked)
}

fn assert_live(config: &ControllerConfig) -> Result<()> {
    require!(!config.paused, AssetControllerError::Paused);
    Ok(())
}

fn assert_authority(config: &ControllerConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        config.authority,
        authority.key(),
        AssetControllerError::Unauthorized
    );
    Ok(())
}

fn controller_signer_seeds(config: &ControllerConfig) -> [&[u8]; 2] {
    [CONTROLLER_SEED, std::slice::from_ref(&config.bump)]
}

fn cpi_record_deposit<'info>(
    config: &Account<'info, ControllerConfig>,
    actor: &Signer<'info>,
    registry: &Account<'info, DealRegistry>,
    deal: &Account<'info, DealAccount>,
    core_program: &Program<'info, deal_core::program::DealCore>,
    is_party_a: bool,
    kind: DepositKind,
) -> Result<()> {
    let seeds = controller_signer_seeds(config);
    deal_core::cpi::record_deposit(
        CpiContext::new_with_signer(
            core_program.key(),
            deal_core::cpi::accounts::AssetAction {
                actor: actor.to_account_info(),
                asset_controller: config.to_account_info(),
                registry: registry.to_account_info(),
                deal: deal.to_account_info(),
            },
            &[&seeds],
        ),
        is_party_a,
        kind,
    )
}

fn cpi_record_withdrawal<'info>(
    config: &Account<'info, ControllerConfig>,
    actor: &Signer<'info>,
    registry: &Account<'info, DealRegistry>,
    deal: &Account<'info, DealAccount>,
    core_program: &Program<'info, deal_core::program::DealCore>,
    is_party_a: bool,
) -> Result<()> {
    let seeds = controller_signer_seeds(config);
    deal_core::cpi::record_withdrawal(
        CpiContext::new_with_signer(
            core_program.key(),
            deal_core::cpi::accounts::AssetAction {
                actor: actor.to_account_info(),
                asset_controller: config.to_account_info(),
                registry: registry.to_account_info(),
                deal: deal.to_account_info(),
            },
            &[&seeds],
        ),
        is_party_a,
    )
}

fn validate_identity_controller(
    config: &Account<'_, ControllerConfig>,
    identity_config: &Account<'_, deal_identity::IdentityConfig>,
) -> Result<()> {
    require_keys_eq!(
        identity_config.trusted_controller,
        config.key(),
        AssetControllerError::InvalidIdentityController
    );
    Ok(())
}

fn cpi_cast_vote(accounts: &ResolveAssets<'_>, vote: Vote) -> Result<()> {
    deal_core::cpi::cast_vote(
        CpiContext::new(
            accounts.core_program.key(),
            deal_core::cpi::accounts::PartyAction {
                actor: accounts.caller.to_account_info(),
                deal: accounts.deal.to_account_info(),
            },
        ),
        vote,
    )
}

fn cpi_settle_votes(accounts: &ResolveAssets<'_>) -> Result<()> {
    let seeds = controller_signer_seeds(&accounts.config);
    deal_core::cpi::settle_votes(CpiContext::new_with_signer(
        accounts.core_program.key(),
        deal_core::cpi::accounts::Settlement {
            asset_controller: accounts.config.to_account_info(),
            registry: accounts.core_registry.to_account_info(),
            deal: accounts.deal.to_account_info(),
        },
        &[&seeds],
    ))
}

fn cpi_force_complete(accounts: &ResolveAssets<'_>) -> Result<()> {
    cpi_asset_action(accounts, deal_core::cpi::force_complete)
}

fn cpi_exit_by_b(accounts: &ResolveAssets<'_>) -> Result<()> {
    cpi_asset_action(accounts, deal_core::cpi::exit_by_b)
}

fn cpi_kick_b_by_a(accounts: &ResolveAssets<'_>) -> Result<()> {
    cpi_asset_action(accounts, deal_core::cpi::kick_b_by_a)
}

fn cpi_replace_inactive_b(accounts: &ResolveAssets<'_>) -> Result<()> {
    cpi_asset_action(accounts, deal_core::cpi::replace_inactive_b)
}

fn cpi_replace_non_voting_b(accounts: &ResolveAssets<'_>) -> Result<()> {
    cpi_asset_action(accounts, deal_core::cpi::replace_non_voting_b)
}

fn cpi_abandon(accounts: &ResolveAssets<'_>) -> Result<()> {
    cpi_asset_action(accounts, deal_core::cpi::abandon)
}

fn cpi_asset_action<'info, F>(accounts: &ResolveAssets<'info>, call: F) -> Result<()>
where
    F: FnOnce(
        CpiContext<'_, '_, '_, 'info, deal_core::cpi::accounts::AssetAction<'info>>,
    ) -> Result<()>,
{
    let seeds = controller_signer_seeds(&accounts.config);
    call(CpiContext::new_with_signer(
        accounts.core_program.key(),
        deal_core::cpi::accounts::AssetAction {
            actor: accounts.caller.to_account_info(),
            asset_controller: accounts.config.to_account_info(),
            registry: accounts.core_registry.to_account_info(),
            deal: accounts.deal.to_account_info(),
        },
        &[&seeds],
    ))
}

#[derive(Accounts)]
pub struct InitializeController<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = ControllerConfig::SPACE,
        seeds = [CONTROLLER_SEED],
        bump
    )]
    pub config: Box<Account<'info, ControllerConfig>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONTROLLER_SEED], bump = config.bump)]
    pub config: Account<'info, ControllerConfig>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONTROLLER_SEED], bump = config.bump)]
    pub config: Account<'info, ControllerConfig>,
}

#[derive(Accounts)]
pub struct ConfigureTerms<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [CONTROLLER_SEED], bump = config.bump)]
    pub config: Account<'info, ControllerConfig>,
    pub deal: Account<'info, DealAccount>,
    #[account(
        init,
        payer = creator,
        space = AssetTerms::SPACE,
        seeds = [TERMS_SEED, deal.key().as_ref()],
        bump
    )]
    pub terms: Account<'info, AssetTerms>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinGatedDeal<'info> {
    pub participant: Signer<'info>,
    #[account(seeds = [CONTROLLER_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ControllerConfig>>,
    #[account(
        seeds = [deal_core::constants::REGISTRY_SEED],
        bump = core_registry.bump,
        seeds::program = deal_core::ID
    )]
    pub core_registry: Box<Account<'info, DealRegistry>>,
    #[account(mut)]
    pub deal: Box<Account<'info, DealAccount>>,
    #[account(
        seeds = [deal_identity::IDENTITY_SEED, identity.mint.as_ref()],
        bump = identity.bump,
        seeds::program = deal_identity::ID
    )]
    pub identity: Box<Account<'info, deal_identity::IdentityRecord>>,
    pub owner_identity: Box<InterfaceAccount<'info, TokenAccount>>,
    pub core_program: Program<'info, deal_core::program::DealCore>,
}

#[derive(Accounts)]
pub struct ManageIdentity<'info> {
    #[account(mut)]
    pub actor: Signer<'info>,
    #[account(seeds = [CONTROLLER_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ControllerConfig>>,
    #[account(
        seeds = [deal_identity::CONFIG_SEED],
        bump = identity_config.bump,
        seeds::program = deal_identity::ID
    )]
    pub identity_config: Box<Account<'info, deal_identity::IdentityConfig>>,
    pub deal: Box<Account<'info, DealAccount>>,
    /// CHECK: DealIdentity validates the canonical mint and mutability.
    #[account(mut)]
    pub identity_mint: UncheckedAccount<'info>,
    /// CHECK: DealIdentity validates the owner, mint, amount, and mutability.
    #[account(mut)]
    pub owner_identity: UncheckedAccount<'info>,
    /// CHECK: DealIdentity validates the canonical IdentityRecord PDA.
    #[account(mut)]
    pub identity: UncheckedAccount<'info>,
    /// CHECK: DealIdentity validates or initializes the Deal binding PDA.
    #[account(mut)]
    pub binding: UncheckedAccount<'info>,
    /// CHECK: DealIdentity validates or initializes the identity lock PDA.
    #[account(mut)]
    pub lock: UncheckedAccount<'info>,
    pub identity_program: Program<'info, deal_identity::program::DealIdentity>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    #[account(
        mut,
        seeds = [TERMS_SEED, deal.key().as_ref()],
        bump = terms.bump,
        constraint = terms.deal == deal.key()
    )]
    pub terms: Box<Account<'info, AssetTerms>>,
}

#[derive(Accounts)]
pub struct DepositFunds<'info> {
    #[account(mut)]
    pub actor: Signer<'info>,
    #[account(seeds = [CONTROLLER_SEED], bump = config.bump)]
    pub config: Account<'info, ControllerConfig>,
    #[account(
        mut,
        seeds = [TERMS_SEED, deal.key().as_ref()],
        bump = terms.bump,
        constraint = terms.deal == deal.key()
    )]
    pub terms: Box<Account<'info, AssetTerms>>,
    pub core_registry: Box<Account<'info, DealRegistry>>,
    #[account(mut)]
    pub deal: Box<Account<'info, DealAccount>>,
    /// CHECK: validated from the configured AssetSpec when SPL is used.
    #[account(mut)]
    pub swap_source: UncheckedAccount<'info>,
    /// CHECK: validated from the configured AssetSpec when SPL is used.
    #[account(mut)]
    pub swap_vault: UncheckedAccount<'info>,
    /// CHECK: validated as the configured mint when SPL is used.
    pub swap_mint: UncheckedAccount<'info>,
    /// CHECK: validated from the configured AssetSpec when SPL is used.
    #[account(mut)]
    pub margin_source: UncheckedAccount<'info>,
    /// CHECK: validated from the configured AssetSpec when SPL is used.
    #[account(mut)]
    pub margin_vault: UncheckedAccount<'info>,
    /// CHECK: validated as the configured mint when SPL is used.
    pub margin_mint: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub core_program: Program<'info, deal_core::program::DealCore>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositNft<'info> {
    #[account(mut)]
    pub actor: Signer<'info>,
    #[account(seeds = [CONTROLLER_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ControllerConfig>>,
    #[account(
        mut,
        seeds = [TERMS_SEED, deal.key().as_ref()],
        bump = terms.bump,
        constraint = terms.deal == deal.key()
    )]
    pub terms: Box<Account<'info, AssetTerms>>,
    pub core_registry: Box<Account<'info, DealRegistry>>,
    #[account(mut)]
    pub deal: Box<Account<'info, DealAccount>>,
    /// CHECK: validated as actor-owned NFT token account.
    #[account(mut)]
    pub source: UncheckedAccount<'info>,
    /// CHECK: validated as configured controller-owned NFT vault.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: validated as zero-decimal supply-one mint.
    pub mint: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub core_program: Program<'info, deal_core::program::DealCore>,
}

#[derive(Accounts)]
pub struct RouteDcFees<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONTROLLER_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ControllerConfig>>,
    #[account(
        mut,
        seeds = [TERMS_SEED, deal.key().as_ref()],
        bump = terms.bump,
        constraint = terms.deal == deal.key()
    )]
    pub terms: Box<Account<'info, AssetTerms>>,
    pub deal: Box<Account<'info, DealAccount>>,
    /// CHECK: Validated as the configured A-side DC vault.
    #[account(mut)]
    pub a_swap_vault: UncheckedAccount<'info>,
    /// CHECK: Validated as the configured B-side DC vault.
    #[account(mut)]
    pub b_swap_vault: UncheckedAccount<'info>,
    #[account(mut, address = config.dc_mint)]
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub a_identity: Option<Box<Account<'info, IdentityRecord>>>,
    pub a_identity_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub a_binding: Option<Box<Account<'info, DealIdentityBinding>>>,
    /// CHECK: Canonical CreditScore PDA is validated and deserialized when supplied.
    pub a_credit: Option<UncheckedAccount<'info>>,
    pub b_identity: Option<Box<Account<'info, IdentityRecord>>>,
    pub b_identity_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub b_binding: Option<Box<Account<'info, DealIdentityBinding>>>,
    /// CHECK: Canonical CreditScore PDA is validated and deserialized when supplied.
    pub b_credit: Option<UncheckedAccount<'info>>,
    pub c_identity: Option<Box<Account<'info, IdentityRecord>>>,
    pub c_identity_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut)]
    pub c_dc_destination: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: Address-constrained Solana Instructions sysvar used by the terminal guard.
    #[account(address = deal_terminal_guard::instructions_sysvar_id())]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ResolveAssets<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [CONTROLLER_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ControllerConfig>>,
    #[account(
        mut,
        seeds = [TERMS_SEED, deal.key().as_ref()],
        bump = terms.bump,
        constraint = terms.deal == deal.key()
    )]
    pub terms: Box<Account<'info, AssetTerms>>,
    pub core_registry: Box<Account<'info, DealRegistry>>,
    #[account(mut)]
    pub deal: Box<Account<'info, DealAccount>>,
    /// CHECK: key is validated against deal.creator before use.
    #[account(mut, address = deal.creator)]
    pub creator: UncheckedAccount<'info>,
    /// CHECK: operation-specific participant/depositor key is validated before use.
    #[account(mut)]
    pub participant: UncheckedAccount<'info>,

    /// CHECK: validated from a_swap spec.
    #[account(mut)]
    pub a_swap_vault: UncheckedAccount<'info>,
    /// CHECK: validated from a_swap spec.
    #[account(mut)]
    pub a_swap_mint: UncheckedAccount<'info>,
    /// CHECK: validated as recipient token account or native wallet.
    #[account(mut)]
    pub a_swap_user: UncheckedAccount<'info>,
    /// CHECK: validated as treasury token account or native treasury.
    #[account(mut)]
    pub a_swap_fee: UncheckedAccount<'info>,
    /// CHECK: validated from a_margin spec.
    #[account(mut)]
    pub a_margin_vault: UncheckedAccount<'info>,
    /// CHECK: validated from a_margin spec.
    pub a_margin_mint: UncheckedAccount<'info>,
    /// CHECK: validated as margin owner token account or native wallet.
    #[account(mut)]
    pub a_margin_user: UncheckedAccount<'info>,

    /// CHECK: validated from b_swap spec.
    #[account(mut)]
    pub b_swap_vault: UncheckedAccount<'info>,
    /// CHECK: validated from b_swap spec.
    #[account(mut)]
    pub b_swap_mint: UncheckedAccount<'info>,
    /// CHECK: validated as recipient token account or native wallet.
    #[account(mut)]
    pub b_swap_user: UncheckedAccount<'info>,
    /// CHECK: validated as treasury token account or native treasury.
    #[account(mut)]
    pub b_swap_fee: UncheckedAccount<'info>,
    /// CHECK: validated from b_margin spec.
    #[account(mut)]
    pub b_margin_vault: UncheckedAccount<'info>,
    /// CHECK: validated from b_margin spec.
    pub b_margin_mint: UncheckedAccount<'info>,
    /// CHECK: validated as margin owner token account or native wallet.
    #[account(mut)]
    pub b_margin_user: UncheckedAccount<'info>,

    /// CHECK: validated from a_asset_nft spec.
    #[account(mut)]
    pub a_nft_vault: UncheckedAccount<'info>,
    /// CHECK: validated from a_asset_nft spec.
    pub a_nft_mint: UncheckedAccount<'info>,
    /// CHECK: validated as NFT recipient token account.
    #[account(mut)]
    pub a_nft_user: UncheckedAccount<'info>,
    /// CHECK: validated from b_asset_nft spec.
    #[account(mut)]
    pub b_nft_vault: UncheckedAccount<'info>,
    /// CHECK: validated from b_asset_nft spec.
    pub b_nft_mint: UncheckedAccount<'info>,
    /// CHECK: validated as NFT recipient token account.
    #[account(mut)]
    pub b_nft_user: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub core_program: Program<'info, deal_core::program::DealCore>,
    /// CHECK: Address-constrained Solana Instructions sysvar used by the terminal guard.
    #[account(address = deal_terminal_guard::instructions_sysvar_id())]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[event]
pub struct ControllerInitialized {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub dc_mint: Pubkey,
    pub fee_numerator: u32,
    pub fee_denominator: u32,
}

#[event]
pub struct PauseUpdated {
    pub paused: bool,
}

#[event]
pub struct FeeUpdated {
    pub numerator: u32,
    pub denominator: u32,
}

#[event]
pub struct TerminalGuardUpdated {
    pub enabled: bool,
}

#[event]
pub struct TreasuryUpdated {
    pub old_treasury: Pubkey,
    pub new_treasury: Pubkey,
}

#[event]
pub struct AuthorityProposed {
    pub pending_authority: Pubkey,
}

#[event]
pub struct AuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct TermsConfigured {
    pub deal: Pubkey,
    pub creator: Pubkey,
}

#[event]
pub struct FundsDeposited {
    pub deal: Pubkey,
    pub actor: Pubkey,
    pub is_party_a: bool,
    pub swap_amount: u64,
    pub margin_amount: u64,
}

#[event]
pub struct NftDeposited {
    pub deal: Pubkey,
    pub actor: Pubkey,
    pub is_party_a: bool,
    pub mint: Pubkey,
}

#[event]
pub struct SideRefunded {
    pub deal: Pubkey,
    pub recipient: Pubkey,
    pub is_party_a: bool,
    pub reason: u8,
}

#[event]
pub struct AssetsSettled {
    pub deal: Pubkey,
    pub a_fee: u64,
    pub b_fee: u64,
}

#[event]
pub struct DcFeesRouted {
    pub deal: Pubkey,
    pub c_identity_mint: Pubkey,
    pub c_recipient: Pubkey,
    pub c_score: u128,
    pub amount: u64,
    pub burned: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(
        owner: Pubkey,
        mint: Pubkey,
        candidate_mint: Pubkey,
        score: u128,
    ) -> FeeIdentityCandidate {
        FeeIdentityCandidate {
            mint,
            owner,
            candidate_mint,
            score,
        }
    }

    #[test]
    fn fee_c_resolution_matches_eth_strict_winner_rules() {
        let owner_a = Pubkey::new_unique();
        let owner_b = Pubkey::new_unique();
        let mint_a = Pubkey::new_unique();
        let mint_b = Pubkey::new_unique();
        let peer = Pubkey::new_unique();

        assert_eq!(
            resolve_fee_c(
                FeeIdentityCandidate::default(),
                FeeIdentityCandidate::default()
            ),
            (Pubkey::default(), 0)
        );
        assert_eq!(
            resolve_fee_c(
                candidate(owner_a, mint_a, mint_a, 0),
                candidate(owner_b, mint_b, mint_b, 0)
            ),
            (Pubkey::default(), 0)
        );
        assert_eq!(
            resolve_fee_c(
                candidate(owner_a, mint_a, mint_a, 100),
                candidate(owner_b, mint_b, mint_b, 100)
            ),
            (Pubkey::default(), 0)
        );
        assert_eq!(
            resolve_fee_c(
                candidate(owner_a, mint_a, mint_a, 100),
                candidate(owner_a, mint_b, mint_b, 200)
            ),
            (Pubkey::default(), 0)
        );
        assert_eq!(
            resolve_fee_c(
                candidate(owner_a, mint_a, peer, 200),
                candidate(owner_b, mint_b, mint_b, 150)
            ),
            (peer, 200)
        );
        assert_eq!(
            resolve_fee_c(
                candidate(owner_a, mint_a, mint_a, 100),
                candidate(owner_b, mint_b, mint_b, 150)
            ),
            (mint_b, 150)
        );
    }
}
