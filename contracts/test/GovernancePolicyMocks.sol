// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {DealGovernance} from "../DealGovernance.sol";

contract GovernancePolicyTargetMock {
    uint256 public parameterCalls;
    uint256 public treasuryCalls;
    uint256 public satoshiCalls;
    uint256 public majorCalls;
    uint256 public received;

    function parameterAction() external {
        ++parameterCalls;
    }

    function parameterPay() external payable {
        received += msg.value;
    }

    function treasuryAction() external {
        ++treasuryCalls;
    }

    function satoshiAction() external {
        ++satoshiCalls;
    }

    function majorAction() external {
        ++majorCalls;
    }
}

contract CrossChainBroadcasterMock {
    uint256 public broadcasts;

    function broadcast(uint32[] calldata, address[] calldata, bytes calldata, uint128) external payable {
        ++broadcasts;
    }
}

contract DealGovernanceUpgradeMock is DealGovernance {
    function version() external pure returns (uint256) {
        return 2;
    }
}
