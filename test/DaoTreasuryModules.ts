import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, toFunctionSelector, zeroAddress } from "viem";

import {
  buildDaoV2TreasuryModuleRules,
  DAO_V2_PROPOSAL_KIND,
} from "../scripts/dao-v2-policy.js";
import { materializeArtifactRuntime } from "../scripts/deployed-runtime-code.js";

const UNIT = 10n ** 18n;

async function waitFor(publicClient: any, hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  return receipt;
}

async function deployGovernanceFixture() {
  const { viem } = await network.connect({ network: "hardhatMainnet" });
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();
  const [owner, alice, bob, outsider] = await viem.getWalletClients();
  const d = await viem.deployContract("D", [owner.account.address]);
  const dc = await viem.deployContract("DCToken", [
    "DealCoin",
    "DC",
    0n,
    owner.account.address,
    owner.account.address,
  ]);
  const implementation = await viem.deployContract("DealGovernanceHarness", []);
  const initData = encodeFunctionData({
    abi: implementation.abi,
    functionName: "initialize",
    args: [d.address, zeroAddress, dc.address, owner.account.address],
  });
  const proxy = await viem.deployContract("ERC1967Proxy", [implementation.address, initData]);
  const governance = await viem.getContractAt("DealGovernanceHarness", proxy.address);
  const satoshiImplementation = await viem.deployContract("SatoshiVault");
  const satoshiInitData = encodeFunctionData({
    abi: satoshiImplementation.abi,
    functionName: "initialize",
    args: [dc.address, proxy.address],
  });
  const satoshiProxy = await viem.deployContract("ERC1967Proxy", [
    satoshiImplementation.address,
    satoshiInitData,
  ]);
  const satoshiVault = await viem.getContractAt("SatoshiVault", satoshiProxy.address);
  const dividendImplementation = await viem.deployContract("DealDividendVault");
  const dividendInitData = encodeFunctionData({
    abi: dividendImplementation.abi,
    functionName: "initialize",
    args: [d.address, dc.address, proxy.address],
  });
  const dividendProxy = await viem.deployContract("ERC1967Proxy", [
    dividendImplementation.address,
    dividendInitData,
  ]);
  const dividendVault = await viem.getContractAt("DealDividendVault", dividendProxy.address);
  const treasury = await viem.deployContract("ProtocolTreasury", [
    owner.account.address,
    owner.account.address,
  ]);

  const moduleRules = buildDaoV2TreasuryModuleRules(satoshiVault.address, dividendVault.address);
  const rules = [
    ...moduleRules,
    {
      kind: DAO_V2_PROPOSAL_KIND.Treasury,
      target: treasury.address,
      selector: toFunctionSelector("payToken(address,address,uint256)"),
      allowed: true,
      validateNestedBroadcast: false,
      nestedOnly: false,
      maxValue: 0n,
    },
  ];
  const registry = await viem.deployContract("GovernancePolicyRegistry", [proxy.address, rules]);
  await waitFor(publicClient, await governance.write.bootstrapPolicyRegistryForTest([registry.address]));
  await waitFor(publicClient, await treasury.write.bootstrapSetController([proxy.address]));
  await waitFor(publicClient, await treasury.write.lockBootstrap());
  await waitFor(publicClient, await d.write.approve([proxy.address, 100n * UNIT]));

  return {
    viem,
    publicClient,
    testClient,
    owner,
    alice,
    bob,
    outsider,
    d,
    dc,
    governance,
    satoshiImplementation,
    satoshiVault,
    dividendImplementation,
    dividendVault,
    treasury,
  };
}

describe("DAO treasury modules", function () {
  it("matches the exact audited implementation and ERC1967Proxy runtime bytecode", async function () {
    const ctx = await deployGovernanceFixture();
    const cwd = process.cwd();
    for (const [label, address, artifactPath] of [
      [
        "SatoshiVault implementation",
        ctx.satoshiImplementation.address,
        "artifacts/contracts/SatoshiVault.sol/SatoshiVault.json",
      ],
      [
        "DealDividendVault implementation",
        ctx.dividendImplementation.address,
        "artifacts/contracts/DealDividendVault.sol/DealDividendVault.json",
      ],
      [
        "SatoshiVault proxy",
        ctx.satoshiVault.address,
        "artifacts/contracts/TestProxy.sol/ERC1967Proxy.json",
      ],
      [
        "DealDividendVault proxy",
        ctx.dividendVault.address,
        "artifacts/contracts/TestProxy.sol/ERC1967Proxy.json",
      ],
    ] as const) {
      const actual = await ctx.publicClient.getCode({ address });
      assert.ok(actual && actual !== "0x", `${label} missing runtime code`);
      assert.equal(actual.toLowerCase(), materializeArtifactRuntime(cwd, artifactPath, address).toLowerCase());
    }
  });

  it("keeps Satoshi success permanent only for the proposal that reached 90 D", async function () {
    const ctx = await deployGovernanceFixture();
    const payout = 250n * UNIT;
    await waitFor(ctx.publicClient, await ctx.dc.write.mint([ctx.satoshiVault.address, payout * 2n]));
    const payData = encodeFunctionData({
      abi: ctx.satoshiVault.abi,
      functionName: "payDC",
      args: [ctx.alice.account.address, payout],
    });
    await waitFor(ctx.publicClient, await ctx.governance.write.createProposal([
      [ctx.satoshiVault.address],
      [0n],
      [payData],
      "Satoshi payout one",
      DAO_V2_PROPOSAL_KIND.Satoshi,
    ]));
    await waitFor(ctx.publicClient, await ctx.governance.write.createProposal([
      [ctx.satoshiVault.address],
      [0n],
      [payData],
      "Satoshi payout two",
      DAO_V2_PROPOSAL_KIND.Satoshi,
    ]));

    await waitFor(ctx.publicClient, await ctx.governance.write.stake([1n, 90n * UNIT]));
    assert.equal(await ctx.governance.read.state([1n]), 3);
    assert.equal(await ctx.governance.read.state([2n]), 1);

    await waitFor(ctx.publicClient, await ctx.governance.write.unstake([1n, 90n * UNIT]));
    assert.equal(await ctx.governance.read.state([1n]), 3);
    assert.equal(await ctx.governance.read.state([2n]), 1);
    await waitFor(ctx.publicClient, await ctx.governance.write.execute([1n]));
    assert.equal(await ctx.dc.read.balanceOf([ctx.alice.account.address]), payout);

    const vaultAsOutsider = await ctx.viem.getContractAt("SatoshiVault", ctx.satoshiVault.address, {
      client: { wallet: ctx.outsider },
    });
    await assert.rejects(vaultAsOutsider.write.payDC([ctx.outsider.account.address, 1n]));
  });

  it("still lets a D seat veto a 90 D Satoshi payout before execution", async function () {
    const ctx = await deployGovernanceFixture();
    const payout = 10n * UNIT;
    await waitFor(ctx.publicClient, await ctx.dc.write.mint([ctx.satoshiVault.address, payout]));
    const payData = encodeFunctionData({
      abi: ctx.satoshiVault.abi,
      functionName: "payDC",
      args: [ctx.alice.account.address, payout],
    });
    await waitFor(ctx.publicClient, await ctx.governance.write.createProposal([
      [ctx.satoshiVault.address],
      [0n],
      [payData],
      "Satoshi payout veto audit",
      DAO_V2_PROPOSAL_KIND.Satoshi,
    ]));
    await waitFor(ctx.publicClient, await ctx.governance.write.stake([1n, 90n * UNIT]));
    await waitFor(ctx.publicClient, await ctx.governance.write.unstake([1n, 90n * UNIT]));
    assert.equal(await ctx.governance.read.state([1n]), 3);

    await waitFor(ctx.publicClient, await ctx.governance.write.veto([1n]));
    assert.equal(await ctx.governance.read.state([1n]), 4);
    await assert.rejects(ctx.governance.write.execute([1n]));
    assert.equal(await ctx.dc.read.balanceOf([ctx.alice.account.address]), 0n);
  });

  it("funds one DC-only dividend round through a 70 D Treasury proposal", async function () {
    const ctx = await deployGovernanceFixture();
    await waitFor(ctx.publicClient, await ctx.d.write.transfer([ctx.alice.account.address, 10n * UNIT]));
    await waitFor(ctx.publicClient, await ctx.d.write.transfer([ctx.bob.account.address, 20n * UNIT]));
    await ctx.testClient.mine({ blocks: 1 });

    const roundTotal = 1_000n * UNIT;
    await waitFor(ctx.publicClient, await ctx.dc.write.mint([ctx.treasury.address, roundTotal]));
    const fundData = encodeFunctionData({
      abi: ctx.treasury.abi,
      functionName: "payToken",
      args: [ctx.dc.address, ctx.dividendVault.address, roundTotal],
    });
    const createRoundData = encodeFunctionData({
      abi: ctx.dividendVault.abi,
      functionName: "createRound",
      args: [roundTotal],
    });
    await waitFor(ctx.publicClient, await ctx.governance.write.createProposal([
      [ctx.treasury.address, ctx.dividendVault.address],
      [0n, 0n],
      [fundData, createRoundData],
      "Fund and create dedicated DC dividend round",
      DAO_V2_PROPOSAL_KIND.Treasury,
    ]));
    await waitFor(ctx.publicClient, await ctx.governance.write.stake([1n, 70n * UNIT]));
    await waitFor(ctx.publicClient, await ctx.governance.write.execute([1n]));
    await ctx.testClient.mine({ blocks: 1 });

    assert.equal(await ctx.dividendVault.read.roundsCount(), 1n);
    assert.equal(await ctx.dividendVault.read.reservedUnclaimed(), roundTotal);
    assert.equal(await ctx.dividendVault.read.unallocatedDC(), 0n);
    const alicePreview = await ctx.dividendVault.read.previewClaim([0n, ctx.alice.account.address]);
    assert.equal(alicePreview[0], 10n * UNIT);
    assert.equal(alicePreview[1], 0n);
    assert.equal(alicePreview[2], 100n * UNIT);
    const ownerPreview = await ctx.dividendVault.read.previewClaim([0n, ctx.owner.account.address]);
    assert.equal(ownerPreview[0], 0n);
    assert.equal(ownerPreview[1], 70n * UNIT);
    assert.equal(ownerPreview[2], 700n * UNIT);
    const custodyPreview = await ctx.dividendVault.read.previewClaim([0n, ctx.governance.address]);
    assert.deepEqual(custodyPreview, [0n, 0n, 0n]);

    const dividendAsAlice = await ctx.viem.getContractAt("DealDividendVault", ctx.dividendVault.address, {
      client: { wallet: ctx.alice },
    });
    await waitFor(ctx.publicClient, await dividendAsAlice.write.claim([0n]));
    assert.equal(await ctx.dc.read.balanceOf([ctx.alice.account.address]), 100n * UNIT);
    const claimedPreview = await ctx.dividendVault.read.previewClaim([0n, ctx.alice.account.address]);
    assert.deepEqual(claimedPreview, [10n * UNIT, 0n, 0n]);
    await assert.rejects(dividendAsAlice.write.claim([0n]));

    const dividendAsOutsider = await ctx.viem.getContractAt("DealDividendVault", ctx.dividendVault.address, {
      client: { wallet: ctx.outsider },
    });
    await assert.rejects(dividendAsOutsider.write.claim([0n]));
    await assert.rejects(dividendAsOutsider.write.createRound([1n]));
  });

  it("does not allocate the same DC balance to two rounds", async function () {
    const ctx = await deployGovernanceFixture();
    const amount = 100n * UNIT;
    await waitFor(ctx.publicClient, await ctx.dc.write.mint([ctx.dividendVault.address, amount]));
    const createRoundData = encodeFunctionData({
      abi: ctx.dividendVault.abi,
      functionName: "createRound",
      args: [amount],
    });
    await waitFor(ctx.publicClient, await ctx.governance.write.createProposal([
      [ctx.dividendVault.address],
      [0n],
      [createRoundData],
      "Create funded dividend round",
      DAO_V2_PROPOSAL_KIND.Treasury,
    ]));
    await waitFor(ctx.publicClient, await ctx.governance.write.stake([1n, 70n * UNIT]));
    await waitFor(ctx.publicClient, await ctx.governance.write.execute([1n]));
    await waitFor(ctx.publicClient, await ctx.governance.write.claimBack([1n]));
    await waitFor(ctx.publicClient, await ctx.d.write.approve([ctx.governance.address, 70n * UNIT]));

    await waitFor(ctx.publicClient, await ctx.governance.write.createProposal([
      [ctx.dividendVault.address],
      [0n],
      [createRoundData],
      "Attempt duplicate allocation",
      DAO_V2_PROPOSAL_KIND.Treasury,
    ]));
    await waitFor(ctx.publicClient, await ctx.governance.write.stake([2n, 70n * UNIT]));
    await assert.rejects(ctx.governance.write.execute([2n]));
    assert.equal(await ctx.dividendVault.read.roundsCount(), 1n);
    assert.equal(await ctx.governance.read.state([2n]), 3);
  });

  it("lets a 0.01 D snapshot holder claim the exact proportional DC share", async function () {
    const ctx = await deployGovernanceFixture();
    const smallHolderBalance = UNIT / 100n;
    await waitFor(
      ctx.publicClient,
      await ctx.d.write.transfer([ctx.alice.account.address, smallHolderBalance]),
    );
    await ctx.testClient.mine({ blocks: 1 });

    const roundTotal = 1_000n * UNIT;
    await waitFor(ctx.publicClient, await ctx.dc.write.mint([ctx.dividendVault.address, roundTotal]));
    const createRoundData = encodeFunctionData({
      abi: ctx.dividendVault.abi,
      functionName: "createRound",
      args: [roundTotal],
    });
    await waitFor(ctx.publicClient, await ctx.governance.write.createProposal([
      [ctx.dividendVault.address],
      [0n],
      [createRoundData],
      "Create 0.01 D holder dividend round",
      DAO_V2_PROPOSAL_KIND.Treasury,
    ]));
    await waitFor(ctx.publicClient, await ctx.governance.write.stake([1n, 70n * UNIT]));
    await waitFor(ctx.publicClient, await ctx.governance.write.execute([1n]));
    await ctx.testClient.mine({ blocks: 1 });

    const block = await ctx.publicClient.getBlock();
    await ctx.testClient.setNextBlockTimestamp({
      timestamp: block.timestamp + 365n * 24n * 60n * 60n,
    });
    await ctx.testClient.mine({ blocks: 1 });

    const expected = UNIT / 10n;
    const preview = await ctx.dividendVault.read.previewClaim([0n, ctx.alice.account.address]);
    assert.equal(preview[2], expected);
    const dividendAsAlice = await ctx.viem.getContractAt("DealDividendVault", ctx.dividendVault.address, {
      client: { wallet: ctx.alice },
    });
    await waitFor(ctx.publicClient, await dividendAsAlice.write.claim([0n]));
    assert.equal(await ctx.dc.read.balanceOf([ctx.alice.account.address]), expected);
  });

  it("includes collective veto stake in the dividend snapshot weight", async function () {
    const ctx = await deployGovernanceFixture();
    const vetoAmount = 1n * UNIT;
    await waitFor(ctx.publicClient, await ctx.d.write.transfer([ctx.alice.account.address, vetoAmount]));
    const payData = encodeFunctionData({
      abi: ctx.satoshiVault.abi,
      functionName: "payDC",
      args: [ctx.bob.account.address, 1n],
    });
    await waitFor(ctx.publicClient, await ctx.governance.write.createProposal([
      [ctx.satoshiVault.address],
      [0n],
      [payData],
      "Pending Satoshi proposal with collective veto stake",
      DAO_V2_PROPOSAL_KIND.Satoshi,
    ]));
    const dAsAlice = await ctx.viem.getContractAt("D", ctx.d.address, {
      client: { wallet: ctx.alice },
    });
    const governanceAsAlice = await ctx.viem.getContractAt(
      "DealGovernanceHarness",
      ctx.governance.address,
      { client: { wallet: ctx.alice } },
    );
    await waitFor(
      ctx.publicClient,
      await dAsAlice.write.approve([ctx.governance.address, vetoAmount]),
    );
    await waitFor(ctx.publicClient, await governanceAsAlice.write.vetoStake([1n, vetoAmount]));

    const roundTotal = 1_000n * UNIT;
    await waitFor(ctx.publicClient, await ctx.dc.write.mint([ctx.dividendVault.address, roundTotal]));
    const createRoundData = encodeFunctionData({
      abi: ctx.dividendVault.abi,
      functionName: "createRound",
      args: [roundTotal],
    });
    await waitFor(ctx.publicClient, await ctx.governance.write.createProposal([
      [ctx.dividendVault.address],
      [0n],
      [createRoundData],
      "Create dividend round while veto D is locked",
      DAO_V2_PROPOSAL_KIND.Treasury,
    ]));
    await waitFor(ctx.publicClient, await ctx.governance.write.stake([2n, 70n * UNIT]));
    await waitFor(ctx.publicClient, await ctx.governance.write.execute([2n]));
    await ctx.testClient.mine({ blocks: 1 });

    const preview = await ctx.dividendVault.read.previewClaim([0n, ctx.alice.account.address]);
    assert.deepEqual(preview, [0n, vetoAmount, 10n * UNIT]);
  });

  it("releases rounding dust when the final D weight claims", async function () {
    const ctx = await deployGovernanceFixture();
    await waitFor(ctx.publicClient, await ctx.d.write.transfer([ctx.alice.account.address, 10n * UNIT]));
    await waitFor(ctx.publicClient, await ctx.d.write.transfer([ctx.bob.account.address, 20n * UNIT]));
    await ctx.testClient.mine({ blocks: 1 });

    const roundTotal = 1_001n;
    await waitFor(ctx.publicClient, await ctx.dc.write.mint([ctx.dividendVault.address, roundTotal]));
    const createRoundData = encodeFunctionData({
      abi: ctx.dividendVault.abi,
      functionName: "createRound",
      args: [roundTotal],
    });
    await waitFor(ctx.publicClient, await ctx.governance.write.createProposal([
      [ctx.dividendVault.address],
      [0n],
      [createRoundData],
      "Create rounding test dividend round",
      DAO_V2_PROPOSAL_KIND.Treasury,
    ]));
    await waitFor(ctx.publicClient, await ctx.governance.write.stake([1n, 70n * UNIT]));
    await waitFor(ctx.publicClient, await ctx.governance.write.execute([1n]));
    await ctx.testClient.mine({ blocks: 1 });

    for (const wallet of [ctx.alice, ctx.owner, ctx.bob]) {
      const dividend = await ctx.viem.getContractAt("DealDividendVault", ctx.dividendVault.address, {
        client: { wallet },
      });
      await waitFor(ctx.publicClient, await dividend.write.claim([0n]));
    }

    const round = await ctx.dividendVault.read.getRound([0n]);
    assert.equal(round.claimed, roundTotal);
    assert.equal(round.claimedWeight, 100n * UNIT);
    assert.equal(await ctx.dividendVault.read.reservedUnclaimed(), 0n);
    assert.equal(await ctx.dc.read.balanceOf([ctx.dividendVault.address]), 0n);
  });

  it("upgrades both module proxies only through Major governance and preserves state", async function () {
    const ctx = await deployGovernanceFixture();
    const nextSatoshi = await ctx.viem.deployContract("SatoshiVaultUpgradeMock");
    const nextDividend = await ctx.viem.deployContract("DealDividendVaultUpgradeMock");
    const satoshiAsOutsider = await ctx.viem.getContractAt("SatoshiVault", ctx.satoshiVault.address, {
      client: { wallet: ctx.outsider },
    });
    const dividendAsOutsider = await ctx.viem.getContractAt("DealDividendVault", ctx.dividendVault.address, {
      client: { wallet: ctx.outsider },
    });
    await assert.rejects(
      satoshiAsOutsider.write.upgradeToAndCall([nextSatoshi.address, "0x"]),
    );
    await assert.rejects(
      dividendAsOutsider.write.upgradeToAndCall([nextDividend.address, "0x"]),
    );
    await assert.rejects(ctx.satoshiImplementation.write.initialize([
      ctx.dc.address,
      ctx.governance.address,
    ]));
    await assert.rejects(ctx.dividendImplementation.write.initialize([
      ctx.d.address,
      ctx.dc.address,
      ctx.governance.address,
    ]));

    await waitFor(ctx.publicClient, await ctx.dc.write.mint([ctx.owner.account.address, 2_000n * UNIT]));
    await waitFor(
      ctx.publicClient,
      await ctx.dc.write.approve([ctx.governance.address, 2_000n * UNIT]),
    );
    const satoshiBalance = 321n * UNIT;
    await waitFor(ctx.publicClient, await ctx.dc.write.mint([ctx.satoshiVault.address, satoshiBalance]));
    const upgradeSatoshiData = encodeFunctionData({
      abi: ctx.satoshiVault.abi,
      functionName: "upgradeToAndCall",
      args: [nextSatoshi.address, "0x"],
    });
    await waitFor(ctx.publicClient, await ctx.governance.write.createProposal([
      [ctx.satoshiVault.address],
      [0n],
      [upgradeSatoshiData],
      "Upgrade SatoshiVault through DAO",
      DAO_V2_PROPOSAL_KIND.Major,
    ]));
    await waitFor(ctx.publicClient, await ctx.governance.write.stake([1n, 70n * UNIT]));
    await waitFor(ctx.publicClient, await ctx.governance.write.execute([1n]));
    await waitFor(ctx.publicClient, await ctx.governance.write.claimBack([1n]));
    const upgradedSatoshi = await ctx.viem.getContractAt(
      "SatoshiVaultUpgradeMock",
      ctx.satoshiVault.address,
    );
    assert.equal(await upgradedSatoshi.read.version(), 2n);
    assert.equal((await upgradedSatoshi.read.dealCoin()).toLowerCase(), ctx.dc.address.toLowerCase());
    assert.equal(
      (await upgradedSatoshi.read.controller()).toLowerCase(),
      ctx.governance.address.toLowerCase(),
    );
    assert.equal(await ctx.dc.read.balanceOf([ctx.satoshiVault.address]), satoshiBalance);

    const roundTotal = 1_000n * UNIT;
    await waitFor(ctx.publicClient, await ctx.dc.write.mint([ctx.dividendVault.address, roundTotal]));
    const createRoundData = encodeFunctionData({
      abi: ctx.dividendVault.abi,
      functionName: "createRound",
      args: [roundTotal],
    });
    await waitFor(ctx.publicClient, await ctx.d.write.approve([ctx.governance.address, 100n * UNIT]));
    await waitFor(ctx.publicClient, await ctx.governance.write.createProposal([
      [ctx.dividendVault.address],
      [0n],
      [createRoundData],
      "Create round before dividend implementation upgrade",
      DAO_V2_PROPOSAL_KIND.Treasury,
    ]));
    await waitFor(ctx.publicClient, await ctx.governance.write.stake([2n, 70n * UNIT]));
    await waitFor(ctx.publicClient, await ctx.governance.write.execute([2n]));
    await waitFor(ctx.publicClient, await ctx.governance.write.claimBack([2n]));
    const roundBefore = await ctx.dividendVault.read.getRound([0n]);

    const upgradeDividendData = encodeFunctionData({
      abi: ctx.dividendVault.abi,
      functionName: "upgradeToAndCall",
      args: [nextDividend.address, "0x"],
    });
    await waitFor(ctx.publicClient, await ctx.d.write.approve([ctx.governance.address, 100n * UNIT]));
    await waitFor(ctx.publicClient, await ctx.governance.write.createProposal([
      [ctx.dividendVault.address],
      [0n],
      [upgradeDividendData],
      "Upgrade DealDividendVault through DAO",
      DAO_V2_PROPOSAL_KIND.Major,
    ]));
    await waitFor(ctx.publicClient, await ctx.governance.write.stake([3n, 70n * UNIT]));
    await waitFor(ctx.publicClient, await ctx.governance.write.execute([3n]));
    await waitFor(ctx.publicClient, await ctx.governance.write.claimBack([3n]));
    const upgradedDividend = await ctx.viem.getContractAt(
      "DealDividendVaultUpgradeMock",
      ctx.dividendVault.address,
    );
    assert.equal(await upgradedDividend.read.version(), 2n);
    assert.equal((await upgradedDividend.read.dToken()).toLowerCase(), ctx.d.address.toLowerCase());
    assert.equal((await upgradedDividend.read.dealCoin()).toLowerCase(), ctx.dc.address.toLowerCase());
    assert.equal(
      (await upgradedDividend.read.governance()).toLowerCase(),
      ctx.governance.address.toLowerCase(),
    );
    assert.equal(await upgradedDividend.read.roundsCount(), 1n);
    assert.deepEqual(await upgradedDividend.read.getRound([0n]), roundBefore);
    assert.equal(await upgradedDividend.read.reservedUnclaimed(), roundTotal);
  });
});
