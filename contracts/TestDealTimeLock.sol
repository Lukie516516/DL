// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

contract DealTimelock is TimelockController {
    constructor(
        uint256 minDelay,           // 执行延迟，例如 2 days
        address[] memory proposers, // 初始拥有 PROPOSER_ROLE 的地址
        address[] memory executors, // 初始拥有 EXECUTOR_ROLE 的地址
        address admin               // 初始 TIMELOCK_ADMIN_ROLE
    )
        TimelockController(minDelay, proposers, executors, admin)
    {}
}
