// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {DealError} from "./DealErrors.sol";

interface IDealInfoNFTView {
    function ownerOf(uint256 tokenId) external view returns (address);
    function isLocked(uint256 tokenId) external view returns (bool);
}

/// @dev 商品 NFT 托管/交割逻辑外提，经 delegatecall 在 Deal 存储上下文执行
library DealAssetNftLib {
    function assetContract(address assetNftAddr, address infoNft) internal pure returns (address) {
        return assetNftAddr == address(0) ? infoNft : assetNftAddr;
    }

    /// @dev 供 Deal 在 join/pay 路径单独校验（与 pull 内校验一致）
    function assertAssetAllowedForA(
        address infoNft,
        address partyA,
        address aAssetNft,
        uint256 aAssetNftId,
        uint256 aNftId,
        uint256 gateNftId
    ) external view {
        _assertAllowedForA(infoNft, partyA, aAssetNft, aAssetNftId, aNftId, gateNftId);
    }

    function assertAssetAllowedForB(
        address infoNft,
        address partyB,
        address bAssetNft,
        uint256 bAssetNftId,
        uint256 bNftId,
        uint256 gateNftId
    ) external view {
        _assertAllowedForB(infoNft, partyB, bAssetNft, bAssetNftId, bNftId, gateNftId);
    }

    function _assertAllowedForA(
        address infoNft,
        address partyA,
        address aAssetNft,
        uint256 aAssetNftId,
        uint256 aNftId,
        uint256 gateNftId
    ) internal view {
        if (aAssetNftId == 0) return;
        address nft = assetContract(aAssetNft, infoNft);
        if (nft == address(0)) revert DealError(38);
        if (nft == infoNft) {
            if (aAssetNftId == aNftId) revert DealError(39);
            if (aAssetNftId == gateNftId) revert DealError(40);
            if (IDealInfoNFTView(infoNft).ownerOf(aAssetNftId) != partyA) revert DealError(41);
            if (IDealInfoNFTView(infoNft).isLocked(aAssetNftId)) revert DealError(42);
        } else {
            if (IERC721(nft).ownerOf(aAssetNftId) != partyA) revert DealError(41);
        }
    }

    function _assertAllowedForB(
        address infoNft,
        address partyB,
        address bAssetNft,
        uint256 bAssetNftId,
        uint256 bNftId,
        uint256 gateNftId
    ) internal view {
        if (bAssetNftId == 0) return;
        address nft = assetContract(bAssetNft, infoNft);
        if (nft == address(0)) revert DealError(43);
        if (partyB == address(0)) revert DealError(44);
        if (nft == infoNft) {
            if (bAssetNftId == bNftId) revert DealError(45);
            if (bAssetNftId == gateNftId) revert DealError(46);
            if (IDealInfoNFTView(infoNft).ownerOf(bAssetNftId) != partyB) revert DealError(47);
            if (IDealInfoNFTView(infoNft).isLocked(bAssetNftId)) revert DealError(48);
        } else {
            if (IERC721(nft).ownerOf(bAssetNftId) != partyB) revert DealError(47);
        }
    }

    /// @return executed 是否执行了拉取（调用方需置 aAssetNftDeposited 并 emit）
    function pullForA(
        uint256 aAssetNftId,
        bool aAssetNftDeposited,
        address aAssetNft,
        address infoNft,
        address partyA,
        uint256 aNftId,
        uint256 gateNftId
    ) external returns (bool executed) {
        if (aAssetNftId == 0 || aAssetNftDeposited) return false;
        _assertAllowedForA(infoNft, partyA, aAssetNft, aAssetNftId, aNftId, gateNftId);
        address nft = assetContract(aAssetNft, infoNft);
        IERC721(nft).safeTransferFrom(partyA, address(this), aAssetNftId);
        return true;
    }

    function pullForB(
        uint256 bAssetNftId,
        bool bAssetNftDeposited,
        address bAssetNft,
        address infoNft,
        address partyB,
        uint256 bNftId,
        uint256 gateNftId
    ) external returns (bool executed) {
        if (bAssetNftId == 0 || bAssetNftDeposited) return false;
        _assertAllowedForB(infoNft, partyB, bAssetNft, bAssetNftId, bNftId, gateNftId);
        address nft = assetContract(bAssetNft, infoNft);
        IERC721(nft).safeTransferFrom(partyB, address(this), bAssetNftId);
        return true;
    }

    function settleBAssetToA(
        bool bAssetNftDeposited,
        uint256 bAssetNftId,
        address bAssetNft,
        address infoNft,
        address partyA
    ) external returns (bool ok, address to, uint256 id) {
        if (!bAssetNftDeposited || bAssetNftId == 0) return (false, address(0), 0);
        address nft = assetContract(bAssetNft, infoNft);
        IERC721(nft).safeTransferFrom(address(this), partyA, bAssetNftId);
        return (true, partyA, bAssetNftId);
    }

    function settleAAssetToB(
        bool aAssetNftDeposited,
        uint256 aAssetNftId,
        address aAssetNft,
        address infoNft,
        address partyB
    ) external returns (bool ok, address to, uint256 id) {
        if (!aAssetNftDeposited || aAssetNftId == 0) return (false, address(0), 0);
        address nft = assetContract(aAssetNft, infoNft);
        IERC721(nft).safeTransferFrom(address(this), partyB, aAssetNftId);
        return (true, partyB, aAssetNftId);
    }

    function sendOutAAssetToA(
        bool aAssetNftDeposited,
        uint256 aAssetNftId,
        address aAssetNft,
        address infoNft,
        address partyA
    ) external returns (bool ok, address to, uint256 id) {
        if (!aAssetNftDeposited || aAssetNftId == 0) return (false, address(0), 0);
        address nft = assetContract(aAssetNft, infoNft);
        IERC721(nft).safeTransferFrom(address(this), partyA, aAssetNftId);
        return (true, partyA, aAssetNftId);
    }

    function sendOutBAssetToB(
        bool bAssetNftDeposited,
        uint256 bAssetNftId,
        address bAssetNft,
        address infoNft,
        address partyB
    ) external returns (bool ok, address to, uint256 id) {
        if (!bAssetNftDeposited || bAssetNftId == 0) return (false, address(0), 0);
        address nft = assetContract(bAssetNft, infoNft);
        IERC721(nft).safeTransferFrom(address(this), partyB, bAssetNftId);
        return (true, partyB, bAssetNftId);
    }
}
