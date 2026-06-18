// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OAppBase, Origin} from "../lib/OAppBase.sol";

/// @title LZGovernanceExecutor
/// @notice 部署在目标链（BSC / Agiking 等）。
///         接收来自主网 LZGovernanceDispatcher 的消息，解码后调用目标合约。
///
/// 安全模型：
///   1. OAppBase.lzReceive() 验证消息只能来自已注册 peer（Dispatcher）
///   2. 目标地址必须在 allowedTargets 白名单内（防止自身被调用或任意合约被攻击）
///   3. 调用失败时发出事件但不 revert，避免消息永久卡在 LZ 重试队列
contract LZGovernanceExecutor is OAppBase {

    // FIX CRITICAL-1: 目标白名单，只有白名单内的合约可以被跨链调用
    mapping(address => bool) public allowedTargets;

    event CrossChainExecuted(
        uint32 indexed srcEid,
        address indexed target,
        bytes data,
        bool success
    );
    event CrossChainFailed(
        uint32 indexed srcEid,
        address indexed target,
        bytes data,
        bytes reason
    );
    event TargetAllowed(address indexed target, bool allowed);

    error TargetNotAllowed(address target);

    constructor(address endpoint, address delegate)
        OAppBase(endpoint, delegate)
    {}

    /// @notice owner 设置允许被跨链调用的目标合约（如 DealFactory、DCdomainrank）。
    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        allowedTargets[target] = allowed;
        emit TargetAllowed(target, allowed);
    }

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

        // FIX CRITICAL-1a: 禁止对自身调用（防止 setPeer / transferOwnership 被滥用）
        // FIX CRITICAL-1b: 只允许白名单目标
        if (target == address(this) || !allowedTargets[target]) {
            revert TargetNotAllowed(target);
        }

        (bool ok, bytes memory ret) = target.call(data);

        // FIX LOW-4: 调用失败时发出事件而不是 revert
        // revert 会让消息永久停在 LZ 重试队列，任何人都能触发重试，带来安全隐患
        // 失败时 DAO 提交新提案即可；旧消息被安全消耗
        if (ok) {
            emit CrossChainExecuted(origin.srcEid, target, data, true);
        } else {
            emit CrossChainFailed(origin.srcEid, target, data, ret);
        }
    }
}
