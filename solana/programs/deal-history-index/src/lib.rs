#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use deal_core::state::{DealAccount, DealStatus};

declare_id!("GVdfEGRAMJxihudnpskiNGykX4wEeoDdi7MEoHriZBBv");

pub const CONFIG_SEED: &[u8] = b"history-config";
pub const USER_ACTIVITY_SEED: &[u8] = b"user-activity";
pub const ACTIVE_PAGE_SEED: &[u8] = b"active-page";
pub const ACTIVE_MARKER_SEED: &[u8] = b"active-marker";
pub const REWARD_SEED: &[u8] = b"reward";
pub const CREDIT_SEED: &[u8] = b"credit";
pub const TIMELINE_HEADER_SEED: &[u8] = b"timeline-header";
pub const TIMELINE_PAGE_SEED: &[u8] = b"timeline-page";

pub const ACTIVE_PAGE_SIZE: usize = 32;
pub const TIMELINE_PAGE_SIZE: usize = 32;
pub const COMPLETED_MAX: usize = 10;

#[program]
pub mod deal_history_index {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, trusted_writer: Pubkey) -> Result<()> {
        require!(
            trusted_writer != Pubkey::default(),
            HistoryError::ZeroAddress
        );
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.trusted_writer = trusted_writer;
        config.core_program = deal_core::id();
        config.paused = true;
        config.bump = ctx.bumps.config;
        emit!(HistoryConfigInitialized {
            authority: config.authority,
            trusted_writer,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.paused = paused;
        emit!(HistoryPauseUpdated { paused });
        Ok(())
    }

    pub fn set_trusted_writer(ctx: Context<AdminConfig>, trusted_writer: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            trusted_writer != Pubkey::default(),
            HistoryError::ZeroAddress
        );
        ctx.accounts.config.trusted_writer = trusted_writer;
        emit!(HistoryWriterUpdated { trusted_writer });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            HistoryError::ZeroAddress
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(HistoryAuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            HistoryError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = Pubkey::default();
        emit!(HistoryAuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority,
        });
        Ok(())
    }

    pub fn add_tracked(ctx: Context<AddTracked>, page_no: u32) -> Result<()> {
        require!(!ctx.accounts.config.paused, HistoryError::Paused);
        assert_deal_party(&ctx.accounts.deal, ctx.accounts.user.key())?;
        require!(
            matches!(
                ctx.accounts.deal.status,
                DealStatus::Ready | DealStatus::Active | DealStatus::Locked
            ),
            HistoryError::InvalidDealStatus
        );
        let header = &mut ctx.accounts.header;
        initialize_header(header, ctx.accounts.user.key(), ctx.bumps.header);
        let expected_page = header.next_sequence / ACTIVE_PAGE_SIZE as u64;
        require_eq!(u64::from(page_no), expected_page, HistoryError::InvalidPage);

        let page = &mut ctx.accounts.page;
        if page.user == Pubkey::default() {
            page.user = ctx.accounts.user.key();
            page.page_no = page_no;
            page.entries = Vec::new();
            page.bump = ctx.bumps.page;
        }
        require_keys_eq!(
            page.user,
            ctx.accounts.user.key(),
            HistoryError::InvalidPage
        );
        require_eq!(page.page_no, page_no, HistoryError::InvalidPage);
        require!(
            page.entries.len() < ACTIVE_PAGE_SIZE,
            HistoryError::PageFull
        );

        let slot = page.entries.len() as u8;
        page.entries.push(ActiveDealEntry {
            deal: ctx.accounts.deal.key(),
            sequence: header.next_sequence,
            active: true,
        });
        let marker = &mut ctx.accounts.marker;
        marker.user = ctx.accounts.user.key();
        marker.deal = ctx.accounts.deal.key();
        marker.page_no = page_no;
        marker.slot = slot;
        marker.bump = ctx.bumps.marker;
        header.tracked_count = header
            .tracked_count
            .checked_add(1)
            .ok_or_else(|| error!(HistoryError::CounterOverflow))?;
        header.next_sequence = header
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| error!(HistoryError::CounterOverflow))?;
        emit!(TrackedAdded {
            user: ctx.accounts.user.key(),
            deal: ctx.accounts.deal.key(),
            page_no,
            slot,
        });
        Ok(())
    }

    pub fn remove_tracked(ctx: Context<RemoveTracked>) -> Result<()> {
        require!(!ctx.accounts.config.paused, HistoryError::Paused);
        let user = ctx.accounts.user.key();
        let removable = if matches!(
            ctx.accounts.deal.status,
            DealStatus::Completed | DealStatus::Canceled | DealStatus::Abandoned
        ) {
            user == ctx.accounts.deal.creator || user == ctx.accounts.deal.participant
        } else {
            user != Pubkey::default() && user == ctx.accounts.deal.last_removed_participant
        };
        require!(removable, HistoryError::InvalidRemoval);
        require_keys_eq!(
            ctx.accounts.marker.user,
            ctx.accounts.user.key(),
            HistoryError::InvalidMarker
        );
        require_keys_eq!(
            ctx.accounts.marker.deal,
            ctx.accounts.deal.key(),
            HistoryError::InvalidMarker
        );
        require_eq!(
            ctx.accounts.page.page_no,
            ctx.accounts.marker.page_no,
            HistoryError::InvalidPage
        );
        let slot = usize::from(ctx.accounts.marker.slot);
        require!(
            slot < ctx.accounts.page.entries.len(),
            HistoryError::InvalidMarker
        );
        let entry = &mut ctx.accounts.page.entries[slot];
        require!(entry.active, HistoryError::NotTracked);
        require_keys_eq!(
            entry.deal,
            ctx.accounts.deal.key(),
            HistoryError::InvalidMarker
        );
        entry.active = false;
        ctx.accounts.header.tracked_count = ctx
            .accounts
            .header
            .tracked_count
            .checked_sub(1)
            .ok_or_else(|| error!(HistoryError::CounterUnderflow))?;
        emit!(TrackedRemoved {
            user: ctx.accounts.user.key(),
            deal: ctx.accounts.deal.key(),
        });
        Ok(())
    }

    pub fn add_completed(ctx: Context<AddCompleted>) -> Result<()> {
        assert_writer(&ctx.accounts.config, &ctx.accounts.writer)?;
        require!(!ctx.accounts.config.paused, HistoryError::Paused);
        require!(
            ctx.accounts.deal.status == DealStatus::Completed,
            HistoryError::InvalidDealStatus
        );
        assert_deal_party(&ctx.accounts.deal, ctx.accounts.user.key())?;
        let header = &mut ctx.accounts.header;
        initialize_header(header, ctx.accounts.user.key(), ctx.bumps.header);
        push_completed(header, ctx.accounts.deal.key());
        emit!(CompletedAdded {
            user: ctx.accounts.user.key(),
            deal: ctx.accounts.deal.key(),
            completed_count: header.completed_size,
        });
        Ok(())
    }

    pub fn record_reward(ctx: Context<RecordReward>, data: RewardData) -> Result<()> {
        assert_writer(&ctx.accounts.config, &ctx.accounts.writer)?;
        require!(!ctx.accounts.config.paused, HistoryError::Paused);
        require_keys_eq!(
            ctx.accounts.deal.key(),
            data.deal,
            HistoryError::InvalidDeal
        );
        require!(
            ctx.accounts.deal.status == DealStatus::Completed,
            HistoryError::InvalidDealStatus
        );
        require_keys_eq!(
            ctx.accounts.deal.creator,
            data.party_a,
            HistoryError::InvalidParty
        );
        require_keys_eq!(
            ctx.accounts.deal.participant,
            data.party_b,
            HistoryError::InvalidParty
        );
        let record = &mut ctx.accounts.reward;
        record.deal = data.deal;
        record.party_a = data.party_a;
        record.to_a = data.to_a;
        record.party_b = data.party_b;
        record.to_b = data.to_b;
        record.c_addr = data.c_addr;
        record.to_c = data.to_c;
        record.timestamp = Clock::get()?.unix_timestamp;
        record.bump = ctx.bumps.reward;
        emit!(DealRewardRecorded {
            deal: record.deal,
            party_a: record.party_a,
            party_b: record.party_b,
            to_a: record.to_a,
            to_b: record.to_b,
            c_addr: record.c_addr,
            to_c: record.to_c,
            timestamp: record.timestamp,
        });
        Ok(())
    }

    pub fn record_credit(ctx: Context<RecordCredit>, data: CreditData) -> Result<()> {
        assert_writer(&ctx.accounts.config, &ctx.accounts.writer)?;
        require!(!ctx.accounts.config.paused, HistoryError::Paused);
        require_keys_eq!(
            ctx.accounts.deal.key(),
            data.deal,
            HistoryError::InvalidDeal
        );
        require!(
            ctx.accounts.deal.status == DealStatus::Completed,
            HistoryError::InvalidDealStatus
        );
        require!(
            data.a_delta > 0 || data.b_delta > 0,
            HistoryError::EmptyCredit
        );
        let record = &mut ctx.accounts.credit;
        record.deal = data.deal;
        record.a_identity = data.a_identity;
        record.b_identity = data.b_identity;
        record.base_credit = data.base_credit;
        record.a_delta = data.a_delta;
        record.b_delta = data.b_delta;
        record.timestamp = Clock::get()?.unix_timestamp;
        record.bump = ctx.bumps.credit;
        emit!(DealCreditRecorded {
            deal: record.deal,
            a_identity: record.a_identity,
            b_identity: record.b_identity,
            base_credit: record.base_credit,
            a_delta: record.a_delta,
            b_delta: record.b_delta,
            timestamp: record.timestamp,
        });
        Ok(())
    }

    pub fn record_timeline(
        ctx: Context<RecordTimeline>,
        index: u64,
        page_no: u32,
        data: TimelineData,
    ) -> Result<()> {
        assert_writer(&ctx.accounts.config, &ctx.accounts.writer)?;
        require!(!ctx.accounts.config.paused, HistoryError::Paused);
        require_keys_eq!(
            ctx.accounts.deal.key(),
            data.deal,
            HistoryError::InvalidDeal
        );
        require!(data.action > 0, HistoryError::InvalidAction);
        let header = &mut ctx.accounts.timeline_header;
        if header.deal == Pubkey::default() {
            header.deal = data.deal;
            header.count = 0;
            header.bump = ctx.bumps.timeline_header;
        }
        require_keys_eq!(header.deal, data.deal, HistoryError::InvalidDeal);
        require_eq!(header.count, index, HistoryError::InvalidTimelineIndex);
        require_eq!(
            u64::from(page_no),
            index / TIMELINE_PAGE_SIZE as u64,
            HistoryError::InvalidPage
        );

        let page = &mut ctx.accounts.timeline_page;
        if page.deal == Pubkey::default() {
            page.deal = data.deal;
            page.page_no = page_no;
            page.entries = Vec::new();
            page.bump = ctx.bumps.timeline_page;
        }
        require_keys_eq!(page.deal, data.deal, HistoryError::InvalidPage);
        require_eq!(page.page_no, page_no, HistoryError::InvalidPage);
        require!(
            page.entries.len() < TIMELINE_PAGE_SIZE,
            HistoryError::PageFull
        );
        let timestamp = Clock::get()?.unix_timestamp;
        page.entries.push(TimelineEntry {
            index,
            action: data.action,
            actor: data.actor,
            is_party_a: data.is_party_a,
            value: data.value,
            timestamp,
        });
        header.count = header
            .count
            .checked_add(1)
            .ok_or_else(|| error!(HistoryError::CounterOverflow))?;
        emit!(DealTimelineRecorded {
            deal: data.deal,
            index,
            action: data.action,
            actor: data.actor,
            is_party_a: data.is_party_a,
            value: data.value,
            timestamp,
        });
        Ok(())
    }
}

fn assert_authority(config: &HistoryConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        config.authority,
        authority.key(),
        HistoryError::Unauthorized
    );
    Ok(())
}

fn assert_writer(config: &HistoryConfig, writer: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        config.trusted_writer,
        writer.key(),
        HistoryError::UnauthorizedWriter
    );
    Ok(())
}

fn assert_deal_party(deal: &DealAccount, user: Pubkey) -> Result<()> {
    require!(
        user == deal.creator || user == deal.participant,
        HistoryError::InvalidParty
    );
    Ok(())
}

fn initialize_header(header: &mut Account<'_, UserActivity>, user: Pubkey, bump: u8) {
    if header.user == Pubkey::default() {
        header.user = user;
        header.tracked_count = 0;
        header.next_sequence = 0;
        header.completed = [Pubkey::default(); COMPLETED_MAX];
        header.completed_start = 0;
        header.completed_size = 0;
        header.bump = bump;
    }
}

fn push_completed(header: &mut UserActivity, deal: Pubkey) {
    if usize::from(header.completed_size) < COMPLETED_MAX {
        let index = (usize::from(header.completed_start) + usize::from(header.completed_size))
            % COMPLETED_MAX;
        header.completed[index] = deal;
        header.completed_size += 1;
    } else {
        let index = usize::from(header.completed_start);
        header.completed[index] = deal;
        header.completed_start = ((index + 1) % COMPLETED_MAX) as u8;
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct RewardData {
    pub deal: Pubkey,
    pub party_a: Pubkey,
    pub to_a: u64,
    pub party_b: Pubkey,
    pub to_b: u64,
    pub c_addr: Pubkey,
    pub to_c: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct CreditData {
    pub deal: Pubkey,
    pub a_identity: Pubkey,
    pub b_identity: Pubkey,
    pub base_credit: u64,
    pub a_delta: u64,
    pub b_delta: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct TimelineData {
    pub deal: Pubkey,
    pub action: u8,
    pub actor: Pubkey,
    pub is_party_a: bool,
    pub value: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(init, payer = payer, space = HistoryConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, HistoryConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, HistoryConfig>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, HistoryConfig>,
}

#[derive(Accounts)]
#[instruction(page_no: u32)]
pub struct AddTracked<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, HistoryConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The key is the user being indexed and is persisted in the header and marker.
    pub user: UncheckedAccount<'info>,
    pub deal: Account<'info, DealAccount>,
    #[account(
        init_if_needed,
        payer = payer,
        space = UserActivity::SPACE,
        seeds = [USER_ACTIVITY_SEED, user.key().as_ref()],
        bump
    )]
    pub header: Account<'info, UserActivity>,
    #[account(
        init_if_needed,
        payer = payer,
        space = ActiveDealPage::SPACE,
        seeds = [ACTIVE_PAGE_SEED, user.key().as_ref(), &page_no.to_le_bytes()],
        bump
    )]
    pub page: Account<'info, ActiveDealPage>,
    #[account(
        init,
        payer = payer,
        space = ActiveDealMarker::SPACE,
        seeds = [ACTIVE_MARKER_SEED, user.key().as_ref(), deal.key().as_ref()],
        bump
    )]
    pub marker: Account<'info, ActiveDealMarker>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveTracked<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, HistoryConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The key is constrained through all index PDAs.
    pub user: UncheckedAccount<'info>,
    pub deal: Account<'info, DealAccount>,
    #[account(mut, seeds = [USER_ACTIVITY_SEED, user.key().as_ref()], bump = header.bump)]
    pub header: Account<'info, UserActivity>,
    #[account(
        mut,
        seeds = [ACTIVE_PAGE_SEED, user.key().as_ref(), &marker.page_no.to_le_bytes()],
        bump = page.bump
    )]
    pub page: Account<'info, ActiveDealPage>,
    #[account(
        mut,
        close = payer,
        seeds = [ACTIVE_MARKER_SEED, user.key().as_ref(), deal.key().as_ref()],
        bump = marker.bump
    )]
    pub marker: Account<'info, ActiveDealMarker>,
}

#[derive(Accounts)]
pub struct AddCompleted<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, HistoryConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub writer: Signer<'info>,
    /// CHECK: The key is persisted in the user activity account.
    pub user: UncheckedAccount<'info>,
    pub deal: Account<'info, DealAccount>,
    #[account(
        init_if_needed,
        payer = payer,
        space = UserActivity::SPACE,
        seeds = [USER_ACTIVITY_SEED, user.key().as_ref()],
        bump
    )]
    pub header: Account<'info, UserActivity>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(data: RewardData)]
pub struct RecordReward<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, HistoryConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub writer: Signer<'info>,
    pub deal: Account<'info, DealAccount>,
    #[account(
        init,
        payer = payer,
        space = RewardRecord::SPACE,
        seeds = [REWARD_SEED, data.deal.as_ref()],
        bump
    )]
    pub reward: Account<'info, RewardRecord>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(data: CreditData)]
pub struct RecordCredit<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, HistoryConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub writer: Signer<'info>,
    pub deal: Account<'info, DealAccount>,
    #[account(
        init,
        payer = payer,
        space = CreditRecord::SPACE,
        seeds = [CREDIT_SEED, data.deal.as_ref()],
        bump
    )]
    pub credit: Account<'info, CreditRecord>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u64, page_no: u32, data: TimelineData)]
pub struct RecordTimeline<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, HistoryConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub writer: Signer<'info>,
    pub deal: Account<'info, DealAccount>,
    #[account(
        init_if_needed,
        payer = payer,
        space = TimelineHeader::SPACE,
        seeds = [TIMELINE_HEADER_SEED, data.deal.as_ref()],
        bump
    )]
    pub timeline_header: Account<'info, TimelineHeader>,
    #[account(
        init_if_needed,
        payer = payer,
        space = TimelinePage::SPACE,
        seeds = [TIMELINE_PAGE_SEED, data.deal.as_ref(), &page_no.to_le_bytes()],
        bump
    )]
    pub timeline_page: Account<'info, TimelinePage>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct HistoryConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub trusted_writer: Pubkey,
    pub core_program: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

impl HistoryConfig {
    pub const SPACE: usize = 8 + (32 * 4) + 1 + 1;
}

#[account]
pub struct UserActivity {
    pub user: Pubkey,
    pub tracked_count: u64,
    pub next_sequence: u64,
    pub completed: [Pubkey; COMPLETED_MAX],
    pub completed_start: u8,
    pub completed_size: u8,
    pub bump: u8,
}

impl UserActivity {
    pub const SPACE: usize = 8 + 32 + 8 + 8 + (32 * COMPLETED_MAX) + 1 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ActiveDealEntry {
    pub deal: Pubkey,
    pub sequence: u64,
    pub active: bool,
}

impl ActiveDealEntry {
    pub const SPACE: usize = 32 + 8 + 1;
}

#[account]
pub struct ActiveDealPage {
    pub user: Pubkey,
    pub page_no: u32,
    pub entries: Vec<ActiveDealEntry>,
    pub bump: u8,
}

impl ActiveDealPage {
    pub const SPACE: usize = 8 + 32 + 4 + 4 + (ActiveDealEntry::SPACE * ACTIVE_PAGE_SIZE) + 1;
}

#[account]
pub struct ActiveDealMarker {
    pub user: Pubkey,
    pub deal: Pubkey,
    pub page_no: u32,
    pub slot: u8,
    pub bump: u8,
}

impl ActiveDealMarker {
    pub const SPACE: usize = 8 + 32 + 32 + 4 + 1 + 1;
}

#[account]
pub struct RewardRecord {
    pub deal: Pubkey,
    pub party_a: Pubkey,
    pub to_a: u64,
    pub party_b: Pubkey,
    pub to_b: u64,
    pub c_addr: Pubkey,
    pub to_c: u64,
    pub timestamp: i64,
    pub bump: u8,
}

impl RewardRecord {
    pub const SPACE: usize = 8 + (32 * 4) + (8 * 4) + 1;
}

#[account]
pub struct CreditRecord {
    pub deal: Pubkey,
    pub a_identity: Pubkey,
    pub b_identity: Pubkey,
    pub base_credit: u64,
    pub a_delta: u64,
    pub b_delta: u64,
    pub timestamp: i64,
    pub bump: u8,
}

impl CreditRecord {
    pub const SPACE: usize = 8 + (32 * 3) + (8 * 4) + 1;
}

#[account]
pub struct TimelineHeader {
    pub deal: Pubkey,
    pub count: u64,
    pub bump: u8,
}

impl TimelineHeader {
    pub const SPACE: usize = 8 + 32 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TimelineEntry {
    pub index: u64,
    pub action: u8,
    pub actor: Pubkey,
    pub is_party_a: bool,
    pub value: u64,
    pub timestamp: i64,
}

impl TimelineEntry {
    pub const SPACE: usize = 8 + 1 + 32 + 1 + 8 + 8;
}

#[account]
pub struct TimelinePage {
    pub deal: Pubkey,
    pub page_no: u32,
    pub entries: Vec<TimelineEntry>,
    pub bump: u8,
}

impl TimelinePage {
    pub const SPACE: usize = 8 + 32 + 4 + 4 + (TimelineEntry::SPACE * TIMELINE_PAGE_SIZE) + 1;
}

#[event]
pub struct HistoryConfigInitialized {
    pub authority: Pubkey,
    pub trusted_writer: Pubkey,
}

#[event]
pub struct HistoryPauseUpdated {
    pub paused: bool,
}

#[event]
pub struct HistoryWriterUpdated {
    pub trusted_writer: Pubkey,
}

#[event]
pub struct HistoryAuthorityProposed {
    pub pending_authority: Pubkey,
}

#[event]
pub struct HistoryAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct TrackedAdded {
    pub user: Pubkey,
    pub deal: Pubkey,
    pub page_no: u32,
    pub slot: u8,
}

#[event]
pub struct TrackedRemoved {
    pub user: Pubkey,
    pub deal: Pubkey,
}

#[event]
pub struct CompletedAdded {
    pub user: Pubkey,
    pub deal: Pubkey,
    pub completed_count: u8,
}

#[event]
pub struct DealRewardRecorded {
    pub deal: Pubkey,
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub to_a: u64,
    pub to_b: u64,
    pub c_addr: Pubkey,
    pub to_c: u64,
    pub timestamp: i64,
}

#[event]
pub struct DealCreditRecorded {
    pub deal: Pubkey,
    pub a_identity: Pubkey,
    pub b_identity: Pubkey,
    pub base_credit: u64,
    pub a_delta: u64,
    pub b_delta: u64,
    pub timestamp: i64,
}

#[event]
pub struct DealTimelineRecorded {
    pub deal: Pubkey,
    pub index: u64,
    pub action: u8,
    pub actor: Pubkey,
    pub is_party_a: bool,
    pub value: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum HistoryError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("pending authority is invalid")]
    InvalidPendingAuthority,
    #[msg("history index is paused")]
    Paused,
    #[msg("trusted writer is not authorized")]
    UnauthorizedWriter,
    #[msg("page account or page number is invalid")]
    InvalidPage,
    #[msg("page is full")]
    PageFull,
    #[msg("active deal marker is invalid")]
    InvalidMarker,
    #[msg("deal is not tracked")]
    NotTracked,
    #[msg("counter overflow")]
    CounterOverflow,
    #[msg("counter underflow")]
    CounterUnderflow,
    #[msg("deal account is invalid")]
    InvalidDeal,
    #[msg("deal status is invalid for this index operation")]
    InvalidDealStatus,
    #[msg("indexed user or reward party is not a deal participant")]
    InvalidParty,
    #[msg("tracked deal cannot be removed for this user in the current state")]
    InvalidRemoval,
    #[msg("credit record has no delta")]
    EmptyCredit,
    #[msg("timeline action cannot be zero")]
    InvalidAction,
    #[msg("timeline index does not match the header count")]
    InvalidTimelineIndex,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completed_ring_keeps_the_latest_ten() {
        let mut header = UserActivity {
            user: Pubkey::new_unique(),
            tracked_count: 0,
            next_sequence: 0,
            completed: [Pubkey::default(); COMPLETED_MAX],
            completed_start: 0,
            completed_size: 0,
            bump: 1,
        };
        let deals: Vec<Pubkey> = (0..12).map(|_| Pubkey::new_unique()).collect();
        for deal in &deals {
            push_completed(&mut header, *deal);
        }
        assert_eq!(header.completed_size, 10);
        assert_eq!(header.completed_start, 2);
        for (logical, expected) in deals[2..].iter().enumerate() {
            let index = (usize::from(header.completed_start) + logical) % COMPLETED_MAX;
            assert_eq!(header.completed[index], *expected);
        }
    }
}
