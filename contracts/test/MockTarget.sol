// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice 跨链治理端到端测试用合约，部署在 BSC testnet。
///         CrossChainBroadcaster → TripleBridgeExecutor → MockTarget.setParam()
contract MockTarget {
    uint256 public param;
    address public lastCaller;
    uint256 public callCount;

    event ParamSet(uint256 indexed oldValue, uint256 indexed newValue, address caller);

    function setParam(uint256 value) external {
        emit ParamSet(param, value, msg.sender);
        param      = value;
        lastCaller = msg.sender;
        callCount += 1;
    }
}
