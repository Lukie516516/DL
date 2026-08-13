#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
};
use deal_core::state::{DealAccount, DealStatus};
use deal_domain_registry::DomainRecord;

declare_id!("254WzKpJ7RXvpS1UHeZJqhRUMcsHN5U868eqjviMgihg");

pub const CONFIG_SEED: &[u8] = b"domain-rank-config";
pub const REPORTER_SEED: &[u8] = b"domain-rank-reporter";
pub const STATS_SEED: &[u8] = b"domain-rank-stats";
pub const ENTRY_SEED: &[u8] = b"domain-rank-entry";
pub const BLACKLIST_SEED: &[u8] = b"domain-rank-blacklist";
pub const MAX_LEADERBOARD: usize = 50;
pub const MAX_PROTOCOL_FEE_BPS: u16 = 5_000;

#[program]
pub mod deal_domain_rank {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        domain_registry_program: Pubkey,
        domain_registry_config: Pubkey,
        treasury: Pubkey,
        min_deposit: u64,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        for key in [domain_registry_program, domain_registry_config, treasury] {
            require!(key != Pubkey::default(), RankError::ZeroAddress);
        }
        require_keys_eq!(
            domain_registry_program,
            deal_domain_registry::id(),
            RankError::InvalidRegistry
        );
        require!(min_deposit > 0, RankError::InvalidAmount);
        require!(
            protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS,
            RankError::FeeTooHigh
        );
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.domain_registry_program = domain_registry_program;
        config.domain_registry_config = domain_registry_config;
        config.dc_mint = ctx.accounts.dc_mint.key();
        config.treasury = treasury;
        config.auto_closer = Pubkey::default();
        config.min_deposit = min_deposit;
        config.kick_inactivity_seconds = 0;
        config.protocol_fee_bps = protocol_fee_bps;
        config.paused = true;
        config.bump = ctx.bumps.config;
        config.top_domains = Vec::new();
        config.top_volumes = Vec::new();
        emit!(RankInitialized {
            authority: config.authority,
            dc_mint: config.dc_mint,
            treasury,
            min_deposit,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.paused = paused;
        emit!(RankPauseUpdated { paused });
        Ok(())
    }

    pub fn set_min_deposit(ctx: Context<AdminConfig>, min_deposit: u64) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(min_deposit > 0, RankError::InvalidAmount);
        ctx.accounts.config.min_deposit = min_deposit;
        emit!(MinimumDepositUpdated { min_deposit });
        Ok(())
    }

    pub fn set_protocol_fee_bps(ctx: Context<AdminConfig>, protocol_fee_bps: u16) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS,
            RankError::FeeTooHigh
        );
        ctx.accounts.config.protocol_fee_bps = protocol_fee_bps;
        emit!(ProtocolFeeUpdated { protocol_fee_bps });
        Ok(())
    }

    pub fn set_kick_inactivity_seconds(
        ctx: Context<AdminConfig>,
        kick_inactivity_seconds: u64,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.kick_inactivity_seconds = kick_inactivity_seconds;
        emit!(KickWindowUpdated {
            kick_inactivity_seconds
        });
        Ok(())
    }

    pub fn set_auto_closer(ctx: Context<AdminConfig>, auto_closer: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.auto_closer = auto_closer;
        emit!(AutoCloserUpdated { auto_closer });
        Ok(())
    }

    pub fn set_treasury(ctx: Context<AdminConfig>, treasury: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(treasury != Pubkey::default(), RankError::ZeroAddress);
        ctx.accounts.config.treasury = treasury;
        emit!(TreasuryUpdated { treasury });
        Ok(())
    }

    pub fn set_reporter(ctx: Context<SetReporter>, allowed: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        let grant = &mut ctx.accounts.reporter_grant;
        grant.reporter = ctx.accounts.reporter.key();
        grant.allowed = allowed;
        grant.bump = ctx.bumps.reporter_grant;
        emit!(ReporterUpdated {
            reporter: grant.reporter,
            allowed
        });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            RankError::ZeroAddress
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(RankAuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            RankError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = Pubkey::default();
        emit!(RankAuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority
        });
        Ok(())
    }

    pub fn set_domain_policy(
        ctx: Context<SetDomainPolicy>,
        fixed_hourly_rate: u64,
        domain_min_deposit: u64,
    ) -> Result<()> {
        validate_domain(&ctx.accounts.config, &ctx.accounts.domain)?;
        require_keys_eq!(
            ctx.accounts.domain.owner,
            ctx.accounts.owner.key(),
            RankError::NotDomainOwner
        );
        let stats = &mut ctx.accounts.stats;
        initialize_stats(stats, ctx.accounts.domain.key(), ctx.bumps.stats);
        stats.fixed_hourly_rate = fixed_hourly_rate;
        stats.domain_min_deposit = domain_min_deposit;
        emit!(DomainPolicyUpdated {
            domain: stats.domain,
            fixed_hourly_rate,
            domain_min_deposit,
        });
        Ok(())
    }

    pub fn set_blacklisted(ctx: Context<SetBlacklisted>, banned: bool) -> Result<()> {
        validate_domain(&ctx.accounts.config, &ctx.accounts.domain)?;
        require_keys_eq!(
            ctx.accounts.domain.owner,
            ctx.accounts.owner.key(),
            RankError::NotDomainOwner
        );
        require!(
            ctx.accounts.user.key() != Pubkey::default(),
            RankError::ZeroAddress
        );
        require!(
            ctx.accounts.user.key() != ctx.accounts.owner.key(),
            RankError::CannotBlacklistSelf
        );
        let entry = &mut ctx.accounts.blacklist;
        entry.domain = ctx.accounts.domain.key();
        entry.user = ctx.accounts.user.key();
        entry.banned = banned;
        entry.bump = ctx.bumps.blacklist;
        emit!(BlacklistUpdated {
            domain: entry.domain,
            user: entry.user,
            banned
        });
        Ok(())
    }

    pub fn report_deal(
        ctx: Context<ReportDeal>,
        merchant: Pubkey,
        reported_volume: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, RankError::Paused);
        require!(
            ctx.accounts.reporter_grant.allowed,
            RankError::ReporterNotAllowed
        );
        require_keys_eq!(
            ctx.accounts.reporter_grant.reporter,
            ctx.accounts.reporter.key(),
            RankError::ReporterNotAllowed
        );
        require!(merchant != Pubkey::default(), RankError::ZeroAddress);
        validate_domain(&ctx.accounts.config, &ctx.accounts.domain)?;
        validate_domain_deal(&ctx.accounts.domain, &ctx.accounts.deal)?;
        require_keys_eq!(
            ctx.accounts.deal.creator,
            merchant,
            RankError::InvalidMerchant
        );

        let stats = &mut ctx.accounts.stats;
        initialize_stats(stats, ctx.accounts.domain.key(), ctx.bumps.stats);
        let entry = &mut ctx.accounts.entry;
        if !entry.initialized {
            entry.domain = ctx.accounts.domain.key();
            entry.deal = ctx.accounts.deal.key();
            entry.merchant = merchant;
            entry.reported_volume = reported_volume;
            entry.bump = ctx.bumps.entry;
            entry.initialized = true;
            stats.deal_count = stats
                .deal_count
                .checked_add(1)
                .ok_or(RankError::ArithmeticOverflow)?;
        } else {
            require_keys_eq!(entry.merchant, merchant, RankError::InvalidMerchant);
            require_eq!(
                entry.reported_volume,
                reported_volume,
                RankError::ReportedVolumeMismatch
            );
        }
        emit!(DomainDealReported {
            domain: entry.domain,
            deal: entry.deal,
            merchant,
            reported_volume,
            deal_count: stats.deal_count,
        });
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, RankError::Paused);
        require!(!ctx.accounts.entry.closed, RankError::EntryClosed);
        require_keys_eq!(
            ctx.accounts.entry.merchant,
            ctx.accounts.merchant.key(),
            RankError::InvalidMerchant
        );
        validate_domain(&ctx.accounts.config, &ctx.accounts.domain)?;
        validate_domain_deal(&ctx.accounts.domain, &ctx.accounts.deal)?;
        require!(
            !is_terminal(ctx.accounts.deal.status),
            RankError::DealClosed
        );
        initialize_blacklist(
            &mut ctx.accounts.blacklist,
            ctx.accounts.domain.key(),
            ctx.accounts.merchant.key(),
            ctx.bumps.blacklist,
        );
        require!(!ctx.accounts.blacklist.banned, RankError::Blacklisted);
        require_keys_eq!(
            ctx.accounts.stats.domain,
            ctx.accounts.domain.key(),
            RankError::InvalidDomain
        );
        let effective_min = ctx
            .accounts
            .config
            .min_deposit
            .max(ctx.accounts.stats.domain_min_deposit);
        require!(amount >= effective_min, RankError::BelowMinimumDeposit);
        validate_dc_accounts(
            &ctx.accounts.config,
            &ctx.accounts.dc_mint,
            &ctx.accounts.merchant_dc,
            ctx.accounts.merchant.key(),
            &ctx.accounts.vault,
        )?;

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.dc_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.merchant_dc.to_account_info(),
                    mint: ctx.accounts.dc_mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.merchant.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.dc_mint.decimals,
        )?;

        let now = Clock::get()?.unix_timestamp;
        require!(now >= 0, RankError::InvalidTimestamp);
        let entry = &mut ctx.accounts.entry;
        let was_inactive = !entry.active;
        entry.deposited_dc = entry
            .deposited_dc
            .checked_add(amount)
            .ok_or(RankError::ArithmeticOverflow)?;
        entry.active = true;
        if entry.joined_at == 0 || was_inactive {
            entry.joined_at = now;
            entry.hourly_rate = ctx.accounts.stats.fixed_hourly_rate;
        }
        entry.last_deposit_at = now;
        entry.last_deposit_amount = amount;
        entry.last_deposit_base = entry.deposited_dc;
        emit!(AdDeposited {
            domain: entry.domain,
            deal: entry.deal,
            merchant: entry.merchant,
            amount
        });
        Ok(())
    }

    pub fn withdraw_deposit(ctx: Context<WithdrawDeposit>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.entry.merchant,
            ctx.accounts.merchant.key(),
            RankError::InvalidMerchant
        );
        require!(
            ctx.accounts.entry.active || ctx.accounts.entry.deposited_dc > 0,
            RankError::NothingToWithdraw
        );
        validate_domain_deal(&ctx.accounts.domain, &ctx.accounts.deal)?;
        validate_dc_destination(
            &ctx.accounts.config,
            &ctx.accounts.dc_mint,
            &ctx.accounts.vault,
            &ctx.accounts.merchant_dc,
            ctx.accounts.merchant.key(),
        )?;
        if ctx.accounts.deal.status == DealStatus::Completed {
            settle_completed(
                &mut ctx.accounts.entry,
                &mut ctx.accounts.stats,
                ctx.accounts.deal.ended_at,
            )?;
        }
        let refund = ctx.accounts.entry.deposited_dc;
        ctx.accounts.entry.deposited_dc = 0;
        ctx.accounts.entry.active = false;
        transfer_from_vault(
            &ctx.accounts.config,
            &ctx.accounts.vault,
            &ctx.accounts.dc_mint,
            &ctx.accounts.merchant_dc,
            &ctx.accounts.dc_token_program,
            refund,
        )?;
        emit!(AdWithdrawn {
            domain: ctx.accounts.entry.domain,
            deal: ctx.accounts.entry.deal,
            merchant: ctx.accounts.entry.merchant,
            refunded: refund,
            total_consumed: ctx.accounts.entry.total_consumed,
        });
        Ok(())
    }

    pub fn close_deal(ctx: Context<CloseDeal>) -> Result<()> {
        require!(
            is_terminal(ctx.accounts.deal.status),
            RankError::DealNotTerminal
        );
        let completed = ctx.accounts.deal.status == DealStatus::Completed;
        close_entry(
            CloseEntryAccounts {
                config: &mut ctx.accounts.config,
                stats: &mut ctx.accounts.stats,
                entry: &mut ctx.accounts.entry,
                deal: &ctx.accounts.deal,
                dc_mint: &ctx.accounts.dc_mint,
                vault: &ctx.accounts.vault,
                merchant_dc: &ctx.accounts.merchant_dc,
                dc_token_program: &ctx.accounts.dc_token_program,
            },
            completed,
        )
    }

    pub fn close_deal_from_auto_closer(ctx: Context<AutoCloseDeal>, completed: bool) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.auto_closer,
            ctx.accounts.auto_closer.key(),
            RankError::InvalidAutoCloser
        );
        close_entry(
            CloseEntryAccounts {
                config: &mut ctx.accounts.config,
                stats: &mut ctx.accounts.stats,
                entry: &mut ctx.accounts.entry,
                deal: &ctx.accounts.deal,
                dc_mint: &ctx.accounts.dc_mint,
                vault: &ctx.accounts.vault,
                merchant_dc: &ctx.accounts.merchant_dc,
                dc_token_program: &ctx.accounts.dc_token_program,
            },
            completed,
        )
    }

    pub fn kick_inactive(ctx: Context<KickInactive>) -> Result<()> {
        require!(
            ctx.accounts.config.kick_inactivity_seconds > 0,
            RankError::KickWindowDisabled
        );
        validate_domain(&ctx.accounts.config, &ctx.accounts.domain)?;
        require_keys_eq!(
            ctx.accounts.domain.owner,
            ctx.accounts.owner.key(),
            RankError::NotDomainOwner
        );
        require!(
            ctx.accounts.entry.active && ctx.accounts.entry.deposited_dc > 0,
            RankError::EntryInactive
        );
        let now = Clock::get()?.unix_timestamp;
        let elapsed = now
            .checked_sub(ctx.accounts.entry.last_deposit_at)
            .ok_or(RankError::InvalidTimestamp)?;
        require!(
            elapsed
                >= i64::try_from(ctx.accounts.config.kick_inactivity_seconds)
                    .map_err(|_| error!(RankError::ArithmeticOverflow))?,
            RankError::KickWindowActive
        );
        if ctx.accounts.deal.status == DealStatus::Completed {
            settle_completed(
                &mut ctx.accounts.entry,
                &mut ctx.accounts.stats,
                ctx.accounts.deal.ended_at,
            )?;
        }
        validate_dc_destination(
            &ctx.accounts.config,
            &ctx.accounts.dc_mint,
            &ctx.accounts.vault,
            &ctx.accounts.merchant_dc,
            ctx.accounts.entry.merchant,
        )?;
        let refund = ctx.accounts.entry.deposited_dc;
        ctx.accounts.entry.deposited_dc = 0;
        ctx.accounts.entry.active = false;
        transfer_from_vault(
            &ctx.accounts.config,
            &ctx.accounts.vault,
            &ctx.accounts.dc_mint,
            &ctx.accounts.merchant_dc,
            &ctx.accounts.dc_token_program,
            refund,
        )?;
        emit!(InactiveAdKicked {
            domain: ctx.accounts.entry.domain,
            deal: ctx.accounts.entry.deal,
            merchant: ctx.accounts.entry.merchant,
            refund,
        });
        Ok(())
    }

    pub fn withdraw_holder_rewards(ctx: Context<WithdrawHolderRewards>) -> Result<()> {
        validate_domain(&ctx.accounts.config, &ctx.accounts.domain)?;
        require_keys_eq!(
            ctx.accounts.domain.owner,
            ctx.accounts.holder.key(),
            RankError::NotDomainOwner
        );
        require!(
            ctx.accounts.stats.holder_rewards_pending > 0,
            RankError::NoHolderRewards
        );
        validate_dc_destination(
            &ctx.accounts.config,
            &ctx.accounts.dc_mint,
            &ctx.accounts.vault,
            &ctx.accounts.holder_dc,
            ctx.accounts.holder.key(),
        )?;
        require_keys_eq!(
            ctx.accounts.treasury_dc.owner,
            ctx.accounts.config.treasury,
            RankError::InvalidTreasury
        );
        require_keys_eq!(
            ctx.accounts.treasury_dc.mint,
            ctx.accounts.config.dc_mint,
            RankError::InvalidDcMint
        );
        let amount = ctx.accounts.stats.holder_rewards_pending;
        ctx.accounts.stats.holder_rewards_pending = 0;
        let protocol_cut = mul_bps(amount, ctx.accounts.config.protocol_fee_bps)?;
        let holder_amount = amount
            .checked_sub(protocol_cut)
            .ok_or(RankError::ArithmeticOverflow)?;
        transfer_from_vault(
            &ctx.accounts.config,
            &ctx.accounts.vault,
            &ctx.accounts.dc_mint,
            &ctx.accounts.treasury_dc,
            &ctx.accounts.dc_token_program,
            protocol_cut,
        )?;
        transfer_from_vault(
            &ctx.accounts.config,
            &ctx.accounts.vault,
            &ctx.accounts.dc_mint,
            &ctx.accounts.holder_dc,
            &ctx.accounts.dc_token_program,
            holder_amount,
        )?;
        emit!(HolderRewardsWithdrawn {
            domain: ctx.accounts.domain.key(),
            holder: ctx.accounts.holder.key(),
            holder_amount,
            protocol_cut,
        });
        Ok(())
    }
}

fn assert_authority(config: &RankConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(config.authority, authority.key(), RankError::Unauthorized);
    Ok(())
}

fn initialize_stats(stats: &mut DomainStats, domain: Pubkey, bump: u8) {
    if stats.domain == Pubkey::default() {
        stats.domain = domain;
        stats.bump = bump;
    }
}

fn initialize_blacklist(entry: &mut BlacklistEntry, domain: Pubkey, user: Pubkey, bump: u8) {
    if entry.domain == Pubkey::default() {
        entry.domain = domain;
        entry.user = user;
        entry.bump = bump;
    }
}

fn validate_domain(config: &RankConfig, domain: &DomainRecord) -> Result<()> {
    require_keys_eq!(
        config.domain_registry_program,
        deal_domain_registry::id(),
        RankError::InvalidRegistry
    );
    require!(domain.owner != Pubkey::default(), RankError::InvalidDomain);
    Ok(())
}

fn validate_domain_deal(domain: &DomainRecord, deal: &DealAccount) -> Result<()> {
    require!(deal.is_domain_deal, RankError::NotDomainDeal);
    require!(
        deal.domain_name == domain.label,
        RankError::DomainDealMismatch
    );
    Ok(())
}

fn is_terminal(status: DealStatus) -> bool {
    matches!(
        status,
        DealStatus::Completed | DealStatus::Canceled | DealStatus::Abandoned
    )
}

fn mul_bps(amount: u64, bps: u16) -> Result<u64> {
    u64::try_from((u128::from(amount) * u128::from(bps)) / 10_000)
        .map_err(|_| error!(RankError::ArithmeticOverflow))
}

fn pending_consume(entry: &DealAdEntry, ended_at: i64) -> Result<u64> {
    if !entry.active
        || entry.deposited_dc == 0
        || entry.joined_at == 0
        || ended_at <= entry.joined_at
        || entry.hourly_rate == 0
    {
        return Ok(0);
    }
    let elapsed = u64::try_from(ended_at - entry.joined_at)
        .map_err(|_| error!(RankError::InvalidTimestamp))?;
    let due = (u128::from(elapsed) * u128::from(entry.hourly_rate)).div_ceil(3_600);
    let due = u64::try_from(due).map_err(|_| error!(RankError::ArithmeticOverflow))?;
    Ok(due.min(entry.deposited_dc))
}

fn settle_completed(
    entry: &mut DealAdEntry,
    stats: &mut DomainStats,
    ended_at: i64,
) -> Result<u64> {
    let consumed = pending_consume(entry, ended_at)?;
    if consumed > 0 {
        entry.deposited_dc = entry
            .deposited_dc
            .checked_sub(consumed)
            .ok_or(RankError::ArithmeticOverflow)?;
        entry.total_consumed = entry
            .total_consumed
            .checked_add(consumed)
            .ok_or(RankError::ArithmeticOverflow)?;
        stats.holder_rewards_pending = stats
            .holder_rewards_pending
            .checked_add(consumed)
            .ok_or(RankError::ArithmeticOverflow)?;
        if entry.deposited_dc == 0 {
            entry.active = false;
        }
    }
    Ok(consumed)
}

struct CloseEntryAccounts<'a, 'info> {
    config: &'a mut Account<'info, RankConfig>,
    stats: &'a mut Account<'info, DomainStats>,
    entry: &'a mut Account<'info, DealAdEntry>,
    deal: &'a Account<'info, DealAccount>,
    dc_mint: &'a InterfaceAccount<'info, Mint>,
    vault: &'a InterfaceAccount<'info, TokenAccount>,
    merchant_dc: &'a InterfaceAccount<'info, TokenAccount>,
    dc_token_program: &'a Interface<'info, TokenInterface>,
}

fn close_entry(accounts: CloseEntryAccounts<'_, '_>, completed: bool) -> Result<()> {
    let CloseEntryAccounts {
        config,
        stats,
        entry,
        deal,
        dc_mint,
        vault,
        merchant_dc,
        dc_token_program,
    } = accounts;
    require!(!entry.closed, RankError::EntryClosed);
    require_keys_eq!(entry.deal, deal.key(), RankError::InvalidDeal);
    validate_dc_destination(config, dc_mint, vault, merchant_dc, entry.merchant)?;
    let consumed = if completed {
        settle_completed(entry, stats, deal.ended_at)?
    } else {
        0
    };
    if completed && !entry.volume_counted {
        stats.trade_volume = stats
            .trade_volume
            .checked_add(entry.reported_volume)
            .ok_or(RankError::ArithmeticOverflow)?;
        entry.volume_counted = true;
        update_top_domains(config, stats.domain, stats.trade_volume)?;
    }
    let refund = entry.deposited_dc;
    entry.deposited_dc = 0;
    entry.active = false;
    entry.closed = true;
    transfer_from_vault(
        config,
        vault,
        dc_mint,
        merchant_dc,
        dc_token_program,
        refund,
    )?;
    emit!(DealAdClosed {
        domain: entry.domain,
        deal: entry.deal,
        merchant: entry.merchant,
        completed,
        consumed,
        refunded: refund,
        trade_volume: stats.trade_volume,
    });
    Ok(())
}

fn update_top_domains(config: &mut RankConfig, domain: Pubkey, volume: u64) -> Result<()> {
    require_eq!(
        config.top_domains.len(),
        config.top_volumes.len(),
        RankError::CorruptLeaderboard
    );
    if let Some(index) = config.top_domains.iter().position(|key| *key == domain) {
        config.top_volumes[index] = volume;
    } else if config.top_domains.len() < MAX_LEADERBOARD {
        config.top_domains.push(domain);
        config.top_volumes.push(volume);
    } else if let Some((min_index, min_volume)) = config
        .top_volumes
        .iter()
        .enumerate()
        .min_by_key(|(_, value)| *value)
    {
        if volume > *min_volume {
            config.top_domains[min_index] = domain;
            config.top_volumes[min_index] = volume;
        } else {
            return Ok(());
        }
    }
    let mut pairs: Vec<(Pubkey, u64)> = config
        .top_domains
        .iter()
        .copied()
        .zip(config.top_volumes.iter().copied())
        .collect();
    pairs.sort_unstable_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| a.0.to_bytes().cmp(&b.0.to_bytes()))
    });
    config.top_domains = pairs.iter().map(|pair| pair.0).collect();
    config.top_volumes = pairs.iter().map(|pair| pair.1).collect();
    Ok(())
}

fn validate_dc_accounts(
    config: &RankConfig,
    mint: &InterfaceAccount<Mint>,
    source: &InterfaceAccount<TokenAccount>,
    source_owner: Pubkey,
    vault: &InterfaceAccount<TokenAccount>,
) -> Result<()> {
    require_keys_eq!(mint.key(), config.dc_mint, RankError::InvalidDcMint);
    require_keys_eq!(source.mint, config.dc_mint, RankError::InvalidDcMint);
    require_keys_eq!(source.owner, source_owner, RankError::InvalidTokenOwner);
    require_keys_eq!(vault.mint, config.dc_mint, RankError::InvalidDcMint);
    require_keys_eq!(
        vault.owner,
        Pubkey::find_program_address(&[CONFIG_SEED], &crate::id()).0,
        RankError::InvalidVault
    );
    Ok(())
}

fn validate_dc_destination(
    config: &RankConfig,
    mint: &InterfaceAccount<Mint>,
    vault: &InterfaceAccount<TokenAccount>,
    destination: &InterfaceAccount<TokenAccount>,
    destination_owner: Pubkey,
) -> Result<()> {
    validate_dc_accounts(config, mint, destination, destination_owner, vault)
}

fn transfer_from_vault<'info>(
    config: &Account<'info, RankConfig>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    destination: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let bump = [config.bump];
    let signer_seeds: &[&[u8]] = &[CONFIG_SEED, &bump];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: destination.to_account_info(),
                authority: config.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
        mint.decimals,
    )
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(init, payer = payer, space = RankConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, RankConfig>>,
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = dc_mint,
        associated_token::authority = config,
        associated_token::token_program = dc_token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub dc_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, RankConfig>>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, RankConfig>>,
}

#[derive(Accounts)]
pub struct SetReporter<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, RankConfig>>,
    /// CHECK: Reporter can be a wallet or a program-controlled PDA.
    pub reporter: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = authority, space = ReporterGrant::SPACE, seeds = [REPORTER_SEED, reporter.key().as_ref()], bump)]
    pub reporter_grant: Box<Account<'info, ReporterGrant>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetDomainPolicy<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, RankConfig>>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub domain: Box<Account<'info, DomainRecord>>,
    #[account(init_if_needed, payer = owner, space = DomainStats::SPACE, seeds = [STATS_SEED, domain.key().as_ref()], bump)]
    pub stats: Box<Account<'info, DomainStats>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetBlacklisted<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, RankConfig>>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub domain: Box<Account<'info, DomainRecord>>,
    /// CHECK: Key is recorded and constrained by the blacklist PDA.
    pub user: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = owner, space = BlacklistEntry::SPACE, seeds = [BLACKLIST_SEED, domain.key().as_ref(), user.key().as_ref()], bump)]
    pub blacklist: Box<Account<'info, BlacklistEntry>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReportDeal<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, RankConfig>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub reporter: Signer<'info>,
    #[account(seeds = [REPORTER_SEED, reporter.key().as_ref()], bump = reporter_grant.bump)]
    pub reporter_grant: Box<Account<'info, ReporterGrant>>,
    pub domain: Box<Account<'info, DomainRecord>>,
    pub deal: Box<Account<'info, DealAccount>>,
    #[account(init_if_needed, payer = payer, space = DomainStats::SPACE, seeds = [STATS_SEED, domain.key().as_ref()], bump)]
    pub stats: Box<Account<'info, DomainStats>>,
    #[account(init_if_needed, payer = payer, space = DealAdEntry::SPACE, seeds = [ENTRY_SEED, domain.key().as_ref(), deal.key().as_ref()], bump)]
    pub entry: Box<Account<'info, DealAdEntry>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, RankConfig>>,
    #[account(mut)]
    pub merchant: Signer<'info>,
    pub domain: Box<Account<'info, DomainRecord>>,
    pub deal: Box<Account<'info, DealAccount>>,
    #[account(mut, seeds = [STATS_SEED, domain.key().as_ref()], bump = stats.bump)]
    pub stats: Box<Account<'info, DomainStats>>,
    #[account(mut, seeds = [ENTRY_SEED, domain.key().as_ref(), deal.key().as_ref()], bump = entry.bump)]
    pub entry: Box<Account<'info, DealAdEntry>>,
    #[account(init_if_needed, payer = merchant, space = BlacklistEntry::SPACE, seeds = [BLACKLIST_SEED, domain.key().as_ref(), merchant.key().as_ref()], bump)]
    pub blacklist: Box<Account<'info, BlacklistEntry>>,
    #[account(mut)]
    pub merchant_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub dc_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawDeposit<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, RankConfig>>,
    pub merchant: Signer<'info>,
    pub domain: Box<Account<'info, DomainRecord>>,
    pub deal: Box<Account<'info, DealAccount>>,
    #[account(mut, seeds = [STATS_SEED, domain.key().as_ref()], bump = stats.bump)]
    pub stats: Box<Account<'info, DomainStats>>,
    #[account(mut, seeds = [ENTRY_SEED, domain.key().as_ref(), deal.key().as_ref()], bump = entry.bump)]
    pub entry: Box<Account<'info, DealAdEntry>>,
    #[account(mut)]
    pub merchant_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub dc_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CloseDeal<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, RankConfig>>,
    pub caller: Signer<'info>,
    pub deal: Box<Account<'info, DealAccount>>,
    #[account(mut, seeds = [STATS_SEED, entry.domain.as_ref()], bump = stats.bump)]
    pub stats: Box<Account<'info, DomainStats>>,
    #[account(mut, seeds = [ENTRY_SEED, entry.domain.as_ref(), deal.key().as_ref()], bump = entry.bump)]
    pub entry: Box<Account<'info, DealAdEntry>>,
    #[account(mut)]
    pub merchant_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub dc_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct AutoCloseDeal<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, RankConfig>>,
    pub auto_closer: Signer<'info>,
    pub deal: Box<Account<'info, DealAccount>>,
    #[account(mut, seeds = [STATS_SEED, entry.domain.as_ref()], bump = stats.bump)]
    pub stats: Box<Account<'info, DomainStats>>,
    #[account(mut, seeds = [ENTRY_SEED, entry.domain.as_ref(), deal.key().as_ref()], bump = entry.bump)]
    pub entry: Box<Account<'info, DealAdEntry>>,
    #[account(mut)]
    pub merchant_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub dc_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct KickInactive<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, RankConfig>>,
    pub owner: Signer<'info>,
    pub domain: Box<Account<'info, DomainRecord>>,
    pub deal: Box<Account<'info, DealAccount>>,
    #[account(mut, seeds = [STATS_SEED, domain.key().as_ref()], bump = stats.bump)]
    pub stats: Box<Account<'info, DomainStats>>,
    #[account(mut, seeds = [ENTRY_SEED, domain.key().as_ref(), deal.key().as_ref()], bump = entry.bump)]
    pub entry: Box<Account<'info, DealAdEntry>>,
    #[account(mut)]
    pub merchant_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub dc_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawHolderRewards<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, RankConfig>>,
    pub holder: Signer<'info>,
    pub domain: Box<Account<'info, DomainRecord>>,
    #[account(mut, seeds = [STATS_SEED, domain.key().as_ref()], bump = stats.bump)]
    pub stats: Box<Account<'info, DomainStats>>,
    #[account(mut)]
    pub holder_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub treasury_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub dc_token_program: Interface<'info, TokenInterface>,
}

#[account]
pub struct RankConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub domain_registry_program: Pubkey,
    pub domain_registry_config: Pubkey,
    pub dc_mint: Pubkey,
    pub treasury: Pubkey,
    pub auto_closer: Pubkey,
    pub min_deposit: u64,
    pub kick_inactivity_seconds: u64,
    pub protocol_fee_bps: u16,
    pub paused: bool,
    pub bump: u8,
    pub top_domains: Vec<Pubkey>,
    pub top_volumes: Vec<u64>,
}

impl RankConfig {
    pub const SPACE: usize =
        8 + (32 * 7) + (8 * 2) + 2 + 1 + 1 + 4 + (32 * MAX_LEADERBOARD) + 4 + (8 * MAX_LEADERBOARD);
}

#[account]
pub struct ReporterGrant {
    pub reporter: Pubkey,
    pub allowed: bool,
    pub bump: u8,
}

impl ReporterGrant {
    pub const SPACE: usize = 8 + 32 + 1 + 1;
}

#[account]
pub struct DomainStats {
    pub domain: Pubkey,
    pub deal_count: u64,
    pub trade_volume: u64,
    pub holder_rewards_pending: u64,
    pub fixed_hourly_rate: u64,
    pub domain_min_deposit: u64,
    pub bump: u8,
}

impl DomainStats {
    pub const SPACE: usize = 8 + 32 + (8 * 5) + 1;
}

#[account]
pub struct DealAdEntry {
    pub domain: Pubkey,
    pub deal: Pubkey,
    pub merchant: Pubkey,
    pub reported_volume: u64,
    pub deposited_dc: u64,
    pub total_consumed: u64,
    pub joined_at: i64,
    pub hourly_rate: u64,
    pub last_deposit_at: i64,
    pub last_deposit_amount: u64,
    pub last_deposit_base: u64,
    pub active: bool,
    pub closed: bool,
    pub volume_counted: bool,
    pub initialized: bool,
    pub bump: u8,
}

impl DealAdEntry {
    pub const SPACE: usize = 8 + (32 * 3) + (8 * 8) + 5;
}

#[account]
pub struct BlacklistEntry {
    pub domain: Pubkey,
    pub user: Pubkey,
    pub banned: bool,
    pub bump: u8,
}

impl BlacklistEntry {
    pub const SPACE: usize = 8 + (32 * 2) + 1 + 1;
}

#[event]
pub struct RankInitialized {
    pub authority: Pubkey,
    pub dc_mint: Pubkey,
    pub treasury: Pubkey,
    pub min_deposit: u64,
}
#[event]
pub struct RankPauseUpdated {
    pub paused: bool,
}
#[event]
pub struct MinimumDepositUpdated {
    pub min_deposit: u64,
}
#[event]
pub struct ProtocolFeeUpdated {
    pub protocol_fee_bps: u16,
}
#[event]
pub struct KickWindowUpdated {
    pub kick_inactivity_seconds: u64,
}
#[event]
pub struct AutoCloserUpdated {
    pub auto_closer: Pubkey,
}
#[event]
pub struct TreasuryUpdated {
    pub treasury: Pubkey,
}
#[event]
pub struct ReporterUpdated {
    pub reporter: Pubkey,
    pub allowed: bool,
}
#[event]
pub struct RankAuthorityProposed {
    pub pending_authority: Pubkey,
}
#[event]
pub struct RankAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}
#[event]
pub struct DomainPolicyUpdated {
    pub domain: Pubkey,
    pub fixed_hourly_rate: u64,
    pub domain_min_deposit: u64,
}
#[event]
pub struct BlacklistUpdated {
    pub domain: Pubkey,
    pub user: Pubkey,
    pub banned: bool,
}
#[event]
pub struct DomainDealReported {
    pub domain: Pubkey,
    pub deal: Pubkey,
    pub merchant: Pubkey,
    pub reported_volume: u64,
    pub deal_count: u64,
}
#[event]
pub struct AdDeposited {
    pub domain: Pubkey,
    pub deal: Pubkey,
    pub merchant: Pubkey,
    pub amount: u64,
}
#[event]
pub struct AdWithdrawn {
    pub domain: Pubkey,
    pub deal: Pubkey,
    pub merchant: Pubkey,
    pub refunded: u64,
    pub total_consumed: u64,
}
#[event]
pub struct DealAdClosed {
    pub domain: Pubkey,
    pub deal: Pubkey,
    pub merchant: Pubkey,
    pub completed: bool,
    pub consumed: u64,
    pub refunded: u64,
    pub trade_volume: u64,
}
#[event]
pub struct InactiveAdKicked {
    pub domain: Pubkey,
    pub deal: Pubkey,
    pub merchant: Pubkey,
    pub refund: u64,
}
#[event]
pub struct HolderRewardsWithdrawn {
    pub domain: Pubkey,
    pub holder: Pubkey,
    pub holder_amount: u64,
    pub protocol_cut: u64,
}

#[error_code]
pub enum RankError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("pending authority is invalid")]
    InvalidPendingAuthority,
    #[msg("domain rank is paused")]
    Paused,
    #[msg("amount is invalid")]
    InvalidAmount,
    #[msg("protocol fee exceeds 50 percent")]
    FeeTooHigh,
    #[msg("domain registry is invalid")]
    InvalidRegistry,
    #[msg("domain is invalid")]
    InvalidDomain,
    #[msg("caller is not the domain owner")]
    NotDomainOwner,
    #[msg("domain owner cannot blacklist itself")]
    CannotBlacklistSelf,
    #[msg("reporter is not allowed")]
    ReporterNotAllowed,
    #[msg("merchant does not match deal creator")]
    InvalidMerchant,
    #[msg("reported volume changed for an existing deal")]
    ReportedVolumeMismatch,
    #[msg("deal is not a domain deal")]
    NotDomainDeal,
    #[msg("deal domain does not match domain record")]
    DomainDealMismatch,
    #[msg("deal is already terminal")]
    DealClosed,
    #[msg("deal is not terminal")]
    DealNotTerminal,
    #[msg("deal account is invalid")]
    InvalidDeal,
    #[msg("advertising entry is closed")]
    EntryClosed,
    #[msg("account is blacklisted")]
    Blacklisted,
    #[msg("deposit is below the effective minimum")]
    BelowMinimumDeposit,
    #[msg("nothing to withdraw")]
    NothingToWithdraw,
    #[msg("timestamp is invalid")]
    InvalidTimestamp,
    #[msg("kick window is disabled")]
    KickWindowDisabled,
    #[msg("entry is not active")]
    EntryInactive,
    #[msg("entry is still within the kick window")]
    KickWindowActive,
    #[msg("auto closer is invalid")]
    InvalidAutoCloser,
    #[msg("DC mint is invalid")]
    InvalidDcMint,
    #[msg("token owner is invalid")]
    InvalidTokenOwner,
    #[msg("vault is invalid")]
    InvalidVault,
    #[msg("treasury token account is invalid")]
    InvalidTreasury,
    #[msg("domain has no holder rewards")]
    NoHolderRewards,
    #[msg("arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("leaderboard state is corrupt")]
    CorruptLeaderboard,
}
