// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev 最小 ERC20，供 Open 币币测试托管/结算
contract MockERC20Mint is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// @dev 与 DealInfoNFT 工厂锁/统计接口兼容的轻量 ERC721
contract MockInfoNFT is ERC721 {
    address public factoryAuth;

    mapping(uint256 => uint256) private _tot;
    mapping(uint256 => uint256) private _maxP;
    mapping(uint256 => uint32) public lockCount;
    mapping(uint256 => mapping(address => uint32)) public lockCountByDeal;

    constructor() ERC721("Info", "INFO") {}

    function setFactoryAuth(address f) external {
        require(factoryAuth == address(0), "auth");
        factoryAuth = f;
    }

    modifier onlyF() {
        require(msg.sender == factoryAuth, "!f");
        _;
    }

    function mint(address to, uint256 id) external {
        _mint(to, id);
        _maxP[id] = id;
    }

    function totalMintedOf(uint256 id) external view returns (uint256) {
        return _tot[id];
    }

    function maxPartnerOf(uint256 id) external view returns (uint256) {
        require(_ownerOf(id) != address(0), "nx");
        uint256 p = _maxP[id];
        return p == 0 ? id : p;
    }

    function addMinted(uint256 id, uint256 a) external onlyF {
        _tot[id] += a;
    }

    function setMaxPartnerOf(uint256 id, uint256 partnerId) external onlyF {
        require(_ownerOf(id) != address(0) && _ownerOf(partnerId) != address(0), "nx");
        _maxP[id] = partnerId;
    }

    function lockByFactory(uint256 tokenId, address deal_, address owner) external onlyF {
        require(ownerOf(tokenId) == owner && owner != address(0), "own");
        lockCountByDeal[tokenId][deal_] += 1;
        lockCount[tokenId] += 1;
    }

    function unlockByFactory(uint256 tokenId, address deal_) external onlyF {
        uint32 c = lockCountByDeal[tokenId][deal_];
        require(c > 0, "c");
        lockCountByDeal[tokenId][deal_] = c - 1;
        lockCount[tokenId] -= 1;
    }
}

/// @dev DealOpenTokenToken 期望的工厂回调（锁/统计/索引/mint 等）
contract MockOpenTTFactory {
    MockInfoNFT public nft;
    address public hub;
    address public lastCreditA;
    address public lastCreditB;
    uint256 public lastCreditATokenId;
    bool public lastCreditAValid;
    uint256 public lastCreditBTokenId;
    bool public lastCreditBValid;
    uint256 public lastCreditBase;

    function setNft(address _nft) external {
        nft = MockInfoNFT(_nft);
    }

    function setHub(address h) external {
        hub = h;
    }

    function isAllowedCreateFor(address) external pure returns (bool) {
        return false;
    }

    function mintDL(address, uint256) external pure {}

    function logDealRewards(address, uint256, address, uint256, address, uint256) external pure {}

    struct DealRewardBatch {
        address partyA; uint256 toA; address partyB; uint256 toB; address cAddr; uint256 toC;
        uint256 aTokenId; uint256 aMinted; uint256 bTokenId; uint256 bMinted; uint256 cTokenId; uint256 cMinted;
    }
    function mintAndRecordDealRewards(DealRewardBatch calldata) external pure {}

    function recordDealCredit(
        address partyA,
        address partyB,
        uint256 aTokenId,
        bool aValid,
        uint256 bTokenId,
        bool bValid,
        uint256 baseCredit
    ) external {
        lastCreditA = partyA;
        lastCreditB = partyB;
        lastCreditATokenId = aTokenId;
        lastCreditAValid = aValid;
        lastCreditBTokenId = bTokenId;
        lastCreditBValid = bValid;
        lastCreditBase = baseCredit;
    }

    function updateAndQuoteToDL(address, uint256) external pure returns (uint256) {
        return 0;
    }

    function dealMessageHub() external view returns (address) {
        return hub;
    }

    function onCreated(address, bool) external pure {}

    function onJoined(address, bool) external pure {}

    function onParticipantRemoved(address) external pure {}

    function onAbandoned(address, address) external pure {}

    function recordDealTimeline(uint8, address, bool, uint256) external pure {}

    function onClosedFor(address) external pure {}

    function onCompletedFor(address) external pure {}

    function infoAddMinted(uint256 id, uint256 a) external {
        nft.addMinted(id, a);
    }

    function infoSetMaxPartnerOf(uint256 id, uint256 p) external {
        nft.setMaxPartnerOf(id, p);
    }

    function infoLock(uint256 id, address holder) external {
        nft.lockByFactory(id, msg.sender, holder);
    }

    function infoUnlock(uint256 id) external {
        nft.unlockByFactory(id, msg.sender);
    }
}
