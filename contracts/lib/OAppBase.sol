// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

// ─── LayerZero V2 structs (from ILayerZeroEndpointV2) ───────────────────────

struct MessagingParams {
    uint32 dstEid;
    bytes32 receiver;
    bytes message;
    bytes options;
    bool payInLzToken;
}

struct MessagingReceipt {
    bytes32 guid;
    uint64 nonce;
    MessagingFee fee;
}

struct MessagingFee {
    uint256 nativeFee;
    uint256 lzTokenFee;
}

struct Origin {
    uint32 srcEid;
    bytes32 sender;
    uint64 nonce;
}

interface ILZEndpointV2 {
    function quote(MessagingParams calldata _params, address _sender) external view returns (MessagingFee memory);
    function send(MessagingParams calldata _params, address _refundAddress) external payable returns (MessagingReceipt memory);
    function setDelegate(address _delegate) external;
    function lzToken() external view returns (address);
}

// ─── OAppBase ────────────────────────────────────────────────────────────────

/**
 * @title OAppBase
 * @notice Minimal LayerZero V2 OApp base. Compatible with OpenZeppelin v5.
 *         Handles peer management, send, receive routing, and fee quoting.
 *         Options encoding for LzReceive is inlined to avoid external libs.
 */
abstract contract OAppBase is Ownable {
    // LZ endpoint on this chain
    ILZEndpointV2 public immutable endpoint;

    // srcEid → trusted peer OApp (bytes32-encoded address)
    mapping(uint32 eid => bytes32 peer) public peers;

    event PeerSet(uint32 eid, bytes32 peer);

    error NoPeer(uint32 eid);
    error NotEndpoint();
    error InvalidSender(uint32 eid, bytes32 sender);
    error NotEnoughNative(uint256 got);

    constructor(address _endpoint, address _delegate) Ownable(_delegate) {
        endpoint = ILZEndpointV2(_endpoint);
        endpoint.setDelegate(_delegate);
    }

    // ── Peer management ──────────────────────────────────────────────────────

    function setPeer(uint32 _eid, bytes32 _peer) external onlyOwner {
        peers[_eid] = _peer;
        emit PeerSet(_eid, _peer);
    }

    function setDelegate(address _delegate) external onlyOwner {
        endpoint.setDelegate(_delegate);
    }

    // ── Send ─────────────────────────────────────────────────────────────────

    function _lzSend(
        uint32 _dstEid,
        bytes memory _message,
        uint128 _gasLimit
    ) internal returns (bytes32 guid) {
        bytes32 peer = peers[_dstEid];
        if (peer == bytes32(0)) revert NoPeer(_dstEid);

        bytes memory options = _lzReceiveOptions(_gasLimit);
        MessagingFee memory fee = endpoint.quote(
            MessagingParams(_dstEid, peer, _message, options, false),
            address(this)
        );
        if (msg.value < fee.nativeFee) revert NotEnoughNative(msg.value);

        MessagingReceipt memory receipt = endpoint.send{value: fee.nativeFee}(
            MessagingParams(_dstEid, peer, _message, options, false),
            payable(tx.origin)
        );
        return receipt.guid;
    }

    function _quoteFee(
        uint32 _dstEid,
        bytes memory _message,
        uint128 _gasLimit
    ) internal view returns (uint256 nativeFee) {
        bytes32 peer = peers[_dstEid];
        if (peer == bytes32(0)) revert NoPeer(_dstEid);
        bytes memory options = _lzReceiveOptions(_gasLimit);
        return endpoint.quote(
            MessagingParams(_dstEid, peer, _message, options, false),
            address(this)
        ).nativeFee;
    }

    // ── Receive ──────────────────────────────────────────────────────────────

    /**
     * @notice Called by the LayerZero endpoint after message verification.
     */
    function lzReceive(
        Origin calldata _origin,
        bytes32 _guid,
        bytes calldata _message,
        address _executor,
        bytes calldata _extraData
    ) external payable {
        if (msg.sender != address(endpoint)) revert NotEndpoint();
        bytes32 expectedPeer = peers[_origin.srcEid];
        if (expectedPeer == bytes32(0) || _origin.sender != expectedPeer) {
            revert InvalidSender(_origin.srcEid, _origin.sender);
        }
        _lzReceive(_origin, _guid, _message, _executor, _extraData);
    }

    /**
     * @dev Override in subcontracts to handle received messages.
     */
    function _lzReceive(
        Origin calldata _origin,
        bytes32 _guid,
        bytes calldata _message,
        address _executor,
        bytes calldata _extraData
    ) internal virtual;

    // ── Option encoding ───────────────────────────────────────────────────────

    /**
     * @dev Encodes a TYPE_3 options blob with a single LzReceive executor option.
     *      Binary layout (per LZ V2 ExecutorOptions spec):
     *        2 bytes: options type = 0x0003 (TYPE_3)
     *        1 byte:  worker id  = 0x01 (Executor WORKER_ID is uint8)
     *        2 bytes: option body length = 17 (1 optionType + 16 gas)
     *        1 byte:  option type = 0x01 (OPTION_TYPE_LZRECEIVE)
     *       16 bytes: gasLimit (uint128 big-endian)
     * Total: 22 bytes
     */
    function _lzReceiveOptions(uint128 _gasLimit) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint16(3),      // TYPE_3
            uint8(1),       // WORKER_ID = Executor (uint8, NOT uint16)
            uint16(17),     // body length: 1 (optionType) + 16 (uint128)
            uint8(1),       // OPTION_TYPE_LZRECEIVE
            _gasLimit       // uint128
        );
    }
}
