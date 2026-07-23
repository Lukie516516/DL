// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC6372} from "@openzeppelin/contracts/interfaces/IERC6372.sol";

interface IDealDividendSnapshotToken is IERC6372 {
    function getPastBalanceOf(address account, uint256 timepoint) external view returns (uint256);
    function getPastTotalBalance(uint256 timepoint) external view returns (uint256);
}

interface IDealDividendGovernanceStaked {
    function getPastStakedOf(address account, uint256 timepoint) external view returns (uint256);
}

/// @title DealDividendVault
/// @notice Dedicated pull-claim DC dividend vault for D holders on Ethereum.
/// @dev Deployed behind ERC1967Proxy. DC must be transferred in before governance creates a round.
contract DealDividendVault is Initializable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    IDealDividendSnapshotToken public dToken;
    IERC20 public dealCoin;
    address public governance;

    struct Round {
        uint48 snapshot;
        uint256 total;
        uint256 claimed;
        uint256 totalWeight;
        uint256 claimedWeight;
    }

    Round[] public rounds;
    mapping(uint256 roundId => mapping(address account => bool)) public claimed;
    uint256 public reservedUnclaimed;

    event RoundCreated(uint256 indexed roundId, uint48 snapshot, uint256 total, uint256 totalWeight);
    event Claimed(
        uint256 indexed roundId,
        address indexed account,
        uint256 walletBalance,
        uint256 governanceStaked,
        uint256 payout
    );

    error NotGovernance();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientUnallocatedDC(uint256 available, uint256 requested);
    error AlreadyClaimed();
    error RoundNotActive();
    error NoDBalance();
    error ZeroTotalSupply();
    error ZeroPayout();
    error ClaimedWeightExceeded();
    error GovernanceCustodyCannotClaim();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address dToken_, address dealCoin_, address governance_) external initializer {
        if (dToken_ == address(0) || dealCoin_ == address(0) || governance_ == address(0)) {
            revert ZeroAddress();
        }
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        dToken = IDealDividendSnapshotToken(dToken_);
        dealCoin = IERC20(dealCoin_);
        governance = governance_;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    /// @notice Creates a DC dividend round from funds already held by this vault.
    function createRound(uint256 total) external onlyGovernance {
        if (total == 0) revert ZeroAmount();
        uint256 balance = dealCoin.balanceOf(address(this));
        uint256 available = balance > reservedUnclaimed ? balance - reservedUnclaimed : 0;
        if (total > available) revert InsufficientUnallocatedDC(available, total);

        uint48 current = dToken.clock();
        uint48 snapshot = current == 0 ? 0 : current - 1;
        uint256 totalWeight = dToken.getPastTotalBalance(snapshot);
        if (totalWeight == 0) revert ZeroTotalSupply();
        reservedUnclaimed += total;
        rounds.push(
            Round({
                snapshot: snapshot,
                total: total,
                claimed: 0,
                totalWeight: totalWeight,
                claimedWeight: 0
            })
        );
        emit RoundCreated(rounds.length - 1, snapshot, total, totalWeight);
    }

    /// @notice Claims the caller's DC share. Each account can claim once per round.
    function claim(uint256 roundId) external nonReentrant {
        if (msg.sender == governance) revert GovernanceCustodyCannotClaim();
        Round storage round = rounds[roundId];
        if (claimed[roundId][msg.sender]) revert AlreadyClaimed();
        if (round.snapshot >= dToken.clock()) revert RoundNotActive();

        uint256 walletBalance = dToken.getPastBalanceOf(msg.sender, round.snapshot);
        uint256 governanceStaked =
            IDealDividendGovernanceStaked(governance).getPastStakedOf(msg.sender, round.snapshot);
        uint256 eligibleBalance = walletBalance + governanceStaked;
        if (eligibleBalance == 0) revert NoDBalance();

        uint256 remainingWeight = round.totalWeight - round.claimedWeight;
        if (eligibleBalance > remainingWeight) revert ClaimedWeightExceeded();
        uint256 payout = eligibleBalance == remainingWeight
            ? round.total - round.claimed
            : Math.mulDiv(eligibleBalance, round.total, round.totalWeight);
        if (payout == 0) revert ZeroPayout();

        claimed[roundId][msg.sender] = true;
        round.claimed += payout;
        round.claimedWeight += eligibleBalance;
        reservedUnclaimed -= payout;
        dealCoin.safeTransfer(msg.sender, payout);
        emit Claimed(roundId, msg.sender, walletBalance, governanceStaked, payout);
    }

    function roundsCount() external view returns (uint256) {
        return rounds.length;
    }

    function getRound(uint256 roundId) external view returns (Round memory) {
        return rounds[roundId];
    }

    function unallocatedDC() external view returns (uint256) {
        uint256 balance = dealCoin.balanceOf(address(this));
        return balance > reservedUnclaimed ? balance - reservedUnclaimed : 0;
    }

    function previewClaim(uint256 roundId, address account)
        external
        view
        returns (uint256 walletBalance, uint256 governanceStaked, uint256 payout)
    {
        if (account == governance) return (0, 0, 0);
        Round storage round = rounds[roundId];
        if (round.snapshot >= dToken.clock()) return (0, 0, 0);
        walletBalance = dToken.getPastBalanceOf(account, round.snapshot);
        governanceStaked =
            IDealDividendGovernanceStaked(governance).getPastStakedOf(account, round.snapshot);
        if (claimed[roundId][account]) return (walletBalance, governanceStaked, 0);
        uint256 eligibleBalance = walletBalance + governanceStaked;
        if (eligibleBalance == 0) return (walletBalance, governanceStaked, 0);
        uint256 remainingWeight = round.totalWeight - round.claimedWeight;
        if (eligibleBalance > remainingWeight) return (walletBalance, governanceStaked, 0);
        payout = eligibleBalance == remainingWeight
            ? round.total - round.claimed
            : Math.mulDiv(eligibleBalance, round.total, round.totalWeight);
    }

    function _authorizeUpgrade(address) internal override onlyGovernance {}

    uint256[44] private __gap;
}
