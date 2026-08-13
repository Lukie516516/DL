use anchor_lang::prelude::*;

#[error_code(offset = 6100)]
pub enum AssetControllerError {
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("pending authority does not match signer")]
    InvalidPendingAuthority,
    #[msg("zero authority is not allowed")]
    ZeroAuthority,
    #[msg("asset controller is paused")]
    Paused,
    #[msg("fee numerator or denominator is invalid")]
    InvalidFee,
    #[msg("asset specification does not match the core amount")]
    InvalidAssetSpec,
    #[msg("NFT specification is invalid")]
    InvalidNftSpec,
    #[msg("deal creator does not match signer")]
    InvalidCreator,
    #[msg("asset terms are already resolved")]
    AlreadyResolved,
    #[msg("side has already deposited funds")]
    FundsAlreadyEscrowed,
    #[msg("side has already deposited its asset NFT")]
    NftAlreadyEscrowed,
    #[msg("side has no escrowed assets")]
    NothingEscrowed,
    #[msg("participant account does not match the current deal participant")]
    InvalidParticipant,
    #[msg("token account or mint does not match the asset specification")]
    InvalidTokenAccount,
    #[msg("token program is not supported by the supplied accounts")]
    InvalidTokenProgram,
    #[msg("token owner does not match the expected wallet or controller")]
    InvalidTokenOwner,
    #[msg("NFT mint must have zero decimals and supply one")]
    InvalidNftMint,
    #[msg("native escrow balance would fall below rent exemption")]
    NativeEscrowInsolvent,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("vote state does not have a resolvable outcome")]
    NothingToResolve,
    #[msg("asset account order does not match this operation")]
    InvalidAssetAccounts,
    #[msg("identity controller configuration does not trust this asset controller")]
    InvalidIdentityController,
    #[msg("identity token account does not belong to the selected deal party")]
    InvalidIdentityOwner,
    #[msg("identity can only be unlocked after the deal reaches a terminal state")]
    DealNotTerminal,
    #[msg("the selected deal party already has a different tracked identity")]
    IdentityAlreadyTracked,
    #[msg("the identity does not match the identity tracked for this deal party")]
    IdentityNotTracked,
    #[msg("DC-to-DC fees have already been routed")]
    DcFeesAlreadyRouted,
    #[msg("the deal does not have pending DC-to-DC fees")]
    DcFeesNotPending,
    #[msg("identity accounts are incomplete or unexpected")]
    IncompleteIdentityAccounts,
    #[msg("identity binding does not match the terminal deal")]
    InvalidIdentityBinding,
    #[msg("credit account does not match the canonical identity score")]
    InvalidCredit,
    #[msg("C identity accounts are missing, unexpected, or invalid")]
    InvalidCRecipient,
}
