// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract TestRevertingOrderBook {
    function settlePair(address, uint256, uint256) external pure {
        revert("SETTLE_REVERT");
    }
}
