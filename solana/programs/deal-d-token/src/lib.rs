#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, FreezeAccount, Mint, ThawAccount, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("7yHub6z31FBMNdYxAgVX2AKiXbut6cHxZbx6M1mycjEt");

pub const CONFIG_SEED: &[u8] = b"d-token-config";
pub const FREEZE_AUTHORITY_SEED: &[u8] = b"d-freeze-authority";
pub const HOLDER_SEED: &[u8] = b"d-holder";
pub const CHECKPOINT_SEED: &[u8] = b"d-checkpoint";
pub const D_DECIMALS: u8 = 9;
pub const D_UNIT: u64 = 1_000_000_000;
pub const MAX_SUPPLY: u64 = 100 * D_UNIT;
pub const SEAT_THRESHOLD: u64 = 25 * D_UNIT / 10;

#[program]
pub mod deal_d_token {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            anchor_spl::token_2022::ID,
            DTokenError::Token2022Required
        );
        require_eq!(
            ctx.accounts.mint.decimals,
            D_DECIMALS,
            DTokenError::InvalidDecimals
        );
        require_eq!(
            ctx.accounts.mint.supply,
            MAX_SUPPLY,
            DTokenError::InvalidSupply
        );
        require!(
            ctx.accounts.mint.mint_authority.is_none(),
            DTokenError::MintAuthorityNotRevoked
        );
        require!(
            ctx.accounts.mint.freeze_authority
                == anchor_lang::solana_program::program_option::COption::Some(
                    ctx.accounts.freeze_authority.key()
                ),
            DTokenError::InvalidFreezeAuthority
        );
        let default_state = anchor_spl::token_interface::get_mint_extension_data::<
            anchor_spl::token_interface::spl_token_2022::extension::default_account_state::DefaultAccountState,
        >(&ctx.accounts.mint.to_account_info())?;
        require_eq!(
            default_state.state,
            anchor_spl::token_interface::spl_token_2022::state::AccountState::Frozen as u8,
            DTokenError::DefaultStateMustBeFrozen
        );
        require_keys_eq!(
            ctx.accounts.initial_holder_token.mint,
            ctx.accounts.mint.key(),
            DTokenError::InvalidMint
        );
        require_keys_eq!(
            ctx.accounts.initial_holder_token.owner,
            ctx.accounts.initial_holder.key(),
            DTokenError::InvalidTokenOwner
        );
        require_eq!(
            ctx.accounts.initial_holder_token.amount,
            MAX_SUPPLY,
            DTokenError::InvalidSupply
        );
        require!(
            ctx.accounts.initial_holder_token.state
                == anchor_spl::token_interface::spl_token_2022::state::AccountState::Frozen,
            DTokenError::AccountMustBeFrozen
        );

        let slot = Clock::get()?.slot;
        let config = &mut ctx.accounts.config;
        config.mint = ctx.accounts.mint.key();
        config.total_supply = MAX_SUPPLY;
        config.seat_threshold = SEAT_THRESHOLD;
        config.holder_count = 1;
        config.bump = ctx.bumps.config;
        config.freeze_bump = ctx.bumps.freeze_authority;

        initialize_holder(
            &mut ctx.accounts.initial_holder_state,
            ctx.accounts.initial_holder.key(),
            MAX_SUPPLY,
            slot,
            ctx.bumps.initial_holder_state,
        );
        ctx.accounts.initial_holder_state.checkpoint_count = 1;
        write_checkpoint(
            &mut ctx.accounts.initial_checkpoint,
            ctx.accounts.initial_holder.key(),
            0,
            slot,
            MAX_SUPPLY,
            ctx.bumps.initial_checkpoint,
        );

        emit!(DTokenInitialized {
            mint: ctx.accounts.mint.key(),
            initial_holder: ctx.accounts.initial_holder.key(),
            supply: MAX_SUPPLY,
        });
        Ok(())
    }

    pub fn transfer_d(
        ctx: Context<TransferD>,
        amount: u64,
        sender_checkpoint_index: u64,
        recipient_checkpoint_index: u64,
    ) -> Result<()> {
        require!(amount > 0, DTokenError::InvalidAmount);
        require_keys_neq!(
            ctx.accounts.holder.key(),
            ctx.accounts.recipient.key(),
            DTokenError::UseSelfTransfer
        );
        validate_transfer_accounts(
            &ctx.accounts.config,
            &ctx.accounts.mint,
            &ctx.accounts.source,
            &ctx.accounts.destination,
            ctx.accounts.holder.key(),
            ctx.accounts.recipient.key(),
            ctx.accounts.token_program.key(),
        )?;
        require_eq!(
            ctx.accounts.sender_state.checkpoint_count,
            sender_checkpoint_index,
            DTokenError::WrongCheckpointIndex
        );
        require!(
            ctx.accounts.sender_state.balance >= amount,
            DTokenError::InsufficientBalance
        );

        let recipient_is_new = ctx.accounts.recipient_state.owner == Pubkey::default();
        if recipient_is_new {
            require_eq!(
                recipient_checkpoint_index,
                0,
                DTokenError::WrongCheckpointIndex
            );
            initialize_holder(
                &mut ctx.accounts.recipient_state,
                ctx.accounts.recipient.key(),
                0,
                0,
                ctx.bumps.recipient_state,
            );
            ctx.accounts.config.holder_count = ctx
                .accounts
                .config
                .holder_count
                .checked_add(1)
                .ok_or_else(|| error!(DTokenError::MathOverflow))?;
        } else {
            require_keys_eq!(
                ctx.accounts.recipient_state.owner,
                ctx.accounts.recipient.key(),
                DTokenError::InvalidHolderState
            );
            require_eq!(
                ctx.accounts.recipient_state.checkpoint_count,
                recipient_checkpoint_index,
                DTokenError::WrongCheckpointIndex
            );
        }

        execute_frozen_transfer(
            &ctx.accounts.config,
            &ctx.accounts.freeze_authority,
            &ctx.accounts.mint,
            &ctx.accounts.source,
            &ctx.accounts.destination,
            &ctx.accounts.holder,
            &ctx.accounts.token_program,
            amount,
        )?;

        let sender_balance = ctx
            .accounts
            .sender_state
            .balance
            .checked_sub(amount)
            .ok_or_else(|| error!(DTokenError::MathOverflow))?;
        let recipient_balance = ctx
            .accounts
            .recipient_state
            .balance
            .checked_add(amount)
            .ok_or_else(|| error!(DTokenError::MathOverflow))?;
        let slot = Clock::get()?.slot;
        update_holder(&mut ctx.accounts.sender_state, sender_balance, slot)?;
        update_holder(&mut ctx.accounts.recipient_state, recipient_balance, slot)?;
        write_checkpoint(
            &mut ctx.accounts.sender_checkpoint,
            ctx.accounts.holder.key(),
            sender_checkpoint_index,
            slot,
            sender_balance,
            ctx.bumps.sender_checkpoint,
        );
        write_checkpoint(
            &mut ctx.accounts.recipient_checkpoint,
            ctx.accounts.recipient.key(),
            recipient_checkpoint_index,
            slot,
            recipient_balance,
            ctx.bumps.recipient_checkpoint,
        );

        emit!(DTransferred {
            from: ctx.accounts.holder.key(),
            to: ctx.accounts.recipient.key(),
            amount,
            sender_balance,
            recipient_balance,
            slot,
        });
        Ok(())
    }

    pub fn transfer_between_own_accounts(
        ctx: Context<TransferBetweenOwnAccounts>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, DTokenError::InvalidAmount);
        validate_transfer_accounts(
            &ctx.accounts.config,
            &ctx.accounts.mint,
            &ctx.accounts.source,
            &ctx.accounts.destination,
            ctx.accounts.holder.key(),
            ctx.accounts.holder.key(),
            ctx.accounts.token_program.key(),
        )?;
        execute_frozen_transfer(
            &ctx.accounts.config,
            &ctx.accounts.freeze_authority,
            &ctx.accounts.mint,
            &ctx.accounts.source,
            &ctx.accounts.destination,
            &ctx.accounts.holder,
            &ctx.accounts.token_program,
            amount,
        )?;
        emit!(DAccountMoved {
            holder: ctx.accounts.holder.key(),
            amount,
        });
        Ok(())
    }
}

fn validate_transfer_accounts(
    config: &Account<'_, DTokenConfig>,
    mint: &InterfaceAccount<'_, Mint>,
    source: &InterfaceAccount<'_, TokenAccount>,
    destination: &InterfaceAccount<'_, TokenAccount>,
    source_owner: Pubkey,
    destination_owner: Pubkey,
    token_program: Pubkey,
) -> Result<()> {
    require_keys_eq!(
        token_program,
        anchor_spl::token_2022::ID,
        DTokenError::Token2022Required
    );
    require_keys_eq!(config.mint, mint.key(), DTokenError::InvalidMint);
    require_keys_eq!(source.mint, mint.key(), DTokenError::InvalidMint);
    require_keys_eq!(destination.mint, mint.key(), DTokenError::InvalidMint);
    require_keys_eq!(source.owner, source_owner, DTokenError::InvalidTokenOwner);
    require_keys_eq!(
        destination.owner,
        destination_owner,
        DTokenError::InvalidTokenOwner
    );
    require!(
        source.state == anchor_spl::token_interface::spl_token_2022::state::AccountState::Frozen,
        DTokenError::AccountMustBeFrozen
    );
    require!(
        destination.state
            == anchor_spl::token_interface::spl_token_2022::state::AccountState::Frozen,
        DTokenError::AccountMustBeFrozen
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn execute_frozen_transfer<'info>(
    config: &Account<'info, DTokenConfig>,
    freeze_authority: &UncheckedAccount<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    source: &InterfaceAccount<'info, TokenAccount>,
    destination: &InterfaceAccount<'info, TokenAccount>,
    holder: &Signer<'info>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    let bump = [config.freeze_bump];
    let signer_seeds: &[&[u8]] = &[FREEZE_AUTHORITY_SEED, &bump];
    let signer = &[signer_seeds];

    token_interface::thaw_account(CpiContext::new_with_signer(
        token_program.key(),
        ThawAccount {
            account: source.to_account_info(),
            mint: mint.to_account_info(),
            authority: freeze_authority.to_account_info(),
        },
        signer,
    ))?;
    token_interface::thaw_account(CpiContext::new_with_signer(
        token_program.key(),
        ThawAccount {
            account: destination.to_account_info(),
            mint: mint.to_account_info(),
            authority: freeze_authority.to_account_info(),
        },
        signer,
    ))?;
    token_interface::transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from: source.to_account_info(),
                mint: mint.to_account_info(),
                to: destination.to_account_info(),
                authority: holder.to_account_info(),
            },
        ),
        amount,
        mint.decimals,
    )?;
    token_interface::freeze_account(CpiContext::new_with_signer(
        token_program.key(),
        FreezeAccount {
            account: source.to_account_info(),
            mint: mint.to_account_info(),
            authority: freeze_authority.to_account_info(),
        },
        signer,
    ))?;
    token_interface::freeze_account(CpiContext::new_with_signer(
        token_program.key(),
        FreezeAccount {
            account: destination.to_account_info(),
            mint: mint.to_account_info(),
            authority: freeze_authority.to_account_info(),
        },
        signer,
    ))?;
    Ok(())
}

fn initialize_holder(
    holder: &mut Account<'_, HolderState>,
    owner: Pubkey,
    balance: u64,
    slot: u64,
    bump: u8,
) {
    holder.owner = owner;
    holder.balance = balance;
    holder.checkpoint_count = 0;
    holder.last_checkpoint_slot = slot;
    holder.bump = bump;
}

fn update_holder(holder: &mut Account<'_, HolderState>, balance: u64, slot: u64) -> Result<()> {
    holder.balance = balance;
    holder.last_checkpoint_slot = slot;
    holder.checkpoint_count = holder
        .checkpoint_count
        .checked_add(1)
        .ok_or_else(|| error!(DTokenError::MathOverflow))?;
    Ok(())
}

fn write_checkpoint(
    checkpoint: &mut Account<'_, BalanceCheckpoint>,
    owner: Pubkey,
    index: u64,
    slot: u64,
    balance: u64,
    bump: u8,
) {
    checkpoint.owner = owner;
    checkpoint.index = index;
    checkpoint.slot = slot;
    checkpoint.balance = balance;
    checkpoint.bump = bump;
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The initial holder is bound to the frozen token account below.
    pub initial_holder: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = DTokenConfig::SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, DTokenConfig>,
    /// CHECK: PDA is the only freeze authority and has no private key.
    #[account(seeds = [FREEZE_AUTHORITY_SEED], bump)]
    pub freeze_authority: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub initial_holder_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = payer,
        space = HolderState::SPACE,
        seeds = [HOLDER_SEED, initial_holder.key().as_ref()],
        bump
    )]
    pub initial_holder_state: Account<'info, HolderState>,
    #[account(
        init,
        payer = payer,
        space = BalanceCheckpoint::SPACE,
        seeds = [CHECKPOINT_SEED, initial_holder.key().as_ref(), &0u64.to_le_bytes()],
        bump
    )]
    pub initial_checkpoint: Account<'info, BalanceCheckpoint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(amount: u64, sender_checkpoint_index: u64, recipient_checkpoint_index: u64)]
pub struct TransferD<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub holder: Signer<'info>,
    /// CHECK: Bound to destination token ownership and holder-state PDA.
    pub recipient: UncheckedAccount<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DTokenConfig>,
    /// CHECK: PDA signs only thaw/freeze operations.
    #[account(seeds = [FREEZE_AUTHORITY_SEED], bump = config.freeze_bump)]
    pub freeze_authority: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [HOLDER_SEED, holder.key().as_ref()], bump = sender_state.bump)]
    pub sender_state: Account<'info, HolderState>,
    #[account(
        init_if_needed,
        payer = payer,
        space = HolderState::SPACE,
        seeds = [HOLDER_SEED, recipient.key().as_ref()],
        bump
    )]
    pub recipient_state: Account<'info, HolderState>,
    #[account(
        init,
        payer = payer,
        space = BalanceCheckpoint::SPACE,
        seeds = [CHECKPOINT_SEED, holder.key().as_ref(), &sender_checkpoint_index.to_le_bytes()],
        bump
    )]
    pub sender_checkpoint: Account<'info, BalanceCheckpoint>,
    #[account(
        init,
        payer = payer,
        space = BalanceCheckpoint::SPACE,
        seeds = [CHECKPOINT_SEED, recipient.key().as_ref(), &recipient_checkpoint_index.to_le_bytes()],
        bump
    )]
    pub recipient_checkpoint: Account<'info, BalanceCheckpoint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferBetweenOwnAccounts<'info> {
    pub holder: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DTokenConfig>,
    /// CHECK: PDA signs only thaw/freeze operations.
    #[account(seeds = [FREEZE_AUTHORITY_SEED], bump = config.freeze_bump)]
    pub freeze_authority: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[account]
pub struct DTokenConfig {
    pub mint: Pubkey,
    pub total_supply: u64,
    pub seat_threshold: u64,
    pub holder_count: u64,
    pub bump: u8,
    pub freeze_bump: u8,
}
impl DTokenConfig {
    pub const SPACE: usize = 8 + 32 + (8 * 3) + 2;
}

#[account]
pub struct HolderState {
    pub owner: Pubkey,
    pub balance: u64,
    pub checkpoint_count: u64,
    pub last_checkpoint_slot: u64,
    pub bump: u8,
}
impl HolderState {
    pub const SPACE: usize = 8 + 32 + (8 * 3) + 1;
}

#[account]
pub struct BalanceCheckpoint {
    pub owner: Pubkey,
    pub index: u64,
    pub slot: u64,
    pub balance: u64,
    pub bump: u8,
}
impl BalanceCheckpoint {
    pub const SPACE: usize = 8 + 32 + (8 * 3) + 1;
}

#[event]
pub struct DTokenInitialized {
    pub mint: Pubkey,
    pub initial_holder: Pubkey,
    pub supply: u64,
}
#[event]
pub struct DTransferred {
    pub from: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
    pub sender_balance: u64,
    pub recipient_balance: u64,
    pub slot: u64,
}
#[event]
pub struct DAccountMoved {
    pub holder: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum DTokenError {
    #[msg("D must use Token-2022")]
    Token2022Required,
    #[msg("D mint must use 9 decimals on Solana")]
    InvalidDecimals,
    #[msg("D supply must be exactly 100 tokens")]
    InvalidSupply,
    #[msg("D mint authority must be permanently revoked")]
    MintAuthorityNotRevoked,
    #[msg("D freeze authority must be the canonical program PDA")]
    InvalidFreezeAuthority,
    #[msg("new D accounts must default to frozen")]
    DefaultStateMustBeFrozen,
    #[msg("token mint does not match D mint")]
    InvalidMint,
    #[msg("token owner does not match the declared holder")]
    InvalidTokenOwner,
    #[msg("D token accounts must be frozen outside program transfers")]
    AccountMustBeFrozen,
    #[msg("amount must be greater than zero")]
    InvalidAmount,
    #[msg("use transfer_between_own_accounts for the same holder")]
    UseSelfTransfer,
    #[msg("checkpoint index is stale or out of sequence")]
    WrongCheckpointIndex,
    #[msg("holder balance is insufficient")]
    InsufficientBalance,
    #[msg("holder-state PDA is invalid")]
    InvalidHolderState,
    #[msg("arithmetic overflow")]
    MathOverflow,
}
