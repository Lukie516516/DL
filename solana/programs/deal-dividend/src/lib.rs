#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
};
use deal_d_token::{BalanceCheckpoint, DTokenConfig, HolderState, MAX_SUPPLY};
use deal_protocol_treasury::TreasuryConfig;

declare_id!("9LuwMxg22xFMBmaYGuLyREvdn93K33psWdZY5TEQuzjL");

pub const CONFIG_SEED: &[u8] = b"dividend-config";
pub const VAULT_AUTHORITY_SEED: &[u8] = b"dividend-vault";
pub const ROUND_SEED: &[u8] = b"dividend-round";
pub const CLAIM_SEED: &[u8] = b"dividend-claim";

#[program]
pub mod deal_dividend {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        controller: Pubkey,
        bootstrap_admin: Pubkey,
    ) -> Result<()> {
        require!(controller != Pubkey::default(), DividendError::ZeroAddress);
        require!(
            bootstrap_admin != Pubkey::default(),
            DividendError::ZeroAddress
        );
        require_keys_eq!(
            ctx.accounts.treasury_config.controller,
            controller,
            DividendError::TreasuryControllerMismatch
        );
        require_eq!(
            ctx.accounts.d_config.total_supply,
            MAX_SUPPLY,
            DividendError::InvalidDConfig
        );

        let config = &mut ctx.accounts.config;
        config.controller = controller;
        config.bootstrap_admin = bootstrap_admin;
        config.d_program = deal_d_token::id();
        config.d_config = ctx.accounts.d_config.key();
        config.activity_program = deal_governance_activity::id();
        config.activity_config = ctx.accounts.activity_config.key();
        config.treasury_program = deal_protocol_treasury::id();
        config.treasury_config = ctx.accounts.treasury_config.key();
        config.treasury_vault_authority = ctx.accounts.treasury_vault_authority.key();
        config.next_round_id = 0;
        config.bootstrap_locked = false;
        config.bump = ctx.bumps.config;
        config.vault_bump = ctx.bumps.vault_authority;
        emit!(DividendInitialized {
            controller,
            d_config: config.d_config,
            treasury_config: config.treasury_config,
            vault_authority: ctx.accounts.vault_authority.key(),
        });
        Ok(())
    }

    pub fn bootstrap_set_controller(
        ctx: Context<BootstrapAdmin>,
        new_controller: Pubkey,
    ) -> Result<()> {
        assert_bootstrap(&ctx.accounts.config, &ctx.accounts.bootstrap_admin)?;
        set_controller(&mut ctx.accounts.config, new_controller)
    }

    pub fn lock_bootstrap(ctx: Context<BootstrapAdmin>) -> Result<()> {
        assert_bootstrap(&ctx.accounts.config, &ctx.accounts.bootstrap_admin)?;
        ctx.accounts.config.bootstrap_locked = true;
        emit!(BootstrapLocked {
            bootstrap_admin: ctx.accounts.bootstrap_admin.key(),
        });
        Ok(())
    }

    pub fn update_controller(ctx: Context<ControllerAction>, new_controller: Pubkey) -> Result<()> {
        assert_controller(&ctx.accounts.config, &ctx.accounts.controller)?;
        set_controller(&mut ctx.accounts.config, new_controller)
    }

    pub fn create_round(ctx: Context<CreateRound>, round_id: u64, total: u64) -> Result<()> {
        assert_controller(&ctx.accounts.config, &ctx.accounts.controller)?;
        require!(total > 0, DividendError::InvalidAmount);
        require_eq!(
            round_id,
            ctx.accounts.config.next_round_id,
            DividendError::InvalidRoundId
        );
        require_keys_eq!(
            ctx.accounts.treasury_config.controller,
            ctx.accounts.controller.key(),
            DividendError::TreasuryControllerMismatch
        );
        require_keys_eq!(
            ctx.accounts.treasury_source.owner,
            ctx.accounts.treasury_vault_authority.key(),
            DividendError::InvalidTreasuryVault
        );
        require_keys_eq!(
            ctx.accounts.treasury_source.mint,
            ctx.accounts.mint.key(),
            DividendError::InvalidMint
        );
        require_keys_eq!(
            ctx.accounts.dividend_vault.owner,
            ctx.accounts.vault_authority.key(),
            DividendError::InvalidDividendVault
        );
        require_keys_eq!(
            ctx.accounts.dividend_vault.mint,
            ctx.accounts.mint.key(),
            DividendError::InvalidMint
        );

        let cpi_accounts = deal_protocol_treasury::cpi::accounts::PayToken {
            controller: ctx.accounts.controller.to_account_info(),
            config: ctx.accounts.treasury_config.to_account_info(),
            vault_authority: ctx.accounts.treasury_vault_authority.to_account_info(),
            source: ctx.accounts.treasury_source.to_account_info(),
            destination: ctx.accounts.dividend_vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        };
        deal_protocol_treasury::cpi::pay_token(
            CpiContext::new(ctx.accounts.treasury_program.key(), cpi_accounts),
            total,
        )?;

        let clock = Clock::get()?;
        let round = &mut ctx.accounts.round;
        round.id = round_id;
        round.snapshot_slot = clock.slot.saturating_sub(1);
        round.created_at = clock.unix_timestamp;
        round.mint = ctx.accounts.mint.key();
        round.total = total;
        round.claimed = 0;
        round.bump = ctx.bumps.round;
        ctx.accounts.config.next_round_id = ctx
            .accounts
            .config
            .next_round_id
            .checked_add(1)
            .ok_or_else(|| error!(DividendError::ArithmeticOverflow))?;
        emit!(RoundCreated {
            round_id,
            snapshot_slot: round.snapshot_slot,
            mint: round.mint,
            total,
        });
        Ok(())
    }

    pub fn claim(ctx: Context<ClaimDividend>) -> Result<()> {
        let claim_bump = ctx.bumps.claim_receipt;
        process_claim(
            &ctx.accounts.config,
            &ctx.accounts.d_config,
            &ctx.accounts.holder_state,
            &ctx.accounts.balance_checkpoint,
            ctx.accounts
                .successor_checkpoint
                .as_deref()
                .map(|account| &**account),
            &mut ctx.accounts.round,
            &mut ctx.accounts.claim_receipt,
            claim_bump,
            &ctx.accounts.claimer,
            &ctx.accounts.vault_authority,
            &ctx.accounts.dividend_vault,
            &ctx.accounts.destination,
            &ctx.accounts.mint,
            &ctx.accounts.token_program,
        )
    }

    pub fn claim_for_identity(
        ctx: Context<ClaimForIdentity>,
        new_checkpoint_index: u64,
    ) -> Result<()> {
        let claim_bump = ctx.bumps.claim_receipt;
        process_claim(
            &ctx.accounts.config,
            &ctx.accounts.d_config,
            &ctx.accounts.holder_state,
            &ctx.accounts.balance_checkpoint,
            ctx.accounts
                .successor_checkpoint
                .as_deref()
                .map(|account| &**account),
            &mut ctx.accounts.round,
            &mut ctx.accounts.claim_receipt,
            claim_bump,
            &ctx.accounts.claimer,
            &ctx.accounts.vault_authority,
            &ctx.accounts.dividend_vault,
            &ctx.accounts.destination,
            &ctx.accounts.mint,
            &ctx.accounts.token_program,
        )?;

        let vault_bump = [ctx.accounts.config.vault_bump];
        let signer_seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &vault_bump];
        let cpi_accounts = deal_governance_activity::cpi::accounts::MarkActive {
            payer: ctx.accounts.claimer.to_account_info(),
            recorder: ctx.accounts.vault_authority.to_account_info(),
            owner: ctx.accounts.claimer.to_account_info(),
            config: ctx.accounts.activity_config.to_account_info(),
            recorder_grant: ctx.accounts.activity_recorder_grant.to_account_info(),
            identity_mint: ctx.accounts.identity_mint.to_account_info(),
            identity: ctx.accounts.identity.to_account_info(),
            owner_identity: ctx.accounts.owner_identity.to_account_info(),
            activity: ctx.accounts.activity.to_account_info(),
            checkpoint: ctx.accounts.new_activity_checkpoint.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        deal_governance_activity::cpi::mark_active(
            CpiContext::new_with_signer(
                ctx.accounts.activity_program.key(),
                cpi_accounts,
                &[signer_seeds],
            ),
            new_checkpoint_index,
        )?;
        Ok(())
    }

    pub fn preview_claim(ctx: Context<PreviewClaim>) -> Result<u64> {
        validate_snapshot(
            &ctx.accounts.config,
            &ctx.accounts.d_config,
            &ctx.accounts.holder_state,
            &ctx.accounts.balance_checkpoint,
            ctx.accounts
                .successor_checkpoint
                .as_deref()
                .map(|account| &**account),
            ctx.accounts.claimer.key(),
            ctx.accounts.round.snapshot_slot,
        )
        .and_then(|balance| calculate_payout(balance, ctx.accounts.round.total))
    }
}

#[allow(clippy::too_many_arguments)]
fn process_claim<'info>(
    config: &Account<'info, DividendConfig>,
    d_config: &Account<'info, DTokenConfig>,
    holder_state: &Account<'info, HolderState>,
    balance_checkpoint: &Account<'info, BalanceCheckpoint>,
    successor_checkpoint: Option<&BalanceCheckpoint>,
    round: &mut Account<'info, DividendRound>,
    claim_receipt: &mut Account<'info, ClaimReceipt>,
    claim_bump: u8,
    claimer: &Signer<'info>,
    vault_authority: &UncheckedAccount<'info>,
    dividend_vault: &InterfaceAccount<'info, TokenAccount>,
    destination: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    require!(
        Clock::get()?.slot > round.snapshot_slot,
        DividendError::SnapshotNotFinal
    );
    require_keys_eq!(round.mint, mint.key(), DividendError::InvalidMint);
    require_keys_eq!(dividend_vault.mint, mint.key(), DividendError::InvalidMint);
    require_keys_eq!(
        dividend_vault.owner,
        vault_authority.key(),
        DividendError::InvalidDividendVault
    );
    require_keys_eq!(destination.mint, mint.key(), DividendError::InvalidMint);
    require_keys_eq!(
        destination.owner,
        claimer.key(),
        DividendError::InvalidDestination
    );
    let balance = validate_snapshot(
        config,
        d_config,
        holder_state,
        balance_checkpoint,
        successor_checkpoint,
        claimer.key(),
        round.snapshot_slot,
    )?;
    let payout = calculate_payout(balance, round.total)?;
    let next_claimed = round
        .claimed
        .checked_add(payout)
        .ok_or_else(|| error!(DividendError::ArithmeticOverflow))?;
    require!(next_claimed <= round.total, DividendError::OverClaimed);

    claim_receipt.round = round.key();
    claim_receipt.claimer = claimer.key();
    claim_receipt.d_balance = balance;
    claim_receipt.amount = payout;
    claim_receipt.bump = claim_bump;
    round.claimed = next_claimed;

    let vault_bump = [config.vault_bump];
    let signer_seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &vault_bump];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: dividend_vault.to_account_info(),
                mint: mint.to_account_info(),
                to: destination.to_account_info(),
                authority: vault_authority.to_account_info(),
            },
            &[signer_seeds],
        ),
        payout,
        mint.decimals,
    )?;
    emit!(DividendClaimed {
        round_id: round.id,
        claimer: claimer.key(),
        d_balance: balance,
        amount: payout,
    });
    Ok(())
}

fn calculate_payout(balance: u64, total: u64) -> Result<u64> {
    require!(balance > 0, DividendError::NoSnapshotBalance);
    let payout = u128::from(balance)
        .checked_mul(u128::from(total))
        .ok_or_else(|| error!(DividendError::ArithmeticOverflow))?
        .checked_div(u128::from(MAX_SUPPLY))
        .ok_or_else(|| error!(DividendError::ArithmeticOverflow))?;
    let payout = u64::try_from(payout).map_err(|_| error!(DividendError::ArithmeticOverflow))?;
    require!(payout > 0, DividendError::ZeroPayout);
    Ok(payout)
}

#[allow(clippy::too_many_arguments)]
fn validate_snapshot(
    config: &DividendConfig,
    d_config: &DTokenConfig,
    holder: &HolderState,
    checkpoint: &BalanceCheckpoint,
    successor: Option<&BalanceCheckpoint>,
    claimer: Pubkey,
    snapshot_slot: u64,
) -> Result<u64> {
    require_keys_eq!(
        config.d_program,
        deal_d_token::id(),
        DividendError::InvalidDConfig
    );
    require_eq!(
        d_config.total_supply,
        MAX_SUPPLY,
        DividendError::InvalidDConfig
    );
    require_keys_eq!(holder.owner, claimer, DividendError::InvalidDHolder);
    require_keys_eq!(
        checkpoint.owner,
        claimer,
        DividendError::InvalidSnapshotProof
    );
    require!(
        checkpoint.slot <= snapshot_slot,
        DividendError::InvalidSnapshotProof
    );
    let next_index = checkpoint
        .index
        .checked_add(1)
        .ok_or_else(|| error!(DividendError::ArithmeticOverflow))?;
    if next_index < holder.checkpoint_count {
        let next = successor.ok_or_else(|| error!(DividendError::MissingSuccessorCheckpoint))?;
        require_keys_eq!(next.owner, claimer, DividendError::InvalidSnapshotProof);
        require_eq!(next.index, next_index, DividendError::InvalidSnapshotProof);
        require!(
            next.slot > snapshot_slot,
            DividendError::InvalidSnapshotProof
        );
    } else {
        require_eq!(
            next_index,
            holder.checkpoint_count,
            DividendError::InvalidSnapshotProof
        );
    }
    Ok(checkpoint.balance)
}

fn assert_controller(config: &DividendConfig, controller: &Signer<'_>) -> Result<()> {
    require_keys_eq!(
        config.controller,
        controller.key(),
        DividendError::NotController
    );
    Ok(())
}

fn assert_bootstrap(config: &DividendConfig, bootstrap_admin: &Signer<'_>) -> Result<()> {
    require!(!config.bootstrap_locked, DividendError::BootstrapLocked);
    require_keys_eq!(
        config.bootstrap_admin,
        bootstrap_admin.key(),
        DividendError::NotBootstrapAdmin
    );
    Ok(())
}

fn set_controller(config: &mut Account<'_, DividendConfig>, new_controller: Pubkey) -> Result<()> {
    require!(
        new_controller != Pubkey::default(),
        DividendError::ZeroAddress
    );
    let old_controller = config.controller;
    config.controller = new_controller;
    emit!(ControllerUpdated {
        old_controller,
        new_controller,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = DividendConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, DividendConfig>>,
    #[account(
        seeds = [deal_d_token::CONFIG_SEED],
        bump = d_config.bump,
        seeds::program = deal_d_token::id()
    )]
    pub d_config: Box<Account<'info, DTokenConfig>>,
    #[account(
        seeds = [deal_governance_activity::CONFIG_SEED],
        bump = activity_config.bump,
        seeds::program = deal_governance_activity::id()
    )]
    pub activity_config: Box<Account<'info, deal_governance_activity::ActivityConfig>>,
    #[account(
        seeds = [deal_protocol_treasury::CONFIG_SEED],
        bump = treasury_config.bump,
        seeds::program = deal_protocol_treasury::id()
    )]
    pub treasury_config: Box<Account<'info, TreasuryConfig>>,
    /// CHECK: Canonical treasury vault authority is stored for all future rounds.
    #[account(
        seeds = [deal_protocol_treasury::VAULT_AUTHORITY_SEED],
        bump = treasury_config.vault_bump,
        seeds::program = deal_protocol_treasury::id()
    )]
    pub treasury_vault_authority: UncheckedAccount<'info>,
    /// CHECK: Canonical dividend vault signs token payouts and activity refreshes.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BootstrapAdmin<'info> {
    pub bootstrap_admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, DividendConfig>>,
}

#[derive(Accounts)]
pub struct ControllerAction<'info> {
    pub controller: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, DividendConfig>>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct CreateRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub controller: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, DividendConfig>>,
    #[account(address = config.d_config @ DividendError::InvalidDConfig)]
    pub d_config: Box<Account<'info, DTokenConfig>>,
    #[account(
        init,
        payer = payer,
        space = DividendRound::SPACE,
        seeds = [ROUND_SEED, &round_id.to_le_bytes()],
        bump
    )]
    pub round: Box<Account<'info, DividendRound>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = config.treasury_config @ DividendError::InvalidTreasuryConfig)]
    pub treasury_config: Box<Account<'info, TreasuryConfig>>,
    /// CHECK: Bound to the treasury address stored at initialization.
    #[account(address = config.treasury_vault_authority @ DividendError::InvalidTreasuryVault)]
    pub treasury_vault_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub treasury_source: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Canonical dividend vault owns the shared token vault.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program
    )]
    pub dividend_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub treasury_program: Program<'info, deal_protocol_treasury::program::DealProtocolTreasury>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimDividend<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, DividendConfig>>,
    #[account(address = config.d_config @ DividendError::InvalidDConfig)]
    pub d_config: Box<Account<'info, DTokenConfig>>,
    #[account(
        seeds = [deal_d_token::HOLDER_SEED, claimer.key().as_ref()],
        bump = holder_state.bump,
        seeds::program = deal_d_token::id()
    )]
    pub holder_state: Box<Account<'info, HolderState>>,
    #[account(
        seeds = [
            deal_d_token::CHECKPOINT_SEED,
            claimer.key().as_ref(),
            &balance_checkpoint.index.to_le_bytes()
        ],
        bump = balance_checkpoint.bump,
        seeds::program = deal_d_token::id()
    )]
    pub balance_checkpoint: Box<Account<'info, BalanceCheckpoint>>,
    #[account(
        seeds = [
            deal_d_token::CHECKPOINT_SEED,
            claimer.key().as_ref(),
            &successor_checkpoint.index.to_le_bytes()
        ],
        bump = successor_checkpoint.bump,
        seeds::program = deal_d_token::id()
    )]
    pub successor_checkpoint: Option<Box<Account<'info, BalanceCheckpoint>>>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, DividendRound>>,
    #[account(
        init,
        payer = claimer,
        space = ClaimReceipt::SPACE,
        seeds = [CLAIM_SEED, round.key().as_ref(), claimer.key().as_ref()],
        bump
    )]
    pub claim_receipt: Box<Account<'info, ClaimReceipt>>,
    /// CHECK: Canonical PDA signs token payouts.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub dividend_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimForIdentity<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, DividendConfig>>,
    #[account(address = config.d_config @ DividendError::InvalidDConfig)]
    pub d_config: Box<Account<'info, DTokenConfig>>,
    #[account(
        seeds = [deal_d_token::HOLDER_SEED, claimer.key().as_ref()],
        bump = holder_state.bump,
        seeds::program = deal_d_token::id()
    )]
    pub holder_state: Box<Account<'info, HolderState>>,
    #[account(
        seeds = [
            deal_d_token::CHECKPOINT_SEED,
            claimer.key().as_ref(),
            &balance_checkpoint.index.to_le_bytes()
        ],
        bump = balance_checkpoint.bump,
        seeds::program = deal_d_token::id()
    )]
    pub balance_checkpoint: Box<Account<'info, BalanceCheckpoint>>,
    #[account(
        seeds = [
            deal_d_token::CHECKPOINT_SEED,
            claimer.key().as_ref(),
            &successor_checkpoint.index.to_le_bytes()
        ],
        bump = successor_checkpoint.bump,
        seeds::program = deal_d_token::id()
    )]
    pub successor_checkpoint: Option<Box<Account<'info, BalanceCheckpoint>>>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, DividendRound>>,
    #[account(
        init,
        payer = claimer,
        space = ClaimReceipt::SPACE,
        seeds = [CLAIM_SEED, round.key().as_ref(), claimer.key().as_ref()],
        bump
    )]
    pub claim_receipt: Box<Account<'info, ClaimReceipt>>,
    /// CHECK: Canonical PDA signs payouts and activity refreshes.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub dividend_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: The activity program validates every following account.
    #[account(mut, address = config.activity_config @ DividendError::InvalidActivityConfig)]
    pub activity_config: UncheckedAccount<'info>,
    /// CHECK: Permission PDA is validated by the activity program.
    pub activity_recorder_grant: UncheckedAccount<'info>,
    /// CHECK: Official identity mint is validated by the activity program.
    pub identity_mint: UncheckedAccount<'info>,
    /// CHECK: Official identity record is validated by the activity program.
    pub identity: UncheckedAccount<'info>,
    /// CHECK: Identity token ownership is validated by the activity program.
    pub owner_identity: UncheckedAccount<'info>,
    /// CHECK: Identity activity PDA is initialized/validated by the activity program.
    #[account(mut)]
    pub activity: UncheckedAccount<'info>,
    /// CHECK: New immutable activity checkpoint is initialized by the activity program.
    #[account(mut)]
    pub new_activity_checkpoint: UncheckedAccount<'info>,
    pub activity_program: Program<'info, deal_governance_activity::program::DealGovernanceActivity>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PreviewClaim<'info> {
    /// CHECK: Only the key is used to bind the D holder snapshot.
    pub claimer: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, DividendConfig>>,
    #[account(address = config.d_config @ DividendError::InvalidDConfig)]
    pub d_config: Box<Account<'info, DTokenConfig>>,
    #[account(
        seeds = [deal_d_token::HOLDER_SEED, claimer.key().as_ref()],
        bump = holder_state.bump,
        seeds::program = deal_d_token::id()
    )]
    pub holder_state: Box<Account<'info, HolderState>>,
    #[account(
        seeds = [
            deal_d_token::CHECKPOINT_SEED,
            claimer.key().as_ref(),
            &balance_checkpoint.index.to_le_bytes()
        ],
        bump = balance_checkpoint.bump,
        seeds::program = deal_d_token::id()
    )]
    pub balance_checkpoint: Box<Account<'info, BalanceCheckpoint>>,
    #[account(
        seeds = [
            deal_d_token::CHECKPOINT_SEED,
            claimer.key().as_ref(),
            &successor_checkpoint.index.to_le_bytes()
        ],
        bump = successor_checkpoint.bump,
        seeds::program = deal_d_token::id()
    )]
    pub successor_checkpoint: Option<Box<Account<'info, BalanceCheckpoint>>>,
    #[account(seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, DividendRound>>,
}

#[account]
pub struct DividendConfig {
    pub controller: Pubkey,
    pub bootstrap_admin: Pubkey,
    pub d_program: Pubkey,
    pub d_config: Pubkey,
    pub activity_program: Pubkey,
    pub activity_config: Pubkey,
    pub treasury_program: Pubkey,
    pub treasury_config: Pubkey,
    pub treasury_vault_authority: Pubkey,
    pub next_round_id: u64,
    pub bootstrap_locked: bool,
    pub bump: u8,
    pub vault_bump: u8,
}
impl DividendConfig {
    pub const SPACE: usize = 8 + (32 * 9) + 8 + 1 + 2;
}

#[account]
pub struct DividendRound {
    pub id: u64,
    pub snapshot_slot: u64,
    pub created_at: i64,
    pub mint: Pubkey,
    pub total: u64,
    pub claimed: u64,
    pub bump: u8,
}
impl DividendRound {
    pub const SPACE: usize = 8 + (8 * 5) + 32 + 1;
}

#[account]
pub struct ClaimReceipt {
    pub round: Pubkey,
    pub claimer: Pubkey,
    pub d_balance: u64,
    pub amount: u64,
    pub bump: u8,
}
impl ClaimReceipt {
    pub const SPACE: usize = 8 + (32 * 2) + (8 * 2) + 1;
}

#[event]
pub struct DividendInitialized {
    pub controller: Pubkey,
    pub d_config: Pubkey,
    pub treasury_config: Pubkey,
    pub vault_authority: Pubkey,
}
#[event]
pub struct ControllerUpdated {
    pub old_controller: Pubkey,
    pub new_controller: Pubkey,
}
#[event]
pub struct BootstrapLocked {
    pub bootstrap_admin: Pubkey,
}
#[event]
pub struct RoundCreated {
    pub round_id: u64,
    pub snapshot_slot: u64,
    pub mint: Pubkey,
    pub total: u64,
}
#[event]
pub struct DividendClaimed {
    pub round_id: u64,
    pub claimer: Pubkey,
    pub d_balance: u64,
    pub amount: u64,
}

#[error_code]
pub enum DividendError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not the dividend controller")]
    NotController,
    #[msg("caller is not the bootstrap admin")]
    NotBootstrapAdmin,
    #[msg("bootstrap authority is permanently locked")]
    BootstrapLocked,
    #[msg("treasury controller must match the dividend controller")]
    TreasuryControllerMismatch,
    #[msg("D configuration is invalid")]
    InvalidDConfig,
    #[msg("governance activity configuration is invalid")]
    InvalidActivityConfig,
    #[msg("treasury configuration is invalid")]
    InvalidTreasuryConfig,
    #[msg("treasury token vault is invalid")]
    InvalidTreasuryVault,
    #[msg("dividend token vault is invalid")]
    InvalidDividendVault,
    #[msg("token mint is invalid")]
    InvalidMint,
    #[msg("claim destination is invalid")]
    InvalidDestination,
    #[msg("amount must be greater than zero")]
    InvalidAmount,
    #[msg("round id is not the next sequential id")]
    InvalidRoundId,
    #[msg("D holder state is invalid")]
    InvalidDHolder,
    #[msg("D snapshot proof is invalid")]
    InvalidSnapshotProof,
    #[msg("a successor checkpoint is required")]
    MissingSuccessorCheckpoint,
    #[msg("snapshot must be in a past slot")]
    SnapshotNotFinal,
    #[msg("address had no D at the round snapshot")]
    NoSnapshotBalance,
    #[msg("calculated payout rounds down to zero")]
    ZeroPayout,
    #[msg("round payout would exceed funded total")]
    OverClaimed,
    #[msg("arithmetic overflow")]
    ArithmeticOverflow,
}
