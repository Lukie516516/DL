// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {DealGovernance, IGovernancePolicyRegistryGov} from "../DealGovernance.sol";

/// @dev Test-only bootstrap hook. Production upgrades set the registry atomically via upgradeToAndCall.
contract DealGovernanceHarness is DealGovernance {
    function bootstrapPolicyRegistryForTest(address registry) external {
        policyRegistry = IGovernancePolicyRegistryGov(registry);
    }

    function clearProposalCreatedAtForTest(uint256 proposalId) external {
        _proposals[proposalId].createdAt = 0;
    }

    function backfillProposalCreatedAtForTest(uint256 firstProposalId, uint48[] calldata createdAts) external {
        this.backfillProposalCreatedAt(firstProposalId, createdAts);
    }
}
