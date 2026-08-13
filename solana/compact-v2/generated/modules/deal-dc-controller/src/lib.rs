#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token_interface::spl_token_2022::instruction::AuthorityType;
use anchor_spl::token_interface::{
    self, Mint, MintToChecked, SetAuthority, TokenAccount, TokenInterface,
};

declare_id!("CGgu8uUw5BzkQtCW4JqaXLmAhwsHAX8VNRkVC5vbp3Jr");

pub const CONFIG_SEED: &[u8] = b"dc-controller";
pub const MINTER_SEED: &[u8] = b"dc-minter";

#[program]
pub mod deal_dc_controller {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        require!(
            ctx.accounts.dc_mint.mint_authority
                == COption::Some(ctx.accounts.current_mint_authority.key()),
            DcControllerError::InvalidMintAuthority
        );

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.dc_mint = ctx.accounts.dc_mint.key();
        config.dc_token_program = ctx.accounts.dc_token_program.key();
        config.total_minted = 0;
        config.paused = true;
        config.bump = ctx.bumps.config;

        token_interface::set_authority(
            CpiContext::new(
                ctx.accounts.dc_token_program.key(),
                SetAuthority {
                    current_authority: ctx.accounts.current_mint_authority.to_account_info(),
                    account_or_mint: ctx.accounts.dc_mint.to_account_info(),
                },
            ),
            AuthorityType::MintTokens,
            Some(config.key()),
        )?;

        emit!(DcControllerInitialized {
            authority: config.authority,
            dc_mint: config.dc_mint,
            mint_authority: config.key(),
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.paused = paused;
        emit!(DcMintPauseUpdated { paused });
        Ok(())
    }

    pub fn set_minter(ctx: Context<SetMinter>, enabled: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            ctx.accounts.minter.key() != Pubkey::default(),
            DcControllerError::ZeroAddress
        );
        let grant = &mut ctx.accounts.grant;
        if grant.minter == Pubkey::default() {
            grant.minter = ctx.accounts.minter.key();
            grant.bump = ctx.bumps.grant;
        }
        require_keys_eq!(
            grant.minter,
            ctx.accounts.minter.key(),
            DcControllerError::InvalidMinterGrant
        );
        grant.enabled = enabled;
        emit!(DcMinterUpdated {
            minter: grant.minter,
            enabled,
        });
        Ok(())
    }

    pub fn mint(ctx: Context<MintDc>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, DcControllerError::Paused);
        require!(amount > 0, DcControllerError::ZeroAmount);
        require!(
            ctx.accounts.grant.enabled,
            DcControllerError::UnauthorizedMinter
        );
        require_keys_eq!(
            ctx.accounts.grant.minter,
            ctx.accounts.minter.key(),
            DcControllerError::UnauthorizedMinter
        );
        require_keys_eq!(
            ctx.accounts.destination.mint,
            ctx.accounts.dc_mint.key(),
            DcControllerError::InvalidDestination
        );

        let signer_seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
        token_interface::mint_to_checked(
            CpiContext::new_with_signer(
                ctx.accounts.dc_token_program.key(),
                MintToChecked {
                    mint: ctx.accounts.dc_mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
            ctx.accounts.dc_mint.decimals,
        )?;
        ctx.accounts.config.total_minted = ctx
            .accounts
            .config
            .total_minted
            .checked_add(u128::from(amount))
            .ok_or(DcControllerError::ArithmeticOverflow)?;
        emit!(DcMinted {
            minter: ctx.accounts.minter.key(),
            recipient: ctx.accounts.destination.owner,
            destination: ctx.accounts.destination.key(),
            amount,
            total_minted: ctx.accounts.config.total_minted,
        });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            DcControllerError::ZeroAddress
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(DcControllerAuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            DcControllerError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = Pubkey::default();
        emit!(DcControllerAuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority,
        });
        Ok(())
    }
}

fn assert_authority(config: &DcControllerConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        config.authority,
        authority.key(),
        DcControllerError::Unauthorized
    );
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    pub current_mint_authority: Signer<'info>,
    #[account(mut)]
    pub dc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = DcControllerConfig::SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, DcControllerConfig>,
    pub dc_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DcControllerConfig>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DcControllerConfig>,
}

#[derive(Accounts)]
pub struct SetMinter<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DcControllerConfig>,
    /// CHECK: Only the key is persisted as a role subject.
    pub minter: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = MinterGrant::SPACE,
        seeds = [MINTER_SEED, minter.key().as_ref()],
        bump
    )]
    pub grant: Account<'info, MinterGrant>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintDc<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DcControllerConfig>,
    pub minter: Signer<'info>,
    #[account(
        seeds = [MINTER_SEED, minter.key().as_ref()],
        bump = grant.bump
    )]
    pub grant: Account<'info, MinterGrant>,
    #[account(mut, address = config.dc_mint)]
    pub dc_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    #[account(address = config.dc_token_program)]
    pub dc_token_program: Interface<'info, TokenInterface>,
}

#[account]
pub struct DcControllerConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub dc_mint: Pubkey,
    pub dc_token_program: Pubkey,
    pub total_minted: u128,
    pub paused: bool,
    pub bump: u8,
}

impl DcControllerConfig {
    pub const SPACE: usize = 8 + (32 * 4) + 16 + 1 + 1;
}

#[account]
pub struct MinterGrant {
    pub minter: Pubkey,
    pub enabled: bool,
    pub bump: u8,
}

impl MinterGrant {
    pub const SPACE: usize = 8 + 32 + 1 + 1;
}

#[event]
pub struct DcControllerInitialized {
    pub authority: Pubkey,
    pub dc_mint: Pubkey,
    pub mint_authority: Pubkey,
}

#[event]
pub struct DcMintPauseUpdated {
    pub paused: bool,
}

#[event]
pub struct DcMinterUpdated {
    pub minter: Pubkey,
    pub enabled: bool,
}

#[event]
pub struct DcMinted {
    pub minter: Pubkey,
    pub recipient: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub total_minted: u128,
}

#[event]
pub struct DcControllerAuthorityProposed {
    pub pending_authority: Pubkey,
}

#[event]
pub struct DcControllerAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[error_code]
pub enum DcControllerError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("pending authority is invalid")]
    InvalidPendingAuthority,
    #[msg("current mint authority does not control DealCoin")]
    InvalidMintAuthority,
    #[msg("minter grant does not match the requested minter")]
    InvalidMinterGrant,
    #[msg("minter is not authorized")]
    UnauthorizedMinter,
    #[msg("DealCoin minting is paused")]
    Paused,
    #[msg("mint amount must be greater than zero")]
    ZeroAmount,
    #[msg("destination is not a DealCoin token account")]
    InvalidDestination,
    #[msg("arithmetic overflow")]
    ArithmeticOverflow,
}
