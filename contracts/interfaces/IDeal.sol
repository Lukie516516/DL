// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IDeal {
    enum TemplateType {
        TokenToToken,
        TokenToNft,
        TokenToEmpty,
        EmptyToEmpty,
        NftToEmpty
    }

    struct InitParams {
        // 四个数字
        address aSwapToken;   uint256 aSwapAmount;
        address aMarginToken; uint256 aMarginAmount;
        address bSwapToken;   uint256 bSwapAmount;
        address bMarginToken; uint256 bMarginAmount;
        address aAssetNft;
        uint256 aAssetNftId;
        address bAssetNft;
        uint256 bAssetNftId;

        // 业务模板
        uint8   templateType; // 0=TokenToToken,1=TokenToNft,2=TokenToEmpty,3=EmptyToEmpty,4=NftToEmpty

        // 进入模式
        uint8   joinMode;     // 0=Open,1=ExactAddress,2=NftGated,3=ExactAddressAndNftGated
        address expectedB;

        // NFT 门禁（NftGated 用）
        address gateNft;      uint256 gateNftId;

        // A 可选 NFT（若非零：本次 A 要质押）
        address aNft;         uint256 aNftId;

        // 基础信息
        string  title;
        string  description;
        uint64  timeoutSeconds;  // 工厂已保证 ≥ 最小值
        uint64  timeStart;
        uint64  timeEnd;
        string  memo;
    }

    function initialize(
        address factory,
        address initiator,
        address liquidityHook,
        InitParams calldata p
    ) external;
}
