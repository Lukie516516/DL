#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod state;

use constants::*;
use errors::DealCoreError;
use state::*;

declare_id!("4pPmeaNz9YQzLhVUPmySMRbcyKTau44h7tJDbAxtot5g");

#[program]
pub mod deal_core {
    use super::*;

    pub fn initialize_registry(
        ctx: Context<InitializeRegistry>,
        asset_controller: Pubkey,
        identity_controller: Pubkey,
    ) -> Result<()> {
        require!(
            asset_controller != Pubkey::default() && identity_controller != Pubkey::default(),
            DealCoreError::ZeroAuthority
        );
        let registry = &mut ctx.accounts.registry;
        registry.authority = ctx.accounts.authority.key();
        registry.pending_authority = Pubkey::default();
        registry.asset_controller = asset_controller;
        registry.identity_controller = identity_controller;
        registry.domain_entry_controller = Pubkey::default();
        registry.next_deal_id = 1;
        registry.min_timeout_seconds = DEFAULT_MIN_TIMEOUT_SECONDS;
        registry.paused = true;
        registry.bump = ctx.bumps.registry;
        emit!(RegistryInitialized {
            authority: registry.authority,
            asset_controller,
            identity_controller,
            min_timeout_seconds: registry.min_timeout_seconds,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.registry, &ctx.accounts.authority)?;
        ctx.accounts.registry.paused = paused;
        emit!(PauseUpdated { paused });
        Ok(())
    }

    pub fn set_asset_controller(ctx: Context<AdminConfig>, asset_controller: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.registry, &ctx.accounts.authority)?;
        require!(
            asset_controller != Pubkey::default(),
            DealCoreError::ZeroAuthority
        );
        let old_controller = ctx.accounts.registry.asset_controller;
        ctx.accounts.registry.asset_controller = asset_controller;
        emit!(AssetControllerUpdated {
            old_controller,
            new_controller: asset_controller,
        });
        Ok(())
    }

    pub fn set_identity_controller(
        ctx: Context<AdminConfig>,
        identity_controller: Pubkey,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.registry, &ctx.accounts.authority)?;
        require!(
            identity_controller != Pubkey::default(),
            DealCoreError::ZeroAuthority
        );
        let old_controller = ctx.accounts.registry.identity_controller;
        ctx.accounts.registry.identity_controller = identity_controller;
        emit!(IdentityControllerUpdated {
            old_controller,
            new_controller: identity_controller,
        });
        Ok(())
    }

    pub fn set_min_timeout_seconds(
        ctx: Context<AdminConfig>,
        min_timeout_seconds: u64,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.registry, &ctx.accounts.authority)?;
        require!(
            (MIN_CONFIGURABLE_TIMEOUT_SECONDS..=MAX_TIMEOUT_SECONDS).contains(&min_timeout_seconds),
            DealCoreError::InvalidMinTimeout
        );
        let old_min_timeout_seconds = ctx.accounts.registry.min_timeout_seconds;
        ctx.accounts.registry.min_timeout_seconds = min_timeout_seconds;
        emit!(MinTimeoutUpdated {
            old_min_timeout_seconds,
            new_min_timeout_seconds: min_timeout_seconds,
        });
        Ok(())
    }

    pub fn set_domain_entry_controller(
        ctx: Context<AdminConfig>,
        domain_entry_controller: Pubkey,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.registry, &ctx.accounts.authority)?;
        require!(
            domain_entry_controller != Pubkey::default(),
            DealCoreError::ZeroAuthority
        );
        let old_controller = ctx.accounts.registry.domain_entry_controller;
        ctx.accounts.registry.domain_entry_controller = domain_entry_controller;
        emit!(DomainEntryControllerUpdated {
            old_controller,
            new_controller: domain_entry_controller,
        });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.registry, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            DealCoreError::ZeroAuthority
        );
        ctx.accounts.registry.pending_authority = pending_authority;
        emit!(AuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.registry.pending_authority,
            ctx.accounts.pending_authority.key(),
            DealCoreError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.registry.authority;
        ctx.accounts.registry.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.registry.pending_authority = Pubkey::default();
        emit!(AuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.registry.authority,
        });
        Ok(())
    }

    pub fn create_deal(
        ctx: Context<CreateDeal>,
        deal_id: u64,
        params: CreateDealParams,
    ) -> Result<()> {
        require!(!params.is_domain_deal, DealCoreError::DomainEntryRequired);
        create_deal_inner(
            &mut ctx.accounts.registry,
            &mut ctx.accounts.deal,
            ctx.accounts.creator.key(),
            ctx.bumps.deal,
            deal_id,
            params,
        )
    }

    pub fn create_domain_deal(
        ctx: Context<CreateDomainDeal>,
        deal_id: u64,
        params: CreateDealParams,
    ) -> Result<()> {
        require!(params.is_domain_deal, DealCoreError::DomainEntryRequired);
        require_keys_eq!(
            ctx.accounts.registry.domain_entry_controller,
            ctx.accounts.domain_entry_controller.key(),
            DealCoreError::InvalidDomainEntryController
        );
        create_deal_inner(
            &mut ctx.accounts.registry,
            &mut ctx.accounts.deal,
            ctx.accounts.creator.key(),
            ctx.bumps.deal,
            deal_id,
            params,
        )
    }

    pub fn update_amounts(
        ctx: Context<PartyAction>,
        a_swap_amount: u64,
        a_margin_amount: u64,
        b_swap_amount: u64,
        b_margin_amount: u64,
    ) -> Result<()> {
        ctx.accounts.deal.update_amounts(
            ctx.accounts.actor.key(),
            a_swap_amount,
            a_margin_amount,
            b_swap_amount,
            b_margin_amount,
        )?;
        emit!(AmountsUpdated {
            deal: ctx.accounts.deal.key(),
            a_swap_amount,
            a_margin_amount,
            b_swap_amount,
            b_margin_amount,
        });
        Ok(())
    }

    pub fn open_join_for(ctx: Context<PartyAction>, chosen: Pubkey) -> Result<()> {
        ctx.accounts
            .deal
            .open_join_for(ctx.accounts.actor.key(), chosen)?;
        emit!(ExpectedParticipantUpdated {
            deal: ctx.accounts.deal.key(),
            expected_participant: chosen,
        });
        Ok(())
    }

    pub fn join_deal(ctx: Context<JoinDeal>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts
            .deal
            .join(ctx.accounts.participant.key(), false, now)?;
        emit_join_events(&ctx.accounts.deal, now);
        Ok(())
    }

    pub fn join_gated_deal(ctx: Context<JoinGatedDeal>) -> Result<()> {
        assert_identity_controller(&ctx.accounts.registry, &ctx.accounts.identity_controller)?;
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts
            .deal
            .join(ctx.accounts.participant.key(), true, now)?;
        emit_join_events(&ctx.accounts.deal, now);
        Ok(())
    }

    pub fn record_deposit(
        ctx: Context<AssetAction>,
        is_party_a: bool,
        kind: DepositKind,
    ) -> Result<()> {
        assert_asset_controller(&ctx.accounts.registry, &ctx.accounts.asset_controller)?;
        let now = Clock::get()?.unix_timestamp;
        let locked =
            ctx.accounts
                .deal
                .record_deposit(ctx.accounts.actor.key(), is_party_a, kind, now)?;
        emit!(DepositRecorded {
            deal: ctx.accounts.deal.key(),
            actor: ctx.accounts.actor.key(),
            is_party_a,
            kind,
            at: now,
        });
        if locked {
            emit!(DealLocked {
                deal: ctx.accounts.deal.key(),
                at: now,
            });
        }
        Ok(())
    }

    pub fn record_withdrawal(ctx: Context<AssetAction>, is_party_a: bool) -> Result<()> {
        assert_asset_controller(&ctx.accounts.registry, &ctx.accounts.asset_controller)?;
        ctx.accounts
            .deal
            .record_withdrawal(ctx.accounts.actor.key(), is_party_a)?;
        emit!(WithdrawalRecorded {
            deal: ctx.accounts.deal.key(),
            actor: ctx.accounts.actor.key(),
            is_party_a,
            at: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn pre_accept(ctx: Context<PartyAction>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts
            .deal
            .pre_accept(ctx.accounts.actor.key(), now)?;
        emit!(DealPreAccepted {
            deal: ctx.accounts.deal.key(),
            creator: ctx.accounts.actor.key(),
            at: now,
        });
        Ok(())
    }

    pub fn cast_vote(ctx: Context<PartyAction>, vote: Vote) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let actor = ctx.accounts.actor.key();
        let is_party_a = actor == ctx.accounts.deal.creator;
        ctx.accounts.deal.cast_vote(actor, vote, now)?;
        emit!(VoteRecorded {
            deal: ctx.accounts.deal.key(),
            actor,
            is_party_a,
            vote,
            at: now,
        });
        Ok(())
    }

    pub fn settle_votes(ctx: Context<Settlement>) -> Result<()> {
        assert_asset_controller(&ctx.accounts.registry, &ctx.accounts.asset_controller)?;
        let now = Clock::get()?.unix_timestamp;
        let outcome = ctx.accounts.deal.settle_votes(now)?;
        match outcome {
            SettlementOutcome::Completed => emit!(DealCompleted {
                deal: ctx.accounts.deal.key(),
                reason: CompletionReason::BothAccepted,
                at: now,
            }),
            SettlementOutcome::Canceled => emit!(DealCanceled {
                deal: ctx.accounts.deal.key(),
                at: now,
            }),
            SettlementOutcome::ParticipantExpelled(participant) => emit!(ParticipantRemoved {
                deal: ctx.accounts.deal.key(),
                participant,
                reason: 3,
                at: now,
            }),
        }
        Ok(())
    }

    pub fn force_complete(ctx: Context<AssetAction>) -> Result<()> {
        assert_asset_controller(&ctx.accounts.registry, &ctx.accounts.asset_controller)?;
        let now = Clock::get()?.unix_timestamp;
        let reason = ctx
            .accounts
            .deal
            .force_complete(ctx.accounts.actor.key(), now)?;
        emit!(DealCompleted {
            deal: ctx.accounts.deal.key(),
            reason,
            at: now,
        });
        Ok(())
    }

    pub fn exit_by_b(ctx: Context<AssetAction>) -> Result<()> {
        assert_asset_controller(&ctx.accounts.registry, &ctx.accounts.asset_controller)?;
        let removed = ctx.accounts.deal.exit_by_b(ctx.accounts.actor.key())?;
        emit!(ParticipantRemoved {
            deal: ctx.accounts.deal.key(),
            participant: removed,
            reason: 1,
            at: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn kick_b_by_a(ctx: Context<AssetAction>) -> Result<()> {
        assert_asset_controller(&ctx.accounts.registry, &ctx.accounts.asset_controller)?;
        let removed = ctx.accounts.deal.kick_b_by_a(ctx.accounts.actor.key())?;
        emit!(ParticipantRemoved {
            deal: ctx.accounts.deal.key(),
            participant: removed,
            reason: 2,
            at: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn replace_inactive_b(ctx: Context<AssetAction>) -> Result<()> {
        assert_asset_controller(&ctx.accounts.registry, &ctx.accounts.asset_controller)?;
        let now = Clock::get()?.unix_timestamp;
        let candidate = ctx.accounts.actor.key();
        let removed = ctx.accounts.deal.replace_inactive_b(candidate, now)?;
        emit!(ParticipantReplaced {
            deal: ctx.accounts.deal.key(),
            removed,
            replacement: candidate,
            reason: 1,
            at: now,
        });
        Ok(())
    }

    pub fn replace_non_voting_b(ctx: Context<AssetAction>) -> Result<()> {
        assert_asset_controller(&ctx.accounts.registry, &ctx.accounts.asset_controller)?;
        let now = Clock::get()?.unix_timestamp;
        let candidate = ctx.accounts.actor.key();
        let removed = ctx.accounts.deal.replace_non_voting_b(candidate, now)?;
        emit!(ParticipantReplaced {
            deal: ctx.accounts.deal.key(),
            removed,
            replacement: candidate,
            reason: 2,
            at: now,
        });
        Ok(())
    }

    pub fn abandon(ctx: Context<AssetAction>) -> Result<()> {
        assert_asset_controller(&ctx.accounts.registry, &ctx.accounts.asset_controller)?;
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.deal.abandon(ctx.accounts.actor.key(), now)?;
        emit!(DealAbandoned {
            deal: ctx.accounts.deal.key(),
            creator: ctx.accounts.actor.key(),
            at: now,
        });
        Ok(())
    }
}

fn emit_join_events(deal: &Account<'_, DealAccount>, now: i64) {
    emit!(ParticipantJoined {
        deal: deal.key(),
        participant: deal.participant,
        at: now,
    });
    if deal.status == DealStatus::Locked {
        emit!(DealLocked {
            deal: deal.key(),
            at: now,
        });
    }
}

fn assert_authority(registry: &DealRegistry, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        registry.authority,
        authority.key(),
        DealCoreError::Unauthorized
    );
    Ok(())
}

fn create_deal_inner(
    registry: &mut Account<'_, DealRegistry>,
    deal: &mut Account<'_, DealAccount>,
    creator: Pubkey,
    deal_bump: u8,
    deal_id: u64,
    params: CreateDealParams,
) -> Result<()> {
    require!(!registry.paused, DealCoreError::Paused);
    require_eq!(deal_id, registry.next_deal_id, DealCoreError::InvalidDealId);
    require!(
        params.timeout_seconds >= registry.min_timeout_seconds,
        DealCoreError::InvalidTimeout
    );
    let now = Clock::get()?.unix_timestamp;
    deal.initialize(deal_id, creator, deal_bump, params, now)?;
    registry.next_deal_id = deal_id
        .checked_add(1)
        .ok_or_else(|| error!(DealCoreError::DealIdOverflow))?;
    emit!(DealCreated {
        deal: deal.key(),
        deal_id,
        creator,
        template_type: deal.template_type,
        join_mode: deal.join_mode,
        created_at: now,
    });
    Ok(())
}

fn assert_asset_controller(registry: &DealRegistry, controller: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        registry.asset_controller,
        controller.key(),
        DealCoreError::InvalidAssetController
    );
    Ok(())
}

fn assert_identity_controller(registry: &DealRegistry, controller: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        registry.identity_controller,
        controller.key(),
        DealCoreError::InvalidIdentityController
    );
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeRegistry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = DealRegistry::SPACE,
        seeds = [REGISTRY_SEED],
        bump
    )]
    pub registry: Account<'info, DealRegistry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, DealRegistry>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, DealRegistry>,
}

#[derive(Accounts)]
#[instruction(deal_id: u64)]
pub struct CreateDeal<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, DealRegistry>,
    #[account(
        init,
        payer = creator,
        space = DealAccount::SPACE,
        seeds = [DEAL_SEED, deal_id.to_le_bytes().as_ref()],
        bump
    )]
    pub deal: Account<'info, DealAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(deal_id: u64)]
pub struct CreateDomainDeal<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub domain_entry_controller: Signer<'info>,
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, DealRegistry>,
    #[account(
        init,
        payer = creator,
        space = DealAccount::SPACE,
        seeds = [DEAL_SEED, deal_id.to_le_bytes().as_ref()],
        bump
    )]
    pub deal: Account<'info, DealAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PartyAction<'info> {
    pub actor: Signer<'info>,
    #[account(mut)]
    pub deal: Account<'info, DealAccount>,
}

#[derive(Accounts)]
pub struct JoinDeal<'info> {
    pub participant: Signer<'info>,
    #[account(mut)]
    pub deal: Account<'info, DealAccount>,
}

#[derive(Accounts)]
pub struct JoinGatedDeal<'info> {
    pub participant: Signer<'info>,
    pub identity_controller: Signer<'info>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, DealRegistry>,
    #[account(mut)]
    pub deal: Account<'info, DealAccount>,
}

#[derive(Accounts)]
pub struct AssetAction<'info> {
    pub actor: Signer<'info>,
    pub asset_controller: Signer<'info>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, DealRegistry>,
    #[account(mut)]
    pub deal: Account<'info, DealAccount>,
}

#[derive(Accounts)]
pub struct Settlement<'info> {
    pub asset_controller: Signer<'info>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, DealRegistry>,
    #[account(mut)]
    pub deal: Account<'info, DealAccount>,
}

#[event]
pub struct RegistryInitialized {
    pub authority: Pubkey,
    pub asset_controller: Pubkey,
    pub identity_controller: Pubkey,
    pub min_timeout_seconds: u64,
}

#[event]
pub struct PauseUpdated {
    pub paused: bool,
}

#[event]
pub struct AssetControllerUpdated {
    pub old_controller: Pubkey,
    pub new_controller: Pubkey,
}

#[event]
pub struct IdentityControllerUpdated {
    pub old_controller: Pubkey,
    pub new_controller: Pubkey,
}

#[event]
pub struct DomainEntryControllerUpdated {
    pub old_controller: Pubkey,
    pub new_controller: Pubkey,
}

#[event]
pub struct MinTimeoutUpdated {
    pub old_min_timeout_seconds: u64,
    pub new_min_timeout_seconds: u64,
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
pub struct DealCreated {
    pub deal: Pubkey,
    pub deal_id: u64,
    pub creator: Pubkey,
    pub template_type: TemplateType,
    pub join_mode: JoinMode,
    pub created_at: i64,
}

#[event]
pub struct AmountsUpdated {
    pub deal: Pubkey,
    pub a_swap_amount: u64,
    pub a_margin_amount: u64,
    pub b_swap_amount: u64,
    pub b_margin_amount: u64,
}

#[event]
pub struct ExpectedParticipantUpdated {
    pub deal: Pubkey,
    pub expected_participant: Pubkey,
}

#[event]
pub struct ParticipantJoined {
    pub deal: Pubkey,
    pub participant: Pubkey,
    pub at: i64,
}

#[event]
pub struct ParticipantRemoved {
    pub deal: Pubkey,
    pub participant: Pubkey,
    pub reason: u8,
    pub at: i64,
}

#[event]
pub struct ParticipantReplaced {
    pub deal: Pubkey,
    pub removed: Pubkey,
    pub replacement: Pubkey,
    pub reason: u8,
    pub at: i64,
}

#[event]
pub struct DepositRecorded {
    pub deal: Pubkey,
    pub actor: Pubkey,
    pub is_party_a: bool,
    pub kind: DepositKind,
    pub at: i64,
}

#[event]
pub struct WithdrawalRecorded {
    pub deal: Pubkey,
    pub actor: Pubkey,
    pub is_party_a: bool,
    pub at: i64,
}

#[event]
pub struct DealLocked {
    pub deal: Pubkey,
    pub at: i64,
}

#[event]
pub struct DealPreAccepted {
    pub deal: Pubkey,
    pub creator: Pubkey,
    pub at: i64,
}

#[event]
pub struct VoteRecorded {
    pub deal: Pubkey,
    pub actor: Pubkey,
    pub is_party_a: bool,
    pub vote: Vote,
    pub at: i64,
}

#[event]
pub struct DealCompleted {
    pub deal: Pubkey,
    pub reason: CompletionReason,
    pub at: i64,
}

#[event]
pub struct DealCanceled {
    pub deal: Pubkey,
    pub at: i64,
}

#[event]
pub struct DealAbandoned {
    pub deal: Pubkey,
    pub creator: Pubkey,
    pub at: i64,
}
