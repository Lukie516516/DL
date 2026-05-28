// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./interfaces/IERC20.sol";
import "./utils/SafeTransfer.sol";
import "./utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";

interface IDLBurnable is IERC20 {
    function burn(uint256 value) external;
}

contract DealSwapTemplate is Initializable, ReentrancyGuard {
    using SafeTransfer for IERC20;

    error NotFactory();
    error ZeroAddress();
    error IdenticalAddress();
    error BadFee();
    error NotInit();
    error AlreadyInit();
    error NeedBothSides();
    error InvalidTo();
    error ZeroOut();
    error OneSideOnly();
    error InsufficientLiquidity();
    error InsufficientInput();
    error Overflow();
    error K();
    error BadGross();
    error BadNet();
    error ZeroIn();
    error InsufficientIn();
    error BadOut();
    error BadVirtualBps();

    /* ---------------- Storage (initialize 设置) ---------------- */
    address public factory; // 仅此地址可做初始化、调费率等治理操作
    address public token0; // DC
    address public token1; // OTHER

    /// @dev 旧版本用于把 token1 虚拟垫高混入会计储备；现在仅保留为 legacy 配置记录，不再混入 reserve。
    uint256 public token1BalanceInit;

    /* ---------------- Reserves / TWAP ---------------- */
    uint112 private reserve0; // DC（真实）
    uint112 private reserve1; // OTHER（真实）
    uint32 private blockTimestampLast;

    // TWAP cumulatives (UQ112x112)；现在按“真实 + 虚拟”的有效储备更新。
    uint256 public price0CumulativeLast; // token1/token0
    uint256 public price1CumulativeLast; // token0/token1

    /* ---------------- Params ---------------- */
    uint32 public feeNum;
    uint32 public feeDen;
    bool public liquidityInited;

    // 虚拟储备：单独配置，不再混入真实 reserve。
    uint256 public virtualReserve0;
    uint256 public virtualReserve1;
    bool public virtualReserve0Enabled;
    bool public virtualReserve1Enabled;

    /* ---------------- Events ---------------- */
    event FeeChanged(uint32 oldNum, uint32 oldDen, uint32 newNum, uint32 newDen);
    event Sync(uint112 reserve0, uint112 reserve1);
    event MintInitial(uint256 amountDL, uint256 amountOther);
    event MintOtherOnly(uint256 amountOther);
    event DustPurged(uint256 dlAmount);
    event FeeBurned(uint256 dlAmount);
    event VirtualReservesConfigured(
        uint256 virtualReserve0,
        bool virtualReserve0Enabled,
        uint256 virtualReserve1,
        bool virtualReserve1Enabled
    );

    // amount0In/Out 表示 DC，amount1In/Out 表示 OTHER，amount0OutNet（仅买 DC 时有意义）
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0OutGross,
        uint256 amount0OutNet,
        uint256 amount1OutGross,
        address indexed to
    );

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    function initialize(
        address dlToken,
        address otherToken,
        address factory_,
        uint32 feeNum_,
        uint32 feeDen_
    ) external initializer {
        if (dlToken == address(0) || otherToken == address(0)) revert ZeroAddress();
        if (dlToken == otherToken) revert IdenticalAddress();
        if (factory_ == address(0)) revert ZeroAddress();
        if (feeDen_ == 0 || feeNum_ >= feeDen_) revert BadFee();

        token0 = dlToken;
        token1 = otherToken;
        factory = factory_;
        feeNum = feeNum_;
        feeDen = feeDen_;
    }

    /* ---------------- Views ---------------- */
    function getReserves() public view returns (uint112 _r0, uint112 _r1, uint32 _ts) {
        _r0 = reserve0;
        _r1 = reserve1;
        _ts = blockTimestampLast;
    }

    function getVirtualReserves() public view returns (uint256 v0, uint256 v1) {
        v0 = virtualReserve0Enabled ? virtualReserve0 : 0;
        v1 = virtualReserve1Enabled ? virtualReserve1 : 0;
    }

    function getEffectiveReserves() external view returns (uint256 e0, uint256 e1, uint32 ts) {
        (uint112 r0, uint112 r1, uint32 _ts) = getReserves();
        (uint256 v0, uint256 v1) = getVirtualReserves();
        return (uint256(r0) + v0, uint256(r1) + v1, _ts);
    }

    function getPriceCumulatives() external view returns (uint256 p0Cum, uint256 p1Cum, uint32 ts) {
        return (price0CumulativeLast, price1CumulativeLast, blockTimestampLast);
    }

    function token1Balance() public view returns (uint256) {
        return IERC20(token1).balanceOf(address(this));
    }

    /* ---------------- Internal math ---------------- */
    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return (a + b - 1) / b;
    }

    function _effectiveReservesFromReal(uint256 r0, uint256 r1) internal view returns (uint256 e0, uint256 e1) {
        (uint256 v0, uint256 v1) = getVirtualReserves();
        e0 = r0 + v0;
        e1 = r1 + v1;
    }

    function _effectiveReserves() internal view returns (uint256 e0, uint256 e1) {
        (uint112 r0, uint112 r1, ) = getReserves();
        return _effectiveReservesFromReal(uint256(r0), uint256(r1));
    }

    function _rollPriceCumulatives(uint32 ts) internal {
        uint32 elapsed = ts - blockTimestampLast;
        if (elapsed == 0) return;

        if (reserve0 != 0 && reserve1 != 0) {
            unchecked {
                (uint256 eff0, uint256 eff1) =
                    _effectiveReservesFromReal(uint256(reserve0), uint256(reserve1));
                uint256 price0 = (eff1 << 112) / eff0;
                uint256 price1 = (eff0 << 112) / eff1;
                price0CumulativeLast += price0 * elapsed;
                price1CumulativeLast += price1 * elapsed;
            }
        }

        blockTimestampLast = ts;
    }

    /* ---------------- Quotes (front-end helpers) ---------------- */
    function quoteBuyGivenGross(uint256 amount0OutGross)
        external
        view
        returns (uint256 in1Min, uint256 feeOut, uint256 out0Net)
    {
        if (!liquidityInited) revert NotInit();
        (uint112 r0, , ) = getReserves();
        if (amount0OutGross == 0 || amount0OutGross >= r0) revert BadGross();

        (uint256 e0, uint256 e1) = _effectiveReserves();
        uint256 denom = e0 - amount0OutGross;
        in1Min = _ceilDiv(e1 * amount0OutGross, denom);

        feeOut = (amount0OutGross * feeNum) / feeDen;
        out0Net = amount0OutGross - feeOut;
    }

    function quoteBuyGivenNet(uint256 out0NetTarget)
        external
        view
        returns (uint256 grossMin, uint256 feeOut, uint256 in1Min)
    {
        if (!liquidityInited) revert NotInit();
        (uint112 r0, , ) = getReserves();
        if (out0NetTarget == 0 || out0NetTarget >= r0) revert BadNet();

        uint256 denomFee = uint256(feeDen) - feeNum;
        grossMin = _ceilDiv(out0NetTarget * feeDen, denomFee);
        feeOut = (grossMin * feeNum) / feeDen;
        if (grossMin - feeOut < out0NetTarget) {
            unchecked {
                grossMin += 1;
            }
            feeOut = (grossMin * feeNum) / feeDen;
        }
        if (grossMin >= r0) revert InsufficientLiquidity();

        (uint256 e0, uint256 e1) = _effectiveReserves();
        uint256 d = e0 - grossMin;
        in1Min = _ceilDiv(e1 * grossMin, d);
    }

    function quoteBuyGivenIn1(uint256 amount1In)
        external
        view
        returns (uint256 grossMax, uint256 feeOut, uint256 out0Net)
    {
        if (!liquidityInited) revert NotInit();
        (uint112 r0, , ) = getReserves();
        if (amount1In == 0) revert ZeroIn();

        (uint256 e0, uint256 e1) = _effectiveReserves();
        grossMax = (e0 * amount1In) / (e1 + amount1In);
        if (grossMax >= r0) revert InsufficientLiquidity();
        if (grossMax == 0) revert InsufficientIn();

        feeOut = (grossMax * feeNum) / feeDen;
        out0Net = grossMax - feeOut;
    }

    function quoteSell(uint256 amount0In)
        external
        view
        returns (uint256 feeIn, uint256 out1)
    {
        if (!liquidityInited) revert NotInit();
        if (amount0In == 0) revert ZeroIn();

        feeIn = (amount0In * feeNum) / feeDen;
        uint256 in0Eff = amount0In - feeIn;
        (uint256 e0, uint256 e1) = _effectiveReserves();
        out1 = (e1 * in0Eff) / (e0 + in0Eff);
    }

    function quoteSellGivenOut1(uint256 out1Target)
        external
        view
        returns (uint256 in0Min, uint256 feeIn, uint256 in0EffMin)
    {
        if (!liquidityInited) revert NotInit();
        (, uint112 r1, ) = getReserves();
        if (out1Target == 0 || out1Target >= r1) revert BadOut();

        (uint256 e0, uint256 e1) = _effectiveReserves();
        uint256 denom = e1 - out1Target;
        in0EffMin = _ceilDiv(e0 * out1Target, denom);

        uint256 denom2 = uint256(feeDen) - feeNum;
        in0Min = _ceilDiv(in0EffMin * feeDen, denom2);
        feeIn = (in0Min * feeNum) / feeDen;
        if (in0Min - feeIn < in0EffMin) {
            unchecked {
                in0Min += 1;
            }
            feeIn = (in0Min * feeNum) / feeDen;
        }
    }

    /* ---------------- Governance (Factory only) ---------------- */
    function setFactory(address f) external onlyFactory {
        factory = f;
    }

    function setFee(uint32 newNum, uint32 newDen) external onlyFactory {
        if (newDen == 0 || newNum >= newDen) revert BadFee();
        emit FeeChanged(feeNum, feeDen, newNum, newDen);
        feeNum = newNum;
        feeDen = newDen;
    }

    function setVirtualReserves(
        uint256 newVirtualReserve0,
        uint256 newVirtualReserve1,
        bool enable0,
        bool enable1
    ) external onlyFactory {
        if (liquidityInited) _rollPriceCumulatives(uint32(block.timestamp));
        virtualReserve0 = newVirtualReserve0;
        virtualReserve1 = newVirtualReserve1;
        virtualReserve0Enabled = enable0 && newVirtualReserve0 > 0;
        virtualReserve1Enabled = enable1 && newVirtualReserve1 > 0;
        emit VirtualReservesConfigured(
            virtualReserve0,
            virtualReserve0Enabled,
            virtualReserve1,
            virtualReserve1Enabled
        );
    }

    function setVirtualReservesByBps(
        uint32 bps0,
        uint32 bps1,
        bool enable0,
        bool enable1
    ) external onlyFactory {
        if (bps0 > 10_000 || bps1 > 10_000) revert BadVirtualBps();
        if (liquidityInited) _rollPriceCumulatives(uint32(block.timestamp));
        uint256 real0 = IERC20(token0).balanceOf(address(this));
        uint256 real1 = IERC20(token1).balanceOf(address(this));
        virtualReserve0 = enable0 ? (real0 * bps0) / 10_000 : 0;
        virtualReserve1 = enable1 ? (real1 * bps1) / 10_000 : 0;
        virtualReserve0Enabled = enable0 && virtualReserve0 > 0;
        virtualReserve1Enabled = enable1 && virtualReserve1 > 0;
        emit VirtualReservesConfigured(
            virtualReserve0,
            virtualReserve0Enabled,
            virtualReserve1,
            virtualReserve1Enabled
        );
    }

    /// 由 Factory 完成初始化（需先把 DC 与 OTHER 转入本合约）
    /// @dev `_b1` 保留为 legacy 参数：若非 0，则默认作为 token1 的初始虚拟储备写入配置，但不再混入真实 reserve。
    function mintInitial(uint256 _b1) external nonReentrant onlyFactory returns (uint256 amountDL, uint256 amountOther) {
        if (liquidityInited) revert AlreadyInit();

        token1BalanceInit = _b1;

        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        amountDL = b0;
        amountOther = b1;
        if (amountDL == 0 || amountOther == 0) revert NeedBothSides();

        liquidityInited = true;
        _updateReserves();

        if (_b1 > 0 && virtualReserve1 == 0 && !virtualReserve1Enabled) {
            virtualReserve1 = _b1;
            virtualReserve1Enabled = true;
            emit VirtualReservesConfigured(
                virtualReserve0,
                virtualReserve0Enabled,
                virtualReserve1,
                virtualReserve1Enabled
            );
        }

        emit MintInitial(amountDL, amountOther);
    }

    /* ---------------- Liquidity (Deal only) ---------------- */
    function mintOtherOnly() external nonReentrant returns (uint256 amountOther) {
        if (!liquidityInited) revert NotInit();

        (, uint112 r1, ) = getReserves();

        uint256 b0Pre = IERC20(token0).balanceOf(address(this));
        if (b0Pre > reserve0) {
            uint256 extraDL = b0Pre - reserve0;
            IDLBurnable(token0).burn(extraDL);
            emit DustPurged(extraDL);
        }

        uint256 b1 = IERC20(token1).balanceOf(address(this));
        uint256 in1 = b1 - r1;
        require(in1 > 0, "NO_OTHER_IN");

        amountOther = in1;
        _updateReserves();
        emit MintOtherOnly(amountOther);
    }

    /* ---------------- Swap (public) ---------------- */
    function swap(uint256 amount0OutGross, uint256 amount1OutGross, address to) external nonReentrant {
        if (!liquidityInited) revert NotInit();
        if (to == address(0) || to == token0 || to == token1 || to == address(this)) revert InvalidTo();
        if (amount0OutGross == 0 && amount1OutGross == 0) revert ZeroOut();
        if (amount0OutGross != 0 && amount1OutGross != 0) revert OneSideOnly();

        (uint112 r0, uint112 r1, ) = getReserves();
        if (amount0OutGross >= r0 || amount1OutGross >= r1) revert InsufficientLiquidity();

        (uint256 preEff0, uint256 preEff1) = _effectiveReserves();

        if (amount0OutGross > 0) {
            uint256 b0Pre = IERC20(token0).balanceOf(address(this));
            if (b0Pre > r0) {
                uint256 dust = b0Pre - r0;
                IDLBurnable(token0).burn(dust);
                emit DustPurged(dust);
            }

            uint256 dlOutFee = (amount0OutGross * feeNum) / feeDen;
            uint256 out0Net = amount0OutGross - dlOutFee;

            if (out0Net > 0) IERC20(token0).safeTransfer(to, out0Net);
            if (dlOutFee > 0) {
                IDLBurnable(token0).burn(dlOutFee);
                emit FeeBurned(dlOutFee);
            }

            uint256 b0 = IERC20(token0).balanceOf(address(this));
            uint256 b1 = IERC20(token1).balanceOf(address(this));
            uint256 in0 = b0 > r0 - amount0OutGross ? b0 - (r0 - amount0OutGross) : 0;
            uint256 in1 = b1 > r1 ? b1 - r1 : 0;
            if (in0 == 0 && in1 == 0) revert InsufficientInput();

            if (b0 > type(uint112).max || b1 > type(uint112).max) revert Overflow();
            (uint256 postEff0Buy, uint256 postEff1Buy) = _effectiveReservesFromReal(b0, b1);
            if (postEff0Buy * postEff1Buy < preEff0 * preEff1) revert K();

            _updateReserves();
            emit Swap(msg.sender, in0, in1, amount0OutGross, out0Net, 0, to);
            return;
        }

        IERC20(token1).safeTransfer(to, amount1OutGross);

        uint256 b0After = IERC20(token0).balanceOf(address(this));
        uint256 b1After = IERC20(token1).balanceOf(address(this));
        uint256 in0After = b0After > r0 ? b0After - r0 : 0;
        uint256 in1After = b1After > r1 - amount1OutGross ? b1After - (r1 - amount1OutGross) : 0;
        if (in0After == 0 && in1After == 0) revert InsufficientInput();

        uint256 feeIn = (in0After * feeNum) / feeDen;
        if (feeIn > 0) {
            IDLBurnable(token0).burn(feeIn);
            emit FeeBurned(feeIn);
            unchecked {
                b0After -= feeIn;
            }
        }

        if (b0After > type(uint112).max || b1After > type(uint112).max) revert Overflow();
        (uint256 postEff0, uint256 postEff1) = _effectiveReservesFromReal(b0After, b1After);
        if (postEff0 * postEff1 < preEff0 * preEff1) revert K();

        _updateReserves();
        emit Swap(msg.sender, in0After, in1After, 0, 0, amount1OutGross, to);
    }

    function sync() external nonReentrant {
        (uint112 r0, , ) = getReserves();
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        if (b0 > r0) {
            uint256 extra = b0 - r0;
            IDLBurnable(token0).burn(extra);
            emit DustPurged(extra);
        }
        _updateReserves();
    }

    function _updateReserves() internal {
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        if (b0 > type(uint112).max || b1 > type(uint112).max) revert Overflow();

        uint32 ts = uint32(block.timestamp);
        _rollPriceCumulatives(ts);

        reserve0 = uint112(b0);
        reserve1 = uint112(b1);
        emit Sync(reserve0, reserve1);
    }
}
