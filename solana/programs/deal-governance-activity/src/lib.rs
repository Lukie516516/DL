#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;
use deal_identity::IdentityRecord;

declare_id!("6Q8EE4YfEMt3fMmavAJdadYt8zbKJqNDuCSx8XFG5gLJ");

pub const CONFIG_SEED: &[u8] = b"governance-activity-config";
pub const RECORDER_SEED: &[u8] = b"governance-activity-recorder";
pub const ACTIVITY_SEED: &[u8] = b"governance-activity";
pub const CHECKPOINT_SEED: &[u8] = b"governance-activity-checkpoint";
pub const DAY_SECONDS: i64 = 86_400;
pub const MIN_ACTIVE_WINDOW_SECONDS: u64 = 30 * DAY_SECONDS as u64;
pub const MAX_ACTIVE_WINDOW_SECONDS: u64 = 90 * DAY_SECONDS as u64;
pub const DEFAULT_ACTIVE_WINDOW_SECONDS: u64 = MAX_ACTIVE_WINDOW_SECONDS;
pub const BUCKET_COUNT: usize = 91;

#[program]
pub mod deal_governance_activity {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, active_window_seconds: u64) -> Result<()> {
        validate_window(active_window_seconds)?;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= 0, ActivityError::InvalidClock);
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.identity_program = deal_identity::id();
        config.active_window_seconds = active_window_seconds;
        config.active_total = 0;
        config.last_synced_day = now / DAY_SECONDS;
        config.buckets = [ActivityBucket::default(); BUCKET_COUNT];
        config.bump = ctx.bumps.config;
        emit!(ActivityConfigInitialized {
            authority: config.authority,
            active_window_seconds,
        });
        Ok(())
    }

    pub fn set_recorder(ctx: Context<SetRecorder>, allowed: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        let grant = &mut ctx.accounts.recorder_grant;
        grant.recorder = ctx.accounts.recorder.key();
        grant.allowed = allowed;
        grant.bump = ctx.bumps.recorder_grant;
        emit!(ActivityRecorderUpdated {
            recorder: grant.recorder,
            allowed,
        });
        Ok(())
    }

    pub fn set_active_window(ctx: Context<AdminConfig>, active_window_seconds: u64) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        validate_window(active_window_seconds)?;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= 0, ActivityError::InvalidClock);
        ctx.accounts.config.active_window_seconds = active_window_seconds;
        sync_buckets(&mut ctx.accounts.config, now)?;
        emit!(ActiveWindowUpdated {
            active_window_seconds,
            active_total: ctx.accounts.config.active_total,
        });
        Ok(())
    }

    pub fn sync_activity(ctx: Context<SyncActivity>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now >= 0, ActivityError::InvalidClock);
        sync_buckets(&mut ctx.accounts.config, now)?;
        emit!(ActivitySupplySynced {
            timestamp: now,
            active_total: ctx.accounts.config.active_total,
        });
        Ok(())
    }

    pub fn mark_active(ctx: Context<MarkActive>, checkpoint_index: u64) -> Result<()> {
        require!(
            ctx.accounts.recorder_grant.allowed,
            ActivityError::RecorderNotAllowed
        );
        require_keys_eq!(
            ctx.accounts.recorder_grant.recorder,
            ctx.accounts.recorder.key(),
            ActivityError::RecorderNotAllowed
        );
        require_keys_eq!(
            ctx.accounts.config.identity_program,
            deal_identity::id(),
            ActivityError::InvalidIdentityProgram
        );
        require_keys_eq!(
            ctx.accounts.identity.mint,
            ctx.accounts.identity_mint.key(),
            ActivityError::InvalidIdentity
        );
        require_keys_eq!(
            ctx.accounts.owner_identity.mint,
            ctx.accounts.identity_mint.key(),
            ActivityError::InvalidIdentity
        );
        require_keys_eq!(
            ctx.accounts.owner_identity.owner,
            ctx.accounts.owner.key(),
            ActivityError::NotIdentityOwner
        );
        require_eq!(
            ctx.accounts.owner_identity.amount,
            1,
            ActivityError::NotIdentityOwner
        );

        let clock = Clock::get()?;
        require!(clock.unix_timestamp >= 0, ActivityError::InvalidClock);
        let now = clock.unix_timestamp;
        let current_day = now / DAY_SECONDS;
        let activity = &mut ctx.accounts.activity;
        let is_new = activity.identity_mint == Pubkey::default();
        if is_new {
            require_eq!(checkpoint_index, 0, ActivityError::WrongCheckpointIndex);
            activity.identity_mint = ctx.accounts.identity_mint.key();
            activity.checkpoint_count = 0;
            activity.last_active_slot = 0;
            activity.last_active_at = 0;
            activity.bump = ctx.bumps.activity;
        } else {
            require_keys_eq!(
                activity.identity_mint,
                ctx.accounts.identity_mint.key(),
                ActivityError::InvalidIdentity
            );
            require_eq!(
                activity.checkpoint_count,
                checkpoint_index,
                ActivityError::WrongCheckpointIndex
            );
        }

        sync_buckets(&mut ctx.accounts.config, now)?;
        let previous_day = if activity.last_active_at > 0 {
            Some(activity.last_active_at / DAY_SECONDS)
        } else {
            None
        };
        if previous_day != Some(current_day) {
            if let Some(day) = previous_day {
                decrement_bucket(&mut ctx.accounts.config, day)?;
            }
            increment_bucket(&mut ctx.accounts.config, current_day)?;
        }

        activity.last_active_at = now;
        activity.last_active_slot = clock.slot;
        activity.checkpoint_count = activity
            .checkpoint_count
            .checked_add(1)
            .ok_or_else(|| error!(ActivityError::ArithmeticOverflow))?;
        let checkpoint = &mut ctx.accounts.checkpoint;
        checkpoint.identity_mint = ctx.accounts.identity_mint.key();
        checkpoint.index = checkpoint_index;
        checkpoint.slot = clock.slot;
        checkpoint.timestamp = now;
        checkpoint.bump = ctx.bumps.checkpoint;
        sync_buckets(&mut ctx.accounts.config, now)?;

        emit!(IdentityActivityRecorded {
            identity_mint: checkpoint.identity_mint,
            owner: ctx.accounts.owner.key(),
            recorder: ctx.accounts.recorder.key(),
            checkpoint_index,
            slot: clock.slot,
            timestamp: now,
            active_total: ctx.accounts.config.active_total,
        });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            ActivityError::ZeroAddress
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(ActivityAuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            ActivityError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = Pubkey::default();
        emit!(ActivityAuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority,
        });
        Ok(())
    }
}

fn validate_window(active_window_seconds: u64) -> Result<()> {
    require!(
        (MIN_ACTIVE_WINDOW_SECONDS..=MAX_ACTIVE_WINDOW_SECONDS).contains(&active_window_seconds),
        ActivityError::InvalidActiveWindow
    );
    Ok(())
}

fn assert_authority(config: &ActivityConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        config.authority,
        authority.key(),
        ActivityError::NotAuthority
    );
    Ok(())
}

fn active_window_days(config: &ActivityConfig) -> i64 {
    config.active_window_seconds.div_ceil(DAY_SECONDS as u64) as i64
}

fn bucket_index(day: i64) -> Result<usize> {
    require!(day >= 0, ActivityError::InvalidClock);
    Ok((day as usize) % BUCKET_COUNT)
}

fn increment_bucket(config: &mut ActivityConfig, day: i64) -> Result<()> {
    let index = bucket_index(day)?;
    let bucket = &mut config.buckets[index];
    if bucket.count > 0 && bucket.day != day {
        bucket.count = 0;
    }
    bucket.day = day;
    bucket.count = bucket
        .count
        .checked_add(1)
        .ok_or_else(|| error!(ActivityError::ArithmeticOverflow))?;
    Ok(())
}

fn decrement_bucket(config: &mut ActivityConfig, day: i64) -> Result<()> {
    let index = bucket_index(day)?;
    let bucket = &mut config.buckets[index];
    if bucket.day == day && bucket.count > 0 {
        bucket.count = bucket
            .count
            .checked_sub(1)
            .ok_or_else(|| error!(ActivityError::ArithmeticOverflow))?;
    }
    Ok(())
}

fn sync_buckets(config: &mut ActivityConfig, now: i64) -> Result<()> {
    let current_day = now / DAY_SECONDS;
    let cutoff = current_day - active_window_days(config) + 1;
    let mut total = 0u64;
    for bucket in &mut config.buckets {
        if bucket.count > 0 && (bucket.day < cutoff || bucket.day > current_day) {
            bucket.count = 0;
        }
        total = total
            .checked_add(bucket.count)
            .ok_or_else(|| error!(ActivityError::ArithmeticOverflow))?;
    }
    config.active_total = total;
    config.last_synced_day = current_day;
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(init, payer = payer, space = ActivityConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, ActivityConfig>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ActivityConfig>>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ActivityConfig>>,
}

#[derive(Accounts)]
pub struct SetRecorder<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    /// CHECK: Recorder identity is stored in its canonical permission PDA.
    pub recorder: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ActivityConfig>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = RecorderGrant::SPACE,
        seeds = [RECORDER_SEED, recorder.key().as_ref()],
        bump
    )]
    pub recorder_grant: Account<'info, RecorderGrant>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SyncActivity<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ActivityConfig>>,
}

#[derive(Accounts)]
#[instruction(checkpoint_index: u64)]
pub struct MarkActive<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub recorder: Signer<'info>,
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ActivityConfig>>,
    #[account(
        seeds = [RECORDER_SEED, recorder.key().as_ref()],
        bump = recorder_grant.bump
    )]
    pub recorder_grant: Account<'info, RecorderGrant>,
    /// CHECK: Mint key is bound to the official IdentityRecord and owner token account below.
    pub identity_mint: UncheckedAccount<'info>,
    #[account(
        seeds = [deal_identity::IDENTITY_SEED, identity_mint.key().as_ref()],
        bump = identity.bump,
        seeds::program = deal_identity::id()
    )]
    pub identity: Box<Account<'info, IdentityRecord>>,
    pub owner_identity: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = IdentityActivity::SPACE,
        seeds = [ACTIVITY_SEED, identity_mint.key().as_ref()],
        bump
    )]
    pub activity: Box<Account<'info, IdentityActivity>>,
    #[account(
        init,
        payer = payer,
        space = ActivityCheckpoint::SPACE,
        seeds = [CHECKPOINT_SEED, identity_mint.key().as_ref(), &checkpoint_index.to_le_bytes()],
        bump
    )]
    pub checkpoint: Box<Account<'info, ActivityCheckpoint>>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct ActivityBucket {
    pub day: i64,
    pub count: u64,
}

#[account]
pub struct ActivityConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub identity_program: Pubkey,
    pub active_window_seconds: u64,
    pub active_total: u64,
    pub last_synced_day: i64,
    pub buckets: [ActivityBucket; BUCKET_COUNT],
    pub bump: u8,
}
impl ActivityConfig {
    pub const SPACE: usize = 8 + (32 * 3) + (8 * 3) + (16 * BUCKET_COUNT) + 1;
}

#[account]
pub struct RecorderGrant {
    pub recorder: Pubkey,
    pub allowed: bool,
    pub bump: u8,
}
impl RecorderGrant {
    pub const SPACE: usize = 8 + 32 + 1 + 1;
}

#[account]
pub struct IdentityActivity {
    pub identity_mint: Pubkey,
    pub checkpoint_count: u64,
    pub last_active_slot: u64,
    pub last_active_at: i64,
    pub bump: u8,
}
impl IdentityActivity {
    pub const SPACE: usize = 8 + 32 + (8 * 3) + 1;
}

#[account]
pub struct ActivityCheckpoint {
    pub identity_mint: Pubkey,
    pub index: u64,
    pub slot: u64,
    pub timestamp: i64,
    pub bump: u8,
}
impl ActivityCheckpoint {
    pub const SPACE: usize = 8 + 32 + (8 * 3) + 1;
}

#[event]
pub struct ActivityConfigInitialized {
    pub authority: Pubkey,
    pub active_window_seconds: u64,
}
#[event]
pub struct ActivityRecorderUpdated {
    pub recorder: Pubkey,
    pub allowed: bool,
}
#[event]
pub struct ActiveWindowUpdated {
    pub active_window_seconds: u64,
    pub active_total: u64,
}
#[event]
pub struct ActivitySupplySynced {
    pub timestamp: i64,
    pub active_total: u64,
}
#[event]
pub struct IdentityActivityRecorded {
    pub identity_mint: Pubkey,
    pub owner: Pubkey,
    pub recorder: Pubkey,
    pub checkpoint_index: u64,
    pub slot: u64,
    pub timestamp: i64,
    pub active_total: u64,
}
#[event]
pub struct ActivityAuthorityProposed {
    pub pending_authority: Pubkey,
}
#[event]
pub struct ActivityAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[error_code]
pub enum ActivityError {
    #[msg("caller is not the activity authority")]
    NotAuthority,
    #[msg("pending authority does not match")]
    InvalidPendingAuthority,
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("active window must be between 30 and 90 days")]
    InvalidActiveWindow,
    #[msg("recorder is not authorized")]
    RecorderNotAllowed,
    #[msg("identity program is not the official Deal identity program")]
    InvalidIdentityProgram,
    #[msg("identity account or mint is invalid")]
    InvalidIdentity,
    #[msg("signer does not own the official identity NFT")]
    NotIdentityOwner,
    #[msg("checkpoint index is stale or out of sequence")]
    WrongCheckpointIndex,
    #[msg("clock timestamp is invalid")]
    InvalidClock,
    #[msg("arithmetic overflow")]
    ArithmeticOverflow,
}
