#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, BurnChecked, Mint, TokenAccount, TokenInterface};
use deal_core::state::DealAccount;
use deal_domain_entry::DomainDealBinding;
use deal_domain_rank::BlacklistEntry;
use deal_domain_registry::DomainRecord;

declare_id!("254WzKpJ7RXvpS1UHeZJqhRUMcsHN5U868eqjviMgihg");

pub const CONFIG_SEED: &[u8] = b"domain-hall-config";
pub const DIRECT_THREAD_SEED: &[u8] = b"domain-direct-thread";
pub const DEAL_THREAD_SEED: &[u8] = b"domain-deal-thread";
pub const MESSAGE_SEED: &[u8] = b"domain-hall-message";
pub const SIGNAL_THREAD_SEED: &[u8] = b"domain-signal-thread";
pub const SIGNAL_SEED: &[u8] = b"domain-pick-signal";
pub const MAX_MESSAGE_BYTES: usize = 1_500;

#[program]
pub mod deal_domain_hall {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        dc_mint: Pubkey,
        message_price: u64,
        fee_enabled: bool,
    ) -> Result<()> {
        require!(dc_mint != Pubkey::default(), HallError::ZeroAddress);
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.dc_mint = dc_mint;
        config.message_price = message_price;
        config.fee_enabled = fee_enabled;
        config.paused = true;
        config.bump = ctx.bumps.config;
        emit!(HallInitialized {
            authority: config.authority,
            dc_mint,
            message_price,
            fee_enabled,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.paused = paused;
        emit!(HallPauseUpdated { paused });
        Ok(())
    }

    pub fn set_fee_rule(
        ctx: Context<AdminConfig>,
        dc_mint: Pubkey,
        message_price: u64,
        fee_enabled: bool,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(dc_mint != Pubkey::default(), HallError::ZeroAddress);
        ctx.accounts.config.dc_mint = dc_mint;
        ctx.accounts.config.message_price = message_price;
        ctx.accounts.config.fee_enabled = fee_enabled;
        emit!(HallFeeRuleUpdated {
            dc_mint,
            message_price,
            fee_enabled,
        });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            HallError::ZeroAddress
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(HallAuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            HallError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = Pubkey::default();
        emit!(HallAuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority,
        });
        Ok(())
    }

    pub fn post_direct_message(
        ctx: Context<PostDirectMessage>,
        index: u64,
        content: String,
    ) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        validate_content(&content)?;
        validate_domain(&ctx.accounts.domain)?;
        let merchant = ctx.accounts.merchant.key();
        let user = ctx.accounts.user.key();
        let sender = ctx.accounts.sender.key();
        require!(
            merchant != Pubkey::default() && user != Pubkey::default(),
            HallError::ZeroAddress
        );
        require!(merchant != user, HallError::SameParty);
        require!(
            sender == merchant || sender == user,
            HallError::NotParticipant
        );
        assert_not_blacklisted(
            ctx.accounts.domain.key(),
            merchant,
            &ctx.accounts.merchant_blacklist,
        )?;
        assert_not_blacklisted(
            ctx.accounts.domain.key(),
            user,
            &ctx.accounts.user_blacklist,
        )?;
        prepare_direct_thread(
            &mut ctx.accounts.thread,
            ctx.accounts.domain.key(),
            merchant,
            user,
            index,
            ctx.bumps.thread,
        )?;
        charge_fee(
            &ctx.accounts.config,
            &ctx.accounts.sender,
            &ctx.accounts.sender_dc,
            &ctx.accounts.dc_mint,
            &ctx.accounts.token_program,
        )?;
        let thread = ctx.accounts.thread.key();
        store_message(
            &mut ctx.accounts.message,
            &mut ctx.accounts.thread.count,
            thread,
            ctx.accounts.domain.key(),
            Pubkey::default(),
            sender,
            index,
            content,
            ctx.bumps.message,
        )
    }

    pub fn post_deal_message(
        ctx: Context<PostDealMessage>,
        index: u64,
        content: String,
    ) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        validate_content(&content)?;
        validate_domain(&ctx.accounts.domain)?;
        require_keys_eq!(
            ctx.accounts.binding.domain,
            ctx.accounts.domain.key(),
            HallError::InvalidBinding
        );
        require_keys_eq!(
            ctx.accounts.binding.deal,
            ctx.accounts.deal.key(),
            HallError::InvalidBinding
        );
        require_keys_eq!(
            ctx.accounts.binding.creator,
            ctx.accounts.deal.creator,
            HallError::InvalidBinding
        );
        assert_not_blacklisted(
            ctx.accounts.domain.key(),
            ctx.accounts.deal.creator,
            &ctx.accounts.creator_blacklist,
        )?;
        assert_not_blacklisted(
            ctx.accounts.domain.key(),
            ctx.accounts.sender.key(),
            &ctx.accounts.sender_blacklist,
        )?;
        prepare_deal_thread(
            &mut ctx.accounts.thread,
            ctx.accounts.domain.key(),
            ctx.accounts.deal.key(),
            index,
            ctx.bumps.thread,
        )?;
        charge_fee(
            &ctx.accounts.config,
            &ctx.accounts.sender,
            &ctx.accounts.sender_dc,
            &ctx.accounts.dc_mint,
            &ctx.accounts.token_program,
        )?;
        let thread = ctx.accounts.thread.key();
        store_message(
            &mut ctx.accounts.message,
            &mut ctx.accounts.thread.count,
            thread,
            ctx.accounts.domain.key(),
            ctx.accounts.deal.key(),
            ctx.accounts.sender.key(),
            index,
            content,
            ctx.bumps.message,
        )
    }

    pub fn signal_pick_user(ctx: Context<SignalPickUser>, index: u64, note: String) -> Result<()> {
        assert_live(&ctx.accounts.config)?;
        validate_optional_note(&note)?;
        validate_domain(&ctx.accounts.domain)?;
        let merchant = ctx.accounts.merchant.key();
        let picked_user = ctx.accounts.picked_user.key();
        require!(
            picked_user != Pubkey::default() && picked_user != merchant,
            HallError::InvalidPickedUser
        );
        assert_not_blacklisted(
            ctx.accounts.domain.key(),
            merchant,
            &ctx.accounts.merchant_blacklist,
        )?;
        assert_not_blacklisted(
            ctx.accounts.domain.key(),
            picked_user,
            &ctx.accounts.picked_blacklist,
        )?;
        let thread = &mut ctx.accounts.thread;
        if thread.domain == Pubkey::default() {
            thread.domain = ctx.accounts.domain.key();
            thread.merchant = merchant;
            thread.count = 0;
            thread.bump = ctx.bumps.thread;
        }
        require_keys_eq!(
            thread.domain,
            ctx.accounts.domain.key(),
            HallError::InvalidThread
        );
        require_keys_eq!(thread.merchant, merchant, HallError::InvalidThread);
        require_eq!(thread.count, index, HallError::InvalidIndex);
        let timestamp = Clock::get()?.unix_timestamp;
        let signal = &mut ctx.accounts.signal;
        signal.domain = ctx.accounts.domain.key();
        signal.merchant = merchant;
        signal.picked_user = picked_user;
        signal.index = index;
        signal.timestamp = timestamp;
        signal.note = note;
        signal.bump = ctx.bumps.signal;
        thread.count = thread
            .count
            .checked_add(1)
            .ok_or(HallError::CountOverflow)?;
        emit!(PickUserSignaled {
            domain: signal.domain,
            merchant,
            picked_user,
            index,
            timestamp,
        });
        Ok(())
    }
}

fn assert_authority(config: &HallConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(config.authority, authority.key(), HallError::Unauthorized);
    Ok(())
}

fn assert_live(config: &HallConfig) -> Result<()> {
    require!(!config.paused, HallError::Paused);
    Ok(())
}

fn validate_domain(domain: &DomainRecord) -> Result<()> {
    require!(domain.owner != Pubkey::default(), HallError::InvalidDomain);
    require!(
        domain.resolve != Pubkey::default(),
        HallError::DomainNotResolved
    );
    Ok(())
}

fn validate_content(content: &str) -> Result<()> {
    require!(!content.is_empty(), HallError::EmptyMessage);
    require!(
        content.len() <= MAX_MESSAGE_BYTES,
        HallError::MessageTooLong
    );
    Ok(())
}

fn validate_optional_note(note: &str) -> Result<()> {
    require!(note.len() <= MAX_MESSAGE_BYTES, HallError::MessageTooLong);
    Ok(())
}

fn assert_not_blacklisted(
    domain: Pubkey,
    user: Pubkey,
    blacklist: &UncheckedAccount<'_>,
) -> Result<()> {
    let expected = Pubkey::find_program_address(
        &[
            deal_domain_rank::BLACKLIST_SEED,
            domain.as_ref(),
            user.as_ref(),
        ],
        &deal_domain_rank::id(),
    )
    .0;
    require_keys_eq!(blacklist.key(), expected, HallError::InvalidBlacklist);
    if blacklist.owner == &deal_domain_rank::id() && !blacklist.data_is_empty() {
        let data = blacklist.try_borrow_data()?;
        let entry = BlacklistEntry::try_deserialize(&mut data.as_ref())?;
        require_keys_eq!(entry.domain, domain, HallError::InvalidBlacklist);
        require_keys_eq!(entry.user, user, HallError::InvalidBlacklist);
        require!(!entry.banned, HallError::Blacklisted);
    }
    Ok(())
}

fn prepare_direct_thread(
    thread: &mut Account<'_, DirectThread>,
    domain: Pubkey,
    merchant: Pubkey,
    user: Pubkey,
    index: u64,
    bump: u8,
) -> Result<()> {
    if thread.domain == Pubkey::default() {
        thread.domain = domain;
        thread.merchant = merchant;
        thread.user = user;
        thread.count = 0;
        thread.bump = bump;
    }
    require_keys_eq!(thread.domain, domain, HallError::InvalidThread);
    require_keys_eq!(thread.merchant, merchant, HallError::InvalidThread);
    require_keys_eq!(thread.user, user, HallError::InvalidThread);
    require_eq!(thread.count, index, HallError::InvalidIndex);
    Ok(())
}

fn prepare_deal_thread(
    thread: &mut Account<'_, DealThread>,
    domain: Pubkey,
    deal: Pubkey,
    index: u64,
    bump: u8,
) -> Result<()> {
    if thread.domain == Pubkey::default() {
        thread.domain = domain;
        thread.deal = deal;
        thread.count = 0;
        thread.bump = bump;
    }
    require_keys_eq!(thread.domain, domain, HallError::InvalidThread);
    require_keys_eq!(thread.deal, deal, HallError::InvalidThread);
    require_eq!(thread.count, index, HallError::InvalidIndex);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn store_message(
    message: &mut Account<'_, HallMessage>,
    count: &mut u64,
    thread: Pubkey,
    domain: Pubkey,
    deal: Pubkey,
    sender: Pubkey,
    index: u64,
    content: String,
    bump: u8,
) -> Result<()> {
    let timestamp = Clock::get()?.unix_timestamp;
    message.thread = thread;
    message.domain = domain;
    message.deal = deal;
    message.index = index;
    message.sender = sender;
    message.timestamp = timestamp;
    message.content = content;
    message.bump = bump;
    *count = count.checked_add(1).ok_or(HallError::CountOverflow)?;
    emit!(HallMessageStored {
        thread,
        domain,
        deal,
        sender,
        index,
        timestamp,
    });
    Ok(())
}

fn charge_fee<'info>(
    config: &Account<'info, HallConfig>,
    sender: &Signer<'info>,
    sender_dc: &InterfaceAccount<'info, TokenAccount>,
    dc_mint: &InterfaceAccount<'info, Mint>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    if !config.fee_enabled || config.message_price == 0 {
        return Ok(());
    }
    require_keys_eq!(config.dc_mint, dc_mint.key(), HallError::InvalidMint);
    require_keys_eq!(sender_dc.owner, sender.key(), HallError::InvalidTokenOwner);
    require_keys_eq!(sender_dc.mint, dc_mint.key(), HallError::InvalidMint);
    token_interface::burn_checked(
        CpiContext::new(
            token_program.key(),
            BurnChecked {
                mint: dc_mint.to_account_info(),
                from: sender_dc.to_account_info(),
                authority: sender.to_account_info(),
            },
        ),
        config.message_price,
        dc_mint.decimals,
    )?;
    emit!(HallMessageFeeBurned {
        payer: sender.key(),
        amount: config.message_price,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(init, payer = payer, space = HallConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, HallConfig>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, HallConfig>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, HallConfig>,
}

#[derive(Accounts)]
#[instruction(index: u64, content: String)]
pub struct PostDirectMessage<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, HallConfig>,
    #[account(mut)]
    pub sender: Signer<'info>,
    pub domain: Box<Account<'info, DomainRecord>>,
    /// CHECK: Participant address constrained by thread seeds and sender checks.
    pub merchant: UncheckedAccount<'info>,
    /// CHECK: Participant address constrained by thread seeds and sender checks.
    pub user: UncheckedAccount<'info>,
    /// CHECK: Must be the merchant's rank blacklist PDA.
    pub merchant_blacklist: UncheckedAccount<'info>,
    /// CHECK: Must be the user's rank blacklist PDA.
    pub user_blacklist: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = sender, space = DirectThread::SPACE, seeds = [DIRECT_THREAD_SEED, domain.key().as_ref(), merchant.key().as_ref(), user.key().as_ref()], bump)]
    pub thread: Box<Account<'info, DirectThread>>,
    #[account(init, payer = sender, space = HallMessage::SPACE, seeds = [MESSAGE_SEED, thread.key().as_ref(), &index.to_le_bytes()], bump)]
    pub message: Box<Account<'info, HallMessage>>,
    #[account(mut)]
    pub sender_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u64, content: String)]
pub struct PostDealMessage<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, HallConfig>>,
    #[account(mut)]
    pub sender: Signer<'info>,
    pub domain: Box<Account<'info, DomainRecord>>,
    pub binding: Box<Account<'info, DomainDealBinding>>,
    pub deal: Box<Account<'info, DealAccount>>,
    /// CHECK: Must be the Deal creator's rank blacklist PDA.
    pub creator_blacklist: UncheckedAccount<'info>,
    /// CHECK: Must be the sender's rank blacklist PDA.
    pub sender_blacklist: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = sender, space = DealThread::SPACE, seeds = [DEAL_THREAD_SEED, domain.key().as_ref(), deal.key().as_ref()], bump)]
    pub thread: Box<Account<'info, DealThread>>,
    #[account(init, payer = sender, space = HallMessage::SPACE, seeds = [MESSAGE_SEED, thread.key().as_ref(), &index.to_le_bytes()], bump)]
    pub message: Box<Account<'info, HallMessage>>,
    #[account(mut)]
    pub sender_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u64, note: String)]
pub struct SignalPickUser<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, HallConfig>>,
    #[account(mut)]
    pub merchant: Signer<'info>,
    pub domain: Box<Account<'info, DomainRecord>>,
    /// CHECK: Address constrained by the signal and blacklist PDA.
    pub picked_user: UncheckedAccount<'info>,
    /// CHECK: Must be the merchant's rank blacklist PDA.
    pub merchant_blacklist: UncheckedAccount<'info>,
    /// CHECK: Must be the picked user's rank blacklist PDA.
    pub picked_blacklist: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = merchant, space = SignalThread::SPACE, seeds = [SIGNAL_THREAD_SEED, domain.key().as_ref(), merchant.key().as_ref()], bump)]
    pub thread: Box<Account<'info, SignalThread>>,
    #[account(init, payer = merchant, space = PickSignal::SPACE, seeds = [SIGNAL_SEED, thread.key().as_ref(), &index.to_le_bytes()], bump)]
    pub signal: Box<Account<'info, PickSignal>>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct HallConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub dc_mint: Pubkey,
    pub message_price: u64,
    pub fee_enabled: bool,
    pub paused: bool,
    pub bump: u8,
}

impl HallConfig {
    pub const SPACE: usize = 8 + (32 * 3) + 8 + 1 + 1 + 1;
}

#[account]
pub struct DirectThread {
    pub domain: Pubkey,
    pub merchant: Pubkey,
    pub user: Pubkey,
    pub count: u64,
    pub bump: u8,
}

impl DirectThread {
    pub const SPACE: usize = 8 + (32 * 3) + 8 + 1;
}

#[account]
pub struct DealThread {
    pub domain: Pubkey,
    pub deal: Pubkey,
    pub count: u64,
    pub bump: u8,
}

impl DealThread {
    pub const SPACE: usize = 8 + (32 * 2) + 8 + 1;
}

#[account]
pub struct HallMessage {
    pub thread: Pubkey,
    pub domain: Pubkey,
    pub deal: Pubkey,
    pub index: u64,
    pub sender: Pubkey,
    pub timestamp: i64,
    pub content: String,
    pub bump: u8,
}

impl HallMessage {
    pub const SPACE: usize = 8 + (32 * 4) + (8 * 2) + 4 + MAX_MESSAGE_BYTES + 1;
}

#[account]
pub struct SignalThread {
    pub domain: Pubkey,
    pub merchant: Pubkey,
    pub count: u64,
    pub bump: u8,
}

impl SignalThread {
    pub const SPACE: usize = 8 + (32 * 2) + 8 + 1;
}

#[account]
pub struct PickSignal {
    pub domain: Pubkey,
    pub merchant: Pubkey,
    pub picked_user: Pubkey,
    pub index: u64,
    pub timestamp: i64,
    pub note: String,
    pub bump: u8,
}

impl PickSignal {
    pub const SPACE: usize = 8 + (32 * 3) + (8 * 2) + 4 + MAX_MESSAGE_BYTES + 1;
}

#[event]
pub struct HallInitialized {
    pub authority: Pubkey,
    pub dc_mint: Pubkey,
    pub message_price: u64,
    pub fee_enabled: bool,
}
#[event]
pub struct HallPauseUpdated {
    pub paused: bool,
}
#[event]
pub struct HallFeeRuleUpdated {
    pub dc_mint: Pubkey,
    pub message_price: u64,
    pub fee_enabled: bool,
}
#[event]
pub struct HallAuthorityProposed {
    pub pending_authority: Pubkey,
}
#[event]
pub struct HallAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}
#[event]
pub struct HallMessageStored {
    pub thread: Pubkey,
    pub domain: Pubkey,
    pub deal: Pubkey,
    pub sender: Pubkey,
    pub index: u64,
    pub timestamp: i64,
}
#[event]
pub struct HallMessageFeeBurned {
    pub payer: Pubkey,
    pub amount: u64,
}
#[event]
pub struct PickUserSignaled {
    pub domain: Pubkey,
    pub merchant: Pubkey,
    pub picked_user: Pubkey,
    pub index: u64,
    pub timestamp: i64,
}

#[error_code(offset = 6200)]
pub enum HallError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("pending authority is invalid")]
    InvalidPendingAuthority,
    #[msg("domain hall is paused")]
    Paused,
    #[msg("domain is invalid")]
    InvalidDomain,
    #[msg("domain is not resolved")]
    DomainNotResolved,
    #[msg("message cannot be empty")]
    EmptyMessage,
    #[msg("message exceeds 1500 bytes")]
    MessageTooLong,
    #[msg("thread participants cannot be the same")]
    SameParty,
    #[msg("sender is not a thread participant")]
    NotParticipant,
    #[msg("thread account is invalid")]
    InvalidThread,
    #[msg("message or signal index is invalid")]
    InvalidIndex,
    #[msg("domain Deal binding is invalid")]
    InvalidBinding,
    #[msg("blacklist account is invalid")]
    InvalidBlacklist,
    #[msg("domain participant is blacklisted")]
    Blacklisted,
    #[msg("picked user is invalid")]
    InvalidPickedUser,
    #[msg("DC mint is invalid")]
    InvalidMint,
    #[msg("DC token account owner is invalid")]
    InvalidTokenOwner,
    #[msg("thread count overflow")]
    CountOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_limits_match_evm_bytes() {
        assert!(validate_content("").is_err());
        assert!(validate_content(&"a".repeat(MAX_MESSAGE_BYTES)).is_ok());
        assert!(validate_content(&"a".repeat(MAX_MESSAGE_BYTES + 1)).is_err());
        assert!(validate_content(&"中".repeat(500)).is_ok());
        assert!(validate_content(&"中".repeat(501)).is_err());
    }
}
