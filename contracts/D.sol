// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

contract D is ERC20, ERC20Permit, ERC20Votes {
    using Checkpoints for Checkpoints.Trace208;
    using SafeCast for uint256;

    error BurnDisabled();
    error CapExceeded();
    error ZeroInitialHolder();

    uint8 public constant D_DECIMALS = 8;
    uint256 public constant UNIT = 10 ** D_DECIMALS;
    uint256 public constant MAX_SUPPLY = 1000 * UNIT;
    uint256 public constant SEAT_THRESHOLD = 25 * UNIT / 10; // 2.5 D

    mapping(address account => Checkpoints.Trace208) private _balanceCheckpoints;
    Checkpoints.Trace208 private _totalBalanceCheckpoints;

    constructor(address initialHolder)
        ERC20("D", "D")
        ERC20Permit("D")
    {
        if (initialHolder == address(0)) revert ZeroInitialHolder();
        _mint(initialHolder, MAX_SUPPLY);
    }

    function decimals() public pure override returns (uint8) {
        return D_DECIMALS;
    }

    function hasSeat(address account) external view returns (bool) {
        return balanceOf(account) >= SEAT_THRESHOLD;
    }

    function hasVotingSeat(address account) external view returns (bool) {
        return getVotes(account) >= SEAT_THRESHOLD;
    }

    function getPastBalanceOf(address account, uint256 timepoint) external view returns (uint256) {
        return _balanceCheckpoints[account].upperLookupRecent(_validateTimepoint(timepoint));
    }

    function getPastTotalBalance(uint256 timepoint) external view returns (uint256) {
        return _totalBalanceCheckpoints.upperLookupRecent(_validateTimepoint(timepoint));
    }

    function _maxSupply() internal pure override returns (uint256) {
        return MAX_SUPPLY;
    }

    function _update(address from, address to, uint256 amount)
        internal
        override(ERC20, ERC20Votes)
    {
        if (from == address(0) && totalSupply() + amount > MAX_SUPPLY) revert CapExceeded();
        super._update(from, to, amount);
        uint48 currentClock = clock();
        if (from != address(0)) {
            _balanceCheckpoints[from].push(currentClock, balanceOf(from).toUint208());
        }
        if (to != address(0) && to != from) {
            _balanceCheckpoints[to].push(currentClock, balanceOf(to).toUint208());
        }
        if (from == address(0) || to == address(0)) {
            _totalBalanceCheckpoints.push(currentClock, totalSupply().toUint208());
        }
    }

    function nonces(address owner)
        public
        view
        override(ERC20Permit, Nonces)
        returns (uint256)
    {
        return super.nonces(owner);
    }
}
