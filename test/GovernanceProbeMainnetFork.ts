import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeFunctionData,
  getAddress,
  maxUint256,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

const UNIT = 10n ** 18n;
const PARAMETER = 0;
const MAJOR = 2;
const FAST_PASS_STAKE = 70n * UNIT;
const DEFAULT_D_HOLDER = getAddress("0x14800e9a1a8b39fb84aa7fa4e6d7beb553cbf0fd");
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const runFork = process.env.GOVERNANCE_PROBE_MAINNET_FORK === "1";
const forkDescribe = runFork ? describe : describe.skip;

type Deployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
};
type CrossChainDeployment = {
  bsc: { executor: Address };
  params: { bscChainKey: number };
};

async function waitFor(publicClient: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
  return receipt;
}

function slotAddress(word: Hex | undefined): Address {
  assert.ok(word && word.length === 66, "implementation slot missing");
  return getAddress(`0x${word.slice(-40)}`);
}

forkDescribe("GovernanceProbe ETH mainnet fork", function () {
  it("adds the exact rules to the live V2 registry and exercises marker plus UUPS control", async function () {
    const eth = JSON.parse(readFileSync("deployments/eth-mainnet-1.json", "utf8")) as Deployment;
    const crossChain = JSON.parse(
      readFileSync("deployments/mainnet-cross-chain.json", "utf8"),
    ) as CrossChainDeployment;
    assert.equal(eth.chainId, 1);
    const governanceAddress = getAddress(eth.addresses.dealGovernance);
    const registryAddress = getAddress(eth.addresses.governancePolicyRegistry);
    const broadcasterAddress = getAddress(eth.addresses.crossChainBroadcaster);
    const dAddress = getAddress(eth.addresses.dToken);
    const dcAddress = getAddress(eth.addresses.dlToken);
    const executorAddress = getAddress(crossChain.bsc.executor);
    const dHolder = process.env.DAO_V2_FORK_D_HOLDER
      ? getAddress(process.env.DAO_V2_FORK_D_HOLDER)
      : DEFAULT_D_HOLDER;

    const { viem, networkHelpers } = await network.connect({
      network: "hardhatEthFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    assert.equal(await publicClient.getChainId(), 1);
    console.log(`GovernanceProbe fork block: ${await publicClient.getBlockNumber()}`);
    const [localDeployer] = await viem.getWalletClients();
    assert.ok(localDeployer, "fork development wallet missing");

    await networkHelpers.impersonateAccount(dHolder);
    await networkHelpers.setBalance(dHolder, parseEther("10"));
    const dHolderWallet = await viem.getWalletClient(dHolder);
    const dAsHolder = await viem.getContractAt("D", dAddress, {
      client: { public: publicClient, wallet: dHolderWallet },
    });
    assert.ok((await dAsHolder.read.balanceOf([dHolder])) >= FAST_PASS_STAKE);
    await waitFor(publicClient, await dAsHolder.write.approve([governanceAddress, maxUint256]));

    const mainnetDeployer = getAddress(eth.deployer);
    await networkHelpers.impersonateAccount(mainnetDeployer);
    await networkHelpers.setBalance(mainnetDeployer, parseEther("10"));
    const mainnetDeployerWallet = await viem.getWalletClient(mainnetDeployer);
    const dcAsMinter = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: mainnetDeployerWallet },
    });
    const governance = await viem.getContractAt("DealGovernance", governanceAddress, {
      client: { public: publicClient, wallet: dHolderWallet },
    });
    const majorFee = await governance.read.majorProposalFee();
    await waitFor(publicClient, await dcAsMinter.write.mint([dHolder, majorFee * 2n]));
    const dcAsHolder = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: dHolderWallet },
    });
    await waitFor(publicClient, await dcAsHolder.write.approve([governanceAddress, majorFee * 2n]));

    const deployClient = { public: publicClient, wallet: localDeployer } as const;
    const ethImplementation = await viem.deployContract("GovernanceProbe", [], { client: deployClient });
    const bscImplementation = await viem.deployContract("GovernanceProbe", [], { client: deployClient });
    const ethInit = encodeFunctionData({
      abi: ethImplementation.abi,
      functionName: "initialize",
      args: [governanceAddress],
    });
    const bscInit = encodeFunctionData({
      abi: bscImplementation.abi,
      functionName: "initialize",
      args: [executorAddress],
    });
    const ethProxy = await viem.deployContract("ERC1967Proxy", [ethImplementation.address, ethInit], {
      client: deployClient,
    });
    const bscProxy = await viem.deployContract("ERC1967Proxy", [bscImplementation.address, bscInit], {
      client: deployClient,
    });
    const ethProbe = await viem.getContractAt("GovernanceProbe", ethProxy.address);
    assert.equal(getAddress(await ethProbe.read.controller()), governanceAddress);
    assert.equal(await ethProbe.read.version(), 1n);

    const markerSelector = toFunctionSelector("recordMarker(bytes32)");
    const upgradeSelector = toFunctionSelector("upgradeToAndCall(address,bytes)");
    const rules = [
      { kind: PARAMETER, target: ethProxy.address, selector: markerSelector, allowed: true, validateNestedBroadcast: false, nestedOnly: false, maxValue: 0n },
      { kind: PARAMETER, target: bscProxy.address, selector: markerSelector, allowed: true, validateNestedBroadcast: false, nestedOnly: true, maxValue: 0n },
      { kind: MAJOR, target: ethProxy.address, selector: upgradeSelector, allowed: true, validateNestedBroadcast: false, nestedOnly: false, maxValue: 0n },
      { kind: MAJOR, target: bscProxy.address, selector: upgradeSelector, allowed: true, validateNestedBroadcast: false, nestedOnly: true, maxValue: 0n },
    ];
    const registry = await viem.getContractAt("GovernancePolicyRegistry", registryAddress);
    const setRulesData = encodeFunctionData({
      abi: registry.abi,
      functionName: "setRules",
      args: [rules],
    });
    await waitFor(
      publicClient,
      await governance.write.createProposal([
        [registryAddress],
        [0n],
        [setRulesData],
        "Fork: enable GovernanceProbe exact ETH and BSC rules",
        MAJOR,
      ]),
    );
    const policyProposalId = await governance.read.proposalCount();
    await waitFor(publicClient, await governance.write.stake([policyProposalId, FAST_PASS_STAKE]));
    await waitFor(publicClient, await governance.write.execute([policyProposalId]));
    await waitFor(publicClient, await governance.write.claimBack([policyProposalId]));
    for (const expected of rules) {
      const actual = await registry.read.getRule([expected.kind, expected.target, expected.selector]);
      assert.equal(actual.allowed, true);
      assert.equal(actual.nestedOnly, expected.nestedOnly);
      assert.equal(actual.maxValue, 0n);
    }

    const marker = "0xbf881c9c366f4c13886585821440811cf5519ba8508807a2368f8aa6bcac57a5" as Hex;
    const markerData = encodeFunctionData({
      abi: ethProbe.abi,
      functionName: "recordMarker",
      args: [marker],
    });
    const broadcaster = await viem.getContractAt("CrossChainBroadcaster", broadcasterAddress);
    const broadcastData = encodeFunctionData({
      abi: broadcaster.abi,
      functionName: "broadcast",
      args: [[crossChain.params.bscChainKey], [bscProxy.address], markerData, 500_000n],
    });
    assert.equal(
      await registry.read.isActionAllowed([PARAMETER, ethProxy.address, 0n, markerData]),
      true,
    );
    assert.equal(
      await registry.read.isActionAllowed([PARAMETER, broadcasterAddress, 1n, broadcastData]),
      true,
    );

    await waitFor(
      publicClient,
      await governance.write.createProposal([
        [ethProxy.address],
        [0n],
        [markerData],
        "Fork: record harmless local GovernanceProbe marker",
        PARAMETER,
      ]),
    );
    const markerProposalId = await governance.read.proposalCount();
    await waitFor(publicClient, await governance.write.stake([markerProposalId, FAST_PASS_STAKE]));
    await waitFor(publicClient, await governance.write.execute([markerProposalId]));
    await waitFor(publicClient, await governance.write.claimBack([markerProposalId]));
    assert.equal(await ethProbe.read.marker(), marker);
    assert.equal(await ethProbe.read.updateCount(), 1n);

    const nextImplementation = await viem.deployContract("GovernanceProbeUpgradeMock", [], {
      client: deployClient,
    });
    const upgradeData = encodeFunctionData({
      abi: ethProbe.abi,
      functionName: "upgradeToAndCall",
      args: [nextImplementation.address, "0x"],
    });
    await waitFor(
      publicClient,
      await governance.write.createProposal([
        [ethProxy.address],
        [0n],
        [upgradeData],
        "Fork: upgrade GovernanceProbe without changing its state",
        MAJOR,
      ]),
    );
    const upgradeProposalId = await governance.read.proposalCount();
    await waitFor(publicClient, await governance.write.stake([upgradeProposalId, FAST_PASS_STAKE]));
    await waitFor(publicClient, await governance.write.execute([upgradeProposalId]));
    await waitFor(publicClient, await governance.write.claimBack([upgradeProposalId]));
    assert.equal(
      slotAddress(await publicClient.getStorageAt({ address: ethProxy.address, slot: IMPLEMENTATION_SLOT })),
      getAddress(nextImplementation.address),
    );
    const upgraded = await viem.getContractAt("GovernanceProbeUpgradeMock", ethProxy.address);
    assert.equal(await upgraded.read.version(), 2n);
    assert.equal(await upgraded.read.marker(), marker);
    assert.equal(await upgraded.read.updateCount(), 1n);
    assert.equal(getAddress(await upgraded.read.controller()), governanceAddress);
  });
});
