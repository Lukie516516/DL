#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{
        self, FreezeAccount, Mint as IdentityMint, MintTo, ThawAccount, Token,
        TokenAccount as IdentityTokenAccount,
    },
    token_interface::{
        self, BurnChecked, Mint as DcMint, TokenAccount as DcTokenAccount, TokenInterface,
    },
};
use deal_core::state::{DealAccount, DealStatus};

declare_id!("GTVqt2Zky42gqpxoLC7Zc2xUWKDAdkzkw26MUogpRk7e");

pub const CONFIG_SEED: &[u8] = b"identity-config";
pub const IDENTITY_MINT_SEED: &[u8] = b"identity-mint";
pub const IDENTITY_SEED: &[u8] = b"identity";
pub const PROFILE_SEED: &[u8] = b"profile";
pub const DATE_COUNTER_SEED: &[u8] = b"date-counter";
pub const LOCK_SEED: &[u8] = b"identity-lock";
pub const BINDING_SEED: &[u8] = b"deal-identity";

pub const MAX_IMAGE_URI_BYTES: usize = 512;
pub const MAX_USERNAME_BYTES: usize = 64;
pub const MAX_USER_DETAIL_BYTES: usize = 1_000;

#[program]
pub mod deal_identity {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        dc_mint: Pubkey,
        trusted_controller: Pubkey,
        mint_price: u64,
        min_mint_price: u64,
        max_mint_price: u64,
    ) -> Result<()> {
        require!(dc_mint != Pubkey::default(), IdentityError::ZeroAddress);
        require!(
            trusted_controller != Pubkey::default(),
            IdentityError::ZeroAddress
        );
        validate_price(mint_price, min_mint_price, max_mint_price)?;
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.dc_mint = dc_mint;
        config.trusted_controller = trusted_controller;
        config.reward_controller = trusted_controller;
        config.next_id = 1;
        config.current_season = 1;
        config.mint_price = mint_price;
        config.min_mint_price = min_mint_price;
        config.max_mint_price = max_mint_price;
        config.paused = true;
        config.bump = ctx.bumps.config;
        emit!(IdentityConfigInitialized {
            authority: config.authority,
            dc_mint,
            trusted_controller,
            mint_price,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.paused = paused;
        emit!(IdentityPauseUpdated { paused });
        Ok(())
    }

    pub fn set_mint_price(ctx: Context<AdminConfig>, mint_price: u64) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        validate_price(
            mint_price,
            ctx.accounts.config.min_mint_price,
            ctx.accounts.config.max_mint_price,
        )?;
        let old_price = ctx.accounts.config.mint_price;
        ctx.accounts.config.mint_price = mint_price;
        emit!(IdentityMintPriceUpdated {
            old_price,
            new_price: mint_price,
        });
        Ok(())
    }

    pub fn set_mint_price_bounds(
        ctx: Context<AdminConfig>,
        min_mint_price: u64,
        max_mint_price: u64,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        validate_price(
            ctx.accounts.config.mint_price,
            min_mint_price,
            max_mint_price,
        )?;
        ctx.accounts.config.min_mint_price = min_mint_price;
        ctx.accounts.config.max_mint_price = max_mint_price;
        emit!(IdentityMintBoundsUpdated {
            min_mint_price,
            max_mint_price,
        });
        Ok(())
    }

    pub fn set_current_season(ctx: Context<AdminConfig>, current_season: u16) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(current_season > 0, IdentityError::InvalidSeason);
        ctx.accounts.config.current_season = current_season;
        emit!(IdentitySeasonUpdated { current_season });
        Ok(())
    }

    pub fn set_trusted_controller(
        ctx: Context<AdminConfig>,
        trusted_controller: Pubkey,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            trusted_controller != Pubkey::default(),
            IdentityError::ZeroAddress
        );
        ctx.accounts.config.trusted_controller = trusted_controller;
        emit!(IdentityControllerUpdated { trusted_controller });
        Ok(())
    }

    pub fn set_reward_controller(
        ctx: Context<AdminConfig>,
        reward_controller: Pubkey,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            reward_controller != Pubkey::default(),
            IdentityError::ZeroAddress
        );
        ctx.accounts.config.reward_controller = reward_controller;
        emit!(IdentityRewardControllerUpdated { reward_controller });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            IdentityError::ZeroAddress
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(IdentityAuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            IdentityError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = Pubkey::default();
        emit!(IdentityAuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority,
        });
        Ok(())
    }

    pub fn mint_identity(
        ctx: Context<MintIdentity>,
        identity_id: u64,
        expected_date_code: u32,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(!config.paused, IdentityError::Paused);
        require_eq!(
            identity_id,
            config.next_id,
            IdentityError::InvalidIdentityId
        );
        require_keys_eq!(
            config.dc_mint,
            ctx.accounts.dc_mint.key(),
            IdentityError::InvalidMint
        );
        require_keys_eq!(
            ctx.accounts.owner_dc.owner,
            ctx.accounts.owner.key(),
            IdentityError::InvalidTokenOwner
        );
        require_keys_eq!(
            ctx.accounts.owner_dc.mint,
            ctx.accounts.dc_mint.key(),
            IdentityError::InvalidMint
        );
        let now = Clock::get()?.unix_timestamp;
        let date_code = date_code_from_timestamp(now)?;
        require_eq!(
            date_code,
            expected_date_code,
            IdentityError::InvalidDateCode
        );

        token_interface::burn_checked(
            CpiContext::new(
                ctx.accounts.dc_token_program.key(),
                BurnChecked {
                    mint: ctx.accounts.dc_mint.to_account_info(),
                    from: ctx.accounts.owner_dc.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            config.mint_price,
            ctx.accounts.dc_mint.decimals,
        )?;

        let config_bump = [config.bump];
        let signer_seeds: &[&[u8]] = &[CONFIG_SEED, &config_bump];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.identity_token_program.key(),
                MintTo {
                    mint: ctx.accounts.identity_mint.to_account_info(),
                    to: ctx.accounts.owner_identity.to_account_info(),
                    authority: config.to_account_info(),
                },
                &[signer_seeds],
            ),
            1,
        )?;

        let counter = &mut ctx.accounts.date_counter;
        if counter.season == 0 {
            counter.season = config.current_season;
            counter.date_code = date_code;
            counter.count = 0;
            counter.bump = ctx.bumps.date_counter;
        }
        counter.count = counter
            .count
            .checked_add(1)
            .ok_or_else(|| error!(IdentityError::CounterOverflow))?;

        let identity = &mut ctx.accounts.identity;
        identity.id = identity_id;
        identity.mint = ctx.accounts.identity_mint.key();
        identity.season = config.current_season;
        identity.date_code = date_code;
        identity.daily_serial = counter.count;
        identity.total_dc_minted = 0;
        identity.max_partner = identity.mint;
        identity.lock_count = 0;
        identity.bump = ctx.bumps.identity;

        let profile = &mut ctx.accounts.profile;
        profile.identity_mint = identity.mint;
        profile.image_uri = String::new();
        profile.username = String::new();
        profile.user_detail = String::new();
        profile.bump = ctx.bumps.profile;

        config.next_id = config
            .next_id
            .checked_add(1)
            .ok_or_else(|| error!(IdentityError::CounterOverflow))?;
        emit!(IdentityMinted {
            owner: ctx.accounts.owner.key(),
            identity_mint: identity.mint,
            identity_id,
            season: identity.season,
            date_code,
            daily_serial: identity.daily_serial,
            dc_burned: config.mint_price,
        });
        Ok(())
    }

    pub fn set_profile(
        ctx: Context<SetProfile>,
        image_uri: String,
        username: String,
        user_detail: String,
    ) -> Result<()> {
        assert_identity_owner(
            &ctx.accounts.owner_identity,
            ctx.accounts.owner.key(),
            ctx.accounts.identity_mint.key(),
        )?;
        validate_json_safe(&image_uri, MAX_IMAGE_URI_BYTES)?;
        validate_json_safe(&username, MAX_USERNAME_BYTES)?;
        validate_json_safe(&user_detail, MAX_USER_DETAIL_BYTES)?;
        let profile = &mut ctx.accounts.profile;
        profile.image_uri = image_uri;
        profile.username = username;
        profile.user_detail = user_detail;
        emit!(IdentityProfileUpdated {
            identity_mint: ctx.accounts.identity_mint.key(),
            owner: ctx.accounts.owner.key(),
        });
        Ok(())
    }

    pub fn add_minted(ctx: Context<ControllerIdentity>, amount: u64) -> Result<()> {
        assert_controller(&ctx.accounts.config, &ctx.accounts.controller)?;
        add_minted_total(&mut ctx.accounts.identity, amount)
    }

    pub fn add_reward_minted(ctx: Context<ControllerIdentity>, amount: u64) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.reward_controller,
            ctx.accounts.controller.key(),
            IdentityError::UnauthorizedRewardController
        );
        add_minted_total(&mut ctx.accounts.identity, amount)
    }

    pub fn set_max_partner(ctx: Context<SetMaxPartner>, partner_mint: Pubkey) -> Result<()> {
        assert_controller(&ctx.accounts.config, &ctx.accounts.controller)?;
        require_keys_eq!(
            ctx.accounts.partner_identity.mint,
            partner_mint,
            IdentityError::InvalidIdentity
        );
        ctx.accounts.identity.max_partner = partner_mint;
        emit!(IdentityMaxPartnerUpdated {
            identity_mint: ctx.accounts.identity.mint,
            partner_mint,
        });
        Ok(())
    }

    pub fn lock_identity(ctx: Context<LockIdentity>) -> Result<()> {
        assert_controller(&ctx.accounts.config, &ctx.accounts.controller)?;
        require!(
            !matches!(
                ctx.accounts.deal.status,
                DealStatus::Completed | DealStatus::Canceled | DealStatus::Abandoned
            ),
            IdentityError::DealAlreadyTerminal
        );
        assert_identity_owner(
            &ctx.accounts.owner_identity,
            ctx.accounts.owner.key(),
            ctx.accounts.identity_mint.key(),
        )?;
        let party = ctx.accounts.owner.key();
        require!(
            party == ctx.accounts.deal.creator || party == ctx.accounts.deal.participant,
            IdentityError::InvalidDealParty
        );
        let binding = &mut ctx.accounts.binding;
        if binding.deal == Pubkey::default() {
            binding.deal = ctx.accounts.deal.key();
            binding.party = party;
            binding.identity_mint = ctx.accounts.identity_mint.key();
            binding.lock_count = 0;
            binding.bump = ctx.bumps.binding;
            emit!(DealIdentityBound {
                deal: binding.deal,
                party,
                identity_mint: binding.identity_mint,
            });
        }
        require_keys_eq!(
            binding.identity_mint,
            ctx.accounts.identity_mint.key(),
            IdentityError::IdentityAlreadyBound
        );
        require_keys_eq!(
            binding.deal,
            ctx.accounts.deal.key(),
            IdentityError::InvalidBinding
        );
        require_keys_eq!(binding.party, party, IdentityError::InvalidBinding);
        let lock = &mut ctx.accounts.lock;
        if lock.identity_mint == Pubkey::default() {
            lock.identity_mint = ctx.accounts.identity_mint.key();
            lock.deal = ctx.accounts.deal.key();
            lock.count = 0;
            lock.bump = ctx.bumps.lock;
        }
        require_keys_eq!(
            lock.identity_mint,
            ctx.accounts.identity_mint.key(),
            IdentityError::InvalidLockState
        );
        require_keys_eq!(
            lock.deal,
            ctx.accounts.deal.key(),
            IdentityError::InvalidLockState
        );
        require!(
            lock.count == 0 && binding.lock_count == 0,
            IdentityError::AlreadyLockedByDeal
        );
        if ctx.accounts.identity.lock_count == 0 {
            let config_bump = [ctx.accounts.config.bump];
            let signer_seeds: &[&[u8]] = &[CONFIG_SEED, &config_bump];
            token::freeze_account(CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                FreezeAccount {
                    account: ctx.accounts.owner_identity.to_account_info(),
                    mint: ctx.accounts.identity_mint.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[signer_seeds],
            ))?;
        }
        lock.count = lock
            .count
            .checked_add(1)
            .ok_or_else(|| error!(IdentityError::CounterOverflow))?;
        binding.lock_count = binding
            .lock_count
            .checked_add(1)
            .ok_or_else(|| error!(IdentityError::CounterOverflow))?;
        ctx.accounts.identity.lock_count = ctx
            .accounts
            .identity
            .lock_count
            .checked_add(1)
            .ok_or_else(|| error!(IdentityError::CounterOverflow))?;
        emit!(IdentityLocked {
            identity_mint: ctx.accounts.identity_mint.key(),
            deal: ctx.accounts.deal.key(),
            total_locks: ctx.accounts.identity.lock_count,
        });
        Ok(())
    }

    pub fn unlock_identity(ctx: Context<UnlockIdentity>) -> Result<()> {
        assert_controller(&ctx.accounts.config, &ctx.accounts.controller)?;
        require!(
            matches!(
                ctx.accounts.deal.status,
                DealStatus::Completed | DealStatus::Canceled | DealStatus::Abandoned
            ),
            IdentityError::DealNotTerminal
        );
        require_keys_eq!(
            ctx.accounts.owner_identity.mint,
            ctx.accounts.identity_mint.key(),
            IdentityError::InvalidMint
        );
        require_eq!(
            ctx.accounts.owner_identity.amount,
            1,
            IdentityError::InvalidIdentityBalance
        );
        require!(
            ctx.accounts.lock.count > 0
                && ctx.accounts.binding.lock_count > 0
                && ctx.accounts.identity.lock_count > 0,
            IdentityError::InvalidLockState
        );
        ctx.accounts.lock.count -= 1;
        ctx.accounts.binding.lock_count -= 1;
        ctx.accounts.identity.lock_count -= 1;
        if ctx.accounts.identity.lock_count == 0 {
            let config_bump = [ctx.accounts.config.bump];
            let signer_seeds: &[&[u8]] = &[CONFIG_SEED, &config_bump];
            token::thaw_account(CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                ThawAccount {
                    account: ctx.accounts.owner_identity.to_account_info(),
                    mint: ctx.accounts.identity_mint.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[signer_seeds],
            ))?;
        }
        emit!(IdentityUnlocked {
            identity_mint: ctx.accounts.identity_mint.key(),
            deal: ctx.accounts.deal.key(),
            remaining_locks: ctx.accounts.identity.lock_count,
        });
        Ok(())
    }
}

fn add_minted_total(identity: &mut Account<'_, IdentityRecord>, amount: u64) -> Result<()> {
    identity.total_dc_minted = identity
        .total_dc_minted
        .checked_add(u128::from(amount))
        .ok_or_else(|| error!(IdentityError::CounterOverflow))?;
    emit!(IdentityMintedTotalAdded {
        identity_mint: identity.mint,
        amount,
        new_total: identity.total_dc_minted,
    });
    Ok(())
}

fn assert_authority(config: &IdentityConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        config.authority,
        authority.key(),
        IdentityError::Unauthorized
    );
    Ok(())
}

fn assert_controller(config: &IdentityConfig, controller: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        config.trusted_controller,
        controller.key(),
        IdentityError::UnauthorizedController
    );
    Ok(())
}

fn assert_identity_owner(
    account: &IdentityTokenAccount,
    owner: Pubkey,
    mint: Pubkey,
) -> Result<()> {
    require_keys_eq!(account.owner, owner, IdentityError::InvalidTokenOwner);
    require_keys_eq!(account.mint, mint, IdentityError::InvalidMint);
    require_eq!(account.amount, 1, IdentityError::InvalidIdentityBalance);
    Ok(())
}

fn validate_price(price: u64, minimum: u64, maximum: u64) -> Result<()> {
    require!(
        minimum > 0 && minimum <= maximum,
        IdentityError::InvalidPriceBounds
    );
    require!(
        (minimum..=maximum).contains(&price),
        IdentityError::InvalidMintPrice
    );
    Ok(())
}

fn validate_json_safe(value: &str, max_bytes: usize) -> Result<()> {
    require!(value.len() <= max_bytes, IdentityError::ProfileTooLong);
    for byte in value.bytes() {
        require!(
            byte >= 0x20 && byte != b'"' && byte != b'\\',
            IdentityError::UnsafeProfileCharacter
        );
    }
    Ok(())
}

fn date_code_from_timestamp(timestamp: i64) -> Result<u32> {
    require!(timestamp >= 0, IdentityError::InvalidTimestamp);
    let days = timestamp / 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    let date = year
        .checked_mul(10_000)
        .and_then(|v| v.checked_add(month * 100))
        .and_then(|v| v.checked_add(day))
        .ok_or_else(|| error!(IdentityError::InvalidTimestamp))?;
    u32::try_from(date).map_err(|_| error!(IdentityError::InvalidTimestamp))
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(init, payer = payer, space = IdentityConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, IdentityConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, IdentityConfig>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, IdentityConfig>,
}

#[derive(Accounts)]
#[instruction(identity_id: u64, expected_date_code: u32)]
pub struct MintIdentity<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, IdentityConfig>>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub owner_dc: Box<InterfaceAccount<'info, DcTokenAccount>>,
    #[account(mut)]
    pub dc_mint: Box<InterfaceAccount<'info, DcMint>>,
    pub dc_token_program: Interface<'info, TokenInterface>,
    #[account(
        init,
        payer = owner,
        seeds = [IDENTITY_MINT_SEED, &identity_id.to_le_bytes()],
        bump,
        mint::decimals = 0,
        mint::authority = config,
        mint::freeze_authority = config,
        mint::token_program = identity_token_program
    )]
    pub identity_mint: Box<Account<'info, IdentityMint>>,
    #[account(
        init,
        payer = owner,
        associated_token::mint = identity_mint,
        associated_token::authority = owner,
        associated_token::token_program = identity_token_program
    )]
    pub owner_identity: Box<Account<'info, IdentityTokenAccount>>,
    #[account(
        init,
        payer = owner,
        space = IdentityRecord::SPACE,
        seeds = [IDENTITY_SEED, identity_mint.key().as_ref()],
        bump
    )]
    pub identity: Box<Account<'info, IdentityRecord>>,
    #[account(
        init,
        payer = owner,
        space = IdentityProfile::SPACE,
        seeds = [PROFILE_SEED, identity_mint.key().as_ref()],
        bump
    )]
    pub profile: Box<Account<'info, IdentityProfile>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = DateCounter::SPACE,
        seeds = [
            DATE_COUNTER_SEED,
            &config.current_season.to_le_bytes(),
            &expected_date_code.to_le_bytes()
        ],
        bump
    )]
    pub date_counter: Box<Account<'info, DateCounter>>,
    pub identity_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetProfile<'info> {
    pub owner: Signer<'info>,
    pub identity_mint: Account<'info, IdentityMint>,
    pub owner_identity: Account<'info, IdentityTokenAccount>,
    #[account(seeds = [IDENTITY_SEED, identity_mint.key().as_ref()], bump = identity.bump)]
    pub identity: Account<'info, IdentityRecord>,
    #[account(mut, seeds = [PROFILE_SEED, identity_mint.key().as_ref()], bump = profile.bump)]
    pub profile: Account<'info, IdentityProfile>,
}

#[derive(Accounts)]
pub struct ControllerIdentity<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, IdentityConfig>,
    pub controller: Signer<'info>,
    #[account(mut, seeds = [IDENTITY_SEED, identity.mint.as_ref()], bump = identity.bump)]
    pub identity: Account<'info, IdentityRecord>,
}

#[derive(Accounts)]
#[instruction(partner_mint: Pubkey)]
pub struct SetMaxPartner<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, IdentityConfig>,
    pub controller: Signer<'info>,
    #[account(mut, seeds = [IDENTITY_SEED, identity.mint.as_ref()], bump = identity.bump)]
    pub identity: Account<'info, IdentityRecord>,
    #[account(seeds = [IDENTITY_SEED, partner_mint.as_ref()], bump = partner_identity.bump)]
    pub partner_identity: Account<'info, IdentityRecord>,
}

#[derive(Accounts)]
pub struct LockIdentity<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, IdentityConfig>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub controller: Signer<'info>,
    pub deal: Box<Account<'info, DealAccount>>,
    /// CHECK: Owner is checked against the identity token account.
    pub owner: UncheckedAccount<'info>,
    #[account(mut)]
    pub identity_mint: Box<Account<'info, IdentityMint>>,
    #[account(mut)]
    pub owner_identity: Box<Account<'info, IdentityTokenAccount>>,
    #[account(mut, seeds = [IDENTITY_SEED, identity_mint.key().as_ref()], bump = identity.bump)]
    pub identity: Box<Account<'info, IdentityRecord>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = DealIdentityBinding::SPACE,
        seeds = [BINDING_SEED, deal.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub binding: Box<Account<'info, DealIdentityBinding>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = IdentityLock::SPACE,
        seeds = [LOCK_SEED, identity_mint.key().as_ref(), deal.key().as_ref()],
        bump
    )]
    pub lock: Box<Account<'info, IdentityLock>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnlockIdentity<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, IdentityConfig>>,
    pub controller: Signer<'info>,
    pub deal: Box<Account<'info, DealAccount>>,
    #[account(mut)]
    pub identity_mint: Box<Account<'info, IdentityMint>>,
    #[account(mut)]
    pub owner_identity: Box<Account<'info, IdentityTokenAccount>>,
    #[account(mut, seeds = [IDENTITY_SEED, identity_mint.key().as_ref()], bump = identity.bump)]
    pub identity: Box<Account<'info, IdentityRecord>>,
    #[account(
        mut,
        seeds = [BINDING_SEED, deal.key().as_ref(), owner_identity.owner.as_ref()],
        bump = binding.bump,
        constraint = binding.deal == deal.key() @ IdentityError::InvalidBinding,
        constraint = binding.party == owner_identity.owner @ IdentityError::InvalidBinding,
        constraint = binding.identity_mint == identity_mint.key() @ IdentityError::InvalidBinding
    )]
    pub binding: Box<Account<'info, DealIdentityBinding>>,
    #[account(
        mut,
        seeds = [LOCK_SEED, identity_mint.key().as_ref(), deal.key().as_ref()],
        bump = lock.bump
    )]
    pub lock: Box<Account<'info, IdentityLock>>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct IdentityConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub dc_mint: Pubkey,
    pub trusted_controller: Pubkey,
    pub reward_controller: Pubkey,
    pub next_id: u64,
    pub current_season: u16,
    pub mint_price: u64,
    pub min_mint_price: u64,
    pub max_mint_price: u64,
    pub paused: bool,
    pub bump: u8,
}

impl IdentityConfig {
    pub const SPACE: usize = 8 + (32 * 5) + 8 + 2 + (8 * 3) + 1 + 1;
}

#[account]
pub struct IdentityRecord {
    pub id: u64,
    pub mint: Pubkey,
    pub season: u16,
    pub date_code: u32,
    pub daily_serial: u32,
    pub total_dc_minted: u128,
    pub max_partner: Pubkey,
    pub lock_count: u32,
    pub bump: u8,
}

impl IdentityRecord {
    pub const SPACE: usize = 8 + 8 + 32 + 2 + 4 + 4 + 16 + 32 + 4 + 1;
}

#[account]
pub struct IdentityProfile {
    pub identity_mint: Pubkey,
    pub image_uri: String,
    pub username: String,
    pub user_detail: String,
    pub bump: u8,
}

impl IdentityProfile {
    pub const SPACE: usize =
        8 + 32 + 4 + MAX_IMAGE_URI_BYTES + 4 + MAX_USERNAME_BYTES + 4 + MAX_USER_DETAIL_BYTES + 1;
}

#[account]
pub struct DateCounter {
    pub season: u16,
    pub date_code: u32,
    pub count: u32,
    pub bump: u8,
}

impl DateCounter {
    pub const SPACE: usize = 8 + 2 + 4 + 4 + 1;
}

#[account]
pub struct IdentityLock {
    pub identity_mint: Pubkey,
    pub deal: Pubkey,
    pub count: u32,
    pub bump: u8,
}

#[account]
pub struct DealIdentityBinding {
    pub deal: Pubkey,
    pub party: Pubkey,
    pub identity_mint: Pubkey,
    pub lock_count: u32,
    pub bump: u8,
}

impl DealIdentityBinding {
    pub const SPACE: usize = 8 + (32 * 3) + 4 + 1;
}

impl IdentityLock {
    pub const SPACE: usize = 8 + 32 + 32 + 4 + 1;
}

#[event]
pub struct IdentityConfigInitialized {
    pub authority: Pubkey,
    pub dc_mint: Pubkey,
    pub trusted_controller: Pubkey,
    pub mint_price: u64,
}

#[event]
pub struct IdentityPauseUpdated {
    pub paused: bool,
}

#[event]
pub struct IdentityMintPriceUpdated {
    pub old_price: u64,
    pub new_price: u64,
}

#[event]
pub struct IdentityMintBoundsUpdated {
    pub min_mint_price: u64,
    pub max_mint_price: u64,
}

#[event]
pub struct IdentitySeasonUpdated {
    pub current_season: u16,
}

#[event]
pub struct IdentityControllerUpdated {
    pub trusted_controller: Pubkey,
}

#[event]
pub struct IdentityRewardControllerUpdated {
    pub reward_controller: Pubkey,
}

#[event]
pub struct IdentityAuthorityProposed {
    pub pending_authority: Pubkey,
}

#[event]
pub struct IdentityAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct IdentityMinted {
    pub owner: Pubkey,
    pub identity_mint: Pubkey,
    pub identity_id: u64,
    pub season: u16,
    pub date_code: u32,
    pub daily_serial: u32,
    pub dc_burned: u64,
}

#[event]
pub struct IdentityProfileUpdated {
    pub identity_mint: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct IdentityMintedTotalAdded {
    pub identity_mint: Pubkey,
    pub amount: u64,
    pub new_total: u128,
}

#[event]
pub struct IdentityMaxPartnerUpdated {
    pub identity_mint: Pubkey,
    pub partner_mint: Pubkey,
}

#[event]
pub struct IdentityLocked {
    pub identity_mint: Pubkey,
    pub deal: Pubkey,
    pub total_locks: u32,
}

#[event]
pub struct DealIdentityBound {
    pub deal: Pubkey,
    pub party: Pubkey,
    pub identity_mint: Pubkey,
}

#[event]
pub struct IdentityUnlocked {
    pub identity_mint: Pubkey,
    pub deal: Pubkey,
    pub remaining_locks: u32,
}

#[error_code]
pub enum IdentityError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("trusted controller is not authorized")]
    UnauthorizedController,
    #[msg("reward controller is not authorized")]
    UnauthorizedRewardController,
    #[msg("pending authority is invalid")]
    InvalidPendingAuthority,
    #[msg("identity program is paused")]
    Paused,
    #[msg("mint price bounds are invalid")]
    InvalidPriceBounds,
    #[msg("mint price is outside the configured bounds")]
    InvalidMintPrice,
    #[msg("season must be greater than zero")]
    InvalidSeason,
    #[msg("identity id does not match the next id")]
    InvalidIdentityId,
    #[msg("token mint is invalid")]
    InvalidMint,
    #[msg("token account owner is invalid")]
    InvalidTokenOwner,
    #[msg("official identity balance must equal one")]
    InvalidIdentityBalance,
    #[msg("date code does not match the current UTC date")]
    InvalidDateCode,
    #[msg("timestamp is invalid")]
    InvalidTimestamp,
    #[msg("counter overflow")]
    CounterOverflow,
    #[msg("profile field exceeds its byte limit")]
    ProfileTooLong,
    #[msg("profile contains a JSON-unsafe character")]
    UnsafeProfileCharacter,
    #[msg("identity record is invalid")]
    InvalidIdentity,
    #[msg("identity owner is not a participant in this deal")]
    InvalidDealParty,
    #[msg("this deal party is already bound to another identity")]
    IdentityAlreadyBound,
    #[msg("deal identity binding is invalid")]
    InvalidBinding,
    #[msg("identity lock state is invalid")]
    InvalidLockState,
    #[msg("identity cannot be locked after the deal reaches a terminal state")]
    DealAlreadyTerminal,
    #[msg("identity can only be unlocked after the deal reaches a terminal state")]
    DealNotTerminal,
    #[msg("this identity is already locked by this deal")]
    AlreadyLockedByDeal,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_date_code_matches_known_dates() {
        assert_eq!(date_code_from_timestamp(0).unwrap(), 19700101);
        assert_eq!(date_code_from_timestamp(1_700_000_000).unwrap(), 20231114);
    }

    #[test]
    fn profile_limits_are_utf8_byte_limits() {
        assert!(validate_json_safe(&"中".repeat(21), 64).is_ok());
        assert!(validate_json_safe(&"中".repeat(22), 64).is_err());
        assert!(validate_json_safe("bad\\value", 64).is_err());
    }
}
