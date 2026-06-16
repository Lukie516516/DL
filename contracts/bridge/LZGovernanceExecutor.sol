// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OAppBase, Origin} from "../lib/OAppBase.sol";

/// @title LZGovernanceExecutor
/// @notice 部署在 BSC Testnet（子链）。
///         接收来自 Sepolia LZGovernanceDispatcher 的消息，
///         解码后调用目标合约执行对应操作。
///
/// 安全性：只接受来自已注册 peer（setPeer 设置的 Dispatcher 地址）的消息，
///         OAppBase.lzReceive() 在 _lzReceive 前已验证 origin。
contract LZGovernanceExecutor is OAppBase {

    event CrossChainExecuted(
        uint32 indexed srcEid,
        address indexed target,
        bytes data,
        bool success
    );

    error CallFailed(address target, bytes returndata);

    constructor(address endpoint, address delegate)
        OAppBase(endpoint, delegate)
    {}

    /// @dev OAppBase 验证消息来源后调用此函数。
    ///      payload = abi.encode(address target, bytes data)
    function _lzReceive(
        Origin calldata origin,
        bytes32,
        bytes calldata payload,
        address,
        bytes calldata
    ) internal override {
        (address target, bytes memory data) = abi.decode(payload, (address, bytes));
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) revert CallFailed(target, ret);
        emit CrossChainExecuted(origin.srcEid, target, data, true);
    }
}
