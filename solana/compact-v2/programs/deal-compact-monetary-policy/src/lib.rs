#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token_interface::spl_token_2022::instruction::AuthorityType;
use anchor_spl::token_interface::{
    self, Mint, MintToChecked, SetAuthority, TokenAccount, TokenInterface,
};

declare_id!("2M17xcuJPMNfuU9HenXrL4N9rwDMaCVhrGYixGfgBMTn");

pub const CONFIG_SEED: &[u8] = b"dc-controller";
pub const MINTER_SEED: &[u8] = b"dc-minter";
pub const PARAMETER_REGISTRY_SEED: &[u8] = b"parameter-registry";
pub const MIN_TWAP_WINDOW_SEC: u32 = 60;
pub const MAX_TWAP_WINDOW_SEC: u32 = 86_400;

#[program]
pub mod deal_compact_monetary_policy {
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

    pub fn initialize_parameters(
        ctx: Context<InitializeParameters>,
        governance_authority: Pubkey,
        message_price: u64,
        min_window_sec: u32,
    ) -> Result<()> {
        require!(
            governance_authority != Pubkey::default(),
            ParameterRegistryError::ZeroAuthority
        );
        validate_parameter_window(min_window_sec)?;
        let registry = &mut ctx.accounts.parameter_registry;
        registry.governance_authority = governance_authority;
        registry.message_price = message_price;
        registry.min_window_sec = min_window_sec;
        registry.bump = ctx.bumps.parameter_registry;
        emit!(ParameterRegistryInitialized {
            governance_authority,
            message_price,
            min_window_sec,
        });
        Ok(())
    }

    pub fn set_message_price(
        ctx: Context<GovernedParameterUpdate>,
        message_price: u64,
    ) -> Result<()> {
        assert_parameter_governance(
            &ctx.accounts.parameter_registry,
            &ctx.accounts.governance_authority,
        )?;
        let old_value = ctx.accounts.parameter_registry.message_price;
        ctx.accounts.parameter_registry.message_price = message_price;
        emit!(MessagePriceUpdated {
            old_value,
            new_value: message_price,
        });
        Ok(())
    }

    pub fn set_min_window_sec(
        ctx: Context<GovernedParameterUpdate>,
        min_window_sec: u32,
    ) -> Result<()> {
        assert_parameter_governance(
            &ctx.accounts.parameter_registry,
            &ctx.accounts.governance_authority,
        )?;
        validate_parameter_window(min_window_sec)?;
        let old_value = ctx.accounts.parameter_registry.min_window_sec;
        ctx.accounts.parameter_registry.min_window_sec = min_window_sec;
        emit!(MinWindowUpdated {
            old_value,
            new_value: min_window_sec,
        });
        Ok(())
    }
}

fn assert_parameter_governance(registry: &ParameterRegistry, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        registry.governance_authority,
        authority.key(),
        ParameterRegistryError::Unauthorized
    );
    Ok(())
}

fn validate_parameter_window(min_window_sec: u32) -> Result<()> {
    require!(
        (MIN_TWAP_WINDOW_SEC..=MAX_TWAP_WINDOW_SEC).contains(&min_window_sec),
        ParameterRegistryError::InvalidWindow
    );
    Ok(())
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
pub struct InitializeParameters<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = ParameterRegistry::SPACE,
        seeds = [PARAMETER_REGISTRY_SEED],
        bump
    )]
    pub parameter_registry: Account<'info, ParameterRegistry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GovernedParameterUpdate<'info> {
    pub governance_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [PARAMETER_REGISTRY_SEED],
        bump = parameter_registry.bump
    )]
    pub parameter_registry: Account<'info, ParameterRegistry>,
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

#[account]
pub struct ParameterRegistry {
    pub governance_authority: Pubkey,
    pub message_price: u64,
    pub min_window_sec: u32,
    pub bump: u8,
}

impl ParameterRegistry {
    pub const SPACE: usize = 8 + 32 + 8 + 4 + 1;
}

#[event]
pub struct ParameterRegistryInitialized {
    pub governance_authority: Pubkey,
    pub message_price: u64,
    pub min_window_sec: u32,
}

#[event]
pub struct MessagePriceUpdated {
    pub old_value: u64,
    pub new_value: u64,
}

#[event]
pub struct MinWindowUpdated {
    pub old_value: u32,
    pub new_value: u32,
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

// Reserve 6100-6199 for the parameter-registry namespace so its errors cannot
// collide with the DC-controller namespace at Anchor's default 6000 range.
#[error_code(offset = 6100)]
pub enum ParameterRegistryError {
    #[msg("governance authority cannot be zero")]
    ZeroAuthority,
    #[msg("caller is not the governance authority")]
    Unauthorized,
    #[msg("TWAP window must be between 60 seconds and 24 hours")]
    InvalidWindow,
}

#[cfg(test)]
mod compact_tests {
    use super::*;

    #[test]
    fn parameter_window_matches_legacy_bounds() {
        assert!(validate_parameter_window(59).is_err());
        assert!(validate_parameter_window(60).is_ok());
        assert!(validate_parameter_window(86_400).is_ok());
        assert!(validate_parameter_window(86_401).is_err());
    }
}
