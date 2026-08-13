#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

pub mod constants;
pub mod errors;
pub mod state;

use constants::*;
use errors::GovernanceError;
use state::*;

declare_id!("7SQaq2kgAZKV7hUnpW1ZZVoXXdg9JfzEH8qh4VzEAx8Q");

#[program]
pub mod deal_governance_executor {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        source_chain: u64,
        source_broadcaster: [u8; 32],
        bridge_signers: [Pubkey; BRIDGE_COUNT],
        threshold: u8,
    ) -> Result<()> {
        GovernanceConfig::validate_bridges(&bridge_signers, threshold)?;
        require!(
            source_broadcaster != [0; 32],
            GovernanceError::WrongSourceBroadcaster
        );

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = ZERO_PUBKEY;
        config.source_chain = source_chain;
        config.source_broadcaster = source_broadcaster;
        config.bridge_signers = bridge_signers;
        config.bridge_set_version = 1;
        config.threshold = threshold;
        config.paused = true;
        config.last_executed_nonce = 0;
        config.bump = ctx.bumps.config;
        config.executor_bump = ctx.bumps.executor_authority;

        emit!(ConfigInitialized {
            authority: config.authority,
            source_chain,
            source_broadcaster,
            threshold,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.paused = paused;
        emit!(PauseUpdated { paused });
        Ok(())
    }

    pub fn set_threshold(ctx: Context<AdminConfig>, threshold: u8) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        GovernanceConfig::validate_bridges(&ctx.accounts.config.bridge_signers, threshold)?;
        ctx.accounts.config.threshold = threshold;
        emit!(ThresholdUpdated { threshold });
        Ok(())
    }

    pub fn set_bridge_signer(
        ctx: Context<AdminConfig>,
        bridge_index: u8,
        bridge_signer: Pubkey,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            usize::from(bridge_index) < BRIDGE_COUNT,
            GovernanceError::InvalidBridgeIndex
        );
        require!(
            bridge_signer != ZERO_PUBKEY,
            GovernanceError::InvalidBridgeConfiguration
        );

        let mut updated = ctx.accounts.config.bridge_signers;
        updated[usize::from(bridge_index)] = bridge_signer;
        GovernanceConfig::validate_bridges(&updated, ctx.accounts.config.threshold)?;
        ctx.accounts.config.bridge_signers = updated;
        ctx.accounts.config.bridge_set_version = ctx
            .accounts
            .config
            .bridge_set_version
            .checked_add(1)
            .ok_or_else(|| error!(GovernanceError::BridgeSetVersionOverflow))?;
        emit!(BridgeSignerUpdated {
            bridge_index,
            bridge_signer,
            bridge_set_version: ctx.accounts.config.bridge_set_version,
        });
        Ok(())
    }

    pub fn set_source(
        ctx: Context<AdminConfig>,
        source_chain: u64,
        source_broadcaster: [u8; 32],
    ) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            source_broadcaster != [0; 32],
            GovernanceError::WrongSourceBroadcaster
        );
        ctx.accounts.config.source_chain = source_chain;
        ctx.accounts.config.source_broadcaster = source_broadcaster;
        ctx.accounts.config.bridge_set_version = ctx
            .accounts
            .config
            .bridge_set_version
            .checked_add(1)
            .ok_or_else(|| error!(GovernanceError::BridgeSetVersionOverflow))?;
        emit!(SourceUpdated {
            source_chain,
            source_broadcaster,
            bridge_set_version: ctx.accounts.config.bridge_set_version,
        });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != ZERO_PUBKEY,
            GovernanceError::InvalidPendingAuthority
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(AuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            GovernanceError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = ZERO_PUBKEY;
        emit!(AuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority,
        });
        Ok(())
    }

    pub fn set_allowed_target(
        ctx: Context<SetAllowedTarget>,
        target: Pubkey,
        allowed: bool,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(target != ZERO_PUBKEY, GovernanceError::ZeroTarget);
        let target_record = &mut ctx.accounts.target_record;
        target_record.target = target;
        target_record.allowed = allowed;
        target_record.bump = ctx.bumps.target_record;
        emit!(TargetPermissionUpdated { target, allowed });
        Ok(())
    }

    pub fn confirm_message(
        ctx: Context<ConfirmMessage>,
        message_hash: [u8; 32],
        envelope: GovernanceEnvelope,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, GovernanceError::Paused);
        envelope.validate(config)?;
        require!(
            envelope.canonical_hash() == message_hash,
            GovernanceError::InvalidMessageHash
        );

        let bridge_index = config.bridge_index(&ctx.accounts.bridge_signer.key())?;
        let message = &mut ctx.accounts.message;
        if message.is_uninitialized() {
            message.initialize_from(message_hash, &envelope, ctx.bumps.message);
        } else {
            require!(
                message.matches(message_hash, &envelope),
                GovernanceError::MessageConflict
            );
        }

        let count = message.confirm(bridge_index, config.threshold)?;
        emit!(BridgeConfirmed {
            message_hash,
            bridge_index,
            confirmation_count: count,
            ready: message.ready,
        });
        Ok(())
    }

    pub fn cancel_message(ctx: Context<CancelMessage>) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            !ctx.accounts.message.executed,
            GovernanceError::MessageAlreadyExecuted
        );
        ctx.accounts.message.cancelled = true;
        emit!(MessageCancelled {
            message_hash: ctx.accounts.message.message_hash
        });
        Ok(())
    }

    pub fn execute_message<'info>(ctx: Context<'info, ExecuteMessage<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;
        let message = &mut ctx.accounts.message;

        require!(!config.paused, GovernanceError::Paused);
        require!(message.ready, GovernanceError::MessageNotReady);
        require!(!message.executed, GovernanceError::MessageAlreadyExecuted);
        require!(!message.cancelled, GovernanceError::MessageCancelled);
        require_eq!(
            message.bridge_set_version,
            config.bridge_set_version,
            GovernanceError::WrongBridgeSetVersion
        );
        require!(
            message.confirmations.count_ones() as u8 >= config.threshold,
            GovernanceError::MessageNotReady
        );
        require!(
            now >= message.valid_after,
            GovernanceError::MessageNotActive
        );
        require!(now <= message.expires_at, GovernanceError::MessageExpired);
        require!(
            message.nonce > config.last_executed_nonce,
            GovernanceError::StaleNonce
        );
        require!(
            ctx.accounts.target_record.allowed,
            GovernanceError::TargetNotAllowed
        );
        require_keys_eq!(
            message.target_program,
            ctx.accounts.target_program.key(),
            GovernanceError::TargetMismatch
        );

        let executor_key = ctx.accounts.executor_authority.key();
        let mut metas = Vec::with_capacity(message.accounts.len());
        let mut infos = Vec::with_capacity(message.accounts.len() + 1);
        let mut has_executor_signer = false;

        for expected in &message.accounts {
            if expected.is_signer && expected.pubkey != executor_key {
                return err!(GovernanceError::UnsupportedSigner);
            }
            if expected.is_signer && expected.pubkey == executor_key {
                has_executor_signer = true;
            }

            let info = if expected.pubkey == executor_key {
                ctx.accounts.executor_authority.to_account_info()
            } else {
                ctx.remaining_accounts
                    .iter()
                    .find(|candidate| candidate.key() == expected.pubkey)
                    .cloned()
                    .ok_or_else(|| error!(GovernanceError::AccountListMismatch))?
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

        require!(has_executor_signer, GovernanceError::MissingExecutorSigner);

        infos.push(ctx.accounts.target_program.to_account_info());
        let instruction = Instruction {
            program_id: message.target_program,
            accounts: metas,
            data: message.payload.clone(),
        };
        let authority_seeds: &[&[u8]] = &[EXECUTOR_AUTHORITY_SEED, &[config.executor_bump]];

        invoke_signed(&instruction, &infos, &[authority_seeds])
            .map_err(|_| error!(GovernanceError::TargetExecutionFailed))?;

        // A governance action may legitimately target this executor itself
        // (for example, accepting the final authority handoff). In that case
        // the inner CPI mutates the same config account held by this outer
        // instruction. Reload it before the outer Anchor account is serialized,
        // otherwise the stale outer value would overwrite the CPI mutation.
        if message.target_program == crate::ID {
            config.reload()?;
        }
        message.executed = true;
        config.last_executed_nonce = message.nonce;
        emit!(MessageExecuted {
            message_hash: message.message_hash,
            nonce: message.nonce,
            target_program: message.target_program,
        });
        Ok(())
    }
}

fn assert_authority(config: &GovernanceConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        config.authority,
        authority.key(),
        GovernanceError::Unauthorized
    );
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(init, payer = payer, space = GovernanceConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, GovernanceConfig>,
    /// CHECK: PDA signs only after a message reaches quorum.
    #[account(seeds = [EXECUTOR_AUTHORITY_SEED], bump)]
    pub executor_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GovernanceConfig>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GovernanceConfig>,
}

#[derive(Accounts)]
#[instruction(target: Pubkey)]
pub struct SetAllowedTarget<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GovernanceConfig>,
    #[account(
        init_if_needed,
        payer = authority,
        space = AllowedTarget::SPACE,
        seeds = [TARGET_SEED, target.as_ref()],
        bump
    )]
    pub target_record: Account<'info, AllowedTarget>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(message_hash: [u8; 32])]
pub struct ConfirmMessage<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub bridge_signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GovernanceConfig>,
    #[account(
        init_if_needed,
        payer = payer,
        space = MessageRecord::SPACE,
        seeds = [MESSAGE_SEED, message_hash.as_ref()],
        bump
    )]
    pub message: Account<'info, MessageRecord>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelMessage<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GovernanceConfig>,
    #[account(mut, seeds = [MESSAGE_SEED, message.message_hash.as_ref()], bump = message.bump)]
    pub message: Account<'info, MessageRecord>,
}

#[derive(Accounts)]
pub struct ExecuteMessage<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GovernanceConfig>,
    #[account(mut, seeds = [MESSAGE_SEED, message.message_hash.as_ref()], bump = message.bump)]
    pub message: Account<'info, MessageRecord>,
    #[account(
        seeds = [TARGET_SEED, target_program.key().as_ref()],
        bump = target_record.bump,
        constraint = target_record.target == target_program.key() @ GovernanceError::TargetMismatch
    )]
    pub target_record: Account<'info, AllowedTarget>,
    /// CHECK: PDA is the only signer accepted inside cross-chain target calls.
    #[account(mut, seeds = [EXECUTOR_AUTHORITY_SEED], bump = config.executor_bump)]
    pub executor_authority: UncheckedAccount<'info>,
    /// CHECK: executable and allowlisted by target_record.
    #[account(executable)]
    pub target_program: UncheckedAccount<'info>,
}

#[event]
pub struct ConfigInitialized {
    pub authority: Pubkey,
    pub source_chain: u64,
    pub source_broadcaster: [u8; 32],
    pub threshold: u8,
}

#[event]
pub struct PauseUpdated {
    pub paused: bool,
}

#[event]
pub struct ThresholdUpdated {
    pub threshold: u8,
}

#[event]
pub struct BridgeSignerUpdated {
    pub bridge_index: u8,
    pub bridge_signer: Pubkey,
    pub bridge_set_version: u64,
}

#[event]
pub struct SourceUpdated {
    pub source_chain: u64,
    pub source_broadcaster: [u8; 32],
    pub bridge_set_version: u64,
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
pub struct TargetPermissionUpdated {
    pub target: Pubkey,
    pub allowed: bool,
}

#[event]
pub struct BridgeConfirmed {
    pub message_hash: [u8; 32],
    pub bridge_index: u8,
    pub confirmation_count: u8,
    pub ready: bool,
}

#[event]
pub struct MessageCancelled {
    pub message_hash: [u8; 32],
}

#[event]
pub struct MessageExecuted {
    pub message_hash: [u8; 32],
    pub nonce: u64,
    pub target_program: Pubkey,
}
