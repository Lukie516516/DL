#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use deal_dex_pair::{
    effective_reserves, quote_buy_given_in, quote_buy_given_net, quote_sell, quote_sell_given_out,
    PairState, PAIR_SEED,
};

declare_id!("BMHErQjGPrA5dCURDqk9fDRwz4xx7ZVVpxWfXdGLy51j");

#[program]
pub mod deal_dex_quoter {
    use super::*;

    pub fn quote_effective_reserves(
        ctx: Context<QuoteSinglePair>,
    ) -> Result<EffectiveReservesQuote> {
        validate_pair(&ctx.accounts.pair)?;
        let (effective_dc, effective_other) = effective_reserves(&ctx.accounts.pair)?;
        Ok(EffectiveReservesQuote {
            real_dc: ctx.accounts.pair.reserve0,
            real_other: ctx.accounts.pair.reserve1,
            effective_dc,
            effective_other,
        })
    }

    pub fn quote_exact_other_for_dc(
        ctx: Context<QuoteSinglePair>,
        amount_other_in: u64,
    ) -> Result<SingleHopQuote> {
        validate_pair(&ctx.accounts.pair)?;
        let (gross_dc, fee_dc, dc_out) = quote_buy_given_in(&ctx.accounts.pair, amount_other_in)?;
        Ok(SingleHopQuote {
            amount_in: amount_other_in,
            amount_out: dc_out,
            dc_gross: gross_dc,
            dc_fee: fee_dc,
        })
    }

    pub fn quote_other_for_exact_dc(
        ctx: Context<QuoteSinglePair>,
        exact_dc_out: u64,
    ) -> Result<SingleHopQuote> {
        validate_pair(&ctx.accounts.pair)?;
        let (gross_dc, fee_dc, actual_dc_out, required_other_in) =
            quote_buy_given_net(&ctx.accounts.pair, exact_dc_out)?;
        Ok(SingleHopQuote {
            amount_in: required_other_in,
            amount_out: actual_dc_out,
            dc_gross: gross_dc,
            dc_fee: fee_dc,
        })
    }

    pub fn quote_exact_dc_for_other(
        ctx: Context<QuoteSinglePair>,
        amount_dc_in: u64,
    ) -> Result<SingleHopQuote> {
        validate_pair(&ctx.accounts.pair)?;
        let (fee_dc, _, other_out) = quote_sell(&ctx.accounts.pair, amount_dc_in)?;
        Ok(SingleHopQuote {
            amount_in: amount_dc_in,
            amount_out: other_out,
            dc_gross: amount_dc_in,
            dc_fee: fee_dc,
        })
    }

    pub fn quote_dc_for_exact_other(
        ctx: Context<QuoteSinglePair>,
        exact_other_out: u64,
    ) -> Result<SingleHopQuote> {
        validate_pair(&ctx.accounts.pair)?;
        let (required_dc_in, fee_dc, _) =
            quote_sell_given_out(&ctx.accounts.pair, exact_other_out)?;
        Ok(SingleHopQuote {
            amount_in: required_dc_in,
            amount_out: exact_other_out,
            dc_gross: required_dc_in,
            dc_fee: fee_dc,
        })
    }

    pub fn quote_exact_other_for_other_via_dc(
        ctx: Context<QuoteTwoPairs>,
        amount_a_in: u64,
    ) -> Result<DoubleHopQuote> {
        validate_two_pairs(&ctx.accounts.pair_a, &ctx.accounts.pair_b)?;
        let (dc_gross, fee_buy_dc, dc_net) = quote_buy_given_in(&ctx.accounts.pair_a, amount_a_in)?;
        let (fee_sell_dc, _, amount_b_out) = quote_sell(&ctx.accounts.pair_b, dc_net)?;
        Ok(DoubleHopQuote {
            amount_a_in,
            amount_b_out,
            dc_gross,
            dc_used: dc_net,
            dc_refund: 0,
            fee_buy_dc,
            fee_sell_dc,
        })
    }

    pub fn quote_other_for_exact_other_via_dc(
        ctx: Context<QuoteTwoPairs>,
        exact_b_out: u64,
    ) -> Result<DoubleHopQuote> {
        validate_two_pairs(&ctx.accounts.pair_a, &ctx.accounts.pair_b)?;
        let (required_dc, fee_sell_dc, _) =
            quote_sell_given_out(&ctx.accounts.pair_b, exact_b_out)?;
        let (dc_gross, fee_buy_dc, actual_dc_out, required_a_in) =
            quote_buy_given_net(&ctx.accounts.pair_a, required_dc)?;
        let dc_refund = actual_dc_out
            .checked_sub(required_dc)
            .ok_or_else(|| error!(QuoterError::InvalidQuote))?;
        Ok(DoubleHopQuote {
            amount_a_in: required_a_in,
            amount_b_out: exact_b_out,
            dc_gross,
            dc_used: required_dc,
            dc_refund,
            fee_buy_dc,
            fee_sell_dc,
        })
    }
}

fn validate_pair(pair: &Account<'_, PairState>) -> Result<()> {
    let (expected, _) =
        Pubkey::find_program_address(&[PAIR_SEED, pair.other_mint.as_ref()], &deal_dex_pair::id());
    require_keys_eq!(pair.key(), expected, QuoterError::InvalidPair);
    Ok(())
}

fn validate_two_pairs(
    pair_a: &Account<'_, PairState>,
    pair_b: &Account<'_, PairState>,
) -> Result<()> {
    validate_pair(pair_a)?;
    validate_pair(pair_b)?;
    require_keys_neq!(pair_a.key(), pair_b.key(), QuoterError::SamePair);
    require_keys_neq!(pair_a.other_mint, pair_b.other_mint, QuoterError::SameMint);
    require_keys_eq!(pair_a.dc_mint, pair_b.dc_mint, QuoterError::InvalidDcMint);
    Ok(())
}

#[derive(Accounts)]
pub struct QuoteSinglePair<'info> {
    pub pair: Account<'info, PairState>,
}

#[derive(Accounts)]
pub struct QuoteTwoPairs<'info> {
    pub pair_a: Account<'info, PairState>,
    pub pair_b: Account<'info, PairState>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct EffectiveReservesQuote {
    pub real_dc: u64,
    pub real_other: u64,
    pub effective_dc: u64,
    pub effective_other: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SingleHopQuote {
    pub amount_in: u64,
    pub amount_out: u64,
    pub dc_gross: u64,
    pub dc_fee: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct DoubleHopQuote {
    pub amount_a_in: u64,
    pub amount_b_out: u64,
    pub dc_gross: u64,
    pub dc_used: u64,
    pub dc_refund: u64,
    pub fee_buy_dc: u64,
    pub fee_sell_dc: u64,
}

#[error_code(offset = 6100)]
pub enum QuoterError {
    #[msg("pair PDA is invalid")]
    InvalidPair,
    #[msg("both route hops cannot use the same pair")]
    SamePair,
    #[msg("route input and output mints must differ")]
    SameMint,
    #[msg("both route hops must use the same DC mint")]
    InvalidDcMint,
    #[msg("quote result is inconsistent")]
    InvalidQuote,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(other_mint: Pubkey) -> PairState {
        PairState {
            dc_mint: Pubkey::new_unique(),
            other_mint,
            dc_token_program: Pubkey::new_unique(),
            other_token_program: Pubkey::new_unique(),
            vault0: Pubkey::new_unique(),
            vault1: Pubkey::new_unique(),
            reserve0: 500_000,
            reserve1: 50_000,
            virtual_reserve0: 500_000,
            virtual_reserve1: 50_000,
            price0_cumulative: 0,
            price1_cumulative: 0,
            last_timestamp: 0,
            fee_numerator: 3,
            fee_denominator: 1_000,
            virtual0_enabled: true,
            virtual1_enabled: true,
            liquidity_initialized: true,
            bump: 0,
        }
    }

    #[test]
    fn quote_payloads_follow_pair_math() {
        let pair = pair(Pubkey::new_unique());
        let (gross, fee, net) = quote_buy_given_in(&pair, 1_000).unwrap();
        assert_eq!(gross, 9_900);
        assert_eq!(fee, 29);
        assert_eq!(net, 9_871);

        let (fee, effective, out) = quote_sell(&pair, 10_000).unwrap();
        assert_eq!(fee, 30);
        assert_eq!(effective, 9_970);
        assert_eq!(out, 987);
    }
}
