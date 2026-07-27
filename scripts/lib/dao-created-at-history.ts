import {
  decodeEventLog,
  getAddress,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

export const DAO_PROPOSAL_LOG_START_BLOCK = 25_470_000n;
const MAX_LOG_BLOCK_RANGE = 1_900n;

export const proposalCreatedEvent = parseAbiItem(
  "event ProposalCreated(uint256 indexed proposalId,address indexed proposer,uint8 indexed kind,string description,uint48 createdAt)"
);

export const legacyGovernanceAbi = parseAbi([
  "function proposalCount() view returns (uint256)",
  "function getProposal(uint256 proposalId) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description) proposal)",
]);

export type ProposalCreatedAtEntry = {
  proposalId: bigint;
  proposer: Address;
  kind: number;
  description: string;
  createdAt: bigint;
  blockNumber: bigint;
  transactionHash: Hex;
};

export type ProposalCreatedAtHistory = {
  proposalCount: bigint;
  fromBlock: bigint;
  toBlock: bigint;
  entries: ProposalCreatedAtEntry[];
};

export async function verifyProposalCreatedAtHistorySnapshot(input: {
  publicClient: PublicClient;
  governance: Address;
  entries: ProposalCreatedAtEntry[];
}): Promise<ProposalCreatedAtHistory> {
  const governance = getAddress(input.governance);
  const [proposalCount, latestBlock] = await Promise.all([
    input.publicClient.readContract({
      address: governance,
      abi: legacyGovernanceAbi,
      functionName: "proposalCount",
    }),
    input.publicClient.getBlockNumber(),
  ]);
  if (input.entries.length !== Number(proposalCount)) {
    throw new Error(
      `ProposalCreated snapshot mismatch: proposalCount=${proposalCount}, entries=${input.entries.length}`
    );
  }

  let previousCreatedAt = 0n;
  for (let i = 0; i < input.entries.length; i += 1) {
    const entry = input.entries[i];
    const expectedProposalId = BigInt(i + 1);
    if (
      entry.proposalId !== expectedProposalId ||
      entry.createdAt === 0n ||
      entry.createdAt < previousCreatedAt
    ) {
      throw new Error(
        `Invalid ProposalCreated snapshot entry ${expectedProposalId}`
      );
    }

    const [receipt, block, proposal] = await Promise.all([
      input.publicClient.getTransactionReceipt({
        hash: entry.transactionHash,
      }),
      input.publicClient.getBlock({ blockNumber: entry.blockNumber }),
      input.publicClient.readContract({
        address: governance,
        abi: legacyGovernanceAbi,
        functionName: "getProposal",
        args: [entry.proposalId],
      }),
    ]);
    if (
      receipt.status !== "success" ||
      receipt.blockNumber !== entry.blockNumber ||
      block.timestamp !== entry.createdAt
    ) {
      throw new Error(`Proposal ${entry.proposalId} receipt/block mismatch`);
    }

    let matchedEvent = false;
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== governance) continue;
      try {
        const decoded = decodeEventLog({
          abi: [proposalCreatedEvent],
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        const args = decoded.args as {
          proposalId: bigint;
          proposer: Address;
          kind: number;
          description: string;
          createdAt: bigint;
        };
        if (
          decoded.eventName === "ProposalCreated" &&
          args.proposalId === entry.proposalId &&
          getAddress(args.proposer) === getAddress(entry.proposer) &&
          Number(args.kind) === entry.kind &&
          args.description === entry.description &&
          BigInt(args.createdAt) === entry.createdAt
        ) {
          matchedEvent = true;
          break;
        }
      } catch {}
    }
    if (!matchedEvent) {
      throw new Error(`Proposal ${entry.proposalId} event/receipt mismatch`);
    }
    if (
      getAddress(proposal.proposer) !== getAddress(entry.proposer) ||
      Number(proposal.kind) !== entry.kind ||
      proposal.description !== entry.description
    ) {
      throw new Error(`Proposal ${entry.proposalId} snapshot/storage mismatch`);
    }
    previousCreatedAt = entry.createdAt;
  }

  return {
    proposalCount,
    fromBlock: input.entries[0]?.blockNumber ?? latestBlock,
    toBlock: latestBlock,
    entries: input.entries,
  };
}

export async function collectProposalCreatedAtHistory(input: {
  publicClient: PublicClient;
  governance: Address;
  fromBlock?: bigint;
  toBlock?: bigint;
}): Promise<ProposalCreatedAtHistory> {
  const governance = getAddress(input.governance);
  const fromBlock = input.fromBlock ?? DAO_PROPOSAL_LOG_START_BLOCK;
  const [proposalCount, latestBlock] = await Promise.all([
    input.publicClient.readContract({
      address: governance,
      abi: legacyGovernanceAbi,
      functionName: "proposalCount",
    }),
    input.publicClient.getBlockNumber(),
  ]);
  const toBlock = input.toBlock ?? latestBlock;
  if (toBlock < fromBlock)
    throw new Error("ProposalCreated log range is empty");

  const logs = [];
  for (
    let chunkFrom = fromBlock;
    chunkFrom <= toBlock;
    chunkFrom += MAX_LOG_BLOCK_RANGE
  ) {
    const chunkTo =
      chunkFrom + MAX_LOG_BLOCK_RANGE - 1n < toBlock
        ? chunkFrom + MAX_LOG_BLOCK_RANGE - 1n
        : toBlock;
    logs.push(
      ...(await input.publicClient.getLogs({
        address: governance,
        event: proposalCreatedEvent,
        fromBlock: chunkFrom,
        toBlock: chunkTo,
      }))
    );
  }
  logs.sort((a, b) =>
    Number((a.args.proposalId ?? 0n) - (b.args.proposalId ?? 0n))
  );

  if (logs.length !== Number(proposalCount)) {
    throw new Error(
      `ProposalCreated coverage mismatch: proposalCount=${proposalCount}, logs=${logs.length}`
    );
  }

  const blockTimestamps = new Map<bigint, bigint>();
  const entries: ProposalCreatedAtEntry[] = [];
  let previousCreatedAt = 0n;

  for (let i = 0; i < logs.length; i += 1) {
    const log = logs[i];
    const expectedProposalId = BigInt(i + 1);
    const proposalId = log.args.proposalId;
    const proposer = log.args.proposer;
    const kind = log.args.kind;
    const description = log.args.description;
    const rawCreatedAt = log.args.createdAt;
    if (
      proposalId !== expectedProposalId ||
      proposer === undefined ||
      kind === undefined ||
      description === undefined ||
      rawCreatedAt === undefined ||
      log.blockNumber === null ||
      log.transactionHash === null
    ) {
      throw new Error(
        `Malformed ProposalCreated event at expected id ${expectedProposalId}`
      );
    }

    let blockTimestamp = blockTimestamps.get(log.blockNumber);
    if (blockTimestamp === undefined) {
      blockTimestamp = (
        await input.publicClient.getBlock({ blockNumber: log.blockNumber })
      ).timestamp;
      blockTimestamps.set(log.blockNumber, blockTimestamp);
    }

    const createdAt = BigInt(rawCreatedAt);
    if (createdAt !== blockTimestamp) {
      throw new Error(
        `Proposal ${proposalId} createdAt ${createdAt} != block timestamp ${blockTimestamp}`
      );
    }
    if (createdAt < previousCreatedAt) {
      throw new Error(`Proposal ${proposalId} createdAt is not monotonic`);
    }

    const proposal = await input.publicClient.readContract({
      address: governance,
      abi: legacyGovernanceAbi,
      functionName: "getProposal",
      args: [proposalId],
    });
    if (
      getAddress(proposal.proposer) !== getAddress(proposer) ||
      Number(proposal.kind) !== Number(kind) ||
      proposal.description !== description
    ) {
      throw new Error(`Proposal ${proposalId} event/storage mismatch`);
    }

    entries.push({
      proposalId,
      proposer: getAddress(proposer),
      kind: Number(kind),
      description,
      createdAt,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
    });
    previousCreatedAt = createdAt;
  }

  return { proposalCount, fromBlock, toBlock, entries };
}
