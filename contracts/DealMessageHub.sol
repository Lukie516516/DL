// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IDealFactoryDealAuth {
    function isDeal(address deal) external view returns (bool);
    function chargeMessageFeeFrom(address payer) external;
}

interface IDealMessagePeerView {
    function a() external view returns (address);
    function b() external view returns (address);
}

contract DealMessageHub {
    uint256 public constant MAX_MESSAGE_BYTES = 1500;
    uint256 public constant MAX_PAGE_SIZE = 100;

    error ZeroAddress();
    error NotDeal();
    error NotParticipant();
    error InvalidSender();
    error EmptyMessage();
    error MessageTooLong();

    struct Thread {
        string[] contents;
        uint64[] times;
        address[] senders;
    }
    address public immutable factory;
    mapping(address => Thread) private _threads;

    event MessageStored(
        address indexed deal,
        address indexed sender,
        uint256 indexed index,
        uint64 timestamp
    );
    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
    }

    function postMessage(address deal, string calldata content) external returns (uint256 index) {
        if (!IDealFactoryDealAuth(factory).isDeal(deal)) revert NotDeal();
        if (msg.sender != IDealMessagePeerView(deal).a() && msg.sender != IDealMessagePeerView(deal).b()) {
            revert NotParticipant();
        }
        IDealFactoryDealAuth(factory).chargeMessageFeeFrom(msg.sender);
        return _store(deal, msg.sender, content);
    }

    function postFromDeal(
        address sender,
        string calldata content
    ) external returns (uint256 index) {
        if (!IDealFactoryDealAuth(factory).isDeal(msg.sender)) revert NotDeal();
        address dealA = IDealMessagePeerView(msg.sender).a();
        address dealB = IDealMessagePeerView(msg.sender).b();
        if (sender != dealA && sender != dealB) revert InvalidSender();
        return _store(msg.sender, sender, content);
    }

    function _store(address deal, address sender, string calldata content) internal returns (uint256 index) {
        uint256 contentLen = bytes(content).length;
        if (contentLen == 0) revert EmptyMessage();
        if (contentLen > MAX_MESSAGE_BYTES) revert MessageTooLong();

        Thread storage t = _threads[deal];
        uint64 ts = uint64(block.timestamp);
        t.contents.push(content);
        t.times.push(ts);
        t.senders.push(sender);
        index = t.contents.length - 1;

        emit MessageStored(deal, sender, index, ts);
    }
    function messagesCount(address deal) external view returns (uint256) {
        return _threads[deal].contents.length;
    }

    function getMessages(
        address deal,
        uint256 offset,
        uint256 limit
    )
        external
        view
        returns (
            string[] memory contents,
            uint64[] memory times,
            address[] memory senders
        )
    {
        Thread storage t = _threads[deal];
        uint256 total = t.contents.length;
        if (offset >= total) {
            return (new string[](0), new uint64[](0), new address[](0));
        }

        uint256 pageLimit = limit > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : limit;
        uint256 end = offset + pageLimit;
        if (end > total) end = total;
        uint256 len = end - offset;

        contents = new string[](len);
        times = new uint64[](len);
        senders = new address[](len);
        for (uint256 i = 0; i < len; ++i) {
            contents[i] = t.contents[offset + i];
            times[i] = t.times[offset + i];
            senders[i] = t.senders[offset + i];
        }
    }
}
