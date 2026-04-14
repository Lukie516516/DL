// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract ExampleAdminTarget is Ownable {
    uint256 public feeBps; // 手续费，万分比

    event FeeChanged(uint256 oldFeeBps, uint256 newFeeBps);

    constructor(
        address initialOwner,
        uint256 initialFeeBps
    ) Ownable(initialOwner) {
        require(initialFeeBps <= 10_000, "fee too high");
        feeBps = initialFeeBps;
    }

    // 这个函数以后只能由 timelock（也就是 DAO 提案）来调用
    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= 10_000, "fee too high");
        uint256 old = feeBps;
        feeBps = newFeeBps;
        emit FeeChanged(old, newFeeBps);
    }
}
