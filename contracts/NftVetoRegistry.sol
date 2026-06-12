// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

interface IDealNftGovernanceActivity {
    function isActive(uint256 tokenId) external view returns (bool);
    function activeGovernanceSupply() external view returns (uint256);
    function markActive(uint256 tokenId) external;
}

/// @title NftVetoRegistry
/// @notice Tracks DealInfoNFT veto votes for Major governance proposals.
///
/// Model: NFT holders cast VETO votes. If ≥ 10 % of the active-NFT snapshot
/// has voted to veto, the proposal is considered blocked and cannot be executed.
///
/// Rules:
///   - Only active official DealInfoNFT holders may vote.
///   - 1 tokenId = 1 veto vote; NFT is NOT locked.
///   - Veto votes are retractable at any time before execute().
///   - isProposalVetoed() re-validates ownership on each call; votes by addresses
///     that have since transferred their NFT are silently discounted.
///   - The active supply snapshot is taken when the proposal first crosses the
///     2.5 D activation threshold (registerProposal called by governance).
contract NftVetoRegistry is Ownable {
    uint256 public constant BPS                = 10_000;
    /// @dev 10 % of active-supply snapshot must veto to block a Major proposal.
    uint256 public constant VETO_THRESHOLD_BPS = 1_000;

    IERC721                    public immutable infoNft;
    IDealNftGovernanceActivity public immutable activity;

    /// @notice Addresses allowed to call registerProposal (i.e. governance contracts).
    mapping(address => bool) public isGovernor;

    struct ProposalVeto {
        uint256 activeSupplySnapshot; // active NFT count at registration time
        bool    exists;
        uint64  vetoCutoff;           // veto window close timestamp; castVeto rejected after this
    }

    mapping(uint256 => ProposalVeto)                    private _proposals;
    // proposalId => tokenId => address that cast the veto (address(0) = not voted / retracted)
    mapping(uint256 => mapping(uint256 => address))     public  vetoOwner;
    // All tokenIds that have ever voted on a proposal (for iteration)
    mapping(uint256 => uint256[])                       private _votedTokenIds;
    // proposalId => tokenId => whether ever added to _votedTokenIds (prevents duplicate push on cast→retract→cast)
    mapping(uint256 => mapping(uint256 => bool))        private _inVotedList;

    // ─── Events ───────────────────────────────────────────────────────────────

    event GovernorSet(address indexed governor, bool allowed);
    event ProposalRegistered(uint256 indexed proposalId, uint256 activeSupplySnapshot);
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

    /// @notice Called by DealGovernance when a Major proposal crosses the 2.5 D
    ///         activation threshold. Snapshots the current active NFT supply.
    function registerProposal(uint256 proposalId, uint64 vetoCutoff) external onlyGovernor {
        ProposalVeto storage pv = _proposals[proposalId];
        if (pv.exists) revert ProposalExists();
        pv.exists               = true;
        pv.activeSupplySnapshot = activity.activeGovernanceSupply();
        pv.vetoCutoff           = vetoCutoff;
        emit ProposalRegistered(proposalId, pv.activeSupplySnapshot);
    }

    // ─── Voting ───────────────────────────────────────────────────────────────

    /// @notice Cast a veto vote with an active official DealInfoNFT.
    ///         Marks the token as governance-active, extending its active window.
    function castVeto(uint256 proposalId, uint256 tokenId) external {
        ProposalVeto storage pv = _existingProposal(proposalId);
        require(pv.vetoCutoff == 0 || block.timestamp <= pv.vetoCutoff, "NftVetoRegistry: veto window closed");
        if (infoNft.ownerOf(tokenId) != msg.sender)        revert NotTokenOwner();
        if (!activity.isActive(tokenId))                   revert InactiveToken();
        if (vetoOwner[proposalId][tokenId] != address(0))  revert AlreadyVoted();

        vetoOwner[proposalId][tokenId] = msg.sender;
        if (!_inVotedList[proposalId][tokenId]) {
            _votedTokenIds[proposalId].push(tokenId);
            _inVotedList[proposalId][tokenId] = true;
        }
        activity.markActive(tokenId);

        emit VetoCast(proposalId, tokenId, msg.sender);
    }

    /// @notice Retract a previously cast veto vote.
    function retractVeto(uint256 proposalId, uint256 tokenId) external {
        _existingProposal(proposalId);
        address voter = vetoOwner[proposalId][tokenId];
        if (voter == address(0)) revert NotVoted();
        if (voter != msg.sender) revert NotTokenOwner();

        vetoOwner[proposalId][tokenId] = address(0);
        emit VetoRetracted(proposalId, tokenId, msg.sender);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice Returns true when valid veto votes ≥ 10 % of the active-supply snapshot.
    ///         Re-verifies current NFT ownership on every call; transferred NFTs
    ///         whose original voter hasn't retracted are discounted automatically.
    ///         Called by DealGovernance.execute() for Major proposals.
    function isProposalVetoed(uint256 proposalId) public view returns (bool) {
        ProposalVeto storage pv = _proposals[proposalId];
        if (!pv.exists || pv.activeSupplySnapshot == 0) return false;
        uint256 valid = _countValidVetos(proposalId);
        return valid * BPS >= pv.activeSupplySnapshot * VETO_THRESHOLD_BPS;
    }

    /// @notice Returns (validVetoCount, activeSupplySnapshot) for a proposal.
    function vetoCount(uint256 proposalId)
        external view returns (uint256 valid, uint256 snapshot)
    {
        ProposalVeto storage pv = _proposals[proposalId];
        valid    = pv.exists ? _countValidVetos(proposalId) : 0;
        snapshot = pv.activeSupplySnapshot;
    }

    function proposalInfo(uint256 proposalId) external view returns (ProposalVeto memory) {
        return _proposals[proposalId];
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _countValidVetos(uint256 proposalId) private view returns (uint256 count) {
        uint256[] storage tokenIds = _votedTokenIds[proposalId];
        for (uint256 i = 0; i < tokenIds.length; ++i) {
            uint256 tid   = tokenIds[i];
            address voter = vetoOwner[proposalId][tid];
            if (voter == address(0)) continue; // retracted
            try infoNft.ownerOf(tid) returns (address current) {
                if (current == voter) ++count;
            } catch {}
        }
    }

    function _existingProposal(uint256 proposalId)
        private view returns (ProposalVeto storage pv)
    {
        pv = _proposals[proposalId];
        if (!pv.exists) revert ProposalMissing();
        return pv;
    }
}
