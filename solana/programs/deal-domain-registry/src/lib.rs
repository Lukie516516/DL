#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{
        self, FreezeAccount, Mint as DomainMint, MintTo, ThawAccount, Token,
        TokenAccount as DomainTokenAccount, TransferChecked as DomainTransferChecked,
    },
    token_interface::{
        self, Mint as DcMint, TokenAccount as DcTokenAccount, TokenInterface,
        TransferChecked as DcTransferChecked,
    },
};

declare_id!("EK5YXKpbYo7Jkah2a3fERFfQfWa4gaR5pZgvqTFozeFW");

pub const CONFIG_SEED: &[u8] = b"domain-config";
pub const DOMAIN_SEED: &[u8] = b"domain";
pub const DOMAIN_MINT_SEED: &[u8] = b"domain-mint";
pub const DOMAIN_ID_SEED: &[u8] = b"domain-id";
pub const PRIMARY_SEED: &[u8] = b"primary-domain";
pub const LABEL_BYTES: usize = 6;
pub const MAX_DESCRIPTION_BYTES: usize = 500;
pub const MAX_BACKGROUND_URI_BYTES: usize = 512;

#[program]
pub mod deal_domain_registry {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        dc_mint: Pubkey,
        treasury: Pubkey,
        base_price: u64,
    ) -> Result<()> {
        require!(dc_mint != Pubkey::default(), DomainError::ZeroAddress);
        require!(treasury != Pubkey::default(), DomainError::ZeroAddress);
        require!(base_price > 0, DomainError::InvalidPrice);
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.dc_mint = dc_mint;
        config.treasury = treasury;
        config.domain_market = Pubkey::default();
        config.base_price = base_price;
        config.next_id = 1;
        config.paused = true;
        config.bump = ctx.bumps.config;
        emit!(DomainRegistryInitialized {
            authority: config.authority,
            dc_mint,
            treasury,
            base_price,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.paused = paused;
        emit!(DomainPauseUpdated { paused });
        Ok(())
    }

    pub fn set_base_price(ctx: Context<AdminConfig>, base_price: u64) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(base_price > 0, DomainError::InvalidPrice);
        let old_price = ctx.accounts.config.base_price;
        ctx.accounts.config.base_price = base_price;
        emit!(DomainBasePriceUpdated {
            old_price,
            new_price: base_price,
        });
        Ok(())
    }

    pub fn set_treasury(ctx: Context<AdminConfig>, treasury: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(treasury != Pubkey::default(), DomainError::ZeroAddress);
        ctx.accounts.config.treasury = treasury;
        emit!(DomainTreasuryUpdated { treasury });
        Ok(())
    }

    pub fn set_domain_market(ctx: Context<AdminConfig>, domain_market: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.domain_market = domain_market;
        emit!(DomainMarketUpdated { domain_market });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            DomainError::ZeroAddress
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(DomainAuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            DomainError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = Pubkey::default();
        emit!(DomainAuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority,
        });
        Ok(())
    }

    pub fn register(ctx: Context<Register>, label: String, expected_id: u64) -> Result<()> {
        validate_label(&label)?;
        let config = &mut ctx.accounts.config;
        require!(!config.paused, DomainError::Paused);
        require_eq!(config.next_id, expected_id, DomainError::InvalidDomainId);
        require_keys_eq!(
            config.dc_mint,
            ctx.accounts.dc_mint.key(),
            DomainError::InvalidMint
        );
        require_keys_eq!(
            ctx.accounts.owner_dc.owner,
            ctx.accounts.owner.key(),
            DomainError::InvalidTokenOwner
        );
        require_keys_eq!(
            ctx.accounts.owner_dc.mint,
            config.dc_mint,
            DomainError::InvalidMint
        );
        require_keys_eq!(
            ctx.accounts.treasury_dc.owner,
            config.treasury,
            DomainError::InvalidTreasury
        );
        require_keys_eq!(
            ctx.accounts.treasury_dc.mint,
            config.dc_mint,
            DomainError::InvalidMint
        );

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.dc_token_program.key(),
                DcTransferChecked {
                    from: ctx.accounts.owner_dc.to_account_info(),
                    mint: ctx.accounts.dc_mint.to_account_info(),
                    to: ctx.accounts.treasury_dc.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            config.base_price,
            ctx.accounts.dc_mint.decimals,
        )?;

        let config_bump = [config.bump];
        let signer_seeds: &[&[u8]] = &[CONFIG_SEED, &config_bump];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.domain_token_program.key(),
                MintTo {
                    mint: ctx.accounts.domain_mint.to_account_info(),
                    to: ctx.accounts.owner_domain.to_account_info(),
                    authority: config.to_account_info(),
                },
                &[signer_seeds],
            ),
            1,
        )?;
        token::freeze_account(CpiContext::new_with_signer(
            ctx.accounts.domain_token_program.key(),
            FreezeAccount {
                account: ctx.accounts.owner_domain.to_account_info(),
                mint: ctx.accounts.domain_mint.to_account_info(),
                authority: config.to_account_info(),
            },
            &[signer_seeds],
        ))?;

        let domain = &mut ctx.accounts.domain;
        domain.id = expected_id;
        domain.label = label.clone();
        domain.mint = ctx.accounts.domain_mint.key();
        domain.owner = ctx.accounts.owner.key();
        domain.creator = ctx.accounts.owner.key();
        domain.resolve = ctx.accounts.owner.key();
        domain.description = String::new();
        domain.background_uri = String::new();
        domain.escrow_market = Pubkey::default();
        domain.bump = ctx.bumps.domain;
        domain.mint_bump = ctx.bumps.domain_mint;

        let id_map = &mut ctx.accounts.id_map;
        id_map.id = expected_id;
        id_map.domain = domain.key();
        id_map.bump = ctx.bumps.id_map;

        config.next_id = config
            .next_id
            .checked_add(1)
            .ok_or(DomainError::ArithmeticOverflow)?;
        emit!(DomainRegistered {
            owner: ctx.accounts.owner.key(),
            label,
            domain: domain.key(),
            mint: domain.mint,
            id: domain.id,
            price: config.base_price,
        });
        Ok(())
    }

    pub fn set_primary_domain(ctx: Context<SetPrimaryDomain>) -> Result<()> {
        assert_domain_owner(&ctx.accounts.domain, ctx.accounts.owner.key())?;
        let primary = &mut ctx.accounts.primary;
        primary.owner = ctx.accounts.owner.key();
        primary.domain = ctx.accounts.domain.key();
        primary.label = ctx.accounts.domain.label.clone();
        primary.bump = ctx.bumps.primary;
        emit!(PrimaryDomainUpdated {
            owner: primary.owner,
            domain: primary.domain,
            label: primary.label.clone(),
        });
        Ok(())
    }

    pub fn set_resolve(ctx: Context<UpdateDomain>, resolve: Pubkey) -> Result<()> {
        assert_domain_owner(&ctx.accounts.domain, ctx.accounts.owner.key())?;
        require!(resolve != Pubkey::default(), DomainError::ZeroAddress);
        ctx.accounts.domain.resolve = resolve;
        emit!(DomainResolveUpdated {
            domain: ctx.accounts.domain.key(),
            resolve,
        });
        Ok(())
    }

    pub fn set_metadata(
        ctx: Context<UpdateDomain>,
        description: String,
        background_uri: String,
    ) -> Result<()> {
        assert_domain_owner(&ctx.accounts.domain, ctx.accounts.owner.key())?;
        validate_json_safe(&description, MAX_DESCRIPTION_BYTES)?;
        validate_json_safe(&background_uri, MAX_BACKGROUND_URI_BYTES)?;
        ctx.accounts.domain.description = description;
        ctx.accounts.domain.background_uri = background_uri;
        emit!(DomainMetadataUpdated {
            domain: ctx.accounts.domain.key(),
            owner: ctx.accounts.owner.key(),
        });
        Ok(())
    }

    pub fn transfer_domain(ctx: Context<TransferDomain>) -> Result<()> {
        let config = &ctx.accounts.config;
        let domain = &mut ctx.accounts.domain;
        assert_domain_owner(domain, ctx.accounts.owner.key())?;
        require!(
            domain.escrow_market == Pubkey::default(),
            DomainError::DomainInEscrow
        );
        require!(
            ctx.accounts.new_owner.key() != Pubkey::default(),
            DomainError::ZeroAddress
        );
        require!(
            ctx.accounts.new_owner.key() != ctx.accounts.owner.key(),
            DomainError::SelfTransfer
        );
        validate_domain_token_accounts(
            domain,
            ctx.accounts.domain_mint.key(),
            &ctx.accounts.owner_domain,
            &ctx.accounts.new_owner_domain,
            ctx.accounts.owner.key(),
            ctx.accounts.new_owner.key(),
        )?;

        let config_bump = [config.bump];
        let signer_seeds: &[&[u8]] = &[CONFIG_SEED, &config_bump];
        token::thaw_account(CpiContext::new_with_signer(
            ctx.accounts.domain_token_program.key(),
            ThawAccount {
                account: ctx.accounts.owner_domain.to_account_info(),
                mint: ctx.accounts.domain_mint.to_account_info(),
                authority: config.to_account_info(),
            },
            &[signer_seeds],
        ))?;
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.domain_token_program.key(),
                DomainTransferChecked {
                    from: ctx.accounts.owner_domain.to_account_info(),
                    mint: ctx.accounts.domain_mint.to_account_info(),
                    to: ctx.accounts.new_owner_domain.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            1,
            0,
        )?;
        token::freeze_account(CpiContext::new_with_signer(
            ctx.accounts.domain_token_program.key(),
            FreezeAccount {
                account: ctx.accounts.new_owner_domain.to_account_info(),
                mint: ctx.accounts.domain_mint.to_account_info(),
                authority: config.to_account_info(),
            },
            &[signer_seeds],
        ))?;

        let old_owner = domain.owner;
        domain.owner = ctx.accounts.new_owner.key();
        domain.resolve = ctx.accounts.new_owner.key();
        emit!(DomainTransferred {
            domain: domain.key(),
            mint: domain.mint,
            old_owner,
            new_owner: domain.owner,
        });
        emit!(DomainResolveUpdated {
            domain: domain.key(),
            resolve: domain.resolve,
        });
        Ok(())
    }

    pub fn escrow_for_market(ctx: Context<MarketEscrowDomain>) -> Result<()> {
        let config = &ctx.accounts.config;
        let domain = &mut ctx.accounts.domain;
        require_keys_eq!(
            config.domain_market,
            ctx.accounts.market_authority.key(),
            DomainError::InvalidMarket
        );
        assert_domain_owner(domain, ctx.accounts.owner.key())?;
        require!(
            domain.escrow_market == Pubkey::default(),
            DomainError::DomainInEscrow
        );
        validate_domain_token_accounts(
            domain,
            ctx.accounts.domain_mint.key(),
            &ctx.accounts.owner_domain,
            &ctx.accounts.market_domain,
            ctx.accounts.owner.key(),
            ctx.accounts.market_authority.key(),
        )?;
        move_frozen_domain(
            config,
            &ctx.accounts.domain_mint,
            &ctx.accounts.owner_domain,
            &ctx.accounts.market_domain,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.domain_token_program,
        )?;
        domain.escrow_market = ctx.accounts.market_authority.key();
        emit!(DomainEscrowed {
            domain: domain.key(),
            owner: domain.owner,
            market: domain.escrow_market,
        });
        Ok(())
    }

    pub fn release_from_market(ctx: Context<MarketReleaseDomain>, sold: bool) -> Result<()> {
        let config = &ctx.accounts.config;
        let domain = &mut ctx.accounts.domain;
        require_keys_eq!(
            config.domain_market,
            ctx.accounts.market_authority.key(),
            DomainError::InvalidMarket
        );
        require_keys_eq!(
            domain.escrow_market,
            ctx.accounts.market_authority.key(),
            DomainError::InvalidMarket
        );
        require_keys_eq!(
            ctx.accounts.market_domain.mint,
            domain.mint,
            DomainError::InvalidMint
        );
        require_keys_eq!(
            ctx.accounts.market_domain.owner,
            ctx.accounts.market_authority.key(),
            DomainError::InvalidTokenOwner
        );
        require_eq!(
            ctx.accounts.market_domain.amount,
            1,
            DomainError::InvalidDomainBalance
        );
        require_keys_eq!(
            ctx.accounts.destination_domain.mint,
            domain.mint,
            DomainError::InvalidMint
        );
        require_keys_eq!(
            ctx.accounts.destination_domain.owner,
            ctx.accounts.destination_owner.key(),
            DomainError::InvalidTokenOwner
        );
        if !sold {
            require_keys_eq!(
                ctx.accounts.destination_owner.key(),
                domain.owner,
                DomainError::InvalidDestinationOwner
            );
        }

        move_frozen_domain(
            config,
            &ctx.accounts.domain_mint,
            &ctx.accounts.market_domain,
            &ctx.accounts.destination_domain,
            &ctx.accounts.market_authority.to_account_info(),
            &ctx.accounts.domain_token_program,
        )?;
        let old_owner = domain.owner;
        if sold {
            require!(
                ctx.accounts.destination_owner.key() != old_owner,
                DomainError::SelfTransfer
            );
            domain.owner = ctx.accounts.destination_owner.key();
            domain.resolve = ctx.accounts.destination_owner.key();
        }
        domain.escrow_market = Pubkey::default();
        emit!(DomainMarketReleased {
            domain: domain.key(),
            old_owner,
            destination_owner: ctx.accounts.destination_owner.key(),
            sold,
        });
        if sold {
            emit!(DomainResolveUpdated {
                domain: domain.key(),
                resolve: domain.resolve,
            });
        }
        Ok(())
    }
}

fn assert_authority(config: &DomainConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(config.authority, authority.key(), DomainError::Unauthorized);
    Ok(())
}

fn assert_domain_owner(domain: &DomainRecord, owner: Pubkey) -> Result<()> {
    require_keys_eq!(domain.owner, owner, DomainError::NotDomainOwner);
    Ok(())
}

fn validate_label(label: &str) -> Result<()> {
    require_eq!(label.len(), LABEL_BYTES, DomainError::InvalidLabelLength);
    for byte in label.bytes() {
        require!(
            byte.is_ascii_alphanumeric(),
            DomainError::InvalidLabelCharacter
        );
    }
    Ok(())
}

fn validate_json_safe(value: &str, max_bytes: usize) -> Result<()> {
    require!(value.len() <= max_bytes, DomainError::MetadataTooLong);
    for byte in value.bytes() {
        require!(
            byte >= 0x20 && byte != b'"' && byte != b'\\',
            DomainError::UnsafeMetadataCharacter
        );
    }
    Ok(())
}

fn validate_domain_token_accounts(
    domain: &DomainRecord,
    mint: Pubkey,
    source: &DomainTokenAccount,
    destination: &DomainTokenAccount,
    owner: Pubkey,
    new_owner: Pubkey,
) -> Result<()> {
    require_keys_eq!(domain.mint, mint, DomainError::InvalidMint);
    require_keys_eq!(source.mint, mint, DomainError::InvalidMint);
    require_keys_eq!(source.owner, owner, DomainError::InvalidTokenOwner);
    require_eq!(source.amount, 1, DomainError::InvalidDomainBalance);
    require_keys_eq!(destination.mint, mint, DomainError::InvalidMint);
    require_keys_eq!(destination.owner, new_owner, DomainError::InvalidTokenOwner);
    Ok(())
}

fn move_frozen_domain<'info, A: ToAccountInfo<'info>>(
    config: &Account<'info, DomainConfig>,
    mint: &Account<'info, DomainMint>,
    source: &Account<'info, DomainTokenAccount>,
    destination: &Account<'info, DomainTokenAccount>,
    transfer_authority: &A,
    token_program: &Program<'info, Token>,
) -> Result<()> {
    let config_bump = [config.bump];
    let signer_seeds: &[&[u8]] = &[CONFIG_SEED, &config_bump];
    token::thaw_account(CpiContext::new_with_signer(
        token_program.key(),
        ThawAccount {
            account: source.to_account_info(),
            mint: mint.to_account_info(),
            authority: config.to_account_info(),
        },
        &[signer_seeds],
    ))?;
    token::transfer_checked(
        CpiContext::new(
            token_program.key(),
            DomainTransferChecked {
                from: source.to_account_info(),
                mint: mint.to_account_info(),
                to: destination.to_account_info(),
                authority: transfer_authority.to_account_info(),
            },
        ),
        1,
        0,
    )?;
    token::freeze_account(CpiContext::new_with_signer(
        token_program.key(),
        FreezeAccount {
            account: destination.to_account_info(),
            mint: mint.to_account_info(),
            authority: config.to_account_info(),
        },
        &[signer_seeds],
    ))
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(init, payer = payer, space = DomainConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, DomainConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DomainConfig>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DomainConfig>,
}

#[derive(Accounts)]
#[instruction(label: String, expected_id: u64)]
pub struct Register<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, DomainConfig>>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub owner_dc: Box<InterfaceAccount<'info, DcTokenAccount>>,
    #[account(mut)]
    pub treasury_dc: Box<InterfaceAccount<'info, DcTokenAccount>>,
    pub dc_mint: Box<InterfaceAccount<'info, DcMint>>,
    pub dc_token_program: Interface<'info, TokenInterface>,
    #[account(
        init,
        payer = owner,
        seeds = [DOMAIN_MINT_SEED, label.as_bytes()],
        bump,
        mint::decimals = 0,
        mint::authority = config,
        mint::freeze_authority = config,
        mint::token_program = domain_token_program
    )]
    pub domain_mint: Box<Account<'info, DomainMint>>,
    #[account(
        init,
        payer = owner,
        associated_token::mint = domain_mint,
        associated_token::authority = owner,
        associated_token::token_program = domain_token_program
    )]
    pub owner_domain: Box<Account<'info, DomainTokenAccount>>,
    #[account(
        init,
        payer = owner,
        space = DomainRecord::SPACE,
        seeds = [DOMAIN_SEED, label.as_bytes()],
        bump
    )]
    pub domain: Box<Account<'info, DomainRecord>>,
    #[account(
        init,
        payer = owner,
        space = DomainIdMap::SPACE,
        seeds = [DOMAIN_ID_SEED, &expected_id.to_le_bytes()],
        bump
    )]
    pub id_map: Box<Account<'info, DomainIdMap>>,
    pub domain_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPrimaryDomain<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [DOMAIN_SEED, domain.label.as_bytes()], bump = domain.bump)]
    pub domain: Account<'info, DomainRecord>,
    #[account(
        init_if_needed,
        payer = owner,
        space = PrimaryDomain::SPACE,
        seeds = [PRIMARY_SEED, owner.key().as_ref()],
        bump
    )]
    pub primary: Account<'info, PrimaryDomain>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateDomain<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [DOMAIN_SEED, domain.label.as_bytes()], bump = domain.bump)]
    pub domain: Account<'info, DomainRecord>,
}

#[derive(Accounts)]
pub struct TransferDomain<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, DomainConfig>>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: Used as the destination owner and checked against its ATA.
    pub new_owner: UncheckedAccount<'info>,
    #[account(mut, seeds = [DOMAIN_SEED, domain.label.as_bytes()], bump = domain.bump)]
    pub domain: Box<Account<'info, DomainRecord>>,
    #[account(mut, seeds = [DOMAIN_MINT_SEED, domain.label.as_bytes()], bump = domain.mint_bump)]
    pub domain_mint: Box<Account<'info, DomainMint>>,
    #[account(mut)]
    pub owner_domain: Box<Account<'info, DomainTokenAccount>>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = domain_mint,
        associated_token::authority = new_owner,
        associated_token::token_program = domain_token_program
    )]
    pub new_owner_domain: Box<Account<'info, DomainTokenAccount>>,
    pub domain_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MarketEscrowDomain<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, DomainConfig>>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub market_authority: Signer<'info>,
    #[account(mut, seeds = [DOMAIN_SEED, domain.label.as_bytes()], bump = domain.bump)]
    pub domain: Box<Account<'info, DomainRecord>>,
    #[account(mut, seeds = [DOMAIN_MINT_SEED, domain.label.as_bytes()], bump = domain.mint_bump)]
    pub domain_mint: Box<Account<'info, DomainMint>>,
    #[account(mut)]
    pub owner_domain: Box<Account<'info, DomainTokenAccount>>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = domain_mint,
        associated_token::authority = market_authority,
        associated_token::token_program = domain_token_program
    )]
    pub market_domain: Box<Account<'info, DomainTokenAccount>>,
    pub domain_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MarketReleaseDomain<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, DomainConfig>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub market_authority: Signer<'info>,
    /// CHECK: Its associated token account is constrained below.
    pub destination_owner: UncheckedAccount<'info>,
    #[account(mut, seeds = [DOMAIN_SEED, domain.label.as_bytes()], bump = domain.bump)]
    pub domain: Box<Account<'info, DomainRecord>>,
    #[account(mut, seeds = [DOMAIN_MINT_SEED, domain.label.as_bytes()], bump = domain.mint_bump)]
    pub domain_mint: Box<Account<'info, DomainMint>>,
    #[account(mut)]
    pub market_domain: Box<Account<'info, DomainTokenAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = domain_mint,
        associated_token::authority = destination_owner,
        associated_token::token_program = domain_token_program
    )]
    pub destination_domain: Box<Account<'info, DomainTokenAccount>>,
    pub domain_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct DomainConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub dc_mint: Pubkey,
    pub treasury: Pubkey,
    pub domain_market: Pubkey,
    pub base_price: u64,
    pub next_id: u64,
    pub paused: bool,
    pub bump: u8,
}

impl DomainConfig {
    pub const SPACE: usize = 8 + (32 * 5) + (8 * 2) + 1 + 1;
}

#[account]
pub struct DomainRecord {
    pub id: u64,
    pub label: String,
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub creator: Pubkey,
    pub resolve: Pubkey,
    pub description: String,
    pub background_uri: String,
    pub escrow_market: Pubkey,
    pub bump: u8,
    pub mint_bump: u8,
}

impl DomainRecord {
    pub const SPACE: usize = 8
        + 8
        + 4
        + LABEL_BYTES
        + (32 * 6)
        + 4
        + MAX_DESCRIPTION_BYTES
        + 4
        + MAX_BACKGROUND_URI_BYTES
        + 1
        + 1;
}

#[account]
pub struct DomainIdMap {
    pub id: u64,
    pub domain: Pubkey,
    pub bump: u8,
}

impl DomainIdMap {
    pub const SPACE: usize = 8 + 8 + 32 + 1;
}

#[account]
pub struct PrimaryDomain {
    pub owner: Pubkey,
    pub domain: Pubkey,
    pub label: String,
    pub bump: u8,
}

impl PrimaryDomain {
    pub const SPACE: usize = 8 + 32 + 32 + 4 + LABEL_BYTES + 1;
}

#[event]
pub struct DomainRegistryInitialized {
    pub authority: Pubkey,
    pub dc_mint: Pubkey,
    pub treasury: Pubkey,
    pub base_price: u64,
}

#[event]
pub struct DomainRegistered {
    pub owner: Pubkey,
    pub label: String,
    pub domain: Pubkey,
    pub mint: Pubkey,
    pub id: u64,
    pub price: u64,
}

#[event]
pub struct DomainTransferred {
    pub domain: Pubkey,
    pub mint: Pubkey,
    pub old_owner: Pubkey,
    pub new_owner: Pubkey,
}

#[event]
pub struct DomainEscrowed {
    pub domain: Pubkey,
    pub owner: Pubkey,
    pub market: Pubkey,
}
#[event]
pub struct DomainMarketReleased {
    pub domain: Pubkey,
    pub old_owner: Pubkey,
    pub destination_owner: Pubkey,
    pub sold: bool,
}

#[event]
pub struct DomainResolveUpdated {
    pub domain: Pubkey,
    pub resolve: Pubkey,
}
#[event]
pub struct DomainMetadataUpdated {
    pub domain: Pubkey,
    pub owner: Pubkey,
}
#[event]
pub struct PrimaryDomainUpdated {
    pub owner: Pubkey,
    pub domain: Pubkey,
    pub label: String,
}
#[event]
pub struct DomainPauseUpdated {
    pub paused: bool,
}
#[event]
pub struct DomainBasePriceUpdated {
    pub old_price: u64,
    pub new_price: u64,
}
#[event]
pub struct DomainTreasuryUpdated {
    pub treasury: Pubkey,
}
#[event]
pub struct DomainMarketUpdated {
    pub domain_market: Pubkey,
}
#[event]
pub struct DomainAuthorityProposed {
    pub pending_authority: Pubkey,
}
#[event]
pub struct DomainAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[error_code]
pub enum DomainError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("pending authority is invalid")]
    InvalidPendingAuthority,
    #[msg("domain registration is paused")]
    Paused,
    #[msg("domain price must be positive")]
    InvalidPrice,
    #[msg("domain id does not match the next id")]
    InvalidDomainId,
    #[msg("domain label must be exactly six bytes")]
    InvalidLabelLength,
    #[msg("domain label must contain only ASCII letters and digits")]
    InvalidLabelCharacter,
    #[msg("token mint is invalid")]
    InvalidMint,
    #[msg("token account owner is invalid")]
    InvalidTokenOwner,
    #[msg("treasury token account is invalid")]
    InvalidTreasury,
    #[msg("caller is not the domain owner")]
    NotDomainOwner,
    #[msg("domain NFT balance must equal one")]
    InvalidDomainBalance,
    #[msg("domain is held by the market escrow")]
    DomainInEscrow,
    #[msg("domain cannot be transferred to the same owner")]
    SelfTransfer,
    #[msg("market authority is invalid")]
    InvalidMarket,
    #[msg("market release destination is invalid")]
    InvalidDestinationOwner,
    #[msg("domain metadata is too long")]
    MetadataTooLong,
    #[msg("domain metadata contains an unsafe JSON character")]
    UnsafeMetadataCharacter,
    #[msg("arithmetic overflow")]
    ArithmeticOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_evm_compatible_domain_labels() {
        assert!(validate_label("Ab12z9").is_ok());
        assert!(validate_label("short").is_err());
        assert!(validate_label("abcdefg").is_err());
        assert!(validate_label("abc-12").is_err());
    }

    #[test]
    fn metadata_rejects_unsafe_or_oversized_values() {
        assert!(validate_json_safe("ipfs://safe", MAX_BACKGROUND_URI_BYTES).is_ok());
        assert!(validate_json_safe("bad\\value", MAX_BACKGROUND_URI_BYTES).is_err());
        assert!(validate_json_safe(
            &"x".repeat(MAX_DESCRIPTION_BYTES + 1),
            MAX_DESCRIPTION_BYTES
        )
        .is_err());
    }
}
