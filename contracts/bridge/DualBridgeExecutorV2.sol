// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {OAppBase, Origin} from "../lib/OAppBase.sol";
import {CCIPClient, IAny2EVMMessageReceiver} from "../lib/CCIP.sol";

interface IAxelarGatewayValidateV2 {
    function validateContractCall(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes32 payloadHash
    ) external returns (bool);
}

/// @title DualBridgeExecutorV2
/// @notice Destination executor for LayerZero + Chainlink CCIP + Axelar confirmations.
/// @dev The legacy name is retained for deployment continuity; threshold remains configurable (2-of-3 by default).
contract DualBridgeExecutorV2 is OAppBase, IAny2EVMMessageReceiver, IERC165 {
    bytes32 public constant BRIDGE_LZ = keccak256("LayerZero");
    bytes32 public constant BRIDGE_CCIP = keccak256("ChainlinkCCIP");
    bytes32 public constant BRIDGE_AX = keccak256("Axelar");
    uint256 public constant MAX_BRIDGES = 3;

    address public immutable ccipRouter;
    uint64 public ccipSrcChainSelector;
    address public ccipSrcSender;

    IAxelarGatewayValidateV2 public immutable axelarGateway;
    string public axSrcChain;
    string public axSrcAddress;

    mapping(address => bool) public allowedTargets;
    mapping(bytes32 => mapping(bytes32 => bool)) public confirmed;
    mapping(bytes32 => bytes) private _payloads;
    mapping(bytes32 => bool) public executed;
    mapping(bytes32 => bool) private _executionInProgress;
    mapping(bytes32 => uint256) public executionAttempts;
    uint256 public threshold;

    event BridgeConfirmed(bytes32 indexed msgHash, bytes32 indexed bridgeId, uint256 confirmCount);
    event LateBridgeConfirmed(bytes32 indexed msgHash, bytes32 indexed bridgeId, uint256 confirmCount);
    event CrossChainExecuted(bytes32 indexed msgHash, address indexed target, bool success);
    event CrossChainFailed(bytes32 indexed msgHash, address indexed target, bytes reason);
    event TargetAllowed(address indexed target, bool allowed);
    event ThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event CcipSrcUpdated(uint64 sourceChainSelector, address indexed sourceSender);
    event AxSrcUpdated(string sourceChain, string sourceAddress);

    error NotCcipRouter();
    error WrongCcipSrcChain(uint64 got, uint64 expected);
    error WrongCcipSrcSender(address got, address expected);
    error InvalidCcipSenderEncoding();
    error UnexpectedCcipTokens();
    error NotApprovedByAxelar();
    error WrongAxSrcChain();
    error WrongAxSrcAddress();
    error AlreadyConfirmed(bytes32 msgHash, bytes32 bridgeId);
    error InvalidThreshold();
    error InvalidCcipSrc();
    error InvalidAxSrc();
    error AlreadyExecuted(bytes32 msgHash);
    error ThresholdNotReached(bytes32 msgHash, uint256 count, uint256 required);
    error ExecutionInProgress(bytes32 msgHash);

    constructor(
        address endpoint_,
        address delegate_,
        address ccipRouter_,
        uint64 ccipSrcChainSelector_,
        address ccipSrcSender_,
        address axelarGateway_,
        string memory axSrcChain_,
        string memory axSrcAddress_,
        uint256 threshold_
    ) OAppBase(endpoint_, delegate_) {
        if (ccipRouter_ == address(0)) revert ZeroAddress();
        if (axelarGateway_ == address(0)) revert ZeroAddress();
        if (ccipSrcChainSelector_ == 0 || ccipSrcSender_ == address(0)) revert InvalidCcipSrc();
        if (bytes(axSrcChain_).length == 0 || bytes(axSrcAddress_).length == 0) revert InvalidAxSrc();
        if (threshold_ == 0 || threshold_ > MAX_BRIDGES) revert InvalidThreshold();
        ccipRouter = ccipRouter_;
        ccipSrcChainSelector = ccipSrcChainSelector_;
        ccipSrcSender = ccipSrcSender_;
        axelarGateway = IAxelarGatewayValidateV2(axelarGateway_);
        axSrcChain = axSrcChain_;
        axSrcAddress = axSrcAddress_;
        threshold = threshold_;
    }

    function _lzReceive(
        Origin calldata,
        bytes32,
        bytes calldata payload,
        address,
        bytes calldata
    ) internal override {
        _confirm(keccak256(payload), BRIDGE_LZ, payload);
    }

    function ccipReceive(CCIPClient.Any2EVMMessage calldata message) external override {
        if (msg.sender != ccipRouter) revert NotCcipRouter();
        if (message.sourceChainSelector != ccipSrcChainSelector) {
            revert WrongCcipSrcChain(message.sourceChainSelector, ccipSrcChainSelector);
        }
        if (message.sender.length != 32) revert InvalidCcipSenderEncoding();
        address sourceSender = abi.decode(message.sender, (address));
        if (sourceSender != ccipSrcSender) {
            revert WrongCcipSrcSender(sourceSender, ccipSrcSender);
        }
        if (message.destTokenAmounts.length != 0) revert UnexpectedCcipTokens();
        _confirm(keccak256(message.data), BRIDGE_CCIP, message.data);
    }

    function execute(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes calldata payload
    ) external {
        if (!axelarGateway.validateContractCall(
            commandId,
            sourceChain,
            sourceAddress,
            keccak256(payload)
        )) revert NotApprovedByAxelar();
        if (keccak256(bytes(sourceChain)) != keccak256(bytes(axSrcChain))) {
            revert WrongAxSrcChain();
        }
        if (keccak256(bytes(sourceAddress)) != keccak256(bytes(axSrcAddress))) {
            revert WrongAxSrcAddress();
        }
        _confirm(keccak256(payload), BRIDGE_AX, payload);
    }

    function _confirm(bytes32 msgHash, bytes32 bridgeId, bytes memory payload) internal {
        if (confirmed[msgHash][bridgeId]) revert AlreadyConfirmed(msgHash, bridgeId);

        if (_payloads[msgHash].length == 0) _payloads[msgHash] = payload;
        confirmed[msgHash][bridgeId] = true;

        uint256 count = _confirmCount(msgHash);
        emit BridgeConfirmed(msgHash, bridgeId, count);

        if (executed[msgHash]) {
            emit LateBridgeConfirmed(msgHash, bridgeId, count);
            return;
        }
        if (count >= threshold) _attemptExecution(msgHash);
    }

    /// @notice Retries only the exact payload that already reached the configured bridge threshold.
    /// @dev Permissionless by design: bridge confirmations authorize the payload, not the retry caller.
    function retryExecution(bytes32 msgHash) external {
        if (executed[msgHash]) revert AlreadyExecuted(msgHash);
        uint256 count = _confirmCount(msgHash);
        if (count < threshold) revert ThresholdNotReached(msgHash, count, threshold);
        _attemptExecution(msgHash);
    }

    function _attemptExecution(bytes32 msgHash) internal {
        if (_executionInProgress[msgHash]) revert ExecutionInProgress(msgHash);

        (, address target, bytes memory data) = abi.decode(
            _payloads[msgHash],
            (uint256, address, bytes)
        );
        ++executionAttempts[msgHash];
        if (target == address(0) || !allowedTargets[target]) {
            emit CrossChainFailed(msgHash, target, abi.encodePacked("target not allowed"));
            emit CrossChainExecuted(msgHash, target, false);
            return;
        }

        _executionInProgress[msgHash] = true;
        (bool ok, bytes memory reason) = target.call(data);
        _executionInProgress[msgHash] = false;
        if (ok) {
            executed[msgHash] = true;
            emit CrossChainExecuted(msgHash, target, true);
        } else {
            emit CrossChainFailed(msgHash, target, reason);
            emit CrossChainExecuted(msgHash, target, false);
        }
    }

    function _confirmCount(bytes32 msgHash) internal view returns (uint256 count) {
        if (confirmed[msgHash][BRIDGE_LZ]) ++count;
        if (confirmed[msgHash][BRIDGE_CCIP]) ++count;
        if (confirmed[msgHash][BRIDGE_AX]) ++count;
    }

    function confirmStatus(bytes32 msgHash) external view returns (
        bool lzConfirmed,
        bool ccipConfirmed,
        bool axConfirmed,
        uint256 count,
        bool isExecuted
    ) {
        lzConfirmed = confirmed[msgHash][BRIDGE_LZ];
        ccipConfirmed = confirmed[msgHash][BRIDGE_CCIP];
        axConfirmed = confirmed[msgHash][BRIDGE_AX];
        count = _confirmCount(msgHash);
        isExecuted = executed[msgHash];
    }

    function calcMsgHash(uint256 nonce, address target, bytes calldata data)
        external pure returns (bytes32)
    {
        return keccak256(abi.encode(nonce, target, data));
    }

    function supportsInterface(bytes4 interfaceId) public pure override returns (bool) {
        return interfaceId == type(IAny2EVMMessageReceiver).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        allowedTargets[target] = allowed;
        emit TargetAllowed(target, allowed);
    }

    function setThreshold(uint256 newThreshold) external onlyOwner {
        if (newThreshold == 0 || newThreshold > MAX_BRIDGES) revert InvalidThreshold();
        emit ThresholdUpdated(threshold, newThreshold);
        threshold = newThreshold;
    }

    function setCcipSrc(uint64 sourceChainSelector, address sourceSender) external onlyOwner {
        if (sourceChainSelector == 0 || sourceSender == address(0)) revert InvalidCcipSrc();
        ccipSrcChainSelector = sourceChainSelector;
        ccipSrcSender = sourceSender;
        emit CcipSrcUpdated(sourceChainSelector, sourceSender);
    }

    function setAxSrc(string calldata sourceChain, string calldata sourceAddress)
        external onlyOwner
    {
        if (bytes(sourceChain).length == 0 || bytes(sourceAddress).length == 0) {
            revert InvalidAxSrc();
        }
        axSrcChain = sourceChain;
        axSrcAddress = sourceAddress;
        emit AxSrcUpdated(sourceChain, sourceAddress);
    }
}
