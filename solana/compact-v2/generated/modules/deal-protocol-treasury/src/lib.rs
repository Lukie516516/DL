#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("AiTezfTJ3DxeFr7oRiBhnz3wRZTJzCsrexhmRJd3u7rF");

pub const CONFIG_SEED: &[u8] = b"protocol-treasury-config";
pub const VAULT_AUTHORITY_SEED: &[u8] = b"protocol-treasury-vault";

#[program]
pub mod deal_protocol_treasury {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        controller: Pubkey,
        bootstrap_admin: Pubkey,
    ) -> Result<()> {
        require!(controller != Pubkey::default(), TreasuryError::ZeroAddress);
        require!(
            bootstrap_admin != Pubkey::default(),
            TreasuryError::ZeroAddress
        );
        let config = &mut ctx.accounts.config;
        config.controller = controller;
        config.bootstrap_admin = bootstrap_admin;
        config.bootstrap_locked = false;
        config.bump = ctx.bumps.config;
        config.vault_bump = ctx.bumps.vault_authority;
        emit!(TreasuryInitialized {
            controller,
            bootstrap_admin,
            vault_authority: ctx.accounts.vault_authority.key(),
        });
        Ok(())
    }

    pub fn bootstrap_set_controller(
        ctx: Context<BootstrapAdmin>,
        new_controller: Pubkey,
    ) -> Result<()> {
        assert_bootstrap(&ctx.accounts.config, &ctx.accounts.bootstrap_admin)?;
        set_controller(&mut ctx.accounts.config, new_controller)
    }

    pub fn lock_bootstrap(ctx: Context<BootstrapAdmin>) -> Result<()> {
        assert_bootstrap(&ctx.accounts.config, &ctx.accounts.bootstrap_admin)?;
        ctx.accounts.config.bootstrap_locked = true;
        emit!(BootstrapLocked {
            bootstrap_admin: ctx.accounts.bootstrap_admin.key(),
        });
        Ok(())
    }

    pub fn update_controller(ctx: Context<ControllerAction>, new_controller: Pubkey) -> Result<()> {
        assert_controller(&ctx.accounts.config, &ctx.accounts.controller)?;
        set_controller(&mut ctx.accounts.config, new_controller)
    }

    pub fn fund_native(ctx: Context<FundNative>, amount: u64) -> Result<()> {
        require!(amount > 0, TreasuryError::InvalidAmount);
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.funder.to_account_info(),
                    to: ctx.accounts.vault_authority.to_account_info(),
                },
            ),
            amount,
        )?;
        emit!(NativeFunded {
            from: ctx.accounts.funder.key(),
            amount,
        });
        Ok(())
    }

    pub fn pay_native(ctx: Context<PayNative>, amount: u64) -> Result<()> {
        assert_controller(&ctx.accounts.config, &ctx.accounts.controller)?;
        require!(amount > 0, TreasuryError::InvalidAmount);
        require!(
            ctx.accounts.recipient.key() != Pubkey::default(),
            TreasuryError::ZeroAddress
        );
        require!(
            ctx.accounts.vault_authority.lamports() >= amount,
            TreasuryError::InsufficientBalance
        );
        let bump = [ctx.accounts.config.vault_bump];
        let signer_seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &bump];
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.vault_authority.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
        )?;
        emit!(NativePaid {
            to: ctx.accounts.recipient.key(),
            amount,
        });
        Ok(())
    }

    pub fn pay_token(ctx: Context<PayToken>, amount: u64) -> Result<()> {
        assert_controller(&ctx.accounts.config, &ctx.accounts.controller)?;
        require!(amount > 0, TreasuryError::InvalidAmount);
        require_keys_eq!(
            ctx.accounts.source.owner,
            ctx.accounts.vault_authority.key(),
            TreasuryError::InvalidVault
        );
        require_keys_eq!(
            ctx.accounts.source.mint,
            ctx.accounts.mint.key(),
            TreasuryError::InvalidMint
        );
        require_keys_eq!(
            ctx.accounts.destination.mint,
            ctx.accounts.mint.key(),
            TreasuryError::InvalidMint
        );
        let bump = [ctx.accounts.config.vault_bump];
        let signer_seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &bump];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        emit!(TokenPaid {
            mint: ctx.accounts.mint.key(),
            to: ctx.accounts.destination.key(),
            amount,
        });
        Ok(())
    }
}

fn assert_bootstrap(config: &TreasuryConfig, bootstrap_admin: &Signer<'_>) -> Result<()> {
    require!(!config.bootstrap_locked, TreasuryError::BootstrapLocked);
    require_keys_eq!(
        config.bootstrap_admin,
        bootstrap_admin.key(),
        TreasuryError::NotBootstrapAdmin
    );
    Ok(())
}

fn assert_controller(config: &TreasuryConfig, controller: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        config.controller,
        controller.key(),
        TreasuryError::NotController
    );
    Ok(())
}

fn set_controller(config: &mut Account<'_, TreasuryConfig>, new_controller: Pubkey) -> Result<()> {
    require!(
        new_controller != Pubkey::default(),
        TreasuryError::ZeroAddress
    );
    let old_controller = config.controller;
    config.controller = new_controller;
    emit!(ControllerUpdated {
        old_controller,
        new_controller,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = TreasuryConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, TreasuryConfig>,
    /// CHECK: PDA is the native vault and SPL-token authority; it has no private key.
    #[account(mut, seeds = [VAULT_AUTHORITY_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BootstrapAdmin<'info> {
    pub bootstrap_admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TreasuryConfig>,
}

#[derive(Accounts)]
pub struct ControllerAction<'info> {
    pub controller: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TreasuryConfig>,
}

#[derive(Accounts)]
pub struct FundNative<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    /// CHECK: PDA receives native SOL and is constrained by its canonical seeds.
    #[account(mut, seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TreasuryConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PayNative<'info> {
    pub controller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TreasuryConfig>,
    /// CHECK: Canonical PDA signs the native transfer.
    #[account(mut, seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: Any nonzero recipient may receive an approved governance payment.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PayToken<'info> {
    pub controller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, TreasuryConfig>,
    /// CHECK: Canonical PDA signs SPL transfers and owns the source account.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[account]
pub struct TreasuryConfig {
    pub controller: Pubkey,
    pub bootstrap_admin: Pubkey,
    pub bootstrap_locked: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

impl TreasuryConfig {
    pub const SPACE: usize = 8 + (32 * 2) + 1 + 1 + 1;
}

#[event]
pub struct TreasuryInitialized {
    pub controller: Pubkey,
    pub bootstrap_admin: Pubkey,
    pub vault_authority: Pubkey,
}
#[event]
pub struct ControllerUpdated {
    pub old_controller: Pubkey,
    pub new_controller: Pubkey,
}
#[event]
pub struct BootstrapLocked {
    pub bootstrap_admin: Pubkey,
}
#[event]
pub struct NativeFunded {
    pub from: Pubkey,
    pub amount: u64,
}
#[event]
pub struct NativePaid {
    pub to: Pubkey,
    pub amount: u64,
}
#[event]
pub struct TokenPaid {
    pub mint: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum TreasuryError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not the treasury controller")]
    NotController,
    #[msg("caller is not the bootstrap admin")]
    NotBootstrapAdmin,
    #[msg("bootstrap authority is permanently locked")]
    BootstrapLocked,
    #[msg("amount must be greater than zero")]
    InvalidAmount,
    #[msg("treasury balance is insufficient")]
    InsufficientBalance,
    #[msg("treasury token vault is invalid")]
    InvalidVault,
    #[msg("token mint is invalid")]
    InvalidMint,
}
