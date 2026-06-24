// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title DealResultIndexV2
/// @notice Gas-optimised replacement for DealResultIndex.
///
/// 设计变化：
///   V1 把 RewardRecord(8 slot)、CreditRecord(9 slot)、TimelineRecord 数组全部写链上。
///   V2 只保留两张轻量索引表（用户→deal 列表、tokenId→deal 列表），
///   详细数据改用 event 发出——前端通过 eth_getLogs 查询，速度与 view call 相当。
///
/// 接口与 V1 完全相同（recordReward / recordCredit / recordTimeline），
/// DealFactory 无需任何改动，直接 setServiceGlobals 指向本合约即可。
///
/// Gas 对比（每笔完整 deal，7 次 timeline + 1 次 reward + 1 次 credit）：
///   V1 ≈ 1,020,000 gas   V2 ≈ 243,000 gas   节省 ≈ 777,000 gas
contract DealResultIndexV2 {

    uint256 public constant MAX_PAGE_SIZE = 100;

    address public immutable factory;

    // ─── 链上索引（仅地址列表，无结构体）────────────────────────────────────
    // 用户地址 → 该用户参与并完成的 deal 列表
    mapping(address => address[]) private _dealsByUser;
    mapping(address => mapping(address => bool)) private _dealSeenByUser;

    // NFT tokenId → 该 token 参与并完成的 deal 列表
    mapping(uint256 => address[]) private _dealsByToken;
    mapping(uint256 => mapping(address => bool)) private _dealSeenByToken;

    // ─── Events（替代 V1 的链上结构体存储）───────────────────────────────────

    /// @notice 等价于 V1 的 RewardRecord。
    ///         partyA / partyB 加了 indexed，方便前端按地址过滤。
    event DealReward(
        address indexed deal,
        address indexed partyA,
        address indexed partyB,
        uint256 toA,
        uint256 toB,
        address cAddr,
        uint256 toC,
        uint64  timestamp
    );

    /// @notice 等价于 V1 的 CreditRecord。
    event DealCredit(
        address indexed deal,
        uint256 indexed aTokenId,
        uint256 indexed bTokenId,
        uint256 aDelta,
        uint256 bDelta,
        uint64  timestamp
    );

    /// @notice 等价于 V1 的 TimelineRecord 数组元素。
    ///         deal 加了 indexed，前端可直接按 deal 地址过滤。
    event DealTimeline(
        address indexed deal,
        uint8   action,
        address actor,
        bool    isPartyA,
        uint256 value,
        uint64  timestamp
    );

    error NotFactory();

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    constructor(address factory_) {
        if (factory_ == address(0)) revert NotFactory();
        factory = factory_;
    }

    // ─── 写入接口（签名与 V1 完全一致）──────────────────────────────────────

    /// @notice 记录 deal 完成后的 DL 奖励分配。
    ///         V1：写 RewardRecord struct（8 slot）+ 3 个用户数组。
    ///         V2：只写 3 个用户数组（seen + push），emit DealReward。
    function recordReward(
        address deal,
        address partyA,
        uint256 toA,
        address partyB,
        uint256 toB,
        address cAddr,
        uint256 toC
    ) external onlyFactory {
        if (toA > 0)                         _addDealForUser(partyA, deal);
        if (toB > 0)                         _addDealForUser(partyB, deal);
        if (toC > 0 && cAddr != address(0)) _addDealForUser(cAddr,  deal);

        emit DealReward(deal, partyA, partyB, toA, toB, cAddr, toC, uint64(block.timestamp));
    }

    /// @notice 记录 deal 完成后的信用分变动。
    ///         V1：写 CreditRecord struct（9 slot）+ 2 个 token 数组。
    ///         V2：只写 2 个 token 数组（seen + push），emit DealCredit。
    function recordCredit(
        address deal,
        address /* partyA */,
        address /* partyB */,
        uint256 aTokenId,
        uint256 bTokenId,
        uint256 /* baseCredit */,
        uint256 aDelta,
        uint256 bDelta
    ) external onlyFactory {
        if (aDelta == 0 && bDelta == 0) return;

        if (aDelta > 0 && aTokenId > 0) _addDealForToken(aTokenId, deal);
        if (bDelta > 0 && bTokenId > 0) _addDealForToken(bTokenId, deal);

        emit DealCredit(deal, aTokenId, bTokenId, aDelta, bDelta, uint64(block.timestamp));
    }

    /// @notice 记录 deal 状态变化时间线。
    ///         V1：写 TimelineRecord 到动态数组（每次 3 个新 SSTORE）。
    ///         V2：0 SSTORE，只 emit DealTimeline。
    function recordTimeline(
        address deal,
        uint8   action,
        address actor,
        bool    isPartyA,
        uint256 value
    ) external onlyFactory {
        if (deal == address(0) || action == 0) return;
        emit DealTimeline(deal, action, actor, isPartyA, value, uint64(block.timestamp));
    }

    // ─── 查询：用户维度 ───────────────────────────────────────────────────────

    /// @notice 该用户完成的 deal 数量。等价于 V1 的 rewardDealCount(user)。
    function dealCountByUser(address user) external view returns (uint256) {
        return _dealsByUser[user].length;
    }

    /// @notice 分页返回该用户完成的 deal 地址列表。
    ///         等价于 V1 的 getRewardDeals(user, offset, limit, newestFirst)。
    function getDealsByUser(
        address user,
        uint256 offset,
        uint256 limit,
        bool    newestFirst
    ) external view returns (address[] memory list) {
        address[] storage arr = _dealsByUser[user];
        uint256 n = _pageLen(arr.length, offset, limit);
        list = new address[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = newestFirst
                ? arr[arr.length - 1 - (offset + i)]
                : arr[offset + i];
        }
    }

    // ─── 查询：NFT tokenId 维度 ───────────────────────────────────────────────

    /// @notice 该 NFT 参与完成的 deal 数量。等价于 V1 的 creditDealCount(tokenId)。
    function dealCountByToken(uint256 tokenId) external view returns (uint256) {
        return _dealsByToken[tokenId].length;
    }

    /// @notice 分页返回该 NFT 参与完成的 deal 地址列表。
    ///         等价于 V1 的 getCreditDeals(tokenId, offset, limit, newestFirst)。
    function getDealsByToken(
        uint256 tokenId,
        uint256 offset,
        uint256 limit,
        bool    newestFirst
    ) external view returns (address[] memory list) {
        address[] storage arr = _dealsByToken[tokenId];
        uint256 n = _pageLen(arr.length, offset, limit);
        list = new address[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = newestFirst
                ? arr[arr.length - 1 - (offset + i)]
                : arr[offset + i];
        }
    }

    // ─── 内部 ─────────────────────────────────────────────────────────────────

    function _addDealForUser(address user, address deal) private {
        if (user == address(0) || _dealSeenByUser[user][deal]) return;
        _dealSeenByUser[user][deal] = true;
        _dealsByUser[user].push(deal);
    }

    function _addDealForToken(uint256 tokenId, address deal) private {
        if (_dealSeenByToken[tokenId][deal]) return;
        _dealSeenByToken[tokenId][deal] = true;
        _dealsByToken[tokenId].push(deal);
    }

    function _pageLen(
        uint256 total,
        uint256 offset,
        uint256 limit
    ) private pure returns (uint256) {
        if (offset >= total || limit == 0) return 0;
        uint256 cap = limit > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : limit;
        uint256 end = offset + cap;
        if (end > total) end = total;
        return end - offset;
    }
}
