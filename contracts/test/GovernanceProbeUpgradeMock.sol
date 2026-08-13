// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {GovernanceProbe} from "../GovernanceProbe.sol";

contract GovernanceProbeUpgradeMock is GovernanceProbe {
    function version() external pure override returns (uint256) {
        return 2;
    }

    function upgradedFeatureAvailable() external pure returns (bool) {
        return true;
    }
}
