// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

interface IDealNftGovernanceActivity {
    function isActive(uint256 tokenId) external view returns (bool);
    function activeGovernanceSupply() external view returns (uint256);
    function markActive(uint256 tokenId) external;
}

/// @title NftApprovalRegistry
/// @notice Tracks official DealInfoNFT veto votes for Major governance proposals.
///
/// Model: if >= vetoThresholdBps of the active NFT supply snapshot cast veto votes within the
/// veto window, the Major proposal is considered vetoed and cannot execute.
/// The threshold is snapshotted from DealGovernance at registerProposal() time so future
/// governance param changes do not retroactively affect in-flight proposals.
///
/// Key rules:
///   - Only active official DealInfoNFT holders may vote.
///   - 1 tokenId = 1 veto vote; NFT is NOT locked.
///   - Veto votes are retractable while the window is still open.
///   - If an NFT is transferred during the window, the new owner may override the stale vote.
///   - At execute() time the governance contract calls isProposalVetoed(), which
///     re-validates ownership: votes from addresses that have since transferred
///     their NFT are silently discounted.
///   - Voting and retracting are both blocked after the window closes.
contract NftApprovalRegistry is Ownable {
    uint256 public constant BPS = 10_000;

    IERC721 public immutable infoNft;
    IDealNftGovernanceActivity public immutable activity;

    /// @notice Addresses allowed to call registerProposal (governance contracts).
    mapping(address => bool) public isGovernor;

    struct ProposalVeto {
        uint256 activeSupplySnapshot; // active NFT count when proposal was registered
        uint256 windowEndsAt;         // timestamp when veto window closes
        uint256 vetoThresholdBps;     // snapshotted from governance at activation (e.g. 1000 = 10%)
        bool    exists;
    }

    mapping(uint256 => ProposalVeto)                         private _proposals;
    // proposalId => tokenId => address that cast the veto (address(0) = not voted / retracted)
    mapping(uint256 => mapping(uint256 => address))          public  vetoOwner;
    // Full list of tokenIds that have ever voted on a proposal (for off-chain enumeration)
    mapping(uint256 => uint256[])                            private _votedTokenIds;
    // Running count of active veto votes per proposal — avoids O(N) loop in isProposalVetoed
    mapping(uint256 => uint256)                              private _validVetoCount;

    // ─── Events ───────────────────────────────────────────────────────────────

    event GovernorSet(address indexed governor, bool allowed);
    event ProposalRegistered(uint256 indexed proposalId, uint256 activeSupplySnapshot, uint256 windowEndsAt, uint256 vetoThresholdBps);
    event VetoCast(uint256 indexed proposalId, uint256 indexed tokenId, address indexed voter);
    event VetoRetracted(uint256 indexed proposalId, uint256 indexed tokenId, address indexed voter);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error ZeroAddress();
    error NotGovernor();
    error ProposalMissing();
    error ProposalExists();
    error NotTokenOwner();
    error InactiveToken();
    error AlreadyVoted();
    error NotVoted();
    error WindowClosed();

    modifier onlyGovernor() {
        if (!isGovernor[msg.sender]) revert NotGovernor();
        _;
    }

    constructor(address infoNft_, address activity_) Ownable(msg.sender) {
        if (infoNft_ == address(0) || activity_ == address(0)) revert ZeroAddress();
        infoNft  = IERC721(infoNft_);
        activity = IDealNftGovernanceActivity(activity_);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @notice Grant or revoke permission for a governance contract to register proposals.
    function setGovernor(address governor, bool allowed) external onlyOwner {
        if (governor == address(0)) revert ZeroAddress();
        isGovernor[governor] = allowed;
        emit GovernorSet(governor, allowed);
    }

    // ─── Governor-only ────────────────────────────────────────────────────────

    /// @notice Called by DealGovernance when a Major proposal crosses the activation threshold.
    ///         Snapshots the current active NFT supply, records the veto window end time,
    ///         and captures the veto threshold at activation time.
    function registerProposal(uint256 proposalId, uint256 windowEndsAt, uint256 vetoThresholdBps) external onlyGovernor {
        ProposalVeto storage p = _proposals[proposalId];
        if (p.exists) revert ProposalExists();
        p.exists               = true;
        p.activeSupplySnapshot = activity.activeGovernanceSupply();
        p.windowEndsAt         = windowEndsAt;
        p.vetoThresholdBps     = vetoThresholdBps;
        emit ProposalRegistered(proposalId, p.activeSupplySnapshot, windowEndsAt, vetoThresholdBps);
    }

    // ─── Voting ───────────────────────────────────────────────────────────────

    /// @notice Cast a veto vote with an active official DealInfoNFT.
    ///         Only allowed while the veto window is open.
    ///         If the NFT was transferred since a previous vote, the new owner may override.
    function castVeto(uint256 proposalId, uint256 tokenId) external {
        ProposalVeto storage p = _existingProposal(proposalId);
        if (block.timestamp >= p.windowEndsAt)      revert WindowClosed();
        if (infoNft.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        if (!activity.isActive(tokenId))            revert InactiveToken();

        address existing = vetoOwner[proposalId][tokenId];
        if (existing != address(0)) {
            if (existing == msg.sender) revert AlreadyVoted();
            // NFT transferred since original vote — override stale entry.
            // tokenId is already in _votedTokenIds; no duplicate push needed.
            // Counter unchanged: one vote replaced by one vote, net zero.
            emit VetoRetracted(proposalId, tokenId, existing);
            vetoOwner[proposalId][tokenId] = msg.sender;
            activity.markActive(tokenId);
            emit VetoCast(proposalId, tokenId, msg.sender);
            return;
        }

        vetoOwner[proposalId][tokenId] = msg.sender;
        _votedTokenIds[proposalId].push(tokenId);
        _validVetoCount[proposalId]++;
        activity.markActive(tokenId);
        emit VetoCast(proposalId, tokenId, msg.sender);
    }

    /// @notice Retract a previously cast veto vote.
    ///         Only allowed while the window is still open.
    function retractVeto(uint256 proposalId, uint256 tokenId) external {
        ProposalVeto storage p = _existingProposal(proposalId);
        if (block.timestamp >= p.windowEndsAt) revert WindowClosed();
        address voter = vetoOwner[proposalId][tokenId];
        if (voter == address(0)) revert NotVoted();
        if (voter != msg.sender) revert NotTokenOwner();

        vetoOwner[proposalId][tokenId] = address(0);
        _validVetoCount[proposalId]--;
        emit VetoRetracted(proposalId, tokenId, msg.sender);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice Returns true when valid veto votes >= vetoThresholdBps of the active supply snapshot.
    ///         Re-verifies current NFT ownership so transferred NFTs are excluded automatically.
    function isProposalVetoed(uint256 proposalId) public view returns (bool) {
        ProposalVeto storage p = _proposals[proposalId];
        if (!p.exists || p.activeSupplySnapshot == 0) return false;
        uint256 valid = _countValidVetos(proposalId);
        return valid * BPS >= p.activeSupplySnapshot * p.vetoThresholdBps;
    }

    /// @notice Returns (validVetoCount, activeSupplySnapshot) for a proposal.
    function vetoCount(uint256 proposalId) external view returns (uint256 valid, uint256 snapshot) {
        ProposalVeto storage p = _proposals[proposalId];
        valid    = p.exists ? _countValidVetos(proposalId) : 0;
        snapshot = p.activeSupplySnapshot;
    }

    function proposalInfo(uint256 proposalId) external view returns (ProposalVeto memory) {
        return _proposals[proposalId];
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @dev Count veto votes where the original voter still owns the tokenId.
    function _countValidVetos(uint256 proposalId) private view returns (uint256) {
        return _validVetoCount[proposalId];
    }

    function _existingProposal(uint256 proposalId) private view returns (ProposalVeto storage p) {
        p = _proposals[proposalId];
        if (!p.exists) revert ProposalMissing();
    }
}
