// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20}            from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721}           from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20}         from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable}     from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard}   from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/* ---------- 工厂侧接口（最小化） ---------- */
interface IFactoryMinter { function mintDL(address to, uint256 amount) external; }
interface IFactoryTwap   { function updateAndQuoteToDL(address pair, uint256 amountIn) external returns (uint256 dlOut); }
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
interface IDLBurnFrom { function burnFrom(address account, uint256 amount) external; }

/* ---------- DealInfoNFT（只读） ---------- */
interface IDealInfoNFTView {
    function totalMintedOf(uint256 tokenId) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function maxPartnerOf(uint256 tokenId) external view returns (uint256);
}

/* ========================================================== */
contract Deal is Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant NATIVE = address(0);

    enum Status { Ready, Active, Locked, Completed, Canceled, Abandoned }
    enum JoinMode { Open, ExactAddress, NftGated }
    enum Vote { Unset, Accept, Reject }
    enum CompletionReason { BothAccepted, ForcedByA, ForcedByB }

    /* 基本信息 */
    address public factory;
    string  public title;
    address public a;
    address public b;

    Status   public status;
    JoinMode public joinMode;
    address  public expectedB;

    // 门禁 & NFT（仅锁引用）
    uint256 public gateNftId;
    uint256 public aNftId;
    uint256 public bNftId;
    bool    public aNftLocked;
    bool    public bNftLocked;

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

    /* ===== 留言存储 ===== */
    string[]  private _msgContents;
    uint64[]  private _msgTimes;
    address[] private _msgSenders;

    /* 事件 */
    event Initialized(address indexed initiator, address indexed factory);
    event Joined(address indexed b, bool nftLockedB);
    event Locked();
    event Completed(CompletionReason reason);
    event Canceled();
    event Claimed(address indexed who, address swapToken, uint256 swapAmt, address marginToken, uint256 marginAmt);
    event FeesProcessed(address indexed tokenA, uint256 aFee, address indexed tokenB, uint256 bFee);
    event RewardsMinted(address indexed a, uint256 toA, address indexed b, uint256 toB, address indexed cAddr, uint256 toC);

    event MessagePosted(address indexed from, uint256 indexed idx, uint64 ts, string content);
    event MessageFeeCharged(address indexed from, uint256 dlBurned, address indexed tokenNorm, uint256 tokenAmount);

    modifier onlyA()  { require(msg.sender == a, "ONLY_A"); _; }
    modifier onlyAB() { require(msg.sender == a || msg.sender == b, "ONLY_AB"); _; }
    modifier inState(Status s) { require(status == s, "BAD_STATE"); _; }

    /* ------------ 初始化 ------------ */
    struct InitParams {
        address aSwapToken;   uint256 aSwapAmount;
        address aMarginToken; uint256 aMarginAmount;
        address bSwapToken;   uint256 bSwapAmount;
        address bMarginToken; uint256 bMarginAmount;
        uint8   joinMode;     address expectedB;
        uint256 gateNftId;
        uint256 aNftId;
        string  title;        uint64  timeoutSeconds;
    }
    struct ConfigParams {
        address dl;           address infoNft;     address treasury; address WNATIVE;
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
        require(_factory != address(0) && _initiator != address(0), "ZERO");
        require(p.timeoutSeconds > 0, "TIMEOUT");
        require(c.dl != address(0) && c.WNATIVE != address(0), "DL/WNATIVE");

        factory = _factory; a = _initiator;
        dl=c.dl; infoNft=c.infoNft; treasury=c.treasury; WNATIVE=c.WNATIVE;
        aTokenNorm=c.aTokenNorm; bTokenNorm=c.bTokenNorm; aPair=c.aPair; bPair=c.bPair;
        feeNonDLNum=c.feeNonDLNum; feeNonDLDen=c.feeNonDLDen; mintOnFeesNum=c.mintOnFeesNum; mintOnFeesDen=c.mintOnFeesDen;
        require(feeNonDLDen>0 && feeNonDLNum<feeNonDLDen, "FEE_RATIO");
        require(mintOnFeesDen>0 && mintOnFeesNum<mintOnFeesDen, "MINT_RATIO");
        specialNoFeeToken=c.specialNoFeeToken;

        msgPriceEnabled=c.msgPriceEnabled; msgPriceTokenNorm=c.msgPriceTokenNorm;
        msgPricePair=c.msgPricePair; msgPriceAmountInToken=c.msgPriceAmountInToken;

        aSwapToken=p.aSwapToken; aSwapAmount=p.aSwapAmount; aMarginToken=p.aMarginToken; aMarginAmount=p.aMarginAmount;
        bSwapToken=p.bSwapToken; bSwapAmount=p.bSwapAmount; bMarginToken=p.bMarginToken; bMarginAmount=p.bMarginAmount;

        require(p.joinMode <= uint8(JoinMode.NftGated), "JOIN_MODE");
        joinMode  = JoinMode(p.joinMode);
        expectedB = p.expectedB;

        gateNftId = p.gateNftId;
        aNftId    = p.aNftId;
        bNftId    = 0;

        title=p.title; timeoutSeconds=p.timeoutSeconds;

        status = Status.Ready;

        _lockNftForAIfAny();

        address aNorm = (aSwapToken == NATIVE) ? WNATIVE : aSwapToken;
        address bNorm = (bSwapToken == NATIVE) ? WNATIVE : bSwapToken;
        require(aNorm == aTokenNorm && bNorm == bTokenNorm, "TOKEN_NORM_MISMATCH");

        _trackA = c.trackCreator;
        if (_trackA) IFactoryIndex(factory).onCreated(a, true);

        emit Initialized(a, factory);
    }

    /* ======================= 留言 ======================= */
    function postMessage(string calldata content) external nonReentrant onlyAB returns (uint256 idx) {
        require(bytes(content).length > 0, "EMPTY");
        _chargeMessageFee(msg.sender);
        uint64 ts = uint64(block.timestamp);
        _msgContents.push(content); _msgTimes.push(ts); _msgSenders.push(msg.sender);
        idx = _msgContents.length - 1;
        emit MessagePosted(msg.sender, idx, ts, content);
    }
    function getMessages(uint256 offset, uint256 limit)
        external view returns (string[] memory contents, uint64[] memory times, address[] memory senders)
    {
        uint256 len = _msgContents.length;
        if (offset >= len) return (new string[](0), new uint64[](0), new address[](0));
        uint256 end = offset + limit; if (end > len) end = len; uint256 n = end - offset;
        contents = new string[](n); times = new uint64[](n); senders = new address[](n);
        for (uint256 i=0; i<n; ++i) { contents[i]=_msgContents[offset+i]; times[i]=_msgTimes[offset+i]; senders[i]=_msgSenders[offset+i]; }
    }
    function messagesCount() external view returns (uint256) { return _msgContents.length; }

    function _chargeMessageFee(address payer) internal {
        if (!msgPriceEnabled || msgPriceAmountInToken == 0) return;
        uint256 dlNeed = (msgPriceTokenNorm == dl)
            ? msgPriceAmountInToken
            : _quoteAggToDL(msgPriceTokenNorm, msgPricePair, msgPriceAmountInToken);
        if (dlNeed > 0) IDLBurnFrom(dl).burnFrom(payer, dlNeed);
        emit MessageFeeCharged(payer, dlNeed, msgPriceTokenNorm, msgPriceAmountInToken);
    }

    /* ========== A：改四数 / 废弃 ========== */
    function updateAmounts(uint256 _aSwapAmount, uint256 _aMarginAmount, uint256 _bSwapAmount, uint256 _bMarginAmount)
        external onlyA inState(Status.Ready)
    { aSwapAmount=_aSwapAmount; aMarginAmount=_aMarginAmount; bSwapAmount=_bSwapAmount; bMarginAmount=_bMarginAmount; }

    function abandonByA() external nonReentrant onlyA {
        require(status == Status.Ready || status == Status.Active);
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

    /* ========== B：进入 ========== */
    function join(uint256 optId, bool trackMe) external nonReentrant inState(Status.Ready) {
        require(b == address(0));
        require(a != msg.sender, "is a");
        if (joinMode == JoinMode.NftGated) {
            require(gateNftId != 0, "GATE_ID_0");
            require(IERC721(infoNft).ownerOf(gateNftId) == msg.sender, "not nft owner");
            b = msg.sender; bNftId = gateNftId;
        } else {
            if (joinMode == JoinMode.ExactAddress) require(msg.sender == expectedB, "not expectedB");
            b = msg.sender;
            if (optId > 0) {
                require(IERC721(infoNft).ownerOf(optId) == msg.sender, "not nft owner");
                bNftId = optId;
            }
        }

        _lockNftForBIfAny();
        
        _trackBActive = trackMe;
        if (_trackBActive) IFactoryIndex(factory).onJoined(b, true);
        status = Status.Active;
        emit Joined(b, bNftLocked);
        _tryLock();
    }

    /* ========== Active：支付 / 撤回 / 退出 / 踢人 ========== */
    function pay() external payable nonReentrant inState(Status.Active) onlyAB {
        if (msg.sender == a) {
            require(!aPaid);
            require(msg.value == nativeRequiredForA(), "NATIVE_NEQ_A");
            if (aSwapToken   != NATIVE) _pullExactERC20(IERC20(aSwapToken), aSwapAmount, msg.sender);
            if (aMarginToken != NATIVE) _pullExactERC20(IERC20(aMarginToken), aMarginAmount, msg.sender);
            if (aSwapAmount > 0 || aMarginAmount > 0) aPaid = true;
        } else {
            require(b != address(0) && !bPaid);
            require(msg.value == nativeRequiredForB(), "NATIVE_NEQ_B");
            if (bSwapToken   != NATIVE) _pullExactERC20(IERC20(bSwapToken), bSwapAmount, msg.sender);
            if (bMarginToken != NATIVE) _pullExactERC20(IERC20(bMarginToken), bMarginAmount, msg.sender);
            if (bSwapAmount > 0 || bMarginAmount > 0) bPaid = true;
        }
        _tryLock();
    }

    function withdrawInActive() external nonReentrant inState(Status.Active) onlyAB {
        if (msg.sender == a) {
            require(aPaid); aPaid = false;
            _sendOut(aSwapToken, a, aSwapAmount);
            _sendOut(aMarginToken, a, aMarginAmount);
        } else {
            require(bPaid); bPaid = false;
            _sendOut(bSwapToken, b, bSwapAmount);
            _sendOut(bMarginToken, b, bMarginAmount);
        }
    }

    function exitByB() external nonReentrant inState(Status.Active) {
        require(msg.sender == b);
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
        require(v == Vote.Accept || v == Vote.Reject, "V_UNSET");
        if (msg.sender == a) { aVote = v; aAt = uint64(block.timestamp); }
        else { bVote = v; bAt = uint64(block.timestamp); }

        if (aVote == Vote.Accept && bVote == Vote.Accept) _complete(CompletionReason.BothAccepted);
        else if (aVote == Vote.Reject && bVote == Vote.Reject) _cancel();
    }

    function forceComplete() external nonReentrant inState(Status.Locked) onlyAB {
        if (msg.sender == a && bVote == Vote.Unset) {
            require(block.timestamp >= uint256(aAt) + uint256(timeoutSeconds), "A_NOT_TIMEOUT");
            if (aVote == Vote.Accept) {
                _complete(CompletionReason.ForcedByA); return;
            } else if (aVote == Vote.Reject) {
                _cancel(); return;
            }
        } else if (msg.sender == b && aVote == Vote.Unset) {
            require(block.timestamp >= uint256(bAt) + uint256(timeoutSeconds), "B_NOT_TIMEOUT");
            if (bVote == Vote.Accept) {
                _complete(CompletionReason.ForcedByB); return;
            } else if (bVote == Vote.Reject) {
                _cancel(); return;
            }
        } 
        
        revert("BAD_FORCE");
    }

    /* ========== 完成 / 取消（自动结算） ========== */
    struct Fees    { uint256 aFee; uint256 bFee; }
    struct Rewards { uint256 toA;  uint256 toB;  uint256 toC; address cAddr; uint256 cToken; }

    // 完成：当场派发 & 清理
    function _complete(CompletionReason reason) internal {
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

        emit Claimed(a, bSwapToken, bSwapNetForA, aMarginToken, aMarginAmount);

        _sendOut(aSwapToken, b, aSwapNetForB);
        _sendOut(bMarginToken, b, bMarginAmount);

        emit Claimed(b, aSwapToken, aSwapNetForB, bMarginToken, bMarginAmount);

        // 仅当该侧开启过热索引追踪，才写入“完成热索引 ring”
        if (_trackA)       { IFactoryIndex(factory).onCompletedFor(a); }
        if (_trackBActive) { IFactoryIndex(factory).onCompletedFor(b); }

        // 解锁 NFT + 清理“活跃热索引”
        _unlockNftIfLocked(true);
        _unlockNftIfLocked(false);
        if (_trackA)       { IFactoryIndex(factory).onClosedFor(a); _trackA = false; }
        if (_trackBActive) { IFactoryIndex(factory).onClosedFor(b); _trackBActive = false; }

        status = Status.Completed;
        emit Completed(reason);
    }

    // 取消：当场退款 & 清理
    function _cancel() internal {
        if (aPaid) {
            aPaid = false; aClaimed = true;
            _sendOut(aSwapToken, a, aSwapAmount);
            _sendOut(aMarginToken, a, aMarginAmount);
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
        
        if (_trackA)       { IFactoryIndex(factory).onClosedFor(a); _trackA = false; }
        if (_trackBActive) { IFactoryIndex(factory).onClosedFor(b); _trackBActive = false; }

        status = Status.Canceled;
        emit Canceled();
    }

    /* ========== 手续费 & 入池 ========== */
    function _isNoFeeToken(address token) internal view returns (bool) {
        address tNorm = (token == NATIVE) ? WNATIVE : token;
        if (tNorm == dl) return true;
        if (specialNoFeeToken != address(0) && tNorm == specialNoFeeToken) return true;
        return false;
    }
    function _computeFees() internal returns (Fees memory f) {
        f.aFee = _isNoFeeToken(aSwapToken) ? 0 : (aSwapAmount * feeNonDLNum) / feeNonDLDen;
        f.bFee = _isNoFeeToken(bSwapToken) ? 0 : (bSwapAmount * feeNonDLNum) / feeNonDLDen;
        aSwapNetForB = aSwapAmount - f.aFee;
        bSwapNetForA = bSwapAmount - f.bFee;
    }
    function _processFees(Fees memory f) internal {
        _handleOneSideFees(aSwapToken, aTokenNorm, aPair, f.aFee);
        _handleOneSideFees(bSwapToken, bTokenNorm, bPair, f.bFee);
    }
    function _handleOneSideFees(address token, address tokenNorm, address pair, uint256 fee) internal {
        if (fee == 0) return;
        if (pair != address(0)) {
            if (token == NATIVE) { IWNATIVE(WNATIVE).deposit{value: fee}(); IERC20(WNATIVE).safeTransfer(pair, fee); }
            else { IERC20(tokenNorm).safeTransfer(pair, fee); }
            (bool ok, bytes memory data) = pair.call(abi.encodeWithSignature("mintOtherOnly()"));
            require(ok && (data.length == 32 || data.length == 0), "PAIR_MINT_FAIL");
        } else {
            if (token == NATIVE) { (bool ok2, ) = payable(treasury).call{value: fee}(""); require(ok2); }
            else IERC20(tokenNorm).safeTransfer(treasury, fee);
        }
    }

    /* ========== 奖励（基于“已计提手续费(折 DL) * 比例”） ========== */
    function _computeRewards() internal returns (Rewards memory r) {
        if (mintOnFeesNum == 0) return r;

        bool hasA = (infoNft != address(0)) && aNftLocked && aNftId != 0 && IDealInfoNFTView(infoNft).ownerOf(aNftId) == a;
        bool hasB = (infoNft != address(0)) && bNftLocked && bNftId != 0 && IDealInfoNFTView(infoNft).ownerOf(bNftId) == b;
       
        uint256 fa = _isNoFeeToken(aSwapToken) ? 0 : (aSwapAmount * mintOnFeesNum * 3) / mintOnFeesDen;
        uint256 fb = _isNoFeeToken(bSwapToken) ? 0 : (bSwapAmount * mintOnFeesNum * 3) / mintOnFeesDen;

        uint256 totalToMint =
            _quoteAggToDL(aSwapToken, aPair, fa) +
            _quoteAggToDL(bSwapToken, bPair, fb);
        if (totalToMint == 0) return r;

        uint256 share = totalToMint / 3;
        r.toA = share;
        r.toB = share;

        uint256 cToken = _selectC(hasA, hasB);
        if (cToken != 0) {
            r.cToken = cToken;
            r.cAddr  = IDealInfoNFTView(infoNft).ownerOf(cToken);
            r.toC    = share;
        }
    }

    function _selectC(bool hasA, bool hasB) internal view returns (uint256 cToken) {
        IDealInfoNFTView inf = IDealInfoNFTView(infoNft);

        if (hasA && hasB) {
            uint256 maxA = inf.maxPartnerOf(aNftId);
            uint256 maxB = inf.maxPartnerOf(bNftId);

            uint256 sA  = inf.totalMintedOf(aNftId);
            uint256 sB  = inf.totalMintedOf(bNftId);
            uint256 sMA = inf.totalMintedOf(maxA);
            uint256 sMB = inf.totalMintedOf(maxB);

            (uint256 win4, bool unique4) = _uniqueMax4(aNftId, sA, bNftId, sB, maxA, sMA, maxB, sMB);
            if (unique4) return win4;
            if (sA == sB && sA == sMA && sA == sMB) return aNftId;
            return 0;
        }

        if (hasA) {
            uint256 maxA = inf.maxPartnerOf(aNftId);
            uint256 sA   = inf.totalMintedOf(aNftId);
            uint256 sMA  = inf.totalMintedOf(maxA);
            return (sMA > sA) ? maxA : aNftId;
        }

        if (hasB) {
            uint256 maxB = inf.maxPartnerOf(bNftId);
            uint256 sB   = inf.totalMintedOf(bNftId);
            uint256 sMB  = inf.totalMintedOf(maxB);
            return (sMB > sB) ? maxB : bNftId;
        }

        return 0;
    }

    function _preferFirstMax2(uint256 id1, uint256 s1, uint256 id2, uint256 s2) internal pure returns (uint256) {
        if (s2 > s1) return id2; return id1;
    }
    function _preferFirstMax3(uint256 id1, uint256 s1, uint256 id2, uint256 s2, uint256 id3, uint256 s3)
        internal pure returns (uint256)
    {
        if (s1 >= s2 && s1 >= s3) return id1;
        if (s2 >= s3) return id2;
        return id3;
    }
    function _uniqueMax4(
        uint256 id1, uint256 s1,
        uint256 id2, uint256 s2,
        uint256 id3, uint256 s3,
        uint256 id4, uint256 s4
    ) internal pure returns (uint256 id, bool unique) {
        uint256 best = s1; uint256 cnt = 1; uint256 win = id1;
        if (s2 > best) { best = s2; win = id2; cnt = 1; } else if (s2 == best) { cnt++; }
        if (s3 > best) { best = s3; win = id3; cnt = 1; } else if (s3 == best) { cnt++; }
        if (s4 > best) { best = s4; win = id4; cnt = 1; } else if (s4 == best) { cnt++; }
        if (cnt == 1) return (win, true);
        return (0, false);
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
        if (infoNft == address(0)) return;
        IDealInfoNFTView inf = IDealInfoNFTView(infoNft);
        bool hasA = aNftLocked && aNftId != 0;
        bool hasB = bNftLocked && bNftId != 0;

        if (hasA) {
            uint256 curMaxA = inf.maxPartnerOf(aNftId);
            uint256 winA = hasB
                ? _preferFirstMax3(
                    aNftId, inf.totalMintedOf(aNftId),
                    bNftId, inf.totalMintedOf(bNftId),
                    curMaxA, inf.totalMintedOf(curMaxA)
                )
                : _preferFirstMax2(
                    aNftId, inf.totalMintedOf(aNftId),
                    curMaxA, inf.totalMintedOf(curMaxA)
                );
            if (winA != curMaxA) IFactoryInfo(factory).infoSetMaxPartnerOf(aNftId, winA);
        }
        if (hasB) {
            uint256 curMaxB = inf.maxPartnerOf(bNftId);
            uint256 winB = hasA
                ? _preferFirstMax3(
                    bNftId, inf.totalMintedOf(bNftId),
                    aNftId, inf.totalMintedOf(aNftId),
                    curMaxB, inf.totalMintedOf(curMaxB)
                )
                : _preferFirstMax2(
                    bNftId, inf.totalMintedOf(bNftId),
                    curMaxB, inf.totalMintedOf(curMaxB)
                );
            if (winB != curMaxB) IFactoryInfo(factory).infoSetMaxPartnerOf(bNftId, winB);
        }
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
        bool tokensReady = (aSwapAmount == 0 && aMarginAmount == 0) || aPaid;
        bool nftReady    = (aNftId == 0) || aNftLocked;
        return tokensReady && nftReady;
    }
    function _isSideReadyB() internal view returns (bool) {
        bool tokensReady = (bSwapAmount == 0 && bMarginAmount == 0) || bPaid;
        bool nftNeeded   = (joinMode == JoinMode.NftGated) || (bNftId != 0);
        bool nftReady    = (!nftNeeded) || bNftLocked;
        return tokensReady && nftReady;
    }

    /* ========== 只读：原生需求 ========== */
    function nativeRequiredForA() public view returns (uint256) {
        uint256 n=0; if (aSwapToken==NATIVE) n+=aSwapAmount; if (aMarginToken==NATIVE) n+=aMarginAmount; return n;
    }
    function nativeRequiredForB() public view returns (uint256) {
        uint256 n=0; if (bSwapToken==NATIVE) n+=bSwapAmount; if (bMarginToken==NATIVE) n+=bMarginAmount; return n;
    }

    /* ========== 工具：资金清退/发送/拉取 ========== */
    function _pullExactERC20(IERC20 token, uint256 amount, address from) internal {
        if (amount == 0) return;
        uint256 beforeBal = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        uint256 delta = token.balanceOf(address(this)) - beforeBal;
        require(delta == amount, "FOT_NOT_ALLOWED");
    }
    function _sendOut(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == NATIVE) { (bool ok, ) = payable(to).call{value: amount}(""); require(ok, "NATIVE_SEND_FAIL"); }
        else IERC20(token).safeTransfer(to, amount);
    }
    function _refundFundsA() internal {
        if (aPaid) { aPaid=false; _sendOut(aSwapToken,a,aSwapAmount); _sendOut(aMarginToken,a,aMarginAmount); }
    }
    function _refundFundsB() internal {
        if (bPaid) { bPaid=false; _sendOut(bSwapToken,b,bSwapAmount); _sendOut(bMarginToken,b,bMarginAmount); }
    }
    function _refundAllToParties() internal { _refundFundsA(); _refundFundsB(); b = address(0); }

    // 加锁/解锁辅助
    function _lockNftForAIfAny() internal {
        if (aNftId == 0 || aNftLocked) return;
        require(IERC721(infoNft).ownerOf(aNftId) == a, "A_NFT_NOT_OWNER");
        IFactoryLock(factory).infoLock(aNftId, a);
        aNftLocked = true;
    }
    function _lockNftForBIfAny() internal {
        if (bNftId == 0 || bNftLocked) return;
        require(IERC721(infoNft).ownerOf(bNftId) == b, "B_NFT_NOT_OWNER");
        IFactoryLock(factory).infoLock(bNftId, b);
        bNftLocked = true;
    }
    function _unlockNftIfLocked(bool isA) internal {
        if (isA) {
            if (aNftLocked && aNftId != 0) { aNftLocked=false; IFactoryLock(factory).infoUnlock(aNftId); }
        } else {
            if (bNftLocked && bNftId != 0) { bNftLocked=false; IFactoryLock(factory).infoUnlock(bNftId); }
        }
    }

    // 接收原生
    receive() external payable {}
}
