// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IDealPair {
    function token0() external view returns (address); // DL
    function token1() external view returns (address); // OTHER / WNATIVE
    function getReserves() external view returns (uint112 r0, uint112 r1, uint32 ts);
    function getVirtualReserves() external view returns (uint256 v0, uint256 v1);
    function getEffectiveReserves() external view returns (uint256 e0, uint256 e1, uint32 ts);
    function swap(uint256 amount0OutGross, uint256 amount1OutGross, address to) external;

    // Pair 的 5 个报价视图
    function quoteBuyGivenGross(uint256 amount0OutGross)
        external view returns (uint256 in1Min, uint256 feeOut, uint256 out0Net);
    function quoteBuyGivenNet(uint256 out0NetTarget)
        external view returns (uint256 grossMin, uint256 feeOut, uint256 in1Min);
    function quoteBuyGivenIn1(uint256 amount1In)
        external view returns (uint256 grossMax, uint256 feeOut, uint256 out0Net);
    function quoteSell(uint256 amount0In)
        external view returns (uint256 feeIn, uint256 out1);
    function quoteSellGivenOut1(uint256 out1Target)
        external view returns (uint256 in0Min, uint256 feeIn, uint256 /*in0EffMin*/);
}
