// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/* 外提库：通过 external 函数让实现字节码落在独立部署地址，供 Deal 代理/克隆 delegatecall 使用。 */

interface IDealInfoNFTView {
    function totalMintedOf(uint256 tokenId) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function maxPartnerOf(uint256 tokenId) external view returns (uint256);
}

interface IFactoryInfoSetMax {
    function infoSetMaxPartnerOf(uint256 tokenId, uint256 partnerTokenId) external;
}

library DealLib {
    uint32 private constant DL_TO_DL_FEE_NUM = 1;
    uint32 private constant DL_TO_DL_FEE_DEN = 1000;

    function computeSwapFeesAndNets(
        uint256 aSwapAmount,
        address aTokenNorm,
        uint256 bSwapAmount,
        address bTokenNorm,
        address dl,
        uint32 feeNonDLNum,
        uint32 feeNonDLDen
    )
        external
        pure
        returns (uint256 aFee, uint256 bFee, uint256 aSwapNetForB, uint256 bSwapNetForA)
    {
        if (aSwapAmount > 0 && aTokenNorm == dl && bSwapAmount > 0 && bTokenNorm == dl) {
            aFee = (aSwapAmount * DL_TO_DL_FEE_NUM) / DL_TO_DL_FEE_DEN;
            bFee = (bSwapAmount * DL_TO_DL_FEE_NUM) / DL_TO_DL_FEE_DEN;
        } else {
            aFee = _nonDlFee(aSwapAmount, aTokenNorm, dl, feeNonDLNum, feeNonDLDen);
            bFee = _nonDlFee(bSwapAmount, bTokenNorm, dl, feeNonDLNum, feeNonDLDen);
        }
        aSwapNetForB = aSwapAmount - aFee;
        bSwapNetForA = bSwapAmount - bFee;
    }

    function _nonDlFee(
        uint256 amount,
        address tokenNorm,
        address dl,
        uint32 num,
        uint32 den
    ) private pure returns (uint256) {
        if (amount == 0 || tokenNorm == dl) return 0;
        return (amount * num) / den;
    }

    function preferFirstMax2(uint256 id1, uint256 s1, uint256 id2, uint256 s2)
        external
        pure
        returns (uint256)
    {
        return _preferFirstMax2(id1, s1, id2, s2);
    }

    function preferFirstMax3(
        uint256 id1,
        uint256 s1,
        uint256 id2,
        uint256 s2,
        uint256 id3,
        uint256 s3
    ) external pure returns (uint256) {
        return _preferFirstMax3(id1, s1, id2, s2, id3, s3);
    }

    function _preferFirstMax2(uint256 id1, uint256 s1, uint256 id2, uint256 s2)
        private
        pure
        returns (uint256)
    {
        if (s2 > s1) return id2;
        return id1;
    }

    function _preferFirstMax3(
        uint256 id1,
        uint256 s1,
        uint256 id2,
        uint256 s2,
        uint256 id3,
        uint256 s3
    ) private pure returns (uint256) {
        if (s1 >= s2 && s1 >= s3) return id1;
        if (s2 >= s3) return id2;
        return id3;
    }

    function uniqueMax4(
        uint256 id1,
        uint256 s1,
        uint256 id2,
        uint256 s2,
        uint256 id3,
        uint256 s3,
        uint256 id4,
        uint256 s4
    ) external pure returns (uint256 id, bool unique) {
        return _uniqueMax4(id1, s1, id2, s2, id3, s3, id4, s4);
    }

    function _uniqueMax4(
        uint256 id1,
        uint256 s1,
        uint256 id2,
        uint256 s2,
        uint256 id3,
        uint256 s3,
        uint256 id4,
        uint256 s4
    ) private pure returns (uint256 id, bool unique) {
        uint256 best = s1;
        uint256 cnt = 1;
        uint256 win = id1;
        if (s2 > best) {
            best = s2;
            win = id2;
            cnt = 1;
        } else if (s2 == best) {
            cnt++;
        }
        if (s3 > best) {
            best = s3;
            win = id3;
            cnt = 1;
        } else if (s3 == best) {
            cnt++;
        }
        if (s4 > best) {
            best = s4;
            win = id4;
            cnt = 1;
        } else if (s4 == best) {
            cnt++;
        }
        if (cnt == 1) return (win, true);
        return (0, false);
    }

    function isRecognizedToken(
        address tokenNorm,
        address WNATIVE,
        address recognizedToken0,
        address recognizedToken1
    ) external pure returns (bool) {
        return _isRecognizedToken(tokenNorm, WNATIVE, recognizedToken0, recognizedToken1);
    }

    function isRecognizedOrDL(
        address tokenNorm,
        address dl,
        address WNATIVE,
        address recognizedToken0,
        address recognizedToken1
    ) external pure returns (bool) {
        return tokenNorm == dl
            || _isRecognizedToken(tokenNorm, WNATIVE, recognizedToken0, recognizedToken1);
    }

    function _isRecognizedToken(
        address tokenNorm,
        address WNATIVE,
        address recognizedToken0,
        address recognizedToken1
    ) private pure returns (bool) {
        return tokenNorm == WNATIVE
            || (recognizedToken0 != address(0) && tokenNorm == recognizedToken0)
            || (recognizedToken1 != address(0) && tokenNorm == recognizedToken1);
    }

    function resolveCRewardTarget(
        address infoNft,
        address partyA,
        address partyB,
        bool aNftLocked,
        uint256 aNftId,
        bool bNftLocked,
        uint256 bNftId
    ) external view returns (uint256 cToken, address cAddr) {
        if (infoNft == address(0)) return (0, address(0));
        bool hasA = aNftLocked && aNftId != 0 && IDealInfoNFTView(infoNft).ownerOf(aNftId) == partyA;
        bool hasB = bNftLocked && bNftId != 0 && IDealInfoNFTView(infoNft).ownerOf(bNftId) == partyB;
        cToken = _selectC(infoNft, hasA, hasB, aNftId, bNftId);
        if (cToken != 0) cAddr = IDealInfoNFTView(infoNft).ownerOf(cToken);
    }

    function _selectC(
        address infoNft,
        bool hasA,
        bool hasB,
        uint256 aNftId,
        uint256 bNftId
    ) private view returns (uint256 cToken) {
        IDealInfoNFTView inf = IDealInfoNFTView(infoNft);

        if (hasA && hasB) {
            uint256 maxA = inf.maxPartnerOf(aNftId);
            uint256 maxB = inf.maxPartnerOf(bNftId);

            uint256 sA = inf.totalMintedOf(aNftId);
            uint256 sB = inf.totalMintedOf(bNftId);
            uint256 sMA = inf.totalMintedOf(maxA);
            uint256 sMB = inf.totalMintedOf(maxB);

            (uint256 win4, bool unique4) = _uniqueMax4(aNftId, sA, bNftId, sB, maxA, sMA, maxB, sMB);
            if (unique4) return win4;
            if (sA == sB && sA == sMA && sA == sMB) return aNftId;
            return 0;
        }

        if (hasA) {
            uint256 maxA = inf.maxPartnerOf(aNftId);
            uint256 sA = inf.totalMintedOf(aNftId);
            uint256 sMA = inf.totalMintedOf(maxA);
            return (sMA > sA) ? maxA : aNftId;
        }

        if (hasB) {
            uint256 maxB = inf.maxPartnerOf(bNftId);
            uint256 sB = inf.totalMintedOf(bNftId);
            uint256 sMB = inf.totalMintedOf(maxB);
            return (sMB > sB) ? maxB : bNftId;
        }

        return 0;
    }

    /// @dev 与 Deal._refreshMaxPointers 等价；写操作通过 factory 代理。
    function refreshMaxPointers(
        address infoNft,
        address factory_,
        bool aNftLocked,
        uint256 aNftId,
        bool bNftLocked,
        uint256 bNftId
    ) external {
        if (infoNft == address(0)) return;
        IDealInfoNFTView inf = IDealInfoNFTView(infoNft);
        IFactoryInfoSetMax fi = IFactoryInfoSetMax(factory_);
        bool hasA = aNftLocked && aNftId != 0;
        bool hasB = bNftLocked && bNftId != 0;

        if (hasA) {
            uint256 curMaxA = inf.maxPartnerOf(aNftId);
            uint256 winA = hasB
                ? _preferFirstMax3(
                    aNftId,
                    inf.totalMintedOf(aNftId),
                    bNftId,
                    inf.totalMintedOf(bNftId),
                    curMaxA,
                    inf.totalMintedOf(curMaxA)
                )
                : _preferFirstMax2(
                    aNftId,
                    inf.totalMintedOf(aNftId),
                    curMaxA,
                    inf.totalMintedOf(curMaxA)
                );
            if (winA != curMaxA) fi.infoSetMaxPartnerOf(aNftId, winA);
        }
        if (hasB) {
            uint256 curMaxB = inf.maxPartnerOf(bNftId);
            uint256 winB = hasA
                ? _preferFirstMax3(
                    bNftId,
                    inf.totalMintedOf(bNftId),
                    aNftId,
                    inf.totalMintedOf(aNftId),
                    curMaxB,
                    inf.totalMintedOf(curMaxB)
                )
                : _preferFirstMax2(
                    bNftId,
                    inf.totalMintedOf(bNftId),
                    curMaxB,
                    inf.totalMintedOf(curMaxB)
                );
            if (winB != curMaxB) fi.infoSetMaxPartnerOf(bNftId, winB);
        }
    }
}
