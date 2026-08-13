#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint as DomainMint, Token, TokenAccount as DomainTokenAccount},
    token_interface::{
        self, Mint as PaymentMint, TokenAccount as PaymentTokenAccount, TokenInterface,
        TransferChecked,
    },
};
use deal_domain_registry::{self, DomainConfig, DomainRecord};

declare_id!("21m75WjpLxPYnFYFgP4srJQmfBKgUfSMP9xmp6pLsXuw");

pub const CONFIG_SEED: &[u8] = b"domain-market-config";
pub const LISTING_SEED: &[u8] = b"domain-listing";
pub const MAX_FEE_BPS: u16 = 2_500;

#[program]
pub mod deal_domain_market {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        domain_registry_program: Pubkey,
        domain_registry_config: Pubkey,
        payment_mint: Pubkey,
        fee_recipient: Pubkey,
        fee_bps: u16,
    ) -> Result<()> {
        for key in [
            domain_registry_program,
            domain_registry_config,
            payment_mint,
            fee_recipient,
        ] {
            require!(key != Pubkey::default(), MarketError::ZeroAddress);
        }
        require!(fee_bps <= MAX_FEE_BPS, MarketError::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.domain_registry_program = domain_registry_program;
        config.domain_registry_config = domain_registry_config;
        config.payment_mint = payment_mint;
        config.fee_recipient = fee_recipient;
        config.fee_bps = fee_bps;
        config.paused = true;
        config.bump = ctx.bumps.config;
        emit!(DomainMarketInitialized {
            authority: config.authority,
            domain_registry_program,
            payment_mint,
            fee_recipient,
            fee_bps,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.paused = paused;
        emit!(MarketPauseUpdated { paused });
        Ok(())
    }

    pub fn set_fee_recipient(ctx: Context<AdminConfig>, fee_recipient: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(fee_recipient != Pubkey::default(), MarketError::ZeroAddress);
        ctx.accounts.config.fee_recipient = fee_recipient;
        emit!(MarketFeeRecipientUpdated { fee_recipient });
        Ok(())
    }

    pub fn set_fee_bps(ctx: Context<AdminConfig>, fee_bps: u16) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(fee_bps <= MAX_FEE_BPS, MarketError::FeeTooHigh);
        ctx.accounts.config.fee_bps = fee_bps;
        emit!(MarketFeeBpsUpdated { fee_bps });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            MarketError::ZeroAddress
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(MarketAuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            MarketError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = Pubkey::default();
        emit!(MarketAuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority
        });
        Ok(())
    }

    pub fn list(ctx: Context<ListDomain>, price: u64, designated_buyer: Pubkey) -> Result<()> {
        require!(!ctx.accounts.config.paused, MarketError::Paused);
        require!(price > 0, MarketError::InvalidPrice);
        require_keys_eq!(
            ctx.accounts.domain.owner,
            ctx.accounts.seller.key(),
            MarketError::NotDomainOwner
        );
        require!(
            ctx.accounts.domain.escrow_market == Pubkey::default(),
            MarketError::AlreadyEscrowed
        );
        require!(
            designated_buyer != ctx.accounts.seller.key(),
            MarketError::SelfTrade
        );
        validate_registry(
            &ctx.accounts.config,
            &ctx.accounts.registry_config,
            ctx.accounts.registry_config.key(),
            ctx.accounts.registry_program.key(),
        )?;

        let bump = [ctx.accounts.config.bump];
        let signer_seeds: &[&[u8]] = &[CONFIG_SEED, &bump];
        deal_domain_registry::cpi::escrow_for_market(CpiContext::new_with_signer(
            ctx.accounts.registry_program.key(),
            deal_domain_registry::cpi::accounts::MarketEscrowDomain {
                config: ctx.accounts.registry_config.to_account_info(),
                owner: ctx.accounts.seller.to_account_info(),
                market_authority: ctx.accounts.config.to_account_info(),
                domain: ctx.accounts.domain.to_account_info(),
                domain_mint: ctx.accounts.domain_mint.to_account_info(),
                owner_domain: ctx.accounts.seller_domain.to_account_info(),
                market_domain: ctx.accounts.market_domain.to_account_info(),
                domain_token_program: ctx.accounts.domain_token_program.to_account_info(),
                associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[signer_seeds],
        ))?;
        ctx.accounts.domain.reload()?;

        let listing = &mut ctx.accounts.listing;
        listing.domain = ctx.accounts.domain.key();
        listing.domain_mint = ctx.accounts.domain.mint;
        listing.seller = ctx.accounts.seller.key();
        listing.designated_buyer = designated_buyer;
        listing.price = price;
        listing.created_at = Clock::get()?.unix_timestamp;
        listing.bump = ctx.bumps.listing;
        emit!(DomainListed {
            domain: listing.domain,
            seller: listing.seller,
            designated_buyer,
            price,
        });
        Ok(())
    }

    pub fn update_listing(ctx: Context<UpdateListing>, new_price: u64) -> Result<()> {
        require!(new_price > 0, MarketError::InvalidPrice);
        require_keys_eq!(
            ctx.accounts.listing.seller,
            ctx.accounts.seller.key(),
            MarketError::NotSeller
        );
        ctx.accounts.listing.price = new_price;
        emit!(DomainListingPriceUpdated {
            domain: ctx.accounts.listing.domain,
            new_price
        });
        Ok(())
    }

    pub fn delist(ctx: Context<DelistDomain>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.listing.seller,
            ctx.accounts.seller.key(),
            MarketError::NotSeller
        );
        validate_registry(
            &ctx.accounts.config,
            &ctx.accounts.registry_config,
            ctx.accounts.registry_config.key(),
            ctx.accounts.registry_program.key(),
        )?;
        let bump = [ctx.accounts.config.bump];
        let signer_seeds: &[&[u8]] = &[CONFIG_SEED, &bump];
        deal_domain_registry::cpi::release_from_market(
            CpiContext::new_with_signer(
                ctx.accounts.registry_program.key(),
                deal_domain_registry::cpi::accounts::MarketReleaseDomain {
                    config: ctx.accounts.registry_config.to_account_info(),
                    payer: ctx.accounts.seller.to_account_info(),
                    market_authority: ctx.accounts.config.to_account_info(),
                    destination_owner: ctx.accounts.seller.to_account_info(),
                    domain: ctx.accounts.domain.to_account_info(),
                    domain_mint: ctx.accounts.domain_mint.to_account_info(),
                    market_domain: ctx.accounts.market_domain.to_account_info(),
                    destination_domain: ctx.accounts.seller_domain.to_account_info(),
                    domain_token_program: ctx.accounts.domain_token_program.to_account_info(),
                    associated_token_program: ctx
                        .accounts
                        .associated_token_program
                        .to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
                &[signer_seeds],
            ),
            false,
        )?;
        ctx.accounts.domain.reload()?;
        emit!(DomainDelisted {
            domain: ctx.accounts.domain.key(),
            seller: ctx.accounts.seller.key()
        });
        Ok(())
    }

    pub fn buy(ctx: Context<BuyDomain>, maximum_price: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, MarketError::Paused);
        let listing = &ctx.accounts.listing;
        require!(
            listing.price <= maximum_price,
            MarketError::MaximumPriceExceeded
        );
        require!(
            listing.designated_buyer == Pubkey::default()
                || listing.designated_buyer == ctx.accounts.buyer.key(),
            MarketError::NotDesignatedBuyer
        );
        require!(
            ctx.accounts.buyer.key() != listing.seller,
            MarketError::SelfTrade
        );
        require_keys_eq!(
            ctx.accounts.domain.key(),
            listing.domain,
            MarketError::InvalidDomain
        );
        require_keys_eq!(
            ctx.accounts.domain.owner,
            listing.seller,
            MarketError::StaleListing
        );
        validate_registry(
            &ctx.accounts.config,
            &ctx.accounts.registry_config,
            ctx.accounts.registry_config.key(),
            ctx.accounts.registry_program.key(),
        )?;
        validate_payment_accounts(&ctx)?;

        let fee = u64::try_from(
            (u128::from(listing.price) * u128::from(ctx.accounts.config.fee_bps)) / 10_000,
        )
        .map_err(|_| error!(MarketError::ArithmeticOverflow))?;
        let seller_amount = listing
            .price
            .checked_sub(fee)
            .ok_or(MarketError::ArithmeticOverflow)?;
        transfer_payment(
            &ctx.accounts.buyer_payment,
            &ctx.accounts.payment_mint,
            &ctx.accounts.seller_payment,
            &ctx.accounts.buyer,
            &ctx.accounts.payment_token_program,
            seller_amount,
        )?;
        transfer_payment(
            &ctx.accounts.buyer_payment,
            &ctx.accounts.payment_mint,
            &ctx.accounts.fee_payment,
            &ctx.accounts.buyer,
            &ctx.accounts.payment_token_program,
            fee,
        )?;

        let bump = [ctx.accounts.config.bump];
        let signer_seeds: &[&[u8]] = &[CONFIG_SEED, &bump];
        deal_domain_registry::cpi::release_from_market(
            CpiContext::new_with_signer(
                ctx.accounts.registry_program.key(),
                deal_domain_registry::cpi::accounts::MarketReleaseDomain {
                    config: ctx.accounts.registry_config.to_account_info(),
                    payer: ctx.accounts.buyer.to_account_info(),
                    market_authority: ctx.accounts.config.to_account_info(),
                    destination_owner: ctx.accounts.buyer.to_account_info(),
                    domain: ctx.accounts.domain.to_account_info(),
                    domain_mint: ctx.accounts.domain_mint.to_account_info(),
                    market_domain: ctx.accounts.market_domain.to_account_info(),
                    destination_domain: ctx.accounts.buyer_domain.to_account_info(),
                    domain_token_program: ctx.accounts.domain_token_program.to_account_info(),
                    associated_token_program: ctx
                        .accounts
                        .associated_token_program
                        .to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
                &[signer_seeds],
            ),
            true,
        )?;
        ctx.accounts.domain.reload()?;
        emit!(DomainSold {
            domain: ctx.accounts.domain.key(),
            seller: listing.seller,
            buyer: ctx.accounts.buyer.key(),
            price: listing.price,
            fee,
        });
        Ok(())
    }
}

fn assert_authority(config: &MarketConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(config.authority, authority.key(), MarketError::Unauthorized);
    Ok(())
}

fn validate_registry(
    config: &MarketConfig,
    registry: &DomainConfig,
    registry_key: Pubkey,
    program: Pubkey,
) -> Result<()> {
    require_keys_eq!(
        config.domain_registry_program,
        program,
        MarketError::InvalidRegistry
    );
    require_keys_eq!(
        config.domain_registry_config,
        registry_key,
        MarketError::InvalidRegistry
    );
    require_keys_eq!(
        registry.domain_market,
        Pubkey::find_program_address(&[CONFIG_SEED], &crate::id()).0,
        MarketError::InvalidRegistryMarket
    );
    Ok(())
}

fn validate_payment_accounts(ctx: &Context<BuyDomain>) -> Result<()> {
    let config = &ctx.accounts.config;
    require_keys_eq!(
        config.payment_mint,
        ctx.accounts.payment_mint.key(),
        MarketError::InvalidPaymentMint
    );
    require_keys_eq!(
        ctx.accounts.buyer_payment.owner,
        ctx.accounts.buyer.key(),
        MarketError::InvalidPaymentOwner
    );
    require_keys_eq!(
        ctx.accounts.buyer_payment.mint,
        config.payment_mint,
        MarketError::InvalidPaymentMint
    );
    require_keys_eq!(
        ctx.accounts.seller_payment.owner,
        ctx.accounts.listing.seller,
        MarketError::InvalidPaymentOwner
    );
    require_keys_eq!(
        ctx.accounts.seller_payment.mint,
        config.payment_mint,
        MarketError::InvalidPaymentMint
    );
    require_keys_eq!(
        ctx.accounts.fee_payment.owner,
        config.fee_recipient,
        MarketError::InvalidFeeRecipient
    );
    require_keys_eq!(
        ctx.accounts.fee_payment.mint,
        config.payment_mint,
        MarketError::InvalidPaymentMint
    );
    Ok(())
}

fn transfer_payment<'info, A: ToAccountInfo<'info>>(
    source: &InterfaceAccount<'info, PaymentTokenAccount>,
    mint: &InterfaceAccount<'info, PaymentMint>,
    destination: &InterfaceAccount<'info, PaymentTokenAccount>,
    authority: &A,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token_interface::transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from: source.to_account_info(),
                mint: mint.to_account_info(),
                to: destination.to_account_info(),
                authority: authority.to_account_info(),
            },
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
    #[account(init, payer = payer, space = MarketConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, MarketConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, MarketConfig>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, MarketConfig>,
}

#[derive(Accounts)]
pub struct ListDomain<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, MarketConfig>>,
    #[account(mut)]
    pub seller: Signer<'info>,
    pub registry_program: Program<'info, deal_domain_registry::program::DealDomainRegistry>,
    #[account(mut)]
    pub registry_config: Box<Account<'info, DomainConfig>>,
    #[account(mut)]
    pub domain: Box<Account<'info, DomainRecord>>,
    #[account(mut)]
    pub domain_mint: Box<Account<'info, DomainMint>>,
    #[account(mut)]
    pub seller_domain: Box<Account<'info, DomainTokenAccount>>,
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = domain_mint,
        associated_token::authority = config,
        associated_token::token_program = domain_token_program
    )]
    pub market_domain: Box<Account<'info, DomainTokenAccount>>,
    #[account(init, payer = seller, space = DomainListing::SPACE, seeds = [LISTING_SEED, domain.key().as_ref()], bump)]
    pub listing: Box<Account<'info, DomainListing>>,
    pub domain_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateListing<'info> {
    pub seller: Signer<'info>,
    #[account(mut, seeds = [LISTING_SEED, listing.domain.as_ref()], bump = listing.bump)]
    pub listing: Account<'info, DomainListing>,
}

#[derive(Accounts)]
pub struct DelistDomain<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, MarketConfig>>,
    #[account(mut)]
    pub seller: Signer<'info>,
    pub registry_program: Program<'info, deal_domain_registry::program::DealDomainRegistry>,
    #[account(mut)]
    pub registry_config: Box<Account<'info, DomainConfig>>,
    #[account(mut)]
    pub domain: Box<Account<'info, DomainRecord>>,
    #[account(mut)]
    pub domain_mint: Box<Account<'info, DomainMint>>,
    #[account(mut)]
    pub market_domain: Box<Account<'info, DomainTokenAccount>>,
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = domain_mint,
        associated_token::authority = seller,
        associated_token::token_program = domain_token_program
    )]
    pub seller_domain: Box<Account<'info, DomainTokenAccount>>,
    #[account(mut, close = seller, seeds = [LISTING_SEED, domain.key().as_ref()], bump = listing.bump)]
    pub listing: Box<Account<'info, DomainListing>>,
    pub domain_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyDomain<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, MarketConfig>>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: Must match listing.seller and its token account is validated.
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,
    pub registry_program: Program<'info, deal_domain_registry::program::DealDomainRegistry>,
    #[account(mut)]
    pub registry_config: Box<Account<'info, DomainConfig>>,
    #[account(mut)]
    pub domain: Box<Account<'info, DomainRecord>>,
    #[account(mut)]
    pub domain_mint: Box<Account<'info, DomainMint>>,
    #[account(mut)]
    pub market_domain: Box<Account<'info, DomainTokenAccount>>,
    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = domain_mint,
        associated_token::authority = buyer,
        associated_token::token_program = domain_token_program
    )]
    pub buyer_domain: Box<Account<'info, DomainTokenAccount>>,
    #[account(mut, close = seller, seeds = [LISTING_SEED, domain.key().as_ref()], bump = listing.bump, constraint = listing.seller == seller.key() @ MarketError::NotSeller)]
    pub listing: Box<Account<'info, DomainListing>>,
    #[account(mut)]
    pub buyer_payment: Box<InterfaceAccount<'info, PaymentTokenAccount>>,
    #[account(mut)]
    pub seller_payment: Box<InterfaceAccount<'info, PaymentTokenAccount>>,
    #[account(mut)]
    pub fee_payment: Box<InterfaceAccount<'info, PaymentTokenAccount>>,
    pub payment_mint: Box<InterfaceAccount<'info, PaymentMint>>,
    pub payment_token_program: Interface<'info, TokenInterface>,
    pub domain_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct MarketConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub domain_registry_program: Pubkey,
    pub domain_registry_config: Pubkey,
    pub payment_mint: Pubkey,
    pub fee_recipient: Pubkey,
    pub fee_bps: u16,
    pub paused: bool,
    pub bump: u8,
}

impl MarketConfig {
    pub const SPACE: usize = 8 + (32 * 6) + 2 + 1 + 1;
}

#[account]
pub struct DomainListing {
    pub domain: Pubkey,
    pub domain_mint: Pubkey,
    pub seller: Pubkey,
    pub designated_buyer: Pubkey,
    pub price: u64,
    pub created_at: i64,
    pub bump: u8,
}

impl DomainListing {
    pub const SPACE: usize = 8 + (32 * 4) + 8 + 8 + 1;
}

#[event]
pub struct DomainMarketInitialized {
    pub authority: Pubkey,
    pub domain_registry_program: Pubkey,
    pub payment_mint: Pubkey,
    pub fee_recipient: Pubkey,
    pub fee_bps: u16,
}
#[event]
pub struct DomainListed {
    pub domain: Pubkey,
    pub seller: Pubkey,
    pub designated_buyer: Pubkey,
    pub price: u64,
}
#[event]
pub struct DomainListingPriceUpdated {
    pub domain: Pubkey,
    pub new_price: u64,
}
#[event]
pub struct DomainDelisted {
    pub domain: Pubkey,
    pub seller: Pubkey,
}
#[event]
pub struct DomainSold {
    pub domain: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub price: u64,
    pub fee: u64,
}
#[event]
pub struct MarketPauseUpdated {
    pub paused: bool,
}
#[event]
pub struct MarketFeeRecipientUpdated {
    pub fee_recipient: Pubkey,
}
#[event]
pub struct MarketFeeBpsUpdated {
    pub fee_bps: u16,
}
#[event]
pub struct MarketAuthorityProposed {
    pub pending_authority: Pubkey,
}
#[event]
pub struct MarketAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[error_code(offset = 6100)]
pub enum MarketError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("pending authority is invalid")]
    InvalidPendingAuthority,
    #[msg("domain market is paused")]
    Paused,
    #[msg("market fee exceeds 25 percent")]
    FeeTooHigh,
    #[msg("listing price must be positive")]
    InvalidPrice,
    #[msg("caller is not the domain owner")]
    NotDomainOwner,
    #[msg("domain is already escrowed")]
    AlreadyEscrowed,
    #[msg("seller cannot designate itself as buyer")]
    SelfTrade,
    #[msg("domain registry is invalid")]
    InvalidRegistry,
    #[msg("domain registry does not trust this market")]
    InvalidRegistryMarket,
    #[msg("caller is not the seller")]
    NotSeller,
    #[msg("listing price exceeds buyer maximum")]
    MaximumPriceExceeded,
    #[msg("buyer is not the designated buyer")]
    NotDesignatedBuyer,
    #[msg("domain account does not match listing")]
    InvalidDomain,
    #[msg("domain owner changed after listing")]
    StaleListing,
    #[msg("payment mint is invalid")]
    InvalidPaymentMint,
    #[msg("payment token owner is invalid")]
    InvalidPaymentOwner,
    #[msg("fee recipient token account is invalid")]
    InvalidFeeRecipient,
    #[msg("arithmetic overflow")]
    ArithmeticOverflow,
}
