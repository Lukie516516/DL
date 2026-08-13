use anchor_lang::prelude::*;

use crate::errors::AssetControllerError;

const DC_TO_DC_FEE_NUMERATOR: u128 = 1;
const DC_TO_DC_FEE_DENOMINATOR: u128 = 1_000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum AssetKind {
    None,
    Native,
    Spl,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct AssetSpec {
    pub kind: AssetKind,
    pub mint: Pubkey,
    pub vault: Pubkey,
}

impl AssetSpec {
    pub fn none() -> Self {
        Self {
            kind: AssetKind::None,
            mint: Pubkey::default(),
            vault: Pubkey::default(),
        }
    }

    pub fn validate_for_amount(&self, amount: u64) -> Result<()> {
        match (amount, self.kind) {
            (0, AssetKind::None) => {
                require!(
                    self.mint == Pubkey::default() && self.vault == Pubkey::default(),
                    AssetControllerError::InvalidAssetSpec
                );
            }
            (0, _) | (_, AssetKind::None) => {
                return err!(AssetControllerError::InvalidAssetSpec);
            }
            (_, AssetKind::Native) => {
                require!(
                    self.mint == Pubkey::default() && self.vault == Pubkey::default(),
                    AssetControllerError::InvalidAssetSpec
                );
            }
            (_, AssetKind::Spl) => {
                require!(
                    self.mint != Pubkey::default() && self.vault != Pubkey::default(),
                    AssetControllerError::InvalidAssetSpec
                );
            }
        }
        Ok(())
    }

    pub fn validate_nft(&self, required: bool) -> Result<()> {
        if required {
            require!(
                self.kind == AssetKind::Spl
                    && self.mint != Pubkey::default()
                    && self.vault != Pubkey::default(),
                AssetControllerError::InvalidNftSpec
            );
        } else {
            require!(*self == Self::none(), AssetControllerError::InvalidNftSpec);
        }
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ConfigureTermsParams {
    pub a_swap: AssetSpec,
    pub a_margin: AssetSpec,
    pub b_swap: AssetSpec,
    pub b_margin: AssetSpec,
    pub a_asset_nft: AssetSpec,
    pub b_asset_nft: AssetSpec,
}

#[account]
pub struct ControllerConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub treasury: Pubkey,
    pub dc_mint: Pubkey,
    pub fee_numerator: u32,
    pub fee_denominator: u32,
    pub terminal_guard_enabled: bool,
    pub paused: bool,
    pub bump: u8,
}

impl ControllerConfig {
    pub const SPACE: usize = 8 + (32 * 4) + 4 + 4 + 1 + 1 + 1;

    pub fn validate_fee(numerator: u32, denominator: u32) -> Result<()> {
        require!(
            denominator > 0 && numerator < denominator,
            AssetControllerError::InvalidFee
        );
        Ok(())
    }

    pub fn fee_for(&self, spec: AssetSpec, amount: u64) -> Result<u64> {
        if amount == 0 || (spec.kind == AssetKind::Spl && spec.mint == self.dc_mint) {
            return Ok(0);
        }
        let fee = (amount as u128)
            .checked_mul(self.fee_numerator as u128)
            .ok_or_else(|| error!(AssetControllerError::MathOverflow))?
            / self.fee_denominator as u128;
        u64::try_from(fee).map_err(|_| error!(AssetControllerError::MathOverflow))
    }

    pub fn swap_fees(
        &self,
        a_spec: AssetSpec,
        a_amount: u64,
        b_spec: AssetSpec,
        b_amount: u64,
    ) -> Result<(u64, u64)> {
        if a_amount > 0
            && b_amount > 0
            && a_spec.kind == AssetKind::Spl
            && b_spec.kind == AssetKind::Spl
            && a_spec.mint == self.dc_mint
            && b_spec.mint == self.dc_mint
        {
            return Ok((dc_to_dc_fee(a_amount)?, dc_to_dc_fee(b_amount)?));
        }
        Ok((
            self.fee_for(a_spec, a_amount)?,
            self.fee_for(b_spec, b_amount)?,
        ))
    }
}

fn dc_to_dc_fee(amount: u64) -> Result<u64> {
    let fee = (amount as u128)
        .checked_mul(DC_TO_DC_FEE_NUMERATOR)
        .ok_or_else(|| error!(AssetControllerError::MathOverflow))?
        / DC_TO_DC_FEE_DENOMINATOR;
    u64::try_from(fee).map_err(|_| error!(AssetControllerError::MathOverflow))
}

#[account]
pub struct AssetTerms {
    pub deal: Pubkey,
    pub creator: Pubkey,
    pub a_swap: AssetSpec,
    pub a_margin: AssetSpec,
    pub b_swap: AssetSpec,
    pub b_margin: AssetSpec,
    pub a_asset_nft: AssetSpec,
    pub b_asset_nft: AssetSpec,
    pub b_depositor: Pubkey,
    pub a_identity_mint: Pubkey,
    pub b_identity_mint: Pubkey,
    pub a_funds_escrowed: bool,
    pub b_funds_escrowed: bool,
    pub a_nft_escrowed: bool,
    pub b_nft_escrowed: bool,
    pub resolved: bool,
    pub dc_fees_routed: bool,
    pub a_fee_paid: u64,
    pub b_fee_paid: u64,
    pub bump: u8,
}

impl AssetTerms {
    pub const SPACE: usize = 8 + 704;

    pub fn initialize(
        &mut self,
        deal: Pubkey,
        creator: Pubkey,
        bump: u8,
        params: ConfigureTermsParams,
    ) {
        self.deal = deal;
        self.creator = creator;
        self.a_swap = params.a_swap;
        self.a_margin = params.a_margin;
        self.b_swap = params.b_swap;
        self.b_margin = params.b_margin;
        self.a_asset_nft = params.a_asset_nft;
        self.b_asset_nft = params.b_asset_nft;
        self.b_depositor = Pubkey::default();
        self.a_identity_mint = Pubkey::default();
        self.b_identity_mint = Pubkey::default();
        self.a_funds_escrowed = false;
        self.b_funds_escrowed = false;
        self.a_nft_escrowed = false;
        self.b_nft_escrowed = false;
        self.resolved = false;
        self.dc_fees_routed = false;
        self.a_fee_paid = 0;
        self.b_fee_paid = 0;
        self.bump = bump;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spl(mint: u8, vault: u8) -> AssetSpec {
        AssetSpec {
            kind: AssetKind::Spl,
            mint: Pubkey::new_from_array([mint; 32]),
            vault: Pubkey::new_from_array([vault; 32]),
        }
    }

    #[test]
    fn asset_shapes_reject_ambiguous_zero_and_native_metadata() {
        assert!(AssetSpec::none().validate_for_amount(0).is_ok());
        assert!(AssetSpec::none().validate_for_amount(1).is_err());
        assert!(spl(1, 2).validate_for_amount(0).is_err());
        assert!(spl(1, 2).validate_for_amount(1).is_ok());
        let invalid_native = AssetSpec {
            kind: AssetKind::Native,
            mint: Pubkey::new_unique(),
            vault: Pubkey::default(),
        };
        assert!(invalid_native.validate_for_amount(1).is_err());
    }

    #[test]
    fn fee_matches_evm_rounding_and_dc_is_fee_free() {
        let dc_mint = Pubkey::new_unique();
        let config = ControllerConfig {
            authority: Pubkey::new_unique(),
            pending_authority: Pubkey::default(),
            treasury: Pubkey::new_unique(),
            dc_mint,
            fee_numerator: 3,
            fee_denominator: 1_000,
            terminal_guard_enabled: false,
            paused: false,
            bump: 255,
        };
        assert_eq!(config.fee_for(spl(1, 2), 10_000).unwrap(), 30);
        assert_eq!(config.fee_for(spl(1, 2), 1).unwrap(), 0);
        assert_eq!(
            config
                .fee_for(
                    AssetSpec {
                        kind: AssetKind::Spl,
                        mint: dc_mint,
                        vault: Pubkey::new_unique(),
                    },
                    10_000,
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn dc_to_dc_charges_the_evm_special_fee_on_both_sides() {
        let dc_mint = Pubkey::new_unique();
        let config = ControllerConfig {
            authority: Pubkey::new_unique(),
            pending_authority: Pubkey::default(),
            treasury: Pubkey::new_unique(),
            dc_mint,
            fee_numerator: 3,
            fee_denominator: 1_000,
            terminal_guard_enabled: false,
            paused: false,
            bump: 255,
        };
        let dc = AssetSpec {
            kind: AssetKind::Spl,
            mint: dc_mint,
            vault: Pubkey::new_unique(),
        };
        assert_eq!(config.swap_fees(dc, 10_000, dc, 20_000).unwrap(), (10, 20));
        assert_eq!(config.swap_fees(dc, 999, dc, 999).unwrap(), (0, 0));
        assert_eq!(
            config.swap_fees(dc, 10_000, spl(1, 2), 10_000).unwrap(),
            (0, 30)
        );
    }

    #[test]
    fn amount_vectors_match_evm_fee_rounding_for_512_cases() {
        let dc_mint = Pubkey::new_unique();
        let config = ControllerConfig {
            authority: Pubkey::new_unique(),
            pending_authority: Pubkey::default(),
            treasury: Pubkey::new_unique(),
            dc_mint,
            fee_numerator: 3,
            fee_denominator: 1_000,
            terminal_guard_enabled: false,
            paused: false,
            bump: 255,
        };
        let token = spl(1, 2);
        let dc = AssetSpec {
            kind: AssetKind::Spl,
            mint: dc_mint,
            vault: Pubkey::new_unique(),
        };
        let mut seed = 0x4d59_5df4_d0f3_3173u64;

        for _ in 0..512 {
            seed = seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let amount = seed.max(1);
            let expected_protocol_fee = ((amount as u128) * 3 / 1_000) as u64;
            let expected_dc_fee = ((amount as u128) / 1_000) as u64;

            let protocol_fee = config.fee_for(token, amount).unwrap();
            assert_eq!(protocol_fee, expected_protocol_fee);
            assert_eq!(amount - protocol_fee + protocol_fee, amount);
            assert_eq!(config.fee_for(dc, amount).unwrap(), 0);
            assert_eq!(
                config.swap_fees(dc, amount, dc, amount).unwrap(),
                (expected_dc_fee, expected_dc_fee)
            );
        }
    }
}
