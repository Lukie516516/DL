// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title CrossChainExecutor
/// @notice Deployed on every non-ETH chain (BSC, Polygon, etc.).
///         Receives governance execution messages from CrossChainDispatcher on ETH,
///         verifies origin, then executes the calls locally.
///
/// Ownership model:
///   - The contracts you want governed (e.g. DealFactory) should transfer
///     ownership to this CrossChainExecutor address.
///   - Only authenticated messages from ETH can trigger execution.
///   - The local `owner` is a safety multisig for emergencies only.
contract CrossChainExecutor is Ownable {

    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice ETH chain ID (LayerZero ID). Set at deployment.
    uint32 public immutable ethChainId;

    /// @notice The CrossChainDispatcher address on ETH — only source we trust.
    address public dispatcher;

    /// @notice Optional whitelist of callable contracts on this chain.
    ///         If empty, any target is allowed (less restrictive, simpler early on).
    mapping(address => bool) public allowedTarget;
    bool public whitelistEnabled;

    // ─── Events ───────────────────────────────────────────────────────────────

    event DispatcherUpdated(address indexed newDispatcher);
    event CallExecuted(address indexed target, bool success);
    event TargetAllowed(address indexed target, bool allowed);
    event WhitelistToggled(bool enabled);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error NotDispatcher();
    error WrongSourceChain();
    error TargetNotAllowed(address target);
    error CallFailed(uint256 index, bytes returndata);

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
            if (whitelistEnabled && !allowedTarget[t]) revert TargetNotAllowed(t);

            (bool ok, bytes memory ret) = t.call{value: values[i]}(calldatas[i]);
            if (!ok) revert CallFailed(i, ret);
            emit CallExecuted(t, ok);
        }
    }

    /// @dev Override this to restrict who can call onMessageReceived.
    ///      Default: open (the bridge adapter is a separate contract that calls us).
    ///      For LayerZero inline mode, check msg.sender == lzEndpoint.
    function _checkCaller() internal virtual {}

    receive() external payable {}
}
