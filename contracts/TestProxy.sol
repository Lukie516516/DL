// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC1967Proxy as _ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @dev Thin wrapper so Hardhat generates a named artifact for use in tests.
contract ERC1967Proxy is _ERC1967Proxy {
    constructor(address impl, bytes memory data) _ERC1967Proxy(impl, data) {}
}
