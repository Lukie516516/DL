#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;

declare_id!("3gsSk16h3xrxDHg5u8SZQek11WcTCLw9Zs6HUeaNBf5S");

pub const REGISTRY_SEED: &[u8] = b"swap-asset-registry";

#[program]
pub mod deal_swap_asset_registry {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        ctx: Context<Initialize>,
        pair_program: Pubkey,
        router_program: Pubkey,
        dc_mint: Pubkey,
        wrapped_native_mint: Pubkey,
        stable0_mint: Pubkey,
        stable1_mint: Pubkey,
    ) -> Result<()> {
        validate_assets(
            pair_program,
            router_program,
            dc_mint,
            wrapped_native_mint,
            stable0_mint,
            stable1_mint,
        )?;

        let registry = &mut ctx.accounts.registry;
        registry.authority = ctx.accounts.authority.key();
        registry.pending_authority = Pubkey::default();
        registry.bump = ctx.bumps.registry;
        registry.revision = 1;
        set_assets(
            registry,
            pair_program,
            router_program,
            dc_mint,
            wrapped_native_mint,
            stable0_mint,
            stable1_mint,
        );
        emit_registry_updated(registry);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_swap_assets(
        ctx: Context<AdminRegistry>,
        pair_program: Pubkey,
        router_program: Pubkey,
        dc_mint: Pubkey,
        wrapped_native_mint: Pubkey,
        stable0_mint: Pubkey,
        stable1_mint: Pubkey,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.registry, &ctx.accounts.authority)?;
        validate_assets(
            pair_program,
            router_program,
            dc_mint,
            wrapped_native_mint,
            stable0_mint,
            stable1_mint,
        )?;

        let registry = &mut ctx.accounts.registry;
        registry.revision = registry
            .revision
            .checked_add(1)
            .ok_or(RegistryError::ArithmeticOverflow)?;
        set_assets(
            registry,
            pair_program,
            router_program,
            dc_mint,
            wrapped_native_mint,
            stable0_mint,
            stable1_mint,
        );
        emit_registry_updated(registry);
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminRegistry>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.registry, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            RegistryError::ZeroAddress
        );
        ctx.accounts.registry.pending_authority = pending_authority;
        emit!(RegistryAuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.registry.pending_authority,
            ctx.accounts.pending_authority.key(),
            RegistryError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.registry.authority;
        ctx.accounts.registry.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.registry.pending_authority = Pubkey::default();
        emit!(RegistryAuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.registry.authority,
        });
        Ok(())
    }
}

fn assert_authority(registry: &SwapAssetRegistry, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        registry.authority,
        authority.key(),
        RegistryError::Unauthorized
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_assets(
    pair_program: Pubkey,
    router_program: Pubkey,
    dc_mint: Pubkey,
    wrapped_native_mint: Pubkey,
    stable0_mint: Pubkey,
    stable1_mint: Pubkey,
) -> Result<()> {
    for key in [
        pair_program,
        router_program,
        dc_mint,
        wrapped_native_mint,
        stable0_mint,
        stable1_mint,
    ] {
        require!(key != Pubkey::default(), RegistryError::ZeroAddress);
    }
    // Pair and Router are distinct programs in the legacy topology. In the
    // audited compact topology both modules intentionally share this root ID.
    // Equality is accepted only when both values equal their compiled module IDs;
    // arbitrary duplicate addresses remain rejected.
    require!(
        pair_program != router_program
            || (pair_program == deal_dex_pair::ID && router_program == crate::ID),
        RegistryError::DuplicateCore
    );
    require!(
        dc_mint != wrapped_native_mint
            && dc_mint != stable0_mint
            && dc_mint != stable1_mint
            && wrapped_native_mint != stable0_mint
            && wrapped_native_mint != stable1_mint
            && stable0_mint != stable1_mint,
        RegistryError::DuplicateMint
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn set_assets(
    registry: &mut SwapAssetRegistry,
    pair_program: Pubkey,
    router_program: Pubkey,
    dc_mint: Pubkey,
    wrapped_native_mint: Pubkey,
    stable0_mint: Pubkey,
    stable1_mint: Pubkey,
) {
    registry.pair_program = pair_program;
    registry.router_program = router_program;
    registry.dc_mint = dc_mint;
    registry.wrapped_native_mint = wrapped_native_mint;
    registry.stable0_mint = stable0_mint;
    registry.stable1_mint = stable1_mint;
    registry.wrapped_native_pair = derive_pair(pair_program, wrapped_native_mint);
    registry.stable0_pair = derive_pair(pair_program, stable0_mint);
    registry.stable1_pair = derive_pair(pair_program, stable1_mint);
}

fn derive_pair(pair_program: Pubkey, other_mint: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[deal_dex_pair::PAIR_SEED, other_mint.as_ref()],
        &pair_program,
    )
    .0
}

fn emit_registry_updated(registry: &SwapAssetRegistry) {
    emit!(SwapAssetsUpdated {
        revision: registry.revision,
        pair_program: registry.pair_program,
        router_program: registry.router_program,
        dc_mint: registry.dc_mint,
        wrapped_native_mint: registry.wrapped_native_mint,
        stable0_mint: registry.stable0_mint,
        stable1_mint: registry.stable1_mint,
        wrapped_native_pair: registry.wrapped_native_pair,
        stable0_pair: registry.stable0_pair,
        stable1_pair: registry.stable1_pair,
    });
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = SwapAssetRegistry::SPACE,
        seeds = [REGISTRY_SEED],
        bump
    )]
    pub registry: Account<'info, SwapAssetRegistry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminRegistry<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, SwapAssetRegistry>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, SwapAssetRegistry>,
}

#[account]
pub struct SwapAssetRegistry {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub pair_program: Pubkey,
    pub router_program: Pubkey,
    pub dc_mint: Pubkey,
    pub wrapped_native_mint: Pubkey,
    pub stable0_mint: Pubkey,
    pub stable1_mint: Pubkey,
    pub wrapped_native_pair: Pubkey,
    pub stable0_pair: Pubkey,
    pub stable1_pair: Pubkey,
    pub revision: u64,
    pub bump: u8,
}

impl SwapAssetRegistry {
    pub const SPACE: usize = 8 + (32 * 11) + 8 + 1;

    pub fn pair_for_official_mint(&self, mint: Pubkey) -> Option<Pubkey> {
        if mint == self.wrapped_native_mint {
            Some(self.wrapped_native_pair)
        } else if mint == self.stable0_mint {
            Some(self.stable0_pair)
        } else if mint == self.stable1_mint {
            Some(self.stable1_pair)
        } else {
            None
        }
    }

    pub fn is_recognized_or_dc(&self, mint: Pubkey) -> bool {
        mint == self.dc_mint || self.pair_for_official_mint(mint).is_some()
    }
}

#[event]
pub struct SwapAssetsUpdated {
    pub revision: u64,
    pub pair_program: Pubkey,
    pub router_program: Pubkey,
    pub dc_mint: Pubkey,
    pub wrapped_native_mint: Pubkey,
    pub stable0_mint: Pubkey,
    pub stable1_mint: Pubkey,
    pub wrapped_native_pair: Pubkey,
    pub stable0_pair: Pubkey,
    pub stable1_pair: Pubkey,
}

#[event]
pub struct RegistryAuthorityProposed {
    pub pending_authority: Pubkey,
}

#[event]
pub struct RegistryAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[error_code(offset = 6300)]
pub enum RegistryError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("pair and router programs must be different")]
    DuplicateCore,
    #[msg("official mints must be distinct")]
    DuplicateMint,
    #[msg("caller is not the registry authority")]
    Unauthorized,
    #[msg("caller is not the pending authority")]
    InvalidPendingAuthority,
    #[msg("registry revision overflow")]
    ArithmeticOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_keys() -> [Pubkey; 6] {
        [
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        ]
    }

    #[test]
    fn rejects_zero_and_duplicate_configuration() {
        let [pair, router, dc, native, stable0, stable1] = fixture_keys();
        assert!(validate_assets(pair, router, dc, native, stable0, stable1).is_ok());
        assert!(validate_assets(Pubkey::default(), router, dc, native, stable0, stable1).is_err());
        assert!(validate_assets(pair, pair, dc, native, stable0, stable1).is_err());
        assert!(validate_assets(pair, router, dc, dc, stable0, stable1).is_err());
        assert!(validate_assets(pair, router, dc, native, stable0, stable0).is_err());
    }

    #[test]
    fn accepts_only_the_compiled_composed_exchange_identity() {
        let [_, _, dc, native, stable0, stable1] = fixture_keys();
        assert!(
            validate_assets(deal_dex_pair::ID, crate::ID, dc, native, stable0, stable1,).is_ok()
        );
        let arbitrary = Pubkey::new_unique();
        assert!(validate_assets(arbitrary, arbitrary, dc, native, stable0, stable1,).is_err());
    }

    #[test]
    fn pair_derivation_matches_pair_program_seed() {
        let pair_program = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let expected =
            Pubkey::find_program_address(&[deal_dex_pair::PAIR_SEED, mint.as_ref()], &pair_program)
                .0;
        assert_eq!(derive_pair(pair_program, mint), expected);
    }
}
