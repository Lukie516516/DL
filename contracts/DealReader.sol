// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice 你的 deal 模板接口（名称与上次完全一致）
/// 若真实类型不同（比如 aPaid 实为 uint256），把这里与下面 struct 同步改一下即可。
interface IDeal {
    function status() external view returns (uint8);
    function joinMode() external view returns (uint8);
    function templateType() external view returns (uint8);
    function title() external view returns (string memory);

    function isDomainDeal() external view returns (bool);
    function domainName() external view returns (string memory);

    function a() external view returns (address);
    function b() external view returns (address);

    function aNftId() external view returns (uint256);
    function bNftId() external view returns (uint256);

    function expectedB() external view returns (address);
    function gateNftId() external view returns (uint256);

    function aPaid() external view returns (bool);
    function bPaid() external view returns (bool);

    function aVote() external view returns (uint8);
    function bVote() external view returns (uint8);

    function aAt() external view returns (uint256);
    function bAt() external view returns (uint256);
    function timeoutSeconds() external view returns (uint256);
    function timeStart() external view returns (uint256);
    function timeEnd() external view returns (uint256);

    function aSwapToken() external view returns (address);
    function aSwapAmount() external view returns (uint256);
    function aMarginToken() external view returns (address);
    function aMarginAmount() external view returns (uint256);
    function aAssetNft() external view returns (address);
    function aAssetNftId() external view returns (uint256);

    function bSwapToken() external view returns (address);
    function bSwapAmount() external view returns (uint256);
    function bMarginToken() external view returns (address);
    function bMarginAmount() external view returns (uint256);
    function bAssetNft() external view returns (address);
    function bAssetNftId() external view returns (uint256);
}

/// @notice NFT（头像/用户名/积分）接口：名称严格按你给的来（imageOf / username / totalDLMinted）
/// 为了兼容“按 tokenId 或按 address 记分”的两种可能，提供了 overload，
/// 实际合约若仅实现其中一种，另一种调用会被 try/catch 吃掉。
interface IProfileNFT {
    function imageOf(uint256 tokenId) external view returns (string memory);
    function username(uint256 tokenId) external view returns (string memory);
    function username(address user) external view returns (string memory);
    function totalDLMinted(uint256 tokenId) external view returns (uint256);
    function totalDLMinted(address user) external view returns (uint256);
}

/// @notice ERC20 元数据（name/decimals）
interface IERC20Metadata {
    function name() external view returns (string memory);
    function decimals() external view returns (uint8);
}

contract DealReader {
    uint256 public constant MAX_BATCH = 100;
    error BatchTooLarge();

    function _assertBatch(uint256 n) internal pure {
        if (n > MAX_BATCH) revert BatchTooLarge();
    }

    /* --------------------------------- 原有结构 --------------------------------- */
    struct DealInfo {
        bool ok;
        address deal;
        uint8 status;
        uint8 joinMode;
        uint8 templateType;
        string title;
        bool isDomainDeal;
        string domainName;
        address a;
        address b;
        uint256 aNftId;
        uint256 bNftId;
        address expectedB;
        uint256 gateNftId;
        bool aPaid;
        bool bPaid;
        uint8 aVote;
        uint8 bVote;
        uint256 aAt;
        uint256 bAt;
        uint256 timeoutSeconds;
        uint256 timeStart;
        uint256 timeEnd;
        address aSwapToken;
        uint256 aSwapAmount;
        address aMarginToken;
        uint256 aMarginAmount;
        address aAssetNft;
        uint256 aAssetNftId;
        address bSwapToken;
        uint256 bSwapAmount;
        address bMarginToken;
        uint256 bMarginAmount;
        address bAssetNft;
        uint256 bAssetNftId;
    }

    struct DealInfoSlim {
        bool ok;
        address deal;
        uint8 status;
        uint8 joinMode;
        uint8 templateType;
        bool isDomainDeal;
        string domainName;
        address a;
        address b;
        uint256 aNftId;
        uint256 bNftId;
        address expectedB;
        uint256 gateNftId;
        bool aPaid;
        bool bPaid;
        uint8 aVote;
        uint8 bVote;
        uint256 aAt;
        uint256 bAt;
        uint256 timeoutSeconds;
        uint256 timeStart;
        uint256 timeEnd;
        address aSwapToken;
        uint256 aSwapAmount;
        address aMarginToken;
        uint256 aMarginAmount;
        address aAssetNft;
        uint256 aAssetNftId;
        address bSwapToken;
        uint256 bSwapAmount;
        address bMarginToken;
        uint256 bMarginAmount;
        address bAssetNft;
        uint256 bAssetNftId;
    }

    /* ------------------------------ 新增：扩展结构 ------------------------------ */
    struct Profile {
        bool ok;                 // 任一字段成功读到即可视为 ok
        uint256 tokenId;
        string image;            // imageOf(tokenId)
        string username;         // username(tokenId)；若该签名不存在，会尝试 username(address)
        uint256 totalDLMinted;   // totalDLMinted(tokenId)；若该签名不存在，会尝试 totalDLMinted(address)
    }

    struct TokenMeta {
        bool ok;                 // name/decimals 只要有任一成功即 ok
        address token;
        string name;
        uint8 decimals;
    }

    /// @notice 扩展版：原有 DealInfo + A/B 的 NFT 档案 + 四个代币元数据
    struct DealInfoPlus {
        DealInfo core;
        Profile aProfile;
        Profile bProfile;
        TokenMeta aSwap;
        TokenMeta aMargin;
        TokenMeta bSwap;
        TokenMeta bMargin;
    }

    /* ------------------------------ 原有只读方法保留 ----------------------------- */

    function getDeal(address dealAddr) external view returns (DealInfo memory out) {
        out.deal = dealAddr;
        IDeal d = IDeal(dealAddr);
        bool ok = true;

        try d.status() returns (uint8 v) { out.status = v; } catch { ok = false; }
        try d.joinMode() returns (uint8 v) { out.joinMode = v; } catch { ok = false; }
        try d.templateType() returns (uint8 v) { out.templateType = v; } catch { ok = false; }
        try d.title() returns (string memory v) { out.title = v; } catch { ok = false; }
        try d.isDomainDeal() returns (bool v) { out.isDomainDeal = v; } catch { ok = false; }
        try d.domainName() returns (string memory v) { out.domainName = v; } catch { ok = false; }

        try d.a() returns (address v) { out.a = v; } catch { ok = false; }
        try d.b() returns (address v) { out.b = v; } catch { ok = false; }

        try d.aNftId() returns (uint256 v) { out.aNftId = v; } catch { ok = false; }
        try d.bNftId() returns (uint256 v) { out.bNftId = v; } catch { ok = false; }

        try d.expectedB() returns (address v) { out.expectedB = v; } catch { ok = false; }
        try d.gateNftId() returns (uint256 v) { out.gateNftId = v; } catch { ok = false; }

        try d.aPaid() returns (bool v) { out.aPaid = v; } catch { ok = false; }
        try d.bPaid() returns (bool v) { out.bPaid = v; } catch { ok = false; }

        try d.aVote() returns (uint8 v) { out.aVote = v; } catch { ok = false; }
        try d.bVote() returns (uint8 v) { out.bVote = v; } catch { ok = false; }

        try d.aAt() returns (uint256 v) { out.aAt = v; } catch { ok = false; }
        try d.bAt() returns (uint256 v) { out.bAt = v; } catch { ok = false; }
        try d.timeoutSeconds() returns (uint256 v) { out.timeoutSeconds = v; } catch { ok = false; }
        try d.timeStart() returns (uint256 v) { out.timeStart = v; } catch { ok = false; }
        try d.timeEnd() returns (uint256 v) { out.timeEnd = v; } catch { ok = false; }

        try d.aSwapToken() returns (address v) { out.aSwapToken = v; } catch { ok = false; }
        try d.aSwapAmount() returns (uint256 v) { out.aSwapAmount = v; } catch { ok = false; }
        try d.aMarginToken() returns (address v) { out.aMarginToken = v; } catch { ok = false; }
        try d.aMarginAmount() returns (uint256 v) { out.aMarginAmount = v; } catch { ok = false; }
        try d.aAssetNft() returns (address v) { out.aAssetNft = v; } catch { ok = false; }
        try d.aAssetNftId() returns (uint256 v) { out.aAssetNftId = v; } catch { ok = false; }

        try d.bSwapToken() returns (address v) { out.bSwapToken = v; } catch { ok = false; }
        try d.bSwapAmount() returns (uint256 v) { out.bSwapAmount = v; } catch { ok = false; }
        try d.bMarginToken() returns (address v) { out.bMarginToken = v; } catch { ok = false; }
        try d.bMarginAmount() returns (uint256 v) { out.bMarginAmount = v; } catch { ok = false; }
        try d.bAssetNft() returns (address v) { out.bAssetNft = v; } catch { ok = false; }
        try d.bAssetNftId() returns (uint256 v) { out.bAssetNftId = v; } catch { ok = false; }

        out.ok = ok;
    }

    function getDeals(address[] calldata deals) external view returns (DealInfo[] memory out) {
        uint256 n = deals.length;
        _assertBatch(n);
        out = new DealInfo[](n);
        for (uint256 i = 0; i < n; ) {
            out[i] = this.getDeal(deals[i]);
            unchecked { ++i; }
        }
    }

    function getDealsSlim(address[] calldata deals) external view returns (DealInfoSlim[] memory out) {
        uint256 n = deals.length;
        _assertBatch(n);
        out = new DealInfoSlim[](n);
        for (uint256 i = 0; i < n; ) {
            IDeal d = IDeal(deals[i]);
            DealInfoSlim memory s;
            s.deal = deals[i];
            bool ok = true;

            try d.status() returns (uint8 v) { s.status = v; } catch { ok = false; }
            try d.joinMode() returns (uint8 v) { s.joinMode = v; } catch { ok = false; }
            try d.templateType() returns (uint8 v) { s.templateType = v; } catch { ok = false; }
            try d.isDomainDeal() returns (bool v) { s.isDomainDeal = v; } catch { ok = false; }
            try d.domainName() returns (string memory v) { s.domainName = v; } catch { ok = false; }
            try d.a() returns (address v) { s.a = v; } catch { ok = false; }
            try d.b() returns (address v) { s.b = v; } catch { ok = false; }
            try d.aNftId() returns (uint256 v) { s.aNftId = v; } catch { ok = false; }
            try d.bNftId() returns (uint256 v) { s.bNftId = v; } catch { ok = false; }
            try d.expectedB() returns (address v) { s.expectedB = v; } catch { ok = false; }
            try d.gateNftId() returns (uint256 v) { s.gateNftId = v; } catch { ok = false; }
            try d.aPaid() returns (bool v) { s.aPaid = v; } catch { ok = false; }
            try d.bPaid() returns (bool v) { s.bPaid = v; } catch { ok = false; }
            try d.aVote() returns (uint8 v) { s.aVote = v; } catch { ok = false; }
            try d.bVote() returns (uint8 v) { s.bVote = v; } catch { ok = false; }
            try d.aAt() returns (uint256 v) { s.aAt = v; } catch { ok = false; }
            try d.bAt() returns (uint256 v) { s.bAt = v; } catch { ok = false; }
            try d.timeoutSeconds() returns (uint256 v) { s.timeoutSeconds = v; } catch { ok = false; }
            try d.timeStart() returns (uint256 v) { s.timeStart = v; } catch { ok = false; }
            try d.timeEnd() returns (uint256 v) { s.timeEnd = v; } catch { ok = false; }
            try d.aSwapToken() returns (address v) { s.aSwapToken = v; } catch { ok = false; }
            try d.aSwapAmount() returns (uint256 v) { s.aSwapAmount = v; } catch { ok = false; }
            try d.aMarginToken() returns (address v) { s.aMarginToken = v; } catch { ok = false; }
            try d.aMarginAmount() returns (uint256 v) { s.aMarginAmount = v; } catch { ok = false; }
            try d.aAssetNft() returns (address v) { s.aAssetNft = v; } catch { ok = false; }
            try d.aAssetNftId() returns (uint256 v) { s.aAssetNftId = v; } catch { ok = false; }
            try d.bSwapToken() returns (address v) { s.bSwapToken = v; } catch { ok = false; }
            try d.bSwapAmount() returns (uint256 v) { s.bSwapAmount = v; } catch { ok = false; }
            try d.bMarginToken() returns (address v) { s.bMarginToken = v; } catch { ok = false; }
            try d.bMarginAmount() returns (uint256 v) { s.bMarginAmount = v; } catch { ok = false; }
            try d.bAssetNft() returns (address v) { s.bAssetNft = v; } catch { ok = false; }
            try d.bAssetNftId() returns (uint256 v) { s.bAssetNftId = v; } catch { ok = false; }

            s.ok = ok;
            out[i] = s;
            unchecked { ++i; }
        }
    }

    /* ------------------------------ 新增：扩展只读方法 ----------------------------- */

    /// @notice 读取单个 deal 的核心字段 + NFT 档案 + 4 个代币元数据
    /// @param profileNft NFT 合约地址（头像/用户名/积分都从这读）
    function getDealPlus(address dealAddr, address profileNft)
        external
        view
        returns (DealInfoPlus memory out)
    {
        // 先读核心字段（原有逻辑）
        out.core = this.getDeal(dealAddr);

        // NFT 档案：a/b 的 tokenId 为 0 时，跳过（避免不必要的 revert）
        if (_isContract(profileNft)) {
            out.aProfile = _readProfile(profileNft, out.core.aNftId, out.core.a);
            out.bProfile = _readProfile(profileNft, out.core.bNftId, out.core.b);
        }

        // 4 个 ERC20 元数据（address(0) 或非合约地址跳过）
        out.aSwap   = _readToken(out.core.aSwapToken);
        out.aMargin = _readToken(out.core.aMarginToken);
        out.bSwap   = _readToken(out.core.bSwapToken);
        out.bMargin = _readToken(out.core.bMarginToken);
    }

    /// @notice 批量版：输入一组 deal 地址 + NFT 合约地址，一次性拉全量扩展信息
    function getDealsPlus(address[] calldata deals, address profileNft)
        external
        view
        returns (DealInfoPlus[] memory out)
    {
        uint256 n = deals.length;
        _assertBatch(n);
        out = new DealInfoPlus[](n);
        for (uint256 i = 0; i < n; ) {
            out[i] = this.getDealPlus(deals[i], profileNft);
            unchecked { ++i; }
        }
    }

    /* --------------------------------- 内部工具 --------------------------------- */

    function _readProfile(address nftAddr, uint256 tokenId, address ownerHint)
        internal
        view
        returns (Profile memory p)
    {
        p.tokenId = tokenId;

        // tokenId 为 0 或合约码为空：直接返回默认值（ok=false）
        if (tokenId == 0 || !_isContract(nftAddr)) {
            return p;
        }

        IProfileNFT nft = IProfileNFT(nftAddr);
        bool ok;

        // imageOf(tokenId)
        try nft.imageOf(tokenId) returns (string memory img) {
            p.image = img; ok = true;
        } catch {}

        // username(tokenId)；若该签名不存在，则尝试 username(address)
        try nft.username(tokenId) returns (string memory name1) {
            p.username = name1; ok = true;
        } catch {
            if (ownerHint != address(0)) {
                try nft.username(ownerHint) returns (string memory name2) {
                    p.username = name2; ok = true;
                } catch {}
            }
        }

        // totalDLMinted(tokenId)；若该签名不存在，则尝试 totalDLMinted(address)
        try nft.totalDLMinted(tokenId) returns (uint256 v1) {
            p.totalDLMinted = v1; ok = true;
        } catch {
            if (ownerHint != address(0)) {
                try nft.totalDLMinted(ownerHint) returns (uint256 v2) {
                    p.totalDLMinted = v2; ok = true;
                } catch {}
            }
        }

        p.ok = ok;
    }

    function _readToken(address token) internal view returns (TokenMeta memory m) {
        m.token = token;
        if (token == address(0) || !_isContract(token)) {
            return m; // ok=false
        }

        bool ok;

        // name()
        try IERC20Metadata(token).name() returns (string memory n) {
            m.name = n; ok = true;
        } catch {
            // 某些非常老的/非标准 ERC20 可能 name() 不存在，这里保持空字符串
        }

        // decimals()
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            m.decimals = d; ok = true;
        } catch {
            // 不猜默认 18，避免误导；保持 0
        }

        m.ok = ok;
    }

    function _isContract(address a) private view returns (bool) {
        return a.code.length > 0;
    }
}
