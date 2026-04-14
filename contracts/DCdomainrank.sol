// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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

/**
 * @title DCDomainRank
 * @notice 任何人都可以成为商家、发布合同，无需白名单/充值。
 *         排行榜按「每笔交易（Deal）的消耗」排序，一个商家可有 N 条上榜。
 *         充值可选：有充值才扣小时费，没充值则该条目分数为 0。
 *         访客系统不变：未发布合同的普通用户可 enterDomain 进入域名。
 */
contract DCDomainRank is ReentrancyGuard {

    uint256 public constant MAX_LEADERBOARD = 50;

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

    // domain -> deal -> merchant -> 最近 deposit 时间
    mapping(string => mapping(address => mapping(address => uint256))) private _lastDepositAt;
    mapping(string => mapping(address => mapping(address => uint256))) private _lastDepositAmount;
    mapping(string => mapping(address => mapping(address => uint256))) private _lastDepositBase;

    // ── 域名级状态 ──
    mapping(string => mapping(address => bool)) private _visitorInDomain;
    mapping(string => mapping(address => bool)) private _blacklisted;

    uint256 public kickInactivitySeconds;

    // ── 全局域名总榜 ──
    mapping(address => bool) public isDealReporter;
    mapping(string  => uint256) public domainDealCount;
    string[] private _globalDomains;
    mapping(string  => bool) private _globalDomainExists;

    // ── 事件 ──
    event DealReporterSet(address indexed reporter, bool allowed);
    event DomainDealReported(string domain, address indexed deal, address indexed merchant, uint256 newCount);
    event Deposited(address indexed player, string domain, address indexed deal, uint256 amount);
    event Withdrawn(address indexed player, string domain, address indexed deal, uint256 remaining, uint256 consumed);
    event Consumed(address indexed player, string domain, address indexed deal, uint256 consumed, uint256 remaining);
    event LeaderboardUpdated(string domain);
    event HourlyFeeToHolder(address indexed holder, uint256 amount, string domain);
    event VisitorEntered(address indexed user, string domain);
    event VisitorLeft(address indexed user, string domain);
    event VisitorKicked(address indexed user, string domain, address indexed kickedBy);
    event KickedInactiveDeal(string domain, address indexed deal, address indexed merchant, address indexed kicker);
    event BlacklistedSet(string indexed domain, address indexed account, bool banned);
    event KickInactivitySecondsSet(uint256 seconds_);

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
    // 商家：任何人都是商家（无需白名单）
    // ═══════════════════════════════════════════

    function isMerchant(string memory domainName, address account) public view returns (bool) {
        if (!dcDomain.isRegistered(domainName)) return false;
        if (_blacklisted[domainName][account]) return false;
        if (_visitorInDomain[domainName][account]) return false;
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
        _blacklisted[domainName][account] = banned;
        emit BlacklistedSet(domainName, account, banned);
    }

    function isBlacklisted(string calldata domainName, address account) external view returns (bool) {
        return _blacklisted[domainName][account];
    }

    function setKickInactivitySeconds(uint256 seconds_) external onlyOwner {
        kickInactivitySeconds = seconds_;
        emit KickInactivitySecondsSet(seconds_);
    }

    function enterDomain(string calldata domainName) external nonReentrant {
        require(dcDomain.isRegistered(domainName), "DCDomainRank: domain not registered");
        require(!_blacklisted[domainName][msg.sender], "DCDomainRank: blacklisted");
        require(!_visitorInDomain[domainName][msg.sender], "DCDomainRank: already visitor");
        _visitorInDomain[domainName][msg.sender] = true;
        emit VisitorEntered(msg.sender, domainName);
    }

    function leaveVisitor(string calldata domainName) external {
        require(_visitorInDomain[domainName][msg.sender], "DCDomainRank: not visitor");
        _visitorInDomain[domainName][msg.sender] = false;
        emit VisitorLeft(msg.sender, domainName);
    }

    function isVisitorActive(string calldata domainName, address user) external view returns (bool) {
        return _visitorInDomain[domainName][user];
    }

    function kickVisitor(string calldata domainName, address visitor) external {
        require(dcDomain.isRegistered(domainName), "DCDomainRank: domain not registered");
        require(visitor != address(0), "ZERO_ACCOUNT");
        require(_domainOwner(domainName) == msg.sender, "DCDomainRank: not domain owner");
        require(_visitorInDomain[domainName][visitor], "DCDomainRank: not visitor");
        _visitorInDomain[domainName][visitor] = false;
        emit VisitorKicked(visitor, domainName, msg.sender);
        emit VisitorLeft(visitor, domainName);
    }

    // ═══════════════════════════════════════════
    // 按交易（Deal）充值 / 提取 / 结算
    // ═══════════════════════════════════════════

    function _calcHourlyRate(uint256 depositAmount) internal view returns (uint256) {
        return baseHourlyRate + (depositAmount * depositRateBps / 10000);
    }

    function _pendingConsumeDeal(Player storage p) internal view returns (uint256) {
        if (!p.active || p.depositedDC == 0) return 0;
        if (p.hourlyRate == 0) return 0;
        if (p.joinedAt == 0 || block.timestamp <= p.joinedAt) return 0;
        uint256 elapsed = block.timestamp - p.joinedAt;
        uint256 due = (elapsed * p.hourlyRate + 3599) / 3600;
        return due > p.depositedDC ? p.depositedDC : due;
    }

    function _settleDeal(string memory domainName, address deal, address merchantAddr) internal returns (bool changed) {
        Player storage p = _dealPlayers[domainName][deal][merchantAddr];
        if (!p.active) return false;
        if (p.hourlyRate == 0) return false;

        uint256 consume = _pendingConsumeDeal(p);
        if (consume > 0) {
            p.depositedDC   -= consume;
            p.totalConsumed += consume;
            changed = true;

            address holder = _domainOwner(domainName);
            require(dcToken.transfer(holder, consume), "DCDomainRank: holder transfer failed");
            emit HourlyFeeToHolder(holder, consume, domainName);

            if (p.depositedDC == 0) {
                uint256 secondsUsed = (consume * 3600) / p.hourlyRate;
                p.joinedAt = p.joinedAt + secondsUsed;
                p.active   = false;
                emit Consumed(merchantAddr, domainName, deal, consume, 0);
                emit Withdrawn(merchantAddr, domainName, deal, 0, p.totalConsumed);
            } else {
                p.joinedAt = block.timestamp;
                emit Consumed(merchantAddr, domainName, deal, consume, p.depositedDC);
            }
        }
    }

    /// @notice 为某笔交易充值（可选，充了才扣小时费）
    function deposit(string calldata domainName, address deal, uint256 amount) external nonReentrant {
        require(deal != address(0), "DCDomainRank: zero deal");
        require(dcDomain.isRegistered(domainName), "DCDomainRank: domain not registered");
        require(!_blacklisted[domainName][msg.sender], "DCDomainRank: blacklisted");
        require(!_visitorInDomain[domainName][msg.sender], "DCDomainRank: visitors cannot deposit");
        require(amount >= minDeposit, "DCDomainRank: below minDeposit");

        _settleDeal(domainName, deal, msg.sender);

        Player storage p = _dealPlayers[domainName][deal][msg.sender];

        require(dcToken.transferFrom(msg.sender, address(this), amount), "DCDomainRank: transfer failed");

        p.depositedDC += amount;
        p.active       = true;
        p.joinedAt     = block.timestamp;
        p.hourlyRate   = _calcHourlyRate(p.depositedDC);

        if (!_entryInList[domainName][deal][msg.sender]) {
            _domainEntries[domainName].push(DealMerchantEntry({deal: deal, merchant: msg.sender}));
            _entryInList[domainName][deal][msg.sender] = true;
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

    // ═══════════════════════════════════════════
    // 域名内排行榜：按每笔交易的 totalConsumed 排序
    // ═══════════════════════════════════════════

    function _getDealScore(string memory domainName, address deal, address merchantAddr) internal view returns (uint256) {
        Player storage p = _dealPlayers[domainName][deal][merchantAddr];
        return p.totalConsumed + _pendingConsumeDeal(p);
    }

    struct LeaderboardEntry {
        address merchant;
        address deal;
        uint256 score;
    }

    /// @notice 域名内排行榜：前 limit 条 (商家, 交易, 消耗额)，包含 0 分条目
    function getLeaderboard(string calldata domainName, uint256 limit)
        external
        view
        returns (LeaderboardEntry[] memory entries)
    {
        require(limit > 0 && limit <= MAX_LEADERBOARD, "DCDomainRank: limit 1-50");

        DealMerchantEntry[] storage all = _domainEntries[domainName];
        uint256 total = all.length;
        if (total == 0) return new LeaderboardEntry[](0);

        LeaderboardEntry[] memory buf = new LeaderboardEntry[](total);
        for (uint256 i; i < total; i++) {
            buf[i] = LeaderboardEntry({
                merchant: all[i].merchant,
                deal:     all[i].deal,
                score:    _getDealScore(domainName, all[i].deal, all[i].merchant)
            });
        }

        uint256 n = total < limit ? total : limit;
        for (uint256 i; i < n; i++) {
            for (uint256 j = i + 1; j < total; j++) {
                if (buf[j].score > buf[i].score) {
                    (buf[i], buf[j]) = (buf[j], buf[i]);
                }
            }
        }

        entries = new LeaderboardEntry[](n);
        for (uint256 i; i < n; i++) {
            entries[i] = buf[i];
        }
    }

    /// @notice 域名内总条目数
    function domainEntryCount(string calldata domainName) external view returns (uint256) {
        return _domainEntries[domainName].length;
    }

    // ═══════════════════════════════════════════
    // 查询
    // ═══════════════════════════════════════════

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
        Player storage p = _dealPlayers[domainName][deal][msg.sender];
        uint256 pending = _pendingConsumeDeal(p);
        uint256 realBal = p.depositedDC > pending ? p.depositedDC - pending : 0;
        uint256 base = _lastDepositBase[domainName][deal][msg.sender];

        depositedDC    = realBal;
        pendingConsume = pending;
        totalConsumed  = p.totalConsumed + pending;
        active         = p.active && realBal > 0;
        hoursRemaining = p.hourlyRate > 0 ? realBal / p.hourlyRate : 0;
        hourlyRate     = p.hourlyRate;
        percent        = base == 0 || realBal == 0 ? 0 : (realBal >= base ? 100 : (realBal * 100) / base);
        lastDepositAmount_ = _lastDepositAmount[domainName][deal][msg.sender];
    }

    function lastDepositAt(string calldata domainName, address deal, address merchant_) external view returns (uint256) {
        return _lastDepositAt[domainName][deal][merchant_];
    }

    function lastDepositAmount(string calldata domainName, address deal, address merchant_) external view returns (uint256) {
        return _lastDepositAmount[domainName][deal][merchant_];
    }

    function depositPercent(string calldata domainName, address deal, address merchant_) external view returns (uint256) {
        Player storage p = _dealPlayers[domainName][deal][merchant_];
        uint256 pending = _pendingConsumeDeal(p);
        uint256 realBal = p.depositedDC > pending ? p.depositedDC - pending : 0;
        uint256 base = _lastDepositBase[domainName][deal][merchant_];
        if (base == 0 || realBal == 0) return 0;
        return realBal >= base ? 100 : (realBal * 100) / base;
    }

    function isParticipant(string calldata domainName, address user) external view returns (bool) {
        if (!dcDomain.isRegistered(domainName)) return false;
        uint256 tokenId = dcDomain.tokenIdOf(domainName);
        if (dcDomain.ownerOf(tokenId) == user) return true;
        if (_visitorInDomain[domainName][user]) return true;
        return false;
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
