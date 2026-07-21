// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title GovernancePolicyRegistry
/// @notice Defines which target/selector combinations each proposal kind may execute.
/// @dev The governance proxy is the only account that can change rules after deployment.
contract GovernancePolicyRegistry {
    struct Rule {
        bool allowed;
        bool validateNestedBroadcast;
        bool nestedOnly;
        uint256 maxValue;
    }

    struct RuleInput {
        uint8 kind;
        address target;
        bytes4 selector;
        bool allowed;
        bool validateNestedBroadcast;
        bool nestedOnly;
        uint256 maxValue;
    }

    address public immutable governance;

    mapping(bytes32 => Rule) private _rules;

    event RuleUpdated(
        uint8 indexed kind,
        address indexed target,
        bytes4 indexed selector,
        bool allowed,
        bool validateNestedBroadcast,
        bool nestedOnly,
        uint256 maxValue
    );

    error OnlyGovernance();
    error ZeroAddress();

    constructor(address governance_, RuleInput[] memory initialRules) {
        if (governance_ == address(0)) revert ZeroAddress();
        governance = governance_;
        _setRules(initialRules);
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert OnlyGovernance();
        _;
    }

    function setRule(RuleInput calldata input) external onlyGovernance {
        _setRule(input);
    }

    function setRules(RuleInput[] calldata inputs) external onlyGovernance {
        uint256 length = inputs.length;
        for (uint256 i; i < length; ++i) {
            _setRule(inputs[i]);
        }
    }

    function getRule(uint8 kind, address target, bytes4 selector) external view returns (Rule memory) {
        return _rules[_key(kind, target, selector)];
    }

    /// @notice Checks an action and, for broadcaster rules, every nested remote action.
    function isActionAllowed(uint8 kind, address target, uint256 value, bytes calldata data)
        external
        view
        returns (bool)
    {
        if (data.length < 4) return false;
        bytes4 selector = bytes4(data[:4]);
        Rule memory rule = _rules[_key(kind, target, selector)];
        if (!rule.allowed || rule.nestedOnly || value > rule.maxValue) return false;
        if (!rule.validateNestedBroadcast) return true;

        (uint32[] memory chainIds, address[] memory targets, bytes memory innerData,) =
            abi.decode(data[4:], (uint32[], address[], bytes, uint128));
        if (chainIds.length == 0 || chainIds.length != targets.length || innerData.length < 4) return false;

        bytes4 innerSelector = _selector(innerData);
        uint256 length = targets.length;
        for (uint256 i; i < length; ++i) {
            if (targets[i] == address(0)) return false;
            Rule memory innerRule = _rules[_key(kind, targets[i], innerSelector)];
            if (!innerRule.allowed || !innerRule.nestedOnly || innerRule.validateNestedBroadcast) return false;
        }
        return true;
    }

    function _setRules(RuleInput[] memory inputs) private {
        uint256 length = inputs.length;
        for (uint256 i; i < length; ++i) {
            _setRule(inputs[i]);
        }
    }

    function _setRule(RuleInput memory input) private {
        _rules[_key(input.kind, input.target, input.selector)] = Rule({
            allowed: input.allowed,
            validateNestedBroadcast: input.validateNestedBroadcast,
            nestedOnly: input.nestedOnly,
            maxValue: input.maxValue
        });
        emit RuleUpdated(
            input.kind,
            input.target,
            input.selector,
            input.allowed,
            input.validateNestedBroadcast,
            input.nestedOnly,
            input.maxValue
        );
    }

    function _key(uint8 kind, address target, bytes4 selector) private pure returns (bytes32) {
        return keccak256(abi.encode(kind, target, selector));
    }

    function _selector(bytes memory data) private pure returns (bytes4 selector) {
        assembly ("memory-safe") {
            selector := mload(add(data, 0x20))
        }
    }
}
