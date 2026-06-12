import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, zeroAddress } from "viem";

const D_UNIT = 10n ** 18n;
const MAX_SUPPLY = 100n * D_UNIT;
const SEAT_THRESHOLD = 25n * D_UNIT / 10n;

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
});
