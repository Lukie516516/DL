// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {DealDividendVault} from "../contracts/DealDividendVault.sol";
import {ERC1967Proxy} from "../contracts/TestProxy.sol";

contract DividendAuditDC is ERC20 {
    constructor() ERC20("Audit DealCoin", "ADC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract DividendAuditD {
    uint48 public clock = 2;
    uint256 private _pastTotal;
    mapping(address account => uint256 balance) private _pastBalances;

    function setPastTotal(uint256 value) external {
        _pastTotal = value;
    }

    function setPastBalance(address account, uint256 value) external {
        _pastBalances[account] = value;
    }

    function getPastBalanceOf(address account, uint256) external view returns (uint256) {
        return _pastBalances[account];
    }

    function getPastTotalBalance(uint256) external view returns (uint256) {
        return _pastTotal;
    }
}

/**
 * Security properties for the dividend accounting that complement the
 * end-to-end Hardhat and mainnet-fork suites.
 */
contract DaoTreasuryModulesSecurityTest is Test {
    uint256 private constant D_UNIT = 1e18;
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA201);

    DividendAuditD private d;
    DividendAuditDC private dc;
    DealDividendVault private vault;
    mapping(address account => uint256 staked) private _pastStaked;

    function setUp() public {
        d = new DividendAuditD();
        dc = new DividendAuditDC();
        DealDividendVault implementation = new DealDividendVault();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(
                DealDividendVault.initialize,
                (address(d), address(dc), address(this))
            )
        );
        vault = DealDividendVault(address(proxy));
    }

    function getPastStakedOf(address account, uint256) external view returns (uint256) {
        return _pastStaked[account];
    }

    function testFuzz_allEligibleWeightConservesRoundAndReleasesDust(
        uint96 rawA,
        uint96 rawB,
        uint96 rawC,
        uint128 rawRoundTotal,
        uint8 rawOrder
    ) public {
        uint256 weightA = bound(uint256(rawA), D_UNIT, 40 * D_UNIT);
        uint256 weightB = bound(uint256(rawB), D_UNIT, 40 * D_UNIT);
        uint256 weightC = bound(uint256(rawC), D_UNIT, 40 * D_UNIT);
        uint256 totalWeight = weightA + weightB + weightC;
        uint256 roundTotal = bound(uint256(rawRoundTotal), D_UNIT, 1e30);

        _setWeight(ALICE, weightA);
        _setWeight(BOB, weightB);
        _setWeight(CAROL, weightC);
        d.setPastTotal(totalWeight);
        dc.mint(address(vault), roundTotal);
        vault.createRound(roundTotal);

        address[3] memory order = _claimOrder(rawOrder % 6);
        for (uint256 i; i < order.length; ++i) {
            vm.prank(order[i]);
            vault.claim(0);
        }

        DealDividendVault.Round memory round = vault.getRound(0);
        assertEq(round.claimed, roundTotal, "all round DC must be claimable");
        assertEq(round.claimedWeight, totalWeight, "all eligible D weight must be consumed");
        assertEq(vault.reservedUnclaimed(), 0, "no reserved dust after final weight claims");
        assertEq(dc.balanceOf(address(vault)), 0, "vault must not retain allocated dust");
        assertEq(
            dc.balanceOf(ALICE) + dc.balanceOf(BOB) + dc.balanceOf(CAROL),
            roundTotal,
            "claim payouts must conserve the funded round"
        );
    }

    function test_untrackedDAtGovernanceGetsNoClaimAndLeavesItsShareReserved() public {
        uint256 trackedWeight = 90 * D_UNIT;
        uint256 ignoredDirectTransferWeight = 10 * D_UNIT;
        uint256 roundTotal = 1_000 * D_UNIT;
        _setWeight(ALICE, trackedWeight);
        d.setPastTotal(trackedWeight + ignoredDirectTransferWeight);
        dc.mint(address(vault), roundTotal);
        vault.createRound(roundTotal);

        vm.prank(ALICE);
        vault.claim(0);

        assertEq(dc.balanceOf(ALICE), 900 * D_UNIT);
        assertEq(vault.reservedUnclaimed(), 100 * D_UNIT);
        vm.prank(address(this));
        vm.expectRevert(DealDividendVault.GovernanceCustodyCannotClaim.selector);
        vault.claim(0);
    }

    function _setWeight(address account, uint256 totalWeight) private {
        uint256 walletWeight = totalWeight / 2;
        d.setPastBalance(account, walletWeight);
        _pastStaked[account] = totalWeight - walletWeight;
    }

    function _claimOrder(uint8 orderIndex) private pure returns (address[3] memory order) {
        if (orderIndex == 0) return [ALICE, BOB, CAROL];
        if (orderIndex == 1) return [ALICE, CAROL, BOB];
        if (orderIndex == 2) return [BOB, ALICE, CAROL];
        if (orderIndex == 3) return [BOB, CAROL, ALICE];
        if (orderIndex == 4) return [CAROL, ALICE, BOB];
        return [CAROL, BOB, ALICE];
    }
}
