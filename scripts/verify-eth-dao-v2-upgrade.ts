/**
 * Read-only verification and optional local finalization for the ETH DAO V2 upgrade.
 *
 * Verify only:
 *   npm run dao:v2:verify
 *
 * Verify first, then update local deployment metadata and create a frontend handoff:
 *   DAO_V2_FINALIZE_LOCAL=1 npm run dao:v2:verify
 *
 * This script never creates or signs a transaction.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { network } from "hardhat";
import {
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { createPublicClient } from "viem";
import { bsc } from "viem/chains";

import {
  buildDaoV2PolicyRules,
  DEFAULT_BROADCAST_MAX_VALUE,
  type DaoV2PolicyRule,
} from "./dao-v2-policy.js";

const ETH_DEPLOYMENT_FILE = "deployments/eth-mainnet-1.json";
const BSC_DEPLOYMENT_FILE = "deployments/bsc-mainnet-56.json";
const CROSS_CHAIN_FILE = "deployments/mainnet-cross-chain.json";
const PREPARATION_FILE =
  "deployments/dao-v2-preparation/eth-mainnet-dao-v2-20260720-101952.json";
const UPGRADE_PROPOSAL_FILE =
  "deployments/dao-v2-preparation/eth-mainnet-dao-v2-20260720-103029.json";
const UPGRADE_TX =
  "0x7ce0d235e82c946f0974640acc6c41eb4aa23d2628a20e0f5e95f089e92ccb64" as Hex;
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

type Deployment = {
  chainId: number;
  deployedAt: string;
  updatedAt?: string;
  deployer: Address;
  addresses: Record<string, Address>;
  abi: Record<string, unknown[]>;
  params: Record<string, unknown>;
  notes?: string[];
  daoV2?: Record<string, unknown>;
};

type CrossChainDeployment = {
  eth: { chainId: number; broadcaster: Address };
  bsc: { chainId: number; executor: Address };
  params: {
    ethGovernance: Address;
    bscChainKey: number;
    bscDealFactory: Address;
  };
};

type Preparation = {
  registryAddress: Address;
  implementationAddress: Address;
  broadcastMaxValueWei: string;
};

type ProposalPreparation = { proposalId: string };

const governanceReadAbi = parseAbi([
  "function dToken() view returns (address)",
  "function dcToken() view returns (address)",
  "function treasury() view returns (address)",
  "function nftVetoRegistry() view returns (address)",
  "function policyRegistry() view returns (address)",
  "function activationThreshold() view returns (uint256)",
  "function treasuryPassThreshold() view returns (uint256)",
  "function satoshiPassThreshold() view returns (uint256)",
  "function paramWindowSeconds() view returns (uint256)",
  "function majorWindowSeconds() view returns (uint256)",
  "function nftVetoThresholdBps() view returns (uint256)",
  "function majorProposalFee() view returns (uint256)",
  "function fastPassThreshold() view returns (uint256)",
  "function proposalCount() view returns (uint256)",
  "function executedProposalCount() view returns (uint256)",
  "function state(uint256) view returns (uint8)",
  "function getProposal(uint256) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description))",
  "function getActions(uint256) view returns (address[] targets,uint256[] values,bytes[] calldatas)",
]);
const governanceUpgradeAbi = parseAbi([
  "function setPolicyRegistry(address)",
  "function upgradeToAndCall(address,bytes) payable",
]);
const registryReadAbi = parseAbi([
  "function governance() view returns (address)",
  "function getRule(uint8,address,bytes4) view returns ((bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue))",
]);
const treasuryReadAbi = parseAbi([
  "function controller() view returns (address)",
  "function bootstrapLocked() view returns (bool)",
]);
const factoryReadAbi = parseAbi([
  "function crossChainGovernance() view returns (address)",
  "function minWindowSec() view returns (uint32)",
]);
const broadcasterReadAbi = parseAbi([
  "function governance() view returns (address)",
  "function quoteFees(uint32[],address[],bytes,uint128) view returns (uint256)",
]);
const executorReadAbi = parseAbi(["function allowedTargets(address) view returns (bool)"]);
const uupsReadAbi = parseAbi(["function proxiableUUID() view returns (bytes32)"]);

function loadJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), relativePath), "utf8")) as T;
}

function sameAddress(actual: unknown, expected: Address): boolean {
  return String(actual).toLowerCase() === expected.toLowerCase();
}

function implementationFromSlot(word: Hex | undefined): Address {
  if (!word || word.length !== 66) throw new Error("Governance implementation slot is empty");
  return getAddress(`0x${word.slice(-40)}`);
}

function expectAddress(label: string, actual: unknown, expected: Address): void {
  if (!sameAddress(actual, expected)) throw new Error(`${label}: ${actual} != ${expected}`);
}

function expectBigInt(label: string, actual: bigint, expected: bigint): void {
  if (actual !== expected) throw new Error(`${label}: ${actual} != ${expected}`);
}

async function assertCode(publicClient: any, label: string, address: Address): Promise<void> {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") throw new Error(`${label} has no code at ${address}`);
}

async function assertRegistryRules(
  publicClient: any,
  registry: Address,
  rules: DaoV2PolicyRule[],
): Promise<void> {
  for (const expected of rules) {
    const actual = (await publicClient.readContract({
      address: registry,
      abi: registryReadAbi,
      functionName: "getRule",
      args: [expected.kind, expected.target, expected.selector],
    })) as any;
    const allowed = actual.allowed ?? actual[0];
    const validateNestedBroadcast = actual.validateNestedBroadcast ?? actual[1];
    const nestedOnly = actual.nestedOnly ?? actual[2];
    const maxValue = actual.maxValue ?? actual[3];
    if (
      !allowed ||
      validateNestedBroadcast !== expected.validateNestedBroadcast ||
      nestedOnly !== expected.nestedOnly ||
      maxValue !== expected.maxValue
    ) {
      throw new Error(`Registry rule mismatch: ${expected.label}`);
    }
  }
}

function appendUnique(notes: string[], value: string): void {
  if (!notes.includes(value)) notes.push(value);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function finalizeLocalDeployment(
  deployment: Deployment,
  implementation: Address,
  registry: Address,
  governance: Address,
  treasury: Address,
  proposalId: bigint,
  upgradeBlock: bigint,
): string {
  const now = new Date().toISOString();
  const stamp = timestamp();
  const deploymentPath = join(process.cwd(), ETH_DEPLOYMENT_FILE);
  const backupDir = join(process.cwd(), "deployments", "backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `eth-mainnet-1.before-dao-v2-finalize-${stamp}.json`);
  copyFileSync(deploymentPath, backupPath);

  const governanceArtifact = loadJson<{ abi: unknown[] }>(
    "artifacts/contracts/DealGovernance.sol/DealGovernance.json",
  );
  const registryArtifact = loadJson<{ abi: unknown[] }>(
    "artifacts/contracts/GovernancePolicyRegistry.sol/GovernancePolicyRegistry.json",
  );

  deployment.updatedAt = now;
  deployment.addresses.dealGovernanceImpl = implementation;
  deployment.addresses.governancePolicyRegistry = registry;
  deployment.abi.DealGovernance = governanceArtifact.abi;
  deployment.abi.GovernancePolicyRegistry = registryArtifact.abi;
  deployment.params.protocolTreasuryEnabled = true;
  deployment.params.protocolTreasury = treasury;
  deployment.params.protocolTreasuryController = governance;
  deployment.params.protocolTreasuryBootstrapLocked = true;
  deployment.daoV2 = {
    upgradedAt: now,
    governanceProxy: governance,
    implementation,
    policyRegistry: registry,
    proposalId: proposalId.toString(),
    upgradeTransaction: UPGRADE_TX,
    upgradeBlock: upgradeBlock.toString(),
    policyRuleCount: 48,
  };
  deployment.notes ??= [];
  appendUnique(
    deployment.notes,
    `[${now}] DealGovernance DAO V2 finalized locally: proxy=${governance} ` +
      `implementation=${implementation} policyRegistry=${registry} proposal=${proposalId} tx=${UPGRADE_TX}`,
  );
  writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`, "utf8");

  const handoffPath = join(
    process.cwd(),
    "deployments",
    `frontend-handoff-eth-dao-v2-${stamp}.md`,
  );
  const handoff = `# ETH DAO V2 前端交接\n\n` +
    `生成时间：${now}\n\n` +
    `## 地址\n\n` +
    `| 合约 | 地址 | 前端处理 |\n| --- | --- | --- |\n` +
    `| DealGovernance 代理 | \`${governance}\` | 地址不变，继续使用该地址 |\n` +
    `| DealGovernance V2 implementation | \`${implementation}\` | 只用于审计展示，不作为业务调用地址 |\n` +
    `| GovernancePolicyRegistry | \`${registry}\` | 可读取治理动作白名单 |\n` +
    `| ProtocolTreasury | \`${treasury}\` | DAO 控制的协议国库 |\n\n` +
    `## 升级结果\n\n` +
    `- 升级提案：\`${proposalId}\`，状态为 Executed。\n` +
    `- 升级交易：\`${UPGRADE_TX}\`，区块：\`${upgradeBlock}\`。\n` +
    `- 治理代理地址未变化，历史提案和质押数据保留。\n` +
    `- V2 新增 \`policyRegistry()\`，当前为 \`${registry}\`。\n` +
    `- 生产策略共 48 条；Satoshi 动作当前仍是 deny-all，等待 SatoshiVault 部署后再由重大提案精确开放。\n` +
    `- Satoshi 的“达到 90 D 后永久成功”仅作用于达到阈值的那一条提案，不影响其他提案。\n\n` +
    `## ABI\n\n` +
    `完整 ABI 已写入 \`deployments/eth-mainnet-1.json\`：\n\n` +
    `- \`abi.DealGovernance\`\n` +
    `- \`abi.GovernancePolicyRegistry\`\n`;
  writeFileSync(handoffPath, handoff, "utf8");
  console.log(`Local deployment finalized: ${deploymentPath}`);
  console.log(`Backup written: ${backupPath}`);
  console.log(`Frontend handoff written: ${handoffPath}`);
  return handoffPath;
}

async function main() {
  const ethDeployment = loadJson<Deployment>(ETH_DEPLOYMENT_FILE);
  const bscDeployment = loadJson<Deployment>(BSC_DEPLOYMENT_FILE);
  const crossChain = loadJson<CrossChainDeployment>(CROSS_CHAIN_FILE);
  const preparation = loadJson<Preparation>(PREPARATION_FILE);
  const proposalPreparation = loadJson<ProposalPreparation>(UPGRADE_PROPOSAL_FILE);
  if (ethDeployment.chainId !== 1 || bscDeployment.chainId !== 56) {
    throw new Error("Deployment file chain IDs do not match ETH=1 and BSC=56");
  }

  const governance = getAddress(ethDeployment.addresses.dealGovernance);
  const implementation = getAddress(preparation.implementationAddress);
  const registry = getAddress(preparation.registryAddress);
  const treasury = getAddress(ethDeployment.addresses.protocolTreasury);
  const dToken = getAddress(ethDeployment.addresses.dToken);
  const dcToken = getAddress(ethDeployment.addresses.dlToken);
  const nftVetoRegistry = getAddress(ethDeployment.addresses.nftVetoRegistry);
  const dealFactory = getAddress(ethDeployment.addresses.dealFactory);
  const broadcaster = getAddress(crossChain.eth.broadcaster);
  const bscDealFactory = getAddress(crossChain.params.bscDealFactory);
  const bscExecutor = getAddress(crossChain.bsc.executor);
  const proposalId = BigInt(proposalPreparation.proposalId);
  const broadcastMaxValue = BigInt(preparation.broadcastMaxValueWei);

  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  expectBigInt("ETH chainId", BigInt(await publicClient.getChainId()), 1n);
  for (const [label, address] of [
    ["DealGovernance proxy", governance],
    ["DealGovernance V2 implementation", implementation],
    ["GovernancePolicyRegistry", registry],
    ["ProtocolTreasury", treasury],
    ["CrossChainBroadcaster", broadcaster],
    ["ETH DealFactory", dealFactory],
  ] as const) {
    await assertCode(publicClient, label, address);
  }

  const slotWord = await publicClient.getStorageAt({ address: governance, slot: IMPLEMENTATION_SLOT });
  expectAddress("EIP-1967 implementation", implementationFromSlot(slotWord), implementation);
  const uuid = await publicClient.readContract({
    address: implementation,
    abi: uupsReadAbi,
    functionName: "proxiableUUID",
  });
  if (uuid.toLowerCase() !== IMPLEMENTATION_SLOT.toLowerCase()) {
    throw new Error(`Unexpected UUPS UUID: ${uuid}`);
  }

  const [
    chainD,
    chainDc,
    chainTreasury,
    chainNftVeto,
    chainRegistry,
    activationThreshold,
    treasuryThreshold,
    satoshiThreshold,
    paramWindow,
    majorWindow,
    nftVetoBps,
    majorFee,
    fastPassThreshold,
    proposalCount,
    executedProposalCount,
    proposalState,
    proposal,
    actions,
  ] = await Promise.all([
    publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "dToken" }),
    publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "dcToken" }),
    publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "treasury" }),
    publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "nftVetoRegistry" }),
    publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "policyRegistry" }),
    publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "activationThreshold" }),
    publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "treasuryPassThreshold" }),
    publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "satoshiPassThreshold" }),
    publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "paramWindowSeconds" }),
    publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "majorWindowSeconds" }),
    publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "nftVetoThresholdBps" }),
    publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "majorProposalFee" }),
    publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "fastPassThreshold" }),
    publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "proposalCount" }),
    publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "executedProposalCount" }),
    publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "state", args: [proposalId] }),
    publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "getProposal", args: [proposalId] }),
    publicClient.readContract({ address: governance, abi: governanceReadAbi, functionName: "getActions", args: [proposalId] }),
  ]);
  expectAddress("DealGovernance.dToken", chainD, dToken);
  expectAddress("DealGovernance.dcToken", chainDc, dcToken);
  expectAddress("DealGovernance.treasury", chainTreasury, treasury);
  expectAddress("DealGovernance.nftVetoRegistry", chainNftVeto, nftVetoRegistry);
  expectAddress("DealGovernance.policyRegistry", chainRegistry, registry);
  expectBigInt("activationThreshold", activationThreshold, parseEther("2.5"));
  expectBigInt("treasuryPassThreshold", treasuryThreshold, parseEther("70"));
  expectBigInt("satoshiPassThreshold", satoshiThreshold, parseEther("90"));
  expectBigInt("paramWindowSeconds", paramWindow, 24n * 60n * 60n);
  expectBigInt("majorWindowSeconds", majorWindow, 120n * 60n * 60n);
  expectBigInt("nftVetoThresholdBps", nftVetoBps, 1_000n);
  expectBigInt("majorProposalFee", majorFee, parseEther("1000"));
  expectBigInt("fastPassThreshold", fastPassThreshold, parseEther("70"));
  if (proposalCount < proposalId) throw new Error(`proposalCount ${proposalCount} < ${proposalId}`);
  if (executedProposalCount < 6n) throw new Error(`executedProposalCount ${executedProposalCount} < 6`);
  expectBigInt(`proposal ${proposalId} state`, BigInt(proposalState), 6n);
  const proposalData = proposal as any;
  if (!(proposalData.executed ?? proposalData[6])) throw new Error(`Proposal ${proposalId} is not executed`);
  expectBigInt(`proposal ${proposalId} kind`, BigInt(proposalData.kind ?? proposalData[1]), 2n);

  const setRegistryData = encodeFunctionData({
    abi: governanceUpgradeAbi,
    functionName: "setPolicyRegistry",
    args: [registry],
  });
  const expectedUpgradeData = encodeFunctionData({
    abi: governanceUpgradeAbi,
    functionName: "upgradeToAndCall",
    args: [implementation, setRegistryData],
  });
  const [targets, values, calldatas] = actions as readonly [readonly Address[], readonly bigint[], readonly Hex[]];
  if (targets.length !== 1 || values.length !== 1 || calldatas.length !== 1) {
    throw new Error(`Proposal ${proposalId} does not contain exactly one upgrade action`);
  }
  expectAddress(`proposal ${proposalId} target`, targets[0], governance);
  expectBigInt(`proposal ${proposalId} value`, values[0], 0n);
  if (calldatas[0].toLowerCase() !== expectedUpgradeData.toLowerCase()) {
    throw new Error(`Proposal ${proposalId} upgrade calldata mismatch`);
  }

  const registryGovernance = await publicClient.readContract({
    address: registry,
    abi: registryReadAbi,
    functionName: "governance",
  });
  expectAddress("GovernancePolicyRegistry.governance", registryGovernance, governance);
  const policyRules = buildDaoV2PolicyRules(
    {
      governance,
      policyRegistry: registry,
      dealFactory,
      crossChainBroadcaster: broadcaster,
      protocolTreasury: treasury,
      bscDealFactory,
    },
    { broadcastMaxValue },
  );
  if (policyRules.length !== 48) throw new Error(`Expected 48 policy rules, got ${policyRules.length}`);
  await assertRegistryRules(publicClient, registry, policyRules);

  const [treasuryController, treasuryLocked, factoryGovernance, broadcasterGovernance] =
    await Promise.all([
      publicClient.readContract({ address: treasury, abi: treasuryReadAbi, functionName: "controller" }),
      publicClient.readContract({ address: treasury, abi: treasuryReadAbi, functionName: "bootstrapLocked" }),
      publicClient.readContract({ address: dealFactory, abi: factoryReadAbi, functionName: "crossChainGovernance" }),
      publicClient.readContract({ address: broadcaster, abi: broadcasterReadAbi, functionName: "governance" }),
    ]);
  expectAddress("ProtocolTreasury.controller", treasuryController, governance);
  if (!treasuryLocked) throw new Error("ProtocolTreasury.bootstrapLocked is false");
  expectAddress("ETH DealFactory.crossChainGovernance", factoryGovernance, governance);
  expectAddress("CrossChainBroadcaster.governance", broadcasterGovernance, governance);

  const bscRpc = process.env.BSC_MAINNET_RPC_URL?.trim() || "https://bsc-dataseed.binance.org";
  const bscClient = createPublicClient({ chain: bsc, transport: http(bscRpc) });
  expectBigInt("BSC chainId", BigInt(await bscClient.getChainId()), 56n);
  await assertCode(bscClient, "BSC DealFactory", bscDealFactory);
  await assertCode(bscClient, "BSC DualBridgeExecutor", bscExecutor);
  const [bscFactoryGovernance, bscTargetAllowed] = await Promise.all([
    bscClient.readContract({ address: bscDealFactory, abi: factoryReadAbi, functionName: "crossChainGovernance" }),
    bscClient.readContract({ address: bscExecutor, abi: executorReadAbi, functionName: "allowedTargets", args: [bscDealFactory] }),
  ]);
  expectAddress("BSC DealFactory.crossChainGovernance", bscFactoryGovernance, bscExecutor);
  if (!bscTargetAllowed) throw new Error("BSC DealFactory is not an allowed executor target");

  const currentMinWindow = await publicClient.readContract({
    address: dealFactory,
    abi: factoryReadAbi,
    functionName: "minWindowSec",
  });
  const probeData = encodeFunctionData({
    abi: parseAbi(["function setMinWindowSec(uint32)"]),
    functionName: "setMinWindowSec",
    args: [currentMinWindow],
  });
  const quote = await publicClient.readContract({
    address: broadcaster,
    abi: broadcasterReadAbi,
    functionName: "quoteFees",
    args: [[crossChain.params.bscChainKey], [bscDealFactory], probeData, 300_000n],
  });
  if (quote > DEFAULT_BROADCAST_MAX_VALUE) {
    throw new Error(`Broadcast quote ${quote} exceeds policy cap ${DEFAULT_BROADCAST_MAX_VALUE}`);
  }

  const upgradeReceipt = await publicClient.getTransactionReceipt({ hash: UPGRADE_TX });
  if (upgradeReceipt.status !== "success") throw new Error(`Upgrade transaction failed: ${UPGRADE_TX}`);

  console.log("DAO V2 post-upgrade verification: PASS");
  console.log(`  Governance proxy: ${governance}`);
  console.log(`  Implementation: ${implementation}`);
  console.log(`  Policy registry: ${registry}`);
  console.log(`  Policy rules: ${policyRules.length}/48`);
  console.log(`  Upgrade proposal: ${proposalId} (Executed)`);
  console.log(`  Upgrade transaction: ${UPGRADE_TX}`);
  console.log(`  Upgrade block: ${upgradeReceipt.blockNumber}`);
  console.log(`  Treasury controller: ${treasuryController}; bootstrapLocked=true`);
  console.log(`  BSC executor target: allowed`);
  console.log(`  Current broadcast quote: ${formatEther(quote)} ETH`);
  console.log("  No transaction was sent.");

  if (process.env.DAO_V2_FINALIZE_LOCAL === "1") {
    finalizeLocalDeployment(
      ethDeployment,
      implementation,
      registry,
      governance,
      treasury,
      proposalId,
      upgradeReceipt.blockNumber,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
