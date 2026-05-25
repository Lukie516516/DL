// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

interface IDLMint {
    function mint(address to, uint256 amount) external;
}
interface IDLBurnFrom {
    function burnFrom(address account, uint256 amount) external;
}

interface IDeal {
    enum TemplateType {
        TokenToToken,
        TokenToNft,
        TokenToEmpty,
        EmptyToEmpty,
        NftToEmpty
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
        uint8 templateType; // 0 TokenToToken, 1 TokenToNft, 2 TokenToEmpty, 3 EmptyToEmpty, 4 NftToEmpty
        uint8 joinMode; // 0 Open, 1 ExactAddress, 2 NftGated, 3 ExactAddressAndNftGated
        address expectedB;
        uint256 gateNftId; // 门禁 NFT 的 tokenId（仅在 NftGated 模式使用）
        uint256 aNftId; // A 侧自愿/要求绑定的 tokenId（0 代表不需要）
        string title;
        string description;
        uint64 timeoutSeconds;
        uint64 replaceTimeoutSeconds;
        bool isDomainDeal;
        string domainName;
        /// @dev true：clone DealOpenTokenToken（仅 TokenToToken）
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
        // 留言计费
        bool msgPriceEnabled;
        address msgPriceTokenNorm;
        address msgPricePair;
        uint256 msgPriceAmountInToken;
    }
    function initialize(
        address _factory,
        address _initiator,
        InitParams calldata p,
        ConfigParams calldata c
    ) external;
}

/* ---------------- DealInfoNFT (写操作由 Factory 代理) ---------------- */
interface IDealInfoNFT {
    function totalMintedOf(uint256 tokenId) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function addMinted(uint256 tokenId, uint256 amount) external;
    function maxPartnerOf(uint256 tokenId) external view returns (uint256);
    function setMaxPartnerOf(uint256 tokenId, uint256 partnerTokenId) external;
}

/* ========= 新增：InfoNFT 锁操作接口（Factory 调用） ========= */
interface IDealInfoNFTLock {
    function lockByFactory(
        uint256 tokenId,
        address deal,
        address owner
    ) external;
    function unlockByFactory(uint256 tokenId, address deal) external;
}

interface IDealCreditGraph {
    function recordDeal(
        address partyA,
        address partyB,
        uint256 aTokenId,
        bool aValid,
        uint256 bTokenId,
        bool bValid,
        uint256 baseCredit
    ) external returns (uint256 aDelta, uint256 bDelta);
}

interface IDealNftGovernanceActivityRecorder {
    function markActive(uint256 tokenId) external;
}

interface IDealActivityIndex {
    function addTracked(address user, address deal) external returns (bool changed);
    function removeTracked(address user, address deal) external returns (bool changed);
    function addCompleted(address user, address deal) external returns (bool changed);
    function trackedCount(address user) external view returns (uint256);
    function getTracked(address user, uint256 offset, uint256 limit) external view returns (address[] memory);
    function isTracked(address user, address deal) external view returns (bool);
    function completedCount(address user) external view returns (uint256);
    function getCompleted(address user, uint256 offset, uint256 limit, bool newestFirst)
        external
        view
        returns (address[] memory);
}

interface IDealResultIndex {
    function recordReward(
        address deal,
        address partyA,
        uint256 toA,
        address partyB,
        uint256 toB,
        address cAddr,
        uint256 toC
    ) external;

    function recordCredit(
        address deal,
        address partyA,
        address partyB,
        uint256 aTokenId,
        uint256 bTokenId,
        uint256 baseCredit,
        uint256 aDelta,
        uint256 bDelta
    ) external;

    function recordTimeline(address deal, uint8 action, address actor, bool isPartyA, uint256 value) external;
}

interface IDealPairManager {
    function pairForToken(address token) external view returns (address);
    function createPair(address tokenOther, uint32 feeNum, uint32 feeDen) external returns (address pair);
    function mapExistingPair(address tokenOther, address pair) external;
    function setPairFactory(address pair, address f) external;
    function initPair(address pair, uint256 b1) external returns (uint256 amountDL, uint256 amountOther);
    function mintPairOtherAndSettle(address pair)
        external
        returns (uint256 amountOther, bool settleAttempted, bool settleSucceeded);
    function setPairFee(address pair, uint32 newNum, uint32 newDen) external;
    function setPairVirtualReserves(
        address pair,
        uint256 virtualReserve0,
        bool enable0,
        uint256 virtualReserve1,
        bool enable1
    ) external;
    function setPairVirtualReservesByBps(address pair, uint32 bps0, bool enable0, uint32 bps1, bool enable1)
        external
        returns (uint256 v0, uint256 v1);
    function updateAndQuoteToDL(address pair, uint256 amountIn) external returns (uint256 dlOut);
}

interface IDealImplementationRegistry {
    function resolveImplementation(
        uint8 templateType,
        bool openTokenTokenFast,
        uint256 aAssetNftId,
        uint256 bAssetNftId
    ) external view returns (address);
}

interface IOrderBookSettle {
    function settlePair(address pair, uint256 maxBuyOrders, uint256 maxSellOrders) external;
}
interface IDealDomainView {
    function isDomainDeal() external view returns (bool);
    function domainName() external view returns (string memory);
}
interface IDCDomainRankAutoClose {
    function closeDeal(string calldata domainName, address deal) external returns (uint256 refunded, uint256 consumed);
    function closeDealFromAutoCloser(string calldata domainName, address deal)
        external
        returns (uint256 refunded, uint256 consumed);
}
/* ========================================================== */
contract DealFactory is Ownable {
    using Clones for address;
    address private constant DEFAULT_AUSD =
        0x8fc6dB736Dce11233078EA6f6EBa4c9F44E4C123;
    address private constant DEFAULT_USDT =
        0x1035F65fc63342F9878C4D03e4372718Dbb33d32;

    address public admin;

    /* ---------- 数学工具 ---------- */
    error RatioInvalid();
    error NotAdmin();
    error NotDeal();
    error ZeroAddress();
    error CloneFailed();
    error CloneNoCode();
    error UseDomainEntry();
    error DealImplementationUnset();
    error CoreGlobalsUnset();
    error NotAllowedCreateFor();
    error InitiatorZero();
    error UnauthorizedQuoteCaller();
    error CreateBurnNoPair();
    error CreateBurnQuantityZero();
    error InvalidTemplateType();
    error InvalidJoinMode();
    error InvalidAssetNftPairing();
    error ExpectedBZero();
    error GateIdZero();
    error InvalidTemplateShape();
    error MarginTokenNotAllowed();
    error InfoNftAmountInvalid();
    error InfoNftZero();
    error RewardPairMissing();
    error OpenTokenTokenFastNotTT();
    error TitleTooLong();
    error DescriptionTooLong();
    error TimeoutTooLong();

    uint256 public constant MAX_TITLE_BYTES = 96;
    uint256 public constant MAX_DESCRIPTION_BYTES = 1500;
    uint64 public constant MAX_TIMEOUT_SECONDS = 36500 days;
    uint64 public constant MIN_REPLACE_TIMEOUT_SECONDS = 60;
    uint64 public constant MAX_REPLACE_TIMEOUT_SECONDS = 1 days;

    struct Ratio {
        uint32 num;
        uint32 den;
    }
    function _assertRatio(Ratio memory r) internal pure {
        if (r.den == 0 || r.num >= r.den) revert RatioInvalid();
    }

    /* ---------- 实现地址 ---------- */
    address public dealImplementation;
    address public pairImplementation;

    /* ---------- Deal 控制 ---------- */
    uint64 public minTimeoutSeconds; // ≥ 3600
    mapping(address => bool) public isDeal;
    mapping(address => bool) public isAllowedCreateFor;

    /* ---------- 全局依赖 ---------- */
    address public dlToken;
    address public infoNft; // 唯一 NFT
    address public treasury;
    address public wrappedNative;
    address public swapOrderBook;
    address public dealMessageHub;
    address public creditGraph;
    address public dealActivityIndex;
    address public dealResultIndex;
    address public dealPairManager;
    address public dealNftGovernanceActivity;
    address public dealImplementationRegistry;
    address public dcDomainRank;

    // Default recognized tokens can still be changed later via setRecognizedTokens().
    address public recognizedToken0 = DEFAULT_AUSD;
    address public recognizedToken1 = DEFAULT_USDT;
    mapping(address => bool) public allowedMarginToken;

    /* ---------- 默认参数 ---------- */
    Ratio public defaultFeeNonDL = Ratio({num: 3, den: 1000}); // 3‰
    Ratio public defaultMintOnFees = Ratio({num: 1, den: 1000}); // 千1
    address public specialNoFeeToken = address(0);

    /* ---------- 创建销毁规则（可选） ---------- */
    bool public createBurnEnabled;
    address public createBurnPricingToken; // 0 原生
    uint256 public createBurnAmountInToken;

    /* ---------- 留言计费规则（全局） ---------- */
    bool public msgPriceEnabled;
    address public msgPriceToken; // 0 原生
    uint256 public msgPriceAmountInToken;

    uint32 public minWindowSec = 30;

    /* ---------- 事件 ---------- */
    event DealImplUpdated(address indexed impl);
    event PairImplUpdated(address indexed impl);
    event MinTimeoutUpdated(uint64 seconds_);
    event MinWindowSet(uint32 sec);
    event GlobalSet(string indexed key, address value);
    event PairCreated(
        address indexed pair,
        address indexed otherToken,
        uint32 feeNum,
        uint32 feeDen
    );
    event PairFeeUpdated(address indexed pair, uint32 newNum, uint32 newDen);
    event PairVirtualReservesUpdated(
        address indexed pair,
        uint256 virtualReserve0,
        bool virtualReserve0Enabled,
        uint256 virtualReserve1,
        bool virtualReserve1Enabled
    );
    event PairMapped(address indexed otherToken, address indexed pair);
    event PairOtherLiquidityAddedAndSettled(
        address indexed pair,
        uint256 amountOther,
        bool settleAttempted,
        bool settleSucceeded
    );
    event PairOtherLiquiditySettleFailed(address indexed pair, bytes reason);
    event FeesAndMintOnFeesUpdated(
        uint32 feeNonDLNum,
        uint32 feeNonDLDen,
        uint32 mintOnFeesNum,
        uint32 mintOnFeesDen
    );
    event RecognizedTokensUpdated(
        address indexed token0,
        address indexed token1
    );
    event MarginTokenAllowedUpdated(address indexed token, bool allowed);
    event SpecialNoFeeTokenUpdated(address indexed token);
    event CreateBurnRuleUpdated(
        bool enabled,
        address pricingToken,
        uint256 amountInToken
    );
    event CreateBurnExecuted(
        address indexed creator,
        address indexed pair,
        address pricingToken,
        uint256 amountInToken,
        uint256 dlBurned
    );
    event DealCreated(address indexed deal, address indexed initiator);
    event DealCreatedV2(
        address indexed initiator,
        address indexed deal,
        uint256 indexed aNftId
    );
    event DealTemplateTagged(
        address indexed deal,
        uint8 indexed templateType
    );
    event DealOpenTokenTokenCreated(address indexed deal);
    event DLMinted(address indexed to, uint256 amount, address indexed deal);
    /// @notice 仅索引便利：每笔 Deal 成交奖励汇总（与 Deal 上 `RewardsMinted` 同数据；`deal` 为 msg.sender）
    event DealRewardsLogged(
        address indexed deal,
        address indexed partyA,
        address indexed partyB,
        uint256 toA,
        uint256 toB,
        address cAddr,
        uint256 toC
    );
    event MessagePriceRuleUpdated(
        bool enabled,
        address pricingToken,
        uint256 amountInToken
    );
    event TrackedAdded(address indexed user, address indexed deal);
    event TrackedRemoved(address indexed user, address indexed deal);
    event AllowedCreateForSet(address indexed caller, bool allowed);
    event MessageFeeCharged(address indexed payer, uint256 dlBurned);

    event CompletedAdded(address indexed user, address indexed deal);
    event DomainAdAutoClosed(address indexed deal, string domainName, bool success);

    /* ---------------- Modifiers ---------------- */
    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }
    modifier onlyDeal() {
        if (!isDeal[msg.sender]) revert NotDeal();
        _;
    }

    constructor(
        address _dealImpl,
        address _pairImpl,
        uint64 _minTimeoutSeconds
    ) Ownable(msg.sender) {
        require(_dealImpl != address(0) && _pairImpl != address(0));
        require(_minTimeoutSeconds >= 3600);
        dealImplementation = _dealImpl;
        pairImplementation = _pairImpl;
        minTimeoutSeconds = _minTimeoutSeconds;
        admin = msg.sender;
        allowedMarginToken[recognizedToken0] = true;
        allowedMarginToken[recognizedToken1] = true;
        emit DealImplUpdated(_dealImpl);
        emit PairImplUpdated(_pairImpl);
        emit MinTimeoutUpdated(_minTimeoutSeconds);
        emit RecognizedTokensUpdated(recognizedToken0, recognizedToken1);
        emit MarginTokenAllowedUpdated(recognizedToken0, true);
        emit MarginTokenAllowedUpdated(recognizedToken1, true);
    }

    /* ========== Owner Admin 配置 ========== */
    function setDealImplementation(address impl) external onlyOwner {
        require(impl != address(0));
        dealImplementation = impl;
        emit DealImplUpdated(impl);
    }
    function setPairImplementation(address impl) external onlyOwner {
        require(impl != address(0));
        pairImplementation = impl;
        emit PairImplUpdated(impl);
    }
    function setMinTimeoutSeconds(uint64 s) external onlyOwner {
        require(s >= 1800);
        if (s > MAX_TIMEOUT_SECONDS) revert TimeoutTooLong();
        minTimeoutSeconds = s;
        emit MinTimeoutUpdated(s);
    }

    function setAdmin(address _admin) external onlyAdmin {
        if (_admin == address(0)) revert ZeroAddress();
        admin = _admin;
    }
    function setMinTimeoutSecondsByAdmin(uint64 s) external onlyAdmin {
        require(s >= 3600);
        if (s > MAX_TIMEOUT_SECONDS) revert TimeoutTooLong();
        minTimeoutSeconds = s;
        emit MinTimeoutUpdated(s);
    }

    /// key ∈ {"dlToken","infoNft","wrappedNative","swapOrderBook","dealMessageHub","creditGraph","dealActivityIndex","dealResultIndex","dealPairManager","dealNftGovernanceActivity","dealImplementationRegistry","dcDomainRank"}
    function setGlobal(string calldata key, address value) external onlyOwner {
        if (value == address(0)) revert ZeroAddress();
        bytes32 k = keccak256(bytes(key));
        if (k == keccak256("dlToken")) dlToken = value;
        else if (k == keccak256("infoNft")) infoNft = value;
        else if (k == keccak256("wrappedNative")) wrappedNative = value;
        else if (k == keccak256("swapOrderBook")) swapOrderBook = value;
        else if (k == keccak256("dealMessageHub")) dealMessageHub = value;
        else if (k == keccak256("creditGraph")) creditGraph = value;
        else if (k == keccak256("dealActivityIndex")) dealActivityIndex = value;
        else if (k == keccak256("dealResultIndex")) dealResultIndex = value;
        else if (k == keccak256("dealPairManager")) dealPairManager = value;
        else if (k == keccak256("dealNftGovernanceActivity")) dealNftGovernanceActivity = value;
        else if (k == keccak256("dealImplementationRegistry")) dealImplementationRegistry = value;
        else if (k == keccak256("dcDomainRank")) dcDomainRank = value;
        else revert();
        if ((k == keccak256("dlToken") || k == keccak256("wrappedNative")) && value != address(0)) {
            allowedMarginToken[value] = true;
            emit MarginTokenAllowedUpdated(value, true);
        }
        emit GlobalSet(key, value);
    }

    function setMinWindowSec(uint32 sec_) external onlyOwner {
        require(sec_ >= 5);
        minWindowSec = sec_;
        emit MinWindowSet(sec_);
    }
    function setMinWindowSecByAdmin(uint32 sec_) external onlyAdmin {
        require(sec_ >= 30);
        minWindowSec = sec_;
        emit MinWindowSet(sec_);
    }

    function setRecognizedTokens(
        address token0,
        address token1
    ) external onlyOwner {
        if (token0 == address(0) || token1 == address(0)) revert ZeroAddress();
        recognizedToken0 = token0;
        recognizedToken1 = token1;
        if (token0 != address(0)) {
            allowedMarginToken[token0] = true;
            emit MarginTokenAllowedUpdated(token0, true);
        }
        if (token1 != address(0)) {
            allowedMarginToken[token1] = true;
            emit MarginTokenAllowedUpdated(token1, true);
        }
        emit RecognizedTokensUpdated(token0, token1);
    }

    function setAllowedMarginToken(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        allowedMarginToken[token] = allowed;
        emit MarginTokenAllowedUpdated(token, allowed);
    }

    function setAllowedCreateFor(address caller, bool allowed) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        isAllowedCreateFor[caller] = allowed;
        emit AllowedCreateForSet(caller, allowed);
    }

    function setFeesAndMintOnFees(
        uint32 feeNonDLNum,
        uint32 feeNonDLDen,
        uint32 mintOnFeesNum,
        uint32 mintOnFeesDen
    ) external onlyOwner {
        Ratio memory r1 = Ratio({num: feeNonDLNum, den: feeNonDLDen});
        Ratio memory r2 = Ratio({num: mintOnFeesNum, den: mintOnFeesDen});
        _assertRatio(r1);
        _assertRatio(r2);
        defaultFeeNonDL = r1;
        defaultMintOnFees = r2;
        emit FeesAndMintOnFeesUpdated(
            feeNonDLNum,
            feeNonDLDen,
            mintOnFeesNum,
            mintOnFeesDen
        );
    }
    function setFeesAndMintOnFeesByAdmin(
        uint32 feeNonDLNum,
        uint32 mintOnFeesNum
    ) external onlyAdmin {
        require(1 <= feeNonDLNum && 10 >= feeNonDLNum);
        require(1 <= mintOnFeesNum && 10 >= mintOnFeesNum);
        Ratio memory r1 = Ratio({num: feeNonDLNum, den: 1000});
        Ratio memory r2 = Ratio({num: mintOnFeesNum, den: 1000});
        _assertRatio(r1);
        _assertRatio(r2);
        defaultFeeNonDL = r1;
        defaultMintOnFees = r2;
        emit FeesAndMintOnFeesUpdated(feeNonDLNum, 1000, mintOnFeesNum, 1000);
    }
    function setSpecialNoFeeTokenByAdmin(address token) external onlyAdmin {
        specialNoFeeToken = token;
        emit SpecialNoFeeTokenUpdated(token);
    }
    function setTreasuryByAdmin(address _treasury) external onlyAdmin {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    /* ---------- 留言计费规则 ---------- */
    function setMessagePriceRule(
        bool enabled,
        address pricingToken,
        uint256 amountInToken
    ) external onlyOwner {
        msgPriceEnabled = enabled;
        msgPriceToken = pricingToken;
        msgPriceAmountInToken = amountInToken;
        emit MessagePriceRuleUpdated(enabled, pricingToken, amountInToken);
    }
    function setMessagePriceRuleByAdmin(
        uint256 amountInToken
    ) external onlyAdmin {
        require(
            amountInToken >= 1 * 10 ** 16 && amountInToken <= 10 * 10 ** 18
        );
        msgPriceAmountInToken = amountInToken;
        emit MessagePriceRuleUpdated(
            msgPriceEnabled,
            msgPriceToken,
            amountInToken
        );
    }

    /* ---------- 创建销毁规则（可选） ---------- */
    function setCreateBurnRule(
        bool enabled,
        address pricingToken,
        uint256 amountInToken
    ) external onlyOwner {
        createBurnEnabled = enabled;
        createBurnPricingToken = pricingToken;
        createBurnAmountInToken = amountInToken;
        emit CreateBurnRuleUpdated(enabled, pricingToken, amountInToken);
    }
    function setCreateBurnRuleByAdmin(
        uint256 amountInToken
    ) external onlyAdmin {
        require(
            amountInToken >= 1 * 10 ** 18 && amountInToken <= 10 * 10 ** 18
        );
        createBurnAmountInToken = amountInToken;
        emit CreateBurnRuleUpdated(
            createBurnEnabled,
            createBurnPricingToken,
            amountInToken
        );
    }

    /* ========== Pair：创建 / 初始化 / 改费率 ========== */
    function createPair(
        address tokenOther,
        uint32 feeNum,
        uint32 feeDen
    ) external onlyOwner returns (address pair) {
        pair = _pairManager().createPair(tokenOther, feeNum, feeDen);
        emit PairCreated(pair, tokenOther, feeNum, feeDen);
        emit PairMapped(tokenOther, pair);
    }

    function setPairFactory(address pair, address f) external onlyOwner {
        _pairManager().setPairFactory(pair, f);
    }
    function initPair(
        address pair,
        uint256 _b1
    ) external onlyOwner returns (uint amountDL, uint amountOther) {
        (amountDL, amountOther) = _pairManager().initPair(pair, _b1);
    }
    function mintPairOtherAndSettle(
        address pair
    ) external onlyOwner returns (uint256 amountOther) {
        bool settleAttempted;
        bool settleSucceeded;
        (amountOther,,) = _pairManager().mintPairOtherAndSettle(pair);
        if (swapOrderBook != address(0)) {
            settleAttempted = true;
            try IOrderBookSettle(swapOrderBook).settlePair(pair, 1, 8) {
                settleSucceeded = true;
            } catch (bytes memory reason) {
                emit PairOtherLiquiditySettleFailed(pair, reason);
            }
        }
        emit PairOtherLiquidityAddedAndSettled(
            pair,
            amountOther,
            settleAttempted,
            settleSucceeded
        );
    }
    function setPairFee(
        address pair,
        uint32 newNum,
        uint32 newDen
    ) external onlyOwner {
        _pairManager().setPairFee(pair, newNum, newDen);
        emit PairFeeUpdated(pair, newNum, newDen);
    }
    function setPairFeeByAdmin(address pair, uint32 newNum) external onlyAdmin {
        require(1 <= newNum && 200 >= newNum);
        _pairManager().setPairFee(pair, newNum, 10000);
        emit PairFeeUpdated(pair, newNum, 10000);
    }
    function setPairVirtualReserves(
        address pair,
        uint256 virtualReserve0,
        bool enable0,
        uint256 virtualReserve1,
        bool enable1
    ) external onlyOwner {
        _pairManager().setPairVirtualReserves(pair, virtualReserve0, enable0, virtualReserve1, enable1);
        emit PairVirtualReservesUpdated(
            pair,
            virtualReserve0,
            enable0 && virtualReserve0 > 0,
            virtualReserve1,
            enable1 && virtualReserve1 > 0
        );
    }
    function setPairVirtualReservesByBps(
        address pair,
        uint32 bps0,
        bool enable0,
        uint32 bps1,
        bool enable1
    ) external onlyOwner {
        (uint256 v0, uint256 v1) = _pairManager().setPairVirtualReservesByBps(pair, bps0, enable0, bps1, enable1);
        emit PairVirtualReservesUpdated(
            pair,
            v0,
            enable0 && v0 > 0,
            v1,
            enable1 && v1 > 0
        );
    }
    function mapExistingPair(address tokenOther, address pair) external onlyOwner {
        _pairManager().mapExistingPair(tokenOther, pair);
        emit PairMapped(tokenOther, pair);
    }

    function pairForToken(address token) public view returns (address) {
        address manager = dealPairManager;
        if (manager == address(0)) return address(0);
        return IDealPairManager(manager).pairForToken(token);
    }

    function getPair(address token) external view returns (address) {
        address t = (token == address(0)) ? wrappedNative : token;
        return pairForToken(t);
    }
    function isTokenSupported(address token) external view returns (bool) {
        address t = (token == address(0)) ? wrappedNative : token;
        return pairForToken(t) != address(0);
    }

    /* ========== TWAP：供 Deal 调用报价 ========== */
    function updateAndQuoteToDL(
        address pair,
        uint256 amountIn
    ) external returns (uint256 dlOut) {
        if (!isDeal[msg.sender] && infoNft != msg.sender)
            revert UnauthorizedQuoteCaller();
        return _updateAndQuoteInternal(pair, amountIn);
    }

    /* ========== 创建 Deal ========== */
    struct CreateParams {
        IDeal.InitParams init;
        bool trackCreator;
    }

    function createDeal(
        CreateParams calldata p
    ) external returns (address deal) {
        deal = _createDeal(msg.sender, p, true);
    }

    function createDealFor(
        address initiator,
        CreateParams calldata p
    ) external returns (address deal) {
        if (!isAllowedCreateFor[msg.sender]) revert NotAllowedCreateFor();
        if (initiator == address(0)) revert InitiatorZero();
        deal = _createDeal(initiator, p, false);
    }

    function chargeMessageFeeFrom(address payer) external {
        if (msg.sender != dealMessageHub && !isAllowedCreateFor[msg.sender]) revert NotAllowedCreateFor();
        if (!msgPriceEnabled || msgPriceAmountInToken == 0) return;
        address msgNorm = _normalizeToken(msgPriceToken);
        uint256 dlNeed;
        if (msgNorm == dlToken) {
            dlNeed = msgPriceAmountInToken;
        } else {
            address msgPair = pairForToken(msgNorm);
            if (msgPair == address(0)) return;
            dlNeed = _updateAndQuoteInternal(msgPair, msgPriceAmountInToken);
        }
        if (dlNeed == 0) return;
        IDLBurnFrom(dlToken).burnFrom(payer, dlNeed);
        emit MessageFeeCharged(payer, dlNeed);
    }

    function _assertTemplate(IDeal.InitParams calldata p) internal pure {
        if (p.templateType > uint8(IDeal.TemplateType.NftToEmpty))
            revert InvalidTemplateType();
        if (p.joinMode > 3) revert InvalidJoinMode();
        if (bytes(p.title).length > MAX_TITLE_BYTES) revert TitleTooLong();
        if (bytes(p.description).length > MAX_DESCRIPTION_BYTES) revert DescriptionTooLong();

        bool aHasSwap = p.aSwapAmount > 0;
        bool bHasSwap = p.bSwapAmount > 0;
        bool aHasAssetNft = p.aAssetNftId > 0;
        bool bHasAssetNft = p.bAssetNftId > 0;
        bool aHasAssetNftAddr = p.aAssetNft != address(0);
        bool bHasAssetNftAddr = p.bAssetNft != address(0);

        if (aHasAssetNft != aHasAssetNftAddr || bHasAssetNft != bHasAssetNftAddr)
            revert InvalidAssetNftPairing();

        if ((p.joinMode == 1 || p.joinMode == 3) && p.expectedB == address(0))
            revert ExpectedBZero();
        if ((p.joinMode == 2 || p.joinMode == 3) && p.gateNftId == 0)
            revert GateIdZero();
        if (p.templateType == uint8(IDeal.TemplateType.TokenToToken)) {
            if (!(aHasSwap && bHasSwap && !aHasAssetNft && !bHasAssetNft))
                revert InvalidTemplateShape();
            return;
        }

        if (p.openTokenTokenFast) revert OpenTokenTokenFastNotTT();

        if (p.templateType == uint8(IDeal.TemplateType.TokenToNft)) {
            if (
                !(
                    (aHasSwap && !bHasSwap && !aHasAssetNft && bHasAssetNft) ||
                    (bHasSwap && !aHasSwap && !bHasAssetNft && aHasAssetNft)
                )
            ) revert InvalidTemplateShape();
            return;
        }

        if (p.templateType == uint8(IDeal.TemplateType.NftToEmpty)) {
            if (
                !(
                    (aHasAssetNft && !bHasAssetNft && !aHasSwap && !bHasSwap) ||
                    (bHasAssetNft && !aHasAssetNft && !aHasSwap && !bHasSwap)
                )
            ) revert InvalidTemplateShape();
            return;
        }

        if (p.templateType == uint8(IDeal.TemplateType.TokenToEmpty)) {
            if (!(aHasSwap != bHasSwap && !aHasAssetNft && !bHasAssetNft))
                revert InvalidTemplateShape();
            return;
        }

        if (aHasSwap || bHasSwap || aHasAssetNft || bHasAssetNft)
            revert InvalidTemplateShape();
    }

    function _assertMarginTokenAllowed(address token, uint256 amount) internal view {
        if (amount == 0) return;
        address tokenNorm = _normalizeToken(token);
        if (
            tokenNorm != dlToken &&
            tokenNorm != wrappedNative &&
            tokenNorm != recognizedToken0 &&
            tokenNorm != recognizedToken1 &&
            !allowedMarginToken[tokenNorm]
        ) revert MarginTokenNotAllowed();
    }

    /* ========== 代理：增发 DL（仅 Deal） ========== */
    function mintDL(address to, uint256 amount) external onlyDeal {
        require(to != address(0) && amount > 0);
        IDLMint(dlToken).mint(to, amount);
        emit DLMinted(to, amount, msg.sender);
    }

    /// @dev Deal 成交后调用；前端/索引只订工厂时可筛 `DealRewardsLogged`，不必扫每个 clone。
    function logDealRewards(
        address partyA,
        uint256 toA,
        address partyB,
        uint256 toB,
        address cAddr,
        uint256 toC
    ) external onlyDeal {
        address deal = msg.sender;
        address resultIndex = dealResultIndex;
        if (resultIndex != address(0)) {
            try IDealResultIndex(resultIndex).recordReward(deal, partyA, toA, partyB, toB, cAddr, toC) {} catch {}
        }
        emit DealRewardsLogged(msg.sender, partyA, partyB, toA, toB, cAddr, toC);
    }

    function recordDealTimeline(uint8 action, address actor, bool isPartyA, uint256 value) external onlyDeal {
        address resultIndex = dealResultIndex;
        if (resultIndex != address(0)) {
            try IDealResultIndex(resultIndex).recordTimeline(msg.sender, action, actor, isPartyA, value) {} catch {}
        }
    }

    /* ========== 代理：写 InfoNFT（仅 Deal） ========== */
    function infoAddMinted(uint256 tokenId, uint256 amount) external onlyDeal {
        if (infoNft == address(0) || amount == 0) revert InfoNftAmountInvalid();
        IDealInfoNFT(infoNft).addMinted(tokenId, amount);
    }
    function infoSetMaxPartnerOf(
        uint256 tokenId,
        uint256 partnerTokenId
    ) external onlyDeal {
        if (infoNft == address(0)) revert InfoNftZero();
        IDealInfoNFT(infoNft).setMaxPartnerOf(tokenId, partnerTokenId);
    }

    /* ========= InfoNFT 锁代理（仅 Deal） ========= */
    function infoLock(uint256 tokenId, address holder) external onlyDeal {
        if (infoNft == address(0)) revert InfoNftZero();
        IDealInfoNFTLock(infoNft).lockByFactory(tokenId, msg.sender, holder);
    }
    function infoUnlock(uint256 tokenId) external onlyDeal {
        if (infoNft == address(0)) revert InfoNftZero();
        IDealInfoNFTLock(infoNft).unlockByFactory(tokenId, msg.sender);
    }

    function recordDealCredit(
        address partyA,
        address partyB,
        uint256 aTokenId,
        bool aValid,
        uint256 bTokenId,
        bool bValid,
        uint256 baseCredit
    ) external onlyDeal {
        if (aValid) _markNftGovernanceActivity(aTokenId);
        if (bValid) _markNftGovernanceActivity(bTokenId);
        address graph = creditGraph;
        if (graph == address(0) || baseCredit == 0) return;
        (uint256 aDelta, uint256 bDelta) = IDealCreditGraph(graph).recordDeal(
            partyA,
            partyB,
            aTokenId,
            aValid,
            bTokenId,
            bValid,
            baseCredit
        );
        if (aDelta == 0 && bDelta == 0) return;
        address resultIndex = dealResultIndex;
        if (resultIndex != address(0)) {
            try IDealResultIndex(resultIndex).recordCredit(
                msg.sender,
                partyA,
                partyB,
                aValid ? aTokenId : 0,
                bValid ? bTokenId : 0,
                baseCredit,
                aDelta,
                bDelta
            ) {} catch {}
        }
    }

    function recordNftGovernanceActivity(uint256 tokenId) external onlyDeal {
        _markNftGovernanceActivity(tokenId);
    }

    function _tryCloseDomainAd(address deal) internal {
        address rank = dcDomainRank;
        if (rank == address(0)) return;

        bool domainDeal;
        try IDealDomainView(deal).isDomainDeal() returns (bool v) {
            domainDeal = v;
        } catch {
            return;
        }
        if (!domainDeal) return;

        string memory name;
        try IDealDomainView(deal).domainName() returns (string memory v) {
            name = v;
        } catch {
            return;
        }
        if (bytes(name).length == 0) return;

        try IDCDomainRankAutoClose(rank).closeDealFromAutoCloser(name, deal) returns (uint256, uint256) {
            emit DomainAdAutoClosed(deal, name, true);
        } catch {
            emit DomainAdAutoClosed(deal, name, false);
        }
    }

    /* ========== 热索引回调（仅 Deal） ========== */
    function onCreated(address creator, bool trackCreator) external onlyDeal {
        if (trackCreator) _addTracked(creator, msg.sender);
    }
    function onJoined(
        address participant,
        bool trackParticipant
    ) external onlyDeal {
        if (trackParticipant && participant != address(0))
            _addTracked(participant, msg.sender);
    }
    function onParticipantRemoved(address prevParticipant) external onlyDeal {
        if (prevParticipant != address(0))
            _removeTracked(prevParticipant, msg.sender);
    }
    function onAbandoned(
        address creator,
        address prevParticipant
    ) external onlyDeal {
        if (creator != address(0)) _removeTracked(creator, msg.sender);
        if (prevParticipant != address(0))
            _removeTracked(prevParticipant, msg.sender);
        _tryCloseDomainAd(msg.sender);
    }
    function onClosedFor(address user) external onlyDeal {
        if (user != address(0)) _removeTracked(user, msg.sender);
        _tryCloseDomainAd(msg.sender);
    }

    // 完成回调（仅完成态 & 仅 Deal 可调）
    function onCompletedFor(address user) external onlyDeal {
        if (user == address(0)) return;
        _addCompleted(user, msg.sender);
        _tryCloseDomainAd(msg.sender);
    }

    /* ========== 热索引只读（活跃） ========== */
    function trackedCount(address user) external view returns (uint256) {
        address index = dealActivityIndex;
        if (index == address(0)) return 0;
        return IDealActivityIndex(index).trackedCount(user);
    }
    function getTracked(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (address[] memory list) {
        address index = dealActivityIndex;
        if (index == address(0)) return new address[](0);
        return IDealActivityIndex(index).getTracked(user, offset, limit);
    }
    function isTracked(
        address user,
        address deal
    ) external view returns (bool) {
        address index = dealActivityIndex;
        if (index == address(0)) return false;
        return IDealActivityIndex(index).isTracked(user, deal);
    }

    /* ========== 完成热索引只读 ========== */
    function completedCount(address user) external view returns (uint256) {
        address index = dealActivityIndex;
        if (index == address(0)) return 0;
        return IDealActivityIndex(index).completedCount(user);
    }

    /**
     * @param newestFirst true: newest->older；false: oldest->newer
     */
    function getCompleted(
        address user,
        uint256 offset,
        uint256 limit,
        bool newestFirst
    ) external view returns (address[] memory list) {
        address index = dealActivityIndex;
        if (index == address(0)) return new address[](0);
        return IDealActivityIndex(index).getCompleted(user, offset, limit, newestFirst);
    }

    /* ---------- 辅助（活跃热索引） ---------- */
    function _addTracked(address user, address deal) internal {
        address index = dealActivityIndex;
        if (index != address(0) && IDealActivityIndex(index).addTracked(user, deal))
            emit TrackedAdded(user, deal);
    }
    function _removeTracked(address user, address deal) internal {
        address index = dealActivityIndex;
        if (index != address(0) && IDealActivityIndex(index).removeTracked(user, deal))
            emit TrackedRemoved(user, deal);
    }

    /* ---------- 辅助（完成热索引） ---------- */
    function _addCompleted(address user, address deal) internal {
        address index = dealActivityIndex;
        if (index != address(0) && IDealActivityIndex(index).addCompleted(user, deal))
            emit CompletedAdded(user, deal);
    }

    function _pairManager() internal view returns (IDealPairManager manager) {
        address addr = dealPairManager;
        if (addr == address(0)) revert ZeroAddress();
        manager = IDealPairManager(addr);
    }

    function _updateAndQuoteInternal(address pair, uint256 amountIn) internal returns (uint256) {
        return _pairManager().updateAndQuoteToDL(pair, amountIn);
    }

    function _assertRewardPairConfigured(
        address tokenNorm,
        uint256 amount
    ) internal view {
        if (amount == 0 || tokenNorm == dlToken) return;
        if (
            tokenNorm == wrappedNative ||
            tokenNorm == recognizedToken0 ||
            tokenNorm == recognizedToken1
        ) {
            if (pairForToken(tokenNorm) == address(0)) revert RewardPairMissing();
        }
    }

    function _assertClone(address instance) internal view {
        if (instance == address(0)) revert CloneFailed();
        if (instance.code.length == 0) revert CloneNoCode();
    }

    function _normalizeToken(address token) internal view returns (address) {
        return token == address(0) ? wrappedNative : token;
    }

    function _assertCreateDealConfig(
        IDeal.InitParams calldata init,
        bool rejectDomainEntry
    ) internal view {
        if (dealImplementation == address(0) && dealImplementationRegistry == address(0))
            revert DealImplementationUnset();
        if (rejectDomainEntry && (init.isDomainDeal || bytes(init.domainName).length != 0))
            revert UseDomainEntry();
        require(init.timeoutSeconds >= minTimeoutSeconds);
        if (init.timeoutSeconds > MAX_TIMEOUT_SECONDS) revert TimeoutTooLong();
        if (init.openTokenTokenFast) {
            require(init.replaceTimeoutSeconds >= MIN_REPLACE_TIMEOUT_SECONDS);
            if (init.replaceTimeoutSeconds > MAX_REPLACE_TIMEOUT_SECONDS) revert TimeoutTooLong();
        }
        if (dlToken == address(0) || wrappedNative == address(0))
            revert CoreGlobalsUnset();
        _assertTemplate(init);
        _assertMarginTokenAllowed(init.aMarginToken, init.aMarginAmount);
        _assertMarginTokenAllowed(init.bMarginToken, init.bMarginAmount);
    }

    function _applyCreateBurn(address payer) internal {
        address pricingNorm = _normalizeToken(createBurnPricingToken);
        address pair = pairForToken(pricingNorm);
        if (pair == address(0)) revert CreateBurnNoPair();
        uint256 dlNeed = _updateAndQuoteInternal(pair, createBurnAmountInToken);
        if (dlNeed == 0) revert CreateBurnQuantityZero();
        IDLBurnFrom(dlToken).burnFrom(payer, dlNeed);
        emit CreateBurnExecuted(
            payer,
            pair,
            pricingNorm,
            createBurnAmountInToken,
            dlNeed
        );
    }

    function _buildDealConfig(
        CreateParams calldata p
    ) internal view returns (IDeal.ConfigParams memory cfg) {
        address aNorm = _normalizeToken(p.init.aSwapToken);
        address bNorm = _normalizeToken(p.init.bSwapToken);
        _assertRewardPairConfigured(aNorm, p.init.aSwapAmount);
        _assertRewardPairConfigured(bNorm, p.init.bSwapAmount);

        address msgNorm = _normalizeToken(msgPriceToken);
        address msgPair = msgNorm == dlToken ? address(0) : pairForToken(msgNorm);

        cfg = IDeal.ConfigParams({
            dl: dlToken,
            infoNft: infoNft,
            treasury: treasury,
            WNATIVE: wrappedNative,
            recognizedToken0: recognizedToken0,
            recognizedToken1: recognizedToken1,
            aTokenNorm: aNorm,
            bTokenNorm: bNorm,
            aPair: pairForToken(aNorm),
            bPair: pairForToken(bNorm),
            feeNonDLNum: defaultFeeNonDL.num,
            feeNonDLDen: defaultFeeNonDL.den,
            mintOnFeesNum: defaultMintOnFees.num,
            mintOnFeesDen: defaultMintOnFees.den,
            specialNoFeeToken: specialNoFeeToken,
            trackCreator: p.trackCreator,
            msgPriceEnabled: msgPriceEnabled,
            msgPriceTokenNorm: msgNorm,
            msgPricePair: msgPair,
            msgPriceAmountInToken: msgPriceAmountInToken
        });
    }

    function _createDeal(
        address initiator,
        CreateParams calldata p,
        bool rejectDomainEntry
    ) internal returns (address deal) {
        _assertCreateDealConfig(p.init, rejectDomainEntry);
        if (createBurnEnabled) _applyCreateBurn(initiator);

        address registry = dealImplementationRegistry;
        address impl = registry == address(0)
            ? dealImplementation
            : IDealImplementationRegistry(registry).resolveImplementation(
                p.init.templateType,
                p.init.openTokenTokenFast,
                p.init.aAssetNftId,
                p.init.bAssetNftId
            );
        if (impl == address(0)) {
            revert DealImplementationUnset();
        }

        deal = impl.clone();
        _assertClone(deal);
        isDeal[deal] = true;

        IDeal(deal).initialize(address(this), initiator, p.init, _buildDealConfig(p));
        _markNftGovernanceActivity(p.init.aNftId);

        emit DealCreated(deal, initiator);
        emit DealCreatedV2(initiator, deal, p.init.aNftId);
        emit DealTemplateTagged(deal, p.init.templateType);
        if (p.init.openTokenTokenFast) emit DealOpenTokenTokenCreated(deal);
    }

    function _markNftGovernanceActivity(uint256 tokenId) internal {
        address activity = dealNftGovernanceActivity;
        if (activity == address(0) || tokenId == 0) return;
        try IDealNftGovernanceActivityRecorder(activity).markActive(tokenId) {} catch {}
    }

}
