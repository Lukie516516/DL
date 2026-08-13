// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Minimal interface for the underlying bridge (LayerZero, Wormhole, etc.)
///         Implementors override _sendMessage with the actual bridge call.
abstract contract CrossChainMessengerBase {
    /// @dev Send payload to dstChainId. msg.value covers destination gas fees.
    function _sendMessage(uint32 dstChainId, bytes memory payload) internal virtual;
}

/// @title CrossChainDispatcher  [PLACEHOLDER — _sendMessage 为空函数，桥未接线]
/// @notice 已部署在 Agiking 主网作为占位合约，_sendMessage 默认 no-op，
///         调用 dispatch() 不发送任何跨链消息。
///         生产跨链治理请使用 CrossChainBroadcaster + DualBridgeExecutor（ETH→BSC，三桥 2-of-3）。
contract CrossChainDispatcher is CrossChainMessengerBase, Ownable {

    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice The DealGovernance contract that is allowed to call dispatch().
    address public governance;

    /// @notice dstChainId → CrossChainExecutor address on that chain
    mapping(uint32 => address) public executor;

    // ─── Events ───────────────────────────────────────────────────────────────

    event ExecutorRegistered(uint32 indexed chainId, address indexed executorAddr);
    event GovernanceUpdated(address indexed newGovernance);
    event Dispatched(uint32 indexed chainId, uint256 callCount);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error NotGovernance();
    error NoExecutor(uint32 chainId);
    error BadArrayLength();

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address governance_) Ownable(msg.sender) {
        governance = governance_;
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @notice Register the CrossChainExecutor address on a remote chain.
    function setExecutor(uint32 chainId, address executorAddr) external onlyOwner {
        executor[chainId] = executorAddr;
        emit ExecutorRegistered(chainId, executorAddr);
    }

    /// @notice Rescue ETH accidentally left in this contract (e.g., excess bridge fee overpayment).
    function rescueETH(address payable to) external onlyOwner {
        require(to != address(0), "ZERO_TO");
        uint256 bal = address(this).balance;
        require(bal > 0, "NOTHING");
        (bool ok, ) = to.call{value: bal}("");
        require(ok, "ETH_SEND_FAIL");
    }

    /// @notice Point to a new DealGovernance contract.
    function setGovernance(address governance_) external onlyOwner {
        governance = governance_;
        emit GovernanceUpdated(governance_);
    }

    // ─── Core ─────────────────────────────────────────────────────────────────

    /// @notice Called by DealGovernance.execute() as one of the proposal actions.
    ///         Sends the same batch of calls to all specified destination chains.
    ///
    /// @param chainIds   LayerZero chain IDs to send to (e.g. [102] for BSC)
    /// @param targets    Contract addresses to call on each destination chain
    /// @param calldatas  Encoded function calls
    /// @param values     Native value to forward with each call (usually 0)
    function dispatch(
        uint32[]  calldata chainIds,
        address[] calldata targets,
        bytes[]   calldata calldatas,
        uint256[] calldata values
    ) external payable {
        if (msg.sender != governance) revert NotGovernance();
        if (targets.length == 0 || targets.length != calldatas.length || targets.length != values.length)
            revert BadArrayLength();

        bytes memory payload = abi.encode(targets, calldatas, values);

        for (uint256 i = 0; i < chainIds.length; ++i) {
            uint32 cid = chainIds[i];
            if (executor[cid] == address(0)) revert NoExecutor(cid);
            _sendMessage(cid, payload);
            emit Dispatched(cid, targets.length);
        }
    }

    // ─── Bridge hook (override with LayerZero / Wormhole / etc.) ─────────────

    /// @dev Default is a no-op placeholder. Replace with real bridge call.
    ///      Example LayerZero implementation:
    ///
    ///   function _sendMessage(uint32 dstChainId, bytes memory payload) internal override {
    ///       endpoint.send{value: msg.value}(
    ///           dstChainId,
    ///           abi.encodePacked(executor[dstChainId], address(this)),
    ///           payload,
    ///           payable(msg.sender),
    ///           address(0),
    ///           bytes("")
    ///       );
    ///   }
    function _sendMessage(uint32, bytes memory) internal virtual override {}

    receive() external payable {}
}
