// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./DealFactory.sol";

contract TestFactoryCaller {
    function createDealFor(
        address factory,
        address initiator,
        DealFactory.CreateParams calldata p
    ) external returns (address deal) {
        deal = DealFactory(factory).createDealFor(initiator, p);
    }

    function chargeMessageFeeFrom(address factory, address payer) external {
        DealFactory(factory).chargeMessageFeeFrom(payer);
    }
}
