// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev Deal / DealOpenTokenToken / 外提库共用，保证 revert 选择器一致
error DealError(uint16 code);
