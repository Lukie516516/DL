// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IDCDomainListSource {
    function totalDomains() external view returns (uint256);
    function tokenIdOf(string calldata domainName) external view returns (uint256);
    function domainLabelOf(uint256 tokenId) external view returns (string memory);
    function ownerOf(uint256 tokenId) external view returns (address);
    function resolve(string calldata domainName) external view returns (address);
    function creatorOf(uint256 tokenId) external view returns (address);
    function createdDomainCount(address creator) external view returns (uint256);
    function createdDomainTokenAt(address creator, uint256 index) external view returns (uint256);
}

interface IDCDomainListRank {
    function domainDealCount(string calldata domainName) external view returns (uint256);
    function domainTradeVolume(string calldata domainName) external view returns (uint256);
    function topDomainIdCount() external view returns (uint256);
    function getTopDomainIds(uint256 limit) external view returns (uint256[] memory);
}

/// @notice Read-only helper for domain list/search pages.
contract DCDomainListReader {
    uint256 public constant MAX_PAGE = 50;

    IDCDomainListSource public immutable dcDomain;
    IDCDomainListRank public immutable rank;

    struct DomainEntry {
        string domainName;
        uint256 tokenId;
        address owner;
        address creator;
        address resolved;
        uint256 tradeVolume;
        uint256 dealCount;
    }

    constructor(address dcDomain_, address rank_) {
        require(dcDomain_ != address(0) && rank_ != address(0), "ZERO_ADDR");
        dcDomain = IDCDomainListSource(dcDomain_);
        rank = IDCDomainListRank(rank_);
    }

    function _checkLimit(uint256 limit) internal pure {
        require(limit > 0 && limit <= MAX_PAGE, "DCDomainListReader: limit 1-50");
    }

    function _entry(uint256 tokenId) internal view returns (DomainEntry memory e) {
        string memory name = dcDomain.domainLabelOf(tokenId);
        e = DomainEntry({
            domainName: name,
            tokenId: tokenId,
            owner: dcDomain.ownerOf(tokenId),
            creator: dcDomain.creatorOf(tokenId),
            resolved: dcDomain.resolve(name),
            tradeVolume: rank.domainTradeVolume(name),
            dealCount: rank.domainDealCount(name)
        });
    }

    /// @notice Default domain list: top domains sorted by trade volume descending.
    function getDomainsByVolume(uint256 offset, uint256 limit)
        external
        view
        returns (DomainEntry[] memory page)
    {
        _checkLimit(limit);
        uint256 total = rank.topDomainIdCount();
        if (offset >= total) return new DomainEntry[](0);

        // Fetch all sorted IDs up to (offset + limit) in one call, then slice
        uint256 need = offset + limit;
        if (need > total) need = total;
        uint256[] memory ids = rank.getTopDomainIds(need);

        uint256 n = ids.length > offset ? ids.length - offset : 0;
        if (n > limit) n = limit;
        page = new DomainEntry[](n);
        for (uint256 i; i < n; ) {
            page[i] = _entry(ids[offset + i]);
            unchecked { ++i; }
        }
    }

    function getDomainByName(string calldata domainName)
        external
        view
        returns (bool exists, DomainEntry memory entry)
    {
        try dcDomain.tokenIdOf(domainName) returns (uint256 tokenId) {
            return (true, _entry(tokenId));
        } catch {
            return (false, entry);
        }
    }

    function getDomainById(uint256 tokenId)
        external
        view
        returns (bool exists, DomainEntry memory entry)
    {
        if (tokenId == 0 || tokenId > dcDomain.totalDomains()) return (false, entry);
        return (true, _entry(tokenId));
    }

    /// @notice Exact resolved-address search. Results are in tokenId (registration) order — O(n) scan.
    /// @dev A reverse-mapping from address→tokenIds in DCdomain would reduce this to O(k) where
    ///      k = number of domains resolving to `resolved`. For now O(n) is acceptable and safe.
    function getDomainsByResolve(address resolved, uint256 offset, uint256 limit)
        external
        view
        returns (DomainEntry[] memory page)
    {
        _checkLimit(limit);
        uint256 total = dcDomain.totalDomains();

        // First pass: count matches
        uint256 matched;
        for (uint256 i = 1; i <= total; ) {
            if (dcDomain.resolve(dcDomain.domainLabelOf(i)) == resolved) matched++;
            unchecked { ++i; }
        }
        if (offset >= matched) return new DomainEntry[](0);

        uint256 remaining = matched - offset;
        uint256 n = remaining < limit ? remaining : limit;
        page = new DomainEntry[](n);
        uint256 seen;
        uint256 k;
        for (uint256 i = 1; i <= total && k < n; ) {
            if (dcDomain.resolve(dcDomain.domainLabelOf(i)) == resolved) {
                if (seen >= offset) page[k++] = _entry(i);
                seen++;
            }
            unchecked { ++i; }
        }
    }

    /// @notice My current domains: filters by the current ERC721 owner. Results are in tokenId
    ///         (registration) order — O(n) scan.
    /// @dev A reverse-mapping from owner→tokenIds in DCdomain would reduce this to O(k) where
    ///      k = number of domains owned. For now O(n) is acceptable and safe.
    function getDomainsByOwner(address owner, uint256 offset, uint256 limit)
        external
        view
        returns (DomainEntry[] memory page)
    {
        _checkLimit(limit);
        uint256 total = dcDomain.totalDomains();

        // First pass: count matches
        uint256 matched;
        for (uint256 i = 1; i <= total; ) {
            if (dcDomain.ownerOf(i) == owner) matched++;
            unchecked { ++i; }
        }
        if (offset >= matched) return new DomainEntry[](0);

        uint256 remaining = matched - offset;
        uint256 n = remaining < limit ? remaining : limit;
        page = new DomainEntry[](n);
        uint256 seen;
        uint256 k;
        for (uint256 i = 1; i <= total && k < n; ) {
            if (dcDomain.ownerOf(i) == owner) {
                if (seen >= offset) page[k++] = _entry(i);
                seen++;
            }
            unchecked { ++i; }
        }
    }

    /// @notice My created domains: uses the creator index written when registering the domain.
    function getDomainsByCreator(address creator, uint256 offset, uint256 limit)
        external
        view
        returns (DomainEntry[] memory page)
    {
        _checkLimit(limit);
        uint256 total = dcDomain.createdDomainCount(creator);
        if (offset >= total) return new DomainEntry[](0);

        uint256 remaining = total - offset;
        uint256 n = remaining < limit ? remaining : limit;
        page = new DomainEntry[](n);
        for (uint256 i; i < n; ) {
            uint256 tokenId = dcDomain.createdDomainTokenAt(creator, offset + i);
            page[i] = _entry(tokenId);
            unchecked { ++i; }
        }
    }
}
