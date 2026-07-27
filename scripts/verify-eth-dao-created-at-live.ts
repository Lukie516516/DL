import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  decodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { mainnet } from "viem/chains";

const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const deploymentFile = join(process.cwd(), "deployments", "eth-mainnet-1.json");
const implementationFile = join(
  process.cwd(),
  "deployments",
  "dao-created-at",
  "eth-mainnet-implementation-20260727.json"
);
const historyFile = join(
  process.cwd(),
  "deployments",
  "dao-created-at",
  "eth-mainnet-proposal-created-at-20260727.json"
);
const proposalVerificationFile = join(
  process.cwd(),
  "deployments",
  "dao-created-at",
  "eth-mainnet-created-at-proposal-verification.json"
);
const readerDeploymentFile = join(
  process.cwd(),
  "deployments",
  "dao-created-at",
  "eth-mainnet-governance-reader-v2-20260727.json"
);
const governanceArtifactFile = join(
  process.cwd(),
  "artifacts",
  "contracts",
  "DealGovernance.sol",
  "DealGovernance.json"
);
const readerArtifactFile = join(
  process.cwd(),
  "artifacts",
  "contracts",
  "DealGovernanceReader.sol",
  "DealGovernanceReader.json"
);
const outputFile = join(
  process.cwd(),
  "deployments",
  "dao-created-at",
  "eth-mainnet-created-at-execution-verification-20260727.json"
);

type Deployment = {
  chainId: number;
  addresses: Record<string, Address>;
};

type ImplementationDeployment = {
  implementation: Address;
};

type HistoryFile = {
  entries: Array<{
    proposalId: string;
    createdAt: string;
    blockNumber: string;
    transactionHash: Hex;
  }>;
};

type ProposalVerification = {
  proposal18Event: {
    createdAt: string;
    blockNumber: string;
    transactionHash: Hex;
  };
};

type ReaderDeployment = {
  address: Address;
  transactionHash: Hex;
  blockNumber: string;
  runtimeCodeHash: Hex;
};

type Artifact = {
  abi: Abi;
};

function loadEnv() {
  for (const line of readFileSync(join(process.cwd(), ".env"), "utf8").split(
    /\r?\n/
  )) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] ||= match[2].trim();
  }
}

function slotAddress(word: Hex | undefined): Address {
  if (!word || word.length !== 66)
    throw new Error("Implementation slot missing");
  return getAddress(`0x${word.slice(-40)}`);
}

async function getProposal18ExecutedLogs(
  publicClient: ReturnType<typeof createPublicClient>,
  governance: Address,
  fromBlock: bigint,
  toBlock: bigint
) {
  const event = parseAbiItem(
    "event ProposalExecuted(uint256 indexed proposalId)"
  );
  const logs = [];
  for (let cursor = fromBlock; cursor <= toBlock; cursor += 10n) {
    const chunkEnd = cursor + 9n < toBlock ? cursor + 9n : toBlock;
    logs.push(
      ...(await publicClient.getLogs({
        address: governance,
        event,
        args: { proposalId: 18n },
        fromBlock: cursor,
        toBlock: chunkEnd,
      }))
    );
  }
  return logs;
}

async function main() {
  loadEnv();
  const rpc = process.env.ETH_MAINNET_RPC_URL?.trim();
  if (!rpc) throw new Error("ETH_MAINNET_RPC_URL is required");

  const deployment = JSON.parse(
    readFileSync(deploymentFile, "utf8")
  ) as Deployment;
  const implementation = JSON.parse(
    readFileSync(implementationFile, "utf8")
  ) as ImplementationDeployment;
  const history = JSON.parse(readFileSync(historyFile, "utf8")) as HistoryFile;
  const proposalVerification = JSON.parse(
    readFileSync(proposalVerificationFile, "utf8")
  ) as ProposalVerification;
  const readerDeployment = JSON.parse(
    readFileSync(readerDeploymentFile, "utf8")
  ) as ReaderDeployment;
  const governanceArtifact = JSON.parse(
    readFileSync(governanceArtifactFile, "utf8")
  ) as Artifact;
  const readerArtifact = JSON.parse(
    readFileSync(readerArtifactFile, "utf8")
  ) as Artifact;

  if (deployment.chainId !== 1) throw new Error("Wrong deployment chain");
  const governance = getAddress(deployment.addresses.dealGovernance);
  const expectedImplementation = getAddress(implementation.implementation);
  const reader = getAddress(readerDeployment.address);
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpc),
  });

  const expectedEntries = [
    ...history.entries.map((entry) => ({
      proposalId: BigInt(entry.proposalId),
      createdAt: BigInt(entry.createdAt),
    })),
    {
      proposalId: 18n,
      createdAt: BigInt(proposalVerification.proposal18Event.createdAt),
    },
  ];
  if (expectedEntries.length !== 18) {
    throw new Error(
      `Expected 18 proposal timestamps, got ${expectedEntries.length}`
    );
  }

  const [
    chainId,
    checkedBlock,
    implementationSlot,
    proposalCount,
    proposal18State,
    readerCode,
    configuredGovernance,
    readerReceipt,
    pageResult,
  ] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlockNumber(),
    publicClient.getStorageAt({
      address: governance,
      slot: IMPLEMENTATION_SLOT,
    }),
    publicClient.readContract({
      address: governance,
      abi: governanceArtifact.abi,
      functionName: "proposalCount",
    }) as Promise<bigint>,
    publicClient.readContract({
      address: governance,
      abi: governanceArtifact.abi,
      functionName: "state",
      args: [18n],
    }) as Promise<number>,
    publicClient.getCode({ address: reader }),
    publicClient.readContract({
      address: reader,
      abi: readerArtifact.abi,
      functionName: "governance",
    }) as Promise<Address>,
    publicClient.getTransactionReceipt({
      hash: readerDeployment.transactionHash,
    }),
    publicClient.readContract({
      address: reader,
      abi: readerArtifact.abi,
      functionName: "getProposalPage",
      args: [ZERO_ADDRESS, 0n, 18n, false],
    }) as Promise<
      readonly [readonly { proposalId: bigint; createdAt: number }[], bigint]
    >,
  ]);

  if (chainId !== 1) throw new Error(`Wrong live chain ${chainId}`);
  if (slotAddress(implementationSlot) !== expectedImplementation) {
    throw new Error("DAO implementation mismatch");
  }
  if (proposalCount !== 18n || proposal18State !== 6) {
    throw new Error("Proposal 18 is not the executed latest proposal");
  }
  if (!readerCode || readerCode === "0x")
    throw new Error("Reader code missing");
  if (keccak256(readerCode) !== readerDeployment.runtimeCodeHash) {
    throw new Error("Reader runtime code hash mismatch");
  }
  if (getAddress(configuredGovernance) !== governance) {
    throw new Error("Reader governance immutable mismatch");
  }
  if (
    readerReceipt.status !== "success" ||
    !readerReceipt.contractAddress ||
    getAddress(readerReceipt.contractAddress) !== reader
  ) {
    throw new Error("Reader deployment receipt mismatch");
  }
  if (readerReceipt.blockNumber.toString() !== readerDeployment.blockNumber) {
    throw new Error("Reader deployment block mismatch");
  }

  const [page, total] = pageResult;
  if (total !== 18n || page.length !== 18) {
    throw new Error("Reader did not return all 18 proposals");
  }

  const daoCreatedAtAbi = parseAbi([
    "function proposalCreatedAt(uint256 proposalId) view returns (uint48)",
  ]);
  const daoCreatedAts = await publicClient.multicall({
    allowFailure: false,
    contracts: expectedEntries.map((entry) => ({
      address: governance,
      abi: daoCreatedAtAbi,
      functionName: "proposalCreatedAt",
      args: [entry.proposalId],
    })),
  });

  for (const [index, expected] of expectedEntries.entries()) {
    const proposal = page[index];
    if (
      proposal.proposalId !== expected.proposalId ||
      BigInt(proposal.createdAt) !== expected.createdAt
    ) {
      throw new Error(
        `Reader createdAt mismatch for proposal ${expected.proposalId}`
      );
    }
    const expectedDaoCreatedAt =
      expected.proposalId === 18n ? 0n : expected.createdAt;
    if (BigInt(daoCreatedAts[index]) !== expectedDaoCreatedAt) {
      throw new Error(
        `DAO createdAt mismatch for proposal ${expected.proposalId}`
      );
    }
  }

  const executedLogs = await getProposal18ExecutedLogs(
    publicClient,
    governance,
    BigInt(proposalVerification.proposal18Event.blockNumber),
    checkedBlock
  );
  if (executedLogs.length !== 1) {
    throw new Error(
      `Expected one ProposalExecuted(18), got ${executedLogs.length}`
    );
  }
  const executionReceipt = await publicClient.getTransactionReceipt({
    hash: executedLogs[0].transactionHash,
  });
  const executionTransaction = await publicClient.getTransaction({
    hash: executedLogs[0].transactionHash,
  });
  const decodedExecution = decodeFunctionData({
    abi: governanceArtifact.abi,
    data: executionTransaction.input,
  });
  if (
    executionReceipt.status !== "success" ||
    getAddress(executionTransaction.to ?? ZERO_ADDRESS) !== governance ||
    decodedExecution.functionName !== "execute" ||
    BigInt((decodedExecution.args as readonly [bigint])[0]) !== 18n
  ) {
    throw new Error("Proposal 18 execution transaction mismatch");
  }

  const executionEvents = parseEventLogs({
    abi: governanceArtifact.abi,
    logs: executionReceipt.logs,
    strict: false,
  });
  const backfill = executionEvents.find(
    (event) =>
      event.eventName === "ProposalCreatedAtBackfilled" &&
      BigInt(event.args.firstProposalId as bigint) === 1n &&
      BigInt(event.args.lastProposalId as bigint) === 17n
  );
  const executed = executionEvents.find(
    (event) =>
      event.eventName === "ProposalExecuted" &&
      BigInt(event.args.proposalId as bigint) === 18n
  );
  if (!backfill || !executed) {
    throw new Error("Execution receipt is missing backfill or execute events");
  }

  const executionBlock = await publicClient.getBlock({
    blockNumber: executionReceipt.blockNumber,
  });
  const result = {
    verifiedAt: new Date().toISOString(),
    chainId,
    checkedBlock: checkedBlock.toString(),
    governance,
    implementation: expectedImplementation,
    proposal18: {
      state: proposal18State,
      executed: true,
      executionTransactionHash: executionReceipt.transactionHash,
      executionBlockNumber: executionReceipt.blockNumber.toString(),
      executionBlockTimestamp: executionBlock.timestamp.toString(),
      backfilledFirstProposalId: "1",
      backfilledLastProposalId: "17",
    },
    daoCreatedAt: {
      verifiedProposalIds: "1..18",
      storageBackfilledProposalIds: "1..17",
      proposal18StorageValue: "0",
    },
    reader: {
      address: reader,
      deploymentTransactionHash: readerDeployment.transactionHash,
      deploymentBlockNumber: readerDeployment.blockNumber,
      runtimeCodeHash: keccak256(readerCode),
      governance: configuredGovernance,
      verifiedProposalIds: "1..18",
      proposal18FallbackCreatedAt:
        proposalVerification.proposal18Event.createdAt,
    },
  };
  writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(JSON.stringify({ ...result, outputFile }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
