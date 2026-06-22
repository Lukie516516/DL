// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

interface IDTokenGov {
    function balanceOf(address account) external view returns (uint256);
    function clock() external view returns (uint48);
}

interface INftVetoRegistryGov {
    /// @notice Called on Major proposal activation; snapshots active NFT supply.
    function registerProposal(uint256 proposalId, uint64 vetoCutoff, uint256 thresholdBps) external;
    /// @notice Returns true when >= VETO_THRESHOLD_BPS of active NFTs cast veto votes.
    function isProposalVetoed(uint256 proposalId) external view returns (bool);
}

/// @title DealGovernance
/// @notice Stake-based governance for the Deal protocol.
///
/// Four proposal kinds:
///   Parameter – D-only, 24h default-pass window. D seat veto (Pending or Active) → rejected.
///               70 D fast-approve → immediate pass before window closes.
///   Treasury  – D-only, accumulation (70 D). No veto. Multi-chain.
///   Major     – Anyone proposes; 120h default-pass window. D seat veto (Pending or Active) OR 10% NFT veto → rejected.
///               70 D fast-approve → immediate pass before window closes.
///   Satoshi   – D seat only; accumulation (90 D); no time limit; free unstake; D seat veto.
///
/// All proposals require 2.5 D staked to activate (pre-proposal gate).
/// D is physically transferred on stake; each staker calls claimBack() individually after end.
/// DAO governance parameters are mutable via Major proposal (onlyGovernance setters).
contract DealGovernance is Initializable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;
    using SafeCast for uint256;

    // ─── Errors ───────────────────────────────────────────────────────────────

    error BadArrayLength();
    error ProposalMissing();
    error AlreadyEnded();
    error AlreadyExecuted();
    error NotProposer();
    error NotExecutable();
    error CannotVetoTreasury();
    error NotSeat();
    error ZeroAmount();
    error InsufficientStake();
    error OnlyGovernance();
    error NotSatoshiEligible();
    error WindowNotOpen();
    error WindowExpired();
    error NothingToClaim();
    error ParamOutOfRange();
    error AlreadyApproved();
    error CallFailed(uint256 index, bytes returndata);

    // ─── Types ────────────────────────────────────────────────────────────────

    enum ProposalKind { Parameter, Treasury, Major, Satoshi }

    /// Missing   : proposal id does not exist
    /// Pending   : exists but totalStaked < activationThreshold
    /// Active    : activated; within window (Parameter/Major) or below threshold (Treasury/Satoshi)
    /// Succeeded : executable — window closed without veto (Parameter/Major) or threshold met (Treasury/Satoshi)
    /// Vetoed    : D seat veto (Parameter/Major/Satoshi) or NFT veto threshold met (Major)
    /// Canceled  : proposer canceled, or expired via expire()
    /// Executed  : actions ran successfully
    enum ProposalState { Missing, Pending, Active, Succeeded, Vetoed, Canceled, Executed }

    // ─── Governance parameters (changeable via Major proposal) ────────────────

    /// @notice Minimum D stake to activate any proposal. Default: 2.5 D.
    uint256 public activationThreshold = 25 * 1e17;

    /// @notice D required to pass Treasury proposals. Default: 70 D.
    uint256 public treasuryPassThreshold = 70 * 1e18;

    /// @notice D required to pass Satoshi proposals. Default: 90 D.
    uint256 public satoshiPassThreshold = 90 * 1e18;

    /// @notice Veto window for Parameter proposals. Default: 24 hours.
    uint256 public paramWindowSeconds = 24 hours;

    /// @notice Veto window for Major proposals. Default: 120 hours.
    uint256 public majorWindowSeconds = 120 hours;

    /// @notice NFT veto threshold for Major proposals in basis points. Default: 1000 (10%).
    ///         Snapshotted into NftVetoRegistry at proposal activation; changes only affect future proposals.
    uint256 public nftVetoThresholdBps = 1_000;

    /// @notice DC fee charged to proposer when creating a Major proposal. Default: 1000 DC.
    uint256 public majorProposalFee = 1000 * 1e18;

    /// @notice D required for Parameter/Major fast-pass (bypass remaining veto window). Default: 70 D.
    uint256 public fastPassThreshold = 70 * 1e18;

    // ─── Immutables ───────────────────────────────────────────────────────────

    IDTokenGov public dToken;

    // ─── State ────────────────────────────────────────────────────────────────

    INftVetoRegistryGov public nftVetoRegistry;
    /// @notice DC token used to collect Major proposal fees.
    IERC20 public dcToken;
    /// @notice Destination address for Major proposal fees.
    address public treasury;
    uint256 public proposalCount;
    uint256 public activeProposalCount;
    uint256 public executedProposalCount;
    uint256 public todayProposalCount;
    uint256 public currentDayBucket;
    mapping(uint256 => bool) private _wasActivated;

    struct Proposal {
        address proposer;
        ProposalKind kind;
        uint256 totalStaked;
        uint256 windowEndsAt;     // Parameter/Major: veto window close timestamp; 0 = not activated
        bool vetoed;
        bool canceled;
        bool executed;
        bool nftRegistered;          // Major: registerProposal already called
        bool satoshiSucceeded;       // Satoshi: set once totalStaked first crosses satoshiPassThreshold
        bool activationReturnable;   // Major: set on activation; stakers may claimBack immediately
        address vetoer;
        bytes32 actionsHash;
        string description;
    }

    mapping(uint256 => Proposal)                          private _proposals;
    mapping(uint256 => address[])                         private _targets;
    mapping(uint256 => uint256[])                         private _values;
    mapping(uint256 => bytes[])                           private _calldatas;
    mapping(uint256 => address[])                         private _stakerList;
    mapping(uint256 => mapping(address => bool))          private _inStakerList;
    mapping(uint256 => mapping(address => uint256))       public  stakeOf;
    mapping(uint256 => uint256)                           public  approvalVotes;
    mapping(uint256 => mapping(address => bool))          private _hasApproved;
    mapping(uint256 => mapping(address => uint256))       public  vetoStakeOf;
    mapping(uint256 => uint256)                           public  totalVetoStaked;

    // Live cross-proposal staked total per address (dividend checkpointing).
    mapping(address => uint256)                           private _currentStaked;
    // Per-address checkpoint history — read by VoteDividendClaimer (Method B).
    mapping(address => Checkpoints.Trace208)              private _stakedCheckpoints;

    // ─── Events ───────────────────────────────────────────────────────────────

    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, ProposalKind indexed kind, string description, uint48 createdAt);
    event ProposalActivated(uint256 indexed proposalId, uint256 windowEndsAt);
    event SatoshiSucceeded(uint256 indexed proposalId);
    event Staked(uint256 indexed proposalId, address indexed staker, uint256 amount, uint256 proposalTotal);
    event Unstaked(uint256 indexed proposalId, address indexed staker, uint256 amount, uint256 proposalTotal);
    event StakeClaimed(uint256 indexed proposalId, address indexed staker, uint256 amount);
    event ProposalVetoed(uint256 indexed proposalId, address indexed vetoer);
    event VetoStaked(uint256 indexed proposalId, address indexed staker, uint256 amount, uint256 vetoTotal);
    event VetoStakeClaimed(uint256 indexed proposalId, address indexed staker, uint256 amount);
    event ProposalApproved(uint256 indexed proposalId, address indexed approver, uint256 totalApproval);
    event ProposalCanceled(uint256 indexed proposalId);
    event ProposalExecuted(uint256 indexed proposalId);
    event NftVetoRegistryUpdated(address indexed registry);
    event GovernanceParamUpdated(string indexed param, uint256 oldValue, uint256 newValue);

    // ─── Constructor ──────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address dToken_, address nftVetoRegistry_, address dcToken_, address treasury_) external initializer {
        require(dToken_ != address(0), "ZERO_D");
        require(dcToken_ != address(0), "ZERO_DC");
        require(treasury_ != address(0), "ZERO_TREASURY");
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        dToken = IDTokenGov(dToken_);
        // nftVetoRegistry defaults to address(0) — NFT veto is disabled until DAO enables it
        if (nftVetoRegistry_ != address(0)) {
            nftVetoRegistry = INftVetoRegistryGov(nftVetoRegistry_);
        }
        dcToken  = IERC20(dcToken_);
        treasury = treasury_;
        // Inline initializers don't apply through UUPS proxy storage — set all defaults here.
        activationThreshold   = 25 * 1e17;      // 2.5 D
        treasuryPassThreshold = 70 * 1e18;       // 70 D
        satoshiPassThreshold  = 90 * 1e18;       // 90 D
        paramWindowSeconds    = 24 hours;
        majorWindowSeconds    = 120 hours;
        nftVetoThresholdBps   = 1_000;           // 10%
        majorProposalFee      = 1000 * 1e18;     // 1000 DC
        fastPassThreshold     = 70 * 1e18;       // 70 D
    }

    function _authorizeUpgrade(address) internal override {
        if (msg.sender != address(this)) revert OnlyGovernance();
    }

    receive() external payable {}

    // ─── Governance self-config (only via a passed proposal) ─────────────────

    modifier onlyGovernance() {
        if (msg.sender != address(this)) revert OnlyGovernance();
        _;
    }

    function rescueETH(address payable to, uint256 amount) external onlyGovernance {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "ETH_SEND_FAIL");
    }

    function setNftVetoRegistry(address registry) external onlyGovernance {
        nftVetoRegistry = INftVetoRegistryGov(registry);
        emit NftVetoRegistryUpdated(registry);
    }

    function setActivationThreshold(uint256 v) external onlyGovernance {
        if (v == 0) revert ParamOutOfRange();
        emit GovernanceParamUpdated("activationThreshold", activationThreshold, v);
        activationThreshold = v;
    }

    function setTreasuryPassThreshold(uint256 v) external onlyGovernance {
        if (v == 0) revert ParamOutOfRange();
        emit GovernanceParamUpdated("treasuryPassThreshold", treasuryPassThreshold, v);
        treasuryPassThreshold = v;
    }

    function setSatoshiPassThreshold(uint256 v) external onlyGovernance {
        if (v == 0) revert ParamOutOfRange();
        emit GovernanceParamUpdated("satoshiPassThreshold", satoshiPassThreshold, v);
        satoshiPassThreshold = v;
    }

    function setParamWindowSeconds(uint256 v) external onlyGovernance {
        if (v < 1 hours) revert ParamOutOfRange();
        emit GovernanceParamUpdated("paramWindowSeconds", paramWindowSeconds, v);
        paramWindowSeconds = v;
    }

    function setMajorWindowSeconds(uint256 v) external onlyGovernance {
        if (v < 1 hours) revert ParamOutOfRange();
        emit GovernanceParamUpdated("majorWindowSeconds", majorWindowSeconds, v);
        majorWindowSeconds = v;
    }

    function setMajorProposalFee(uint256 v) external onlyGovernance {
        emit GovernanceParamUpdated("majorProposalFee", majorProposalFee, v);
        majorProposalFee = v;
    }

    function setDcToken(address v) external onlyGovernance {
        require(v != address(0), "ZERO_DC");
        dcToken = IERC20(v);
    }

    function setTreasury(address v) external onlyGovernance {
        require(v != address(0), "ZERO_TREASURY");
        treasury = v;
    }

    function setNftVetoThresholdBps(uint256 v) external onlyGovernance {
        if (v > 10_000) revert ParamOutOfRange();
        emit GovernanceParamUpdated("nftVetoThresholdBps", nftVetoThresholdBps, v);
        nftVetoThresholdBps = v;
    }

    function setFastPassThreshold(uint256 v) external onlyGovernance {
        if (v == 0 || v > 100 * 1e18) revert ParamOutOfRange();
        emit GovernanceParamUpdated("fastPassThreshold", fastPassThreshold, v);
        fastPassThreshold = v;
    }

    // ─── Proposal creation ────────────────────────────────────────────────────

    /// @notice Create a proposal.
    ///         Parameter / Satoshi: restricted to D seat holders (wallet balance >= activationThreshold).
    ///         Treasury / Major: anyone may create.
    function createProposal(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas,
        string  calldata description,
        ProposalKind kind
    ) external returns (uint256 proposalId) {
        if (targets.length == 0 || targets.length != values.length || targets.length != calldatas.length)
            revert BadArrayLength();

        if (kind == ProposalKind.Parameter || kind == ProposalKind.Satoshi) {
            if (IERC20(address(dToken)).balanceOf(msg.sender) < activationThreshold)
                revert NotSatoshiEligible();
        }

        if (kind == ProposalKind.Major && majorProposalFee > 0) {
            require(address(dcToken) != address(0) && treasury != address(0), "DealGovernance: fee not configured");
            dcToken.safeTransferFrom(msg.sender, treasury, majorProposalFee);
        }

        proposalId = ++proposalCount;
        Proposal storage p = _proposals[proposalId];
        p.proposer    = msg.sender;
        p.kind        = kind;
        p.actionsHash = keccak256(abi.encode(targets, values, calldatas));
        p.description = description;

        _targets[proposalId]   = targets;
        _values[proposalId]    = values;
        _calldatas[proposalId] = calldatas;

        uint256 dayBucket = block.timestamp / 86400;
        if (dayBucket != currentDayBucket) {
            currentDayBucket = dayBucket;
            todayProposalCount = 0;
        }
        ++todayProposalCount;

        emit ProposalCreated(proposalId, msg.sender, kind, description, uint48(block.timestamp));
    }

    // ─── Staking ──────────────────────────────────────────────────────────────

    /// @notice Stake D to support a proposal (= cast a vote).
    ///         Crossing activationThreshold for the first time starts the veto window
    ///         (Parameter/Major) or marks the proposal Active (Treasury/Satoshi).
    ///         For Satoshi, crossing satoshiPassThreshold sets satoshiSucceeded permanently.
    function stake(uint256 proposalId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Proposal storage p = _existingProposal(proposalId);
        _requireNotEnded(p);

        // ── Effects ──────────────────────────────────────────────────────────
        if (!_inStakerList[proposalId][msg.sender]) {
            _stakerList[proposalId].push(msg.sender);
            _inStakerList[proposalId][msg.sender] = true;
        }
        stakeOf[proposalId][msg.sender] += amount;

        uint256 prevTotal = p.totalStaked;
        p.totalStaked += amount;

        _currentStaked[msg.sender] += amount;
        _checkpointStaked(msg.sender);

        bool justActivated = false;
        if (prevTotal < activationThreshold && p.totalStaked >= activationThreshold) {
            uint256 window = _windowFor(p.kind);
            if (window > 0) {
                // Guard: only set windowEndsAt on FIRST threshold crossing.
                // Without this, a staker could do 1-wei unstake/re-stake to reset
                // the veto window indefinitely, preventing proposal execution.
                if (p.windowEndsAt == 0) {
                    p.windowEndsAt = block.timestamp + window;
                    justActivated = true;
                }
            } else {
                justActivated = true; // Treasury / Satoshi: no window
            }
            if (p.kind == ProposalKind.Major && !p.nftRegistered) p.nftRegistered = true;
        }

        bool justPassed = false;
        if (p.kind == ProposalKind.Satoshi && !p.satoshiSucceeded && p.totalStaked >= satoshiPassThreshold) {
            p.satoshiSucceeded = true;
            justPassed = true;
        }

        // ── Interactions ─────────────────────────────────────────────────────
        IERC20(address(dToken)).safeTransferFrom(msg.sender, address(this), amount);

        if (justActivated) {
            ++activeProposalCount;
            _wasActivated[proposalId] = true;
            emit ProposalActivated(proposalId, p.windowEndsAt);
            if (p.kind == ProposalKind.Major) {
                p.activationReturnable = true;
                if (address(nftVetoRegistry) != address(0)) {
                    nftVetoRegistry.registerProposal(proposalId, uint64(p.windowEndsAt), nftVetoThresholdBps);
                }
            }
        }
        if (justPassed) emit SatoshiSucceeded(proposalId);

        emit Staked(proposalId, msg.sender, amount, p.totalStaked);
    }

    /// @notice Retract your D stake (change of vote / change of mind).
    ///
    ///   Parameter / Major:  only while the veto window is still open
    ///                       (or before activation, when windowEndsAt == 0).
    ///                       Stake is locked once the window closes.
    ///   Treasury:           any time while proposal not ended.
    ///   Satoshi:            any time while proposal not ended (free unstake by design).
    ///                       Note: satoshiSucceeded is irreversible once set; unstake
    ///                       cannot un-pass a Satoshi proposal.
    function unstake(uint256 proposalId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Proposal storage p = _existingProposal(proposalId);
        _requireNotEnded(p);
        if (stakeOf[proposalId][msg.sender] < amount) revert InsufficientStake();

        if (p.kind == ProposalKind.Parameter || p.kind == ProposalKind.Major) {
            if (p.windowEndsAt > 0 && block.timestamp >= p.windowEndsAt) revert WindowExpired();
            // Lock stakes once fast-pass threshold is reached; unstaking would de-activate execution.
            if (approvalVotes[proposalId] >= fastPassThreshold) revert WindowExpired();
        }

        stakeOf[proposalId][msg.sender] -= amount;
        p.totalStaked -= amount;
        _currentStaked[msg.sender] -= amount;
        _checkpointStaked(msg.sender);

        IERC20(address(dToken)).safeTransfer(msg.sender, amount);
        emit Unstaked(proposalId, msg.sender, amount, p.totalStaked);
    }

    /// @notice Retrieve staked D after a proposal has ended (executed / vetoed / canceled).
    ///         Returns both support stake (stake()) and collective veto stake (vetoStake()) in one call.
    ///         D is never auto-returned; each staker calls this individually.
    function claimBack(uint256 proposalId) external nonReentrant {
        Proposal storage p = _existingProposal(proposalId);
        if (!_isEnded(p) && !p.activationReturnable) revert NotExecutable();

        uint256 support = stakeOf[proposalId][msg.sender];
        uint256 vetoAmt = vetoStakeOf[proposalId][msg.sender];
        uint256 total   = support + vetoAmt;
        if (total == 0) revert NothingToClaim();

        if (support > 0) {
            stakeOf[proposalId][msg.sender] = 0;
            emit StakeClaimed(proposalId, msg.sender, support);
        }
        if (vetoAmt > 0) {
            vetoStakeOf[proposalId][msg.sender] = 0;
            totalVetoStaked[proposalId] -= vetoAmt;
            emit VetoStakeClaimed(proposalId, msg.sender, vetoAmt);
        }
        _currentStaked[msg.sender] -= total;
        _checkpointStaked(msg.sender);

        IERC20(address(dToken)).safeTransfer(msg.sender, total);
    }

    // ─── Veto (D seat — Parameter / Major / Satoshi) ──────────────────────────

    /// @notice D seat holder (wallet balance >= activationThreshold) exercises one-time veto.
    ///         Treasury proposals cannot be vetoed.
    ///         Parameter / Major: veto allowed during Pending OR while window is open.
    ///         Satoshi: veto can be cast at any time before execution.
    function veto(uint256 proposalId) external nonReentrant {
        Proposal storage p = _existingProposal(proposalId);
        if (p.kind == ProposalKind.Treasury) revert CannotVetoTreasury();
        _requireNotEnded(p);
        if (IERC20(address(dToken)).balanceOf(msg.sender) < activationThreshold) revert NotSeat();

        if (p.kind == ProposalKind.Parameter || p.kind == ProposalKind.Major) {
            // Allow veto during Pending (windowEndsAt == 0) OR within the open window.
            if (p.windowEndsAt != 0 && block.timestamp >= p.windowEndsAt) revert WindowExpired();
        }

        if (_wasActivated[proposalId]) --activeProposalCount;
        p.vetoed = true;
        p.vetoer = msg.sender;
        emit ProposalVetoed(proposalId, msg.sender);
    }

    // ─── Collective veto (Parameter / Major / Satoshi) ───────────────────────

    /// @notice Contributes D tokens toward a collective veto.
    ///         D is physically locked; when cumulative contributions >= activationThreshold
    ///         the proposal is immediately vetoed.
    ///         Use veto() instead if your wallet balance already >= activationThreshold (no lock needed).
    ///         Retrieve locked D with claimBack() after the proposal ends.
    function vetoStake(uint256 proposalId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Proposal storage p = _existingProposal(proposalId);
        if (p.kind == ProposalKind.Treasury) revert CannotVetoTreasury();
        _requireNotEnded(p);

        if (p.kind == ProposalKind.Parameter || p.kind == ProposalKind.Major) {
            if (p.windowEndsAt != 0 && block.timestamp >= p.windowEndsAt) revert WindowExpired();
        }

        IERC20(address(dToken)).safeTransferFrom(msg.sender, address(this), amount);
        vetoStakeOf[proposalId][msg.sender] += amount;
        uint256 newTotal = totalVetoStaked[proposalId] + amount;
        totalVetoStaked[proposalId] = newTotal;
        _currentStaked[msg.sender] += amount;
        _checkpointStaked(msg.sender);
        emit VetoStaked(proposalId, msg.sender, amount, newTotal);

        if (newTotal >= activationThreshold) {
            if (_wasActivated[proposalId]) --activeProposalCount;
            p.vetoed = true;
            p.vetoer = msg.sender;
            emit ProposalVetoed(proposalId, msg.sender);
        }
    }

    // ─── Fast-pass approval (Parameter / Major) ──────────────────────────────

    /// @notice D seat holder explicitly approves a Parameter or Major proposal.
    ///         Accumulates approval weight by caller's current D balance.
    ///         Once total approval >= fastPassThreshold the proposal is immediately executable,
    ///         bypassing the remaining veto window.
    ///         Proposal must already be Active (activationThreshold reached).
    function approve(uint256 proposalId) external nonReentrant {
        Proposal storage p = _existingProposal(proposalId);
        if (p.kind != ProposalKind.Parameter && p.kind != ProposalKind.Major) revert NotExecutable();
        _requireNotEnded(p);
        if (p.totalStaked < activationThreshold) revert WindowNotOpen();
        if (p.windowEndsAt != 0 && block.timestamp >= p.windowEndsAt) revert WindowExpired();
        uint256 dBal = IERC20(address(dToken)).balanceOf(msg.sender);
        if (dBal == 0) revert ZeroAmount();
        if (_hasApproved[proposalId][msg.sender]) revert AlreadyApproved();
        if (approvalVotes[proposalId] >= fastPassThreshold) revert AlreadyEnded();

        _hasApproved[proposalId][msg.sender] = true;
        approvalVotes[proposalId] += dBal;
        emit ProposalApproved(proposalId, msg.sender, approvalVotes[proposalId]);
    }

    // ─── Cancel (proposer only) ───────────────────────────────────────────────

    /// @notice Proposer cancels their proposal before execution.
    ///         Stakers call claimBack() to retrieve D afterward.
    function cancel(uint256 proposalId) external nonReentrant {
        Proposal storage p = _existingProposal(proposalId);
        if (p.proposer != msg.sender) revert NotProposer();
        _requireNotEnded(p);
        if (_canExecute(p, proposalId)) revert AlreadyEnded();
        if (_wasActivated[proposalId]) --activeProposalCount;
        p.canceled = true;
        emit ProposalCanceled(proposalId);
    }

    // ─── Expire (public safety valve) ────────────────────────────────────────

    /// @notice Anyone may expire a Parameter/Major proposal whose window closed more than
    ///         7 days ago but was never executed (e.g. activationThreshold raised afterward).
    ///         Marks as canceled so stakers can call claimBack().
    function expire(uint256 proposalId) external nonReentrant {
        Proposal storage p = _existingProposal(proposalId);
        _requireNotEnded(p);
        if (p.kind != ProposalKind.Parameter && p.kind != ProposalKind.Major) revert NotExecutable();
        if (p.windowEndsAt == 0 || block.timestamp <= p.windowEndsAt + 7 days) revert NotExecutable();
        if (_wasActivated[proposalId]) --activeProposalCount;
        p.canceled = true;
        emit ProposalCanceled(proposalId);
    }

    // ─── Execute ──────────────────────────────────────────────────────────────

    /// @notice Execute a Succeeded proposal. Anyone may call.
    ///         If any action reverts the whole tx reverts (proposal stays Succeeded, retry allowed).
    ///         After success, stakers call claimBack() to retrieve their D.
    function execute(uint256 proposalId) external payable nonReentrant {
        Proposal storage p = _existingProposal(proposalId);
        _requireNotEnded(p);
        if (!_canExecute(p, proposalId)) revert NotExecutable();

        p.executed = true;
        if (_wasActivated[proposalId]) --activeProposalCount;
        ++executedProposalCount;

        address[] storage targets   = _targets[proposalId];
        uint256[] storage vals      = _values[proposalId];
        bytes[]   storage calldatas = _calldatas[proposalId];
        for (uint256 i = 0; i < targets.length; ++i) {
            (bool ok, bytes memory ret) = targets[i].call{value: vals[i]}(calldatas[i]);
            if (!ok) revert CallFailed(i, ret);
        }

        emit ProposalExecuted(proposalId);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function state(uint256 proposalId) public view returns (ProposalState) {
        Proposal storage p = _proposals[proposalId];
        if (p.proposer == address(0))            return ProposalState.Missing;
        if (p.executed)                          return ProposalState.Executed;
        if (p.vetoed)                            return ProposalState.Vetoed;
        if (p.canceled)                          return ProposalState.Canceled;
        if (_canExecute(p, proposalId))          return ProposalState.Succeeded;
        if (p.totalStaked < activationThreshold) return ProposalState.Pending;
        return ProposalState.Active;
    }

    function getProposal(uint256 proposalId) external view returns (Proposal memory) {
        return _proposals[proposalId];
    }

    function getProposals(uint256 offset, uint256 limit)
        external view returns (Proposal[] memory page, uint256 total)
    {
        total = proposalCount;
        if (offset >= total) return (new Proposal[](0), total);
        uint256 n = total - offset < limit ? total - offset : limit;
        page = new Proposal[](n);
        for (uint256 i; i < n; ) {
            page[i] = _proposals[offset + 1 + i];
            unchecked { ++i; }
        }
    }

    function getActions(uint256 proposalId)
        external view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory calldatas)
    {
        return (_targets[proposalId], _values[proposalId], _calldatas[proposalId]);
    }

    function getStakerList(uint256 proposalId) external view returns (address[] memory) {
        return _stakerList[proposalId];
    }

    /// @notice Total D currently staked by an address across all live proposals.
    function currentStakedOf(address account) external view returns (uint256) {
        return _currentStaked[account];
    }

    /// @notice Historical staked D at a past timepoint — called by VoteDividendClaimer (Method B).
    function getPastStakedOf(address account, uint256 timepoint) external view returns (uint256) {
        return _stakedCheckpoints[account].upperLookupRecent(uint48(timepoint));
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _canExecute(Proposal storage p, uint256 proposalId) private view returns (bool) {
        // Satoshi: once satoshiSucceeded is set it is permanent; free-unstake cannot block execution.
        if (p.kind == ProposalKind.Satoshi) return p.satoshiSucceeded;

        if (p.totalStaked < activationThreshold) return false;

        if (p.kind == ProposalKind.Parameter) {
            // Fast-pass: enough D explicitly approved
            if (approvalVotes[proposalId] >= fastPassThreshold) return true;
            // Default-pass: window closed, no D veto
            return p.windowEndsAt > 0 && block.timestamp >= p.windowEndsAt;
        }

        if (p.kind == ProposalKind.Treasury) {
            // Accumulation: 70 D staked
            return p.totalStaked >= treasuryPassThreshold;
        }

        if (p.kind == ProposalKind.Major) {
            // Fast-pass: enough D explicitly approved (bypasses remaining window)
            if (approvalVotes[proposalId] >= fastPassThreshold) return true;
            // Default-pass: window closed, no D veto, NFT veto threshold not reached
            if (p.windowEndsAt == 0 || block.timestamp < p.windowEndsAt) return false;
            if (address(nftVetoRegistry) != address(0) &&
                nftVetoRegistry.isProposalVetoed(proposalId)) return false;
            return true;
        }

        return false;
    }

    function _windowFor(ProposalKind kind) private view returns (uint256) {
        if (kind == ProposalKind.Parameter) return paramWindowSeconds;
        if (kind == ProposalKind.Major)     return majorWindowSeconds;
        return 0; // Treasury and Satoshi: no veto window
    }

    function _isEnded(Proposal storage p) private view returns (bool) {
        return p.executed || p.vetoed || p.canceled;
    }

    function _requireNotEnded(Proposal storage p) private view {
        if (p.executed) revert AlreadyExecuted();
        if (p.vetoed)   revert AlreadyEnded();
        if (p.canceled) revert AlreadyEnded();
    }

    function _checkpointStaked(address account) private {
        uint48 ts = dToken.clock();
        _stakedCheckpoints[account].push(ts, _currentStaked[account].toUint208());
    }

    function _existingProposal(uint256 proposalId) private view returns (Proposal storage p) {
        p = _proposals[proposalId];
        if (p.proposer == address(0)) revert ProposalMissing();
    }
}
