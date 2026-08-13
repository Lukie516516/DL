import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  padHex,
  parseEther,
  stringToHex,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

const RUN = process.env.BASE_CROSS_CHAIN_V2_CANARY_ETH_FORK === "1";
const forkDescribe = RUN ? describe : describe.skip;

const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const GOVERNANCE = getAddress("0x9a41a9A85C16F590789C846Fb933fF8C715407F7");
const REGISTRY = getAddress("0xBFF01F91291476e671f0F310846D5dDb460e2382");
const BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const BSC_PROBE = getAddress("0xd31C6417aE0C267F8C5bd634B96dA7590E6E6aB3");
const BSC_CHAIN_KEY = 30_102;
const BASE_CHAIN_KEY = 30_184;
const BASE_CCIP_SELECTOR = 15_971_525_489_660_198_786n;
const AX_MIN_FEE = 1_000_000_000_000_000n;
const MAJOR = 2;
const LZ_GAS = 500_000n;
const FEE_BUDGET = parseEther("0.005");
const RECORD_MARKER_SELECTOR = toFunctionSelector("recordMarker(bytes32)");
const MARKER = keccak256(stringToHex("BASE_CROSS_CHAIN_V2_CANARY_20260807"));

type Stage1 = { executor: Address; probe: Address };

async function waitFor(publicClient: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
  return receipt;
}

forkDescribe("Base CrossChain V2 Canary Ethereum fork", function () {
  it("rehearses the exact BSC + Base zero-asset marker broadcast", async function () {
    const stage1 = JSON.parse(
      readFileSync("deployments/base-cross-chain-v2-stage1.json", "utf8"),
    ) as Stage1;
    const baseProbe = getAddress(stage1.probe);

    const { viem, networkHelpers } = await network.connect({
      network: "hardhatEthFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    assert.equal(await publicClient.getChainId(), 1);

    const broadcaster = await viem.getContractAt("CrossChainBroadcasterV2", BROADCASTER);
    const registry = await viem.getContractAt("GovernancePolicyRegistry", REGISTRY);
    assert.equal(getAddress(await broadcaster.read.owner()), OWNER);
    assert.equal(getAddress(await broadcaster.read.governance()), GOVERNANCE);
    assert.equal(getAddress(await registry.read.governance()), GOVERNANCE);
    const chainIds = await broadcaster.read.getChainIds();
    assert.equal(chainIds.includes(BSC_CHAIN_KEY), true);
    assert.equal((await broadcaster.read.chains([BSC_CHAIN_KEY]))[6], true);

    await networkHelpers.impersonateAccount(OWNER);
    await networkHelpers.setBalance(OWNER, parseEther("2"));
    const ownerWallet = await viem.getWalletClient(OWNER);
    const broadcasterAsOwner = await viem.getContractAt(
      "CrossChainBroadcasterV2",
      BROADCASTER,
      { client: { public: publicClient, wallet: ownerWallet } },
    );
    if (!chainIds.includes(BASE_CHAIN_KEY)) {
      await waitFor(
        publicClient,
        await broadcasterAsOwner.write.addChain([BASE_CHAIN_KEY, {
          lzDstEid: BASE_CHAIN_KEY,
          ccipDstChainSelector: BASE_CCIP_SELECTOR,
          ccipReceiver: getAddress(stage1.executor),
          axDstChain: "base",
          axDstAddress: stage1.executor.toLowerCase(),
          axMinFee: AX_MIN_FEE,
          active: false,
        }]),
      );
      await waitFor(
        publicClient,
        await broadcasterAsOwner.write.setPeer([
          BASE_CHAIN_KEY,
          padHex(getAddress(stage1.executor), { size: 32 }),
        ]),
      );
    }
    assert.deepEqual(await broadcaster.read.getChainIds(), [BSC_CHAIN_KEY, BASE_CHAIN_KEY]);
    assert.equal((await broadcaster.read.chains([BASE_CHAIN_KEY]))[6], false);
    await waitFor(
      publicClient,
      await broadcasterAsOwner.write.setChainActive([BASE_CHAIN_KEY, true]),
    );

    await networkHelpers.impersonateAccount(GOVERNANCE);
    await networkHelpers.setBalance(GOVERNANCE, parseEther("2"));
    const governanceWallet = await viem.getWalletClient(GOVERNANCE);
    const registryAsGovernance = await viem.getContractAt(
      "GovernancePolicyRegistry",
      REGISTRY,
      { client: { public: publicClient, wallet: governanceWallet } },
    );
    await waitFor(
      publicClient,
      await registryAsGovernance.write.setRules([[BSC_PROBE, baseProbe].map((target) => ({
        kind: MAJOR,
        target,
        selector: RECORD_MARKER_SELECTOR,
        allowed: true,
        validateNestedBroadcast: false,
        nestedOnly: true,
        maxValue: 0n,
      }))]),
    );

    const probe = await viem.getContractAt("GovernanceProbe", baseProbe);
    const markerData = encodeFunctionData({
      abi: probe.abi,
      functionName: "recordMarker",
      args: [MARKER],
    });
    const broadcastData = encodeFunctionData({
      abi: broadcaster.abi,
      functionName: "broadcast",
      args: [
        [BSC_CHAIN_KEY, BASE_CHAIN_KEY],
        [BSC_PROBE, baseProbe],
        markerData,
        LZ_GAS,
      ],
    });

    assert.equal(
      await registry.read.isActionAllowed([MAJOR, baseProbe, 0n, markerData]),
      false,
      "Base Probe must remain nested-only",
    );
    assert.equal(
      await registry.read.isActionAllowed([
        MAJOR,
        BROADCASTER,
        FEE_BUDGET,
        broadcastData,
      ]),
      true,
      "exact BSC + Base broadcast must pass nested policy validation",
    );

    const quote = await broadcaster.read.quoteFees([
      [BSC_CHAIN_KEY, BASE_CHAIN_KEY],
      [BSC_PROBE, baseProbe],
      markerData,
      LZ_GAS,
    ]);
    assert.ok(quote > 0n);
    assert.ok(quote <= FEE_BUDGET, `live quote ${quote} exceeds ${FEE_BUDGET}`);

    const nonceBefore = await broadcaster.read.broadcastNonce();
    const broadcasterAsGovernance = await viem.getContractAt(
      "CrossChainBroadcasterV2",
      BROADCASTER,
      { client: { public: publicClient, wallet: governanceWallet } },
    );
    await waitFor(
      publicClient,
      await broadcasterAsGovernance.write.broadcast(
        [
          [BSC_CHAIN_KEY, BASE_CHAIN_KEY],
          [BSC_PROBE, baseProbe],
          markerData,
          LZ_GAS,
        ],
        { value: FEE_BUDGET },
      ),
    );
    assert.equal(await broadcaster.read.broadcastNonce(), nonceBefore + 1n);
  });
});
