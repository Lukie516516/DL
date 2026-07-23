// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {
    MessagingFee,
    MessagingParams,
    MessagingReceipt,
    Origin
} from "../lib/OAppBase.sol";
import {CCIPClient, IAny2EVMMessageReceiver} from "../lib/CCIP.sol";

interface ILzReceiverV2Mock {
    function lzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) external payable;
}

contract MockLzEndpointForCCIP {
    address public delegate;
    uint256 public fee;
    uint32 public lastDstEid;
    bytes32 public lastReceiver;
    bytes public lastMessage;
    bytes public lastOptions;
    uint256 public lastValue;
    uint64 public sendNonce;

    function setDelegate(address delegate_) external {
        delegate = delegate_;
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function lzToken() external pure returns (address) {
        return address(0);
    }

    function quote(MessagingParams calldata, address)
        external view returns (MessagingFee memory)
    {
        return MessagingFee({nativeFee: fee, lzTokenFee: 0});
    }

    function send(MessagingParams calldata params, address)
        external payable returns (MessagingReceipt memory receipt)
    {
        require(msg.value == fee, "wrong LZ fee");
        lastDstEid = params.dstEid;
        lastReceiver = params.receiver;
        lastMessage = params.message;
        lastOptions = params.options;
        lastValue = msg.value;
        uint64 nonce = ++sendNonce;
        receipt = MessagingReceipt({
            guid: keccak256(abi.encode(msg.sender, nonce, params.message)),
            nonce: nonce,
            fee: MessagingFee({nativeFee: msg.value, lzTokenFee: 0})
        });
    }

    function deliver(address receiver, Origin calldata origin, bytes calldata payload) external {
        ILzReceiverV2Mock(receiver).lzReceive(origin, bytes32(0), payload, msg.sender, "");
    }
}

contract MockCCIPRouter {
    mapping(uint64 => bool) public supportedChains;
    uint256 public fee;
    uint256 public sendNonce;
    uint64 public lastDestinationChainSelector;
    bytes public lastReceiver;
    bytes public lastData;
    bytes public lastExtraArgs;
    address public lastFeeToken;
    uint256 public lastValue;

    function setChainSupported(uint64 chainSelector, bool supported) external {
        supportedChains[chainSelector] = supported;
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function isChainSupported(uint64 chainSelector) external view returns (bool) {
        return supportedChains[chainSelector];
    }

    function getFee(uint64 chainSelector, CCIPClient.EVM2AnyMessage memory)
        external view returns (uint256)
    {
        require(supportedChains[chainSelector], "unsupported CCIP chain");
        return fee;
    }

    function ccipSend(uint64 chainSelector, CCIPClient.EVM2AnyMessage calldata message)
        external payable returns (bytes32 messageId)
    {
        require(supportedChains[chainSelector], "unsupported CCIP chain");
        require(msg.value == fee, "wrong CCIP fee");
        require(message.tokenAmounts.length == 0, "unexpected token transfer");
        lastDestinationChainSelector = chainSelector;
        lastReceiver = message.receiver;
        lastData = message.data;
        lastExtraArgs = message.extraArgs;
        lastFeeToken = message.feeToken;
        lastValue = msg.value;
        messageId = keccak256(abi.encode(msg.sender, ++sendNonce, message.data));
    }

    function deliver(
        address receiver,
        bytes32 messageId,
        uint64 sourceChainSelector,
        bytes calldata sender,
        bytes calldata data
    ) external {
        CCIPClient.EVMTokenAmount[] memory noTokens = new CCIPClient.EVMTokenAmount[](0);
        IAny2EVMMessageReceiver(receiver).ccipReceive(
            CCIPClient.Any2EVMMessage({
                messageId: messageId,
                sourceChainSelector: sourceChainSelector,
                sender: sender,
                data: data,
                destTokenAmounts: noTokens
            })
        );
    }

    function deliverWithToken(
        address receiver,
        bytes32 messageId,
        uint64 sourceChainSelector,
        bytes calldata sender,
        bytes calldata data,
        address token,
        uint256 amount
    ) external {
        CCIPClient.EVMTokenAmount[] memory tokens = new CCIPClient.EVMTokenAmount[](1);
        tokens[0] = CCIPClient.EVMTokenAmount({token: token, amount: amount});
        IAny2EVMMessageReceiver(receiver).ccipReceive(
            CCIPClient.Any2EVMMessage({
                messageId: messageId,
                sourceChainSelector: sourceChainSelector,
                sender: sender,
                data: data,
                destTokenAmounts: tokens
            })
        );
    }
}

interface IAxelarExecutorV2Mock {
    function execute(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes calldata payload
    ) external;
}

contract MockAxelarGatewayForCCIP {
    bool public validationResult = true;
    string public lastDestinationChain;
    string public lastDestinationAddress;
    bytes public lastPayload;

    function setValidationResult(bool result) external {
        validationResult = result;
    }

    function callContract(
        string calldata destinationChain,
        string calldata destinationAddress,
        bytes calldata payload
    ) external {
        lastDestinationChain = destinationChain;
        lastDestinationAddress = destinationAddress;
        lastPayload = payload;
    }

    function validateContractCall(bytes32, string calldata, string calldata, bytes32)
        external view returns (bool)
    {
        return validationResult;
    }

    function deliver(
        address receiver,
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes calldata payload
    ) external {
        IAxelarExecutorV2Mock(receiver).execute(
            commandId,
            sourceChain,
            sourceAddress,
            payload
        );
    }
}

contract MockAxelarGasServiceForCCIP {
    address public lastSender;
    string public lastDestinationChain;
    string public lastDestinationAddress;
    bytes public lastPayload;
    address public lastRefundAddress;
    uint256 public lastValue;

    function payNativeGasForContractCall(
        address sender,
        string calldata destinationChain,
        string calldata destinationAddress,
        bytes calldata payload,
        address refundAddress
    ) external payable {
        lastSender = sender;
        lastDestinationChain = destinationChain;
        lastDestinationAddress = destinationAddress;
        lastPayload = payload;
        lastRefundAddress = refundAddress;
        lastValue = msg.value;
    }
}

contract RetryableExecutionTarget {
    bool public shouldFail = true;
    uint256 public param;
    uint256 public successfulCalls;

    error PlannedFailure();

    function setShouldFail(bool value) external {
        shouldFail = value;
    }

    function setParam(uint256 value) external {
        if (shouldFail) revert PlannedFailure();
        param = value;
        ++successfulCalls;
    }
}

interface IRetryableBridgeExecutor {
    function retryExecution(bytes32 msgHash) external;
}

contract ReentrantRetryTarget {
    IRetryableBridgeExecutor public executor;
    bytes32 public msgHash;
    uint256 public callCount;
    bool public reentryBlocked;

    function configure(address executor_, bytes32 msgHash_) external {
        executor = IRetryableBridgeExecutor(executor_);
        msgHash = msgHash_;
    }

    function executeAndTryReentry() external {
        ++callCount;
        try executor.retryExecution(msgHash) {
            reentryBlocked = false;
        } catch {
            reentryBlocked = true;
        }
    }
}
