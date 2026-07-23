// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OAppBase, Origin} from "../lib/OAppBase.sol";

interface IAxelarGatewayValidate {
    function validateContractCall(
        bytes32 commandId,
        string  calldata sourceChain,
        string  calldata sourceAddress,
        bytes32 payloadHash
    ) external returns (bool);
}

/// @title DualBridgeExecutor  [PRODUCTION — BSC 主网部署]
/// @notice 部署在 BSC 主网。配套 ETH 主网的 CrossChainBroadcaster 使用。
///         同时作为 LayerZero OApp、Wormhole IWormholeReceiver、Axelar IAxelarExecutable 接收端。
///         当同一条消息被 threshold（默认 2）条桥确认后，自动执行目标合约调用（2-of-3）。
///
/// 安全模型：
///   - LZ：OAppBase.peers[srcEid] 验证来源（只接受 CrossChainBroadcaster）
///   - WH：msg.sender == wormholeRelayer + srcChain + srcAddress
///   - AX：axelarGateway.validateContractCall() + srcChain + srcAddress 字符串匹配
///   - 执行目标必须在 allowedTargets 白名单
///   - payload 里的 nonce 防止重放（executed[msgHash] = true 后拒绝）
contract DualBridgeExecutor is OAppBase {

    // ─── 桥 ID ────────────────────────────────────────────────────────────────
    bytes32 public constant BRIDGE_LZ = keccak256("LayerZero");
    bytes32 public constant BRIDGE_WH = keccak256("Wormhole");
    bytes32 public constant BRIDGE_AX = keccak256("Axelar");
    uint256 public constant MAX_BRIDGES = 3;

    // ─── Wormhole ─────────────────────────────────────────────────────────────
    address public immutable wormholeRelayer;
    uint16  public whSrcChain;
    /// @dev WH 的 EVM 地址编码：bytes32(uint256(uint160(broadcasterAddr)))
    ///      即左补零的 32 字节，右 20 字节为地址。切勿使用右补零格式，否则 WH 消息全部被拒绝。
    bytes32 public whSrcAddress;

    // ─── Axelar ───────────────────────────────────────────────────────────────
    IAxelarGatewayValidate public immutable axelarGateway;
    /// @dev e.g. "Ethereum" for ETH mainnet. Axelar chain names are case-sensitive.
    string  public axSrcChain;
    /// @dev CrossChainBroadcaster 地址，必须与 Axelar 传入的 sourceAddress 完全一致。
    ///      主网实际为 checksum 格式；如果写成全小写，Axelar 路径会因字符串匹配失败而 revert。
    string  public axSrcAddress;

    // ─── 执行目标白名单 ───────────────────────────────────────────────────────
    mapping(address => bool) public allowedTargets;

    // ─── 聚合状态 ─────────────────────────────────────────────────────────────
    mapping(bytes32 => mapping(bytes32 => bool)) public confirmed;
    mapping(bytes32 => bytes) private _payloads;
    mapping(bytes32 => bool)  public executed;

    uint256 public threshold;

    // ─── 事件 ─────────────────────────────────────────────────────────────────
    event BridgeConfirmed(bytes32 indexed msgHash, bytes32 indexed bridgeId, uint256 confirmCount);
    event CrossChainExecuted(bytes32 indexed msgHash, address indexed target, bool success);
    event CrossChainFailed(bytes32 indexed msgHash, address indexed target, bytes reason);
    event TargetAllowed(address indexed target, bool allowed);
    event ThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event WhSrcUpdated(uint16 srcChain, bytes32 srcAddress);
    event AxSrcUpdated(string srcChain, string srcAddress);

    // ─── 错误 ─────────────────────────────────────────────────────────────────
    error NotWormholeRelayer();
    error WrongWHSrcChain(uint16 got, uint16 expected);
    error WrongWHSrcAddress(bytes32 got, bytes32 expected);
    error NotApprovedByAxelar();
    error WrongAxSrcChain();
    error WrongAxSrcAddress();
    error AlreadyExecuted(bytes32 msgHash);
    error TargetNotAllowed(address target);
    error InvalidThreshold();
    error InvalidWhSrc();

    // ─── 构造 ─────────────────────────────────────────────────────────────────
    constructor(
        address endpoint_,
        address delegate_,
        address wormholeRelayer_,
        uint16  whSrcChain_,
        bytes32 whSrcAddress_,
        address axelarGateway_,
        string  memory axSrcChain_,
        string  memory axSrcAddress_,
        uint256 threshold_
    ) OAppBase(endpoint_, delegate_) {
        if (wormholeRelayer_  == address(0)) revert ZeroAddress();
        if (axelarGateway_    == address(0)) revert ZeroAddress();
        if (threshold_ == 0 || threshold_ > MAX_BRIDGES) revert InvalidThreshold();
        // whSrcChain=0 或 whSrcAddress=bytes32(0) 会导致 WH 通路静默失败
        if (whSrcChain_ == 0 || whSrcAddress_ == bytes32(0)) revert InvalidWhSrc();
        wormholeRelayer = wormholeRelayer_;
        whSrcChain      = whSrcChain_;
        whSrcAddress    = whSrcAddress_;
        axelarGateway   = IAxelarGatewayValidate(axelarGateway_);
        axSrcChain      = axSrcChain_;
        axSrcAddress    = axSrcAddress_;
        threshold       = threshold_;
    }

    // ─── LayerZero 接收 ───────────────────────────────────────────────────────

    function _lzReceive(
        Origin calldata,
        bytes32,
        bytes calldata payload,
        address,
        bytes calldata
    ) internal override {
        _confirm(keccak256(payload), BRIDGE_LZ, payload);
    }

    // ─── Wormhole 接收 ────────────────────────────────────────────────────────

    function receiveWormholeMessages(
        bytes   memory payload,
        bytes[] memory,
        bytes32 sourceAddress,
        uint16  sourceChain,
        bytes32
    ) external payable {
        if (msg.sender != wormholeRelayer)     revert NotWormholeRelayer();
        if (sourceChain != whSrcChain)         revert WrongWHSrcChain(sourceChain, whSrcChain);
        if (sourceAddress != whSrcAddress)     revert WrongWHSrcAddress(sourceAddress, whSrcAddress);
        _confirm(keccak256(payload), BRIDGE_WH, payload);
    }

    // ─── Axelar 接收（IAxelarExecutable）────────────────────────────────────

    /// @notice Axelar gateway 在验证完 VAA 后调用此函数。
    function execute(
        bytes32        commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes  calldata payload
    ) external {
        // validateContractCall 同时验证 + 标记消费（防止重放由 Axelar 侧保证）
        if (!axelarGateway.validateContractCall(commandId, sourceChain, sourceAddress, keccak256(payload)))
            revert NotApprovedByAxelar();
        if (keccak256(bytes(sourceChain))   != keccak256(bytes(axSrcChain)))   revert WrongAxSrcChain();
        if (keccak256(bytes(sourceAddress)) != keccak256(bytes(axSrcAddress))) revert WrongAxSrcAddress();
        _confirm(keccak256(payload), BRIDGE_AX, payload);
    }

    // ─── 核心聚合逻辑 ─────────────────────────────────────────────────────────

    function _confirm(bytes32 msgHash, bytes32 bridgeId, bytes memory payload) internal {
        if (executed[msgHash]) revert AlreadyExecuted(msgHash);

        if (_payloads[msgHash].length == 0) {
            _payloads[msgHash] = payload;
        }

        confirmed[msgHash][bridgeId] = true;

        uint256 count;
        if (confirmed[msgHash][BRIDGE_LZ]) count++;
        if (confirmed[msgHash][BRIDGE_WH]) count++;
        if (confirmed[msgHash][BRIDGE_AX]) count++;

        emit BridgeConfirmed(msgHash, bridgeId, count);

        if (count >= threshold) {
            _execute(msgHash);
        }
    }

    function _execute(bytes32 msgHash) internal {
        executed[msgHash] = true;

        bytes memory raw = _payloads[msgHash];
        (, address target, bytes memory data) = abi.decode(raw, (uint256, address, bytes));

        if (target == address(0) || !allowedTargets[target]) {
            emit CrossChainFailed(msgHash, target, abi.encodePacked("target not allowed"));
            return;
        }

        (bool ok, bytes memory reason) = target.call(data);
        if (ok) {
            emit CrossChainExecuted(msgHash, target, true);
        } else {
            emit CrossChainFailed(msgHash, target, reason);
            emit CrossChainExecuted(msgHash, target, false);
        }
    }

    // ─── 查询 ─────────────────────────────────────────────────────────────────

    function confirmStatus(bytes32 msgHash) external view returns (
        bool lzConfirmed,
        bool whConfirmed,
        bool axConfirmed,
        uint256 count,
        bool isExecuted
    ) {
        lzConfirmed = confirmed[msgHash][BRIDGE_LZ];
        whConfirmed = confirmed[msgHash][BRIDGE_WH];
        axConfirmed = confirmed[msgHash][BRIDGE_AX];
        count = (lzConfirmed ? 1 : 0) + (whConfirmed ? 1 : 0) + (axConfirmed ? 1 : 0);
        isExecuted = executed[msgHash];
    }

    function calcMsgHash(uint256 nonce, address target, bytes calldata data) external pure returns (bytes32) {
        return keccak256(abi.encode(nonce, target, data));
    }

    // ─── 管理 ─────────────────────────────────────────────────────────────────

    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        allowedTargets[target] = allowed;
        emit TargetAllowed(target, allowed);
    }

    function setThreshold(uint256 t) external onlyOwner {
        if (t == 0 || t > MAX_BRIDGES) revert InvalidThreshold();
        emit ThresholdUpdated(threshold, t);
        threshold = t;
    }

    function setWhSrc(uint16 srcChain, bytes32 srcAddress) external onlyOwner {
        if (srcChain == 0 || srcAddress == bytes32(0)) revert InvalidWhSrc();
        whSrcChain   = srcChain;
        whSrcAddress = srcAddress;
        emit WhSrcUpdated(srcChain, srcAddress);
    }

    function setAxSrc(string calldata srcChain, string calldata srcAddress) external onlyOwner {
        axSrcChain   = srcChain;
        axSrcAddress = srcAddress;
        emit AxSrcUpdated(srcChain, srcAddress);
    }

}
