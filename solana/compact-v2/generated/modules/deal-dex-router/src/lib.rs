#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use deal_dex_pair::{
    self, quote_buy_given_in, quote_buy_given_net, quote_sell, quote_sell_given_out,
    DexConfig as PairConfig, PairState, CONFIG_SEED as PAIR_CONFIG_SEED, PAIR_SEED,
};

declare_id!("3gsSk16h3xrxDHg5u8SZQek11WcTCLw9Zs6HUeaNBf5S");

pub const CONFIG_SEED: &[u8] = b"router-config";

#[program]
pub mod deal_dex_router {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.pair_program = deal_dex_pair::id();
        config.dc_mint = ctx.accounts.dc_mint.key();
        config.paused = true;
        config.bump = ctx.bumps.config;
        emit!(RouterInitialized {
            authority: config.authority,
            pair_program: config.pair_program,
            dc_mint: config.dc_mint,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.paused = paused;
        emit!(RouterPauseUpdated { paused });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            RouterError::ZeroAddress
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(RouterAuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            RouterError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = Pubkey::default();
        emit!(RouterAuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority,
        });
        Ok(())
    }

    pub fn swap_exact_other_for_dc(
        ctx: Context<SwapExactOtherForDc>,
        amount_other_in: u64,
        minimum_dc_out: u64,
        deadline: i64,
    ) -> Result<()> {
        assert_router_enabled(&ctx.accounts.config, deadline)?;
        validate_pair(
            &ctx.accounts.config,
            &ctx.accounts.pair_config,
            &ctx.accounts.pair,
            ctx.accounts.other_mint.key(),
        )?;
        let (gross_dc, fee_dc, net_dc) = quote_buy_given_in(&ctx.accounts.pair, amount_other_in)?;
        require!(net_dc >= minimum_dc_out, RouterError::SlippageExceeded);
        deal_dex_pair::cpi::swap_buy_dc(
            CpiContext::new(
                ctx.accounts.pair_program.key(),
                deal_dex_pair::cpi::accounts::SwapBuyDc {
                    user: ctx.accounts.user.to_account_info(),
                    config: ctx.accounts.pair_config.to_account_info(),
                    pair: ctx.accounts.pair.to_account_info(),
                    user_other: ctx.accounts.user_other.to_account_info(),
                    user_dc: ctx.accounts.user_dc.to_account_info(),
                    dc_mint: ctx.accounts.dc_mint.to_account_info(),
                    other_mint: ctx.accounts.other_mint.to_account_info(),
                    vault0: ctx.accounts.vault0.to_account_info(),
                    vault1: ctx.accounts.vault1.to_account_info(),
                    dc_token_program: ctx.accounts.dc_token_program.to_account_info(),
                    other_token_program: ctx.accounts.other_token_program.to_account_info(),
                },
            ),
            amount_other_in,
            minimum_dc_out,
        )?;
        ctx.accounts.pair.reload()?;
        emit!(SingleHopExecuted {
            user: ctx.accounts.user.key(),
            pair: ctx.accounts.pair.key(),
            other_to_dc: true,
            amount_in: amount_other_in,
            amount_out: net_dc,
            dc_gross: gross_dc,
            dc_fee_burned: fee_dc,
        });
        Ok(())
    }

    pub fn swap_other_for_exact_dc(
        ctx: Context<SwapExactOtherForDc>,
        exact_dc_out: u64,
        maximum_other_in: u64,
        deadline: i64,
    ) -> Result<()> {
        assert_router_enabled(&ctx.accounts.config, deadline)?;
        validate_pair(
            &ctx.accounts.config,
            &ctx.accounts.pair_config,
            &ctx.accounts.pair,
            ctx.accounts.other_mint.key(),
        )?;
        let (gross_dc, fee_dc, actual_dc_out, required_other_in) =
            quote_buy_given_net(&ctx.accounts.pair, exact_dc_out)?;
        require!(
            required_other_in <= maximum_other_in,
            RouterError::MaximumInputExceeded
        );
        deal_dex_pair::cpi::swap_other_for_exact_dc(
            CpiContext::new(
                ctx.accounts.pair_program.key(),
                deal_dex_pair::cpi::accounts::SwapBuyDc {
                    user: ctx.accounts.user.to_account_info(),
                    config: ctx.accounts.pair_config.to_account_info(),
                    pair: ctx.accounts.pair.to_account_info(),
                    user_other: ctx.accounts.user_other.to_account_info(),
                    user_dc: ctx.accounts.user_dc.to_account_info(),
                    dc_mint: ctx.accounts.dc_mint.to_account_info(),
                    other_mint: ctx.accounts.other_mint.to_account_info(),
                    vault0: ctx.accounts.vault0.to_account_info(),
                    vault1: ctx.accounts.vault1.to_account_info(),
                    dc_token_program: ctx.accounts.dc_token_program.to_account_info(),
                    other_token_program: ctx.accounts.other_token_program.to_account_info(),
                },
            ),
            exact_dc_out,
            required_other_in,
        )?;
        ctx.accounts.pair.reload()?;
        emit!(SingleHopExactOutputExecuted {
            user: ctx.accounts.user.key(),
            pair: ctx.accounts.pair.key(),
            other_to_dc: true,
            required_input: required_other_in,
            target_output: exact_dc_out,
            actual_output: actual_dc_out,
            dc_gross: gross_dc,
            dc_fee_burned: fee_dc,
        });
        Ok(())
    }

    pub fn swap_exact_dc_for_other(
        ctx: Context<SwapExactDcForOther>,
        amount_dc_in: u64,
        minimum_other_out: u64,
        deadline: i64,
    ) -> Result<()> {
        assert_router_enabled(&ctx.accounts.config, deadline)?;
        validate_pair(
            &ctx.accounts.config,
            &ctx.accounts.pair_config,
            &ctx.accounts.pair,
            ctx.accounts.other_mint.key(),
        )?;
        let (fee_dc, _, other_out) = quote_sell(&ctx.accounts.pair, amount_dc_in)?;
        require!(
            other_out >= minimum_other_out,
            RouterError::SlippageExceeded
        );
        deal_dex_pair::cpi::swap_sell_dc(
            CpiContext::new(
                ctx.accounts.pair_program.key(),
                deal_dex_pair::cpi::accounts::SwapSellDc {
                    user: ctx.accounts.user.to_account_info(),
                    config: ctx.accounts.pair_config.to_account_info(),
                    pair: ctx.accounts.pair.to_account_info(),
                    user_dc: ctx.accounts.user_dc.to_account_info(),
                    user_other: ctx.accounts.user_other.to_account_info(),
                    dc_mint: ctx.accounts.dc_mint.to_account_info(),
                    other_mint: ctx.accounts.other_mint.to_account_info(),
                    vault0: ctx.accounts.vault0.to_account_info(),
                    vault1: ctx.accounts.vault1.to_account_info(),
                    dc_token_program: ctx.accounts.dc_token_program.to_account_info(),
                    other_token_program: ctx.accounts.other_token_program.to_account_info(),
                },
            ),
            amount_dc_in,
            minimum_other_out,
        )?;
        ctx.accounts.pair.reload()?;
        emit!(SingleHopExecuted {
            user: ctx.accounts.user.key(),
            pair: ctx.accounts.pair.key(),
            other_to_dc: false,
            amount_in: amount_dc_in,
            amount_out: other_out,
            dc_gross: amount_dc_in,
            dc_fee_burned: fee_dc,
        });
        Ok(())
    }

    pub fn swap_dc_for_exact_other(
        ctx: Context<SwapExactDcForOther>,
        exact_other_out: u64,
        maximum_dc_in: u64,
        deadline: i64,
    ) -> Result<()> {
        assert_router_enabled(&ctx.accounts.config, deadline)?;
        validate_pair(
            &ctx.accounts.config,
            &ctx.accounts.pair_config,
            &ctx.accounts.pair,
            ctx.accounts.other_mint.key(),
        )?;
        let (required_dc_in, fee_dc, _) =
            quote_sell_given_out(&ctx.accounts.pair, exact_other_out)?;
        require!(
            required_dc_in <= maximum_dc_in,
            RouterError::MaximumInputExceeded
        );
        deal_dex_pair::cpi::swap_dc_for_exact_other(
            CpiContext::new(
                ctx.accounts.pair_program.key(),
                deal_dex_pair::cpi::accounts::SwapSellDc {
                    user: ctx.accounts.user.to_account_info(),
                    config: ctx.accounts.pair_config.to_account_info(),
                    pair: ctx.accounts.pair.to_account_info(),
                    user_dc: ctx.accounts.user_dc.to_account_info(),
                    user_other: ctx.accounts.user_other.to_account_info(),
                    dc_mint: ctx.accounts.dc_mint.to_account_info(),
                    other_mint: ctx.accounts.other_mint.to_account_info(),
                    vault0: ctx.accounts.vault0.to_account_info(),
                    vault1: ctx.accounts.vault1.to_account_info(),
                    dc_token_program: ctx.accounts.dc_token_program.to_account_info(),
                    other_token_program: ctx.accounts.other_token_program.to_account_info(),
                },
            ),
            exact_other_out,
            required_dc_in,
        )?;
        ctx.accounts.pair.reload()?;
        emit!(SingleHopExactOutputExecuted {
            user: ctx.accounts.user.key(),
            pair: ctx.accounts.pair.key(),
            other_to_dc: false,
            required_input: required_dc_in,
            target_output: exact_other_out,
            actual_output: exact_other_out,
            dc_gross: required_dc_in,
            dc_fee_burned: fee_dc,
        });
        Ok(())
    }

    pub fn swap_exact_other_for_other_via_dc(
        ctx: Context<SwapExactOtherForOtherViaDc>,
        amount_a_in: u64,
        minimum_b_out: u64,
        deadline: i64,
    ) -> Result<()> {
        assert_router_enabled(&ctx.accounts.config, deadline)?;
        require_keys_neq!(
            ctx.accounts.pair_a.key(),
            ctx.accounts.pair_b.key(),
            RouterError::SamePair
        );
        require_keys_neq!(
            ctx.accounts.mint_a.key(),
            ctx.accounts.mint_b.key(),
            RouterError::SameMint
        );
        validate_pair(
            &ctx.accounts.config,
            &ctx.accounts.pair_config,
            &ctx.accounts.pair_a,
            ctx.accounts.mint_a.key(),
        )?;
        validate_pair(
            &ctx.accounts.config,
            &ctx.accounts.pair_config,
            &ctx.accounts.pair_b,
            ctx.accounts.mint_b.key(),
        )?;
        validate_user_token(
            &ctx.accounts.user_a,
            ctx.accounts.user.key(),
            ctx.accounts.mint_a.key(),
        )?;
        validate_user_token(
            &ctx.accounts.user_dc,
            ctx.accounts.user.key(),
            ctx.accounts.dc_mint.key(),
        )?;
        validate_user_token(
            &ctx.accounts.user_b,
            ctx.accounts.user.key(),
            ctx.accounts.mint_b.key(),
        )?;

        let (dc_gross, fee_buy_dc, dc_net) = quote_buy_given_in(&ctx.accounts.pair_a, amount_a_in)?;
        let (fee_sell_dc, _, amount_b_out) = quote_sell(&ctx.accounts.pair_b, dc_net)?;
        require!(amount_b_out >= minimum_b_out, RouterError::SlippageExceeded);

        deal_dex_pair::cpi::swap_buy_dc(
            CpiContext::new(
                ctx.accounts.pair_program.key(),
                deal_dex_pair::cpi::accounts::SwapBuyDc {
                    user: ctx.accounts.user.to_account_info(),
                    config: ctx.accounts.pair_config.to_account_info(),
                    pair: ctx.accounts.pair_a.to_account_info(),
                    user_other: ctx.accounts.user_a.to_account_info(),
                    user_dc: ctx.accounts.user_dc.to_account_info(),
                    dc_mint: ctx.accounts.dc_mint.to_account_info(),
                    other_mint: ctx.accounts.mint_a.to_account_info(),
                    vault0: ctx.accounts.vault_a_dc.to_account_info(),
                    vault1: ctx.accounts.vault_a_other.to_account_info(),
                    dc_token_program: ctx.accounts.dc_token_program.to_account_info(),
                    other_token_program: ctx.accounts.token_program_a.to_account_info(),
                },
            ),
            amount_a_in,
            dc_net,
        )?;
        ctx.accounts.pair_a.reload()?;
        deal_dex_pair::cpi::swap_sell_dc(
            CpiContext::new(
                ctx.accounts.pair_program.key(),
                deal_dex_pair::cpi::accounts::SwapSellDc {
                    user: ctx.accounts.user.to_account_info(),
                    config: ctx.accounts.pair_config.to_account_info(),
                    pair: ctx.accounts.pair_b.to_account_info(),
                    user_dc: ctx.accounts.user_dc.to_account_info(),
                    user_other: ctx.accounts.user_b.to_account_info(),
                    dc_mint: ctx.accounts.dc_mint.to_account_info(),
                    other_mint: ctx.accounts.mint_b.to_account_info(),
                    vault0: ctx.accounts.vault_b_dc.to_account_info(),
                    vault1: ctx.accounts.vault_b_other.to_account_info(),
                    dc_token_program: ctx.accounts.dc_token_program.to_account_info(),
                    other_token_program: ctx.accounts.token_program_b.to_account_info(),
                },
            ),
            dc_net,
            minimum_b_out,
        )?;
        ctx.accounts.pair_b.reload()?;
        emit!(DoubleHopExecuted {
            user: ctx.accounts.user.key(),
            pair_a: ctx.accounts.pair_a.key(),
            pair_b: ctx.accounts.pair_b.key(),
            amount_a_in,
            dc_gross,
            dc_net,
            amount_b_out,
            fee_buy_dc,
            fee_sell_dc,
        });
        Ok(())
    }

    pub fn swap_other_for_exact_other_via_dc(
        ctx: Context<SwapExactOtherForOtherViaDc>,
        exact_b_out: u64,
        maximum_a_in: u64,
        deadline: i64,
    ) -> Result<()> {
        assert_router_enabled(&ctx.accounts.config, deadline)?;
        require_keys_neq!(
            ctx.accounts.pair_a.key(),
            ctx.accounts.pair_b.key(),
            RouterError::SamePair
        );
        require_keys_neq!(
            ctx.accounts.mint_a.key(),
            ctx.accounts.mint_b.key(),
            RouterError::SameMint
        );
        validate_pair(
            &ctx.accounts.config,
            &ctx.accounts.pair_config,
            &ctx.accounts.pair_a,
            ctx.accounts.mint_a.key(),
        )?;
        validate_pair(
            &ctx.accounts.config,
            &ctx.accounts.pair_config,
            &ctx.accounts.pair_b,
            ctx.accounts.mint_b.key(),
        )?;
        validate_user_token(
            &ctx.accounts.user_a,
            ctx.accounts.user.key(),
            ctx.accounts.mint_a.key(),
        )?;
        validate_user_token(
            &ctx.accounts.user_dc,
            ctx.accounts.user.key(),
            ctx.accounts.dc_mint.key(),
        )?;
        validate_user_token(
            &ctx.accounts.user_b,
            ctx.accounts.user.key(),
            ctx.accounts.mint_b.key(),
        )?;

        let (required_dc, fee_sell_dc, _) =
            quote_sell_given_out(&ctx.accounts.pair_b, exact_b_out)?;
        let (dc_gross, fee_buy_dc, actual_dc_out, required_a_in) =
            quote_buy_given_net(&ctx.accounts.pair_a, required_dc)?;
        require!(
            required_a_in <= maximum_a_in,
            RouterError::MaximumInputExceeded
        );

        deal_dex_pair::cpi::swap_other_for_exact_dc(
            CpiContext::new(
                ctx.accounts.pair_program.key(),
                deal_dex_pair::cpi::accounts::SwapBuyDc {
                    user: ctx.accounts.user.to_account_info(),
                    config: ctx.accounts.pair_config.to_account_info(),
                    pair: ctx.accounts.pair_a.to_account_info(),
                    user_other: ctx.accounts.user_a.to_account_info(),
                    user_dc: ctx.accounts.user_dc.to_account_info(),
                    dc_mint: ctx.accounts.dc_mint.to_account_info(),
                    other_mint: ctx.accounts.mint_a.to_account_info(),
                    vault0: ctx.accounts.vault_a_dc.to_account_info(),
                    vault1: ctx.accounts.vault_a_other.to_account_info(),
                    dc_token_program: ctx.accounts.dc_token_program.to_account_info(),
                    other_token_program: ctx.accounts.token_program_a.to_account_info(),
                },
            ),
            required_dc,
            required_a_in,
        )?;
        ctx.accounts.pair_a.reload()?;
        deal_dex_pair::cpi::swap_dc_for_exact_other(
            CpiContext::new(
                ctx.accounts.pair_program.key(),
                deal_dex_pair::cpi::accounts::SwapSellDc {
                    user: ctx.accounts.user.to_account_info(),
                    config: ctx.accounts.pair_config.to_account_info(),
                    pair: ctx.accounts.pair_b.to_account_info(),
                    user_dc: ctx.accounts.user_dc.to_account_info(),
                    user_other: ctx.accounts.user_b.to_account_info(),
                    dc_mint: ctx.accounts.dc_mint.to_account_info(),
                    other_mint: ctx.accounts.mint_b.to_account_info(),
                    vault0: ctx.accounts.vault_b_dc.to_account_info(),
                    vault1: ctx.accounts.vault_b_other.to_account_info(),
                    dc_token_program: ctx.accounts.dc_token_program.to_account_info(),
                    other_token_program: ctx.accounts.token_program_b.to_account_info(),
                },
            ),
            exact_b_out,
            required_dc,
        )?;
        ctx.accounts.pair_b.reload()?;
        let dc_refund = actual_dc_out
            .checked_sub(required_dc)
            .ok_or_else(|| error!(RouterError::InvalidQuote))?;
        emit!(DoubleHopExactOutputExecuted {
            user: ctx.accounts.user.key(),
            pair_a: ctx.accounts.pair_a.key(),
            pair_b: ctx.accounts.pair_b.key(),
            required_a_in,
            dc_gross,
            required_dc,
            dc_refund,
            exact_b_out,
            fee_buy_dc,
            fee_sell_dc,
        });
        Ok(())
    }
}

fn assert_authority(config: &RouterConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(config.authority, authority.key(), RouterError::Unauthorized);
    Ok(())
}

fn assert_router_enabled(config: &RouterConfig, deadline: i64) -> Result<()> {
    require!(!config.paused, RouterError::Paused);
    require!(
        Clock::get()?.unix_timestamp <= deadline,
        RouterError::Expired
    );
    Ok(())
}

fn validate_pair(
    router_config: &RouterConfig,
    pair_config: &Account<'_, PairConfig>,
    pair: &Account<'_, PairState>,
    other_mint: Pubkey,
) -> Result<()> {
    require_keys_eq!(
        router_config.pair_program,
        deal_dex_pair::id(),
        RouterError::InvalidPairProgram
    );
    require_keys_eq!(
        router_config.dc_mint,
        pair_config.dc_mint,
        RouterError::InvalidDcMint
    );
    require_keys_eq!(
        router_config.dc_mint,
        pair.dc_mint,
        RouterError::InvalidDcMint
    );
    require_keys_eq!(pair.other_mint, other_mint, RouterError::InvalidOtherMint);
    let (expected_config, _) =
        Pubkey::find_program_address(&[PAIR_CONFIG_SEED], &deal_dex_pair::id());
    require_keys_eq!(
        pair_config.key(),
        expected_config,
        RouterError::InvalidPairConfig
    );
    let (expected_pair, _) =
        Pubkey::find_program_address(&[PAIR_SEED, other_mint.as_ref()], &deal_dex_pair::id());
    require_keys_eq!(pair.key(), expected_pair, RouterError::InvalidPair);
    Ok(())
}

fn validate_user_token(account: &TokenAccount, user: Pubkey, mint: Pubkey) -> Result<()> {
    require_keys_eq!(account.owner, user, RouterError::InvalidUserTokenAccount);
    require_keys_eq!(account.mint, mint, RouterError::InvalidUserTokenAccount);
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = payer, space = RouterConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, RouterConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RouterConfig>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RouterConfig>,
}

#[derive(Accounts)]
pub struct SwapExactOtherForDc<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RouterConfig>,
    pub pair_program: Program<'info, deal_dex_pair::program::DealDexPair>,
    pub pair_config: Box<Account<'info, PairConfig>>,
    #[account(mut)]
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
pub struct SwapExactDcForOther<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RouterConfig>,
    pub pair_program: Program<'info, deal_dex_pair::program::DealDexPair>,
    pub pair_config: Box<Account<'info, PairConfig>>,
    #[account(mut)]
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

#[derive(Accounts)]
pub struct SwapExactOtherForOtherViaDc<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RouterConfig>,
    pub pair_program: Program<'info, deal_dex_pair::program::DealDexPair>,
    pub pair_config: Box<Account<'info, PairConfig>>,
    #[account(mut)]
    pub pair_a: Box<Account<'info, PairState>>,
    #[account(mut)]
    pub pair_b: Box<Account<'info, PairState>>,
    #[account(mut)]
    pub user_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub user_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub user_b: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub dc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub mint_a: Box<InterfaceAccount<'info, Mint>>,
    pub mint_b: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub vault_a_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_a_other: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_b_dc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_b_other: Box<InterfaceAccount<'info, TokenAccount>>,
    pub dc_token_program: Interface<'info, TokenInterface>,
    pub token_program_a: Interface<'info, TokenInterface>,
    pub token_program_b: Interface<'info, TokenInterface>,
}

#[account]
pub struct RouterConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub pair_program: Pubkey,
    pub dc_mint: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

impl RouterConfig {
    pub const SPACE: usize = 8 + (32 * 4) + 1 + 1;
}

#[event]
pub struct RouterInitialized {
    pub authority: Pubkey,
    pub pair_program: Pubkey,
    pub dc_mint: Pubkey,
}

#[event]
pub struct RouterPauseUpdated {
    pub paused: bool,
}

#[event]
pub struct RouterAuthorityProposed {
    pub pending_authority: Pubkey,
}

#[event]
pub struct RouterAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct SingleHopExecuted {
    pub user: Pubkey,
    pub pair: Pubkey,
    pub other_to_dc: bool,
    pub amount_in: u64,
    pub amount_out: u64,
    pub dc_gross: u64,
    pub dc_fee_burned: u64,
}

#[event]
pub struct SingleHopExactOutputExecuted {
    pub user: Pubkey,
    pub pair: Pubkey,
    pub other_to_dc: bool,
    pub required_input: u64,
    pub target_output: u64,
    pub actual_output: u64,
    pub dc_gross: u64,
    pub dc_fee_burned: u64,
}

#[event]
pub struct DoubleHopExecuted {
    pub user: Pubkey,
    pub pair_a: Pubkey,
    pub pair_b: Pubkey,
    pub amount_a_in: u64,
    pub dc_gross: u64,
    pub dc_net: u64,
    pub amount_b_out: u64,
    pub fee_buy_dc: u64,
    pub fee_sell_dc: u64,
}

#[event]
pub struct DoubleHopExactOutputExecuted {
    pub user: Pubkey,
    pub pair_a: Pubkey,
    pub pair_b: Pubkey,
    pub required_a_in: u64,
    pub dc_gross: u64,
    pub required_dc: u64,
    pub dc_refund: u64,
    pub exact_b_out: u64,
    pub fee_buy_dc: u64,
    pub fee_sell_dc: u64,
}

#[error_code(offset = 6100)]
pub enum RouterError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("pending authority is invalid")]
    InvalidPendingAuthority,
    #[msg("router is paused")]
    Paused,
    #[msg("swap deadline expired")]
    Expired,
    #[msg("pair program is invalid")]
    InvalidPairProgram,
    #[msg("pair config is invalid")]
    InvalidPairConfig,
    #[msg("DC mint is invalid")]
    InvalidDcMint,
    #[msg("other mint is invalid")]
    InvalidOtherMint,
    #[msg("pair PDA is invalid")]
    InvalidPair,
    #[msg("both route hops cannot use the same pair")]
    SamePair,
    #[msg("route input and output mints must differ")]
    SameMint,
    #[msg("user token account has the wrong owner or mint")]
    InvalidUserTokenAccount,
    #[msg("minimum output was not met")]
    SlippageExceeded,
    #[msg("required input exceeds the caller limit")]
    MaximumInputExceeded,
    #[msg("pair quote returned an inconsistent amount")]
    InvalidQuote,
}
