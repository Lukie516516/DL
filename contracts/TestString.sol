// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract GovHelper {
    // 把描述字符串转成 bytes32 的 descriptionHash
    function hashDescription(string memory desc) external pure returns (bytes32) {
        return keccak256(bytes(desc));
    }
}
