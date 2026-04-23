// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {DealMessageHub} from "../contracts/DealMessageHub.sol";

contract MockFactoryHub {
    mapping(address => bool) public isDeal;
    function set(address d, bool v) external {
        isDeal[d] = v;
    }
}

/**
 * Fuzz: hub stores message threads keyed by calling deal; sender array matches pushed values.
 */
contract DealMessageHubFuzz is Test {
    function testFuzz_MessagesAppend(uint8 n, bytes32 salt) public {
        vm.assume(n > 0 && n < 32);
        MockFactoryHub f = new MockFactoryHub();
        DealMessageHub hub = new DealMessageHub(address(f));
        address dealA = address(uint160(uint256(keccak256(abi.encode(salt, "deal")))));
        f.set(dealA, true);

        vm.startPrank(dealA);
        for (uint256 i = 0; i < n; i++) {
            hub.postFromDeal(address(uint160(100 + i)), string(abi.encodePacked("m", i)));
        }
        vm.stopPrank();

        assertEq(hub.messagesCount(dealA), uint256(n), "count");
        (string[] memory contents,, address[] memory senders) = hub.getMessages(dealA, 0, 256);
        assertEq(contents.length, uint256(n));
        for (uint256 j = 0; j < n; j++) {
            assertEq(senders[j], address(uint160(100 + j)));
            assertTrue(bytes(contents[j]).length > 0);
        }
    }

    function test_postFromDeal_revertsWhenCallerNotRegisteredDeal() public {
        MockFactoryHub f = new MockFactoryHub();
        DealMessageHub hub = new DealMessageHub(address(f));
        address rogue = address(uint160(uint256(keccak256("rogue"))));
        vm.prank(rogue);
        vm.expectRevert(DealMessageHub.NotDeal.selector);
        hub.postFromDeal(rogue, "nope");
    }

    function testFuzz_postFromDeal_revertsUnauthorized(address rogue, bytes32 salt) public {
        vm.assume(rogue != address(0));
        MockFactoryHub f = new MockFactoryHub();
        DealMessageHub hub = new DealMessageHub(address(f));
        address allowed = address(uint160(uint256(keccak256(abi.encode(salt, "ok")))));
        f.set(allowed, true);
        vm.assume(rogue != allowed);

        vm.prank(rogue);
        vm.expectRevert(DealMessageHub.NotDeal.selector);
        hub.postFromDeal(rogue, "x");
    }
}
