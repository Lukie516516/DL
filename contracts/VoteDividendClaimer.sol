// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC6372} from "@openzeppelin/contracts/interfaces/IERC6372.sol"; // 引入时钟接口

interface IDividendSnapshotToken is IERC6372 {
    function getPastBalanceOf(address account, uint256 timepoint) external view returns (uint256);
    function getPastTotalBalance(uint256 timepoint) external view returns (uint256);
}

interface INftGovernanceActivityRecorder {
    function markActive(uint256 tokenId) external;
}

contract VoteDividendClaimer is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// 分红权资产（D：按历史持仓快照分红，不按委托票权）
    IDividendSnapshotToken public immutable votesToken;
    /// EIP-6372 时钟（与 D 为同一地址）
    IERC6372 public immutable votesClock;
    /// 分红资产
    IERC20  public immutable dlc;
    /// 只有该地址可执行开轮（建议设为 DAO 执行合约）
    address public executor;
    /// 分红资金来源（treasury / DAO 分红金库），createRound 从这里拉取 DC。
    address public dividendSource;
    address public infoNft;
    address public governanceActivity;

    struct Round {
        uint48  snapshot;   // 快照 timepoint（与代币时钟一致：区块号或时间戳）
        uint256 total;      // 本轮 dlc 总额
        uint256 claimed;    // 全部地址累计已领取
    }
    Round[] public rounds;

    /// 防重复领取：roundId => account => claimed?
    mapping(uint256 => mapping(address => bool)) public claimed;

    // --------- events ---------
    event ExecutorUpdated(address indexed oldExec, address indexed newExec);
    event DividendSourceUpdated(address indexed oldSource, address indexed newSource);
    event GovernanceActivityUpdated(address indexed infoNft, address indexed activity);
    event RoundCreated(uint256 indexed roundId, uint48 snapshot, uint256 total);
    event Claimed(uint256 indexed roundId, address indexed account, uint256 balance, uint256 payout);

    modifier onlyExecutor() {
        require(msg.sender == executor, "NOT_EXECUTOR");
        _;
    }

    constructor(address _votesToken, address _dlc, address _executor, address _dividendSource) {
        require(
            _votesToken != address(0) &&
            _dlc != address(0) &&
            _executor != address(0) &&
            _dividendSource != address(0),
            "ZERO_ADDR"
        );
        votesToken = IDividendSnapshotToken(_votesToken);
        votesClock = IERC6372(_votesToken); // 同地址作为时钟
        dlc = IERC20(_dlc);
        executor = _executor;
        dividendSource = _dividendSource;
        emit ExecutorUpdated(address(0), _executor);
        emit DividendSourceUpdated(address(0), _dividendSource);
    }

    /// 治理迁移时更新执行者
    function setExecutor(address newExec) external onlyExecutor {
        require(newExec != address(0), "ZERO_ADDR");
        emit ExecutorUpdated(executor, newExec);
        executor = newExec;
    }

    function setDividendSource(address newSource) external onlyExecutor {
        require(newSource != address(0), "ZERO_ADDR");
        emit DividendSourceUpdated(dividendSource, newSource);
        dividendSource = newSource;
    }

    function setGovernanceActivity(address infoNft_, address activity_) external onlyExecutor {
        require(infoNft_ != address(0) && activity_ != address(0), "ZERO_ADDR");
        infoNft = infoNft_;
        governanceActivity = activity_;
        emit GovernanceActivityUpdated(infoNft_, activity_);
    }

    /// DAO / executor：开新一轮（记录“过去”的快照，避免与本交易同一 timepoint）
    /// 本函数从 dividendSource 拉取本轮 DC，提案人/执行人不需要用自己的钱出资。
    /// dividendSource 需要提前 approve 本合约，或由治理提案先完成授权。
    function createRound(uint256 total) external onlyExecutor {
        require(total > 0, "total=0");

        uint48 current = votesClock.clock();
        uint48 snapshot = current == 0 ? 0 : current - 1; // 关键：取过去的快照

        dlc.safeTransferFrom(dividendSource, address(this), total);

        rounds.push(Round({ snapshot: snapshot, total: total, claimed: 0 }));
        emit RoundCreated(rounds.length - 1, snapshot, total);
    }

    /// 用户：按 D 持仓快照领取（每地址一次）
    function claim(uint256 roundId) external nonReentrant {
        _claim(roundId, msg.sender);
    }

    function claimForNft(uint256 roundId, uint256 tokenId) external nonReentrant {
        address nft = infoNft;
        address activity = governanceActivity;
        require(nft != address(0) && activity != address(0), "ACTIVITY_NOT_SET");
        require(IERC721(nft).ownerOf(tokenId) == msg.sender, "NOT_NFT_OWNER");
        _claim(roundId, msg.sender);
        INftGovernanceActivityRecorder(activity).markActive(tokenId);
    }

    function _claim(uint256 roundId, address account) private {
        Round storage r = rounds[roundId];
        require(!claimed[roundId][account], "already claimed");
        require(r.snapshot < votesClock.clock(), "round not active yet"); // 快照必须在过去

        // 分子：快照持仓，不要求用户提前 delegate
        uint256 balance = votesToken.getPastBalanceOf(account, r.snapshot);
        require(balance > 0, "no balance at snapshot");

        // 分母：快照总 D 供应量
        uint256 totalSupplyAt = votesToken.getPastTotalBalance(r.snapshot);
        require(totalSupplyAt > 0, "totalSupply=0");

        // 向下取整
        uint256 payout = Math.mulDiv(balance, r.total, totalSupplyAt);
        require(payout > 0, "payout=0");

        // 防双花 & 不变量护栏
        claimed[roundId][account] = true;
        r.claimed += payout;
        require(r.claimed <= r.total, "over-claimed");

        dlc.safeTransfer(account, payout);
        emit Claimed(roundId, account, balance, payout);
    }

    // --------- 只读 ---------
    function roundsCount() external view returns (uint256) { return rounds.length; }
    function getRound(uint256 roundId) external view returns (Round memory) { return rounds[roundId]; }

    function previewClaim(uint256 roundId, address account)
        external view returns (uint256 balance, uint256 payout)
    {
        Round storage r = rounds[roundId];
        if (r.snapshot >= votesClock.clock()) return (0, 0); // 这轮尚未生效
        balance = votesToken.getPastBalanceOf(account, r.snapshot);
        if (balance == 0) return (0, 0);
        uint256 totalSupplyAt = votesToken.getPastTotalBalance(r.snapshot);
        if (totalSupplyAt == 0) return (balance, 0);
        payout = Math.mulDiv(balance, r.total, totalSupplyAt);
    }
}
