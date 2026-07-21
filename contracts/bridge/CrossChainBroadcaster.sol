// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OAppBase, Origin} from "../lib/OAppBase.sol";

interface IWormholeRelayerSend {
    function sendPayloadToEvm(
        uint16  targetChain,
        address targetAddress,
        bytes   memory payload,
        uint256 receiverValue,
        uint256 gasLimit
    ) external payable returns (uint64 sequence);

    function quoteEVMDeliveryPrice(
        uint16  targetChain,
        uint256 receiverValue,
        uint256 gasLimit
    ) external view returns (uint256 nativePriceQuote, uint256 targetChainRefundPerGasUnused);
}

interface IAxelarGateway {
    function callContract(
        string calldata destinationChain,
        string calldata contractAddress,
        bytes  calldata payload
    ) external;
}

interface IAxelarGasService {
    function payNativeGasForContractCall(
        address sender,
        string  calldata destinationChain,
        string  calldata destinationAddress,
        bytes   calldata payload,
        address refundAddress
    ) external payable;
}

/// @title CrossChainBroadcaster  [PRODUCTION — ETH 主网部署]
/// @notice 部署在 ETH 主网。DealGovernance 提案通过后调用 broadcast()，
///         同时向所有已注册副链广播治理消息（扇出）。
///
/// 每条副链独立配置使用哪些桥：
///   - BSC / Polygon：lzDstEid + whDstChain + axDstChain（三桥，Executor threshold=2）
///   - Tron：当前仅 whDstChain（LZ/Axelar 不支持 Tron，Executor threshold=1）
///   - 未来新链：按实际桥支持情况配置
///
/// 来源验证由对端 DualBridgeExecutor 负责；本合约只发不收。
contract CrossChainBroadcaster is OAppBase {

    // ─── 每条目标链的桥配置 ───────────────────────────────────────────────────

    struct ChainConfig {
        // LayerZero：lzDstEid = 0 → 跳过 LZ（如 Tron）
        uint32  lzDstEid;
        // Wormhole：whDstChain = 0 → 跳过 WH
        uint16  whDstChain;
        /// @dev WH 目标地址：该链的 DualBridgeExecutor（EVM 地址）
        address whDstAddress;
        // Axelar：axDstChain = "" → 跳过 AX
        /// @dev Axelar 链名，如 "binance"、"polygon"
        ///      Tron 不被 Axelar 支持，Tron 链请留空字符串 ""
        string  axDstChain;
        /// @dev DualBridgeExecutor 地址，必须全小写十六进制，Axelar 大小写敏感
        string  axDstAddress;
        /// @dev 预付 Axelar gas 的最小金额（wei），Axelar 无链上报价，手动配置
        uint256 axMinFee;
        /// @dev false = 暂停该链广播但保留配置
        bool    active;
    }

    // ─── 状态 ─────────────────────────────────────────────────────────────────

    IWormholeRelayerSend public immutable wormholeRelayer;
    IAxelarGateway       public immutable axelarGateway;
    IAxelarGasService    public immutable axelarGasService;

    uint256 public whGasLimit = 300_000;
    address public governance;
    uint256 public broadcastNonce;

    /// @dev 任意 uint32 key → 链配置（推荐用 LZ EID 作为 key，无 LZ 的链用自定义 key）
    mapping(uint32 => ChainConfig) public chains;
    uint32[] public chainIds;
    mapping(uint32 => uint256) private _chainIndex; // key → index+1（0 = 未注册）

    // ─── 事件 ─────────────────────────────────────────────────────────────────

    event Broadcast(uint256 indexed nonce, uint32[] targetChainIds, address[] targets, bytes data);
    event BroadcastToChain(
        uint256 indexed nonce,
        uint32  indexed chainId,
        address indexed target,
        bytes32 lzGuid,
        uint64  whSeq
    );
    event ChainAdded(uint32 indexed chainId);
    event ChainUpdated(uint32 indexed chainId);
    event ChainRemoved(uint32 indexed chainId);
    event GovernanceUpdated(address indexed old_, address indexed new_);
    event WhGasLimitUpdated(uint256 oldLimit, uint256 newLimit);
    event ExcessRefundFailed(address indexed to, uint256 amount);

    // ─── 错误 ─────────────────────────────────────────────────────────────────

    error NotGovernance();
    error InsufficientFee(uint256 required, uint256 provided);
    error ZeroTarget();
    error ChainAlreadyExists(uint32 chainId);
    error ChainNotFound(uint32 chainId);
    error NoActiveChains();
    error BadTargetArrays();
    error MissingTarget(uint32 chainId);

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    // ─── 构造 ─────────────────────────────────────────────────────────────────

    constructor(
        address endpoint_,
        address delegate_,
        address governance_,
        address wormholeRelayer_,
        address axelarGateway_,
        address axelarGasService_
    ) OAppBase(endpoint_, delegate_) {
        if (governance_       == address(0)) revert ZeroAddress();
        if (wormholeRelayer_  == address(0)) revert ZeroAddress();
        if (axelarGateway_    == address(0)) revert ZeroAddress();
        if (axelarGasService_ == address(0)) revert ZeroAddress();
        governance       = governance_;
        wormholeRelayer  = IWormholeRelayerSend(wormholeRelayer_);
        axelarGateway    = IAxelarGateway(axelarGateway_);
        axelarGasService = IAxelarGasService(axelarGasService_);
    }

    // ─── 链管理（onlyOwner）──────────────────────────────────────────────────

    /// @notice 注册一条新的目标链。
    ///         若该链启用 LZ，还需另外调用 setPeer(lzDstEid, executorBytes32) 注册 LZ 对端。
    function addChain(uint32 chainId, ChainConfig calldata cfg) external onlyOwner {
        if (_chainIndex[chainId] != 0) revert ChainAlreadyExists(chainId);
        chains[chainId] = cfg;
        chainIds.push(chainId);
        _chainIndex[chainId] = chainIds.length;
        emit ChainAdded(chainId);
    }

    /// @notice 更新已注册链的全部配置。
    function setChain(uint32 chainId, ChainConfig calldata cfg) external onlyOwner {
        if (_chainIndex[chainId] == 0) revert ChainNotFound(chainId);
        chains[chainId] = cfg;
        emit ChainUpdated(chainId);
    }

    /// @notice 暂停或恢复对某链的广播（保留配置）。
    function setChainActive(uint32 chainId, bool active) external onlyOwner {
        if (_chainIndex[chainId] == 0) revert ChainNotFound(chainId);
        chains[chainId].active = active;
        emit ChainUpdated(chainId);
    }

    /// @notice 删除已注册链（swap-and-pop，O(1)）。
    function removeChain(uint32 chainId) external onlyOwner {
        uint256 idx = _chainIndex[chainId];
        if (idx == 0) revert ChainNotFound(chainId);
        uint256 last = chainIds.length - 1;
        uint32 lastId = chainIds[last];
        chainIds[idx - 1] = lastId;
        _chainIndex[lastId] = idx;
        chainIds.pop();
        delete _chainIndex[chainId];
        delete chains[chainId];
        emit ChainRemoved(chainId);
    }

    function getChainIds() external view returns (uint32[] memory) {
        return chainIds;
    }

    // ─── 费用预估 ─────────────────────────────────────────────────────────────

    /// @notice 预估一次 broadcast 发往所有活跃链的总费用。
    /// @dev targetChainIds/targets 用来为每条目标链指定不同的被调用合约地址。
    function quoteFees(
        uint32[] calldata targetChainIds,
        address[] calldata targets,
        bytes calldata data,
        uint128 lzGas
    )
        external view returns (uint256 total)
    {
        _checkTargetArrays(targetChainIds, targets);
        uint256 nonce = broadcastNonce + 1;
        uint256 n = chainIds.length;
        for (uint256 i; i < n; ++i) {
            uint32 cid = chainIds[i];
            ChainConfig storage cfg = chains[cid];
            if (!cfg.active) continue;
            address target = _targetForChain(cid, targetChainIds, targets);
            if (target == address(0)) revert MissingTarget(cid);
            bytes memory payload = _buildPayload(nonce, target, data);
            total += _quoteChainFee(cfg, payload, lzGas);
        }
        if (total == 0) revert NoActiveChains();
    }

    // ─── 广播（扇出到所有活跃链）────────────────────────────────────────────

    /// @notice 由 DealGovernance.execute() 调用，向所有活跃副链广播治理消息。
    /// @param targetChainIds 目标链 key 列表，必须覆盖所有 active 链。
    /// @param targets        每条目标链的 DualBridgeExecutor 将调用的业务合约地址。
    /// @param data           calldata（如 DealFactory.setFeeRate(...)）。
    /// @param lzGas          LZ 目标链执行 gas（对不用 LZ 的链忽略）。
    function broadcast(
        uint32[] calldata targetChainIds,
        address[] calldata targets,
        bytes calldata data,
        uint128 lzGas
    )
        external payable onlyGovernance
    {
        _checkTargetArrays(targetChainIds, targets);

        uint256 nonce = ++broadcastNonce;

        // ── 预算并校验总费用 ──
        uint256 n = chainIds.length;
        uint256 totalFee;
        for (uint256 i; i < n; ++i) {
            uint32 cid = chainIds[i];
            ChainConfig storage cfg = chains[cid];
            if (!cfg.active) continue;
            address target = _targetForChain(cid, targetChainIds, targets);
            if (target == address(0)) revert MissingTarget(cid);
            bytes memory payload = _buildPayload(nonce, target, data);
            totalFee += _quoteChainFee(cfg, payload, lzGas);
        }
        // 无活跃链时拒绝（防止 nonce 被静默消耗）
        if (totalFee == 0) revert NoActiveChains();
        if (msg.value < totalFee) revert InsufficientFee(totalFee, msg.value);

        // ── CEI：先退还多余 ETH，再做外部调用 ──
        uint256 excess = msg.value - totalFee;
        if (excess > 0) {
            (bool ok,) = payable(msg.sender).call{value: excess}("");
            if (!ok) emit ExcessRefundFailed(msg.sender, excess);
        }

        emit Broadcast(nonce, targetChainIds, targets, data);

        // ── 逐链广播 ──
        for (uint256 i; i < n; ++i) {
            uint32 cid = chainIds[i];
            ChainConfig storage cfg = chains[cid];
            if (!cfg.active) continue;
            address target = _targetForChain(cid, targetChainIds, targets);
            if (target == address(0)) revert MissingTarget(cid);
            bytes memory payload = _buildPayload(nonce, target, data);
            _broadcastToChain(cid, cfg, target, payload, lzGas, nonce);
        }
    }

    // ─── 内部 ─────────────────────────────────────────────────────────────────

    function _quoteChainFee(
        ChainConfig storage cfg,
        bytes memory payload,
        uint128 lzGas
    ) internal view returns (uint256 fee) {
        if (cfg.lzDstEid != 0) {
            fee += _quoteFee(cfg.lzDstEid, payload, lzGas);
        }
        if (cfg.whDstChain != 0) {
            (uint256 whFee,) = wormholeRelayer.quoteEVMDeliveryPrice(cfg.whDstChain, 0, whGasLimit);
            fee += whFee;
        }
        if (bytes(cfg.axDstChain).length != 0) {
            fee += cfg.axMinFee;
        }
    }

    function _broadcastToChain(
        uint32 chainId,
        ChainConfig storage cfg,
        address target,
        bytes memory payload,
        uint128 lzGas,
        uint256 nonce
    ) internal {
        bytes32 lzGuid;
        uint64  whSeq;

        if (cfg.lzDstEid != 0) {
            lzGuid = _lzSend(cfg.lzDstEid, payload, lzGas);
        }
        if (cfg.whDstChain != 0) {
            (uint256 whFee,) = wormholeRelayer.quoteEVMDeliveryPrice(cfg.whDstChain, 0, whGasLimit);
            whSeq = wormholeRelayer.sendPayloadToEvm{value: whFee}(
                cfg.whDstChain, cfg.whDstAddress, payload, 0, whGasLimit
            );
        }
        if (bytes(cfg.axDstChain).length != 0) {
            axelarGasService.payNativeGasForContractCall{value: cfg.axMinFee}(
                address(this), cfg.axDstChain, cfg.axDstAddress, payload, msg.sender
            );
            axelarGateway.callContract(cfg.axDstChain, cfg.axDstAddress, payload);
        }

        emit BroadcastToChain(nonce, chainId, target, lzGuid, whSeq);
    }

    function _buildPayload(uint256 nonce, address target, bytes memory data)
        internal pure returns (bytes memory)
    {
        return abi.encode(nonce, target, data);
    }

    function _checkTargetArrays(uint32[] calldata targetChainIds, address[] calldata targets)
        internal pure
    {
        if (targetChainIds.length == 0 || targetChainIds.length != targets.length) revert BadTargetArrays();
        uint256 n = targets.length;
        for (uint256 i; i < n; ++i) {
            if (targets[i] == address(0)) revert ZeroTarget();
        }
    }

    function _targetForChain(
        uint32 chainId,
        uint32[] calldata targetChainIds,
        address[] calldata targets
    ) internal pure returns (address) {
        uint256 n = targetChainIds.length;
        for (uint256 i; i < n; ++i) {
            if (targetChainIds[i] == chainId) return targets[i];
        }
        return address(0);
    }

    // ─── 管理 ─────────────────────────────────────────────────────────────────

    function setGovernance(address gov) external onlyOwner {
        if (gov == address(0)) revert ZeroAddress();
        emit GovernanceUpdated(governance, gov);
        governance = gov;
    }

    function setWhGasLimit(uint256 gasLimit) external onlyOwner {
        emit WhGasLimitUpdated(whGasLimit, gasLimit);
        whGasLimit = gasLimit;
    }

    /// @dev Broadcaster 只发不收
    function _lzReceive(Origin calldata, bytes32, bytes calldata, address, bytes calldata)
        internal pure override
    {
        revert("broadcaster: receive not supported");
    }
}
