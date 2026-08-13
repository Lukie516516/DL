#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token::TokenAccount as IdentityTokenAccount;
use deal_d_token::{BalanceCheckpoint, DTokenConfig, HolderState, D_UNIT, SEAT_THRESHOLD};
use deal_governance_activity::{ActivityCheckpoint, ActivityConfig, IdentityActivity, DAY_SECONDS};
use deal_identity::IdentityRecord;

declare_id!("9t2XDazJT4p4FBMXZ4jiF5sX3TJYqqUP1jaoNMW9f4yH");

pub const CONFIG_SEED: &[u8] = b"deal-governance-config";
pub const EXECUTOR_SEED: &[u8] = b"deal-governance-executor";
pub const TARGET_SEED: &[u8] = b"deal-governance-target";
pub const PROPOSAL_SEED: &[u8] = b"deal-governance-proposal";
pub const D_VOTE_SEED: &[u8] = b"deal-governance-d-vote";
pub const NFT_VOTE_SEED: &[u8] = b"deal-governance-nft-vote";

pub const D_APPROVAL_THRESHOLD: u64 = 70 * D_UNIT;
pub const NFT_APPROVAL_BPS: u16 = 7_000;
pub const PARAMETER_WINDOW_SECONDS: u64 = 48 * 60 * 60;
pub const LONG_WINDOW_SECONDS: u64 = 120 * 60 * 60;
pub const MAX_PAYLOAD_BYTES: usize = 1_024;
pub const MAX_ACTION_ACCOUNTS: usize = 24;
pub const BPS_DENOMINATOR: u128 = 10_000;

#[program]
pub mod deal_governance {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        require_eq!(
            ctx.accounts.d_config.total_supply,
            100 * D_UNIT,
            GovernanceError::InvalidDConfig
        );
        require_keys_eq!(
            ctx.accounts.activity_config.identity_program,
            deal_identity::id(),
            GovernanceError::InvalidActivityConfig
        );
        let d_config = ctx.accounts.d_config.key();
        let activity_config = ctx.accounts.activity_config.key();
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.bootstrap_admin = ctx.accounts.authority.key();
        config.d_program = deal_d_token::id();
        config.d_config = d_config;
        config.activity_program = deal_governance_activity::id();
        config.activity_config = activity_config;
        config.d_approval_threshold = D_APPROVAL_THRESHOLD;
        config.nft_approval_bps = NFT_APPROVAL_BPS;
        config.parameter_window_seconds = PARAMETER_WINDOW_SECONDS;
        config.long_window_seconds = LONG_WINDOW_SECONDS;
        config.next_proposal_id = 0;
        config.bootstrap_locked = false;
        config.bump = ctx.bumps.config;
        config.executor_bump = ctx.bumps.executor_authority;
        emit!(GovernanceInitialized {
            authority: config.authority,
            executor_authority: ctx.accounts.executor_authority.key(),
            d_config,
            activity_config,
        });
        Ok(())
    }

    pub fn set_allowed_target(
        ctx: Context<SetAllowedTarget>,
        target: Pubkey,
        allowed: bool,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(target != Pubkey::default(), GovernanceError::ZeroAddress);
        let record = &mut ctx.accounts.target_record;
        record.target = target;
        record.allowed = allowed;
        record.bump = ctx.bumps.target_record;
        emit!(TargetPermissionUpdated { target, allowed });
        Ok(())
    }

    pub fn set_rules(
        ctx: Context<AdminConfig>,
        d_approval_threshold: u64,
        nft_approval_bps: u16,
        parameter_window_seconds: u64,
        long_window_seconds: u64,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            (SEAT_THRESHOLD..=100 * D_UNIT).contains(&d_approval_threshold),
            GovernanceError::InvalidThreshold
        );
        require!(
            (5_000..=10_000).contains(&nft_approval_bps),
            GovernanceError::InvalidThreshold
        );
        require!(
            (3_600..=7 * 86_400).contains(&parameter_window_seconds),
            GovernanceError::InvalidWindow
        );
        require!(
            (86_400..=30 * 86_400).contains(&long_window_seconds),
            GovernanceError::InvalidWindow
        );
        let config = &mut ctx.accounts.config;
        config.d_approval_threshold = d_approval_threshold;
        config.nft_approval_bps = nft_approval_bps;
        config.parameter_window_seconds = parameter_window_seconds;
        config.long_window_seconds = long_window_seconds;
        emit!(GovernanceRulesUpdated {
            d_approval_threshold,
            nft_approval_bps,
            parameter_window_seconds,
            long_window_seconds,
        });
        Ok(())
    }

    pub fn update_authority(ctx: Context<AdminConfig>, new_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        set_authority(&mut ctx.accounts.config, new_authority)
    }

    pub fn bootstrap_set_authority(
        ctx: Context<BootstrapAdmin>,
        new_authority: Pubkey,
    ) -> Result<()> {
        assert_bootstrap(&ctx.accounts.config, &ctx.accounts.bootstrap_admin)?;
        set_authority(&mut ctx.accounts.config, new_authority)
    }

    pub fn lock_bootstrap(ctx: Context<BootstrapAdmin>) -> Result<()> {
        assert_bootstrap(&ctx.accounts.config, &ctx.accounts.bootstrap_admin)?;
        ctx.accounts.config.bootstrap_locked = true;
        emit!(GovernanceBootstrapLocked {
            bootstrap_admin: ctx.accounts.bootstrap_admin.key(),
        });
        Ok(())
    }

    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        proposal_id: u64,
        kind: ProposalKind,
        target_program: Pubkey,
        payload: Vec<u8>,
        action_accounts: Vec<ActionAccountMeta>,
        description_hash: [u8; 32],
    ) -> Result<()> {
        require_eq!(
            proposal_id,
            ctx.accounts.config.next_proposal_id,
            GovernanceError::InvalidProposalId
        );
        require!(
            ctx.accounts.target_record.allowed,
            GovernanceError::TargetNotAllowed
        );
        require_keys_eq!(
            ctx.accounts.target_record.target,
            target_program,
            GovernanceError::TargetMismatch
        );
        require!(
            payload.len() <= MAX_PAYLOAD_BYTES,
            GovernanceError::PayloadTooLarge
        );
        require!(
            !action_accounts.is_empty() && action_accounts.len() <= MAX_ACTION_ACCOUNTS,
            GovernanceError::InvalidAccountList
        );
        require!(
            description_hash != [0; 32],
            GovernanceError::EmptyDescription
        );
        require_keys_eq!(
            ctx.accounts.config.d_config,
            ctx.accounts.d_config.key(),
            GovernanceError::InvalidDConfig
        );
        require_keys_eq!(
            ctx.accounts.d_config.mint,
            ctx.accounts.d_mint.key(),
            GovernanceError::InvalidDConfig
        );
        require_keys_eq!(
            ctx.accounts.proposer_state.owner,
            ctx.accounts.proposer.key(),
            GovernanceError::InvalidDHolder
        );
        require!(
            ctx.accounts.proposer_state.balance >= SEAT_THRESHOLD,
            GovernanceError::SeatRequired
        );
        require_keys_eq!(
            ctx.accounts.config.activity_config,
            ctx.accounts.activity_config.key(),
            GovernanceError::InvalidActivityConfig
        );

        let executor_key = ctx.accounts.executor_authority.key();
        require!(
            action_accounts
                .iter()
                .any(|meta| meta.pubkey == executor_key && meta.is_signer),
            GovernanceError::MissingExecutorSigner
        );
        require!(
            action_accounts
                .iter()
                .all(|meta| !meta.is_signer || meta.pubkey == executor_key),
            GovernanceError::UnsupportedSigner
        );

        let clock = Clock::get()?;
        require!(clock.unix_timestamp >= 0, GovernanceError::InvalidClock);
        if kind == ProposalKind::Major {
            let current_day = clock.unix_timestamp / DAY_SECONDS;
            require_eq!(
                ctx.accounts.activity_config.last_synced_day,
                current_day,
                GovernanceError::ActivitySupplyNotSynced
            );
        }
        let window = if kind == ProposalKind::Parameter {
            ctx.accounts.config.parameter_window_seconds
        } else {
            ctx.accounts.config.long_window_seconds
        };
        let ends_at = clock
            .unix_timestamp
            .checked_add(
                i64::try_from(window).map_err(|_| error!(GovernanceError::ArithmeticOverflow))?,
            )
            .ok_or_else(|| error!(GovernanceError::ArithmeticOverflow))?;
        let snapshot_slot = clock.slot.saturating_sub(1);
        let proposal = &mut ctx.accounts.proposal;
        proposal.id = proposal_id;
        proposal.proposer = ctx.accounts.proposer.key();
        proposal.kind = kind;
        proposal.snapshot_slot = snapshot_slot;
        proposal.snapshot_timestamp = clock.unix_timestamp;
        proposal.ends_at = ends_at;
        proposal.active_nft_supply = if kind == ProposalKind::Major {
            ctx.accounts.activity_config.active_total
        } else {
            0
        };
        proposal.d_support = 0;
        proposal.nft_support = 0;
        proposal.target_program = target_program;
        proposal.payload = payload;
        proposal.action_accounts = action_accounts;
        proposal.description_hash = description_hash;
        proposal.vetoer = Pubkey::default();
        proposal.vetoed = false;
        proposal.executed = false;
        proposal.canceled = false;
        proposal.bump = ctx.bumps.proposal;
        ctx.accounts.config.next_proposal_id = ctx
            .accounts
            .config
            .next_proposal_id
            .checked_add(1)
            .ok_or_else(|| error!(GovernanceError::ArithmeticOverflow))?;
        emit!(ProposalCreated {
            proposal_id,
            proposer: proposal.proposer,
            kind,
            snapshot_slot,
            snapshot_timestamp: proposal.snapshot_timestamp,
            ends_at,
            active_nft_supply: proposal.active_nft_supply,
            target_program,
            description_hash,
        });
        Ok(())
    }

    pub fn cast_d_vote(ctx: Context<CastDVote>) -> Result<()> {
        assert_proposal_active(&ctx.accounts.proposal)?;
        let weight = validate_d_snapshot(
            &ctx.accounts.config,
            &ctx.accounts.d_config,
            &ctx.accounts.voter_state,
            &ctx.accounts.balance_checkpoint,
            ctx.accounts
                .successor_checkpoint
                .as_deref()
                .map(|account| &**account),
            ctx.accounts.voter.key(),
            ctx.accounts.proposal.snapshot_slot,
        )?;
        require!(weight > 0, GovernanceError::NoVotingPower);
        let receipt = &mut ctx.accounts.vote_receipt;
        receipt.proposal = ctx.accounts.proposal.key();
        receipt.voter = ctx.accounts.voter.key();
        receipt.weight = weight;
        receipt.bump = ctx.bumps.vote_receipt;
        ctx.accounts.proposal.d_support = ctx
            .accounts
            .proposal
            .d_support
            .checked_add(weight)
            .ok_or_else(|| error!(GovernanceError::ArithmeticOverflow))?;
        emit!(DVoteCast {
            proposal_id: ctx.accounts.proposal.id,
            voter: receipt.voter,
            weight,
            total_support: ctx.accounts.proposal.d_support,
        });
        Ok(())
    }

    pub fn cast_nft_vote(ctx: Context<CastNftVote>, new_checkpoint_index: u64) -> Result<()> {
        assert_proposal_active(&ctx.accounts.proposal)?;
        require!(
            ctx.accounts.proposal.kind == ProposalKind::Major,
            GovernanceError::NftVoteNotAllowed
        );
        require!(
            ctx.accounts.proposal.active_nft_supply > 0,
            GovernanceError::NoActiveNftSupply
        );
        validate_identity_owner(
            &ctx.accounts.identity,
            ctx.accounts.identity_mint.key(),
            &ctx.accounts.owner_identity,
            ctx.accounts.voter.key(),
        )?;
        validate_activity_snapshot(
            &ctx.accounts.config,
            &ctx.accounts.activity_config,
            &ctx.accounts.activity,
            &ctx.accounts.activity_checkpoint,
            ctx.accounts
                .successor_activity_checkpoint
                .as_deref()
                .map(|account| &**account),
            ctx.accounts.identity_mint.key(),
            ctx.accounts.proposal.snapshot_slot,
            ctx.accounts.proposal.snapshot_timestamp,
        )?;

        let receipt = &mut ctx.accounts.vote_receipt;
        receipt.proposal = ctx.accounts.proposal.key();
        receipt.identity_mint = ctx.accounts.identity_mint.key();
        receipt.voter = ctx.accounts.voter.key();
        receipt.bump = ctx.bumps.vote_receipt;
        ctx.accounts.proposal.nft_support = ctx
            .accounts
            .proposal
            .nft_support
            .checked_add(1)
            .ok_or_else(|| error!(GovernanceError::ArithmeticOverflow))?;

        let executor_bump = [ctx.accounts.config.executor_bump];
        let executor_seeds: &[&[u8]] = &[EXECUTOR_SEED, &executor_bump];
        let cpi_accounts = deal_governance_activity::cpi::accounts::MarkActive {
            payer: ctx.accounts.voter.to_account_info(),
            recorder: ctx.accounts.executor_authority.to_account_info(),
            owner: ctx.accounts.voter.to_account_info(),
            config: ctx.accounts.activity_config.to_account_info(),
            recorder_grant: ctx.accounts.activity_recorder_grant.to_account_info(),
            identity_mint: ctx.accounts.identity_mint.to_account_info(),
            identity: ctx.accounts.identity.to_account_info(),
            owner_identity: ctx.accounts.owner_identity.to_account_info(),
            activity: ctx.accounts.activity.to_account_info(),
            checkpoint: ctx.accounts.new_activity_checkpoint.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        deal_governance_activity::cpi::mark_active(
            CpiContext::new_with_signer(
                ctx.accounts.activity_program.key(),
                cpi_accounts,
                &[executor_seeds],
            ),
            new_checkpoint_index,
        )?;
        emit!(NftVoteCast {
            proposal_id: ctx.accounts.proposal.id,
            identity_mint: receipt.identity_mint,
            voter: receipt.voter,
            total_support: ctx.accounts.proposal.nft_support,
        });
        Ok(())
    }

    pub fn veto(ctx: Context<VetoProposal>) -> Result<()> {
        assert_proposal_active(&ctx.accounts.proposal)?;
        let weight = validate_d_snapshot(
            &ctx.accounts.config,
            &ctx.accounts.d_config,
            &ctx.accounts.vetoer_state,
            &ctx.accounts.balance_checkpoint,
            ctx.accounts
                .successor_checkpoint
                .as_deref()
                .map(|account| &**account),
            ctx.accounts.vetoer.key(),
            ctx.accounts.proposal.snapshot_slot,
        )?;
        require!(weight >= SEAT_THRESHOLD, GovernanceError::SeatRequired);
        ctx.accounts.proposal.vetoed = true;
        ctx.accounts.proposal.vetoer = ctx.accounts.vetoer.key();
        emit!(ProposalVetoed {
            proposal_id: ctx.accounts.proposal.id,
            vetoer: ctx.accounts.vetoer.key(),
            snapshot_weight: weight,
        });
        Ok(())
    }

    pub fn cancel(ctx: Context<CancelProposal>) -> Result<()> {
        assert_proposal_active(&ctx.accounts.proposal)?;
        require_keys_eq!(
            ctx.accounts.proposal.proposer,
            ctx.accounts.proposer.key(),
            GovernanceError::NotProposer
        );
        require_eq!(
            ctx.accounts.proposal.d_support,
            0,
            GovernanceError::VotesAlreadyCast
        );
        require_eq!(
            ctx.accounts.proposal.nft_support,
            0,
            GovernanceError::VotesAlreadyCast
        );
        ctx.accounts.proposal.canceled = true;
        emit!(ProposalCanceled {
            proposal_id: ctx.accounts.proposal.id
        });
        Ok(())
    }

    pub fn execute<'info>(ctx: Context<'info, ExecuteProposal<'info>>) -> Result<()> {
        let state = compute_state(&ctx.accounts.config, &ctx.accounts.proposal)?;
        require!(
            state == ProposalState::Succeeded,
            GovernanceError::ProposalNotSucceeded
        );
        require!(
            ctx.accounts.target_record.allowed,
            GovernanceError::TargetNotAllowed
        );
        require_keys_eq!(
            ctx.accounts.target_record.target,
            ctx.accounts.proposal.target_program,
            GovernanceError::TargetMismatch
        );
        require_keys_eq!(
            ctx.accounts.target_program.key(),
            ctx.accounts.proposal.target_program,
            GovernanceError::TargetMismatch
        );

        let executor_key = ctx.accounts.executor_authority.key();
        let mut metas = Vec::with_capacity(ctx.accounts.proposal.action_accounts.len());
        let mut infos = Vec::with_capacity(ctx.accounts.proposal.action_accounts.len() + 1);
        for expected in &ctx.accounts.proposal.action_accounts {
            if expected.is_signer && expected.pubkey != executor_key {
                return err!(GovernanceError::UnsupportedSigner);
            }
            let info = if expected.pubkey == executor_key {
                ctx.accounts.executor_authority.to_account_info()
            } else {
                ctx.remaining_accounts
                    .iter()
                    .find(|account| account.key() == expected.pubkey)
                    .cloned()
                    .ok_or_else(|| error!(GovernanceError::InvalidAccountList))?
            };
            if expected.is_writable && !info.is_writable {
                return err!(GovernanceError::AccountNotWritable);
            }
            metas.push(if expected.is_writable {
                AccountMeta::new(expected.pubkey, expected.is_signer)
            } else {
                AccountMeta::new_readonly(expected.pubkey, expected.is_signer)
            });
            infos.push(info);
        }
        infos.push(ctx.accounts.target_program.to_account_info());
        let instruction = Instruction {
            program_id: ctx.accounts.proposal.target_program,
            accounts: metas,
            data: ctx.accounts.proposal.payload.clone(),
        };
        let executor_bump = [ctx.accounts.config.executor_bump];
        let executor_seeds: &[&[u8]] = &[EXECUTOR_SEED, &executor_bump];
        ctx.accounts.proposal.executed = true;
        invoke_signed(&instruction, &infos, &[executor_seeds])
            .map_err(|_| error!(GovernanceError::TargetExecutionFailed))?;
        emit!(ProposalExecuted {
            proposal_id: ctx.accounts.proposal.id,
            target_program: ctx.accounts.proposal.target_program,
        });
        Ok(())
    }

    pub fn proposal_state(ctx: Context<ReadProposal>) -> Result<ProposalState> {
        compute_state(&ctx.accounts.config, &ctx.accounts.proposal)
    }
}

fn assert_authority(config: &GovernanceConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        config.authority,
        authority.key(),
        GovernanceError::NotAuthority
    );
    Ok(())
}

fn assert_bootstrap(config: &GovernanceConfig, bootstrap_admin: &Signer<'_>) -> Result<()> {
    require!(!config.bootstrap_locked, GovernanceError::BootstrapLocked);
    require_keys_eq!(
        config.bootstrap_admin,
        bootstrap_admin.key(),
        GovernanceError::NotBootstrapAdmin
    );
    Ok(())
}

fn set_authority(config: &mut Account<'_, GovernanceConfig>, new_authority: Pubkey) -> Result<()> {
    require!(
        new_authority != Pubkey::default(),
        GovernanceError::ZeroAddress
    );
    let old_authority = config.authority;
    config.authority = new_authority;
    emit!(GovernanceAuthorityUpdated {
        old_authority,
        new_authority
    });
    Ok(())
}

fn assert_proposal_active(proposal: &Proposal) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        !proposal.executed && !proposal.vetoed && !proposal.canceled,
        GovernanceError::ProposalEnded
    );
    require!(now <= proposal.ends_at, GovernanceError::VotingClosed);
    Ok(())
}

fn validate_d_snapshot(
    config: &GovernanceConfig,
    d_config: &DTokenConfig,
    holder: &HolderState,
    checkpoint: &BalanceCheckpoint,
    successor: Option<&BalanceCheckpoint>,
    voter: Pubkey,
    snapshot_slot: u64,
) -> Result<u64> {
    require_keys_eq!(
        config.d_program,
        deal_d_token::id(),
        GovernanceError::InvalidDConfig
    );
    require_eq!(
        d_config.total_supply,
        100 * D_UNIT,
        GovernanceError::InvalidDConfig
    );
    require_keys_eq!(holder.owner, voter, GovernanceError::InvalidDHolder);
    require_keys_eq!(
        checkpoint.owner,
        voter,
        GovernanceError::InvalidBalanceProof
    );
    require!(
        checkpoint.slot <= snapshot_slot,
        GovernanceError::InvalidBalanceProof
    );
    let next_index = checkpoint
        .index
        .checked_add(1)
        .ok_or_else(|| error!(GovernanceError::ArithmeticOverflow))?;
    if next_index < holder.checkpoint_count {
        let next = successor.ok_or_else(|| error!(GovernanceError::MissingSuccessorCheckpoint))?;
        require_keys_eq!(next.owner, voter, GovernanceError::InvalidBalanceProof);
        require_eq!(next.index, next_index, GovernanceError::InvalidBalanceProof);
        require!(
            next.slot > snapshot_slot,
            GovernanceError::InvalidBalanceProof
        );
    } else {
        require_eq!(
            next_index,
            holder.checkpoint_count,
            GovernanceError::InvalidBalanceProof
        );
    }
    Ok(checkpoint.balance)
}

fn validate_identity_owner(
    identity: &IdentityRecord,
    mint: Pubkey,
    token: &IdentityTokenAccount,
    owner: Pubkey,
) -> Result<()> {
    require_keys_eq!(identity.mint, mint, GovernanceError::InvalidIdentity);
    require_keys_eq!(token.mint, mint, GovernanceError::InvalidIdentity);
    require_keys_eq!(token.owner, owner, GovernanceError::NotIdentityOwner);
    require_eq!(token.amount, 1, GovernanceError::NotIdentityOwner);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_activity_snapshot(
    config: &GovernanceConfig,
    activity_config: &ActivityConfig,
    activity: &IdentityActivity,
    checkpoint: &ActivityCheckpoint,
    successor: Option<&ActivityCheckpoint>,
    identity_mint: Pubkey,
    snapshot_slot: u64,
    snapshot_timestamp: i64,
) -> Result<()> {
    require_keys_eq!(
        config.activity_program,
        deal_governance_activity::id(),
        GovernanceError::InvalidActivityConfig
    );
    require_keys_eq!(
        activity.identity_mint,
        identity_mint,
        GovernanceError::InvalidActivityProof
    );
    require_keys_eq!(
        checkpoint.identity_mint,
        identity_mint,
        GovernanceError::InvalidActivityProof
    );
    require!(
        checkpoint.slot <= snapshot_slot,
        GovernanceError::InvalidActivityProof
    );
    require!(
        checkpoint.timestamp <= snapshot_timestamp,
        GovernanceError::InvalidActivityProof
    );
    let expires_at = checkpoint
        .timestamp
        .checked_add(
            i64::try_from(activity_config.active_window_seconds)
                .map_err(|_| error!(GovernanceError::ArithmeticOverflow))?,
        )
        .ok_or_else(|| error!(GovernanceError::ArithmeticOverflow))?;
    require!(
        snapshot_timestamp <= expires_at,
        GovernanceError::InactiveIdentity
    );
    let next_index = checkpoint
        .index
        .checked_add(1)
        .ok_or_else(|| error!(GovernanceError::ArithmeticOverflow))?;
    if next_index < activity.checkpoint_count {
        let next = successor.ok_or_else(|| error!(GovernanceError::MissingSuccessorCheckpoint))?;
        require_keys_eq!(
            next.identity_mint,
            identity_mint,
            GovernanceError::InvalidActivityProof
        );
        require_eq!(
            next.index,
            next_index,
            GovernanceError::InvalidActivityProof
        );
        require!(
            next.slot > snapshot_slot,
            GovernanceError::InvalidActivityProof
        );
    } else {
        require_eq!(
            next_index,
            activity.checkpoint_count,
            GovernanceError::InvalidActivityProof
        );
    }
    Ok(())
}

fn compute_state(config: &GovernanceConfig, proposal: &Proposal) -> Result<ProposalState> {
    if proposal.executed {
        return Ok(ProposalState::Executed);
    }
    if proposal.vetoed {
        return Ok(ProposalState::Vetoed);
    }
    if proposal.canceled {
        return Ok(ProposalState::Canceled);
    }
    if Clock::get()?.unix_timestamp <= proposal.ends_at {
        return Ok(ProposalState::Active);
    }
    if proposal.d_support < config.d_approval_threshold {
        return Ok(ProposalState::Defeated);
    }
    if proposal.kind == ProposalKind::Major {
        if proposal.active_nft_supply == 0 {
            return Ok(ProposalState::Defeated);
        }
        let support = u128::from(proposal.nft_support)
            .checked_mul(BPS_DENOMINATOR)
            .ok_or_else(|| error!(GovernanceError::ArithmeticOverflow))?;
        let required = u128::from(proposal.active_nft_supply)
            .checked_mul(u128::from(config.nft_approval_bps))
            .ok_or_else(|| error!(GovernanceError::ArithmeticOverflow))?;
        if support < required {
            return Ok(ProposalState::Defeated);
        }
    }
    Ok(ProposalState::Succeeded)
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(init, payer = payer, space = GovernanceConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, GovernanceConfig>>,
    #[account(
        seeds = [deal_d_token::CONFIG_SEED],
        bump = d_config.bump,
        seeds::program = deal_d_token::id()
    )]
    pub d_config: Box<Account<'info, DTokenConfig>>,
    #[account(
        seeds = [deal_governance_activity::CONFIG_SEED],
        bump = activity_config.bump,
        seeds::program = deal_governance_activity::id()
    )]
    pub activity_config: Box<Account<'info, ActivityConfig>>,
    /// CHECK: Canonical PDA signs only successful proposal actions.
    #[account(seeds = [EXECUTOR_SEED], bump)]
    pub executor_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, GovernanceConfig>>,
}

#[derive(Accounts)]
pub struct BootstrapAdmin<'info> {
    pub bootstrap_admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, GovernanceConfig>>,
}

#[derive(Accounts)]
#[instruction(target: Pubkey)]
pub struct SetAllowedTarget<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, GovernanceConfig>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = AllowedTarget::SPACE,
        seeds = [TARGET_SEED, target.as_ref()],
        bump
    )]
    pub target_record: Account<'info, AllowedTarget>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proposal_id: u64, kind: ProposalKind, target_program: Pubkey)]
pub struct CreateProposal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub proposer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, GovernanceConfig>>,
    #[account(address = config.d_config @ GovernanceError::InvalidDConfig)]
    pub d_config: Box<Account<'info, DTokenConfig>>,
    /// CHECK: D mint key is matched against the canonical D config.
    pub d_mint: UncheckedAccount<'info>,
    #[account(
        seeds = [deal_d_token::HOLDER_SEED, proposer.key().as_ref()],
        bump = proposer_state.bump,
        seeds::program = deal_d_token::id()
    )]
    pub proposer_state: Box<Account<'info, HolderState>>,
    #[account(address = config.activity_config @ GovernanceError::InvalidActivityConfig)]
    pub activity_config: Box<Account<'info, ActivityConfig>>,
    #[account(
        seeds = [TARGET_SEED, target_program.as_ref()],
        bump = target_record.bump
    )]
    pub target_record: Account<'info, AllowedTarget>,
    #[account(
        init,
        payer = payer,
        space = Proposal::SPACE,
        seeds = [PROPOSAL_SEED, &proposal_id.to_le_bytes()],
        bump
    )]
    pub proposal: Box<Account<'info, Proposal>>,
    /// CHECK: Canonical executor PDA is embedded into the action account list.
    #[account(seeds = [EXECUTOR_SEED], bump = config.executor_bump)]
    pub executor_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CastDVote<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub voter: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, GovernanceConfig>>,
    #[account(address = config.d_config @ GovernanceError::InvalidDConfig)]
    pub d_config: Box<Account<'info, DTokenConfig>>,
    #[account(
        seeds = [deal_d_token::HOLDER_SEED, voter.key().as_ref()],
        bump = voter_state.bump,
        seeds::program = deal_d_token::id()
    )]
    pub voter_state: Box<Account<'info, HolderState>>,
    #[account(
        seeds = [
            deal_d_token::CHECKPOINT_SEED,
            voter.key().as_ref(),
            &balance_checkpoint.index.to_le_bytes()
        ],
        bump = balance_checkpoint.bump,
        seeds::program = deal_d_token::id()
    )]
    pub balance_checkpoint: Box<Account<'info, BalanceCheckpoint>>,
    #[account(
        seeds = [
            deal_d_token::CHECKPOINT_SEED,
            voter.key().as_ref(),
            &successor_checkpoint.index.to_le_bytes()
        ],
        bump = successor_checkpoint.bump,
        seeds::program = deal_d_token::id()
    )]
    pub successor_checkpoint: Option<Box<Account<'info, BalanceCheckpoint>>>,
    #[account(mut, seeds = [PROPOSAL_SEED, &proposal.id.to_le_bytes()], bump = proposal.bump)]
    pub proposal: Box<Account<'info, Proposal>>,
    #[account(
        init,
        payer = payer,
        space = DVoteReceipt::SPACE,
        seeds = [D_VOTE_SEED, proposal.key().as_ref(), voter.key().as_ref()],
        bump
    )]
    pub vote_receipt: Account<'info, DVoteReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(new_checkpoint_index: u64)]
pub struct CastNftVote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, GovernanceConfig>>,
    #[account(mut, seeds = [PROPOSAL_SEED, &proposal.id.to_le_bytes()], bump = proposal.bump)]
    pub proposal: Box<Account<'info, Proposal>>,
    /// CHECK: Bound to the official identity record and owner token account.
    pub identity_mint: UncheckedAccount<'info>,
    #[account(
        seeds = [deal_identity::IDENTITY_SEED, identity_mint.key().as_ref()],
        bump = identity.bump,
        seeds::program = deal_identity::id()
    )]
    pub identity: Box<Account<'info, IdentityRecord>>,
    pub owner_identity: Box<Account<'info, IdentityTokenAccount>>,
    #[account(mut, address = config.activity_config @ GovernanceError::InvalidActivityConfig)]
    pub activity_config: Box<Account<'info, ActivityConfig>>,
    #[account(
        mut,
        seeds = [deal_governance_activity::ACTIVITY_SEED, identity_mint.key().as_ref()],
        bump = activity.bump,
        seeds::program = deal_governance_activity::id()
    )]
    pub activity: Box<Account<'info, IdentityActivity>>,
    #[account(
        seeds = [
            deal_governance_activity::CHECKPOINT_SEED,
            identity_mint.key().as_ref(),
            &activity_checkpoint.index.to_le_bytes()
        ],
        bump = activity_checkpoint.bump,
        seeds::program = deal_governance_activity::id()
    )]
    pub activity_checkpoint: Box<Account<'info, ActivityCheckpoint>>,
    #[account(
        seeds = [
            deal_governance_activity::CHECKPOINT_SEED,
            identity_mint.key().as_ref(),
            &successor_activity_checkpoint.index.to_le_bytes()
        ],
        bump = successor_activity_checkpoint.bump,
        seeds::program = deal_governance_activity::id()
    )]
    pub successor_activity_checkpoint: Option<Box<Account<'info, ActivityCheckpoint>>>,
    /// CHECK: Recorder permission PDA is validated by the activity CPI.
    pub activity_recorder_grant: UncheckedAccount<'info>,
    /// CHECK: Canonical governance PDA signs as the authorized activity recorder.
    #[account(seeds = [EXECUTOR_SEED], bump = config.executor_bump)]
    pub executor_authority: UncheckedAccount<'info>,
    /// CHECK: New checkpoint PDA is initialized and validated by the activity CPI.
    #[account(mut)]
    pub new_activity_checkpoint: UncheckedAccount<'info>,
    #[account(
        init,
        payer = voter,
        space = NftVoteReceipt::SPACE,
        seeds = [NFT_VOTE_SEED, proposal.key().as_ref(), identity_mint.key().as_ref()],
        bump
    )]
    pub vote_receipt: Account<'info, NftVoteReceipt>,
    pub activity_program: Program<'info, deal_governance_activity::program::DealGovernanceActivity>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VetoProposal<'info> {
    pub vetoer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, GovernanceConfig>>,
    #[account(address = config.d_config @ GovernanceError::InvalidDConfig)]
    pub d_config: Box<Account<'info, DTokenConfig>>,
    #[account(
        seeds = [deal_d_token::HOLDER_SEED, vetoer.key().as_ref()],
        bump = vetoer_state.bump,
        seeds::program = deal_d_token::id()
    )]
    pub vetoer_state: Box<Account<'info, HolderState>>,
    #[account(
        seeds = [
            deal_d_token::CHECKPOINT_SEED,
            vetoer.key().as_ref(),
            &balance_checkpoint.index.to_le_bytes()
        ],
        bump = balance_checkpoint.bump,
        seeds::program = deal_d_token::id()
    )]
    pub balance_checkpoint: Box<Account<'info, BalanceCheckpoint>>,
    #[account(
        seeds = [
            deal_d_token::CHECKPOINT_SEED,
            vetoer.key().as_ref(),
            &successor_checkpoint.index.to_le_bytes()
        ],
        bump = successor_checkpoint.bump,
        seeds::program = deal_d_token::id()
    )]
    pub successor_checkpoint: Option<Box<Account<'info, BalanceCheckpoint>>>,
    #[account(mut, seeds = [PROPOSAL_SEED, &proposal.id.to_le_bytes()], bump = proposal.bump)]
    pub proposal: Box<Account<'info, Proposal>>,
}

#[derive(Accounts)]
pub struct CancelProposal<'info> {
    pub proposer: Signer<'info>,
    #[account(mut, seeds = [PROPOSAL_SEED, &proposal.id.to_le_bytes()], bump = proposal.bump)]
    pub proposal: Box<Account<'info, Proposal>>,
}

#[derive(Accounts)]
pub struct ExecuteProposal<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, GovernanceConfig>>,
    #[account(mut, seeds = [PROPOSAL_SEED, &proposal.id.to_le_bytes()], bump = proposal.bump)]
    pub proposal: Box<Account<'info, Proposal>>,
    #[account(
        seeds = [TARGET_SEED, proposal.target_program.as_ref()],
        bump = target_record.bump
    )]
    pub target_record: Account<'info, AllowedTarget>,
    /// CHECK: Canonical PDA signs the successful proposal action.
    #[account(seeds = [EXECUTOR_SEED], bump = config.executor_bump)]
    pub executor_authority: UncheckedAccount<'info>,
    /// CHECK: Address and executable program are validated against the proposal.
    pub target_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ReadProposal<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, GovernanceConfig>>,
    #[account(seeds = [PROPOSAL_SEED, &proposal.id.to_le_bytes()], bump = proposal.bump)]
    pub proposal: Box<Account<'info, Proposal>>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProposalKind {
    Parameter,
    Treasury,
    Major,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProposalState {
    Active,
    Succeeded,
    Defeated,
    Vetoed,
    Executed,
    Canceled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ActionAccountMeta {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}
impl ActionAccountMeta {
    pub const SPACE: usize = 32 + 1 + 1;
}

#[account]
pub struct GovernanceConfig {
    pub authority: Pubkey,
    pub bootstrap_admin: Pubkey,
    pub d_program: Pubkey,
    pub d_config: Pubkey,
    pub activity_program: Pubkey,
    pub activity_config: Pubkey,
    pub d_approval_threshold: u64,
    pub nft_approval_bps: u16,
    pub parameter_window_seconds: u64,
    pub long_window_seconds: u64,
    pub next_proposal_id: u64,
    pub bootstrap_locked: bool,
    pub bump: u8,
    pub executor_bump: u8,
}
impl GovernanceConfig {
    pub const SPACE: usize = 8 + (32 * 6) + 8 + 2 + (8 * 3) + 1 + 2;
}

#[account]
pub struct AllowedTarget {
    pub target: Pubkey,
    pub allowed: bool,
    pub bump: u8,
}
impl AllowedTarget {
    pub const SPACE: usize = 8 + 32 + 1 + 1;
}

#[account]
pub struct Proposal {
    pub id: u64,
    pub proposer: Pubkey,
    pub kind: ProposalKind,
    pub snapshot_slot: u64,
    pub snapshot_timestamp: i64,
    pub ends_at: i64,
    pub active_nft_supply: u64,
    pub d_support: u64,
    pub nft_support: u64,
    pub target_program: Pubkey,
    pub payload: Vec<u8>,
    pub action_accounts: Vec<ActionAccountMeta>,
    pub description_hash: [u8; 32],
    pub vetoer: Pubkey,
    pub vetoed: bool,
    pub executed: bool,
    pub canceled: bool,
    pub bump: u8,
}
impl Proposal {
    pub const SPACE: usize = 8
        + 8
        + 32
        + 1
        + (8 * 6)
        + 32
        + 4
        + MAX_PAYLOAD_BYTES
        + 4
        + (MAX_ACTION_ACCOUNTS * ActionAccountMeta::SPACE)
        + 32
        + 32
        + 4;
}

#[account]
pub struct DVoteReceipt {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub weight: u64,
    pub bump: u8,
}
impl DVoteReceipt {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 1;
}

#[account]
pub struct NftVoteReceipt {
    pub proposal: Pubkey,
    pub identity_mint: Pubkey,
    pub voter: Pubkey,
    pub bump: u8,
}
impl NftVoteReceipt {
    pub const SPACE: usize = 8 + (32 * 3) + 1;
}

#[event]
pub struct GovernanceInitialized {
    pub authority: Pubkey,
    pub executor_authority: Pubkey,
    pub d_config: Pubkey,
    pub activity_config: Pubkey,
}
#[event]
pub struct TargetPermissionUpdated {
    pub target: Pubkey,
    pub allowed: bool,
}
#[event]
pub struct GovernanceRulesUpdated {
    pub d_approval_threshold: u64,
    pub nft_approval_bps: u16,
    pub parameter_window_seconds: u64,
    pub long_window_seconds: u64,
}
#[event]
pub struct GovernanceAuthorityUpdated {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}
#[event]
pub struct GovernanceBootstrapLocked {
    pub bootstrap_admin: Pubkey,
}
#[event]
pub struct ProposalCreated {
    pub proposal_id: u64,
    pub proposer: Pubkey,
    pub kind: ProposalKind,
    pub snapshot_slot: u64,
    pub snapshot_timestamp: i64,
    pub ends_at: i64,
    pub active_nft_supply: u64,
    pub target_program: Pubkey,
    pub description_hash: [u8; 32],
}
#[event]
pub struct DVoteCast {
    pub proposal_id: u64,
    pub voter: Pubkey,
    pub weight: u64,
    pub total_support: u64,
}
#[event]
pub struct NftVoteCast {
    pub proposal_id: u64,
    pub identity_mint: Pubkey,
    pub voter: Pubkey,
    pub total_support: u64,
}
#[event]
pub struct ProposalVetoed {
    pub proposal_id: u64,
    pub vetoer: Pubkey,
    pub snapshot_weight: u64,
}
#[event]
pub struct ProposalCanceled {
    pub proposal_id: u64,
}
#[event]
pub struct ProposalExecuted {
    pub proposal_id: u64,
    pub target_program: Pubkey,
}

#[error_code]
pub enum GovernanceError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not the governance authority")]
    NotAuthority,
    #[msg("caller is not the bootstrap admin")]
    NotBootstrapAdmin,
    #[msg("bootstrap authority is permanently locked")]
    BootstrapLocked,
    #[msg("governance threshold is invalid")]
    InvalidThreshold,
    #[msg("governance voting window is invalid")]
    InvalidWindow,
    #[msg("proposal id is not the next sequential id")]
    InvalidProposalId,
    #[msg("target program is not allowed")]
    TargetNotAllowed,
    #[msg("target program does not match")]
    TargetMismatch,
    #[msg("proposal payload is too large")]
    PayloadTooLarge,
    #[msg("proposal account list is invalid")]
    InvalidAccountList,
    #[msg("proposal description hash cannot be empty")]
    EmptyDescription,
    #[msg("D config is invalid")]
    InvalidDConfig,
    #[msg("D holder state is invalid")]
    InvalidDHolder,
    #[msg("2.5 D seat is required")]
    SeatRequired,
    #[msg("activity config is invalid")]
    InvalidActivityConfig,
    #[msg("activity supply must be synchronized before proposal creation")]
    ActivitySupplyNotSynced,
    #[msg("executor PDA signer is missing from the action")]
    MissingExecutorSigner,
    #[msg("action requests an unsupported signer")]
    UnsupportedSigner,
    #[msg("proposal has ended")]
    ProposalEnded,
    #[msg("proposal voting window is closed")]
    VotingClosed,
    #[msg("D balance proof is invalid")]
    InvalidBalanceProof,
    #[msg("successor checkpoint is required to prove the snapshot balance")]
    MissingSuccessorCheckpoint,
    #[msg("snapshot has no voting power")]
    NoVotingPower,
    #[msg("NFT voting is only available for major proposals")]
    NftVoteNotAllowed,
    #[msg("major proposal has no active NFT supply snapshot")]
    NoActiveNftSupply,
    #[msg("official identity NFT is invalid")]
    InvalidIdentity,
    #[msg("signer does not own the official identity NFT")]
    NotIdentityOwner,
    #[msg("activity checkpoint proof is invalid")]
    InvalidActivityProof,
    #[msg("identity NFT was not active at the proposal snapshot")]
    InactiveIdentity,
    #[msg("only the proposal creator can cancel it")]
    NotProposer,
    #[msg("proposal with votes cannot be canceled")]
    VotesAlreadyCast,
    #[msg("proposal has not passed all required chambers")]
    ProposalNotSucceeded,
    #[msg("action account must be writable")]
    AccountNotWritable,
    #[msg("target program execution failed")]
    TargetExecutionFailed,
    #[msg("clock timestamp is invalid")]
    InvalidClock,
    #[msg("arithmetic overflow")]
    ArithmeticOverflow,
}
