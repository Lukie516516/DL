import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, zeroAddress } from "viem";

const D_UNIT = 10n ** 18n;
const MAX_SUPPLY = 100n * D_UNIT;
const SEAT_THRESHOLD = 25n * D_UNIT / 10n;
const FAST_PASS_THRESHOLD = 70n * D_UNIT;
const ACTIVATION_THRESHOLD = SEAT_THRESHOLD; // 2.5 D

// Deploy DealGovernance as UUPS proxy
async function deployGovernance(viem: any, dAddr: `0x${string}`, dcAddr: `0x${string}`, treasury: `0x${string}`) {
  const impl = await viem.deployContract("DealGovernance", []);
  const initData = encodeFunctionData({
    abi: impl.abi,
    functionName: "initialize",
    args: [dAddr, zeroAddress, dcAddr, treasury],
  });
  const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initData]);
  return viem.getContractAt("DealGovernance", proxy.address);
}

async function waitFor(
  publicClient: Awaited<
    ReturnType<
      Awaited<ReturnType<typeof network.connect<{ network: "hardhatMainnet" }>>>["viem"]["getPublicClient"]
    >
  >,
  hash: `0x${string}`,
) {
  return publicClient.waitForTransactionReceipt({ hash });
}

describe("DAO Rules", async function () {
  it("configures D as a 100 supply, 18-decimal, transferable seat token", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const testClient = await viem.getTestClient();
    const [owner, alice, bob] = await viem.getWalletClients();

    const d = await viem.deployContract("D", [owner.account.address]);

    assert.equal(await d.read.decimals(), 18);
    assert.equal(await d.read.UNIT(), D_UNIT);
    assert.equal(await d.read.MAX_SUPPLY(), MAX_SUPPLY);
    assert.equal(await d.read.SEAT_THRESHOLD(), SEAT_THRESHOLD);
    assert.equal(await d.read.totalSupply(), MAX_SUPPLY);
    assert.equal(await d.read.balanceOf([owner.account.address]), MAX_SUPPLY);

    await waitFor(publicClient, await d.write.transfer([alice.account.address, SEAT_THRESHOLD]));
    await waitFor(publicClient, await d.write.transfer([bob.account.address, SEAT_THRESHOLD - 1n]));
    await testClient.mine({ blocks: 1 });
    const snapshot = BigInt(await d.read.clock()) - 1n;

    assert.equal(await d.read.hasSeat([alice.account.address]), true);
    assert.equal(await d.read.hasSeat([bob.account.address]), false);
    assert.equal(await d.read.getPastBalanceOf([alice.account.address, snapshot]), SEAT_THRESHOLD);
    assert.equal(await d.read.getPastTotalBalance([snapshot]), MAX_SUPPLY);

    assert.equal(await d.read.hasVotingSeat([alice.account.address]), false);
    const dAsAlice = await viem.getContractAt("D", d.address, {
      client: { wallet: alice },
    });
    await waitFor(publicClient, await dAsAlice.write.delegate([alice.account.address]));
    assert.equal(await d.read.hasVotingSeat([alice.account.address]), true);
  });

  it("sets the Governor proposal threshold to one D seat", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const [owner] = await viem.getWalletClients();

    const d = await viem.deployContract("D", [owner.account.address]);
    const timelock = await viem.deployContract("DealTimelock", [
      0n,
      [owner.account.address],
      [zeroAddress],
      owner.account.address,
    ]);
    const governor = await viem.deployContract("contracts/DealDao.sol:DealGovernor", [
      d.address,
      timelock.address,
    ]);

    assert.equal(await governor.read.D_SEAT_THRESHOLD(), SEAT_THRESHOLD);
    assert.equal(await governor.read.proposalThreshold(), SEAT_THRESHOLD);
  });

  it("distributes dividends by D balance snapshots, not delegated votes", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const testClient = await viem.getTestClient();
    const [owner, alice, bob, executor] = await viem.getWalletClients();

    const d = await viem.deployContract("D", [owner.account.address]);
    const dl = await viem.deployContract("DCToken", [
      "DealCoin",
      "DC",
      0n,
      owner.account.address,
      owner.account.address,
    ]);
    const claimer = await viem.deployContract("VoteDividendClaimer", [
      d.address,
      dl.address,
      executor.account.address,
      executor.account.address,
    ]);

    const tenD = 10n * D_UNIT;
    await waitFor(publicClient, await d.write.transfer([alice.account.address, tenD]));
    await testClient.mine({ blocks: 1 });

    const dlAmount = 1000n * 10n ** 18n;
    await waitFor(publicClient, await dl.write.mint([executor.account.address, dlAmount]));

    const claimerAsExecutor = await viem.getContractAt("VoteDividendClaimer", claimer.address, {
      client: { wallet: executor },
    });
    const dlAsExecutor = await viem.getContractAt("DCToken", dl.address, {
      client: { wallet: executor },
    });
    await waitFor(publicClient, await dlAsExecutor.write.approve([claimer.address, dlAmount]));
    await waitFor(publicClient, await claimerAsExecutor.write.createRound([dlAmount]));

    await waitFor(publicClient, await d.write.transfer([bob.account.address, tenD]));
    await testClient.mine({ blocks: 1 });

    const previewAlice = await claimer.read.previewClaim([0n, alice.account.address]);
    const previewBob = await claimer.read.previewClaim([0n, bob.account.address]);
    assert.equal(previewAlice[0], tenD);
    assert.equal(previewAlice[1], 100n * 10n ** 18n);
    assert.equal(previewBob[0], 0n);
    assert.equal(previewBob[1], 0n);

    const claimerAsAlice = await viem.getContractAt("VoteDividendClaimer", claimer.address, {
      client: { wallet: alice },
    });
    await waitFor(publicClient, await claimerAsAlice.write.claim([0n]));
    assert.equal(await dl.read.balanceOf([alice.account.address]), 100n * 10n ** 18n);
  });

  it("only allows the dividend executor to create official treasury rounds", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [owner, alice, bob, executor] = await viem.getWalletClients();

    const d = await viem.deployContract("D", [owner.account.address]);
    const dl = await viem.deployContract("DCToken", [
      "DealCoin",
      "DC",
      0n,
      owner.account.address,
      owner.account.address,
    ]);
    const claimer = await viem.deployContract("VoteDividendClaimer", [
      d.address,
      dl.address,
      executor.account.address,
      executor.account.address,
    ]);

    await waitFor(publicClient, await d.write.transfer([alice.account.address, SEAT_THRESHOLD]));

    const dlAmount = 500n * 10n ** 18n;
    await waitFor(publicClient, await dl.write.mint([alice.account.address, dlAmount]));
    await waitFor(publicClient, await dl.write.mint([executor.account.address, dlAmount]));

    const claimerAsAlice = await viem.getContractAt("VoteDividendClaimer", claimer.address, {
      client: { wallet: alice },
    });
    const claimerAsBob = await viem.getContractAt("VoteDividendClaimer", claimer.address, {
      client: { wallet: bob },
    });
    const claimerAsExecutor = await viem.getContractAt("VoteDividendClaimer", claimer.address, {
      client: { wallet: executor },
    });
    const dlAsAlice = await viem.getContractAt("DCToken", dl.address, {
      client: { wallet: alice },
    });
    const dlAsExecutor = await viem.getContractAt("DCToken", dl.address, {
      client: { wallet: executor },
    });

    await assert.rejects(claimerAsBob.write.createRound([1n]), /NOT_EXECUTOR/);
    await waitFor(publicClient, await dlAsAlice.write.approve([claimer.address, dlAmount]));
    await assert.rejects(claimerAsAlice.write.createRound([dlAmount]), /NOT_EXECUTOR/);
    await waitFor(publicClient, await dlAsExecutor.write.approve([claimer.address, dlAmount]));
    await waitFor(publicClient, await claimerAsExecutor.write.createRound([dlAmount]));

    const round = await claimer.read.getRound([0n]);
    assert.equal(round.total, dlAmount);
    assert.equal(await dl.read.balanceOf([claimer.address]), dlAmount);
  });

  it("can refresh NFT governance activity when claiming dividends", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const testClient = await viem.getTestClient();
    const [owner, alice, executor] = await viem.getWalletClients();

    const d = await viem.deployContract("D", [owner.account.address]);
    const dl = await viem.deployContract("DCToken", [
      "DealCoin",
      "DC",
      0n,
      owner.account.address,
      owner.account.address,
    ]);
    const nft = await viem.deployContract("TestERC721");
    const activity = await viem.deployContract("DealNftGovernanceActivity", [nft.address]);
    const claimer = await viem.deployContract("VoteDividendClaimer", [
      d.address,
      dl.address,
      executor.account.address,
      executor.account.address,
    ]);

    await waitFor(publicClient, await nft.write.mint([alice.account.address]));
    await waitFor(publicClient, await activity.write.setRecorder([claimer.address, true]));
    const claimerAsExecutor = await viem.getContractAt("VoteDividendClaimer", claimer.address, {
      client: { wallet: executor },
    });
    await waitFor(publicClient, await claimerAsExecutor.write.setGovernanceActivity([nft.address, activity.address]));

    const tenD = 10n * D_UNIT;
    await waitFor(publicClient, await d.write.transfer([alice.account.address, tenD]));
    await testClient.mine({ blocks: 1 });

    const dlAmount = 1000n * 10n ** 18n;
    await waitFor(publicClient, await dl.write.mint([executor.account.address, dlAmount]));
    const dlAsExecutor = await viem.getContractAt("DCToken", dl.address, {
      client: { wallet: executor },
    });
    await waitFor(publicClient, await dlAsExecutor.write.approve([claimer.address, dlAmount]));
    await waitFor(publicClient, await claimerAsExecutor.write.createRound([dlAmount]));

    const claimerAsAlice = await viem.getContractAt("VoteDividendClaimer", claimer.address, {
      client: { wallet: alice },
    });
    await waitFor(publicClient, await claimerAsAlice.write.claimForNft([0n, 1n]));
    assert.equal(await activity.read.isActive([1n]), true);
  });

  it("allows D seats to veto regular proposals", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const testClient = await viem.getTestClient();
    const [owner, alice, bob] = await viem.getWalletClients();

    const d = await viem.deployContract("D", [owner.account.address]);
    const governor = await viem.deployContract("DealSeatVetoGovernor", [d.address, zeroAddress]);
    const dl = await viem.deployContract("DCToken", [
      "DealCoin",
      "DC",
      0n,
      owner.account.address,
      owner.account.address,
    ]);
    const minterRole = await dl.read.MINTER_ROLE();
    await waitFor(publicClient, await dl.write.grantRole([minterRole, governor.address]));
    await waitFor(publicClient, await d.write.transfer([alice.account.address, SEAT_THRESHOLD]));
    await waitFor(publicClient, await d.write.transfer([bob.account.address, SEAT_THRESHOLD]));
    await testClient.mine({ blocks: 1 });

    const governorAsAlice = await viem.getContractAt("DealSeatVetoGovernor", governor.address, {
      client: { wallet: alice },
    });
    const governorAsBob = await viem.getContractAt("DealSeatVetoGovernor", governor.address, {
      client: { wallet: bob },
    });
    const mintCalldata = encodeFunctionData({
      abi: dl.abi,
      functionName: "mint",
      args: [bob.account.address, 1n * 10n ** 18n],
    });

    await waitFor(publicClient, await governorAsAlice.write.propose([
      [dl.address],
      [0n],
      [mintCalldata],
      "mint test DC",
      0,
    ]));
    assert.equal(await governor.read.state([1n]), 1);

    await waitFor(publicClient, await governorAsBob.write.veto([1n]));
    assert.equal(await governor.read.state([1n]), 2);
    await assert.rejects(governorAsAlice.write.execute([1n]), /AlreadyVetoed/);
  });

  it("executes a non-vetoed proposal after the veto window", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const testClient = await viem.getTestClient();
    const [owner, alice, bob] = await viem.getWalletClients();

    const d = await viem.deployContract("D", [owner.account.address]);
    const governor = await viem.deployContract("DealSeatVetoGovernor", [d.address, zeroAddress]);
    const dl = await viem.deployContract("DCToken", [
      "DealCoin",
      "DC",
      0n,
      owner.account.address,
      owner.account.address,
    ]);
    const minterRole = await dl.read.MINTER_ROLE();
    await waitFor(publicClient, await dl.write.grantRole([minterRole, governor.address]));
    await waitFor(publicClient, await d.write.transfer([alice.account.address, SEAT_THRESHOLD]));
    await testClient.mine({ blocks: 1 });

    const governorAsAlice = await viem.getContractAt("DealSeatVetoGovernor", governor.address, {
      client: { wallet: alice },
    });
    await assert.rejects(governorAsAlice.write.setVetoWindows([3600, 7200]), /OnlyGovernance/);
    const setWindowsCalldata = encodeFunctionData({
      abi: governor.abi,
      functionName: "setVetoWindows",
      args: [3600, 7200],
    });

    await waitFor(publicClient, await governorAsAlice.write.propose([
      [governor.address],
      [0n],
      [setWindowsCalldata],
      "set veto windows",
      0,
    ]));

    const block = await publicClient.getBlock();
    await testClient.setNextBlockTimestamp({ timestamp: block.timestamp + 48n * 3600n + 1n });
    await testClient.mine({ blocks: 1 });
    assert.equal(await governor.read.state([1n]), 3);

    await waitFor(publicClient, await governorAsAlice.write.execute([1n]));
    assert.equal(await governor.read.state([1n]), 4);
    assert.equal(await governor.read.regularVetoWindow(), 3600);
    assert.equal(await governor.read.majorVetoWindow(), 7200);
  });

  it("allows D seat to veto a Parameter proposal during Pending stage (before activation)", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [owner, alice, bob] = await viem.getWalletClients();

    const d  = await viem.deployContract("D", [owner.account.address]);
    const dc = await viem.deployContract("DCToken", ["DC", "DC", 0n, owner.account.address, owner.account.address]);
    const gov = await deployGovernance(viem, d.address, dc.address, owner.account.address);

    // Give alice and bob a D seat each
    await waitFor(publicClient, await d.write.transfer([alice.account.address, SEAT_THRESHOLD]));
    await waitFor(publicClient, await d.write.transfer([bob.account.address,  SEAT_THRESHOLD]));

    // Alice creates a Parameter proposal — lands in Pending (no D staked yet)
    const govAsAlice = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: alice } });
    const govAsBob   = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: bob } });

    const noop = encodeFunctionData({ abi: gov.abi, functionName: "setFastPassThreshold", args: [70n * D_UNIT] });
    await waitFor(publicClient, await govAsAlice.write.createProposal([
      [gov.address], [0n], [noop], "test pending veto", 0,
    ]));

    // State must be Pending (nothing staked)
    assert.equal(await gov.read.state([1n]), 1 /* Pending */);

    // Bob vetoes during Pending — should succeed
    await waitFor(publicClient, await govAsBob.write.veto([1n]));
    assert.equal(await gov.read.state([1n]), 4 /* Vetoed */);

    // Execute must fail
    await assert.rejects(govAsAlice.write.execute([1n]), /AlreadyVetoed|AlreadyEnded/);
  });

  it("fast-passes a Parameter proposal when totalStaked reaches fastPassThreshold while window is open", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [owner, alice, bob] = await viem.getWalletClients();

    const d   = await viem.deployContract("D", [owner.account.address]);
    const dc  = await viem.deployContract("DCToken", ["DC", "DC", 0n, owner.account.address, owner.account.address]);
    const gov = await deployGovernance(viem, d.address, dc.address, owner.account.address);

    // alice 30 D, bob 30 D, owner keeps 40 D
    const thirtyD    = 30n * D_UNIT;
    const sevenHalfD = 75n * D_UNIT / 10n; // 7.5 D
    await waitFor(publicClient, await d.write.transfer([alice.account.address, thirtyD]));
    await waitFor(publicClient, await d.write.transfer([bob.account.address,   thirtyD]));

    const govAsOwner = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: owner } });
    const govAsAlice = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: alice } });
    const govAsBob   = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: bob } });

    const noop = encodeFunctionData({ abi: gov.abi, functionName: "setFastPassThreshold", args: [70n * D_UNIT] });
    await waitFor(publicClient, await govAsAlice.write.createProposal([
      [gov.address], [0n], [noop], "fast pass test", 0,
    ]));
    assert.equal(await gov.read.state([1n]), 1 /* Pending */);

    // Owner stakes 2.5 D to activate
    await waitFor(publicClient, await d.write.approve([gov.address, ACTIVATION_THRESHOLD]));
    await waitFor(publicClient, await govAsOwner.write.stake([1n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.state([1n]), 2 /* Active */);

    // alice 30D + bob 30D = totalStaked 62.5D — not enough yet
    await waitFor(publicClient, await d.write.approve([gov.address, thirtyD], { account: alice.account }));
    await waitFor(publicClient, await govAsAlice.write.stake([1n, thirtyD]));
    assert.equal(await gov.read.state([1n]), 2 /* still Active */);

    await waitFor(publicClient, await d.write.approve([gov.address, thirtyD], { account: bob.account }));
    await waitFor(publicClient, await govAsBob.write.stake([1n, thirtyD]));
    assert.equal(await gov.read.state([1n]), 2 /* still Active, 62.5 < 70 */);

    // owner stakes 7.5 D more → totalStaked = 70 D ≥ fastPassThreshold → Succeeded
    await waitFor(publicClient, await d.write.approve([gov.address, sevenHalfD]));
    await waitFor(publicClient, await govAsOwner.write.stake([1n, sevenHalfD]));
    assert.equal(await gov.read.state([1n]), 3 /* Succeeded */);

    // Execute immediately — no need to wait for window
    await waitFor(publicClient, await govAsAlice.write.execute([1n]));
    assert.equal(await gov.read.state([1n]), 6 /* Executed */);
  });

  it("fast-passed proposal can still be vetoed by D-seat holder while window is open", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [owner, alice, bob] = await viem.getWalletClients();

    const d   = await viem.deployContract("D", [owner.account.address]);
    const dc  = await viem.deployContract("DCToken", ["DC", "DC", 0n, owner.account.address, owner.account.address]);
    const gov = await deployGovernance(viem, d.address, dc.address, owner.account.address);

    // owner: 90D, alice: 10D (keeps wallet D for veto seat), bob: 2.5D
    await waitFor(publicClient, await d.write.transfer([alice.account.address, 10n * D_UNIT]));
    await waitFor(publicClient, await d.write.transfer([bob.account.address,   SEAT_THRESHOLD]));

    const govAsOwner = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: owner } });
    const govAsAlice = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: alice } });
    const govAsBob   = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: bob } });

    // Step 1: lower fastPassThreshold to 5 D via a passed Parameter proposal
    const setFpCalldata = encodeFunctionData({
      abi: gov.abi, functionName: "setFastPassThreshold", args: [5n * D_UNIT],
    });
    await waitFor(publicClient, await govAsAlice.write.createProposal([
      [gov.address], [0n], [setFpCalldata], "lower fast-pass for test", 0,
    ]));
    // owner stakes 70 D → totalStaked = 70 D ≥ fastPassThreshold (70 D) → Succeeded
    await waitFor(publicClient, await d.write.approve([gov.address, FAST_PASS_THRESHOLD]));
    await waitFor(publicClient, await govAsOwner.write.stake([1n, FAST_PASS_THRESHOLD]));
    assert.equal(await gov.read.state([1n]), 3 /* Succeeded */);
    await waitFor(publicClient, await govAsOwner.write.execute([1n]));
    assert.equal(await gov.read.fastPassThreshold(), 5n * D_UNIT);

    // Step 2: Bob creates proposal 2, totalStaked reaches new fastPassThreshold (5 D)
    const noop = encodeFunctionData({ abi: gov.abi, functionName: "setFastPassThreshold", args: [5n * D_UNIT] });
    await waitFor(publicClient, await govAsBob.write.createProposal([
      [gov.address], [0n], [noop], "veto overrides fast-pass", 0,
    ]));
    // owner stakes 2.5 D to activate
    await waitFor(publicClient, await d.write.approve([gov.address, ACTIVATION_THRESHOLD]));
    await waitFor(publicClient, await govAsOwner.write.stake([2n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.state([2n]), 2 /* Active */);

    // owner stakes 2.5 D more → totalStaked = 5 D ≥ fastPassThreshold (5 D) → Succeeded
    await waitFor(publicClient, await d.write.approve([gov.address, ACTIVATION_THRESHOLD]));
    await waitFor(publicClient, await govAsOwner.write.stake([2n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.state([2n]), 3 /* Succeeded */);

    // Alice (10 D in wallet, never staked) vetoes — veto wins over fast-pass
    await waitFor(publicClient, await govAsAlice.write.veto([2n]));
    assert.equal(await gov.read.state([2n]), 4 /* Vetoed */);
    await assert.rejects(govAsOwner.write.execute([2n]), /AlreadyVetoed|AlreadyEnded/);
  });

  it("lets active official NFTs veto a major seat proposal at the 20% threshold", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [owner, alice, bob, carol, dave] = await viem.getWalletClients();

    const d = await viem.deployContract("D", [owner.account.address]);
    const nft = await viem.deployContract("TestERC721");
    const activity = await viem.deployContract("DealNftGovernanceActivity", [nft.address]);
    const nftVeto = await viem.deployContract("NftVetoRegistry", [nft.address, activity.address]);
    const governor = await viem.deployContract("DealSeatVetoGovernor", [d.address, nftVeto.address]);
    const dl = await viem.deployContract("DCToken", [
      "DealCoin",
      "DC",
      0n,
      owner.account.address,
      owner.account.address,
    ]);

    await waitFor(publicClient, await nftVeto.write.setGovernor([governor.address, true]));
    await waitFor(publicClient, await activity.write.setRecorder([owner.account.address, true]));
    await waitFor(publicClient, await activity.write.setRecorder([nftVeto.address, true]));
    await waitFor(publicClient, await d.write.transfer([alice.account.address, SEAT_THRESHOLD]));

    const tokenOwners = [bob.account.address, carol.account.address, owner.account.address, alice.account.address, bob.account.address];
    for (const to of tokenOwners) {
      await waitFor(publicClient, await nft.write.mint([to]));
    }
    await waitFor(publicClient, await activity.write.markActiveBatch([[1n, 2n, 3n, 4n, 5n]]));
    assert.equal(await activity.read.activeGovernanceSupply(), 5n);

    const minterRole = await dl.read.MINTER_ROLE();
    await waitFor(publicClient, await dl.write.grantRole([minterRole, governor.address]));
    const governorAsAlice = await viem.getContractAt("DealSeatVetoGovernor", governor.address, {
      client: { wallet: alice },
    });
    const mintCalldata = encodeFunctionData({
      abi: dl.abi,
      functionName: "mint",
      args: [carol.account.address, 1n * 10n ** 18n],
    });

    await waitFor(publicClient, await governorAsAlice.write.propose([
      [dl.address],
      [0n],
      [mintCalldata],
      "mint test DC",
      1,
    ]));

    const vetoState = await nftVeto.read.proposalInfo([1n]);
    assert.equal(vetoState.activeSupplySnapshot, 5n);

    const nftAsBob = await viem.getContractAt("TestERC721", nft.address, {
      client: { wallet: bob },
    });
    await waitFor(publicClient, await nftAsBob.write.transferFrom([bob.account.address, dave.account.address, 1n]));

    const nftVetoAsBob = await viem.getContractAt("NftVetoRegistry", nftVeto.address, {
      client: { wallet: bob },
    });
    const nftVetoAsDave = await viem.getContractAt("NftVetoRegistry", nftVeto.address, {
      client: { wallet: dave },
    });
    await assert.rejects(nftVetoAsBob.write.castVeto([1n, 1n]));
    await waitFor(publicClient, await nftVetoAsDave.write.castVeto([1n, 1n]));

    assert.equal(await nftVeto.read.isProposalVetoed([1n]), true);
    assert.equal(await governor.read.state([1n]), 2);
    await assert.rejects(governorAsAlice.write.execute([1n]), /AlreadyVetoed/);
  });

  it("locks unstaking once totalStaked reaches fastPassThreshold (prevents de-activation attack)", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [owner, alice, bob] = await viem.getWalletClients();

    const d   = await viem.deployContract("D", [owner.account.address]);
    const dc  = await viem.deployContract("DCToken", ["DC", "DC", 0n, owner.account.address, owner.account.address]);
    const gov = await deployGovernance(viem, d.address, dc.address, owner.account.address);

    // alice 30 D, bob 30 D, owner keeps 40 D
    const thirtyD = 30n * D_UNIT;
    const tenD    = 10n * D_UNIT;
    await waitFor(publicClient, await d.write.transfer([alice.account.address, thirtyD]));
    await waitFor(publicClient, await d.write.transfer([bob.account.address,   thirtyD]));

    const govAsOwner = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: owner } });
    const govAsAlice = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: alice } });
    const govAsBob   = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: bob } });

    const noop = encodeFunctionData({ abi: gov.abi, functionName: "setFastPassThreshold", args: [70n * D_UNIT] });
    await waitFor(publicClient, await govAsAlice.write.createProposal([
      [gov.address], [0n], [noop], "unstake lock test", 0,
    ]));

    // Owner stakes 2.5 D to activate
    await waitFor(publicClient, await d.write.approve([gov.address, ACTIVATION_THRESHOLD]));
    await waitFor(publicClient, await govAsOwner.write.stake([1n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.state([1n]), 2 /* Active */);

    // alice 30D + bob 30D → totalStaked = 62.5D, still Active
    await waitFor(publicClient, await d.write.approve([gov.address, thirtyD], { account: alice.account }));
    await waitFor(publicClient, await govAsAlice.write.stake([1n, thirtyD]));
    await waitFor(publicClient, await d.write.approve([gov.address, thirtyD], { account: bob.account }));
    await waitFor(publicClient, await govAsBob.write.stake([1n, thirtyD]));
    assert.equal(await gov.read.state([1n]), 2 /* still Active */);

    // owner stakes 10 D more → totalStaked = 72.5 D ≥ 70 D → Succeeded (fast-pass)
    await waitFor(publicClient, await d.write.approve([gov.address, tenD]));
    await waitFor(publicClient, await govAsOwner.write.stake([1n, tenD]));
    assert.equal(await gov.read.state([1n]), 3 /* Succeeded */);

    // Attempting to unstake MUST now revert — stakes are locked
    await assert.rejects(
      govAsOwner.write.unstake([1n, ACTIVATION_THRESHOLD]),
      /WindowExpired/,
    );

    // State is still Succeeded (no de-activation attack possible)
    assert.equal(await gov.read.state([1n]), 3 /* Succeeded */);

    // Execute proceeds normally
    await waitFor(publicClient, await govAsAlice.write.execute([1n]));
    assert.equal(await gov.read.state([1n]), 6 /* Executed */);
  });

  it("Satoshi proposal stays Succeeded after all stakers unstake (satoshiSucceeded is permanent)", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [owner, alice] = await viem.getWalletClients();

    const d   = await viem.deployContract("D", [owner.account.address]);
    const dc  = await viem.deployContract("DCToken", ["DC", "DC", 0n, owner.account.address, owner.account.address]);
    const gov = await deployGovernance(viem, d.address, dc.address, owner.account.address);

    const SATOSHI_THRESHOLD = 90n * D_UNIT;

    // owner holds 100 D — enough to stake 90 D and pass the Satoshi threshold
    const govAsOwner = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: owner } });
    const govAsAlice = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: alice } });

    // Transfer 2.5 D to alice so she can create a Satoshi proposal (seat threshold)
    await waitFor(publicClient, await d.write.transfer([alice.account.address, ACTIVATION_THRESHOLD]));

    const noop = encodeFunctionData({ abi: gov.abi, functionName: "setFastPassThreshold", args: [70n * D_UNIT] });
    await waitFor(publicClient, await govAsAlice.write.createProposal([
      [gov.address], [0n], [noop], "satoshi test", 3 /* Satoshi */,
    ]));
    assert.equal(await gov.read.state([1n]), 1 /* Pending */);

    // Stake 90 D — crosses satoshiPassThreshold → satoshiSucceeded = true
    await waitFor(publicClient, await d.write.approve([gov.address, SATOSHI_THRESHOLD]));
    await waitFor(publicClient, await govAsOwner.write.stake([1n, SATOSHI_THRESHOLD]));
    assert.equal(await gov.read.state([1n]), 3 /* Succeeded */);

    // Owner unstakes all 90 D — totalStaked drops to 0
    await waitFor(publicClient, await govAsOwner.write.unstake([1n, SATOSHI_THRESHOLD]));
    assert.equal((await gov.read.getProposal([1n])).totalStaked, 0n);

    // Proposal must still be Succeeded — satoshiSucceeded is permanent
    assert.equal(await gov.read.state([1n]), 3 /* Succeeded */);

    // Execute works despite zero totalStaked
    await waitFor(publicClient, await govAsAlice.write.execute([1n]));
    assert.equal(await gov.read.state([1n]), 6 /* Executed */);
  });

  // ─── 集票否决 (vetoStake) ─────────────────────────────────────────────────

  it("多人集票否决：三人合计达到 2.5 D 门槛时提案立即被否决", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [owner, alice, bob, carol] = await viem.getWalletClients();

    const d   = await viem.deployContract("D", [owner.account.address]);
    const dc  = await viem.deployContract("DCToken", ["DC", "DC", 0n, owner.account.address, owner.account.address]);
    const gov = await deployGovernance(viem, d.address, dc.address, owner.account.address);

    // 分发 D：alice 1 D，bob 1 D，carol 0.6 D，owner 激活提案用 2.5 D
    const ONE   = 1n * D_UNIT;
    const PT6   = 6n * D_UNIT / 10n;  // 0.6 D
    await waitFor(publicClient, await d.write.transfer([alice.account.address, ONE]));
    await waitFor(publicClient, await d.write.transfer([bob.account.address,   ONE]));
    await waitFor(publicClient, await d.write.transfer([carol.account.address, PT6]));

    // owner 创建 Parameter 提案
    const govAsOwner = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: owner } });
    const govAsAlice = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: alice } });
    const govAsBob   = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: bob } });
    const govAsCarol = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: carol } });

    const noop = encodeFunctionData({ abi: gov.abi, functionName: "setFastPassThreshold", args: [70n * D_UNIT] });
    await waitFor(publicClient, await govAsOwner.write.createProposal([[gov.address], [0n], [noop], "collective veto test", 0]));

    // owner 质押 2.5 D 激活提案
    const dAsOwner = await viem.getContractAt("D", d.address, { client: { wallet: owner } });
    await waitFor(publicClient, await dAsOwner.write.approve([gov.address, ACTIVATION_THRESHOLD]));
    await waitFor(publicClient, await govAsOwner.write.stake([1n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.state([1n]), 2 /* Active */);

    // alice 投 1 D 否决票 — 未达门槛，提案仍 Active
    const dAsAlice = await viem.getContractAt("D", d.address, { client: { wallet: alice } });
    await waitFor(publicClient, await dAsAlice.write.approve([gov.address, ONE]));
    await waitFor(publicClient, await govAsAlice.write.vetoStake([1n, ONE]));
    assert.equal(await gov.read.state([1n]), 2 /* Active，1 D < 2.5 D */);
    assert.equal(await gov.read.totalVetoStaked([1n]), ONE);

    // bob 投 1 D — 累计 2 D，仍未触发
    const dAsBob = await viem.getContractAt("D", d.address, { client: { wallet: bob } });
    await waitFor(publicClient, await dAsBob.write.approve([gov.address, ONE]));
    await waitFor(publicClient, await govAsBob.write.vetoStake([1n, ONE]));
    assert.equal(await gov.read.state([1n]), 2 /* Active，2 D < 2.5 D */);

    // carol 投 0.6 D — 累计 2.6 D >= 2.5 D → 立即否决
    const dAsCarol = await viem.getContractAt("D", d.address, { client: { wallet: carol } });
    await waitFor(publicClient, await dAsCarol.write.approve([gov.address, PT6]));
    await waitFor(publicClient, await govAsCarol.write.vetoStake([1n, PT6]));
    assert.equal(await gov.read.state([1n]), 4 /* Vetoed */);
    assert.equal(await gov.read.totalVetoStaked([1n]), ONE + ONE + PT6);

    // 触发后不能再执行
    await assert.rejects(govAsOwner.write.execute([1n]), /AlreadyVetoed|AlreadyEnded/);
  });

  it("集票否决后各人可通过 claimBack 取回自己的否决质押 D", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [owner, alice, bob] = await viem.getWalletClients();

    const d   = await viem.deployContract("D", [owner.account.address]);
    const dc  = await viem.deployContract("DCToken", ["DC", "DC", 0n, owner.account.address, owner.account.address]);
    const gov = await deployGovernance(viem, d.address, dc.address, owner.account.address);

    const PT5 = 5n * D_UNIT / 10n;  // 0.5 D per person → 两人凑 1 D，owner 再凑 1.5 D = 2.5 D
    const PT15 = 15n * D_UNIT / 10n;
    await waitFor(publicClient, await d.write.transfer([alice.account.address, PT5]));
    await waitFor(publicClient, await d.write.transfer([bob.account.address,   PT5]));

    const govAsOwner = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: owner } });
    const govAsAlice = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: alice } });
    const govAsBob   = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: bob } });
    const dAsOwner   = await viem.getContractAt("D", d.address, { client: { wallet: owner } });
    const dAsAlice   = await viem.getContractAt("D", d.address, { client: { wallet: alice } });
    const dAsBob     = await viem.getContractAt("D", d.address, { client: { wallet: bob } });

    const noop = encodeFunctionData({ abi: gov.abi, functionName: "setFastPassThreshold", args: [70n * D_UNIT] });
    await waitFor(publicClient, await govAsOwner.write.createProposal([[gov.address], [0n], [noop], "claimback test", 0]));

    // owner 激活提案
    await waitFor(publicClient, await dAsOwner.write.approve([gov.address, ACTIVATION_THRESHOLD]));
    await waitFor(publicClient, await govAsOwner.write.stake([1n, ACTIVATION_THRESHOLD]));

    // 三人集票否决
    await waitFor(publicClient, await dAsAlice.write.approve([gov.address, PT5]));
    await waitFor(publicClient, await govAsAlice.write.vetoStake([1n, PT5]));
    await waitFor(publicClient, await dAsBob.write.approve([gov.address, PT5]));
    await waitFor(publicClient, await govAsBob.write.vetoStake([1n, PT5]));
    await waitFor(publicClient, await dAsOwner.write.approve([gov.address, PT15]));
    await waitFor(publicClient, await govAsOwner.write.vetoStake([1n, PT15]));  // 触发否决

    assert.equal(await gov.read.state([1n]), 4 /* Vetoed */);

    // alice 取回 0.5 D
    const aliceBefore = await d.read.balanceOf([alice.account.address]);
    await waitFor(publicClient, await govAsAlice.write.claimBack([1n]));
    const aliceAfter = await d.read.balanceOf([alice.account.address]);
    assert.equal(aliceAfter - aliceBefore, PT5);

    // bob 取回 0.5 D
    const bobBefore = await d.read.balanceOf([bob.account.address]);
    await waitFor(publicClient, await govAsBob.write.claimBack([1n]));
    const bobAfter = await d.read.balanceOf([bob.account.address]);
    assert.equal(bobAfter - bobBefore, PT5);

    // 重复 claimBack 应失败
    await assert.rejects(govAsAlice.write.claimBack([1n]), /NothingToClaim/);
  });

  it("claimBack 一次性退还支持质押和否决质押", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [owner, alice] = await viem.getWalletClients();

    const d   = await viem.deployContract("D", [owner.account.address]);
    const dc  = await viem.deployContract("DCToken", ["DC", "DC", 0n, owner.account.address, owner.account.address]);
    const gov = await deployGovernance(viem, d.address, dc.address, owner.account.address);

    // alice 拿 3.5 D：1 D 支持（stake）+ 2.5 D 集票否决（vetoStake）
    const ONE = 1n * D_UNIT;
    const threeHalfD = ONE + ACTIVATION_THRESHOLD;  // 3.5 D
    await waitFor(publicClient, await d.write.transfer([alice.account.address, threeHalfD]));

    const govAsOwner = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: owner } });
    const govAsAlice = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: alice } });
    const dAsAlice   = await viem.getContractAt("D", d.address, { client: { wallet: alice } });

    const noop = encodeFunctionData({ abi: gov.abi, functionName: "setFastPassThreshold", args: [70n * D_UNIT] });
    await waitFor(publicClient, await govAsOwner.write.createProposal([[gov.address], [0n], [noop], "both stake test", 0]));

    // alice 先质押 1 D 支持提案（激活）
    await waitFor(publicClient, await dAsAlice.write.approve([gov.address, threeHalfD]));
    await waitFor(publicClient, await govAsAlice.write.stake([1n, ONE]));
    // owner 再补 1.5 D 激活
    const dAsOwner = await viem.getContractAt("D", d.address, { client: { wallet: owner } });
    await waitFor(publicClient, await dAsOwner.write.approve([gov.address, ACTIVATION_THRESHOLD]));
    await waitFor(publicClient, await govAsOwner.write.stake([1n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.state([1n]), 2 /* Active */);

    // alice 再 vetoStake 2.5 D → 立即触发否决（approve 已在上面一并给足 3.5 D）
    await waitFor(publicClient, await govAsAlice.write.vetoStake([1n, ACTIVATION_THRESHOLD]));
    assert.equal(await gov.read.state([1n]), 4 /* Vetoed */);

    // alice 持有 stakeOf=1D + vetoStakeOf=2.5D，claimBack 应退还 3.5 D
    const aliceBefore = await d.read.balanceOf([alice.account.address]);
    await waitFor(publicClient, await govAsAlice.write.claimBack([1n]));
    const aliceAfter = await d.read.balanceOf([alice.account.address]);
    assert.equal(aliceAfter - aliceBefore, threeHalfD /* 3.5 D */);
  });

  it("Treasury 提案不允许集票否决", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [owner, alice] = await viem.getWalletClients();

    const d   = await viem.deployContract("D", [owner.account.address]);
    const dc  = await viem.deployContract("DCToken", ["DC", "DC", 0n, owner.account.address, owner.account.address]);
    const gov = await deployGovernance(viem, d.address, dc.address, owner.account.address);

    await waitFor(publicClient, await d.write.transfer([alice.account.address, ACTIVATION_THRESHOLD]));
    const govAsAlice = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: alice } });
    const dAsAlice   = await viem.getContractAt("D", d.address, { client: { wallet: alice } });

    // 创建 Treasury 提案（kind=1）
    const noop = encodeFunctionData({ abi: gov.abi, functionName: "setFastPassThreshold", args: [70n * D_UNIT] });
    await waitFor(publicClient, await govAsAlice.write.createProposal([[gov.address], [0n], [noop], "treasury test", 1]));

    await waitFor(publicClient, await dAsAlice.write.approve([gov.address, ACTIVATION_THRESHOLD]));
    await assert.rejects(
      govAsAlice.write.vetoStake([1n, ACTIVATION_THRESHOLD]),
      /CannotVetoTreasury/
    );
  });

  it("Parameter 提案窗口关闭后不允许集票否决", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const testClient   = await viem.getTestClient();
    const [owner, alice] = await viem.getWalletClients();

    const d   = await viem.deployContract("D", [owner.account.address]);
    const dc  = await viem.deployContract("DCToken", ["DC", "DC", 0n, owner.account.address, owner.account.address]);
    const gov = await deployGovernance(viem, d.address, dc.address, owner.account.address);

    await waitFor(publicClient, await d.write.transfer([alice.account.address, ACTIVATION_THRESHOLD]));
    const govAsOwner = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: owner } });
    const govAsAlice = await viem.getContractAt("DealGovernance", gov.address, { client: { wallet: alice } });
    const dAsOwner   = await viem.getContractAt("D", d.address, { client: { wallet: owner } });
    const dAsAlice   = await viem.getContractAt("D", d.address, { client: { wallet: alice } });

    const noop = encodeFunctionData({ abi: gov.abi, functionName: "setFastPassThreshold", args: [70n * D_UNIT] });
    await waitFor(publicClient, await govAsOwner.write.createProposal([[gov.address], [0n], [noop], "window test", 0]));

    // 激活提案，开启 24h 窗口
    await waitFor(publicClient, await dAsOwner.write.approve([gov.address, ACTIVATION_THRESHOLD]));
    await waitFor(publicClient, await govAsOwner.write.stake([1n, ACTIVATION_THRESHOLD]));

    // 快进 25 小时，窗口关闭
    const block = await publicClient.getBlock();
    await testClient.setNextBlockTimestamp({ timestamp: block.timestamp + 25n * 3600n });
    await testClient.mine({ blocks: 1 });
    assert.equal(await gov.read.state([1n]), 3 /* Succeeded */);

    // 窗口关闭后 vetoStake 应失败
    await waitFor(publicClient, await dAsAlice.write.approve([gov.address, ACTIVATION_THRESHOLD]));
    await assert.rejects(
      govAsAlice.write.vetoStake([1n, ACTIVATION_THRESHOLD]),
      /WindowExpired/
    );
  });
});
