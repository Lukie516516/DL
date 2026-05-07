// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Official InfoNFT credit book. V1 credit is produced only by completed P2P deals.
contract DealCreditGraph is Ownable {
    uint256 public constant TOP_K = 5;
    uint256 public constant BPS = 10_000;
    uint256 public constant MIN_EXTRA_BPS = 100; // 0.01x
    uint256 public constant MAX_EXTRA_BPS = 20_000; // 2x

    struct CreditPeer {
        uint256 tokenId;
        uint256 creditSnapshot;
        uint64 updatedAt;
    }

    IERC721 public immutable infoNft;

    mapping(address => bool) public isRecorder;
    mapping(uint256 => uint256) public creditScore;
    mapping(uint256 => CreditPeer[TOP_K]) private _topPeers;
    bool public migrationLocked;

    event RecorderSet(address indexed recorder, bool allowed);
    event CreditImported(uint256 indexed tokenId, uint256 creditScore);
    event MigrationLocked();
    event DealCreditRecorded(
        address indexed recorder,
        uint256 indexed aTokenId,
        uint256 indexed bTokenId,
        uint256 baseCredit,
        uint256 aDelta,
        uint256 bDelta
    );
    event CreditUpdated(uint256 indexed tokenId, uint256 delta, uint256 newCredit);
    event TopCreditPeerUpdated(
        uint256 indexed tokenId,
        uint256 indexed peerTokenId,
        uint256 creditSnapshot,
        uint256 slot
    );

    error NotRecorder();
    error ZeroInfoNft();
    error InvalidTokenId();
    error InvalidCreditPeer();
    error MigrationAlreadyLocked();

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

    function importCredit(uint256 tokenId, uint256 score, CreditPeer[TOP_K] calldata peers) external onlyOwner {
        if (migrationLocked) revert MigrationAlreadyLocked();
        if (tokenId == 0) revert InvalidTokenId();

        creditScore[tokenId] = score;
        CreditPeer[TOP_K] storage dst = _topPeers[tokenId];
        for (uint256 i = 0; i < TOP_K; ++i) {
            CreditPeer calldata peer = peers[i];
            if (peer.tokenId == tokenId) revert InvalidCreditPeer();
            if (peer.tokenId == 0 && (peer.creditSnapshot != 0 || peer.updatedAt != 0)) {
                revert InvalidCreditPeer();
            }
            dst[i] = peer;
        }

        emit CreditImported(tokenId, score);
    }

    function lockMigration() external onlyOwner {
        migrationLocked = true;
        emit MigrationLocked();
    }

    function topCreditPeers(uint256 tokenId) external view returns (CreditPeer[TOP_K] memory) {
        return _topPeers[tokenId];
    }

    function bestCandidateOf(uint256 tokenId)
        public
        view
        returns (uint256 candidateTokenId, address candidateOwner, uint256 score)
    {
        candidateTokenId = tokenId;
        score = creditScore[tokenId];

        CreditPeer[TOP_K] storage peers = _topPeers[tokenId];
        for (uint256 i = 0; i < TOP_K; ++i) {
            CreditPeer storage peer = peers[i];
            if (peer.tokenId != 0 && peer.creditSnapshot > score) {
                candidateTokenId = peer.tokenId;
                score = peer.creditSnapshot;
            }
        }

        if (candidateTokenId != 0 && score > 0) {
            candidateOwner = infoNft.ownerOf(candidateTokenId);
        }
    }

    function resolveCRewardTarget(
        address partyA,
        address partyB,
        uint256 aTokenId,
        bool aValid,
        uint256 bTokenId,
        bool bValid
    ) external view returns (uint256 cTokenId, address cOwner) {
        aValid = _isValidOwner(aTokenId, partyA, aValid);
        bValid = _isValidOwner(bTokenId, partyB, bValid);

        if (!aValid && !bValid) return (0, address(0));
        if (aValid && bValid && infoNft.ownerOf(aTokenId) == infoNft.ownerOf(bTokenId)) {
            return (0, address(0));
        }

        uint256 aScore;
        uint256 bScore;
        uint256 aCandidate;
        uint256 bCandidate;
        address aOwner;
        address bOwner;

        if (aValid) (aCandidate, aOwner, aScore) = bestCandidateOf(aTokenId);
        if (bValid) (bCandidate, bOwner, bScore) = bestCandidateOf(bTokenId);

        if (aScore == 0 && bScore == 0) return (0, address(0));
        if (aScore > bScore) return (aCandidate, aOwner);
        if (bScore > aScore) return (bCandidate, bOwner);
        return (0, address(0));
    }

    /// @dev baseCredit uses 18-decimal U-credit units. Only successful deals should call this.
    function recordDeal(
        address partyA,
        address partyB,
        uint256 aTokenId,
        bool aValid,
        uint256 bTokenId,
        bool bValid,
        uint256 baseCredit
    ) external onlyRecorder returns (uint256 aDelta, uint256 bDelta) {
        if (baseCredit == 0) return (0, 0);

        aValid = _isValidOwner(aTokenId, partyA, aValid);
        bValid = _isValidOwner(bTokenId, partyB, bValid);
        if (!aValid && !bValid) return (0, 0);

        if (aValid && bValid && infoNft.ownerOf(aTokenId) == infoNft.ownerOf(bTokenId)) {
            return (0, 0);
        }

        uint256 aBefore = aValid ? creditScore[aTokenId] : 0;
        uint256 bBefore = bValid ? creditScore[bTokenId] : 0;

        if (aValid) {
            aDelta = _creditDelta(baseCredit, aBefore, bValid ? bBefore : 0);
            creditScore[aTokenId] = aBefore + aDelta;
            emit CreditUpdated(aTokenId, aDelta, creditScore[aTokenId]);
        }
        if (bValid) {
            bDelta = _creditDelta(baseCredit, bBefore, aValid ? aBefore : 0);
            creditScore[bTokenId] = bBefore + bDelta;
            emit CreditUpdated(bTokenId, bDelta, creditScore[bTokenId]);
        }

        if (aValid && bValid) {
            _upsertTopPeer(aTokenId, bTokenId, creditScore[bTokenId]);
            _upsertTopPeer(bTokenId, aTokenId, creditScore[aTokenId]);
        }

        emit DealCreditRecorded(msg.sender, aValid ? aTokenId : 0, bValid ? bTokenId : 0, baseCredit, aDelta, bDelta);
    }

    function _isValidOwner(uint256 tokenId, address owner, bool claimedValid) private view returns (bool) {
        return claimedValid && tokenId != 0 && owner != address(0) && infoNft.ownerOf(tokenId) == owner;
    }

    function _creditDelta(uint256 baseCredit, uint256 selfCredit, uint256 counterpartyCredit)
        private
        pure
        returns (uint256)
    {
        uint256 extraBps;
        if (selfCredit == 0) {
            extraBps = counterpartyCredit == 0 ? 0 : MAX_EXTRA_BPS;
        } else if (counterpartyCredit == 0) {
            extraBps = 0;
        } else {
            extraBps = Math.mulDiv(counterpartyCredit, BPS, selfCredit);
            if (extraBps < MIN_EXTRA_BPS) extraBps = MIN_EXTRA_BPS;
            if (extraBps > MAX_EXTRA_BPS) extraBps = MAX_EXTRA_BPS;
        }

        return baseCredit + Math.mulDiv(baseCredit, extraBps, BPS);
    }

    function _upsertTopPeer(uint256 tokenId, uint256 peerTokenId, uint256 peerCredit) private {
        if (tokenId == 0 || peerTokenId == 0 || tokenId == peerTokenId) return;

        CreditPeer[TOP_K] storage peers = _topPeers[tokenId];
        uint256 minSlot = 0;
        uint256 minCredit = type(uint256).max;

        for (uint256 i = 0; i < TOP_K; ++i) {
            if (peers[i].tokenId == peerTokenId) {
                peers[i] = CreditPeer({
                    tokenId: peerTokenId,
                    creditSnapshot: peerCredit,
                    updatedAt: uint64(block.timestamp)
                });
                emit TopCreditPeerUpdated(tokenId, peerTokenId, peerCredit, i);
                return;
            }
            if (peers[i].tokenId == 0) {
                peers[i] = CreditPeer({
                    tokenId: peerTokenId,
                    creditSnapshot: peerCredit,
                    updatedAt: uint64(block.timestamp)
                });
                emit TopCreditPeerUpdated(tokenId, peerTokenId, peerCredit, i);
                return;
            }
            if (peers[i].creditSnapshot < minCredit) {
                minCredit = peers[i].creditSnapshot;
                minSlot = i;
            }
        }

        if (peerCredit > minCredit) {
            peers[minSlot] = CreditPeer({
                tokenId: peerTokenId,
                creditSnapshot: peerCredit,
                updatedAt: uint64(block.timestamp)
            });
            emit TopCreditPeerUpdated(tokenId, peerTokenId, peerCredit, minSlot);
        }
    }
}
