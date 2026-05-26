// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

interface IDealFactoryPairConfig {
    function dlToken() external view returns (address);
    function pairImplementation() external view returns (address);
    function swapOrderBook() external view returns (address);
    function minWindowSec() external view returns (uint32);
}

interface IManagedDealPairLight {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getPriceCumulatives() external view returns (uint256 p0Cum, uint256 p1Cum, uint32 ts);
    function getEffectiveReserves() external view returns (uint256 e0, uint256 e1, uint32 ts);
}

interface IManagedDealPairInit {
    function initialize(address dlToken, address otherToken, address factory_, uint32 feeNum_, uint32 feeDen_)
        external;
    function setFactory(address f) external;
    function setFee(uint32 newNum, uint32 newDen) external;
    function mintInitial(uint256 _b1) external returns (uint256 amountDL, uint256 amountOther);
    function setVirtualReserves(uint256 newVirtualReserve0, uint256 newVirtualReserve1, bool enable0, bool enable1)
        external;
    function setVirtualReservesByBps(uint32 bps0, uint32 bps1, bool enable0, bool enable1) external;
}

interface IManagedDealPairOtherLiquidity {
    function mintOtherOnly() external returns (uint256 amountOther);
}

interface IManagedDealPairVirtualView {
    function getVirtualReserves() external view returns (uint256 v0, uint256 v1);
}

interface IManagedOrderBookSettle {
    function settlePair(address pair, uint256 maxBuyOrders, uint256 maxSellOrders) external;
}

/// @notice Owns pair lifecycle and TWAP accounting so DealFactory can stay below the bytecode limit.
contract DealPairManager {
    using Clones for address;

    address public immutable factory;
    address public owner;

    mapping(address => address) public pairForToken;

    struct Obs {
        uint256 p1Cumulative;
        uint32 timestamp;
        bool inited;
        uint256 lastAvgQ112;
    }

    mapping(address => Obs) public obsByPair;

    error NotFactory();
    error ZeroAddress();
    error PairExists();
    error CloneFailed();
    error CloneNoCode();
    error RatioInvalid();
    error InvalidDlPair();
    error NotOwner();

    event OwnerTransferred(address indexed oldOwner, address indexed newOwner);
    event TwapRolled(address indexed pair, uint256 avgQ112, uint32 ts, uint32 elapsed);

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        owner = msg.sender;
        emit OwnerTransferred(address(0), msg.sender);
    }

    function transferOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    function createPair(address tokenOther, uint32 feeNum, uint32 feeDen) external onlyOwner returns (address pair) {
        if (pairForToken[tokenOther] != address(0)) revert PairExists();
        address dl = IDealFactoryPairConfig(factory).dlToken();
        address impl = IDealFactoryPairConfig(factory).pairImplementation();
        if (impl == address(0) || dl == address(0) || tokenOther == address(0) || tokenOther == dl) {
            revert ZeroAddress();
        }
        _assertRatio(feeNum, feeDen);

        pair = impl.clone();
        _assertClone(pair);
        IManagedDealPairInit(pair).initialize(dl, tokenOther, address(this), feeNum, feeDen);
        _assertDlPair(pair, dl);
        pairForToken[tokenOther] = pair;
    }

    function mapExistingPair(address tokenOther, address pair) external onlyOwner {
        if (tokenOther == address(0) || pair == address(0)) revert ZeroAddress();
        if (pairForToken[tokenOther] != address(0)) revert PairExists();
        _assertDlPair(pair, IDealFactoryPairConfig(factory).dlToken());
        pairForToken[tokenOther] = pair;
    }

    function setPairFactory(address pair, address f) external onlyOwner {
        IManagedDealPairInit(pair).setFactory(f);
    }

    function initPair(address pair, uint256 b1) external onlyOwner returns (uint256 amountDL, uint256 amountOther) {
        (amountDL, amountOther) = IManagedDealPairInit(pair).mintInitial(b1);
        address orderBook = IDealFactoryPairConfig(factory).swapOrderBook();
        if (orderBook != address(0)) {
            IManagedOrderBookSettle(orderBook).settlePair(pair, 1, 1);
        }
    }

    function mintPairOtherAndSettle(address pair)
        external
        onlyOwner
        returns (uint256 amountOther, bool settleAttempted, bool settleSucceeded)
    {
        _assertDlPair(pair, IDealFactoryPairConfig(factory).dlToken());
        amountOther = IManagedDealPairOtherLiquidity(pair).mintOtherOnly();
        address orderBook = IDealFactoryPairConfig(factory).swapOrderBook();
        if (orderBook != address(0)) {
            settleAttempted = true;
            IManagedOrderBookSettle(orderBook).settlePair(pair, 1, 8);
            settleSucceeded = true;
        }
    }

    function setPairFee(address pair, uint32 newNum, uint32 newDen) external onlyOwner {
        IManagedDealPairInit(pair).setFee(newNum, newDen);
    }

    function setPairVirtualReserves(
        address pair,
        uint256 virtualReserve0,
        bool enable0,
        uint256 virtualReserve1,
        bool enable1
    ) external onlyOwner {
        _assertDlPair(pair, IDealFactoryPairConfig(factory).dlToken());
        IManagedDealPairInit(pair).setVirtualReserves(virtualReserve0, virtualReserve1, enable0, enable1);
    }

    function setPairVirtualReservesByBps(address pair, uint32 bps0, bool enable0, uint32 bps1, bool enable1)
        external
        onlyOwner
        returns (uint256 v0, uint256 v1)
    {
        if (bps0 > 10_000 || bps1 > 10_000) revert RatioInvalid();
        _assertDlPair(pair, IDealFactoryPairConfig(factory).dlToken());
        IManagedDealPairInit(pair).setVirtualReservesByBps(bps0, bps1, enable0, enable1);
        (v0, v1) = IManagedDealPairVirtualView(pair).getVirtualReserves();
    }

    function updateAndQuoteToDL(address pair, uint256 amountIn) external onlyFactory returns (uint256 dlOut) {
        if (amountIn == 0 || pair == address(0)) return 0;
        _assertDlPair(pair, IDealFactoryPairConfig(factory).dlToken());
        (uint256 cumNow, uint32 nowTs, uint256 spotQ112) = _currentP1CumulativeWithSpot(pair);
        Obs storage o = obsByPair[pair];
        if (!o.inited) {
            o.p1Cumulative = cumNow;
            o.timestamp = nowTs;
            o.inited = true;
            o.lastAvgQ112 = spotQ112;
            emit TwapRolled(pair, spotQ112, nowTs, 0);
            return (spotQ112 * amountIn) >> 112;
        }
        uint32 elapsed = nowTs - o.timestamp;
        if (elapsed < IDealFactoryPairConfig(factory).minWindowSec()) return (o.lastAvgQ112 * amountIn) >> 112;
        uint256 avgQ112 = (cumNow - o.p1Cumulative) / elapsed;
        o.p1Cumulative = cumNow;
        o.timestamp = nowTs;
        o.lastAvgQ112 = avgQ112;
        emit TwapRolled(pair, avgQ112, nowTs, elapsed);
        return (avgQ112 * amountIn) >> 112;
    }

    function _currentP1CumulativeWithSpot(address pair)
        internal
        view
        returns (uint256 p1CumNow, uint32 nowTs, uint256 spotQ112)
    {
        (, p1CumNow, ) = IManagedDealPairLight(pair).getPriceCumulatives();
        (uint256 r0, uint256 r1, uint32 tsRes) = IManagedDealPairLight(pair).getEffectiveReserves();
        require(r0 > 0 && r1 > 0);
        nowTs = uint32(block.timestamp);
        uint32 elapsed = nowTs - tsRes;
        spotQ112 = (r0 << 112) / r1;
        if (elapsed > 0) {
            unchecked {
                p1CumNow += spotQ112 * elapsed;
            }
        }
    }

    function _assertRatio(uint32 num, uint32 den) private pure {
        if (den == 0 || num >= den) revert RatioInvalid();
    }

    function _assertDlPair(address pair, address dl) private view {
        if (pair == address(0) || IManagedDealPairLight(pair).token0() != dl) revert InvalidDlPair();
    }

    function _assertClone(address instance) private view {
        if (instance == address(0)) revert CloneFailed();
        if (instance.code.length == 0) revert CloneNoCode();
    }
}
