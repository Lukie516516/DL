// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {
    MessagingFee,
    MessagingParams,
    MessagingReceipt,
    Origin
} from "../lib/OAppBase.sol";

/// @dev Records the exact remote action approved and paid for by DealGovernance.
contract CrossChainBroadcasterRecorder {
    address public immutable governance;
    uint256 public broadcastNonce;
    uint32 public lastChainId;
    address public lastTarget;
    bytes public lastData;
    uint128 public lastLzGas;
    uint256 public totalValueReceived;

    error NotGovernance();
    error BadTargets();

    constructor(address governance_) {
        governance = governance_;
    }

    function broadcast(
        uint32[] calldata targetChainIds,
        address[] calldata targets,
        bytes calldata data,
        uint128 lzGas
    ) external payable {
        if (msg.sender != governance) revert NotGovernance();
        if (targetChainIds.length != 1 || targets.length != 1) revert BadTargets();
        ++broadcastNonce;
        lastChainId = targetChainIds[0];
        lastTarget = targets[0];
        lastData = data;
        lastLzGas = lzGas;
        totalValueReceived += msg.value;
    }
}

interface ILzReceiverMock {
    function lzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) external payable;
}

contract MockLzEndpointV2 {
    address public delegate;

    function setDelegate(address delegate_) external {
        delegate = delegate_;
    }

    function lzToken() external pure returns (address) {
        return address(0);
    }

    function quote(MessagingParams calldata, address) external pure returns (MessagingFee memory) {
        return MessagingFee({nativeFee: 0, lzTokenFee: 0});
    }

    function send(MessagingParams calldata, address)
        external
        payable
        returns (MessagingReceipt memory)
    {
        return MessagingReceipt({
            guid: keccak256(abi.encodePacked(msg.sender, block.number)),
            nonce: 1,
            fee: MessagingFee({nativeFee: msg.value, lzTokenFee: 0})
        });
    }

    function deliver(address receiver, Origin calldata origin, bytes calldata payload) external {
        ILzReceiverMock(receiver).lzReceive(origin, bytes32(0), payload, msg.sender, "");
    }
}

interface IWormholeReceiverMock {
    function receiveWormholeMessages(
        bytes memory payload,
        bytes[] memory additionalVaas,
        bytes32 sourceAddress,
        uint16 sourceChain,
        bytes32 deliveryHash
    ) external payable;
}

contract MockWormholeRelayer {
    function deliver(
        address receiver,
        bytes calldata payload,
        bytes32 sourceAddress,
        uint16 sourceChain
    ) external {
        bytes[] memory additionalVaas = new bytes[](0);
        IWormholeReceiverMock(receiver).receiveWormholeMessages(
            payload,
            additionalVaas,
            sourceAddress,
            sourceChain,
            keccak256(payload)
        );
    }
}

contract MockAxelarGateway {
    function validateContractCall(bytes32, string calldata, string calldata, bytes32)
        external
        pure
        returns (bool)
    {
        return true;
    }
}
