// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

/// @title SatoshiVault
/// @notice Holds DealCoin and pays one DAO-approved recipient per Satoshi proposal action.
/// @dev Deployed behind ERC1967Proxy. The DealGovernance proxy is the only caller and UUPS upgrader.
contract SatoshiVault is Initializable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    IERC20 public dealCoin;
    address public controller;

    event DealCoinPaid(address indexed to, uint256 amount);

    error NotController();
    error ZeroAddress();
    error ZeroAmount();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address dealCoin_, address controller_) external initializer {
        if (dealCoin_ == address(0) || controller_ == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        dealCoin = IERC20(dealCoin_);
        controller = controller_;
    }

    modifier onlyController() {
        if (msg.sender != controller) revert NotController();
        _;
    }

    /// @notice Pays DC to the exact recipient approved by one Satoshi proposal.
    function payDC(address to, uint256 amount) external onlyController nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        dealCoin.safeTransfer(to, amount);
        emit DealCoinPaid(to, amount);
    }

    function _authorizeUpgrade(address) internal override onlyController {}

    uint256[48] private __gap;
}
