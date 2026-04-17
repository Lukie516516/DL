// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TestFeeOnTransferToken is ERC20 {
    uint256 public immutable feeBps;
    address public immutable feeCollector;

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 feeBps_,
        address feeCollector_
    ) ERC20(name_, symbol_) {
        require(feeBps_ < 10_000, "BAD_FEE");
        require(feeCollector_ != address(0), "BAD_COLLECTOR");
        feeBps = feeBps_;
        feeCollector = feeCollector_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }

        uint256 fee = (value * feeBps) / 10_000;
        uint256 net = value - fee;

        if (fee > 0) super._update(from, feeCollector, fee);
        super._update(from, to, net);
    }
}
