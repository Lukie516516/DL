// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./interfaces/IDealPair.sol";

interface IDealSwapOrderBookQuote {
    function maxImmediateSellIn(address pair) external view returns (uint256);
    function maxImmediateBuyIn(address pair) external view returns (uint256);
}

/// @notice Read-only quote helpers for DealRouter. Kept outside the router so swap bytecode stays small.
contract DealRouterQuoter {
    address public immutable ORDER_BOOK;

    struct PreviewExactIn {
        uint256 immediateIn;
        uint256 immediateOut;
        uint256 queuedIn;
        bool fullyImmediate;
    }

    struct PreviewExactOut {
        bool fullyImmediate;
        uint256 immediateOutCap;
        uint256 queuedOut;
        uint256 requiredInForTarget;
        uint256 requiredInForImmediateCap;
    }

    constructor(address orderBook_) {
        ORDER_BOOK = orderBook_;
    }

    function previewExact0For1(address pair, uint256 amount0In)
        external
        view
        returns (PreviewExactIn memory p)
    {
        uint256 cap = _maxImmediateSellIn(pair);
        p.immediateIn = amount0In < cap ? amount0In : cap;
        if (p.immediateIn > 0) {
            if (amount0In > cap) {
                (, uint112 reserve1_, ) = IDealPair(pair).getReserves();
                if (reserve1_ > 1) p.immediateOut = uint256(reserve1_) - 1;
            } else {
                (, p.immediateOut) = IDealPair(pair).quoteSell(p.immediateIn);
            }
        }
        p.queuedIn = amount0In - p.immediateIn;
        p.fullyImmediate = p.queuedIn == 0;
    }

    function previewExact1For0(address pair, uint256 amount1In)
        external
        view
        returns (PreviewExactIn memory p)
    {
        uint256 cap = _maxImmediateBuyIn(pair);
        p.immediateIn = amount1In < cap ? amount1In : cap;
        if (p.immediateIn > 0) {
            if (amount1In > cap) {
                (uint112 reserve0_, , ) = IDealPair(pair).getReserves();
                if (reserve0_ > 1) {
                    (, , p.immediateOut) = IDealPair(pair).quoteBuyGivenGross(uint256(reserve0_) - 1);
                }
            } else {
                (, , p.immediateOut) = IDealPair(pair).quoteBuyGivenIn1(p.immediateIn);
            }
        }
        p.queuedIn = amount1In - p.immediateIn;
        p.fullyImmediate = p.queuedIn == 0;
    }

    function preview0ForExact1(address pair, uint256 out1Target)
        external
        view
        returns (PreviewExactOut memory p)
    {
        p.immediateOutCap = _maxImmediateSellOut(pair);
        p.fullyImmediate = out1Target <= p.immediateOutCap;
        p.queuedOut = p.fullyImmediate ? 0 : out1Target - p.immediateOutCap;
        if (p.fullyImmediate && out1Target > 0) {
            (p.requiredInForTarget,,) = IDealPair(pair).quoteSellGivenOut1(out1Target);
        }
        if (p.immediateOutCap > 0) {
            (p.requiredInForImmediateCap,,) = IDealPair(pair).quoteSellGivenOut1(p.immediateOutCap);
        }
    }

    function preview1ForExact0Net(address pair, uint256 out0NetTarget)
        external
        view
        returns (PreviewExactOut memory p)
    {
        uint256 grossCap = _maxImmediateBuyGrossOut(pair);
        if (grossCap > 0) {
            (p.requiredInForImmediateCap, , p.immediateOutCap) = IDealPair(pair).quoteBuyGivenGross(grossCap);
        }
        p.fullyImmediate = out0NetTarget <= p.immediateOutCap;
        p.queuedOut = p.fullyImmediate ? 0 : out0NetTarget - p.immediateOutCap;
        if (p.fullyImmediate && out0NetTarget > 0) {
            (, , p.requiredInForTarget) = IDealPair(pair).quoteBuyGivenNet(out0NetTarget);
        }
    }

    function _maxImmediateSellIn(address pair) internal view returns (uint256 cap) {
        if (ORDER_BOOK != address(0)) {
            return IDealSwapOrderBookQuote(ORDER_BOOK).maxImmediateSellIn(pair);
        }
        (, uint112 reserve1,) = IDealPair(pair).getReserves();
        if (reserve1 <= 1) return 0;
        (cap,,) = IDealPair(pair).quoteSellGivenOut1(uint256(reserve1) - 1);
    }

    function _maxImmediateBuyIn(address pair) internal view returns (uint256 cap) {
        if (ORDER_BOOK != address(0)) {
            return IDealSwapOrderBookQuote(ORDER_BOOK).maxImmediateBuyIn(pair);
        }
        (uint112 reserve0,,) = IDealPair(pair).getReserves();
        if (reserve0 <= 1) return 0;
        (cap,,) = IDealPair(pair).quoteBuyGivenGross(uint256(reserve0) - 1);
    }

    function _maxImmediateSellOut(address pair) internal view returns (uint256) {
        (, uint112 reserve1,) = IDealPair(pair).getReserves();
        return reserve1 <= 1 ? 0 : uint256(reserve1) - 1;
    }

    function _maxImmediateBuyGrossOut(address pair) internal view returns (uint256) {
        (uint112 reserve0,,) = IDealPair(pair).getReserves();
        return reserve0 <= 1 ? 0 : uint256(reserve0) - 1;
    }
}
