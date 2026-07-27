import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeFunctionData,
  parseEther,
  toFunctionSelector,
  zeroAddress,
} from "viem";

import {
  buildDaoV2PolicyRules,
  buildDaoV2TreasuryModuleRules,
  DAO_V2_PROPOSAL_KIND,
  DEFAULT_BROADCAST_MAX_VALUE,
} from "../scripts/dao-v2-policy.js";

const D = 10n ** 18n;

const policyAddresses = {
  governance: "0x0000000000000000000000000000000000000011" as const,
  policyRegistry: "0x0000000000000000000000000000000000000012" as const,
  dealFactory: "0x0000000000000000000000000000000000000013" as const,
  crossChainBroadcaster: "0x0000000000000000000000000000000000000014" as const,
  protocolTreasury: "0x0000000000000000000000000000000000000015" as const,
  bscDealFactory: "0x0000000000000000000000000000000000000016" as const,
};

async function waitFor(publicClient: any, hash: `0x${string}`) {
  return publicClient.waitForTransactionReceipt({ hash });
}

async function fixture() {
  const { viem } = await network.connect({ network: "hardhatMainnet" });
  const publicClient = await viem.getPublicClient();
  const [owner, other] = await viem.getWalletClients();

  const d = await viem.deployContract("D", [owner.account.address]);
  const dc = await viem.deployContract("DCToken", [
    "DealCoin",
    "DC",
    10_000n * D,
    owner.account.address,
    owner.account.address,
  ]);
  const target = await viem.deployContract("GovernancePolicyTargetMock", []);
  const remoteA = await viem.deployContract("GovernancePolicyTargetMock", []);
  const remoteB = await viem.deployContract("GovernancePolicyTargetMock", []);
  const broadcaster = await viem.deployContract("CrossChainBroadcasterMock", []);

  const implementation = await viem.deployContract("DealGovernanceHarness", []);
  const initData = encodeFunctionData({
    abi: implementation.abi,
    functionName: "initialize",
    args: [d.address, zeroAddress, dc.address, owner.account.address],
  });
  const proxy = await viem.deployContract("ERC1967Proxy", [implementation.address, initData]);

  const rule = (
    kind: number,
    ruleTarget: `0x${string}`,
    signature: string,
    maxValue = 0n,
    validateNestedBroadcast = false,
    nestedOnly = false,
  ) => ({
    kind,
    target: ruleTarget,
    selector: toFunctionSelector(signature),
    allowed: true,
    validateNestedBroadcast,
    nestedOnly,
    maxValue,
  });

  const rules = [
    rule(0, target.address, "parameterAction()"),
    rule(0, target.address, "parameterPay()", parseEther("1")),
    rule(1, target.address, "treasuryAction()"),
    rule(2, target.address, "majorAction()"),
    rule(3, target.address, "satoshiAction()"),
    rule(2, proxy.address, "upgradeToAndCall(address,bytes)"),
    rule(2, proxy.address, "setPolicyRegistry(address)"),
    rule(0, broadcaster.address, "broadcast(uint32[],address[],bytes,uint128)", parseEther("1"), true),
    rule(0, remoteA.address, "parameterAction()", 0n, false, true),
    rule(0, remoteB.address, "parameterAction()", 0n, false, true),
  ];
  const registry = await viem.deployContract("GovernancePolicyRegistry", [proxy.address, rules]);
  const harness = await viem.getContractAt("DealGovernanceHarness", proxy.address);
  await waitFor(publicClient, await harness.write.bootstrapPolicyRegistryForTest([registry.address]));

  const governance = await viem.getContractAt("DealGovernance", proxy.address);
  await waitFor(publicClient, await d.write.approve([proxy.address, 100n * D]));
  await waitFor(publicClient, await dc.write.approve([proxy.address, 10_000n * D]));

  return {
    viem,
    publicClient,
    owner,
    other,
    d,
    dc,
    target,
    remoteA,
    remoteB,
    broadcaster,
    proxy,
    governance,
    harness,
    registry,
  };
}

async function createProposal(ctx: Awaited<ReturnType<typeof fixture>>, kind: number, target: any, data: `0x${string}`, value = 0n) {
  await waitFor(ctx.publicClient, await ctx.governance.write.createProposal([
    [target],
    [value],
    [data],
    "policy test",
    kind,
  ]));
  return ctx.governance.read.proposalCount();
}

describe("DAO V2 production policy builder", function () {
  it("builds the complete deny-by-default initial policy", function () {
    const rules = buildDaoV2PolicyRules(policyAddresses);
    assert.equal(rules.length, 48);
    assert.deepEqual(
      [0, 1, 2, 3].map((kind) => rules.filter((rule) => rule.kind === kind).length),
      [15, 4, 29, 0],
    );
    assert.equal(
      rules.some((rule) => rule.signature === "execute(address,uint256,bytes)"),
      false,
    );
    const broadcasterRules = rules.filter(
      (rule) => rule.target.toLowerCase() === policyAddresses.crossChainBroadcaster.toLowerCase(),
    );
    assert.equal(broadcasterRules.length, 2);
    for (const rule of broadcasterRules) {
      assert.equal(rule.validateNestedBroadcast, true);
      assert.equal(rule.nestedOnly, false);
      assert.equal(rule.maxValue, DEFAULT_BROADCAST_MAX_VALUE);
    }
    const remoteRules = rules.filter((rule) => rule.scope === "broadcast-target");
    assert.equal(remoteRules.length, 13);
    assert.equal(remoteRules.every((rule) => rule.nestedOnly), true);
  });

  it("only enables one exact SatoshiVault action when both settings are supplied", function () {
    const satoshiVault = "0x0000000000000000000000000000000000000017" as const;
    const signature = "paySatoshi(address,uint256)";
    assert.throws(
      () => buildDaoV2PolicyRules({ ...policyAddresses, satoshiVault }),
      /configured together/,
    );
    const rules = buildDaoV2PolicyRules(
      { ...policyAddresses, satoshiVault },
      { satoshiVaultFunction: signature },
    );
    const satoshiRules = rules.filter((rule) => rule.kind === DAO_V2_PROPOSAL_KIND.Satoshi);
    assert.equal(satoshiRules.length, 1);
    assert.equal(satoshiRules[0].target.toLowerCase(), satoshiVault.toLowerCase());
    assert.equal(satoshiRules[0].selector, toFunctionSelector(signature));
  });

  it("keeps the 48-rule baseline unchanged and builds four exact module proxy rules", function () {
    const satoshiVault = "0x0000000000000000000000000000000000000017" as const;
    const dividendVault = "0x0000000000000000000000000000000000000018" as const;
    assert.equal(buildDaoV2PolicyRules(policyAddresses).length, 48);

    const rules = buildDaoV2TreasuryModuleRules(satoshiVault, dividendVault);
    assert.deepEqual(rules, [
      {
        kind: DAO_V2_PROPOSAL_KIND.Satoshi,
        target: satoshiVault,
        selector: toFunctionSelector("payDC(address,uint256)"),
        allowed: true,
        validateNestedBroadcast: false,
        nestedOnly: false,
        maxValue: 0n,
      },
      {
        kind: DAO_V2_PROPOSAL_KIND.Treasury,
        target: dividendVault,
        selector: toFunctionSelector("createRound(uint256)"),
        allowed: true,
        validateNestedBroadcast: false,
        nestedOnly: false,
        maxValue: 0n,
      },
      {
        kind: DAO_V2_PROPOSAL_KIND.Major,
        target: satoshiVault,
        selector: toFunctionSelector("upgradeToAndCall(address,bytes)"),
        allowed: true,
        validateNestedBroadcast: false,
        nestedOnly: false,
        maxValue: 0n,
      },
      {
        kind: DAO_V2_PROPOSAL_KIND.Major,
        target: dividendVault,
        selector: toFunctionSelector("upgradeToAndCall(address,bytes)"),
        allowed: true,
        validateNestedBroadcast: false,
        nestedOnly: false,
        maxValue: 0n,
      },
    ]);
  });
});

describe("DealGovernance V2 action policy", function () {
  it("separates Parameter, Treasury, Satoshi and Major action boundaries", async function () {
    const ctx = await fixture();
    const parameterData = encodeFunctionData({ abi: ctx.target.abi, functionName: "parameterAction" });
    const treasuryData = encodeFunctionData({ abi: ctx.target.abi, functionName: "treasuryAction" });
    const satoshiData = encodeFunctionData({ abi: ctx.target.abi, functionName: "satoshiAction" });
    const majorData = encodeFunctionData({ abi: ctx.target.abi, functionName: "majorAction" });

    await createProposal(ctx, 0, ctx.target.address, parameterData);
    await createProposal(ctx, 1, ctx.target.address, treasuryData);
    await createProposal(ctx, 2, ctx.target.address, majorData);
    await createProposal(ctx, 3, ctx.target.address, satoshiData);

    await assert.rejects(createProposal(ctx, 0, ctx.target.address, treasuryData), /ActionNotAllowed/);
    await assert.rejects(createProposal(ctx, 1, ctx.target.address, parameterData), /ActionNotAllowed/);
    await assert.rejects(createProposal(ctx, 2, ctx.target.address, satoshiData), /ActionNotAllowed/);
    await assert.rejects(createProposal(ctx, 3, ctx.target.address, majorData), /ActionNotAllowed/);
  });

  it("checks nested cross-chain targets and selectors", async function () {
    const ctx = await fixture();
    const inner = encodeFunctionData({ abi: ctx.remoteA.abi, functionName: "parameterAction" });
    const good = encodeFunctionData({
      abi: ctx.broadcaster.abi,
      functionName: "broadcast",
      args: [[56, 137], [ctx.remoteA.address, ctx.remoteB.address], inner, 300_000],
    });
    await createProposal(ctx, 0, ctx.broadcaster.address, good);
    await assert.rejects(
      createProposal(ctx, 0, ctx.remoteA.address, inner),
      /ActionNotAllowed/,
    );

    const badTarget = encodeFunctionData({
      abi: ctx.broadcaster.abi,
      functionName: "broadcast",
      args: [[56], [ctx.other.account.address], inner, 300_000],
    });
    await assert.rejects(createProposal(ctx, 0, ctx.broadcaster.address, badTarget), /ActionNotAllowed/);

    const badInner = encodeFunctionData({ abi: ctx.remoteA.abi, functionName: "treasuryAction" });
    const badSelector = encodeFunctionData({
      abi: ctx.broadcaster.abi,
      functionName: "broadcast",
      args: [[56], [ctx.remoteA.address], badInner, 300_000],
    });
    await assert.rejects(createProposal(ctx, 0, ctx.broadcaster.address, badSelector), /ActionNotAllowed/);
  });

  it("requires exact execution value and respects the configured value cap", async function () {
    const ctx = await fixture();
    const data = encodeFunctionData({ abi: ctx.target.abi, functionName: "parameterPay" });
    const value = parseEther("0.1");
    const id = await createProposal(ctx, 0, ctx.target.address, data, value);
    await waitFor(ctx.publicClient, await ctx.governance.write.stake([id, 70n * D]));

    await assert.rejects(ctx.governance.write.execute([id]), /IncorrectExecutionValue/);
    await waitFor(ctx.publicClient, await ctx.governance.write.execute([id], { value }));
    assert.equal(await ctx.target.read.received(), value);

    await assert.rejects(
      createProposal(ctx, 0, ctx.target.address, data, parseEther("1.01")),
      /ActionNotAllowed/,
    );
  });

  it("upgrades through a Major proposal without changing existing state", async function () {
    const ctx = await fixture();
    const nextImplementation = await ctx.viem.deployContract("DealGovernanceUpgradeMock", []);
    const beforeD = await ctx.governance.read.dToken();
    const beforeThreshold = await ctx.governance.read.fastPassThreshold();
    const historicalData = encodeFunctionData({
      abi: ctx.target.abi,
      functionName: "majorAction",
    });
    const historicalId = await createProposal(
      ctx,
      2,
      ctx.target.address,
      historicalData,
    );
    const historicalCreatedAt = (
      await ctx.governance.read.getProposal([historicalId])
    ).createdAt;
    await waitFor(
      ctx.publicClient,
      await ctx.harness.write.clearProposalCreatedAtForTest([historicalId]),
    );

    const backfillData = encodeFunctionData({
      abi: ctx.governance.abi,
      functionName: "backfillProposalCreatedAt",
      args: [historicalId, [historicalCreatedAt]],
    });
    const upgradeData = encodeFunctionData({
      abi: ctx.governance.abi,
      functionName: "upgradeToAndCall",
      args: [nextImplementation.address, backfillData],
    });
    const id = await createProposal(ctx, 2, ctx.proxy.address, upgradeData);
    await waitFor(ctx.publicClient, await ctx.governance.write.stake([id, 70n * D]));
    await waitFor(ctx.publicClient, await ctx.governance.write.execute([id]));

    const upgraded = await ctx.viem.getContractAt("DealGovernanceUpgradeMock", ctx.proxy.address);
    assert.equal(await upgraded.read.version(), 2n);
    assert.equal(await upgraded.read.dToken(), beforeD);
    assert.equal(await upgraded.read.fastPassThreshold(), beforeThreshold);
    assert.equal(
      (await upgraded.read.getProposal([historicalId])).createdAt,
      historicalCreatedAt,
    );
    assert.equal(
      (await upgraded.read.policyRegistry()).toLowerCase(),
      ctx.registry.address.toLowerCase(),
    );
    assert.equal(await upgraded.read.executedProposalCount(), 1n);
  });
});
