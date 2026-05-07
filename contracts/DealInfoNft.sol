// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ERC721Votes} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Votes.sol";

interface IFactoryLite {
    function dlToken() external view returns (address);
    /// @notice 基于 TWAP 的 U->DL 报价；输入为 U 的最小单位（例如 USDT 6 位），输出为 DL 的最小单位（通常 18 位）
    function updateAndQuoteToDL(address pair, uint256 amountIn) external returns (uint256 dlOut);
}
interface IDLBurnable is IERC20 { function burnFrom(address from, uint256 value) external; }

contract DealInfoNFT is ERC721, EIP712, ERC721Votes, Ownable {
    /* ========== 基本配置 ========== */
    uint256 public nextId = 1;
    uint16 public currentSeason = 1;

    mapping(uint256 => uint16) public seasonOf;
    mapping(uint256 => uint32) public dateCodeOf;
    mapping(uint256 => uint32) public dailySerialOf;
    mapping(uint16 => mapping(uint32 => uint32)) public mintedCountBySeasonAndDate;

    address public admin;
    // 主 Factory（仅用于 mintByBurn 时查询 TWAP 报价）；可由 Owner 切换
    address public factory;

    // 允许写入/锁的 Factory 白名单
    mapping(address => bool) public isFactory;

    // 多 Factory 事件
    event FactoryAdded(address indexed factory);
    event FactoryRemoved(address indexed factory);
    event PrimaryFactoryUpdated(address indexed factory);

    address public pair;
    uint256 public mintPriceDL;

    /// @notice 铸造事件（记录换算与燃烧结果）
    event MintByBurn(address indexed minter, uint256 indexed tokenId, uint256 uAmount, uint256 dlBurned);
    event CurrentSeasonUpdated(uint16 season);
    event DisplayNoAssigned(
        uint256 indexed tokenId,
        uint16 indexed season,
        uint32 indexed dateCode,
        uint32 dailySerial
    );

    /* ========== 地址枚举（可选） ========== */
    mapping(address => uint256[]) private _ownedTokens;
    mapping(uint256 => uint256)  private _ownedIndex1b;
    uint256 public constant MAX_PAGE_SIZE = 100;

    function tokensOfOwner(address owner) external view returns (uint256[] memory tokens) {
        return _ownedTokens[owner];
    }
    function tokensOfOwnerPaginated(address owner, uint256 offset, uint256 limit)
        external view returns (uint256[] memory tokens, uint256 total)
    {
        uint256[] storage arr = _ownedTokens[owner];
        total = arr.length;
        if (offset >= total) return (new uint256[](0), total);
        uint256 pageLimit = limit > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : limit;
        uint256 end = offset + pageLimit; if (end > total) end = total;
        uint256 n = end - offset; tokens = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) tokens[i] = arr[offset + i];
    }

    /* ========== 媒体（可选） ========== */
    struct Media { string uri; string mime; bytes data; }
    mapping(uint256 => Media) private _media;
    uint256 public maxImageDataBytes = 256*1024;
    uint256 public constant MAX_IMAGE_URI_BYTES = 512;
    uint256 public constant MAX_IMAGE_MIME_BYTES = 64;
    uint256 public constant MAX_USERNAME_BYTES = 64;
    uint256 public constant MAX_USERDETAIL_BYTES = 1000;
    event TokenImageURISet(uint256 indexed tokenId, string uri);
    event TokenImageDataSet(uint256 indexed tokenId, string mime, uint256 size);
    event MaxImageDataBytesUpdated(uint256 newLimit);

    /* ========== 访问控制 ========== */
    modifier onlyOwnerOrApproved(uint256 tokenId) {
        address owner = _ownerOf(tokenId);
        require(owner != address(0), "NONEXISTENT");
        require(
            msg.sender == owner ||
            getApproved(tokenId) == msg.sender ||
            isApprovedForAll(owner, msg.sender),
            "NOT_ALLOWED"
        );
        _;
    }
    modifier onlyFactoryAuth() { require(isFactory[msg.sender], "NOT_FACTORY"); _; }
    modifier onlyAdmin() { require(msg.sender == admin, "NOT_ADMIN"); _; }

    /* ========== 构造 & 治理 ========== */
    // EIP712("Deal Info NFT","1")，ERC721Votes 依赖它做 EIP-712 签名域
    constructor(address f, address p, uint256 u)
        ERC721("Deal Info NFT", "DINFT")
        EIP712("Deal Info NFT", "1")
        Ownable(msg.sender)
    {
        require(f != address(0), "ZERO_FACTORY");
        factory = f;                  // 作为主 Factory（供 mintByBurn 查询 TWAP）
        isFactory[f] = true;          // 主 Factory 默认授权
        emit FactoryAdded(f);
        admin = msg.sender;
        mintPriceDL = u;
        pair = p;
    }

    // 设置/切换主 Factory（必须先授权）
    function setFactory(address f) external onlyOwner {
        require(f != address(0), "ZERO_FACTORY");
        require(isFactory[f], "NEW_FACTORY_NOT_ADDED");
        factory = f;
        emit PrimaryFactoryUpdated(f);
    }
    // 新增/移除授权 Factory（并行授权以平滑迁移）
    function addFactory(address f) external onlyOwner {
        require(f != address(0), "ZERO_FACTORY");
        require(!isFactory[f], "ALREADY_ADDED");
        isFactory[f] = true;
        emit FactoryAdded(f);
    }
    function removeFactory(address f) external onlyOwner {
        require(isFactory[f], "NOT_ADDED");
        require(f != factory, "CANNOT_REMOVE_PRIMARY");
        isFactory[f] = false;
        emit FactoryRemoved(f);
    }

    function setAdmin(address _admin) external onlyAdmin {
        require(_admin != address(0), "ZERO_ADMIN");
        admin = _admin;
    }

    function setMintPriceU(address p, uint256 u) external onlyOwner { pair = p; mintPriceDL = u; }

    function setMintPriceUByAdmin(uint256 u) external onlyAdmin {
        require(u >= 1 * 10**16 && u <= 100 * 10**18);
        mintPriceDL = u;
    }

    function setMaxImageDataBytes(uint256 newLimit) external onlyOwner {
        require(newLimit <= 256*1024, "LIMIT");
        maxImageDataBytes = newLimit;
        emit MaxImageDataBytesUpdated(newLimit);
    }

    function setCurrentSeason(uint16 season_) external onlyOwner {
        require(season_ > 0, "BAD_SEASON");
        currentSeason = season_;
        emit CurrentSeasonUpdated(season_);
    }

    /* ========== 媒体/昵称 ========== */
    function _assertJsonSafe(bytes memory b, uint256 maxLen) internal pure {
        require(b.length <= maxLen, "TOO_LONG");
        for (uint256 i; i < b.length; ) {
            uint8 c = uint8(b[i]);
            require(c >= 0x20 && c != 0x22 && c != 0x5c, "UNSAFE_CHAR");
            unchecked { ++i; }
        }
    }

    function setTokenImageURI(uint256 tokenId, string calldata uri) external onlyOwnerOrApproved(tokenId) {
        require(_ownerOf(tokenId) != address(0), "NONEXISTENT");
        _assertJsonSafe(bytes(uri), MAX_IMAGE_URI_BYTES);
        _media[tokenId].uri = uri; emit TokenImageURISet(tokenId, uri);
    }
    function setTokenImageData(uint256 tokenId, string calldata mime, bytes calldata data)
        external onlyOwnerOrApproved(tokenId)
    {
        require(_ownerOf(tokenId) != address(0), "NONEXISTENT");
        bytes memory mimeBytes = bytes(mime);
        require(mimeBytes.length > 0 && data.length <= maxImageDataBytes, "BAD_MEDIA");
        _assertJsonSafe(mimeBytes, MAX_IMAGE_MIME_BYTES);
        _media[tokenId].mime = mime; _media[tokenId].data = data;
        emit TokenImageDataSet(tokenId, mime, data.length);
    }
    function imageOf(uint256 tokenId) public view returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "NONEXISTENT");
        Media storage m = _media[tokenId];
        if (bytes(m.uri).length != 0) return m.uri;
        if (m.data.length != 0) {
            return string(abi.encodePacked(
                "data:", bytes(m.mime).length != 0 ? m.mime : "application/octet-stream",
                ";base64,", Base64.encode(m.data)
            ));
        }
        string memory svg = string(
            abi.encodePacked(
                "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 350 350'>",
                "<rect fill='#121212' width='100%' height='100%'/>",
                "<text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-size='20' fill='#fff'>DINFT #",
                _toString(tokenId), "</text></svg>"
            )
        );
        return string(abi.encodePacked("data:image/svg+xml;base64,", Base64.encode(bytes(svg))));
    }

    mapping(uint256 => string) public username;
    event TokenUserNameSet(uint256 indexed tokenId, string username);
    function setTokenUserName(uint256 tokenId, string calldata _name) external onlyOwnerOrApproved(tokenId) {
        require(_ownerOf(tokenId) != address(0), "NONEXISTENT");
        _assertJsonSafe(bytes(_name), MAX_USERNAME_BYTES);
        username[tokenId] = _name; emit TokenUserNameSet(tokenId, _name);
    }

    mapping(uint256 => string) public userdetail;
    event TokenUserDetailSet(uint256 indexed tokenId, string userdetail);
    function setTokenUserDetail(uint256 tokenId, string calldata _detail) external onlyOwnerOrApproved(tokenId) {
        require(_ownerOf(tokenId) != address(0), "NONEXISTENT");
        _assertJsonSafe(bytes(_detail), MAX_USERDETAIL_BYTES);
        userdetail[tokenId] = _detail; emit TokenUserDetailSet(tokenId, _detail);
    }

    /* ========== 统计与伙伴指针（Factory 代理写） ========== */
    mapping(uint256 => uint256) public totalDLMinted;
    event MintedAdded(uint256 indexed tokenId, uint256 amount);
    function totalMintedOf(uint256 tokenId) external view returns (uint256) { return totalDLMinted[tokenId]; }

    mapping(uint256 => uint256) private _maxPartner; // 0 表示自己
    event MaxPartnerUpdated(uint256 indexed tokenId, uint256 indexed newMaxPartner);

    function maxPartnerOf(uint256 tokenId) external view returns (uint256) {
        require(_ownerOf(tokenId) != address(0), "NONEXISTENT");
        uint256 p = _maxPartner[tokenId];
        return p == 0 ? tokenId : p;
    }

    function addMinted(uint256 tokenId, uint256 amount) external onlyFactoryAuth {
        totalDLMinted[tokenId] += amount;
        emit MintedAdded(tokenId, amount);
    }
    function setMaxPartnerOf(uint256 tokenId, uint256 partnerTokenId) external onlyFactoryAuth {
        require(_ownerOf(tokenId) != address(0) && _ownerOf(partnerTokenId) != address(0), "NONEXISTENT");
        _maxPartner[tokenId] = partnerTokenId;
        emit MaxPartnerUpdated(tokenId, partnerTokenId);
    }

    /* ========== 锁：支持多 Deal 并发 ========== */
    mapping(uint256 => uint32) public lockCount;
    mapping(uint256 => mapping(address => uint32)) public lockCountByDeal;

    event TokenLocked(uint256 indexed tokenId, address indexed deal, address indexed owner, uint256 totalLocks);
    event TokenUnlocked(uint256 indexed tokenId, address indexed deal, uint256 remainingLocks);

    function lockByFactory(uint256 tokenId, address deal, address owner) external onlyFactoryAuth {
        require(_ownerOf(tokenId) == owner && owner != address(0), "NOT_OWNER");
        require(lockCount[tokenId] < type(uint32).max, "LOCK_OVERFLOW");
        lockCountByDeal[tokenId][deal] += 1;
        lockCount[tokenId] += 1;
        emit TokenLocked(tokenId, deal, owner, lockCount[tokenId]);
    }
    function unlockByFactory(uint256 tokenId, address deal) external onlyFactoryAuth {
        uint32 cnt = lockCountByDeal[tokenId][deal];
        require(cnt > 0 && lockCount[tokenId] >= cnt, "UNLOCK_BAD_STATE");
        lockCountByDeal[tokenId][deal] = cnt - 1;
        lockCount[tokenId] -= 1;
        emit TokenUnlocked(tokenId, deal, lockCount[tokenId]);
    }
    function isLocked(uint256 tokenId) external view returns (bool) { return lockCount[tokenId] > 0; }

    /* ========== 铸造：通过 DL 燃烧（U 计价->TWAP 折算 DL） ========== */
    function mintByBurn() external returns (uint256 tokenId) {
        require(factory != address(0) && pair != address(0) && mintPriceDL > 0, "MINT_NOT_CONFIGURED");
        uint256 dlNeed = IFactoryLite(factory).updateAndQuoteToDL(pair, mintPriceDL);
        IDLBurnable(IFactoryLite(factory).dlToken()).burnFrom(msg.sender, dlNeed);

        tokenId = nextId++;
        uint32 dateCode = _dateCodeFromTimestamp(block.timestamp);
        uint32 serial = mintedCountBySeasonAndDate[currentSeason][dateCode] + 1;
        mintedCountBySeasonAndDate[currentSeason][dateCode] = serial;
        seasonOf[tokenId] = currentSeason;
        dateCodeOf[tokenId] = dateCode;
        dailySerialOf[tokenId] = serial;
        _mint(msg.sender, tokenId);
        _maxPartner[tokenId] = tokenId; // 默认指向自己

        emit DisplayNoAssigned(tokenId, currentSeason, dateCode, serial);
        emit MintByBurn(msg.sender, tokenId, mintPriceDL, dlNeed);
    }

    function displayNoOf(uint256 tokenId) public view returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "NONEXISTENT");
        return string(
            abi.encodePacked(
                "S",
                _toString(seasonOf[tokenId]),
                "-",
                _toString(dateCodeOf[tokenId]),
                "-",
                _toString(dailySerialOf[tokenId])
            )
        );
    }

    /* ========== tokenURI ========== */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "NONEXISTENT");
        string memory image = imageOf(tokenId);
        string memory displayNo = displayNoOf(tokenId);
        bytes memory json = abi.encodePacked(
            '{',
                '"name":"Deal Info NFT ', displayNo, '",',
                '"description":"Deal Info NFT - partner & DL stats",',
                '"image":"', image, '",',
                '"attributes":[',
                    '{"trait_type":"Display No","value":"', displayNo, '"},',
                    '{"trait_type":"Season","value":"', _toString(seasonOf[tokenId]), '"},',
                    '{"trait_type":"Date Code","value":"', _toString(dateCodeOf[tokenId]), '"},',
                    '{"trait_type":"Daily Serial","value":"', _toString(dailySerialOf[tokenId]), '"},',
                    '{"trait_type":"Total DL Minted","value":"', _toString(totalDLMinted[tokenId]), '"},',
                    '{"trait_type":"Locked","value":"', lockCount[tokenId] > 0 ? "true" : "false", '"}',
                ']',
            '}'
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    /* ========== 转移拦截 + 地址枚举维护 ========== */
    // v5 里需要重写 _update（且返回 from），并与 ERC721Votes 进行多重覆盖
    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721, ERC721Votes)
        returns (address from)
    {
        if (lockCount[tokenId] > 0) revert("LOCKED");

        // 先让父类处理所有权与投票移动（包含 ERC721Votes 的投票单元转移）
        from = super._update(to, tokenId, auth);

        // —— 再做地址枚举维护（你原来的逻辑保持不变） ——
        if (from != address(0)) {
            uint256 idx1b = _ownedIndex1b[tokenId];
            if (idx1b != 0) {
                uint256 idx = idx1b - 1;
                uint256[] storage arrFrom = _ownedTokens[from];
                uint256 last = arrFrom.length - 1;
                if (idx != last) {
                    uint256 lastId = arrFrom[last];
                    arrFrom[idx] = lastId;
                    _ownedIndex1b[lastId] = idx + 1;
                }
                arrFrom.pop();
                delete _ownedIndex1b[tokenId];
            }
        }
        if (to != address(0)) {
            _ownedTokens[to].push(tokenId);
            _ownedIndex1b[tokenId] = _ownedTokens[to].length;
        }
    }

    // v5 里也需要重写 _increaseBalance（多重覆盖），以让 Votes 记录总投票单元
    function _increaseBalance(address account, uint128 amount)
        internal
        override(ERC721, ERC721Votes)
    {
        super._increaseBalance(account, amount);
    }

    /* ========== 辅助 ========== */
    function _toString(uint256 v) internal pure returns (string memory str) {
        if (v == 0) return "0";
        uint256 j = v; uint256 len;
        while (j != 0) { len++; j /= 10; }
        bytes memory b = new bytes(len);
        while (v != 0) { len -= 1; b[len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        str = string(b);
    }

    function _dateCodeFromTimestamp(uint256 ts) internal pure returns (uint32 code) {
        (uint256 year, uint256 month, uint256 day) = _daysToDate(ts / 86400);
        code = uint32(year * 10000 + month * 100 + day);
    }

    function _daysToDate(uint256 _days) internal pure returns (uint256 year, uint256 month, uint256 day) {
        int256 __days = int256(_days);
        int256 L = __days + 68569 + 2440588;
        int256 N = (4 * L) / 146097;
        L = L - (146097 * N + 3) / 4;
        int256 _year = (4000 * (L + 1)) / 1461001;
        L = L - (1461 * _year) / 4 + 31;
        int256 _month = (80 * L) / 2447;
        int256 _day = L - (2447 * _month) / 80;
        L = _month / 11;
        _month = _month + 2 - (12 * L);
        _year = (100 * (N - 49)) + _year + L;

        year = uint256(_year);
        month = uint256(_month);
        day = uint256(_day);
    }
}
