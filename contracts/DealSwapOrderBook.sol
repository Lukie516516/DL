// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./interfaces/IERC20.sol";
import "./interfaces/IDealPair.sol";
import "./utils/SafeTransfer.sol";
import "./utils/ReentrancyGuard.sol";

interface IWNativeOrderBook is IERC20 {
    function withdraw(uint256 amount) external;
}

interface IDealPairReserves is IDealPair {
    function getReserves() external view returns (uint112 r0, uint112 r1, uint32 ts);
}

contract DealSwapOrderBook is ReentrancyGuard {
    using SafeTransfer for IERC20;

    uint256 public constant CANCEL_FEE_NUM = 1;
    uint256 public constant CANCEL_FEE_DEN = 1000;

    struct Order {
        address owner;
        address pair;
        bool isSellDL; // true: DL -> OTHER, false: OTHER -> DL
        bool active;
        uint256 remainingIn;
        uint64 createdAt;
        bool unwrapNativeOut;
        bool refundNativeIn;
    }

    address public immutable treasury;
    address public owner;
    address public router;
    uint256 public nextOrderId = 1;

    mapping(uint256 => Order) public orders;

    mapping(address => uint256[]) private _sellQueues; // DL -> OTHER
    mapping(address => uint256[]) private _buyQueues;  // OTHER -> DL
    mapping(address => uint256) public sellHead;
    mapping(address => uint256) public buyHead;

    event OrderPlaced(
        uint256 indexed orderId,
        address indexed owner,
        address indexed pair,
        bool isSellDL,
        uint256 amountIn,
        uint256 filledIn,
        uint256 filledOut,
        uint256 remainingIn
    );
    event OrderPartiallySettled(
        uint256 indexed orderId,
        address indexed pair,
        uint256 filledIn,
        uint256 filledOut,
        uint256 remainingIn
    );
    event OrderCompleted(uint256 indexed orderId, address indexed pair);
    event OrderCanceled(
        uint256 indexed orderId,
        address indexed owner,
        address refundToken,
        uint256 refunded,
        uint256 feeToTreasury
    );
    event RouterUpdated(address indexed router);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier onlyRouter() {
        require(msg.sender == router, "NOT_ROUTER");
        _;
    }

    constructor(address treasury_) {
        require(treasury_ != address(0), "ZERO_TREASURY");
        treasury = treasury_;
        owner = msg.sender;
    }

    receive() external payable {}

    function setRouter(address router_) external onlyOwner {
        router = router_;
        emit RouterUpdated(router_);
    }

    function placeSellDL(address pair, uint256 amount0In)
        external
        nonReentrant
        returns (uint256 orderId, uint256 filledIn, uint256 filledOut)
    {
        require(pair != address(0) && amount0In > 0, "BAD_ORDER");
        address token0 = IDealPair(pair).token0();
        IERC20(token0).safeTransferFrom(msg.sender, address(this), amount0In);

        (filledIn, filledOut) = _executeSellDL(pair, msg.sender, amount0In, false);
        uint256 remainingIn = amount0In - filledIn;
        if (remainingIn == 0) return (0, filledIn, filledOut);

        orderId = _enqueue(pair, true, msg.sender, remainingIn, false, false);
        emit OrderPlaced(orderId, msg.sender, pair, true, amount0In, filledIn, filledOut, remainingIn);
    }

    function placeBuyDL(address pair, uint256 amount1In)
        external
        nonReentrant
        returns (uint256 orderId, uint256 filledIn, uint256 filledOut)
    {
        require(pair != address(0) && amount1In > 0, "BAD_ORDER");
        address token1 = IDealPair(pair).token1();
        IERC20(token1).safeTransferFrom(msg.sender, address(this), amount1In);

        (filledIn, filledOut) = _executeBuyDL(pair, msg.sender, amount1In);
        uint256 remainingIn = amount1In - filledIn;
        if (remainingIn == 0) return (0, filledIn, filledOut);

        orderId = _enqueue(pair, false, msg.sender, remainingIn, false, false);
        emit OrderPlaced(orderId, msg.sender, pair, false, amount1In, filledIn, filledOut, remainingIn);
    }

    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.active, "ORDER_INACTIVE");
        require(o.owner == msg.sender, "NOT_OWNER");

        o.active = false;
        uint256 refundTokenAmount = o.remainingIn;
        o.remainingIn = 0;

        address refundToken = o.isSellDL ? IDealPair(o.pair).token0() : IDealPair(o.pair).token1();
        uint256 fee = (refundTokenAmount * CANCEL_FEE_NUM) / CANCEL_FEE_DEN;
        uint256 refund = refundTokenAmount - fee;

        if (o.refundNativeIn) {
            IWNativeOrderBook(refundToken).withdraw(refundTokenAmount);
            refundToken = address(0);
            if (fee > 0) _sendNative(treasury, fee);
            if (refund > 0) _sendNative(o.owner, refund);
        } else {
            if (fee > 0) IERC20(refundToken).safeTransfer(treasury, fee);
            if (refund > 0) IERC20(refundToken).safeTransfer(o.owner, refund);
        }

        emit OrderCanceled(orderId, o.owner, refundToken, refund, fee);
    }

    function settlePair(address pair, uint256 maxBuyOrders, uint256 maxSellOrders)
        external
        nonReentrant
    {
        if (maxSellOrders > 0) _settleQueue(pair, true, maxSellOrders);
        if (maxBuyOrders > 0) _settleQueue(pair, false, maxBuyOrders);
    }

    function getQueue(address pair, bool isSellDL)
        external
        view
        returns (uint256[] memory ids, uint256 head)
    {
        if (isSellDL) {
            return (_sellQueues[pair], sellHead[pair]);
        }
        return (_buyQueues[pair], buyHead[pair]);
    }

    function maxImmediateSellIn(address pair) external view returns (uint256) {
        (, uint112 reserve1,) = IDealPairReserves(pair).getReserves();
        return _maxSellInForCurrentReserves(pair, reserve1);
    }

    function maxImmediateBuyIn(address pair) external view returns (uint256) {
        (uint112 reserve0,,) = IDealPairReserves(pair).getReserves();
        return _maxBuyInForCurrentReserves(pair, reserve0);
    }

    function enqueueSellDLFromRouter(address pair, address owner_, uint256 amount0In, bool unwrapNativeOut)
        external
        onlyRouter
        returns (uint256 orderId)
    {
        require(amount0In > 0 && owner_ != address(0), "BAD_QUEUE");
        if (unwrapNativeOut) require(IDealPair(pair).token1() != address(0), "BAD_NATIVE_PAIR");
        IERC20(IDealPair(pair).token0()).safeTransferFrom(msg.sender, address(this), amount0In);
        orderId = _enqueue(pair, true, owner_, amount0In, unwrapNativeOut, false);
        emit OrderPlaced(orderId, owner_, pair, true, amount0In, 0, 0, amount0In);
    }

    function enqueueBuyDLFromRouter(address pair, address owner_, uint256 amount1In, bool refundNativeIn)
        external
        onlyRouter
        returns (uint256 orderId)
    {
        require(amount1In > 0 && owner_ != address(0), "BAD_QUEUE");
        if (refundNativeIn) require(IDealPair(pair).token1() != address(0), "BAD_NATIVE_PAIR");
        IERC20(IDealPair(pair).token1()).safeTransferFrom(msg.sender, address(this), amount1In);
        orderId = _enqueue(pair, false, owner_, amount1In, false, refundNativeIn);
        emit OrderPlaced(orderId, owner_, pair, false, amount1In, 0, 0, amount1In);
    }

    function _enqueue(
        address pair,
        bool isSellDL,
        address orderOwner,
        uint256 amountIn,
        bool unwrapNativeOut,
        bool refundNativeIn
    )
        internal
        returns (uint256 orderId)
    {
        orderId = nextOrderId++;
        orders[orderId] = Order({
            owner: orderOwner,
            pair: pair,
            isSellDL: isSellDL,
            active: true,
            remainingIn: amountIn,
            createdAt: uint64(block.timestamp),
            unwrapNativeOut: unwrapNativeOut,
            refundNativeIn: refundNativeIn
        });

        if (isSellDL) _sellQueues[pair].push(orderId);
        else _buyQueues[pair].push(orderId);
    }

    function _settleQueue(address pair, bool isSellDL, uint256 maxOrders) internal {
        uint256[] storage queue = isSellDL ? _sellQueues[pair] : _buyQueues[pair];
        uint256 head = isSellDL ? sellHead[pair] : buyHead[pair];
        uint256 processed;

        while (head < queue.length && processed < maxOrders) {
            uint256 orderId = queue[head];
            Order storage o = orders[orderId];

            if (!o.active || o.remainingIn == 0) {
                head++;
                continue;
            }

            (uint256 filledIn, uint256 filledOut) = isSellDL
                ? _executeSellDL(pair, o.owner, o.remainingIn, o.unwrapNativeOut)
                : _executeBuyDL(pair, o.owner, o.remainingIn);

            if (filledIn == 0) break;

            o.remainingIn -= filledIn;
            emit OrderPartiallySettled(orderId, pair, filledIn, filledOut, o.remainingIn);

            if (o.remainingIn == 0) {
                o.active = false;
                emit OrderCompleted(orderId, pair);
                head++;
            }

            processed++;
        }

        if (isSellDL) sellHead[pair] = head;
        else buyHead[pair] = head;
    }

    function _sendNative(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "NATIVE_SEND_FAIL");
    }

    function _settleSellOut(address pair, address to, uint256 out1, bool unwrapNativeOut) internal {
        if (unwrapNativeOut) {
            address token1 = IDealPair(pair).token1();
            IDealPair(pair).swap(0, out1, address(this));
            IWNativeOrderBook(token1).withdraw(out1);
            _sendNative(to, out1);
        } else {
            IDealPair(pair).swap(0, out1, to);
        }
    }

    function _executeSellDL(address pair, address to, uint256 amount0In, bool unwrapNativeOut)
        internal
        returns (uint256 filledIn, uint256 filledOut)
    {
        if (amount0In == 0) return (0, 0);
        (uint112 r0, uint112 r1,) = IDealPairReserves(pair).getReserves();
        if (r0 == 0 || r1 <= 1) return (0, 0);

        if (amount0In < _maxSellInForCurrentReserves(pair, r1)) {
            (uint256 feeIn, uint256 out1) = IDealPair(pair).quoteSell(amount0In);
            feeIn;
            IERC20(IDealPair(pair).token0()).safeTransfer(pair, amount0In);
            _settleSellOut(pair, to, out1, unwrapNativeOut);
            return (amount0In, out1);
        }

        uint256 outTarget = uint256(r1) / 2;
        (uint256 in0Min,,) = IDealPair(pair).quoteSellGivenOut1(outTarget);
        if (in0Min == 0) return (0, 0);
        IERC20(IDealPair(pair).token0()).safeTransfer(pair, in0Min);
        _settleSellOut(pair, to, outTarget, unwrapNativeOut);
        return (in0Min, outTarget);
    }

    function _executeBuyDL(address pair, address to, uint256 amount1In)
        internal
        returns (uint256 filledIn, uint256 filledOut)
    {
        if (amount1In == 0) return (0, 0);
        (uint112 r0, uint112 r1,) = IDealPairReserves(pair).getReserves();
        if (r1 == 0 || r0 <= 1) return (0, 0);

        if (amount1In < _maxBuyInForCurrentReserves(pair, r0)) {
            (uint256 grossOut,, uint256 netOut) = IDealPair(pair).quoteBuyGivenIn1(amount1In);
            IERC20(IDealPair(pair).token1()).safeTransfer(pair, amount1In);
            IDealPair(pair).swap(grossOut, 0, to);
            return (amount1In, netOut);
        }

        uint256 grossTarget = uint256(r0) / 2;
        (uint256 in1Min,, uint256 netOutTarget) = IDealPair(pair).quoteBuyGivenGross(grossTarget);
        if (in1Min == 0) return (0, 0);
        IERC20(IDealPair(pair).token1()).safeTransfer(pair, in1Min);
        IDealPair(pair).swap(grossTarget, 0, to);
        return (in1Min, netOutTarget);
    }

    function _maxSellInForCurrentReserves(address pair, uint112 reserve1) internal view returns (uint256 maxIn) {
        uint256 outTarget = uint256(reserve1) / 2;
        if (outTarget == 0) return 0;
        (maxIn,,) = IDealPair(pair).quoteSellGivenOut1(outTarget);
    }

    function _maxBuyInForCurrentReserves(address pair, uint112 reserve0) internal view returns (uint256 maxIn) {
        uint256 grossTarget = uint256(reserve0) / 2;
        if (grossTarget == 0) return 0;
        (maxIn,,) = IDealPair(pair).quoteBuyGivenGross(grossTarget);
    }
}
