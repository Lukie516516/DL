#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;

declare_id!("3ZemYrD7Zbo7A2CDYfXd6zwBK7nGsAyJPSy5JwboSCub");

const REGISTRY_SEED: &[u8] = b"parameter-registry";
const MIN_TWAP_WINDOW_SEC: u32 = 60;
const MAX_TWAP_WINDOW_SEC: u32 = 86_400;

#[program]
pub mod deal_parameter_registry {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        governance_authority: Pubkey,
        message_price: u64,
        min_window_sec: u32,
    ) -> Result<()> {
        require!(
            governance_authority != Pubkey::default(),
            RegistryError::ZeroAuthority
        );
        validate_window(min_window_sec)?;
        let registry = &mut ctx.accounts.registry;
        registry.governance_authority = governance_authority;
        registry.message_price = message_price;
        registry.min_window_sec = min_window_sec;
        registry.bump = ctx.bumps.registry;
        emit!(RegistryInitialized {
            governance_authority,
            message_price,
            min_window_sec
        });
        Ok(())
    }

    pub fn set_message_price(ctx: Context<GovernedUpdate>, message_price: u64) -> Result<()> {
        assert_governance(&ctx.accounts.registry, &ctx.accounts.governance_authority)?;
        let old_value = ctx.accounts.registry.message_price;
        ctx.accounts.registry.message_price = message_price;
        emit!(MessagePriceUpdated {
            old_value,
            new_value: message_price
        });
        Ok(())
    }

    pub fn set_min_window_sec(ctx: Context<GovernedUpdate>, min_window_sec: u32) -> Result<()> {
        assert_governance(&ctx.accounts.registry, &ctx.accounts.governance_authority)?;
        validate_window(min_window_sec)?;
        let old_value = ctx.accounts.registry.min_window_sec;
        ctx.accounts.registry.min_window_sec = min_window_sec;
        emit!(MinWindowUpdated {
            old_value,
            new_value: min_window_sec
        });
        Ok(())
    }
}

fn assert_governance(registry: &ParameterRegistry, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        registry.governance_authority,
        authority.key(),
        RegistryError::Unauthorized
    );
    Ok(())
}

fn validate_window(min_window_sec: u32) -> Result<()> {
    require!(
        (MIN_TWAP_WINDOW_SEC..=MAX_TWAP_WINDOW_SEC).contains(&min_window_sec),
        RegistryError::InvalidWindow
    );
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = ParameterRegistry::SPACE, seeds = [REGISTRY_SEED], bump)]
    pub registry: Account<'info, ParameterRegistry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GovernedUpdate<'info> {
    pub governance_authority: Signer<'info>,
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, ParameterRegistry>,
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
pub struct RegistryInitialized {
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

#[error_code]
pub enum RegistryError {
    #[msg("governance authority cannot be zero")]
    ZeroAuthority,
    #[msg("caller is not the governance authority")]
    Unauthorized,
    #[msg("TWAP window must be between 60 seconds and 24 hours")]
    InvalidWindow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn twap_window_bounds_are_enforced() {
        assert!(validate_window(59).is_err());
        assert!(validate_window(60).is_ok());
        assert!(validate_window(86_400).is_ok());
        assert!(validate_window(86_401).is_err());
    }
}
