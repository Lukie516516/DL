// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {DealOpenTokenToken} from "../contracts/DealOpenTokenToken.sol";
import {DealError} from "../contracts/utils/DealErrors.sol";
import {MockERC20Mint, MockInfoNFT, MockOpenTTFactory} from "./mocks/MockOpenTTStack.sol";
import {DealMessageHub} from "../contracts/DealMessageHub.sol";

/// @notice Foundry：DealOpenTokenToken 单元 / fuzz / invariant（独立 mock 栈，不依赖整套 Hardhat 部署）
contract DealOpenTokenTokenFullTest is Test {
    uint256 internal constant ONE = 1e18;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal charlie = address(0xC0FFEE);
    address internal treasury = address(0x7E4);

    MockOpenTTFactory internal factory;
    MockInfoNFT internal infoNft;
    MockERC20Mint internal tokenA;
    MockERC20Mint internal tokenB;
    MockERC20Mint internal dl;
    MockERC20Mint internal wnative;
    DealOpenTokenToken internal impl;
    DealOpenTokenToken internal openDeal;

    uint256 internal bobNftId = 1;
    uint256 internal aliceNftId = 2;
    uint256 internal charlieNftId = 3;

    function setUp() public {
        factory = new MockOpenTTFactory();
        infoNft = new MockInfoNFT();
        infoNft.setFactoryAuth(address(factory));
        factory.setNft(address(infoNft));

        tokenA = new MockERC20Mint("A", "A");
        tokenB = new MockERC20Mint("B", "B");
        dl = new MockERC20Mint("DL", "DL");
        wnative = new MockERC20Mint("W", "W");

        vm.label(alice, "alice");
        vm.label(bob, "bob");
        vm.label(charlie, "charlie");
        vm.label(treasury, "treasury");

        DealOpenTokenToken impl_ = new DealOpenTokenToken();
        impl = impl_;
        address clone = Clones.clone(address(impl));
        openDeal = DealOpenTokenToken(payable(clone));

        _initDeal(openDeal, 10 * ONE, 5 * ONE, 3600, false);

        tokenA.mint(alice, 1_000 * ONE);
        tokenB.mint(bob, 1_000 * ONE);
        tokenB.mint(charlie, 1_000 * ONE);
        infoNft.mint(bob, bobNftId);
        infoNft.mint(charlie, charlieNftId);
    }

    function _initDeal(
        DealOpenTokenToken d,
        uint256 aAmt,
        uint256 bAmt,
        uint64 timeout,
        bool trackCreator
    ) internal {
        _initDealWithOptions(d, aAmt, bAmt, timeout, trackCreator, 0, false);
    }

    function _initDealWithOptions(
        DealOpenTokenToken d,
        uint256 aAmt,
        uint256 bAmt,
        uint64 timeout,
        bool trackCreator,
        uint256 aInfoId,
        bool recognizeCreditTokens
    ) internal {
        DealOpenTokenToken.InitParams memory p = DealOpenTokenToken.InitParams({
            aSwapToken: address(tokenA),
            aSwapAmount: aAmt,
            aMarginToken: address(tokenA),
            aMarginAmount: 0,
            bSwapToken: address(tokenB),
            bSwapAmount: bAmt,
            bMarginToken: address(tokenB),
            bMarginAmount: 0,
            aAssetNft: address(0),
            aAssetNftId: 0,
            bAssetNft: address(0),
            bAssetNftId: 0,
            templateType: 0,
            joinMode: 0,
            expectedB: address(0),
            gateNftId: 0,
            aNftId: aInfoId,
            title: "open-tt",
            description: "",
            timeoutSeconds: timeout,
            replaceTimeoutSeconds: 120,
            timeStart: 1_700_000_000,
            timeEnd: 1_800_000_000,
            isDomainDeal: false,
            domainName: "",
            openTokenTokenFast: true
        });

        DealOpenTokenToken.ConfigParams memory c = DealOpenTokenToken.ConfigParams({
            dl: address(dl),
            infoNft: address(infoNft),
            treasury: treasury,
            WNATIVE: address(wnative),
            recognizedToken0: recognizeCreditTokens ? address(tokenA) : address(0),
            recognizedToken1: recognizeCreditTokens ? address(tokenB) : address(0),
            aTokenNorm: address(tokenA),
            bTokenNorm: address(tokenB),
            aPair: address(0),
            bPair: address(0),
            feeNonDLNum: 3,
            feeNonDLDen: 1000,
            mintOnFeesNum: 0,
            mintOnFeesDen: 1,
            specialNoFeeToken: address(0),
            trackCreator: trackCreator,
            msgPriceEnabled: false,
            msgPriceTokenNorm: address(0),
            msgPricePair: address(0),
            msgPriceAmountInToken: 0
        });

        vm.prank(alice);
        d.initialize(address(factory), alice, p, c);
    }

    function _payAReady() internal {
        vm.startPrank(alice);
        tokenA.approve(address(openDeal), type(uint256).max);
        openDeal.pay();
        vm.stopPrank();
    }

    function _preAccept() internal {
        vm.prank(alice);
        openDeal.preAccept();
    }

    function _joinB(uint256 optId) internal {
        vm.prank(bob);
        openDeal.join(optId, false);
    }

    function _joinC(uint256 optId) internal {
        vm.prank(charlie);
        openDeal.join(optId, false);
    }

    function _payB() internal {
        vm.startPrank(bob);
        tokenB.approve(address(openDeal), type(uint256).max);
        openDeal.pay();
        vm.stopPrank();
    }

    function _payC() internal {
        vm.startPrank(charlie);
        tokenB.approve(address(openDeal), type(uint256).max);
        openDeal.pay();
        vm.stopPrank();
    }

    /* ---------- 单元：主路径 ---------- */

    function test_happyPath_preAccept_joinNft_settle() public {
        _payAReady();
        _preAccept();
        _joinB(bobNftId);
        assertEq(openDeal.bNftId(), bobNftId);
        assertTrue(openDeal.bNftLocked());
        _payB();
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Locked));

        vm.prank(bob);
        openDeal.setMyVote(DealOpenTokenToken.Vote.Accept);
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Completed));
        assertEq(openDeal.bNftId(), 0);
        assertFalse(openDeal.bNftLocked());
    }

    function test_aInfoNft_participatesInCreditOnCompletion() public {
        infoNft.mint(alice, aliceNftId);

        DealOpenTokenToken d = DealOpenTokenToken(payable(Clones.clone(address(impl))));
        _initDealWithOptions(d, 10 * ONE, 5 * ONE, 3600, false, aliceNftId, true);
        tokenA.mint(alice, 1_000 * ONE);
        tokenB.mint(bob, 1_000 * ONE);

        assertEq(d.aNftId(), aliceNftId);
        assertEq(infoNft.lockCount(aliceNftId), 1);

        vm.startPrank(alice);
        tokenA.approve(address(d), type(uint256).max);
        d.pay();
        d.preAccept();
        vm.stopPrank();

        vm.prank(bob);
        d.join(bobNftId, false);

        vm.startPrank(bob);
        tokenB.approve(address(d), type(uint256).max);
        d.pay();
        vm.stopPrank();

        vm.prank(bob);
        d.setMyVote(DealOpenTokenToken.Vote.Accept);

        assertEq(uint8(d.status()), uint8(DealOpenTokenToken.Status.Completed));
        assertFalse(d.bNftLocked());
        assertEq(infoNft.lockCount(aliceNftId), 0);
        assertEq(infoNft.lockCount(bobNftId), 0);

        assertEq(factory.lastCreditA(), alice);
        assertEq(factory.lastCreditB(), bob);
        assertEq(factory.lastCreditATokenId(), aliceNftId);
        assertTrue(factory.lastCreditAValid());
        assertEq(factory.lastCreditBTokenId(), bobNftId);
        assertTrue(factory.lastCreditBValid());
        assertEq(factory.lastCreditBase(), (10 * ONE * 3) / 1000 + (5 * ONE * 3) / 1000);
    }

    function test_join_optIdZero_noLock() public {
        _payAReady();
        _preAccept();
        _joinB(0);
        assertEq(openDeal.bNftId(), 0);
        assertFalse(openDeal.bNftLocked());
        _payB();
        vm.prank(bob);
        openDeal.setMyVote(DealOpenTokenToken.Vote.Accept);
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Completed));
    }

    function test_withdrawAInReady_afterPay() public {
        _payAReady();
        assertTrue(openDeal.aPaid());
        vm.prank(alice);
        openDeal.withdrawAInReady();
        assertFalse(openDeal.aPaid());
    }

    function test_B_reject_expels_toReady() public {
        _payAReady();
        _preAccept();
        _joinB(bobNftId);
        _payB();
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Locked));

        vm.prank(bob);
        openDeal.setMyVote(DealOpenTokenToken.Vote.Reject);
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Ready));
        assertEq(openDeal.b(), address(0));
        assertEq(openDeal.bNftId(), 0);
        assertFalse(openDeal.bNftLocked());
    }

    function test_replaceInactiveBAndJoin_preservesAPaymentAndBlocksOldB() public {
        _payAReady();
        _joinB(bobNftId);
        assertEq(openDeal.b(), bob);
        assertTrue(openDeal.aPaid());
        assertEq(openDeal.bJoinedAt(), block.timestamp);

        vm.prank(charlie);
        vm.expectRevert(abi.encodeWithSelector(DealError.selector, uint16(58)));
        openDeal.replaceInactiveBAndJoin(charlieNftId, false);

        vm.warp(uint256(openDeal.bJoinedAt()) + uint256(openDeal.replaceTimeoutSeconds()) + 1);
        vm.prank(charlie);
        openDeal.replaceInactiveBAndJoin(charlieNftId, false);

        assertEq(openDeal.b(), charlie);
        assertEq(openDeal.lastRemovedB(), bob);
        assertEq(openDeal.bNftId(), charlieNftId);
        assertTrue(openDeal.bNftLocked());
        assertTrue(openDeal.aPaid());
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Active));
        assertEq(infoNft.lockCount(bobNftId), 0);
        assertEq(infoNft.lockCount(charlieNftId), 1);

        _payC();
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Locked));
        vm.prank(charlie);
        openDeal.setMyVote(DealOpenTokenToken.Vote.Accept);
        vm.prank(alice);
        openDeal.setMyVote(DealOpenTokenToken.Vote.Accept);
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Completed));
    }

    function test_replaceNonVotingBAndJoin_afterLockedTimeout_returnsToActive() public {
        _payAReady();
        _preAccept();
        _joinB(bobNftId);
        _payB();
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Locked));
        assertEq(uint8(openDeal.aVote()), uint8(DealOpenTokenToken.Vote.Accept));
        assertEq(uint8(openDeal.bVote()), uint8(DealOpenTokenToken.Vote.Unset));

        vm.prank(charlie);
        vm.expectRevert(abi.encodeWithSelector(DealError.selector, uint16(58)));
        openDeal.replaceNonVotingBAndJoin(charlieNftId, false);

        uint256 base = openDeal.aAt() > openDeal.lockedAt() ? openDeal.aAt() : openDeal.lockedAt();
        vm.warp(base + uint256(openDeal.replaceTimeoutSeconds()) + 1);
        vm.prank(charlie);
        openDeal.replaceNonVotingBAndJoin(charlieNftId, false);

        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Active));
        assertEq(openDeal.b(), charlie);
        assertTrue(openDeal.aPaid());
        assertFalse(openDeal.bPaid());
        assertEq(openDeal.lastRemovedB(), bob);
        assertEq(infoNft.lockCount(bobNftId), 0);
        assertEq(infoNft.lockCount(charlieNftId), 1);

        _payC();
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Locked));
        assertEq(uint8(openDeal.aVote()), uint8(DealOpenTokenToken.Vote.Accept));
        assertEq(uint8(openDeal.bVote()), uint8(DealOpenTokenToken.Vote.Unset));
    }

    function test_removedB_cannotRejoinUnlessAOpensForHim() public {
        _payAReady();
        _preAccept();
        _joinB(bobNftId);
        _payB();
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Locked));

        vm.prank(bob);
        openDeal.setMyVote(DealOpenTokenToken.Vote.Reject);
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Ready));
        assertEq(openDeal.lastRemovedB(), bob);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DealError.selector, uint16(59)));
        openDeal.join(bobNftId, false);

        vm.prank(alice);
        openDeal.openJoinFor(bob);
        vm.prank(bob);
        openDeal.join(bobNftId, false);

        assertEq(openDeal.b(), bob);
        assertEq(openDeal.bNftId(), bobNftId);
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Active));
    }

    /// @dev preAccept 后 aVote 已为 Accept，仅 **A** 可在 b 未投票且超时后 forceComplete（与合约分支一致）
    function test_forceComplete_byA_afterPreAccept_timeout() public {
        _payAReady();
        _preAccept();
        _joinB(0);
        _payB();
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Locked));
        assertEq(uint8(openDeal.aVote()), uint8(DealOpenTokenToken.Vote.Accept));
        assertEq(uint8(openDeal.bVote()), uint8(DealOpenTokenToken.Vote.Unset));

        vm.warp(uint256(openDeal.aAt()) + uint256(openDeal.timeoutSeconds()) + 1);

        vm.prank(alice);
        openDeal.forceComplete();
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Completed));
    }

    /// @dev 无 preAccept 时 aVote 仍为 Unset；B 先投 Accept 后可在超时后 forceComplete
    function test_forceComplete_byB_whenAVoteStillUnset() public {
        _payAReady();
        _joinB(0);
        _payB();
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Locked));
        vm.prank(bob);
        openDeal.setMyVote(DealOpenTokenToken.Vote.Accept);
        assertEq(uint8(openDeal.aVote()), uint8(DealOpenTokenToken.Vote.Unset));
        assertEq(uint8(openDeal.bVote()), uint8(DealOpenTokenToken.Vote.Accept));

        vm.warp(uint256(openDeal.bAt()) + uint256(openDeal.timeoutSeconds()) + 1);

        vm.prank(bob);
        openDeal.forceComplete();
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Completed));
    }

    function test_double_initialize_reverts() public {
        DealOpenTokenToken d2 = DealOpenTokenToken(payable(Clones.clone(address(impl))));
        _initDeal(d2, ONE, ONE, 100, false);
        DealOpenTokenToken.InitParams memory p;
        DealOpenTokenToken.ConfigParams memory c;
        vm.expectRevert(); // Initializable: already initialized
        d2.initialize(address(factory), alice, p, c);
    }

    function test_postMessage_whenHubSet() public {
        MockFactoryForHub mf = new MockFactoryForHub();
        DealMessageHub hub2 = new DealMessageHub(address(mf));
        mf.setDeal(address(openDeal), true);
        factory.setHub(address(hub2));

        _payAReady();
        _preAccept();
        _joinB(0);
        vm.prank(alice);
        hub2.postMessage(address(openDeal), "hi");
    }

    function test_postMessage_afterCompleted() public {
        MockFactoryForHub mf = new MockFactoryForHub();
        DealMessageHub hub2 = new DealMessageHub(address(mf));
        mf.setDeal(address(openDeal), true);
        factory.setHub(address(hub2));

        _payAReady();
        _preAccept();
        _joinB(0);
        _payB();
        vm.prank(bob);
        openDeal.setMyVote(DealOpenTokenToken.Vote.Accept);
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Completed));

        vm.prank(alice);
        hub2.postMessage(address(openDeal), "after done");
        assertEq(hub2.messagesCount(address(openDeal)), 1);
    }

    function test_postMessage_afterCanceled() public {
        MockFactoryForHub mf = new MockFactoryForHub();
        DealMessageHub hub2 = new DealMessageHub(address(mf));
        mf.setDeal(address(openDeal), true);
        factory.setHub(address(hub2));

        _payAReady();
        _preAccept();
        _joinB(0);
        _payB();
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Locked));

        vm.prank(alice);
        openDeal.setMyVote(DealOpenTokenToken.Vote.Reject);
        vm.prank(bob);
        openDeal.setMyVote(DealOpenTokenToken.Vote.Reject);
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Canceled));

        vm.prank(alice);
        hub2.postMessage(address(openDeal), "after cancel a");
        vm.prank(bob);
        hub2.postMessage(address(openDeal), "after cancel b");
        assertEq(hub2.messagesCount(address(openDeal)), 2);
    }

    function test_postMessage_afterAbandoned() public {
        MockFactoryForHub mf = new MockFactoryForHub();
        DealMessageHub hub2 = new DealMessageHub(address(mf));
        mf.setDeal(address(openDeal), true);
        factory.setHub(address(hub2));

        _payAReady();
        _preAccept();
        _joinB(0);
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Active));

        vm.prank(alice);
        openDeal.abandonByA();
        assertEq(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Abandoned));

        vm.prank(alice);
        hub2.postMessage(address(openDeal), "after abandon a");
        // `abandonByA` -> `_refundAllToParties` 会 `b = address(0)`，Hub 只允许当前 A/B。
        vm.prank(bob);
        vm.expectRevert(DealMessageHub.NotParticipant.selector);
        hub2.postMessage(address(openDeal), "bob cannot");
        assertEq(hub2.messagesCount(address(openDeal)), 1);
    }

    /* ---------- Fuzz：金额与时间 ---------- */

    function testFuzz_happyPath_amounts(uint128 aRaw, uint128 bRaw) public {
        uint256 aAmt = uint256(aRaw) % (1_000_000 * ONE) + 1;
        uint256 bAmt = uint256(bRaw) % (1_000_000 * ONE) + 1;

        address clone = Clones.clone(address(impl));
        DealOpenTokenToken d = DealOpenTokenToken(payable(clone));
        _initDeal(d, aAmt, bAmt, 3600, false);

        tokenA.mint(alice, aAmt * 2);
        tokenB.mint(bob, bAmt * 2);

        vm.startPrank(alice);
        tokenA.approve(address(d), type(uint256).max);
        d.pay();
        d.preAccept();
        vm.stopPrank();

        vm.prank(bob);
        d.join(0, false);

        vm.startPrank(bob);
        tokenB.approve(address(d), type(uint256).max);
        d.pay();
        vm.stopPrank();

        vm.prank(bob);
        d.setMyVote(DealOpenTokenToken.Vote.Accept);
        assertEq(uint8(d.status()), uint8(DealOpenTokenToken.Status.Completed));
    }

    function testFuzz_timeout_forceComplete_AfterPreAccept_onlyA(uint32 timeout) public {
        vm.assume(timeout >= 60 && timeout <= 365 days);
        address clone = Clones.clone(address(impl));
        DealOpenTokenToken d = DealOpenTokenToken(payable(clone));
        _initDeal(d, ONE, ONE, uint64(timeout), false);
        tokenA.mint(alice, 100 * ONE);
        tokenB.mint(bob, 100 * ONE);

        vm.startPrank(alice);
        tokenA.approve(address(d), type(uint256).max);
        d.pay();
        d.preAccept();
        vm.stopPrank();
        vm.prank(bob);
        d.join(0, false);
        vm.startPrank(bob);
        tokenB.approve(address(d), type(uint256).max);
        d.pay();
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert();
        d.forceComplete();

        vm.warp(uint256(d.aAt()) + uint256(timeout) + 1);
        vm.prank(alice);
        d.forceComplete();
        assertEq(uint8(d.status()), uint8(DealOpenTokenToken.Status.Completed));
    }
}

/// @dev DealMessageHub 需要 IDealFactoryDealAuth.isDeal(deal)
contract MockFactoryForHub {
    mapping(address => bool) private _isDeal;

    function setDeal(address d, bool v) external {
        _isDeal[d] = v;
    }

    function isDeal(address d) external view returns (bool) {
        return _isDeal[d];
    }

    function chargeMessageFeeFrom(address) external pure {}
}

/// @notice 随机步进 OpenTT；不变式检查链上状态一致性
contract DealOpenTokenTokenInvariantTest is StdInvariant, Test {
    uint256 internal constant ONE = 1e18;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal treasury = address(0x7E4);

    OpenTTHandler internal handler;

    function setUp() public {
        handler = new OpenTTHandler(alice, bob, treasury);
        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](10);
        sel[0] = OpenTTHandler.step_payAReady.selector;
        sel[1] = OpenTTHandler.step_preAccept.selector;
        sel[2] = OpenTTHandler.step_joinBWithNft.selector;
        sel[3] = OpenTTHandler.step_joinBNoNft.selector;
        sel[4] = OpenTTHandler.step_payB.selector;
        sel[5] = OpenTTHandler.step_bAccept.selector;
        sel[6] = OpenTTHandler.step_bReject.selector;
        sel[7] = OpenTTHandler.step_abandon.selector;
        sel[8] = OpenTTHandler.step_forceCompleteB.selector;
        sel[9] = OpenTTHandler.step_forceCompleteA.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    function invariant_statusEnumBounded() public view {
        handler.assertStatusBounded();
    }

    function invariant_noBNftWithoutCounterparty() public view {
        handler.assertNoBNftWithoutCounterparty();
    }

    function invariant_completedClearsNftBinding() public view {
        handler.assertCompletedClearsNft();
    }

    function invariant_escrowSolvent() public view {
        handler.assertEscrowSolvent();
    }

    /// @dev `abandonByA` 必须清对手方，否则 `postMessage` onlyAB 与产品语义不一致
    function invariant_abandonedClearsCounterparty() public view {
        handler.assertAbandonedClearsB();
    }

    /// @dev Active / Locked 必须已有 B（OpenTT 状态机）
    function invariant_activeOrLockedHasCounterparty() public view {
        handler.assertActiveOrLockedHasB();
    }
}

contract OpenTTHandler is Test {
    address public alice;
    address public bob;
    address public treasury;

    MockOpenTTFactory public factory;
    MockInfoNFT public infoNft;
    MockERC20Mint public tokenA;
    MockERC20Mint public tokenB;
    MockERC20Mint public dl;
    MockERC20Mint public wnative;
    DealOpenTokenToken public impl;
    DealOpenTokenToken public openDeal;

    uint256 public bobNftId = 1;
    uint256 public initA = 10 * 1e18;
    uint256 public initB = 5 * 1e18;

    constructor(address a, address b_, address t) {
        alice = a;
        bob = b_;
        treasury = t;
        factory = new MockOpenTTFactory();
        infoNft = new MockInfoNFT();
        infoNft.setFactoryAuth(address(factory));
        factory.setNft(address(infoNft));

        tokenA = new MockERC20Mint("A", "A");
        tokenB = new MockERC20Mint("B", "B");
        dl = new MockERC20Mint("DL", "DL");
        wnative = new MockERC20Mint("W", "W");

        impl = new DealOpenTokenToken();
        openDeal = DealOpenTokenToken(payable(Clones.clone(address(impl))));

        DealOpenTokenToken.InitParams memory p = DealOpenTokenToken.InitParams({
            aSwapToken: address(tokenA),
            aSwapAmount: initA,
            aMarginToken: address(tokenA),
            aMarginAmount: 0,
            bSwapToken: address(tokenB),
            bSwapAmount: initB,
            bMarginToken: address(tokenB),
            bMarginAmount: 0,
            aAssetNft: address(0),
            aAssetNftId: 0,
            bAssetNft: address(0),
            bAssetNftId: 0,
            templateType: 0,
            joinMode: 0,
            expectedB: address(0),
            gateNftId: 0,
            aNftId: 0,
            title: "inv",
            description: "",
            timeoutSeconds: 3600,
            replaceTimeoutSeconds: 120,
            timeStart: 1_700_000_000,
            timeEnd: 1_800_000_000,
            isDomainDeal: false,
            domainName: "",
            openTokenTokenFast: true
        });

        DealOpenTokenToken.ConfigParams memory c = DealOpenTokenToken.ConfigParams({
            dl: address(dl),
            infoNft: address(infoNft),
            treasury: treasury,
            WNATIVE: address(wnative),
            recognizedToken0: address(0),
            recognizedToken1: address(0),
            aTokenNorm: address(tokenA),
            bTokenNorm: address(tokenB),
            aPair: address(0),
            bPair: address(0),
            feeNonDLNum: 3,
            feeNonDLDen: 1000,
            mintOnFeesNum: 0,
            mintOnFeesDen: 1,
            specialNoFeeToken: address(0),
            trackCreator: false,
            msgPriceEnabled: false,
            msgPriceTokenNorm: address(0),
            msgPricePair: address(0),
            msgPriceAmountInToken: 0
        });

        vm.prank(alice);
        openDeal.initialize(address(factory), alice, p, c);

        tokenA.mint(alice, 1_000_000 * 1e18);
        tokenB.mint(bob, 1_000_000 * 1e18);
        infoNft.mint(bob, bobNftId);
    }

    function _terminal() internal view returns (bool) {
        DealOpenTokenToken.Status s = openDeal.status();
        return s == DealOpenTokenToken.Status.Completed || s == DealOpenTokenToken.Status.Canceled
            || s == DealOpenTokenToken.Status.Abandoned;
    }

    function step_payAReady() external {
        if (_terminal()) return;
        if (openDeal.status() != DealOpenTokenToken.Status.Ready) return;
        if (openDeal.b() != address(0)) return;
        if (openDeal.aPaid()) return;
        vm.startPrank(alice);
        tokenA.approve(address(openDeal), type(uint256).max);
        openDeal.pay();
        vm.stopPrank();
    }

    function step_preAccept() external {
        if (_terminal()) return;
        if (openDeal.status() != DealOpenTokenToken.Status.Ready) return;
        vm.prank(alice);
        openDeal.preAccept();
    }

    function step_joinBWithNft() external {
        if (_terminal()) return;
        if (openDeal.status() != DealOpenTokenToken.Status.Ready) return;
        if (openDeal.b() != address(0)) return;
        vm.prank(bob);
        openDeal.join(bobNftId, false);
    }

    function step_joinBNoNft() external {
        if (_terminal()) return;
        if (openDeal.status() != DealOpenTokenToken.Status.Ready) return;
        if (openDeal.b() != address(0)) return;
        vm.prank(bob);
        openDeal.join(0, false);
    }

    function step_payB() external {
        if (_terminal()) return;
        if (openDeal.status() != DealOpenTokenToken.Status.Active) return;
        if (openDeal.bPaid()) return;
        vm.startPrank(bob);
        tokenB.approve(address(openDeal), type(uint256).max);
        openDeal.pay();
        vm.stopPrank();
    }

    function step_bAccept() external {
        if (_terminal()) return;
        if (openDeal.status() != DealOpenTokenToken.Status.Locked) return;
        vm.prank(bob);
        openDeal.setMyVote(DealOpenTokenToken.Vote.Accept);
    }

    function step_bReject() external {
        if (_terminal()) return;
        if (openDeal.status() != DealOpenTokenToken.Status.Locked) return;
        vm.prank(bob);
        openDeal.setMyVote(DealOpenTokenToken.Vote.Reject);
    }

    function step_abandon() external {
        if (_terminal()) return;
        if (openDeal.status() != DealOpenTokenToken.Status.Ready && openDeal.status() != DealOpenTokenToken.Status.Active)
        {
            return;
        }
        vm.prank(alice);
        openDeal.abandonByA();
    }

    /// @dev B 强结分支要求 aVote == Unset（无 preAccept 且 B 已投票）
    function step_forceCompleteB() external {
        if (_terminal()) return;
        if (openDeal.status() != DealOpenTokenToken.Status.Locked) return;
        if (openDeal.aVote() != DealOpenTokenToken.Vote.Unset) return;
        if (openDeal.bVote() == DealOpenTokenToken.Vote.Unset) return;
        // 与单元测试一致：绝对截止 = 投票时间 + timeout（勿再叠加 block.timestamp）
        uint256 t = uint256(openDeal.bAt()) + uint256(openDeal.timeoutSeconds()) + 1;
        vm.warp(t > block.timestamp ? t : block.timestamp);
        vm.prank(bob);
        try openDeal.forceComplete() {} catch {}
    }

    /// @dev preAccept 后 aVote==Accept：仅 A 可在 b 未投时超时强结
    function step_forceCompleteA() external {
        if (_terminal()) return;
        if (openDeal.status() != DealOpenTokenToken.Status.Locked) return;
        if (openDeal.bVote() != DealOpenTokenToken.Vote.Unset) return;
        if (openDeal.aVote() != DealOpenTokenToken.Vote.Accept) return;
        uint256 t = uint256(openDeal.aAt()) + uint256(openDeal.timeoutSeconds()) + 1;
        vm.warp(t > block.timestamp ? t : block.timestamp);
        vm.prank(alice);
        try openDeal.forceComplete() {} catch {}
    }

    function assertStatusBounded() external view {
        assertLe(uint8(openDeal.status()), uint8(DealOpenTokenToken.Status.Abandoned));
    }

    function assertNoBNftWithoutCounterparty() external view {
        if (openDeal.b() == address(0)) {
            assertEq(openDeal.bNftId(), 0);
            assertFalse(openDeal.bNftLocked());
        }
    }

    function assertCompletedClearsNft() external view {
        if (openDeal.status() == DealOpenTokenToken.Status.Completed) {
            assertEq(openDeal.bNftId(), 0);
            assertFalse(openDeal.bNftLocked());
        }
    }

    function assertEscrowSolvent() external view {
        uint256 aNeed = openDeal.aSwapAmount() + openDeal.aMarginAmount();
        uint256 bNeed = openDeal.bSwapAmount() + openDeal.bMarginAmount();
        assertLe(tokenA.balanceOf(address(openDeal)), aNeed + 1);
        assertLe(tokenB.balanceOf(address(openDeal)), bNeed + 1);
    }

    function assertAbandonedClearsB() external view {
        if (openDeal.status() == DealOpenTokenToken.Status.Abandoned) {
            assertEq(openDeal.b(), address(0), "abandoned must clear b");
        }
    }

    function assertActiveOrLockedHasB() external view {
        DealOpenTokenToken.Status s = openDeal.status();
        if (s == DealOpenTokenToken.Status.Active || s == DealOpenTokenToken.Status.Locked) {
            assertTrue(openDeal.b() != address(0), "active/locked needs counterparty");
        }
    }
}
