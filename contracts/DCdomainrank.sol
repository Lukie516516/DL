// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

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
 *         广告费由域名 NFT 持有人配置固定时费（wei/小时），0 表示关闭广告充值。
 */
contract DCDomainRank is Initializable, OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_LEADERBOARD = 50;

    /// @dev 0=None 禁止广告充值；1=等比（每小时扣当前余额的 bps）；2=等差（固定每小时 wei）
    IERC20    public dcToken;
    IDCDomain public dcDomain;
    address   public treasury;
    address   public autoCloser;

    uint256 public minDeposit = 50 ether;
    uint256 public baseHourlyRate = 500 ether;
    uint256 public depositRateBps = 1000;

    uint256 public constant MAX_PROTOCOL_FEE_BPS = 5000; // 50% hard cap
    uint256 public protocolFeeBps = 0;                   // default: 100% to domain holder

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
    mapping(string => mapping(address => bool)) private _dealAdClosed;

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
    mapping(string  => uint256) public domainTradeVolume;
    mapping(string => mapping(address => uint256)) private _reportedDealVolume;
    mapping(string => mapping(address => bool)) private _dealTradeVolumeCounted;
    string[] private _globalDomains;
    mapping(string  => bool) private _globalDomainExists;

    /// @dev 按域名累积、待域名 NFT 持有人提取的广告费（DC，与商家充值同一 token）
    mapping(string => uint256) private _holderRewardsPending;

    /// @dev 域名固定时费（wei/小时），0 = 关闭广告
    mapping(string => uint256) private _domainFixedHourlyRate;

    /// @dev 域名最低充值金额（wei），由域名商自行设置
    mapping(string => uint256) private _domainMinDeposit;

    // Top domains by trade volume — min-heap of size ≤ MAX_LEADERBOARD
    // Heap root (_topDomainIds[0]) = token with LOWEST volume among top-N (easiest to evict)
    uint256[] private _topDomainIds;                     // min-heap array, max MAX_LEADERBOARD entries
    mapping(uint256 => uint256) private _topDomainIdPos; // tokenId → 1-based index in _topDomainIds, 0 = not in heap
    mapping(uint256 => uint256) private _topDomainVol;   // tokenId → cached domainTradeVolume

    // ── 事件 ──
    event DealReporterSet(address indexed reporter, bool allowed);
    event DomainDealReported(string domain, address indexed deal, address indexed merchant, uint256 newCount);
    event DomainTradeVolumeAdded(string domain, address indexed deal, uint256 volume, uint256 totalVolume);
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
    event AutoCloserSet(address indexed closer);
    event ProtocolFeeBpsSet(uint256 oldBps, uint256 newBps);
    event DomainHourlyRateSet(string domain, uint256 rateWei);
    event DomainMinDepositSet(string domain, uint256 minDeposit);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _dcToken, address _dcDomain, address _treasury) external initializer {
        require(_dcToken   != address(0), "ZERO_TOKEN");
        require(_dcDomain  != address(0), "ZERO_DOMAIN");
        require(_treasury  != address(0), "ZERO_TREASURY");
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        dcToken  = IERC20(_dcToken);
        dcDomain = IDCDomain(_dcDomain);
        treasury = _treasury;
        // Storage defaults: state-variable initializers don't apply through proxy
        minDeposit      = 50 ether;
        baseHourlyRate  = 500 ether;
        depositRateBps  = 1000;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

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

    /// @notice 域名 NFT 持有人提取本域名累积的广告费（DC）
    function withdraw(string calldata domainName) external nonReentrant {
        require(dcDomain.isRegistered(domainName), "DCDomainRank: domain not registered");
        require(_domainOwner(domainName) == msg.sender, "DCDomainRank: not domain owner");
        uint256 amount = _holderRewardsPending[domainName];
        require(amount > 0, "DCDomainRank: no rewards");
        _holderRewardsPending[domainName] = 0;

        uint256 protocolCut = protocolFeeBps > 0 ? (amount * protocolFeeBps) / 10000 : 0;
        uint256 holderGet = amount - protocolCut;

        if (protocolCut > 0) dcToken.safeTransfer(treasury, protocolCut);
        dcToken.safeTransfer(msg.sender, holderGet);
        emit HolderAdRewardsWithdrawn(msg.sender, domainName, holderGet);
    }

    // ═══════════════════════════════════════════
    // 域名 NFT 持有人：广告时费设置（0 = 关闭）
    // ═══════════════════════════════════════════

    function getDomainHourlyRate(string calldata domainName) external view returns (uint256 rateWei) {
        return _domainFixedHourlyRate[domainName];
    }

    /// @notice 设置本域名每小时广告费（wei）；0 = 关闭广告充值。仅域名 NFT 持有人可调用。
    function setDomainHourlyRate(string calldata domainName, uint256 rateWei) external {
        require(dcDomain.isRegistered(domainName), "DCDomainRank: domain not registered");
        require(_domainOwner(domainName) == msg.sender, "DCDomainRank: not domain owner");
        _domainFixedHourlyRate[domainName] = rateWei;
        emit DomainHourlyRateSet(domainName, rateWei);
    }

    /// @notice 设置本域名最低充值金额（wei）；仅域名 NFT 持有人可调用。
    function setDomainMinDeposit(string calldata domainName, uint256 minDepositWei) external {
        require(dcDomain.isRegistered(domainName), "DCDomainRank: domain not registered");
        require(_domainOwner(domainName) == msg.sender, "DCDomainRank: not domain owner");
        _domainMinDeposit[domainName] = minDepositWei;
        emit DomainMinDepositSet(domainName, minDepositWei);
    }

    function getDomainMinDeposit(string calldata domainName) external view returns (uint256) {
        return _domainMinDeposit[domainName];
    }

    // ═══════════════════════════════════════════
    // 按交易（Deal）充值 / 提取 / 结算
    // ═══════════════════════════════════════════

    function _calcHourlyRate(uint256 depositAmount) internal view returns (uint256) {
        return baseHourlyRate + (depositAmount * depositRateBps / 10000);
    }

function _pendingConsumeDeal(string memory domainName, address deal, Player storage p) internal view returns (uint256) {
        if (!p.active || p.depositedDC == 0) return 0;

        // 只有 deal Completed（status == 3）才触发收费；取消/放弃全额退
        (bool ok, uint8 s, uint64 ended) = _dealStatus(deal);
        if (!ok || s != 3 || ended == 0) return 0;

        if (p.joinedAt == 0 || ended <= p.joinedAt) return 0;

        uint256 rate = p.hourlyRate;  // 进场时快照的费率，域名商后续改价不影响已在途订单
        if (rate == 0) return 0;

        uint256 elapsed = ended - uint256(p.joinedAt);
        uint256 due = (elapsed * rate + 3599) / 3600;
        return due > p.depositedDC ? p.depositedDC : due;
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
        require(!_blacklisted[domainName][msg.sender], "DCDomainRank: blacklisted");
        uint256 effectiveMin = _domainMinDeposit[domainName] > minDeposit ? _domainMinDeposit[domainName] : minDeposit;
        require(amount >= effectiveMin, "DCDomainRank: below minDeposit");
        require(_entryInList[domainName][deal][msg.sender], "DCDomainRank: deal not reported");
        require(_isDealOpenForLeaderboard(deal), "DCDomainRank: deal closed");

        _settleDeal(domainName, deal, msg.sender);

        Player storage p = _dealPlayers[domainName][deal][msg.sender];

        dcToken.safeTransferFrom(msg.sender, address(this), amount);

        bool wasInactive = !p.active;
        p.depositedDC += amount;
        p.active       = true;
        if (p.joinedAt == 0 || wasInactive) {
            p.joinedAt   = block.timestamp;
            p.hourlyRate = _domainFixedHourlyRate[domainName];
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
            dcToken.safeTransfer(msg.sender, remaining);
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

    function _closeDeal(string memory domainName, address deal, bool checkTerminal, bool completedHint)
        internal
        returns (uint256 refunded, uint256 consumed)
    {
        if (_dealAdClosed[domainName][deal]) {
            _accountCompletedTradeVolume(domainName, deal, completedHint);
            return (0, 0);
        }

        address merchantAddr = _merchantOfDeal[domainName][deal];
        require(merchantAddr != address(0), "DCDomainRank: deal not reported");
        bool completed = completedHint;
        if (checkTerminal) {
            (bool ok, uint8 s, ) = _dealStatus(deal);
            require(ok && s >= 3, "DCDomainRank: deal not closed");
            completed = s == 3;
        }

        _accountCompletedTradeVolume(domainName, deal, completed);

        Player storage p = _dealPlayers[domainName][deal][merchantAddr];
        uint256 before_ = p.depositedDC;

        _settleDeal(domainName, deal, merchantAddr);

        refunded = p.depositedDC;
        consumed = before_ - refunded;
        p.depositedDC = 0;
        p.active = false;
        _dealAdClosed[domainName][deal] = true;

        if (refunded > 0) {
            dcToken.safeTransfer(merchantAddr, refunded);
        }

        emit Withdrawn(merchantAddr, domainName, deal, refunded, p.totalConsumed);
        emit DealAdClosed(domainName, deal, merchantAddr, refunded, p.totalConsumed);
        emit LeaderboardUpdated(domainName);
    }

    /// @notice 交易终局后，任何人都可触发广告位结算并把未消耗余额退回原充值商家。
    function closeDeal(string calldata domainName, address deal)
        external
        nonReentrant
        returns (uint256 refunded, uint256 consumed)
    {
        return _closeDeal(domainName, deal, true, false);
    }

    /// @notice Factory terminal callback path. Some old templates notify before writing Abandoned status.
    function closeDealFromAutoCloser(string calldata domainName, address deal, bool completed)
        external
        nonReentrant
        returns (uint256 refunded, uint256 consumed)
    {
        require(msg.sender == autoCloser, "DCDomainRank: not auto closer");
        return _closeDeal(domainName, deal, false, completed);
    }

    // ═══════════════════════════════════════════
    // 域名内排行榜：分数 = 已消耗 + 当前剩余余额（即总投入）
    // ═══════════════════════════════════════════

    function _getDealScore(string memory domainName, address deal, address merchantAddr) internal view returns (uint256) {
        Player storage p = _dealPlayers[domainName][deal][merchantAddr];
        return p.totalConsumed + p.depositedDC;
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

        hoursRemaining = p.hourlyRate > 0 ? realBal / p.hourlyRate : 0;
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
            dcToken.safeTransfer(target, remaining);
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

    function _ensureGlobalDomain(string memory domainName) internal {
        if (!_globalDomainExists[domainName]) {
            _globalDomains.push(domainName);
            _globalDomainExists[domainName] = true;
        }
    }

    // ── Min-heap helpers ──────────────────────────────────────────────────────
    // Invariant: _topDomainVol[_topDomainIds[parent]] ≤ _topDomainVol[_topDomainIds[child]]
    // _topDomainIdPos stores 1-based index (0 = not in heap)

    function _heapSwap(uint256 i, uint256 j) private {
        uint256 ti = _topDomainIds[i];
        uint256 tj = _topDomainIds[j];
        _topDomainIds[i] = tj;
        _topDomainIds[j] = ti;
        _topDomainIdPos[ti] = j + 1;
        _topDomainIdPos[tj] = i + 1;
    }

    function _heapSiftUp(uint256 i) private {
        while (i > 0) {
            uint256 parent = (i - 1) / 2;
            if (_topDomainVol[_topDomainIds[parent]] <= _topDomainVol[_topDomainIds[i]]) break;
            _heapSwap(i, parent);
            i = parent;
        }
    }

    function _heapSiftDown(uint256 i) private {
        uint256 n = _topDomainIds.length;
        while (true) {
            uint256 smallest = i;
            uint256 l = 2 * i + 1;
            uint256 r = 2 * i + 2;
            if (l < n && _topDomainVol[_topDomainIds[l]] < _topDomainVol[_topDomainIds[smallest]]) smallest = l;
            if (r < n && _topDomainVol[_topDomainIds[r]] < _topDomainVol[_topDomainIds[smallest]]) smallest = r;
            if (smallest == i) break;
            _heapSwap(i, smallest);
            i = smallest;
        }
    }

    function _heapInsertOrUpdate(uint256 tokenId) private {
        uint256 newVol = _topDomainVol[tokenId];
        uint256 pos    = _topDomainIdPos[tokenId]; // 1-based

        if (pos > 0) {
            // Already in heap. Trade volume only increases, so in a min-heap
            // this node can only need to move away from the root.
            _heapSiftDown(pos - 1);
        } else if (_topDomainIds.length < MAX_LEADERBOARD) {
            // Room available → append + sift up
            _topDomainIds.push(tokenId);
            _topDomainIdPos[tokenId] = _topDomainIds.length; // 1-based
            _heapSiftUp(_topDomainIds.length - 1);
        } else if (newVol > _topDomainVol[_topDomainIds[0]]) {
            // Beats current minimum (root) → evict root, insert new token at root, sift down
            uint256 evicted = _topDomainIds[0];
            _topDomainIdPos[evicted] = 0;
            _topDomainIds[0] = tokenId;
            _topDomainIdPos[tokenId] = 1;
            _heapSiftDown(0);
        }
        // else: below current minimum → ignore
    }

    function _updateTopDomains(string memory domainName) internal {
        uint256 tokenId = dcDomain.tokenIdOf(domainName);
        _topDomainVol[tokenId] = domainTradeVolume[domainName];
        _heapInsertOrUpdate(tokenId);
    }

    function _addDomainTradeVolume(string memory domainName, address deal, uint256 volume) internal {
        if (volume == 0) return;
        domainTradeVolume[domainName] += volume;
        emit DomainTradeVolumeAdded(domainName, deal, volume, domainTradeVolume[domainName]);
        _updateTopDomains(domainName);
    }

    function _accountCompletedTradeVolume(string memory domainName, address deal, bool completed) internal {
        if (!completed || _dealTradeVolumeCounted[domainName][deal]) return;
        _dealTradeVolumeCounted[domainName][deal] = true;
        _addDomainTradeVolume(domainName, deal, _reportedDealVolume[domainName][deal]);
    }

    function _reportDeal(string memory domainName, address deal, address merchant_, uint256 volume) internal {
        require(isDealReporter[msg.sender], "DCDomainRank: not reporter");
        require(deal != address(0) && merchant_ != address(0), "DCDomainRank: zero addr");

        domainDealCount[domainName]++;

        if (!_entryInList[domainName][deal][merchant_]) {
            _domainEntries[domainName].push(DealMerchantEntry({deal: deal, merchant: merchant_}));
            _entryInList[domainName][deal][merchant_] = true;
            if (_merchantOfDeal[domainName][deal] == address(0)) {
                _merchantOfDeal[domainName][deal] = merchant_;
            }
            _reportedDealVolume[domainName][deal] = volume;
        }

        _ensureGlobalDomain(domainName);
        emit DomainDealReported(domainName, deal, merchant_, domainDealCount[domainName]);
    }

    /// @notice 创建交易时由 DCDomainSwap / DCDomainHall 调用，自动在排行榜注册条目。
    /// @dev 兼容旧 reporter，不累计成交额。
    function reportDeal(string calldata domainName, address deal, address merchant_) external {
        _reportDeal(domainName, deal, merchant_, 0);
    }

    /// @notice 新 reporter：登记本单名义成交额；只有 deal 最终 Completed 才计入域名累计成交额。
    function reportDealWithVolume(string calldata domainName, address deal, address merchant_, uint256 volume) external {
        _reportDeal(domainName, deal, merchant_, volume);
    }

    function globalDomainCount() external view returns (uint256) {
        return _globalDomains.length;
    }

    function globalDomainAt(uint256 index) external view returns (string memory) {
        return _globalDomains[index];
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

    function previewHourlyRate(string calldata domainName) external view returns (uint256) {
        return _domainFixedHourlyRate[domainName];
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "ZERO_TREASURY");
        treasury = newTreasury;
    }

    function setAutoCloser(address closer) external onlyOwner {
        require(closer != address(0), "DCDomainRank: zero closer");
        autoCloser = closer;
        emit AutoCloserSet(closer);
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

    function setProtocolFeeBps(uint256 newBps) external onlyOwner {
        require(newBps <= MAX_PROTOCOL_FEE_BPS, "DCDomainRank: exceeds 50% cap");
        emit ProtocolFeeBpsSet(protocolFeeBps, newBps);
        protocolFeeBps = newBps;
    }

    // ═══════════════════════════════════════════
    // Top-N 排行榜读取（按成交额降序，最多 MAX_LEADERBOARD 条）
    // ═══════════════════════════════════════════

    /// @notice 当前堆中域名数量（0 … MAX_LEADERBOARD）
    function topDomainIdCount() external view returns (uint256) { return _topDomainIds.length; }

    /// @notice 堆内第 index 个元素（无排序保证）。保留供向后兼容，新代码请用 getTopDomainIds()。
    function topDomainIdAt(uint256 index) external view returns (uint256) { return _topDomainIds[index]; }

    /**
     * @notice 按成交额降序返回 top-N 的 tokenId 列表。
     * @dev    在内存中对堆的 ≤50 个元素做选择排序，view 调用免 gas。
     * @param  limit  最多返回条数（1 … MAX_LEADERBOARD）
     */
    function getTopDomainIds(uint256 limit) external view returns (uint256[] memory sorted) {
        require(limit > 0 && limit <= MAX_LEADERBOARD, "DCDomainRank: limit 1-50");
        uint256 n = _topDomainIds.length;
        if (n == 0) return new uint256[](0);
        uint256 k = n < limit ? n : limit;

        // Copy heap to memory scratch array
        uint256[] memory tmp = new uint256[](n);
        for (uint256 i; i < n; ) {
            tmp[i] = _topDomainIds[i];
            unchecked { ++i; }
        }

        // Selection sort (descending) — only need the first k passes, n ≤ 50 so trivial
        for (uint256 i; i < k; ) {
            uint256 maxIdx = i;
            for (uint256 j = i + 1; j < n; ) {
                if (_topDomainVol[tmp[j]] > _topDomainVol[tmp[maxIdx]]) maxIdx = j;
                unchecked { ++j; }
            }
            if (maxIdx != i) (tmp[i], tmp[maxIdx]) = (tmp[maxIdx], tmp[i]);
            unchecked { ++i; }
        }

        sorted = new uint256[](k);
        for (uint256 i; i < k; ) {
            sorted[i] = tmp[i];
            unchecked { ++i; }
        }
    }

    /**
     * @notice 将链上旧的"有序数组"格式迁移为最小堆格式。
     * @dev    仅在合约升级后调用一次。会读取 _globalDomains 中所有有成交量的域名并重建堆。
     */
    /// @notice 第一步：清空旧排行榜数据，升级后调用一次。
    function clearLeaderboardForMigration() external onlyOwner {
        uint256 n = _topDomainIds.length;
        for (uint256 i; i < n; ) {
            _topDomainIdPos[_topDomainIds[i]] = 0;
            unchecked { ++i; }
        }
        for (uint256 i; i < n; ) {
            _topDomainIds.pop();
            unchecked { ++i; }
        }
    }

    /// @notice 第二步：分批从 _globalDomains 重建最小堆，每次处理 batchSize 个域名。
    ///         从 offset=0 开始，重复调用直到 offset >= globalDomainCount()。
    function migrateLeaderboardBatch(uint256 offset, uint256 batchSize) external onlyOwner {
        uint256 total = _globalDomains.length;
        uint256 end = offset + batchSize;
        if (end > total) end = total;
        for (uint256 i = offset; i < end; ) {
            string memory domain = _globalDomains[i];
            uint256 vol = domainTradeVolume[domain];
            if (vol > 0) {
                uint256 tokenId = dcDomain.tokenIdOf(domain);
                _topDomainVol[tokenId] = vol;
                _heapInsertOrUpdate(tokenId);
            }
            unchecked { ++i; }
        }
    }

}
