// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

contract DealNftGovernanceActivity is Ownable {
    IERC721 public immutable infoNft;

    uint256 public constant BUCKET_SIZE = 1 days;
    uint256 public constant MIN_ACTIVE_WINDOW = 30 days;
    uint256 public constant MAX_ACTIVE_WINDOW = 90 days;

    uint256 public activeWindowSeconds = 90 days;

    mapping(address recorder => bool) public isRecorder;
    mapping(uint256 tokenId => uint256) public lastActiveAt;
    mapping(uint256 tokenId => uint256) public lastActiveBucket;
    mapping(uint256 bucket => uint256) public activeCountByBucket;

    // Running count of NFTs currently inside the active window.
    // _drainedUpToBucket: all buckets strictly below this index have already
    // been subtracted from _activeTotalCount. Advances forward in _drainExpiredBuckets().
    uint256 private _activeTotalCount;
    uint256 private _drainedUpToBucket;

    event RecorderSet(address indexed recorder, bool allowed);
    event ActiveWindowUpdated(uint256 activeWindowSeconds);
    event TokenActivityRecorded(uint256 indexed tokenId, uint256 timestamp, address indexed recorder);

    error ZeroInfoNft();
    error NotRecorder();
    error BadActiveWindow();

    modifier onlyRecorder() {
        if (!isRecorder[msg.sender]) revert NotRecorder();
        _;
    }

    constructor(address infoNft_) Ownable(msg.sender) {
        if (infoNft_ == address(0)) revert ZeroInfoNft();
        infoNft = IERC721(infoNft_);
        _drainedUpToBucket = _computeDrainTarget();
    }

    function setRecorder(address recorder, bool allowed) external onlyOwner {
        isRecorder[recorder] = allowed;
        emit RecorderSet(recorder, allowed);
    }

    function setActiveWindowSeconds(uint256 value) external onlyOwner {
        if (value < MIN_ACTIVE_WINDOW || value > MAX_ACTIVE_WINDOW) revert BadActiveWindow();
        activeWindowSeconds = value;
        emit ActiveWindowUpdated(value);
    }

    function markActive(uint256 tokenId) external onlyRecorder {
        _markActive(tokenId);
    }

    function markActiveBatch(uint256[] calldata tokenIds) external onlyRecorder {
        for (uint256 i = 0; i < tokenIds.length; ++i) {
            _markActive(tokenIds[i]);
        }
    }

    function isActive(uint256 tokenId) public view returns (bool) {
        uint256 last = lastActiveAt[tokenId];
        return last != 0 && block.timestamp <= last + activeWindowSeconds;
    }

    /// @notice Count of NFTs currently within the active window.
    ///
    /// Uses _activeTotalCount which is kept up-to-date by _markActive.
    /// Any expired buckets not yet drained (i.e. no markActive call since they
    /// expired) are compensated inline; in an active protocol this loop is
    /// typically 0 iterations. Worst case = days since last markActive call.
    function activeGovernanceSupply() public view returns (uint256) {
        uint256 drainTarget = _computeDrainTarget();
        if (drainTarget <= _drainedUpToBucket) return _activeTotalCount;

        uint256 undrained;
        for (uint256 b = _drainedUpToBucket; b < drainTarget; ++b) {
            undrained += activeCountByBucket[b];
        }
        return _activeTotalCount > undrained ? _activeTotalCount - undrained : 0;
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _markActive(uint256 tokenId) private {
        infoNft.ownerOf(tokenId);

        // Drain expired buckets first so _drainedUpToBucket reflects now.
        _drainExpiredBuckets();

        uint256 bucket    = block.timestamp / BUCKET_SIZE;
        uint256 bucket1b  = bucket + 1;
        uint256 oldBucket1b = lastActiveBucket[tokenId];

        if (oldBucket1b != bucket1b) {
            // Was the NFT's old bucket still inside the window?
            bool wasInWindow = oldBucket1b != 0 && (oldBucket1b - 1) >= _drainedUpToBucket;

            if (oldBucket1b != 0) {
                activeCountByBucket[oldBucket1b - 1] -= 1;
            }
            activeCountByBucket[bucket] += 1;
            lastActiveBucket[tokenId] = bucket1b;

            if (!wasInWindow) {
                // NFT is new or re-entering after expiry — add to live count.
                _activeTotalCount += 1;
            }
            // wasInWindow == true → moved within window, total count unchanged.
        }

        lastActiveAt[tokenId] = block.timestamp;
        emit TokenActivityRecorded(tokenId, block.timestamp, msg.sender);
    }

    /// @dev Subtract expired buckets from _activeTotalCount and advance the drain cursor.
    function _drainExpiredBuckets() private {
        uint256 drainTarget = _computeDrainTarget();
        for (uint256 b = _drainedUpToBucket; b < drainTarget; ++b) {
            uint256 cnt = activeCountByBucket[b];
            if (cnt > 0) _activeTotalCount -= cnt;
        }
        _drainedUpToBucket = drainTarget;
    }

    function _computeDrainTarget() private view returns (uint256) {
        uint256 currentBucket = block.timestamp / BUCKET_SIZE;
        uint256 windowBuckets = _windowBucketCount();
        return currentBucket >= windowBuckets ? currentBucket - windowBuckets + 1 : 0;
    }

    function _windowBucketCount() private view returns (uint256) {
        return (activeWindowSeconds + BUCKET_SIZE - 1) / BUCKET_SIZE;
    }
}
