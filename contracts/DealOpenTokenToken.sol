// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DealLib} from "./utils/DealLib.sol";
import {DealError} from "./utils/DealErrors.sol";

interface IFactoryAuth {
    function isAllowedCreateFor(address) external view returns (bool);
}
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
interface IFactoryLock {
    function infoLock(uint256 tokenId, address holder) external;
    function infoUnlock(uint256 tokenId) external;
}
interface IFactoryCreditOpen {
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
interface IFactoryTimelineOpen {
    function recordDealTimeline(uint8 action, address actor, bool isPartyA, uint256 value) external;
}
/**
 * @title DealOpenTokenToken
 * @notice 精简版 Open 币币：ERC20/原生互换 + Open/ExactAddress；A 可在创建时绑定 Info NFT，B 可在 join 时带 Info NFT。
 *         无 NftGated / 无商品交割 NFT。A 可在 Ready 先 pay；preAccept；Locked 下 B 单方 Reject 退 B 回 Ready。
 */
contract DealOpenTokenToken is Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant NATIVE = address(0);

    enum Status {
        Ready,
        Active,
        Locked,
        Completed,
        Canceled,
        Abandoned
    }
    enum JoinMode {
        Open,
        ExactAddress
    }
    enum Vote {
        Unset,
        Accept,
        Reject
    }
    enum CompletionReason {
        BothAccepted,
        ForcedByA,
        ForcedByB
    }

    address public factory;
    string public title;
    string public description;
    address public a;
    address public b;

    bool public isDomainDeal;
    string public domainName;

    Status public status;
    /// @dev 与 Deal 一致：Open 币币固定为 0（TokenToToken）
    JoinMode public joinMode;
    address public expectedB;

    uint256 public aNftId;
    uint256 public bNftId;
    bool private aNftLocked;
    bool public bNftLocked;

    address public aSwapToken;
    uint256 public aSwapAmount;
    address public aMarginToken;
    uint256 public aMarginAmount;
    address public bSwapToken;
    uint256 public bSwapAmount;
    address public bMarginToken;
    uint256 public bMarginAmount;

    bool public aPaid;
    bool public bPaid;

    uint64 public lockedAt;
    uint64 public timeoutSeconds;
    uint64 public replaceTimeoutSeconds;
    uint64 public bJoinedAt;
    uint64 public createdAt;
    uint64 public endedAt;
    uint64 public aAt;
    uint64 public bAt;
    Vote public aVote;
    Vote public bVote;

    bool public aHasPreAccepted;
    uint64 public aPreAcceptAt;

    uint256 private aSwapNetForB;
    uint256 private bSwapNetForA;

    address private dl;
    address private infoNft;
    address private treasury;
    address private WNATIVE;
    address private recognizedToken0;
    address private recognizedToken1;
    address private aTokenNorm;
    address private bTokenNorm;
    address private aPair;
    address private bPair;

    uint32 private feeNonDLNum;
    uint32 private feeNonDLDen;
    uint32 private mintOnFeesNum;
    uint32 private mintOnFeesDen;
    address public lastRemovedB;

    uint64 public constant MIN_REPLACE_TIMEOUT_SECONDS = 60;
    uint64 public constant MAX_REPLACE_TIMEOUT_SECONDS = 1 days;

    bool private _trackA;
    bool private _trackBActive;

    event Initialized(address indexed initiator, address indexed factory);
    event Joined(address indexed b, bool nftLocked, uint64 when);
    event Locked(uint64 when);
    event VoteCast(address indexed who, bool indexed isPartyA, Vote vote, uint64 when);
    /// @dev reason: 1 = B `exitByB`，2 = A `kickBByA`
    event ActivePartnerCleared(address indexed prevB, uint8 reason, uint64 when);
    event DealAbandoned(address indexed initiator, uint64 when);
    event ForcedAfterTimeout(address indexed caller, bool completed, uint64 when);
    event Completed(CompletionReason reason, uint64 when);
    event Canceled(uint64 when);
    event Claimed(address indexed who, address swapToken, uint256 swapAmt, address marginToken, uint256 marginAmt);
    event FeesProcessed(address indexed tokenA, uint256 aFee, address indexed tokenB, uint256 bFee);
    event RewardsMinted(address indexed a, uint256 toA, address indexed b, uint256 toB, address cAddr, uint256 toC);
    event Paid(address indexed payer, bool indexed isPartyA, uint64 when);
    event WithdrawnInActive(address indexed payer, bool indexed isPartyA, uint64 when);
    event APreAccepted(address indexed a_, uint64 at);
    event BExpelledOnReject(address indexed prevB, uint64 when);

    modifier onlyA() {
        _check(msg.sender == a, 1);
        _;
    }
    modifier onlyAB() {
        _check(msg.sender == a || msg.sender == b, 2);
        _;
    }
    modifier inState(Status s) {
        _check(status == s, 3);
        _;
    }

    function _check(bool ok, uint16 code) internal pure {
        if (!ok) revert DealError(code);
    }

    struct InitParams {
        address aSwapToken;
        uint256 aSwapAmount;
        address aMarginToken;
        uint256 aMarginAmount;
        address bSwapToken;
        uint256 bSwapAmount;
        address bMarginToken;
        uint256 bMarginAmount;
        address aAssetNft;
        uint256 aAssetNftId;
        address bAssetNft;
        uint256 bAssetNftId;
        uint8 templateType;
        uint8 joinMode;
        address expectedB;
        uint256 gateNftId;
        uint256 aNftId;
        string title;
        string description;
        uint64 timeoutSeconds;
        uint64 replaceTimeoutSeconds;
        bool isDomainDeal;
        string domainName;
        bool openTokenTokenFast;
    }

    struct ConfigParams {
        address dl;
        address infoNft;
        address treasury;
        address WNATIVE;
        address recognizedToken0;
        address recognizedToken1;
        address aTokenNorm;
        address bTokenNorm;
        address aPair;
        address bPair;
        uint32 feeNonDLNum;
        uint32 feeNonDLDen;
        uint32 mintOnFeesNum;
        uint32 mintOnFeesDen;
        address specialNoFeeToken;
        bool trackCreator;
        bool msgPriceEnabled;
        address msgPriceTokenNorm;
        address msgPricePair;
        uint256 msgPriceAmountInToken;
    }

    function initialize(address _factory, address _initiator, InitParams calldata p, ConfigParams calldata c)
        external
        initializer
    {
        _check(p.openTokenTokenFast, 56);
        _check(_factory != address(0) && _initiator != address(0), 4);
        _check(p.timeoutSeconds > 0, 5);
        _check(c.dl != address(0) && c.WNATIVE != address(0), 6);
        _check(c.treasury != address(0), 53);

        // 本合约仅支持标准 TokenToToken 形状；禁止 gate / 商品交割 NFT；A/B 的 Info NFT 单独锁定用于奖励和信用。
        _check(p.templateType == 0, 9);
        _check(p.joinMode <= uint8(JoinMode.ExactAddress), 10);
        _check(
            p.aAssetNft == address(0) && p.aAssetNftId == 0 && p.bAssetNft == address(0) && p.bAssetNftId == 0,
            38
        );
        _check(p.gateNftId == 0, 12);

        factory = _factory;
        a = _initiator;
        dl = c.dl;
        infoNft = c.infoNft;
        treasury = c.treasury;
        WNATIVE = c.WNATIVE;
        recognizedToken0 = c.recognizedToken0;
        recognizedToken1 = c.recognizedToken1;
        aTokenNorm = c.aTokenNorm;
        bTokenNorm = c.bTokenNorm;
        aPair = c.aPair;
        bPair = c.bPair;
        feeNonDLNum = c.feeNonDLNum;
        feeNonDLDen = c.feeNonDLDen;
        mintOnFeesNum = c.mintOnFeesNum;
        mintOnFeesDen = c.mintOnFeesDen;
        _check(feeNonDLDen > 0 && feeNonDLNum < feeNonDLDen, 7);
        _check(mintOnFeesDen > 0 && mintOnFeesNum < mintOnFeesDen, 8);

        aSwapToken = p.aSwapToken;
        aSwapAmount = p.aSwapAmount;
        aMarginToken = p.aMarginToken;
        aMarginAmount = p.aMarginAmount;
        bSwapToken = p.bSwapToken;
        bSwapAmount = p.bSwapAmount;
        bMarginToken = p.bMarginToken;
        bMarginAmount = p.bMarginAmount;
        aNftId = p.aNftId;

        _check(aSwapAmount > 0 && bSwapAmount > 0, 14);

        joinMode = JoinMode(p.joinMode);
        expectedB = p.expectedB;
        if (joinMode == JoinMode.ExactAddress) {
            _check(expectedB != address(0), 11);
        }

        title = p.title;
        description = p.description;
        timeoutSeconds = p.timeoutSeconds;
        replaceTimeoutSeconds = p.replaceTimeoutSeconds;
        _check(
            replaceTimeoutSeconds >= MIN_REPLACE_TIMEOUT_SECONDS &&
                replaceTimeoutSeconds <= MAX_REPLACE_TIMEOUT_SECONDS,
            57
        );
        createdAt = uint64(block.timestamp);

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

    function updateAmounts(
        uint256 _aSwapAmount,
        uint256 _aMarginAmount,
        uint256 _bSwapAmount,
        uint256 _bMarginAmount
    ) external onlyA inState(Status.Ready) {
        _check(!aPaid, 57);
        aSwapAmount = _aSwapAmount;
        aMarginAmount = _aMarginAmount;
        bSwapAmount = _bSwapAmount;
        bMarginAmount = _bMarginAmount;
        _check(aSwapAmount > 0 && bSwapAmount > 0, 14);
    }

    function abandonByA() external nonReentrant onlyA {
        _check(status == Status.Ready || status == Status.Active, 16);
        address prevB = b;

        _refundAllToParties();

        _unlockNftIfLocked(true);
        _unlockNftIfLocked(false);
        bJoinedAt = 0;
        bNftId = 0;

        if (_trackA && _trackBActive) IFactoryIndex(factory).onAbandoned(a, prevB, isDomainDeal);
        else if (_trackA) IFactoryIndex(factory).onAbandoned(a, address(0), isDomainDeal);
        else if (_trackBActive) IFactoryIndex(factory).onParticipantRemoved(prevB);
        _trackA = false;
        _trackBActive = false;

        uint64 ts = uint64(block.timestamp);
        endedAt = ts;
        status = Status.Abandoned;
        emit DealAbandoned(a, ts);
        _recordTimeline(8, a, true, 0);
    }

    function openJoinFor(address chosenB) external inState(Status.Ready) {
        _check(msg.sender == a || IFactoryAuth(factory).isAllowedCreateFor(msg.sender), 15);
        _check(b == address(0), 17);
        _check(chosenB != address(0) && chosenB != a, 18);
        expectedB = chosenB;
        joinMode = JoinMode.ExactAddress;
    }

    function join(uint256 optId, bool trackMe) external nonReentrant inState(Status.Ready) {
        _check(b == address(0), 17);
        _check(a != msg.sender, 18);
        if (joinMode == JoinMode.ExactAddress) _check(msg.sender == expectedB, 21);
        _check(msg.sender != lastRemovedB || (joinMode == JoinMode.ExactAddress && expectedB == msg.sender), 59);
        _setJoinedB(msg.sender, optId, trackMe);
    }

    function replaceInactiveBAndJoin(uint256 optId, bool trackMe) external nonReentrant inState(Status.Active) {
        _check(joinMode == JoinMode.Open, 58);
        _check(b != address(0) && msg.sender != a && msg.sender != b && msg.sender != lastRemovedB, 18);
        _check(bJoinedAt != 0 && block.timestamp >= uint256(bJoinedAt) + uint256(replaceTimeoutSeconds), 58);

        address prevB = _clearB(false);

        emit ActivePartnerCleared(prevB, 3, uint64(block.timestamp));
        _recordTimeline(9, prevB, false, 3);
        _setJoinedB(msg.sender, optId, trackMe);
    }

    function replaceNonVotingBAndJoin(uint256 optId, bool trackMe) external nonReentrant inState(Status.Locked) {
        _check(joinMode == JoinMode.Open, 58);
        _check(b != address(0) && msg.sender != a && msg.sender != b && msg.sender != lastRemovedB, 18);
        _check(aVote == Vote.Accept && bVote == Vote.Unset, 58);
        uint256 base = uint256(aAt > lockedAt ? aAt : lockedAt);
        _check(base != 0 && block.timestamp >= base + uint256(replaceTimeoutSeconds), 58);

        address prevB = _clearB(false);
        lockedAt = 0;
        aVote = Vote.Unset;
        bVote = Vote.Unset;
        aAt = 0;
        bAt = 0;
        status = Status.Active;
        aHasPreAccepted = true;
        aPreAcceptAt = uint64(block.timestamp);

        emit ActivePartnerCleared(prevB, 4, uint64(block.timestamp));
        _recordTimeline(9, prevB, false, 4);
        _setJoinedB(msg.sender, optId, trackMe);
    }

    function pay() external payable nonReentrant onlyAB {
        if (status == Status.Ready) {
            _check(msg.sender == a, 2);
            _check(b == address(0), 17);
            _check(!aPaid, 23);
            _check(msg.value == _nativeRequired(true), 24);
            if (aSwapToken != NATIVE) _pullExactERC20(IERC20(aSwapToken), aSwapAmount, msg.sender);
            if (aMarginToken != NATIVE) _pullExactERC20(IERC20(aMarginToken), aMarginAmount, msg.sender);
            bool injectedReady;
            if (_sideNeedsPayA()) {
                aPaid = true;
                injectedReady = true;
            }
            if (injectedReady) {
                emit Paid(a, true, uint64(block.timestamp));
                _recordTimeline(2, a, true, 0);
            }
            return;
        }
        _check(status == Status.Active, 3);
        bool injected;
        if (msg.sender == a) {
            _check(!aPaid, 23);
            _check(msg.value == _nativeRequired(true), 24);
            if (aSwapToken != NATIVE) _pullExactERC20(IERC20(aSwapToken), aSwapAmount, msg.sender);
            if (aMarginToken != NATIVE) _pullExactERC20(IERC20(aMarginToken), aMarginAmount, msg.sender);
            if (_sideNeedsPayA()) {
                aPaid = true;
                injected = true;
            }
        } else {
            _check(b != address(0) && !bPaid, 25);
            _check(msg.value == _nativeRequired(false), 26);
            if (bSwapToken != NATIVE) _pullExactERC20(IERC20(bSwapToken), bSwapAmount, msg.sender);
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

    function preAccept() external nonReentrant onlyA {
        _check(status == Status.Ready || status == Status.Active, 16);
        aHasPreAccepted = true;
        aPreAcceptAt = uint64(block.timestamp);
        emit APreAccepted(a, aPreAcceptAt);
        _recordTimeline(11, a, true, 0);
    }

    function withdrawAInReady() external nonReentrant onlyA inState(Status.Ready) {
        _check(b == address(0), 17);
        _check(aPaid, 27);
        aPaid = false;
        _sendOut(aSwapToken, a, aSwapAmount);
        _sendOut(aMarginToken, a, aMarginAmount);
        emit WithdrawnInActive(a, true, uint64(block.timestamp));
        _recordTimeline(3, a, true, 0);
    }

    function withdrawInActive() external nonReentrant inState(Status.Active) onlyAB {
        if (msg.sender == a) {
            _check(aPaid, 27);
            aPaid = false;
            _sendOut(aSwapToken, a, aSwapAmount);
            _sendOut(aMarginToken, a, aMarginAmount);
            emit WithdrawnInActive(a, true, uint64(block.timestamp));
            _recordTimeline(3, a, true, 0);
        } else {
            _check(bPaid, 28);
            bPaid = false;
            _sendOut(bSwapToken, b, bSwapAmount);
            _sendOut(bMarginToken, b, bMarginAmount);
            emit WithdrawnInActive(b, false, uint64(block.timestamp));
            _recordTimeline(3, b, false, 0);
        }
    }

    function exitByB() external nonReentrant inState(Status.Active) {
        _check(msg.sender == b, 29);
        address prevB = _clearB(true);
        status = Status.Ready;
        emit ActivePartnerCleared(prevB, 1, uint64(block.timestamp));
        _recordTimeline(9, prevB, false, 1);
    }

    function kickBByA() external nonReentrant onlyA inState(Status.Active) {
        address prevB = _clearB(true);
        status = Status.Ready;
        emit ActivePartnerCleared(prevB, 2, uint64(block.timestamp));
        _recordTimeline(9, prevB, false, 2);
    }

    function setMyVote(Vote v) external nonReentrant inState(Status.Locked) onlyAB {
        _check(v == Vote.Accept || v == Vote.Reject, 30);
        uint64 ts = uint64(block.timestamp);
        if (msg.sender == b && v == Vote.Reject) {
            if (aVote == Vote.Reject) {
                bVote = Vote.Reject;
                bAt = ts;
                emit VoteCast(b, false, v, ts);
                _recordTimeline(4, b, false, uint8(v));
                _cancel();
                return;
            }
            emit VoteCast(b, false, v, ts);
            _recordTimeline(4, b, false, uint8(v));
            _expelBOnReject();
            return;
        }
        if (msg.sender == a) {
            if (!(v == Vote.Accept && aVote == Vote.Accept)) {
                aVote = v;
                aAt = ts;
                emit VoteCast(a, true, v, ts);
                _recordTimeline(4, a, true, uint8(v));
            }
        } else {
            bVote = v;
            bAt = ts;
            emit VoteCast(b, false, v, ts);
            _recordTimeline(4, b, false, uint8(v));
        }

        if (aVote == Vote.Accept && bVote == Vote.Accept) _complete(CompletionReason.BothAccepted);
        else if (aVote == Vote.Reject && bVote == Vote.Reject) _cancel();
    }

    function _expelBOnReject() internal {
        address prevB = _clearB(false);
        status = Status.Ready;
        aVote = Vote.Unset;
        bVote = Vote.Unset;
        aAt = 0;
        bAt = 0;
        emit BExpelledOnReject(prevB, uint64(block.timestamp));
        _recordTimeline(10, prevB, false, 0);
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

    struct Fees {
        uint256 aFee;
        uint256 bFee;
    }
    struct Rewards {
        uint256 toA;
        uint256 toB;
        uint256 toC;
        address cAddr;
        uint256 cToken;
    }

    function _complete(CompletionReason reason) internal {
        uint64 ts = uint64(block.timestamp);
        endedAt = ts;
        status = Status.Completed;

        Fees memory f = _computeFees();
        _processFees(f);
        emit FeesProcessed(aSwapToken, f.aFee, bSwapToken, f.bFee);

        Rewards memory r = _computeRewards();
        _mintAndRecord(r);
        _recordDealCredit(f);
        DealLib.refreshMaxPointers(infoNft, factory, aNftLocked, aNftId, bNftLocked, bNftId);

        aPaid = false;
        bPaid = false;

        _sendOut(bSwapToken, a, bSwapNetForA);
        _sendOut(aMarginToken, a, aMarginAmount);
        emit Claimed(a, bSwapToken, bSwapNetForA, aMarginToken, aMarginAmount);

        _sendOut(aSwapToken, b, aSwapNetForB);
        _sendOut(bMarginToken, b, bMarginAmount);
        emit Claimed(b, aSwapToken, aSwapNetForB, bMarginToken, bMarginAmount);

        _finishIndex(true);

        _unlockNftIfLocked(true);
        _unlockNftIfLocked(false);
        bJoinedAt = 0;
        bNftId = 0;

        emit Completed(reason, ts);
        _recordTimeline(6, address(0), false, uint8(reason));
    }

    function _cancel() internal {
        uint64 ts = uint64(block.timestamp);
        endedAt = ts;
        status = Status.Canceled;

        if (aPaid) {
            aPaid = false;
            _sendOut(aSwapToken, a, aSwapAmount);
            _sendOut(aMarginToken, a, aMarginAmount);
            emit Claimed(a, aSwapToken, aSwapAmount, aMarginToken, aMarginAmount);
        }
        if (bPaid) {
            bPaid = false;
            _sendOut(bSwapToken, b, bSwapAmount);
            _sendOut(bMarginToken, b, bMarginAmount);
            emit Claimed(b, bSwapToken, bSwapAmount, bMarginToken, bMarginAmount);
        }

        _finishIndex(false);

        _unlockNftIfLocked(true);
        _unlockNftIfLocked(false);
        bJoinedAt = 0;
        bNftId = 0;

        emit Canceled(ts);
        _recordTimeline(7, address(0), false, 0);
    }

    function _computeFees() internal returns (Fees memory f) {
        (f.aFee, f.bFee, aSwapNetForB, bSwapNetForA) = DealLib.computeSwapFeesAndNets(
            aSwapAmount, aTokenNorm, bSwapAmount, bTokenNorm, dl, feeNonDLNum, feeNonDLDen
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

    function _recordDealCredit(Fees memory f) internal {
        if (infoNft == address(0)) return;
        uint256 baseCredit = DealLib.feeCreditU(
            factory, dl, WNATIVE, aTokenNorm, f.aFee, recognizedToken0, recognizedToken1, aPair
        ) + DealLib.feeCreditU(
            factory, dl, WNATIVE, bTokenNorm, f.bFee, recognizedToken0, recognizedToken1, bPair
        );
        if (baseCredit == 0) return;
        IFactoryCreditOpen(factory).recordDealCredit(a, b, aNftId, aNftLocked, bNftId, bNftLocked, baseCredit);
    }

    function _finishIndex(bool completed) internal {
        bool trackA = _trackA;
        bool trackB = _trackBActive;
        if (!trackA && !trackB) return;
        IFactoryIndex(factory).onFinishedFor(a, b, trackA, trackB, completed, isDomainDeal);
        _trackA = false;
        _trackBActive = false;
    }

    function _setJoinedB(address newB, uint256 optId, bool trackMe) internal {
        b = newB;
        if (optId > 0) {
            _check(infoNft != address(0), 22);
            _check(IERC721(infoNft).ownerOf(optId) == newB, 22);
            bNftId = optId;
        }
        _lockNftForBIfAny();

        _trackBActive = trackMe;
        status = Status.Active;
        bJoinedAt = uint64(block.timestamp);
        if (newB == lastRemovedB) lastRemovedB = address(0);
        emit Joined(b, bNftLocked, uint64(block.timestamp));
        _recordTimeline(1, b, false, bNftId);
        if (_trackBActive) IFactoryIndex(factory).onJoined(b, true);
        _tryLock();
    }

    function _markRemovedB(address prevB) internal {
        lastRemovedB = prevB;
        if (joinMode == JoinMode.ExactAddress && expectedB == prevB) expectedB = address(0);
    }

    function _clearB(bool refundA) internal returns (address prevB) {
        prevB = b;
        if (refundA) _refundFundsA();
        _refundFundsB();
        _unlockNftIfLocked(false);
        bNftId = 0;
        _markRemovedB(prevB);
        if (_trackBActive) {
            IFactoryIndex(factory).onParticipantRemoved(prevB);
            _trackBActive = false;
        }
        b = address(0);
        bJoinedAt = 0;
    }

    function _lockNftForAIfAny() internal {
        if (aNftId == 0 || aNftLocked) return;
        _check(infoNft != address(0), 49);
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
            if (aNftLocked && aNftId != 0) {
                aNftLocked = false;
                IFactoryLock(factory).infoUnlock(aNftId);
            }
        } else {
            if (bNftLocked && bNftId != 0) {
                bNftLocked = false;
                IFactoryLock(factory).infoUnlock(bNftId);
            }
        }
    }

    function _tryLock() internal {
        if (status != Status.Active) return;
        if (_isSideReadyA() && _isSideReadyB()) {
            status = Status.Locked;
            lockedAt = uint64(block.timestamp);
            if (aHasPreAccepted) {
                aVote = Vote.Accept;
                aAt = aPreAcceptAt;
            } else {
                aVote = Vote.Unset;
                aAt = 0;
            }
            bVote = Vote.Unset;
            bAt = 0;
            emit Locked(lockedAt);
            _recordTimeline(12, address(0), false, 0);
        }
    }

    function _isSideReadyA() internal view returns (bool) {
        bool tokensReady = !_sideNeedsPayA() || aPaid;
        bool nftReady = aNftId == 0 || aNftLocked;
        return tokensReady && nftReady;
    }

    function _isSideReadyB() internal view returns (bool) {
        bool tokensReady = !_sideNeedsPayB() || bPaid;
        bool nftNeeded = bNftId != 0;
        bool nftReady = !nftNeeded || bNftLocked;
        return tokensReady && nftReady;
    }

    function _nativeRequired(bool isA) internal view returns (uint256 n) {
        if (isA) {
            if (aSwapToken == NATIVE) n += aSwapAmount;
            if (aMarginToken == NATIVE) n += aMarginAmount;
        } else {
            if (bSwapToken == NATIVE) n += bSwapAmount;
            if (bMarginToken == NATIVE) n += bMarginAmount;
        }
    }

    function _pullExactERC20(IERC20 token, uint256 amount, address from) internal {
        if (amount == 0) return;
        uint256 beforeBal = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        uint256 delta = token.balanceOf(address(this)) - beforeBal;
        _check(delta == amount, 36);
    }

    function _sendOut(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == NATIVE) {
            (bool ok,) = payable(to).call{value: amount}("");
            _check(ok, 37);
        } else IERC20(token).safeTransfer(to, amount);
    }

    function _refundFundsA() internal {
        if (aPaid) {
            aPaid = false;
            _sendOut(aSwapToken, a, aSwapAmount);
            _sendOut(aMarginToken, a, aMarginAmount);
        }
    }

    function _refundFundsB() internal {
        if (bPaid) {
            bPaid = false;
            _sendOut(bSwapToken, b, bSwapAmount);
            _sendOut(bMarginToken, b, bMarginAmount);
        }
    }

    function _refundAllToParties() internal {
        _refundFundsA();
        _refundFundsB();
        b = address(0);
    }

    function _sideNeedsPayA() internal view returns (bool) {
        return aSwapAmount > 0 || aMarginAmount > 0;
    }

    function _sideNeedsPayB() internal view returns (bool) {
        return bSwapAmount > 0 || bMarginAmount > 0;
    }

    function _recordTimeline(uint8 action, address actor, bool isPartyA, uint256 value) internal {
        IFactoryTimelineOpen(factory).recordDealTimeline(action, actor, isPartyA, value);
    }

    function templateType() external pure returns (uint8) {
        return 0;
    }

    function timeStart() external view returns (uint64) {
        return createdAt;
    }

    function timeEnd() external view returns (uint64) {
        return endedAt;
    }

    receive() external payable {}
}
