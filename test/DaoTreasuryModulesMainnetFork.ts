import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeFunctionData,
  getAddress,
  maxUint256,
  parseEther,
  type Address,
  type Hex,
} from "viem";

import {
  buildDaoV2TreasuryModuleRules,
  DAO_V2_PROPOSAL_KIND,
} from "../scripts/dao-v2-policy.js";

const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const UNIT = 10n ** 18n;
const DEFAULT_D_HOLDER = getAddress("0x14800e9a1a8b39fb84aa7fa4e6d7beb553cbf0fd");
const runFork = process.env.DAO_TREASURY_MODULES_FORK === "1";
const forkDescribe = runFork ? describe : describe.skip;

type Deployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
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

forkDescribe("DAO treasury modules ETH mainnet fork", function () {
  it("adds four exact rules and exercises Satoshi, dividend and UUPS upgrade flows", async function () {
    const eth = JSON.parse(readFileSync("deployments/eth-mainnet-1.json", "utf8")) as Deployment;
    assert.equal(eth.chainId, 1);
    const governanceAddress = getAddress(eth.addresses.dealGovernance);
    const governanceImplementation = getAddress(eth.addresses.dealGovernanceImpl);
    const registryAddress = getAddress(eth.addresses.governancePolicyRegistry);
    const treasuryAddress = getAddress(eth.addresses.protocolTreasury);
    const dAddress = getAddress(eth.addresses.dToken);
    const dcAddress = getAddress(eth.addresses.dlToken);
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
    console.log(`DAO treasury modules fork block: ${forkBlock}`);
    const currentGovernanceSlot = await publicClient.getStorageAt({
      address: governanceAddress,
      slot: IMPLEMENTATION_SLOT,
    });
    assert.equal(slotAddress(currentGovernanceSlot), governanceImplementation);

    const [localDeployer, recipient] = await viem.getWalletClients();
    assert.ok(localDeployer && recipient, "fork development wallets missing");
    await networkHelpers.impersonateAccount(dHolder);
    await networkHelpers.setBalance(dHolder, parseEther("10"));
    const dHolderWallet = await viem.getWalletClient(dHolder);
    const d = await viem.getContractAt("D", dAddress, {
      client: { public: publicClient, wallet: dHolderWallet },
    });
    assert.ok((await d.read.balanceOf([dHolder])) >= 90n * UNIT);
    await waitFor(publicClient, await d.write.approve([governanceAddress, maxUint256]));

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
    assert.equal(getAddress(await governance.read.policyRegistry()), registryAddress);
    const majorFee = await governance.read.majorProposalFee();
    await waitFor(publicClient, await dcAsMinter.write.mint([dHolder, majorFee * 2n]));
    const dcAsHolder = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: dHolderWallet },
    });
    await waitFor(
      publicClient,
      await dcAsHolder.write.approve([governanceAddress, majorFee * 2n]),
    );

    const deployClient = { public: publicClient, wallet: localDeployer } as const;
    const satoshiImplementation = await viem.deployContract("SatoshiVault", [], {
      client: deployClient,
    });
    const satoshiInitData = encodeFunctionData({
      abi: satoshiImplementation.abi,
      functionName: "initialize",
      args: [dcAddress, governanceAddress],
    });
    const satoshiProxy = await viem.deployContract(
      "ERC1967Proxy",
      [satoshiImplementation.address, satoshiInitData],
      { client: deployClient },
    );
    const satoshiVault = await viem.getContractAt("SatoshiVault", satoshiProxy.address);

    const dividendImplementation = await viem.deployContract("DealDividendVault", [], {
      client: deployClient,
    });
    const dividendInitData = encodeFunctionData({
      abi: dividendImplementation.abi,
      functionName: "initialize",
      args: [dAddress, dcAddress, governanceAddress],
    });
    const dividendProxy = await viem.deployContract(
      "ERC1967Proxy",
      [dividendImplementation.address, dividendInitData],
      { client: deployClient },
    );
    const dividendVault = await viem.getContractAt("DealDividendVault", dividendProxy.address);

    assert.equal(getAddress(await satoshiVault.read.dealCoin()), dcAddress);
    assert.equal(getAddress(await satoshiVault.read.controller()), governanceAddress);
    assert.equal(getAddress(await dividendVault.read.dToken()), dAddress);
    assert.equal(getAddress(await dividendVault.read.dealCoin()), dcAddress);
    assert.equal(getAddress(await dividendVault.read.governance()), governanceAddress);

    const moduleRules = buildDaoV2TreasuryModuleRules(
      satoshiProxy.address,
      dividendProxy.address,
    );
    assert.equal(moduleRules.length, 4);
    const registry = await viem.getContractAt("GovernancePolicyRegistry", registryAddress);
    const setRulesData = encodeFunctionData({
      abi: registry.abi,
      functionName: "setRules",
      args: [moduleRules],
    });
    const create = async (
      kind: number,
      targets: Address[],
      calldatas: Hex[],
      description: string,
    ) => {
      await waitFor(
        publicClient,
        await governance.write.createProposal([
          targets,
          targets.map(() => 0n),
          calldatas,
          description,
          kind,
        ]),
      );
      return governance.read.proposalCount();
    };

    const policyProposalId = await create(
      DAO_V2_PROPOSAL_KIND.Major,
      [registryAddress],
      [setRulesData],
      "Fork: enable four DAO treasury module proxy rules",
    );
    await waitFor(publicClient, await governance.write.stake([policyProposalId, 70n * UNIT]));
    await waitFor(publicClient, await governance.write.execute([policyProposalId]));
    await waitFor(publicClient, await governance.write.claimBack([policyProposalId]));
    for (const expected of moduleRules) {
      const actual = await registry.read.getRule([
        expected.kind,
        expected.target,
        expected.selector,
      ]);
      assert.equal(actual.allowed, true);
      assert.equal(actual.validateNestedBroadcast, false);
      assert.equal(actual.nestedOnly, false);
      assert.equal(actual.maxValue, 0n);
    }

    const satoshiPayout = 10n * UNIT;
    await waitFor(
      publicClient,
      await dcAsMinter.write.mint([satoshiProxy.address, satoshiPayout]),
    );
    const recipientDcBefore = await dcAsMinter.read.balanceOf([recipient.account.address]);
    const payData = encodeFunctionData({
      abi: satoshiVault.abi,
      functionName: "payDC",
      args: [recipient.account.address, satoshiPayout],
    });
    const satoshiProposalId = await create(
      DAO_V2_PROPOSAL_KIND.Satoshi,
      [satoshiProxy.address],
      [payData],
      "Fork: small Satoshi DC payout",
    );
    await waitFor(publicClient, await governance.write.stake([satoshiProposalId, 90n * UNIT]));
    assert.equal(await governance.read.state([satoshiProposalId]), 3);
    await waitFor(publicClient, await governance.write.unstake([satoshiProposalId, 90n * UNIT]));
    assert.equal(await governance.read.state([satoshiProposalId]), 3);
    await waitFor(publicClient, await governance.write.execute([satoshiProposalId]));
    assert.equal(
      await dcAsMinter.read.balanceOf([recipient.account.address]),
      recipientDcBefore + satoshiPayout,
    );

    const roundTotal = 1_000n * UNIT;
    await waitFor(publicClient, await dcAsMinter.write.mint([treasuryAddress, roundTotal]));
    const treasury = await viem.getContractAt("ProtocolTreasury", treasuryAddress);
    const fundData = encodeFunctionData({
      abi: treasury.abi,
      functionName: "payToken",
      args: [dcAddress, dividendProxy.address, roundTotal],
    });
    const createRoundData = encodeFunctionData({
      abi: dividendVault.abi,
      functionName: "createRound",
      args: [roundTotal],
    });
    const dividendProposalId = await create(
      DAO_V2_PROPOSAL_KIND.Treasury,
      [treasuryAddress, dividendProxy.address],
      [fundData, createRoundData],
      "Fork: fund and create DC dividend round",
    );
    await waitFor(publicClient, await governance.write.stake([dividendProposalId, 70n * UNIT]));
    await waitFor(publicClient, await governance.write.execute([dividendProposalId]));
    await waitFor(publicClient, await governance.write.claimBack([dividendProposalId]));
    assert.equal(await dividendVault.read.roundsCount(), 1n);
    const holderPreview = await dividendVault.read.previewClaim([0n, dHolder]);
    assert.equal(holderPreview[0] + holderPreview[1], 975n * UNIT / 10n);
    assert.equal(holderPreview[2], 975n * UNIT);
    const dividendAsHolder = await viem.getContractAt("DealDividendVault", dividendProxy.address, {
      client: { public: publicClient, wallet: dHolderWallet },
    });
    await waitFor(publicClient, await dividendAsHolder.write.claim([0n]));
    assert.equal((await dividendVault.read.previewClaim([0n, dHolder]))[2], 0n);

    const nextSatoshi = await viem.deployContract("SatoshiVaultUpgradeMock", [], {
      client: deployClient,
    });
    const nextDividend = await viem.deployContract("DealDividendVaultUpgradeMock", [], {
      client: deployClient,
    });
    const upgradeSatoshiData = encodeFunctionData({
      abi: satoshiVault.abi,
      functionName: "upgradeToAndCall",
      args: [nextSatoshi.address, "0x"],
    });
    const upgradeDividendData = encodeFunctionData({
      abi: dividendVault.abi,
      functionName: "upgradeToAndCall",
      args: [nextDividend.address, "0x"],
    });
    const upgradeProposalId = await create(
      DAO_V2_PROPOSAL_KIND.Major,
      [satoshiProxy.address, dividendProxy.address],
      [upgradeSatoshiData, upgradeDividendData],
      "Fork: upgrade both DAO treasury module proxies",
    );
    await waitFor(publicClient, await governance.write.stake([upgradeProposalId, 70n * UNIT]));
    await waitFor(publicClient, await governance.write.execute([upgradeProposalId]));
    await waitFor(publicClient, await governance.write.claimBack([upgradeProposalId]));
    assert.equal(
      slotAddress(await publicClient.getStorageAt({ address: satoshiProxy.address, slot: IMPLEMENTATION_SLOT })),
      getAddress(nextSatoshi.address),
    );
    assert.equal(
      slotAddress(await publicClient.getStorageAt({ address: dividendProxy.address, slot: IMPLEMENTATION_SLOT })),
      getAddress(nextDividend.address),
    );
    const upgradedDividend = await viem.getContractAt(
      "DealDividendVaultUpgradeMock",
      dividendProxy.address,
    );
    assert.equal(await upgradedDividend.read.version(), 2n);
    assert.equal(await upgradedDividend.read.roundsCount(), 1n);
    assert.equal((await upgradedDividend.read.getRound([0n])).total, roundTotal);
  });
});
