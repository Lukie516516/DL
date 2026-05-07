// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Keeps DealFactory small by owning template-to-implementation routing.
contract DealImplementationRegistry is Ownable {
    enum TemplateType {
        TokenToToken,
        TokenToNft,
        TokenToEmpty,
        EmptyToEmpty,
        NftToEmpty
    }

    address public fallbackImplementation;
    address public noAssetImplementation;
    address public aAssetNftImplementation;
    address public bAssetNftImplementation;
    address public aAssetNftOnlyImplementation;
    address public bAssetNftOnlyImplementation;
    address public openTokenTokenImplementation;

    event DealImplementationsUpdated(
        address indexed fallbackImplementation,
        address indexed noAssetImplementation,
        address indexed openTokenTokenImplementation
    );

    constructor() Ownable(msg.sender) {}

    function setDealImplementations(
        address fallbackImpl,
        address noAssetImpl,
        address aAssetNftImpl,
        address bAssetNftImpl,
        address aAssetNftOnlyImpl,
        address bAssetNftOnlyImpl,
        address openTokenTokenImpl
    ) external onlyOwner {
        require(
            fallbackImpl != address(0) &&
                noAssetImpl != address(0) &&
                aAssetNftImpl != address(0) &&
                bAssetNftImpl != address(0) &&
                aAssetNftOnlyImpl != address(0) &&
                bAssetNftOnlyImpl != address(0) &&
                openTokenTokenImpl != address(0)
        );
        fallbackImplementation = fallbackImpl;
        noAssetImplementation = noAssetImpl;
        aAssetNftImplementation = aAssetNftImpl;
        bAssetNftImplementation = bAssetNftImpl;
        aAssetNftOnlyImplementation = aAssetNftOnlyImpl;
        bAssetNftOnlyImplementation = bAssetNftOnlyImpl;
        openTokenTokenImplementation = openTokenTokenImpl;
        emit DealImplementationsUpdated(fallbackImpl, noAssetImpl, openTokenTokenImpl);
    }

    function resolveImplementation(
        uint8 templateType,
        bool openTokenTokenFast,
        uint256 aAssetNftId,
        uint256 bAssetNftId
    ) external view returns (address) {
        if (openTokenTokenFast) return openTokenTokenImplementation;
        if (_isNoAssetTemplate(templateType)) return noAssetImplementation;
        if (templateType == uint8(TemplateType.TokenToNft)) {
            if (aAssetNftId != 0) return aAssetNftImplementation;
            if (bAssetNftId != 0) return bAssetNftImplementation;
        }
        if (templateType == uint8(TemplateType.NftToEmpty)) {
            if (aAssetNftId != 0) return aAssetNftOnlyImplementation;
            if (bAssetNftId != 0) return bAssetNftOnlyImplementation;
        }
        return fallbackImplementation;
    }

    function _isNoAssetTemplate(uint8 templateType) internal pure returns (bool) {
        return templateType == uint8(TemplateType.TokenToToken)
            || templateType == uint8(TemplateType.TokenToEmpty)
            || templateType == uint8(TemplateType.EmptyToEmpty);
    }
}
