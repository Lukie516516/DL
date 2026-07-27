/**
 * Read-only production preparation for the DAO Proposal.createdAt upgrade.
 *
 * This script has no wallet client and cannot send a transaction. It verifies every
 * ProposalCreated event against its block timestamp and current Proposal storage, then
 * prints the exact history and optional UUPS calldata.
 *
 * ETH_MAINNET_RPC_URL=<trusted archive RPC> \
 * DAO_CREATED_AT_IMPLEMENTATION=0x... \  # optional
 * node --import tsx/esm scripts/prepare-eth-dao-created-at-upgrade.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  type Address,
} from "viem";
import { mainnet } from "viem/chains";

import { collectProposalCreatedAtHistory } from "./lib/dao-created-at-history.js";

const DEPLOYMENT_FILE = join(process.cwd(), "deployments", "eth-mainnet-1.json");

const governanceAbi = parseAbi([
  "function policyRegistry() view returns (address)",
  "function backfillProposalCreatedAt(uint256 firstProposalId,uint48[] createdAts)",
  "function upgradeToAndCall(address newImplementation,bytes data) payable",
]);

type Deployment = {
  chainId: number;
  addresses: Record<string, Address>;
};

function loadEnv(): void {
  for (const line of readFileSync(join(process.cwd(), ".env"), "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] ||= match[2].trim();
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

async function main(): Promise<void> {
  loadEnv();
  const rpcUrl = process.env.ETH_MAINNET_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("ETH_MAINNET_RPC_URL is required");

  const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Deployment;
  if (deployment.chainId !== 1) throw new Error("Deployment file is not Ethereum mainnet");

  const governance = getAddress(deployment.addresses.dealGovernance);
  const publicClient = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
  const [chainId, history, policyRegistry] = await Promise.all([
    publicClient.getChainId(),
    collectProposalCreatedAtHistory({ publicClient, governance }),
    publicClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "policyRegistry",
    }),
  ]);
  if (chainId !== 1) throw new Error(`Wrong chain ${chainId}`);

  const createdAts = history.entries.map((entry) => {
    const createdAt = Number(entry.createdAt);
    if (!Number.isSafeInteger(createdAt) || BigInt(createdAt) !== entry.createdAt) {
      throw new Error(`Proposal ${entry.proposalId} createdAt is not a safe uint48`);
    }
    return createdAt;
  });
  const backfillCalldata = encodeFunctionData({
    abi: governanceAbi,
    functionName: "backfillProposalCreatedAt",
    args: [1n, createdAts],
  });

  const rawImplementation = process.env.DAO_CREATED_AT_IMPLEMENTATION?.trim();
  const implementation = rawImplementation
    ? getAddress(rawImplementation)
    : undefined;
  const implementationCode = implementation
    ? await publicClient.getCode({ address: implementation })
    : undefined;
  if (implementation && (!implementationCode || implementationCode === "0x")) {
    throw new Error(`DAO_CREATED_AT_IMPLEMENTATION has no code: ${implementation}`);
  }

  const upgradeCalldata = implementation
    ? encodeFunctionData({
        abi: governanceAbi,
        functionName: "upgradeToAndCall",
        args: [implementation, backfillCalldata],
      })
    : undefined;

  console.log(JSON.stringify({
    mode: "read-only",
    checkedAt: new Date().toISOString(),
    chainId,
    governance,
    policyRegistry: getAddress(policyRegistry),
    proposalCount: history.proposalCount,
    scannedFromBlock: history.fromBlock,
    scannedToBlock: history.toBlock,
    allIdsContinuous: true,
    allEventTimestampsMatchBlocks: true,
    allEventsMatchProposalStorage: true,
    historicalProposalIds: history.entries.map((entry) => entry.proposalId),
    historicalCreatedAts: createdAts,
    entries: history.entries,
    backfillCalldata,
    implementation: implementation ?? null,
    upgradeCalldata: upgradeCalldata ?? null,
    note: "No transaction was signed or sent.",
  }, jsonReplacer, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
