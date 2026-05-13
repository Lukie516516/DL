// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IDCDomainRankForHall {
    function isMerchant(string memory domainName, address account) external view returns (bool);
    function isVisitorActive(string calldata domainName, address user) external view returns (bool);
    function isActive(string calldata domainName, address playerAddr) external view returns (bool);
    function isBlacklisted(string calldata domainName, address account) external view returns (bool);
    function reportDeal(string calldata domainName, address deal, address merchant) external;
}

interface IDCDomainForHall {
    function isRegistered(string calldata domainName) external view returns (bool);
    function resolve(string calldata domainName) external view returns (address);
}

/// @notice 大厅对「先建单再选人」的 Deal 调用 openJoinFor
interface IDealOpenJoinForHall {
    function a() external view returns (address);
    function openJoinFor(address chosenB) external;
}

interface IDealFactoryForHall {
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
    struct CreateParams {
        InitParams init;
        bool trackCreator;
    }
    function createDealFor(address initiator, CreateParams calldata p) external returns (address deal);
    function chargeMessageFeeFrom(address payer) external;
}

/**
 * @title DCDomainHall
 * @notice 商家与访客：点对点留言；先建单再在「按 deal 维度」的撮合大厅留言，最后由商家 openJoinFor 选定访客成交。
 * @dev DealFactory 须 setTrustedDealRelay(本合约)。模板② 推荐 createHallDealTemplate23 + postMessageOnDeal + confirmHallDealCounterparty。
 */
contract DCDomainHall is ReentrancyGuard {
    IDCDomainRankForHall public immutable rank;
    IDCDomainForHall public immutable dcDomain;
    IDealFactoryForHall public immutable dealFactory;

    uint256 public constant MAX_MESSAGE_BYTES = 1500;
    uint256 public constant MAX_PAGE_SIZE = 100;
    uint64 public constant DEAL_TIMEOUT = 3600;

    struct MsgThread {
        string[] contents;
        uint64[] times;
        address[] senders;
    }

    mapping(bytes32 => MsgThread) private _threads;
    /// @dev 与 _threads 键空间隔离：keccak256(abi.encode(uint8(1), domainName, deal))
    mapping(bytes32 => MsgThread) private _dealHallThreads;

    event MessagePosted(
        string domain,
        address indexed merchant,
        address indexed user,
        address indexed from,
        uint256 idx,
        uint64 ts,
        string content
    );

    event MerchantPickUser(
        string domain,
        address indexed merchant,
        address indexed pickedUser,
        uint64 ts,
        string note
    );

    event HallDealWithPickedUser(
        string domain,
        address indexed merchant,
        address indexed pickedUser,
        address indexed deal,
        address aSwapToken,
        uint256 aSwapAmount,
        address bSwapToken,
        uint256 bSwapAmount
    );

    event DealHallMessagePosted(
        string domain,
        address indexed deal,
        address indexed from,
        uint256 idx,
        uint64 ts,
        string content
    );

    event HallDealCreatedDeferred(
        string domain,
        address indexed merchant,
        address indexed deal,
        uint8 templateType
    );

    constructor(address _rank, address _dcDomain, address _dealFactory) {
        require(
            _rank != address(0) && _dcDomain != address(0) && _dealFactory != address(0),
            "DCDomainHall: zero"
        );
        rank = IDCDomainRankForHall(_rank);
        dcDomain = IDCDomainForHall(_dcDomain);
        dealFactory = IDealFactoryForHall(_dealFactory);
    }

    function _mustRegistered(string calldata domainName) internal view {
        require(dcDomain.isRegistered(domainName), "DCDomainHall: domain not registered");
    }

    function _limitMsg(string calldata content) internal pure {
        require(bytes(content).length > 0, "DCDomainHall: empty");
        require(bytes(content).length <= MAX_MESSAGE_BYTES, "DCDomainHall: too long");
    }

    /// @dev 与 DealFactory 一致：timeStart/timeEnd 均非零且 timeEnd > timeStart，供前端阶段时间轴
    function _defaultPhaseTimestamps() internal view returns (uint64 tsStart, uint64 tsEnd) {
        uint64 ts = uint64(block.timestamp);
        tsStart = ts + DEAL_TIMEOUT;
        tsEnd = tsStart + DEAL_TIMEOUT;
    }

    function _threadId(
        string calldata domainName,
        address merchant,
        address user
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(domainName, merchant, user));
    }

    function _dealHallThreadId(string calldata domainName, address deal) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint8(1), domainName, deal));
    }

    function _assertTemplate2Or3(
        uint8 templateType,
        uint256 aSwapAmount,
        uint256 bSwapAmount,
        uint256,
        uint256
    ) internal pure {
        require(
            templateType == uint8(IDealFactoryForHall.TemplateType.TokenToEmpty) ||
                templateType == uint8(IDealFactoryForHall.TemplateType.EmptyToEmpty),
            "DCDomainHall: template not 2/3"
        );
        bool aSw = aSwapAmount > 0;
        bool bSw = bSwapAmount > 0;
        if (templateType == uint8(IDealFactoryForHall.TemplateType.TokenToEmpty)) {
            require(aSw != bSw, "DCDomainHall: TTE swap");
        } else {
            require(!aSw && !bSw, "DCDomainHall: ETE swap");
        }
    }

    /**
     * @notice 模板②/③：先建单（join 锁定），再在「本 deal 专属」大厅留言，最后由商户调用 confirmHallDealCounterparty。
     */
    function createHallDealTemplate23(
        string calldata domainName,
        uint8 templateType,
        address aSwapToken,
        uint256 aSwapAmount,
        address aMarginToken,
        uint256 aMarginAmount,
        address bSwapToken,
        uint256 bSwapAmount,
        address bMarginToken,
        uint256 bMarginAmount,
        uint256 aNftId,
        uint64 timeoutSeconds_,
        uint64 timeStart_,
        string calldata title,
        string calldata description,
        bool trackCreator
    ) external nonReentrant returns (address deal) {
        _mustRegistered(domainName);
        require(dcDomain.resolve(domainName) != address(0), "DCDomainHall: domain not bound");
        require(rank.isMerchant(domainName, msg.sender), "DCDomainHall: not merchant");
        require(timeoutSeconds_ >= 3600, "DCDomainHall: timeout");
        require(timeStart_ > 0, "DCDomainHall: timeStart");
        uint64 timeEnd_ = timeStart_ + DEAL_TIMEOUT;

        _assertTemplate2Or3(
            templateType,
            aSwapAmount,
            bSwapAmount,
            aMarginAmount,
            bMarginAmount
        );

        IDealFactoryForHall.InitParams memory init = IDealFactoryForHall.InitParams({
            aSwapToken: aSwapToken,
            aSwapAmount: aSwapAmount,
            aMarginToken: aMarginToken,
            aMarginAmount: aMarginAmount,
            bSwapToken: bSwapToken,
            bSwapAmount: bSwapAmount,
            bMarginToken: bMarginToken,
            bMarginAmount: bMarginAmount,
            aAssetNft: address(0),
            aAssetNftId: 0,
            bAssetNft: address(0),
            bAssetNftId: 0,
            templateType: templateType,
            joinMode: 1,
            expectedB: msg.sender,
            gateNftId: 0,
            aNftId: aNftId,
            title: title,
            description: description,
            timeoutSeconds: timeoutSeconds_,
            timeStart: timeStart_,
            timeEnd: timeEnd_,
            isDomainDeal: true,
            domainName: domainName,
            openTokenTokenFast: false
        });

        deal = dealFactory.createDealFor(
            msg.sender,
            IDealFactoryForHall.CreateParams({init: init, trackCreator: trackCreator})
        );

        rank.reportDeal(domainName, deal, msg.sender);
        emit HallDealCreatedDeferred(domainName, msg.sender, deal, templateType);
    }

    function postMessage(
        string calldata domainName,
        address merchant,
        address user,
        string calldata content
    ) external nonReentrant {
        require(merchant != address(0) && user != address(0), "DCDomainHall: zero addr");
        require(merchant != user, "DCDomainHall: same party");
        _mustRegistered(domainName);
        require(dcDomain.resolve(domainName) != address(0), "DCDomainHall: domain not bound");
        require(rank.isMerchant(domainName, merchant), "DCDomainHall: bad merchant");
        require(!rank.isBlacklisted(domainName, user), "DCDomainHall: user blacklisted");
        _limitMsg(content);

        if (msg.sender == merchant) {
            require(rank.isVisitorActive(domainName, user), "DCDomainHall: peer not visitor");
        } else if (msg.sender == user) {
            require(rank.isVisitorActive(domainName, user), "DCDomainHall: not visitor");
        } else {
            revert("DCDomainHall: not participant");
        }

        dealFactory.chargeMessageFeeFrom(msg.sender);

        bytes32 tid = _threadId(domainName, merchant, user);
        MsgThread storage t = _threads[tid];
        uint64 ts = uint64(block.timestamp);
        t.contents.push(content);
        t.times.push(ts);
        t.senders.push(msg.sender);
        uint256 idx = t.contents.length - 1;
        emit MessagePosted(domainName, merchant, user, msg.sender, idx, ts, content);
    }

    function getMessages(
        string calldata domainName,
        address merchant,
        address user,
        uint256 offset,
        uint256 limit
    )
        external
        view
        returns (string[] memory contents, uint64[] memory times, address[] memory senders)
    {
        bytes32 tid = _threadId(domainName, merchant, user);
        MsgThread storage t = _threads[tid];
        uint256 len = t.contents.length;
        if (offset >= len) {
            return (new string[](0), new uint64[](0), new address[](0));
        }
        uint256 pageLimit = limit > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : limit;
        uint256 end = offset + pageLimit;
        if (end > len) end = len;
        uint256 n = end - offset;
        contents = new string[](n);
        times = new uint64[](n);
        senders = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            contents[i] = t.contents[offset + i];
            times[i] = t.times[offset + i];
            senders[i] = t.senders[offset + i];
        }
    }

    function messagesCount(
        string calldata domainName,
        address merchant,
        address user
    ) external view returns (uint256) {
        return _threads[_threadId(domainName, merchant, user)].contents.length;
    }

    function signalPickUser(
        string calldata domainName,
        address pickedUser,
        string calldata note
    ) external {
        _mustRegistered(domainName);
        require(pickedUser != address(0), "DCDomainHall: zero user");
        require(rank.isMerchant(domainName, msg.sender), "DCDomainHall: not merchant");
        if (bytes(note).length > MAX_MESSAGE_BYTES) revert("DCDomainHall: note too long");
        emit MerchantPickUser(domainName, msg.sender, pickedUser, uint64(block.timestamp), note);
    }

    /// @notice 商户对访客发起 TokenToToken 单（不经撮合会话）
    function pickUserAndCreateDeal(
        string calldata domainName,
        address pickedUser,
        address aSwapToken,
        uint256 aSwapAmount,
        address bSwapToken,
        uint256 bSwapAmount,
        string calldata title,
        string calldata description,
        bool trackCreator
    ) external returns (address deal) {
        require(pickedUser != address(0), "DCDomainHall: zero picked");
        _mustRegistered(domainName);
        require(dcDomain.resolve(domainName) != address(0), "DCDomainHall: domain not bound");
        require(rank.isMerchant(domainName, msg.sender), "DCDomainHall: not merchant");
        require(!rank.isBlacklisted(domainName, pickedUser), "DCDomainHall: picked blacklisted");
        require(rank.isVisitorActive(domainName, pickedUser), "DCDomainHall: picked not visitor");

        (uint64 tsStart, uint64 tsEnd) = _defaultPhaseTimestamps();

        IDealFactoryForHall.InitParams memory init = IDealFactoryForHall.InitParams({
            aSwapToken: aSwapToken,
            aSwapAmount: aSwapAmount,
            aMarginToken: address(0),
            aMarginAmount: 0,
            bSwapToken: bSwapToken,
            bSwapAmount: bSwapAmount,
            bMarginToken: address(0),
            bMarginAmount: 0,
            aAssetNft: address(0),
            aAssetNftId: 0,
            bAssetNft: address(0),
            bAssetNftId: 0,
            templateType: uint8(IDealFactoryForHall.TemplateType.TokenToToken),
            joinMode: 1,
            expectedB: pickedUser,
            gateNftId: 0,
            aNftId: 0,
            title: title,
            description: description,
            timeoutSeconds: DEAL_TIMEOUT,
            timeStart: tsStart,
            timeEnd: tsEnd,
            isDomainDeal: true,
            domainName: domainName,
            openTokenTokenFast: false
        });

        deal = dealFactory.createDealFor(
            msg.sender,
            IDealFactoryForHall.CreateParams({init: init, trackCreator: trackCreator})
        );

        rank.reportDeal(domainName, deal, msg.sender);

        emit HallDealWithPickedUser(
            domainName,
            msg.sender,
            pickedUser,
            deal,
            aSwapToken,
            aSwapAmount,
            bSwapToken,
            bSwapAmount
        );
    }

    /**
     * @notice TokenToToken：先建单再大厅撮合，最后 confirmHallDealCounterparty；不经会话 id。
     */
    function createTteHallDeal(
        string calldata domainName,
        address aSwapToken,
        uint256 aSwapAmount,
        address bSwapToken,
        uint256 bSwapAmount,
        string calldata title,
        string calldata description,
        bool trackCreator
    ) external nonReentrant returns (address deal) {
        _mustRegistered(domainName);
        require(dcDomain.resolve(domainName) != address(0), "DCDomainHall: domain not bound");
        require(rank.isMerchant(domainName, msg.sender), "DCDomainHall: not merchant");

        (uint64 tteStart, uint64 tteEnd) = _defaultPhaseTimestamps();

        IDealFactoryForHall.InitParams memory init = IDealFactoryForHall.InitParams({
            aSwapToken: aSwapToken,
            aSwapAmount: aSwapAmount,
            aMarginToken: address(0),
            aMarginAmount: 0,
            bSwapToken: bSwapToken,
            bSwapAmount: bSwapAmount,
            bMarginToken: address(0),
            bMarginAmount: 0,
            aAssetNft: address(0),
            aAssetNftId: 0,
            bAssetNft: address(0),
            bAssetNftId: 0,
            templateType: uint8(IDealFactoryForHall.TemplateType.TokenToToken),
            joinMode: 1,
            expectedB: msg.sender,
            gateNftId: 0,
            aNftId: 0,
            title: title,
            description: description,
            timeoutSeconds: DEAL_TIMEOUT,
            timeStart: tteStart,
            timeEnd: tteEnd,
            isDomainDeal: true,
            domainName: domainName,
            openTokenTokenFast: false
        });

        deal = dealFactory.createDealFor(
            msg.sender,
            IDealFactoryForHall.CreateParams({init: init, trackCreator: trackCreator})
        );

        rank.reportDeal(domainName, deal, msg.sender);

        emit HallDealCreatedDeferred(
            domainName,
            msg.sender,
            deal,
            uint8(IDealFactoryForHall.TemplateType.TokenToToken)
        );
    }

    /**
     * @notice 商户在专属大厅选人后，对 Deal 调用 openJoinFor（仅 deal 创建者 A 可调）。
     */
    function confirmHallDealCounterparty(
        string calldata domainName,
        address deal,
        address pickedVisitor
    ) external nonReentrant {
        require(deal != address(0) && pickedVisitor != address(0), "DCDomainHall: zero");
        _mustRegistered(domainName);
        require(dcDomain.resolve(domainName) != address(0), "DCDomainHall: domain not bound");
        require(rank.isMerchant(domainName, msg.sender), "DCDomainHall: not merchant");
        require(!rank.isBlacklisted(domainName, pickedVisitor), "DCDomainHall: picked bl");
        require(rank.isVisitorActive(domainName, pickedVisitor), "DCDomainHall: not visitor");

        address dealA = IDealOpenJoinForHall(deal).a();
        require(dealA == msg.sender, "DCDomainHall: not deal A");

        IDealOpenJoinForHall(deal).openJoinFor(pickedVisitor);
    }

    /// @notice 某 deal 专属撮合大厅留言（商户 A 或该域名下访客）
    function postMessageOnDeal(string calldata domainName, address deal, string calldata content)
        external
        nonReentrant
    {
        require(deal != address(0), "DCDomainHall: zero deal");
        _mustRegistered(domainName);
        require(dcDomain.resolve(domainName) != address(0), "DCDomainHall: domain not bound");
        require(!rank.isBlacklisted(domainName, msg.sender), "DCDomainHall: blacklisted");
        _limitMsg(content);

        address dealA = IDealOpenJoinForHall(deal).a();
        require(rank.isMerchant(domainName, dealA), "DCDomainHall: deal A not merchant");

        if (msg.sender == dealA) {
            // dealA is already verified as merchant above
        } else {
            require(rank.isVisitorActive(domainName, msg.sender), "DCDomainHall: not visitor");
        }

        dealFactory.chargeMessageFeeFrom(msg.sender);

        bytes32 tid = _dealHallThreadId(domainName, deal);
        MsgThread storage t = _dealHallThreads[tid];
        uint64 ts = uint64(block.timestamp);
        t.contents.push(content);
        t.times.push(ts);
        t.senders.push(msg.sender);
        uint256 idx = t.contents.length - 1;
        emit DealHallMessagePosted(domainName, deal, msg.sender, idx, ts, content);
    }

    function getMessagesOnDeal(
        string calldata domainName,
        address deal,
        uint256 offset,
        uint256 limit
    )
        external
        view
        returns (string[] memory contents, uint64[] memory times, address[] memory senders)
    {
        MsgThread storage t = _dealHallThreads[_dealHallThreadId(domainName, deal)];
        uint256 len = t.contents.length;
        if (offset >= len) {
            return (new string[](0), new uint64[](0), new address[](0));
        }
        uint256 pageLimit = limit > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : limit;
        uint256 end = offset + pageLimit;
        if (end > len) end = len;
        uint256 n = end - offset;
        contents = new string[](n);
        times = new uint64[](n);
        senders = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            contents[i] = t.contents[offset + i];
            times[i] = t.times[offset + i];
            senders[i] = t.senders[offset + i];
        }
    }

    function messagesCountOnDeal(string calldata domainName, address deal) external view returns (uint256) {
        return _dealHallThreads[_dealHallThreadId(domainName, deal)].contents.length;
    }
}
