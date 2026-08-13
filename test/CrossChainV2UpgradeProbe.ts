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
const ETH_CCIP_SELECTOR = 5_009_297_550_715_157_269n;
const BSC_CCIP_SELECTOR = 11_344_663_589_394_136_015n;
const LZ_FEE = 2n;
const CCIP_FEE = 5n;
const AXELAR_FEE = 3n;
const TOTAL_BRIDGE_FEE = LZ_FEE + CCIP_FEE + AXELAR_FEE;

async function waitFor(publicClient: any, hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
  return receipt;
}

function revertsWithSelector(action: () => Promise<unknown>, signature: string) {
  const selector = toFunctionSelector(signature);
  return assert.rejects(action, (error: unknown) => String(error).includes(selector));
}

describe("asset-free CrossChainBroadcasterV2 UUPS upgrade probe", function () {
  it("uses one DAO proposal to upgrade ETH directly and BSC after any 2-of-3 confirmations", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [owner, outsider] = await viem.getWalletClients();

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
    const governance = await viem.getContractAt(
      "DealGovernanceHarness",
      governanceProxy.address,
    );

    const lzEndpoint = await viem.deployContract("MockLzEndpointForCCIP", []);
    const ccipRouter = await viem.deployContract("MockCCIPRouter", []);
    const axelarGateway = await viem.deployContract("MockAxelarGatewayForCCIP", []);
    const axelarGasService = await viem.deployContract(
      "MockAxelarGasServiceForCCIP",
      [],
    );
    await waitFor(publicClient, await lzEndpoint.write.setFee([LZ_FEE]));
    await waitFor(publicClient, await ccipRouter.write.setFee([CCIP_FEE]));
    await waitFor(
      publicClient,
      await ccipRouter.write.setChainSupported([BSC_CCIP_SELECTOR, true]),
    );

    const broadcaster = await viem.deployContract("CrossChainBroadcasterV2", [
      lzEndpoint.address,
      owner.account.address,
      governanceProxy.address,
      ccipRouter.address,
      axelarGateway.address,
      axelarGasService.address,
    ]);
    const executor = await viem.deployContract("DualBridgeExecutorV2", [
      lzEndpoint.address,
      owner.account.address,
      ccipRouter.address,
      ETH_CCIP_SELECTOR,
      broadcaster.address,
      axelarGateway.address,
      "Ethereum",
      broadcaster.address,
      2n,
    ]);
    const broadcasterBytes32 = padHex(broadcaster.address, { size: 32 });
    const executorBytes32 = padHex(executor.address, { size: 32 });
    await waitFor(
      publicClient,
      await broadcaster.write.setPeer([BSC_LZ_EID, executorBytes32]),
    );
    await waitFor(
      publicClient,
      await executor.write.setPeer([ETH_LZ_EID, broadcasterBytes32]),
    );
    await waitFor(
      publicClient,
      await broadcaster.write.addChain([
        BSC_LZ_EID,
        {
          lzDstEid: BSC_LZ_EID,
          ccipDstChainSelector: BSC_CCIP_SELECTOR,
          ccipReceiver: executor.address,
          axDstChain: "binance",
          axDstAddress: executor.address.toLowerCase(),
          axMinFee: AXELAR_FEE,
          active: true,
        },
      ]),
    );

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
    const ethProxy = await viem.deployContract("ERC1967Proxy", [
      ethV1Implementation.address,
      ethInit,
    ]);
    const bscProxy = await viem.deployContract("ERC1967Proxy", [
      bscV1Implementation.address,
      bscInit,
    ]);
    const ethV1 = await viem.getContractAt("GovernanceProbe", ethProxy.address);
    const bscV1 = await viem.getContractAt("GovernanceProbe", bscProxy.address);
    const ethV2Implementation = await viem.deployContract(
      "GovernanceProbeUpgradeMock",
      [],
    );
    const bscV2Implementation = await viem.deployContract(
      "GovernanceProbeUpgradeMock",
      [],
    );

    await revertsWithSelector(
      () => ethV1Implementation.write.initialize([owner.account.address]),
      "InvalidInitialization()",
    );
    await revertsWithSelector(
      () => bscV1Implementation.write.initialize([owner.account.address]),
      "InvalidInitialization()",
    );
    await revertsWithSelector(
      () => ethV1.write.upgradeToAndCall([ethV2Implementation.address, "0x"]),
      "NotController()",
    );
    const bscAsOutsider = await viem.getContractAt("GovernanceProbe", bscProxy.address, {
      client: { public: publicClient, wallet: outsider },
    });
    await revertsWithSelector(
      () => bscAsOutsider.write.upgradeToAndCall([bscV2Implementation.address, "0x"]),
      "NotController()",
    );

    const registryNonce = await publicClient.getTransactionCount({
      address: owner.account.address,
    });
    const predictedRegistry = getContractAddress({
      from: owner.account.address,
      nonce: BigInt(registryNonce),
    });
    const broadcastSelector = toFunctionSelector(
      "broadcast(uint32[],address[],bytes,uint128)",
    );
    const registry = await viem.deployContract("GovernancePolicyRegistry", [
      governanceProxy.address,
      [
        {
          kind: MAJOR,
          target: predictedRegistry,
          selector: toFunctionSelector(
            "setRules((uint8,address,bytes4,bool,bool,bool,uint256)[])",
          ),
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
      ],
    ]);
    assert.equal(registry.address.toLowerCase(), predictedRegistry.toLowerCase());
    await waitFor(
      publicClient,
      await governance.write.bootstrapPolicyRegistryForTest([registry.address]),
    );
    await waitFor(publicClient, await d.write.approve([governanceProxy.address, maxUint256]));
    await waitFor(
      publicClient,
      await dc.write.approve([governanceProxy.address, maxUint256]),
    );

    const markerSelector = toFunctionSelector("recordMarker(bytes32)");
    const upgradeSelector = toFunctionSelector("upgradeToAndCall(address,bytes)");
    const rules = [
      {
        kind: PARAMETER,
        target: ethProxy.address,
        selector: markerSelector,
        allowed: true,
        validateNestedBroadcast: false,
        nestedOnly: false,
        maxValue: 0n,
      },
      {
        kind: PARAMETER,
        target: bscProxy.address,
        selector: markerSelector,
        allowed: true,
        validateNestedBroadcast: false,
        nestedOnly: true,
        maxValue: 0n,
      },
      {
        kind: MAJOR,
        target: ethProxy.address,
        selector: upgradeSelector,
        allowed: true,
        validateNestedBroadcast: false,
        nestedOnly: false,
        maxValue: 0n,
      },
      {
        kind: MAJOR,
        target: bscProxy.address,
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
      args: [rules],
    });
    await waitFor(
      publicClient,
      await governance.write.createProposal([
        [registry.address],
        [0n],
        [setRulesData],
        "测试探针授权",
        MAJOR,
      ]),
    );
    const policyProposalId = await governance.read.proposalCount();
    await waitFor(
      publicClient,
      await governance.write.stake([policyProposalId, FAST_PASS_STAKE]),
    );
    await waitFor(publicClient, await governance.write.execute([policyProposalId]));
    await waitFor(publicClient, await governance.write.claimBack([policyProposalId]));
    await waitFor(
      publicClient,
      await executor.write.setAllowedTarget([bscProxy.address, true]),
    );

    const marker = keccak256(stringToHex("DEAL_V2_ASSET_FREE_UPGRADE_PROBE"));
    const markerData = encodeFunctionData({
      abi: ethV1.abi,
      functionName: "recordMarker",
      args: [marker],
    });
    const markerBroadcastData = encodeFunctionData({
      abi: broadcaster.abi,
      functionName: "broadcast",
      args: [[BSC_LZ_EID], [bscProxy.address], markerData, 500_000n],
    });
    assert.equal(
      await registry.read.isActionAllowed([
        PARAMETER,
        broadcaster.address,
        TOTAL_BRIDGE_FEE,
        markerBroadcastData,
      ]),
      true,
    );
    await waitFor(
      publicClient,
      await governance.write.createProposal([
        [ethProxy.address, broadcaster.address],
        [0n, TOTAL_BRIDGE_FEE],
        [markerData, markerBroadcastData],
        "测试探针写入",
        PARAMETER,
      ]),
    );
    const markerProposalId = await governance.read.proposalCount();
    await waitFor(
      publicClient,
      await governance.write.stake([markerProposalId, FAST_PASS_STAKE]),
    );
    await waitFor(
      publicClient,
      await governance.write.execute([markerProposalId], {
        value: TOTAL_BRIDGE_FEE,
      }),
    );
    await waitFor(publicClient, await governance.write.claimBack([markerProposalId]));
    assert.equal(await ethV1.read.marker(), marker);
    assert.equal(await ethV1.read.updateCount(), 1n);
    assert.equal(await bscV1.read.updateCount(), 0n);

    const markerPayload = await ccipRouter.read.lastData();
    const markerHash = keccak256(markerPayload);
    await waitFor(
      publicClient,
      await lzEndpoint.write.deliver([
        executor.address,
        { srcEid: ETH_LZ_EID, sender: broadcasterBytes32, nonce: 1n },
        markerPayload,
      ]),
    );
    await waitFor(
      publicClient,
      await ccipRouter.write.deliver([
        executor.address,
        keccak256("0x01"),
        ETH_CCIP_SELECTOR,
        encodeAbiParameters([{ type: "address" }], [broadcaster.address]),
        markerPayload,
      ]),
    );
    assert.deepEqual(await executor.read.confirmStatus([markerHash]), [
      true,
      true,
      false,
      2n,
      true,
    ]);
    assert.equal(await bscV1.read.marker(), marker);
    assert.equal(await bscV1.read.updateCount(), 1n);

    const ethUpgradeData = encodeFunctionData({
      abi: ethV1.abi,
      functionName: "upgradeToAndCall",
      args: [ethV2Implementation.address, "0x"],
    });
    const bscUpgradeData = encodeFunctionData({
      abi: bscV1.abi,
      functionName: "upgradeToAndCall",
      args: [bscV2Implementation.address, "0x"],
    });
    const upgradeBroadcastData = encodeFunctionData({
      abi: broadcaster.abi,
      functionName: "broadcast",
      args: [[BSC_LZ_EID], [bscProxy.address], bscUpgradeData, 500_000n],
    });
    assert.equal(
      await registry.read.isActionAllowed([
        MAJOR,
        ethProxy.address,
        0n,
        ethUpgradeData,
      ]),
      true,
    );
    assert.equal(
      await registry.read.isActionAllowed([
        MAJOR,
        broadcaster.address,
        TOTAL_BRIDGE_FEE,
        upgradeBroadcastData,
      ]),
      true,
    );
    await waitFor(
      publicClient,
      await governance.write.createProposal([
        [ethProxy.address, broadcaster.address],
        [0n, TOTAL_BRIDGE_FEE],
        [ethUpgradeData, upgradeBroadcastData],
        "跨链升级探针测试",
        MAJOR,
      ]),
    );
    const upgradeProposalId = await governance.read.proposalCount();
    await waitFor(
      publicClient,
      await governance.write.stake([upgradeProposalId, FAST_PASS_STAKE]),
    );
    await waitFor(
      publicClient,
      await governance.write.execute([upgradeProposalId], {
        value: TOTAL_BRIDGE_FEE,
      }),
    );

    const ethV2 = await viem.getContractAt(
      "GovernanceProbeUpgradeMock",
      ethProxy.address,
    );
    assert.equal(await ethV2.read.version(), 2n);
    assert.equal(await ethV2.read.upgradedFeatureAvailable(), true);
    assert.equal(await ethV2.read.marker(), marker);
    assert.equal(await ethV2.read.updateCount(), 1n);
    assert.equal(
      (await ethV2.read.controller()).toLowerCase(),
      governanceProxy.address.toLowerCase(),
    );
    assert.equal(await bscV1.read.version(), 1n);

    const upgradePayload = await ccipRouter.read.lastData();
    const upgradeHash = keccak256(upgradePayload);
    await revertsWithSelector(
      () =>
        ccipRouter.write.deliver([
          executor.address,
          keccak256("0x02"),
          ETH_CCIP_SELECTOR,
          encodeAbiParameters([{ type: "address" }], [outsider.account.address]),
          upgradePayload,
        ]),
      "WrongCcipSrcSender(address,address)",
    );
    await waitFor(
      publicClient,
      await axelarGateway.write.deliver([
        executor.address,
        keccak256("0x03"),
        "Ethereum",
        broadcaster.address,
        upgradePayload,
      ]),
    );
    assert.equal(await bscV1.read.version(), 1n);
    await waitFor(
      publicClient,
      await ccipRouter.write.deliver([
        executor.address,
        keccak256("0x04"),
        ETH_CCIP_SELECTOR,
        encodeAbiParameters([{ type: "address" }], [broadcaster.address]),
        upgradePayload,
      ]),
    );
    assert.deepEqual(await executor.read.confirmStatus([upgradeHash]), [
      false,
      true,
      true,
      2n,
      true,
    ]);
    assert.equal(await executor.read.executionAttempts([upgradeHash]), 1n);

    const bscV2 = await viem.getContractAt(
      "GovernanceProbeUpgradeMock",
      bscProxy.address,
    );
    assert.equal(await bscV2.read.version(), 2n);
    assert.equal(await bscV2.read.upgradedFeatureAvailable(), true);
    assert.equal(await bscV2.read.marker(), marker);
    assert.equal(await bscV2.read.updateCount(), 1n);
    assert.equal(
      (await bscV2.read.controller()).toLowerCase(),
      executor.address.toLowerCase(),
    );

    await waitFor(
      publicClient,
      await lzEndpoint.write.deliver([
        executor.address,
        { srcEid: ETH_LZ_EID, sender: broadcasterBytes32, nonce: 2n },
        upgradePayload,
      ]),
    );
    assert.deepEqual(await executor.read.confirmStatus([upgradeHash]), [
      true,
      true,
      true,
      3n,
      true,
    ]);
    assert.equal(await executor.read.executionAttempts([upgradeHash]), 1n);
    await revertsWithSelector(
      () =>
        ccipRouter.write.deliver([
          executor.address,
          keccak256("0x05"),
          ETH_CCIP_SELECTOR,
          encodeAbiParameters([{ type: "address" }], [broadcaster.address]),
          upgradePayload,
        ]),
      "AlreadyConfirmed(bytes32,bytes32)",
    );
  });
});
