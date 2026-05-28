// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title DCDomain
 * @notice 6位字母+数字域名 NFT，格式为 xxxxxx@DC
 *         使用平台代币购买，永久有效
 *         部署在 BSC (Chain ID 56)
 */
contract DCDomain is ERC721, Ownable {
    using Strings for uint256;

    // ─────────────────────────────────────────────
    // 常量 & 配置
    // ─────────────────────────────────────────────

    /// 底价（单位：平台代币，18位小数）
    uint256 public basePrice = 500 ether;

    /// 平台代币合约地址
    IERC20 public paymentToken;

    /// 收款地址（项目方）
    address public treasury;

    /// 二级市场合约（仅此地址可调用 marketSyncResolve）
    address public domainMarket;

    /// tokenId 计数器
    uint256 private _tokenIdCounter;

    // ─────────────────────────────────────────────
    // 存储
    // ─────────────────────────────────────────────

    /// 域名字符串 → tokenId（用于查重）
    mapping(string => uint256) private _domainToTokenId;

    /// tokenId → 域名字符串
    mapping(uint256 => string) private _tokenIdToDomain;

    /// tokenId → 首次注册创建者
    mapping(uint256 => address) private _creatorOfToken;

    /// 创建者 → 其创建过的 tokenId 列表
    mapping(address => uint256[]) private _createdTokensBy;

    /// 地址 → 主域名（可选，用户可设置）
    mapping(address => string) public primaryDomain;

    /// 域名 → 解析地址
    mapping(string => address) public resolve;

    /// tokenId → 域名展示描述（链上存储；禁止含 " \\ 及控制字符，避免破坏 tokenURI JSON）
    mapping(uint256 => string) public domainDescription;

    /// tokenId → 背景图 URI（https / ipfs / ar 等；同上安全校验）
    mapping(uint256 => string) public domainBackgroundUri;

    uint256 public constant MAX_DOMAIN_DESCRIPTION_BYTES = 500;
    uint256 public constant MAX_DOMAIN_BACKGROUND_URI_BYTES = 512;

    // ─────────────────────────────────────────────
    // 事件
    // ─────────────────────────────────────────────

    event DomainRegistered(address indexed owner, string domain, uint256 tokenId, uint256 price);
    event PrimaryDomainSet(address indexed owner, string domain);
    event ResolveSet(string domain, address indexed target);
    event DomainDescriptionSet(uint256 indexed tokenId, string description);
    event DomainBackgroundUriSet(uint256 indexed tokenId, string uri);

    // ─────────────────────────────────────────────
    // 构造函数
    // ─────────────────────────────────────────────

    constructor(address _paymentToken, address _treasury) ERC721("DC Domain", "DCD") Ownable(msg.sender) {
        paymentToken = IERC20(_paymentToken);
        treasury = _treasury;
    }

    // ─────────────────────────────────────────────
    // 核心：购买注册域名
    // ─────────────────────────────────────────────

    /// @notice 购买域名
    /// @param domainName 6位字符串（不含 @DC 后缀）
    function register(string calldata domainName) external {
        _validateDomain(domainName);

        require(_domainToTokenId[domainName] == 0, "DCDomain: already registered");

        uint256 price = getPrice(domainName);

        require(paymentToken.transferFrom(msg.sender, treasury, price), "DCDomain: payment failed");

        _tokenIdCounter++;
        uint256 tokenId = _tokenIdCounter;

        _safeMint(msg.sender, tokenId);
        _domainToTokenId[domainName] = tokenId;
        _tokenIdToDomain[tokenId] = domainName;
        _creatorOfToken[tokenId] = msg.sender;
        _createdTokensBy[msg.sender].push(tokenId);

        resolve[domainName] = msg.sender;

        emit DomainRegistered(msg.sender, domainName, tokenId, price);
    }

    // ─────────────────────────────────────────────
    // 价格计算
    // ─────────────────────────────────────────────

    /// @notice 计算域名价格：当前所有一级注册域名统一 500 DC
    function getPrice(string memory) public view returns (uint256) {
        return basePrice;
    }

    /// @dev 返回倍数（基数100）：100=1x … 取所有匹配规则中的最高倍数，不叠加。
    function _getMultiplierBps(string memory domainName) internal pure returns (uint256) {
        bytes memory b = bytes(domainName);

        uint256 best = 100;

        uint256 repeatScore = _repeatScore(b);
        if (repeatScore > best) best = repeatScore;

        uint256 seqScore = _seqScore(b);
        if (seqScore > best) best = seqScore;

        return best;
    }

    function _repeatScore(bytes memory b) internal pure returns (uint256) {
        uint8[128] memory counts;
        for (uint256 i = 0; i < 6; i++) {
            uint8 c = uint8(b[i]);
            require(c < 128, "DCDomain: invalid char");
            counts[c]++;
        }

        uint8 maxCount = 0;
        for (uint256 i = 0; i < 128; i++) {
            if (counts[i] > maxCount) maxCount = counts[i];
        }

        if (maxCount == 6) return 50000;
        if (maxCount == 5) return 10000;
        if (maxCount == 4) return 2000;
        if (maxCount == 3) return 400;
        if (maxCount == 2) return 150;
        return 100;
    }

    function _seqScore(bytes memory b) internal pure returns (uint256) {
        int8[6] memory digits;
        for (uint256 i = 0; i < 6; i++) {
            uint8 c = uint8(b[i]);
            if (c >= 48 && c <= 57) {
                digits[i] = int8(int8(c) - 48);
            } else {
                return 100;
            }
        }

        uint256 maxAsc = 1;
        uint256 curAsc = 1;
        for (uint256 i = 0; i < 5; i++) {
            if (digits[i + 1] - digits[i] == 1) {
                curAsc++;
                if (curAsc > maxAsc) maxAsc = curAsc;
            } else {
                curAsc = 1;
            }
        }

        uint256 maxDesc = 1;
        uint256 curDesc = 1;
        for (uint256 i = 0; i < 5; i++) {
            if (digits[i] - digits[i + 1] == 1) {
                curDesc++;
                if (curDesc > maxDesc) maxDesc = curDesc;
            } else {
                curDesc = 1;
            }
        }

        uint256 maxRun = maxAsc > maxDesc ? maxAsc : maxDesc;

        if (maxRun >= 6) return 50000;
        if (maxRun >= 5) return 10000;
        if (maxRun >= 4) return 2000;
        if (maxRun >= 3) return 400;
        if (maxRun >= 2) return 150;
        return 100;
    }

    // ─────────────────────────────────────────────
    // 域名格式校验
    // ─────────────────────────────────────────────

    function _validateDomain(string memory domainName) internal pure {
        bytes memory b = bytes(domainName);
        require(b.length == 6, "DCDomain: must be exactly 6 characters");
        for (uint256 i = 0; i < 6; i++) {
            uint8 c = uint8(b[i]);
            bool isDigit = c >= 48 && c <= 57;
            bool isLower = c >= 97 && c <= 122;
            bool isUpper = c >= 65 && c <= 90;
            require(isDigit || isLower || isUpper, "DCDomain: invalid character");
        }
    }

    // ─────────────────────────────────────────────
    // 用户操作
    // ─────────────────────────────────────────────

    function setPrimaryDomain(string calldata domainName) external {
        uint256 tokenId = _domainToTokenId[domainName];
        require(tokenId != 0, "DCDomain: domain not registered");
        require(ownerOf(tokenId) == msg.sender, "DCDomain: not your domain");
        primaryDomain[msg.sender] = domainName;
        emit PrimaryDomainSet(msg.sender, domainName);
    }

    function setResolve(string calldata domainName, address target) external {
        uint256 tokenId = _domainToTokenId[domainName];
        require(tokenId != 0, "DCDomain: domain not registered");
        require(ownerOf(tokenId) == msg.sender, "DCDomain: not your domain");
        resolve[domainName] = target;
        emit ResolveSet(domainName, target);
    }

    function _assertJsonSafe(bytes memory b, uint256 maxLen) internal pure {
        require(b.length <= maxLen, "DCDomain: too long");
        for (uint256 i; i < b.length; ) {
            uint8 c = uint8(b[i]);
            require(c >= 0x20 && c != 0x22 && c != 0x5c, "DCDomain: unsafe char");
            unchecked { ++i; }
        }
    }

    function _tokenIdForDomain(string calldata domainName) internal view returns (uint256 tokenId) {
        tokenId = _domainToTokenId[domainName];
        require(tokenId != 0, "DCDomain: domain not registered");
    }

    /// @notice 按 tokenId 设置域名描述
    function setDomainDescription(uint256 tokenId, string calldata desc) external {
        require(bytes(_tokenIdToDomain[tokenId]).length > 0, "DCDomain: token not exist");
        require(ownerOf(tokenId) == msg.sender, "DCDomain: not your domain");
        _assertJsonSafe(bytes(desc), MAX_DOMAIN_DESCRIPTION_BYTES);
        domainDescription[tokenId] = desc;
        emit DomainDescriptionSet(tokenId, desc);
    }

    /// @notice 按 6 位域名字符串设置描述（不含 @DC）
    function setDomainDescriptionFor(string calldata domainName, string calldata desc) external {
        uint256 tokenId = _tokenIdForDomain(domainName);
        require(ownerOf(tokenId) == msg.sender, "DCDomain: not your domain");
        _assertJsonSafe(bytes(desc), MAX_DOMAIN_DESCRIPTION_BYTES);
        domainDescription[tokenId] = desc;
        emit DomainDescriptionSet(tokenId, desc);
    }

    /// @notice 按 tokenId 设置背景图 URI（链上存字符串，图片本体通常在 IPFS/HTTP）
    function setDomainBackgroundUri(uint256 tokenId, string calldata uri) external {
        require(bytes(_tokenIdToDomain[tokenId]).length > 0, "DCDomain: token not exist");
        require(ownerOf(tokenId) == msg.sender, "DCDomain: not your domain");
        _assertJsonSafe(bytes(uri), MAX_DOMAIN_BACKGROUND_URI_BYTES);
        domainBackgroundUri[tokenId] = uri;
        emit DomainBackgroundUriSet(tokenId, uri);
    }

    /// @notice 按 6 位域名字符串设置背景图 URI
    function setDomainBackgroundUriFor(string calldata domainName, string calldata uri) external {
        uint256 tokenId = _tokenIdForDomain(domainName);
        require(ownerOf(tokenId) == msg.sender, "DCDomain: not your domain");
        _assertJsonSafe(bytes(uri), MAX_DOMAIN_BACKGROUND_URI_BYTES);
        domainBackgroundUri[tokenId] = uri;
        emit DomainBackgroundUriSet(tokenId, uri);
    }

    // ─────────────────────────────────────────────
    // 查询
    // ─────────────────────────────────────────────

    function domainOf(uint256 tokenId) external view returns (string memory) {
        require(bytes(_tokenIdToDomain[tokenId]).length > 0, "DCDomain: token not exist");
        return string(abi.encodePacked(_tokenIdToDomain[tokenId], "@DC"));
    }

    function isRegistered(string calldata domainName) external view returns (bool) {
        return _domainToTokenId[domainName] != 0;
    }

    function tokenIdOf(string calldata domainName) external view returns (uint256) {
        uint256 tokenId = _domainToTokenId[domainName];
        require(tokenId != 0, "DCDomain: not registered");
        return tokenId;
    }

    /// @notice 已注册域名 NFT 总数（等于当前最大 tokenId，无 burn）
    function totalDomains() external view returns (uint256) {
        return _tokenIdCounter;
    }

    function creatorOf(uint256 tokenId) external view returns (address) {
        require(bytes(_tokenIdToDomain[tokenId]).length > 0, "DCDomain: token not exist");
        return _creatorOfToken[tokenId];
    }

    function createdDomainCount(address creator) external view returns (uint256) {
        return _createdTokensBy[creator].length;
    }

    function createdDomainTokenAt(address creator, uint256 index) external view returns (uint256) {
        return _createdTokensBy[creator][index];
    }

    function createdDomainTokens(address creator, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory tokenIds)
    {
        require(limit <= 100, "DCDomain: limit too large");
        uint256 total = _createdTokensBy[creator].length;
        if (offset >= total) return new uint256[](0);
        uint256 remaining = total - offset;
        uint256 n = remaining < limit ? remaining : limit;
        tokenIds = new uint256[](n);
        for (uint256 i; i < n; ) {
            tokenIds[i] = _createdTokensBy[creator][offset + i];
            unchecked { ++i; }
        }
    }

    // ─────────────────────────────────────────────
    // 管理员
    // ─────────────────────────────────────────────

    function setBasePrice(uint256 newPrice) external onlyOwner {
        basePrice = newPrice;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "DCDomain: zero treasury");
        treasury = newTreasury;
    }

    function setPaymentToken(address newToken) external onlyOwner {
        require(newToken != address(0), "DCDomain: zero token");
        paymentToken = IERC20(newToken);
    }

    function setDomainMarket(address newMarket) external onlyOwner {
        domainMarket = newMarket;
    }

    /// @notice 不含 @DC 后缀的 6 位标签（供二级市场等使用）
    function domainLabelOf(uint256 tokenId) external view returns (string memory) {
        require(bytes(_tokenIdToDomain[tokenId]).length > 0, "DCDomain: token not exist");
        return _tokenIdToDomain[tokenId];
    }

    /// @notice 成交后由可信市场把解析地址同步为新持有人（避免二级成交后 resolve 仍指向旧地址）
    function marketSyncResolve(string calldata domainName, address newOwner) external {
        require(msg.sender == domainMarket && domainMarket != address(0), "DCDomain: not market");
        uint256 tokenId = _domainToTokenId[domainName];
        require(tokenId != 0 && ownerOf(tokenId) == newOwner, "DCDomain: bad sync");
        resolve[domainName] = newOwner;
        emit ResolveSet(domainName, newOwner);
    }

    // ─────────────────────────────────────────────
    // NFT 元数据
    // ─────────────────────────────────────────────

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(bytes(_tokenIdToDomain[tokenId]).length > 0, "DCDomain: token not exist");
        string memory domain = string(abi.encodePacked(_tokenIdToDomain[tokenId], "@DC"));
        string memory desc = bytes(domainDescription[tokenId]).length > 0
            ? domainDescription[tokenId]
            : "DC Domain Name Service";
        string memory svg = string(
            abi.encodePacked(
                '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">',
                '<rect width="400" height="200" fill="#0a0a0f"/>',
                '<text x="200" y="100" font-size="36" fill="#00ff9d" text-anchor="middle" font-family="monospace">',
                domain,
                "</text>",
                '<text x="200" y="140" font-size="14" fill="#555570" text-anchor="middle" font-family="monospace">DC Domain</text>',
                "</svg>"
            )
        );
        string memory imageField = bytes(domainBackgroundUri[tokenId]).length > 0
            ? domainBackgroundUri[tokenId]
            : string(abi.encodePacked("data:image/svg+xml;base64,", _base64Encode(bytes(svg))));
        string memory json = string(
            abi.encodePacked(
                '{"name":"',
                domain,
                '","description":"',
                desc,
                '","image":"',
                imageField,
                '"}'
            )
        );
        return string(abi.encodePacked("data:application/json;base64,", _base64Encode(bytes(json))));
    }

    // ─────────────────────────────────────────────
    // Base64
    // ─────────────────────────────────────────────

    string internal constant _B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    function _base64Encode(bytes memory data) internal pure returns (string memory) {
        uint256 len = data.length;
        if (len == 0) return "";
        uint256 encodedLen = 4 * ((len + 2) / 3);
        bytes memory result = new bytes(encodedLen);
        bytes memory chars = bytes(_B64_CHARS);
        uint256 i = 0;
        uint256 j = 0;
        for (; i + 2 < len; i += 3) {
            result[j++] = chars[(uint8(data[i]) >> 2) & 0x3F];
            result[j++] = chars[((uint8(data[i]) & 0x03) << 4) | ((uint8(data[i + 1]) >> 4) & 0x0F)];
            result[j++] = chars[((uint8(data[i + 1]) & 0x0F) << 2) | ((uint8(data[i + 2]) >> 6) & 0x03)];
            result[j++] = chars[uint8(data[i + 2]) & 0x3F];
        }
        if (i + 1 == len) {
            result[j++] = chars[(uint8(data[i]) >> 2) & 0x3F];
            result[j++] = chars[(uint8(data[i]) & 0x03) << 4];
            result[j++] = bytes1("=");
            result[j++] = bytes1("=");
        } else if (i + 2 == len) {
            result[j++] = chars[(uint8(data[i]) >> 2) & 0x3F];
            result[j++] = chars[((uint8(data[i]) & 0x03) << 4) | ((uint8(data[i + 1]) >> 4) & 0x0F)];
            result[j++] = chars[(uint8(data[i + 1]) & 0x0F) << 2];
            result[j++] = bytes1("=");
        }
        return string(result);
    }
}
