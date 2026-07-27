/**
 * Deploy the permissionless, read-only DealGovernanceReader on ETH mainnet.
 *
 * Default mode is read-only and prints the exact predicted address and gas estimate.
 * The only write path requires this exact gate:
 *
 * DEAL_GOVERNANCE_READER_DEPLOY=DEPLOY_READ_ONLY_ETH_GOVERNANCE_READER \
 *   node --import tsx/esm scripts/deploy-eth-governance-reader.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeDeployData,
  formatEther,
  getAddress,
  getContractAddress,
  http,
  keccak256,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import {
  collectProposalCreatedAtHistory,
  legacyGovernanceAbi,
  type ProposalCreatedAtEntry,
  verifyProposalCreatedAtHistorySnapshot,
} from "./lib/dao-created-at-history.js";

const CONFIRM = "DEPLOY_READ_ONLY_ETH_GOVERNANCE_READER";
const DEPLOYMENT_FILE = join(
  process.cwd(),
  "deployments",
  "eth-mainnet-1.json"
);
const ARTIFACT_FILE = join(
  process.cwd(),
  "artifacts",
  "contracts",
  "DealGovernanceReader.sol",
  "DealGovernanceReader.json"
);
const HISTORY_FILE = join(
  process.cwd(),
  "deployments",
  "dao-created-at",
  "eth-mainnet-proposal-created-at-20260727.json"
);
const PROPOSAL_FILE = join(
  process.cwd(),
  "deployments",
  "dao-created-at",
  "eth-mainnet-created-at-proposal.json"
);
const PROPOSAL_VERIFICATION_FILE = join(
  process.cwd(),
  "deployments",
  "dao-created-at",
  "eth-mainnet-created-at-proposal-verification.json"
);
const OUTPUT_FILE = join(
  process.cwd(),
  "deployments",
  "dao-created-at",
  "eth-mainnet-governance-reader-v2-20260727.json"
);

type Deployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
};

type Artifact = {
  abi: Abi;
  bytecode: Hex;
};

type HistoricalSnapshotFile = {
  entries: Array<{
    proposalId: string;
    createdAt: string;
    blockNumber: string;
    transactionHash: Hex;
  }>;
};

type CreatedAtProposalFile = {
  proposalId: string;
  proposer: Address;
  description: string;
};

type CreatedAtProposalVerificationFile = {
  proposal18Event: {
    createdAt: string;
    blockNumber: string;
    transactionHash: Hex;
  };
};

const governanceAbi = [
  {
    type: "function",
    stateMutability: "view",
    name: "proposalCount",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

function loadEnv() {
  for (const line of readFileSync(join(process.cwd(), ".env"), "utf8").split(
    /\r?\n/
  )) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] ||= match[2].trim();
  }
}

function sameAddress(a: Address, b: Address) {
  return a.toLowerCase() === b.toLowerCase();
}

async function loadVerifiedSnapshotFallback(
  publicClient: any,
  governance: Address
): Promise<ProposalCreatedAtEntry[]> {
  const historical = JSON.parse(
    readFileSync(HISTORY_FILE, "utf8")
  ) as HistoricalSnapshotFile;
  const proposal = JSON.parse(
    readFileSync(PROPOSAL_FILE, "utf8")
  ) as CreatedAtProposalFile;
  const verification = JSON.parse(
    readFileSync(PROPOSAL_VERIFICATION_FILE, "utf8")
  ) as CreatedAtProposalVerificationFile;

  const rawEntries = [
    ...historical.entries,
    {
      proposalId: BigInt(proposal.proposalId),
      createdAt: verification.proposal18Event.createdAt,
      blockNumber: verification.proposal18Event.blockNumber,
      transactionHash: verification.proposal18Event.transactionHash,
    },
  ];
  const entries: ProposalCreatedAtEntry[] = [];
  for (const entry of rawEntries) {
    const proposalView = await publicClient.readContract({
      address: governance,
      abi: legacyGovernanceAbi,
      functionName: "getProposal",
      args: [BigInt(entry.proposalId)],
    });
    entries.push({
      proposalId: BigInt(entry.proposalId),
      proposer: getAddress(proposalView.proposer),
      kind: Number(proposalView.kind),
      description: proposalView.description,
      createdAt: BigInt(entry.createdAt),
      blockNumber: BigInt(entry.blockNumber),
      transactionHash: entry.transactionHash,
    });
  }
  return entries;
}

async function main() {
  loadEnv();

  const deployment = JSON.parse(
    readFileSync(DEPLOYMENT_FILE, "utf8")
  ) as Deployment;
  const artifact = JSON.parse(readFileSync(ARTIFACT_FILE, "utf8")) as Artifact;
  if (deployment.chainId !== 1)
    throw new Error("Deployment file is not Ethereum mainnet");
  if (!artifact.bytecode || artifact.bytecode === "0x")
    throw new Error("Reader artifact has no bytecode");

  const rpc = process.env.ETH_MAINNET_RPC_URL?.trim();
  const rawKey =
    process.env.ETH_MAINNET_PRIVATE_KEY?.trim() ||
    process.env.AGIKING_PRIVATE_KEY?.trim();
  if (!rpc || !rawKey)
    throw new Error("Missing ETH mainnet RPC or private key");

  const account = privateKeyToAccount(
    (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex
  );
  const expectedDeployer = getAddress(deployment.deployer);
  if (!sameAddress(account.address, expectedDeployer)) {
    throw new Error(
      `Configured signer ${account.address} != recorded deployer ${expectedDeployer}`
    );
  }

  const governance = getAddress(deployment.addresses.dealGovernance);
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpc),
  });
  const walletClient = createWalletClient({
    account,
    chain: mainnet,
    transport: http(rpc),
  });

  const [
    chainId,
    blockNumber,
    latestNonce,
    pendingNonce,
    balance,
    governanceCode,
    proposalCount,
  ] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlockNumber(),
    publicClient.getTransactionCount({
      address: account.address,
      blockTag: "latest",
    }),
    publicClient.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    }),
    publicClient.getBalance({ address: account.address }),
    publicClient.getCode({ address: governance }),
    publicClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "proposalCount",
    }),
  ]);

  if (chainId !== 1) throw new Error(`Wrong chain ${chainId}`);
  if (latestNonce !== pendingNonce)
    throw new Error("Signer has pending transactions");
  if (!governanceCode || governanceCode === "0x")
    throw new Error("Governance proxy has no code");

  let historySource = "rpc-log-scan";
  let history;
  try {
    history = await collectProposalCreatedAtHistory({
      publicClient,
      governance,
    });
  } catch (error) {
    historySource = "verified-receipt-snapshot-fallback";
    console.warn(
      `Full ProposalCreated scan unavailable; verifying every stored receipt instead: ${String(
        error
      )}`
    );
    history = await verifyProposalCreatedAtHistorySnapshot({
      publicClient,
      governance,
      entries: await loadVerifiedSnapshotFallback(publicClient, governance),
    });
  }
  if (history.proposalCount !== proposalCount) {
    throw new Error("ProposalCreated history changed during Reader preflight");
  }
  const historicalProposalIds = history.entries.map(
    (entry) => entry.proposalId
  );
  const historicalCreatedAts = history.entries.map((entry) => {
    const createdAt = Number(entry.createdAt);
    if (
      !Number.isSafeInteger(createdAt) ||
      BigInt(createdAt) !== entry.createdAt
    ) {
      throw new Error(
        `Proposal ${entry.proposalId} createdAt is not a safe uint48`
      );
    }
    return createdAt;
  });
  const historyHash = keccak256(
    encodeAbiParameters(
      [{ type: "uint256[]" }, { type: "uint48[]" }],
      [historicalProposalIds, historicalCreatedAts]
    )
  );

  const predictedAddress = getContractAddress({
    from: account.address,
    nonce: BigInt(pendingNonce),
  });
  const predictedCode = await publicClient.getCode({
    address: predictedAddress,
  });
  if (predictedCode && predictedCode !== "0x") {
    throw new Error(`Predicted address already has code: ${predictedAddress}`);
  }

  const deployData = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [governance, historicalProposalIds, historicalCreatedAts],
  });
  const [gasEstimate, feeEstimate] = await Promise.all([
    publicClient.estimateGas({ account: account.address, data: deployData }),
    publicClient.estimateFeesPerGas(),
  ]);
  const maxDeploymentCost = gasEstimate * feeEstimate.maxFeePerGas;
  if (balance <= maxDeploymentCost)
    throw new Error("Insufficient ETH for Reader deployment");

  const preflight = {
    mode:
      process.env.DEAL_GOVERNANCE_READER_DEPLOY === CONFIRM
        ? "write"
        : "dry-run",
    checkedAt: new Date().toISOString(),
    chainId,
    blockNumber: blockNumber.toString(),
    deployer: account.address,
    nonce: pendingNonce,
    balanceWei: balance.toString(),
    governance,
    proposalCount: proposalCount.toString(),
    historySource,
    historicalCreatedAtCount: history.entries.length,
    historicalCreatedAtThroughProposalId:
      historicalProposalIds.at(-1)?.toString() ?? "0",
    historicalCreatedAtHash: historyHash,
    predictedAddress,
    creationBytecodeHash: keccak256(artifact.bytecode),
    gasEstimate: gasEstimate.toString(),
    maxFeePerGasWei: feeEstimate.maxFeePerGas.toString(),
    maxDeploymentCostWei: maxDeploymentCost.toString(),
    maxDeploymentCostEth: formatEther(maxDeploymentCost),
  };
  console.log(JSON.stringify(preflight, null, 2));

  if (process.env.DEAL_GOVERNANCE_READER_DEPLOY !== CONFIRM) {
    console.log("DRY-RUN ONLY: no transaction sent.");
    return;
  }

  const hash = await walletClient.deployContract({
    account,
    chain: mainnet,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [governance, historicalProposalIds, historicalCreatedAts],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success")
    throw new Error(`Reader deployment failed: ${hash}`);
  if (
    !receipt.contractAddress ||
    !sameAddress(receipt.contractAddress, predictedAddress)
  ) {
    throw new Error(
      `Unexpected deployed address: ${String(receipt.contractAddress)}`
    );
  }

  const reader = {
    address: receipt.contractAddress,
    abi: artifact.abi,
  } as const;
  const [
    runtimeCode,
    configuredGovernance,
    maxPageSize,
    maxStateBatchSize,
    stats,
    proposal13,
    latestHistoricalCreatedAt,
  ] = await Promise.all([
    publicClient.getCode({ address: receipt.contractAddress }),
    publicClient.readContract({ ...reader, functionName: "governance" }),
    publicClient.readContract({ ...reader, functionName: "MAX_PAGE_SIZE" }),
    publicClient.readContract({
      ...reader,
      functionName: "MAX_STATE_BATCH_SIZE",
    }),
    publicClient.readContract({
      ...reader,
      functionName: "getGovernanceStats",
    }),
    publicClient.readContract({
      ...reader,
      functionName: "getProposalDetail",
      args: [13n, "0x0000000000000000000000000000000000000000"],
    }),
    publicClient.readContract({
      ...reader,
      functionName: "historicalCreatedAt",
      args: [proposalCount],
    }),
  ]);

  if (!runtimeCode || runtimeCode === "0x")
    throw new Error("Reader runtime code is empty");
  if (!sameAddress(configuredGovernance as Address, governance)) {
    throw new Error("Reader governance immutable mismatch");
  }
  if (maxPageSize !== 50n || maxStateBatchSize !== 100n) {
    throw new Error("Reader limits mismatch");
  }
  const returnedProposalCount = (stats as { proposalCount: bigint })
    .proposalCount;
  const proposal13View = (
    proposal13 as readonly [{ proposalId: bigint }, ...unknown[]]
  )[0];
  if (
    returnedProposalCount !== proposalCount ||
    proposal13View.proposalId !== 13n
  ) {
    throw new Error("Reader live read verification failed");
  }
  if (
    BigInt(latestHistoricalCreatedAt as bigint) !==
    BigInt(historicalCreatedAts.at(-1) ?? 0)
  ) {
    throw new Error("Reader historical createdAt verification failed");
  }

  const result = {
    deployed: true,
    deployedAt: new Date().toISOString(),
    address: receipt.contractAddress,
    transactionHash: hash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    governance: configuredGovernance,
    maxPageSize: maxPageSize.toString(),
    maxStateBatchSize: maxStateBatchSize.toString(),
    proposalCount: String(returnedProposalCount),
    historySource,
    historicalCreatedAtCount: history.entries.length,
    historicalCreatedAtThroughProposalId:
      historicalProposalIds.at(-1)?.toString() ?? "0",
    historicalCreatedAtHash: historyHash,
    latestHistoricalCreatedAt: String(latestHistoricalCreatedAt),
    proposal13Id: String(proposal13View.proposalId),
    creationBytecodeHash: keccak256(artifact.bytecode),
    runtimeCodeHash: keccak256(runtimeCode),
  };
  writeFileSync(OUTPUT_FILE, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(JSON.stringify({ ...result, outputFile: OUTPUT_FILE }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
