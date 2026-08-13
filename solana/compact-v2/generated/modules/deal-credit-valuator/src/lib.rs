#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use deal_asset_controller::state::{AssetKind, AssetSpec, AssetTerms, ControllerConfig};
use deal_core::state::{DealAccount, DealStatus};
use deal_dex_pair::PairState;
use deal_swap_asset_registry::SwapAssetRegistry;
use deal_terminal_guard::{validate_current_and_following, ExpectedInstruction};

declare_id!("7m8WXGUfwnuyxi2GmzNepfkrXgsCAurTKvANSdPqZXzG");

pub const VALUATION_SEED: &[u8] = b"credit-valuation";
const REWARD_ENGINE_PROGRAM_ID: Pubkey = pubkey!("7m8WXGUfwnuyxi2GmzNepfkrXgsCAurTKvANSdPqZXzG");
const VALUE_COMPLETED_DEAL_DISC: [u8; 8] = [0x6f, 0xa3, 0xa0, 0xe7, 0xcd, 0x08, 0xbd, 0x4a];
const PREPARE_COMPLETED_REWARDS_DISC: [u8; 8] = [0x9b, 0x0d, 0x71, 0x1e, 0x88, 0xf9, 0xa9, 0xbf];

#[program]
pub mod deal_credit_valuator {
    use super::*;

    pub fn value_completed_deal(ctx: Context<ValueCompletedDeal>) -> Result<()> {
        require!(
            ctx.accounts.deal.status == DealStatus::Completed,
            ValuationError::DealNotCompleted
        );
        require!(
            ctx.accounts.terms.resolved,
            ValuationError::TermsNotResolved
        );
        require_keys_eq!(
            ctx.accounts.terms.deal,
            ctx.accounts.deal.key(),
            ValuationError::InvalidTerms
        );
        require!(
            ctx.accounts.deal.ended_at > 0,
            ValuationError::MissingEndTime
        );
        require_keys_eq!(
            ctx.accounts.stable0_mint.key(),
            ctx.accounts.registry.stable0_mint,
            ValuationError::InvalidStableMint
        );
        require_keys_eq!(
            ctx.accounts.stable1_mint.key(),
            ctx.accounts.registry.stable1_mint,
            ValuationError::InvalidStableMint
        );

        let pair_accounts = PairAccounts {
            wrapped_native: &ctx.accounts.wrapped_native_pair,
            stable0: &ctx.accounts.stable0_pair,
            stable1: &ctx.accounts.stable1_pair,
        };
        let mint_decimals = StableDecimals {
            stable0: ctx.accounts.stable0_mint.decimals,
            stable1: ctx.accounts.stable1_mint.decimals,
        };
        let a_credit_u = fee_credit_u(
            &ctx.accounts.registry,
            &pair_accounts,
            mint_decimals,
            ctx.accounts.terms.a_swap,
            ctx.accounts.terms.a_fee_paid,
        )?;
        let b_credit_u = fee_credit_u(
            &ctx.accounts.registry,
            &pair_accounts,
            mint_decimals,
            ctx.accounts.terms.b_swap,
            ctx.accounts.terms.b_fee_paid,
        )?;
        let base_credit_u = a_credit_u
            .checked_add(b_credit_u)
            .ok_or(ValuationError::ArithmeticOverflow)?;
        let valued_at = Clock::get()?.unix_timestamp;

        let receipt = &mut ctx.accounts.receipt;
        receipt.deal = ctx.accounts.deal.key();
        receipt.registry_revision = ctx.accounts.registry.revision;
        receipt.a_fee_paid = ctx.accounts.terms.a_fee_paid;
        receipt.b_fee_paid = ctx.accounts.terms.b_fee_paid;
        receipt.a_credit_u = a_credit_u;
        receipt.b_credit_u = b_credit_u;
        receipt.base_credit_u = base_credit_u;
        receipt.ended_at = ctx.accounts.deal.ended_at;
        receipt.valued_at = valued_at;
        receipt.bump = ctx.bumps.receipt;

        emit!(DealFeeValued {
            deal: receipt.deal,
            registry_revision: receipt.registry_revision,
            a_fee_paid: receipt.a_fee_paid,
            b_fee_paid: receipt.b_fee_paid,
            a_credit_u,
            b_credit_u,
            base_credit_u,
            valued_at,
        });
        if ctx.accounts.asset_config.terminal_guard_enabled {
            let following = [ExpectedInstruction::anchor(
                REWARD_ENGINE_PROGRAM_ID,
                PREPARE_COMPLETED_REWARDS_DISC,
            )
            .account(2, ctx.accounts.deal.key())];
            validate_current_and_following(
                &ctx.accounts.instructions_sysvar.to_account_info(),
                crate::ID,
                VALUE_COMPLETED_DEAL_DISC,
                &following,
            )?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
struct StableDecimals {
    stable0: u8,
    stable1: u8,
}

struct PairAccounts<'a, 'info> {
    wrapped_native: &'a UncheckedAccount<'info>,
    stable0: &'a UncheckedAccount<'info>,
    stable1: &'a UncheckedAccount<'info>,
}

fn fee_credit_u(
    registry: &SwapAssetRegistry,
    pair_accounts: &PairAccounts<'_, '_>,
    decimals: StableDecimals,
    asset: AssetSpec,
    fee: u64,
) -> Result<u128> {
    if fee == 0 || asset.kind == AssetKind::None {
        return Ok(0);
    }
    if asset.kind == AssetKind::Native {
        return native_to_u(registry, pair_accounts, decimals, fee);
    }
    if asset.kind != AssetKind::Spl {
        return Ok(0);
    }
    if asset.mint == registry.stable0_mint {
        return to_u18(fee, decimals.stable0);
    }
    if asset.mint == registry.stable1_mint {
        return to_u18(fee, decimals.stable1);
    }
    if asset.mint == registry.dc_mint {
        return dc_to_u(registry, pair_accounts, decimals, fee as u128);
    }
    if asset.mint == registry.wrapped_native_mint {
        return native_to_u(registry, pair_accounts, decimals, fee);
    }
    Ok(0)
}

fn native_to_u(
    registry: &SwapAssetRegistry,
    pair_accounts: &PairAccounts<'_, '_>,
    decimals: StableDecimals,
    native_amount: u64,
) -> Result<u128> {
    let Some(pair) = load_pair(
        pair_accounts.wrapped_native,
        registry.wrapped_native_pair,
        registry,
        registry.wrapped_native_mint,
    )?
    else {
        return Ok(0);
    };
    let dc_value = token1_to_token0(&pair, native_amount as u128)?;
    dc_to_u(registry, pair_accounts, decimals, dc_value)
}

fn dc_to_u(
    registry: &SwapAssetRegistry,
    pair_accounts: &PairAccounts<'_, '_>,
    decimals: StableDecimals,
    dc_amount: u128,
) -> Result<u128> {
    if dc_amount == 0 {
        return Ok(0);
    }
    if let Some(pair) = load_pair(
        pair_accounts.stable1,
        registry.stable1_pair,
        registry,
        registry.stable1_mint,
    )? {
        let stable_value = token0_to_token1(&pair, dc_amount)?;
        let u_value = to_u18_u128(stable_value, decimals.stable1)?;
        if u_value != 0 {
            return Ok(u_value);
        }
    }
    if let Some(pair) = load_pair(
        pair_accounts.stable0,
        registry.stable0_pair,
        registry,
        registry.stable0_mint,
    )? {
        return to_u18_u128(token0_to_token1(&pair, dc_amount)?, decimals.stable0);
    }
    Ok(0)
}

fn load_pair(
    account: &UncheckedAccount<'_>,
    expected_key: Pubkey,
    registry: &SwapAssetRegistry,
    expected_other_mint: Pubkey,
) -> Result<Option<PairState>> {
    if account.key() != expected_key {
        return Ok(None);
    }
    require_keys_eq!(
        *account.owner,
        registry.pair_program,
        ValuationError::InvalidPairOwner
    );
    let data = account.try_borrow_data()?;
    let pair = PairState::try_deserialize(&mut data.as_ref())
        .map_err(|_| error!(ValuationError::InvalidPairData))?;
    require_keys_eq!(pair.dc_mint, registry.dc_mint, ValuationError::InvalidPair);
    require_keys_eq!(
        pair.other_mint,
        expected_other_mint,
        ValuationError::InvalidPair
    );
    if !pair.liquidity_initialized {
        return Ok(None);
    }
    Ok(Some(pair))
}

fn effective_reserves(pair: &PairState) -> Result<(u128, u128)> {
    let reserve0 = (pair.reserve0 as u128)
        .checked_add(pair.virtual_reserve0 as u128)
        .ok_or(ValuationError::ArithmeticOverflow)?;
    let reserve1 = (pair.reserve1 as u128)
        .checked_add(pair.virtual_reserve1 as u128)
        .ok_or(ValuationError::ArithmeticOverflow)?;
    Ok((reserve0, reserve1))
}

fn token0_to_token1(pair: &PairState, amount0: u128) -> Result<u128> {
    let (reserve0, reserve1) = effective_reserves(pair)?;
    if reserve0 == 0 || reserve1 == 0 || amount0 == 0 {
        return Ok(0);
    }
    amount0
        .checked_mul(reserve1)
        .ok_or_else(|| error!(ValuationError::ArithmeticOverflow))?
        .checked_div(reserve0)
        .ok_or_else(|| error!(ValuationError::ArithmeticOverflow))
}

fn token1_to_token0(pair: &PairState, amount1: u128) -> Result<u128> {
    let (reserve0, reserve1) = effective_reserves(pair)?;
    if reserve0 == 0 || reserve1 == 0 || amount1 == 0 {
        return Ok(0);
    }
    amount1
        .checked_mul(reserve0)
        .ok_or_else(|| error!(ValuationError::ArithmeticOverflow))?
        .checked_div(reserve1)
        .ok_or_else(|| error!(ValuationError::ArithmeticOverflow))
}

fn to_u18(amount: u64, decimals: u8) -> Result<u128> {
    to_u18_u128(amount as u128, decimals)
}

fn to_u18_u128(amount: u128, decimals: u8) -> Result<u128> {
    if decimals == 18 {
        return Ok(amount);
    }
    if decimals < 18 {
        return amount
            .checked_mul(pow10(18 - decimals)?)
            .ok_or_else(|| error!(ValuationError::ArithmeticOverflow));
    }
    if decimals <= 36 {
        return Ok(amount / pow10(decimals - 18)?);
    }
    Ok(0)
}

fn pow10(exponent: u8) -> Result<u128> {
    10u128
        .checked_pow(exponent as u32)
        .ok_or_else(|| error!(ValuationError::ArithmeticOverflow))
}

#[derive(Accounts)]
pub struct ValueCompletedDeal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub deal: Box<Account<'info, DealAccount>>,
    #[account(
        seeds = [deal_asset_controller::TERMS_SEED, deal.key().as_ref()],
        bump = terms.bump,
        seeds::program = deal_asset_controller::ID
    )]
    pub terms: Box<Account<'info, AssetTerms>>,
    #[account(
        seeds = [deal_swap_asset_registry::REGISTRY_SEED],
        bump = registry.bump,
        seeds::program = deal_swap_asset_registry::ID
    )]
    pub registry: Box<Account<'info, SwapAssetRegistry>>,
    #[account(address = registry.stable0_mint)]
    pub stable0_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = registry.stable1_mint)]
    pub stable1_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: Validated against the registry and deserialized only when native value is needed.
    pub wrapped_native_pair: UncheckedAccount<'info>,
    /// CHECK: Validated against the registry and deserialized only when the fallback stable route is needed.
    pub stable0_pair: UncheckedAccount<'info>,
    /// CHECK: Validated against the registry and deserialized only when the preferred stable route is needed.
    pub stable1_pair: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = CreditValuationReceipt::SPACE,
        seeds = [VALUATION_SEED, deal.key().as_ref()],
        bump
    )]
    pub receipt: Box<Account<'info, CreditValuationReceipt>>,
    pub system_program: Program<'info, System>,
    #[account(
        seeds = [deal_asset_controller::CONTROLLER_SEED],
        bump = asset_config.bump,
        seeds::program = deal_asset_controller::ID
    )]
    pub asset_config: Box<Account<'info, ControllerConfig>>,
    /// CHECK: Address-constrained Solana Instructions sysvar used by the terminal guard.
    #[account(address = deal_terminal_guard::instructions_sysvar_id())]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[account]
pub struct CreditValuationReceipt {
    pub deal: Pubkey,
    pub registry_revision: u64,
    pub a_fee_paid: u64,
    pub b_fee_paid: u64,
    pub a_credit_u: u128,
    pub b_credit_u: u128,
    pub base_credit_u: u128,
    pub ended_at: i64,
    pub valued_at: i64,
    pub bump: u8,
}

impl CreditValuationReceipt {
    pub const SPACE: usize = 8 + 32 + (8 * 3) + (16 * 3) + (8 * 2) + 1;
}

#[event]
pub struct DealFeeValued {
    pub deal: Pubkey,
    pub registry_revision: u64,
    pub a_fee_paid: u64,
    pub b_fee_paid: u64,
    pub a_credit_u: u128,
    pub b_credit_u: u128,
    pub base_credit_u: u128,
    pub valued_at: i64,
}

#[error_code(offset = 6100)]
pub enum ValuationError {
    #[msg("deal is not completed")]
    DealNotCompleted,
    #[msg("asset terms are not resolved")]
    TermsNotResolved,
    #[msg("asset terms do not belong to the deal")]
    InvalidTerms,
    #[msg("deal end time is missing")]
    MissingEndTime,
    #[msg("stable mint does not match the official registry")]
    InvalidStableMint,
    #[msg("pair account owner does not match the registry")]
    InvalidPairOwner,
    #[msg("pair account data is invalid")]
    InvalidPairData,
    #[msg("pair assets do not match the official route")]
    InvalidPair,
    #[msg("valuation arithmetic overflow")]
    ArithmeticOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(reserve0: u64, reserve1: u64, virtual0: u64, virtual1: u64) -> PairState {
        PairState {
            dc_mint: Pubkey::new_unique(),
            other_mint: Pubkey::new_unique(),
            dc_token_program: Pubkey::new_unique(),
            other_token_program: Pubkey::new_unique(),
            vault0: Pubkey::new_unique(),
            vault1: Pubkey::new_unique(),
            reserve0,
            reserve1,
            virtual_reserve0: virtual0,
            virtual_reserve1: virtual1,
            price0_cumulative: 0,
            price1_cumulative: 0,
            last_timestamp: 0,
            fee_numerator: 3,
            fee_denominator: 1_000,
            virtual0_enabled: virtual0 != 0,
            virtual1_enabled: virtual1 != 0,
            liquidity_initialized: true,
            bump: 255,
        }
    }

    #[test]
    fn stable_decimal_scaling_matches_evm_u18_rules() {
        assert_eq!(to_u18(30, 6).unwrap(), 30_000_000_000_000);
        assert_eq!(to_u18(30, 18).unwrap(), 30);
        assert_eq!(to_u18_u128(30_000_000_000_000, 30).unwrap(), 30);
        assert_eq!(to_u18(30, 37).unwrap(), 0);
    }

    #[test]
    fn effective_reserve_conversion_uses_real_plus_virtual_liquidity() {
        let pair = pair(1_000, 2_000, 1_000, 2_000);
        assert_eq!(token0_to_token1(&pair, 100).unwrap(), 200);
        assert_eq!(token1_to_token0(&pair, 200).unwrap(), 100);
    }
}
