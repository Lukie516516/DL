import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeFunctionData,
  getAddress,
  getContractAddress,
  maxUint256,
  parseAbi,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

import {
  buildDaoV2PolicyRules,
  DEFAULT_BROADCAST_MAX_VALUE,
  DAO_V2_PROPOSAL_KIND,
  toRegistryRuleInputs,
} from "../scripts/dao-v2-policy.js";

const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const D_UNIT = 10n ** 18n;
const FAST_PASS_STAKE = 70n * D_UNIT;
const DEFAULT_D_HOLDER = getAddress("0x14800e9a1a8b39fb84aa7fa4e6d7beb553cbf0fd");
const runFork = process.env.DAO_V2_MAINNET_FORK === "1";
const forkDescribe = runFork ? describe : describe.skip;

type Deployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
};

type CrossChainDeployment = {
  bsc: { executor: Address };
  params: { bscChainKey: number; bscDealFactory: Address };
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

forkDescribe("DealGovernance V2 ETH mainnet fork", function () {
  it("rehearses the atomic upgrade, preserves history and enforces the production policy", async function () {
    try {
    const eth = JSON.parse(readFileSync("deployments/eth-mainnet-1.json", "utf8")) as Deployment;
    const crossChain = JSON.parse(
      readFileSync("deployments/mainnet-cross-chain.json", "utf8"),
    ) as CrossChainDeployment;
    const addresses = eth.addresses;
    const governanceAddress = getAddress(addresses.dealGovernance);
    const oldImplementation = getAddress(addresses.dealGovernanceImpl);
    const dAddress = getAddress(addresses.dToken);
    const dcAddress = getAddress(addresses.dlToken);
    const factoryAddress = getAddress(addresses.dealFactory);
    const treasuryAddress = getAddress(addresses.protocolTreasury);
    const broadcasterAddress = getAddress(addresses.crossChainBroadcaster);
    const bscFactoryAddress = getAddress(crossChain.params.bscDealFactory);
    const dHolder = process.env.DAO_V2_FORK_D_HOLDER
      ? getAddress(process.env.DAO_V2_FORK_D_HOLDER)
      : DEFAULT_D_HOLDER;

    const { viem, networkHelpers } = await network.connect({
      network: "hardhatEthFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    assert.equal(await publicClient.getChainId(), 1);
    const forkBlock = await publicClient.getBlockNumber();
    console.log(`DAO V2 fork block: ${forkBlock}`);

    const [localDeployer, recipient] = await viem.getWalletClients();
    assert.ok(localDeployer && recipient, "fork development wallets missing");
    const oldSlot = await publicClient.getStorageAt({
      address: governanceAddress,
      slot: IMPLEMENTATION_SLOT,
    });
    assert.equal(slotAddress(oldSlot), oldImplementation);

    const governanceRead = await viem.getContractAt("DealGovernance", governanceAddress);
    const historicalProposal = await governanceRead.read.getProposal([5n]);
    const historicalActions = await governanceRead.read.getActions([5n]);
    const before = {
      dToken: await governanceRead.read.dToken(),
      dcToken: await governanceRead.read.dcToken(),
      treasury: await governanceRead.read.treasury(),
      nftVetoRegistry: await governanceRead.read.nftVetoRegistry(),
      activationThreshold: await governanceRead.read.activationThreshold(),
      treasuryPassThreshold: await governanceRead.read.treasuryPassThreshold(),
      satoshiPassThreshold: await governanceRead.read.satoshiPassThreshold(),
      paramWindowSeconds: await governanceRead.read.paramWindowSeconds(),
      majorWindowSeconds: await governanceRead.read.majorWindowSeconds(),
      nftVetoThresholdBps: await governanceRead.read.nftVetoThresholdBps(),
      majorProposalFee: await governanceRead.read.majorProposalFee(),
      fastPassThreshold: await governanceRead.read.fastPassThreshold(),
      proposalCount: await governanceRead.read.proposalCount(),
      executedProposalCount: await governanceRead.read.executedProposalCount(),
    };

    await networkHelpers.impersonateAccount(dHolder);
    await networkHelpers.setBalance(dHolder, parseEther("10"));
    const dHolderWallet = await viem.getWalletClient(dHolder);
    const dAsHolder = await viem.getContractAt("D", dAddress, {
      client: { public: publicClient, wallet: dHolderWallet },
    });
    const holderDBalance = await dAsHolder.read.balanceOf([dHolder]);
    assert.ok(
      holderDBalance >= FAST_PASS_STAKE,
      `configured fork D holder has ${holderDBalance}; set DAO_V2_FORK_D_HOLDER to a current >=70 D holder`,
    );

    const mainnetDeployer = getAddress(eth.deployer);
    await networkHelpers.impersonateAccount(mainnetDeployer);
    await networkHelpers.setBalance(mainnetDeployer, parseEther("10"));
    const mainnetDeployerWallet = await viem.getWalletClient(mainnetDeployer);
    const dcAsMinter = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: mainnetDeployerWallet },
    });
    await waitFor(
      publicClient,
      await dcAsMinter.write.mint([dHolder, before.majorProposalFee * 10n]),
    );

    const dcAsHolder = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: dHolderWallet },
    });
    await waitFor(
      publicClient,
      await dcAsHolder.write.approve([governanceAddress, before.majorProposalFee * 10n]),
    );
    await waitFor(publicClient, await dAsHolder.write.approve([governanceAddress, maxUint256]));

    // Rehearse the required pre-upgrade treasury handoff on the fork only.
    const treasuryAsBootstrap = await viem.getContractAt("ProtocolTreasury", treasuryAddress, {
      client: { public: publicClient, wallet: mainnetDeployerWallet },
    });
    assert.equal(
      getAddress(await treasuryAsBootstrap.read.bootstrapAdmin()),
      mainnetDeployer,
      "unexpected mainnet treasury bootstrap admin",
    );
    if (getAddress(await treasuryAsBootstrap.read.controller()) !== governanceAddress) {
      await waitFor(
        publicClient,
        await treasuryAsBootstrap.write.bootstrapSetController([governanceAddress]),
      );
    }
    if (!(await treasuryAsBootstrap.read.bootstrapLocked())) {
      await waitFor(publicClient, await treasuryAsBootstrap.write.lockBootstrap());
    }
    await waitFor(
      publicClient,
      await localDeployer.sendTransaction({ to: treasuryAddress, value: parseEther("1") }),
    );

    const nonce = await publicClient.getTransactionCount({ address: localDeployer.account.address });
    const predictedRegistry = getContractAddress({
      from: localDeployer.account.address,
      nonce: BigInt(nonce),
    });
    const policyRules = buildDaoV2PolicyRules({
      governance: governanceAddress,
      policyRegistry: predictedRegistry,
      dealFactory: factoryAddress,
      crossChainBroadcaster: broadcasterAddress,
      protocolTreasury: treasuryAddress,
      bscDealFactory: bscFactoryAddress,
    });
    const deployClient = { public: publicClient, wallet: localDeployer } as const;
    const registry = await viem.deployContract(
      "GovernancePolicyRegistry",
      [governanceAddress, toRegistryRuleInputs(policyRules)],
      { client: deployClient },
    );
    assert.equal(getAddress(registry.address), predictedRegistry);
    const newImplementation = await viem.deployContract("DealGovernance", [], {
      client: deployClient,
    });

    const governance = await viem.getContractAt("DealGovernance", governanceAddress, {
      client: { public: publicClient, wallet: dHolderWallet },
    });
    const setRegistryData = encodeFunctionData({
      abi: governance.abi,
      functionName: "setPolicyRegistry",
      args: [registry.address],
    });
    const upgradeData = encodeFunctionData({
      abi: governance.abi,
      functionName: "upgradeToAndCall",
      args: [newImplementation.address, setRegistryData],
    });
    await waitFor(
      publicClient,
      await governance.write.createProposal([
        [governanceAddress],
        [0n],
        [upgradeData],
        "Fork rehearsal: atomic DealGovernance V2 upgrade",
        DAO_V2_PROPOSAL_KIND.Major,
      ]),
    );
    const upgradeProposalId = await governance.read.proposalCount();
    assert.equal(upgradeProposalId, before.proposalCount + 1n);
    await waitFor(publicClient, await governance.write.stake([upgradeProposalId, FAST_PASS_STAKE]));
    assert.equal(await governance.read.state([upgradeProposalId]), 3);
    await waitFor(publicClient, await governance.write.execute([upgradeProposalId]));

    const newSlot = await publicClient.getStorageAt({
      address: governanceAddress,
      slot: IMPLEMENTATION_SLOT,
    });
    assert.equal(slotAddress(newSlot), getAddress(newImplementation.address));
    assert.equal(getAddress(await governance.read.policyRegistry()), getAddress(registry.address));
    assert.equal(await governance.read.executedProposalCount(), before.executedProposalCount + 1n);
    assert.equal(await governance.read.proposalCount(), before.proposalCount + 1n);
    for (const [key, expected] of Object.entries(before)) {
      if (key === "proposalCount" || key === "executedProposalCount") continue;
      assert.deepEqual(await (governance.read as any)[key](), expected, `${key} changed across upgrade`);
    }
    assert.deepEqual(await governance.read.getProposal([5n]), historicalProposal);
    assert.deepEqual(await governance.read.getActions([5n]), historicalActions);

    for (const expected of policyRules) {
      const actual = await registry.read.getRule([
        expected.kind,
        expected.target,
        expected.selector,
      ]);
      assert.equal(actual.allowed, true, expected.label);
      assert.equal(actual.validateNestedBroadcast, expected.validateNestedBroadcast, expected.label);
      assert.equal(actual.nestedOnly, expected.nestedOnly, expected.label);
      assert.equal(actual.maxValue, expected.maxValue, expected.label);
    }
    await waitFor(publicClient, await governance.write.claimBack([upgradeProposalId]));

    const create = async (
      kind: number,
      target: Address,
      data: Hex,
      value = 0n,
      description = "DAO V2 mainnet fork policy exercise",
    ) => {
      await waitFor(
        publicClient,
        await governance.write.createProposal([[target], [value], [data], description, kind]),
      );
      return governance.read.proposalCount();
    };
    const reject = async (kind: number, target: Address, data: Hex, value = 0n) => {
      await assert.rejects(
        governance.write.createProposal([[target], [value], [data], "must reject", kind]),
        /ActionNotAllowed/,
      );
    };

    // Execute a real ETH Factory parameter proposal through the production rule set.
    const factory = await viem.getContractAt("DealFactory", factoryAddress);
    const oldMinWindow = await factory.read.minWindowSec();
    const nextMinWindow = oldMinWindow + 1;
    const parameterData = encodeFunctionData({
      abi: factory.abi,
      functionName: "setMinWindowSec",
      args: [nextMinWindow],
    });
    const parameterId = await create(
      DAO_V2_PROPOSAL_KIND.Parameter,
      factoryAddress,
      parameterData,
    );
    await waitFor(publicClient, await governance.write.stake([parameterId, FAST_PASS_STAKE]));
    await waitFor(publicClient, await governance.write.execute([parameterId]));
    assert.equal(await factory.read.minWindowSec(), nextMinWindow);
    await waitFor(publicClient, await governance.write.claimBack([parameterId]));

    // Execute a real ProtocolTreasury payout after the fork-only controller handoff.
    const recipientBefore = await publicClient.getBalance({ address: recipient.account.address });
    const payout = parseEther("0.1");
    const treasuryData = encodeFunctionData({
      abi: treasuryAsBootstrap.abi,
      functionName: "payNative",
      args: [recipient.account.address, payout],
    });
    const treasuryId = await create(
      DAO_V2_PROPOSAL_KIND.Treasury,
      treasuryAddress,
      treasuryData,
    );
    await waitFor(publicClient, await governance.write.stake([treasuryId, FAST_PASS_STAKE]));
    await waitFor(publicClient, await governance.write.execute([treasuryId]));
    assert.equal(
      await publicClient.getBalance({ address: recipient.account.address }),
      recipientBefore + payout,
    );
    await waitFor(publicClient, await governance.write.claimBack([treasuryId]));

    // Validate the actual broadcaster rule, every nested BSC target/selector, and the value cap.
    const broadcaster = await viem.getContractAt("CrossChainBroadcaster", broadcasterAddress);
    const bscParameterData = encodeFunctionData({
      abi: parseAbi(["function setMinWindowSec(uint32)"]),
      functionName: "setMinWindowSec",
      args: [nextMinWindow],
    });
    await reject(
      DAO_V2_PROPOSAL_KIND.Parameter,
      bscFactoryAddress,
      bscParameterData,
    );
    const quote = await broadcaster.read.quoteFees([
      [crossChain.params.bscChainKey],
      [bscFactoryAddress],
      bscParameterData,
      300_000n,
    ]);
    assert.ok(quote > 0n && quote <= DEFAULT_BROADCAST_MAX_VALUE);
    const goodBroadcast = encodeFunctionData({
      abi: broadcaster.abi,
      functionName: "broadcast",
      args: [[crossChain.params.bscChainKey], [bscFactoryAddress], bscParameterData, 300_000n],
    });
    const broadcastNonceBefore = await broadcaster.read.broadcastNonce();
    const broadcastId = await create(
      DAO_V2_PROPOSAL_KIND.Parameter,
      broadcasterAddress,
      goodBroadcast,
      quote,
    );
    await waitFor(publicClient, await governance.write.stake([broadcastId, FAST_PASS_STAKE]));
    await waitFor(
      publicClient,
      await governance.write.execute([broadcastId], { value: quote }),
    );
    assert.equal(await broadcaster.read.broadcastNonce(), broadcastNonceBefore + 1n);
    await waitFor(publicClient, await governance.write.claimBack([broadcastId]));

    const badNestedSelector = encodeFunctionData({
      abi: parseAbi(["function setAllowedCreateFor(address,bool)"]),
      functionName: "setAllowedCreateFor",
      args: [recipient.account.address, true],
    });
    const badSelectorBroadcast = encodeFunctionData({
      abi: broadcaster.abi,
      functionName: "broadcast",
      args: [[crossChain.params.bscChainKey], [bscFactoryAddress], badNestedSelector, 300_000n],
    });
    await reject(
      DAO_V2_PROPOSAL_KIND.Parameter,
      broadcasterAddress,
      badSelectorBroadcast,
      quote,
    );
    const badTargetBroadcast = encodeFunctionData({
      abi: broadcaster.abi,
      functionName: "broadcast",
      args: [
        [crossChain.params.bscChainKey],
        [recipient.account.address],
        bscParameterData,
        300_000n,
      ],
    });
    await reject(
      DAO_V2_PROPOSAL_KIND.Parameter,
      broadcasterAddress,
      badTargetBroadcast,
      quote,
    );
    await reject(
      DAO_V2_PROPOSAL_KIND.Parameter,
      broadcasterAddress,
      goodBroadcast,
      DEFAULT_BROADCAST_MAX_VALUE + 1n,
    );

    await reject(DAO_V2_PROPOSAL_KIND.Parameter, treasuryAddress, treasuryData);
    await reject(DAO_V2_PROPOSAL_KIND.Treasury, factoryAddress, parameterData);
    await reject(DAO_V2_PROPOSAL_KIND.Major, factoryAddress, parameterData);
    await reject(DAO_V2_PROPOSAL_KIND.Satoshi, treasuryAddress, treasuryData);

    // A policy update via Major must invalidate an older pending proposal at execution time.
    const staleParameterData = encodeFunctionData({
      abi: factory.abi,
      functionName: "setMinWindowSec",
      args: [nextMinWindow + 1],
    });
    const staleParameterId = await create(
      DAO_V2_PROPOSAL_KIND.Parameter,
      factoryAddress,
      staleParameterData,
    );
    const disableRule = {
      kind: DAO_V2_PROPOSAL_KIND.Parameter,
      target: factoryAddress,
      selector: toFunctionSelector("setMinWindowSec(uint32)"),
      allowed: false,
      validateNestedBroadcast: false,
      nestedOnly: false,
      maxValue: 0n,
    };
    const disableData = encodeFunctionData({
      abi: registry.abi,
      functionName: "setRule",
      args: [disableRule],
    });
    const policyUpdateId = await create(
      DAO_V2_PROPOSAL_KIND.Major,
      getAddress(registry.address),
      disableData,
    );
    await waitFor(publicClient, await governance.write.stake([policyUpdateId, FAST_PASS_STAKE]));
    await waitFor(publicClient, await governance.write.execute([policyUpdateId]));
    await waitFor(publicClient, await governance.write.claimBack([policyUpdateId]));
    assert.equal(
      (await registry.read.getRule([
        disableRule.kind,
        disableRule.target,
        disableRule.selector,
      ])).allowed,
      false,
    );
    await waitFor(publicClient, await governance.write.stake([staleParameterId, FAST_PASS_STAKE]));
    await assert.rejects(governance.write.execute([staleParameterId]), /ActionNotAllowed/);
    } catch (error) {
      console.error("DAO V2 fork rehearsal failure:", error);
      throw error;
    }
  });
});
