// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SatoshiVault} from "../SatoshiVault.sol";
import {DealDividendVault} from "../DealDividendVault.sol";

contract SatoshiVaultUpgradeMock is SatoshiVault {
    function version() external pure returns (uint256) {
        return 2;
    }
}

contract DealDividendVaultUpgradeMock is DealDividendVault {
    function version() external pure returns (uint256) {
        return 2;
    }
}
