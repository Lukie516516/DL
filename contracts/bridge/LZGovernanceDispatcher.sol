// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OAppBase, Origin} from "../lib/OAppBase.sol";

/// @title LZGovernanceDispatcher
/// @notice 部署在主网（ETH）。DealGovernance 提案通过后调用 dispatch()，
///         通过 LayerZero V2 把 calldata 发到目标链的 LZGovernanceExecutor。
///         只有 DealGovernance 合约可以调用 dispatch()。
contract LZGovernanceDispatcher is OAppBase {
    address public governance;

    event Dispatched(uint32 indexed dstEid, address indexed target, bytes data, bytes32 guid);
    event GovernanceUpdated(address indexed oldGov, address indexed newGov);

    error NotGovernance();
    error ZeroTarget();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    constructor(address endpoint, address delegate, address governance_)
        OAppBase(endpoint, delegate)
    {
        if (governance_ == address(0)) revert ZeroAddress();
        governance = governance_;
    }

    /// @notice 由 DealGovernance.execute() 调用，向目标链发送跨链执行消息。
    function dispatch(
        uint32 dstEid,
        address target,
        bytes calldata data,
        uint128 gas
    ) external payable onlyGovernance {
        // FIX MEDIUM-4: reject zero target — silent success on dest chain wastes fees
        if (target == address(0)) revert ZeroTarget();
        bytes memory payload = abi.encode(target, data);
        bytes32 guid = _lzSend(dstEid, payload, gas);
        emit Dispatched(dstEid, target, data, guid);
    }

    /// @notice 预估跨链费用。
    function quoteFee(
        uint32 dstEid,
        address target,
        bytes calldata data,
        uint128 gas
    ) external view returns (uint256 nativeFee) {
        return _quoteFee(dstEid, abi.encode(target, data), gas);
    }

    /// @notice 更新 governance 地址（只有 owner 可调）。
    function setGovernance(address gov) external onlyOwner {
        // FIX HIGH-3: zero address would permanently lock dispatch()
        if (gov == address(0)) revert ZeroAddress();
        emit GovernanceUpdated(governance, gov);
        governance = gov;
    }

    // FIX LOW-2: Dispatcher 只发不收，明确 revert 而不是静默 no-op
    function _lzReceive(
        Origin calldata,
        bytes32,
        bytes calldata,
        address,
        bytes calldata
    ) internal pure override {
        revert("LZGovernanceDispatcher: send-only");
    }
}
