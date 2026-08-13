#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;
use deal_asset_controller::state::{AssetTerms, ControllerConfig};
use deal_core::state::{CompletionReason, DealAccount, DealStatus};
use deal_terminal_guard::{validate_current_and_following, ExpectedInstruction};

declare_id!("7m8WXGUfwnuyxi2GmzNepfkrXgsCAurTKvANSdPqZXzG");

pub const CONFIG_SEED: &[u8] = b"finalizer-config";
pub const WRITER_SEED: &[u8] = b"finalizer-writer";
pub const RECEIPT_SEED: &[u8] = b"terminal-receipt";
pub const CREDIT_RECEIPT_SEED: &[u8] = b"credit-recorded";
pub const HISTORY_RECEIPT_SEED: &[u8] = b"history-indexed";
const VALUATOR_PROGRAM_ID: Pubkey = pubkey!("7m8WXGUfwnuyxi2GmzNepfkrXgsCAurTKvANSdPqZXzG");
const FINALIZE_COMPLETED_DISC: [u8; 8] = [0x85, 0xfe, 0x5c, 0x8c, 0xd1, 0xca, 0x2c, 0xe9];
const FINALIZE_NON_COMPLETED_DISC: [u8; 8] = [0x42, 0x54, 0xf8, 0x26, 0xd8, 0xf9, 0x1b, 0x49];
const VALUE_COMPLETED_DEAL_DISC: [u8; 8] = [0x6f, 0xa3, 0xa0, 0xe7, 0xcd, 0x08, 0xbd, 0x4a];
const RECORD_COMPLETED_CREDIT_DISC: [u8; 8] = [0x2a, 0x8c, 0xad, 0xe0, 0x80, 0x80, 0x20, 0xc4];
const RECORD_COMPLETED_CREDIT_SINGLE_DISC: [u8; 8] =
    [0xd5, 0x08, 0x67, 0x2d, 0xdf, 0xfe, 0xa9, 0xc6];
const RECORD_COMPLETED_CREDIT_NONE_DISC: [u8; 8] = [0x46, 0x00, 0xca, 0x77, 0x48, 0x35, 0x80, 0x14];
const UNLOCK_IDENTITY_DISC: [u8; 8] = [0xce, 0x0b, 0x80, 0xab, 0xff, 0x97, 0x69, 0xc1];

#[program]
pub mod deal_finalizer {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.history_index = deal_history_index::id();
        config.paused = true;
        config.bump = ctx.bumps.config;
        emit!(FinalizerInitialized {
            authority: config.authority,
            history_index: config.history_index,
            writer: ctx.accounts.writer.key(),
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.paused = paused;
        emit!(FinalizerPauseUpdated { paused });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            FinalizerError::ZeroAddress
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(FinalizerAuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            FinalizerError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = Pubkey::default();
        emit!(FinalizerAuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority,
        });
        Ok(())
    }

    pub fn finalize_completed(ctx: Context<FinalizeCompleted>) -> Result<()> {
        assert_enabled(&ctx.accounts.config)?;
        require!(
            ctx.accounts.deal.status == DealStatus::Completed,
            FinalizerError::InvalidTerminalStatus
        );
        require!(
            ctx.accounts.deal.participant != Pubkey::default(),
            FinalizerError::ParticipantMissing
        );
        require!(
            ctx.accounts.terms.resolved,
            FinalizerError::AssetsNotResolved
        );
        require!(
            ctx.accounts.terms.dc_fees_routed,
            FinalizerError::DcFeesNotRouted
        );
        validate_completed_finalization_sequence(ctx.accounts)?;
        record_receipt(
            &mut ctx.accounts.receipt,
            &ctx.accounts.deal,
            ctx.accounts.deal.key(),
            ctx.accounts.payer.key(),
            ctx.bumps.receipt,
        )
    }

    pub fn index_completed_history(ctx: Context<IndexCompletedHistory>) -> Result<()> {
        assert_enabled(&ctx.accounts.config)?;
        require!(
            ctx.accounts.deal.status == DealStatus::Completed,
            FinalizerError::InvalidTerminalStatus
        );
        require_keys_eq!(
            ctx.accounts.terminal_receipt.deal,
            ctx.accounts.deal.key(),
            FinalizerError::InvalidTerminalReceipt
        );
        validate_history(&ctx.accounts.history_config, ctx.accounts.writer.key())?;
        let writer_bump = ctx.bumps.writer;
        let writer_seeds: &[&[u8]] = &[WRITER_SEED, &[writer_bump]];
        let signer_seeds = &[writer_seeds];
        add_completed_history(
            &ctx.accounts.history_program,
            &ctx.accounts.history_config,
            &ctx.accounts.payer,
            &ctx.accounts.writer,
            &ctx.accounts.creator,
            &ctx.accounts.deal,
            &ctx.accounts.creator_header,
            &ctx.accounts.system_program,
            signer_seeds,
        )?;
        add_completed_history(
            &ctx.accounts.history_program,
            &ctx.accounts.history_config,
            &ctx.accounts.payer,
            &ctx.accounts.writer,
            &ctx.accounts.participant,
            &ctx.accounts.deal,
            &ctx.accounts.participant_header,
            &ctx.accounts.system_program,
            signer_seeds,
        )?;
        let receipt = &mut ctx.accounts.history_receipt;
        receipt.deal = ctx.accounts.deal.key();
        receipt.indexed_at = Clock::get()?.unix_timestamp;
        receipt.indexed_by = ctx.accounts.payer.key();
        receipt.bump = ctx.bumps.history_receipt;
        emit!(CompletedHistoryIndexed {
            deal: receipt.deal,
            indexed_by: receipt.indexed_by,
            indexed_at: receipt.indexed_at,
        });
        Ok(())
    }

    pub fn finalize_non_completed(ctx: Context<FinalizeNonCompleted>) -> Result<()> {
        assert_enabled(&ctx.accounts.config)?;
        require!(
            matches!(
                ctx.accounts.deal.status,
                DealStatus::Canceled | DealStatus::Abandoned
            ),
            FinalizerError::InvalidTerminalStatus
        );
        validate_non_completed_finalization_sequence(ctx.accounts)?;
        record_receipt(
            &mut ctx.accounts.receipt,
            &ctx.accounts.deal,
            ctx.accounts.deal.key(),
            ctx.accounts.payer.key(),
            ctx.bumps.receipt,
        )
    }

    pub fn record_completed_credit(ctx: Context<RecordCompletedCredit>) -> Result<()> {
        assert_enabled(&ctx.accounts.config)?;
        require_keys_eq!(
            ctx.accounts.terms.a_identity_mint,
            ctx.accounts.a_identity.mint,
            FinalizerError::InvalidIdentityBinding
        );
        require_keys_eq!(
            ctx.accounts.terms.b_identity_mint,
            ctx.accounts.b_identity.mint,
            FinalizerError::InvalidIdentityBinding
        );
        validate_credit_inputs(
            &ctx.accounts.deal,
            &ctx.accounts.terminal_receipt,
            &ctx.accounts.valuation_receipt,
        )?;

        let a_before = read_credit_score(&ctx.accounts.a_credit.to_account_info())?;
        let b_before = read_credit_score(&ctx.accounts.b_credit.to_account_info())?;
        let writer_bump = ctx.bumps.writer;
        let writer_seeds: &[&[u8]] = &[WRITER_SEED, &[writer_bump]];
        let signer_seeds = &[writer_seeds];
        let credit_accounts = deal_credit_graph::cpi::accounts::RecordPair {
            config: ctx.accounts.credit_config.to_account_info(),
            payer: ctx.accounts.payer.to_account_info(),
            recorder: ctx.accounts.writer.to_account_info(),
            party_a: ctx.accounts.party_a.to_account_info(),
            party_b: ctx.accounts.party_b.to_account_info(),
            a_identity: ctx.accounts.a_identity.to_account_info(),
            b_identity: ctx.accounts.b_identity.to_account_info(),
            a_owner_token: ctx.accounts.a_owner_token.to_account_info(),
            b_owner_token: ctx.accounts.b_owner_token.to_account_info(),
            a_credit: ctx.accounts.a_credit.to_account_info(),
            b_credit: ctx.accounts.b_credit.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        deal_credit_graph::cpi::record_pair(
            CpiContext::new_with_signer(
                ctx.accounts.credit_program.key(),
                credit_accounts,
                signer_seeds,
            ),
            ctx.accounts.valuation_receipt.base_credit_u,
        )?;

        let a_after = read_credit_score(&ctx.accounts.a_credit.to_account_info())?;
        let b_after = read_credit_score(&ctx.accounts.b_credit.to_account_info())?;
        let a_delta = a_after
            .checked_sub(a_before)
            .ok_or(FinalizerError::InvalidCreditAccount)?;
        let b_delta = b_after
            .checked_sub(b_before)
            .ok_or(FinalizerError::InvalidCreditAccount)?;

        write_credit_receipt(
            &mut ctx.accounts.credit_receipt,
            ctx.accounts.deal.key(),
            ctx.accounts.valuation_receipt.key(),
            ctx.accounts.a_identity.mint,
            ctx.accounts.b_identity.mint,
            ctx.accounts.valuation_receipt.base_credit_u,
            a_delta,
            b_delta,
            ctx.bumps.credit_receipt,
        )?;
        validate_credit_sequence(
            &ctx.accounts.asset_config,
            &ctx.accounts.instructions_sysvar,
            RECORD_COMPLETED_CREDIT_DISC,
        )
    }

    pub fn record_completed_credit_single(
        ctx: Context<RecordCompletedCreditSingle>,
        is_party_a: bool,
    ) -> Result<()> {
        assert_enabled(&ctx.accounts.config)?;
        let expected_a_mint = if is_party_a {
            ctx.accounts.identity.mint
        } else {
            Pubkey::default()
        };
        let expected_b_mint = if is_party_a {
            Pubkey::default()
        } else {
            ctx.accounts.identity.mint
        };
        require_keys_eq!(
            ctx.accounts.terms.a_identity_mint,
            expected_a_mint,
            FinalizerError::InvalidIdentityBinding
        );
        require_keys_eq!(
            ctx.accounts.terms.b_identity_mint,
            expected_b_mint,
            FinalizerError::InvalidIdentityBinding
        );
        validate_credit_inputs(
            &ctx.accounts.deal,
            &ctx.accounts.terminal_receipt,
            &ctx.accounts.valuation_receipt,
        )?;
        let expected_party = if is_party_a {
            ctx.accounts.deal.creator
        } else {
            ctx.accounts.deal.participant
        };
        require_keys_eq!(
            ctx.accounts.party.key(),
            expected_party,
            FinalizerError::InvalidCreditParty
        );

        let before = read_credit_score(&ctx.accounts.credit.to_account_info())?;
        let writer_bump = ctx.bumps.writer;
        let writer_seeds: &[&[u8]] = &[WRITER_SEED, &[writer_bump]];
        let signer_seeds = &[writer_seeds];
        let credit_accounts = deal_credit_graph::cpi::accounts::RecordSingle {
            config: ctx.accounts.credit_config.to_account_info(),
            payer: ctx.accounts.payer.to_account_info(),
            recorder: ctx.accounts.writer.to_account_info(),
            party: ctx.accounts.party.to_account_info(),
            identity: ctx.accounts.identity.to_account_info(),
            owner_token: ctx.accounts.owner_token.to_account_info(),
            credit: ctx.accounts.credit.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        deal_credit_graph::cpi::record_single(
            CpiContext::new_with_signer(
                ctx.accounts.credit_program.key(),
                credit_accounts,
                signer_seeds,
            ),
            ctx.accounts.valuation_receipt.base_credit_u,
        )?;
        let after = read_credit_score(&ctx.accounts.credit.to_account_info())?;
        let delta = after
            .checked_sub(before)
            .ok_or(FinalizerError::InvalidCreditAccount)?;
        let (a_identity_mint, b_identity_mint, a_delta, b_delta) = if is_party_a {
            (ctx.accounts.identity.mint, Pubkey::default(), delta, 0)
        } else {
            (Pubkey::default(), ctx.accounts.identity.mint, 0, delta)
        };
        write_credit_receipt(
            &mut ctx.accounts.credit_receipt,
            ctx.accounts.deal.key(),
            ctx.accounts.valuation_receipt.key(),
            a_identity_mint,
            b_identity_mint,
            ctx.accounts.valuation_receipt.base_credit_u,
            a_delta,
            b_delta,
            ctx.bumps.credit_receipt,
        )?;
        validate_credit_sequence(
            &ctx.accounts.asset_config,
            &ctx.accounts.instructions_sysvar,
            RECORD_COMPLETED_CREDIT_SINGLE_DISC,
        )
    }

    pub fn record_completed_credit_none(ctx: Context<RecordCompletedCreditNone>) -> Result<()> {
        assert_enabled(&ctx.accounts.config)?;
        require!(
            ctx.accounts.terms.a_identity_mint == Pubkey::default()
                && ctx.accounts.terms.b_identity_mint == Pubkey::default(),
            FinalizerError::InvalidIdentityBinding
        );
        validate_credit_inputs(
            &ctx.accounts.deal,
            &ctx.accounts.terminal_receipt,
            &ctx.accounts.valuation_receipt,
        )?;
        write_credit_receipt(
            &mut ctx.accounts.credit_receipt,
            ctx.accounts.deal.key(),
            ctx.accounts.valuation_receipt.key(),
            Pubkey::default(),
            Pubkey::default(),
            ctx.accounts.valuation_receipt.base_credit_u,
            0,
            0,
            ctx.bumps.credit_receipt,
        )?;
        validate_credit_sequence(
            &ctx.accounts.asset_config,
            &ctx.accounts.instructions_sysvar,
            RECORD_COMPLETED_CREDIT_NONE_DISC,
        )
    }
}

fn validate_completed_finalization_sequence(accounts: &FinalizeCompleted<'_>) -> Result<()> {
    if !accounts.asset_config.terminal_guard_enabled {
        return Ok(());
    }
    let following = [
        ExpectedInstruction::anchor(VALUATOR_PROGRAM_ID, VALUE_COMPLETED_DEAL_DISC)
            .account(1, accounts.deal.key()),
    ];
    validate_current_and_following(
        &accounts.instructions_sysvar.to_account_info(),
        crate::ID,
        FINALIZE_COMPLETED_DISC,
        &following,
    )
    .map_err(Into::into)
}

fn validate_non_completed_finalization_sequence(accounts: &FinalizeNonCompleted<'_>) -> Result<()> {
    if !accounts.asset_config.terminal_guard_enabled {
        return Ok(());
    }
    let following = expected_unlocks(&accounts.terms, accounts.deal.key());
    validate_current_and_following(
        &accounts.instructions_sysvar.to_account_info(),
        crate::ID,
        FINALIZE_NON_COMPLETED_DISC,
        &following,
    )
    .map_err(Into::into)
}

#[allow(clippy::too_many_arguments)]
fn validate_credit_sequence(
    asset_config: &Account<'_, ControllerConfig>,
    instructions_sysvar: &UncheckedAccount<'_>,
    current_discriminator: [u8; 8],
) -> Result<()> {
    if !asset_config.terminal_guard_enabled {
        return Ok(());
    }
    validate_current_and_following(
        &instructions_sysvar.to_account_info(),
        crate::ID,
        current_discriminator,
        &[],
    )
    .map_err(Into::into)
}

fn expected_unlocks(terms: &AssetTerms, deal: Pubkey) -> Vec<ExpectedInstruction> {
    let mut following = Vec::new();
    for identity_mint in [terms.a_identity_mint, terms.b_identity_mint] {
        if identity_mint != Pubkey::default() {
            following.push(
                ExpectedInstruction::anchor(deal_asset_controller::ID, UNLOCK_IDENTITY_DISC)
                    .account(3, deal)
                    .account(4, identity_mint),
            );
        }
    }
    following
}

fn validate_credit_inputs(
    deal: &Account<'_, DealAccount>,
    terminal_receipt: &Account<'_, TerminalReceipt>,
    valuation_receipt: &Account<'_, deal_credit_valuator::CreditValuationReceipt>,
) -> Result<()> {
    require!(
        deal.status == DealStatus::Completed,
        FinalizerError::InvalidTerminalStatus
    );
    require_keys_eq!(
        terminal_receipt.deal,
        deal.key(),
        FinalizerError::InvalidTerminalReceipt
    );
    require!(
        terminal_receipt.status == DealStatus::Completed,
        FinalizerError::InvalidTerminalReceipt
    );
    require_keys_eq!(
        valuation_receipt.deal,
        deal.key(),
        FinalizerError::InvalidValuationReceipt
    );
    require_eq!(
        valuation_receipt.ended_at,
        deal.ended_at,
        FinalizerError::InvalidValuationReceipt
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn write_credit_receipt(
    receipt: &mut Account<'_, CreditRecordingReceipt>,
    deal: Pubkey,
    valuation_receipt: Pubkey,
    a_identity_mint: Pubkey,
    b_identity_mint: Pubkey,
    base_credit_u: u128,
    a_delta: u128,
    b_delta: u128,
    bump: u8,
) -> Result<()> {
    let recorded_at = Clock::get()?.unix_timestamp;
    receipt.deal = deal;
    receipt.valuation_receipt = valuation_receipt;
    receipt.a_identity_mint = a_identity_mint;
    receipt.b_identity_mint = b_identity_mint;
    receipt.base_credit_u = base_credit_u;
    receipt.a_delta = a_delta;
    receipt.b_delta = b_delta;
    receipt.recorded_at = recorded_at;
    receipt.bump = bump;
    emit!(CompletedCreditRecorded {
        deal,
        valuation_receipt,
        a_identity_mint,
        b_identity_mint,
        base_credit_u,
        a_delta,
        b_delta,
        recorded_at,
    });
    Ok(())
}

fn read_credit_score(account: &AccountInfo<'_>) -> Result<u128> {
    if account.data_is_empty() {
        return Ok(0);
    }
    require_keys_eq!(
        *account.owner,
        deal_credit_graph::ID,
        FinalizerError::InvalidCreditAccount
    );
    let data = account.try_borrow_data()?;
    let credit = deal_credit_graph::CreditScore::try_deserialize(&mut data.as_ref())
        .map_err(|_| error!(FinalizerError::InvalidCreditAccount))?;
    Ok(credit.score)
}

fn assert_authority(config: &FinalizerConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        config.authority,
        authority.key(),
        FinalizerError::Unauthorized
    );
    Ok(())
}

fn assert_enabled(config: &FinalizerConfig) -> Result<()> {
    require!(!config.paused, FinalizerError::Paused);
    require_keys_eq!(
        config.history_index,
        deal_history_index::id(),
        FinalizerError::InvalidHistoryIndex
    );
    Ok(())
}

fn validate_history(config: &deal_history_index::HistoryConfig, writer: Pubkey) -> Result<()> {
    require!(!config.paused, FinalizerError::HistoryPaused);
    require_keys_eq!(
        config.trusted_writer,
        writer,
        FinalizerError::InvalidHistoryWriter
    );
    require_keys_eq!(
        config.core_program,
        deal_core::id(),
        FinalizerError::InvalidCoreProgram
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn add_completed_history<'info>(
    history_program: &Program<'info, deal_history_index::program::DealHistoryIndex>,
    history_config: &Account<'info, deal_history_index::HistoryConfig>,
    payer: &Signer<'info>,
    writer: &UncheckedAccount<'info>,
    user: &UncheckedAccount<'info>,
    deal: &Account<'info, DealAccount>,
    header: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let accounts = deal_history_index::cpi::accounts::AddCompleted {
        config: history_config.to_account_info(),
        payer: payer.to_account_info(),
        writer: writer.to_account_info(),
        user: user.to_account_info(),
        deal: deal.to_account_info(),
        header: header.to_account_info(),
        system_program: system_program.to_account_info(),
    };
    deal_history_index::cpi::add_completed(CpiContext::new_with_signer(
        history_program.key(),
        accounts,
        signer_seeds,
    ))
}

fn record_receipt(
    receipt: &mut Account<'_, TerminalReceipt>,
    deal: &DealAccount,
    deal_key: Pubkey,
    finalized_by: Pubkey,
    bump: u8,
) -> Result<()> {
    require!(deal.ended_at > 0, FinalizerError::MissingEndTime);
    let finalized_at = Clock::get()?.unix_timestamp;
    receipt.deal = deal_key;
    receipt.creator = deal.creator;
    receipt.participant = deal.participant;
    receipt.status = deal.status;
    receipt.completion_reason = deal.completion_reason;
    receipt.ended_at = deal.ended_at;
    receipt.finalized_at = finalized_at;
    receipt.finalized_by = finalized_by;
    receipt.bump = bump;
    emit!(DealTerminalFinalized {
        deal: deal_key,
        status: deal.status,
        completion_reason: deal.completion_reason,
        finalized_by,
        finalized_at,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(init, payer = payer, space = FinalizerConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, FinalizerConfig>,
    /// CHECK: Canonical PDA used only as a signer for downstream index writes.
    #[account(seeds = [WRITER_SEED], bump)]
    pub writer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, FinalizerConfig>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, FinalizerConfig>,
}

#[derive(Accounts)]
pub struct FinalizeCompleted<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, FinalizerConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub deal: Account<'info, DealAccount>,
    /// CHECK: Constrained to the immutable party stored in the deal.
    #[account(address = deal.creator)]
    pub creator: UncheckedAccount<'info>,
    /// CHECK: Constrained to the terminal participant stored in the deal.
    #[account(address = deal.participant)]
    pub participant: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = TerminalReceipt::SPACE,
        seeds = [RECEIPT_SEED, deal.key().as_ref()],
        bump
    )]
    pub receipt: Account<'info, TerminalReceipt>,
    pub system_program: Program<'info, System>,
    #[account(
        seeds = [deal_asset_controller::CONTROLLER_SEED],
        bump = asset_config.bump,
        seeds::program = deal_asset_controller::ID
    )]
    pub asset_config: Box<Account<'info, ControllerConfig>>,
    /// CHECK: Address-constrained Solana Instructions sysvar used by the terminal guard.
    #[account(address = deal_terminal_guard::instructions_sysvar_id())]
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(
        seeds = [deal_asset_controller::TERMS_SEED, deal.key().as_ref()],
        bump = terms.bump,
        seeds::program = deal_asset_controller::ID,
        constraint = terms.deal == deal.key()
    )]
    pub terms: Box<Account<'info, AssetTerms>>,
}

#[derive(Accounts)]
pub struct IndexCompletedHistory<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, FinalizerConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Canonical finalizer PDA signs downstream history writes.
    #[account(seeds = [WRITER_SEED], bump)]
    pub writer: UncheckedAccount<'info>,
    pub deal: Account<'info, DealAccount>,
    #[account(
        seeds = [RECEIPT_SEED, deal.key().as_ref()],
        bump = terminal_receipt.bump
    )]
    pub terminal_receipt: Account<'info, TerminalReceipt>,
    /// CHECK: Constrained to the immutable party stored in the deal.
    #[account(address = deal.creator)]
    pub creator: UncheckedAccount<'info>,
    /// CHECK: Constrained to the terminal participant stored in the deal.
    #[account(address = deal.participant)]
    pub participant: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = HistoryIndexReceipt::SPACE,
        seeds = [HISTORY_RECEIPT_SEED, deal.key().as_ref()],
        bump
    )]
    pub history_receipt: Account<'info, HistoryIndexReceipt>,
    #[account(
        seeds = [deal_history_index::CONFIG_SEED],
        bump = history_config.bump,
        seeds::program = deal_history_index::ID
    )]
    pub history_config: Account<'info, deal_history_index::HistoryConfig>,
    /// CHECK: Created and validated by the history program CPI.
    #[account(mut)]
    pub creator_header: UncheckedAccount<'info>,
    /// CHECK: Created and validated by the history program CPI.
    #[account(mut)]
    pub participant_header: UncheckedAccount<'info>,
    pub history_program: Program<'info, deal_history_index::program::DealHistoryIndex>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizeNonCompleted<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, FinalizerConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub deal: Account<'info, DealAccount>,
    #[account(
        init,
        payer = payer,
        space = TerminalReceipt::SPACE,
        seeds = [RECEIPT_SEED, deal.key().as_ref()],
        bump
    )]
    pub receipt: Account<'info, TerminalReceipt>,
    pub system_program: Program<'info, System>,
    #[account(
        seeds = [deal_asset_controller::TERMS_SEED, deal.key().as_ref()],
        bump = terms.bump,
        seeds::program = deal_asset_controller::ID,
        constraint = terms.deal == deal.key()
    )]
    pub terms: Box<Account<'info, AssetTerms>>,
    #[account(
        seeds = [deal_asset_controller::CONTROLLER_SEED],
        bump = asset_config.bump,
        seeds::program = deal_asset_controller::ID
    )]
    pub asset_config: Box<Account<'info, ControllerConfig>>,
    /// CHECK: Address-constrained Solana Instructions sysvar used by the terminal guard.
    #[account(address = deal_terminal_guard::instructions_sysvar_id())]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RecordCompletedCredit<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, FinalizerConfig>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Canonical finalizer PDA signs the CreditGraph CPI.
    #[account(seeds = [WRITER_SEED], bump)]
    pub writer: UncheckedAccount<'info>,
    pub deal: Box<Account<'info, DealAccount>>,
    #[account(
        seeds = [RECEIPT_SEED, deal.key().as_ref()],
        bump = terminal_receipt.bump
    )]
    pub terminal_receipt: Box<Account<'info, TerminalReceipt>>,
    #[account(
        seeds = [deal_credit_valuator::VALUATION_SEED, deal.key().as_ref()],
        bump = valuation_receipt.bump,
        seeds::program = deal_credit_valuator::ID
    )]
    pub valuation_receipt: Box<Account<'info, deal_credit_valuator::CreditValuationReceipt>>,
    #[account(
        seeds = [deal_credit_graph::CONFIG_SEED],
        bump = credit_config.bump,
        seeds::program = deal_credit_graph::ID
    )]
    pub credit_config: Box<Account<'info, deal_credit_graph::CreditConfig>>,
    /// CHECK: Constrained to the immutable creator stored in the deal.
    #[account(address = deal.creator)]
    pub party_a: UncheckedAccount<'info>,
    /// CHECK: Constrained to the terminal participant stored in the deal.
    #[account(address = deal.participant)]
    pub party_b: UncheckedAccount<'info>,
    #[account(
        seeds = [deal_identity::BINDING_SEED, deal.key().as_ref(), deal.creator.as_ref()],
        bump = a_binding.bump,
        seeds::program = deal_identity::ID,
        constraint = a_binding.deal == deal.key() @ FinalizerError::InvalidIdentityBinding,
        constraint = a_binding.party == deal.creator @ FinalizerError::InvalidIdentityBinding,
        constraint = a_binding.identity_mint == a_identity.mint @ FinalizerError::InvalidIdentityBinding,
        constraint = a_binding.lock_count > 0 @ FinalizerError::InvalidIdentityBinding,
        constraint = a_identity.lock_count > 0 @ FinalizerError::InvalidIdentityBinding
    )]
    pub a_binding: Box<Account<'info, deal_identity::DealIdentityBinding>>,
    #[account(
        seeds = [deal_identity::BINDING_SEED, deal.key().as_ref(), deal.participant.as_ref()],
        bump = b_binding.bump,
        seeds::program = deal_identity::ID,
        constraint = b_binding.deal == deal.key() @ FinalizerError::InvalidIdentityBinding,
        constraint = b_binding.party == deal.participant @ FinalizerError::InvalidIdentityBinding,
        constraint = b_binding.identity_mint == b_identity.mint @ FinalizerError::InvalidIdentityBinding,
        constraint = b_binding.lock_count > 0 @ FinalizerError::InvalidIdentityBinding,
        constraint = b_identity.lock_count > 0 @ FinalizerError::InvalidIdentityBinding
    )]
    pub b_binding: Box<Account<'info, deal_identity::DealIdentityBinding>>,
    pub a_identity: Box<Account<'info, deal_identity::IdentityRecord>>,
    pub b_identity: Box<Account<'info, deal_identity::IdentityRecord>>,
    pub a_owner_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub b_owner_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: CreditGraph validates and initializes the canonical score PDA.
    #[account(mut)]
    pub a_credit: UncheckedAccount<'info>,
    /// CHECK: CreditGraph validates and initializes the canonical score PDA.
    #[account(mut)]
    pub b_credit: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = CreditRecordingReceipt::SPACE,
        seeds = [CREDIT_RECEIPT_SEED, deal.key().as_ref()],
        bump
    )]
    pub credit_receipt: Box<Account<'info, CreditRecordingReceipt>>,
    pub credit_program: Program<'info, deal_credit_graph::program::DealCreditGraph>,
    pub system_program: Program<'info, System>,
    #[account(
        seeds = [deal_asset_controller::TERMS_SEED, deal.key().as_ref()],
        bump = terms.bump,
        seeds::program = deal_asset_controller::ID,
        constraint = terms.deal == deal.key()
    )]
    pub terms: Box<Account<'info, AssetTerms>>,
    #[account(
        seeds = [deal_asset_controller::CONTROLLER_SEED],
        bump = asset_config.bump,
        seeds::program = deal_asset_controller::ID
    )]
    pub asset_config: Box<Account<'info, ControllerConfig>>,
    /// CHECK: Address-constrained Solana Instructions sysvar used by the terminal guard.
    #[account(address = deal_terminal_guard::instructions_sysvar_id())]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(is_party_a: bool)]
pub struct RecordCompletedCreditSingle<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, FinalizerConfig>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Canonical finalizer PDA signs the CreditGraph CPI.
    #[account(seeds = [WRITER_SEED], bump)]
    pub writer: UncheckedAccount<'info>,
    pub deal: Box<Account<'info, DealAccount>>,
    #[account(
        seeds = [RECEIPT_SEED, deal.key().as_ref()],
        bump = terminal_receipt.bump
    )]
    pub terminal_receipt: Box<Account<'info, TerminalReceipt>>,
    #[account(
        seeds = [deal_credit_valuator::VALUATION_SEED, deal.key().as_ref()],
        bump = valuation_receipt.bump,
        seeds::program = deal_credit_valuator::ID
    )]
    pub valuation_receipt: Box<Account<'info, deal_credit_valuator::CreditValuationReceipt>>,
    #[account(
        seeds = [deal_credit_graph::CONFIG_SEED],
        bump = credit_config.bump,
        seeds::program = deal_credit_graph::ID
    )]
    pub credit_config: Box<Account<'info, deal_credit_graph::CreditConfig>>,
    /// CHECK: Constrained in the handler to the selected immutable Deal party.
    pub party: UncheckedAccount<'info>,
    #[account(
        seeds = [deal_identity::BINDING_SEED, deal.key().as_ref(), party.key().as_ref()],
        bump = binding.bump,
        seeds::program = deal_identity::ID,
        constraint = binding.deal == deal.key() @ FinalizerError::InvalidIdentityBinding,
        constraint = binding.party == party.key() @ FinalizerError::InvalidIdentityBinding,
        constraint = binding.identity_mint == identity.mint @ FinalizerError::InvalidIdentityBinding,
        constraint = binding.lock_count > 0 @ FinalizerError::InvalidIdentityBinding,
        constraint = identity.lock_count > 0 @ FinalizerError::InvalidIdentityBinding
    )]
    pub binding: Box<Account<'info, deal_identity::DealIdentityBinding>>,
    pub identity: Box<Account<'info, deal_identity::IdentityRecord>>,
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: CreditGraph validates and initializes the canonical score PDA.
    #[account(mut)]
    pub credit: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = CreditRecordingReceipt::SPACE,
        seeds = [CREDIT_RECEIPT_SEED, deal.key().as_ref()],
        bump
    )]
    pub credit_receipt: Box<Account<'info, CreditRecordingReceipt>>,
    pub credit_program: Program<'info, deal_credit_graph::program::DealCreditGraph>,
    pub system_program: Program<'info, System>,
    #[account(
        seeds = [deal_asset_controller::TERMS_SEED, deal.key().as_ref()],
        bump = terms.bump,
        seeds::program = deal_asset_controller::ID,
        constraint = terms.deal == deal.key()
    )]
    pub terms: Box<Account<'info, AssetTerms>>,
    #[account(
        seeds = [deal_asset_controller::CONTROLLER_SEED],
        bump = asset_config.bump,
        seeds::program = deal_asset_controller::ID
    )]
    pub asset_config: Box<Account<'info, ControllerConfig>>,
    /// CHECK: Address-constrained Solana Instructions sysvar used by the terminal guard.
    #[account(address = deal_terminal_guard::instructions_sysvar_id())]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RecordCompletedCreditNone<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, FinalizerConfig>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub deal: Box<Account<'info, DealAccount>>,
    #[account(
        seeds = [RECEIPT_SEED, deal.key().as_ref()],
        bump = terminal_receipt.bump
    )]
    pub terminal_receipt: Box<Account<'info, TerminalReceipt>>,
    #[account(
        seeds = [deal_credit_valuator::VALUATION_SEED, deal.key().as_ref()],
        bump = valuation_receipt.bump,
        seeds::program = deal_credit_valuator::ID
    )]
    pub valuation_receipt: Box<Account<'info, deal_credit_valuator::CreditValuationReceipt>>,
    #[account(
        init,
        payer = payer,
        space = CreditRecordingReceipt::SPACE,
        seeds = [CREDIT_RECEIPT_SEED, deal.key().as_ref()],
        bump
    )]
    pub credit_receipt: Box<Account<'info, CreditRecordingReceipt>>,
    pub system_program: Program<'info, System>,
    #[account(
        seeds = [deal_asset_controller::TERMS_SEED, deal.key().as_ref()],
        bump = terms.bump,
        seeds::program = deal_asset_controller::ID,
        constraint = terms.deal == deal.key()
    )]
    pub terms: Box<Account<'info, AssetTerms>>,
    #[account(
        seeds = [deal_asset_controller::CONTROLLER_SEED],
        bump = asset_config.bump,
        seeds::program = deal_asset_controller::ID
    )]
    pub asset_config: Box<Account<'info, ControllerConfig>>,
    /// CHECK: Address-constrained Solana Instructions sysvar used by the terminal guard.
    #[account(address = deal_terminal_guard::instructions_sysvar_id())]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[account]
pub struct FinalizerConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub history_index: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

impl FinalizerConfig {
    pub const SPACE: usize = 8 + (32 * 3) + 1 + 1;
}

#[account]
pub struct TerminalReceipt {
    pub deal: Pubkey,
    pub creator: Pubkey,
    pub participant: Pubkey,
    pub status: DealStatus,
    pub completion_reason: CompletionReason,
    pub ended_at: i64,
    pub finalized_at: i64,
    pub finalized_by: Pubkey,
    pub bump: u8,
}

impl TerminalReceipt {
    pub const SPACE: usize = 8 + (32 * 4) + 1 + 1 + 8 + 8 + 1;
}

#[account]
pub struct CreditRecordingReceipt {
    pub deal: Pubkey,
    pub valuation_receipt: Pubkey,
    pub a_identity_mint: Pubkey,
    pub b_identity_mint: Pubkey,
    pub base_credit_u: u128,
    pub a_delta: u128,
    pub b_delta: u128,
    pub recorded_at: i64,
    pub bump: u8,
}

#[account]
pub struct HistoryIndexReceipt {
    pub deal: Pubkey,
    pub indexed_by: Pubkey,
    pub indexed_at: i64,
    pub bump: u8,
}

impl HistoryIndexReceipt {
    pub const SPACE: usize = 8 + (32 * 2) + 8 + 1;
}

impl CreditRecordingReceipt {
    pub const SPACE: usize = 8 + (32 * 4) + (16 * 3) + 8 + 1;
}

#[event]
pub struct FinalizerInitialized {
    pub authority: Pubkey,
    pub history_index: Pubkey,
    pub writer: Pubkey,
}

#[event]
pub struct FinalizerPauseUpdated {
    pub paused: bool,
}

#[event]
pub struct FinalizerAuthorityProposed {
    pub pending_authority: Pubkey,
}

#[event]
pub struct FinalizerAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct DealTerminalFinalized {
    pub deal: Pubkey,
    pub status: DealStatus,
    pub completion_reason: CompletionReason,
    pub finalized_by: Pubkey,
    pub finalized_at: i64,
}

#[event]
pub struct CompletedHistoryIndexed {
    pub deal: Pubkey,
    pub indexed_by: Pubkey,
    pub indexed_at: i64,
}

#[event]
pub struct CompletedCreditRecorded {
    pub deal: Pubkey,
    pub valuation_receipt: Pubkey,
    pub a_identity_mint: Pubkey,
    pub b_identity_mint: Pubkey,
    pub base_credit_u: u128,
    pub a_delta: u128,
    pub b_delta: u128,
    pub recorded_at: i64,
}

#[error_code]
pub enum FinalizerError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("pending authority is invalid")]
    InvalidPendingAuthority,
    #[msg("finalizer is paused")]
    Paused,
    #[msg("deal is not in the required terminal state")]
    InvalidTerminalStatus,
    #[msg("completed deal has no participant")]
    ParticipantMissing,
    #[msg("completed deal assets have not been resolved")]
    AssetsNotResolved,
    #[msg("DC-to-DC fees have not been routed to C or burned")]
    DcFeesNotRouted,
    #[msg("terminal deal has no end timestamp")]
    MissingEndTime,
    #[msg("configured history index is invalid")]
    InvalidHistoryIndex,
    #[msg("history index is paused")]
    HistoryPaused,
    #[msg("history index does not trust the finalizer writer PDA")]
    InvalidHistoryWriter,
    #[msg("history index core program is invalid")]
    InvalidCoreProgram,
    #[msg("terminal receipt does not match the completed deal")]
    InvalidTerminalReceipt,
    #[msg("credit valuation receipt does not match the completed deal")]
    InvalidValuationReceipt,
    #[msg("credit score account is invalid")]
    InvalidCreditAccount,
    #[msg("identity is not the one bound to this deal party")]
    InvalidIdentityBinding,
    #[msg("selected credit party does not match the completed deal")]
    InvalidCreditParty,
}
