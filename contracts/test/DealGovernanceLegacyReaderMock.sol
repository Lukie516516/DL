// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev Models the pre-createdAt `getProposal` ABI used by the already deployed Reader.
interface IDealGovernanceLegacyProposalView {
    struct Proposal {
        address proposer;
        uint8 kind;
        uint256 totalStaked;
        uint256 windowEndsAt;
        bool vetoed;
        bool canceled;
        bool executed;
        bool nftRegistered;
        bool satoshiSucceeded;
        bool activationReturnable;
        address vetoer;
        bytes32 actionsHash;
        string description;
    }

    function getProposal(uint256 proposalId) external view returns (Proposal memory);
}

contract DealGovernanceLegacyReaderMock {
    IDealGovernanceLegacyProposalView public immutable governance;

    constructor(address governance_) {
        governance = IDealGovernanceLegacyProposalView(governance_);
    }

    function getProposal(uint256 proposalId)
        external
        view
        returns (IDealGovernanceLegacyProposalView.Proposal memory)
    {
        return governance.getProposal(proposalId);
    }
}
