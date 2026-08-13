#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use deal_asset_controller::{
    self,
    state::{ConfigureTermsParams, ControllerConfig},
};
use deal_core::{
    self,
    state::{CreateDealParams, DealAccount, DealRegistry, JoinMode, TemplateType},
};
use deal_domain_rank::{self, BlacklistEntry, RankConfig, ReporterGrant};
use deal_domain_registry::DomainRecord;

declare_id!("254WzKpJ7RXvpS1UHeZJqhRUMcsHN5U868eqjviMgihg");

pub const CONFIG_SEED: &[u8] = b"domain-entry-config";
pub const BINDING_SEED: &[u8] = b"domain-deal-binding";

#[program]
pub mod deal_domain_entry {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        ctx: Context<Initialize>,
        core_program: Pubkey,
        core_registry: Pubkey,
        asset_program: Pubkey,
        asset_config: Pubkey,
        rank_program: Pubkey,
        rank_config: Pubkey,
        default_timeout_seconds: u64,
        default_replace_timeout_seconds: u64,
    ) -> Result<()> {
        for key in [
            core_program,
            core_registry,
            asset_program,
            asset_config,
            rank_program,
            rank_config,
        ] {
            require!(key != Pubkey::default(), EntryError::ZeroAddress);
        }
        require_keys_eq!(core_program, deal_core::id(), EntryError::InvalidCore);
        require_keys_eq!(
            asset_program,
            deal_asset_controller::id(),
            EntryError::InvalidAssetController
        );
        require_keys_eq!(
            rank_program,
            deal_domain_rank::id(),
            EntryError::InvalidRank
        );
        validate_timeouts(default_timeout_seconds, default_replace_timeout_seconds)?;
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.core_program = core_program;
        config.core_registry = core_registry;
        config.asset_program = asset_program;
        config.asset_config = asset_config;
        config.rank_program = rank_program;
        config.rank_config = rank_config;
        config.default_timeout_seconds = default_timeout_seconds;
        config.default_replace_timeout_seconds = default_replace_timeout_seconds;
        config.paused = true;
        config.bump = ctx.bumps.config;
        emit!(DomainEntryInitialized {
            authority: config.authority,
            core_registry,
            asset_config,
            rank_config,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.paused = paused;
        emit!(DomainEntryPauseUpdated { paused });
        Ok(())
    }

    pub fn set_default_timeouts(
        ctx: Context<AdminConfig>,
        timeout_seconds: u64,
        replace_timeout_seconds: u64,
    ) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        validate_timeouts(timeout_seconds, replace_timeout_seconds)?;
        ctx.accounts.config.default_timeout_seconds = timeout_seconds;
        ctx.accounts.config.default_replace_timeout_seconds = replace_timeout_seconds;
        emit!(DomainEntryTimeoutsUpdated {
            timeout_seconds,
            replace_timeout_seconds
        });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            EntryError::ZeroAddress
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(DomainEntryAuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            EntryError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = Pubkey::default();
        emit!(DomainEntryAuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority
        });
        Ok(())
    }

    pub fn create_domain_deal(
        ctx: Context<CreateDomainDeal>,
        params: DomainCreateParams,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, EntryError::Paused);
        validate_dependencies(&ctx)?;
        require!(
            ctx.accounts.domain.resolve != Pubkey::default(),
            EntryError::DomainNotResolved
        );
        assert_active(
            ctx.accounts.domain.key(),
            ctx.accounts.creator.key(),
            &ctx.accounts.blacklist,
        )?;
        validate_creation_mode(&params)?;
        require_eq!(
            ctx.accounts.core_registry.next_deal_id,
            params.deal_id,
            EntryError::InvalidDealId
        );

        let expected_participant = if params.deferred_hall {
            Pubkey::default()
        } else {
            params.expected_participant
        };
        let join_mode = join_mode_for(expected_participant, params.require_identity);
        let timeout_seconds = if params.timeout_seconds == 0 {
            ctx.accounts.config.default_timeout_seconds
        } else {
            params.timeout_seconds
        };
        let replace_timeout_seconds = if params.replace_timeout_seconds == 0 {
            ctx.accounts.config.default_replace_timeout_seconds
        } else {
            params.replace_timeout_seconds
        };
        validate_timeouts(timeout_seconds, replace_timeout_seconds)?;
        let volume = params
            .a_swap_amount
            .checked_add(params.a_margin_amount)
            .and_then(|value| value.checked_add(params.b_swap_amount))
            .and_then(|value| value.checked_add(params.b_margin_amount))
            .ok_or(EntryError::ArithmeticOverflow)?;

        let core_params = CreateDealParams {
            template_type: params.template_type,
            open_token_token_fast: !params.deferred_hall,
            join_mode,
            expected_participant,
            a_swap_amount: params.a_swap_amount,
            a_margin_amount: params.a_margin_amount,
            b_swap_amount: params.b_swap_amount,
            b_margin_amount: params.b_margin_amount,
            a_has_asset_nft: false,
            b_has_asset_nft: false,
            title: params.title.clone(),
            description: params.description.clone(),
            timeout_seconds,
            replace_timeout_seconds,
            is_domain_deal: true,
            domain_name: ctx.accounts.domain.label.clone(),
        };
        let config_bump = [ctx.accounts.config.bump];
        let config_signer_seeds: &[&[u8]] = &[CONFIG_SEED, &config_bump];
        deal_core::cpi::create_domain_deal(
            CpiContext::new_with_signer(
                ctx.accounts.core_program.key(),
                deal_core::cpi::accounts::CreateDomainDeal {
                    creator: ctx.accounts.creator.to_account_info(),
                    domain_entry_controller: ctx.accounts.config.to_account_info(),
                    registry: ctx.accounts.core_registry.to_account_info(),
                    deal: ctx.accounts.deal.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
                &[config_signer_seeds],
            ),
            params.deal_id,
            core_params,
        )?;

        deal_asset_controller::cpi::configure_terms(
            CpiContext::new(
                ctx.accounts.asset_program.key(),
                deal_asset_controller::cpi::accounts::ConfigureTerms {
                    creator: ctx.accounts.creator.to_account_info(),
                    config: ctx.accounts.asset_config.to_account_info(),
                    deal: ctx.accounts.deal.to_account_info(),
                    terms: ctx.accounts.asset_terms.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
            ),
            params.asset_terms,
        )?;

        let bump = [ctx.accounts.config.bump];
        let signer_seeds: &[&[u8]] = &[CONFIG_SEED, &bump];
        deal_domain_rank::cpi::report_deal(
            CpiContext::new_with_signer(
                ctx.accounts.rank_program.key(),
                deal_domain_rank::cpi::accounts::ReportDeal {
                    config: ctx.accounts.rank_config.to_account_info(),
                    payer: ctx.accounts.creator.to_account_info(),
                    reporter: ctx.accounts.config.to_account_info(),
                    reporter_grant: ctx.accounts.rank_reporter_grant.to_account_info(),
                    domain: ctx.accounts.domain.to_account_info(),
                    deal: ctx.accounts.deal.to_account_info(),
                    stats: ctx.accounts.rank_stats.to_account_info(),
                    entry: ctx.accounts.rank_entry.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
                &[signer_seeds],
            ),
            ctx.accounts.creator.key(),
            volume,
        )?;

        let binding = &mut ctx.accounts.binding;
        binding.domain = ctx.accounts.domain.key();
        binding.deal = ctx.accounts.deal.key();
        binding.creator = ctx.accounts.creator.key();
        binding.picked_counterparty = Pubkey::default();
        binding.deferred_hall = params.deferred_hall;
        binding.require_identity = params.require_identity;
        binding.bump = ctx.bumps.binding;
        emit!(DomainDealCreated {
            domain: binding.domain,
            deal: binding.deal,
            creator: binding.creator,
            template_type: params.template_type,
            join_mode,
            expected_participant,
            deferred_hall: params.deferred_hall,
            reported_volume: volume,
        });
        Ok(())
    }

    pub fn confirm_hall_counterparty(
        ctx: Context<ConfirmHallCounterparty>,
        picked_counterparty: Pubkey,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, EntryError::Paused);
        require!(
            ctx.accounts.binding.deferred_hall,
            EntryError::NotDeferredHallDeal
        );
        require_keys_eq!(
            ctx.accounts.binding.creator,
            ctx.accounts.creator.key(),
            EntryError::NotDealCreator
        );
        require_keys_eq!(
            ctx.accounts.binding.deal,
            ctx.accounts.deal.key(),
            EntryError::InvalidDeal
        );
        require_keys_eq!(
            ctx.accounts.binding.domain,
            ctx.accounts.domain.key(),
            EntryError::InvalidDomain
        );
        require_keys_eq!(
            ctx.accounts.deal.creator,
            ctx.accounts.creator.key(),
            EntryError::NotDealCreator
        );
        require!(
            picked_counterparty != Pubkey::default()
                && picked_counterparty != ctx.accounts.creator.key(),
            EntryError::InvalidCounterparty
        );
        assert_active(
            ctx.accounts.domain.key(),
            picked_counterparty,
            &ctx.accounts.picked_blacklist,
        )?;
        deal_core::cpi::open_join_for(
            CpiContext::new(
                ctx.accounts.core_program.key(),
                deal_core::cpi::accounts::PartyAction {
                    actor: ctx.accounts.creator.to_account_info(),
                    deal: ctx.accounts.deal.to_account_info(),
                },
            ),
            picked_counterparty,
        )?;
        ctx.accounts.binding.picked_counterparty = picked_counterparty;
        ctx.accounts.binding.deferred_hall = false;
        emit!(HallCounterpartyConfirmed {
            domain: ctx.accounts.domain.key(),
            deal: ctx.accounts.deal.key(),
            creator: ctx.accounts.creator.key(),
            picked_counterparty,
            require_identity: ctx.accounts.binding.require_identity,
        });
        Ok(())
    }
}

fn assert_authority(config: &DomainEntryConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(config.authority, authority.key(), EntryError::Unauthorized);
    Ok(())
}

fn validate_timeouts(timeout_seconds: u64, replace_timeout_seconds: u64) -> Result<()> {
    require!(
        (1..=deal_core::constants::MAX_TIMEOUT_SECONDS).contains(&timeout_seconds),
        EntryError::InvalidTimeout
    );
    require!(
        (deal_core::constants::MIN_REPLACE_TIMEOUT_SECONDS
            ..=deal_core::constants::MAX_REPLACE_TIMEOUT_SECONDS)
            .contains(&replace_timeout_seconds),
        EntryError::InvalidReplaceTimeout
    );
    Ok(())
}

fn validate_dependencies(ctx: &Context<CreateDomainDeal>) -> Result<()> {
    let config = &ctx.accounts.config;
    require_keys_eq!(
        config.core_program,
        ctx.accounts.core_program.key(),
        EntryError::InvalidCore
    );
    require_keys_eq!(
        config.core_registry,
        ctx.accounts.core_registry.key(),
        EntryError::InvalidCore
    );
    require_keys_eq!(
        config.asset_program,
        ctx.accounts.asset_program.key(),
        EntryError::InvalidAssetController
    );
    require_keys_eq!(
        config.asset_config,
        ctx.accounts.asset_config.key(),
        EntryError::InvalidAssetController
    );
    require_keys_eq!(
        config.rank_program,
        ctx.accounts.rank_program.key(),
        EntryError::InvalidRank
    );
    require_keys_eq!(
        config.rank_config,
        ctx.accounts.rank_config.key(),
        EntryError::InvalidRank
    );
    require_keys_eq!(
        ctx.accounts.core_registry.asset_controller,
        ctx.accounts.asset_config.key(),
        EntryError::InvalidAssetController
    );
    require_keys_eq!(
        ctx.accounts.core_registry.domain_entry_controller,
        ctx.accounts.config.key(),
        EntryError::InvalidCore
    );
    Ok(())
}

fn assert_active(domain: Pubkey, user: Pubkey, blacklist: &UncheckedAccount<'_>) -> Result<()> {
    let expected = Pubkey::find_program_address(
        &[
            deal_domain_rank::BLACKLIST_SEED,
            domain.as_ref(),
            user.as_ref(),
        ],
        &deal_domain_rank::id(),
    )
    .0;
    require_keys_eq!(blacklist.key(), expected, EntryError::InvalidBlacklist);
    if blacklist.owner == &deal_domain_rank::id() && !blacklist.data_is_empty() {
        let data = blacklist.try_borrow_data()?;
        let entry = BlacklistEntry::try_deserialize(&mut data.as_ref())?;
        require_keys_eq!(entry.domain, domain, EntryError::InvalidBlacklist);
        require_keys_eq!(entry.user, user, EntryError::InvalidBlacklist);
        require!(!entry.banned, EntryError::Blacklisted);
    }
    Ok(())
}

fn validate_creation_mode(params: &DomainCreateParams) -> Result<()> {
    if params.deferred_hall {
        require!(
            matches!(
                params.template_type,
                TemplateType::TokenToToken
                    | TemplateType::TokenToEmpty
                    | TemplateType::EmptyToEmpty
            ),
            EntryError::InvalidHallTemplate
        );
    } else {
        require!(
            params.template_type == TemplateType::TokenToToken,
            EntryError::InvalidDirectTemplate
        );
    }
    Ok(())
}

fn join_mode_for(expected_participant: Pubkey, require_identity: bool) -> JoinMode {
    match (expected_participant == Pubkey::default(), require_identity) {
        (true, false) => JoinMode::Open,
        (false, false) => JoinMode::ExactAddress,
        (true, true) => JoinMode::NftGated,
        (false, true) => JoinMode::ExactAddressAndNftGated,
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct DomainCreateParams {
    pub deal_id: u64,
    pub template_type: TemplateType,
    pub expected_participant: Pubkey,
    pub require_identity: bool,
    pub deferred_hall: bool,
    pub a_swap_amount: u64,
    pub a_margin_amount: u64,
    pub b_swap_amount: u64,
    pub b_margin_amount: u64,
    pub title: String,
    pub description: String,
    pub timeout_seconds: u64,
    pub replace_timeout_seconds: u64,
    pub asset_terms: ConfigureTermsParams,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(init, payer = payer, space = DomainEntryConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, DomainEntryConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DomainEntryConfig>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, DomainEntryConfig>,
}

#[derive(Accounts)]
pub struct CreateDomainDeal<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, DomainEntryConfig>>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub domain: Box<Account<'info, DomainRecord>>,
    /// CHECK: Must be the rank blacklist PDA; an uninitialized PDA means not blacklisted.
    pub blacklist: UncheckedAccount<'info>,
    pub core_program: Program<'info, deal_core::program::DealCore>,
    #[account(mut)]
    pub core_registry: Box<Account<'info, DealRegistry>>,
    /// CHECK: Created and constrained by the core program CPI.
    #[account(mut)]
    pub deal: UncheckedAccount<'info>,
    pub asset_program: Program<'info, deal_asset_controller::program::DealAssetController>,
    pub asset_config: Box<Account<'info, ControllerConfig>>,
    /// CHECK: Created and constrained by the asset-controller CPI.
    #[account(mut)]
    pub asset_terms: UncheckedAccount<'info>,
    pub rank_program: Program<'info, deal_domain_rank::program::DealDomainRank>,
    pub rank_config: Box<Account<'info, RankConfig>>,
    pub rank_reporter_grant: Box<Account<'info, ReporterGrant>>,
    /// CHECK: Created and constrained by the rank CPI.
    #[account(mut)]
    pub rank_stats: UncheckedAccount<'info>,
    /// CHECK: Created and constrained by the rank CPI.
    #[account(mut)]
    pub rank_entry: UncheckedAccount<'info>,
    #[account(init, payer = creator, space = DomainDealBinding::SPACE, seeds = [BINDING_SEED, deal.key().as_ref()], bump)]
    pub binding: Box<Account<'info, DomainDealBinding>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ConfirmHallCounterparty<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, DomainEntryConfig>>,
    pub creator: Signer<'info>,
    pub domain: Box<Account<'info, DomainRecord>>,
    /// CHECK: Must be the picked user's rank blacklist PDA.
    pub picked_blacklist: UncheckedAccount<'info>,
    pub core_program: Program<'info, deal_core::program::DealCore>,
    #[account(mut)]
    pub deal: Box<Account<'info, DealAccount>>,
    #[account(mut, seeds = [BINDING_SEED, deal.key().as_ref()], bump = binding.bump)]
    pub binding: Box<Account<'info, DomainDealBinding>>,
}

#[account]
pub struct DomainEntryConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub core_program: Pubkey,
    pub core_registry: Pubkey,
    pub asset_program: Pubkey,
    pub asset_config: Pubkey,
    pub rank_program: Pubkey,
    pub rank_config: Pubkey,
    pub default_timeout_seconds: u64,
    pub default_replace_timeout_seconds: u64,
    pub paused: bool,
    pub bump: u8,
}

impl DomainEntryConfig {
    pub const SPACE: usize = 8 + (32 * 8) + (8 * 2) + 1 + 1;
}

#[account]
pub struct DomainDealBinding {
    pub domain: Pubkey,
    pub deal: Pubkey,
    pub creator: Pubkey,
    pub picked_counterparty: Pubkey,
    pub deferred_hall: bool,
    pub require_identity: bool,
    pub bump: u8,
}

impl DomainDealBinding {
    pub const SPACE: usize = 8 + (32 * 4) + 1 + 1 + 1;
}

#[event]
pub struct DomainEntryInitialized {
    pub authority: Pubkey,
    pub core_registry: Pubkey,
    pub asset_config: Pubkey,
    pub rank_config: Pubkey,
}
#[event]
pub struct DomainEntryPauseUpdated {
    pub paused: bool,
}
#[event]
pub struct DomainEntryTimeoutsUpdated {
    pub timeout_seconds: u64,
    pub replace_timeout_seconds: u64,
}
#[event]
pub struct DomainEntryAuthorityProposed {
    pub pending_authority: Pubkey,
}
#[event]
pub struct DomainEntryAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}
#[event]
pub struct DomainDealCreated {
    pub domain: Pubkey,
    pub deal: Pubkey,
    pub creator: Pubkey,
    pub template_type: TemplateType,
    pub join_mode: JoinMode,
    pub expected_participant: Pubkey,
    pub deferred_hall: bool,
    pub reported_volume: u64,
}
#[event]
pub struct HallCounterpartyConfirmed {
    pub domain: Pubkey,
    pub deal: Pubkey,
    pub creator: Pubkey,
    pub picked_counterparty: Pubkey,
    pub require_identity: bool,
}

#[error_code(offset = 6100)]
pub enum EntryError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("pending authority is invalid")]
    InvalidPendingAuthority,
    #[msg("domain entry is paused")]
    Paused,
    #[msg("core program or registry is invalid")]
    InvalidCore,
    #[msg("asset controller is invalid")]
    InvalidAssetController,
    #[msg("domain rank is invalid")]
    InvalidRank,
    #[msg("timeout is invalid")]
    InvalidTimeout,
    #[msg("replacement timeout is invalid")]
    InvalidReplaceTimeout,
    #[msg("domain is not resolved")]
    DomainNotResolved,
    #[msg("blacklist account is invalid")]
    InvalidBlacklist,
    #[msg("domain participant is blacklisted")]
    Blacklisted,
    #[msg("deal id does not match the core registry")]
    InvalidDealId,
    #[msg("direct domain entry only supports token-to-token deals")]
    InvalidDirectTemplate,
    #[msg("deferred hall template is invalid")]
    InvalidHallTemplate,
    #[msg("arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("deal is not awaiting hall selection")]
    NotDeferredHallDeal,
    #[msg("caller is not the deal creator")]
    NotDealCreator,
    #[msg("deal account is invalid")]
    InvalidDeal,
    #[msg("domain account is invalid")]
    InvalidDomain,
    #[msg("counterparty is invalid")]
    InvalidCounterparty,
}
