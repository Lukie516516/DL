// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IProtocolDividendClaimer {
    function createRound(uint256 total) external;
}

/// @title ProtocolTreasury
/// @notice Holds protocol revenue and executes payouts/approvals only through a
///         configured governance controller.
/// @dev The bootstrap admin exists only to wire the final controller after
///      deployment. Call lockBootstrap() once DAO/timelock/executor is wired.
contract ProtocolTreasury is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public controller;
    address public bootstrapAdmin;
    bool public bootstrapLocked;

    event ControllerUpdated(address indexed oldController, address indexed newController);
    event BootstrapLocked(address indexed admin);
    event NativeReceived(address indexed from, uint256 amount);
    event NativePaid(address indexed to, uint256 amount);
    event TokenPaid(address indexed token, address indexed to, uint256 amount);
    event TokenApproved(address indexed token, address indexed spender, uint256 amount);
    event Executed(address indexed target, uint256 value, bytes data, bytes result);
    event DividendRoundCreated(address indexed token, address indexed claimer, uint256 amount);

    error NotController();
    error NotBootstrapAdmin();
    error BootstrapAlreadyLocked();
    error ZeroAddress();
    error CallFailed(bytes reason);

    modifier onlyController() {
        if (msg.sender != controller) revert NotController();
        _;
    }

    modifier onlyBootstrapAdmin() {
        if (bootstrapLocked) revert BootstrapAlreadyLocked();
        if (msg.sender != bootstrapAdmin) revert NotBootstrapAdmin();
        _;
    }

    constructor(address controller_, address bootstrapAdmin_) {
        if (controller_ == address(0) || bootstrapAdmin_ == address(0)) revert ZeroAddress();
        controller = controller_;
        bootstrapAdmin = bootstrapAdmin_;
        emit ControllerUpdated(address(0), controller_);
    }

    receive() external payable {
        emit NativeReceived(msg.sender, msg.value);
    }

    /// @notice One-time deployment wiring path. Use it to move control to the
    ///         DAO/timelock/executor, then call lockBootstrap().
    function bootstrapSetController(address newController) external onlyBootstrapAdmin {
        _setController(newController);
    }

    function lockBootstrap() external onlyBootstrapAdmin {
        bootstrapLocked = true;
        emit BootstrapLocked(msg.sender);
    }

    /// @notice Governance-controlled controller migration.
    function setController(address newController) external onlyController {
        _setController(newController);
    }

    function payNative(address payable to, uint256 amount) external onlyController nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, bytes memory reason) = to.call{value: amount}("");
        if (!ok) revert CallFailed(reason);
        emit NativePaid(to, amount);
    }

    function payToken(IERC20 token, address to, uint256 amount) external onlyController nonReentrant {
        if (address(token) == address(0) || to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit TokenPaid(address(token), to, amount);
    }

    function approveToken(IERC20 token, address spender, uint256 amount) external onlyController nonReentrant {
        _approveToken(token, spender, amount);
    }

    /// @notice Convenience path for dividend distribution. The treasury must be
    ///         both dividendSource and executor of VoteDividendClaimer.
    function approveAndCreateDividendRound(IERC20 token, address claimer, uint256 amount)
        external
        onlyController
        nonReentrant
    {
        _approveToken(token, claimer, amount);
        IProtocolDividendClaimer(claimer).createRound(amount);
        emit DividendRoundCreated(address(token), claimer, amount);
    }

    /// @notice Generic governance execution hook for future treasury integrations.
    function execute(address target, uint256 value, bytes calldata data)
        external
        onlyController
        nonReentrant
        returns (bytes memory result)
    {
        if (target == address(0)) revert ZeroAddress();
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        emit Executed(target, value, data, ret);
        return ret;
    }

    function _approveToken(IERC20 token, address spender, uint256 amount) private {
        if (address(token) == address(0) || spender == address(0)) revert ZeroAddress();
        token.forceApprove(spender, amount);
        emit TokenApproved(address(token), spender, amount);
    }

    function _setController(address newController) private {
        if (newController == address(0)) revert ZeroAddress();
        emit ControllerUpdated(controller, newController);
        controller = newController;
    }
}
