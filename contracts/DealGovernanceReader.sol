// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {DealGovernance} from "./DealGovernance.sol";

/// @title DealGovernanceReader
/// @notice Read-only aggregation layer for DAO proposal list and detail pages.
/// @dev This contract never writes to DealGovernance and never holds tokens. Its purpose is to
///      collapse the frontend's N+1 RPC calls into one eth_call with a stable, typed response.
contract DealGovernanceReader {
    uint256 public constant MAX_PAGE_SIZE = 50;
    uint256 public constant MAX_STATE_BATCH_SIZE = 100;

    DealGovernance public immutable governance;

    error ZeroGovernance();
    error GovernanceHasNoCode();
    error InvalidPageLimit();
    error StateBatchTooLarge();

    struct ProposalView {
        uint256 proposalId;
        address proposer;
        uint8 kind;
        uint8 currentState;
        uint256 totalStaked;
        uint256 totalVetoStaked;
        uint256 accountStake;
        uint256 accountVetoStake;
        uint256 windowEndsAt;
        bool vetoed;
        bool canceled;
        bool executed;
        bool nftRegistered;
        bool satoshiSucceeded;
        bool activationReturnable;
        address vetoer;
        bytes32 actionsHash;
        string description;
    }

    struct GovernanceStats {
        uint256 proposalCount;
        uint256 activeProposalCount;
        uint256 executedProposalCount;
        uint256 todayProposalCount;
        uint256 activationThreshold;
        uint256 treasuryPassThreshold;
        uint256 satoshiPassThreshold;
        uint256 fastPassThreshold;
        uint256 paramWindowSeconds;
        uint256 majorWindowSeconds;
        uint256 majorProposalFee;
        uint256 nftVetoThresholdBps;
    }

    constructor(address governance_) {
        if (governance_ == address(0)) revert ZeroGovernance();
        if (governance_.code.length == 0) revert GovernanceHasNoCode();
        governance = DealGovernance(payable(governance_));
    }

    /// @notice Returns one proposal page and the total proposal count.
    /// @param account Optional wallet used to populate accountStake/accountVetoStake. Pass address(0) to skip them.
    /// @param offset Number of proposals skipped in the requested order.
    /// @param limit Page size, from 1 through MAX_PAGE_SIZE.
    /// @param newestFirst True for proposalCount -> 1, false for 1 -> proposalCount.
    function getProposalPage(address account, uint256 offset, uint256 limit, bool newestFirst)
        external
        view
        returns (ProposalView[] memory page, uint256 total)
    {
        if (limit == 0 || limit > MAX_PAGE_SIZE) revert InvalidPageLimit();

        total = governance.proposalCount();
        if (offset >= total) return (new ProposalView[](0), total);

        uint256 remaining = total - offset;
        uint256 length = remaining < limit ? remaining : limit;
        page = new ProposalView[](length);

        for (uint256 i; i < length; ) {
            uint256 proposalId = newestFirst ? total - offset - i : offset + i + 1;
            page[i] = _proposalView(proposalId, account);
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Returns the proposal summary, current state, account position and complete action arrays.
    /// @dev Use this on the detail page; action calldata is intentionally excluded from list pages.
    function getProposalDetail(uint256 proposalId, address account)
        external
        view
        returns (
            ProposalView memory proposal,
            address[] memory targets,
            uint256[] memory values,
            bytes[] memory calldatas
        )
    {
        proposal = _proposalView(proposalId, account);
        (targets, values, calldatas) = governance.getActions(proposalId);
    }

    /// @notice Lightweight state refresh for proposal cards already held by the frontend.
    function getProposalStates(uint256[] calldata proposalIds)
        external
        view
        returns (uint8[] memory states)
    {
        uint256 length = proposalIds.length;
        if (length > MAX_STATE_BATCH_SIZE) revert StateBatchTooLarge();

        states = new uint8[](length);
        for (uint256 i; i < length; ) {
            states[i] = uint8(governance.state(proposalIds[i]));
            unchecked {
                ++i;
            }
        }
    }

    /// @notice One-call DAO counters, thresholds, windows and Major proposal fee.
    function getGovernanceStats() external view returns (GovernanceStats memory stats) {
        uint256 dayBucket = block.timestamp / 1 days;
        uint256 todayCount = governance.currentDayBucket() == dayBucket
            ? governance.todayProposalCount()
            : 0;

        stats = GovernanceStats({
            proposalCount: governance.proposalCount(),
            activeProposalCount: governance.activeProposalCount(),
            executedProposalCount: governance.executedProposalCount(),
            todayProposalCount: todayCount,
            activationThreshold: governance.activationThreshold(),
            treasuryPassThreshold: governance.treasuryPassThreshold(),
            satoshiPassThreshold: governance.satoshiPassThreshold(),
            fastPassThreshold: governance.fastPassThreshold(),
            paramWindowSeconds: governance.paramWindowSeconds(),
            majorWindowSeconds: governance.majorWindowSeconds(),
            majorProposalFee: governance.majorProposalFee(),
            nftVetoThresholdBps: governance.nftVetoThresholdBps()
        });
    }

    function _proposalView(uint256 proposalId, address account)
        internal
        view
        returns (ProposalView memory result)
    {
        DealGovernance.Proposal memory proposal = governance.getProposal(proposalId);
        uint256 accountStake;
        uint256 accountVetoStake;
        if (account != address(0)) {
            accountStake = governance.stakeOf(proposalId, account);
            accountVetoStake = governance.vetoStakeOf(proposalId, account);
        }

        result = ProposalView({
            proposalId: proposalId,
            proposer: proposal.proposer,
            kind: uint8(proposal.kind),
            currentState: uint8(governance.state(proposalId)),
            totalStaked: proposal.totalStaked,
            totalVetoStaked: governance.totalVetoStaked(proposalId),
            accountStake: accountStake,
            accountVetoStake: accountVetoStake,
            windowEndsAt: proposal.windowEndsAt,
            vetoed: proposal.vetoed,
            canceled: proposal.canceled,
            executed: proposal.executed,
            nftRegistered: proposal.nftRegistered,
            satoshiSucceeded: proposal.satoshiSucceeded,
            activationReturnable: proposal.activationReturnable,
            vetoer: proposal.vetoer,
            actionsHash: proposal.actionsHash,
            description: proposal.description
        });
    }
}
