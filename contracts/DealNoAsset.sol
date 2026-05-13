// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DealLib} from "./utils/DealLib.sol";
import {DealError} from "./utils/DealErrors.sol";

interface IFactoryAuthNoAsset {
    function isAllowedCreateFor(address) external view returns (bool);
}

interface IFactoryMinterNoAsset {
    function mintDL(address to, uint256 amount) external;
}

interface IFactoryDealRewardsLogNoAsset {
    function logDealRewards(
        address partyA,
        uint256 toA,
        address partyB,
        uint256 toB,
        address cAddr,
        uint256 toC
    ) external;
}

interface IFactoryMessageHubNoAsset {
    function dealMessageHub() external view returns (address);
}

interface IFactoryIndexNoAsset {
    function onCreated(address creator, bool trackCreator) external;
    function onJoined(address participant, bool trackParticipant) external;
    function onParticipantRemoved(address prevParticipant) external;
    function onAbandoned(address creator, address prevParticipant) external;
    function onClosedFor(address user) external;
    function onCompletedFor(address user) external;
}

interface IFactoryInfoNoAsset {
    function infoAddMinted(uint256 tokenId, uint256 amount) external;
}

interface IFactoryLockNoAsset {
    function infoLock(uint256 tokenId, address holder) external;
    function infoUnlock(uint256 tokenId) external;
}

interface IFactoryCreditNoAsset {
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

interface IDLBurnFromNoAsset {
    function burnFrom(address account, uint256 amount) external;
}

interface IDealMessageHubNoAsset {
    function postFromDeal(address sender, string calldata content) external returns (uint256 index);
}

/// @notice Smaller ordinary deal implementation for templates without delivered asset NFTs.
contract DealNoAsset is Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant NATIVE = address(0);

    enum Status { Ready, Active, Locked, Completed, Canceled, Abandoned }
    enum JoinMode { Open, ExactAddress, NftGated, ExactAddressAndNftGated }
    enum Vote { Unset, Accept, Reject }
    enum CompletionReason { BothAccepted, ForcedByA, ForcedByB }

    address public factory;
    string public title;
    string public description;
    address public a;
    address public b;

    bool public isDomainDeal;
    string public domainName;

    Status public status;
    JoinMode public joinMode;
    uint8 public templateType;
    address public expectedB;

    uint256 public gateNftId;
    uint256 public aNftId;
    uint256 public bNftId;
    bool public aNftLocked;
    bool public bNftLocked;

    address public constant aAssetNft = address(0);
    uint256 public constant aAssetNftId = 0;
    address public constant bAssetNft = address(0);
    uint256 public constant bAssetNftId = 0;
    bool public constant aAssetNftDeposited = false;
    bool public constant bAssetNftDeposited = false;

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
    event Joined(address indexed b, bool nftLockedB, uint64 when);
    event Locked(uint64 when);
    event VoteCast(address indexed who, bool indexed isPartyA, Vote vote, uint64 when);
    event ActivePartnerCleared(address indexed prevB, uint8 reason, uint64 when);
    event DealAbandoned(address indexed initiator, uint64 when);
    event ForcedAfterTimeout(address indexed caller, bool completed, uint64 when);
    event Completed(CompletionReason reason);
    event Canceled();
    event Claimed(address indexed who, address swapToken, uint256 swapAmt, address marginToken, uint256 marginAmt);
    event FeesProcessed(address indexed tokenA, uint256 aFee, address indexed tokenB, uint256 bFee);
    event RewardsMinted(address indexed a, uint256 toA, address indexed b, uint256 toB, address indexed cAddr, uint256 toC);
    event MessagePosted(address indexed sender, uint256 indexed index);
    event MessageFeeCharged(address indexed sender, uint256 dlBurned);
    event Paid(address indexed payer, bool indexed isPartyA, uint64 when);
    event WithdrawnInActive(address indexed payer, bool indexed isPartyA, uint64 when);

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
        _check(!p.openTokenTokenFast, 56);
        _check(_factory != address(0) && _initiator != address(0), 4);
        _check(p.timeoutSeconds > 0, 5);
        _check(c.dl != address(0) && c.WNATIVE != address(0), 6);
        _check(c.treasury != address(0), 53);
        _check(p.templateType == 0 || p.templateType == 2 || p.templateType == 3, 9);
        _check(p.joinMode <= uint8(JoinMode.ExactAddressAndNftGated), 10);
        _check(
            p.aAssetNft == address(0) && p.aAssetNftId == 0 && p.bAssetNft == address(0) && p.bAssetNftId == 0,
            38
        );

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

        templateType = p.templateType;
        joinMode = JoinMode(p.joinMode);
        expectedB = p.expectedB;
        if (joinMode == JoinMode.ExactAddress || joinMode == JoinMode.ExactAddressAndNftGated) {
            _check(expectedB != address(0), 11);
        }

        gateNftId = p.gateNftId;
        if (joinMode == JoinMode.NftGated || joinMode == JoinMode.ExactAddressAndNftGated) {
            _check(gateNftId != 0, 12);
        }
        aNftId = p.aNftId;

        title = p.title;
        description = p.description;
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
        _lockNftForAIfAny();

        address aNorm = (aSwapToken == NATIVE) ? WNATIVE : aSwapToken;
        address bNorm = (bSwapToken == NATIVE) ? WNATIVE : bSwapToken;
        _check(aNorm == aTokenNorm && bNorm == bTokenNorm, 14);

        _trackA = c.trackCreator;
        if (_trackA) IFactoryIndexNoAsset(factory).onCreated(a, true);

        emit Initialized(a, factory);
    }

    function updateAmounts(
        uint256 _aSwapAmount,
        uint256 _aMarginAmount,
        uint256 _bSwapAmount,
        uint256 _bMarginAmount
    ) external onlyA inState(Status.Ready) {
        aSwapAmount = _aSwapAmount;
        aMarginAmount = _aMarginAmount;
        bSwapAmount = _bSwapAmount;
        bMarginAmount = _bMarginAmount;
    }

    function abandonByA() external nonReentrant onlyA {
        _check(status == Status.Ready || status == Status.Active, 16);
        address prevB = b;
        _refundAllToParties();
        _unlockNftIfLocked(true);
        _unlockNftIfLocked(false);
        bNftId = 0;

        if (_trackA && _trackBActive) IFactoryIndexNoAsset(factory).onAbandoned(a, prevB);
        else if (_trackA) IFactoryIndexNoAsset(factory).onAbandoned(a, address(0));
        else if (_trackBActive) IFactoryIndexNoAsset(factory).onParticipantRemoved(prevB);
        _trackA = false;
        _trackBActive = false;

        status = Status.Abandoned;
        emit DealAbandoned(a, uint64(block.timestamp));
    }

    function openJoinFor(address chosenB) external inState(Status.Ready) {
        _check(msg.sender == a || IFactoryAuthNoAsset(factory).isAllowedCreateFor(msg.sender), 15);
        _check(b == address(0), 17);
        _check(chosenB != address(0) && chosenB != a, 18);
        expectedB = chosenB;
        joinMode = JoinMode.ExactAddress;
    }

    function join(uint256 optId, bool trackMe) external nonReentrant inState(Status.Ready) {
        _check(b == address(0), 17);
        _check(a != msg.sender, 18);
        if (joinMode == JoinMode.NftGated || joinMode == JoinMode.ExactAddressAndNftGated) {
            if (joinMode == JoinMode.ExactAddressAndNftGated) _check(msg.sender == expectedB, 19);
            _check(IERC721(infoNft).ownerOf(gateNftId) == msg.sender, 20);
            b = msg.sender;
            bNftId = gateNftId;
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
        if (_trackBActive) IFactoryIndexNoAsset(factory).onJoined(b, true);
        _tryLock();
    }

    function pay() external payable nonReentrant inState(Status.Active) onlyAB {
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
        if (injected) emit Paid(msg.sender, msg.sender == a, uint64(block.timestamp));
        _tryLock();
    }

    function withdrawInActive() external nonReentrant inState(Status.Active) onlyAB {
        if (msg.sender == a) {
            _check(aPaid, 27);
            aPaid = false;
            _sendOut(aSwapToken, a, aSwapAmount);
            _sendOut(aMarginToken, a, aMarginAmount);
            emit WithdrawnInActive(a, true, uint64(block.timestamp));
        } else {
            _check(bPaid, 28);
            bPaid = false;
            _sendOut(bSwapToken, b, bSwapAmount);
            _sendOut(bMarginToken, b, bMarginAmount);
            emit WithdrawnInActive(b, false, uint64(block.timestamp));
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
            IFactoryIndexNoAsset(factory).onParticipantRemoved(prevB);
            _trackBActive = false;
        }
        b = address(0);
        status = Status.Ready;
        emit ActivePartnerCleared(prevB, 1, uint64(block.timestamp));
    }

    function kickBByA() external nonReentrant onlyA inState(Status.Active) {
        address prevB = b;
        _refundFundsA();
        _refundFundsB();
        _unlockNftIfLocked(false);
        bNftId = 0;
        if (_trackBActive) {
            IFactoryIndexNoAsset(factory).onParticipantRemoved(prevB);
            _trackBActive = false;
        }
        b = address(0);
        status = Status.Ready;
        emit ActivePartnerCleared(prevB, 2, uint64(block.timestamp));
    }

    function setMyVote(Vote v) external nonReentrant inState(Status.Locked) onlyAB {
        _check(v == Vote.Accept || v == Vote.Reject, 30);
        uint64 ts = uint64(block.timestamp);
        if (msg.sender == a) {
            aVote = v;
            aAt = ts;
        } else {
            bVote = v;
            bAt = ts;
        }
        emit VoteCast(msg.sender, msg.sender == a, v, ts);

        if (aVote == Vote.Accept && bVote == Vote.Accept) _complete(CompletionReason.BothAccepted);
        else if (aVote == Vote.Reject && bVote == Vote.Reject) _cancel();
    }

    function forceComplete() external nonReentrant inState(Status.Locked) onlyAB {
        uint64 ts = uint64(block.timestamp);
        if (msg.sender == a && bVote == Vote.Unset) {
            _check(block.timestamp >= uint256(aAt) + uint256(timeoutSeconds), 31);
            if (aVote == Vote.Accept) {
                emit ForcedAfterTimeout(msg.sender, true, ts);
                _complete(CompletionReason.ForcedByA);
                return;
            } else if (aVote == Vote.Reject) {
                emit ForcedAfterTimeout(msg.sender, false, ts);
                _cancel();
                return;
            }
        } else if (msg.sender == b && aVote == Vote.Unset) {
            _check(block.timestamp >= uint256(bAt) + uint256(timeoutSeconds), 32);
            if (bVote == Vote.Accept) {
                emit ForcedAfterTimeout(msg.sender, true, ts);
                _complete(CompletionReason.ForcedByB);
                return;
            } else if (bVote == Vote.Reject) {
                emit ForcedAfterTimeout(msg.sender, false, ts);
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
        _recordDealCredit(f);
        DealLib.refreshMaxPointers(infoNft, factory, aNftLocked, aNftId, bNftLocked, bNftId);

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

        if (_trackA) IFactoryIndexNoAsset(factory).onCompletedFor(a);
        if (_trackBActive) IFactoryIndexNoAsset(factory).onCompletedFor(b);

        _unlockNftIfLocked(true);
        _unlockNftIfLocked(false);
        if (_trackA) {
            IFactoryIndexNoAsset(factory).onClosedFor(a);
            _trackA = false;
        }
        if (_trackBActive) {
            IFactoryIndexNoAsset(factory).onClosedFor(b);
            _trackBActive = false;
        }

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

        _unlockNftIfLocked(true);
        _unlockNftIfLocked(false);
        if (_trackA) {
            IFactoryIndexNoAsset(factory).onClosedFor(a);
            _trackA = false;
        }
        if (_trackBActive) {
            IFactoryIndexNoAsset(factory).onClosedFor(b);
            _trackBActive = false;
        }

        emit Canceled();
    }

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
        if (r.toA > 0) IFactoryMinterNoAsset(factory).mintDL(a, r.toA);
        if (r.toB > 0) IFactoryMinterNoAsset(factory).mintDL(b, r.toB);
        if (r.toC > 0 && r.cAddr != address(0)) IFactoryMinterNoAsset(factory).mintDL(r.cAddr, r.toC);
        emit RewardsMinted(a, r.toA, b, r.toB, r.cAddr, r.toC);
        IFactoryDealRewardsLogNoAsset(factory).logDealRewards(a, r.toA, b, r.toB, r.cAddr, r.toC);

        if (infoNft != address(0)) {
            if (aNftLocked && aNftId != 0 && r.toA > 0) IFactoryInfoNoAsset(factory).infoAddMinted(aNftId, r.toA);
            if (bNftLocked && bNftId != 0 && r.toB > 0) IFactoryInfoNoAsset(factory).infoAddMinted(bNftId, r.toB);
            if (r.cToken != 0 && r.toC > 0) IFactoryInfoNoAsset(factory).infoAddMinted(r.cToken, r.toC);
        }
    }

    function _recordDealCredit(Fees memory f) internal {
        if (infoNft == address(0)) return;
        uint256 baseCredit = DealLib.feeCreditU(aTokenNorm, f.aFee, recognizedToken0, recognizedToken1)
            + DealLib.feeCreditU(bTokenNorm, f.bFee, recognizedToken0, recognizedToken1);
        if (baseCredit == 0) return;
        IFactoryCreditNoAsset(factory).recordDealCredit(a, b, aNftId, aNftLocked, bNftId, bNftLocked, baseCredit);
    }

    function _tryLock() internal {
        if (status != Status.Active) return;
        if (_isSideReadyA() && _isSideReadyB()) {
            status = Status.Locked;
            lockedAt = uint64(block.timestamp);
            aVote = Vote.Unset;
            bVote = Vote.Unset;
            aAt = 0;
            bAt = 0;
            emit Locked(lockedAt);
        }
    }

    function _isSideReadyA() internal view returns (bool) {
        bool tokensReady = !_sideNeedsPayA() || aPaid;
        bool nftReady = aNftId == 0 || aNftLocked;
        return tokensReady && nftReady;
    }

    function _isSideReadyB() internal view returns (bool) {
        bool tokensReady = !_sideNeedsPayB() || bPaid;
        bool nftNeeded = joinMode == JoinMode.NftGated || bNftId != 0;
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
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
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

    function _lockNftForAIfAny() internal {
        if (aNftId == 0 || aNftLocked) return;
        _check(IERC721(infoNft).ownerOf(aNftId) == a, 49);
        aNftLocked = true;
        IFactoryLockNoAsset(factory).infoLock(aNftId, a);
    }

    function _lockNftForBIfAny() internal {
        if (bNftId == 0 || bNftLocked) return;
        _check(IERC721(infoNft).ownerOf(bNftId) == b, 50);
        bNftLocked = true;
        IFactoryLockNoAsset(factory).infoLock(bNftId, b);
    }

    function _unlockNftIfLocked(bool isA) internal {
        if (isA) {
            if (aNftLocked && aNftId != 0) {
                aNftLocked = false;
                IFactoryLockNoAsset(factory).infoUnlock(aNftId);
            }
        } else {
            if (bNftLocked && bNftId != 0) {
                bNftLocked = false;
                IFactoryLockNoAsset(factory).infoUnlock(bNftId);
            }
        }
    }

    function _quoteAggToDL(address token, address pair, uint256 amountIn) internal returns (uint256 dlOut) {
        return DealLib.quoteAggToDL(factory, dl, token, pair, amountIn);
    }

    function postMessage(string calldata content) external nonReentrant onlyAB {
        _check(
            status == Status.Ready || status == Status.Active || status == Status.Locked || status == Status.Completed
                || status == Status.Canceled || status == Status.Abandoned,
            52
        );
        _chargeMessageFee(msg.sender);
        address hub = IFactoryMessageHubNoAsset(factory).dealMessageHub();
        _check(hub != address(0), 54);
        uint256 idx = IDealMessageHubNoAsset(hub).postFromDeal(msg.sender, content);
        emit MessagePosted(msg.sender, idx);
    }

    function _chargeMessageFee(address sender) internal {
        if (!msgPriceEnabled) return;
        if (msgPriceAmountInToken == 0) return;
        uint256 dlAmount = _quoteAggToDL(msgPriceTokenNorm, msgPricePair, msgPriceAmountInToken);
        if (dlAmount == 0) return;
        IDLBurnFromNoAsset(dl).burnFrom(sender, dlAmount);
        emit MessageFeeCharged(sender, dlAmount);
    }

    receive() external payable {}
}
