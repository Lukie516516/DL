import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, parseEther, toFunctionSelector, type Address, type Hex } from "viem";

const RUN = process.env.BASE_CROSS_CHAIN_V2_ACTIVATION_FORK === "1";
const forkDescribe = RUN ? describe : describe.skip;
const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const REGISTRY = getAddress("0xBFF01F91291476e671f0F310846D5dDb460e2382");
const BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const BSC_EXECUTOR = getAddress("0x407381d841DD48bBBd40Bd37f9dB268CE75950A8");
const BSC_PROBE = getAddress("0xd31C6417aE0C267F8C5bd634B96dA7590E6E6aB3");
const BASE_EXECUTOR = getAddress("0xf92cE4DBA86eDbfAdEA32880a04FF1123a188218");
const BASE_PROBE = getAddress("0x61921eCb954FFaAf8cd3Fd2e71EeCB14B3eD529f");
const BSC_CHAIN_KEY = 30_102;
const BASE_CHAIN_KEY = 30_184;
const MAJOR = 2;
const FEE_BUDGET = parseEther("0.005");
const SELECTOR = toFunctionSelector("recordMarker(bytes32)");

type Plan = {
  canary: {
    markerCalldata: Hex;
    broadcastCalldata: Hex;
    targetChainKeys: number[];
    targets: Address[];
    lzGas: string;
  };
};

function assertNestedRule(rule: any) {
  assert.equal(rule.allowed ?? rule[0], true);
  assert.equal(rule.validateNestedBroadcast ?? rule[1], false);
  assert.equal(rule.nestedOnly ?? rule[2], true);
  assert.equal(rule.maxValue ?? rule[3], 0n);
}

async function waitFor(publicClient: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
}

forkDescribe("Base CrossChain V2 activation forks", function () {
  it("enables only the asset-free BSC Probe without calling it", async function () {
    try {
    const { viem, networkHelpers } = await network.connect({
      network: "hardhatBscFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    assert.equal(await publicClient.getChainId(), 56);
    const executor = await viem.getContractAt("DualBridgeExecutorV2", BSC_EXECUTOR);
    const probe = await viem.getContractAt("GovernanceProbeUpgradeMock", BSC_PROBE);
    assert.equal(getAddress(await executor.read.owner()), OWNER);
    assert.equal(await executor.read.threshold(), 2n);
    assert.equal(getAddress(await probe.read.controller()), BSC_EXECUTOR);
    assert.equal(await probe.read.version(), 2n);
    assert.equal(await executor.read.allowedTargets([BSC_PROBE]), false);
    const markerBefore = await probe.read.marker();
    const countBefore = await probe.read.updateCount();

    await networkHelpers.impersonateAccount(OWNER);
    await networkHelpers.setBalance(OWNER, parseEther("2"));
    const ownerWallet = await viem.getWalletClient(OWNER);
    const executorAsOwner = await viem.getContractAt("DualBridgeExecutorV2", BSC_EXECUTOR, {
      client: { public: publicClient, wallet: ownerWallet },
    });
    await waitFor(publicClient, await executorAsOwner.write.setAllowedTarget([BSC_PROBE, true]));
    assert.equal(await executor.read.allowedTargets([BSC_PROBE]), true);
    assert.equal(await probe.read.marker(), markerBefore);
    assert.equal(await probe.read.updateCount(), countBefore);
    } catch (error) {
      console.error("Base activation BSC fork error:", error);
      throw error;
    }
  });

  it("activates the exact Base route and quotes the policy-approved BSC + Base canary", async function () {
    try {
    const plan = JSON.parse(
      readFileSync("deployments/base-cross-chain-v2-canary-plan.json", "utf8"),
    ) as Plan;
    const { viem, networkHelpers } = await network.connect({
      network: "hardhatEthFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    assert.equal(await publicClient.getChainId(), 1);
    const broadcaster = await viem.getContractAt("CrossChainBroadcasterV2", BROADCASTER);
    const registry = await viem.getContractAt("GovernancePolicyRegistry", REGISTRY);
    const bscRouteBefore = await broadcaster.read.chains([BSC_CHAIN_KEY]);
    const baseRouteBefore = await broadcaster.read.chains([BASE_CHAIN_KEY]);
    const nonceBefore = await broadcaster.read.broadcastNonce();
    assert.equal(bscRouteBefore[6], true);
    assert.equal(baseRouteBefore[6], false);
    assert.equal(getAddress(baseRouteBefore[2]), BASE_EXECUTOR);
    assertNestedRule(await registry.read.getRule([MAJOR, BSC_PROBE, SELECTOR]));
    assertNestedRule(await registry.read.getRule([MAJOR, BASE_PROBE, SELECTOR]));
    assert.equal(
      await registry.read.isActionAllowed([MAJOR, BROADCASTER, FEE_BUDGET, plan.canary.broadcastCalldata]),
      true,
    );
    assert.equal(
      await registry.read.isActionAllowed([MAJOR, BASE_PROBE, 0n, plan.canary.markerCalldata]),
      false,
      "Base Probe must not become directly callable on Ethereum",
    );

    await networkHelpers.impersonateAccount(OWNER);
    await networkHelpers.setBalance(OWNER, parseEther("2"));
    const ownerWallet = await viem.getWalletClient(OWNER);
    const broadcasterAsOwner = await viem.getContractAt("CrossChainBroadcasterV2", BROADCASTER, {
      client: { public: publicClient, wallet: ownerWallet },
    });
    await waitFor(publicClient, await broadcasterAsOwner.write.setChainActive([BASE_CHAIN_KEY, true]));
    assert.equal((await broadcaster.read.chains([BASE_CHAIN_KEY]))[6], true);
    assert.deepEqual(await broadcaster.read.chains([BSC_CHAIN_KEY]), bscRouteBefore);
    assert.equal(await broadcaster.read.broadcastNonce(), nonceBefore);

    const quote = await broadcaster.read.quoteFees([
      plan.canary.targetChainKeys,
      plan.canary.targets,
      plan.canary.markerCalldata,
      BigInt(plan.canary.lzGas),
    ]);
    assert.ok(quote > 0n);
    assert.ok(quote <= FEE_BUDGET, `combined quote ${quote} exceeds ${FEE_BUDGET}`);
    } catch (error) {
      console.error("Base activation ETH fork error:", error);
      throw error;
    }
  });
});
