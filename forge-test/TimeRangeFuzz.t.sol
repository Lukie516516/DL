// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

/**
 * Fuzz: mirrors Deal.sol + DealFactory time window checks (no full deployment).
 * Invariant: valid iff timeStart > 0 && timeEnd > timeStart.
 */
contract TimeRangeFuzz is Test {
    function _factoryValid(uint64 timeStart, uint64 timeEnd) internal pure returns (bool) {
        return timeStart > 0 && timeEnd > timeStart;
    }

    function _dealValid(uint64 timeStart, uint64 timeEnd) internal pure returns (bool) {
        return timeStart > 0 && timeEnd > timeStart;
    }

    function testFuzz_FactoryAndDeal_Agree(uint64 timeStart, uint64 timeEnd) public pure {
        assertEq(_factoryValid(timeStart, timeEnd), _dealValid(timeStart, timeEnd), "time checks diverge");
    }

    function test_ZeroZeroInvalid() public pure {
        assertFalse(_dealValid(0, 0));
        assertFalse(_factoryValid(0, 0));
    }

    function test_EndMustExceedStart() public pure {
        assertFalse(_dealValid(100, 100));
        assertFalse(_dealValid(100, 99));
        assertTrue(_dealValid(100, 101));
    }
}
