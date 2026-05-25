// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IDCDomainRankReaderSource {
    function MAX_LEADERBOARD() external view returns (uint256);
    function merchantOfDeal(string calldata domainName, address deal) external view returns (address);
    function isBlacklisted(string calldata domainName, address account) external view returns (bool);
    function rawDomainEntryCount(string calldata domainName) external view returns (uint256);
    function domainEntryAt(string calldata domainName, uint256 index)
        external
        view
        returns (address deal, address merchant);
    function dealScoreOf(string calldata domainName, address deal, address merchant) external view returns (uint256);
    function isDealVisible(string calldata domainName, address deal, address merchant) external view returns (bool);
    function myDealStatusOf(string calldata domainName, address deal, address merchant)
        external
        view
        returns (
            uint256 depositedDC,
            uint256 pendingConsume,
            uint256 totalConsumed,
            bool active,
            uint256 hoursRemaining,
            uint256 hourlyRate,
            uint256 percent,
            uint256 lastDepositAmount
        );
}

interface IDealStatusReaderView {
    function status() external view returns (uint8);
    function endedAt() external view returns (uint64);
}

/// @notice Read-only helper for domain deal search/detail so DCDomainRank stays small.
contract DCDomainRankReader {
    IDCDomainRankReaderSource public immutable rank;

    struct LeaderboardEntry {
        address merchant;
        address deal;
        uint256 score;
    }

    struct DomainStatusCounts {
        uint256 completed;
        uint256 inProgress;
        uint256 pending;
        uint256 failed;
        uint256 total;
    }

    constructor(address rank_) {
        require(rank_ != address(0), "ZERO_RANK");
        rank = IDCDomainRankReaderSource(rank_);
    }

    function _dealStatus(address deal) internal view returns (bool ok, uint8 s, uint64 ended) {
        try IDealStatusReaderView(deal).status() returns (uint8 status_) {
            ok = true;
            s = status_;
            try IDealStatusReaderView(deal).endedAt() returns (uint64 ended_) {
                ended = ended_;
            } catch {}
            return (ok, s, ended);
        } catch {
            return (false, 0, 0);
        }
    }

    function _buildSortedLeaderboard(string memory domainName)
        internal
        view
        returns (LeaderboardEntry[] memory buf)
    {
        uint256 total = rank.rawDomainEntryCount(domainName);
        uint256 visible;
        for (uint256 i; i < total; i++) {
            (address deal, address merchant) = rank.domainEntryAt(domainName, i);
            if (rank.isDealVisible(domainName, deal, merchant)) visible++;
        }

        buf = new LeaderboardEntry[](visible);
        uint256 k;
        for (uint256 i; i < total; i++) {
            (address deal, address merchant) = rank.domainEntryAt(domainName, i);
            if (!rank.isDealVisible(domainName, deal, merchant)) continue;
            buf[k++] = LeaderboardEntry({
                merchant: merchant,
                deal: deal,
                score: rank.dealScoreOf(domainName, deal, merchant)
            });
        }

        for (uint256 i; i < visible; i++) {
            for (uint256 j = i + 1; j < visible; j++) {
                if (buf[j].score > buf[i].score) {
                    (buf[i], buf[j]) = (buf[j], buf[i]);
                }
            }
        }
    }

    /// @notice Domain leaderboard: first `limit` visible deals sorted by consumed score.
    function getLeaderboard(string calldata domainName, uint256 limit)
        external
        view
        returns (LeaderboardEntry[] memory entries)
    {
        require(limit > 0 && limit <= rank.MAX_LEADERBOARD(), "DCDomainRankReader: limit 1-50");

        LeaderboardEntry[] memory buf = _buildSortedLeaderboard(domainName);
        uint256 total = buf.length;
        if (total == 0) return new LeaderboardEntry[](0);

        uint256 n = total < limit ? total : limit;
        entries = new LeaderboardEntry[](n);
        for (uint256 i; i < n; i++) {
            entries[i] = buf[i];
        }
    }

    /// @notice Domain leaderboard page sorted by consumed score.
    function getLeaderboard(string calldata domainName, uint256 offset, uint256 limit)
        external
        view
        returns (LeaderboardEntry[] memory entries)
    {
        require(limit > 0 && limit <= rank.MAX_LEADERBOARD(), "DCDomainRankReader: limit 1-50");

        LeaderboardEntry[] memory buf = _buildSortedLeaderboard(domainName);
        uint256 total = buf.length;
        if (offset >= total) return new LeaderboardEntry[](0);

        uint256 remaining = total - offset;
        uint256 n = remaining < limit ? remaining : limit;
        entries = new LeaderboardEntry[](n);
        for (uint256 i; i < n; i++) {
            entries[i] = buf[offset + i];
        }
    }

    function domainEntryCount(string calldata domainName) external view returns (uint256) {
        uint256 total = rank.rawDomainEntryCount(domainName);
        uint256 visible;
        for (uint256 i; i < total; i++) {
            (address deal, address merchant) = rank.domainEntryAt(domainName, i);
            if (rank.isDealVisible(domainName, deal, merchant)) visible++;
        }
        return visible;
    }

    /// @notice Count all domain deals by current deal status without returning the full list.
    /// pending=Ready, inProgress=Active/Locked, completed=Completed, failed=Canceled/Abandoned.
    function getDomainStatusCounts(string calldata domainName)
        external
        view
        returns (DomainStatusCounts memory counts)
    {
        uint256 total = rank.rawDomainEntryCount(domainName);
        counts.total = total;
        for (uint256 i; i < total; i++) {
            (address deal,) = rank.domainEntryAt(domainName, i);
            (bool ok, uint8 s,) = _dealStatus(deal);
            if (!ok) {
                counts.failed++;
            } else if (s == 0) {
                counts.pending++;
            } else if (s == 1 || s == 2) {
                counts.inProgress++;
            } else if (s == 3) {
                counts.completed++;
            } else {
                counts.failed++;
            }
        }
    }

    /// @notice Exact-address search/detail. Terminal deals hidden from the leaderboard remain searchable here.
    function getDomainDealInfo(string calldata domainName, address deal)
        external
        view
        returns (
            bool exists,
            address merchant,
            bool visible,
            uint8 dealStatus,
            uint64 dealEndedAt,
            uint256 depositedDC,
            uint256 pendingConsume,
            uint256 totalConsumed,
            bool active,
            uint256 hoursRemaining,
            uint256 hourlyRate,
            uint256 percent,
            uint256 lastDepositAmount
        )
    {
        merchant = rank.merchantOfDeal(domainName, deal);
        exists = merchant != address(0);
        (bool ok, uint8 s, uint64 ended) = _dealStatus(deal);
        dealStatus = ok ? s : type(uint8).max;
        dealEndedAt = ended;
        visible = exists && (!ok || s < 3) && !rank.isBlacklisted(domainName, merchant);

        if (exists) {
            (
                depositedDC,
                pendingConsume,
                totalConsumed,
                active,
                hoursRemaining,
                hourlyRate,
                percent,
                lastDepositAmount
            ) = rank.myDealStatusOf(domainName, deal, merchant);
        }
    }
}
