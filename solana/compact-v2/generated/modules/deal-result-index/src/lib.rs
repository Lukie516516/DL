#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use deal_core::state::{DealAccount, DealStatus};

declare_id!("FGfBWHNDZCZJCMWT1yhw87sArj2NCs9yEeX3xMC7MjTn");

pub const CONFIG_SEED: &[u8] = b"result-config";
pub const REWARD_HEADER_SEED: &[u8] = b"reward-header";
pub const REWARD_PAGE_SEED: &[u8] = b"reward-page";
pub const REWARD_MARKER_SEED: &[u8] = b"reward-marker";
pub const CREDIT_HEADER_SEED: &[u8] = b"credit-header";
pub const CREDIT_PAGE_SEED: &[u8] = b"credit-page";
pub const CREDIT_MARKER_SEED: &[u8] = b"credit-marker";
pub const RESULT_PAGE_SIZE: usize = 32;

pub const REWARD_ROLE_A: u8 = 0;
pub const REWARD_ROLE_B: u8 = 1;
pub const REWARD_ROLE_C: u8 = 2;
pub const CREDIT_SIDE_A: u8 = 0;
pub const CREDIT_SIDE_B: u8 = 1;

#[program]
pub mod deal_result_index {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.reward_program = deal_reward_engine::ID;
        config.finalizer_program = deal_finalizer::ID;
        config.paused = true;
        config.bump = ctx.bumps.config;
        emit!(ResultIndexInitialized {
            authority: config.authority,
            reward_program: config.reward_program,
            finalizer_program: config.finalizer_program,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.paused = paused;
        emit!(ResultIndexPauseUpdated { paused });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            ResultIndexError::ZeroAddress
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(ResultIndexAuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            ResultIndexError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = Pubkey::default();
        emit!(ResultIndexAuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority,
        });
        Ok(())
    }

    pub fn index_reward(ctx: Context<IndexReward>, role: u8, page_no: u32) -> Result<()> {
        assert_enabled(&ctx.accounts.config)?;
        require!(
            ctx.accounts.deal.status == DealStatus::Completed,
            ResultIndexError::DealNotCompleted
        );
        require_keys_eq!(
            ctx.accounts.reward_receipt.deal,
            ctx.accounts.deal.key(),
            ResultIndexError::InvalidRewardReceipt
        );
        let (subject, amount) =
            reward_subject(&ctx.accounts.deal, &ctx.accounts.reward_receipt, role)?;
        require_keys_eq!(
            ctx.accounts.subject.key(),
            subject,
            ResultIndexError::InvalidSubject
        );
        require!(amount > 0, ResultIndexError::ZeroResult);

        append_result(
            &mut ctx.accounts.header,
            &mut ctx.accounts.page,
            &mut ctx.accounts.marker,
            subject,
            ctx.accounts.deal.key(),
            ctx.accounts.reward_receipt.minted_at,
            page_no,
            ctx.bumps.header,
            ctx.bumps.page,
            ctx.bumps.marker,
        )?;
        emit!(RewardDealIndexed {
            subject,
            deal: ctx.accounts.deal.key(),
            role,
            amount,
            page_no,
        });
        Ok(())
    }

    pub fn index_credit(ctx: Context<IndexCredit>, side: u8, page_no: u32) -> Result<()> {
        assert_enabled(&ctx.accounts.config)?;
        require!(
            ctx.accounts.deal.status == DealStatus::Completed,
            ResultIndexError::DealNotCompleted
        );
        require_keys_eq!(
            ctx.accounts.credit_receipt.deal,
            ctx.accounts.deal.key(),
            ResultIndexError::InvalidCreditReceipt
        );
        let (subject, amount) = credit_subject(&ctx.accounts.credit_receipt, side)?;
        require_keys_eq!(
            ctx.accounts.subject.key(),
            subject,
            ResultIndexError::InvalidSubject
        );
        require!(amount > 0, ResultIndexError::ZeroResult);

        append_result(
            &mut ctx.accounts.header,
            &mut ctx.accounts.page,
            &mut ctx.accounts.marker,
            subject,
            ctx.accounts.deal.key(),
            ctx.accounts.credit_receipt.recorded_at,
            page_no,
            ctx.bumps.header,
            ctx.bumps.page,
            ctx.bumps.marker,
        )?;
        emit!(CreditDealIndexed {
            identity_mint: subject,
            deal: ctx.accounts.deal.key(),
            side,
            amount,
            page_no,
        });
        Ok(())
    }
}

fn assert_authority(config: &ResultIndexConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        config.authority,
        authority.key(),
        ResultIndexError::Unauthorized
    );
    Ok(())
}

fn assert_enabled(config: &ResultIndexConfig) -> Result<()> {
    require!(!config.paused, ResultIndexError::Paused);
    require_keys_eq!(
        config.reward_program,
        deal_reward_engine::ID,
        ResultIndexError::InvalidSourceProgram
    );
    require_keys_eq!(
        config.finalizer_program,
        deal_finalizer::ID,
        ResultIndexError::InvalidSourceProgram
    );
    Ok(())
}

fn reward_subject(
    deal: &DealAccount,
    receipt: &deal_reward_engine::RewardReceipt,
    role: u8,
) -> Result<(Pubkey, u64)> {
    match role {
        REWARD_ROLE_A => Ok((deal.creator, receipt.a_reward)),
        REWARD_ROLE_B => Ok((deal.participant, receipt.b_reward)),
        REWARD_ROLE_C => Ok((receipt.c_recipient, receipt.c_reward)),
        _ => err!(ResultIndexError::InvalidRole),
    }
}

fn credit_subject(
    receipt: &deal_finalizer::CreditRecordingReceipt,
    side: u8,
) -> Result<(Pubkey, u128)> {
    match side {
        CREDIT_SIDE_A => Ok((receipt.a_identity_mint, receipt.a_delta)),
        CREDIT_SIDE_B => Ok((receipt.b_identity_mint, receipt.b_delta)),
        _ => err!(ResultIndexError::InvalidSide),
    }
}

#[allow(clippy::too_many_arguments)]
fn append_result(
    header: &mut Account<'_, ResultHeader>,
    page: &mut Account<'_, ResultPage>,
    marker: &mut Account<'_, ResultMarker>,
    subject: Pubkey,
    deal: Pubkey,
    recorded_at: i64,
    page_no: u32,
    header_bump: u8,
    page_bump: u8,
    marker_bump: u8,
) -> Result<()> {
    if header.subject == Pubkey::default() {
        header.subject = subject;
        header.count = 0;
        header.next_sequence = 0;
        header.bump = header_bump;
    }
    require_keys_eq!(header.subject, subject, ResultIndexError::InvalidHeader);
    let expected_page = header.next_sequence / RESULT_PAGE_SIZE as u64;
    require_eq!(
        u64::from(page_no),
        expected_page,
        ResultIndexError::InvalidPage
    );

    if page.subject == Pubkey::default() {
        page.subject = subject;
        page.page_no = page_no;
        page.entries = Vec::new();
        page.bump = page_bump;
    }
    require_keys_eq!(page.subject, subject, ResultIndexError::InvalidPage);
    require_eq!(page.page_no, page_no, ResultIndexError::InvalidPage);
    require!(
        page.entries.len() < RESULT_PAGE_SIZE,
        ResultIndexError::PageFull
    );

    page.entries.push(ResultDealEntry {
        deal,
        sequence: header.next_sequence,
        recorded_at,
    });
    marker.subject = subject;
    marker.deal = deal;
    marker.sequence = header.next_sequence;
    marker.bump = marker_bump;
    header.count = header
        .count
        .checked_add(1)
        .ok_or(ResultIndexError::CounterOverflow)?;
    header.next_sequence = header
        .next_sequence
        .checked_add(1)
        .ok_or(ResultIndexError::CounterOverflow)?;
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(init, payer = payer, space = ResultIndexConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, ResultIndexConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ResultIndexConfig>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ResultIndexConfig>,
}

#[derive(Accounts)]
#[instruction(role: u8, page_no: u32)]
pub struct IndexReward<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ResultIndexConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub deal: Account<'info, DealAccount>,
    #[account(
        seeds = [deal_reward_engine::RECEIPT_SEED, deal.key().as_ref()],
        bump = reward_receipt.bump,
        seeds::program = deal_reward_engine::ID
    )]
    pub reward_receipt: Account<'info, deal_reward_engine::RewardReceipt>,
    /// CHECK: Must equal the selected reward recipient.
    pub subject: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = ResultHeader::SPACE,
        seeds = [REWARD_HEADER_SEED, subject.key().as_ref()],
        bump
    )]
    pub header: Account<'info, ResultHeader>,
    #[account(
        init_if_needed,
        payer = payer,
        space = ResultPage::SPACE,
        seeds = [REWARD_PAGE_SEED, subject.key().as_ref(), &page_no.to_le_bytes()],
        bump
    )]
    pub page: Account<'info, ResultPage>,
    #[account(
        init,
        payer = payer,
        space = ResultMarker::SPACE,
        seeds = [REWARD_MARKER_SEED, subject.key().as_ref(), deal.key().as_ref()],
        bump
    )]
    pub marker: Account<'info, ResultMarker>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(side: u8, page_no: u32)]
pub struct IndexCredit<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ResultIndexConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub deal: Account<'info, DealAccount>,
    #[account(
        seeds = [deal_finalizer::CREDIT_RECEIPT_SEED, deal.key().as_ref()],
        bump = credit_receipt.bump,
        seeds::program = deal_finalizer::ID
    )]
    pub credit_receipt: Account<'info, deal_finalizer::CreditRecordingReceipt>,
    /// CHECK: Must equal the selected official identity mint.
    pub subject: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = ResultHeader::SPACE,
        seeds = [CREDIT_HEADER_SEED, subject.key().as_ref()],
        bump
    )]
    pub header: Account<'info, ResultHeader>,
    #[account(
        init_if_needed,
        payer = payer,
        space = ResultPage::SPACE,
        seeds = [CREDIT_PAGE_SEED, subject.key().as_ref(), &page_no.to_le_bytes()],
        bump
    )]
    pub page: Account<'info, ResultPage>,
    #[account(
        init,
        payer = payer,
        space = ResultMarker::SPACE,
        seeds = [CREDIT_MARKER_SEED, subject.key().as_ref(), deal.key().as_ref()],
        bump
    )]
    pub marker: Account<'info, ResultMarker>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct ResultIndexConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub reward_program: Pubkey,
    pub finalizer_program: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

impl ResultIndexConfig {
    pub const SPACE: usize = 8 + (32 * 4) + 1 + 1;
}

#[account]
pub struct ResultHeader {
    pub subject: Pubkey,
    pub count: u64,
    pub next_sequence: u64,
    pub bump: u8,
}

impl ResultHeader {
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ResultDealEntry {
    pub deal: Pubkey,
    pub sequence: u64,
    pub recorded_at: i64,
}

impl ResultDealEntry {
    pub const SPACE: usize = 32 + 8 + 8;
}

#[account]
pub struct ResultPage {
    pub subject: Pubkey,
    pub page_no: u32,
    pub entries: Vec<ResultDealEntry>,
    pub bump: u8,
}

impl ResultPage {
    pub const SPACE: usize = 8 + 32 + 4 + 4 + (ResultDealEntry::SPACE * RESULT_PAGE_SIZE) + 1;
}

#[account]
pub struct ResultMarker {
    pub subject: Pubkey,
    pub deal: Pubkey,
    pub sequence: u64,
    pub bump: u8,
}

impl ResultMarker {
    pub const SPACE: usize = 8 + (32 * 2) + 8 + 1;
}

#[event]
pub struct ResultIndexInitialized {
    pub authority: Pubkey,
    pub reward_program: Pubkey,
    pub finalizer_program: Pubkey,
}

#[event]
pub struct ResultIndexPauseUpdated {
    pub paused: bool,
}

#[event]
pub struct ResultIndexAuthorityProposed {
    pub pending_authority: Pubkey,
}

#[event]
pub struct ResultIndexAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct RewardDealIndexed {
    pub subject: Pubkey,
    pub deal: Pubkey,
    pub role: u8,
    pub amount: u64,
    pub page_no: u32,
}

#[event]
pub struct CreditDealIndexed {
    pub identity_mint: Pubkey,
    pub deal: Pubkey,
    pub side: u8,
    pub amount: u128,
    pub page_no: u32,
}

#[error_code(offset = 6100)]
pub enum ResultIndexError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("pending authority is invalid")]
    InvalidPendingAuthority,
    #[msg("result index is paused")]
    Paused,
    #[msg("source program configuration is invalid")]
    InvalidSourceProgram,
    #[msg("deal is not completed")]
    DealNotCompleted,
    #[msg("reward receipt is invalid")]
    InvalidRewardReceipt,
    #[msg("credit receipt is invalid")]
    InvalidCreditReceipt,
    #[msg("result subject is invalid")]
    InvalidSubject,
    #[msg("reward role is invalid")]
    InvalidRole,
    #[msg("credit side is invalid")]
    InvalidSide,
    #[msg("zero results are not indexed")]
    ZeroResult,
    #[msg("result header is invalid")]
    InvalidHeader,
    #[msg("result page is invalid")]
    InvalidPage,
    #[msg("result page is full")]
    PageFull,
    #[msg("result counter overflow")]
    CounterOverflow,
}
