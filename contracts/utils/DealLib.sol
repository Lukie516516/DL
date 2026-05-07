// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DealError} from "./DealErrors.sol";

/* 外提库：通过 external 函数让实现字节码落在独立部署地址，供 Deal 代理/克隆 delegatecall 使用。 */

interface IDealInfoNFTView {
    function totalMintedOf(uint256 tokenId) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function maxPartnerOf(uint256 tokenId) external view returns (uint256);
}

interface IFactoryInfoSetMax {
    function infoSetMaxPartnerOf(uint256 tokenId, uint256 partnerTokenId) external;
}

interface IFactoryCreditGraphView {
    function creditGraph() external view returns (address);
}

interface IDealCreditGraphView {
    function resolveCRewardTarget(
        address partyA,
        address partyB,
        uint256 aTokenId,
        bool aValid,
        uint256 bTokenId,
        bool bValid
    ) external view returns (uint256 cTokenId, address cOwner);
}

interface IFactoryTwapLib {
    function updateAndQuoteToDL(address pair, uint256 amountIn) external returns (uint256 dlOut);
}

interface IWNATIVELib is IERC20 {
    function deposit() external payable;
}

interface IDLBurnLib {
    function burn(uint256 amount) external;
}

library DealLib {
    using SafeERC20 for IERC20;
    uint32 private constant DL_TO_DL_FEE_NUM = 1;
    uint32 private constant DL_TO_DL_FEE_DEN = 1000;

    struct ProcessDealFeesParams {
        address NATIVE;
        address factory;
        address dl;
        address treasury;
        address WNATIVE;
        address recognizedToken0;
        address recognizedToken1;
        uint256 aSwapAmount;
        address aTokenNorm;
        uint256 bSwapAmount;
        address bTokenNorm;
        address aSwapToken;
        address bSwapToken;
        address aPair;
        address bPair;
        uint256 aFee;
        uint256 bFee;
        address infoNft;
        address partyA;
        address partyB;
        bool aNftLocked;
        uint256 aNftId;
        bool bNftLocked;
        uint256 bNftId;
    }

    struct ComputeDealRewardsParams {
        uint32 mintOnFeesNum;
        uint32 mintOnFeesDen;
        uint256 aSwapAmount;
        address aTokenNorm;
        address aSwapToken;
        address aPair;
        uint256 bSwapAmount;
        address bTokenNorm;
        address bSwapToken;
        address bPair;
        address dl;
        address WNATIVE;
        address recognizedToken0;
        address recognizedToken1;
        address factory;
        address infoNft;
        address partyA;
        address partyB;
        bool aNftLocked;
        uint256 aNftId;
        bool bNftLocked;
        uint256 bNftId;
    }

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

    function feeCreditU(
        address tokenNorm,
        uint256 fee,
        address recognizedToken0,
        address recognizedToken1
    ) external view returns (uint256) {
        if (fee == 0) return 0;
        if (tokenNorm != recognizedToken0 && tokenNorm != recognizedToken1) return 0;
        uint8 dec = _tokenDecimals(tokenNorm);
        if (dec == 18) return fee;
        if (dec < 18) return fee * (10 ** (18 - dec));
        if (dec <= 36) return fee / (10 ** (dec - 18));
        return 0;
    }

    function _tokenDecimals(address token) private view returns (uint8) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (ok && data.length >= 32) {
            uint256 d = abi.decode(data, (uint256));
            if (d <= type(uint8).max) return uint8(d);
        }
        return 18;
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
        address factory_,
        address infoNft,
        address partyA,
        address partyB,
        bool aNftLocked,
        uint256 aNftId,
        bool bNftLocked,
        uint256 bNftId
    ) external view returns (uint256 cToken, address cAddr) {
        return _resolveCRewardTargetView(factory_, infoNft, partyA, partyB, aNftLocked, aNftId, bNftLocked, bNftId);
    }

    function _resolveCRewardTargetView(
        address factory_,
        address infoNft,
        address partyA,
        address partyB,
        bool aNftLocked,
        uint256 aNftId,
        bool bNftLocked,
        uint256 bNftId
    ) internal view returns (uint256 cToken, address cAddr) {
        if (infoNft == address(0)) return (0, address(0));
        bool hasA = aNftLocked && aNftId != 0 && IDealInfoNFTView(infoNft).ownerOf(aNftId) == partyA;
        bool hasB = bNftLocked && bNftId != 0 && IDealInfoNFTView(infoNft).ownerOf(bNftId) == partyB;
        address graph = _creditGraphOf(factory_);
        if (graph != address(0)) {
            return IDealCreditGraphView(graph).resolveCRewardTarget(partyA, partyB, aNftId, hasA, bNftId, hasB);
        }
        cToken = _selectC(infoNft, hasA, hasB, aNftId, bNftId);
        if (cToken != 0) cAddr = IDealInfoNFTView(infoNft).ownerOf(cToken);
    }

    function _creditGraphOf(address factory_) private view returns (address graph) {
        if (factory_ == address(0)) return address(0);
        try IFactoryCreditGraphView(factory_).creditGraph() returns (address g) {
            return g;
        } catch {
            return address(0);
        }
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
        if (_creditGraphOf(factory_) != address(0)) return;
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

    /* ---------- 手续费 / 入池 / 奖励 / TWAP（Deal 与 DealOpenTokenToken 共用） ---------- */

    function _quoteAggToDLImpl(address factory_, address dl, address token, address pair, uint256 amountIn)
        private
        returns (uint256 dlOut)
    {
        if (amountIn == 0) return 0;
        if (token == dl) return amountIn;
        if (pair == address(0)) return 0;
        try IFactoryTwapLib(factory_).updateAndQuoteToDL(pair, amountIn) returns (uint256 x) {
            return x;
        } catch {
            return 0;
        }
    }

    function quoteAggToDL(address factory_, address dl, address token, address pair, uint256 amountIn)
        external
        returns (uint256 dlOut)
    {
        return _quoteAggToDLImpl(factory_, dl, token, pair, amountIn);
    }

    function _handleDlToDlFees(
        address factory_,
        address dl,
        address infoNft,
        address partyA,
        address partyB,
        bool aNftLocked,
        uint256 aNftId,
        bool bNftLocked,
        uint256 bNftId,
        uint256 fee
    ) private {
        if (fee == 0) return;
        (uint256 cToken, address cAddr) =
            _resolveCRewardTargetView(factory_, infoNft, partyA, partyB, aNftLocked, aNftId, bNftLocked, bNftId);
        if (cToken != 0 && cAddr != address(0)) {
            IERC20(dl).safeTransfer(cAddr, fee);
        } else {
            IDLBurnLib(dl).burn(fee);
        }
    }

    function _handleOneSideFees(
        address NATIVE,
        address treasury_,
        address WNATIVE_,
        address recognizedToken0,
        address recognizedToken1,
        address token,
        address tokenNorm,
        address pair,
        uint256 fee
    ) private {
        if (fee == 0) return;
        if (_isRecognizedToken(tokenNorm, WNATIVE_, recognizedToken0, recognizedToken1) && pair != address(0)) {
            if (token == NATIVE) {
                IWNATIVELib(WNATIVE_).deposit{value: fee}();
                IERC20(WNATIVE_).safeTransfer(pair, fee);
            } else {
                IERC20(tokenNorm).safeTransfer(pair, fee);
            }
            (bool okPair, bytes memory data) = pair.call(abi.encodeWithSignature("mintOtherOnly()"));
            if (!(okPair && (data.length == 32 || data.length == 0))) revert DealError(34);
            return;
        }
        if (treasury_ == address(0)) revert DealError(53);
        if (token == NATIVE) {
            (bool ok,) = payable(treasury_).call{value: fee}("");
            if (!ok) revert DealError(35);
        } else IERC20(tokenNorm).safeTransfer(treasury_, fee);
    }

    function _processDealFeesImpl(ProcessDealFeesParams calldata p) private {
        if (p.aSwapAmount > 0 && p.aTokenNorm == p.dl && p.bSwapAmount > 0 && p.bTokenNorm == p.dl) {
            _handleDlToDlFees(
                p.factory,
                p.dl,
                p.infoNft,
                p.partyA,
                p.partyB,
                p.aNftLocked,
                p.aNftId,
                p.bNftLocked,
                p.bNftId,
                p.aFee + p.bFee
            );
            return;
        }
        _handleOneSideFees(
            p.NATIVE,
            p.treasury,
            p.WNATIVE,
            p.recognizedToken0,
            p.recognizedToken1,
            p.aSwapToken,
            p.aTokenNorm,
            p.aPair,
            p.aFee
        );
        _handleOneSideFees(
            p.NATIVE,
            p.treasury,
            p.WNATIVE,
            p.recognizedToken0,
            p.recognizedToken1,
            p.bSwapToken,
            p.bTokenNorm,
            p.bPair,
            p.bFee
        );
    }

    function processDealFees(ProcessDealFeesParams calldata p) external {
        _processDealFeesImpl(p);
    }

    function _rewardFromRecognizedSide(
        address factory_,
        address dl,
        address WNATIVE_,
        address recognizedToken0,
        address recognizedToken1,
        uint32 mintOnFeesNum,
        uint32 mintOnFeesDen,
        address token,
        address tokenNorm,
        address pair,
        uint256 amount
    ) private returns (uint256 dlOut) {
        if (amount == 0) return 0;
        if (!_isRecognizedToken(tokenNorm, WNATIVE_, recognizedToken0, recognizedToken1)) return 0;
        uint256 rewardBasis = (amount * mintOnFeesNum) / mintOnFeesDen;
        return _quoteAggToDLImpl(factory_, dl, token, pair, rewardBasis);
    }

    function _dealRewardFromRecognizedSideA(ComputeDealRewardsParams calldata p) private returns (uint256) {
        return _rewardFromRecognizedSide(
            p.factory,
            p.dl,
            p.WNATIVE,
            p.recognizedToken0,
            p.recognizedToken1,
            p.mintOnFeesNum,
            p.mintOnFeesDen,
            p.aSwapToken,
            p.aTokenNorm,
            p.aPair,
            p.aSwapAmount
        );
    }

    function _dealRewardFromRecognizedSideB(ComputeDealRewardsParams calldata p) private returns (uint256) {
        return _rewardFromRecognizedSide(
            p.factory,
            p.dl,
            p.WNATIVE,
            p.recognizedToken0,
            p.recognizedToken1,
            p.mintOnFeesNum,
            p.mintOnFeesDen,
            p.bSwapToken,
            p.bTokenNorm,
            p.bPair,
            p.bSwapAmount
        );
    }

    function _computeDealRewardsFinalize(ComputeDealRewardsParams calldata p)
        private
        returns (uint256 toA, uint256 toB, uint256 toC, address cAddr, uint256 cToken)
    {
        (cToken, cAddr) = _resolveCRewardTargetView(
            p.factory, p.infoNft, p.partyA, p.partyB, p.aNftLocked, p.aNftId, p.bNftLocked, p.bNftId
        );
        uint256 perRoleA = _dealRewardFromRecognizedSideA(p);
        uint256 perRoleB = _dealRewardFromRecognizedSideB(p);
        uint256 perRole = perRoleA + perRoleB;
        if (perRole == 0) return (0, 0, 0, address(0), 0);

        toA = perRole;
        toB = perRole;
        if (cToken != 0) {
            toC = perRole;
        }
    }

    function _computeDealRewardsImpl(ComputeDealRewardsParams calldata p)
        private
        returns (uint256 toA, uint256 toB, uint256 toC, address cAddr, uint256 cToken)
    {
        if (p.mintOnFeesNum == 0) return (0, 0, 0, address(0), 0);

        bool aHasSwap = p.aSwapAmount > 0;
        bool bHasSwap = p.bSwapAmount > 0;

        if (
            (aHasSwap && !_isRecognizedOrDL(p.aTokenNorm, p.dl, p.WNATIVE, p.recognizedToken0, p.recognizedToken1))
                || (bHasSwap
                    && !_isRecognizedOrDL(p.bTokenNorm, p.dl, p.WNATIVE, p.recognizedToken0, p.recognizedToken1))
        ) {
            return (0, 0, 0, address(0), 0);
        }

        if (aHasSwap && p.aTokenNorm == p.dl && bHasSwap && p.bTokenNorm == p.dl) {
            return (0, 0, 0, address(0), 0);
        }

        return _computeDealRewardsFinalize(p);
    }

    function computeDealRewards(ComputeDealRewardsParams calldata p)
        external
        returns (uint256 toA, uint256 toB, uint256 toC, address cAddr, uint256 cToken)
    {
        return _computeDealRewardsImpl(p);
    }

    function _isRecognizedOrDL(
        address tokenNorm,
        address dl_,
        address WNATIVE_,
        address recognizedToken0,
        address recognizedToken1
    ) private pure returns (bool) {
        return tokenNorm == dl_
            || _isRecognizedToken(tokenNorm, WNATIVE_, recognizedToken0, recognizedToken1);
    }
}
