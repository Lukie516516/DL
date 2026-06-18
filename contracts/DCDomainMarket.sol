// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev 与 DCDomain 对齐的最小接口（ERC721 + 标签 + 成交同步 resolve）
interface IDCDomainNFT is IERC721 {
    function domainLabelOf(uint256 tokenId) external view returns (string memory);
    function marketSyncResolve(string calldata domainName, address newOwner) external;
}

/**
 * @title DCDomainMarket
 * @notice DC 域名 NFT 二级市场：挂单定价（paymentToken）、成交后 NFT 过户并调用 DCDomain.marketSyncResolve
 * @dev 部署后需在 DCDomain 上执行 setDomainMarket(address(this))；卖家需 approve 本合约或 setApprovalForAll
 */
contract DCDomainMarket is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IDCDomainNFT public immutable dcDomain;
    IERC20       public immutable paymentToken;

    address public feeRecipient;
    uint256 public feeBps;
    uint256 public constant MAX_FEE_BPS = 2500;
    uint256 public constant MAX_PAGE_SIZE = 100;

    struct Listing {
        address seller;
        uint256 price;
        bool    active;
        address buyer;   // address(0) = 公开挂单，非零 = 仅该买家可购买（P2P）
    }

    mapping(uint256 tokenId => Listing) public listings;

    uint256[] private _activeTokenIds;
    mapping(uint256 tokenId => uint256 arrayIndex) private _activeIndex;

    event Listed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event ListedP2P(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price);
    event Delisted(uint256 indexed tokenId);
    event PriceUpdated(uint256 indexed tokenId, uint256 newPrice);
    event Sold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price, uint256 fee);

    constructor(
        address _dcDomain,
        address _paymentToken,
        address _feeRecipient,
        uint256 _feeBps
    ) Ownable(msg.sender) {
        require(_dcDomain != address(0) && _paymentToken != address(0), "DCDomainMarket: zero addr");
        require(_feeRecipient != address(0), "DCDomainMarket: zero fee recv");
        require(_feeBps <= MAX_FEE_BPS, "DCDomainMarket: fee too high");
        dcDomain     = IDCDomainNFT(_dcDomain);
        paymentToken = IERC20(_paymentToken);
        feeRecipient = _feeRecipient;
        feeBps       = _feeBps;
    }

    function list(uint256 tokenId, uint256 price) external nonReentrant {
        require(price > 0, "DCDomainMarket: zero price");
        require(dcDomain.ownerOf(tokenId) == msg.sender, "DCDomainMarket: not owner");
        require(
            dcDomain.getApproved(tokenId) == address(this) || dcDomain.isApprovedForAll(msg.sender, address(this)),
            "DCDomainMarket: not approved"
        );

        listings[tokenId] = Listing({seller: msg.sender, price: price, active: true, buyer: address(0)});
        _addToActive(tokenId);
        emit Listed(tokenId, msg.sender, price);
    }

    /// @notice P2P 挂单：仅指定买家可购买
    function listP2P(uint256 tokenId, uint256 price, address _buyer) external nonReentrant {
        require(price > 0, "DCDomainMarket: zero price");
        require(_buyer != address(0), "DCDomainMarket: zero buyer");
        require(_buyer != msg.sender, "DCDomainMarket: self trade");
        require(dcDomain.ownerOf(tokenId) == msg.sender, "DCDomainMarket: not owner");
        require(
            dcDomain.getApproved(tokenId) == address(this) || dcDomain.isApprovedForAll(msg.sender, address(this)),
            "DCDomainMarket: not approved"
        );

        listings[tokenId] = Listing({seller: msg.sender, price: price, active: true, buyer: _buyer});
        _addToActive(tokenId);
        emit ListedP2P(tokenId, msg.sender, _buyer, price);
    }

    function updateListing(uint256 tokenId, uint256 newPrice) external nonReentrant {
        Listing storage L = listings[tokenId];
        require(L.active, "DCDomainMarket: no listing");
        require(L.seller == msg.sender, "DCDomainMarket: not seller");
        require(dcDomain.ownerOf(tokenId) == msg.sender, "DCDomainMarket: stale owner");
        require(newPrice > 0, "DCDomainMarket: zero price");

        L.price = newPrice;
        emit PriceUpdated(tokenId, newPrice);
    }

    function delist(uint256 tokenId) external nonReentrant {
        Listing storage L = listings[tokenId];
        require(L.active, "DCDomainMarket: no listing");
        require(L.seller == msg.sender, "DCDomainMarket: not seller");
        delete listings[tokenId];
        _removeFromActive(tokenId);
        emit Delisted(tokenId);
    }

    /**
     * @notice 买断：买家需先 approve 本合约 `price` 的 paymentToken
     */
    function buy(uint256 tokenId, uint256 maxPrice) external nonReentrant {
        Listing memory L = listings[tokenId];
        require(L.active, "DCDomainMarket: no listing");
        require(L.buyer == address(0) || L.buyer == msg.sender, "DCDomainMarket: not designated buyer");

        address seller = L.seller;
        uint256 price  = L.price;
        require(price <= maxPrice, "DCDomainMarket: price exceeds maxPrice");
        require(dcDomain.ownerOf(tokenId) == seller, "DCDomainMarket: stale listing");

        uint256 fee     = (price * feeBps) / 10000;
        uint256 toSeller = price - fee;

        delete listings[tokenId];
        _removeFromActive(tokenId);

        paymentToken.safeTransferFrom(msg.sender, address(this), price);
        dcDomain.safeTransferFrom(seller, msg.sender, tokenId);

        if (toSeller > 0) {
            paymentToken.safeTransfer(seller, toSeller);
        }
        if (fee > 0) {
            paymentToken.safeTransfer(feeRecipient, fee);
        }

        string memory label = dcDomain.domainLabelOf(tokenId);
        dcDomain.marketSyncResolve(label, msg.sender);

        emit Sold(tokenId, seller, msg.sender, price, fee);
    }

    function setFeeRecipient(address a) external onlyOwner {
        require(a != address(0), "DCDomainMarket: zero");
        feeRecipient = a;
    }

    function setFeeBps(uint256 b) external onlyOwner {
        require(b <= MAX_FEE_BPS, "DCDomainMarket: fee too high");
        feeBps = b;
    }

    // ─────────────────────────────────────────────
    // 内部：活跃列表维护（swap-and-pop）
    // ─────────────────────────────────────────────

    function _addToActive(uint256 tokenId) internal {
        if (_activeTokenIds.length > 0 && _activeTokenIds[_activeIndex[tokenId]] == tokenId) return;
        _activeIndex[tokenId] = _activeTokenIds.length;
        _activeTokenIds.push(tokenId);
    }

    function _removeFromActive(uint256 tokenId) internal {
        uint256 idx = _activeIndex[tokenId];
        uint256 last = _activeTokenIds.length;
        if (last == 0) return;
        last--;
        if (idx != last) {
            uint256 moved = _activeTokenIds[last];
            _activeTokenIds[idx] = moved;
            _activeIndex[moved] = idx;
        }
        _activeTokenIds.pop();
        delete _activeIndex[tokenId];
    }

    // ─────────────────────────────────────────────
    // 查询：活跃挂单列表
    // ─────────────────────────────────────────────

    /// @notice 当前活跃挂单总数
    function activeListingCount() external view returns (uint256) {
        return _activeTokenIds.length;
    }

    /// @notice 按索引获取活跃挂单的 tokenId
    function activeTokenIdAt(uint256 index) external view returns (uint256) {
        require(index < _activeTokenIds.length, "DCDomainMarket: out of range");
        return _activeTokenIds[index];
    }

    /// @notice 分页获取活跃挂单 tokenId 列表
    function activeTokenIds(uint256 offset, uint256 limit)
        external view returns (uint256[] memory tokenIds)
    {
        uint256 total = _activeTokenIds.length;
        if (offset >= total) return new uint256[](0);
        uint256 pageLimit = _pageLimit(limit);
        uint256 end = offset + pageLimit;
        if (end > total) end = total;
        uint256 len = end - offset;
        tokenIds = new uint256[](len);
        for (uint256 i; i < len; i++) {
            tokenIds[i] = _activeTokenIds[offset + i];
        }
    }

    struct ListingView {
        uint256 tokenId;
        address seller;
        uint256 price;
        address buyer;
    }

    function _pageLimit(uint256 limit) internal pure returns (uint256) {
        return limit > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : limit;
    }

    /// @notice 分页获取活跃挂单完整信息（tokenId + seller + price + buyer）
    function getActiveListings(uint256 offset, uint256 limit)
        external view returns (ListingView[] memory result)
    {
        uint256 total = _activeTokenIds.length;
        if (offset >= total) return new ListingView[](0);
        uint256 pageLimit = _pageLimit(limit);
        uint256 end = offset + pageLimit;
        if (end > total) end = total;
        uint256 len = end - offset;
        result = new ListingView[](len);
        for (uint256 i; i < len; i++) {
            uint256 tid = _activeTokenIds[offset + i];
            Listing storage L = listings[tid];
            result[i] = ListingView({
                tokenId: tid,
                seller:  L.seller,
                price:   L.price,
                buyer:   L.buyer
            });
        }
    }

    /// @notice 仅获取公开挂单（buyer == address(0)），分页
    function getPublicListings(uint256 offset, uint256 limit)
        external view returns (ListingView[] memory)
    {
        uint256 total = _activeTokenIds.length;
        ListingView[] memory buf = new ListingView[](total);
        uint256 count;
        for (uint256 i; i < total; i++) {
            uint256 tid = _activeTokenIds[i];
            Listing storage L = listings[tid];
            if (L.buyer == address(0)) {
                buf[count++] = ListingView({ tokenId: tid, seller: L.seller, price: L.price, buyer: address(0) });
            }
        }
        if (offset >= count) return new ListingView[](0);
        uint256 pageLimit = _pageLimit(limit);
        uint256 end = offset + pageLimit;
        if (end > count) end = count;
        uint256 len = end - offset;
        ListingView[] memory result = new ListingView[](len);
        for (uint256 i; i < len; i++) {
            result[i] = buf[offset + i];
        }
        return result;
    }

    /// @notice 游标式公开挂单查询：cursor 是 active 列表下标，最多返回 MAX_PAGE_SIZE 条。
    function getPublicListingsPage(uint256 cursor, uint256 limit)
        external
        view
        returns (ListingView[] memory result, uint256 nextCursor, bool hasMore)
    {
        uint256 total = _activeTokenIds.length;
        if (cursor >= total) return (new ListingView[](0), total, false);

        uint256 pageLimit = _pageLimit(limit);
        ListingView[] memory buf = new ListingView[](pageLimit);
        uint256 count;
        uint256 i = cursor;
        for (; i < total && count < pageLimit; ++i) {
            uint256 tid = _activeTokenIds[i];
            Listing storage L = listings[tid];
            if (L.buyer == address(0)) {
                buf[count++] = ListingView({ tokenId: tid, seller: L.seller, price: L.price, buyer: address(0) });
            }
        }

        result = new ListingView[](count);
        for (uint256 j; j < count; ++j) result[j] = buf[j];
        nextCursor = i;
        hasMore = i < total;
    }

    /// @notice 查询指定买家的所有 P2P 挂单
    function getP2PListingsForBuyer(address _buyer)
        external view returns (ListingView[] memory)
    {
        uint256 total = _activeTokenIds.length;
        ListingView[] memory buf = new ListingView[](total);
        uint256 count;
        for (uint256 i; i < total; i++) {
            uint256 tid = _activeTokenIds[i];
            Listing storage L = listings[tid];
            if (L.buyer == _buyer) {
                buf[count++] = ListingView({ tokenId: tid, seller: L.seller, price: L.price, buyer: _buyer });
            }
        }
        ListingView[] memory result = new ListingView[](count);
        for (uint256 i; i < count; i++) {
            result[i] = buf[i];
        }
        return result;
    }

    /// @notice 游标式 P2P 挂单查询：cursor 是 active 列表下标，最多返回 MAX_PAGE_SIZE 条。
    function getP2PListingsForBuyerPage(address _buyer, uint256 cursor, uint256 limit)
        external
        view
        returns (ListingView[] memory result, uint256 nextCursor, bool hasMore)
    {
        uint256 total = _activeTokenIds.length;
        if (cursor >= total) return (new ListingView[](0), total, false);

        uint256 pageLimit = _pageLimit(limit);
        ListingView[] memory buf = new ListingView[](pageLimit);
        uint256 count;
        uint256 i = cursor;
        for (; i < total && count < pageLimit; ++i) {
            uint256 tid = _activeTokenIds[i];
            Listing storage L = listings[tid];
            if (L.buyer == _buyer) {
                buf[count++] = ListingView({ tokenId: tid, seller: L.seller, price: L.price, buyer: _buyer });
            }
        }

        result = new ListingView[](count);
        for (uint256 j; j < count; ++j) result[j] = buf[j];
        nextCursor = i;
        hasMore = i < total;
    }
}
