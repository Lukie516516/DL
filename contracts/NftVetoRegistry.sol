// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

interface IDealInfoNftOwnerSnapshot is IERC721 {
    function ownerOfAt(uint256 tokenId, uint256 blockNumber) external view returns (address);
}

interface IDealNftGovernanceActivity {
    function isActive(uint256 tokenId) external view returns (bool);
    function activeGovernanceSupply() external view returns (uint256);
    function markActive(uint256 tokenId) external;
}

contract NftVetoRegistry is Ownable {
    uint256 public constant BPS = 10_000;
    uint256 public constant MIN_VETO_THRESHOLD_BPS = 500; // 5%
    uint256 public constant MAX_VETO_THRESHOLD_BPS = 5_000; // 50%

    IDealInfoNftOwnerSnapshot public immutable infoNft;
    IDealNftGovernanceActivity public immutable activity;

    uint256 public nftVetoThresholdBps = 2_000; // 20%

    mapping(address governor => bool) public isGovernor;

    struct ProposalVeto {
        uint256 activeSupplySnapshot;
        uint48 snapshotBlock;
        uint64 vetoDeadline;
        uint256 vetoCount;
        bool exists;
        bool vetoed;
    }

    mapping(uint256 proposalId => ProposalVeto) private _proposals;
    mapping(uint256 proposalId => mapping(uint256 tokenId => bool)) public hasVetoed;

    event GovernorSet(address indexed governor, bool allowed);
    event VetoThresholdUpdated(uint256 thresholdBps);
    event ProposalRegistered(
        uint256 indexed proposalId,
        uint256 activeSupplySnapshot,
        uint48 snapshotBlock,
        uint64 vetoDeadline
    );
    event NftVetoCast(
        uint256 indexed proposalId,
        uint256 indexed tokenId,
        address indexed owner,
        uint256 vetoCount,
        uint256 activeSupplySnapshot,
        bool vetoed
    );

    error ZeroAddress();
    error NotGovernor();
    error BadThreshold();
    error ProposalMissing();
    error ProposalExists();
    error VetoClosed();
    error AlreadyVetoed();
    error NotTokenOwner();
    error InactiveToken();

    modifier onlyGovernor() {
        if (!isGovernor[msg.sender]) revert NotGovernor();
        _;
    }

    constructor(address infoNft_, address activity_) Ownable(msg.sender) {
        if (infoNft_ == address(0) || activity_ == address(0)) revert ZeroAddress();
        infoNft = IDealInfoNftOwnerSnapshot(infoNft_);
        activity = IDealNftGovernanceActivity(activity_);
    }

    function setGovernor(address governor, bool allowed) external onlyOwner {
        if (governor == address(0)) revert ZeroAddress();
        isGovernor[governor] = allowed;
        emit GovernorSet(governor, allowed);
    }

    function setVetoThresholdBps(uint256 thresholdBps) external onlyOwner {
        if (thresholdBps < MIN_VETO_THRESHOLD_BPS || thresholdBps > MAX_VETO_THRESHOLD_BPS) revert BadThreshold();
        nftVetoThresholdBps = thresholdBps;
        emit VetoThresholdUpdated(thresholdBps);
    }

    function registerProposal(uint256 proposalId, uint64 vetoDeadline) external onlyGovernor {
        ProposalVeto storage p = _proposals[proposalId];
        if (p.exists) revert ProposalExists();
        p.exists = true;
        p.vetoDeadline = vetoDeadline;
        p.snapshotBlock = uint48(block.number - 1);
        p.activeSupplySnapshot = activity.activeGovernanceSupply();
        emit ProposalRegistered(proposalId, p.activeSupplySnapshot, p.snapshotBlock, vetoDeadline);
    }

    function castVeto(uint256 proposalId, uint256 tokenId) external {
        ProposalVeto storage p = _existingProposal(proposalId);
        if (block.timestamp > p.vetoDeadline) revert VetoClosed();
        if (hasVetoed[proposalId][tokenId]) revert AlreadyVetoed();
        if (infoNft.ownerOfAt(tokenId, p.snapshotBlock) != msg.sender) revert NotTokenOwner();
        if (!activity.isActive(tokenId)) revert InactiveToken();

        hasVetoed[proposalId][tokenId] = true;
        p.vetoCount += 1;
        p.vetoed = _reachesThreshold(p.vetoCount, p.activeSupplySnapshot);
        activity.markActive(tokenId);

        emit NftVetoCast(proposalId, tokenId, msg.sender, p.vetoCount, p.activeSupplySnapshot, p.vetoed);
    }

    function proposalVeto(uint256 proposalId) external view returns (ProposalVeto memory) {
        return _proposals[proposalId];
    }

    function isProposalVetoed(uint256 proposalId) public view returns (bool) {
        return _proposals[proposalId].vetoed;
    }

    function thresholdVotes(uint256 proposalId) external view returns (uint256) {
        ProposalVeto storage p = _proposals[proposalId];
        if (!p.exists || p.activeSupplySnapshot == 0) return 0;
        return (p.activeSupplySnapshot * nftVetoThresholdBps + BPS - 1) / BPS;
    }

    function _existingProposal(uint256 proposalId) private view returns (ProposalVeto storage p) {
        p = _proposals[proposalId];
        if (!p.exists) revert ProposalMissing();
    }

    function _reachesThreshold(uint256 vetoCount, uint256 activeSupplySnapshot) private view returns (bool) {
        return activeSupplySnapshot != 0 && vetoCount * BPS >= activeSupplySnapshot * nftVetoThresholdBps;
    }
}
