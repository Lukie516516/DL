// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*
  DealRouter — 对齐 DealSwapTemplate (Pair)
  - 支持 ERC20 与 原生币 via WNATIVE
  - 所有 swap 均带 deadline + minOut / maxIn
  - 报价→成交：先转入→按“实际到帐”报价→再 swap（抗扣税 OTHER）
  - 覆盖：单跳 / 双跳（A↔DC↔B）/ ETH 便捷双跳（四条路径已对称齐全）
*/

import "./interfaces/IDealPair.sol";
import "./interfaces/IERC20.sol";
import "./utils/SafeTransfer.sol";
import "./utils/ReentrancyGuard.sol";

interface IWNative is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IDealSwapOrderBookHook {
    function maxImmediateSellIn(address pair) external view returns (uint256);
    function maxImmediateBuyIn(address pair) external view returns (uint256);
    function enqueueSellDLFromRouter(address pair, address owner, uint256 amount0In, bool unwrapNativeOut) external returns (uint256);
    function enqueueBuyDLFromRouter(address pair, address owner, uint256 amount1In, bool refundNativeIn) external returns (uint256);
    function settlePair(address pair, uint256 maxBuyOrders, uint256 maxSellOrders) external;
}

contract DealRouter is ReentrancyGuard {
    using SafeTransfer for IERC20;

    /* ---------------- config ---------------- */
    address public immutable WNATIVE;
    address public immutable ORDER_BOOK;
    constructor(address _wNative, address _orderBook) {
        require(_wNative != address(0), "ZERO_WNATIVE");
        WNATIVE = _wNative;
        ORDER_BOOK = _orderBook;
    }
    receive() external payable { require(msg.sender == WNATIVE, "ETH_NOT_ALLOWED"); }

    /* ---------------- events ---------------- */
    // —— 单跳 —— //
    event SwapExact1For0(address indexed pair, address indexed sender, uint256 in1, uint256 out0Net, uint256 out0Gross, uint256 feeOut, address indexed to);
    event Swap1ForExact0Net(address indexed pair, address indexed sender, uint256 in1Used, uint256 out0Net, uint256 out0Gross, uint256 feeOut, address indexed to);
    event SwapExact0For1(address indexed pair, address indexed sender, uint256 in0, uint256 out1, uint256 feeIn, address indexed to);
    event Swap0ForExact1(address indexed pair, address indexed sender, uint256 in0Used, uint256 out1Target, uint256 feeIn, address indexed to);

    // —— 单跳（ETH/BNB via WNATIVE） —— //
    event SwapExactETHFor0(address indexed pair, address indexed sender, uint256 ethIn, uint256 out0Net, uint256 out0Gross, uint256 feeOut, address indexed to);
    event SwapETHForExact0Net(address indexed pair, address indexed sender, uint256 ethUsed, uint256 out0Net, uint256 out0Gross, uint256 feeOut, uint256 ethRefund, address indexed to);
    event SwapExact0ForETH(address indexed pair, address indexed sender, uint256 in0, uint256 ethOut, uint256 feeIn, address indexed to);
    event Swap0ForExactETH(address indexed pair, address indexed sender, uint256 in0Used, uint256 ethOutTarget, uint256 feeIn, address indexed to);

    // —— 双跳（A ↔ DC ↔ B，ERC20） —— //
    event SwapExact1For1ViaDL(address indexed pairA, address indexed pairB, address indexed sender, uint256 inA, uint256 dlNet, uint256 outB, uint256 feeOutDL, uint256 feeInDL, address to);
    event Swap1ForExact1ViaDL(address indexed pairA, address indexed pairB, address indexed sender, uint256 inAUsed, uint256 dlRequired, uint256 outBTarget, uint256 feeOutDL, uint256 feeInDL, uint256 dlRefund, address to);

    // —— 双跳便捷（ETH ↔ DC ↔ ERC20） —— //
    event SwapExactETHFor1ViaDL(address indexed pairWNATIVE, address indexed pairB, address indexed sender, uint256 ethIn, uint256 dlNet, uint256 outB, uint256 feeOutDL, uint256 feeInDL, address to);
    event Swap1ForExactETHViaDL(address indexed pairA, address indexed pairWNATIVE, address indexed sender, uint256 inAUsed, uint256 dlRequired, uint256 outETHTarget, uint256 feeOutDL, uint256 feeInDL, uint256 dlRefund, address to);
    event SwapExact1ForETHViaDL(address indexed pairA, address indexed pairWNATIVE, address indexed sender, uint256 inA, uint256 dlNet, uint256 ethOut, uint256 feeOutDL, uint256 feeInDL, address to);
    event SwapETHForExact1ViaDL(address indexed pairWNATIVE, address indexed pairB, address indexed sender, uint256 ethUsed, uint256 dlRequired, uint256 outBTarget, uint256 feeOutDL, uint256 feeInDL, uint256 dlRefund, uint256 ethRefund, address to);
    event SwapQueuedRemainder(address indexed pair, address indexed sender, bool isSellDL, uint256 immediateIn, uint256 immediateOut, uint256 queuedIn, uint256 orderId);

    /* -------------- tiny structs（降栈） -------------- */
    struct QBuyNet   { uint256 gross; uint256 feeOut; uint256 in1Min; }
    struct QBuyIn1   { uint256 gross; uint256 feeOut; uint256 out0Net; }
    struct QSellIn0  { uint256 feeIn;  uint256 out1; }
    struct QSellOut1 { uint256 in0Min; uint256 feeIn; }

    struct ResSingle { // 用于外层发事件（单跳）
        uint256 inAmt;      // 实际到帐（in1 或 in0 或 ethUsed）
        uint256 outAmt;     // out0Net / out1 / ethOut
        uint256 outGross;   // out0Gross（买 DC 时）
        uint256 feeSide;    // feeOut or feeIn
        uint256 refund;     // ethRefund（仅 ETH exact-out 用）
    }
    struct ResDouble { // 用于外层发事件（双跳）
        uint256 inAUsed;
        uint256 dlNetOrReq; // dlNet 或 dlRequired
        uint256 outBOrETH;  // outB 或 outETHTarget
        uint256 feeOutDL;
        uint256 feeInDL;
        uint256 dlRefund;   // 仅 exact-out 路径会用
    }
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
    struct ResQueued {
        uint256 immediateIn;
        uint256 immediateOut;
        uint256 outGross;
        uint256 feeSide;
        uint256 queuedIn;
        uint256 orderId;
    }

    /* -------------- internal quote wrappers -------------- */
    function _qBuyNet(address pair, uint256 netDL) internal view returns (QBuyNet memory q) {
        (q.gross, q.feeOut, q.in1Min) = IDealPair(pair).quoteBuyGivenNet(netDL);
    }
    function _qBuyIn1(address pair, uint256 in1) internal view returns (QBuyIn1 memory q) {
        (q.gross, q.feeOut, q.out0Net) = IDealPair(pair).quoteBuyGivenIn1(in1);
    }
    function _qSellIn0(address pair, uint256 in0) internal view returns (QSellIn0 memory q) {
        (q.feeIn, q.out1) = IDealPair(pair).quoteSell(in0);
    }
    function _qSellOut1(address pair, uint256 out1) internal view returns (QSellOut1 memory q) {
        (q.in0Min, q.feeIn, ) = IDealPair(pair).quoteSellGivenOut1(out1);
    }

    /* -------------- internal IO helpers -------------- */
    function _balanceOf(address token, address a) internal view returns (uint256) {
        return IERC20(token).balanceOf(a);
    }
    function _pullToPairAndGetIn(address token, address pair, address from, uint256 amount) internal returns (uint256 actual) {
        uint256 b = _balanceOf(token, pair);
        IERC20(token).safeTransferFrom(from, pair, amount);
        unchecked { actual = _balanceOf(token, pair) - b; }
    }
    function _pullToSelfAndGetIn(address token, address from, uint256 amount) internal returns (uint256 actual) {
        uint256 b = _balanceOf(token, address(this));
        IERC20(token).safeTransferFrom(from, address(this), amount);
        unchecked { actual = _balanceOf(token, address(this)) - b; }
    }
    function _pushFromSelfToPairAndGetIn(address token, address pair, uint256 amount) internal returns (uint256 actual) {
        uint256 b = _balanceOf(token, pair);
        IERC20(token).safeTransfer(pair, amount);
        unchecked { actual = _balanceOf(token, pair) - b; }
    }
    function _pullToPairMin(address token, address pair, address from, uint256 minAmount, string memory err) internal {
        uint256 b = _balanceOf(token, pair);
        IERC20(token).safeTransferFrom(from, pair, minAmount);
        require(_balanceOf(token, pair) - b >= minAmount, string(abi.encodePacked(err)));
    }
    function _sendETH(address to, uint256 amt) internal {
        (bool ok, ) = to.call{value: amt}("");
        require(ok, "ETH_SEND_FAIL");
    }
    function _wrapToPair(address pair, uint256 ethAmount) internal {
        IWNative(WNATIVE).deposit{value: ethAmount}();
        IERC20(WNATIVE).safeTransfer(pair, ethAmount);
    }
    function _deadline(uint256 d) internal view { require(block.timestamp <= d, "EXPIRED"); }
    function _maybeSettle(address pair) internal {
        if (ORDER_BOOK != address(0)) {
            IDealSwapOrderBookHook(ORDER_BOOK).settlePair(pair, 1, 1);
        }
    }
    function _maxImmediateSellIn(address pair) internal view returns (uint256 cap) {
        if (ORDER_BOOK != address(0)) {
            return IDealSwapOrderBookHook(ORDER_BOOK).maxImmediateSellIn(pair);
        }
        (, uint112 reserve1,) = IDealPair(pair).getReserves();
        if (reserve1 <= 1) return 0;
        (cap,,) = IDealPair(pair).quoteSellGivenOut1(uint256(reserve1) - 1);
    }
    function _maxImmediateBuyIn(address pair) internal view returns (uint256 cap) {
        if (ORDER_BOOK != address(0)) {
            return IDealSwapOrderBookHook(ORDER_BOOK).maxImmediateBuyIn(pair);
        }
        (uint112 reserve0,,) = IDealPair(pair).getReserves();
        if (reserve0 <= 1) return 0;
        (cap,,) = IDealPair(pair).quoteBuyGivenGross(uint256(reserve0) - 1);
    }
    function _maxImmediateSellOut(address pair) internal view returns (uint256 capOut) {
        (, uint112 reserve1,) = IDealPair(pair).getReserves();
        if (reserve1 <= 1) return 0;
        return uint256(reserve1) - 1;
    }
    function _maxImmediateBuyGrossOut(address pair) internal view returns (uint256 capOut) {
        (uint112 reserve0,,) = IDealPair(pair).getReserves();
        if (reserve0 <= 1) return 0;
        return uint256(reserve0) - 1;
    }

    /* -------------- preview helpers -------------- */
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
                if (reserve1_ > 1) {
                    p.immediateOut = uint256(reserve1_) - 1;
                }
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

    /* ===================================================== *
     *                INTERNAL EXEC (单跳)                   *
     * ===================================================== */

    // DC net exact-out -> OTHER max-in
    function _exec1ForExact0Net(address pair, address from, address to, uint256 out0NetTarget, uint256 maxAmount1In)
        internal
        returns (ResSingle memory r)
    {
        QBuyNet memory q = _qBuyNet(pair, out0NetTarget);
        require(q.in1Min <= maxAmount1In, "MAX_IN_EXCEEDED");
        address t1 = IDealPair(pair).token1();
        _pullToPairMin(t1, pair, from, q.in1Min, "AFTER_TAX_LOW");
        IDealPair(pair).swap(q.gross, 0, to);
        r.inAmt   = q.in1Min;
        r.outAmt  = out0NetTarget;
        r.outGross= q.gross;
        r.feeSide = q.feeOut;
    }

    // OTHER exact-out -> DC max-in
    function _exec0ForExact1(address pair, address from, address to, uint256 out1Target, uint256 maxAmount0In)
        internal
        returns (ResSingle memory r)
    {
        QSellOut1 memory q = _qSellOut1(pair, out1Target);
        require(q.in0Min <= maxAmount0In, "MAX_IN_EXCEEDED");
        address t0 = IDealPair(pair).token0();
        _pullToPairMin(t0, pair, from, q.in0Min, "IN0_SHORT");
        IDealPair(pair).swap(0, out1Target, to);
        r.inAmt  = q.in0Min;
        r.outAmt = out1Target;
        r.feeSide= q.feeIn;
    }

    /* ============== INTERNAL EXEC（ETH 单跳） ============== */

    // DC net exact-out -> ETH max-in（退回多余 ETH）
    function _execETHForExact0Net(address pair, address to, uint256 out0NetTarget, uint256 ethMax)
        internal
        returns (ResSingle memory r)
    {
        require(IDealPair(pair).token1() == WNATIVE, "PAIR_NOT_WNATIVE");
        require(ethMax > 0, "ZERO_ETH");
        QBuyNet memory q = _qBuyNet(pair, out0NetTarget);
        require(q.in1Min <= ethMax, "ETH_NOT_ENOUGH");
        _wrapToPair(pair, q.in1Min);
        IDealPair(pair).swap(q.gross, 0, to);
        r.inAmt    = q.in1Min;
        r.outAmt   = out0NetTarget;
        r.outGross = q.gross;
        r.feeSide  = q.feeOut;
        r.refund   = ethMax - q.in1Min; // 由外层退回
    }

    // OTHER exact-out(ETH) -> DC max-in
    function _exec0ForExactETH(address pair, uint256 outETHTarget, address from, address to, uint256 maxAmount0In)
        internal
        returns (ResSingle memory r)
    {
        require(IDealPair(pair).token1() == WNATIVE, "PAIR_NOT_WNATIVE");
        QSellOut1 memory q = _qSellOut1(pair, outETHTarget);
        require(q.in0Min <= maxAmount0In, "MAX_IN_EXCEEDED");
        address t0 = IDealPair(pair).token0();
        _pullToPairMin(t0, pair, from, q.in0Min, "IN0_SHORT");
        IDealPair(pair).swap(0, outETHTarget, address(this)); // Router 收 WNATIVE
        IWNative(WNATIVE).withdraw(outETHTarget);
        _sendETH(to, outETHTarget);
        r.inAmt  = q.in0Min;
        r.outAmt = outETHTarget;
        r.feeSide= q.feeIn;
    }

    /* ===================================================== *
     *              INTERNAL EXEC (双跳 & 便捷)              *
     * ===================================================== */

    // A exact-in -> B min-out（A/DC = pairA, DC/B = pairB）
    function _execExact1For1ViaDL(address pairA, address pairB, address from, address to, uint256 amountAIn, uint256 minOutB)
        internal
        returns (ResDouble memory r)
    {
        require(IDealPair(pairA).token0() == IDealPair(pairB).token0(), "DL_MISMATCH");
        address tokenA = IDealPair(pairA).token1();

        // 跳1：A->DC（Router 收 DC）
        uint256 inA = _pullToPairAndGetIn(tokenA, pairA, from, amountAIn);
        require(inA > 0, "NO_IN_A");
        QBuyIn1 memory q1 = _qBuyIn1(pairA, inA);
        IDealPair(pairA).swap(q1.gross, 0, address(this));
        r.inAUsed     = inA;
        r.dlNetOrReq  = q1.out0Net;
        r.feeOutDL    = q1.feeOut;

        // 跳2：DC->B（用户收 B）
        QSellIn0 memory q2 = _qSellIn0(pairB, r.dlNetOrReq);
        require(q2.out1 >= minOutB, "SLIPPAGE_B");
        IERC20(IDealPair(pairA).token0()).safeTransfer(pairB, r.dlNetOrReq);
        IDealPair(pairB).swap(0, q2.out1, to);
        r.outBOrETH = q2.out1;
        r.feeInDL   = q2.feeIn;
    }

    // B exact-out -> A max-in（多余 DC 退回）
    function _exec1ForExact1ViaDL(address pairA, address pairB, address from, address to, uint256 outBTarget, uint256 maxAmountAIn)
        internal
        returns (ResDouble memory r)
    {
        require(IDealPair(pairA).token0() == IDealPair(pairB).token0(), "DL_MISMATCH");

        // 第二跳需求：为 outBTarget 需要的 DC
        QSellOut1 memory s = _qSellOut1(pairB, outBTarget);
        r.dlNetOrReq = s.in0Min; // required DC
        r.feeInDL    = s.feeIn;

        // 第一跳需求：为 dlRequired 需要的 A
        QBuyNet memory b = _qBuyNet(pairA, r.dlNetOrReq);
        require(b.in1Min <= maxAmountAIn, "MAX_IN_EXCEEDED_A");

        // 跳1：A->DC（Router 收 DC）
        address tokenA = IDealPair(pairA).token1();
        _pullToPairMin(tokenA, pairA, from, b.in1Min, "AFTER_TAX_A_LOW");
        IDealPair(pairA).swap(b.gross, 0, address(this));
        r.inAUsed  = b.in1Min;
        r.feeOutDL = b.feeOut;

        // 跳2：DC->B（exact-out），退回多余 DC
        address dl = IDealPair(pairA).token0();
        uint256 dlBal = IERC20(dl).balanceOf(address(this));
        require(dlBal >= r.dlNetOrReq, "DL_NOT_ENOUGH");
        IERC20(dl).safeTransfer(pairB, r.dlNetOrReq);
        IDealPair(pairB).swap(0, outBTarget, to);
        r.outBOrETH = outBTarget;
        r.dlRefund  = dlBal - r.dlNetOrReq;
        if (r.dlRefund > 0) IERC20(dl).safeTransfer(from, r.dlRefund);
    }

    // ETH exact-in -> DC -> B min-out（pairWNATIVE=DC/WNATIVE）
    function _execExactETHFor1ViaDL(address pairWNATIVE, address pairB, address to, uint256 ethIn, uint256 minOutB)
        internal
        returns (ResDouble memory r)
    {
        require(IDealPair(pairWNATIVE).token1() == WNATIVE, "PAIR_NOT_WNATIVE");
        require(IDealPair(pairWNATIVE).token0() == IDealPair(pairB).token0(), "DL_MISMATCH");
        require(ethIn > 0, "ZERO_ETH");

        // 跳1：ETH->DC（Router 收 DC）
        _wrapToPair(pairWNATIVE, ethIn);
        QBuyIn1 memory q1 = _qBuyIn1(pairWNATIVE, ethIn);
        IDealPair(pairWNATIVE).swap(q1.gross, 0, address(this));
        r.inAUsed     = ethIn;      // 这里“inAUsed”表示 ETH 输入
        r.dlNetOrReq  = q1.out0Net; // dlNet
        r.feeOutDL    = q1.feeOut;

        // 跳2：DC->B（用户收 B）
        QSellIn0 memory q2 = _qSellIn0(pairB, r.dlNetOrReq);
        require(q2.out1 >= minOutB, "SLIPPAGE_B");
        IERC20(IDealPair(pairB).token0()).safeTransfer(pairB, r.dlNetOrReq);
        IDealPair(pairB).swap(0, q2.out1, to);
        r.outBOrETH = q2.out1;
        r.feeInDL   = q2.feeIn;
    }

    // B exact-out -> DC -> ETH max-in（多余 DC 退回；ETH 由 Router 解包转出）
    function _exec1ForExactETHViaDL(address pairA, address pairWNATIVE, address from, address to, uint256 outETHTarget, uint256 maxAmountAIn)
        internal
        returns (ResDouble memory r)
    {
        require(IDealPair(pairWNATIVE).token1() == WNATIVE, "PAIR_NOT_WNATIVE");
        require(IDealPair(pairA).token0() == IDealPair(pairWNATIVE).token0(), "DL_MISMATCH");

        // 第二跳：为 outETHTarget 需要的 DC
        QSellOut1 memory s = _qSellOut1(pairWNATIVE, outETHTarget);
        r.dlNetOrReq = s.in0Min; // required DC
        r.feeInDL    = s.feeIn;

        // 第一跳：为 dlRequired 需要的 A
        QBuyNet memory b = _qBuyNet(pairA, r.dlNetOrReq);
        require(b.in1Min <= maxAmountAIn, "MAX_IN_EXCEEDED_A");

        // 跳1：A->DC（Router 收 DC）
        address tokenA = IDealPair(pairA).token1();
        _pullToPairMin(tokenA, pairA, from, b.in1Min, "AFTER_TAX_A_LOW");
        IDealPair(pairA).swap(b.gross, 0, address(this));
        r.inAUsed  = b.in1Min;
        r.feeOutDL = b.feeOut;

        // 跳2：DC->WNATIVE->ETH
        address dl = IDealPair(pairA).token0();
        uint256 dlBal = IERC20(dl).balanceOf(address(this));
        require(dlBal >= r.dlNetOrReq, "DL_NOT_ENOUGH");
        IERC20(dl).safeTransfer(pairWNATIVE, r.dlNetOrReq);
        IDealPair(pairWNATIVE).swap(0, outETHTarget, address(this));
        IWNative(WNATIVE).withdraw(outETHTarget);
        _sendETH(to, outETHTarget);
        r.outBOrETH = outETHTarget;

        // 退回多余 DC
        r.dlRefund = dlBal - r.dlNetOrReq;
        if (r.dlRefund > 0) IERC20(dl).safeTransfer(from, r.dlRefund);
    }

    // ====== B exact-in -> ETH min-out（pairA=A/DC，pairWNATIVE=DC/WNATIVE） ====== //
    function _execExact1ForETHViaDL(address pairA, address pairWNATIVE, address from, address to, uint256 amountAIn, uint256 minOutETH)
        internal
        returns (ResDouble memory r)
    {
        require(IDealPair(pairWNATIVE).token1() == WNATIVE, "PAIR_NOT_WNATIVE");
        require(IDealPair(pairA).token0() == IDealPair(pairWNATIVE).token0(), "DL_MISMATCH");

        // 跳1：A -> DC（Router 收 DC）
        address tokenA = IDealPair(pairA).token1();
        uint256 inA = _pullToPairAndGetIn(tokenA, pairA, from, amountAIn);
        require(inA > 0, "NO_IN_A");
        QBuyIn1 memory q1 = _qBuyIn1(pairA, inA);
        IDealPair(pairA).swap(q1.gross, 0, address(this));
        r.inAUsed    = inA;
        r.dlNetOrReq = q1.out0Net;
        r.feeOutDL   = q1.feeOut;

        // 跳2：DC -> WNATIVE -> ETH（用户收 ETH）
        QSellIn0 memory q2 = _qSellIn0(pairWNATIVE, r.dlNetOrReq);
        require(q2.out1 >= minOutETH, "SLIPPAGE_ETH");
        IERC20(IDealPair(pairA).token0()).safeTransfer(pairWNATIVE, r.dlNetOrReq);
        IDealPair(pairWNATIVE).swap(0, q2.out1, address(this));
        IWNative(WNATIVE).withdraw(q2.out1);
        _sendETH(to, q2.out1);

        r.outBOrETH = q2.out1;
        r.feeInDL   = q2.feeIn;
    }

    // ====== ETH max-in -> B exact-out（pairWNATIVE=DC/WNATIVE，pairB=DC/B） ====== //
    function _execETHForExact1ViaDL(address pairWNATIVE, address pairB, address from, address to, uint256 outBTarget, uint256 ethMax)
        internal
        returns (ResDouble memory r)
    {
        require(IDealPair(pairWNATIVE).token1() == WNATIVE, "PAIR_NOT_WNATIVE");
        require(IDealPair(pairWNATIVE).token0() == IDealPair(pairB).token0(), "DL_MISMATCH");
        require(ethMax > 0, "ZERO_ETH");

        // 第二跳需求：为 outBTarget 需要的 DC
        QSellOut1 memory s = _qSellOut1(pairB, outBTarget);
        r.dlNetOrReq = s.in0Min; // required DC
        r.feeInDL    = s.feeIn;

        // 第一跳：ETH -> DC（只换入所需 ETH）
        QBuyNet memory b = _qBuyNet(pairWNATIVE, r.dlNetOrReq);
        require(b.in1Min <= ethMax, "ETH_NOT_ENOUGH");
        _wrapToPair(pairWNATIVE, b.in1Min);
        IDealPair(pairWNATIVE).swap(b.gross, 0, address(this));
        r.inAUsed  = b.in1Min; // 实际用掉 ETH
        r.feeOutDL = b.feeOut;

        // 跳2：DC -> B（exact-out），退回多余 DC
        address dl = IDealPair(pairB).token0();
        uint256 dlBal = IERC20(dl).balanceOf(address(this));
        require(dlBal >= r.dlNetOrReq, "DL_NOT_ENOUGH");
        IERC20(dl).safeTransfer(pairB, r.dlNetOrReq);
        IDealPair(pairB).swap(0, outBTarget, to);
        r.outBOrETH = outBTarget;

        r.dlRefund = dlBal - r.dlNetOrReq;
        if (r.dlRefund > 0) IERC20(dl).safeTransfer(from, r.dlRefund);
    }

    function _execExact0For1Hybrid(address pair, uint256 amount0In, address from, address to, uint256 minImmediateOut1)
        internal
        returns (ResQueued memory r)
    {
        require(ORDER_BOOK != address(0), "NO_ORDER_BOOK");
        address token0 = IDealPair(pair).token0();
        uint256 actualIn = _pullToSelfAndGetIn(token0, from, amount0In);
        require(actualIn > 0, "NO_IN");

        uint256 cap = IDealSwapOrderBookHook(ORDER_BOOK).maxImmediateSellIn(pair);
        r.immediateIn = actualIn < cap ? actualIn : cap;
        if (r.immediateIn > 0) {
            if (actualIn > cap) {
                (, uint112 reserve1,) = IDealPair(pair).getReserves();
                uint256 outTarget = uint256(reserve1) - 1;
                (uint256 in0Min, uint256 feeIn,) = IDealPair(pair).quoteSellGivenOut1(outTarget);
                IERC20(token0).safeTransfer(pair, in0Min);
                IDealPair(pair).swap(0, outTarget, to);
                r.immediateIn = in0Min;
                r.immediateOut = outTarget;
                r.feeSide = feeIn;
            } else {
                QSellIn0 memory q = _qSellIn0(pair, r.immediateIn);
                IERC20(token0).safeTransfer(pair, r.immediateIn);
                IDealPair(pair).swap(0, q.out1, to);
                r.immediateOut = q.out1;
                r.feeSide = q.feeIn;
            }
        }
        require(r.immediateOut >= minImmediateOut1, "SLIPPAGE");

        r.queuedIn = actualIn - r.immediateIn;
        if (r.queuedIn > 0) {
            IERC20(token0).safeApprove(ORDER_BOOK, 0);
            IERC20(token0).safeApprove(ORDER_BOOK, r.queuedIn);
            r.orderId = IDealSwapOrderBookHook(ORDER_BOOK).enqueueSellDLFromRouter(pair, from, r.queuedIn, false);
        }
        _maybeSettle(pair);
    }

    function _execExact1For0Hybrid(address pair, uint256 amount1In, address from, address to, uint256 minImmediateOut0Net)
        internal
        returns (ResQueued memory r)
    {
        require(ORDER_BOOK != address(0), "NO_ORDER_BOOK");
        address token1 = IDealPair(pair).token1();
        uint256 actualIn = _pullToSelfAndGetIn(token1, from, amount1In);
        require(actualIn > 0, "NO_IN");

        uint256 cap = IDealSwapOrderBookHook(ORDER_BOOK).maxImmediateBuyIn(pair);
        r.immediateIn = actualIn < cap ? actualIn : cap;
        if (r.immediateIn > 0) {
            uint256 actualPairIn = _pushFromSelfToPairAndGetIn(token1, pair, r.immediateIn);
            if (actualPairIn > 0) {
                if (actualIn > cap && actualPairIn == r.immediateIn) {
                    (uint112 reserve0,,) = IDealPair(pair).getReserves();
                    uint256 grossTarget = uint256(reserve0) - 1;
                    (, uint256 feeOut, uint256 netOutTarget) = IDealPair(pair).quoteBuyGivenGross(grossTarget);
                    IDealPair(pair).swap(grossTarget, 0, to);
                    r.immediateOut = netOutTarget;
                    r.outGross = grossTarget;
                    r.feeSide = feeOut;
                } else {
                    QBuyIn1 memory q = _qBuyIn1(pair, actualPairIn);
                    IDealPair(pair).swap(q.gross, 0, to);
                    r.immediateOut = q.out0Net;
                    r.outGross = q.gross;
                    r.feeSide = q.feeOut;
                }
            }
        }
        require(r.immediateOut >= minImmediateOut0Net, "SLIPPAGE");

        r.queuedIn = actualIn - r.immediateIn;
        if (r.queuedIn > 0) {
            IERC20(token1).safeApprove(ORDER_BOOK, 0);
            IERC20(token1).safeApprove(ORDER_BOOK, r.queuedIn);
            r.orderId = IDealSwapOrderBookHook(ORDER_BOOK).enqueueBuyDLFromRouter(pair, from, r.queuedIn, false);
        }
        _maybeSettle(pair);
    }

    function _execExactETHFor0Hybrid(address pair, address to, uint256 ethIn, uint256 minImmediateOut0Net)
        internal
        returns (ResQueued memory r)
    {
        require(ORDER_BOOK != address(0), "NO_ORDER_BOOK");
        require(IDealPair(pair).token1() == WNATIVE, "PAIR_NOT_WNATIVE");
        require(ethIn > 0, "NO_IN");

        uint256 cap = IDealSwapOrderBookHook(ORDER_BOOK).maxImmediateBuyIn(pair);
        r.immediateIn = ethIn < cap ? ethIn : cap;
        if (r.immediateIn > 0) {
            if (ethIn > cap) {
                (uint112 reserve0,,) = IDealPair(pair).getReserves();
                uint256 grossTarget = uint256(reserve0) - 1;
                (uint256 in1Min, uint256 feeOut, uint256 netOutTarget) = IDealPair(pair).quoteBuyGivenGross(grossTarget);
                _wrapToPair(pair, in1Min);
                IDealPair(pair).swap(grossTarget, 0, to);
                r.immediateIn = in1Min;
                r.immediateOut = netOutTarget;
                r.outGross = grossTarget;
                r.feeSide = feeOut;
            } else {
                _wrapToPair(pair, r.immediateIn);
                QBuyIn1 memory q = _qBuyIn1(pair, r.immediateIn);
                IDealPair(pair).swap(q.gross, 0, to);
                r.immediateOut = q.out0Net;
                r.outGross = q.gross;
                r.feeSide = q.feeOut;
            }
        }
        require(r.immediateOut >= minImmediateOut0Net, "SLIPPAGE");

        r.queuedIn = ethIn - r.immediateIn;
        if (r.queuedIn > 0) {
            IWNative(WNATIVE).deposit{value: r.queuedIn}();
            IERC20(WNATIVE).safeApprove(ORDER_BOOK, 0);
            IERC20(WNATIVE).safeApprove(ORDER_BOOK, r.queuedIn);
            r.orderId = IDealSwapOrderBookHook(ORDER_BOOK).enqueueBuyDLFromRouter(pair, to, r.queuedIn, true);
        }
        _maybeSettle(pair);
    }

    function _execExact0ForETHHybrid(address pair, uint256 amount0In, address from, address to, uint256 minImmediateOutETH)
        internal
        returns (ResQueued memory r)
    {
        require(ORDER_BOOK != address(0), "NO_ORDER_BOOK");
        require(IDealPair(pair).token1() == WNATIVE, "PAIR_NOT_WNATIVE");
        address token0 = IDealPair(pair).token0();
        uint256 actualIn = _pullToSelfAndGetIn(token0, from, amount0In);
        require(actualIn > 0, "NO_IN");

        uint256 cap = IDealSwapOrderBookHook(ORDER_BOOK).maxImmediateSellIn(pair);
        r.immediateIn = actualIn < cap ? actualIn : cap;
        if (r.immediateIn > 0) {
            if (actualIn > cap) {
                (, uint112 reserve1,) = IDealPair(pair).getReserves();
                uint256 outTarget = uint256(reserve1) - 1;
                (uint256 in0Min, uint256 feeIn,) = IDealPair(pair).quoteSellGivenOut1(outTarget);
                IERC20(token0).safeTransfer(pair, in0Min);
                IDealPair(pair).swap(0, outTarget, address(this));
                IWNative(WNATIVE).withdraw(outTarget);
                _sendETH(to, outTarget);
                r.immediateIn = in0Min;
                r.immediateOut = outTarget;
                r.feeSide = feeIn;
            } else {
                QSellIn0 memory q = _qSellIn0(pair, r.immediateIn);
                IERC20(token0).safeTransfer(pair, r.immediateIn);
                IDealPair(pair).swap(0, q.out1, address(this));
                IWNative(WNATIVE).withdraw(q.out1);
                _sendETH(to, q.out1);
                r.immediateOut = q.out1;
                r.feeSide = q.feeIn;
            }
        }
        require(r.immediateOut >= minImmediateOutETH, "SLIPPAGE");

        r.queuedIn = actualIn - r.immediateIn;
        if (r.queuedIn > 0) {
            IERC20(token0).safeApprove(ORDER_BOOK, 0);
            IERC20(token0).safeApprove(ORDER_BOOK, r.queuedIn);
            r.orderId = IDealSwapOrderBookHook(ORDER_BOOK).enqueueSellDLFromRouter(pair, from, r.queuedIn, true);
        }
        _maybeSettle(pair);
    }

    /* ===================================================== *
     *                EXTERNAL / EMIT ONLY                   *
     * ===================================================== */

    // —— 单跳（ERC20） —— //
    function swapExact1For0(address pair, uint256 amount1In, uint256 minOut0Net, uint256 deadline) external nonReentrant {
        _deadline(deadline);
        ResQueued memory r = _execExact1For0Hybrid(pair, amount1In, msg.sender, msg.sender, minOut0Net);
        emit SwapExact1For0(pair, msg.sender, r.immediateIn, r.immediateOut, r.outGross, r.feeSide, msg.sender);
        if (r.queuedIn > 0) emit SwapQueuedRemainder(pair, msg.sender, false, r.immediateIn, r.immediateOut, r.queuedIn, r.orderId);
    }
    function swap1ForExact0Net(address pair, uint256 out0NetTarget, uint256 maxAmount1In, uint256 deadline) external nonReentrant {
        _deadline(deadline);
        ResSingle memory r = _exec1ForExact0Net(pair, msg.sender, msg.sender, out0NetTarget, maxAmount1In);
        _maybeSettle(pair);
        emit Swap1ForExact0Net(pair, msg.sender, r.inAmt, out0NetTarget, r.outGross, r.feeSide, msg.sender);
    }
    function swapExact0For1(address pair, uint256 amount0In, uint256 minOut1, uint256 deadline) external nonReentrant {
        _deadline(deadline);
        ResQueued memory r = _execExact0For1Hybrid(pair, amount0In, msg.sender, msg.sender, minOut1);
        emit SwapExact0For1(pair, msg.sender, r.immediateIn, r.immediateOut, r.feeSide, msg.sender);
        if (r.queuedIn > 0) emit SwapQueuedRemainder(pair, msg.sender, true, r.immediateIn, r.immediateOut, r.queuedIn, r.orderId);
    }
    function swap0ForExact1(address pair, uint256 out1Target, uint256 maxAmount0In, uint256 deadline) external nonReentrant {
        _deadline(deadline);
        ResSingle memory r = _exec0ForExact1(pair, msg.sender, msg.sender, out1Target, maxAmount0In);
        _maybeSettle(pair);
        emit Swap0ForExact1(pair, msg.sender, r.inAmt, out1Target, r.feeSide, msg.sender);
    }

    // —— 单跳（ETH/BNB via WNATIVE） —— //
    function swapExactETHFor0(address pair, uint256 minOut0Net, uint256 deadline) external payable nonReentrant {
        _deadline(deadline);
        uint256 ethIn = msg.value;
        ResQueued memory r = _execExactETHFor0Hybrid(pair, msg.sender, ethIn, minOut0Net);
        emit SwapExactETHFor0(pair, msg.sender, r.immediateIn, r.immediateOut, r.outGross, r.feeSide, msg.sender);
        if (r.queuedIn > 0) emit SwapQueuedRemainder(pair, msg.sender, false, r.immediateIn, r.immediateOut, r.queuedIn, r.orderId);
    }
    function swapETHForExact0Net(address pair, uint256 out0NetTarget, uint256 deadline) external payable nonReentrant {
        _deadline(deadline);
        uint256 ethMax = msg.value;
        ResSingle memory r = _execETHForExact0Net(pair, msg.sender, out0NetTarget, ethMax);
        if (r.refund > 0) _sendETH(msg.sender, r.refund);
        _maybeSettle(pair);
        emit SwapETHForExact0Net(pair, msg.sender, r.inAmt, out0NetTarget, r.outGross, r.feeSide, r.refund, msg.sender);
    }
    function swapExact0ForETH(address pair, uint256 amount0In, uint256 minOutETH, uint256 deadline) external nonReentrant {
        _deadline(deadline);
        ResQueued memory r = _execExact0ForETHHybrid(pair, amount0In, msg.sender, msg.sender, minOutETH);
        emit SwapExact0ForETH(pair, msg.sender, r.immediateIn, r.immediateOut, r.feeSide, msg.sender);
        if (r.queuedIn > 0) emit SwapQueuedRemainder(pair, msg.sender, true, r.immediateIn, r.immediateOut, r.queuedIn, r.orderId);
    }
    function swap0ForExactETH(address pair, uint256 outETHTarget, uint256 maxAmount0In, uint256 deadline) external nonReentrant {
        _deadline(deadline);
        ResSingle memory r = _exec0ForExactETH(pair, outETHTarget, msg.sender, msg.sender, maxAmount0In);
        _maybeSettle(pair);
        emit Swap0ForExactETH(pair, msg.sender, r.inAmt, outETHTarget, r.feeSide, msg.sender);
    }

    // —— 双跳（A ↔ DC ↔ B，ERC20） —— //
    function swapExact1For1ViaDL(address pairA, address pairB, uint256 amountAIn, uint256 minOutB, uint256 deadline) external nonReentrant {
        _deadline(deadline);
        ResDouble memory r = _execExact1For1ViaDL(pairA, pairB, msg.sender, msg.sender, amountAIn, minOutB);
        _maybeSettle(pairA);
        _maybeSettle(pairB);
        emit SwapExact1For1ViaDL(pairA, pairB, msg.sender, r.inAUsed, r.dlNetOrReq, r.outBOrETH, r.feeOutDL, r.feeInDL, msg.sender);
    }
    function swap1ForExact1ViaDL(address pairA, address pairB, uint256 outBTarget, uint256 maxAmountAIn, uint256 deadline) external nonReentrant {
        _deadline(deadline);
        ResDouble memory r = _exec1ForExact1ViaDL(pairA, pairB, msg.sender, msg.sender, outBTarget, maxAmountAIn);
        _maybeSettle(pairA);
        _maybeSettle(pairB);
        emit Swap1ForExact1ViaDL(pairA, pairB, msg.sender, r.inAUsed, r.dlNetOrReq, outBTarget, r.feeOutDL, r.feeInDL, r.dlRefund, msg.sender);
    }

    // —— 双跳便捷（ETH ↔ DC ↔ ERC20） —— //
    function swapExactETHFor1ViaDL(address pairWNATIVE, address pairB, uint256 minOutB, uint256 deadline) external payable nonReentrant {
        _deadline(deadline);
        uint256 ethIn = msg.value;
        ResDouble memory r = _execExactETHFor1ViaDL(pairWNATIVE, pairB, msg.sender, ethIn, minOutB);
        _maybeSettle(pairWNATIVE);
        _maybeSettle(pairB);
        emit SwapExactETHFor1ViaDL(pairWNATIVE, pairB, msg.sender, ethIn, r.dlNetOrReq, r.outBOrETH, r.feeOutDL, r.feeInDL, msg.sender);
    }
    function swap1ForExactETHViaDL(address pairA, address pairWNATIVE, uint256 outETHTarget, uint256 maxAmountAIn, uint256 deadline) external nonReentrant {
        _deadline(deadline);
        ResDouble memory r = _exec1ForExactETHViaDL(pairA, pairWNATIVE, msg.sender, msg.sender, outETHTarget, maxAmountAIn);
        _maybeSettle(pairA);
        _maybeSettle(pairWNATIVE);
        emit Swap1ForExactETHViaDL(pairA, pairWNATIVE, msg.sender, r.inAUsed, r.dlNetOrReq, outETHTarget, r.feeOutDL, r.feeInDL, r.dlRefund, msg.sender);
    }

    // u（A） exact-in -> ETH min-out
    function swapExact1ForETHViaDL(address pairA, address pairWNATIVE, uint256 amountAIn, uint256 minOutETH, uint256 deadline) external nonReentrant {
        _deadline(deadline);
        ResDouble memory r = _execExact1ForETHViaDL(pairA, pairWNATIVE, msg.sender, msg.sender, amountAIn, minOutETH);
        _maybeSettle(pairA);
        _maybeSettle(pairWNATIVE);
        emit SwapExact1ForETHViaDL(pairA, pairWNATIVE, msg.sender, r.inAUsed, r.dlNetOrReq, r.outBOrETH, r.feeOutDL, r.feeInDL, msg.sender);
    }
    // ETH max-in -> u exact-out（退回未用 ETH）
    function swapETHForExact1ViaDL(address pairWNATIVE, address pairB, uint256 outBTarget, uint256 deadline) external payable nonReentrant {
        _deadline(deadline);
        uint256 ethMax = msg.value;
        ResDouble memory r = _execETHForExact1ViaDL(pairWNATIVE, pairB, msg.sender, msg.sender, outBTarget, ethMax);
        uint256 ethRefund = ethMax - r.inAUsed;
        if (ethRefund > 0) _sendETH(msg.sender, ethRefund);
        _maybeSettle(pairWNATIVE);
        _maybeSettle(pairB);
        emit SwapETHForExact1ViaDL(pairWNATIVE, pairB, msg.sender, r.inAUsed, r.dlNetOrReq, outBTarget, r.feeOutDL, r.feeInDL, r.dlRefund, ethRefund, msg.sender);
    }

    function swapExact0For1OrQueue(address pair, uint256 amount0In, uint256 deadline) external nonReentrant {
        _deadline(deadline);
        ResQueued memory r = _execExact0For1Hybrid(pair, amount0In, msg.sender, msg.sender, 0);
        emit SwapExact0For1(pair, msg.sender, r.immediateIn, r.immediateOut, r.feeSide, msg.sender);
        if (r.queuedIn > 0) emit SwapQueuedRemainder(pair, msg.sender, true, r.immediateIn, r.immediateOut, r.queuedIn, r.orderId);
    }

    function swapExact1For0OrQueue(address pair, uint256 amount1In, uint256 deadline) external nonReentrant {
        _deadline(deadline);
        ResQueued memory r = _execExact1For0Hybrid(pair, amount1In, msg.sender, msg.sender, 0);
        emit SwapExact1For0(pair, msg.sender, r.immediateIn, r.immediateOut, r.outGross, r.feeSide, msg.sender);
        if (r.queuedIn > 0) emit SwapQueuedRemainder(pair, msg.sender, false, r.immediateIn, r.immediateOut, r.queuedIn, r.orderId);
    }

    function swapExactETHFor0OrQueue(address pair, uint256 deadline) external payable nonReentrant {
        _deadline(deadline);
        ResQueued memory r = _execExactETHFor0Hybrid(pair, msg.sender, msg.value, 0);
        emit SwapExactETHFor0(pair, msg.sender, r.immediateIn, r.immediateOut, r.outGross, r.feeSide, msg.sender);
        if (r.queuedIn > 0) emit SwapQueuedRemainder(pair, msg.sender, false, r.immediateIn, r.immediateOut, r.queuedIn, r.orderId);
    }

    function swapExact0ForETHOrQueue(address pair, uint256 amount0In, uint256 deadline) external nonReentrant {
        _deadline(deadline);
        ResQueued memory r = _execExact0ForETHHybrid(pair, amount0In, msg.sender, msg.sender, 0);
        emit SwapExact0ForETH(pair, msg.sender, r.immediateIn, r.immediateOut, r.feeSide, msg.sender);
        if (r.queuedIn > 0) emit SwapQueuedRemainder(pair, msg.sender, true, r.immediateIn, r.immediateOut, r.queuedIn, r.orderId);
    }
}
