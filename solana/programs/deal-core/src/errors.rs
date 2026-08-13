use anchor_lang::prelude::*;

#[error_code]
pub enum DealCoreError {
    #[msg("caller is not the registry authority")]
    Unauthorized,
    #[msg("pending authority does not match caller")]
    InvalidPendingAuthority,
    #[msg("controller or authority cannot be the zero public key")]
    ZeroAuthority,
    #[msg("deal creation is paused")]
    Paused,
    #[msg("deal id does not match the registry sequence")]
    InvalidDealId,
    #[msg("deal id sequence overflowed")]
    DealIdOverflow,
    #[msg("title exceeds 96 UTF-8 bytes")]
    TitleTooLong,
    #[msg("description exceeds 1500 UTF-8 bytes")]
    DescriptionTooLong,
    #[msg("domain name must be 1 to 64 UTF-8 bytes for a domain deal")]
    InvalidDomainName,
    #[msg("ordinary deals cannot carry a domain name")]
    UnexpectedDomainName,
    #[msg("timeout must be between 1 second and 100 years")]
    InvalidTimeout,
    #[msg("registry minimum timeout must be between 30 minutes and 100 years")]
    InvalidMinTimeout,
    #[msg("replacement timeout must be between 60 seconds and 24 hours")]
    InvalidReplaceTimeout,
    #[msg("operation is only available for the OpenTokenToken fast implementation")]
    OpenTokenModeRequired,
    #[msg("template asset and token shape is invalid")]
    InvalidTemplateShape,
    #[msg("exact-address mode requires a non-zero participant")]
    InvalidExpectedParticipant,
    #[msg("deal is not in the required status")]
    InvalidStatus,
    #[msg("caller is not party A")]
    NotPartyA,
    #[msg("caller is not an active deal party")]
    NotParty,
    #[msg("party B is already present")]
    ParticipantAlreadyJoined,
    #[msg("party B is not present")]
    ParticipantMissing,
    #[msg("creator cannot join as party B")]
    CreatorCannotJoin,
    #[msg("caller is not the expected participant")]
    WrongParticipant,
    #[msg("gated join must use the identity-controller instruction")]
    GatedJoinRequired,
    #[msg("identity controller did not authorize this join")]
    InvalidIdentityController,
    #[msg("the most recently removed participant cannot immediately rejoin")]
    RemovedParticipantBlocked,
    #[msg("replacement is only available for open deals")]
    ReplacementNotOpen,
    #[msg("replacement timeout has not elapsed")]
    ReplacementTooEarly,
    #[msg("locked replacement requires A=Accept and B=Unset")]
    ReplacementNotEligible,
    #[msg("caller is not the configured asset controller")]
    InvalidAssetController,
    #[msg("caller is not the configured domain-entry controller")]
    InvalidDomainEntryController,
    #[msg("domain deals must use the authorized domain-entry instruction")]
    DomainEntryRequired,
    #[msg("deposit side or deposit kind is not required by this deal")]
    DepositNotRequired,
    #[msg("the requested deposit is already recorded")]
    AlreadyDeposited,
    #[msg("there is no recorded deposit to withdraw")]
    NothingDeposited,
    #[msg("vote must be Accept or Reject")]
    InvalidVote,
    #[msg("current votes do not have a settlement action")]
    NothingToSettle,
    #[msg("force completion conditions are not satisfied")]
    ForceCompleteNotEligible,
    #[msg("force completion timeout has not elapsed")]
    ForceCompleteTooEarly,
    #[msg("amount update is not allowed after party A deposits")]
    AmountsLocked,
}
