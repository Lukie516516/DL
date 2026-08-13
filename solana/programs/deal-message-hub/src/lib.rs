#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, BurnChecked, Mint, TokenAccount, TokenInterface};
use deal_core::state::DealAccount;

declare_id!("tY7R1Ai842jvRRNCdgudjAw7HVuENopG4ZmwYNTQNCJ");

pub const CONFIG_SEED: &[u8] = b"message-config";
pub const THREAD_SEED: &[u8] = b"thread";
pub const MESSAGE_SEED: &[u8] = b"message";
pub const MAX_MESSAGE_BYTES: usize = 1_500;

#[program]
pub mod deal_message_hub {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        trusted_writer: Pubkey,
        dc_mint: Pubkey,
        message_price: u64,
        fee_enabled: bool,
    ) -> Result<()> {
        require!(
            trusted_writer != Pubkey::default(),
            MessageError::ZeroAddress
        );
        require!(dc_mint != Pubkey::default(), MessageError::ZeroAddress);
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.trusted_writer = trusted_writer;
        config.core_program = deal_core::id();
        config.dc_mint = dc_mint;
        config.message_price = message_price;
        config.fee_enabled = fee_enabled;
        config.paused = true;
        config.bump = ctx.bumps.config;
        emit!(MessageConfigInitialized {
            authority: config.authority,
            trusted_writer,
            dc_mint,
            message_price,
            fee_enabled,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.paused = paused;
        emit!(MessagePauseUpdated { paused });
        Ok(())
    }

    pub fn set_fee_rule(
        ctx: Context<AdminConfig>,
        dc_mint: Pubkey,
        message_price: u64,
        fee_enabled: bool,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(dc_mint != Pubkey::default(), MessageError::ZeroAddress);
        let config = &mut ctx.accounts.config;
        config.dc_mint = dc_mint;
        config.message_price = message_price;
        config.fee_enabled = fee_enabled;
        emit!(MessageFeeRuleUpdated {
            dc_mint,
            message_price,
            fee_enabled,
        });
        Ok(())
    }

    pub fn set_trusted_writer(ctx: Context<AdminConfig>, trusted_writer: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            trusted_writer != Pubkey::default(),
            MessageError::ZeroAddress
        );
        ctx.accounts.config.trusted_writer = trusted_writer;
        emit!(TrustedWriterUpdated { trusted_writer });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            MessageError::ZeroAddress
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(MessageAuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            MessageError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = Pubkey::default();
        emit!(MessageAuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority,
        });
        Ok(())
    }

    pub fn post_message(ctx: Context<PostMessage>, index: u64, content: String) -> Result<()> {
        require!(!ctx.accounts.config.paused, MessageError::Paused);
        validate_content(&content)?;
        assert_participant(&ctx.accounts.deal, ctx.accounts.sender.key())?;
        prepare_thread_and_index(
            &mut ctx.accounts.thread,
            ctx.accounts.deal.key(),
            index,
            ctx.bumps.thread,
        )?;
        charge_fee(&ctx)?;
        store_message(
            &mut ctx.accounts.message,
            &mut ctx.accounts.thread,
            ctx.accounts.deal.key(),
            ctx.accounts.sender.key(),
            index,
            content,
            ctx.bumps.message,
        )
    }

    pub fn post_from_writer(
        ctx: Context<PostFromWriter>,
        index: u64,
        sender: Pubkey,
        content: String,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, MessageError::Paused);
        require_keys_eq!(
            ctx.accounts.config.trusted_writer,
            ctx.accounts.writer.key(),
            MessageError::UnauthorizedWriter
        );
        validate_content(&content)?;
        assert_participant(&ctx.accounts.deal, sender)?;
        prepare_thread_and_index(
            &mut ctx.accounts.thread,
            ctx.accounts.deal.key(),
            index,
            ctx.bumps.thread,
        )?;
        store_message(
            &mut ctx.accounts.message,
            &mut ctx.accounts.thread,
            ctx.accounts.deal.key(),
            sender,
            index,
            content,
            ctx.bumps.message,
        )
    }
}

fn assert_authority(config: &MessageConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        config.authority,
        authority.key(),
        MessageError::Unauthorized
    );
    Ok(())
}

fn assert_participant(deal: &DealAccount, sender: Pubkey) -> Result<()> {
    require!(
        sender == deal.creator || sender == deal.participant,
        MessageError::NotParticipant
    );
    Ok(())
}

fn validate_content(content: &str) -> Result<()> {
    require!(!content.is_empty(), MessageError::EmptyMessage);
    require!(
        content.len() <= MAX_MESSAGE_BYTES,
        MessageError::MessageTooLong
    );
    Ok(())
}

fn prepare_thread_and_index(
    thread: &mut Account<'_, MessageThread>,
    deal: Pubkey,
    index: u64,
    bump: u8,
) -> Result<()> {
    if thread.deal == Pubkey::default() {
        thread.deal = deal;
        thread.count = 0;
        thread.bump = bump;
    }
    require_keys_eq!(thread.deal, deal, MessageError::InvalidThread);
    require_eq!(thread.count, index, MessageError::InvalidMessageIndex);
    Ok(())
}

fn charge_fee(ctx: &Context<PostMessage>) -> Result<()> {
    let config = &ctx.accounts.config;
    if !config.fee_enabled || config.message_price == 0 {
        return Ok(());
    }
    require_keys_eq!(
        config.dc_mint,
        ctx.accounts.dc_mint.key(),
        MessageError::InvalidMint
    );
    require_keys_eq!(
        ctx.accounts.sender_dc.owner,
        ctx.accounts.sender.key(),
        MessageError::InvalidTokenOwner
    );
    require_keys_eq!(
        ctx.accounts.sender_dc.mint,
        ctx.accounts.dc_mint.key(),
        MessageError::InvalidMint
    );
    token_interface::burn_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            BurnChecked {
                mint: ctx.accounts.dc_mint.to_account_info(),
                from: ctx.accounts.sender_dc.to_account_info(),
                authority: ctx.accounts.sender.to_account_info(),
            },
        ),
        config.message_price,
        ctx.accounts.dc_mint.decimals,
    )?;
    emit!(MessageFeeBurned {
        payer: ctx.accounts.sender.key(),
        amount: config.message_price,
    });
    Ok(())
}

fn store_message(
    message: &mut Account<'_, StoredMessage>,
    thread: &mut Account<'_, MessageThread>,
    deal: Pubkey,
    sender: Pubkey,
    index: u64,
    content: String,
    bump: u8,
) -> Result<()> {
    let timestamp = Clock::get()?.unix_timestamp;
    message.deal = deal;
    message.index = index;
    message.sender = sender;
    message.timestamp = timestamp;
    message.content = content;
    message.bump = bump;
    thread.count = thread
        .count
        .checked_add(1)
        .ok_or_else(|| error!(MessageError::MessageCountOverflow))?;
    emit!(MessageStored {
        deal,
        sender,
        index,
        timestamp,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(init, payer = payer, space = MessageConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, MessageConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, MessageConfig>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, MessageConfig>,
}

#[derive(Accounts)]
#[instruction(index: u64, content: String)]
pub struct PostMessage<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, MessageConfig>,
    #[account(mut)]
    pub sender: Signer<'info>,
    pub deal: Account<'info, DealAccount>,
    #[account(
        init_if_needed,
        payer = sender,
        space = MessageThread::SPACE,
        seeds = [THREAD_SEED, deal.key().as_ref()],
        bump
    )]
    pub thread: Account<'info, MessageThread>,
    #[account(
        init,
        payer = sender,
        space = StoredMessage::SPACE,
        seeds = [MESSAGE_SEED, deal.key().as_ref(), &index.to_le_bytes()],
        bump
    )]
    pub message: Account<'info, StoredMessage>,
    #[account(mut)]
    pub sender_dc: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub dc_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u64, sender: Pubkey, content: String)]
pub struct PostFromWriter<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, MessageConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub writer: Signer<'info>,
    pub deal: Account<'info, DealAccount>,
    #[account(
        init_if_needed,
        payer = payer,
        space = MessageThread::SPACE,
        seeds = [THREAD_SEED, deal.key().as_ref()],
        bump
    )]
    pub thread: Account<'info, MessageThread>,
    #[account(
        init,
        payer = payer,
        space = StoredMessage::SPACE,
        seeds = [MESSAGE_SEED, deal.key().as_ref(), &index.to_le_bytes()],
        bump
    )]
    pub message: Account<'info, StoredMessage>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct MessageConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub trusted_writer: Pubkey,
    pub core_program: Pubkey,
    pub dc_mint: Pubkey,
    pub message_price: u64,
    pub fee_enabled: bool,
    pub paused: bool,
    pub bump: u8,
}

impl MessageConfig {
    pub const SPACE: usize = 8 + (32 * 5) + 8 + 1 + 1 + 1;
}

#[account]
pub struct MessageThread {
    pub deal: Pubkey,
    pub count: u64,
    pub bump: u8,
}

impl MessageThread {
    pub const SPACE: usize = 8 + 32 + 8 + 1;
}

#[account]
pub struct StoredMessage {
    pub deal: Pubkey,
    pub index: u64,
    pub sender: Pubkey,
    pub timestamp: i64,
    pub content: String,
    pub bump: u8,
}

impl StoredMessage {
    pub const SPACE: usize = 8 + 32 + 8 + 32 + 8 + 4 + MAX_MESSAGE_BYTES + 1;
}

#[event]
pub struct MessageConfigInitialized {
    pub authority: Pubkey,
    pub trusted_writer: Pubkey,
    pub dc_mint: Pubkey,
    pub message_price: u64,
    pub fee_enabled: bool,
}

#[event]
pub struct MessagePauseUpdated {
    pub paused: bool,
}

#[event]
pub struct MessageFeeRuleUpdated {
    pub dc_mint: Pubkey,
    pub message_price: u64,
    pub fee_enabled: bool,
}

#[event]
pub struct TrustedWriterUpdated {
    pub trusted_writer: Pubkey,
}

#[event]
pub struct MessageAuthorityProposed {
    pub pending_authority: Pubkey,
}

#[event]
pub struct MessageAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct MessageStored {
    pub deal: Pubkey,
    pub sender: Pubkey,
    pub index: u64,
    pub timestamp: i64,
}

#[event]
pub struct MessageFeeBurned {
    pub payer: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum MessageError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("pending authority is invalid")]
    InvalidPendingAuthority,
    #[msg("message hub is paused")]
    Paused,
    #[msg("sender is not a deal participant")]
    NotParticipant,
    #[msg("message cannot be empty")]
    EmptyMessage,
    #[msg("message exceeds 1500 bytes")]
    MessageTooLong,
    #[msg("message index does not match the thread count")]
    InvalidMessageIndex,
    #[msg("message thread does not belong to this deal")]
    InvalidThread,
    #[msg("trusted writer is not authorized")]
    UnauthorizedWriter,
    #[msg("token mint is invalid")]
    InvalidMint,
    #[msg("token account owner is invalid")]
    InvalidTokenOwner,
    #[msg("message count overflow")]
    MessageCountOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_bounds_match_evm() {
        assert!(validate_content("").is_err());
        assert!(validate_content(&"a".repeat(MAX_MESSAGE_BYTES)).is_ok());
        assert!(validate_content(&"a".repeat(MAX_MESSAGE_BYTES + 1)).is_err());
        assert!(validate_content(&"中".repeat(500)).is_ok());
        assert!(validate_content(&"中".repeat(501)).is_err());
    }
}
