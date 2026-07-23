// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal Chainlink CCIP v1.6.x ABI surface used by Deal governance.
/// @dev The structs and selectors intentionally match @chainlink/contracts-ccip v1.6.1.
library CCIPClient {
    struct EVMTokenAmount {
        address token;
        uint256 amount;
    }

    struct Any2EVMMessage {
        bytes32 messageId;
        uint64 sourceChainSelector;
        bytes sender;
        bytes data;
        EVMTokenAmount[] destTokenAmounts;
    }

    struct EVM2AnyMessage {
        bytes receiver;
        bytes data;
        EVMTokenAmount[] tokenAmounts;
        address feeToken;
        bytes extraArgs;
    }

    bytes4 internal constant GENERIC_EXTRA_ARGS_V2_TAG = 0x181dcf10;

    struct GenericExtraArgsV2 {
        uint256 gasLimit;
        bool allowOutOfOrderExecution;
    }

    function argsToBytes(GenericExtraArgsV2 memory extraArgs)
        internal pure returns (bytes memory)
    {
        return abi.encodeWithSelector(GENERIC_EXTRA_ARGS_V2_TAG, extraArgs);
    }
}

interface ICCIPRouter {
    function isChainSupported(uint64 destinationChainSelector) external view returns (bool);

    function getFee(
        uint64 destinationChainSelector,
        CCIPClient.EVM2AnyMessage memory message
    ) external view returns (uint256 fee);

    function ccipSend(
        uint64 destinationChainSelector,
        CCIPClient.EVM2AnyMessage calldata message
    ) external payable returns (bytes32 messageId);
}

interface IAny2EVMMessageReceiver {
    function ccipReceive(CCIPClient.Any2EVMMessage calldata message) external;
}
