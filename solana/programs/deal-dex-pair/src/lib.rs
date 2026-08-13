#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, BurnChecked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

declare_id!("7gj62yTY5NpATrvseLcsC4eNvsBWd53eAK5RBe2kgQe6");

pub const CONFIG_SEED: &[u8] = b"dex-config";
pub const PAIR_SEED: &[u8] = b"dex-pair";
pub const PRICE_SCALE: u128 = 1u128 << 32;

#[program]
pub mod deal_dex_pair {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.dc_mint = ctx.accounts.dc_mint.key();
        config.dc_token_program = ctx.accounts.dc_token_program.key();
        config.paused = true;
        config.bump = ctx.bumps.config;
        emit!(DexInitialized {
            authority: config.authority,
            dc_mint: config.dc_mint,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.paused = paused;
        emit!(DexPauseUpdated { paused });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            DexError::ZeroAddress
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(DexAuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            DexError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = Pubkey::default();
        emit!(DexAuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority,
        });
        Ok(())
    }

    pub fn create_pair(
        ctx: Context<CreatePair>,
        fee_numerator: u32,
        fee_denominator: u32,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        validate_fee(fee_numerator, fee_denominator)?;
        require_keys_neq!(
            ctx.accounts.dc_mint.key(),
            ctx.accounts.other_mint.key(),
            DexError::IdenticalMint
        );
        let pair = &mut ctx.accounts.pair;
        pair.dc_mint = ctx.accounts.dc_mint.key();
        pair.other_mint = ctx.accounts.other_mint.key();
        pair.dc_token_program = ctx.accounts.dc_token_program.key();
        pair.other_token_program = ctx.accounts.other_token_program.key();
        pair.vault0 = ctx.accounts.vault0.key();
        pair.vault1 = ctx.accounts.vault1.key();
        pair.reserve0 = 0;
        pair.reserve1 = 0;
        pair.virtual_reserve0 = 0;
        pair.virtual_reserve1 = 0;
        pair.virtual0_enabled = false;
        pair.virtual1_enabled = false;
        pair.price0_cumulative = 0;
        pair.price1_cumulative = 0;
        pair.last_timestamp = Clock::get()?.unix_timestamp;
        pair.fee_numerator = fee_numerator;
        pair.fee_denominator = fee_denominator;
        pair.liquidity_initialized = false;
        pair.bump = ctx.bumps.pair;
        emit!(PairCreated {
            pair: pair.key(),
            dc_mint: pair.dc_mint,
            other_mint: pair.other_mint,
            fee_numerator,
            fee_denominator,
        });
        Ok(())
    }

    pub fn set_fee(
        ctx: Context<AdminPair>,
        fee_numerator: u32,
        fee_denominator: u32,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        validate_fee(fee_numerator, fee_denominator)?;
        let old_numerator = ctx.accounts.pair.fee_numerator;
        let old_denominator = ctx.accounts.pair.fee_denominator;
        ctx.accounts.pair.fee_numerator = fee_numerator;
        ctx.accounts.pair.fee_denominator = fee_denominator;
        emit!(PairFeeUpdated {
            pair: ctx.accounts.pair.key(),
            old_numerator,
            old_denominator,
            fee_numerator,
            fee_denominator,
        });
        Ok(())
    }

    pub fn set_virtual_reserves(
        ctx: Context<AdminPair>,
        virtual_reserve0: u64,
        virtual_reserve1: u64,
        enable0: bool,
        enable1: bool,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        let now = Clock::get()?.unix_timestamp;
        roll_price_cumulatives(&mut ctx.accounts.pair, now)?;
        let pair = &mut ctx.accounts.pair;
        pair.virtual_reserve0 = virtual_reserve0;
        pair.virtual_reserve1 = virtual_reserve1;
        pair.virtual0_enabled = enable0 && virtual_reserve0 > 0;
        pair.virtual1_enabled = enable1 && virtual_reserve1 > 0;
        effective_reserves(pair)?;
        emit!(VirtualReservesUpdated {
            pair: pair.key(),
            virtual_reserve0: pair.virtual_reserve0,
            virtual0_enabled: pair.virtual0_enabled,
            virtual_reserve1: pair.virtual_reserve1,
            virtual1_enabled: pair.virtual1_enabled,
        });
        Ok(())
    }

    pub fn initialize_liquidity(
        ctx: Context<InitializeLiquidity>,
        amount0: u64,
        amount1: u64,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(!ctx.accounts.config.paused, DexError::Paused);
        require!(
            !ctx.accounts.pair.liquidity_initialized,
            DexError::AlreadyInitialized
        );
        require!(amount0 > 0 && amount1 > 0, DexError::NeedBothSides);
        validate_pair_accounts(
            &ctx.accounts.config,
            ctx.accounts.pair.key(),
            &ctx.accounts.pair,
            &ctx.accounts.dc_mint,
            &ctx.accounts.other_mint,
            &ctx.accounts.vault0,
            &ctx.accounts.vault1,
            &ctx.accounts.dc_token_program,
            &ctx.accounts.other_token_program,
        )?;
        require_eq!(
            ctx.accounts.vault0.amount,
            0,
            DexError::UnexpectedVaultBalance
        );
        require_eq!(
            ctx.accounts.vault1.amount,
            0,
            DexError::UnexpectedVaultBalance
        );
        transfer_in(
            &ctx.accounts.source0,
            &ctx.accounts.dc_mint,
            &ctx.accounts.vault0,
            &ctx.accounts.authority,
            &ctx.accounts.dc_token_program,
            amount0,
        )?;
        transfer_in(
            &ctx.accounts.source1,
            &ctx.accounts.other_mint,
            &ctx.accounts.vault1,
            &ctx.accounts.authority,
            &ctx.accounts.other_token_program,
            amount1,
        )?;
        ctx.accounts.vault0.reload()?;
        ctx.accounts.vault1.reload()?;
        require_eq!(
            ctx.accounts.vault0.amount,
            amount0,
            DexError::TransferMismatch
        );
        require_eq!(
            ctx.accounts.vault1.amount,
            amount1,
            DexError::TransferMismatch
        );
        let pair = &mut ctx.accounts.pair;
        pair.reserve0 = amount0;
        pair.reserve1 = amount1;
        pair.liquidity_initialized = true;
        pair.last_timestamp = Clock::get()?.unix_timestamp;
        effective_reserves(pair)?;
        emit!(LiquidityInitialized {
            pair: pair.key(),
            amount0,
            amount1,
        });
        Ok(())
    }

    pub fn add_other_liquidity(ctx: Context<AddOtherLiquidity>, amount1: u64) -> Result<()> {
        assert_pair_enabled(&ctx.accounts.config, &ctx.accounts.pair)?;
        require!(amount1 > 0, DexError::ZeroInput);
        validate_pair_accounts(
            &ctx.accounts.config,
            ctx.accounts.pair.key(),
            &ctx.accounts.pair,
            &ctx.accounts.dc_mint,
            &ctx.accounts.other_mint,
            &ctx.accounts.vault0,
            &ctx.accounts.vault1,
            &ctx.accounts.dc_token_program,
            &ctx.accounts.other_token_program,
        )?;
        require_eq!(
            ctx.accounts.vault0.amount,
            ctx.accounts.pair.reserve0,
            DexError::ReserveMismatch
        );
        require_eq!(
            ctx.accounts.vault1.amount,
            ctx.accounts.pair.reserve1,
            DexError::ReserveMismatch
        );
        let now = Clock::get()?.unix_timestamp;
        roll_price_cumulatives(&mut ctx.accounts.pair, now)?;
        transfer_in(
            &ctx.accounts.source1,
            &ctx.accounts.other_mint,
            &ctx.accounts.vault1,
            &ctx.accounts.depositor,
            &ctx.accounts.other_token_program,
            amount1,
        )?;
        ctx.accounts.vault1.reload()?;
        let expected = ctx
            .accounts
            .pair
            .reserve1
            .checked_add(amount1)
            .ok_or_else(|| error!(DexError::MathOverflow))?;
        require_eq!(
            ctx.accounts.vault1.amount,
            expected,
            DexError::TransferMismatch
        );
        ctx.accounts.pair.reserve1 = expected;
        effective_reserves(&ctx.accounts.pair)?;
        emit!(OtherLiquidityAdded {
            pair: ctx.accounts.pair.key(),
            amount1,
        });
        Ok(())
    }

    pub fn sync_donations(ctx: Context<SyncDonations>) -> Result<()> {
        require!(
            ctx.accounts.pair.liquidity_initialized,
            DexError::NotInitialized
        );
        validate_pair_accounts(
            &ctx.accounts.config,
            ctx.accounts.pair.key(),
            &ctx.accounts.pair,
            &ctx.accounts.dc_mint,
            &ctx.accounts.other_mint,
            &ctx.accounts.vault0,
            &ctx.accounts.vault1,
            &ctx.accounts.dc_token_program,
            &ctx.accounts.other_token_program,
        )?;
        require!(
            ctx.accounts.vault0.amount >= ctx.accounts.pair.reserve0
                && ctx.accounts.vault1.amount >= ctx.accounts.pair.reserve1,
            DexError::ReserveDeficit
        );
        let now = Clock::get()?.unix_timestamp;
        roll_price_cumulatives(&mut ctx.accounts.pair, now)?;
        let old_reserve1 = ctx.accounts.pair.reserve1;
        let dc_dust_burned = ctx.accounts.vault0.amount - ctx.accounts.pair.reserve0;
        burn_dc(
            &ctx.accounts.pair,
            &ctx.accounts.dc_mint,
            &ctx.accounts.vault0,
            &ctx.accounts.dc_token_program,
            dc_dust_burned,
        )?;
        ctx.accounts.vault0.reload()?;
        require_eq!(
            ctx.accounts.vault0.amount,
            ctx.accounts.pair.reserve0,
            DexError::TransferMismatch
        );
        ctx.accounts.pair.reserve0 = ctx.accounts.vault0.amount;
        ctx.accounts.pair.reserve1 = ctx.accounts.vault1.amount;
        effective_reserves(&ctx.accounts.pair)?;
        emit!(DonationsSynced {
            pair: ctx.accounts.pair.key(),
            dc_dust_burned,
            added1: ctx.accounts.pair.reserve1 - old_reserve1,
        });
        Ok(())
    }

    pub fn swap_buy_dc(ctx: Context<SwapBuyDc>, amount1_in: u64, minimum0_out: u64) -> Result<()> {
        assert_pair_enabled(&ctx.accounts.config, &ctx.accounts.pair)?;
        validate_pair_accounts(
            &ctx.accounts.config,
            ctx.accounts.pair.key(),
            &ctx.accounts.pair,
            &ctx.accounts.dc_mint,
            &ctx.accounts.other_mint,
            &ctx.accounts.vault0,
            &ctx.accounts.vault1,
            &ctx.accounts.dc_token_program,
            &ctx.accounts.other_token_program,
        )?;
        require_eq!(
            ctx.accounts.vault0.amount,
            ctx.accounts.pair.reserve0,
            DexError::ReserveMismatch
        );
        require_eq!(
            ctx.accounts.vault1.amount,
            ctx.accounts.pair.reserve1,
            DexError::ReserveMismatch
        );
        let (gross0_out, fee0, net0_out) = quote_buy_given_in(&ctx.accounts.pair, amount1_in)?;
        require!(net0_out >= minimum0_out, DexError::SlippageExceeded);
        let pre = invariant(&ctx.accounts.pair)?;
        let now = Clock::get()?.unix_timestamp;
        roll_price_cumulatives(&mut ctx.accounts.pair, now)?;
        transfer_in(
            &ctx.accounts.user_other,
            &ctx.accounts.other_mint,
            &ctx.accounts.vault1,
            &ctx.accounts.user,
            &ctx.accounts.other_token_program,
            amount1_in,
        )?;
        burn_dc(
            &ctx.accounts.pair,
            &ctx.accounts.dc_mint,
            &ctx.accounts.vault0,
            &ctx.accounts.dc_token_program,
            fee0,
        )?;
        transfer_dc_out(
            &ctx.accounts.pair,
            &ctx.accounts.dc_mint,
            &ctx.accounts.vault0,
            &ctx.accounts.user_dc,
            &ctx.accounts.dc_token_program,
            net0_out,
        )?;
        ctx.accounts.vault0.reload()?;
        ctx.accounts.vault1.reload()?;
        let expected0 = ctx
            .accounts
            .pair
            .reserve0
            .checked_sub(gross0_out)
            .ok_or_else(|| error!(DexError::MathOverflow))?;
        let expected1 = ctx
            .accounts
            .pair
            .reserve1
            .checked_add(amount1_in)
            .ok_or_else(|| error!(DexError::MathOverflow))?;
        require_eq!(
            ctx.accounts.vault0.amount,
            expected0,
            DexError::TransferMismatch
        );
        require_eq!(
            ctx.accounts.vault1.amount,
            expected1,
            DexError::TransferMismatch
        );
        ctx.accounts.pair.reserve0 = expected0;
        ctx.accounts.pair.reserve1 = expected1;
        require!(
            invariant(&ctx.accounts.pair)? >= pre,
            DexError::InvariantViolation
        );
        emit!(SwapExecuted {
            pair: ctx.accounts.pair.key(),
            user: ctx.accounts.user.key(),
            amount0_in: 0,
            amount1_in,
            amount0_out_gross: gross0_out,
            amount0_out_net: net0_out,
            amount1_out: 0,
            fee0_burned: fee0,
        });
        Ok(())
    }

    pub fn swap_other_for_exact_dc(
        ctx: Context<SwapBuyDc>,
        net0_target: u64,
        maximum1_in: u64,
    ) -> Result<()> {
        assert_pair_enabled(&ctx.accounts.config, &ctx.accounts.pair)?;
        validate_pair_accounts(
            &ctx.accounts.config,
            ctx.accounts.pair.key(),
            &ctx.accounts.pair,
            &ctx.accounts.dc_mint,
            &ctx.accounts.other_mint,
            &ctx.accounts.vault0,
            &ctx.accounts.vault1,
            &ctx.accounts.dc_token_program,
            &ctx.accounts.other_token_program,
        )?;
        require_eq!(
            ctx.accounts.vault0.amount,
            ctx.accounts.pair.reserve0,
            DexError::ReserveMismatch
        );
        require_eq!(
            ctx.accounts.vault1.amount,
            ctx.accounts.pair.reserve1,
            DexError::ReserveMismatch
        );
        let (gross0_out, fee0, net0_out, amount1_in) =
            quote_buy_given_net(&ctx.accounts.pair, net0_target)?;
        require!(amount1_in <= maximum1_in, DexError::MaximumInputExceeded);
        let pre = invariant(&ctx.accounts.pair)?;
        let now = Clock::get()?.unix_timestamp;
        roll_price_cumulatives(&mut ctx.accounts.pair, now)?;
        transfer_in(
            &ctx.accounts.user_other,
            &ctx.accounts.other_mint,
            &ctx.accounts.vault1,
            &ctx.accounts.user,
            &ctx.accounts.other_token_program,
            amount1_in,
        )?;
        burn_dc(
            &ctx.accounts.pair,
            &ctx.accounts.dc_mint,
            &ctx.accounts.vault0,
            &ctx.accounts.dc_token_program,
            fee0,
        )?;
        transfer_dc_out(
            &ctx.accounts.pair,
            &ctx.accounts.dc_mint,
            &ctx.accounts.vault0,
            &ctx.accounts.user_dc,
            &ctx.accounts.dc_token_program,
            net0_out,
        )?;
        ctx.accounts.vault0.reload()?;
        ctx.accounts.vault1.reload()?;
        let expected0 = ctx
            .accounts
            .pair
            .reserve0
            .checked_sub(gross0_out)
            .ok_or_else(|| error!(DexError::MathOverflow))?;
        let expected1 = ctx
            .accounts
            .pair
            .reserve1
            .checked_add(amount1_in)
            .ok_or_else(|| error!(DexError::MathOverflow))?;
        require_eq!(
            ctx.accounts.vault0.amount,
            expected0,
            DexError::TransferMismatch
        );
        require_eq!(
            ctx.accounts.vault1.amount,
            expected1,
            DexError::TransferMismatch
        );
        ctx.accounts.pair.reserve0 = expected0;
        ctx.accounts.pair.reserve1 = expected1;
        require!(
            invariant(&ctx.accounts.pair)? >= pre,
            DexError::InvariantViolation
        );
        emit!(SwapExecuted {
            pair: ctx.accounts.pair.key(),
            user: ctx.accounts.user.key(),
            amount0_in: 0,
            amount1_in,
            amount0_out_gross: gross0_out,
            amount0_out_net: net0_out,
            amount1_out: 0,
            fee0_burned: fee0,
        });
        Ok(())
    }

    pub fn swap_sell_dc(
        ctx: Context<SwapSellDc>,
        amount0_in: u64,
        minimum1_out: u64,
    ) -> Result<()> {
        assert_pair_enabled(&ctx.accounts.config, &ctx.accounts.pair)?;
        validate_pair_accounts(
            &ctx.accounts.config,
            ctx.accounts.pair.key(),
            &ctx.accounts.pair,
            &ctx.accounts.dc_mint,
            &ctx.accounts.other_mint,
            &ctx.accounts.vault0,
            &ctx.accounts.vault1,
            &ctx.accounts.dc_token_program,
            &ctx.accounts.other_token_program,
        )?;
        require_eq!(
            ctx.accounts.vault0.amount,
            ctx.accounts.pair.reserve0,
            DexError::ReserveMismatch
        );
        require_eq!(
            ctx.accounts.vault1.amount,
            ctx.accounts.pair.reserve1,
            DexError::ReserveMismatch
        );
        let (fee0, effective0_in, amount1_out) = quote_sell(&ctx.accounts.pair, amount0_in)?;
        require!(amount1_out >= minimum1_out, DexError::SlippageExceeded);
        let pre = invariant(&ctx.accounts.pair)?;
        let now = Clock::get()?.unix_timestamp;
        roll_price_cumulatives(&mut ctx.accounts.pair, now)?;
        transfer_in(
            &ctx.accounts.user_dc,
            &ctx.accounts.dc_mint,
            &ctx.accounts.vault0,
            &ctx.accounts.user,
            &ctx.accounts.dc_token_program,
            amount0_in,
        )?;
        burn_dc(
            &ctx.accounts.pair,
            &ctx.accounts.dc_mint,
            &ctx.accounts.vault0,
            &ctx.accounts.dc_token_program,
            fee0,
        )?;
        transfer_other_out(
            &ctx.accounts.pair,
            &ctx.accounts.other_mint,
            &ctx.accounts.vault1,
            &ctx.accounts.user_other,
            &ctx.accounts.other_token_program,
            amount1_out,
        )?;
        ctx.accounts.vault0.reload()?;
        ctx.accounts.vault1.reload()?;
        let expected0 = ctx
            .accounts
            .pair
            .reserve0
            .checked_add(effective0_in)
            .ok_or_else(|| error!(DexError::MathOverflow))?;
        let expected1 = ctx
            .accounts
            .pair
            .reserve1
            .checked_sub(amount1_out)
            .ok_or_else(|| error!(DexError::MathOverflow))?;
        require_eq!(
            ctx.accounts.vault0.amount,
            expected0,
            DexError::TransferMismatch
        );
        require_eq!(
            ctx.accounts.vault1.amount,
            expected1,
            DexError::TransferMismatch
        );
        ctx.accounts.pair.reserve0 = expected0;
        ctx.accounts.pair.reserve1 = expected1;
        require!(
            invariant(&ctx.accounts.pair)? >= pre,
            DexError::InvariantViolation
        );
        emit!(SwapExecuted {
            pair: ctx.accounts.pair.key(),
            user: ctx.accounts.user.key(),
            amount0_in,
            amount1_in: 0,
            amount0_out_gross: 0,
            amount0_out_net: 0,
            amount1_out,
            fee0_burned: fee0,
        });
        Ok(())
    }

    pub fn swap_dc_for_exact_other(
        ctx: Context<SwapSellDc>,
        amount1_target: u64,
        maximum0_in: u64,
    ) -> Result<()> {
        assert_pair_enabled(&ctx.accounts.config, &ctx.accounts.pair)?;
        validate_pair_accounts(
            &ctx.accounts.config,
            ctx.accounts.pair.key(),
            &ctx.accounts.pair,
            &ctx.accounts.dc_mint,
            &ctx.accounts.other_mint,
            &ctx.accounts.vault0,
            &ctx.accounts.vault1,
            &ctx.accounts.dc_token_program,
            &ctx.accounts.other_token_program,
        )?;
        require_eq!(
            ctx.accounts.vault0.amount,
            ctx.accounts.pair.reserve0,
            DexError::ReserveMismatch
        );
        require_eq!(
            ctx.accounts.vault1.amount,
            ctx.accounts.pair.reserve1,
            DexError::ReserveMismatch
        );
        let (amount0_in, fee0, effective0_in) =
            quote_sell_given_out(&ctx.accounts.pair, amount1_target)?;
        require!(amount0_in <= maximum0_in, DexError::MaximumInputExceeded);
        let pre = invariant(&ctx.accounts.pair)?;
        let now = Clock::get()?.unix_timestamp;
        roll_price_cumulatives(&mut ctx.accounts.pair, now)?;
        transfer_in(
            &ctx.accounts.user_dc,
            &ctx.accounts.dc_mint,
            &ctx.accounts.vault0,
            &ctx.accounts.user,
            &ctx.accounts.dc_token_program,
            amount0_in,
        )?;
        burn_dc(
            &ctx.accounts.pair,
            &ctx.accounts.dc_mint,
            &ctx.accounts.vault0,
            &ctx.accounts.dc_token_program,
            fee0,
        )?;
        transfer_other_out(
            &ctx.accounts.pair,
            &ctx.accounts.other_mint,
            &ctx.accounts.vault1,
            &ctx.accounts.user_other,
            &ctx.accounts.other_token_program,
            amount1_target,
        )?;
        ctx.accounts.vault0.reload()?;
        ctx.accounts.vault1.reload()?;
        let expected0 = ctx
            .accounts
            .pair
            .reserve0
            .checked_add(effective0_in)
            .ok_or_else(|| error!(DexError::MathOverflow))?;
        let expected1 = ctx
            .accounts
            .pair
            .reserve1
            .checked_sub(amount1_target)
            .ok_or_else(|| error!(DexError::MathOverflow))?;
        require_eq!(
            ctx.accounts.vault0.amount,
            expected0,
            DexError::TransferMismatch
        );
        require_eq!(
            ctx.accounts.vault1.amount,
            expected1,
            DexError::TransferMismatch
        );
        ctx.accounts.pair.reserve0 = expected0;
        ctx.accounts.pair.reserve1 = expected1;
        require!(
            invariant(&ctx.accounts.pair)? >= pre,
            DexError::InvariantViolation
        );
        emit!(SwapExecuted {
            pair: ctx.accounts.pair.key(),
            user: ctx.accounts.user.key(),
            amount0_in,
            amount1_in: 0,
            amount0_out_gross: 0,
            amount0_out_net: 0,
            amount1_out: amount1_target,
            fee0_burned: fee0,
        });
        Ok(())
    }
}

fn assert_authority(config: &DexConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(config.authority, authority.key(), DexError::Unauthorized);
    Ok(())
}

fn assert_pair_enabled(config: &DexConfig, pair: &PairState) -> Result<()> {
    require!(!config.paused, DexError::Paused);
    require!(pair.liquidity_initialized, DexError::NotInitialized);
    Ok(())
}

fn validate_fee(numerator: u32, denominator: u32) -> Result<()> {
    require!(
        denominator > 0 && numerator < denominator,
        DexError::InvalidFee
    );
    Ok(())
}

pub fn effective_reserves(pair: &PairState) -> Result<(u64, u64)> {
    let virtual0 = if pair.virtual0_enabled {
        pair.virtual_reserve0
    } else {
        0
    };
    let virtual1 = if pair.virtual1_enabled {
        pair.virtual_reserve1
    } else {
        0
    };
    let effective0 = pair
        .reserve0
        .checked_add(virtual0)
        .ok_or_else(|| error!(DexError::MathOverflow))?;
    let effective1 = pair
        .reserve1
        .checked_add(virtual1)
        .ok_or_else(|| error!(DexError::MathOverflow))?;
    Ok((effective0, effective1))
}

pub fn quote_buy_given_in(pair: &PairState, amount1_in: u64) -> Result<(u64, u64, u64)> {
    require!(pair.liquidity_initialized, DexError::NotInitialized);
    require!(amount1_in > 0, DexError::ZeroInput);
    let (effective0, effective1) = effective_reserves(pair)?;
    let gross = checked_mul_div(
        u128::from(effective0),
        u128::from(amount1_in),
        u128::from(effective1)
            .checked_add(u128::from(amount1_in))
            .ok_or_else(|| error!(DexError::MathOverflow))?,
    )?;
    let gross = to_u64(gross)?;
    require!(gross > 0, DexError::InsufficientInput);
    require!(gross < pair.reserve0, DexError::InsufficientLiquidity);
    let fee = fee_amount(gross, pair.fee_numerator, pair.fee_denominator)?;
    let net = gross
        .checked_sub(fee)
        .ok_or_else(|| error!(DexError::MathOverflow))?;
    Ok((gross, fee, net))
}

pub fn quote_buy_given_net(pair: &PairState, net0_target: u64) -> Result<(u64, u64, u64, u64)> {
    require!(pair.liquidity_initialized, DexError::NotInitialized);
    require!(net0_target > 0, DexError::ZeroOutput);
    require!(net0_target < pair.reserve0, DexError::InsufficientLiquidity);
    validate_fee(pair.fee_numerator, pair.fee_denominator)?;

    let fee_denominator = u128::from(pair.fee_denominator);
    let net_denominator = u128::from(pair.fee_denominator - pair.fee_numerator);
    let mut gross = to_u64(checked_mul_div_ceil(
        u128::from(net0_target),
        fee_denominator,
        net_denominator,
    )?)?;
    let mut fee = fee_amount(gross, pair.fee_numerator, pair.fee_denominator)?;
    if gross
        .checked_sub(fee)
        .ok_or_else(|| error!(DexError::MathOverflow))?
        < net0_target
    {
        gross = gross
            .checked_add(1)
            .ok_or_else(|| error!(DexError::MathOverflow))?;
        fee = fee_amount(gross, pair.fee_numerator, pair.fee_denominator)?;
    }
    require!(gross < pair.reserve0, DexError::InsufficientLiquidity);
    let net = gross
        .checked_sub(fee)
        .ok_or_else(|| error!(DexError::MathOverflow))?;
    require!(net >= net0_target, DexError::InsufficientInput);

    let (effective0, effective1) = effective_reserves(pair)?;
    let denominator = effective0
        .checked_sub(gross)
        .ok_or_else(|| error!(DexError::MathOverflow))?;
    let amount1_in = to_u64(checked_mul_div_ceil(
        u128::from(effective1),
        u128::from(gross),
        u128::from(denominator),
    )?)?;
    require!(amount1_in > 0, DexError::InsufficientInput);
    Ok((gross, fee, net, amount1_in))
}

pub fn quote_sell(pair: &PairState, amount0_in: u64) -> Result<(u64, u64, u64)> {
    require!(pair.liquidity_initialized, DexError::NotInitialized);
    require!(amount0_in > 0, DexError::ZeroInput);
    let fee = fee_amount(amount0_in, pair.fee_numerator, pair.fee_denominator)?;
    let effective_input = amount0_in
        .checked_sub(fee)
        .ok_or_else(|| error!(DexError::MathOverflow))?;
    require!(effective_input > 0, DexError::InsufficientInput);
    let (effective0, effective1) = effective_reserves(pair)?;
    let output = checked_mul_div(
        u128::from(effective1),
        u128::from(effective_input),
        u128::from(effective0)
            .checked_add(u128::from(effective_input))
            .ok_or_else(|| error!(DexError::MathOverflow))?,
    )?;
    let output = to_u64(output)?;
    require!(output > 0, DexError::InsufficientInput);
    require!(output < pair.reserve1, DexError::InsufficientLiquidity);
    Ok((fee, effective_input, output))
}

pub fn quote_sell_given_out(pair: &PairState, amount1_target: u64) -> Result<(u64, u64, u64)> {
    require!(pair.liquidity_initialized, DexError::NotInitialized);
    require!(amount1_target > 0, DexError::ZeroOutput);
    require!(
        amount1_target < pair.reserve1,
        DexError::InsufficientLiquidity
    );
    validate_fee(pair.fee_numerator, pair.fee_denominator)?;

    let (effective0, effective1) = effective_reserves(pair)?;
    let output_denominator = effective1
        .checked_sub(amount1_target)
        .ok_or_else(|| error!(DexError::MathOverflow))?;
    let effective_input = to_u64(checked_mul_div_ceil(
        u128::from(effective0),
        u128::from(amount1_target),
        u128::from(output_denominator),
    )?)?;
    require!(effective_input > 0, DexError::InsufficientInput);

    let fee_denominator = u128::from(pair.fee_denominator);
    let net_denominator = u128::from(pair.fee_denominator - pair.fee_numerator);
    let mut amount0_in = to_u64(checked_mul_div_ceil(
        u128::from(effective_input),
        fee_denominator,
        net_denominator,
    )?)?;
    let mut fee = fee_amount(amount0_in, pair.fee_numerator, pair.fee_denominator)?;
    if amount0_in
        .checked_sub(fee)
        .ok_or_else(|| error!(DexError::MathOverflow))?
        < effective_input
    {
        amount0_in = amount0_in
            .checked_add(1)
            .ok_or_else(|| error!(DexError::MathOverflow))?;
        fee = fee_amount(amount0_in, pair.fee_numerator, pair.fee_denominator)?;
    }
    let actual_effective_input = amount0_in
        .checked_sub(fee)
        .ok_or_else(|| error!(DexError::MathOverflow))?;
    require!(
        actual_effective_input >= effective_input,
        DexError::InsufficientInput
    );
    Ok((amount0_in, fee, actual_effective_input))
}

fn fee_amount(amount: u64, numerator: u32, denominator: u32) -> Result<u64> {
    validate_fee(numerator, denominator)?;
    to_u64(checked_mul_div(
        u128::from(amount),
        u128::from(numerator),
        u128::from(denominator),
    )?)
}

fn checked_mul_div(left: u128, right: u128, denominator: u128) -> Result<u128> {
    require!(denominator > 0, DexError::MathOverflow);
    left.checked_mul(right)
        .ok_or_else(|| error!(DexError::MathOverflow))?
        .checked_div(denominator)
        .ok_or_else(|| error!(DexError::MathOverflow))
}

fn checked_mul_div_ceil(left: u128, right: u128, denominator: u128) -> Result<u128> {
    require!(denominator > 0, DexError::MathOverflow);
    let product = left
        .checked_mul(right)
        .ok_or_else(|| error!(DexError::MathOverflow))?;
    let quotient = product
        .checked_div(denominator)
        .ok_or_else(|| error!(DexError::MathOverflow))?;
    let remainder = product
        .checked_rem(denominator)
        .ok_or_else(|| error!(DexError::MathOverflow))?;
    quotient
        .checked_add(u128::from(remainder > 0))
        .ok_or_else(|| error!(DexError::MathOverflow))
}

fn to_u64(value: u128) -> Result<u64> {
    u64::try_from(value).map_err(|_| error!(DexError::MathOverflow))
}

fn invariant(pair: &PairState) -> Result<u128> {
    let (effective0, effective1) = effective_reserves(pair)?;
    u128::from(effective0)
        .checked_mul(u128::from(effective1))
        .ok_or_else(|| error!(DexError::MathOverflow))
}

fn roll_price_cumulatives(pair: &mut PairState, now: i64) -> Result<()> {
    require!(now >= pair.last_timestamp, DexError::InvalidTimestamp);
    let elapsed = u128::try_from(now - pair.last_timestamp)
        .map_err(|_| error!(DexError::InvalidTimestamp))?;
    if elapsed > 0 && pair.liquidity_initialized && pair.reserve0 > 0 && pair.reserve1 > 0 {
        let (effective0, effective1) = effective_reserves(pair)?;
        let price0 = checked_mul_div(u128::from(effective1), PRICE_SCALE, u128::from(effective0))?;
        let price1 = checked_mul_div(u128::from(effective0), PRICE_SCALE, u128::from(effective1))?;
        pair.price0_cumulative = pair
            .price0_cumulative
            .wrapping_add(price0.wrapping_mul(elapsed));
        pair.price1_cumulative = pair
            .price1_cumulative
            .wrapping_add(price1.wrapping_mul(elapsed));
    }
    pair.last_timestamp = now;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_pair_accounts(
    config: &DexConfig,
    pair_key: Pubkey,
    pair: &PairState,
    dc_mint: &InterfaceAccount<'_, Mint>,
    other_mint: &InterfaceAccount<'_, Mint>,
    vault0: &InterfaceAccount<'_, TokenAccount>,
    vault1: &InterfaceAccount<'_, TokenAccount>,
    dc_token_program: &Interface<'_, TokenInterface>,
    other_token_program: &Interface<'_, TokenInterface>,
) -> Result<()> {
    require_keys_eq!(pair.dc_mint, config.dc_mint, DexError::InvalidMint);
    require_keys_eq!(pair.dc_mint, dc_mint.key(), DexError::InvalidMint);
    require_keys_eq!(pair.other_mint, other_mint.key(), DexError::InvalidMint);
    require_keys_eq!(pair.vault0, vault0.key(), DexError::InvalidVault);
    require_keys_eq!(pair.vault1, vault1.key(), DexError::InvalidVault);
    require_keys_eq!(vault0.owner, pair_key, DexError::InvalidVault);
    require_keys_eq!(vault1.owner, pair_key, DexError::InvalidVault);
    require_keys_eq!(vault0.mint, pair.dc_mint, DexError::InvalidMint);
    require_keys_eq!(vault1.mint, pair.other_mint, DexError::InvalidMint);
    require_keys_eq!(
        pair.dc_token_program,
        dc_token_program.key(),
        DexError::InvalidTokenProgram
    );
    require_keys_eq!(
        pair.other_token_program,
        other_token_program.key(),
        DexError::InvalidTokenProgram
    );
    Ok(())
}

fn transfer_in<'info, A: ToAccountInfo<'info>>(
    source: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    authority: &A,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from: source.to_account_info(),
                mint: mint.to_account_info(),
                to: vault.to_account_info(),
                authority: authority.to_account_info(),
            },
        ),
        amount,
        mint.decimals,
    )
}

fn burn_dc<'info>(
    pair: &Account<'info, PairState>,
    mint: &InterfaceAccount<'info, Mint>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let bump = [pair.bump];
    let signer_seeds: &[&[u8]] = &[PAIR_SEED, pair.other_mint.as_ref(), &bump];
    token_interface::burn_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            BurnChecked {
                mint: mint.to_account_info(),
                from: vault.to_account_info(),
                authority: pair.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
        mint.decimals,
    )
}

fn transfer_dc_out<'info>(
    pair: &Account<'info, PairState>,
    mint: &InterfaceAccount<'info, Mint>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    destination: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    transfer_pair_out(pair, mint, vault, destination, token_program, amount)
}

fn transfer_other_out<'info>(
    pair: &Account<'info, PairState>,
    mint: &InterfaceAccount<'info, Mint>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    destination: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    transfer_pair_out(pair, mint, vault, destination, token_program, amount)
}

fn transfer_pair_out<'info>(
    pair: &Account<'info, PairState>,
    mint: &InterfaceAccount<'info, Mint>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    destination: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let bump = [pair.bump];
    let signer_seeds: &[&[u8]] = &[PAIR_SEED, pair.other_mint.as_ref(), &bump];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: destination.to_account_info(),
                authority: pair.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
        mint.decimals,
    )
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub dc_token_program: Interface<'info, TokenInterface>,
    #[account(init, payer = payer, space = DexConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, DexConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DexConfig>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DexConfig>,
}

#[derive(Accounts)]
pub struct CreatePair<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DexConfig>,
    #[account(address = config.dc_mint)]
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub other_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = config.dc_token_program)]
    pub dc_token_program: Interface<'info, TokenInterface>,
    pub other_token_program: Interface<'info, TokenInterface>,
    #[account(
        init,
        payer = authority,
        space = PairState::SPACE,
        seeds = [PAIR_SEED, other_mint.key().as_ref()],
        bump
    )]
    pub pair: Box<Account<'info, PairState>>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = dc_mint,
        associated_token::authority = pair,
        associated_token::token_program = dc_token_program
    )]
    pub vault0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = other_mint,
        associated_token::authority = pair,
        associated_token::token_program = other_token_program
    )]
    pub vault1: Box<InterfaceAccount<'info, TokenAccount>>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminPair<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DexConfig>,
    #[account(mut, seeds = [PAIR_SEED, pair.other_mint.as_ref()], bump = pair.bump)]
    pub pair: Box<Account<'info, PairState>>,
}

#[derive(Accounts)]
pub struct InitializeLiquidity<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DexConfig>,
    #[account(mut, seeds = [PAIR_SEED, pair.other_mint.as_ref()], bump = pair.bump)]
    pub pair: Box<Account<'info, PairState>>,
    #[account(mut)]
    pub source0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub source1: Box<InterfaceAccount<'info, TokenAccount>>,
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub other_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub vault0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault1: Box<InterfaceAccount<'info, TokenAccount>>,
    pub dc_token_program: Interface<'info, TokenInterface>,
    pub other_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct AddOtherLiquidity<'info> {
    pub depositor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DexConfig>,
    #[account(mut, seeds = [PAIR_SEED, pair.other_mint.as_ref()], bump = pair.bump)]
    pub pair: Box<Account<'info, PairState>>,
    #[account(mut)]
    pub source1: Box<InterfaceAccount<'info, TokenAccount>>,
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub other_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub vault0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault1: Box<InterfaceAccount<'info, TokenAccount>>,
    pub dc_token_program: Interface<'info, TokenInterface>,
    pub other_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SyncDonations<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DexConfig>,
    #[account(mut, seeds = [PAIR_SEED, pair.other_mint.as_ref()], bump = pair.bump)]
    pub pair: Box<Account<'info, PairState>>,
    #[account(mut)]
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub other_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub vault0: Box<InterfaceAccount<'info, TokenAccount>>,
    pub vault1: Box<InterfaceAccount<'info, TokenAccount>>,
    pub dc_token_program: Interface<'info, TokenInterface>,
    pub other_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SwapBuyDc<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DexConfig>,
    #[account(mut, seeds = [PAIR_SEED, pair.other_mint.as_ref()], bump = pair.bump)]
    pub pair: Box<Account<'info, PairState>>,
    #[account(mut)]
    pub user_other: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub user_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub other_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub vault0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault1: Box<InterfaceAccount<'info, TokenAccount>>,
    pub dc_token_program: Interface<'info, TokenInterface>,
    pub other_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SwapSellDc<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DexConfig>,
    #[account(mut, seeds = [PAIR_SEED, pair.other_mint.as_ref()], bump = pair.bump)]
    pub pair: Box<Account<'info, PairState>>,
    #[account(mut)]
    pub user_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub user_other: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub other_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub vault0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault1: Box<InterfaceAccount<'info, TokenAccount>>,
    pub dc_token_program: Interface<'info, TokenInterface>,
    pub other_token_program: Interface<'info, TokenInterface>,
}

#[account]
pub struct DexConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub dc_mint: Pubkey,
    pub dc_token_program: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

impl DexConfig {
    pub const SPACE: usize = 8 + (32 * 4) + 1 + 1;
}

#[account]
pub struct PairState {
    pub dc_mint: Pubkey,
    pub other_mint: Pubkey,
    pub dc_token_program: Pubkey,
    pub other_token_program: Pubkey,
    pub vault0: Pubkey,
    pub vault1: Pubkey,
    pub reserve0: u64,
    pub reserve1: u64,
    pub virtual_reserve0: u64,
    pub virtual_reserve1: u64,
    pub price0_cumulative: u128,
    pub price1_cumulative: u128,
    pub last_timestamp: i64,
    pub fee_numerator: u32,
    pub fee_denominator: u32,
    pub virtual0_enabled: bool,
    pub virtual1_enabled: bool,
    pub liquidity_initialized: bool,
    pub bump: u8,
}

impl PairState {
    pub const SPACE: usize = 8 + (32 * 6) + (8 * 5) + (16 * 2) + (4 * 2) + 4;
}

#[event]
pub struct DexInitialized {
    pub authority: Pubkey,
    pub dc_mint: Pubkey,
}

#[event]
pub struct DexPauseUpdated {
    pub paused: bool,
}

#[event]
pub struct DexAuthorityProposed {
    pub pending_authority: Pubkey,
}

#[event]
pub struct DexAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct PairCreated {
    pub pair: Pubkey,
    pub dc_mint: Pubkey,
    pub other_mint: Pubkey,
    pub fee_numerator: u32,
    pub fee_denominator: u32,
}

#[event]
pub struct PairFeeUpdated {
    pub pair: Pubkey,
    pub old_numerator: u32,
    pub old_denominator: u32,
    pub fee_numerator: u32,
    pub fee_denominator: u32,
}

#[event]
pub struct VirtualReservesUpdated {
    pub pair: Pubkey,
    pub virtual_reserve0: u64,
    pub virtual0_enabled: bool,
    pub virtual_reserve1: u64,
    pub virtual1_enabled: bool,
}

#[event]
pub struct LiquidityInitialized {
    pub pair: Pubkey,
    pub amount0: u64,
    pub amount1: u64,
}

#[event]
pub struct OtherLiquidityAdded {
    pub pair: Pubkey,
    pub amount1: u64,
}

#[event]
pub struct DonationsSynced {
    pub pair: Pubkey,
    pub dc_dust_burned: u64,
    pub added1: u64,
}

#[event]
pub struct SwapExecuted {
    pub pair: Pubkey,
    pub user: Pubkey,
    pub amount0_in: u64,
    pub amount1_in: u64,
    pub amount0_out_gross: u64,
    pub amount0_out_net: u64,
    pub amount1_out: u64,
    pub fee0_burned: u64,
}

#[error_code]
pub enum DexError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("pending authority is invalid")]
    InvalidPendingAuthority,
    #[msg("DEX is paused")]
    Paused,
    #[msg("token mints must differ")]
    IdenticalMint,
    #[msg("fee fraction is invalid")]
    InvalidFee,
    #[msg("pair is not initialized")]
    NotInitialized,
    #[msg("pair is already initialized")]
    AlreadyInitialized,
    #[msg("both real liquidity sides are required")]
    NeedBothSides,
    #[msg("input amount cannot be zero")]
    ZeroInput,
    #[msg("output amount cannot be zero")]
    ZeroOutput,
    #[msg("input is too small for a non-zero output")]
    InsufficientInput,
    #[msg("real reserves cannot cover the requested output")]
    InsufficientLiquidity,
    #[msg("minimum output was not met")]
    SlippageExceeded,
    #[msg("required input exceeds the caller limit")]
    MaximumInputExceeded,
    #[msg("pair invariant decreased")]
    InvariantViolation,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("clock moved backwards")]
    InvalidTimestamp,
    #[msg("mint does not match pair configuration")]
    InvalidMint,
    #[msg("vault does not match pair configuration")]
    InvalidVault,
    #[msg("token program does not match pair configuration")]
    InvalidTokenProgram,
    #[msg("vault balance differs from the recorded reserve")]
    ReserveMismatch,
    #[msg("vault balance is below the recorded reserve")]
    ReserveDeficit,
    #[msg("vault must be empty before initialization")]
    UnexpectedVaultBalance,
    #[msg("token transfer delta does not match the requested amount")]
    TransferMismatch,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> PairState {
        PairState {
            dc_mint: Pubkey::new_unique(),
            other_mint: Pubkey::new_unique(),
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
            last_timestamp: 1_000,
            fee_numerator: 3,
            fee_denominator: 1_000,
            virtual0_enabled: true,
            virtual1_enabled: true,
            liquidity_initialized: true,
            bump: 1,
        }
    }

    #[test]
    fn quotes_match_constant_product_and_dc_fee_direction() {
        let pair = pair();
        let (gross, fee, net) = quote_buy_given_in(&pair, 1_000).unwrap();
        assert_eq!(gross, 9_900);
        assert_eq!(fee, 29);
        assert_eq!(net, 9_871);
        let (fee, effective, output) = quote_sell(&pair, 10_000).unwrap();
        assert_eq!(fee, 30);
        assert_eq!(effective, 9_970);
        assert_eq!(output, 987);
    }

    #[test]
    fn exact_output_quotes_match_evm_ceiling_rules() {
        let pair = pair();
        let (gross, fee, net, other_in) = quote_buy_given_net(&pair, 9_871).unwrap();
        assert_eq!((gross, fee, net, other_in), (9_901, 29, 9_872, 1_001));

        let (dc_in, sell_fee, effective_in) = quote_sell_given_out(&pair, 987).unwrap();
        assert_eq!((dc_in, sell_fee, effective_in), (9_999, 29, 9_970));
        assert!(quote_buy_given_net(&pair, 0).is_err());
        assert!(quote_sell_given_out(&pair, pair.reserve1).is_err());
    }

    #[test]
    fn virtual_reserves_change_price_but_not_real_output_limit() {
        let mut pair = pair();
        pair.virtual_reserve0 = 10_000_000;
        assert!(quote_buy_given_in(&pair, 10_000).is_err());
        pair.virtual_reserve0 = 0;
        pair.virtual0_enabled = false;
        let (gross, _, _) = quote_buy_given_in(&pair, 10_000).unwrap();
        assert!(gross < pair.reserve0);
    }

    #[test]
    fn fee_and_overflow_boundaries_are_rejected() {
        assert!(validate_fee(1, 0).is_err());
        assert!(validate_fee(1_000, 1_000).is_err());
        let mut pair = pair();
        pair.virtual_reserve0 = u64::MAX;
        assert!(effective_reserves(&pair).is_err());
    }
}
