// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

contract DealNftGovernanceActivity is Ownable {
    IERC721 public immutable infoNft;

    uint256 public constant BUCKET_SIZE = 1 days;
    uint256 public constant MIN_ACTIVE_WINDOW = 30 days;
    uint256 public constant MAX_ACTIVE_WINDOW = 365 days;

    uint256 public activeWindowSeconds = 90 days;

    mapping(address recorder => bool) public isRecorder;
    mapping(uint256 tokenId => uint256) public lastActiveAt;
    mapping(uint256 tokenId => uint256) public lastActiveBucket;
    mapping(uint256 bucket => uint256) public activeCountByBucket;

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

    function activeGovernanceSupply() public view returns (uint256 total) {
        uint256 currentBucket = block.timestamp / BUCKET_SIZE;
        uint256 buckets = _windowBucketCount();
        uint256 startBucket = currentBucket >= buckets ? currentBucket - buckets + 1 : 0;
        for (uint256 bucket = startBucket; bucket <= currentBucket; ++bucket) {
            total += activeCountByBucket[bucket];
        }
    }

    function _markActive(uint256 tokenId) private {
        // Ensures the official NFT exists.
        infoNft.ownerOf(tokenId);

        uint256 bucket = block.timestamp / BUCKET_SIZE;
        uint256 bucket1b = bucket + 1;
        uint256 oldBucket1b = lastActiveBucket[tokenId];
        if (oldBucket1b != bucket1b) {
            if (oldBucket1b != 0) {
                activeCountByBucket[oldBucket1b - 1] -= 1;
            }
            activeCountByBucket[bucket] += 1;
            lastActiveBucket[tokenId] = bucket1b;
        }
        lastActiveAt[tokenId] = block.timestamp;
        emit TokenActivityRecorded(tokenId, block.timestamp, msg.sender);
    }

    function _windowBucketCount() private view returns (uint256) {
        return (activeWindowSeconds + BUCKET_SIZE - 1) / BUCKET_SIZE;
    }
}
