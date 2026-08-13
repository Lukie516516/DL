use anchor_lang::prelude::*;
use solana_keccak_hasher as keccak;

use crate::constants::{
    BRIDGE_COUNT, ENVELOPE_DOMAIN, ENVELOPE_VERSION, MAX_ACCOUNT_METAS, MAX_PAYLOAD_LEN,
    ZERO_PUBKEY,
};
use crate::errors::GovernanceError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct GovernanceAccountMeta {
    pub pubkey: Pubkey,
    pub is_writable: bool,
    pub is_signer: bool,
}

impl GovernanceAccountMeta {
    pub const SPACE: usize = 32 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct GovernanceEnvelope {
    pub version: u8,
    pub source_chain: u64,
    pub source_broadcaster: [u8; 32],
    pub bridge_set_version: u64,
    pub nonce: u64,
    pub action_type: u8,
    pub target_program: Pubkey,
    pub valid_after: i64,
    pub expires_at: i64,
    pub accounts: Vec<GovernanceAccountMeta>,
    pub payload: Vec<u8>,
}

impl GovernanceEnvelope {
    pub fn validate(&self, config: &GovernanceConfig) -> Result<()> {
        require_eq!(
            self.version,
            ENVELOPE_VERSION,
            GovernanceError::UnsupportedEnvelopeVersion
        );
        require_eq!(
            self.source_chain,
            config.source_chain,
            GovernanceError::WrongSourceChain
        );
        require!(
            self.source_broadcaster == config.source_broadcaster,
            GovernanceError::WrongSourceBroadcaster
        );
        require_eq!(
            self.bridge_set_version,
            config.bridge_set_version,
            GovernanceError::WrongBridgeSetVersion
        );
        require!(
            self.target_program != ZERO_PUBKEY,
            GovernanceError::ZeroTarget
        );
        require!(
            self.payload.len() <= MAX_PAYLOAD_LEN,
            GovernanceError::PayloadTooLarge
        );
        require!(
            self.accounts.len() <= MAX_ACCOUNT_METAS,
            GovernanceError::TooManyAccounts
        );
        for (index, account) in self.accounts.iter().enumerate() {
            require!(
                self.accounts[(index + 1)..].iter().all(|candidate| {
                    candidate.pubkey != account.pubkey
                        || (candidate.is_writable == account.is_writable
                            && candidate.is_signer == account.is_signer)
                }),
                GovernanceError::DuplicateAccount
            );
        }
        require!(
            self.expires_at > self.valid_after,
            GovernanceError::InvalidTimeWindow
        );
        Ok(())
    }

    /// Canonical cross-VM hash. Every field uses fixed big-endian encoding and
    /// only the payload hash is included, so Solidity and Rust can reproduce it.
    pub fn canonical_hash(&self) -> [u8; 32] {
        let source_chain = self.source_chain.to_be_bytes();
        let bridge_set_version = self.bridge_set_version.to_be_bytes();
        let nonce = self.nonce.to_be_bytes();
        let valid_after = self.valid_after.to_be_bytes();
        let expires_at = self.expires_at.to_be_bytes();
        let payload_hash = keccak::hash(&self.payload).to_bytes();
        let account_count = (self.accounts.len() as u16).to_be_bytes();

        let mut account_bytes =
            Vec::with_capacity(self.accounts.len() * GovernanceAccountMeta::SPACE);
        for meta in &self.accounts {
            account_bytes.extend_from_slice(meta.pubkey.as_ref());
            account_bytes.push(u8::from(meta.is_writable));
            account_bytes.push(u8::from(meta.is_signer));
        }

        keccak::hashv(&[
            ENVELOPE_DOMAIN,
            &[self.version],
            &source_chain,
            &self.source_broadcaster,
            &bridge_set_version,
            &nonce,
            &[self.action_type],
            self.target_program.as_ref(),
            &valid_after,
            &expires_at,
            &account_count,
            &account_bytes,
            &payload_hash,
        ])
        .to_bytes()
    }
}

#[account]
pub struct GovernanceConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub source_chain: u64,
    pub source_broadcaster: [u8; 32],
    pub bridge_signers: [Pubkey; BRIDGE_COUNT],
    pub bridge_set_version: u64,
    pub threshold: u8,
    pub paused: bool,
    pub last_executed_nonce: u64,
    pub bump: u8,
    pub executor_bump: u8,
}

impl GovernanceConfig {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 32 + (32 * BRIDGE_COUNT) + 8 + 1 + 1 + 8 + 1 + 1;

    pub fn validate_bridges(signers: &[Pubkey; BRIDGE_COUNT], threshold: u8) -> Result<()> {
        require!(
            threshold >= 2 && usize::from(threshold) <= BRIDGE_COUNT,
            GovernanceError::InvalidThreshold
        );
        for i in 0..BRIDGE_COUNT {
            require!(
                signers[i] != ZERO_PUBKEY,
                GovernanceError::InvalidBridgeConfiguration
            );
            for j in (i + 1)..BRIDGE_COUNT {
                require!(
                    signers[i] != signers[j],
                    GovernanceError::InvalidBridgeConfiguration
                );
            }
        }
        Ok(())
    }

    pub fn bridge_index(&self, signer: &Pubkey) -> Result<u8> {
        self.bridge_signers
            .iter()
            .position(|candidate| candidate == signer)
            .map(|index| index as u8)
            .ok_or_else(|| error!(GovernanceError::UnknownBridge))
    }
}

#[account]
pub struct AllowedTarget {
    pub target: Pubkey,
    pub allowed: bool,
    pub bump: u8,
}

impl AllowedTarget {
    pub const SPACE: usize = 8 + 32 + 1 + 1;
}

#[account]
pub struct MessageRecord {
    pub message_hash: [u8; 32],
    pub target_program: Pubkey,
    pub bridge_set_version: u64,
    pub nonce: u64,
    pub action_type: u8,
    pub valid_after: i64,
    pub expires_at: i64,
    pub confirmations: u8,
    pub ready: bool,
    pub executed: bool,
    pub cancelled: bool,
    pub bump: u8,
    pub accounts: Vec<GovernanceAccountMeta>,
    pub payload: Vec<u8>,
}

impl MessageRecord {
    pub const SPACE: usize = 8
        + 32
        + 32
        + 8
        + 8
        + 1
        + 8
        + 8
        + 1
        + 1
        + 1
        + 1
        + 1
        + 4
        + (GovernanceAccountMeta::SPACE * MAX_ACCOUNT_METAS)
        + 4
        + MAX_PAYLOAD_LEN;

    pub fn is_uninitialized(&self) -> bool {
        self.message_hash == [0; 32]
    }

    pub fn initialize_from(&mut self, hash: [u8; 32], envelope: &GovernanceEnvelope, bump: u8) {
        self.message_hash = hash;
        self.target_program = envelope.target_program;
        self.bridge_set_version = envelope.bridge_set_version;
        self.nonce = envelope.nonce;
        self.action_type = envelope.action_type;
        self.valid_after = envelope.valid_after;
        self.expires_at = envelope.expires_at;
        self.confirmations = 0;
        self.ready = false;
        self.executed = false;
        self.cancelled = false;
        self.bump = bump;
        self.accounts = envelope.accounts.clone();
        self.payload = envelope.payload.clone();
    }

    pub fn matches(&self, hash: [u8; 32], envelope: &GovernanceEnvelope) -> bool {
        self.message_hash == hash
            && self.target_program == envelope.target_program
            && self.bridge_set_version == envelope.bridge_set_version
            && self.nonce == envelope.nonce
            && self.action_type == envelope.action_type
            && self.valid_after == envelope.valid_after
            && self.expires_at == envelope.expires_at
            && self.accounts == envelope.accounts
            && self.payload == envelope.payload
    }

    pub fn confirm(&mut self, bridge_index: u8, threshold: u8) -> Result<u8> {
        require!(
            usize::from(bridge_index) < BRIDGE_COUNT,
            GovernanceError::InvalidBridgeIndex
        );
        let mask = 1u8 << bridge_index;
        require!(
            self.confirmations & mask == 0,
            GovernanceError::BridgeAlreadyConfirmed
        );
        self.confirmations |= mask;
        let count = self.confirmations.count_ones() as u8;
        if count >= threshold {
            self.ready = true;
        }
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pubkey(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    fn config() -> GovernanceConfig {
        GovernanceConfig {
            authority: pubkey(9),
            pending_authority: ZERO_PUBKEY,
            source_chain: 1,
            source_broadcaster: [7; 32],
            bridge_signers: [pubkey(1), pubkey(2), pubkey(3)],
            bridge_set_version: 1,
            threshold: 2,
            paused: false,
            last_executed_nonce: 0,
            bump: 1,
            executor_bump: 2,
        }
    }

    fn envelope() -> GovernanceEnvelope {
        GovernanceEnvelope {
            version: ENVELOPE_VERSION,
            source_chain: 1,
            source_broadcaster: [7; 32],
            bridge_set_version: 1,
            nonce: 42,
            action_type: 1,
            target_program: pubkey(8),
            valid_after: 100,
            expires_at: 200,
            accounts: vec![GovernanceAccountMeta {
                pubkey: pubkey(6),
                is_writable: true,
                is_signer: false,
            }],
            payload: vec![1, 2, 3, 4],
        }
    }

    #[test]
    fn requires_two_distinct_bridge_confirmations() {
        let env = envelope();
        let hash = env.canonical_hash();
        let mut record = MessageRecord {
            message_hash: [0; 32],
            target_program: ZERO_PUBKEY,
            bridge_set_version: 0,
            nonce: 0,
            action_type: 0,
            valid_after: 0,
            expires_at: 0,
            confirmations: 0,
            ready: false,
            executed: false,
            cancelled: false,
            bump: 0,
            accounts: Vec::new(),
            payload: Vec::new(),
        };
        record.initialize_from(hash, &env, 4);

        assert_eq!(record.confirm(0, 2).unwrap(), 1);
        assert!(!record.ready);
        assert!(record.confirm(0, 2).is_err());
        assert_eq!(record.confirm(2, 2).unwrap(), 2);
        assert!(record.ready);
    }

    #[test]
    fn canonical_hash_commits_to_accounts_and_payload() {
        let base = envelope();
        let mut changed_payload = base.clone();
        changed_payload.payload.push(5);
        let mut changed_account = base.clone();
        changed_account.accounts[0].is_writable = false;
        let mut changed_bridge_set = base.clone();
        changed_bridge_set.bridge_set_version = 2;

        assert_ne!(base.canonical_hash(), changed_payload.canonical_hash());
        assert_ne!(base.canonical_hash(), changed_account.canonical_hash());
        assert_ne!(base.canonical_hash(), changed_bridge_set.canonical_hash());
        assert_eq!(base.canonical_hash(), base.clone().canonical_hash());
        assert_eq!(
            base.canonical_hash(),
            [
                0xc8, 0xc0, 0xbf, 0x0f, 0x7d, 0xd4, 0x12, 0x19, 0x2c, 0x28, 0xfc, 0x58, 0xda, 0xa8,
                0xff, 0x78, 0x35, 0x01, 0x92, 0x22, 0x92, 0x4b, 0x4c, 0x10, 0x60, 0x64, 0x71, 0xce,
                0xa2, 0xc8, 0x44, 0x8a,
            ]
        );
    }

    #[test]
    fn rejects_wrong_source_bridge_version_and_unsafe_bridge_configuration() {
        let mut cfg = config();
        let mut bad_source = envelope();
        bad_source.source_chain = 56;
        assert!(bad_source.validate(&cfg).is_err());

        cfg.bridge_set_version = 2;
        assert!(envelope().validate(&cfg).is_err());

        let duplicates = [pubkey(1), pubkey(1), pubkey(3)];
        assert!(GovernanceConfig::validate_bridges(&duplicates, 2).is_err());
        assert!(GovernanceConfig::validate_bridges(&config().bridge_signers, 1).is_err());
    }

    #[test]
    fn allows_exact_aliases_but_rejects_privilege_conflicting_aliases() {
        let cfg = config();
        let mut exact_alias = envelope();
        exact_alias.accounts.push(exact_alias.accounts[0]);
        assert!(exact_alias.validate(&cfg).is_ok());

        let mut privilege_conflict = envelope();
        let mut conflicting = privilege_conflict.accounts[0];
        conflicting.is_writable = !conflicting.is_writable;
        privilege_conflict.accounts.push(conflicting);
        assert!(privilege_conflict.validate(&cfg).is_err());
    }
}
