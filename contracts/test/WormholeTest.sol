// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ─── 接口 ────────────────────────────────────────────────────────────────────

interface IWormholeRelayer {
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

interface IWormholeReceiver {
    function receiveWormholeMessages(
        bytes   memory payload,
        bytes[] memory additionalVaas,
        bytes32 sourceAddress,
        uint16  sourceChain,
        bytes32 deliveryHash
    ) external payable;
}

// ─── Sender（部署在 Sepolia）────────────────────────────────────────────────

contract WormholeTestSender {
    IWormholeRelayer public immutable relayer;
    uint16  public constant DST_CHAIN  = 4;       // BSC testnet Wormhole chain ID
    uint256 public constant GAS_LIMIT  = 200_000;

    event Sent(uint64 sequence, bytes payload);

    constructor(address relayer_) {
        relayer = IWormholeRelayer(relayer_);
    }

    /// @notice 估算费用
    function quoteFee() external view returns (uint256) {
        (uint256 fee,) = relayer.quoteEVMDeliveryPrice(DST_CHAIN, 0, GAS_LIMIT);
        return fee;
    }

    /// @notice 发送测试消息到 BSC testnet
    function send(address receiver, bytes calldata payload) external payable {
        (uint256 fee,) = relayer.quoteEVMDeliveryPrice(DST_CHAIN, 0, GAS_LIMIT);
        require(msg.value >= fee, "insufficient fee");

        uint64 seq = relayer.sendPayloadToEvm{value: fee}(
            DST_CHAIN,
            receiver,
            payload,
            0,          // receiverValue（不需要在目标链上转 ETH）
            GAS_LIMIT
        );
        emit Sent(seq, payload);

        // 多余的退回
        if (msg.value > fee) {
            payable(msg.sender).transfer(msg.value - fee);
        }
    }
}

// ─── Receiver（部署在 BSC testnet）──────────────────────────────────────────

contract WormholeTestReceiver is IWormholeReceiver {
    address public immutable wormholeRelayer;
    uint16  public constant  SRC_CHAIN = 10002;  // Sepolia Wormhole chain ID

    struct ReceivedMsg {
        bytes32 sourceAddress;
        uint16  sourceChain;
        bytes   payload;
        uint256 receivedAt;
    }

    ReceivedMsg[] public messages;

    event MessageReceived(
        bytes32 indexed sourceAddress,
        uint16  sourceChain,
        bytes   payload,
        uint256 index
    );

    error OnlyRelayer();
    error WrongSourceChain(uint16 got, uint16 expected);

    constructor(address wormholeRelayer_) {
        wormholeRelayer = wormholeRelayer_;
    }

    function receiveWormholeMessages(
        bytes   memory payload,
        bytes[] memory,           // additionalVaas 本次不用
        bytes32 sourceAddress,
        uint16  sourceChain,
        bytes32                   // deliveryHash
    ) external payable override {
        if (msg.sender != wormholeRelayer) revert OnlyRelayer();
        if (sourceChain != SRC_CHAIN)      revert WrongSourceChain(sourceChain, SRC_CHAIN);

        messages.push(ReceivedMsg({
            sourceAddress: sourceAddress,
            sourceChain:   sourceChain,
            payload:       payload,
            receivedAt:    block.timestamp
        }));

        emit MessageReceived(sourceAddress, sourceChain, payload, messages.length - 1);
    }

    function messageCount() external view returns (uint256) {
        return messages.length;
    }

    function latestMessage() external view returns (ReceivedMsg memory) {
        require(messages.length > 0, "no messages");
        return messages[messages.length - 1];
    }
}
