import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  keccak256,
  maxUint256,
  padHex,
  parseEther,
  stringToHex,
  toFunctionSelector,
  zeroAddress,
} from "viem";

const D_UNIT = 10n ** 18n;
const FAST_PASS_STAKE = 70n * D_UNIT;
const PARAMETER = 0;
const MAJOR = 2;
const ETH_LZ_EID = 30101;
const BSC_LZ_EID = 30102;
const WH_ETH_CHAIN_ID = 2;

async function waitFor(publicClient: any, hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
  return receipt;
}

function revertsWithSelector(action: () => Promise<unknown>, signature: string) {
  const selector = toFunctionSelector(signature);
  return assert.rejects(action, (error: unknown) => String(error).includes(selector));
}

describe("cross-chain GovernanceProbe onboarding and UUPS upgrade flow", function () {
  it("registers policy, records one marker on both chains, then upgrades after 2-of-3 confirmation", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [owner] = await viem.getWalletClients();

    const d = await viem.deployContract("D", [owner.account.address]);
    const dc = await viem.deployContract("DCToken", [
      "DealCoin",
      "DC",
      10_000n * D_UNIT,
      owner.account.address,
      owner.account.address,
    ]);
    const governanceImplementation = await viem.deployContract("DealGovernanceHarness", []);
    const governanceInit = encodeFunctionData({
      abi: governanceImplementation.abi,
      functionName: "initialize",
      args: [d.address, zeroAddress, dc.address, owner.account.address],
    });
    const governanceProxy = await viem.deployContract("ERC1967Proxy", [
      governanceImplementation.address,
      governanceInit,
    ]);
    const governance = await viem.getContractAt("DealGovernanceHarness", governanceProxy.address);

    const broadcaster = await viem.deployContract("CrossChainBroadcasterRecorder", [
      governanceProxy.address,
    ]);
    const lzEndpoint = await viem.deployContract("MockLzEndpointV2", []);
    const wormholeRelayer = await viem.deployContract("MockWormholeRelayer", []);
    const axelarGateway = await viem.deployContract("MockAxelarGateway", []);
    const broadcasterAsBytes32 = padHex(broadcaster.address, { size: 32 });
    const executor = await viem.deployContract("DualBridgeExecutor", [
      lzEndpoint.address,
      owner.account.address,
      wormholeRelayer.address,
      WH_ETH_CHAIN_ID,
      broadcasterAsBytes32,
      axelarGateway.address,
      "Ethereum",
      broadcaster.address,
      2n,
    ]);
    await waitFor(publicClient, await executor.write.setPeer([ETH_LZ_EID, broadcasterAsBytes32]));

    const ethV1Implementation = await viem.deployContract("GovernanceProbe", []);
    const bscV1Implementation = await viem.deployContract("GovernanceProbe", []);
    const ethInit = encodeFunctionData({
      abi: ethV1Implementation.abi,
      functionName: "initialize",
      args: [governanceProxy.address],
    });
    const bscInit = encodeFunctionData({
      abi: bscV1Implementation.abi,
      functionName: "initialize",
      args: [executor.address],
    });
    const ethProbeProxy = await viem.deployContract("ERC1967Proxy", [
      ethV1Implementation.address,
      ethInit,
    ]);
    const bscProbeProxy = await viem.deployContract("ERC1967Proxy", [
      bscV1Implementation.address,
      bscInit,
    ]);
    const ethProbeV1 = await viem.getContractAt("GovernanceProbe", ethProbeProxy.address);
    const bscProbeV1 = await viem.getContractAt("GovernanceProbe", bscProbeProxy.address);
    const ethV2Implementation = await viem.deployContract("GovernanceProbeUpgradeMock", []);
    const bscV2Implementation = await viem.deployContract("GovernanceProbeUpgradeMock", []);
    const marker = keccak256(stringToHex("DEAL_CROSS_CHAIN_GOVERNANCE_PROBE_V1"));

    await assert.rejects(ethProbeV1.write.recordMarker([marker]), /NotController/);
    await assert.rejects(bscProbeV1.write.recordMarker([marker]), /NotController/);
    await revertsWithSelector(
      () => ethProbeV1.write.upgradeToAndCall([ethV2Implementation.address, "0x"]),
      "NotController()",
    );
    await revertsWithSelector(
      () => bscProbeV1.write.upgradeToAndCall([bscV2Implementation.address, "0x"]),
      "NotController()",
    );

    const registryNonce = await publicClient.getTransactionCount({
      address: owner.account.address,
    });
    const predictedRegistry = getContractAddress({
      from: owner.account.address,
      nonce: BigInt(registryNonce),
    });
    const broadcastSelector = toFunctionSelector("broadcast(uint32[],address[],bytes,uint128)");
    const initialRules = [
      {
        kind: MAJOR,
        target: predictedRegistry,
        selector: toFunctionSelector("setRules((uint8,address,bytes4,bool,bool,bool,uint256)[])"),
        allowed: true,
        validateNestedBroadcast: false,
        nestedOnly: false,
        maxValue: 0n,
      },
      ...[PARAMETER, MAJOR].map((kind) => ({
        kind,
        target: broadcaster.address,
        selector: broadcastSelector,
        allowed: true,
        validateNestedBroadcast: true,
        nestedOnly: false,
        maxValue: parseEther("1"),
      })),
    ];
    const registry = await viem.deployContract("GovernancePolicyRegistry", [
      governanceProxy.address,
      initialRules,
    ]);
    assert.equal(registry.address.toLowerCase(), predictedRegistry.toLowerCase());
    await waitFor(
      publicClient,
      await governance.write.bootstrapPolicyRegistryForTest([registry.address]),
    );

    await waitFor(publicClient, await d.write.approve([governanceProxy.address, maxUint256]));
    await waitFor(publicClient, await dc.write.approve([governanceProxy.address, maxUint256]));

    const markerData = encodeFunctionData({
      abi: ethProbeV1.abi,
      functionName: "recordMarker",
      args: [marker],
    });
    const markerBroadcastData = encodeFunctionData({
      abi: broadcaster.abi,
      functionName: "broadcast",
      args: [[BSC_LZ_EID], [bscProbeProxy.address], markerData, 500_000n],
    });
    await assert.rejects(
      governance.write.createProposal([
        [ethProbeProxy.address, broadcaster.address],
        [0n, 1n],
        [markerData, markerBroadcastData],
        "must register GovernanceProbe policy first",
        PARAMETER,
      ]),
      /ActionNotAllowed/,
    );

    const markerSelector = toFunctionSelector("recordMarker(bytes32)");
    const upgradeSelector = toFunctionSelector("upgradeToAndCall(address,bytes)");
    const probeRules = [
      {
        kind: PARAMETER,
        target: ethProbeProxy.address,
        selector: markerSelector,
        allowed: true,
        validateNestedBroadcast: false,
        nestedOnly: false,
        maxValue: 0n,
      },
      {
        kind: PARAMETER,
        target: bscProbeProxy.address,
        selector: markerSelector,
        allowed: true,
        validateNestedBroadcast: false,
        nestedOnly: true,
        maxValue: 0n,
      },
      {
        kind: MAJOR,
        target: ethProbeProxy.address,
        selector: upgradeSelector,
        allowed: true,
        validateNestedBroadcast: false,
        nestedOnly: false,
        maxValue: 0n,
      },
      {
        kind: MAJOR,
        target: bscProbeProxy.address,
        selector: upgradeSelector,
        allowed: true,
        validateNestedBroadcast: false,
        nestedOnly: true,
        maxValue: 0n,
      },
    ];
    const setRulesData = encodeFunctionData({
      abi: registry.abi,
      functionName: "setRules",
      args: [probeRules],
    });
    await waitFor(
      publicClient,
      await governance.write.createProposal([
        [registry.address],
        [0n],
        [setRulesData],
        "Phase A: register direct ETH and nested BSC GovernanceProbe rules",
        MAJOR,
      ]),
    );
    const policyProposalId = await governance.read.proposalCount();
    await waitFor(publicClient, await governance.write.stake([policyProposalId, FAST_PASS_STAKE]));
    await waitFor(publicClient, await governance.write.execute([policyProposalId]));
    await waitFor(publicClient, await governance.write.claimBack([policyProposalId]));

    for (const [kind, target, selector, nestedOnly] of [
      [PARAMETER, ethProbeProxy.address, markerSelector, false],
      [PARAMETER, bscProbeProxy.address, markerSelector, true],
      [MAJOR, ethProbeProxy.address, upgradeSelector, false],
      [MAJOR, bscProbeProxy.address, upgradeSelector, true],
    ] as const) {
      const rule = await registry.read.getRule([kind, target, selector]);
      assert.equal(rule.allowed, true);
      assert.equal(rule.nestedOnly, nestedOnly);
      assert.equal(rule.maxValue, 0n);
    }

    await waitFor(
      publicClient,
      await executor.write.setAllowedTarget([bscProbeProxy.address, true]),
    );
    assert.equal(await executor.read.allowedTargets([bscProbeProxy.address]), true);

    await waitFor(
      publicClient,
      await governance.write.createProposal([
        [ethProbeProxy.address, broadcaster.address],
        [0n, 1n],
        [markerData, markerBroadcastData],
        "Phase B: record the same harmless marker on ETH and BSC",
        PARAMETER,
      ]),
    );
    const markerProposalId = await governance.read.proposalCount();
    await waitFor(publicClient, await governance.write.stake([markerProposalId, FAST_PASS_STAKE]));
    await waitFor(publicClient, await governance.write.execute([markerProposalId], { value: 1n }));
    await waitFor(publicClient, await governance.write.claimBack([markerProposalId]));

    assert.equal(await ethProbeV1.read.marker(), marker);
    assert.equal(await ethProbeV1.read.updateCount(), 1n);
    assert.equal(await bscProbeV1.read.marker(), `0x${"00".repeat(32)}`);
    assert.equal(await broadcaster.read.broadcastNonce(), 1n);
    assert.equal(await broadcaster.read.lastData(), markerData);

    const markerPayload = encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
      [1n, bscProbeProxy.address, markerData],
    );
    const markerMessageHash = keccak256(markerPayload);
    const markerOrigin = {
      srcEid: ETH_LZ_EID,
      sender: broadcasterAsBytes32,
      nonce: 1n,
    };
    await waitFor(
      publicClient,
      await lzEndpoint.write.deliver([executor.address, markerOrigin, markerPayload]),
    );
    let status = await executor.read.confirmStatus([markerMessageHash]);
    assert.deepEqual(status, [true, false, false, 1n, false]);
    assert.equal(await bscProbeV1.read.updateCount(), 0n);

    await waitFor(
      publicClient,
      await wormholeRelayer.write.deliver([
        executor.address,
        markerPayload,
        broadcasterAsBytes32,
        WH_ETH_CHAIN_ID,
      ]),
    );
    status = await executor.read.confirmStatus([markerMessageHash]);
    assert.deepEqual(status, [true, true, false, 2n, true]);
    assert.equal(await bscProbeV1.read.marker(), marker);
    assert.equal(await bscProbeV1.read.updateCount(), 1n);

    const ethUpgradeData = encodeFunctionData({
      abi: ethProbeV1.abi,
      functionName: "upgradeToAndCall",
      args: [ethV2Implementation.address, "0x"],
    });
    const bscUpgradeData = encodeFunctionData({
      abi: bscProbeV1.abi,
      functionName: "upgradeToAndCall",
      args: [bscV2Implementation.address, "0x"],
    });
    const upgradeBroadcastData = encodeFunctionData({
      abi: broadcaster.abi,
      functionName: "broadcast",
      args: [[BSC_LZ_EID], [bscProbeProxy.address], bscUpgradeData, 500_000n],
    });
    await waitFor(
      publicClient,
      await governance.write.createProposal([
        [ethProbeProxy.address, broadcaster.address],
        [0n, 1n],
        [ethUpgradeData, upgradeBroadcastData],
        "Phase C: upgrade GovernanceProbe on ETH and BSC",
        MAJOR,
      ]),
    );
    const upgradeProposalId = await governance.read.proposalCount();
    await waitFor(publicClient, await governance.write.stake([upgradeProposalId, FAST_PASS_STAKE]));
    await waitFor(publicClient, await governance.write.execute([upgradeProposalId], { value: 1n }));

    const ethProbeV2 = await viem.getContractAt("GovernanceProbeUpgradeMock", ethProbeProxy.address);
    assert.equal(await ethProbeV2.read.version(), 2n);
    assert.equal(await ethProbeV2.read.upgradedFeatureAvailable(), true);
    assert.equal(await ethProbeV2.read.marker(), marker);
    assert.equal(await ethProbeV2.read.updateCount(), 1n);
    assert.equal(await bscProbeV1.read.version(), 1n);
    assert.equal(await broadcaster.read.broadcastNonce(), 2n);
    assert.equal(await broadcaster.read.lastChainId(), BSC_LZ_EID);
    assert.equal((await broadcaster.read.lastTarget()).toLowerCase(), bscProbeProxy.address.toLowerCase());
    assert.equal(await broadcaster.read.lastData(), bscUpgradeData);
    assert.equal(await broadcaster.read.lastLzGas(), 500_000n);
    assert.equal(await broadcaster.read.totalValueReceived(), 2n);

    const upgradePayload = encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
      [2n, bscProbeProxy.address, bscUpgradeData],
    );
    const upgradeMessageHash = keccak256(upgradePayload);
    const upgradeOrigin = {
      srcEid: ETH_LZ_EID,
      sender: broadcasterAsBytes32,
      nonce: 2n,
    };
    await waitFor(
      publicClient,
      await lzEndpoint.write.deliver([executor.address, upgradeOrigin, upgradePayload]),
    );
    status = await executor.read.confirmStatus([upgradeMessageHash]);
    assert.deepEqual(status, [true, false, false, 1n, false]);
    assert.equal(await bscProbeV1.read.version(), 1n);

    await waitFor(
      publicClient,
      await wormholeRelayer.write.deliver([
        executor.address,
        upgradePayload,
        broadcasterAsBytes32,
        WH_ETH_CHAIN_ID,
      ]),
    );
    status = await executor.read.confirmStatus([upgradeMessageHash]);
    assert.deepEqual(status, [true, true, false, 2n, true]);

    const bscProbeV2 = await viem.getContractAt("GovernanceProbeUpgradeMock", bscProbeProxy.address);
    assert.equal(await bscProbeV2.read.version(), 2n);
    assert.equal(await bscProbeV2.read.upgradedFeatureAvailable(), true);
    assert.equal(await bscProbeV2.read.marker(), marker);
    assert.equal(await bscProbeV2.read.updateCount(), 1n);
    assert.equal((await ethProbeV2.read.controller()).toLowerCase(), governanceProxy.address.toLowerCase());
    assert.equal((await bscProbeV2.read.controller()).toLowerCase(), executor.address.toLowerCase());
  });
});
