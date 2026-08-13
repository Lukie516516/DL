#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use deal_asset_controller::state::{AssetKind, AssetSpec, AssetTerms, ControllerConfig};
use deal_core::state::{DealAccount, DealStatus};
use deal_credit_graph::{CreditScore, SCORE_SEED};
use deal_dex_pair::{PairState, PRICE_SCALE};
use deal_identity::IdentityRecord;
use deal_swap_asset_registry::SwapAssetRegistry;
use deal_terminal_guard::{validate_current_and_following, ExpectedInstruction};

declare_id!("EVq7dnxAft4VVAXp3gZvt93DnJyUA3uwBRSS86yxZwo5");

pub const CONFIG_SEED: &[u8] = b"reward-config";
pub const MINTER_SEED: &[u8] = b"reward-minter";
pub const OBSERVATION_SEED: &[u8] = b"reward-twap";
pub const QUOTE_SEED: &[u8] = b"reward-quote";
pub const RECEIPT_SEED: &[u8] = b"reward-receipt";
pub const IDENTITY_RECEIPT_SEED: &[u8] = b"identity-reward";
pub const DEFAULT_MIN_WINDOW_SECONDS: u32 = 1_800;
pub const MAX_MIN_WINDOW_SECONDS: u32 = 7 * 24 * 60 * 60;
const FINALIZER_PROGRAM_ID: Pubkey = pubkey!("5VGLevrU3z3P9Epr6E1nTuMuxTdqqZiusbz21NugTgG9");
const PREPARE_COMPLETED_REWARDS_DISC: [u8; 8] = [0x9b, 0x0d, 0x71, 0x1e, 0x88, 0xf9, 0xa9, 0xbf];
const MINT_COMPLETED_REWARDS_DISC: [u8; 8] = [0x28, 0x0b, 0xd1, 0x62, 0x2f, 0x8b, 0x5f, 0xde];
const RECORD_COMPLETED_CREDIT_DISC: [u8; 8] = [0x2a, 0x8c, 0xad, 0xe0, 0x80, 0x80, 0x20, 0xc4];
const RECORD_COMPLETED_CREDIT_SINGLE_DISC: [u8; 8] =
    [0xd5, 0x08, 0x67, 0x2d, 0xdf, 0xfe, 0xa9, 0xc6];
const RECORD_COMPLETED_CREDIT_NONE_DISC: [u8; 8] = [0x46, 0x00, 0xca, 0x77, 0x48, 0x35, 0x80, 0x14];

#[program]
pub mod deal_reward_engine {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        reward_numerator: u32,
        reward_denominator: u32,
        min_window_seconds: u32,
    ) -> Result<()> {
        validate_reward_rate(
            reward_numerator,
            reward_denominator,
            &ctx.accounts.asset_config,
        )?;
        validate_window(min_window_seconds)?;
        require_keys_eq!(
            ctx.accounts.registry.dc_mint,
            ctx.accounts.dc_controller_config.dc_mint,
            RewardError::InvalidDcController
        );

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.dc_mint = ctx.accounts.registry.dc_mint;
        config.dc_controller = ctx.accounts.dc_controller_config.key();
        config.reward_numerator = reward_numerator;
        config.reward_denominator = reward_denominator;
        config.min_window_seconds = min_window_seconds;
        config.paused = true;
        config.bump = ctx.bumps.config;
        emit!(RewardEngineInitialized {
            authority: config.authority,
            dc_mint: config.dc_mint,
            reward_minter: ctx.accounts.reward_minter.key(),
            reward_numerator,
            reward_denominator,
            min_window_seconds,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.paused = paused;
        emit!(RewardPauseUpdated { paused });
        Ok(())
    }

    pub fn set_reward_rate(
        ctx: Context<AdminRewardRate>,
        reward_numerator: u32,
        reward_denominator: u32,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        validate_reward_rate(
            reward_numerator,
            reward_denominator,
            &ctx.accounts.asset_config,
        )?;
        ctx.accounts.config.reward_numerator = reward_numerator;
        ctx.accounts.config.reward_denominator = reward_denominator;
        emit!(RewardRateUpdated {
            reward_numerator,
            reward_denominator,
        });
        Ok(())
    }

    pub fn set_min_window(ctx: Context<AdminConfig>, min_window_seconds: u32) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        validate_window(min_window_seconds)?;
        ctx.accounts.config.min_window_seconds = min_window_seconds;
        emit!(RewardWindowUpdated { min_window_seconds });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            RewardError::ZeroAddress
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(RewardAuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            RewardError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = Pubkey::default();
        emit!(RewardAuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority,
        });
        Ok(())
    }

    pub fn prepare_completed_rewards(ctx: Context<PrepareCompletedRewards>) -> Result<()> {
        require!(!ctx.accounts.config.paused, RewardError::Paused);
        require!(
            ctx.accounts.deal.status == DealStatus::Completed,
            RewardError::DealNotCompleted
        );
        require!(ctx.accounts.terms.resolved, RewardError::TermsNotResolved);
        require_keys_eq!(
            ctx.accounts.terms.deal,
            ctx.accounts.deal.key(),
            RewardError::InvalidTerms
        );
        require_keys_eq!(
            ctx.accounts.registry.dc_mint,
            ctx.accounts.config.dc_mint,
            RewardError::InvalidRegistry
        );
        require_keys_eq!(
            ctx.accounts.registry.pair_program,
            deal_dex_pair::ID,
            RewardError::InvalidRegistry
        );
        validate_reward_rate(
            ctx.accounts.config.reward_numerator,
            ctx.accounts.config.reward_denominator,
            &ctx.accounts.asset_config,
        )?;
        require_keys_eq!(
            ctx.accounts.wrapped_native_pair.key(),
            ctx.accounts.registry.wrapped_native_pair,
            RewardError::InvalidPair
        );
        require_keys_eq!(
            ctx.accounts.stable0_pair.key(),
            ctx.accounts.registry.stable0_pair,
            RewardError::InvalidPair
        );
        require_keys_eq!(
            ctx.accounts.stable1_pair.key(),
            ctx.accounts.registry.stable1_pair,
            RewardError::InvalidPair
        );

        initialize_observation(
            &mut ctx.accounts.wrapped_native_observation,
            ctx.accounts.registry.wrapped_native_pair,
            ctx.bumps.wrapped_native_observation,
        );
        initialize_observation(
            &mut ctx.accounts.stable0_observation,
            ctx.accounts.registry.stable0_pair,
            ctx.bumps.stable0_observation,
        );
        initialize_observation(
            &mut ctx.accounts.stable1_observation,
            ctx.accounts.registry.stable1_pair,
            ctx.bumps.stable1_observation,
        );

        let recognized = side_is_recognized(&ctx.accounts.registry, ctx.accounts.terms.a_swap)
            && side_is_recognized(&ctx.accounts.registry, ctx.accounts.terms.b_swap);
        let both_dc = is_dc(&ctx.accounts.registry, ctx.accounts.terms.a_swap)
            && is_dc(&ctx.accounts.registry, ctx.accounts.terms.b_swap)
            && ctx.accounts.deal.a_swap_amount > 0
            && ctx.accounts.deal.b_swap_amount > 0;

        let mut a_reward = 0u64;
        let mut b_reward = 0u64;
        if recognized && !both_dc && ctx.accounts.config.reward_numerator > 0 {
            a_reward = reward_for_side(
                &ctx.accounts.config,
                &ctx.accounts.registry,
                ctx.accounts.terms.a_swap,
                ctx.accounts.deal.a_swap_amount,
                &ctx.accounts.wrapped_native_pair,
                &ctx.accounts.stable0_pair,
                &ctx.accounts.stable1_pair,
                &mut ctx.accounts.wrapped_native_observation,
                &mut ctx.accounts.stable0_observation,
                &mut ctx.accounts.stable1_observation,
            )?;
            b_reward = reward_for_side(
                &ctx.accounts.config,
                &ctx.accounts.registry,
                ctx.accounts.terms.b_swap,
                ctx.accounts.deal.b_swap_amount,
                &ctx.accounts.wrapped_native_pair,
                &ctx.accounts.stable0_pair,
                &ctx.accounts.stable1_pair,
                &mut ctx.accounts.wrapped_native_observation,
                &mut ctx.accounts.stable0_observation,
                &mut ctx.accounts.stable1_observation,
            )?;
        }

        let prepared_at = Clock::get()?.unix_timestamp;
        let quote = &mut ctx.accounts.quote;
        quote.deal = ctx.accounts.deal.key();
        quote.registry_revision = ctx.accounts.registry.revision;
        quote.a_reward = a_reward;
        quote.b_reward = b_reward;
        quote.prepared_at = prepared_at;
        quote.bump = ctx.bumps.quote;
        emit!(DealRewardsQuoted {
            deal: quote.deal,
            registry_revision: quote.registry_revision,
            a_reward,
            b_reward,
            prepared_at,
        });
        if ctx.accounts.asset_config.terminal_guard_enabled {
            let following = [
                ExpectedInstruction::anchor(crate::ID, MINT_COMPLETED_REWARDS_DISC)
                    .account(3, ctx.accounts.deal.key())
                    .account(4, ctx.accounts.quote.key()),
            ];
            validate_current_and_following(
                &ctx.accounts.instructions_sysvar.to_account_info(),
                crate::ID,
                PREPARE_COMPLETED_REWARDS_DISC,
                &following,
            )?;
        }
        Ok(())
    }

    pub fn mint_completed_rewards(ctx: Context<MintCompletedRewards>) -> Result<()> {
        require!(!ctx.accounts.config.paused, RewardError::Paused);
        require!(
            ctx.accounts.deal.status == DealStatus::Completed,
            RewardError::DealNotCompleted
        );
        require_keys_eq!(
            ctx.accounts.quote.deal,
            ctx.accounts.deal.key(),
            RewardError::InvalidRewardQuote
        );
        require_keys_eq!(
            ctx.accounts.dc_controller_config.key(),
            ctx.accounts.config.dc_controller,
            RewardError::InvalidDcController
        );
        validate_dc_destination(
            &ctx.accounts.a_dc_destination,
            ctx.accounts.config.dc_mint,
            ctx.accounts.deal.creator,
        )?;
        validate_dc_destination(
            &ctx.accounts.b_dc_destination,
            ctx.accounts.config.dc_mint,
            ctx.accounts.deal.participant,
        )?;
        let a_reward = ctx.accounts.quote.a_reward;
        let b_reward = ctx.accounts.quote.b_reward;

        let a_identity = validate_identity_side(IdentitySideAccounts {
            deal_key: ctx.accounts.deal.key(),
            deal: &ctx.accounts.deal,
            is_a: true,
            identity_key: ctx.accounts.a_identity.as_ref().map(|value| value.key()),
            identity: ctx.accounts.a_identity.as_deref().map(|value| &**value),
            owner_token: ctx
                .accounts
                .a_identity_token
                .as_deref()
                .map(|value| &**value),
            binding_key: ctx.accounts.a_binding.as_ref().map(|value| value.key()),
            binding: ctx.accounts.a_binding.as_deref().map(|value| &**value),
            credit_account: ctx.accounts.a_credit.as_ref(),
        })?;
        let b_identity = validate_identity_side(IdentitySideAccounts {
            deal_key: ctx.accounts.deal.key(),
            deal: &ctx.accounts.deal,
            is_a: false,
            identity_key: ctx.accounts.b_identity.as_ref().map(|value| value.key()),
            identity: ctx.accounts.b_identity.as_deref().map(|value| &**value),
            owner_token: ctx
                .accounts
                .b_identity_token
                .as_deref()
                .map(|value| &**value),
            binding_key: ctx.accounts.b_binding.as_ref().map(|value| value.key()),
            binding: ctx.accounts.b_binding.as_deref().map(|value| &**value),
            credit_account: ctx.accounts.b_credit.as_ref(),
        })?;
        require_keys_eq!(
            ctx.accounts.terms.a_identity_mint,
            a_identity.mint,
            RewardError::InvalidIdentity
        );
        require_keys_eq!(
            ctx.accounts.terms.b_identity_mint,
            b_identity.mint,
            RewardError::InvalidIdentity
        );
        let (c_identity, c_score) = if a_reward > 0 || b_reward > 0 {
            resolve_c(a_identity, b_identity)
        } else {
            (Pubkey::default(), 0)
        };
        let c_reward = if c_identity == Pubkey::default() {
            0
        } else {
            a_reward
                .checked_add(b_reward)
                .ok_or(RewardError::ArithmeticOverflow)?
        };
        let c_recipient = validate_c_recipient(
            c_identity,
            ctx.accounts.c_identity.as_ref().map(|value| value.key()),
            ctx.accounts.c_identity.as_deref().map(|value| &**value),
            ctx.accounts
                .c_identity_token
                .as_deref()
                .map(|value| &**value),
            ctx.accounts
                .c_dc_destination
                .as_deref()
                .map(|value| &**value),
            ctx.accounts.config.dc_mint,
        )?;

        let reward_minter_bump = ctx.bumps.reward_minter;

        mint_dc(
            a_reward,
            ctx.accounts,
            &ctx.accounts.a_dc_destination.to_account_info(),
            reward_minter_bump,
        )?;
        mint_dc(
            b_reward,
            ctx.accounts,
            &ctx.accounts.b_dc_destination.to_account_info(),
            reward_minter_bump,
        )?;
        if let Some(destination) = ctx.accounts.c_dc_destination.as_deref() {
            mint_dc(
                c_reward,
                ctx.accounts,
                &destination.to_account_info(),
                reward_minter_bump,
            )?;
        }

        let minted_at = Clock::get()?.unix_timestamp;
        let receipt = &mut ctx.accounts.receipt;
        receipt.deal = ctx.accounts.deal.key();
        receipt.registry_revision = ctx.accounts.quote.registry_revision;
        receipt.a_identity_mint = a_identity.mint;
        receipt.b_identity_mint = b_identity.mint;
        receipt.c_identity_mint = c_identity;
        receipt.c_recipient = c_recipient;
        receipt.a_reward = a_reward;
        receipt.b_reward = b_reward;
        receipt.c_reward = c_reward;
        receipt.c_score_snapshot = c_score;
        receipt.minted_at = minted_at;
        receipt.bump = ctx.bumps.receipt;
        emit!(DealRewardsMinted {
            deal: receipt.deal,
            party_a: ctx.accounts.deal.creator,
            party_b: ctx.accounts.deal.participant,
            a_reward,
            b_reward,
            c_reward,
            c_identity_mint: c_identity,
            c_recipient,
            minted_at,
        });
        validate_minted_reward_sequence(ctx.accounts)
    }

    pub fn record_identity_reward(ctx: Context<RecordIdentityReward>, role: u8) -> Result<()> {
        require!(!ctx.accounts.config.paused, RewardError::Paused);
        require_keys_eq!(
            ctx.accounts.reward_receipt.deal,
            ctx.accounts.deal.key(),
            RewardError::InvalidRewardReceipt
        );
        let (identity_mint, amount) = reward_role(&ctx.accounts.reward_receipt, role)?;
        require!(amount > 0, RewardError::ZeroReward);
        require_keys_eq!(
            ctx.accounts.identity.mint,
            identity_mint,
            RewardError::InvalidIdentity
        );
        require_keys_eq!(
            ctx.accounts.identity_config.reward_controller,
            ctx.accounts.reward_minter.key(),
            RewardError::InvalidIdentityController
        );

        let minter_seeds: &[&[u8]] = &[MINTER_SEED, &[ctx.bumps.reward_minter]];
        deal_identity::cpi::add_reward_minted(
            CpiContext::new_with_signer(
                ctx.accounts.identity_program.key(),
                deal_identity::cpi::accounts::ControllerIdentity {
                    config: ctx.accounts.identity_config.to_account_info(),
                    controller: ctx.accounts.reward_minter.to_account_info(),
                    identity: ctx.accounts.identity.to_account_info(),
                },
                &[minter_seeds],
            ),
            amount,
        )?;

        let recorded_at = Clock::get()?.unix_timestamp;
        let receipt = &mut ctx.accounts.identity_receipt;
        receipt.deal = ctx.accounts.deal.key();
        receipt.identity_mint = identity_mint;
        receipt.amount = amount;
        receipt.role = role;
        receipt.recorded_at = recorded_at;
        receipt.bump = ctx.bumps.identity_receipt;
        emit!(IdentityRewardRecorded {
            deal: receipt.deal,
            identity_mint,
            amount,
            role,
            recorded_at,
        });
        Ok(())
    }
}

fn validate_minted_reward_sequence(accounts: &MintCompletedRewards<'_>) -> Result<()> {
    if !accounts.asset_config.terminal_guard_enabled {
        return Ok(());
    }
    let deal = accounts.deal.key();
    let credit = match (
        accounts.terms.a_identity_mint != Pubkey::default(),
        accounts.terms.b_identity_mint != Pubkey::default(),
    ) {
        (true, true) => {
            ExpectedInstruction::anchor(FINALIZER_PROGRAM_ID, RECORD_COMPLETED_CREDIT_DISC)
                .account(3, deal)
        }
        (true, false) => {
            ExpectedInstruction::anchor(FINALIZER_PROGRAM_ID, RECORD_COMPLETED_CREDIT_SINGLE_DISC)
                .account(3, deal)
                .byte_argument(8, 1)
        }
        (false, true) => {
            ExpectedInstruction::anchor(FINALIZER_PROGRAM_ID, RECORD_COMPLETED_CREDIT_SINGLE_DISC)
                .account(3, deal)
                .byte_argument(8, 0)
        }
        (false, false) => {
            ExpectedInstruction::anchor(FINALIZER_PROGRAM_ID, RECORD_COMPLETED_CREDIT_NONE_DISC)
                .account(2, deal)
        }
    };
    validate_current_and_following(
        &accounts.instructions_sysvar.to_account_info(),
        crate::ID,
        MINT_COMPLETED_REWARDS_DISC,
        &[credit],
    )
    .map_err(Into::into)
}

fn assert_authority(config: &RewardConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(config.authority, authority.key(), RewardError::Unauthorized);
    Ok(())
}

fn validate_window(min_window_seconds: u32) -> Result<()> {
    require!(
        (1..=MAX_MIN_WINDOW_SECONDS).contains(&min_window_seconds),
        RewardError::InvalidWindow
    );
    Ok(())
}

fn validate_reward_rate(
    numerator: u32,
    denominator: u32,
    asset_config: &ControllerConfig,
) -> Result<()> {
    require!(
        denominator > 0 && numerator < denominator,
        RewardError::InvalidRewardRate
    );
    require!(
        asset_config.fee_denominator > 0,
        RewardError::InvalidProtocolFee
    );
    let reward_worst = u128::from(numerator)
        .checked_mul(3)
        .and_then(|value| value.checked_mul(u128::from(asset_config.fee_denominator)))
        .ok_or(RewardError::ArithmeticOverflow)?;
    let fee = u128::from(asset_config.fee_numerator)
        .checked_mul(u128::from(denominator))
        .ok_or(RewardError::ArithmeticOverflow)?;
    require!(reward_worst <= fee, RewardError::RewardExceedsFee);
    Ok(())
}

fn side_is_recognized(registry: &SwapAssetRegistry, asset: AssetSpec) -> bool {
    match asset.kind {
        AssetKind::None => true,
        AssetKind::Native => true,
        AssetKind::Spl => {
            asset.mint == registry.dc_mint
                || asset.mint == registry.wrapped_native_mint
                || asset.mint == registry.stable0_mint
                || asset.mint == registry.stable1_mint
        }
    }
}

fn is_dc(registry: &SwapAssetRegistry, asset: AssetSpec) -> bool {
    asset.kind == AssetKind::Spl && asset.mint == registry.dc_mint
}

fn reward_basis(config: &RewardConfig, amount: u64) -> Result<u64> {
    let value = u128::from(amount)
        .checked_mul(u128::from(config.reward_numerator))
        .ok_or(RewardError::ArithmeticOverflow)?
        .checked_div(u128::from(config.reward_denominator))
        .ok_or(RewardError::ArithmeticOverflow)?;
    u64::try_from(value).map_err(|_| error!(RewardError::ArithmeticOverflow))
}

#[allow(clippy::too_many_arguments)]
fn reward_for_side(
    config: &RewardConfig,
    registry: &SwapAssetRegistry,
    asset: AssetSpec,
    amount: u64,
    wrapped_native_pair: &UncheckedAccount<'_>,
    stable0_pair: &UncheckedAccount<'_>,
    stable1_pair: &UncheckedAccount<'_>,
    wrapped_native_observation: &mut Account<'_, TwapObservation>,
    stable0_observation: &mut Account<'_, TwapObservation>,
    stable1_observation: &mut Account<'_, TwapObservation>,
) -> Result<u64> {
    if amount == 0 || asset.kind == AssetKind::None {
        return Ok(0);
    }
    let basis = reward_basis(config, amount)?;
    if basis == 0 {
        return Ok(0);
    }
    // ETH DealLib only rewards WNATIVE / recognized stable sides. DC is
    // allowed in a mixed pair, but the DC side itself never earns a reward.
    if is_dc(registry, asset) {
        return Ok(0);
    }
    match asset.kind {
        AssetKind::Native => quote_pair_to_dc(
            registry,
            wrapped_native_pair,
            wrapped_native_observation,
            registry.wrapped_native_pair,
            registry.wrapped_native_mint,
            basis,
            config.min_window_seconds,
        ),
        AssetKind::Spl if asset.mint == registry.wrapped_native_mint => quote_pair_to_dc(
            registry,
            wrapped_native_pair,
            wrapped_native_observation,
            registry.wrapped_native_pair,
            registry.wrapped_native_mint,
            basis,
            config.min_window_seconds,
        ),
        AssetKind::Spl if asset.mint == registry.stable0_mint => quote_pair_to_dc(
            registry,
            stable0_pair,
            stable0_observation,
            registry.stable0_pair,
            registry.stable0_mint,
            basis,
            config.min_window_seconds,
        ),
        AssetKind::Spl if asset.mint == registry.stable1_mint => quote_pair_to_dc(
            registry,
            stable1_pair,
            stable1_observation,
            registry.stable1_pair,
            registry.stable1_mint,
            basis,
            config.min_window_seconds,
        ),
        _ => Ok(0),
    }
}

fn quote_pair_to_dc(
    registry: &SwapAssetRegistry,
    pair_account: &UncheckedAccount<'_>,
    observation: &mut Account<'_, TwapObservation>,
    expected_pair: Pubkey,
    expected_other_mint: Pubkey,
    amount: u64,
    min_window_seconds: u32,
) -> Result<u64> {
    require_keys_eq!(pair_account.key(), expected_pair, RewardError::InvalidPair);
    require_keys_eq!(
        *pair_account.owner,
        registry.pair_program,
        RewardError::InvalidPairOwner
    );
    let data = pair_account.try_borrow_data()?;
    let pair = PairState::try_deserialize(&mut data.as_ref())
        .map_err(|_| error!(RewardError::InvalidPairData))?;
    require_keys_eq!(pair.dc_mint, registry.dc_mint, RewardError::InvalidPair);
    require_keys_eq!(
        pair.other_mint,
        expected_other_mint,
        RewardError::InvalidPair
    );
    require!(pair.liquidity_initialized, RewardError::PairNotInitialized);
    require_keys_eq!(
        observation.pair,
        expected_pair,
        RewardError::InvalidObservation
    );

    let now = Clock::get()?.unix_timestamp;
    require!(now >= pair.last_timestamp, RewardError::InvalidTimestamp);
    let (reserve0, reserve1) = deal_dex_pair::effective_reserves(&pair)?;
    require!(
        reserve0 > 0 && reserve1 > 0,
        RewardError::PairNotInitialized
    );
    let spot = u128::from(reserve0)
        .checked_mul(PRICE_SCALE)
        .ok_or(RewardError::ArithmeticOverflow)?
        .checked_div(u128::from(reserve1))
        .ok_or(RewardError::ArithmeticOverflow)?;
    let pair_elapsed = u128::try_from(now - pair.last_timestamp)
        .map_err(|_| error!(RewardError::InvalidTimestamp))?;
    let cumulative_now = pair
        .price1_cumulative
        .wrapping_add(spot.wrapping_mul(pair_elapsed));

    let average = if !observation.initialized {
        observation.cumulative = cumulative_now;
        observation.timestamp = now;
        observation.last_average = spot;
        observation.initialized = true;
        spot
    } else {
        require!(now >= observation.timestamp, RewardError::InvalidTimestamp);
        let elapsed = u64::try_from(now - observation.timestamp)
            .map_err(|_| error!(RewardError::InvalidTimestamp))?;
        if elapsed < u64::from(min_window_seconds) {
            observation.last_average
        } else {
            let average = cumulative_now
                .wrapping_sub(observation.cumulative)
                .checked_div(u128::from(elapsed))
                .ok_or(RewardError::ArithmeticOverflow)?;
            observation.cumulative = cumulative_now;
            observation.timestamp = now;
            observation.last_average = average;
            average
        }
    };
    let output = u128::from(amount)
        .checked_mul(average)
        .ok_or(RewardError::ArithmeticOverflow)?
        .checked_div(PRICE_SCALE)
        .ok_or(RewardError::ArithmeticOverflow)?;
    u64::try_from(output).map_err(|_| error!(RewardError::ArithmeticOverflow))
}

fn initialize_observation(observation: &mut Account<'_, TwapObservation>, pair: Pubkey, bump: u8) {
    if observation.pair == Pubkey::default() {
        observation.pair = pair;
        observation.bump = bump;
    }
}

#[derive(Clone, Copy, Default)]
struct IdentityCandidate {
    mint: Pubkey,
    owner: Pubkey,
    candidate_mint: Pubkey,
    score: u128,
}

struct IdentitySideAccounts<'a, 'info> {
    deal_key: Pubkey,
    deal: &'a DealAccount,
    is_a: bool,
    identity_key: Option<Pubkey>,
    identity: Option<&'a IdentityRecord>,
    owner_token: Option<&'a TokenAccount>,
    binding_key: Option<Pubkey>,
    binding: Option<&'a deal_identity::DealIdentityBinding>,
    credit_account: Option<&'a UncheckedAccount<'info>>,
}

fn validate_identity_side(accounts: IdentitySideAccounts<'_, '_>) -> Result<IdentityCandidate> {
    let IdentitySideAccounts {
        deal_key,
        deal,
        is_a,
        identity_key,
        identity,
        owner_token,
        binding_key,
        binding,
        credit_account,
    } = accounts;
    let (
        Some(identity_key),
        Some(identity),
        Some(owner_token),
        Some(binding_key),
        Some(binding),
        Some(credit_account),
    ) = (
        identity_key,
        identity,
        owner_token,
        binding_key,
        binding,
        credit_account,
    )
    else {
        require!(
            identity_key.is_none()
                && identity.is_none()
                && owner_token.is_none()
                && binding_key.is_none()
                && binding.is_none()
                && credit_account.is_none(),
            RewardError::IncompleteIdentityAccounts
        );
        return Ok(IdentityCandidate::default());
    };
    let party = if is_a { deal.creator } else { deal.participant };
    let (expected_identity, _) = Pubkey::find_program_address(
        &[deal_identity::IDENTITY_SEED, identity.mint.as_ref()],
        &deal_identity::id(),
    );
    require_keys_eq!(
        identity_key,
        expected_identity,
        RewardError::InvalidIdentity
    );
    require_keys_eq!(
        owner_token.mint,
        identity.mint,
        RewardError::InvalidIdentityOwner
    );
    require_keys_eq!(owner_token.owner, party, RewardError::InvalidIdentityOwner);
    require_eq!(owner_token.amount, 1, RewardError::InvalidIdentityOwner);
    let (expected_binding, _) = Pubkey::find_program_address(
        &[
            deal_identity::BINDING_SEED,
            deal_key.as_ref(),
            party.as_ref(),
        ],
        &deal_identity::id(),
    );
    require_keys_eq!(
        binding_key,
        expected_binding,
        RewardError::InvalidIdentityBinding
    );
    require_keys_eq!(binding.deal, deal_key, RewardError::InvalidIdentityBinding);
    require_keys_eq!(binding.party, party, RewardError::InvalidIdentityBinding);
    require_keys_eq!(
        binding.identity_mint,
        identity.mint,
        RewardError::InvalidIdentityBinding
    );
    require!(
        binding.lock_count > 0 && identity.lock_count > 0,
        RewardError::InvalidIdentityBinding
    );

    let (expected_credit, _) = Pubkey::find_program_address(
        &[SCORE_SEED, identity.mint.as_ref()],
        &deal_credit_graph::id(),
    );
    require_keys_eq!(
        credit_account.key(),
        expected_credit,
        RewardError::InvalidCredit
    );
    let (candidate_mint, score) = load_best_candidate(identity.mint, credit_account)?;
    Ok(IdentityCandidate {
        mint: identity.mint,
        owner: party,
        candidate_mint,
        score,
    })
}

fn load_best_candidate(
    identity_mint: Pubkey,
    credit_account: &UncheckedAccount<'_>,
) -> Result<(Pubkey, u128)> {
    if credit_account.data_is_empty() {
        return Ok((identity_mint, 0));
    }
    require_keys_eq!(
        *credit_account.owner,
        deal_credit_graph::id(),
        RewardError::InvalidCredit
    );
    let data = credit_account.try_borrow_data()?;
    let credit = CreditScore::try_deserialize(&mut data.as_ref())
        .map_err(|_| error!(RewardError::InvalidCredit))?;
    require_keys_eq!(
        credit.identity_mint,
        identity_mint,
        RewardError::InvalidCredit
    );
    let mut candidate = identity_mint;
    let mut score = credit.score;
    for peer in credit.top_peers {
        if peer.identity_mint != Pubkey::default() && peer.credit_snapshot > score {
            candidate = peer.identity_mint;
            score = peer.credit_snapshot;
        }
    }
    Ok((candidate, score))
}

fn resolve_c(a: IdentityCandidate, b: IdentityCandidate) -> (Pubkey, u128) {
    if a.mint == Pubkey::default() && b.mint == Pubkey::default() {
        return (Pubkey::default(), 0);
    }
    if a.mint != Pubkey::default() && b.mint != Pubkey::default() && a.owner == b.owner {
        return (Pubkey::default(), 0);
    }
    if a.score == 0 && b.score == 0 {
        return (Pubkey::default(), 0);
    }
    if a.score > b.score {
        return (a.candidate_mint, a.score);
    }
    if b.score > a.score {
        return (b.candidate_mint, b.score);
    }
    (Pubkey::default(), 0)
}

fn validate_c_recipient(
    expected_mint: Pubkey,
    identity_key: Option<Pubkey>,
    identity: Option<&IdentityRecord>,
    owner_token: Option<&TokenAccount>,
    dc_destination: Option<&TokenAccount>,
    dc_mint: Pubkey,
) -> Result<Pubkey> {
    if expected_mint == Pubkey::default() {
        require!(
            identity_key.is_none()
                && identity.is_none()
                && owner_token.is_none()
                && dc_destination.is_none(),
            RewardError::UnexpectedCAccounts
        );
        return Ok(Pubkey::default());
    }
    let (Some(identity_key), Some(identity), Some(owner_token), Some(dc_destination)) =
        (identity_key, identity, owner_token, dc_destination)
    else {
        return err!(RewardError::MissingCAccounts);
    };
    require_keys_eq!(identity.mint, expected_mint, RewardError::InvalidCIdentity);
    let (expected_identity, _) = Pubkey::find_program_address(
        &[deal_identity::IDENTITY_SEED, identity.mint.as_ref()],
        &deal_identity::id(),
    );
    require_keys_eq!(
        identity_key,
        expected_identity,
        RewardError::InvalidCIdentity
    );
    require_keys_eq!(
        owner_token.mint,
        expected_mint,
        RewardError::InvalidCRecipient
    );
    require_eq!(owner_token.amount, 1, RewardError::InvalidCRecipient);
    require_keys_eq!(dc_destination.mint, dc_mint, RewardError::InvalidCRecipient);
    require_keys_eq!(
        dc_destination.owner,
        owner_token.owner,
        RewardError::InvalidCRecipient
    );
    Ok(owner_token.owner)
}

fn validate_dc_destination(
    destination: &TokenAccount,
    dc_mint: Pubkey,
    owner: Pubkey,
) -> Result<()> {
    require_keys_eq!(destination.mint, dc_mint, RewardError::InvalidDcDestination);
    require_keys_eq!(destination.owner, owner, RewardError::InvalidDcDestination);
    Ok(())
}

fn mint_dc<'info>(
    amount: u64,
    accounts: &MintCompletedRewards<'info>,
    destination: &AccountInfo<'info>,
    reward_minter_bump: u8,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let minter_seeds: &[&[u8]] = &[MINTER_SEED, &[reward_minter_bump]];
    deal_dc_controller::cpi::mint(
        CpiContext::new_with_signer(
            accounts.dc_controller_program.key(),
            deal_dc_controller::cpi::accounts::MintDc {
                config: accounts.dc_controller_config.to_account_info(),
                minter: accounts.reward_minter.to_account_info(),
                grant: accounts.dc_minter_grant.to_account_info(),
                dc_mint: accounts.dc_mint.to_account_info(),
                destination: destination.clone(),
                dc_token_program: accounts.dc_token_program.to_account_info(),
            },
            &[minter_seeds],
        ),
        amount,
    )
}

fn reward_role(receipt: &RewardReceipt, role: u8) -> Result<(Pubkey, u64)> {
    match role {
        0 => Ok((receipt.a_identity_mint, receipt.a_reward)),
        1 => Ok((receipt.b_identity_mint, receipt.b_reward)),
        2 => Ok((receipt.c_identity_mint, receipt.c_reward)),
        _ => err!(RewardError::InvalidRole),
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = RewardConfig::SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, RewardConfig>,
    /// CHECK: Canonical signer used for DC minting and identity reward totals.
    #[account(seeds = [MINTER_SEED], bump)]
    pub reward_minter: UncheckedAccount<'info>,
    #[account(
        seeds = [deal_asset_controller::CONTROLLER_SEED],
        bump = asset_config.bump,
        seeds::program = deal_asset_controller::ID
    )]
    pub asset_config: Account<'info, ControllerConfig>,
    #[account(
        seeds = [deal_swap_asset_registry::REGISTRY_SEED],
        bump = registry.bump,
        seeds::program = deal_swap_asset_registry::ID
    )]
    pub registry: Account<'info, SwapAssetRegistry>,
    #[account(
        seeds = [deal_dc_controller::CONFIG_SEED],
        bump = dc_controller_config.bump,
        seeds::program = deal_dc_controller::ID
    )]
    pub dc_controller_config: Account<'info, deal_dc_controller::DcControllerConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RewardConfig>,
}

#[derive(Accounts)]
pub struct AdminRewardRate<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RewardConfig>,
    #[account(
        seeds = [deal_asset_controller::CONTROLLER_SEED],
        bump = asset_config.bump,
        seeds::program = deal_asset_controller::ID
    )]
    pub asset_config: Account<'info, ControllerConfig>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RewardConfig>,
}

#[derive(Accounts)]
pub struct PrepareCompletedRewards<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, RewardConfig>>,
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
        seeds = [deal_asset_controller::CONTROLLER_SEED],
        bump = asset_config.bump,
        seeds::program = deal_asset_controller::ID
    )]
    pub asset_config: Box<Account<'info, ControllerConfig>>,
    #[account(
        seeds = [deal_swap_asset_registry::REGISTRY_SEED],
        bump = registry.bump,
        seeds::program = deal_swap_asset_registry::ID
    )]
    pub registry: Box<Account<'info, SwapAssetRegistry>>,
    /// CHECK: Pair owner, address, assets, and data are validated before quoting.
    pub wrapped_native_pair: UncheckedAccount<'info>,
    /// CHECK: Pair owner, address, assets, and data are validated before quoting.
    pub stable0_pair: UncheckedAccount<'info>,
    /// CHECK: Pair owner, address, assets, and data are validated before quoting.
    pub stable1_pair: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = TwapObservation::SPACE,
        seeds = [OBSERVATION_SEED, registry.wrapped_native_pair.as_ref()],
        bump
    )]
    pub wrapped_native_observation: Box<Account<'info, TwapObservation>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = TwapObservation::SPACE,
        seeds = [OBSERVATION_SEED, registry.stable0_pair.as_ref()],
        bump
    )]
    pub stable0_observation: Box<Account<'info, TwapObservation>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = TwapObservation::SPACE,
        seeds = [OBSERVATION_SEED, registry.stable1_pair.as_ref()],
        bump
    )]
    pub stable1_observation: Box<Account<'info, TwapObservation>>,
    #[account(
        init,
        payer = payer,
        space = RewardQuote::SPACE,
        seeds = [QUOTE_SEED, deal.key().as_ref()],
        bump
    )]
    pub quote: Box<Account<'info, RewardQuote>>,
    pub system_program: Program<'info, System>,
    /// CHECK: Address-constrained Solana Instructions sysvar used by the terminal guard.
    #[account(address = deal_terminal_guard::instructions_sysvar_id())]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct MintCompletedRewards<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, RewardConfig>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Canonical reward signer authorized by the DC controller.
    #[account(seeds = [MINTER_SEED], bump)]
    pub reward_minter: UncheckedAccount<'info>,
    pub deal: Box<Account<'info, DealAccount>>,
    #[account(
        seeds = [QUOTE_SEED, deal.key().as_ref()],
        bump = quote.bump
    )]
    pub quote: Box<Account<'info, RewardQuote>>,
    pub a_identity: Option<Box<Account<'info, IdentityRecord>>>,
    pub a_identity_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub a_binding: Option<Box<Account<'info, deal_identity::DealIdentityBinding>>>,
    /// CHECK: Canonical CreditScore PDA is validated and deserialized when present.
    pub a_credit: Option<UncheckedAccount<'info>>,
    pub b_identity: Option<Box<Account<'info, IdentityRecord>>>,
    pub b_identity_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub b_binding: Option<Box<Account<'info, deal_identity::DealIdentityBinding>>>,
    /// CHECK: Canonical CreditScore PDA is validated and deserialized when present.
    pub b_credit: Option<UncheckedAccount<'info>>,
    pub c_identity: Option<Box<Account<'info, IdentityRecord>>>,
    pub c_identity_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut)]
    pub a_dc_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub b_dc_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub c_dc_destination: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut, address = config.dc_mint)]
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [deal_dc_controller::CONFIG_SEED],
        bump = dc_controller_config.bump,
        seeds::program = deal_dc_controller::ID
    )]
    pub dc_controller_config: Box<Account<'info, deal_dc_controller::DcControllerConfig>>,
    #[account(
        seeds = [deal_dc_controller::MINTER_SEED, reward_minter.key().as_ref()],
        bump = dc_minter_grant.bump,
        seeds::program = deal_dc_controller::ID
    )]
    pub dc_minter_grant: Box<Account<'info, deal_dc_controller::MinterGrant>>,
    #[account(address = dc_controller_config.dc_token_program)]
    pub dc_token_program: Interface<'info, TokenInterface>,
    pub dc_controller_program: Program<'info, deal_dc_controller::program::DealDcController>,
    #[account(
        init,
        payer = payer,
        space = RewardReceipt::SPACE,
        seeds = [RECEIPT_SEED, deal.key().as_ref()],
        bump
    )]
    pub receipt: Box<Account<'info, RewardReceipt>>,
    pub system_program: Program<'info, System>,
    #[account(
        seeds = [deal_asset_controller::TERMS_SEED, deal.key().as_ref()],
        bump = terms.bump,
        seeds::program = deal_asset_controller::ID,
        constraint = terms.deal == deal.key()
    )]
    pub terms: Box<Account<'info, AssetTerms>>,
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

#[derive(Accounts)]
#[instruction(role: u8)]
pub struct RecordIdentityReward<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RewardConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Canonical reward signer authorized by Identity.
    #[account(seeds = [MINTER_SEED], bump)]
    pub reward_minter: UncheckedAccount<'info>,
    pub deal: Account<'info, DealAccount>,
    #[account(
        seeds = [RECEIPT_SEED, deal.key().as_ref()],
        bump = reward_receipt.bump
    )]
    pub reward_receipt: Account<'info, RewardReceipt>,
    #[account(
        seeds = [deal_identity::CONFIG_SEED],
        bump = identity_config.bump,
        seeds::program = deal_identity::ID
    )]
    pub identity_config: Account<'info, deal_identity::IdentityConfig>,
    #[account(mut, seeds = [deal_identity::IDENTITY_SEED, identity.mint.as_ref()], bump = identity.bump, seeds::program = deal_identity::ID)]
    pub identity: Account<'info, IdentityRecord>,
    #[account(
        init,
        payer = payer,
        space = IdentityRewardReceipt::SPACE,
        seeds = [IDENTITY_RECEIPT_SEED, deal.key().as_ref(), &[role]],
        bump
    )]
    pub identity_receipt: Account<'info, IdentityRewardReceipt>,
    pub identity_program: Program<'info, deal_identity::program::DealIdentity>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct RewardConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub dc_mint: Pubkey,
    pub dc_controller: Pubkey,
    pub reward_numerator: u32,
    pub reward_denominator: u32,
    pub min_window_seconds: u32,
    pub paused: bool,
    pub bump: u8,
}

impl RewardConfig {
    pub const SPACE: usize = 8 + (32 * 4) + (4 * 3) + 1 + 1;
}

#[account]
pub struct TwapObservation {
    pub pair: Pubkey,
    pub cumulative: u128,
    pub last_average: u128,
    pub timestamp: i64,
    pub initialized: bool,
    pub bump: u8,
}

impl TwapObservation {
    pub const SPACE: usize = 8 + 32 + (16 * 2) + 8 + 1 + 1;
}

#[account]
pub struct RewardQuote {
    pub deal: Pubkey,
    pub registry_revision: u64,
    pub a_reward: u64,
    pub b_reward: u64,
    pub prepared_at: i64,
    pub bump: u8,
}

impl RewardQuote {
    pub const SPACE: usize = 8 + 32 + (8 * 4) + 1;
}

#[account]
pub struct RewardReceipt {
    pub deal: Pubkey,
    pub registry_revision: u64,
    pub a_identity_mint: Pubkey,
    pub b_identity_mint: Pubkey,
    pub c_identity_mint: Pubkey,
    pub c_recipient: Pubkey,
    pub a_reward: u64,
    pub b_reward: u64,
    pub c_reward: u64,
    pub c_score_snapshot: u128,
    pub minted_at: i64,
    pub bump: u8,
}

impl RewardReceipt {
    pub const SPACE: usize = 8 + (32 * 5) + 8 + (8 * 3) + 16 + 8 + 1;
}

#[account]
pub struct IdentityRewardReceipt {
    pub deal: Pubkey,
    pub identity_mint: Pubkey,
    pub amount: u64,
    pub role: u8,
    pub recorded_at: i64,
    pub bump: u8,
}

impl IdentityRewardReceipt {
    pub const SPACE: usize = 8 + (32 * 2) + 8 + 1 + 8 + 1;
}

#[event]
pub struct RewardEngineInitialized {
    pub authority: Pubkey,
    pub dc_mint: Pubkey,
    pub reward_minter: Pubkey,
    pub reward_numerator: u32,
    pub reward_denominator: u32,
    pub min_window_seconds: u32,
}

#[event]
pub struct RewardPauseUpdated {
    pub paused: bool,
}

#[event]
pub struct RewardRateUpdated {
    pub reward_numerator: u32,
    pub reward_denominator: u32,
}

#[event]
pub struct RewardWindowUpdated {
    pub min_window_seconds: u32,
}

#[event]
pub struct RewardAuthorityProposed {
    pub pending_authority: Pubkey,
}

#[event]
pub struct RewardAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct DealRewardsQuoted {
    pub deal: Pubkey,
    pub registry_revision: u64,
    pub a_reward: u64,
    pub b_reward: u64,
    pub prepared_at: i64,
}

#[event]
pub struct DealRewardsMinted {
    pub deal: Pubkey,
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub a_reward: u64,
    pub b_reward: u64,
    pub c_reward: u64,
    pub c_identity_mint: Pubkey,
    pub c_recipient: Pubkey,
    pub minted_at: i64,
}

#[event]
pub struct IdentityRewardRecorded {
    pub deal: Pubkey,
    pub identity_mint: Pubkey,
    pub amount: u64,
    pub role: u8,
    pub recorded_at: i64,
}

#[error_code]
pub enum RewardError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("pending authority is invalid")]
    InvalidPendingAuthority,
    #[msg("reward engine is paused")]
    Paused,
    #[msg("deal is not completed")]
    DealNotCompleted,
    #[msg("asset terms are not resolved")]
    TermsNotResolved,
    #[msg("asset terms do not belong to the deal")]
    InvalidTerms,
    #[msg("swap asset registry is invalid")]
    InvalidRegistry,
    #[msg("DC controller is invalid")]
    InvalidDcController,
    #[msg("reward ratio is invalid")]
    InvalidRewardRate,
    #[msg("protocol fee ratio is invalid")]
    InvalidProtocolFee,
    #[msg("configured rewards can exceed collected protocol fees")]
    RewardExceedsFee,
    #[msg("TWAP minimum window is invalid")]
    InvalidWindow,
    #[msg("pair address or assets are invalid")]
    InvalidPair,
    #[msg("pair owner is invalid")]
    InvalidPairOwner,
    #[msg("pair account data is invalid")]
    InvalidPairData,
    #[msg("pair is not initialized")]
    PairNotInitialized,
    #[msg("TWAP observation is invalid")]
    InvalidObservation,
    #[msg("timestamp is invalid")]
    InvalidTimestamp,
    #[msg("identity account set is incomplete")]
    IncompleteIdentityAccounts,
    #[msg("identity account is invalid")]
    InvalidIdentity,
    #[msg("identity owner is invalid")]
    InvalidIdentityOwner,
    #[msg("identity was not locked to this deal")]
    InvalidIdentityLock,
    #[msg("identity is not the one bound to this deal party")]
    InvalidIdentityBinding,
    #[msg("credit snapshot account is invalid")]
    InvalidCredit,
    #[msg("C identity accounts were supplied when no C exists")]
    UnexpectedCAccounts,
    #[msg("C identity accounts are required")]
    MissingCAccounts,
    #[msg("C identity does not match the selected candidate")]
    InvalidCIdentity,
    #[msg("C recipient is not the current identity owner")]
    InvalidCRecipient,
    #[msg("DC destination does not belong to the expected party")]
    InvalidDcDestination,
    #[msg("reward receipt is invalid")]
    InvalidRewardReceipt,
    #[msg("reward quote is invalid")]
    InvalidRewardQuote,
    #[msg("identity reward controller is invalid")]
    InvalidIdentityController,
    #[msg("reward role must be A, B, or C")]
    InvalidRole,
    #[msg("reward amount is zero")]
    ZeroReward,
    #[msg("arithmetic overflow")]
    ArithmeticOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn controller(fee_numerator: u32, fee_denominator: u32) -> ControllerConfig {
        ControllerConfig {
            authority: Pubkey::new_unique(),
            pending_authority: Pubkey::default(),
            treasury: Pubkey::new_unique(),
            dc_mint: Pubkey::new_unique(),
            fee_numerator,
            fee_denominator,
            terminal_guard_enabled: false,
            paused: false,
            bump: 255,
        }
    }

    #[test]
    fn reward_cap_matches_evm_three_role_limit() {
        let fees = controller(3, 1_000);
        assert!(validate_reward_rate(1, 1_000, &fees).is_ok());
        assert!(validate_reward_rate(2, 1_000, &fees).is_err());
    }

    #[test]
    fn c_selection_uses_highest_snapshot_and_ties_pay_nobody() {
        let a = IdentityCandidate {
            mint: Pubkey::new_unique(),
            owner: Pubkey::new_unique(),
            candidate_mint: Pubkey::new_unique(),
            score: 10_000,
        };
        let mut b = IdentityCandidate {
            mint: Pubkey::new_unique(),
            owner: Pubkey::new_unique(),
            candidate_mint: Pubkey::new_unique(),
            score: 200,
        };
        assert_eq!(resolve_c(a, b), (a.candidate_mint, 10_000));
        b.score = 10_000;
        assert_eq!(resolve_c(a, b), (Pubkey::default(), 0));
    }

    #[test]
    fn same_owner_cannot_receive_c_reward() {
        let owner = Pubkey::new_unique();
        let a = IdentityCandidate {
            mint: Pubkey::new_unique(),
            owner,
            candidate_mint: Pubkey::new_unique(),
            score: 10_000,
        };
        let b = IdentityCandidate {
            mint: Pubkey::new_unique(),
            owner,
            candidate_mint: Pubkey::new_unique(),
            score: 200,
        };
        assert_eq!(resolve_c(a, b), (Pubkey::default(), 0));
    }
}
