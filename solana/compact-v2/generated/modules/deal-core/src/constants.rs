pub const REGISTRY_SEED: &[u8] = b"deal-registry";
pub const DEAL_SEED: &[u8] = b"deal";

pub const MAX_TITLE_BYTES: usize = 96;
pub const MAX_DESCRIPTION_BYTES: usize = 1_500;
pub const MAX_DOMAIN_BYTES: usize = 64;

pub const DEFAULT_MIN_TIMEOUT_SECONDS: u64 = 60 * 60;
pub const MIN_CONFIGURABLE_TIMEOUT_SECONDS: u64 = 30 * 60;
pub const MAX_TIMEOUT_SECONDS: u64 = 100 * 365 * 24 * 60 * 60;
pub const MIN_REPLACE_TIMEOUT_SECONDS: u64 = 60;
pub const MAX_REPLACE_TIMEOUT_SECONDS: u64 = 24 * 60 * 60;
