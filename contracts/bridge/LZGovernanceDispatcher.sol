// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OAppBase, Origin, MessagingFee} from "../lib/OAppBase.sol";

/// @title LZGovernanceDispatcher
/// @notice 部署在 Sepolia（主网角色）。
///         DealGovernance 提案通过后调用 dispatch()，通过 LayerZero V2
///         把 calldata 发到目标链的 LZGovernanceExecutor。
///
/// 调用者权限：只有 DealGovernance 合约（governance）可以调 dispatch()。
contract LZGovernanceDispatcher is OAppBase {
    address public governance;

    event Dispatched(uint32 indexed dstEid, address indexed target, bytes data, bytes32 guid);
    event GovernanceUpdated(address indexed oldGov, address indexed newGov);

    error NotGovernance();
    error ZeroAddress();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    /// @param endpoint   LayerZero V2 endpoint（Sepolia: 0x6EDCE65403992e310A62460808c4b910D972f10f）
    /// @param delegate   合约 owner（用于 setPeer 等管理操作）
    /// @param governance_ DealGovernance proxy 地址
    constructor(address endpoint, address delegate, address governance_)
        OAppBase(endpoint, delegate)
    {
        if (governance_ == address(0)) revert ZeroAddress();
        governance = governance_;
    }

    /// @notice 由 DealGovernance.execute() 调用，向目标链发送跨链执行消息。
    /// @param dstEid  目标链 EID（BSC Testnet = 40102）
    /// @param target  目标链上要调用的合约地址
    /// @param data    要执行的 calldata
    /// @param gas     目标链执行所需 gas（建议 200_000）
    function dispatch(
        uint32 dstEid,
        address target,
        bytes calldata data,
        uint128 gas
    ) external payable onlyGovernance {
        bytes memory payload = abi.encode(target, data);
        bytes32 guid = _lzSend(dstEid, payload, gas);
        emit Dispatched(dstEid, target, data, guid);
    }

    /// @notice 预估跨链费用，前端调用后把 msg.value 传给 dispatch()。
    function quoteFee(
        uint32 dstEid,
        address target,
        bytes calldata data,
        uint128 gas
    ) external view returns (uint256 nativeFee) {
        bytes memory payload = abi.encode(target, data);
        return _quoteFee(dstEid, payload, gas);
    }

    function setGovernance(address gov) external onlyOwner {
        emit GovernanceUpdated(governance, gov);
        governance = gov;
    }

    // Dispatcher 只发不收
    function _lzReceive(
        Origin calldata,
        bytes32,
        bytes calldata,
        address,
        bytes calldata
    ) internal override {}
}
