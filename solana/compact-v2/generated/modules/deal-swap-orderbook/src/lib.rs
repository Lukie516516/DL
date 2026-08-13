#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
};
use deal_dex_pair::{
    self, effective_reserves, quote_buy_given_in, quote_sell, quote_sell_given_out,
    DexConfig as PairConfig, PairState, CONFIG_SEED as PAIR_CONFIG_SEED, PAIR_SEED,
};

declare_id!("3gsSk16h3xrxDHg5u8SZQek11WcTCLw9Zs6HUeaNBf5S");

pub const CONFIG_SEED: &[u8] = b"orderbook-config";
pub const QUEUE_HEADER_SEED: &[u8] = b"order-queue";
pub const QUEUE_PAGE_SEED: &[u8] = b"order-page";
pub const ORDER_SEED: &[u8] = b"order";
pub const SIDE_SELL_DC: u8 = 0;
pub const SIDE_BUY_DC: u8 = 1;
pub const PAGE_CAPACITY: usize = 32;
pub const CANCEL_FEE_NUMERATOR: u64 = 1;
pub const CANCEL_FEE_DENOMINATOR: u64 = 1_000;

#[program]
pub mod deal_swap_orderbook {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, treasury: Pubkey) -> Result<()> {
        require!(treasury != Pubkey::default(), OrderbookError::ZeroAddress);
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.treasury = treasury;
        config.pair_program = deal_dex_pair::ID;
        config.paused = true;
        config.bump = ctx.bumps.config;
        emit!(OrderbookInitialized {
            authority: config.authority,
            treasury,
            pair_program: config.pair_program,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.paused = paused;
        emit!(OrderbookPauseUpdated { paused });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            OrderbookError::ZeroAddress
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(OrderbookAuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            OrderbookError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = Pubkey::default();
        emit!(OrderbookAuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority,
        });
        Ok(())
    }

    pub fn place_sell_dc(
        ctx: Context<PlaceSellDc>,
        sequence: u64,
        page_no: u32,
        amount_dc_in: u64,
    ) -> Result<u64> {
        require!(!ctx.accounts.config.paused, OrderbookError::Paused);
        require!(amount_dc_in > 0, OrderbookError::ZeroInput);
        validate_pair(
            &ctx.accounts.config,
            &ctx.accounts.pair_config,
            &ctx.accounts.pair,
        )?;
        validate_queue_position(
            &mut ctx.accounts.header,
            &mut ctx.accounts.page,
            ctx.accounts.pair.key(),
            SIDE_SELL_DC,
            sequence,
            page_no,
        )?;
        validate_user_token(
            &ctx.accounts.source_dc,
            ctx.accounts.user.key(),
            ctx.accounts.dc_mint.key(),
        )?;
        validate_user_token(
            &ctx.accounts.destination_other,
            ctx.accounts.user.key(),
            ctx.accounts.other_mint.key(),
        )?;

        transfer_user_to_escrow(
            &ctx.accounts.source_dc,
            &ctx.accounts.escrow_dc,
            &ctx.accounts.dc_mint,
            &ctx.accounts.user,
            &ctx.accounts.dc_token_program,
            amount_dc_in,
        )?;
        initialize_order(
            &mut ctx.accounts.order,
            OrderInit {
                owner: ctx.accounts.user.key(),
                pair: ctx.accounts.pair.key(),
                destination_out: ctx.accounts.destination_other.key(),
                side: SIDE_SELL_DC,
                sequence,
                amount_in: amount_dc_in,
                bump: ctx.bumps.order,
            },
        )?;
        append_queue_entry(
            &mut ctx.accounts.header,
            &mut ctx.accounts.page,
            ctx.accounts.order.key(),
            ctx.accounts.user.key(),
            sequence,
        )?;
        emit!(OrderPlaced {
            order: ctx.accounts.order.key(),
            owner: ctx.accounts.user.key(),
            pair: ctx.accounts.pair.key(),
            side: SIDE_SELL_DC,
            sequence,
            amount_in: amount_dc_in,
        });
        Ok(sequence)
    }

    pub fn place_buy_dc(
        ctx: Context<PlaceBuyDc>,
        sequence: u64,
        page_no: u32,
        amount_other_in: u64,
    ) -> Result<u64> {
        require!(!ctx.accounts.config.paused, OrderbookError::Paused);
        require!(amount_other_in > 0, OrderbookError::ZeroInput);
        validate_pair(
            &ctx.accounts.config,
            &ctx.accounts.pair_config,
            &ctx.accounts.pair,
        )?;
        validate_queue_position(
            &mut ctx.accounts.header,
            &mut ctx.accounts.page,
            ctx.accounts.pair.key(),
            SIDE_BUY_DC,
            sequence,
            page_no,
        )?;
        validate_user_token(
            &ctx.accounts.source_other,
            ctx.accounts.user.key(),
            ctx.accounts.other_mint.key(),
        )?;
        validate_user_token(
            &ctx.accounts.destination_dc,
            ctx.accounts.user.key(),
            ctx.accounts.dc_mint.key(),
        )?;

        transfer_user_to_escrow(
            &ctx.accounts.source_other,
            &ctx.accounts.escrow_other,
            &ctx.accounts.other_mint,
            &ctx.accounts.user,
            &ctx.accounts.other_token_program,
            amount_other_in,
        )?;
        initialize_order(
            &mut ctx.accounts.order,
            OrderInit {
                owner: ctx.accounts.user.key(),
                pair: ctx.accounts.pair.key(),
                destination_out: ctx.accounts.destination_dc.key(),
                side: SIDE_BUY_DC,
                sequence,
                amount_in: amount_other_in,
                bump: ctx.bumps.order,
            },
        )?;
        append_queue_entry(
            &mut ctx.accounts.header,
            &mut ctx.accounts.page,
            ctx.accounts.order.key(),
            ctx.accounts.user.key(),
            sequence,
        )?;
        emit!(OrderPlaced {
            order: ctx.accounts.order.key(),
            owner: ctx.accounts.user.key(),
            pair: ctx.accounts.pair.key(),
            side: SIDE_BUY_DC,
            sequence,
            amount_in: amount_other_in,
        });
        Ok(sequence)
    }

    pub fn settle_sell_dc(ctx: Context<SettleSellDc>) -> Result<SettlementResult> {
        require!(!ctx.accounts.config.paused, OrderbookError::Paused);
        validate_settlement(
            &ctx.accounts.config,
            &ctx.accounts.pair_config,
            &ctx.accounts.pair,
            &ctx.accounts.order,
            &ctx.accounts.header,
            SIDE_SELL_DC,
            ctx.accounts.destination_other.key(),
        )?;
        let fill_in = max_sell_fill(&ctx.accounts.pair, ctx.accounts.order.remaining_in)?;
        require!(fill_in > 0, OrderbookError::NoImmediateLiquidity);
        let (fee_dc, _, amount_other_out) = quote_sell(&ctx.accounts.pair, fill_in)?;
        let signer_seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
        deal_dex_pair::cpi::swap_sell_dc(
            CpiContext::new_with_signer(
                ctx.accounts.pair_program.key(),
                deal_dex_pair::cpi::accounts::SwapSellDc {
                    user: ctx.accounts.config.to_account_info(),
                    config: ctx.accounts.pair_config.to_account_info(),
                    pair: ctx.accounts.pair.to_account_info(),
                    user_dc: ctx.accounts.escrow_dc.to_account_info(),
                    user_other: ctx.accounts.destination_other.to_account_info(),
                    dc_mint: ctx.accounts.dc_mint.to_account_info(),
                    other_mint: ctx.accounts.other_mint.to_account_info(),
                    vault0: ctx.accounts.vault0.to_account_info(),
                    vault1: ctx.accounts.vault1.to_account_info(),
                    dc_token_program: ctx.accounts.dc_token_program.to_account_info(),
                    other_token_program: ctx.accounts.other_token_program.to_account_info(),
                },
                &[signer_seeds],
            ),
            fill_in,
            amount_other_out,
        )?;
        ctx.accounts.pair.reload()?;
        finish_fill(
            &mut ctx.accounts.order,
            &mut ctx.accounts.header,
            fill_in,
            amount_other_out,
            fee_dc,
        )
    }

    pub fn settle_buy_dc(ctx: Context<SettleBuyDc>) -> Result<SettlementResult> {
        require!(!ctx.accounts.config.paused, OrderbookError::Paused);
        validate_settlement(
            &ctx.accounts.config,
            &ctx.accounts.pair_config,
            &ctx.accounts.pair,
            &ctx.accounts.order,
            &ctx.accounts.header,
            SIDE_BUY_DC,
            ctx.accounts.destination_dc.key(),
        )?;
        let fill_in = max_buy_fill(&ctx.accounts.pair, ctx.accounts.order.remaining_in)?;
        require!(fill_in > 0, OrderbookError::NoImmediateLiquidity);
        let (_, fee_dc, dc_out) = quote_buy_given_in(&ctx.accounts.pair, fill_in)?;
        let signer_seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
        deal_dex_pair::cpi::swap_buy_dc(
            CpiContext::new_with_signer(
                ctx.accounts.pair_program.key(),
                deal_dex_pair::cpi::accounts::SwapBuyDc {
                    user: ctx.accounts.config.to_account_info(),
                    config: ctx.accounts.pair_config.to_account_info(),
                    pair: ctx.accounts.pair.to_account_info(),
                    user_other: ctx.accounts.escrow_other.to_account_info(),
                    user_dc: ctx.accounts.destination_dc.to_account_info(),
                    dc_mint: ctx.accounts.dc_mint.to_account_info(),
                    other_mint: ctx.accounts.other_mint.to_account_info(),
                    vault0: ctx.accounts.vault0.to_account_info(),
                    vault1: ctx.accounts.vault1.to_account_info(),
                    dc_token_program: ctx.accounts.dc_token_program.to_account_info(),
                    other_token_program: ctx.accounts.other_token_program.to_account_info(),
                },
                &[signer_seeds],
            ),
            fill_in,
            dc_out,
        )?;
        ctx.accounts.pair.reload()?;
        finish_fill(
            &mut ctx.accounts.order,
            &mut ctx.accounts.header,
            fill_in,
            dc_out,
            fee_dc,
        )
    }

    pub fn cancel_sell_dc(ctx: Context<CancelSellDc>) -> Result<CancelResult> {
        validate_cancellation(
            &ctx.accounts.order,
            &ctx.accounts.owner,
            &ctx.accounts.header,
            ctx.accounts.pair.key(),
            SIDE_SELL_DC,
        )?;
        validate_user_token(
            &ctx.accounts.refund_dc,
            ctx.accounts.owner.key(),
            ctx.accounts.dc_mint.key(),
        )?;
        validate_treasury_token(
            &ctx.accounts.treasury_dc,
            ctx.accounts.config.treasury,
            ctx.accounts.dc_mint.key(),
        )?;
        let result = cancel_from_escrow(
            &ctx.accounts.config,
            &mut ctx.accounts.order,
            &mut ctx.accounts.header,
            &ctx.accounts.escrow_dc,
            &ctx.accounts.refund_dc,
            &ctx.accounts.treasury_dc,
            &ctx.accounts.dc_mint,
            &ctx.accounts.dc_token_program,
        )?;
        emit_cancel(ctx.accounts.order.key(), &ctx.accounts.order, &result);
        Ok(result)
    }

    pub fn cancel_buy_dc(ctx: Context<CancelBuyDc>) -> Result<CancelResult> {
        validate_cancellation(
            &ctx.accounts.order,
            &ctx.accounts.owner,
            &ctx.accounts.header,
            ctx.accounts.pair.key(),
            SIDE_BUY_DC,
        )?;
        validate_user_token(
            &ctx.accounts.refund_other,
            ctx.accounts.owner.key(),
            ctx.accounts.other_mint.key(),
        )?;
        validate_treasury_token(
            &ctx.accounts.treasury_other,
            ctx.accounts.config.treasury,
            ctx.accounts.other_mint.key(),
        )?;
        let result = cancel_from_escrow(
            &ctx.accounts.config,
            &mut ctx.accounts.order,
            &mut ctx.accounts.header,
            &ctx.accounts.escrow_other,
            &ctx.accounts.refund_other,
            &ctx.accounts.treasury_other,
            &ctx.accounts.other_mint,
            &ctx.accounts.other_token_program,
        )?;
        emit_cancel(ctx.accounts.order.key(), &ctx.accounts.order, &result);
        Ok(result)
    }
}

fn assert_authority(config: &OrderbookConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        config.authority,
        authority.key(),
        OrderbookError::Unauthorized
    );
    Ok(())
}

fn validate_pair(
    config: &OrderbookConfig,
    pair_config: &Account<'_, PairConfig>,
    pair: &Account<'_, PairState>,
) -> Result<()> {
    require_keys_eq!(
        config.pair_program,
        deal_dex_pair::ID,
        OrderbookError::InvalidPair
    );
    let (expected_config, _) =
        Pubkey::find_program_address(&[PAIR_CONFIG_SEED], &deal_dex_pair::ID);
    require_keys_eq!(
        pair_config.key(),
        expected_config,
        OrderbookError::InvalidPair
    );
    require_keys_eq!(
        pair.dc_mint,
        pair_config.dc_mint,
        OrderbookError::InvalidPair
    );
    let (expected_pair, _) =
        Pubkey::find_program_address(&[PAIR_SEED, pair.other_mint.as_ref()], &deal_dex_pair::ID);
    require_keys_eq!(pair.key(), expected_pair, OrderbookError::InvalidPair);
    Ok(())
}

fn validate_queue_position(
    header: &mut Account<'_, QueueHeader>,
    page: &mut Account<'_, QueuePage>,
    pair: Pubkey,
    side: u8,
    sequence: u64,
    page_no: u32,
) -> Result<()> {
    if header.pair == Pubkey::default() {
        header.pair = pair;
        header.side = side;
        header.next_sequence = 0;
        header.open_orders = 0;
    }
    require_keys_eq!(header.pair, pair, OrderbookError::InvalidQueue);
    require_eq!(header.side, side, OrderbookError::InvalidQueue);
    require_eq!(
        header.next_sequence,
        sequence,
        OrderbookError::InvalidSequence
    );
    let expected_page = u32::try_from(sequence / PAGE_CAPACITY as u64)
        .map_err(|_| error!(OrderbookError::MathOverflow))?;
    require_eq!(page_no, expected_page, OrderbookError::InvalidPage);
    if page.pair == Pubkey::default() {
        page.pair = pair;
        page.side = side;
        page.page_no = page_no;
        page.entries = Vec::new();
    }
    require_keys_eq!(page.pair, pair, OrderbookError::InvalidPage);
    require_eq!(page.side, side, OrderbookError::InvalidPage);
    require_eq!(page.page_no, page_no, OrderbookError::InvalidPage);
    require!(page.entries.len() < PAGE_CAPACITY, OrderbookError::PageFull);
    Ok(())
}

struct OrderInit {
    owner: Pubkey,
    pair: Pubkey,
    destination_out: Pubkey,
    side: u8,
    sequence: u64,
    amount_in: u64,
    bump: u8,
}

fn initialize_order(order: &mut Account<'_, Order>, init: OrderInit) -> Result<()> {
    order.owner = init.owner;
    order.pair = init.pair;
    order.destination_out = init.destination_out;
    order.side = init.side;
    order.sequence = init.sequence;
    order.remaining_in = init.amount_in;
    order.created_at = Clock::get()?.unix_timestamp;
    order.active = true;
    order.bump = init.bump;
    Ok(())
}

fn append_queue_entry(
    header: &mut Account<'_, QueueHeader>,
    page: &mut Account<'_, QueuePage>,
    order: Pubkey,
    owner: Pubkey,
    sequence: u64,
) -> Result<()> {
    page.entries.push(QueueEntry {
        sequence,
        order,
        owner,
        created_at: Clock::get()?.unix_timestamp,
    });
    header.next_sequence = header
        .next_sequence
        .checked_add(1)
        .ok_or_else(|| error!(OrderbookError::MathOverflow))?;
    header.open_orders = header
        .open_orders
        .checked_add(1)
        .ok_or_else(|| error!(OrderbookError::MathOverflow))?;
    Ok(())
}

fn validate_settlement(
    config: &OrderbookConfig,
    pair_config: &Account<'_, PairConfig>,
    pair: &Account<'_, PairState>,
    order: &Account<'_, Order>,
    header: &Account<'_, QueueHeader>,
    side: u8,
    destination: Pubkey,
) -> Result<()> {
    validate_pair(config, pair_config, pair)?;
    require!(
        order.active && order.remaining_in > 0,
        OrderbookError::InactiveOrder
    );
    require_keys_eq!(order.pair, pair.key(), OrderbookError::InvalidOrder);
    require_eq!(order.side, side, OrderbookError::InvalidOrder);
    require_keys_eq!(
        order.destination_out,
        destination,
        OrderbookError::InvalidDestination
    );
    require_keys_eq!(header.pair, pair.key(), OrderbookError::InvalidQueue);
    require_eq!(header.side, side, OrderbookError::InvalidQueue);
    Ok(())
}

fn max_sell_fill(pair: &PairState, remaining: u64) -> Result<u64> {
    if pair.reserve1 <= 1 {
        return Ok(0);
    }
    let (max_in, _, _) = quote_sell_given_out(pair, pair.reserve1 - 1)?;
    Ok(remaining.min(max_in))
}

fn max_buy_fill(pair: &PairState, remaining: u64) -> Result<u64> {
    if pair.reserve0 <= 1 {
        return Ok(0);
    }
    let (effective0, effective1) = effective_reserves(pair)?;
    let virtual0 = effective0
        .checked_sub(pair.reserve0)
        .ok_or_else(|| error!(OrderbookError::MathOverflow))?;
    if virtual0 == 0 {
        return Ok(remaining);
    }
    let numerator = u128::from(pair.reserve0)
        .checked_mul(u128::from(effective1))
        .and_then(|value| value.checked_sub(1))
        .ok_or_else(|| error!(OrderbookError::MathOverflow))?;
    let max_in = u64::try_from(numerator / u128::from(virtual0))
        .map_err(|_| error!(OrderbookError::MathOverflow))?;
    Ok(remaining.min(max_in))
}

fn finish_fill(
    order: &mut Account<'_, Order>,
    header: &mut Account<'_, QueueHeader>,
    filled_in: u64,
    filled_out: u64,
    fee_dc: u64,
) -> Result<SettlementResult> {
    order.remaining_in = order
        .remaining_in
        .checked_sub(filled_in)
        .ok_or_else(|| error!(OrderbookError::MathOverflow))?;
    let completed = order.remaining_in == 0;
    if completed {
        order.active = false;
        header.open_orders = header
            .open_orders
            .checked_sub(1)
            .ok_or_else(|| error!(OrderbookError::MathOverflow))?;
    }
    let result = SettlementResult {
        filled_in,
        filled_out,
        fee_dc,
        remaining_in: order.remaining_in,
        completed,
    };
    emit!(OrderSettled {
        order: order.key(),
        pair: order.pair,
        side: order.side,
        filled_in,
        filled_out,
        fee_dc,
        remaining_in: result.remaining_in,
        completed,
    });
    Ok(result)
}

fn validate_cancellation(
    order: &Account<'_, Order>,
    owner: &Signer<'_>,
    header: &Account<'_, QueueHeader>,
    pair: Pubkey,
    side: u8,
) -> Result<()> {
    require!(
        order.active && order.remaining_in > 0,
        OrderbookError::InactiveOrder
    );
    require_keys_eq!(order.owner, owner.key(), OrderbookError::Unauthorized);
    require_keys_eq!(order.pair, pair, OrderbookError::InvalidOrder);
    require_eq!(order.side, side, OrderbookError::InvalidOrder);
    require_keys_eq!(header.pair, pair, OrderbookError::InvalidQueue);
    require_eq!(header.side, side, OrderbookError::InvalidQueue);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn cancel_from_escrow<'info>(
    config: &Account<'info, OrderbookConfig>,
    order: &mut Account<'info, Order>,
    header: &mut Account<'info, QueueHeader>,
    escrow: &InterfaceAccount<'info, TokenAccount>,
    refund: &InterfaceAccount<'info, TokenAccount>,
    treasury: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<CancelResult> {
    let amount = order.remaining_in;
    let fee = amount
        .checked_mul(CANCEL_FEE_NUMERATOR)
        .ok_or_else(|| error!(OrderbookError::MathOverflow))?
        / CANCEL_FEE_DENOMINATOR;
    let refunded = amount
        .checked_sub(fee)
        .ok_or_else(|| error!(OrderbookError::MathOverflow))?;
    let signer_seeds: &[&[u8]] = &[CONFIG_SEED, &[config.bump]];
    if fee > 0 {
        transfer_from_escrow(
            config,
            escrow,
            treasury,
            mint,
            token_program,
            fee,
            signer_seeds,
        )?;
    }
    if refunded > 0 {
        transfer_from_escrow(
            config,
            escrow,
            refund,
            mint,
            token_program,
            refunded,
            signer_seeds,
        )?;
    }
    order.remaining_in = 0;
    order.active = false;
    header.open_orders = header
        .open_orders
        .checked_sub(1)
        .ok_or_else(|| error!(OrderbookError::MathOverflow))?;
    Ok(CancelResult {
        refunded,
        fee_to_treasury: fee,
    })
}

fn emit_cancel(order_key: Pubkey, order: &Order, result: &CancelResult) {
    emit!(OrderCanceled {
        order: order_key,
        owner: order.owner,
        pair: order.pair,
        side: order.side,
        refunded: result.refunded,
        fee_to_treasury: result.fee_to_treasury,
    });
}

fn transfer_user_to_escrow<'info>(
    source: &InterfaceAccount<'info, TokenAccount>,
    escrow: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    user: &Signer<'info>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from: source.to_account_info(),
                mint: mint.to_account_info(),
                to: escrow.to_account_info(),
                authority: user.to_account_info(),
            },
        ),
        amount,
        mint.decimals,
    )
}

fn transfer_from_escrow<'info>(
    config: &Account<'info, OrderbookConfig>,
    escrow: &InterfaceAccount<'info, TokenAccount>,
    destination: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: escrow.to_account_info(),
                mint: mint.to_account_info(),
                to: destination.to_account_info(),
                authority: config.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
        mint.decimals,
    )
}

fn validate_user_token(account: &TokenAccount, owner: Pubkey, mint: Pubkey) -> Result<()> {
    require_keys_eq!(account.owner, owner, OrderbookError::InvalidTokenAccount);
    require_keys_eq!(account.mint, mint, OrderbookError::InvalidTokenAccount);
    Ok(())
}

fn validate_treasury_token(account: &TokenAccount, treasury: Pubkey, mint: Pubkey) -> Result<()> {
    require_keys_eq!(
        account.owner,
        treasury,
        OrderbookError::InvalidTreasuryAccount
    );
    require_keys_eq!(account.mint, mint, OrderbookError::InvalidTreasuryAccount);
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(init, payer = payer, space = OrderbookConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, OrderbookConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, OrderbookConfig>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, OrderbookConfig>,
}

#[derive(Accounts)]
#[instruction(sequence: u64, page_no: u32)]
pub struct PlaceSellDc<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, OrderbookConfig>,
    pub pair_config: Box<Account<'info, PairConfig>>,
    pub pair: Box<Account<'info, PairState>>,
    #[account(
        init_if_needed,
        payer = user,
        space = QueueHeader::SPACE,
        seeds = [QUEUE_HEADER_SEED, pair.key().as_ref(), &[SIDE_SELL_DC]],
        bump
    )]
    pub header: Account<'info, QueueHeader>,
    #[account(
        init_if_needed,
        payer = user,
        space = QueuePage::SPACE,
        seeds = [QUEUE_PAGE_SEED, pair.key().as_ref(), &[SIDE_SELL_DC], &page_no.to_le_bytes()],
        bump
    )]
    pub page: Account<'info, QueuePage>,
    #[account(
        init,
        payer = user,
        space = Order::SPACE,
        seeds = [ORDER_SEED, pair.key().as_ref(), &[SIDE_SELL_DC], &sequence.to_le_bytes()],
        bump
    )]
    pub order: Account<'info, Order>,
    #[account(mut)]
    pub source_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    pub destination_other: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = dc_mint,
        associated_token::authority = config,
        associated_token::token_program = dc_token_program
    )]
    pub escrow_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pair.dc_mint)]
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = pair.other_mint)]
    pub other_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = pair.dc_token_program)]
    pub dc_token_program: Interface<'info, TokenInterface>,
    #[account(address = pair.other_token_program)]
    pub other_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(sequence: u64, page_no: u32)]
pub struct PlaceBuyDc<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, OrderbookConfig>,
    pub pair_config: Box<Account<'info, PairConfig>>,
    pub pair: Box<Account<'info, PairState>>,
    #[account(
        init_if_needed,
        payer = user,
        space = QueueHeader::SPACE,
        seeds = [QUEUE_HEADER_SEED, pair.key().as_ref(), &[SIDE_BUY_DC]],
        bump
    )]
    pub header: Account<'info, QueueHeader>,
    #[account(
        init_if_needed,
        payer = user,
        space = QueuePage::SPACE,
        seeds = [QUEUE_PAGE_SEED, pair.key().as_ref(), &[SIDE_BUY_DC], &page_no.to_le_bytes()],
        bump
    )]
    pub page: Account<'info, QueuePage>,
    #[account(
        init,
        payer = user,
        space = Order::SPACE,
        seeds = [ORDER_SEED, pair.key().as_ref(), &[SIDE_BUY_DC], &sequence.to_le_bytes()],
        bump
    )]
    pub order: Account<'info, Order>,
    #[account(mut)]
    pub source_other: Box<InterfaceAccount<'info, TokenAccount>>,
    pub destination_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = other_mint,
        associated_token::authority = config,
        associated_token::token_program = other_token_program
    )]
    pub escrow_other: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pair.dc_mint)]
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = pair.other_mint)]
    pub other_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = pair.dc_token_program)]
    pub dc_token_program: Interface<'info, TokenInterface>,
    #[account(address = pair.other_token_program)]
    pub other_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleSellDc<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, OrderbookConfig>,
    pub pair_program: Program<'info, deal_dex_pair::program::DealDexPair>,
    pub pair_config: Box<Account<'info, PairConfig>>,
    #[account(mut)]
    pub pair: Box<Account<'info, PairState>>,
    #[account(mut)]
    pub order: Account<'info, Order>,
    #[account(mut, seeds = [QUEUE_HEADER_SEED, pair.key().as_ref(), &[SIDE_SELL_DC]], bump)]
    pub header: Account<'info, QueueHeader>,
    #[account(
        mut,
        associated_token::mint = dc_mint,
        associated_token::authority = config,
        associated_token::token_program = dc_token_program
    )]
    pub escrow_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub destination_other: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pair.dc_mint)]
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = pair.other_mint)]
    pub other_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pair.vault0)]
    pub vault0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pair.vault1)]
    pub vault1: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pair.dc_token_program)]
    pub dc_token_program: Interface<'info, TokenInterface>,
    #[account(address = pair.other_token_program)]
    pub other_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SettleBuyDc<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, OrderbookConfig>,
    pub pair_program: Program<'info, deal_dex_pair::program::DealDexPair>,
    pub pair_config: Box<Account<'info, PairConfig>>,
    #[account(mut)]
    pub pair: Box<Account<'info, PairState>>,
    #[account(mut)]
    pub order: Account<'info, Order>,
    #[account(mut, seeds = [QUEUE_HEADER_SEED, pair.key().as_ref(), &[SIDE_BUY_DC]], bump)]
    pub header: Account<'info, QueueHeader>,
    #[account(
        mut,
        associated_token::mint = other_mint,
        associated_token::authority = config,
        associated_token::token_program = other_token_program
    )]
    pub escrow_other: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub destination_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pair.dc_mint)]
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = pair.other_mint)]
    pub other_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pair.vault0)]
    pub vault0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pair.vault1)]
    pub vault1: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pair.dc_token_program)]
    pub dc_token_program: Interface<'info, TokenInterface>,
    #[account(address = pair.other_token_program)]
    pub other_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CancelSellDc<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, OrderbookConfig>,
    pub pair: Account<'info, PairState>,
    #[account(mut)]
    pub order: Account<'info, Order>,
    #[account(mut, seeds = [QUEUE_HEADER_SEED, pair.key().as_ref(), &[SIDE_SELL_DC]], bump)]
    pub header: Account<'info, QueueHeader>,
    #[account(
        mut,
        associated_token::mint = dc_mint,
        associated_token::authority = config,
        associated_token::token_program = dc_token_program
    )]
    pub escrow_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub refund_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub treasury_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pair.dc_mint)]
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = pair.dc_token_program)]
    pub dc_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CancelBuyDc<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, OrderbookConfig>,
    pub pair: Account<'info, PairState>,
    #[account(mut)]
    pub order: Account<'info, Order>,
    #[account(mut, seeds = [QUEUE_HEADER_SEED, pair.key().as_ref(), &[SIDE_BUY_DC]], bump)]
    pub header: Account<'info, QueueHeader>,
    #[account(
        mut,
        associated_token::mint = other_mint,
        associated_token::authority = config,
        associated_token::token_program = other_token_program
    )]
    pub escrow_other: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub refund_other: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub treasury_other: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pair.other_mint)]
    pub other_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = pair.other_token_program)]
    pub other_token_program: Interface<'info, TokenInterface>,
}

#[account]
pub struct OrderbookConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub treasury: Pubkey,
    pub pair_program: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

impl OrderbookConfig {
    pub const SPACE: usize = 8 + (32 * 4) + 1 + 1;
}

#[account]
pub struct QueueHeader {
    pub pair: Pubkey,
    pub side: u8,
    pub next_sequence: u64,
    pub open_orders: u64,
}

impl QueueHeader {
    pub const SPACE: usize = 8 + 32 + 1 + 8 + 8;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct QueueEntry {
    pub sequence: u64,
    pub order: Pubkey,
    pub owner: Pubkey,
    pub created_at: i64,
}

#[account]
pub struct QueuePage {
    pub pair: Pubkey,
    pub side: u8,
    pub page_no: u32,
    pub entries: Vec<QueueEntry>,
}

impl QueuePage {
    pub const SPACE: usize = 8 + 32 + 1 + 4 + 4 + (PAGE_CAPACITY * (8 + 32 + 32 + 8));
}

#[account]
pub struct Order {
    pub owner: Pubkey,
    pub pair: Pubkey,
    pub destination_out: Pubkey,
    pub side: u8,
    pub sequence: u64,
    pub remaining_in: u64,
    pub created_at: i64,
    pub active: bool,
    pub bump: u8,
}

impl Order {
    pub const SPACE: usize = 8 + (32 * 3) + 1 + (8 * 3) + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SettlementResult {
    pub filled_in: u64,
    pub filled_out: u64,
    pub fee_dc: u64,
    pub remaining_in: u64,
    pub completed: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct CancelResult {
    pub refunded: u64,
    pub fee_to_treasury: u64,
}

#[event]
pub struct OrderbookInitialized {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub pair_program: Pubkey,
}

#[event]
pub struct OrderbookPauseUpdated {
    pub paused: bool,
}

#[event]
pub struct OrderbookAuthorityProposed {
    pub pending_authority: Pubkey,
}

#[event]
pub struct OrderbookAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct OrderPlaced {
    pub order: Pubkey,
    pub owner: Pubkey,
    pub pair: Pubkey,
    pub side: u8,
    pub sequence: u64,
    pub amount_in: u64,
}

#[event]
pub struct OrderSettled {
    pub order: Pubkey,
    pub pair: Pubkey,
    pub side: u8,
    pub filled_in: u64,
    pub filled_out: u64,
    pub fee_dc: u64,
    pub remaining_in: u64,
    pub completed: bool,
}

#[event]
pub struct OrderCanceled {
    pub order: Pubkey,
    pub owner: Pubkey,
    pub pair: Pubkey,
    pub side: u8,
    pub refunded: u64,
    pub fee_to_treasury: u64,
}

#[error_code(offset = 6400)]
pub enum OrderbookError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("pending authority is invalid")]
    InvalidPendingAuthority,
    #[msg("orderbook is paused")]
    Paused,
    #[msg("input amount must be positive")]
    ZeroInput,
    #[msg("pair or pair configuration is invalid")]
    InvalidPair,
    #[msg("queue state is invalid")]
    InvalidQueue,
    #[msg("order sequence is invalid")]
    InvalidSequence,
    #[msg("queue page is invalid")]
    InvalidPage,
    #[msg("queue page is full")]
    PageFull,
    #[msg("order is invalid")]
    InvalidOrder,
    #[msg("order is inactive")]
    InactiveOrder,
    #[msg("order destination token account is invalid")]
    InvalidDestination,
    #[msg("token account owner or mint is invalid")]
    InvalidTokenAccount,
    #[msg("treasury token account owner or mint is invalid")]
    InvalidTreasuryAccount,
    #[msg("pair has no immediately settleable real liquidity")]
    NoImmediateLiquidity,
    #[msg("arithmetic overflow")]
    MathOverflow,
}
