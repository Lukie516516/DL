use anchor_lang::prelude::*;

use crate::constants::{
    MAX_DESCRIPTION_BYTES, MAX_DOMAIN_BYTES, MAX_REPLACE_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS,
    MAX_TITLE_BYTES, MIN_REPLACE_TIMEOUT_SECONDS,
};
use crate::errors::DealCoreError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum TemplateType {
    TokenToToken,
    TokenToNft,
    TokenToEmpty,
    EmptyToEmpty,
    NftToEmpty,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum JoinMode {
    Open,
    ExactAddress,
    NftGated,
    ExactAddressAndNftGated,
}

impl JoinMode {
    pub fn is_exact(self) -> bool {
        matches!(self, Self::ExactAddress | Self::ExactAddressAndNftGated)
    }

    pub fn is_gated(self) -> bool {
        matches!(self, Self::NftGated | Self::ExactAddressAndNftGated)
    }

    pub fn is_open(self) -> bool {
        self == Self::Open
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum DealStatus {
    Ready,
    Active,
    Locked,
    Completed,
    Canceled,
    Abandoned,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Vote {
    Unset,
    Accept,
    Reject,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompletionReason {
    None,
    BothAccepted,
    ForcedByA,
    ForcedByB,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum DepositKind {
    Funds,
    AssetNft,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct CreateDealParams {
    pub template_type: TemplateType,
    pub open_token_token_fast: bool,
    pub join_mode: JoinMode,
    pub expected_participant: Pubkey,
    pub a_swap_amount: u64,
    pub a_margin_amount: u64,
    pub b_swap_amount: u64,
    pub b_margin_amount: u64,
    pub a_has_asset_nft: bool,
    pub b_has_asset_nft: bool,
    pub title: String,
    pub description: String,
    pub timeout_seconds: u64,
    pub replace_timeout_seconds: u64,
    pub is_domain_deal: bool,
    pub domain_name: String,
}

impl CreateDealParams {
    pub fn validate(&self, _creator: Pubkey) -> Result<()> {
        require!(
            self.title.len() <= MAX_TITLE_BYTES,
            DealCoreError::TitleTooLong
        );
        require!(
            self.description.len() <= MAX_DESCRIPTION_BYTES,
            DealCoreError::DescriptionTooLong
        );
        require!(
            (1..=MAX_TIMEOUT_SECONDS).contains(&self.timeout_seconds),
            DealCoreError::InvalidTimeout
        );
        if self.open_token_token_fast {
            require!(
                self.template_type == TemplateType::TokenToToken,
                DealCoreError::InvalidTemplateShape
            );
            require!(
                self.join_mode != JoinMode::ExactAddressAndNftGated,
                DealCoreError::InvalidTemplateShape
            );
            require!(
                (MIN_REPLACE_TIMEOUT_SECONDS..=MAX_REPLACE_TIMEOUT_SECONDS)
                    .contains(&self.replace_timeout_seconds),
                DealCoreError::InvalidReplaceTimeout
            );
        }

        if self.is_domain_deal {
            require!(
                !self.domain_name.is_empty() && self.domain_name.len() <= MAX_DOMAIN_BYTES,
                DealCoreError::InvalidDomainName
            );
        } else {
            require!(
                self.domain_name.is_empty(),
                DealCoreError::UnexpectedDomainName
            );
        }

        if self.join_mode.is_exact() {
            require!(
                self.expected_participant != Pubkey::default(),
                DealCoreError::InvalidExpectedParticipant
            );
        }

        let a_has_swap = self.a_swap_amount > 0;
        let b_has_swap = self.b_swap_amount > 0;
        let valid_shape = match self.template_type {
            TemplateType::TokenToToken => {
                a_has_swap && b_has_swap && !self.a_has_asset_nft && !self.b_has_asset_nft
            }
            TemplateType::TokenToNft => {
                (a_has_swap && !b_has_swap && !self.a_has_asset_nft && self.b_has_asset_nft)
                    || (b_has_swap && !a_has_swap && !self.b_has_asset_nft && self.a_has_asset_nft)
            }
            TemplateType::TokenToEmpty => {
                a_has_swap != b_has_swap && !self.a_has_asset_nft && !self.b_has_asset_nft
            }
            TemplateType::EmptyToEmpty => {
                !a_has_swap && !b_has_swap && !self.a_has_asset_nft && !self.b_has_asset_nft
            }
            TemplateType::NftToEmpty => {
                !a_has_swap && !b_has_swap && (self.a_has_asset_nft != self.b_has_asset_nft)
            }
        };
        require!(valid_shape, DealCoreError::InvalidTemplateShape);
        Ok(())
    }
}

#[account]
pub struct DealRegistry {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub asset_controller: Pubkey,
    pub identity_controller: Pubkey,
    pub domain_entry_controller: Pubkey,
    pub next_deal_id: u64,
    pub min_timeout_seconds: u64,
    pub paused: bool,
    pub bump: u8,
}

impl DealRegistry {
    pub const SPACE: usize = 8 + (32 * 5) + (8 * 2) + 1 + 1;
}

#[account]
pub struct DealAccount {
    pub id: u64,
    pub creator: Pubkey,
    pub participant: Pubkey,
    pub expected_participant: Pubkey,
    pub last_removed_participant: Pubkey,
    pub template_type: TemplateType,
    pub open_token_token_fast: bool,
    pub join_mode: JoinMode,
    pub status: DealStatus,
    pub a_vote: Vote,
    pub b_vote: Vote,
    pub completion_reason: CompletionReason,
    pub a_funds_deposited: bool,
    pub b_funds_deposited: bool,
    pub a_asset_deposited: bool,
    pub b_asset_deposited: bool,
    pub a_asset_required: bool,
    pub b_asset_required: bool,
    pub a_has_pre_accepted: bool,
    pub is_domain_deal: bool,
    pub a_swap_amount: u64,
    pub a_margin_amount: u64,
    pub b_swap_amount: u64,
    pub b_margin_amount: u64,
    pub timeout_seconds: u64,
    pub replace_timeout_seconds: u64,
    pub created_at: i64,
    pub ended_at: i64,
    pub b_joined_at: i64,
    pub locked_at: i64,
    pub a_vote_at: i64,
    pub b_vote_at: i64,
    pub a_pre_accept_at: i64,
    pub title: String,
    pub description: String,
    pub domain_name: String,
    pub bump: u8,
}

impl DealAccount {
    pub const SPACE: usize = 8
        + 8
        + (32 * 4)
        + 8
        + 7
        + (8 * 6)
        + (8 * 7)
        + 4
        + MAX_TITLE_BYTES
        + 4
        + MAX_DESCRIPTION_BYTES
        + 4
        + MAX_DOMAIN_BYTES
        + 1;

    pub fn initialize(
        &mut self,
        id: u64,
        creator: Pubkey,
        bump: u8,
        params: CreateDealParams,
        now: i64,
    ) -> Result<()> {
        params.validate(creator)?;
        self.id = id;
        self.creator = creator;
        self.participant = Pubkey::default();
        self.expected_participant = params.expected_participant;
        self.last_removed_participant = Pubkey::default();
        self.template_type = params.template_type;
        self.open_token_token_fast = params.open_token_token_fast;
        self.join_mode = params.join_mode;
        self.status = DealStatus::Ready;
        self.a_vote = Vote::Unset;
        self.b_vote = Vote::Unset;
        self.completion_reason = CompletionReason::None;
        self.a_funds_deposited = false;
        self.b_funds_deposited = false;
        self.a_asset_deposited = false;
        self.b_asset_deposited = false;
        self.a_asset_required = params.a_has_asset_nft;
        self.b_asset_required = params.b_has_asset_nft;
        self.a_has_pre_accepted = false;
        self.is_domain_deal = params.is_domain_deal;
        self.a_swap_amount = params.a_swap_amount;
        self.a_margin_amount = params.a_margin_amount;
        self.b_swap_amount = params.b_swap_amount;
        self.b_margin_amount = params.b_margin_amount;
        self.timeout_seconds = params.timeout_seconds;
        self.replace_timeout_seconds = params.replace_timeout_seconds;
        self.created_at = now;
        self.ended_at = 0;
        self.b_joined_at = 0;
        self.locked_at = 0;
        self.a_vote_at = 0;
        self.b_vote_at = 0;
        self.a_pre_accept_at = 0;
        self.title = params.title;
        self.description = params.description;
        self.domain_name = params.domain_name;
        self.bump = bump;
        Ok(())
    }

    pub fn update_amounts(
        &mut self,
        actor: Pubkey,
        a_swap_amount: u64,
        a_margin_amount: u64,
        b_swap_amount: u64,
        b_margin_amount: u64,
    ) -> Result<()> {
        self.require_creator(actor)?;
        self.require_status(DealStatus::Ready)?;
        require!(
            !self.a_funds_deposited && !self.a_asset_deposited,
            DealCoreError::AmountsLocked
        );
        let mut candidate = CreateDealParams {
            template_type: self.template_type,
            open_token_token_fast: self.open_token_token_fast,
            join_mode: self.join_mode,
            expected_participant: self.expected_participant,
            a_swap_amount,
            a_margin_amount,
            b_swap_amount,
            b_margin_amount,
            a_has_asset_nft: self.a_asset_required,
            b_has_asset_nft: self.b_asset_required,
            title: self.title.clone(),
            description: self.description.clone(),
            timeout_seconds: self.timeout_seconds,
            replace_timeout_seconds: self.replace_timeout_seconds,
            is_domain_deal: self.is_domain_deal,
            domain_name: self.domain_name.clone(),
        };
        if !candidate.join_mode.is_exact() {
            candidate.expected_participant = Pubkey::default();
        }
        candidate.validate(self.creator)?;
        self.a_swap_amount = a_swap_amount;
        self.a_margin_amount = a_margin_amount;
        self.b_swap_amount = b_swap_amount;
        self.b_margin_amount = b_margin_amount;
        Ok(())
    }

    pub fn open_join_for(&mut self, actor: Pubkey, chosen: Pubkey) -> Result<()> {
        self.require_creator(actor)?;
        self.require_status(DealStatus::Ready)?;
        require!(
            self.participant == Pubkey::default(),
            DealCoreError::ParticipantAlreadyJoined
        );
        require!(
            chosen != Pubkey::default() && chosen != self.creator,
            DealCoreError::InvalidExpectedParticipant
        );
        self.expected_participant = chosen;
        self.join_mode = if self.join_mode.is_gated() {
            JoinMode::ExactAddressAndNftGated
        } else {
            JoinMode::ExactAddress
        };
        Ok(())
    }

    pub fn join(&mut self, candidate: Pubkey, gated: bool, now: i64) -> Result<()> {
        self.require_status(DealStatus::Ready)?;
        require!(
            self.participant == Pubkey::default(),
            DealCoreError::ParticipantAlreadyJoined
        );
        require!(candidate != self.creator, DealCoreError::CreatorCannotJoin);
        if self.join_mode.is_gated() {
            require!(gated, DealCoreError::GatedJoinRequired);
        } else {
            require!(!gated, DealCoreError::GatedJoinRequired);
        }
        if self.join_mode.is_exact() {
            require_keys_eq!(
                candidate,
                self.expected_participant,
                DealCoreError::WrongParticipant
            );
        }
        require!(
            candidate != self.last_removed_participant
                || (self.join_mode.is_exact() && self.expected_participant == candidate),
            DealCoreError::RemovedParticipantBlocked
        );
        self.set_joined_participant(candidate, now);
        Ok(())
    }

    pub fn record_deposit(
        &mut self,
        actor: Pubkey,
        is_party_a: bool,
        kind: DepositKind,
        now: i64,
    ) -> Result<bool> {
        if self.status == DealStatus::Ready {
            require!(
                self.open_token_token_fast,
                DealCoreError::OpenTokenModeRequired
            );
            require!(is_party_a && actor == self.creator, DealCoreError::NotParty);
            require!(
                self.participant == Pubkey::default(),
                DealCoreError::ParticipantAlreadyJoined
            );
        } else {
            self.require_status(DealStatus::Active)?;
            self.require_side(actor, is_party_a)?;
        }
        let flag = self.deposit_flag_mut(is_party_a, kind)?;
        require!(!*flag, DealCoreError::AlreadyDeposited);
        *flag = true;
        Ok(self.try_lock(now))
    }

    pub fn record_withdrawal(&mut self, actor: Pubkey, is_party_a: bool) -> Result<()> {
        require!(
            matches!(self.status, DealStatus::Ready | DealStatus::Active),
            DealCoreError::InvalidStatus
        );
        if self.status == DealStatus::Ready {
            require!(
                self.open_token_token_fast,
                DealCoreError::OpenTokenModeRequired
            );
            require!(is_party_a && actor == self.creator, DealCoreError::NotParty);
        } else {
            self.require_side(actor, is_party_a)?;
        }
        let had_deposit = if is_party_a {
            let had = self.a_funds_deposited || self.a_asset_deposited;
            self.a_funds_deposited = false;
            self.a_asset_deposited = false;
            had
        } else {
            let had = self.b_funds_deposited || self.b_asset_deposited;
            self.b_funds_deposited = false;
            self.b_asset_deposited = false;
            had
        };
        require!(had_deposit, DealCoreError::NothingDeposited);
        Ok(())
    }

    pub fn pre_accept(&mut self, actor: Pubkey, now: i64) -> Result<()> {
        require!(
            self.open_token_token_fast,
            DealCoreError::OpenTokenModeRequired
        );
        self.require_creator(actor)?;
        require!(
            matches!(self.status, DealStatus::Ready | DealStatus::Active),
            DealCoreError::InvalidStatus
        );
        self.a_has_pre_accepted = true;
        self.a_pre_accept_at = now;
        Ok(())
    }

    pub fn cast_vote(&mut self, actor: Pubkey, vote: Vote, now: i64) -> Result<()> {
        self.require_status(DealStatus::Locked)?;
        require!(
            matches!(vote, Vote::Accept | Vote::Reject),
            DealCoreError::InvalidVote
        );
        if actor == self.creator {
            if !(vote == Vote::Accept && self.a_vote == Vote::Accept) {
                self.a_vote = vote;
                self.a_vote_at = now;
            }
        } else if actor == self.participant {
            self.b_vote = vote;
            self.b_vote_at = now;
        } else {
            return err!(DealCoreError::NotParty);
        }
        Ok(())
    }

    pub fn settle_votes(&mut self, now: i64) -> Result<SettlementOutcome> {
        self.require_status(DealStatus::Locked)?;
        if self.a_vote == Vote::Accept && self.b_vote == Vote::Accept {
            self.complete(CompletionReason::BothAccepted, now);
            return Ok(SettlementOutcome::Completed);
        }
        if self.a_vote == Vote::Reject && self.b_vote == Vote::Reject {
            self.cancel(now);
            return Ok(SettlementOutcome::Canceled);
        }
        if self.open_token_token_fast && self.b_vote == Vote::Reject {
            let removed = self.participant;
            self.clear_participant(false);
            self.status = DealStatus::Ready;
            self.reset_lock_and_votes();
            return Ok(SettlementOutcome::ParticipantExpelled(removed));
        }
        err!(DealCoreError::NothingToSettle)
    }

    pub fn force_complete(&mut self, actor: Pubkey, now: i64) -> Result<CompletionReason> {
        self.require_status(DealStatus::Locked)?;
        let (base, reason) =
            if actor == self.creator && self.a_vote == Vote::Accept && self.b_vote == Vote::Unset {
                (
                    self.a_vote_at.max(self.locked_at),
                    CompletionReason::ForcedByA,
                )
            } else if actor == self.participant
                && self.b_vote == Vote::Accept
                && self.a_vote == Vote::Unset
            {
                (
                    self.b_vote_at.max(self.locked_at),
                    CompletionReason::ForcedByB,
                )
            } else {
                return err!(DealCoreError::ForceCompleteNotEligible);
            };
        require!(
            now >= base.saturating_add(self.timeout_seconds as i64),
            DealCoreError::ForceCompleteTooEarly
        );
        self.complete(reason, now);
        Ok(reason)
    }

    pub fn exit_by_b(&mut self, actor: Pubkey) -> Result<Pubkey> {
        self.require_status(DealStatus::Active)?;
        require_keys_eq!(actor, self.participant, DealCoreError::NotParty);
        let removed = self.participant;
        self.clear_participant(true);
        self.status = DealStatus::Ready;
        Ok(removed)
    }

    pub fn kick_b_by_a(&mut self, actor: Pubkey) -> Result<Pubkey> {
        self.require_creator(actor)?;
        self.require_status(DealStatus::Active)?;
        let removed = self.participant;
        require!(
            removed != Pubkey::default(),
            DealCoreError::ParticipantMissing
        );
        self.clear_participant(true);
        self.status = DealStatus::Ready;
        Ok(removed)
    }

    pub fn replace_inactive_b(&mut self, candidate: Pubkey, now: i64) -> Result<Pubkey> {
        require!(
            self.open_token_token_fast,
            DealCoreError::OpenTokenModeRequired
        );
        self.require_status(DealStatus::Active)?;
        require!(self.join_mode.is_open(), DealCoreError::ReplacementNotOpen);
        self.validate_replacement_candidate(candidate)?;
        require!(
            self.b_joined_at > 0
                && now
                    >= self
                        .b_joined_at
                        .saturating_add(self.replace_timeout_seconds as i64),
            DealCoreError::ReplacementTooEarly
        );
        let removed = self.participant;
        self.clear_participant(false);
        self.set_joined_participant(candidate, now);
        Ok(removed)
    }

    pub fn replace_non_voting_b(&mut self, candidate: Pubkey, now: i64) -> Result<Pubkey> {
        require!(
            self.open_token_token_fast,
            DealCoreError::OpenTokenModeRequired
        );
        self.require_status(DealStatus::Locked)?;
        require!(self.join_mode.is_open(), DealCoreError::ReplacementNotOpen);
        self.validate_replacement_candidate(candidate)?;
        require!(
            self.a_vote == Vote::Accept && self.b_vote == Vote::Unset,
            DealCoreError::ReplacementNotEligible
        );
        let base = self.a_vote_at.max(self.locked_at);
        require!(
            base > 0 && now >= base.saturating_add(self.replace_timeout_seconds as i64),
            DealCoreError::ReplacementTooEarly
        );
        let removed = self.participant;
        self.clear_participant(false);
        self.status = DealStatus::Active;
        self.reset_lock_and_votes();
        self.a_has_pre_accepted = true;
        self.a_pre_accept_at = now;
        self.set_joined_participant(candidate, now);
        Ok(removed)
    }

    pub fn abandon(&mut self, actor: Pubkey, now: i64) -> Result<()> {
        self.require_creator(actor)?;
        require!(
            matches!(self.status, DealStatus::Ready | DealStatus::Active),
            DealCoreError::InvalidStatus
        );
        self.a_funds_deposited = false;
        self.b_funds_deposited = false;
        self.a_asset_deposited = false;
        self.b_asset_deposited = false;
        self.participant = Pubkey::default();
        self.status = DealStatus::Abandoned;
        self.ended_at = now;
        Ok(())
    }

    fn require_creator(&self, actor: Pubkey) -> Result<()> {
        require_keys_eq!(actor, self.creator, DealCoreError::NotPartyA);
        Ok(())
    }

    fn require_status(&self, expected: DealStatus) -> Result<()> {
        require!(self.status == expected, DealCoreError::InvalidStatus);
        Ok(())
    }

    fn require_side(&self, actor: Pubkey, is_party_a: bool) -> Result<()> {
        let expected = if is_party_a {
            self.creator
        } else {
            self.participant
        };
        require!(
            expected != Pubkey::default(),
            DealCoreError::ParticipantMissing
        );
        require_keys_eq!(actor, expected, DealCoreError::NotParty);
        Ok(())
    }

    fn a_requires_funds(&self) -> bool {
        self.a_swap_amount > 0 || self.a_margin_amount > 0
    }

    fn b_requires_funds(&self) -> bool {
        self.b_swap_amount > 0 || self.b_margin_amount > 0
    }

    fn a_requires_asset(&self) -> bool {
        self.a_asset_required
    }

    fn b_requires_asset(&self) -> bool {
        self.b_asset_required
    }

    fn side_ready_a(&self) -> bool {
        (!self.a_requires_funds() || self.a_funds_deposited)
            && (!self.a_requires_asset() || self.a_asset_deposited)
    }

    fn side_ready_b(&self) -> bool {
        (!self.b_requires_funds() || self.b_funds_deposited)
            && (!self.b_requires_asset() || self.b_asset_deposited)
    }

    fn deposit_flag_mut(&mut self, is_party_a: bool, kind: DepositKind) -> Result<&mut bool> {
        let required = match (is_party_a, kind) {
            (true, DepositKind::Funds) => self.a_requires_funds(),
            (false, DepositKind::Funds) => self.b_requires_funds(),
            (true, DepositKind::AssetNft) => self.a_requires_asset(),
            (false, DepositKind::AssetNft) => self.b_requires_asset(),
        };
        require!(required, DealCoreError::DepositNotRequired);
        Ok(match (is_party_a, kind) {
            (true, DepositKind::Funds) => &mut self.a_funds_deposited,
            (false, DepositKind::Funds) => &mut self.b_funds_deposited,
            (true, DepositKind::AssetNft) => &mut self.a_asset_deposited,
            (false, DepositKind::AssetNft) => &mut self.b_asset_deposited,
        })
    }

    fn try_lock(&mut self, now: i64) -> bool {
        if self.status != DealStatus::Active || !self.side_ready_a() || !self.side_ready_b() {
            return false;
        }
        self.status = DealStatus::Locked;
        self.locked_at = now;
        if self.a_has_pre_accepted {
            self.a_vote = Vote::Accept;
            self.a_vote_at = self.a_pre_accept_at;
        } else {
            self.a_vote = Vote::Unset;
            self.a_vote_at = 0;
        }
        self.b_vote = Vote::Unset;
        self.b_vote_at = 0;
        true
    }

    fn set_joined_participant(&mut self, candidate: Pubkey, now: i64) {
        self.participant = candidate;
        self.status = DealStatus::Active;
        self.b_joined_at = now;
        if candidate == self.last_removed_participant {
            self.last_removed_participant = Pubkey::default();
        }
        self.try_lock(now);
    }

    fn validate_replacement_candidate(&self, candidate: Pubkey) -> Result<()> {
        require!(
            self.participant != Pubkey::default()
                && candidate != self.creator
                && candidate != self.participant
                && candidate != self.last_removed_participant,
            DealCoreError::RemovedParticipantBlocked
        );
        Ok(())
    }

    fn clear_participant(&mut self, refund_a: bool) {
        let removed = self.participant;
        if refund_a {
            self.a_funds_deposited = false;
            self.a_asset_deposited = false;
        }
        self.b_funds_deposited = false;
        self.b_asset_deposited = false;
        self.last_removed_participant = removed;
        if self.join_mode.is_exact() && self.expected_participant == removed {
            self.expected_participant = Pubkey::default();
        }
        self.participant = Pubkey::default();
        self.b_joined_at = 0;
    }

    fn reset_lock_and_votes(&mut self) {
        self.locked_at = 0;
        self.a_vote = Vote::Unset;
        self.b_vote = Vote::Unset;
        self.a_vote_at = 0;
        self.b_vote_at = 0;
    }

    fn complete(&mut self, reason: CompletionReason, now: i64) {
        self.status = DealStatus::Completed;
        self.completion_reason = reason;
        self.ended_at = now;
        self.a_funds_deposited = false;
        self.b_funds_deposited = false;
        self.a_asset_deposited = false;
        self.b_asset_deposited = false;
        self.b_joined_at = 0;
    }

    fn cancel(&mut self, now: i64) {
        self.status = DealStatus::Canceled;
        self.ended_at = now;
        self.a_funds_deposited = false;
        self.b_funds_deposited = false;
        self.a_asset_deposited = false;
        self.b_asset_deposited = false;
        self.b_joined_at = 0;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettlementOutcome {
    Completed,
    Canceled,
    ParticipantExpelled(Pubkey),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct TemplateShapeVector {
        name: String,
        template_type: u8,
        open_fast: bool,
        a_swap: u64,
        b_swap: u64,
        a_asset: bool,
        b_asset: bool,
        valid: bool,
    }

    fn key(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    fn token_token_params() -> CreateDealParams {
        CreateDealParams {
            template_type: TemplateType::TokenToToken,
            open_token_token_fast: true,
            join_mode: JoinMode::Open,
            expected_participant: Pubkey::default(),
            a_swap_amount: 100,
            a_margin_amount: 10,
            b_swap_amount: 200,
            b_margin_amount: 20,
            a_has_asset_nft: false,
            b_has_asset_nft: false,
            title: "token swap".into(),
            description: "state parity test".into(),
            timeout_seconds: 300,
            replace_timeout_seconds: 120,
            is_domain_deal: false,
            domain_name: String::new(),
        }
    }

    fn make_deal(params: CreateDealParams) -> DealAccount {
        let mut deal = DealAccount {
            id: 0,
            creator: Pubkey::default(),
            participant: Pubkey::default(),
            expected_participant: Pubkey::default(),
            last_removed_participant: Pubkey::default(),
            template_type: TemplateType::EmptyToEmpty,
            open_token_token_fast: false,
            join_mode: JoinMode::Open,
            status: DealStatus::Ready,
            a_vote: Vote::Unset,
            b_vote: Vote::Unset,
            completion_reason: CompletionReason::None,
            a_funds_deposited: false,
            b_funds_deposited: false,
            a_asset_deposited: false,
            b_asset_deposited: false,
            a_asset_required: false,
            b_asset_required: false,
            a_has_pre_accepted: false,
            is_domain_deal: false,
            a_swap_amount: 0,
            a_margin_amount: 0,
            b_swap_amount: 0,
            b_margin_amount: 0,
            timeout_seconds: 0,
            replace_timeout_seconds: 0,
            created_at: 0,
            ended_at: 0,
            b_joined_at: 0,
            locked_at: 0,
            a_vote_at: 0,
            b_vote_at: 0,
            a_pre_accept_at: 0,
            title: String::new(),
            description: String::new(),
            domain_name: String::new(),
            bump: 0,
        };
        deal.initialize(1, key(1), 255, params, 1_000).unwrap();
        deal
    }

    #[test]
    fn validates_evm_template_shapes_and_bounds() {
        let mut params = token_token_params();
        assert!(params.validate(key(1)).is_ok());
        params.b_swap_amount = 0;
        assert!(params.validate(key(1)).is_err());

        let mut nft_to_empty = token_token_params();
        nft_to_empty.template_type = TemplateType::NftToEmpty;
        nft_to_empty.open_token_token_fast = false;
        nft_to_empty.a_swap_amount = 0;
        nft_to_empty.b_swap_amount = 0;
        nft_to_empty.a_has_asset_nft = true;
        assert!(nft_to_empty.validate(key(1)).is_ok());
        nft_to_empty.b_has_asset_nft = true;
        assert!(nft_to_empty.validate(key(1)).is_err());

        let mut too_long = token_token_params();
        too_long.title = "x".repeat(MAX_TITLE_BYTES + 1);
        assert!(too_long.validate(key(1)).is_err());
        let mut bad_replace = token_token_params();
        bad_replace.replace_timeout_seconds = MIN_REPLACE_TIMEOUT_SECONDS - 1;
        assert!(bad_replace.validate(key(1)).is_err());
    }

    #[test]
    fn shared_eth_template_shape_vectors_match_solana_validation() {
        let vectors: Vec<TemplateShapeVector> =
            serde_json::from_str(include_str!("../../../fixtures/deal-template-shapes.json"))
                .unwrap();
        assert_eq!(vectors.iter().filter(|vector| vector.valid).count(), 9);
        assert_eq!(vectors.iter().filter(|vector| !vector.valid).count(), 6);

        for vector in vectors {
            let template_type = match vector.template_type {
                0 => TemplateType::TokenToToken,
                1 => TemplateType::TokenToNft,
                2 => TemplateType::TokenToEmpty,
                3 => TemplateType::EmptyToEmpty,
                4 => TemplateType::NftToEmpty,
                value => panic!("{}: invalid template type {value}", vector.name),
            };
            let params = CreateDealParams {
                template_type,
                open_token_token_fast: vector.open_fast,
                join_mode: JoinMode::Open,
                expected_participant: Pubkey::default(),
                a_swap_amount: vector.a_swap,
                a_margin_amount: 0,
                b_swap_amount: vector.b_swap,
                b_margin_amount: 0,
                a_has_asset_nft: vector.a_asset,
                b_has_asset_nft: vector.b_asset,
                title: vector.name.clone(),
                description: "shared ETH/Solana template oracle".into(),
                timeout_seconds: 3_600,
                replace_timeout_seconds: if vector.open_fast { 60 } else { 0 },
                is_domain_deal: false,
                domain_name: String::new(),
            };
            assert_eq!(
                params.validate(key(1)).is_ok(),
                vector.valid,
                "{}",
                vector.name
            );
        }
    }

    #[test]
    fn preaccept_deposit_lock_and_both_accept_complete_match_evm() {
        let mut deal = make_deal(token_token_params());
        let a = key(1);
        let b = key(2);
        deal.pre_accept(a, 1_010).unwrap();
        deal.record_deposit(a, true, DepositKind::Funds, 1_020)
            .unwrap();
        deal.join(b, false, 1_030).unwrap();
        let locked = deal
            .record_deposit(b, false, DepositKind::Funds, 1_040)
            .unwrap();
        assert!(locked);
        assert_eq!(deal.status, DealStatus::Locked);
        assert_eq!(deal.a_vote, Vote::Accept);
        assert_eq!(deal.a_vote_at, 1_010);

        deal.cast_vote(b, Vote::Accept, 1_050).unwrap();
        assert_eq!(
            deal.settle_votes(1_051).unwrap(),
            SettlementOutcome::Completed
        );
        assert_eq!(deal.status, DealStatus::Completed);
        assert_eq!(deal.completion_reason, CompletionReason::BothAccepted);
        assert_eq!(deal.ended_at, 1_051);
    }

    #[test]
    fn b_reject_expel_keeps_a_deposit_and_blocks_immediate_rejoin() {
        let mut deal = make_deal(token_token_params());
        let a = key(1);
        let b = key(2);
        deal.record_deposit(a, true, DepositKind::Funds, 1_010)
            .unwrap();
        deal.join(b, false, 1_020).unwrap();
        deal.record_deposit(b, false, DepositKind::Funds, 1_030)
            .unwrap();
        deal.cast_vote(b, Vote::Reject, 1_040).unwrap();
        assert_eq!(
            deal.settle_votes(1_041).unwrap(),
            SettlementOutcome::ParticipantExpelled(b)
        );
        assert_eq!(deal.status, DealStatus::Ready);
        assert!(deal.a_funds_deposited);
        assert!(!deal.b_funds_deposited);
        assert_eq!(deal.last_removed_participant, b);
        assert!(deal.join(b, false, 1_050).is_err());

        deal.open_join_for(a, b).unwrap();
        deal.join(b, false, 1_060).unwrap();
        assert_eq!(deal.participant, b);
    }

    #[test]
    fn ordinary_templates_preserve_single_reject_and_reject_fast_only_operations() {
        let a = key(1);
        let b = key(2);
        let c = key(3);
        let mut params = token_token_params();
        params.open_token_token_fast = false;
        params.replace_timeout_seconds = 0;
        assert!(params.validate(a).is_ok());

        let mut deal = make_deal(params);
        assert!(deal.pre_accept(a, 1_005).is_err());
        assert!(deal
            .record_deposit(a, true, DepositKind::Funds, 1_010)
            .is_err());
        deal.join(b, false, 1_020).unwrap();
        assert!(deal.replace_inactive_b(c, 10_000).is_err());
        deal.record_deposit(a, true, DepositKind::Funds, 1_030)
            .unwrap();
        deal.record_deposit(b, false, DepositKind::Funds, 1_040)
            .unwrap();
        deal.cast_vote(b, Vote::Reject, 1_050).unwrap();

        assert!(deal.settle_votes(1_051).is_err());
        assert_eq!(deal.status, DealStatus::Locked);
        assert_eq!(deal.participant, b);
        assert_eq!(deal.b_vote, Vote::Reject);
        assert!(deal.replace_non_voting_b(c, 10_000).is_err());
    }

    #[test]
    fn fast_mode_is_only_valid_for_supported_open_token_token_shapes() {
        let a = key(1);
        let mut not_token_to_token = token_token_params();
        not_token_to_token.template_type = TemplateType::TokenToEmpty;
        not_token_to_token.b_swap_amount = 0;
        assert!(not_token_to_token.validate(a).is_err());

        let mut exact_and_gated = token_token_params();
        exact_and_gated.join_mode = JoinMode::ExactAddressAndNftGated;
        exact_and_gated.expected_participant = key(2);
        assert!(exact_and_gated.validate(a).is_err());

        let mut ordinary = token_token_params();
        ordinary.open_token_token_fast = false;
        ordinary.replace_timeout_seconds = u64::MAX;
        assert!(ordinary.validate(a).is_ok());

        let mut exact_to_creator = ordinary;
        exact_to_creator.join_mode = JoinMode::ExactAddress;
        exact_to_creator.expected_participant = a;
        assert!(exact_to_creator.validate(a).is_ok());
        let mut dead_end = make_deal(exact_to_creator);
        assert!(dead_end.join(a, false, 1_010).is_err());
    }

    #[test]
    fn inactive_and_locked_replacements_obey_timeouts() {
        let mut deal = make_deal(token_token_params());
        let a = key(1);
        let b = key(2);
        let c = key(3);
        deal.join(b, false, 1_000).unwrap();
        assert!(deal.replace_inactive_b(c, 1_119).is_err());
        assert_eq!(deal.replace_inactive_b(c, 1_120).unwrap(), b);
        assert_eq!(deal.participant, c);

        deal.record_deposit(a, true, DepositKind::Funds, 1_130)
            .unwrap();
        deal.record_deposit(c, false, DepositKind::Funds, 1_140)
            .unwrap();
        deal.cast_vote(a, Vote::Accept, 1_150).unwrap();
        let d = key(4);
        assert!(deal.replace_non_voting_b(d, 1_269).is_err());
        assert_eq!(deal.replace_non_voting_b(d, 1_270).unwrap(), c);
        assert_eq!(deal.status, DealStatus::Active);
        assert!(deal.a_funds_deposited);
        assert!(deal.a_has_pre_accepted);
        assert!(!deal.b_funds_deposited);

        deal.record_deposit(d, false, DepositKind::Funds, 1_280)
            .unwrap();
        assert_eq!(deal.status, DealStatus::Locked);
        assert_eq!(deal.a_vote, Vote::Accept);
        assert_eq!(deal.a_vote_at, 1_270);
    }

    #[test]
    fn force_complete_requires_accept_silence_and_timeout() {
        let mut deal = make_deal(token_token_params());
        let a = key(1);
        let b = key(2);
        deal.join(b, false, 1_000).unwrap();
        deal.record_deposit(a, true, DepositKind::Funds, 1_010)
            .unwrap();
        deal.record_deposit(b, false, DepositKind::Funds, 1_020)
            .unwrap();
        deal.cast_vote(a, Vote::Accept, 1_030).unwrap();
        assert!(deal.force_complete(a, 1_329).is_err());
        assert_eq!(
            deal.force_complete(a, 1_330).unwrap(),
            CompletionReason::ForcedByA
        );
        assert_eq!(deal.status, DealStatus::Completed);

        let mut rejected = make_deal(token_token_params());
        rejected.join(b, false, 1_000).unwrap();
        rejected
            .record_deposit(a, true, DepositKind::Funds, 1_010)
            .unwrap();
        rejected
            .record_deposit(b, false, DepositKind::Funds, 1_020)
            .unwrap();
        rejected.cast_vote(a, Vote::Reject, 1_030).unwrap();
        assert!(rejected.force_complete(a, 2_000).is_err());
        assert_eq!(rejected.status, DealStatus::Locked);
    }

    #[test]
    fn nft_side_is_explicit_and_account_allocation_is_sufficient() {
        let mut params = token_token_params();
        params.template_type = TemplateType::NftToEmpty;
        params.open_token_token_fast = false;
        params.a_swap_amount = 0;
        params.a_margin_amount = 0;
        params.b_swap_amount = 0;
        params.b_margin_amount = 0;
        params.a_has_asset_nft = false;
        params.b_has_asset_nft = true;
        let mut deal = make_deal(params);
        let b = key(2);
        deal.join(b, false, 1_010).unwrap();
        assert!(deal
            .record_deposit(key(1), true, DepositKind::AssetNft, 1_020)
            .is_err());
        assert!(deal
            .record_deposit(b, false, DepositKind::AssetNft, 1_020)
            .unwrap());
        assert_eq!(deal.status, DealStatus::Locked);
        let mut serialized = Vec::new();
        deal.try_serialize(&mut serialized).unwrap();
        assert!(serialized.len() <= DealAccount::SPACE);
    }

    #[test]
    fn ready_and_active_withdrawals_and_abandon_match_evm() {
        let a = key(1);
        let b = key(2);
        let mut ready = make_deal(token_token_params());
        ready
            .record_deposit(a, true, DepositKind::Funds, 1_010)
            .unwrap();
        ready.record_withdrawal(a, true).unwrap();
        assert!(!ready.a_funds_deposited);
        assert_eq!(ready.status, DealStatus::Ready);

        ready.join(b, false, 1_020).unwrap();
        ready
            .record_deposit(a, true, DepositKind::Funds, 1_030)
            .unwrap();
        ready.record_withdrawal(a, true).unwrap();
        assert_eq!(ready.status, DealStatus::Active);
        assert!(!ready.a_funds_deposited);

        ready
            .record_deposit(b, false, DepositKind::Funds, 1_040)
            .unwrap();
        ready.abandon(a, 1_050).unwrap();
        assert_eq!(ready.status, DealStatus::Abandoned);
        assert_eq!(ready.ended_at, 1_050);
        assert!(!ready.b_funds_deposited);
        assert_eq!(ready.participant, Pubkey::default());
    }

    #[test]
    fn b_can_force_complete_only_after_accept_and_a_silence() {
        let a = key(1);
        let b = key(2);
        let mut deal = make_deal(token_token_params());
        deal.join(b, false, 1_000).unwrap();
        deal.record_deposit(a, true, DepositKind::Funds, 1_010)
            .unwrap();
        deal.record_deposit(b, false, DepositKind::Funds, 1_020)
            .unwrap();
        deal.cast_vote(b, Vote::Accept, 1_030).unwrap();
        assert!(deal.force_complete(b, 1_329).is_err());
        assert_eq!(
            deal.force_complete(b, 1_330).unwrap(),
            CompletionReason::ForcedByB
        );
    }

    #[test]
    fn both_reject_cancel_but_one_reject_cannot_force_cancel() {
        let a = key(1);
        let b = key(2);
        let mut deal = make_deal(token_token_params());
        deal.join(b, false, 1_000).unwrap();
        deal.record_deposit(a, true, DepositKind::Funds, 1_010)
            .unwrap();
        deal.record_deposit(b, false, DepositKind::Funds, 1_020)
            .unwrap();
        deal.cast_vote(a, Vote::Reject, 1_030).unwrap();
        assert!(deal.force_complete(a, 10_000).is_err());
        assert!(deal.settle_votes(10_000).is_err());
        assert_eq!(deal.status, DealStatus::Locked);
        deal.cast_vote(b, Vote::Reject, 10_001).unwrap();
        assert_eq!(
            deal.settle_votes(10_002).unwrap(),
            SettlementOutcome::Canceled
        );
        assert_eq!(deal.status, DealStatus::Canceled);
    }

    #[test]
    fn timeout_vectors_match_evm_preaccept_force_complete_for_512_cases() {
        let a = key(1);
        let b = key(2);
        let min_timeout = 60u64;
        let max_timeout = 365u64 * 24 * 60 * 60;
        let span = max_timeout - min_timeout + 1;
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;

        for _ in 0..512 {
            seed = seed
                .wrapping_mul(2_862_933_555_777_941_757)
                .wrapping_add(3_037_000_493);
            let timeout = min_timeout + seed % span;
            let mut params = token_token_params();
            params.timeout_seconds = timeout;
            let mut deal = make_deal(params);

            deal.pre_accept(a, 1_010).unwrap();
            deal.record_deposit(a, true, DepositKind::Funds, 1_020)
                .unwrap();
            deal.join(b, false, 1_030).unwrap();
            deal.record_deposit(b, false, DepositKind::Funds, 1_040)
                .unwrap();

            let deadline = 1_040i64 + timeout as i64;
            assert!(deal.force_complete(b, deadline).is_err());
            assert!(deal.force_complete(a, deadline - 1).is_err());
            assert_eq!(
                deal.force_complete(a, deadline).unwrap(),
                CompletionReason::ForcedByA
            );
            assert_eq!(deal.status, DealStatus::Completed);
            assert_eq!(deal.ended_at, deadline);
        }
    }

    #[test]
    fn kick_and_exit_refund_both_sides_and_require_a_to_reopen_removed_b() {
        let a = key(1);
        let b = key(2);
        let mut kicked = make_deal(token_token_params());
        kicked.join(b, false, 1_000).unwrap();
        kicked
            .record_deposit(a, true, DepositKind::Funds, 1_010)
            .unwrap();
        kicked
            .record_deposit(b, false, DepositKind::Funds, 1_020)
            .unwrap();
        // Depositing both locks, so use a fresh Active deal for kick semantics.
        let mut active = make_deal(token_token_params());
        active.join(b, false, 1_000).unwrap();
        active
            .record_deposit(a, true, DepositKind::Funds, 1_010)
            .unwrap();
        assert_eq!(active.kick_b_by_a(a).unwrap(), b);
        assert_eq!(active.status, DealStatus::Ready);
        assert!(!active.a_funds_deposited);
        assert!(active.join(b, false, 1_020).is_err());
        active.open_join_for(a, b).unwrap();
        active.join(b, false, 1_030).unwrap();

        let mut exited = make_deal(token_token_params());
        exited.join(b, false, 1_000).unwrap();
        exited
            .record_deposit(a, true, DepositKind::Funds, 1_010)
            .unwrap();
        assert_eq!(exited.exit_by_b(b).unwrap(), b);
        assert_eq!(exited.status, DealStatus::Ready);
        assert!(!exited.a_funds_deposited);
    }

    #[test]
    fn exact_and_gated_join_modes_are_both_enforced() {
        let a = key(1);
        let b = key(2);
        let c = key(3);
        let mut params = token_token_params();
        params.open_token_token_fast = false;
        params.join_mode = JoinMode::ExactAddressAndNftGated;
        params.expected_participant = b;
        let mut deal = make_deal(params);
        assert!(deal.join(c, true, 1_010).is_err());
        assert!(deal.join(b, false, 1_010).is_err());
        deal.join(b, true, 1_010).unwrap();
        assert_eq!(deal.participant, b);
        assert_ne!(deal.creator, deal.participant);
        assert_eq!(deal.creator, a);
    }

    #[test]
    fn amount_updates_preserve_template_shape_and_stop_after_a_deposit() {
        let a = key(1);
        let mut deal = make_deal(token_token_params());
        assert!(deal.update_amounts(a, 101, 11, 202, 22).is_ok());
        assert_eq!(deal.a_swap_amount, 101);
        assert!(deal.update_amounts(a, 0, 0, 202, 22).is_err());
        deal.record_deposit(a, true, DepositKind::Funds, 1_010)
            .unwrap();
        assert!(deal.update_amounts(a, 111, 0, 222, 0).is_err());
    }

    #[test]
    fn boundary_values_match_eth_limits() {
        let mut params = token_token_params();
        params.timeout_seconds = MAX_TIMEOUT_SECONDS;
        params.replace_timeout_seconds = MAX_REPLACE_TIMEOUT_SECONDS;
        params.title = "t".repeat(MAX_TITLE_BYTES);
        params.description = "d".repeat(MAX_DESCRIPTION_BYTES);
        assert!(params.validate(key(1)).is_ok());
        params.timeout_seconds = MAX_TIMEOUT_SECONDS + 1;
        assert!(params.validate(key(1)).is_err());
    }
}
