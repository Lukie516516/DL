// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OAppBase, Origin} from "../lib/OAppBase.sol";
import {CCIPClient, ICCIPRouter} from "../lib/CCIP.sol";

interface IAxelarGatewayV2 {
    function callContract(
        string calldata destinationChain,
        string calldata contractAddress,
        bytes calldata payload
    ) external;
}

interface IAxelarGasServiceV2 {
    function payNativeGasForContractCall(
        address sender,
        string calldata destinationChain,
        string calldata destinationAddress,
        bytes calldata payload,
        address refundAddress
    ) external payable;
}

/// @title CrossChainBroadcasterV2
/// @notice ETH-side governance broadcaster using LayerZero + Chainlink CCIP + Axelar.
/// @dev Keeps the V1 broadcast selector and payload encoding so DAO nested-policy rules remain stable.
contract CrossChainBroadcasterV2 is OAppBase {
    uint256 public constant MAX_CHAINS = 32;

    struct ChainConfig {
        // 0 disables the LayerZero path.
        uint32 lzDstEid;
        // 0 disables the CCIP path.
        uint64 ccipDstChainSelector;
        address ccipReceiver;
        // Empty string disables the Axelar path.
        string axDstChain;
        string axDstAddress;
        uint256 axMinFee;
        bool active;
    }

    ICCIPRouter public immutable ccipRouter;
    IAxelarGatewayV2 public immutable axelarGateway;
    IAxelarGasServiceV2 public immutable axelarGasService;

    uint256 public ccipGasLimit = 500_000;
    bool public ccipAllowOutOfOrderExecution = true;
    address public governance;
    uint256 public broadcastNonce;
    bool private _broadcasting;

    mapping(uint32 => ChainConfig) public chains;
    uint32[] public chainIds;
    mapping(uint32 => uint256) private _chainIndex;

    event Broadcast(uint256 indexed nonce, uint32[] targetChainIds, address[] targets, bytes data);
    event BroadcastToChain(
        uint256 indexed nonce,
        uint32 indexed chainId,
        address indexed target,
        bytes32 lzGuid,
        bytes32 ccipMessageId
    );
    event ChainAdded(uint32 indexed chainId);
    event ChainUpdated(uint32 indexed chainId);
    event ChainRemoved(uint32 indexed chainId);
    event GovernanceUpdated(address indexed oldGovernance, address indexed newGovernance);
    event CcipExecutionConfigUpdated(
        uint256 oldGasLimit,
        uint256 newGasLimit,
        bool oldAllowOutOfOrderExecution,
        bool newAllowOutOfOrderExecution
    );
    event ExcessRefundFailed(address indexed to, uint256 amount);

    error NotGovernance();
    error InsufficientFee(uint256 required, uint256 provided);
    error ZeroTarget();
    error ChainAlreadyExists(uint32 chainId);
    error ChainNotFound(uint32 chainId);
    error NoActiveChains();
    error BadTargetArrays();
    error MissingTarget(uint32 chainId);
    error InvalidChainConfig(uint32 chainId);
    error UnsupportedCcipChain(uint64 chainSelector);
    error InvalidCcipGasLimit();
    error ReentrantBroadcast();
    error TooManyChains();
    error UnexpectedTargetCount(uint256 expected, uint256 provided);
    error InvalidLzGas();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    constructor(
        address endpoint_,
        address delegate_,
        address governance_,
        address ccipRouter_,
        address axelarGateway_,
        address axelarGasService_
    ) OAppBase(endpoint_, delegate_) {
        if (governance_ == address(0)) revert ZeroAddress();
        if (ccipRouter_ == address(0)) revert ZeroAddress();
        if (axelarGateway_ == address(0)) revert ZeroAddress();
        if (axelarGasService_ == address(0)) revert ZeroAddress();
        governance = governance_;
        ccipRouter = ICCIPRouter(ccipRouter_);
        axelarGateway = IAxelarGatewayV2(axelarGateway_);
        axelarGasService = IAxelarGasServiceV2(axelarGasService_);
    }

    function addChain(uint32 chainId, ChainConfig calldata cfg) external onlyOwner {
        if (_chainIndex[chainId] != 0) revert ChainAlreadyExists(chainId);
        if (chainIds.length >= MAX_CHAINS) revert TooManyChains();
        _validateChainConfig(chainId, cfg);
        chains[chainId] = cfg;
        chainIds.push(chainId);
        _chainIndex[chainId] = chainIds.length;
        emit ChainAdded(chainId);
    }

    function setChain(uint32 chainId, ChainConfig calldata cfg) external onlyOwner {
        if (_chainIndex[chainId] == 0) revert ChainNotFound(chainId);
        _validateChainConfig(chainId, cfg);
        chains[chainId] = cfg;
        emit ChainUpdated(chainId);
    }

    function setChainActive(uint32 chainId, bool active) external onlyOwner {
        if (_chainIndex[chainId] == 0) revert ChainNotFound(chainId);
        if (active) _validateChainConfig(chainId, chains[chainId]);
        chains[chainId].active = active;
        emit ChainUpdated(chainId);
    }

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

    function quoteFees(
        uint32[] calldata targetChainIds,
        address[] calldata targets,
        bytes calldata data,
        uint128 lzGas
    ) external view returns (uint256 total) {
        _checkTargetArrays(targetChainIds, targets);
        return _quoteBroadcast(targetChainIds, targets, data, lzGas, broadcastNonce + 1);
    }

    /// @notice Same ABI as V1. The DAO calls this after proposal execution is authorized.
    function broadcast(
        uint32[] calldata targetChainIds,
        address[] calldata targets,
        bytes calldata data,
        uint128 lzGas
    ) external payable onlyGovernance {
        if (_broadcasting) revert ReentrantBroadcast();
        _checkTargetArrays(targetChainIds, targets);

        uint256 startingBalance = address(this).balance - msg.value;
        uint256 nonce = broadcastNonce + 1;
        uint256 totalFee = _quoteBroadcast(targetChainIds, targets, data, lzGas, nonce);
        if (msg.value < totalFee) revert InsufficientFee(totalFee, msg.value);

        // Commit the nonce before any external bridge call.
        _broadcasting = true;
        broadcastNonce = nonce;
        emit Broadcast(nonce, targetChainIds, targets, data);

        uint256 n = chainIds.length;
        for (uint256 i; i < n; ++i) {
            uint32 cid = chainIds[i];
            ChainConfig storage cfg = chains[cid];
            if (!cfg.active) continue;
            address target = _targetForChain(cid, targetChainIds, targets);
            _broadcastToChain(
                cid,
                cfg,
                target,
                _buildPayload(nonce, target, data),
                lzGas,
                nonce
            );
        }

        // Refund only this call's unused fee budget. Never expose ETH that predates this call.
        uint256 excess = address(this).balance - startingBalance;
        if (excess != 0) {
            (bool ok,) = payable(msg.sender).call{value: excess}("");
            if (!ok) emit ExcessRefundFailed(msg.sender, excess);
        }
        _broadcasting = false;
    }

    function _quoteBroadcast(
        uint32[] calldata targetChainIds,
        address[] calldata targets,
        bytes calldata data,
        uint128 lzGas,
        uint256 nonce
    ) internal view returns (uint256 totalFee) {
        uint256 activeCount = 0;
        uint256 n = chainIds.length;
        for (uint256 i; i < n; ++i) {
            uint32 cid = chainIds[i];
            ChainConfig storage cfg = chains[cid];
            if (!cfg.active) continue;
            ++activeCount;
            if (cfg.lzDstEid != 0 && lzGas == 0) revert InvalidLzGas();
            address target = _targetForChain(cid, targetChainIds, targets);
            if (target == address(0)) revert MissingTarget(cid);
            totalFee += _quoteChainFee(cfg, _buildPayload(nonce, target, data), lzGas);
        }
        if (activeCount == 0) revert NoActiveChains();
        if (targetChainIds.length != activeCount) {
            revert UnexpectedTargetCount(activeCount, targetChainIds.length);
        }
    }

    function _quoteChainFee(
        ChainConfig storage cfg,
        bytes memory payload,
        uint128 lzGas
    ) internal view returns (uint256 fee) {
        if (cfg.lzDstEid != 0) fee += _quoteFee(cfg.lzDstEid, payload, lzGas);
        if (cfg.ccipDstChainSelector != 0) {
            fee += ccipRouter.getFee(
                cfg.ccipDstChainSelector,
                _buildCcipMessage(cfg.ccipReceiver, payload)
            );
        }
        if (bytes(cfg.axDstChain).length != 0) fee += cfg.axMinFee;
    }

    function _broadcastToChain(
        uint32 chainId,
        ChainConfig storage cfg,
        address target,
        bytes memory payload,
        uint128 lzGas,
        uint256 nonce
    ) internal {
        bytes32 lzGuid = bytes32(0);
        bytes32 ccipMessageId = bytes32(0);

        if (cfg.lzDstEid != 0) lzGuid = _lzSend(cfg.lzDstEid, payload, lzGas);

        if (cfg.ccipDstChainSelector != 0) {
            CCIPClient.EVM2AnyMessage memory ccipMessage =
                _buildCcipMessage(cfg.ccipReceiver, payload);
            uint256 ccipFee = ccipRouter.getFee(cfg.ccipDstChainSelector, ccipMessage);
            ccipMessageId = ccipRouter.ccipSend{value: ccipFee}(
                cfg.ccipDstChainSelector,
                ccipMessage
            );
        }

        if (bytes(cfg.axDstChain).length != 0) {
            axelarGasService.payNativeGasForContractCall{value: cfg.axMinFee}(
                address(this),
                cfg.axDstChain,
                cfg.axDstAddress,
                payload,
                msg.sender
            );
            axelarGateway.callContract(cfg.axDstChain, cfg.axDstAddress, payload);
        }

        emit BroadcastToChain(nonce, chainId, target, lzGuid, ccipMessageId);
    }

    function _buildCcipMessage(address receiver, bytes memory payload)
        internal view returns (CCIPClient.EVM2AnyMessage memory message)
    {
        message.receiver = abi.encode(receiver);
        message.data = payload;
        message.tokenAmounts = new CCIPClient.EVMTokenAmount[](0);
        message.feeToken = address(0);
        message.extraArgs = CCIPClient.argsToBytes(
            CCIPClient.GenericExtraArgsV2({
                gasLimit: ccipGasLimit,
                allowOutOfOrderExecution: ccipAllowOutOfOrderExecution
            })
        );
    }

    function _buildPayload(uint256 nonce, address target, bytes memory data)
        internal pure returns (bytes memory)
    {
        return abi.encode(nonce, target, data);
    }

    function _checkTargetArrays(uint32[] calldata targetChainIds, address[] calldata targets)
        internal pure
    {
        if (targetChainIds.length == 0 || targetChainIds.length != targets.length) {
            revert BadTargetArrays();
        }
        uint256 n = targets.length;
        for (uint256 i; i < n; ++i) {
            if (targets[i] == address(0)) revert ZeroTarget();
            for (uint256 j = i + 1; j < n; ++j) {
                if (targetChainIds[i] == targetChainIds[j]) revert BadTargetArrays();
            }
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

    function _validateChainConfig(uint32 chainId, ChainConfig memory cfg) internal view {
        bool hasLz = cfg.lzDstEid != 0;
        bool hasCcip = cfg.ccipDstChainSelector != 0;
        bool hasAxelar = bytes(cfg.axDstChain).length != 0;
        if (!hasLz && !hasCcip && !hasAxelar) revert InvalidChainConfig(chainId);
        if (hasCcip) {
            if (cfg.ccipReceiver == address(0)) revert InvalidChainConfig(chainId);
            if (!ccipRouter.isChainSupported(cfg.ccipDstChainSelector)) {
                revert UnsupportedCcipChain(cfg.ccipDstChainSelector);
            }
        } else if (cfg.ccipReceiver != address(0)) {
            revert InvalidChainConfig(chainId);
        }
        if (hasAxelar != (bytes(cfg.axDstAddress).length != 0)) {
            revert InvalidChainConfig(chainId);
        }
        if (hasAxelar && cfg.axMinFee == 0) revert InvalidChainConfig(chainId);
    }

    function setGovernance(address newGovernance) external onlyOwner {
        if (newGovernance == address(0)) revert ZeroAddress();
        emit GovernanceUpdated(governance, newGovernance);
        governance = newGovernance;
    }

    function setCcipExecutionConfig(uint256 gasLimit, bool allowOutOfOrderExecution)
        external onlyOwner
    {
        if (gasLimit == 0) revert InvalidCcipGasLimit();
        emit CcipExecutionConfigUpdated(
            ccipGasLimit,
            gasLimit,
            ccipAllowOutOfOrderExecution,
            allowOutOfOrderExecution
        );
        ccipGasLimit = gasLimit;
        ccipAllowOutOfOrderExecution = allowOutOfOrderExecution;
    }

    function _lzReceive(Origin calldata, bytes32, bytes calldata, address, bytes calldata)
        internal pure override
    {
        revert("broadcaster: receive not supported");
    }
}
