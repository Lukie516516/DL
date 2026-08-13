// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title CrossChainExecutor  [PLACEHOLDER — bridgeAdapter 未设置，桥未接线]
/// @notice 已部署在 Agiking 主网作为占位合约，bridgeAdapter = address(0)，
///         目前只有 owner 可以手动调用（紧急模式）。
///         生产跨链治理请使用 DualBridgeExecutor（BSC 主网，三桥 2-of-3）。
contract CrossChainExecutor is Ownable {

    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice ETH chain ID (LayerZero ID). Set at deployment.
    uint32 public immutable ethChainId;

    /// @notice The CrossChainDispatcher address on ETH — only source we trust.
    address public dispatcher;

    /// @notice The bridge adapter contract allowed to call onMessageReceived.
    ///         address(0) = only owner may call (safe default before bridge is wired).
    ///         Set to LayerZero endpoint / Wormhole relayer once bridge is live.
    address public bridgeAdapter;

    /// @notice Optional whitelist of callable contracts on this chain.
    ///         If empty, any target is allowed (less restrictive, simpler early on).
    mapping(address => bool) public allowedTarget;
    bool public whitelistEnabled;

    /// @notice Replay protection: tracks message IDs already executed.
    mapping(bytes32 => bool) public executedMessages;

    // ─── Events ───────────────────────────────────────────────────────────────

    event DispatcherUpdated(address indexed newDispatcher);
    event BridgeAdapterUpdated(address indexed newAdapter);
    event CallExecuted(address indexed target, bool success);
    event CallFailed(address indexed target, bytes data, bytes reason);
    event TargetAllowed(address indexed target, bool allowed);
    event WhitelistToggled(bool enabled);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error NotDispatcher();
    error WrongSourceChain();
    error TargetNotAllowed(address target);
    error MessageAlreadyExecuted(bytes32 msgId);

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(uint32 ethChainId_, address dispatcher_) Ownable(msg.sender) {
        ethChainId  = ethChainId_;
        dispatcher  = dispatcher_;
    }

    // ─── Admin (emergency multisig only) ──────────────────────────────────────

    function setDispatcher(address dispatcher_) external onlyOwner {
        dispatcher = dispatcher_;
        emit DispatcherUpdated(dispatcher_);
    }

    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        allowedTarget[target] = allowed;
        emit TargetAllowed(target, allowed);
    }

    function setWhitelistEnabled(bool enabled) external onlyOwner {
        whitelistEnabled = enabled;
        emit WhitelistToggled(enabled);
    }

    /// @notice Register the bridge adapter contract (e.g. LayerZero endpoint wrapper).
    ///         Call this once the real bridge is deployed and ready.
    ///         Set to address(0) to fall back to owner-only mode (emergency).
    function setBridgeAdapter(address adapter) external onlyOwner {
        bridgeAdapter = adapter;
        emit BridgeAdapterUpdated(adapter);
    }

    // ─── Message reception (called by bridge adapter) ─────────────────────────

    /// @notice Entry point called by the bridge integration layer after verifying
    ///         the message authenticity.
    ///
    ///         For LayerZero: implement _lzReceive and call this.
    ///         For Wormhole: implement receiveMessage and call this.
    ///
    /// @param srcChainId  Source chain's LayerZero chain ID
    /// @param srcAddress  Address that sent the message on the source chain
    /// @param payload     abi.encode(targets, calldatas, values)
    function onMessageReceived(
        uint32  srcChainId,
        address srcAddress,
        bytes   calldata payload
    ) external {
        // Only the bridge adapter (this contract itself in LZ case, or an adapter) may call this.
        // If you wire LayerZero directly, replace with the LZ endpoint check.
        _checkCaller();

        if (srcChainId != ethChainId)   revert WrongSourceChain();
        if (srcAddress  != dispatcher)  revert NotDispatcher();

        bytes32 msgId = keccak256(abi.encode(srcChainId, srcAddress, payload));
        if (executedMessages[msgId]) revert MessageAlreadyExecuted(msgId);
        executedMessages[msgId] = true;

        _execute(payload);
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _execute(bytes calldata payload) internal {
        (
            address[] memory targets,
            bytes[]   memory calldatas,
            uint256[] memory values
        ) = abi.decode(payload, (address[], bytes[], uint256[]));

        for (uint256 i = 0; i < targets.length; ++i) {
            address t = targets[i];
            if (whitelistEnabled && !allowedTarget[t]) {
                emit CallFailed(t, calldatas[i], abi.encodePacked("target not allowed"));
                continue;
            }

            (bool ok, bytes memory ret) = t.call{value: values[i]}(calldatas[i]);
            if (ok) {
                emit CallExecuted(t, true);
            } else {
                // 不 revert：revert 会让 LZ 消息卡在 retry 队列
                // 失败后 DAO 用新 nonce 重新发起提案即可
                emit CallFailed(t, calldatas[i], ret);
            }
        }
    }

    /// @dev Called at the top of onMessageReceived to authenticate the caller.
    ///      - If bridgeAdapter == address(0): only owner may call (safe pre-bridge default).
    ///      - If bridgeAdapter is set: only that address may call (LayerZero endpoint, etc.).
    ///      Override this function when integrating an inline bridge (e.g. OApp _lzReceive).
    function _checkCaller() internal virtual {
        if (bridgeAdapter == address(0)) {
            // Bridge not yet wired — allow emergency owner calls only.
            require(msg.sender == owner(), "CrossChainExecutor: bridge not configured");
        } else {
            require(msg.sender == bridgeAdapter, "CrossChainExecutor: unauthorized caller");
        }
    }

    receive() external payable {}
}
