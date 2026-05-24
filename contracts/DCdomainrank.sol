// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IDCDomain {
    function isRegistered(string calldata domainName) external view returns (bool);
    function tokenIdOf(string calldata domainName) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IDealStatusView {
    function status() external view returns (uint8);
    function endedAt() external view returns (uint64);
}

/**
 * @title DCDomainRank
 * @notice 任何人都可以成为商家、发布合同，无需白名单/充值。
 *         排行榜按「每笔交易（Deal）的消耗」排序，一个商家可有 N 条上榜。
 *         充值可选：有充值才扣小时费，没充值则该条目分数为 0。
 *         访客入口保留兼容 ABI，但不再作为业务权限限制。
 *         小时费结算产生的广告费暂存本合约，域名 NFT 持有人调用 withdraw(domainName) 领取。
 *         广告费模式由域名 NFT 持有人配置：None（默认，禁止充值）/ Proportional（按余额比例）/ Fixed（固定速率）。
 */
contract DCDomainRank is ReentrancyGuard {

    uint256 public constant MAX_LEADERBOARD = 50;

    /// @dev 0=None 禁止广告充值；1=等比（每小时扣当前余额的 bps）；2=等差（固定每小时 wei）
    enum AdFeeMode {
        None,
        Proportional,
        Fixed
    }

    IERC20    public immutable dcToken;
    IDCDomain public immutable dcDomain;
    address   public owner;
    address   public treasury;

    uint256 public minDeposit = 50 ether;
    uint256 public baseHourlyRate = 500 ether;
    uint256 public depositRateBps = 1000;

    // ── 按 (域名, Deal, 商家) 粒度的充值记录 ──
    struct Player {
        uint256 depositedDC;
        uint256 totalConsumed;
        uint256 joinedAt;
        uint256 hourlyRate;
        bool    active;      // 有充值且余额>0
    }

    // domain -> deal -> merchant -> Player
    mapping(string => mapping(address => mapping(address => Player))) private _dealPlayers;

    struct DealMerchantEntry {
        address deal;
        address merchant;
    }
    mapping(string => DealMerchantEntry[]) private _domainEntries;
    mapping(string => mapping(address => mapping(address => bool))) private _entryInList;
    mapping(string => mapping(address => address)) private _merchantOfDeal;

    // domain -> deal -> merchant -> 最近 deposit 时间
    mapping(string => mapping(address => mapping(address => uint256))) private _lastDepositAt;
    mapping(string => mapping(address => mapping(address => uint256))) private _lastDepositAmount;
    mapping(string => mapping(address => mapping(address => uint256))) private _lastDepositBase;

    // ── 域名级状态 ──
    /// @dev visitor mapping is kept only for storage/layout and legacy event compatibility.
    mapping(string => mapping(address => bool)) private _visitorInDomain;
    mapping(string => mapping(address => bool)) private _blacklisted;
    /// @dev 与 _blacklisted 同步，供前端枚举；仅 setBlacklisted 维护
    mapping(string => address[]) private _blacklistEnumerate;
    /// @dev 地址在 _blacklistEnumerate[domain] 中的位置（1-based，0 表示不在列表中）
    mapping(string => mapping(address => uint256)) private _blacklistPos;

    uint256 public kickInactivitySeconds;

    // ── 全局域名总榜 ──
    mapping(address => bool) public isDealReporter;
    mapping(string  => uint256) public domainDealCount;
    string[] private _globalDomains;
    mapping(string  => bool) private _globalDomainExists;

    /// @dev 按域名累积、待域名 NFT 持有人提取的广告费（DL，与商家充值同一 token）
    mapping(string => uint256) private _holderRewardsPending;

    /// @dev 域名级广告费策略（默认 None，映射为 0）
    mapping(string => uint8) private _domainAdFeeMode;
    mapping(string => uint256) private _domainProportionalBpsPerHour;
    mapping(string => uint256) private _domainFixedHourlyRate;

    // ── 事件 ──
    event DealReporterSet(address indexed reporter, bool allowed);
    event DomainDealReported(string domain, address indexed deal, address indexed merchant, uint256 newCount);
    event Deposited(address indexed player, string domain, address indexed deal, uint256 amount);
    event Withdrawn(address indexed player, string domain, address indexed deal, uint256 remaining, uint256 consumed);
    event Consumed(address indexed player, string domain, address indexed deal, uint256 consumed, uint256 remaining);
    event LeaderboardUpdated(string domain);
    event AdRewardsAccrued(string domain, uint256 amount);
    event HolderAdRewardsWithdrawn(address indexed holder, string domain, uint256 amount);
    event VisitorEntered(address indexed user, string domain);
    event VisitorLeft(address indexed user, string domain);
    event VisitorKicked(address indexed user, string domain, address indexed kickedBy);
    event KickedInactiveDeal(string domain, address indexed deal, address indexed merchant, address indexed kicker);
    event DealAdClosed(
        string domain,
        address indexed deal,
        address indexed merchant,
        uint256 refunded,
        uint256 totalConsumed
    );
    event BlacklistedSet(string indexed domain, address indexed account, bool banned);
    event KickInactivitySecondsSet(uint256 seconds_);
    event DomainAdFeePolicySet(
        string domain,
        uint8 mode,
        uint256 proportionalBpsPerHour,
        uint256 fixedHourlyRateWei
    );

    constructor(address _dcToken, address _dcDomain, address _treasury) {
        require(_dcToken   != address(0), "ZERO_TOKEN");
        require(_dcDomain  != address(0), "ZERO_DOMAIN");
        require(_treasury  != address(0), "ZERO_TREASURY");
        dcToken  = IERC20(_dcToken);
        dcDomain = IDCDomain(_dcDomain);
        owner    = msg.sender;
        treasury = _treasury;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    function _domainOwner(string memory domainName) internal view returns (address) {
        uint256 tokenId = dcDomain.tokenIdOf(domainName);
        return dcDomain.ownerOf(tokenId);
    }

    // ═══════════════════════════════════════════
    // 域名用户：任何未被拉黑的地址都可参与
    // ═══════════════════════════════════════════

    function isMerchant(string memory domainName, address account) public view returns (bool) {
        if (!dcDomain.isRegistered(domainName)) return false;
        if (_blacklisted[domainName][account]) return false;
        return true;
    }

    function isActive(string calldata domainName, address playerAddr) external view returns (bool) {
        if (!dcDomain.isRegistered(domainName)) return false;
        return !_blacklisted[domainName][playerAddr];
    }

    // ═══════════════════════════════════════════
    // 访客 & 黑名单（域名级，不变）
    // ═══════════════════════════════════════════

    function setBlacklisted(string calldata domainName, address account, bool banned) external {
        require(dcDomain.isRegistered(domainName), "DCDomainRank: domain not registered");
        require(account != address(0), "ZERO_ACCOUNT");
        require(_domainOwner(domainName) == msg.sender, "DCDomainRank: not domain owner");
        if (banned) {
            require(account != msg.sender, "DCDomainRank: cannot blacklist self");
            if (!_blacklisted[domainName][account]) {
                _blacklisted[domainName][account] = true;
                _blacklistEnumerate[domainName].push(account);
                _blacklistPos[domainName][account] = _blacklistEnumerate[domainName].length;
            }
        } else {
            if (_blacklisted[domainName][account]) {
                _blacklisted[domainName][account] = false;
                uint256 len = _blacklistEnumerate[domainName].length;
                uint256 pos = _blacklistPos[domainName][account];
                address lastAddr = _blacklistEnumerate[domainName][len - 1];
                if (pos != len) {
                    _blacklistEnumerate[domainName][pos - 1] = lastAddr;
                    _blacklistPos[domainName][lastAddr] = pos;
                }
                _blacklistEnumerate[domainName].pop();
                _blacklistPos[domainName][account] = 0;
            }
        }
        emit BlacklistedSet(domainName, account, banned);
    }

    function isBlacklisted(string calldata domainName, address account) external view returns (bool) {
        return _blacklisted[domainName][account];
    }

    /// @notice 当前域名下拉黑地址数量（与 isBlacklisted 一致维护）
    function blacklistedCount(string calldata domainName) external view returns (uint256) {
        return _blacklistEnumerate[domainName].length;
    }

    /// @notice 当前域名下所有仍被拉黑的地址（顺序不保证稳定）
    function blacklistedAddresses(string calldata domainName) external view returns (address[] memory) {
        return _blacklistEnumerate[domainName];
    }

    function setKickInactivitySeconds(uint256 seconds_) external onlyOwner {
        kickInactivitySeconds = seconds_;
        emit KickInactivitySecondsSet(seconds_);
    }

    function enterDomain(string calldata domainName) external nonReentrant {
        require(dcDomain.isRegistered(domainName), "DCDomainRank: domain not registered");
        require(!_blacklisted[domainName][msg.sender], "DCDomainRank: blacklisted");
        emit VisitorEntered(msg.sender, domainName);
    }

    function leaveVisitor(string calldata domainName) external {
        require(dcDomain.isRegistered(domainName), "DCDomainRank: domain not registered");
        emit VisitorLeft(msg.sender, domainName);
    }

    /// @notice Legacy compatibility hook. Visitor status no longer affects domain permissions.
    function leaveVisitorFor(string calldata domainName, address visitor) external {
        require(isDealReporter[msg.sender], "DCDomainRank: not reporter");
        require(visitor != address(0), "ZERO_ACCOUNT");
        require(dcDomain.isRegistered(domainName), "DCDomainRank: domain not registered");
        emit VisitorLeft(visitor, domainName);
    }

    function isVisitorActive(string calldata domainName, address user) external pure returns (bool) {
        domainName;
        user;
        return false;
    }

    function kickVisitor(string calldata domainName, address visitor) external {
        require(dcDomain.isRegistered(domainName), "DCDomainRank: domain not registered");
        require(visitor != address(0), "ZERO_ACCOUNT");
        require(_domainOwner(domainName) == msg.sender, "DCDomainRank: not domain owner");
        emit VisitorKicked(visitor, domainName, msg.sender);
        emit VisitorLeft(visitor, domainName);
    }

    // ═══════════════════════════════════════════
    // 域名 NFT 持有人：待领广告费（结算先入本合约再提取）
    // ═══════════════════════════════════════════

    function pendingHolderRewards(string calldata domainName) external view returns (uint256) {
        return _holderRewardsPending[domainName];
    }

    /// @notice 域名 NFT 持有人提取本域名累积的广告费（DL）
    function withdraw(string calldata domainName) external nonReentrant {
        require(dcDomain.isRegistered(domainName), "DCDomainRank: domain not registered");
        require(_domainOwner(domainName) == msg.sender, "DCDomainRank: not domain owner");
        uint256 amount = _holderRewardsPending[domainName];
        require(amount > 0, "DCDomainRank: no rewards");
        _holderRewardsPending[domainName] = 0;
        require(dcToken.transfer(msg.sender, amount), "DCDomainRank: reward transfer failed");
        emit HolderAdRewardsWithdrawn(msg.sender, domainName, amount);
    }

    // ═══════════════════════════════════════════
    // 域名 NFT 持有人：广告费策略（默认 None）
    // ═══════════════════════════════════════════

    function getDomainAdFeePolicy(string calldata domainName)
        external
        view
        returns (uint8 mode, uint256 proportionalBpsPerHour, uint256 fixedHourlyRateWei)
    {
        mode = _domainAdFeeMode[domainName];
        proportionalBpsPerHour = _domainProportionalBpsPerHour[domainName];
        fixedHourlyRateWei = _domainFixedHourlyRate[domainName];
    }

    /// @notice 设置本域名广告费模式；仅域名 NFT 持有人可调用
    /// @param mode 0=None（禁止商家 deposit）1=等比 2=等差
    /// @param proportionalBpsPerHour 等比：每小时从当前余额扣除的比例（万分比），须 1..9999
    /// @param fixedHourlyRateWei 等差：每小时固定扣除的 DL（wei），mode=2 时须 >0
    function setDomainAdFeePolicy(
        string calldata domainName,
        uint8 mode,
        uint256 proportionalBpsPerHour,
        uint256 fixedHourlyRateWei
    ) external {
        require(dcDomain.isRegistered(domainName), "DCDomainRank: domain not registered");
        require(_domainOwner(domainName) == msg.sender, "DCDomainRank: not domain owner");
        require(mode <= uint8(AdFeeMode.Fixed), "DCDomainRank: bad mode");

        if (mode == uint8(AdFeeMode.None)) {
            _domainAdFeeMode[domainName] = mode;
            _domainProportionalBpsPerHour[domainName] = 0;
            _domainFixedHourlyRate[domainName] = 0;
        } else if (mode == uint8(AdFeeMode.Proportional)) {
            require(
                proportionalBpsPerHour > 0 && proportionalBpsPerHour < 10000,
                "DCDomainRank: proportional bps"
            );
            _domainAdFeeMode[domainName] = mode;
            _domainProportionalBpsPerHour[domainName] = proportionalBpsPerHour;
            _domainFixedHourlyRate[domainName] = 0;
        } else {
            require(fixedHourlyRateWei > 0, "DCDomainRank: fixed rate");
            _domainAdFeeMode[domainName] = mode;
            _domainProportionalBpsPerHour[domainName] = 0;
            _domainFixedHourlyRate[domainName] = fixedHourlyRateWei;
        }

        emit DomainAdFeePolicySet(domainName, mode, proportionalBpsPerHour, fixedHourlyRateWei);
    }

    // ═══════════════════════════════════════════
    // 按交易（Deal）充值 / 提取 / 结算
    // ═══════════════════════════════════════════

    function _calcHourlyRate(uint256 depositAmount) internal view returns (uint256) {
        return baseHourlyRate + (depositAmount * depositRateBps / 10000);
    }

    /// @dev 连续 H 个计费小时后的余额：每小时末余额乘 (1 - bps/10000)
    function _balanceAfterProportionalHours(uint256 balance, uint256 bpsPerHour, uint256 fullHours)
        internal
        pure
        returns (uint256)
    {
        if (fullHours == 0 || balance == 0) return balance;
        uint256 factor = 1e18;
        uint256 base = Math.mulDiv(10_000 - bpsPerHour, 1e18, 10_000);
        uint256 exp = fullHours;
        while (exp > 0) {
            if (exp & 1 == 1) {
                factor = Math.mulDiv(factor, base, 1e18);
            }
            base = Math.mulDiv(base, base, 1e18);
            exp >>= 1;
        }
        return Math.mulDiv(balance, factor, 1e18);
    }

    function _billingTimestamp(address deal) internal view returns (uint256) {
        (bool ok, uint8 s, uint64 ended) = _dealStatus(deal);
        if (ok && s >= 3 && ended != 0) return ended;
        return block.timestamp;
    }

    function _pendingConsumeDeal(string memory domainName, address deal, Player storage p) internal view returns (uint256) {
        if (!p.active || p.depositedDC == 0) return 0;
        uint256 chargeUntil = _billingTimestamp(deal);
        if (p.joinedAt == 0 || chargeUntil <= p.joinedAt) return 0;

        uint8 mode = _domainAdFeeMode[domainName];
        if (mode == uint8(AdFeeMode.None)) return 0;

        uint256 elapsed = chargeUntil - p.joinedAt;

        if (mode == uint8(AdFeeMode.Fixed)) {
            uint256 rate = _domainFixedHourlyRate[domainName];
            if (rate == 0) return 0;
            uint256 due = (elapsed * rate + 3599) / 3600;
            return due > p.depositedDC ? p.depositedDC : due;
        }

        uint256 H = (elapsed + 3599) / 3600;
        if (H == 0) return 0;

        uint256 bps = _domainProportionalBpsPerHour[domainName];
        if (bps == 0 || bps >= 10_000) return 0;
        uint256 afterB = _balanceAfterProportionalHours(p.depositedDC, bps, H);
        return p.depositedDC - afterB;
    }

    function _settleDeal(string memory domainName, address deal, address merchantAddr) internal returns (bool changed) {
        Player storage p = _dealPlayers[domainName][deal][merchantAddr];
        if (!p.active) return false;

        uint256 consume = _pendingConsumeDeal(domainName, deal, p);
        if (consume > 0) {
            p.depositedDC -= consume;
            p.totalConsumed += consume;
            changed = true;

            _holderRewardsPending[domainName] += consume;
            emit AdRewardsAccrued(domainName, consume);

            if (p.depositedDC == 0) {
                p.joinedAt = block.timestamp;
                p.active = false;
                emit Consumed(merchantAddr, domainName, deal, consume, 0);
                emit Withdrawn(merchantAddr, domainName, deal, 0, p.totalConsumed);
            } else {
                p.joinedAt = block.timestamp;
                emit Consumed(merchantAddr, domainName, deal, consume, p.depositedDC);
            }
        }
    }

    function _dealStatus(address deal) internal view returns (bool ok, uint8 s, uint64 ended) {
        try IDealStatusView(deal).status() returns (uint8 status_) {
            ok = true;
            s = status_;
            try IDealStatusView(deal).endedAt() returns (uint64 ended_) {
                ended = ended_;
            } catch {}
            return (ok, s, ended);
        } catch {
            return (false, 0, 0);
        }
    }

    function _isDealOpenForLeaderboard(address deal) internal view returns (bool) {
        (bool ok, uint8 s, ) = _dealStatus(deal);
        return !ok || s < 3; // Ready, Active, Locked；未知状态按兼容旧合约处理为可见
    }

    function _isDealTerminal(address deal) internal view returns (bool) {
        (bool ok, uint8 s, ) = _dealStatus(deal);
        return ok && s >= 3;
    }

    /// @notice 为某笔交易充值（可选，充了才扣小时费）
    function deposit(string calldata domainName, address deal, uint256 amount) external nonReentrant {
        require(deal != address(0), "DCDomainRank: zero deal");
        require(dcDomain.isRegistered(domainName), "DCDomainRank: domain not registered");
        require(_domainAdFeeMode[domainName] != uint8(AdFeeMode.None), "DCDomainRank: ad fees disabled");
        require(!_blacklisted[domainName][msg.sender], "DCDomainRank: blacklisted");
        require(amount >= minDeposit, "DCDomainRank: below minDeposit");
        require(_entryInList[domainName][deal][msg.sender], "DCDomainRank: deal not reported");
        require(_isDealOpenForLeaderboard(deal), "DCDomainRank: deal closed");

        _settleDeal(domainName, deal, msg.sender);

        Player storage p = _dealPlayers[domainName][deal][msg.sender];

        require(dcToken.transferFrom(msg.sender, address(this), amount), "DCDomainRank: transfer failed");

        p.depositedDC += amount;
        p.active       = true;
        p.joinedAt     = block.timestamp;

        uint8 mode = _domainAdFeeMode[domainName];
        if (mode == uint8(AdFeeMode.Fixed)) {
            p.hourlyRate = _domainFixedHourlyRate[domainName];
        } else if (mode == uint8(AdFeeMode.Proportional)) {
            uint256 bps = _domainProportionalBpsPerHour[domainName];
            p.hourlyRate = Math.mulDiv(p.depositedDC, bps, 10_000);
        } else {
            p.hourlyRate = 0;
        }

        _lastDepositAt[domainName][deal][msg.sender] = block.timestamp;
        _lastDepositAmount[domainName][deal][msg.sender] = amount;
        _lastDepositBase[domainName][deal][msg.sender] = p.depositedDC;

        emit Deposited(msg.sender, domainName, deal, amount);
        emit LeaderboardUpdated(domainName);
    }

    /// @notice 从某笔交易提取剩余充值
    function withdraw(string calldata domainName, address deal) external nonReentrant {
        Player storage p = _dealPlayers[domainName][deal][msg.sender];
        require(p.active || p.depositedDC > 0, "DCDomainRank: nothing to withdraw");

        _settleDeal(domainName, deal, msg.sender);

        uint256 remaining = p.depositedDC;
        p.depositedDC = 0;
        p.active      = false;

        if (remaining > 0) {
            require(dcToken.transfer(msg.sender, remaining), "DCDomainRank: refund failed");
        }

        emit Withdrawn(msg.sender, domainName, deal, remaining, p.totalConsumed);
        emit LeaderboardUpdated(domainName);
    }

    /// @notice 触发某笔交易的结算
    function settle(string calldata domainName, address deal, address merchantAddr)
        external
        nonReentrant
        returns (uint256 remaining, uint256 consumed)
    {
        Player storage p = _dealPlayers[domainName][deal][merchantAddr];
        uint256 before_ = p.depositedDC;

        bool changed = _settleDeal(domainName, deal, merchantAddr);

        remaining = p.depositedDC;
        consumed  = before_ - remaining;

        if (changed) emit LeaderboardUpdated(domainName);
    }

    /// @notice 交易终局后，任何人都可触发广告位结算并把未消耗余额退回原充值商家。
    function closeDeal(string calldata domainName, address deal)
        external
        nonReentrant
        returns (uint256 refunded, uint256 consumed)
    {
        address merchantAddr = _merchantOfDeal[domainName][deal];
        require(merchantAddr != address(0), "DCDomainRank: deal not reported");
        require(_isDealTerminal(deal), "DCDomainRank: deal not closed");

        Player storage p = _dealPlayers[domainName][deal][merchantAddr];
        uint256 before_ = p.depositedDC;

        _settleDeal(domainName, deal, merchantAddr);

        refunded = p.depositedDC;
        consumed = before_ - refunded;
        p.depositedDC = 0;
        p.active = false;

        if (refunded > 0) {
            require(dcToken.transfer(merchantAddr, refunded), "DCDomainRank: refund failed");
        }

        emit Withdrawn(merchantAddr, domainName, deal, refunded, p.totalConsumed);
        emit DealAdClosed(domainName, deal, merchantAddr, refunded, p.totalConsumed);
        emit LeaderboardUpdated(domainName);
    }

    // ═══════════════════════════════════════════
    // 域名内排行榜：按每笔交易的 totalConsumed 排序
    // ═══════════════════════════════════════════

    function _getDealScore(string memory domainName, address deal, address merchantAddr) internal view returns (uint256) {
        Player storage p = _dealPlayers[domainName][deal][merchantAddr];
        return p.totalConsumed + _pendingConsumeDeal(domainName, deal, p);
    }

    function rawDomainEntryCount(string calldata domainName) external view returns (uint256) {
        return _domainEntries[domainName].length;
    }

    function domainEntryAt(string calldata domainName, uint256 index)
        external
        view
        returns (address deal, address merchant)
    {
        DealMerchantEntry storage entry = _domainEntries[domainName][index];
        return (entry.deal, entry.merchant);
    }

    function dealScoreOf(string calldata domainName, address deal, address merchantAddr) external view returns (uint256) {
        return _getDealScore(domainName, deal, merchantAddr);
    }

    function isDealVisible(string calldata domainName, address deal, address merchantAddr) external view returns (bool) {
        return _isDealOpenForLeaderboard(deal) && !_blacklisted[domainName][merchantAddr];
    }

    // ═══════════════════════════════════════════
    // 查询
    // ═══════════════════════════════════════════

    function _myDealStatusView(string memory domainName, address deal, address merchant)
        internal
        view
        returns (
            uint256 depositedDC,
            uint256 pendingConsume,
            uint256 totalConsumed,
            bool    active,
            uint256 hoursRemaining,
            uint256 hourlyRate,
            uint256 percent,
            uint256 lastDepositAmount_
        )
    {
        Player storage p = _dealPlayers[domainName][deal][merchant];
        uint256 pending = _pendingConsumeDeal(domainName, deal, p);
        uint256 realBal = p.depositedDC > pending ? p.depositedDC - pending : 0;
        uint256 base = _lastDepositBase[domainName][deal][merchant];

        depositedDC = realBal;
        pendingConsume = pending;
        totalConsumed = p.totalConsumed + pending;
        active = p.active && realBal > 0;
        hourlyRate = p.hourlyRate;

        uint8 mode = _domainAdFeeMode[domainName];
        if (mode == uint8(AdFeeMode.Fixed) && p.hourlyRate > 0) {
            hoursRemaining = realBal / p.hourlyRate;
        } else if (mode == uint8(AdFeeMode.Proportional)) {
            uint256 bps = _domainProportionalBpsPerHour[domainName];
            uint256 nominal = bps > 0 ? Math.mulDiv(realBal, bps, 10_000) : 0;
            hoursRemaining = nominal > 0 ? realBal / nominal : type(uint256).max;
        } else {
            hoursRemaining = 0;
        }
        percent = base == 0 || realBal == 0 ? 0 : (realBal >= base ? 100 : (realBal * 100) / base);
        lastDepositAmount_ = _lastDepositAmount[domainName][deal][merchant];
    }

    /// @notice 查询「当前调用者」作为商家时的充值状态（链下 eth_call 若未设置 from 则 msg.sender 为零地址，请优先用 myDealStatusOf）
    function myDealStatus(string calldata domainName, address deal)
        external
        view
        returns (
            uint256 depositedDC,
            uint256 pendingConsume,
            uint256 totalConsumed,
            bool    active,
            uint256 hoursRemaining,
            uint256 hourlyRate,
            uint256 percent,
            uint256 lastDepositAmount_
        )
    {
        return _myDealStatusView(domainName, deal, msg.sender);
    }

    /// @notice 查询指定商家地址的充值状态（推荐前端 / 索引器使用，不依赖 msg.sender）
    function myDealStatusOf(string calldata domainName, address deal, address merchant)
        external
        view
        returns (
            uint256 depositedDC,
            uint256 pendingConsume,
            uint256 totalConsumed,
            bool    active,
            uint256 hoursRemaining,
            uint256 hourlyRate,
            uint256 percent,
            uint256 lastDepositAmount_
        )
    {
        return _myDealStatusView(domainName, deal, merchant);
    }

    function merchantOfDeal(string calldata domainName, address deal) external view returns (address) {
        return _merchantOfDeal[domainName][deal];
    }

    function lastDepositAt(string calldata domainName, address deal, address merchant_) external view returns (uint256) {
        return _lastDepositAt[domainName][deal][merchant_];
    }

    function lastDepositAmount(string calldata domainName, address deal, address merchant_) external view returns (uint256) {
        return _lastDepositAmount[domainName][deal][merchant_];
    }

    function depositPercent(string calldata domainName, address deal, address merchant_) external view returns (uint256) {
        Player storage p = _dealPlayers[domainName][deal][merchant_];
        uint256 pending = _pendingConsumeDeal(domainName, deal, p);
        uint256 realBal = p.depositedDC > pending ? p.depositedDC - pending : 0;
        uint256 base = _lastDepositBase[domainName][deal][merchant_];
        if (base == 0 || realBal == 0) return 0;
        return realBal >= base ? 100 : (realBal * 100) / base;
    }

    function isParticipant(string calldata domainName, address user) external view returns (bool) {
        if (!dcDomain.isRegistered(domainName)) return false;
        return user != address(0) && !_blacklisted[domainName][user];
    }

    // ═══════════════════════════════════════════
    // 踢超时未充值的交易条目
    // ═══════════════════════════════════════════

    function kickInactiveDeal(string calldata domainName, address deal, address target) external nonReentrant {
        require(kickInactivitySeconds > 0, "DCDomainRank: kick window off");
        require(dcDomain.isRegistered(domainName), "DCDomainRank: domain not registered");
        require(target != address(0) && target != msg.sender, "DCDomainRank: bad target");
        require(
            _domainOwner(domainName) == msg.sender,
            "DCDomainRank: not domain owner"
        );

        Player storage p = _dealPlayers[domainName][deal][target];
        require(p.active && p.depositedDC > 0, "DCDomainRank: target deal not active");

        uint256 last = _lastDepositAt[domainName][deal][target];
        require(last > 0, "DCDomainRank: no deposit clock");
        require(block.timestamp - last >= kickInactivitySeconds, "DCDomainRank: still within window");

        _settleDeal(domainName, deal, target);

        uint256 remaining = p.depositedDC;
        p.depositedDC = 0;
        p.active = false;

        if (remaining > 0) {
            require(dcToken.transfer(target, remaining), "DCDomainRank: kick refund failed");
        }

        emit KickedInactiveDeal(domainName, deal, target, msg.sender);
        emit Withdrawn(target, domainName, deal, remaining, p.totalConsumed);
        emit LeaderboardUpdated(domainName);
    }

    // ═══════════════════════════════════════════
    // 全局域名总榜 + 交易上报
    // ═══════════════════════════════════════════

    function setDealReporter(address reporter, bool allowed) external onlyOwner {
        require(reporter != address(0), "ZERO_REPORTER");
        isDealReporter[reporter] = allowed;
        emit DealReporterSet(reporter, allowed);
    }

    /// @notice 创建交易时由 DCDomainSwap / DCDomainHall 调用，自动在排行榜注册条目
    function reportDeal(string calldata domainName, address deal, address merchant_) external {
        require(isDealReporter[msg.sender], "DCDomainRank: not reporter");
        require(deal != address(0) && merchant_ != address(0), "DCDomainRank: zero addr");

        domainDealCount[domainName]++;

        if (!_entryInList[domainName][deal][merchant_]) {
            _domainEntries[domainName].push(DealMerchantEntry({deal: deal, merchant: merchant_}));
            _entryInList[domainName][deal][merchant_] = true;
            if (_merchantOfDeal[domainName][deal] == address(0)) {
                _merchantOfDeal[domainName][deal] = merchant_;
            }
        }

        if (!_globalDomainExists[domainName]) {
            _globalDomains.push(domainName);
            _globalDomainExists[domainName] = true;
        }
        emit DomainDealReported(domainName, deal, merchant_, domainDealCount[domainName]);
    }

    function globalDomainCount() external view returns (uint256) {
        return _globalDomains.length;
    }

    function getGlobalLeaderboard(uint256 limit)
        external
        view
        returns (string[] memory domains, uint256[] memory counts)
    {
        require(limit > 0 && limit <= MAX_LEADERBOARD, "DCDomainRank: limit 1-50");
        uint256 total = _globalDomains.length;
        if (total == 0) return (new string[](0), new uint256[](0));

        string[]  memory allDomains = new string[](total);
        uint256[] memory allCounts  = new uint256[](total);
        for (uint256 i; i < total; i++) {
            allDomains[i] = _globalDomains[i];
            allCounts[i]  = domainDealCount[_globalDomains[i]];
        }

        uint256 n = total < limit ? total : limit;
        for (uint256 i; i < n; i++) {
            for (uint256 j = i + 1; j < total; j++) {
                if (allCounts[j] > allCounts[i]) {
                    (allCounts[i], allCounts[j]) = (allCounts[j], allCounts[i]);
                    (allDomains[i], allDomains[j]) = (allDomains[j], allDomains[i]);
                }
            }
        }

        domains = new string[](n);
        counts  = new uint256[](n);
        for (uint256 i; i < n; i++) {
            domains[i] = allDomains[i];
            counts[i]  = allCounts[i];
        }
    }

    // ═══════════════════════════════════════════
    // 管理
    // ═══════════════════════════════════════════

    function previewHourlyRate(uint256 depositAmount) external view returns (uint256) {
        return _calcHourlyRate(depositAmount);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "ZERO_TREASURY");
        treasury = newTreasury;
    }

    function setMinDeposit(uint256 newMin) external onlyOwner {
        require(newMin > 0, "DCDomainRank: zero minDeposit");
        minDeposit = newMin;
    }

    function setBaseHourlyRate(uint256 newRate) external onlyOwner {
        require(newRate > 0, "DCDomainRank: zero rate");
        baseHourlyRate = newRate;
    }

    function setDepositRateBps(uint256 newBps) external onlyOwner {
        require(newBps <= 10000, "DCDomainRank: bps > 100%");
        depositRateBps = newBps;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");
        owner = newOwner;
    }
}
