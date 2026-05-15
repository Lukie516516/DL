// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ─────────────────────────────────────────────
// 接口
// ─────────────────────────────────────────────

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IDCDomain {
    function resolve(string calldata domainName) external view returns (address);
}

interface IDCDomainRank {
    function isActive(string calldata domainName, address playerAddr) external view returns (bool);
    function isBlacklisted(string calldata domainName, address account) external view returns (bool);
    function reportDeal(string calldata domainName, address deal, address merchant) external;
}

interface IDealFactory {
    /// @dev 与 DealFactory / Deal 的 InitParams 字段顺序一致（含 templateType，见文档 §2）
    enum TemplateType {
        TokenToToken,
        TokenToNft,
        TokenToEmpty,
        EmptyToEmpty,
        NftToEmpty
    }
    struct InitParams {
        address aSwapToken;   uint256 aSwapAmount;
        address aMarginToken; uint256 aMarginAmount;
        address bSwapToken;   uint256 bSwapAmount;
        address bMarginToken; uint256 bMarginAmount;
        address aAssetNft;
        uint256 aAssetNftId;
        address bAssetNft;
        uint256 bAssetNftId;
        uint8   templateType; // TemplateType
        uint8   joinMode;     // 0 Open, 1 ExactAddress, 2 NftGated
        address expectedB;
        uint256 gateNftId;
        uint256 aNftId;
        string  title;
        string  description;
        uint64  timeoutSeconds;
        uint64  replaceTimeoutSeconds;
        uint64  timeStart;
        uint64  timeEnd;
        bool    isDomainDeal;
        string  domainName;
        bool    openTokenTokenFast;
    }
    struct CreateParams {
        InitParams init;
        bool trackCreator;
    }
    function createDeal(CreateParams calldata p) external returns (address deal);
    function createDealFor(address initiator, CreateParams calldata p) external returns (address deal);
    function chargeMessageFeeFrom(address payer) external;
}

/**
 * @title DCDomainSwap
 * @notice 通过域名在 DealFactory 发起点对点交易（Deal）
 *         templateType 固定 TokenToToken（§2）
 *         expectedB = 零地址 → Open 模式（任何人接单）
 *         expectedB = 具体地址 → ExactAddress（指定对方接单）
 *         超时固定 3600 秒（1小时）
 *         timeStart/timeEnd：非零，供前端阶段时间轴（等待加入 / 等待注入），建单时按区块时间 + TIMEOUT 递推
 *         openTokenTokenFast：走 DealOpenTokenToken（A 可先 pay / preAccept 等）
 *         部署在 BSC (Chain ID: 56)
 */
contract DCDomainSwap {

    // ─────────────────────────────────────────────
    // 常量 & 状态
    // ─────────────────────────────────────────────

    address public owner;
    address public FACTORY;
    uint64  public constant TIMEOUT = 3600;
    uint64  public constant REPLACE_TIMEOUT = 120;
    uint64  public constant MIN_REPLACE_TIMEOUT_SECONDS = 60;
    uint64  public constant MAX_REPLACE_TIMEOUT_SECONDS = 1 days;
    uint64  public replaceTimeoutSeconds = REPLACE_TIMEOUT;
    IDCDomain     public immutable dcDomain;
    IDCDomainRank public immutable dcRank;

    // ─────────────────────────────────────────────
    // 事件
    // ─────────────────────────────────────────────

    event DealCreated(
        address indexed creator,
        string  domain,
        address indexed deal,
        address aSwapToken,
        uint256 aSwapAmount,
        address bSwapToken,
        uint256 bSwapAmount,
        uint8   templateType,  // 本入口固定 0 = TokenToToken
        uint8   joinMode,      // 0=Open 1=ExactAddress
        address expectedB
    );
    event ReplaceTimeoutUpdated(uint64 oldValue, uint64 newValue);

    modifier onlyOwner() {
        require(msg.sender == owner, "DCDomainSwap: not owner");
        _;
    }

    // ─────────────────────────────────────────────
    // 构造函数
    // ─────────────────────────────────────────────

    constructor(address _dcDomain, address _dcRank, address _factory) {
        require(_dcDomain != address(0), "ZERO_DOMAIN");
        require(_dcRank   != address(0), "ZERO_RANK");
        require(_factory  != address(0), "ZERO_FACTORY");
        owner    = msg.sender;
        dcDomain = IDCDomain(_dcDomain);
        dcRank   = IDCDomainRank(_dcRank);
        FACTORY  = _factory;
    }//填入DCdomain、DCDomainRank、Factory的地址

    function setReplaceTimeoutSeconds(uint64 value) external onlyOwner {
        require(
            value >= MIN_REPLACE_TIMEOUT_SECONDS && value <= MAX_REPLACE_TIMEOUT_SECONDS,
            "DCDomainSwap: invalid replace timeout"
        );
        uint64 oldValue = replaceTimeoutSeconds;
        replaceTimeoutSeconds = value;
        emit ReplaceTimeoutUpdated(oldValue, value);
    }

    // ─────────────────────────────────────────────
    // 内部工具
    // ─────────────────────────────────────────────

    function _resolveDomain(string memory domainName) internal view returns (address) {
        address resolved = dcDomain.resolve(domainName);
        require(resolved != address(0), "DCDomainSwap: domain not bound");
        return resolved;
    }//检查域名是否存在

    // ─────────────────────────────────────────────
    // 核心：发起 Deal
    // ─────────────────────────────────────────────

    /**
     * @notice 发起交易
     * @param domainName  域名（必须已在 DCDomainRank 充值）
     * @param aSwapToken  我出的代币地址（address(0) = BNB）
     * @param aSwapAmount 我出的数量
     * @param bSwapToken  我要的代币地址（address(0) = BNB）
     * @param bSwapAmount 我要的数量
     * @param expectedB   对方钱包地址（零地址 = 任何人都可接单）
     */

     //我们的合约只提出这个交易 bsc链上0x6382Cd4693a9091277794BfD07c6BE658Fc04974 实现交易 
    function createDeal(
        string  calldata domainName,
        address aSwapToken,
        uint256 aSwapAmount,
        address bSwapToken,
        uint256 bSwapAmount,
        string  calldata title,
        string  calldata description,
        address expectedB
    ) external returns (address deal) {
        // 检查域名存在
        _resolveDomain(domainName);

        // 检查发起人是否在域名内活跃
        require(
            dcRank.isActive(domainName, msg.sender),
            "DCDomainSwap: not active in domain"
        );

        uint8 joinMode = expectedB == address(0) ? 0 : 1; // Open / ExactAddress

        uint64 ts = uint64(block.timestamp);
        uint64 phaseJoinDeadline = ts + TIMEOUT;
        uint64 phasePayDeadline = phaseJoinDeadline + TIMEOUT;

        IDealFactory.InitParams memory init = IDealFactory.InitParams({
            aSwapToken:     aSwapToken,
            aSwapAmount:    aSwapAmount,
            aMarginToken:   address(0),
            aMarginAmount:  0,
            bSwapToken:     bSwapToken,
            bSwapAmount:    bSwapAmount,
            bMarginToken:   address(0),
            bMarginAmount:  0,
            aAssetNft:      address(0),
            aAssetNftId:    0,
            bAssetNft:      address(0),
            bAssetNftId:    0,
            templateType:   uint8(IDealFactory.TemplateType.TokenToToken),
            joinMode:       joinMode,
            expectedB:      expectedB,
            gateNftId:      0,
            aNftId:         0,
            title:                    title,
            description:              description,
            timeoutSeconds:           TIMEOUT,
            replaceTimeoutSeconds:    replaceTimeoutSeconds,
            timeStart:                phaseJoinDeadline,
            timeEnd:                  phasePayDeadline,
            isDomainDeal:             true,
            domainName:               domainName,
            openTokenTokenFast:       true
        });

        deal = IDealFactory(FACTORY).createDealFor(
            msg.sender,
            IDealFactory.CreateParams({ init: init, trackCreator: true })
        );

        dcRank.reportDeal(domainName, deal, msg.sender);

        emit DealCreated(
            msg.sender,
            domainName,
            deal,
            aSwapToken,
            aSwapAmount,
            bSwapToken,
            bSwapAmount,
            uint8(IDealFactory.TemplateType.TokenToToken),
            joinMode,
            expectedB
        );
    }

    // ─────────────────────────────────────────────
    // 查询
    // ─────────────────────────────────────────────

    /**
     * @notice 查询域名是否已绑定（前端可调用）
     */
    function isDomainBound(string calldata domainName) external view returns (bool) {
        return dcDomain.resolve(domainName) != address(0);
    }
}
