// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IDealPairManagerLookup {
    function pairForToken(address token) external view returns (address);
}

/// @notice Lightweight frontend registry for the official DL swap assets.
/// Core pair creation and swap logic lives in PairManager/Pair/Router.
contract DealSwapAssetRegistry {
    struct SwapPairSet {
        address dl;
        address agi;
        address usdt;
        address ausd;
        address pairDlAgi;
        address pairDlUsdt;
        address pairDlAusd;
        address router;
    }

    address public owner;
    address public pairManager;
    address public dl;
    address public agi;
    address public usdt;
    address public ausd;
    address public router;

    event OwnerTransferred(address indexed oldOwner, address indexed newOwner);
    event SwapAssetsUpdated(
        address indexed pairManager,
        address indexed router,
        address dl,
        address agi,
        address usdt,
        address ausd
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(
        address owner_,
        address pairManager_,
        address router_,
        address dl_,
        address agi_,
        address usdt_,
        address ausd_
    ) {
        require(owner_ != address(0), "ZERO_OWNER");
        owner = owner_;
        _set(pairManager_, router_, dl_, agi_, usdt_, ausd_);
        emit OwnerTransferred(address(0), owner_);
    }

    function transferOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setSwapAssets(
        address pairManager_,
        address router_,
        address dl_,
        address agi_,
        address usdt_,
        address ausd_
    ) external onlyOwner {
        _set(pairManager_, router_, dl_, agi_, usdt_, ausd_);
    }

    function getSwapPairSet() external view returns (SwapPairSet memory s) {
        s = SwapPairSet({
            dl: dl,
            agi: agi,
            usdt: usdt,
            ausd: ausd,
            pairDlAgi: _pair(agi),
            pairDlUsdt: _pair(usdt),
            pairDlAusd: _pair(ausd),
            router: router
        });
    }

    function pairForOfficialToken(address token) external view returns (address pair, bool supported) {
        supported = token == agi || token == usdt || token == ausd;
        if (supported) pair = _pair(token);
    }

    function _set(address pairManager_, address router_, address dl_, address agi_, address usdt_, address ausd_)
        internal
    {
        require(pairManager_ != address(0) && router_ != address(0), "ZERO_CORE");
        require(dl_ != address(0) && agi_ != address(0) && usdt_ != address(0) && ausd_ != address(0), "ZERO_TOKEN");
        pairManager = pairManager_;
        router = router_;
        dl = dl_;
        agi = agi_;
        usdt = usdt_;
        ausd = ausd_;
        emit SwapAssetsUpdated(pairManager_, router_, dl_, agi_, usdt_, ausd_);
    }

    function _pair(address token) internal view returns (address) {
        return IDealPairManagerLookup(pairManager).pairForToken(token);
    }
}
