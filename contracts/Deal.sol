// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20}            from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721}           from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver}   from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {SafeERC20}         from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable}     from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard}   from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DealLib}           from "./utils/DealLib.sol";

/* ---------- 工厂侧接口（最小化） ---------- */
interface IFactoryAuth   { function isAllowedCreateFor(address) external view returns (bool); }
interface IFactoryMinter { function mintDL(address to, uint256 amount) external; }
interface IFactoryTwap   { function updateAndQuoteToDL(address pair, uint256 amountIn) external returns (uint256 dlOut); }
interface IFactoryMessageHub { function dealMessageHub() external view returns (address); }
interface IFactoryIndex {
    function onCreated(address creator, bool trackCreator) external;
    function onJoined(address participant, bool trackParticipant) external;
    function onParticipantRemoved(address prevParticipant) external;
    function onAbandoned(address creator, address prevParticipant) external;
    function onClosedFor(address user) external;

    // 仅在 Completed 时写入 “完成热索引 ring”
    function onCompletedFor(address user) external;
}
interface IFactoryInfo {
    function infoAddMinted(uint256 tokenId, uint256 amount) external;
    function infoSetMaxPartnerOf(uint256 tokenId, uint256 partnerTokenId) external;
}
/* 通过 Factory 锁/解锁 InfoNFT（仅 Deal 可调） */
interface IFactoryLock {
    function infoLock(uint256 tokenId, address holder) external;
    function infoUnlock(uint256 tokenId) external;
}

interface IWNATIVE is IERC20 { function deposit() external payable; function withdraw(uint256) external; }
interface IDLBurn { function burn(uint256 amount) external; }
interface IDLBurnFrom { function burnFrom(address account, uint256 amount) external; }
interface IDealMessageHub {
    function postFromDeal(address sender, string calldata content) external returns (uint256 index);
    function messagesCount(address deal) external view returns (uint256);
    function getMessages(
        address deal,
        uint256 offset,
        uint256 limit
    )
        external
        view
        returns (
            string[] memory contents,
            uint64[] memory times,
            address[] memory senders
        );
}

/* ---------- DealInfoNFT（只读） ---------- */
interface IDealInfoNFTView {
    function totalMintedOf(uint256 tokenId) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function maxPartnerOf(uint256 tokenId) external view returns (uint256);
    function isLocked(uint256 tokenId) external view returns (bool);
}

/* ========================================================== */
contract Deal is Initializable, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    error DealError(uint16 code);

    address public constant NATIVE = address(0);

    enum Status { Ready, Active, Locked, Completed, Canceled, Abandoned }
    enum JoinMode { Open, ExactAddress, NftGated, ExactAddressAndNftGated }
    enum TemplateType { TokenToToken, TokenToNft, TokenToEmpty, EmptyToEmpty, NftToEmpty }
    enum Vote { Unset, Accept, Reject }
    enum CompletionReason { BothAccepted, ForcedByA, ForcedByB }

    /* 基本信息 */
    address public factory;
    string  public title;
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
    address public bAssetNft;
    uint256 public bAssetNftId;
    bool    public aAssetNftDeposited;
    bool    public bAssetNftDeposited;

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

    /* ===== 留言计费 ===== */
    bool    public msgPriceEnabled;
    address public msgPriceTokenNorm;
    address public msgPricePair;
    uint256 public msgPriceAmountInToken;

    /* 事件 */
    event Initialized(address indexed initiator, address indexed factory);
    event Joined(address indexed b, bool nftLockedB);
    event Locked();
    event Completed(CompletionReason reason);
    event Canceled();
    event Claimed(address indexed who, address swapToken, uint256 swapAmt, address marginToken, uint256 marginAmt);
    event FeesProcessed(address indexed tokenA, uint256 aFee, address indexed tokenB, uint256 bFee);
    event RewardsMinted(address indexed a, uint256 toA, address indexed b, uint256 toB, address indexed cAddr, uint256 toC);
    event AssetNftDeposited(address indexed owner, uint256 indexed tokenId);
    event AssetNftReleased(address indexed to, uint256 indexed tokenId);
    event MessagePosted(address indexed sender, uint256 indexed index);
    event MessageFeeCharged(address indexed sender, uint256 dlBurned);

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
        string  title;        uint64  timeoutSeconds;
        uint64  timeStart;    uint64  timeEnd;
        bool    isDomainDeal;
        string  domainName;
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

        msgPriceEnabled=c.msgPriceEnabled; msgPriceTokenNorm=c.msgPriceTokenNorm;
        msgPricePair=c.msgPricePair; msgPriceAmountInToken=c.msgPriceAmountInToken;

        aSwapToken=p.aSwapToken; aSwapAmount=p.aSwapAmount; aMarginToken=p.aMarginToken; aMarginAmount=p.aMarginAmount;
        bSwapToken=p.bSwapToken; bSwapAmount=p.bSwapAmount; bMarginToken=p.bMarginToken; bMarginAmount=p.bMarginAmount;
        aAssetNft=p.aAssetNft; aAssetNftId=p.aAssetNftId;
        bAssetNft=p.bAssetNft; bAssetNftId=p.bAssetNftId;

        _check(p.templateType <= uint8(TemplateType.NftToEmpty), 9);
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

        title=p.title; timeoutSeconds=p.timeoutSeconds;
        timeStart = p.timeStart; timeEnd = p.timeEnd;
        if (timeStart != 0 || timeEnd != 0) _check(timeEnd > timeStart, 13);

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

        if (_trackA && _trackBActive) IFactoryIndex(factory).onAbandoned(a, prevB);
        else if (_trackA)             IFactoryIndex(factory).onAbandoned(a, address(0));
        else if (_trackBActive)       IFactoryIndex(factory).onParticipantRemoved(prevB);
        _trackA=false; _trackBActive=false;

        status = Status.Abandoned;
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

        _assertAssetNftAllowedForB();

        _lockNftForBIfAny();

        _trackBActive = trackMe;
        status = Status.Active;
        emit Joined(b, bNftLocked);
        if (_trackBActive) IFactoryIndex(factory).onJoined(b, true);
        _tryLock();
    }

    /* ========== Active：支付 / 撤回 / 退出 / 踢人 ========== */
    function pay() external payable nonReentrant inState(Status.Active) onlyAB {
        if (msg.sender == a) {
            _check(!aPaid, 23);
            _check(msg.value == _nativeRequired(true), 24);
            if (aSwapToken   != NATIVE) _pullExactERC20(IERC20(aSwapToken), aSwapAmount, msg.sender);
            if (aMarginToken != NATIVE) _pullExactERC20(IERC20(aMarginToken), aMarginAmount, msg.sender);
            _pullAssetNftForA();
            if (_sideNeedsPayA()) aPaid = true;
        } else {
            _check(b != address(0) && !bPaid, 25);
            _check(msg.value == _nativeRequired(false), 26);
            if (bSwapToken   != NATIVE) _pullExactERC20(IERC20(bSwapToken), bSwapAmount, msg.sender);
            if (bMarginToken != NATIVE) _pullExactERC20(IERC20(bMarginToken), bMarginAmount, msg.sender);
            _pullAssetNftForB();
            if (_sideNeedsPayB()) bPaid = true;
        }
        _tryLock();
    }

    function withdrawInActive() external nonReentrant inState(Status.Active) onlyAB {
        if (msg.sender == a) {
            _check(aPaid, 27); aPaid = false;
            _sendOut(aSwapToken, a, aSwapAmount);
            _sendOut(aMarginToken, a, aMarginAmount);
            _sendOutAssetNftToA();
        } else {
            _check(bPaid, 28); bPaid = false;
            _sendOut(bSwapToken, b, bSwapAmount);
            _sendOut(bMarginToken, b, bMarginAmount);
            _sendOutAssetNftToB();
        }
    }

    function exitByB() external nonReentrant inState(Status.Active) {
        _check(msg.sender == b, 29);
        address prevB = b;
        _refundFundsA(); _refundFundsB();
        _unlockNftIfLocked(false);
        bNftId = 0;
        if (_trackBActive) { IFactoryIndex(factory).onParticipantRemoved(prevB); _trackBActive = false; }
        b = address(0); status = Status.Ready;
    }

    function kickBByA() external nonReentrant onlyA inState(Status.Active) {
        address prevB = b;
        _refundFundsA(); _refundFundsB();
        _unlockNftIfLocked(false);
        bNftId = 0;
        if (_trackBActive) { IFactoryIndex(factory).onParticipantRemoved(prevB); _trackBActive = false; }
        b = address(0); status = Status.Ready;
    }

    /* ========== Locked：投票 / 强制完成 / 取消 ========== */
    function setMyVote(Vote v) external nonReentrant inState(Status.Locked) onlyAB {
        _check(v == Vote.Accept || v == Vote.Reject, 30);
        if (msg.sender == a) { aVote = v; aAt = uint64(block.timestamp); }
        else { bVote = v; bAt = uint64(block.timestamp); }

        if (aVote == Vote.Accept && bVote == Vote.Accept) _complete(CompletionReason.BothAccepted);
        else if (aVote == Vote.Reject && bVote == Vote.Reject) _cancel();
    }

    function forceComplete() external nonReentrant inState(Status.Locked) onlyAB {
        if (msg.sender == a && bVote == Vote.Unset) {
            _check(block.timestamp >= uint256(aAt) + uint256(timeoutSeconds), 31);
            if (aVote == Vote.Accept) {
                _complete(CompletionReason.ForcedByA); return;
            } else if (aVote == Vote.Reject) {
                _cancel(); return;
            }
        } else if (msg.sender == b && aVote == Vote.Unset) {
            _check(block.timestamp >= uint256(bAt) + uint256(timeoutSeconds), 32);
            if (bVote == Vote.Accept) {
                _complete(CompletionReason.ForcedByB); return;
            } else if (bVote == Vote.Reject) {
                _cancel(); return;
            }
        } 
        
        revert DealError(33);
    }

    /* ========== 完成 / 取消（自动结算） ========== */
    struct Fees    { uint256 aFee; uint256 bFee; }
    struct Rewards { uint256 toA;  uint256 toB;  uint256 toC; address cAddr; uint256 cToken; }

    // 完成：当场派发 & 清理（先置终态，符合 CEI，降低重入窗口）
    function _complete(CompletionReason reason) internal {
        status = Status.Completed;

        Fees memory f = _computeFees();
        _processFees(f); emit FeesProcessed(aSwapToken, f.aFee, bSwapToken, f.bFee);

        Rewards memory r = _computeRewards();
        _mintAndRecord(r);
        _refreshMaxPointers();

        // 内部标记
        aPaid = false; bPaid = false;
        aClaimed = true; bClaimed = true;

        // === 结算派发（完成态） ===
        _sendOut(bSwapToken, a, bSwapNetForA);
        _sendOut(aMarginToken, a, aMarginAmount);
        _settleAssetNftToA();

        emit Claimed(a, bSwapToken, bSwapNetForA, aMarginToken, aMarginAmount);

        _sendOut(aSwapToken, b, aSwapNetForB);
        _sendOut(bMarginToken, b, bMarginAmount);
        _settleAssetNftToB();

        emit Claimed(b, aSwapToken, aSwapNetForB, bMarginToken, bMarginAmount);

        // 仅当该侧开启过热索引追踪，才写入“完成热索引 ring”
        if (_trackA)       { IFactoryIndex(factory).onCompletedFor(a); }
        if (_trackBActive) { IFactoryIndex(factory).onCompletedFor(b); }

        // 解锁 NFT + 清理“活跃热索引”
        _unlockNftIfLocked(true);
        _unlockNftIfLocked(false);
        if (_trackA)       { IFactoryIndex(factory).onClosedFor(a); _trackA = false; }
        if (_trackBActive) { IFactoryIndex(factory).onClosedFor(b); _trackBActive = false; }

        emit Completed(reason);
    }

    // 取消：当场退款 & 清理（先置终态，符合 CEI，降低重入窗口）
    function _cancel() internal {
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
            _sendOutAssetNftToB();
            emit Claimed(b, bSwapToken, bSwapAmount, bMarginToken, bMarginAmount);
        }

        _unlockNftIfLocked(true);
        _unlockNftIfLocked(false);
        
        if (_trackA)       { IFactoryIndex(factory).onClosedFor(a); _trackA = false; }
        if (_trackBActive) { IFactoryIndex(factory).onClosedFor(b); _trackBActive = false; }

        emit Canceled();
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
        if (aSwapAmount > 0 && aTokenNorm == dl && bSwapAmount > 0 && bTokenNorm == dl) {
            _handleDlToDlFees(f.aFee + f.bFee);
            return;
        }
        _handleOneSideFees(aSwapToken, aTokenNorm, aPair, f.aFee);
        _handleOneSideFees(bSwapToken, bTokenNorm, bPair, f.bFee);
    }
    function _handleDlToDlFees(uint256 fee) internal {
        if (fee == 0) return;
        (uint256 cToken, address cAddr) = _resolveCRewardTarget();
        if (cToken != 0 && cAddr != address(0)) {
            IERC20(dl).safeTransfer(cAddr, fee);
        } else {
            IDLBurn(dl).burn(fee);
        }
    }
    function _handleOneSideFees(address token, address tokenNorm, address pair, uint256 fee) internal {
        if (fee == 0) return;
        if (
            DealLib.isRecognizedToken(tokenNorm, WNATIVE, recognizedToken0, recognizedToken1)
                && pair != address(0)
        ) {
            if (token == NATIVE) {
                IWNATIVE(WNATIVE).deposit{value: fee}();
                IERC20(WNATIVE).safeTransfer(pair, fee);
            } else {
                IERC20(tokenNorm).safeTransfer(pair, fee);
            }
            (bool okPair, bytes memory data) = pair.call(abi.encodeWithSignature("mintOtherOnly()"));
            _check(okPair && (data.length == 32 || data.length == 0), 34);
            return;
        }
        // treasury 在 initialize 中已校验非零；此处为防御性断言
        _check(treasury != address(0), 53);
        if (token == NATIVE) { (bool ok, ) = payable(treasury).call{value: fee}(""); _check(ok, 35); }
        else IERC20(tokenNorm).safeTransfer(treasury, fee);
    }

    /* ========== 奖励（按认可币交易额返 DL） ========== */
    function _computeRewards() internal returns (Rewards memory r) {
        if (mintOnFeesNum == 0) return r;

        bool aHasSwap = aSwapAmount > 0;
        bool bHasSwap = bSwapAmount > 0;

        if (
            (aHasSwap
                && !DealLib.isRecognizedOrDL(
                    aTokenNorm, dl, WNATIVE, recognizedToken0, recognizedToken1
                ))
                || (bHasSwap
                    && !DealLib.isRecognizedOrDL(
                        bTokenNorm, dl, WNATIVE, recognizedToken0, recognizedToken1
                    ))
        ) {
            return r;
        }

        if (aHasSwap && aTokenNorm == dl && bHasSwap && bTokenNorm == dl) {
            return r;
        }

        (uint256 cToken, address cAddr) = _resolveCRewardTarget();
        uint256 perRole =
            _rewardFromRecognizedSide(aSwapToken, aTokenNorm, aPair, aSwapAmount) +
            _rewardFromRecognizedSide(bSwapToken, bTokenNorm, bPair, bSwapAmount);
        if (perRole == 0) return r;

        r.toA = perRole;
        r.toB = perRole;
        if (cToken != 0) {
            r.cToken = cToken;
            r.cAddr  = cAddr;
            r.toC    = perRole;
        }
    }

    function _rewardFromRecognizedSide(
        address token,
        address tokenNorm,
        address pair,
        uint256 amount
    ) internal returns (uint256 dlOut) {
        if (amount == 0) return 0;
        if (!DealLib.isRecognizedToken(tokenNorm, WNATIVE, recognizedToken0, recognizedToken1)) return 0;
        uint256 rewardBasis = (amount * mintOnFeesNum) / mintOnFeesDen;
        return _quoteAggToDL(token, pair, rewardBasis);
    }

    function _resolveCRewardTarget() internal view returns (uint256 cToken, address cAddr) {
        return DealLib.resolveCRewardTarget(infoNft, a, b, aNftLocked, aNftId, bNftLocked, bNftId);
    }

    /* ---------- 铸币 & 统计（通过 Factory 代理写 InfoNFT） ---------- */
    function _mintAndRecord(Rewards memory r) internal {
        if (r.toA > 0) IFactoryMinter(factory).mintDL(a, r.toA);
        if (r.toB > 0) IFactoryMinter(factory).mintDL(b, r.toB);
        if (r.toC > 0 && r.cAddr != address(0)) IFactoryMinter(factory).mintDL(r.cAddr, r.toC);
        emit RewardsMinted(a, r.toA, b, r.toB, r.cAddr, r.toC);

        if (infoNft != address(0)) {
            if (aNftLocked && aNftId != 0 && r.toA > 0) IFactoryInfo(factory).infoAddMinted(aNftId, r.toA);
            if (bNftLocked && bNftId != 0 && r.toB > 0) IFactoryInfo(factory).infoAddMinted(bNftId, r.toB);
            if (r.cToken != 0 && r.toC > 0) IFactoryInfo(factory).infoAddMinted(r.cToken, r.toC);
        }
    }

    /* ---------- 完成后更新 maxA / maxB（通过 Factory 代理） ---------- */
    function _refreshMaxPointers() internal {
        DealLib.refreshMaxPointers(infoNft, factory, aNftLocked, aNftId, bNftLocked, bNftId);
    }

    /* ========== 折算 ========== */
    function _quoteAggToDL(address token, address pair, uint256 amountIn) internal returns (uint256 dlOut) {
        if (amountIn == 0) return 0;
        if (token == dl) return amountIn;
        if (pair == address(0)) return 0;
        try IFactoryTwap(factory).updateAndQuoteToDL(pair, amountIn) returns (uint256 x) { return x; } catch { return 0; }
    }

    /* ========== 自动锁定判定 ========== */
    function _tryLock() internal {
        if (status != Status.Active) return;
        if (_isSideReadyA() && _isSideReadyB()) {
            status = Status.Locked;
            lockedAt = uint64(block.timestamp);
            aVote = Vote.Unset; bVote = Vote.Unset; aAt = 0; bAt = 0;
            emit Locked();
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
        if (bPaid) { bPaid=false; _sendOut(bSwapToken,b,bSwapAmount); _sendOut(bMarginToken,b,bMarginAmount); _sendOutAssetNftToB(); }
    }
    function _refundAllToParties() internal { _refundFundsA(); _refundFundsB(); b = address(0); }

    function _sideNeedsPayA() internal view returns (bool) {
        return aSwapAmount > 0 || aMarginAmount > 0 || aAssetNftId != 0;
    }
    function _sideNeedsPayB() internal view returns (bool) {
        return bSwapAmount > 0 || bMarginAmount > 0 || bAssetNftId != 0;
    }

    function _pullAssetNftForA() internal {
        if (aAssetNftId == 0 || aAssetNftDeposited) return;
        _assertAssetNftAllowedForA();
        IERC721(_assetNftContractForA()).safeTransferFrom(a, address(this), aAssetNftId);
        aAssetNftDeposited = true;
        emit AssetNftDeposited(a, aAssetNftId);
    }
    function _pullAssetNftForB() internal {
        if (bAssetNftId == 0 || bAssetNftDeposited) return;
        _assertAssetNftAllowedForB();
        IERC721(_assetNftContractForB()).safeTransferFrom(b, address(this), bAssetNftId);
        bAssetNftDeposited = true;
        emit AssetNftDeposited(b, bAssetNftId);
    }
    function _settleAssetNftToA() internal {
        if (!bAssetNftDeposited || bAssetNftId == 0) return;
        bAssetNftDeposited = false;
        IERC721(_assetNftContractForB()).safeTransferFrom(address(this), a, bAssetNftId);
        emit AssetNftReleased(a, bAssetNftId);
    }
    function _settleAssetNftToB() internal {
        if (!aAssetNftDeposited || aAssetNftId == 0) return;
        aAssetNftDeposited = false;
        IERC721(_assetNftContractForA()).safeTransferFrom(address(this), b, aAssetNftId);
        emit AssetNftReleased(b, aAssetNftId);
    }
    function _sendOutAssetNftToA() internal {
        if (!aAssetNftDeposited || aAssetNftId == 0) return;
        aAssetNftDeposited = false;
        IERC721(_assetNftContractForA()).safeTransferFrom(address(this), a, aAssetNftId);
        emit AssetNftReleased(a, aAssetNftId);
    }
    function _sendOutAssetNftToB() internal {
        if (!bAssetNftDeposited || bAssetNftId == 0) return;
        bAssetNftDeposited = false;
        IERC721(_assetNftContractForB()).safeTransferFrom(address(this), b, bAssetNftId);
        emit AssetNftReleased(b, bAssetNftId);
    }

    function _assetNftContractForA() internal view returns (address) {
        return aAssetNft == address(0) ? infoNft : aAssetNft;
    }
    function _assetNftContractForB() internal view returns (address) {
        return bAssetNft == address(0) ? infoNft : bAssetNft;
    }

    function _assertAssetNftAllowedForA() internal view {
        if (aAssetNftId == 0) return;
        address nft = _assetNftContractForA();
        _check(nft != address(0), 38);
        if (nft == infoNft) {
            _check(aAssetNftId != aNftId, 39);
            _check(aAssetNftId != gateNftId, 40);
            _check(IDealInfoNFTView(infoNft).ownerOf(aAssetNftId) == a, 41);
            _check(!IDealInfoNFTView(infoNft).isLocked(aAssetNftId), 42);
        } else {
            _check(IERC721(nft).ownerOf(aAssetNftId) == a, 41);
        }
    }
    function _assertAssetNftAllowedForB() internal view {
        if (bAssetNftId == 0) return;
        address nft = _assetNftContractForB();
        _check(nft != address(0), 43);
        _check(b != address(0), 44);
        if (nft == infoNft) {
            _check(bAssetNftId != bNftId, 45);
            _check(bAssetNftId != gateNftId, 46);
            _check(IDealInfoNFTView(infoNft).ownerOf(bAssetNftId) == b, 47);
            _check(!IDealInfoNFTView(infoNft).isLocked(bAssetNftId), 48);
        } else {
            _check(IERC721(nft).ownerOf(bAssetNftId) == b, 47);
        }
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

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        _check(
            msg.sender == infoNft
                || msg.sender == _assetNftContractForA()
                || msg.sender == _assetNftContractForB(),
            51
        );
        return IERC721Receiver.onERC721Received.selector;
    }

    /* ========== 链上聊天 ========== */
    function postMessage(string calldata content) external nonReentrant onlyAB {
        _check(
            status == Status.Active || status == Status.Locked || status == Status.Ready,
            52
        );
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

    // 接收原生
    receive() external payable {}
}
