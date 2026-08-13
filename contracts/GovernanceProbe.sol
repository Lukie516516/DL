// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @title GovernanceProbe
/// @notice Asset-free module used to prove that the same DAO-approved action reaches each supported chain.
/// @dev The Ethereum proxy is controlled by DealGovernance. Satellite proxies are controlled by their
///      local cross-chain executor. It defines no token operations or application-level external calls.
///      Governance policy sets maxValue=0 for every allowed probe action.
contract GovernanceProbe is Initializable, UUPSUpgradeable {
    address public controller;
    bytes32 public marker;
    uint256 public updateCount;

    event MarkerRecorded(bytes32 indexed previousMarker, bytes32 indexed newMarker, uint256 updateCount);

    error NotController();
    error ZeroAddress();
    error ZeroMarker();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address controller_) external initializer {
        if (controller_ == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        controller = controller_;
    }

    modifier onlyController() {
        if (msg.sender != controller) revert NotController();
        _;
    }

    /// @notice Stores a governance-approved marker without touching any protocol or user assets.
    function recordMarker(bytes32 newMarker) external onlyController {
        if (newMarker == bytes32(0)) revert ZeroMarker();
        bytes32 previousMarker = marker;
        marker = newMarker;
        uint256 newCount = updateCount + 1;
        updateCount = newCount;
        emit MarkerRecorded(previousMarker, newMarker, newCount);
    }

    function version() external pure virtual returns (uint256) {
        return 1;
    }

    function _authorizeUpgrade(address) internal override onlyController {}

    uint256[47] private __gap;
}
