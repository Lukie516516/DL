// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Stores deal result indexes for frontend reads so clients do not scan historical logs.
contract DealResultIndex {
    uint256 public constant MAX_PAGE_SIZE = 100;

    address public immutable factory;

    struct RewardRecord {
        bool exists;
        address deal;
        address partyA;
        address partyB;
        address cAddr;
        uint256 toA;
        uint256 toB;
        uint256 toC;
        uint64 timestamp;
    }

    struct CreditRecord {
        bool exists;
        address deal;
        address partyA;
        address partyB;
        uint256 aTokenId;
        uint256 bTokenId;
        uint256 baseCredit;
        uint256 aDelta;
        uint256 bDelta;
        uint64 timestamp;
    }

    struct TimelineRecord {
        uint8 action;
        address actor;
        bool isPartyA;
        uint256 value;
        uint64 timestamp;
    }

    mapping(address => RewardRecord) private _rewardByDeal;
    mapping(address => address[]) private _rewardDealsByUser;
    mapping(address => mapping(address => bool)) private _rewardDealSeenByUser;

    mapping(address => CreditRecord) private _creditByDeal;
    mapping(uint256 => address[]) private _creditDealsByToken;
    mapping(uint256 => mapping(address => bool)) private _creditDealSeenByToken;

    mapping(address => TimelineRecord[]) private _timelineByDeal;

    error NotFactory();

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    constructor(address factory_) {
        if (factory_ == address(0)) revert NotFactory();
        factory = factory_;
    }

    function recordReward(
        address deal,
        address partyA,
        uint256 toA,
        address partyB,
        uint256 toB,
        address cAddr,
        uint256 toC
    ) external onlyFactory {
        _rewardByDeal[deal] = RewardRecord({
            exists: true,
            deal: deal,
            partyA: partyA,
            partyB: partyB,
            cAddr: cAddr,
            toA: toA,
            toB: toB,
            toC: toC,
            timestamp: uint64(block.timestamp)
        });

        if (toA > 0) _addRewardDealFor(partyA, deal);
        if (toB > 0) _addRewardDealFor(partyB, deal);
        if (toC > 0) _addRewardDealFor(cAddr, deal);
    }

    function recordCredit(
        address deal,
        address partyA,
        address partyB,
        uint256 aTokenId,
        uint256 bTokenId,
        uint256 baseCredit,
        uint256 aDelta,
        uint256 bDelta
    ) external onlyFactory {
        if (aDelta == 0 && bDelta == 0) return;

        _creditByDeal[deal] = CreditRecord({
            exists: true,
            deal: deal,
            partyA: partyA,
            partyB: partyB,
            aTokenId: aDelta > 0 ? aTokenId : 0,
            bTokenId: bDelta > 0 ? bTokenId : 0,
            baseCredit: baseCredit,
            aDelta: aDelta,
            bDelta: bDelta,
            timestamp: uint64(block.timestamp)
        });

        if (aDelta > 0) _addCreditDealFor(aTokenId, deal);
        if (bDelta > 0) _addCreditDealFor(bTokenId, deal);
    }

    function recordTimeline(address deal, uint8 action, address actor, bool isPartyA, uint256 value)
        external
        onlyFactory
    {
        if (deal == address(0) || action == 0) return;
        _timelineByDeal[deal].push(
            TimelineRecord({
                action: action,
                actor: actor,
                isPartyA: isPartyA,
                value: value,
                timestamp: uint64(block.timestamp)
            })
        );
    }

    function rewardOfDeal(address deal) external view returns (RewardRecord memory) {
        return _rewardByDeal[deal];
    }

    function rewardDealCount(address user) external view returns (uint256) {
        return _rewardDealsByUser[user].length;
    }

    function getRewardDeals(address user, uint256 offset, uint256 limit, bool newestFirst)
        external
        view
        returns (address[] memory list)
    {
        address[] storage arr = _rewardDealsByUser[user];
        uint256 n = _pageLength(arr.length, offset, limit);
        list = new address[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = _pagedAddress(arr, offset, i, newestFirst);
        }
    }

    function getRewards(address user, uint256 offset, uint256 limit, bool newestFirst)
        external
        view
        returns (RewardRecord[] memory list)
    {
        address[] storage arr = _rewardDealsByUser[user];
        uint256 n = _pageLength(arr.length, offset, limit);
        list = new RewardRecord[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = _rewardByDeal[_pagedAddress(arr, offset, i, newestFirst)];
        }
    }

    function creditOfDeal(address deal) external view returns (CreditRecord memory) {
        return _creditByDeal[deal];
    }

    function creditDealCount(uint256 tokenId) external view returns (uint256) {
        return _creditDealsByToken[tokenId].length;
    }

    function getCreditDeals(uint256 tokenId, uint256 offset, uint256 limit, bool newestFirst)
        external
        view
        returns (address[] memory list)
    {
        address[] storage arr = _creditDealsByToken[tokenId];
        uint256 n = _pageLength(arr.length, offset, limit);
        list = new address[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = _pagedAddress(arr, offset, i, newestFirst);
        }
    }

    function getCreditRecords(uint256 tokenId, uint256 offset, uint256 limit, bool newestFirst)
        external
        view
        returns (CreditRecord[] memory list)
    {
        address[] storage arr = _creditDealsByToken[tokenId];
        uint256 n = _pageLength(arr.length, offset, limit);
        list = new CreditRecord[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = _creditByDeal[_pagedAddress(arr, offset, i, newestFirst)];
        }
    }

    function timelineCount(address deal) external view returns (uint256) {
        return _timelineByDeal[deal].length;
    }

    function getTimeline(address deal, uint256 offset, uint256 limit, bool newestFirst)
        external
        view
        returns (TimelineRecord[] memory list)
    {
        TimelineRecord[] storage arr = _timelineByDeal[deal];
        uint256 n = _pageLength(arr.length, offset, limit);
        list = new TimelineRecord[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = _pagedTimeline(arr, offset, i, newestFirst);
        }
    }

    function _addRewardDealFor(address user, address deal) private {
        if (user == address(0) || _rewardDealSeenByUser[user][deal]) return;
        _rewardDealSeenByUser[user][deal] = true;
        _rewardDealsByUser[user].push(deal);
    }

    function _addCreditDealFor(uint256 tokenId, address deal) private {
        if (tokenId == 0 || _creditDealSeenByToken[tokenId][deal]) return;
        _creditDealSeenByToken[tokenId][deal] = true;
        _creditDealsByToken[tokenId].push(deal);
    }

    function _pageLength(uint256 total, uint256 offset, uint256 limit) private pure returns (uint256) {
        if (offset >= total || limit == 0) return 0;
        uint256 pageLimit = limit > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : limit;
        uint256 end = offset + pageLimit;
        if (end > total) end = total;
        return end - offset;
    }

    function _pagedAddress(address[] storage arr, uint256 offset, uint256 i, bool newestFirst)
        private
        view
        returns (address)
    {
        if (newestFirst) {
            return arr[arr.length - 1 - (offset + i)];
        }
        return arr[offset + i];
    }

    function _pagedTimeline(TimelineRecord[] storage arr, uint256 offset, uint256 i, bool newestFirst)
        private
        view
        returns (TimelineRecord memory)
    {
        if (newestFirst) {
            return arr[arr.length - 1 - (offset + i)];
        }
        return arr[offset + i];
    }
}
