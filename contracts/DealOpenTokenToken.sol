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
interface IFactoryMinter {
    function mintDL(address to, uint256 amount) external;
}
interface IFactoryMessageHub {
    function dealMessageHub() external view returns (address);
}
interface IFactoryIndex {
    function onCreated(address creator, bool trackCreator) external;
    function onJoined(address participant, bool trackParticipant) external;
    function onParticipantRemoved(address prevParticipant) external;
    function onAbandoned(address creator, address prevParticipant) external;
    function onClosedFor(address user) external;
    function onCompletedFor(address user) external;
}
interface IFactoryInfo {
    function infoAddMinted(uint256 tokenId, uint256 amount) external;
}
interface IFactoryLock {
    function infoLock(uint256 tokenId, address holder) external;
    function infoUnlock(uint256 tokenId) external;
}

interface IDLBurnFrom {
    function burnFrom(address account, uint256 amount) external;
}
interface IDealMessageHub {
    function postFromDeal(address sender, string calldata content) external returns (uint256 index);
}

/**
 * @title DealOpenTokenToken
 * @notice 精简版 Open 币币：ERC20/原生互换 + Open/ExactAddress；与 Deal 币币一致可由 B 在 join 时带 Info NFT（optId）并经 Factory 锁定。
 *         无 NftGated / 无 A 侧链上 NFT / 无商品交割 NFT。A 可在 Ready 先 pay；preAccept；Locked 下 B 单方 Reject 退 B 回 Ready。
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
    address public a;
    address public b;

    bool public isDomainDeal;
    string public domainName;

    Status public status;
    /// @dev 与 Deal 一致：Open 币币固定为 0（TokenToToken）
    uint8 public templateType;
    JoinMode public joinMode;
    address public expectedB;

    uint256 public bNftId;
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
    uint64 public timeStart;
    uint64 public timeEnd;
    uint64 public aAt;
    uint64 public bAt;
    Vote public aVote;
    Vote public bVote;

    bool public aHasPreAccepted;
    uint64 public aPreAcceptAt;

    bool public aClaimed;
    bool public bClaimed;

    uint256 public aSwapNetForB;
    uint256 public bSwapNetForA;

    address public dl;
    address public infoNft;
    address public treasury;
    address public WNATIVE;
    address public recognizedToken0;
    address public recognizedToken1;
    address public aTokenNorm;
    address public bTokenNorm;
    address public aPair;
    address public bPair;

    uint32 public feeNonDLNum;
    uint32 public feeNonDLDen;
    uint32 public mintOnFeesNum;
    uint32 public mintOnFeesDen;
    address public specialNoFeeToken;

    bool private _trackA;
    bool private _trackBActive;

    bool public msgPriceEnabled;
    address public msgPriceTokenNorm;
    address public msgPricePair;
    uint256 public msgPriceAmountInToken;

    event Initialized(address indexed initiator, address indexed factory);
    event Joined(address indexed b, bool nftLocked);
    event Locked();
    event Completed(CompletionReason reason);
    event Canceled();
    event Claimed(address indexed who, address swapToken, uint256 swapAmt, address marginToken, uint256 marginAmt);
    event FeesProcessed(address indexed tokenA, uint256 aFee, address indexed tokenB, uint256 bFee);
    event RewardsMinted(address indexed a, uint256 toA, address indexed b, uint256 toB, address cAddr, uint256 toC);
    event MessagePosted(address indexed sender, uint256 indexed index);
    event MessageFeeCharged(address indexed sender, uint256 dlBurned);
    event Paid(address indexed payer, bool indexed isPartyA);
    event WithdrawnInActive(address indexed payer, bool indexed isPartyA);
    event APreAccepted(address indexed a_, uint64 at);
    event BExpelledOnReject(address indexed prevB);

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
        uint64 timeoutSeconds;
        uint64 timeStart;
        uint64 timeEnd;
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

        // 本合约仅支持标准 TokenToToken 形状；禁止 gate / A 链上 NFT / 商品交割 NFT（B 的 Info NFT 仅经 join(optId)）
        _check(p.templateType == 0, 9);
        _check(p.joinMode <= uint8(JoinMode.ExactAddress), 10);
        _check(
            p.aAssetNft == address(0) && p.aAssetNftId == 0 && p.bAssetNft == address(0) && p.bAssetNftId == 0,
            38
        );
        _check(p.gateNftId == 0 && p.aNftId == 0, 12);

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
        specialNoFeeToken = c.specialNoFeeToken;

        msgPriceEnabled = c.msgPriceEnabled;
        msgPriceTokenNorm = c.msgPriceTokenNorm;
        msgPricePair = c.msgPricePair;
        msgPriceAmountInToken = c.msgPriceAmountInToken;

        aSwapToken = p.aSwapToken;
        aSwapAmount = p.aSwapAmount;
        aMarginToken = p.aMarginToken;
        aMarginAmount = p.aMarginAmount;
        bSwapToken = p.bSwapToken;
        bSwapAmount = p.bSwapAmount;
        bMarginToken = p.bMarginToken;
        bMarginAmount = p.bMarginAmount;

        _check(aSwapAmount > 0 && bSwapAmount > 0, 14);

        templateType = p.templateType;
        joinMode = JoinMode(p.joinMode);
        expectedB = p.expectedB;
        if (joinMode == JoinMode.ExactAddress) {
            _check(expectedB != address(0), 11);
        }

        title = p.title;
        timeoutSeconds = p.timeoutSeconds;
        timeStart = p.timeStart;
        timeEnd = p.timeEnd;
        _check(timeStart > 0 && timeEnd > timeStart, 13);

        isDomainDeal = p.isDomainDeal;
        domainName = p.domainName;
        if (p.isDomainDeal) {
            _check(bytes(p.domainName).length > 0 && bytes(p.domainName).length <= 64, 54);
        } else {
            _check(bytes(p.domainName).length == 0, 55);
        }

        status = Status.Ready;

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

        _unlockNftIfLocked(false);
        bNftId = 0;

        if (_trackA && _trackBActive) IFactoryIndex(factory).onAbandoned(a, prevB);
        else if (_trackA) IFactoryIndex(factory).onAbandoned(a, address(0));
        else if (_trackBActive) IFactoryIndex(factory).onParticipantRemoved(prevB);
        _trackA = false;
        _trackBActive = false;

        status = Status.Abandoned;
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
        b = msg.sender;
        if (optId > 0) {
            _check(infoNft != address(0), 22);
            _check(IERC721(infoNft).ownerOf(optId) == msg.sender, 22);
            bNftId = optId;
        }
        _lockNftForBIfAny();

        _trackBActive = trackMe;
        status = Status.Active;
        emit Joined(b, bNftLocked);
        if (_trackBActive) IFactoryIndex(factory).onJoined(b, true);
        _tryLock();
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
            if (injectedReady) emit Paid(a, true);
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
        if (injected) emit Paid(msg.sender, msg.sender == a);
        _tryLock();
    }

    function preAccept() external nonReentrant onlyA {
        _check(status == Status.Ready || status == Status.Active, 16);
        aHasPreAccepted = true;
        aPreAcceptAt = uint64(block.timestamp);
        emit APreAccepted(a, aPreAcceptAt);
    }

    function withdrawAInReady() external nonReentrant onlyA inState(Status.Ready) {
        _check(b == address(0), 17);
        _check(aPaid, 27);
        aPaid = false;
        _sendOut(aSwapToken, a, aSwapAmount);
        _sendOut(aMarginToken, a, aMarginAmount);
        emit WithdrawnInActive(a, true);
    }

    function withdrawInActive() external nonReentrant inState(Status.Active) onlyAB {
        if (msg.sender == a) {
            _check(aPaid, 27);
            aPaid = false;
            _sendOut(aSwapToken, a, aSwapAmount);
            _sendOut(aMarginToken, a, aMarginAmount);
            emit WithdrawnInActive(a, true);
        } else {
            _check(bPaid, 28);
            bPaid = false;
            _sendOut(bSwapToken, b, bSwapAmount);
            _sendOut(bMarginToken, b, bMarginAmount);
            emit WithdrawnInActive(b, false);
        }
    }

    function exitByB() external nonReentrant inState(Status.Active) {
        _check(msg.sender == b, 29);
        address prevB = b;
        _refundFundsA();
        _refundFundsB();
        _unlockNftIfLocked(false);
        bNftId = 0;
        if (_trackBActive) {
            IFactoryIndex(factory).onParticipantRemoved(prevB);
            _trackBActive = false;
        }
        b = address(0);
        status = Status.Ready;
    }

    function kickBByA() external nonReentrant onlyA inState(Status.Active) {
        address prevB = b;
        _refundFundsA();
        _refundFundsB();
        _unlockNftIfLocked(false);
        bNftId = 0;
        if (_trackBActive) {
            IFactoryIndex(factory).onParticipantRemoved(prevB);
            _trackBActive = false;
        }
        b = address(0);
        status = Status.Ready;
    }

    function setMyVote(Vote v) external nonReentrant inState(Status.Locked) onlyAB {
        _check(v == Vote.Accept || v == Vote.Reject, 30);
        if (msg.sender == b && v == Vote.Reject) {
            if (aVote == Vote.Reject) {
                bVote = Vote.Reject;
                bAt = uint64(block.timestamp);
                _cancel();
                return;
            }
            _expelBOnReject();
            return;
        }
        if (msg.sender == a) {
            if (!(v == Vote.Accept && aVote == Vote.Accept)) {
                aVote = v;
                aAt = uint64(block.timestamp);
            }
        } else {
            bVote = v;
            bAt = uint64(block.timestamp);
        }

        if (aVote == Vote.Accept && bVote == Vote.Accept) _complete(CompletionReason.BothAccepted);
        else if (aVote == Vote.Reject && bVote == Vote.Reject) _cancel();
    }

    function _expelBOnReject() internal {
        address prevB = b;
        _refundFundsB();
        _unlockNftIfLocked(false);
        bNftId = 0;
        if (_trackBActive) {
            IFactoryIndex(factory).onParticipantRemoved(prevB);
            _trackBActive = false;
        }
        b = address(0);
        status = Status.Ready;
        aVote = Vote.Unset;
        bVote = Vote.Unset;
        aAt = 0;
        bAt = 0;
        emit BExpelledOnReject(prevB);
    }

    function forceComplete() external nonReentrant inState(Status.Locked) onlyAB {
        if (msg.sender == a && bVote == Vote.Unset) {
            _check(block.timestamp >= uint256(aAt) + uint256(timeoutSeconds), 31);
            if (aVote == Vote.Accept) {
                _complete(CompletionReason.ForcedByA);
                return;
            } else if (aVote == Vote.Reject) {
                _cancel();
                return;
            }
        } else if (msg.sender == b && aVote == Vote.Unset) {
            _check(block.timestamp >= uint256(bAt) + uint256(timeoutSeconds), 32);
            if (bVote == Vote.Accept) {
                _complete(CompletionReason.ForcedByB);
                return;
            } else if (bVote == Vote.Reject) {
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
        status = Status.Completed;

        Fees memory f = _computeFees();
        _processFees(f);
        emit FeesProcessed(aSwapToken, f.aFee, bSwapToken, f.bFee);

        Rewards memory r = _computeRewards();
        _mintAndRecord(r);
        DealLib.refreshMaxPointers(infoNft, factory, false, 0, bNftLocked, bNftId);

        aPaid = false;
        bPaid = false;
        aClaimed = true;
        bClaimed = true;

        _sendOut(bSwapToken, a, bSwapNetForA);
        _sendOut(aMarginToken, a, aMarginAmount);
        emit Claimed(a, bSwapToken, bSwapNetForA, aMarginToken, aMarginAmount);

        _sendOut(aSwapToken, b, aSwapNetForB);
        _sendOut(bMarginToken, b, bMarginAmount);
        emit Claimed(b, aSwapToken, aSwapNetForB, bMarginToken, bMarginAmount);

        if (_trackA) IFactoryIndex(factory).onCompletedFor(a);
        if (_trackBActive) IFactoryIndex(factory).onCompletedFor(b);

        if (_trackA) {
            IFactoryIndex(factory).onClosedFor(a);
            _trackA = false;
        }
        if (_trackBActive) {
            IFactoryIndex(factory).onClosedFor(b);
            _trackBActive = false;
        }

        _unlockNftIfLocked(false);
        bNftId = 0;

        emit Completed(reason);
    }

    function _cancel() internal {
        status = Status.Canceled;

        if (aPaid) {
            aPaid = false;
            aClaimed = true;
            _sendOut(aSwapToken, a, aSwapAmount);
            _sendOut(aMarginToken, a, aMarginAmount);
            emit Claimed(a, aSwapToken, aSwapAmount, aMarginToken, aMarginAmount);
        }
        if (bPaid) {
            bPaid = false;
            bClaimed = true;
            _sendOut(bSwapToken, b, bSwapAmount);
            _sendOut(bMarginToken, b, bMarginAmount);
            emit Claimed(b, bSwapToken, bSwapAmount, bMarginToken, bMarginAmount);
        }

        if (_trackA) {
            IFactoryIndex(factory).onClosedFor(a);
            _trackA = false;
        }
        if (_trackBActive) {
            IFactoryIndex(factory).onClosedFor(b);
            _trackBActive = false;
        }

        _unlockNftIfLocked(false);
        bNftId = 0;

        emit Canceled();
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
                aNftLocked: false,
                aNftId: 0,
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
                aNftLocked: false,
                aNftId: 0,
                bNftLocked: bNftLocked,
                bNftId: bNftId
            })
        );
    }

    function _mintAndRecord(Rewards memory r) internal {
        if (r.toA > 0) IFactoryMinter(factory).mintDL(a, r.toA);
        if (r.toB > 0) IFactoryMinter(factory).mintDL(b, r.toB);
        if (r.toC > 0 && r.cAddr != address(0)) IFactoryMinter(factory).mintDL(r.cAddr, r.toC);
        emit RewardsMinted(a, r.toA, b, r.toB, r.cAddr, r.toC);

        if (infoNft != address(0)) {
            if (bNftLocked && bNftId != 0 && r.toB > 0) IFactoryInfo(factory).infoAddMinted(bNftId, r.toB);
            if (r.cToken != 0 && r.toC > 0) IFactoryInfo(factory).infoAddMinted(r.cToken, r.toC);
        }
    }

    function _lockNftForBIfAny() internal {
        if (bNftId == 0 || bNftLocked) return;
        _check(IERC721(infoNft).ownerOf(bNftId) == b, 50);
        bNftLocked = true;
        IFactoryLock(factory).infoLock(bNftId, b);
    }

    function _unlockNftIfLocked(bool isA) internal {
        if (isA) return;
        if (bNftLocked && bNftId != 0) {
            bNftLocked = false;
            IFactoryLock(factory).infoUnlock(bNftId);
        }
    }

    function _quoteAggToDL(address token, address pair, uint256 amountIn) internal returns (uint256 dlOut) {
        return DealLib.quoteAggToDL(factory, dl, token, pair, amountIn);
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
            emit Locked();
        }
    }

    function _isSideReadyA() internal view returns (bool) {
        return !_sideNeedsPayA() || aPaid;
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

    function postMessage(string calldata content) external nonReentrant onlyAB {
        _check(status == Status.Active || status == Status.Locked || status == Status.Ready, 52);
        _chargeMessageFee(msg.sender);
        address hub = IFactoryMessageHub(factory).dealMessageHub();
        _check(hub != address(0), 54);
        uint256 idx = IDealMessageHub(hub).postFromDeal(msg.sender, content);
        emit MessagePosted(msg.sender, idx);
    }

    function _chargeMessageFee(address sender) internal {
        if (!msgPriceEnabled) return;
        if (msgPriceAmountInToken == 0) return;
        uint256 dlAmount = _quoteAggToDL(msgPriceTokenNorm, msgPricePair, msgPriceAmountInToken);
        if (dlAmount == 0) return;
        IDLBurnFrom(dl).burnFrom(sender, dlAmount);
        emit MessageFeeCharged(sender, dlAmount);
    }

    receive() external payable {}
}
