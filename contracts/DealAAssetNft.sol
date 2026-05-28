// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20}            from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721}           from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver}   from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {SafeERC20}         from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable}     from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard}   from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DealLib} from "./utils/DealLib.sol";
import {DealAssetNftLib} from "./utils/DealAssetNftLib.sol";
import {DealError} from "./utils/DealErrors.sol";

/* ---------- 工厂侧接口（最小化） ---------- */
interface IFactoryAuth   { function isAllowedCreateFor(address) external view returns (bool); }
interface IFactoryDealRewardsLog {
    struct DealRewardBatch {
        address partyA; uint256 toA; address partyB; uint256 toB; address cAddr; uint256 toC;
        uint256 aTokenId; uint256 aMinted; uint256 bTokenId; uint256 bMinted; uint256 cTokenId; uint256 cMinted;
    }
    function mintAndRecordDealRewards(DealRewardBatch calldata r) external;
}
interface IFactoryIndex {
    function onCreated(address creator, bool trackCreator) external;
    function onJoined(address participant, bool trackParticipant) external;
    function onParticipantRemoved(address prevParticipant) external;
    function onAbandoned(address creator, address prevParticipant, bool domainDeal) external;
    function onFinishedFor(address partyA, address partyB, bool trackA, bool trackB, bool completed, bool domainDeal) external;
}
/* 通过 Factory 锁/解锁 InfoNFT（仅 Deal 可调） */
interface IFactoryLock {
    function infoLock(uint256 tokenId, address holder) external;
    function infoUnlock(uint256 tokenId) external;
}
interface IFactoryCredit {
    function recordDealCredit(
        address partyA,
        address partyB,
        uint256 aTokenId,
        bool aValid,
        uint256 bTokenId,
        bool bValid,
        uint256 baseCredit
    ) external;
}
interface IFactoryTimeline { function recordDealTimeline(uint8 action, address actor, bool isPartyA, uint256 value) external; }


/* ---------- DealInfoNFT（只读） ---------- */
interface IDealInfoNFTView {
    function totalMintedOf(uint256 tokenId) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function maxPartnerOf(uint256 tokenId) external view returns (uint256);
    function isLocked(uint256 tokenId) external view returns (bool);
}

/* ========================================================== */
/// @notice Ordinary NFT-asset deal implementation where party A delivers the asset NFT.
contract DealAAssetNft is Initializable, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    address public constant NATIVE = address(0);

    enum Status { Ready, Active, Locked, Completed, Canceled, Abandoned }
    enum JoinMode { Open, ExactAddress, NftGated, ExactAddressAndNftGated }
    enum TemplateType { TokenToToken, TokenToNft, TokenToEmpty, EmptyToEmpty, NftToEmpty }
    enum Vote { Unset, Accept, Reject }
    enum CompletionReason { BothAccepted, ForcedByA, ForcedByB }

    /* 基本信息 */
    address public factory;
    string  public title;
    string  public description;
    address public a;
    address public b;

    /// @notice 是否经域名入口创建（DCDomainSwap / DCDomainHall）
    bool    public isDomainDeal;
    /// @notice 域名 6 位标签（不含 @DC）；普通合约为空串
    string  public domainName;

    Status   public status;
    JoinMode public joinMode;
    TemplateType public templateType;
    address  public expectedB;

    // 门禁 & NFT（仅锁引用）
    uint256 public gateNftId;
    uint256 public aNftId;
    uint256 public bNftId;
    bool    public aNftLocked;
    bool    public bNftLocked;

    // 商品 NFT（真实交割）
    address public aAssetNft;
    uint256 public aAssetNftId;
    address public constant bAssetNft = address(0);
    uint256 public constant bAssetNftId = 0;
    bool    public aAssetNftDeposited;
    bool    public constant bAssetNftDeposited = false;

    // 置换 & 保证金
    address public aSwapToken;   uint256 public aSwapAmount;
    address public aMarginToken; uint256 public aMarginAmount;
    address public bSwapToken;   uint256 public bSwapAmount;
    address public bMarginToken; uint256 public bMarginAmount;

    // 支付标记
    bool public aPaid; bool public bPaid;

    // 锁定/投票/超时
    uint64 public lockedAt;
    uint64 public timeoutSeconds;
    uint64 public timeStart;
    uint64 public timeEnd;
    uint64 public createdAt;
    uint64 public endedAt;
    uint64 public aAt; uint64 public bAt;
    Vote   public aVote;     Vote   public bVote;

    // 兼容旧逻辑（自动结算后置 true）
    bool public aClaimed; bool public bClaimed;

    // 完成后的净置换额
    uint256 public aSwapNetForB;
    uint256 public bSwapNetForA;

    /* 固化配置 */
    address public dl;
    address public infoNft;
    address public treasury;
    address public WNATIVE;
    address public recognizedToken0;
    address public recognizedToken1;
    address public aTokenNorm; address public bTokenNorm;
    address public aPair;      address public bPair;

    // 手续费/奖励比例
    uint32  public feeNonDLNum;    uint32 public feeNonDLDen;
    uint32  public mintOnFeesNum;  uint32  public mintOnFeesDen;
    address public specialNoFeeToken;

    bool private _trackA;
    bool private _trackBActive;

    /* 事件 */
    event Initialized(address indexed initiator, address indexed factory);
    event Joined(address indexed b, bool nftLockedB, uint64 when);
    event Locked(uint64 when);
    /// @notice Locked 态投票（单方同意/拒绝）；终局仍见 `Completed` / `Canceled`
    event VoteCast(address indexed who, bool indexed isPartyA, Vote vote, uint64 when);
    /// @dev reason: 1 = B `exitByB`，2 = A `kickBByA`
    event ActivePartnerCleared(address indexed prevB, uint8 reason, uint64 when);
    event DealAbandoned(address indexed initiator, uint64 when);
    /// @notice `forceComplete`：对侧超时未投票后单方推进；`completed` 为 true 则成交，false 则取消
    event ForcedAfterTimeout(address indexed caller, bool completed, uint64 when);
    event Completed(CompletionReason reason, uint64 when);
    event Canceled(uint64 when);
    event Claimed(address indexed who, address swapToken, uint256 swapAmt, address marginToken, uint256 marginAmt);
    event FeesProcessed(address indexed tokenA, uint256 aFee, address indexed tokenB, uint256 bFee);
    event RewardsMinted(address indexed a, uint256 toA, address indexed b, uint256 toB, address indexed cAddr, uint256 toC);
    event AssetNftDeposited(address indexed owner, uint256 indexed tokenId);
    event AssetNftReleased(address indexed to, uint256 indexed tokenId);
    /// @notice Active 下成功注入（pay）：便于前端时间线索引
    event Paid(address indexed payer, bool indexed isPartyA, uint64 when);
    /// @notice Active 下 withdrawInActive 撤回已注入资产
    event WithdrawnInActive(address indexed payer, bool indexed isPartyA, uint64 when);

    modifier onlyA()  { _check(msg.sender == a, 1); _; }
    modifier onlyAB() { _check(msg.sender == a || msg.sender == b, 2); _; }
    modifier inState(Status s) { _check(status == s, 3); _; }

    function _check(bool ok, uint16 code) internal pure {
        if (!ok) revert DealError(code);
    }

    /* ------------ 初始化 ------------ */
    struct InitParams {
        address aSwapToken;   uint256 aSwapAmount;
        address aMarginToken; uint256 aMarginAmount;
        address bSwapToken;   uint256 bSwapAmount;
        address bMarginToken; uint256 bMarginAmount;
        address aAssetNft;
        uint256 aAssetNftId;
        address bAssetNft;
        uint256 bAssetNftId;
        uint8   templateType;
        uint8   joinMode;     address expectedB;
        uint256 gateNftId;
        uint256 aNftId;
        string  title;
        string  description;
        uint64  timeoutSeconds; uint64 replaceTimeoutSeconds;
        bool    isDomainDeal;
        string  domainName;
        /// @dev true 时使用 DealOpenTokenToken 实现；普通 Deal 必须为 false
        bool    openTokenTokenFast;
    }
    struct ConfigParams {
        address dl;           address infoNft;     address treasury; address WNATIVE;
        address recognizedToken0; address recognizedToken1;
        address aTokenNorm;   address bTokenNorm;  address aPair;    address bPair;
        uint32  feeNonDLNum;  uint32 feeNonDLDen;
        uint32  mintOnFeesNum; uint32 mintOnFeesDen;
        address specialNoFeeToken;
        bool    trackCreator;
        bool    msgPriceEnabled; address msgPriceTokenNorm; address msgPricePair; uint256 msgPriceAmountInToken;
    }

    function initialize(address _factory, address _initiator, InitParams calldata p, ConfigParams calldata c)
        external initializer
    {
        _check(!p.openTokenTokenFast, 56);
        _check(_factory != address(0) && _initiator != address(0), 4);
        _check(p.timeoutSeconds > 0, 5);
        _check(c.dl != address(0) && c.WNATIVE != address(0), 6);
        _check(c.treasury != address(0), 53);

        factory = _factory; a = _initiator;
        dl=c.dl; infoNft=c.infoNft; treasury=c.treasury; WNATIVE=c.WNATIVE;
        recognizedToken0 = c.recognizedToken0; recognizedToken1 = c.recognizedToken1;
        aTokenNorm=c.aTokenNorm; bTokenNorm=c.bTokenNorm; aPair=c.aPair; bPair=c.bPair;
        feeNonDLNum=c.feeNonDLNum; feeNonDLDen=c.feeNonDLDen; mintOnFeesNum=c.mintOnFeesNum; mintOnFeesDen=c.mintOnFeesDen;
        _check(feeNonDLDen>0 && feeNonDLNum<feeNonDLDen, 7);
        _check(mintOnFeesDen>0 && mintOnFeesNum<mintOnFeesDen, 8);
        specialNoFeeToken=c.specialNoFeeToken;

        aSwapToken=p.aSwapToken; aSwapAmount=p.aSwapAmount; aMarginToken=p.aMarginToken; aMarginAmount=p.aMarginAmount;
        bSwapToken=p.bSwapToken; bSwapAmount=p.bSwapAmount; bMarginToken=p.bMarginToken; bMarginAmount=p.bMarginAmount;
        aAssetNft=p.aAssetNft; aAssetNftId=p.aAssetNftId;
        _check(
            p.aAssetNft != address(0) && p.aAssetNftId != 0 && p.bAssetNft == address(0) && p.bAssetNftId == 0,
            38
        );

        _check(
            p.templateType == uint8(TemplateType.TokenToNft),
            9
        );
        _check(p.joinMode <= uint8(JoinMode.ExactAddressAndNftGated), 10);
        templateType = TemplateType(p.templateType);
        joinMode  = JoinMode(p.joinMode);
        expectedB = p.expectedB;
        if (joinMode == JoinMode.ExactAddress || joinMode == JoinMode.ExactAddressAndNftGated) {
            _check(expectedB != address(0), 11);
        }

        gateNftId = p.gateNftId;
        if (joinMode == JoinMode.NftGated || joinMode == JoinMode.ExactAddressAndNftGated) {
            _check(gateNftId != 0, 12);
        }
        aNftId    = p.aNftId;
        bNftId    = 0;

        _assertAssetNftAllowedForA();

        title=p.title; description=p.description; timeoutSeconds=p.timeoutSeconds;
        createdAt = uint64(block.timestamp); timeStart = createdAt;

        isDomainDeal = p.isDomainDeal;
        domainName = p.domainName;
        if (p.isDomainDeal) {
            _check(bytes(p.domainName).length > 0 && bytes(p.domainName).length <= 64, 54);
        } else {
            _check(bytes(p.domainName).length == 0, 55);
        }

        status = Status.Ready;

        _lockNftForAIfAny();

        address aNorm = (aSwapToken == NATIVE) ? WNATIVE : aSwapToken;
        address bNorm = (bSwapToken == NATIVE) ? WNATIVE : bSwapToken;
        _check(aNorm == aTokenNorm && bNorm == bTokenNorm, 14);

        _trackA = c.trackCreator;
        if (_trackA) IFactoryIndex(factory).onCreated(a, true);

        emit Initialized(a, factory);
    }

    /* ========== A：改四数 / 废弃 ========== */
    function updateAmounts(uint256 _aSwapAmount, uint256 _aMarginAmount, uint256 _bSwapAmount, uint256 _bMarginAmount)
        external onlyA inState(Status.Ready)
    { aSwapAmount=_aSwapAmount; aMarginAmount=_aMarginAmount; bSwapAmount=_bSwapAmount; bMarginAmount=_bMarginAmount; }

    function abandonByA() external nonReentrant onlyA {
        _check(status == Status.Ready || status == Status.Active, 16);
        address prevB = b;

        _refundAllToParties();

        _unlockNftIfLocked(true);
        _unlockNftIfLocked(false);
        bNftId = 0;

        if (_trackA && _trackBActive) IFactoryIndex(factory).onAbandoned(a, prevB, isDomainDeal);
        else if (_trackA)             IFactoryIndex(factory).onAbandoned(a, address(0), isDomainDeal);
        else if (_trackBActive)       IFactoryIndex(factory).onParticipantRemoved(prevB);
        _trackA=false; _trackBActive=false;

        uint64 ts = uint64(block.timestamp);
        endedAt = ts;
        timeEnd = ts;
        status = Status.Abandoned;
        emit DealAbandoned(a, ts);
        _recordTimeline(8, a, true, 0);
    }

    /* ========== A 或授权合约：指定 B（供 DCDomainHall 等调用） ========== */
    function openJoinFor(address chosenB) external inState(Status.Ready) {
        _check(
            msg.sender == a || IFactoryAuth(factory).isAllowedCreateFor(msg.sender),
            15
        );
        _check(b == address(0), 17);
        _check(chosenB != address(0) && chosenB != a, 18);
        expectedB = chosenB;
        joinMode  = JoinMode.ExactAddress;
    }

    /* ========== B：进入 ========== */
    function join(uint256 optId, bool trackMe) external nonReentrant inState(Status.Ready) {
        _check(b == address(0), 17);
        _check(a != msg.sender, 18);
        if (joinMode == JoinMode.NftGated || joinMode == JoinMode.ExactAddressAndNftGated) {
            if (joinMode == JoinMode.ExactAddressAndNftGated) _check(msg.sender == expectedB, 19);
            _check(IERC721(infoNft).ownerOf(gateNftId) == msg.sender, 20);
            b = msg.sender; bNftId = gateNftId;
        } else {
            if (joinMode == JoinMode.ExactAddress) _check(msg.sender == expectedB, 21);
            b = msg.sender;
            if (optId > 0) {
                _check(IERC721(infoNft).ownerOf(optId) == msg.sender, 22);
                bNftId = optId;
            }
        }

        _lockNftForBIfAny();

        _trackBActive = trackMe;
        status = Status.Active;
        emit Joined(b, bNftLocked, uint64(block.timestamp));
        _recordTimeline(1, b, false, bNftId);
        if (_trackBActive) IFactoryIndex(factory).onJoined(b, true);
        _tryLock();
    }

    /* ========== Active：支付 / 撤回 / 退出 / 踢人 ========== */
    function pay() external payable nonReentrant inState(Status.Active) onlyAB {
        bool injected;
        if (msg.sender == a) {
            _check(!aPaid, 23);
            _check(msg.value == _nativeRequired(true), 24);
            if (aSwapToken   != NATIVE) _pullExactERC20(IERC20(aSwapToken), aSwapAmount, msg.sender);
            if (aMarginToken != NATIVE) _pullExactERC20(IERC20(aMarginToken), aMarginAmount, msg.sender);
            _pullAssetNftForA();
            if (_sideNeedsPayA()) {
                aPaid = true;
                injected = true;
            }
        } else {
            _check(b != address(0) && !bPaid, 25);
            _check(msg.value == _nativeRequired(false), 26);
            if (bSwapToken   != NATIVE) _pullExactERC20(IERC20(bSwapToken), bSwapAmount, msg.sender);
            if (bMarginToken != NATIVE) _pullExactERC20(IERC20(bMarginToken), bMarginAmount, msg.sender);
            if (_sideNeedsPayB()) {
                bPaid = true;
                injected = true;
            }
        }
        if (injected) {
            bool isA = msg.sender == a;
            emit Paid(msg.sender, isA, uint64(block.timestamp));
            _recordTimeline(2, msg.sender, isA, 0);
        }
        _tryLock();
    }

    function withdrawInActive() external nonReentrant inState(Status.Active) onlyAB {
        if (msg.sender == a) {
            _check(aPaid, 27); aPaid = false;
            _sendOut(aSwapToken, a, aSwapAmount);
            _sendOut(aMarginToken, a, aMarginAmount);
            _sendOutAssetNftToA();
            emit WithdrawnInActive(a, true, uint64(block.timestamp));
            _recordTimeline(3, a, true, 0);
        } else {
            _check(bPaid, 28); bPaid = false;
            _sendOut(bSwapToken, b, bSwapAmount);
            _sendOut(bMarginToken, b, bMarginAmount);
            emit WithdrawnInActive(b, false, uint64(block.timestamp));
            _recordTimeline(3, b, false, 0);
        }
    }

    function exitByB() external nonReentrant inState(Status.Active) {
        _check(msg.sender == b, 29);
        address prevB = b;
        _refundFundsA(); _refundFundsB();
        _unlockNftIfLocked(false);
        bNftId = 0;
        if (_trackBActive) { IFactoryIndex(factory).onParticipantRemoved(prevB); _trackBActive = false; }
        b = address(0);
        status = Status.Ready;
        emit ActivePartnerCleared(prevB, 1, uint64(block.timestamp));
        _recordTimeline(9, prevB, false, 1);
    }

    function kickBByA() external nonReentrant onlyA inState(Status.Active) {
        address prevB = b;
        _refundFundsA(); _refundFundsB();
        _unlockNftIfLocked(false);
        bNftId = 0;
        if (_trackBActive) { IFactoryIndex(factory).onParticipantRemoved(prevB); _trackBActive = false; }
        b = address(0);
        status = Status.Ready;
        emit ActivePartnerCleared(prevB, 2, uint64(block.timestamp));
        _recordTimeline(9, prevB, false, 2);
    }

    /* ========== Locked：投票 / 强制完成 / 取消 ========== */
    function setMyVote(Vote v) external nonReentrant inState(Status.Locked) onlyAB {
        _check(v == Vote.Accept || v == Vote.Reject, 30);
        uint64 ts = uint64(block.timestamp);
        if (msg.sender == a) { aVote = v; aAt = ts; }
        else { bVote = v; bAt = ts; }
        bool isA = msg.sender == a;
        emit VoteCast(msg.sender, isA, v, ts);
        _recordTimeline(4, msg.sender, isA, uint8(v));

        if (aVote == Vote.Accept && bVote == Vote.Accept) _complete(CompletionReason.BothAccepted);
        else if (aVote == Vote.Reject && bVote == Vote.Reject) _cancel();
    }

    function forceComplete() external nonReentrant inState(Status.Locked) onlyAB {
        uint64 ts = uint64(block.timestamp);
        if (msg.sender == a && bVote == Vote.Unset) {
            _check(block.timestamp >= uint256(aAt) + uint256(timeoutSeconds), 31);
            if (aVote == Vote.Accept) {
                emit ForcedAfterTimeout(msg.sender, true, ts);
                _recordTimeline(5, msg.sender, true, 1);
                _complete(CompletionReason.ForcedByA);
                return;
            }
        } else if (msg.sender == b && aVote == Vote.Unset) {
            _check(block.timestamp >= uint256(bAt) + uint256(timeoutSeconds), 32);
            if (bVote == Vote.Accept) {
                emit ForcedAfterTimeout(msg.sender, true, ts);
                _recordTimeline(5, msg.sender, false, 1);
                _complete(CompletionReason.ForcedByB);
                return;
            } else if (bVote == Vote.Reject) {
                emit ForcedAfterTimeout(msg.sender, false, ts);
                _recordTimeline(5, msg.sender, false, 0);
                _cancel();
                return;
            }
        }

        revert DealError(33);
    }

    /* ========== 完成 / 取消（自动结算） ========== */
    struct Fees    { uint256 aFee; uint256 bFee; }
    struct Rewards { uint256 toA;  uint256 toB;  uint256 toC; address cAddr; uint256 cToken; }

    // 完成：当场派发 & 清理（先置终态，符合 CEI，降低重入窗口）
    function _complete(CompletionReason reason) internal {
        uint64 ts = uint64(block.timestamp);
        endedAt = ts;
        timeEnd = ts;
        status = Status.Completed;

        Fees memory f = _computeFees();
        _processFees(f); emit FeesProcessed(aSwapToken, f.aFee, bSwapToken, f.bFee);

        Rewards memory r = _computeRewards();
        _mintAndRecord(r);
        _recordDealCredit(f);
        _refreshMaxPointers();

        // 内部标记
        aPaid = false; bPaid = false;
        aClaimed = true; bClaimed = true;

        // === 结算派发（完成态） ===
        _sendOut(bSwapToken, a, bSwapNetForA);
        _sendOut(aMarginToken, a, aMarginAmount);
        emit Claimed(a, bSwapToken, bSwapNetForA, aMarginToken, aMarginAmount);

        _sendOut(aSwapToken, b, aSwapNetForB);
        _sendOut(bMarginToken, b, bMarginAmount);
        _settleAssetNftToB();

        emit Claimed(b, aSwapToken, aSwapNetForB, bMarginToken, bMarginAmount);

        // 解锁 NFT + 清理“活跃热索引”
        _unlockNftIfLocked(true);
        _unlockNftIfLocked(false);
        _finishIndex(true);

        emit Completed(reason, ts);
        _recordTimeline(6, address(0), false, uint8(reason));
    }

    // 取消：当场退款 & 清理（先置终态，符合 CEI，降低重入窗口）
    function _cancel() internal {
        uint64 ts = uint64(block.timestamp);
        endedAt = ts;
        timeEnd = ts;
        status = Status.Canceled;

        if (aPaid) {
            aPaid = false; aClaimed = true;
            _sendOut(aSwapToken, a, aSwapAmount);
            _sendOut(aMarginToken, a, aMarginAmount);
            _sendOutAssetNftToA();
            emit Claimed(a, aSwapToken, aSwapAmount, aMarginToken, aMarginAmount);
        }
        if (bPaid) {
            bPaid = false; bClaimed = true;
            _sendOut(bSwapToken, b, bSwapAmount);
            _sendOut(bMarginToken, b, bMarginAmount);
            emit Claimed(b, bSwapToken, bSwapAmount, bMarginToken, bMarginAmount);
        }

        _unlockNftIfLocked(true);
        _unlockNftIfLocked(false);

        _finishIndex(false);

        emit Canceled(ts);
        _recordTimeline(7, address(0), false, 0);
    }

    /* ========== 手续费 & 入池 ========== */
    function _computeFees() internal returns (Fees memory f) {
        (f.aFee, f.bFee, aSwapNetForB, bSwapNetForA) = DealLib.computeSwapFeesAndNets(
            aSwapAmount,
            aTokenNorm,
            bSwapAmount,
            bTokenNorm,
            dl,
            feeNonDLNum,
            feeNonDLDen
        );
    }
    function _processFees(Fees memory f) internal {
        DealLib.processDealFees(
            DealLib.ProcessDealFeesParams({
                NATIVE: NATIVE,
                factory: factory,
                dl: dl,
                treasury: treasury,
                WNATIVE: WNATIVE,
                recognizedToken0: recognizedToken0,
                recognizedToken1: recognizedToken1,
                aSwapAmount: aSwapAmount,
                aTokenNorm: aTokenNorm,
                bSwapAmount: bSwapAmount,
                bTokenNorm: bTokenNorm,
                aSwapToken: aSwapToken,
                bSwapToken: bSwapToken,
                aPair: aPair,
                bPair: bPair,
                aFee: f.aFee,
                bFee: f.bFee,
                infoNft: infoNft,
                partyA: a,
                partyB: b,
                aNftLocked: aNftLocked,
                aNftId: aNftId,
                bNftLocked: bNftLocked,
                bNftId: bNftId
            })
        );
    }

    /* ========== 奖励（按认可币交易额返 DC） ========== */
    function _computeRewards() internal returns (Rewards memory r) {
        (r.toA, r.toB, r.toC, r.cAddr, r.cToken) = DealLib.computeDealRewards(
            DealLib.ComputeDealRewardsParams({
                mintOnFeesNum: mintOnFeesNum,
                mintOnFeesDen: mintOnFeesDen,
                aSwapAmount: aSwapAmount,
                aTokenNorm: aTokenNorm,
                aSwapToken: aSwapToken,
                aPair: aPair,
                bSwapAmount: bSwapAmount,
                bTokenNorm: bTokenNorm,
                bSwapToken: bSwapToken,
                bPair: bPair,
                dl: dl,
                WNATIVE: WNATIVE,
                recognizedToken0: recognizedToken0,
                recognizedToken1: recognizedToken1,
                factory: factory,
                infoNft: infoNft,
                partyA: a,
                partyB: b,
                aNftLocked: aNftLocked,
                aNftId: aNftId,
                bNftLocked: bNftLocked,
                bNftId: bNftId
            })
        );
    }

    /* ---------- 铸币 & 统计（通过 Factory 代理写 InfoNFT） ---------- */
    function _mintAndRecord(Rewards memory r) internal {
        emit RewardsMinted(a, r.toA, b, r.toB, r.cAddr, r.toC);
        IFactoryDealRewardsLog(factory).mintAndRecordDealRewards(
            IFactoryDealRewardsLog.DealRewardBatch({
                partyA: a,
                toA: r.toA,
                partyB: b,
                toB: r.toB,
                cAddr: r.cAddr,
                toC: r.toC,
                aTokenId: aNftLocked ? aNftId : 0,
                aMinted: r.toA,
                bTokenId: bNftLocked ? bNftId : 0,
                bMinted: r.toB,
                cTokenId: r.cToken,
                cMinted: r.toC
            })
        );
    }

    /* ---------- 完成后更新 maxA / maxB（通过 Factory 代理） ---------- */
    function _refreshMaxPointers() internal {
        DealLib.refreshMaxPointers(infoNft, factory, aNftLocked, aNftId, bNftLocked, bNftId);
    }

    function _recordDealCredit(Fees memory f) internal {
        if (infoNft == address(0)) return;
        uint256 baseCredit = DealLib.feeCreditU(aTokenNorm, f.aFee, recognizedToken0, recognizedToken1)
            + DealLib.feeCreditU(bTokenNorm, f.bFee, recognizedToken0, recognizedToken1);
        if (baseCredit == 0) return;
        IFactoryCredit(factory).recordDealCredit(a, b, aNftId, aNftLocked, bNftId, bNftLocked, baseCredit);
    }

    function _finishIndex(bool completed) internal {
        bool trackA = _trackA;
        bool trackB = _trackBActive;
        if (!trackA && !trackB) return;
        IFactoryIndex(factory).onFinishedFor(a, b, trackA, trackB, completed, isDomainDeal);
        _trackA = false;
        _trackBActive = false;
    }

    /* ========== 自动锁定判定 ========== */
    function _tryLock() internal {
        if (status != Status.Active) return;
        if (_isSideReadyA() && _isSideReadyB()) {
            status = Status.Locked;
            lockedAt = uint64(block.timestamp);
            aVote = Vote.Unset; bVote = Vote.Unset; aAt = 0; bAt = 0;
            emit Locked(lockedAt);
            _recordTimeline(12, address(0), false, 0);
        }
    }
    function _isSideReadyA() internal view returns (bool) {
        bool tokensReady = !_sideNeedsPayA() || aPaid;
        bool nftReady    = (aNftId == 0) || aNftLocked;
        return tokensReady && nftReady;
    }
    function _isSideReadyB() internal view returns (bool) {
        bool tokensReady = !_sideNeedsPayB() || bPaid;
        bool nftNeeded   = (joinMode == JoinMode.NftGated) || (bNftId != 0);
        bool nftReady    = (!nftNeeded) || bNftLocked;
        return tokensReady && nftReady;
    }

    /* ========== 只读：原生需求 ========== */
    function _nativeRequired(bool isA) internal view returns (uint256 n) {
        if (isA) {
            if (aSwapToken == NATIVE) n += aSwapAmount;
            if (aMarginToken == NATIVE) n += aMarginAmount;
        } else {
            if (bSwapToken == NATIVE) n += bSwapAmount;
            if (bMarginToken == NATIVE) n += bMarginAmount;
        }
    }

    /* ========== 工具：资金清退/发送/拉取 ========== */
    function _pullExactERC20(IERC20 token, uint256 amount, address from) internal {
        if (amount == 0) return;
        uint256 beforeBal = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        uint256 delta = token.balanceOf(address(this)) - beforeBal;
        _check(delta == amount, 36);
    }
    function _sendOut(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == NATIVE) { (bool ok, ) = payable(to).call{value: amount}(""); _check(ok, 37); }
        else IERC20(token).safeTransfer(to, amount);
    }
    function _refundFundsA() internal {
        if (aPaid) { aPaid=false; _sendOut(aSwapToken,a,aSwapAmount); _sendOut(aMarginToken,a,aMarginAmount); _sendOutAssetNftToA(); }
    }
    function _refundFundsB() internal {
        if (bPaid) { bPaid=false; _sendOut(bSwapToken,b,bSwapAmount); _sendOut(bMarginToken,b,bMarginAmount); }
    }
    function _refundAllToParties() internal { _refundFundsA(); _refundFundsB(); b = address(0); }

    function _sideNeedsPayA() internal view returns (bool) {
        return aSwapAmount > 0 || aMarginAmount > 0 || aAssetNftId != 0;
    }
    function _sideNeedsPayB() internal view returns (bool) {
        return bSwapAmount > 0 || bMarginAmount > 0;
    }

    function _pullAssetNftForA() internal {
        if (aAssetNftId == 0 || aAssetNftDeposited) return;
        if (
            DealAssetNftLib.pullForA(
                aAssetNftId, aAssetNftDeposited, aAssetNft, infoNft, a, aNftId, gateNftId
            )
        ) {
            aAssetNftDeposited = true;
            emit AssetNftDeposited(a, aAssetNftId);
        }
    }
    function _settleAssetNftToB() internal {
        (bool ok, address to, uint256 id) = DealAssetNftLib.settleAAssetToB(
            aAssetNftDeposited, aAssetNftId, aAssetNft, infoNft, b
        );
        if (ok) {
            aAssetNftDeposited = false;
            emit AssetNftReleased(to, id);
        }
    }
    function _sendOutAssetNftToA() internal {
        (bool ok, address to, uint256 id) = DealAssetNftLib.sendOutAAssetToA(
            aAssetNftDeposited, aAssetNftId, aAssetNft, infoNft, a
        );
        if (ok) {
            aAssetNftDeposited = false;
            emit AssetNftReleased(to, id);
        }
    }

    function _assetNftContractForA() internal view returns (address) {
        return aAssetNft == address(0) ? infoNft : aAssetNft;
    }

    function _assertAssetNftAllowedForA() internal view {
        if (aAssetNftId == 0) return;
        DealAssetNftLib.assertAssetAllowedForA(infoNft, a, aAssetNft, aAssetNftId, aNftId, gateNftId);
    }

    // 加锁/解锁辅助
    function _lockNftForAIfAny() internal {
        if (aNftId == 0 || aNftLocked) return;
        _check(IERC721(infoNft).ownerOf(aNftId) == a, 49);
        aNftLocked = true;
        IFactoryLock(factory).infoLock(aNftId, a);
    }
    function _lockNftForBIfAny() internal {
        if (bNftId == 0 || bNftLocked) return;
        _check(IERC721(infoNft).ownerOf(bNftId) == b, 50);
        bNftLocked = true;
        IFactoryLock(factory).infoLock(bNftId, b);
    }
    function _unlockNftIfLocked(bool isA) internal {
        if (isA) {
            if (aNftLocked && aNftId != 0) { aNftLocked=false; IFactoryLock(factory).infoUnlock(aNftId); }
        } else {
            if (bNftLocked && bNftId != 0) { bNftLocked=false; IFactoryLock(factory).infoUnlock(bNftId); }
        }
    }

    function _recordTimeline(uint8 action, address actor, bool isPartyA, uint256 value) internal {
        IFactoryTimeline(factory).recordDealTimeline(action, actor, isPartyA, value);
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        _check(
            msg.sender == infoNft
                || msg.sender == _assetNftContractForA(),
            51
        );
        return IERC721Receiver.onERC721Received.selector;
    }

    // 接收原生
    receive() external payable {}
}
