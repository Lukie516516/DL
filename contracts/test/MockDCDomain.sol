// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Minimal IDCDomain stub for unit tests only.
contract MockDCDomain {
    mapping(string => uint256) public tokenIds;
    mapping(uint256 => address) public owners;
    uint256 private _next = 1;

    function register(string calldata name, address owner_) external returns (uint256 id) {
        if (tokenIds[name] != 0) return tokenIds[name]; // idempotent
        id = _next++;
        tokenIds[name] = id;
        owners[id] = owner_;
    }

    function tokenIdOf(string calldata name) external view returns (uint256) {
        uint256 id = tokenIds[name];
        require(id != 0, "MockDCDomain: not registered");
        return id;
    }

    function isRegistered(string calldata name) external view returns (bool) {
        return tokenIds[name] != 0;
    }

    function ownerOf(uint256 id) external view returns (address) {
        return owners[id];
    }
}
