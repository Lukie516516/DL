use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"governance-config";
pub const EXECUTOR_AUTHORITY_SEED: &[u8] = b"executor-authority";
pub const MESSAGE_SEED: &[u8] = b"governance-message";
pub const TARGET_SEED: &[u8] = b"allowed-target";

pub const ENVELOPE_VERSION: u8 = 1;
pub const ENVELOPE_DOMAIN: &[u8] = b"DEAL_GOVERNANCE_V1";
pub const BRIDGE_COUNT: usize = 3;
pub const MAX_ACCOUNT_METAS: usize = 16;
pub const MAX_PAYLOAD_LEN: usize = 1_024;

pub const ZERO_PUBKEY: Pubkey = Pubkey::new_from_array([0; 32]);
