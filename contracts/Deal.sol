// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {DealError} from "./utils/DealErrors.sol";

/// @notice ABI-compatible fallback shell. Real deal logic is split into template implementations.
contract Deal is IERC721Receiver {
    address public constant NATIVE = address(0);

    enum Status { Ready, Active, Locked, Completed, Canceled, Abandoned }
    enum JoinMode { Open, ExactAddress, NftGated, ExactAddressAndNftGated }
    enum TemplateType { TokenToToken, TokenToNft, TokenToEmpty, EmptyToEmpty, NftToEmpty }
    enum Vote { Unset, Accept, Reject }
    enum CompletionReason { BothAccepted, ForcedByA, ForcedByB }

    address public factory;
    string public title;
    string public description;
    address public a;
    address public b;
    bool public isDomainDeal;
    string public domainName;

    Status public status;
    JoinMode public joinMode;
    TemplateType public templateType;
    address public expectedB;

    uint256 public gateNftId;
    uint256 public aNftId;
    uint256 public bNftId;
    bool public aNftLocked;
    bool public bNftLocked;

    address public aAssetNft;
    uint256 public aAssetNftId;
    address public bAssetNft;
    uint256 public bAssetNftId;
    bool public aAssetNftDeposited;
    bool public bAssetNftDeposited;

    address public aSwapToken;
    uint256 public aSwapAmount;
    address public aMarginToken;
    uint256 public aMarginAmount;
    address public bSwapToken;
    uint256 public bSwapAmount;
    address public bMarginToken;
    uint256 public bMarginAmount;

    bool public aPaid;
    bool public bPaid;
    uint64 public lockedAt;
    uint64 public timeoutSeconds;
    uint64 public timeStart;
    uint64 public timeEnd;
    uint64 public aAt;
    uint64 public bAt;
    Vote public aVote;
    Vote public bVote;
    bool public aClaimed;
    bool public bClaimed;
    uint256 public aSwapNetForB;
    uint256 public bSwapNetForA;

    address public dl;
    address public infoNft;
    address public treasury;
    address public WNATIVE;
    address public recognizedToken0;
    address public recognizedToken1;
    address public aTokenNorm;
    address public bTokenNorm;
    address public aPair;
    address public bPair;
    uint32 public feeNonDLNum;
    uint32 public feeNonDLDen;
    uint32 public mintOnFeesNum;
    uint32 public mintOnFeesDen;
    address public specialNoFeeToken;
    bool public msgPriceEnabled;
    address public msgPriceTokenNorm;
    address public msgPricePair;
    uint256 public msgPriceAmountInToken;

    event Initialized(address indexed initiator, address indexed factory);
    event Joined(address indexed b, bool nftLockedB, uint64 when);
    event Locked(uint64 when);
    event VoteCast(address indexed who, bool indexed isPartyA, Vote vote, uint64 when);
    event ActivePartnerCleared(address indexed prevB, uint8 reason, uint64 when);
    event DealAbandoned(address indexed initiator, uint64 when);
    event ForcedAfterTimeout(address indexed caller, bool completed, uint64 when);
    event Completed(CompletionReason reason);
    event Canceled();
    event Claimed(address indexed who, address swapToken, uint256 swapAmt, address marginToken, uint256 marginAmt);
    event FeesProcessed(address indexed tokenA, uint256 aFee, address indexed tokenB, uint256 bFee);
    event RewardsMinted(address indexed a, uint256 toA, address indexed b, uint256 toB, address indexed cAddr, uint256 toC);
    event AssetNftDeposited(address indexed owner, uint256 indexed tokenId);
    event AssetNftReleased(address indexed to, uint256 indexed tokenId);
    event MessagePosted(address indexed sender, uint256 indexed index);
    event MessageFeeCharged(address indexed sender, uint256 dlBurned);
    event Paid(address indexed payer, bool indexed isPartyA, uint64 when);
    event WithdrawnInActive(address indexed payer, bool indexed isPartyA, uint64 when);

    struct InitParams {
        address aSwapToken;
        uint256 aSwapAmount;
        address aMarginToken;
        uint256 aMarginAmount;
        address bSwapToken;
        uint256 bSwapAmount;
        address bMarginToken;
        uint256 bMarginAmount;
        address aAssetNft;
        uint256 aAssetNftId;
        address bAssetNft;
        uint256 bAssetNftId;
        uint8 templateType;
        uint8 joinMode;
        address expectedB;
        uint256 gateNftId;
        uint256 aNftId;
        string title;
        string description;
        uint64 timeoutSeconds;
        uint64 timeStart;
        uint64 timeEnd;
        bool isDomainDeal;
        string domainName;
        bool openTokenTokenFast;
    }

    struct ConfigParams {
        address dl;
        address infoNft;
        address treasury;
        address WNATIVE;
        address recognizedToken0;
        address recognizedToken1;
        address aTokenNorm;
        address bTokenNorm;
        address aPair;
        address bPair;
        uint32 feeNonDLNum;
        uint32 feeNonDLDen;
        uint32 mintOnFeesNum;
        uint32 mintOnFeesDen;
        address specialNoFeeToken;
        bool trackCreator;
        bool msgPriceEnabled;
        address msgPriceTokenNorm;
        address msgPricePair;
        uint256 msgPriceAmountInToken;
    }

    function initialize(address, address, InitParams calldata, ConfigParams calldata) external pure {
        revert DealError(57);
    }

    function updateAmounts(uint256, uint256, uint256, uint256) external pure {
        revert DealError(57);
    }

    function abandonByA() external pure {
        revert DealError(57);
    }

    function openJoinFor(address) external pure {
        revert DealError(57);
    }

    function join(uint256, bool) external pure {
        revert DealError(57);
    }

    function pay() external payable {
        revert DealError(57);
    }

    function withdrawInActive() external pure {
        revert DealError(57);
    }

    function exitByB() external pure {
        revert DealError(57);
    }

    function kickBByA() external pure {
        revert DealError(57);
    }

    function setMyVote(Vote) external pure {
        revert DealError(57);
    }

    function forceComplete() external pure {
        revert DealError(57);
    }

    function postMessage(string calldata) external pure {
        revert DealError(57);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {}
}
