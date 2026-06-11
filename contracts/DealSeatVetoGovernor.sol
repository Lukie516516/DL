// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC6372} from "@openzeppelin/contracts/interfaces/IERC6372.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IDSeatToken is IERC6372 {
    function SEAT_THRESHOLD() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function getPastBalanceOf(address account, uint256 timepoint) external view returns (uint256);
}

interface INftVetoRegistry {
    function registerProposal(uint256 proposalId, uint64 vetoDeadline) external;
    function isProposalVetoed(uint256 proposalId) external view returns (bool);
}

contract DealSeatVetoGovernor is ReentrancyGuard {
    error NotSeat();
    error BadArrayLength();
    error BadWindow();
    error ProposalMissing();
    error AlreadyVetoed();
    error AlreadyExecuted();
    error VetoWindowOpen();
    error VetoWindowClosed();
    error OnlyGovernance();
    error CallFailed(uint256 index, bytes returndata);

    enum ProposalKind {
        Regular,
        Major
    }

    enum ProposalState {
        Missing,
        Active,
        Vetoed,
        Succeeded,
        Executed
    }

    struct Proposal {
        address proposer;
        uint48 snapshot;
        uint48 vetoDeadline;
        ProposalKind kind;
        bool vetoed;
        bool executed;
        address vetoer;
        bytes32 actionsHash;
        string description;
    }

    IDSeatToken public immutable dToken;
    INftVetoRegistry public nftVetoRegistry;
    uint48 public constant MIN_VETO_WINDOW = 1 hours;
    uint48 public constant MAX_VETO_WINDOW = 30 days;
    uint48 public regularVetoWindow = 48 hours;
    uint48 public majorVetoWindow = 120 hours;

    uint256 public proposalCount;

    mapping(uint256 proposalId => Proposal) private _proposals;
    mapping(uint256 proposalId => address[]) private _targets;
    mapping(uint256 proposalId => uint256[]) private _values;
    mapping(uint256 proposalId => bytes[]) private _calldatas;

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        ProposalKind indexed kind,
        uint48 snapshot,
        uint48 vetoDeadline,
        bytes32 actionsHash,
        string description
    );
    event ProposalVetoed(uint256 indexed proposalId, address indexed vetoer);
    event ProposalExecuted(uint256 indexed proposalId);
    event VetoWindowsUpdated(uint48 regularVetoWindow, uint48 majorVetoWindow);
    event NftVetoRegistryUpdated(address indexed registry);

    constructor(address _dToken, address _nftVetoRegistry) {
        require(_dToken != address(0), "ZERO_D");
        dToken = IDSeatToken(_dToken);
        nftVetoRegistry = INftVetoRegistry(_nftVetoRegistry);
    }

    receive() external payable {}

    function setVetoWindows(uint48 regularWindow, uint48 majorWindow) external {
        if (msg.sender != address(this)) revert OnlyGovernance();
        _checkWindow(regularWindow);
        _checkWindow(majorWindow);
        regularVetoWindow = regularWindow;
        majorVetoWindow = majorWindow;
        emit VetoWindowsUpdated(regularWindow, majorWindow);
    }

    function setNftVetoRegistry(address registry) external {
        if (msg.sender != address(this)) revert OnlyGovernance();
        nftVetoRegistry = INftVetoRegistry(registry);
        emit NftVetoRegistryUpdated(registry);
    }

    function propose(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas,
        string calldata description,
        ProposalKind kind
    ) external returns (uint256 proposalId) {
        if (targets.length == 0 || targets.length != values.length || targets.length != calldatas.length) {
            revert BadArrayLength();
        }

        uint48 snapshot = _snapshot();
        _requirePastSeat(msg.sender, snapshot);

        uint48 window = kind == ProposalKind.Regular ? regularVetoWindow : majorVetoWindow;
        uint48 vetoDeadline = uint48(block.timestamp) + window;
        bytes32 actionsHash = keccak256(abi.encode(targets, values, calldatas));

        proposalId = ++proposalCount;
        Proposal storage p = _proposals[proposalId];
        p.proposer = msg.sender;
        p.snapshot = snapshot;
        p.vetoDeadline = vetoDeadline;
        p.kind = kind;
        p.actionsHash = actionsHash;
        p.description = description;

        _targets[proposalId] = targets;
        _values[proposalId] = values;
        _calldatas[proposalId] = calldatas;

        if (kind == ProposalKind.Major && address(nftVetoRegistry) != address(0)) {
            nftVetoRegistry.registerProposal(proposalId, vetoDeadline);
        }

        emit ProposalCreated(proposalId, msg.sender, kind, snapshot, vetoDeadline, actionsHash, description);
    }

    function veto(uint256 proposalId) external {
        Proposal storage p = _existingProposal(proposalId);
        if (p.executed) revert AlreadyExecuted();
        if (p.vetoed) revert AlreadyVetoed();
        if (block.timestamp >= p.vetoDeadline) revert VetoWindowClosed();

        _requirePastSeat(msg.sender, p.snapshot);
        p.vetoed = true;
        p.vetoer = msg.sender;
        emit ProposalVetoed(proposalId, msg.sender);
    }

    function execute(uint256 proposalId) external payable nonReentrant {
        Proposal storage p = _existingProposal(proposalId);
        if (p.executed) revert AlreadyExecuted();
        if (_isVetoed(p, proposalId)) revert AlreadyVetoed();
        if (block.timestamp <= p.vetoDeadline) revert VetoWindowOpen();

        _requireCurrentSeat(msg.sender);
        p.executed = true;

        address[] storage targets = _targets[proposalId];
        uint256[] storage values = _values[proposalId];
        bytes[] storage calldatas = _calldatas[proposalId];
        for (uint256 i = 0; i < targets.length; ++i) {
            (bool ok, bytes memory ret) = targets[i].call{value: values[i]}(calldatas[i]);
            if (!ok) revert CallFailed(i, ret);
        }

        emit ProposalExecuted(proposalId);
    }

    function getProposal(uint256 proposalId) external view returns (Proposal memory) {
        return _proposals[proposalId];
    }

    function getActions(uint256 proposalId)
        external
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory calldatas)
    {
        return (_targets[proposalId], _values[proposalId], _calldatas[proposalId]);
    }

    function state(uint256 proposalId) public view returns (ProposalState) {
        Proposal storage p = _proposals[proposalId];
        if (p.proposer == address(0)) return ProposalState.Missing;
        if (p.executed) return ProposalState.Executed;
        if (_isVetoed(p, proposalId)) return ProposalState.Vetoed;
        if (block.timestamp <= p.vetoDeadline) return ProposalState.Active;
        return ProposalState.Succeeded;
    }

    function _snapshot() private view returns (uint48) {
        uint48 current = dToken.clock();
        return current == 0 ? 0 : current - 1;
    }

    function _requireCurrentSeat(address account) private view {
        if (dToken.balanceOf(account) < dToken.SEAT_THRESHOLD()) revert NotSeat();
    }

    function _requirePastSeat(address account, uint48 snapshot) private view {
        if (dToken.getPastBalanceOf(account, snapshot) < dToken.SEAT_THRESHOLD()) revert NotSeat();
    }

    function _existingProposal(uint256 proposalId) private view returns (Proposal storage p) {
        p = _proposals[proposalId];
        if (p.proposer == address(0)) revert ProposalMissing();
    }

    function _isVetoed(Proposal storage p, uint256 proposalId) private view returns (bool) {
        if (p.vetoed) return true;
        if (p.kind != ProposalKind.Major) return false;
        INftVetoRegistry registry = nftVetoRegistry;
        return address(registry) != address(0) && registry.isProposalVetoed(proposalId);
    }

    function _checkWindow(uint48 window) private pure {
        if (window < MIN_VETO_WINDOW || window > MAX_VETO_WINDOW) revert BadWindow();
    }
}
