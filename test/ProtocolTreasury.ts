import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeFunctionData, toFunctionSelector, zeroAddress } from "viem";

const D_UNIT = 10n ** 18n;
const TREASURY_PASS = 70n * D_UNIT;

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

async function deployGovernance(viem: any, dAddr: `0x${string}`, dcAddr: `0x${string}`, treasury: `0x${string}`) {
  const publicClient = await viem.getPublicClient();
  const impl = await viem.deployContract("DealGovernanceHarness", []);
  const initData = encodeFunctionData({
    abi: impl.abi,
    functionName: "initialize",
    args: [dAddr, zeroAddress, dcAddr, treasury],
  });
  const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initData]);
  const rules = [{
    kind: 1,
    target: treasury,
    selector: toFunctionSelector("payToken(address,address,uint256)"),
    allowed: true,
    validateNestedBroadcast: false,
    nestedOnly: false,
    maxValue: 0n,
  }];
  const registry = await viem.deployContract("GovernancePolicyRegistry", [proxy.address, rules]);
  const harness = await viem.getContractAt("DealGovernanceHarness", proxy.address);
  await waitFor(publicClient, await harness.write.bootstrapPolicyRegistryForTest([registry.address]));
  return viem.getContractAt("DealGovernance", proxy.address);
}

describe("ProtocolTreasury", async function () {
  it("lets governance move treasury funds without any treasury private key", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [owner, alice] = await viem.getWalletClients();

    const d = await viem.deployContract("D", [owner.account.address]);
    const dc = await viem.deployContract("DCToken", [
      "DealCoin",
      "DC",
      0n,
      owner.account.address,
      owner.account.address,
    ]);
    const treasury = await viem.deployContract("ProtocolTreasury", [
      owner.account.address,
      owner.account.address,
    ]);
    const gov = await deployGovernance(viem, d.address, dc.address, treasury.address);

    await waitFor(publicClient, await treasury.write.bootstrapSetController([gov.address]));
    await waitFor(publicClient, await treasury.write.lockBootstrap());
    assert.equal(
      (await treasury.read.controller()).toLowerCase(),
      gov.address.toLowerCase(),
    );
    assert.equal(await treasury.read.bootstrapLocked(), true);

    const payout = 123n * D_UNIT;
    await waitFor(publicClient, await dc.write.mint([treasury.address, payout]));

    const payData = encodeFunctionData({
      abi: treasury.abi,
      functionName: "payToken",
      args: [dc.address, alice.account.address, payout],
    });
    await waitFor(publicClient, await gov.write.createProposal([
      [treasury.address],
      [0n],
      [payData],
      "treasury payout",
      1,
    ]));

    await waitFor(publicClient, await d.write.approve([gov.address, TREASURY_PASS]));
    await waitFor(publicClient, await gov.write.stake([1n, TREASURY_PASS]));
    await waitFor(publicClient, await gov.write.execute([1n]));

    assert.equal(await dc.read.balanceOf([alice.account.address]), payout);
    assert.equal(await dc.read.balanceOf([treasury.address]), 0n);

    await assert.rejects(() => treasury.write.payToken([dc.address, alice.account.address, 1n]));
  });

  it("can be the dividend source and executor for VoteDividendClaimer", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const testClient = await viem.getTestClient();
    const [owner, alice] = await viem.getWalletClients();

    const d = await viem.deployContract("D", [owner.account.address]);
    const dc = await viem.deployContract("DCToken", [
      "DealCoin",
      "DC",
      0n,
      owner.account.address,
      owner.account.address,
    ]);
    const treasury = await viem.deployContract("ProtocolTreasury", [
      owner.account.address,
      owner.account.address,
    ]);
    const claimer = await viem.deployContract("VoteDividendClaimer", [
      d.address,
      dc.address,
      treasury.address,
      treasury.address,
    ]);

    const aliceD = 10n * D_UNIT;
    await waitFor(publicClient, await d.write.transfer([alice.account.address, aliceD]));
    await testClient.mine({ blocks: 1 });

    const roundTotal = 1000n * D_UNIT;
    await waitFor(publicClient, await dc.write.mint([treasury.address, roundTotal]));
    await waitFor(
      publicClient,
      await treasury.write.approveAndCreateDividendRound([dc.address, claimer.address, roundTotal]),
    );
    await testClient.mine({ blocks: 1 });

    const preview = await claimer.read.previewClaim([0n, alice.account.address]);
    assert.equal(preview[0], aliceD);
    assert.equal(preview[1], 100n * D_UNIT);

    const claimerAsAlice = await viem.getContractAt("VoteDividendClaimer", claimer.address, {
      client: { wallet: alice },
    });
    await waitFor(publicClient, await claimerAsAlice.write.claim([0n]));
    assert.equal(await dc.read.balanceOf([alice.account.address]), 100n * D_UNIT);
  });
});
