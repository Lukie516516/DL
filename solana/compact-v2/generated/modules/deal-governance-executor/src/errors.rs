use anchor_lang::prelude::*;

#[error_code]
pub enum GovernanceError {
    #[msg("governance execution is paused")]
    Paused,
    #[msg("caller is not the governance authority")]
    Unauthorized,
    #[msg("pending authority does not match caller")]
    InvalidPendingAuthority,
    #[msg("bridge index is outside the configured range")]
    InvalidBridgeIndex,
    #[msg("bridge signer is not registered")]
    UnknownBridge,
    #[msg("the same bridge already confirmed this message")]
    BridgeAlreadyConfirmed,
    #[msg("threshold must be two or three")]
    InvalidThreshold,
    #[msg("bridge signers must be non-zero and unique")]
    InvalidBridgeConfiguration,
    #[msg("message envelope version is unsupported")]
    UnsupportedEnvelopeVersion,
    #[msg("source chain does not match the trusted governance chain")]
    WrongSourceChain,
    #[msg("source broadcaster does not match the trusted broadcaster")]
    WrongSourceBroadcaster,
    #[msg("message bridge set version does not match the active bridge set")]
    WrongBridgeSetVersion,
    #[msg("bridge set version overflowed")]
    BridgeSetVersionOverflow,
    #[msg("message hash does not match the canonical envelope hash")]
    InvalidMessageHash,
    #[msg("message payload exceeds the configured maximum")]
    PayloadTooLarge,
    #[msg("message contains too many Solana accounts")]
    TooManyAccounts,
    #[msg("message contains a duplicate Solana account")]
    DuplicateAccount,
    #[msg("message timing window is invalid")]
    InvalidTimeWindow,
    #[msg("message target cannot be the zero public key")]
    ZeroTarget,
    #[msg("stored message does not match the newly confirmed envelope")]
    MessageConflict,
    #[msg("message has not reached the bridge threshold")]
    MessageNotReady,
    #[msg("message has already executed")]
    MessageAlreadyExecuted,
    #[msg("message was cancelled")]
    MessageCancelled,
    #[msg("message is not active yet")]
    MessageNotActive,
    #[msg("message has expired")]
    MessageExpired,
    #[msg("message nonce is not newer than the last executed nonce")]
    StaleNonce,
    #[msg("target program is not allowed")]
    TargetNotAllowed,
    #[msg("target program does not match the message")]
    TargetMismatch,
    #[msg("remaining accounts do not match the signed envelope")]
    AccountListMismatch,
    #[msg("only the executor authority PDA may be a signer in a governance CPI")]
    UnsupportedSigner,
    #[msg("governance CPI must include the executor authority PDA as its only signer")]
    MissingExecutorSigner,
    #[msg("a required writable account was provided read-only")]
    AccountNotWritable,
    #[msg("the target program CPI failed")]
    TargetExecutionFailed,
}
