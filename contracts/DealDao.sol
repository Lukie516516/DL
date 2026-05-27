// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorCountingSimple} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {GovernorVotesQuorumFraction} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {GovernorTimelockControl} from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

contract DealGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    uint256 public constant D_SEAT_THRESHOLD = 2_500_000_000_000_000_000; // 2.5 D, D has 18 decimals

    constructor(IVotes token, TimelockController timelock)
        Governor("DealGovernor")
        GovernorSettings(1, 50400, D_SEAT_THRESHOLD)
        GovernorVotes(token)
        GovernorVotesQuorumFraction(20)
        GovernorTimelockControl(timelock)
    {}

    function votingDelay()
        public view
        override(Governor, GovernorSettings)
        returns (uint256)
    { return super.votingDelay(); }

    function votingPeriod()
        public view
        override(Governor, GovernorSettings)
        returns (uint256)
    { return super.votingPeriod(); }

    function proposalThreshold()
        public view
        override(Governor, GovernorSettings)
        returns (uint256)
    { return super.proposalThreshold(); }

    function quorum(uint256 timepoint)
        public view
        override(Governor, GovernorVotesQuorumFraction)
        returns (uint256)
    { return super.quorum(timepoint); }

    function state(uint256 proposalId)
        public view
        override(Governor, GovernorTimelockControl)
        returns (ProposalState)
    { return super.state(proposalId); }

    function proposalNeedsQueuing(uint256 proposalId)
        public view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    { return super.proposalNeedsQueuing(proposalId); }

    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    )
        internal
        override(Governor, GovernorTimelockControl)
        returns (uint48)
    { return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash); }

    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    )
        internal
        override(Governor, GovernorTimelockControl)
    { super._executeOperations(proposalId, targets, values, calldatas, descriptionHash); }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    )
        internal
        override(Governor, GovernorTimelockControl)
        returns (uint256)
    { return super._cancel(targets, values, calldatas, descriptionHash); }

    function _executor()
        internal view
        override(Governor, GovernorTimelockControl)
        returns (address)
    { return super._executor(); }
}
