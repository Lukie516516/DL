// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Stores per-user active/completed deal indexes outside DealFactory.
contract DealActivityIndex {
    error NotFactory();

    uint256 public constant MAX_PAGE_SIZE = 100;
    uint8 public constant COMPLETED_MAX = 10;

    address public immutable factory;

    mapping(address => address[]) private _trackedDealsByUser;
    mapping(address => mapping(address => uint256)) private _trackedIndexByUser;

    struct CompletedRing {
        address[COMPLETED_MAX] items;
        uint8 start;
        uint8 size;
    }

    mapping(address => CompletedRing) private _completedByUser;

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    constructor(address factory_) {
        if (factory_ == address(0)) revert NotFactory();
        factory = factory_;
    }

    function addTracked(address user, address deal) external onlyFactory returns (bool changed) {
        if (user == address(0) || deal == address(0)) return false;
        mapping(address => uint256) storage idx = _trackedIndexByUser[user];
        if (idx[deal] != 0) return false;
        _trackedDealsByUser[user].push(deal);
        idx[deal] = _trackedDealsByUser[user].length;
        return true;
    }

    function removeTracked(address user, address deal) external onlyFactory returns (bool changed) {
        if (user == address(0) || deal == address(0)) return false;
        mapping(address => uint256) storage idx = _trackedIndexByUser[user];
        uint256 pos = idx[deal];
        if (pos == 0) return false;

        address[] storage arr = _trackedDealsByUser[user];
        uint256 i = pos - 1;
        uint256 last = arr.length - 1;
        if (i != last) {
            address lastDeal = arr[last];
            arr[i] = lastDeal;
            _trackedIndexByUser[user][lastDeal] = i + 1;
        }
        arr.pop();
        delete _trackedIndexByUser[user][deal];
        return true;
    }

    function addCompleted(address user, address deal) external onlyFactory returns (bool changed) {
        if (user == address(0) || deal == address(0)) return false;
        CompletedRing storage r = _completedByUser[user];
        if (r.size < COMPLETED_MAX) {
            uint8 idx = uint8((uint16(r.start) + uint16(r.size)) % uint16(COMPLETED_MAX));
            r.items[idx] = deal;
            unchecked {
                r.size += 1;
            }
        } else {
            r.items[r.start] = deal;
            r.start = uint8((r.start + 1) % uint16(COMPLETED_MAX));
        }
        return true;
    }

    function trackedCount(address user) external view returns (uint256) {
        return _trackedDealsByUser[user].length;
    }

    function getTracked(address user, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory list)
    {
        address[] storage arr = _trackedDealsByUser[user];
        uint256 len = arr.length;
        if (offset >= len) return new address[](0);
        uint256 pageLimit = limit > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : limit;
        uint256 end = offset + pageLimit;
        if (end > len) end = len;
        uint256 n = end - offset;
        list = new address[](n);
        for (uint256 i = 0; i < n; ++i) list[i] = arr[offset + i];
    }

    function isTracked(address user, address deal) external view returns (bool) {
        return _trackedIndexByUser[user][deal] != 0;
    }

    function completedCount(address user) external view returns (uint256) {
        return _completedByUser[user].size;
    }

    function getCompleted(address user, uint256 offset, uint256 limit, bool newestFirst)
        external
        view
        returns (address[] memory list)
    {
        CompletedRing storage r = _completedByUser[user];
        uint256 sz = r.size;
        if (offset >= sz) return new address[](0);
        uint256 pageLimit = limit > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : limit;
        uint256 end = offset + pageLimit;
        if (end > sz) end = sz;
        uint256 n = end - offset;

        list = new address[](n);
        if (newestFirst) {
            for (uint256 i = 0; i < n; ++i) {
                uint256 logical = sz - 1 - (offset + i);
                uint8 idx = uint8((uint16(r.start) + uint16(logical)) % uint16(COMPLETED_MAX));
                list[i] = r.items[idx];
            }
        } else {
            for (uint256 i = 0; i < n; ++i) {
                uint8 idx = uint8((uint16(r.start) + uint16(offset + i)) % uint16(COMPLETED_MAX));
                list[i] = r.items[idx];
            }
        }
    }
}
