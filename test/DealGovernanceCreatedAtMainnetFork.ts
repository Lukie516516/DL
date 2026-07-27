import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeFunctionData,
  getAddress,
  maxUint256,
  parseAbi,
  parseEventLogs,
  parseEther,
  type Address,
  type Hex,
} from "viem";

import { legacyGovernanceAbi } from "../scripts/lib/dao-created-at-history.js";
import { ensureForkSpendableD } from "./helpers/mainnetForkGovernance.js";

const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const UNIT = 10n ** 18n;
const FAST_PASS_STAKE = 70n * UNIT;
const DEFAULT_D_HOLDER = getAddress("0x14800e9a1a8b39fb84aa7fa4e6d7beb553cbf0fd");
const runFork = process.env.DAO_CREATED_AT_MAINNET_FORK === "1";
const forkDescribe = runFork ? describe : describe.skip;

const legacyReaderAbi = parseAbi([
  "function getProposalPage(address account,uint256 offset,uint256 limit,bool newestFirst) view returns ((uint256 proposalId,address proposer,uint8 kind,uint8 currentState,uint256 totalStaked,uint256 totalVetoStaked,uint256 accountStake,uint256 accountVetoStake,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description)[] page,uint256 total)",
]);

type Deployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
};

type CreatedAtSnapshot = {
  chainId: number;
  governance: Address;
  policyRegistry: Address;
  proposalCount: string;
  entries: Array<{
    proposalId: string;
    createdAt: string;
    blockNumber: string;
    transactionHash: Hex;
  }>;
};

type ReaderDeployment = {
  reader: Address;
};

async function waitFor(publicClient: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `fork transaction failed: ${hash}`);
  return receipt;
}

function slotAddress(word: Hex | undefined): Address {
  assert.ok(word && word.length === 66, "implementation slot missing");
  return getAddress(`0x${word.slice(-40)}`);
}

async function snapshotProposals(
  governance: any,
  publicClient: any,
  proposalIds: bigint[],
) {
  const baseCalls = proposalIds.flatMap((proposalId) => [
    {
      address: governance.address,
      abi: legacyGovernanceAbi,
      functionName: "getProposal",
      args: [proposalId],
    },
    {
      address: governance.address,
      abi: governance.abi,
      functionName: "state",
      args: [proposalId],
    },
    {
      address: governance.address,
      abi: governance.abi,
      functionName: "getActions",
      args: [proposalId],
    },
    {
      address: governance.address,
      abi: governance.abi,
      functionName: "totalVetoStaked",
      args: [proposalId],
    },
    {
      address: governance.address,
      abi: governance.abi,
      functionName: "getStakerList",
      args: [proposalId],
    },
  ]);
  const baseResults = await publicClient.multicall({
    contracts: baseCalls,
    allowFailure: false,
  });

  const snapshots = proposalIds.map((proposalId, index) => {
    const offset = index * 5;
    return {
      proposalId,
      proposal: baseResults[offset],
      state: baseResults[offset + 1],
      actions: baseResults[offset + 2],
      totalVetoStaked: baseResults[offset + 3],
      stakers: baseResults[offset + 4] as readonly Address[],
      positions: [] as Array<{ staker: Address; support: bigint; veto: bigint }>,
    };
  });

  const positionCalls = snapshots.flatMap((snapshot) =>
    snapshot.stakers.flatMap((staker) => [
      {
        address: governance.address,
        abi: governance.abi,
        functionName: "stakeOf",
        args: [snapshot.proposalId, staker],
      },
      {
        address: governance.address,
        abi: governance.abi,
        functionName: "vetoStakeOf",
        args: [snapshot.proposalId, staker],
      },
    ]),
  );
  if (positionCalls.length > 0) {
    const positionResults = await publicClient.multicall({
      contracts: positionCalls,
      allowFailure: false,
    });
    let resultIndex = 0;
    for (const snapshot of snapshots) {
      snapshot.positions = snapshot.stakers.map((staker) => {
        const support = positionResults[resultIndex] as bigint;
        const veto = positionResults[resultIndex + 1] as bigint;
        resultIndex += 2;
        return { staker: getAddress(staker), support, veto };
      });
    }
  }

  return snapshots;
}

forkDescribe("DealGovernance Proposal.createdAt ETH mainnet fork", function () {
  it("atomically upgrades, backfills 17 proposals and serves every timestamp in one Reader call", async function () {
    const deployment = JSON.parse(
      readFileSync("deployments/eth-mainnet-1.json", "utf8"),
    ) as Deployment;
    const history = JSON.parse(
      readFileSync(
        "deployments/dao-created-at/eth-mainnet-proposal-created-at-20260727.json",
        "utf8",
      ),
    ) as CreatedAtSnapshot;
    const readerDeployment = JSON.parse(
      readFileSync("deployments/eth-mainnet-governance-reader-20260723.json", "utf8"),
    ) as ReaderDeployment;

    assert.equal(deployment.chainId, 1);
    assert.equal(history.chainId, 1);
    const governanceAddress = getAddress(deployment.addresses.dealGovernance);
    const currentImplementation = getAddress(deployment.addresses.dealGovernanceImpl);
    const policyRegistry = getAddress(deployment.addresses.governancePolicyRegistry);
    const treasuryAddress = getAddress(deployment.addresses.protocolTreasury);
    const dAddress = getAddress(deployment.addresses.dToken);
    const dcAddress = getAddress(deployment.addresses.dlToken);
    assert.equal(getAddress(history.governance), governanceAddress);
    assert.equal(getAddress(history.policyRegistry), policyRegistry);

    const { viem, networkHelpers } = await network.connect({
      network: "hardhatEthFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    assert.equal(await publicClient.getChainId(), 1);
    console.log("createdAt fork: connected");
    const [localDeployer] = await viem.getWalletClients();
    assert.ok(localDeployer, "fork development wallet missing");

    const oldSlot = await publicClient.getStorageAt({
      address: governanceAddress,
      slot: IMPLEMENTATION_SLOT,
    });
    assert.equal(slotAddress(oldSlot), currentImplementation);

    const governance = await viem.getContractAt("DealGovernance", governanceAddress);
    const liveProposalCount = await governance.read.proposalCount();
    assert.equal(liveProposalCount, BigInt(history.proposalCount));
    assert.equal(history.entries.length, Number(liveProposalCount));

    const dHolder = process.env.DAO_V2_FORK_D_HOLDER
      ? getAddress(process.env.DAO_V2_FORK_D_HOLDER)
      : DEFAULT_D_HOLDER;
    await networkHelpers.impersonateAccount(dHolder);
    await networkHelpers.setBalance(dHolder, parseEther("10"));
    const dHolderWallet = await viem.getWalletClient(dHolder);
    const d = await viem.getContractAt("D", dAddress, {
      client: { public: publicClient, wallet: dHolderWallet },
    });
    const governanceAsHolder = await viem.getContractAt(
      "DealGovernance",
      governanceAddress,
      { client: { public: publicClient, wallet: dHolderWallet } },
    );
    await ensureForkSpendableD({
      publicClient,
      governance: governanceAsHolder,
      dToken: d,
      holder: dHolder,
      required: FAST_PASS_STAKE,
    });
    console.log("createdAt fork: D is spendable");
    await waitFor(
      publicClient,
      await d.write.approve([governanceAddress, maxUint256]),
    );

    const mainnetDeployer = getAddress(deployment.deployer);
    await networkHelpers.impersonateAccount(mainnetDeployer);
    await networkHelpers.setBalance(mainnetDeployer, parseEther("10"));
    const mainnetDeployerWallet = await viem.getWalletClient(mainnetDeployer);
    const dcAsMinter = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: mainnetDeployerWallet },
    });
    const majorFee = await governance.read.majorProposalFee();
    await waitFor(
      publicClient,
      await dcAsMinter.write.mint([dHolder, majorFee * 3n]),
    );
    const dcAsHolder = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: dHolderWallet },
    });
    await waitFor(
      publicClient,
      await dcAsHolder.write.approve([governanceAddress, majorFee * 3n]),
    );

    const beforeGlobals = {
      dToken: await governance.read.dToken(),
      nftVetoRegistry: await governance.read.nftVetoRegistry(),
      dcToken: await governance.read.dcToken(),
      treasury: await governance.read.treasury(),
      policyRegistry: await governance.read.policyRegistry(),
      activationThreshold: await governance.read.activationThreshold(),
      treasuryPassThreshold: await governance.read.treasuryPassThreshold(),
      satoshiPassThreshold: await governance.read.satoshiPassThreshold(),
      paramWindowSeconds: await governance.read.paramWindowSeconds(),
      majorWindowSeconds: await governance.read.majorWindowSeconds(),
      nftVetoThresholdBps: await governance.read.nftVetoThresholdBps(),
      majorProposalFee: await governance.read.majorProposalFee(),
      fastPassThreshold: await governance.read.fastPassThreshold(),
      activeProposalCount: await governance.read.activeProposalCount(),
      executedProposalCount: await governance.read.executedProposalCount(),
    };
    const historicalProposalIds = history.entries.map((entry) =>
      BigInt(entry.proposalId)
    );
    const beforeProposals = await snapshotProposals(
      governance,
      publicClient,
      historicalProposalIds,
    );
    console.log("createdAt fork: 17 proposal snapshots captured");
    const treasury = await viem.getContractAt("ProtocolTreasury", treasuryAddress);
    const treasuryBefore = {
      controller: await treasury.read.controller(),
      bootstrapLocked: await treasury.read.bootstrapLocked(),
    };

    const newImplementation = await viem.deployContract("DealGovernance", [], {
      client: { public: publicClient, wallet: localDeployer },
    });
    const historicalCreatedAts = history.entries.map((entry) =>
      BigInt(entry.createdAt)
    );
    const backfillData = encodeFunctionData({
      abi: governance.abi,
      functionName: "backfillProposalCreatedAt",
      args: [1n, historicalCreatedAts],
    });
    const upgradeData = encodeFunctionData({
      abi: governance.abi,
      functionName: "upgradeToAndCall",
      args: [newImplementation.address, backfillData],
    });
    const createReceipt = await waitFor(
      publicClient,
      await governanceAsHolder.write.createProposal([
        [governanceAddress],
        [0n],
        [upgradeData],
        "升级 DAO 提案创建时间读取",
        2,
      ]),
    );
    console.log("createdAt fork: upgrade proposal created");
    const upgradeProposalId = liveProposalCount + 1n;
    assert.equal(await governance.read.proposalCount(), upgradeProposalId);
    const proposalCreatedLogs = parseEventLogs({
      abi: governance.abi,
      eventName: "ProposalCreated",
      logs: createReceipt.logs,
    });
    assert.equal(proposalCreatedLogs.length, 1);
    assert.equal(proposalCreatedLogs[0].args.proposalId, upgradeProposalId);
    const upgradeProposalCreatedAt = BigInt(
      proposalCreatedLogs[0].args.createdAt,
    );
    const creationBlock = await publicClient.getBlock({
      blockNumber: createReceipt.blockNumber,
    });
    assert.equal(upgradeProposalCreatedAt, creationBlock.timestamp);

    const readerHistoryIds = [
      ...history.entries.map((entry) => BigInt(entry.proposalId)),
      upgradeProposalId,
    ];
    const readerHistoryCreatedAts = [
      ...historicalCreatedAts,
      upgradeProposalCreatedAt,
    ];
    const readerV2 = await viem.deployContract(
      "DealGovernanceReader",
      [governanceAddress, readerHistoryIds, readerHistoryCreatedAts],
      { client: { public: publicClient, wallet: localDeployer } },
    );
    console.log("createdAt fork: Reader V2 deployed");

    const [preUpgradePage, preUpgradeTotal] =
      await readerV2.read.getProposalPage([
        "0x0000000000000000000000000000000000000000",
        0n,
        upgradeProposalId,
        false,
      ]);
    assert.equal(preUpgradeTotal, upgradeProposalId);
    assert.deepEqual(
      preUpgradePage.map((proposal: any) => BigInt(proposal.createdAt)),
      readerHistoryCreatedAts,
    );

    await waitFor(
      publicClient,
      await governanceAsHolder.write.stake([upgradeProposalId, FAST_PASS_STAKE]),
    );
    assert.equal(await governance.read.state([upgradeProposalId]), 3);
    await waitFor(
      publicClient,
      await governanceAsHolder.write.execute([upgradeProposalId]),
    );
    console.log("createdAt fork: upgrade executed");

    const newSlot = await publicClient.getStorageAt({
      address: governanceAddress,
      slot: IMPLEMENTATION_SLOT,
    });
    assert.equal(slotAddress(newSlot), getAddress(newImplementation.address));

    for (const [key, expected] of Object.entries(beforeGlobals)) {
      if (key === "executedProposalCount") continue;
      assert.deepEqual(
        await (governance.read as any)[key](),
        expected,
        `${key} changed across createdAt upgrade`,
      );
    }
    assert.equal(
      await governance.read.executedProposalCount(),
      beforeGlobals.executedProposalCount + 1n,
    );
    assert.equal(await governance.read.proposalCount(), upgradeProposalId);
    assert.deepEqual(
      {
        controller: await treasury.read.controller(),
        bootstrapLocked: await treasury.read.bootstrapLocked(),
      },
      treasuryBefore,
    );

    const afterProposals = await snapshotProposals(
      governance,
      publicClient,
      historicalProposalIds,
    );
    console.log("createdAt fork: 17 post-upgrade snapshots captured");
    assert.deepEqual(afterProposals, beforeProposals);

    for (const entry of history.entries) {
      assert.equal(
        await governance.read.proposalCreatedAt([BigInt(entry.proposalId)]),
        Number(BigInt(entry.createdAt)),
      );
    }
    assert.equal(
      await governance.read.proposalCreatedAt([upgradeProposalId]),
      0,
    );
    assert.equal(
      await readerV2.read.historicalCreatedAt([upgradeProposalId]),
      Number(upgradeProposalCreatedAt),
    );

    const [postUpgradePage, postUpgradeTotal] =
      await readerV2.read.getProposalPage([
        "0x0000000000000000000000000000000000000000",
        0n,
        upgradeProposalId,
        false,
      ]);
    assert.equal(postUpgradeTotal, upgradeProposalId);
    assert.deepEqual(
      postUpgradePage.map((proposal: any) => BigInt(proposal.createdAt)),
      readerHistoryCreatedAts,
    );

    const [legacyPage, legacyTotal] = await publicClient.readContract({
      address: getAddress(readerDeployment.reader),
      abi: legacyReaderAbi,
      functionName: "getProposalPage",
      args: [
        "0x0000000000000000000000000000000000000000",
        0n,
        1n,
        true,
      ],
    });
    assert.equal(legacyTotal, upgradeProposalId);
    assert.equal(legacyPage[0].proposalId, upgradeProposalId);

    await networkHelpers.impersonateAccount(governanceAddress);
    await networkHelpers.setBalance(governanceAddress, parseEther("1"));
    const governanceSelfWallet = await viem.getWalletClient(governanceAddress);
    const governanceAsSelf = await viem.getContractAt(
      "DealGovernance",
      governanceAddress,
      { client: { public: publicClient, wallet: governanceSelfWallet } },
    );
    await assert.rejects(
      governanceAsSelf.write.backfillProposalCreatedAt([
        1n,
        historicalCreatedAts,
      ]),
    );

    await waitFor(
      publicClient,
      await governanceAsHolder.write.claimBack([upgradeProposalId]),
    );
    const postUpgradeCreateReceipt = await waitFor(
      publicClient,
      await governanceAsHolder.write.createProposal([
        [governanceAddress],
        [0n],
        [upgradeData],
        "Fork only: verify automatic createdAt",
        2,
      ]),
    );
    const postUpgradeProposalId = upgradeProposalId + 1n;
    const postUpgradeBlock = await publicClient.getBlock({
      blockNumber: postUpgradeCreateReceipt.blockNumber,
    });
    assert.equal(
      await governance.read.proposalCreatedAt([postUpgradeProposalId]),
      Number(postUpgradeBlock.timestamp),
    );
    const [postUpgradeProposal] = await readerV2.read.getProposalDetail([
      postUpgradeProposalId,
      "0x0000000000000000000000000000000000000000",
    ]);
    assert.equal(
      postUpgradeProposal.createdAt,
      Number(postUpgradeBlock.timestamp),
    );
  });
});
