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
 */
abstract contract OAppBase is Ownable {
    ILZEndpointV2 public immutable endpoint;

    // srcEid → trusted peer OApp (bytes32-encoded address)
    mapping(uint32 eid => bytes32 peer) public peers;

    event PeerSet(uint32 eid, bytes32 peer);
    event ETHRescued(address indexed to, uint256 amount);

    error NoPeer(uint32 eid);
    error NotEndpoint();
    error InvalidSender(uint32 eid, bytes32 sender);
    error NotEnoughNative(uint256 got);
    error ZeroAddress();
    error RescueFailed();

    constructor(address _endpoint, address _delegate) Ownable(_delegate) {
        if (_endpoint == address(0)) revert ZeroAddress();
        endpoint = ILZEndpointV2(_endpoint);
        endpoint.setDelegate(_delegate);
    }

    // Accept ETH (e.g. excess from fee buffers returned by LZ endpoint)
    receive() external payable {}

    // ── Peer management ──────────────────────────────────────────────────────

    function setPeer(uint32 _eid, bytes32 _peer) external onlyOwner {
        if (_peer == bytes32(0)) revert ZeroAddress();
        // Enforce EVM address encoding: left 12 bytes must be zero (right-padded 20-byte address).
        if (uint96(uint256(_peer) >> 160) != 0) revert ZeroAddress();
        peers[_eid] = _peer;
        emit PeerSet(_eid, _peer);
    }

    function setDelegate(address _delegate) external onlyOwner {
        endpoint.setDelegate(_delegate);
    }

    // ── Rescue ETH accidentally locked in this contract ──────────────────────

    function rescueETH(address payable _to, uint256 _amount) external onlyOwner {
        if (_to == address(0)) revert ZeroAddress();
        (bool ok,) = _to.call{value: _amount}("");
        if (!ok) revert RescueFailed();
        emit ETHRescued(_to, _amount);
    }

    // ── LZ V2 receiver interface ─────────────────────────────────────────────

    /**
     * @notice Required by LZ V2 EndpointV2._initializable().
     *         Called before the first message on any path to check if this OApp
     *         accepts that sender. Without this, the first delivery silently fails.
     */
    function allowInitializePath(Origin calldata _origin) external view returns (bool) {
        return peers[_origin.srcEid] != bytes32(0) && peers[_origin.srcEid] == _origin.sender;
    }

    /**
     * @notice Returns 0 — unordered delivery. Governance proposals should be
     *         designed to be independent (not depend on ordering guarantees).
     */
    function nextNonce(uint32 /*_srcEid*/, bytes32 /*_sender*/) external pure returns (uint64) {
        return 0;
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
            // FIX HIGH-1: use msg.sender (governance contract) not tx.origin.
            // tx.origin fails with AA wallets and misdirects refunds to proposer EOA.
            payable(msg.sender)
        );

        // Any excess msg.value stays in contract; use rescueETH() to recover.
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

    function _lzReceive(
        Origin calldata _origin,
        bytes32 _guid,
        bytes calldata _message,
        address _executor,
        bytes calldata _extraData
    ) internal virtual;

    // ── Options encoding ─────────────────────────────────────────────────────

    /**
     * @dev TYPE_3 options with a single LzReceive executor option.
     *      Layout: 2B type | 1B workerId | 2B bodyLen | 1B optionType | 16B gasLimit
     *      WORKER_ID must be uint8(1), NOT uint16(1).
     */
    function _lzReceiveOptions(uint128 _gasLimit) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint16(3),   // TYPE_3
            uint8(1),    // WORKER_ID = Executor
            uint16(17),  // body length: 1 + 16
            uint8(1),    // OPTION_TYPE_LZRECEIVE
            _gasLimit
        );
    }
}
