import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, toFunctionSelector, zeroAddress } from "viem";

const D = 10n ** 18n;

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
  const implementation = await viem.deployContract("DealGovernanceHarness", []);
  const initData = encodeFunctionData({
    abi: implementation.abi,
    functionName: "initialize",
    args: [d.address, zeroAddress, dc.address, owner.account.address],
  });
  const proxy = await viem.deployContract("ERC1967Proxy", [implementation.address, initData]);

  const rules = [{
    kind: 1,
    target: target.address,
    selector: toFunctionSelector("treasuryAction()"),
    allowed: true,
    validateNestedBroadcast: false,
    nestedOnly: false,
    maxValue: 0n,
  }];
  const registry = await viem.deployContract("GovernancePolicyRegistry", [proxy.address, rules]);
  const harness = await viem.getContractAt("DealGovernanceHarness", proxy.address);
  await waitFor(publicClient, await harness.write.bootstrapPolicyRegistryForTest([registry.address]));

  const governance = await viem.getContractAt("DealGovernance", proxy.address);
  const reader = await viem.deployContract("DealGovernanceReader", [
    proxy.address,
    [],
    [],
  ]);
  const action = encodeFunctionData({ abi: target.abi, functionName: "treasuryAction" });

  for (const description of ["first", "second", "third"]) {
    await waitFor(publicClient, await governance.write.createProposal([
      [target.address],
      [0n],
      [action],
      description,
      1,
    ]));
  }

  await waitFor(publicClient, await d.write.approve([proxy.address, 100n * D]));
  await waitFor(publicClient, await governance.write.stake([2n, 25n * 10n ** 17n]));

  return { viem, publicClient, owner, other, d, governance, harness, reader, target, action };
}

describe("DealGovernanceReader", function () {
  it("returns newest-first proposal pages with authoritative states and account positions", async function () {
    const ctx = await fixture();
    const [page, total] = await ctx.reader.read.getProposalPage([
      ctx.owner.account.address,
      0n,
      2n,
      true,
    ]);

    assert.equal(total, 3n);
    assert.deepEqual(page.map((item: any) => item.proposalId), [3n, 2n]);
    assert.deepEqual(page.map((item: any) => item.description), ["third", "second"]);
    assert.ok(page[0].createdAt > 0n);
    assert.ok(page[0].createdAt >= page[1].createdAt);
    assert.equal(page[0].currentState, 1);
    assert.equal(page[1].currentState, 2);
    assert.equal(page[1].accountStake, 25n * 10n ** 17n);
    assert.equal(page[1].accountVetoStake, 0n);
  });

  it("returns oldest-first pages and an empty page past the end", async function () {
    const ctx = await fixture();
    const [page, total] = await ctx.reader.read.getProposalPage([
      zeroAddress,
      1n,
      2n,
      false,
    ]);
    const [empty, emptyTotal] = await ctx.reader.read.getProposalPage([
      zeroAddress,
      3n,
      10n,
      true,
    ]);

    assert.equal(total, 3n);
    assert.deepEqual(page.map((item: any) => item.proposalId), [2n, 3n]);
    assert.equal(emptyTotal, 3n);
    assert.equal(empty.length, 0);
  });

  it("returns complete detail actions without putting calldata in list pages", async function () {
    const ctx = await fixture();
    const [proposal, targets, values, calldatas] = await ctx.reader.read.getProposalDetail([
      1n,
      ctx.other.account.address,
    ]);

    assert.equal(proposal.proposalId, 1n);
    assert.equal(proposal.description, "first");
    const directProposal = await ctx.governance.read.getProposal([1n]);
    assert.equal(proposal.createdAt, directProposal.createdAt);
    assert.ok(proposal.createdAt > 0n);
    assert.deepEqual(
      targets.map((target: string) => target.toLowerCase()),
      [ctx.target.address.toLowerCase()],
    );
    assert.deepEqual(values, [0n]);
    assert.deepEqual(calldatas, [ctx.action]);
  });

  it("keeps the pre-createdAt getProposal ABI readable", async function () {
    const ctx = await fixture();
    const legacyReader = await ctx.viem.deployContract(
      "DealGovernanceLegacyReaderMock",
      [ctx.governance.address],
    );
    const proposal = await legacyReader.read.getProposal([1n]);

    assert.equal(proposal.proposer.toLowerCase(), ctx.owner.account.address.toLowerCase());
    assert.equal(proposal.description, "first");
    assert.equal(proposal.totalStaked, 0n);
  });

  it("batches state refreshes and returns normalized governance stats", async function () {
    const ctx = await fixture();
    const states = await ctx.reader.read.getProposalStates([[1n, 2n, 3n, 999n]]);
    const stats = await ctx.reader.read.getGovernanceStats();

    assert.deepEqual(states, [1, 2, 1, 0]);
    assert.equal(stats.proposalCount, 3n);
    assert.equal(stats.activeProposalCount, 1n);
    assert.equal(stats.executedProposalCount, 0n);
    assert.equal(stats.activationThreshold, 25n * 10n ** 17n);
    assert.equal(stats.todayProposalCount, 3n);
  });

  it("rejects oversized list and state batches", async function () {
    const ctx = await fixture();
    await assert.rejects(
      ctx.reader.read.getProposalPage([zeroAddress, 0n, 51n, true]),
    );
    await assert.rejects(
      ctx.reader.read.getProposalStates([Array.from({ length: 101 }, (_, i) => BigInt(i + 1))]),
    );
  });

  it("rejects zero and non-contract governance targets", async function () {
    const ctx = await fixture();
    await assert.rejects(
      ctx.viem.deployContract("DealGovernanceReader", [zeroAddress, [], []]),
    );
    await assert.rejects(
      ctx.viem.deployContract("DealGovernanceReader", [
        ctx.other.account.address,
        [],
        [],
      ]),
    );
  });

  it("validates and returns immutable historical createdAt fallbacks", async function () {
    const ctx = await fixture();
    const block = await ctx.publicClient.getBlock();
    const proposal1 = await ctx.governance.read.getProposal([1n]);
    await waitFor(
      ctx.publicClient,
      await ctx.harness.write.clearProposalCreatedAtForTest([1n]),
    );
    const proposalReader = await ctx.viem.deployContract(
      "DealGovernanceReader",
      [ctx.governance.address, [1n], [proposal1.createdAt]],
    );
    const [proposalView] = await proposalReader.read.getProposalDetail([
      1n,
      zeroAddress,
    ]);
    assert.equal(proposalView.createdAt, proposal1.createdAt);

    const fallbackReader = await ctx.viem.deployContract("DealGovernanceReader", [
      ctx.governance.address,
      [10n, 11n],
      [block.timestamp - 2n, block.timestamp - 1n],
    ]);

    assert.equal(
      await fallbackReader.read.historicalCreatedAt([10n]),
      Number(block.timestamp - 2n),
    );
    await assert.rejects(
      ctx.viem.deployContract("DealGovernanceReader", [
        ctx.governance.address,
        [10n],
        [],
      ]),
    );
    await assert.rejects(
      ctx.viem.deployContract("DealGovernanceReader", [
        ctx.governance.address,
        [10n, 10n],
        [block.timestamp - 2n, block.timestamp - 1n],
      ]),
    );
    await assert.rejects(
      ctx.viem.deployContract("DealGovernanceReader", [
        ctx.governance.address,
        [10n],
        [block.timestamp + 1_000n],
      ]),
    );
  });

  it("backfills only missing historical createdAt values through governance", async function () {
    const ctx = await fixture();
    const original = await ctx.governance.read.getProposal([1n]);
    assert.ok(original.createdAt > 0n);

    await waitFor(
      ctx.publicClient,
      await ctx.harness.write.clearProposalCreatedAtForTest([1n]),
    );
    assert.equal((await ctx.governance.read.getProposal([1n])).createdAt, 0);

    await assert.rejects(
      ctx.governance.write.backfillProposalCreatedAt([1n, [original.createdAt]]),
    );

    await waitFor(
      ctx.publicClient,
      await ctx.harness.write.backfillProposalCreatedAtForTest([
        1n,
        [original.createdAt],
      ]),
    );
    assert.equal(
      (await ctx.governance.read.getProposal([1n])).createdAt,
      original.createdAt,
    );

    await assert.rejects(
      ctx.harness.write.backfillProposalCreatedAtForTest([1n, [original.createdAt]]),
    );
  });

  it("rejects invalid historical createdAt ranges and future timestamps", async function () {
    const ctx = await fixture();
    const latestBlock = await ctx.publicClient.getBlock();

    await assert.rejects(
      ctx.harness.write.backfillProposalCreatedAtForTest([0n, [1n]]),
    );

    await waitFor(
      ctx.publicClient,
      await ctx.harness.write.clearProposalCreatedAtForTest([3n]),
    );
    await assert.rejects(
      ctx.harness.write.backfillProposalCreatedAtForTest([
        3n,
        [latestBlock.timestamp + 1_000n],
      ]),
    );
  });
});
