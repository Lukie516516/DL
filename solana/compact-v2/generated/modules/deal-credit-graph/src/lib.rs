#![allow(unexpected_cfgs, clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

declare_id!("4uhbTXV4SnMgFje7EiJFE6hKjWPfQUDYYkg9AytrZUxW");

pub const CONFIG_SEED: &[u8] = b"credit-config";
pub const SCORE_SEED: &[u8] = b"credit-score";
pub const TOP_K: usize = 5;
pub const BPS: u128 = 10_000;
pub const MIN_EXTRA_BPS: u128 = 100;
pub const MAX_EXTRA_BPS: u128 = 20_000;

#[program]
pub mod deal_credit_graph {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, recorder: Pubkey) -> Result<()> {
        require!(recorder != Pubkey::default(), CreditError::ZeroAddress);
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.recorder = recorder;
        config.import_authority = ctx.accounts.authority.key();
        config.migration_locked = false;
        config.paused = true;
        config.bump = ctx.bumps.config;
        emit!(CreditConfigInitialized {
            authority: config.authority,
            recorder,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        ctx.accounts.config.paused = paused;
        emit!(CreditPauseUpdated { paused });
        Ok(())
    }

    pub fn set_recorder(ctx: Context<AdminConfig>, recorder: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(recorder != Pubkey::default(), CreditError::ZeroAddress);
        ctx.accounts.config.recorder = recorder;
        emit!(CreditRecorderUpdated { recorder });
        Ok(())
    }

    pub fn set_import_authority(ctx: Context<AdminConfig>, import_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            !ctx.accounts.config.migration_locked,
            CreditError::MigrationLocked
        );
        require!(
            import_authority != Pubkey::default(),
            CreditError::ZeroAddress
        );
        ctx.accounts.config.import_authority = import_authority;
        emit!(CreditImportAuthorityUpdated { import_authority });
        Ok(())
    }

    pub fn lock_migration(ctx: Context<AdminConfig>) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            !ctx.accounts.config.migration_locked,
            CreditError::MigrationLocked
        );
        ctx.accounts.config.migration_locked = true;
        ctx.accounts.config.import_authority = Pubkey::default();
        emit!(CreditMigrationLocked {});
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminConfig>, pending_authority: Pubkey) -> Result<()> {
        assert_authority(&ctx.accounts.config, &ctx.accounts.authority)?;
        require!(
            pending_authority != Pubkey::default(),
            CreditError::ZeroAddress
        );
        ctx.accounts.config.pending_authority = pending_authority;
        emit!(CreditAuthorityProposed { pending_authority });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.pending_authority,
            ctx.accounts.pending_authority.key(),
            CreditError::InvalidPendingAuthority
        );
        let old_authority = ctx.accounts.config.authority;
        ctx.accounts.config.authority = ctx.accounts.pending_authority.key();
        ctx.accounts.config.pending_authority = Pubkey::default();
        emit!(CreditAuthorityAccepted {
            old_authority,
            new_authority: ctx.accounts.config.authority,
        });
        Ok(())
    }

    pub fn import_credit(
        ctx: Context<ImportCredit>,
        score: u128,
        peers: [CreditPeerInput; TOP_K],
    ) -> Result<()> {
        require!(
            !ctx.accounts.config.migration_locked,
            CreditError::MigrationLocked
        );
        require_keys_eq!(
            ctx.accounts.config.import_authority,
            ctx.accounts.import_authority.key(),
            CreditError::UnauthorizedImporter
        );
        assert_official_identity(&ctx.accounts.identity, ctx.accounts.identity.key())?;
        validate_import_peers(ctx.accounts.identity.mint, &peers)?;
        let credit = &mut ctx.accounts.credit;
        initialize_score_if_needed(credit, ctx.accounts.identity.mint, ctx.bumps.credit);
        credit.score = score;
        credit.top_peers = peers.map(CreditPeer::from);
        emit!(CreditImported {
            identity_mint: credit.identity_mint,
            score,
        });
        Ok(())
    }

    pub fn record_pair(ctx: Context<RecordPair>, base_credit: u128) -> Result<()> {
        assert_recording_enabled(&ctx.accounts.config, &ctx.accounts.recorder)?;
        if base_credit == 0 {
            return Ok(());
        }
        assert_official_owner(
            &ctx.accounts.a_identity,
            ctx.accounts.a_identity.key(),
            &ctx.accounts.a_owner_token,
            ctx.accounts.party_a.key(),
        )?;
        assert_official_owner(
            &ctx.accounts.b_identity,
            ctx.accounts.b_identity.key(),
            &ctx.accounts.b_owner_token,
            ctx.accounts.party_b.key(),
        )?;

        let a_credit = &mut ctx.accounts.a_credit;
        let b_credit = &mut ctx.accounts.b_credit;
        initialize_score_if_needed(a_credit, ctx.accounts.a_identity.mint, ctx.bumps.a_credit);
        initialize_score_if_needed(b_credit, ctx.accounts.b_identity.mint, ctx.bumps.b_credit);
        if ctx.accounts.party_a.key() == ctx.accounts.party_b.key()
            || a_credit.identity_mint == b_credit.identity_mint
        {
            emit!(DealCreditRecorded {
                recorder: ctx.accounts.recorder.key(),
                a_identity_mint: a_credit.identity_mint,
                b_identity_mint: b_credit.identity_mint,
                base_credit,
                a_delta: 0,
                b_delta: 0,
            });
            return Ok(());
        }

        let a_before = a_credit.score;
        let b_before = b_credit.score;
        let a_delta = credit_delta(base_credit, a_before, b_before)?;
        let b_delta = credit_delta(base_credit, b_before, a_before)?;
        a_credit.score = checked_add(a_before, a_delta)?;
        b_credit.score = checked_add(b_before, b_delta)?;
        let now = Clock::get()?.unix_timestamp;
        upsert_top_peer(
            &mut a_credit.top_peers,
            b_credit.identity_mint,
            b_credit.score,
            now,
        );
        upsert_top_peer(
            &mut b_credit.top_peers,
            a_credit.identity_mint,
            a_credit.score,
            now,
        );
        emit!(CreditUpdated {
            identity_mint: a_credit.identity_mint,
            delta: a_delta,
            new_score: a_credit.score,
        });
        emit!(CreditUpdated {
            identity_mint: b_credit.identity_mint,
            delta: b_delta,
            new_score: b_credit.score,
        });
        emit!(DealCreditRecorded {
            recorder: ctx.accounts.recorder.key(),
            a_identity_mint: a_credit.identity_mint,
            b_identity_mint: b_credit.identity_mint,
            base_credit,
            a_delta,
            b_delta,
        });
        Ok(())
    }

    pub fn record_single(ctx: Context<RecordSingle>, base_credit: u128) -> Result<()> {
        assert_recording_enabled(&ctx.accounts.config, &ctx.accounts.recorder)?;
        if base_credit == 0 {
            return Ok(());
        }
        assert_official_owner(
            &ctx.accounts.identity,
            ctx.accounts.identity.key(),
            &ctx.accounts.owner_token,
            ctx.accounts.party.key(),
        )?;
        let credit = &mut ctx.accounts.credit;
        initialize_score_if_needed(credit, ctx.accounts.identity.mint, ctx.bumps.credit);
        let delta = credit_delta(base_credit, credit.score, 0)?;
        credit.score = checked_add(credit.score, delta)?;
        emit!(CreditUpdated {
            identity_mint: credit.identity_mint,
            delta,
            new_score: credit.score,
        });
        emit!(SingleCreditRecorded {
            recorder: ctx.accounts.recorder.key(),
            identity_mint: credit.identity_mint,
            base_credit,
            delta,
        });
        Ok(())
    }
}

fn assert_authority(config: &CreditConfig, authority: &Signer<'_>) -> Result<()> {
    require_keys_eq!(config.authority, authority.key(), CreditError::Unauthorized);
    Ok(())
}

fn assert_recording_enabled(config: &CreditConfig, recorder: &Signer<'_>) -> Result<()> {
    require!(!config.paused, CreditError::Paused);
    require_keys_eq!(
        config.recorder,
        recorder.key(),
        CreditError::UnauthorizedRecorder
    );
    Ok(())
}

fn assert_official_identity(
    identity: &Account<'_, deal_identity::IdentityRecord>,
    identity_key: Pubkey,
) -> Result<()> {
    let expected = Pubkey::find_program_address(
        &[deal_identity::IDENTITY_SEED, identity.mint.as_ref()],
        &deal_identity::ID,
    )
    .0;
    require_keys_eq!(expected, identity_key, CreditError::InvalidIdentity);
    Ok(())
}

fn assert_official_owner(
    identity: &Account<'_, deal_identity::IdentityRecord>,
    identity_key: Pubkey,
    owner_token: &TokenAccount,
    party: Pubkey,
) -> Result<()> {
    assert_official_identity(identity, identity_key)?;
    require_keys_eq!(
        owner_token.mint,
        identity.mint,
        CreditError::InvalidIdentityMint
    );
    require_keys_eq!(owner_token.owner, party, CreditError::InvalidIdentityOwner);
    require_eq!(owner_token.amount, 1, CreditError::InvalidIdentityBalance);
    Ok(())
}

fn initialize_score_if_needed(credit: &mut CreditScore, identity_mint: Pubkey, bump: u8) {
    if credit.identity_mint == Pubkey::default() {
        credit.identity_mint = identity_mint;
        credit.score = 0;
        credit.top_peers = [CreditPeer::default(); TOP_K];
        credit.bump = bump;
    }
}

fn checked_add(left: u128, right: u128) -> Result<u128> {
    left.checked_add(right)
        .ok_or_else(|| error!(CreditError::CreditOverflow))
}

fn credit_delta(base_credit: u128, self_credit: u128, counterparty_credit: u128) -> Result<u128> {
    let extra_bps = if self_credit == 0 {
        if counterparty_credit == 0 {
            0
        } else {
            MAX_EXTRA_BPS
        }
    } else if counterparty_credit == 0 {
        0
    } else {
        counterparty_credit
            .checked_mul(BPS)
            .ok_or_else(|| error!(CreditError::CreditOverflow))?
            .checked_div(self_credit)
            .ok_or_else(|| error!(CreditError::CreditOverflow))?
            .clamp(MIN_EXTRA_BPS, MAX_EXTRA_BPS)
    };
    let extra = base_credit
        .checked_mul(extra_bps)
        .ok_or_else(|| error!(CreditError::CreditOverflow))?
        .checked_div(BPS)
        .ok_or_else(|| error!(CreditError::CreditOverflow))?;
    checked_add(base_credit, extra)
}

fn upsert_top_peer(
    peers: &mut [CreditPeer; TOP_K],
    peer_mint: Pubkey,
    peer_credit: u128,
    updated_at: i64,
) {
    if peer_mint == Pubkey::default() {
        return;
    }
    if let Some(existing) = peers
        .iter_mut()
        .find(|peer| peer.identity_mint == peer_mint)
    {
        *existing = CreditPeer::new(peer_mint, peer_credit, updated_at);
        return;
    }
    if let Some(empty) = peers
        .iter_mut()
        .find(|peer| peer.identity_mint == Pubkey::default())
    {
        *empty = CreditPeer::new(peer_mint, peer_credit, updated_at);
        return;
    }
    if let Some((index, minimum)) = peers
        .iter()
        .enumerate()
        .min_by_key(|(_, peer)| peer.credit_snapshot)
    {
        if peer_credit > minimum.credit_snapshot {
            peers[index] = CreditPeer::new(peer_mint, peer_credit, updated_at);
        }
    }
}

fn validate_import_peers(identity_mint: Pubkey, peers: &[CreditPeerInput; TOP_K]) -> Result<()> {
    for (index, peer) in peers.iter().enumerate() {
        require!(
            peer.identity_mint != identity_mint,
            CreditError::InvalidCreditPeer
        );
        if peer.identity_mint == Pubkey::default() {
            require!(
                peer.credit_snapshot == 0 && peer.updated_at == 0,
                CreditError::InvalidCreditPeer
            );
        } else {
            require!(
                peers[..index]
                    .iter()
                    .all(|prior| prior.identity_mint != peer.identity_mint),
                CreditError::InvalidCreditPeer
            );
        }
    }
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(init, payer = payer, space = CreditConfig::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, CreditConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, CreditConfig>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, CreditConfig>,
}

#[derive(Accounts)]
pub struct ImportCredit<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, CreditConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub import_authority: Signer<'info>,
    pub identity: Account<'info, deal_identity::IdentityRecord>,
    #[account(
        init_if_needed,
        payer = payer,
        space = CreditScore::SPACE,
        seeds = [SCORE_SEED, identity.mint.as_ref()],
        bump
    )]
    pub credit: Account<'info, CreditScore>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordPair<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, CreditConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub recorder: Signer<'info>,
    /// CHECK: Validated against the official identity token account.
    pub party_a: UncheckedAccount<'info>,
    /// CHECK: Validated against the official identity token account.
    pub party_b: UncheckedAccount<'info>,
    pub a_identity: Account<'info, deal_identity::IdentityRecord>,
    pub b_identity: Account<'info, deal_identity::IdentityRecord>,
    pub a_owner_token: InterfaceAccount<'info, TokenAccount>,
    pub b_owner_token: InterfaceAccount<'info, TokenAccount>,
    #[account(init_if_needed, payer = payer, space = CreditScore::SPACE, seeds = [SCORE_SEED, a_identity.mint.as_ref()], bump)]
    pub a_credit: Account<'info, CreditScore>,
    #[account(init_if_needed, payer = payer, space = CreditScore::SPACE, seeds = [SCORE_SEED, b_identity.mint.as_ref()], bump)]
    pub b_credit: Account<'info, CreditScore>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordSingle<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, CreditConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub recorder: Signer<'info>,
    /// CHECK: Validated against the official identity token account.
    pub party: UncheckedAccount<'info>,
    pub identity: Account<'info, deal_identity::IdentityRecord>,
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    #[account(init_if_needed, payer = payer, space = CreditScore::SPACE, seeds = [SCORE_SEED, identity.mint.as_ref()], bump)]
    pub credit: Account<'info, CreditScore>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct CreditConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub recorder: Pubkey,
    pub import_authority: Pubkey,
    pub migration_locked: bool,
    pub paused: bool,
    pub bump: u8,
}

impl CreditConfig {
    pub const SPACE: usize = 8 + (32 * 4) + 3;
}

#[account]
pub struct CreditScore {
    pub identity_mint: Pubkey,
    pub score: u128,
    pub top_peers: [CreditPeer; TOP_K],
    pub bump: u8,
}

impl CreditScore {
    pub const SPACE: usize = 8 + 32 + 16 + (CreditPeer::SIZE * TOP_K) + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct CreditPeer {
    pub identity_mint: Pubkey,
    pub credit_snapshot: u128,
    pub updated_at: i64,
}

impl CreditPeer {
    pub const SIZE: usize = 32 + 16 + 8;

    fn new(identity_mint: Pubkey, credit_snapshot: u128, updated_at: i64) -> Self {
        Self {
            identity_mint,
            credit_snapshot,
            updated_at,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct CreditPeerInput {
    pub identity_mint: Pubkey,
    pub credit_snapshot: u128,
    pub updated_at: i64,
}

impl From<CreditPeerInput> for CreditPeer {
    fn from(value: CreditPeerInput) -> Self {
        Self::new(value.identity_mint, value.credit_snapshot, value.updated_at)
    }
}

#[event]
pub struct CreditConfigInitialized {
    pub authority: Pubkey,
    pub recorder: Pubkey,
}
#[event]
pub struct CreditPauseUpdated {
    pub paused: bool,
}
#[event]
pub struct CreditRecorderUpdated {
    pub recorder: Pubkey,
}
#[event]
pub struct CreditImportAuthorityUpdated {
    pub import_authority: Pubkey,
}
#[event]
pub struct CreditMigrationLocked {}
#[event]
pub struct CreditAuthorityProposed {
    pub pending_authority: Pubkey,
}
#[event]
pub struct CreditAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}
#[event]
pub struct CreditImported {
    pub identity_mint: Pubkey,
    pub score: u128,
}
#[event]
pub struct CreditUpdated {
    pub identity_mint: Pubkey,
    pub delta: u128,
    pub new_score: u128,
}
#[event]
pub struct DealCreditRecorded {
    pub recorder: Pubkey,
    pub a_identity_mint: Pubkey,
    pub b_identity_mint: Pubkey,
    pub base_credit: u128,
    pub a_delta: u128,
    pub b_delta: u128,
}
#[event]
pub struct SingleCreditRecorded {
    pub recorder: Pubkey,
    pub identity_mint: Pubkey,
    pub base_credit: u128,
    pub delta: u128,
}

#[error_code(offset = 6100)]
pub enum CreditError {
    #[msg("address cannot be zero")]
    ZeroAddress,
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("pending authority is invalid")]
    InvalidPendingAuthority,
    #[msg("credit recording is paused")]
    Paused,
    #[msg("recorder is not authorized")]
    UnauthorizedRecorder,
    #[msg("credit import authority is not authorized")]
    UnauthorizedImporter,
    #[msg("credit migration is permanently locked")]
    MigrationLocked,
    #[msg("identity record is not an official Deal identity")]
    InvalidIdentity,
    #[msg("identity mint does not match the identity record")]
    InvalidIdentityMint,
    #[msg("identity token owner does not match the deal party")]
    InvalidIdentityOwner,
    #[msg("official identity balance must equal one")]
    InvalidIdentityBalance,
    #[msg("credit peer data is invalid")]
    InvalidCreditPeer,
    #[msg("credit arithmetic overflow")]
    CreditOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credit_formula_matches_evm_rules() {
        assert_eq!(credit_delta(3_000, 10_000, 200).unwrap(), 3_060);
        assert_eq!(credit_delta(30, 200, 10_000).unwrap(), 90);
        assert_eq!(credit_delta(30, 0, 0).unwrap(), 30);
        assert_eq!(credit_delta(30, 0, 1).unwrap(), 90);
        assert_eq!(credit_delta(30, 1, 0).unwrap(), 30);
    }

    #[test]
    fn top_five_refreshes_and_replaces_only_when_stronger() {
        let mut peers = [CreditPeer::default(); TOP_K];
        let keys = std::array::from_fn::<_, TOP_K, _>(|_| Pubkey::new_unique());
        for (index, key) in keys.iter().enumerate() {
            upsert_top_peer(&mut peers, *key, (index + 1) as u128 * 10, index as i64);
        }
        let weak = Pubkey::new_unique();
        upsert_top_peer(&mut peers, weak, 5, 10);
        assert!(!peers.iter().any(|peer| peer.identity_mint == weak));
        let strong = Pubkey::new_unique();
        upsert_top_peer(&mut peers, strong, 60, 11);
        assert!(peers.iter().any(|peer| peer.identity_mint == strong));
        assert!(!peers.iter().any(|peer| peer.identity_mint == keys[0]));
        upsert_top_peer(&mut peers, keys[1], 99, 12);
        assert_eq!(
            peers
                .iter()
                .find(|peer| peer.identity_mint == keys[1])
                .unwrap()
                .credit_snapshot,
            99
        );
    }
}
