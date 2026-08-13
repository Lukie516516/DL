/**
 * Read-only status monitor for one CrossChainBroadcasterV2 message.
 *
 * Existing canary:
 *   node --import tsx/esm scripts/monitor-cross-chain-v2-message.ts \
 *     --record deployments/ccip-v2-mainnet-stage4-canary-execution.json \
 *     --require-executed
 *
 * Generic message:
 *   node --import tsx/esm scripts/monitor-cross-chain-v2-message.ts \
 *     --message-hash 0x...
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  getAddress,
  http,
  isHex,
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";

import { executorAbi, messageHash } from "./lib/cross-chain-v2-feature.js";

type Stage1 = {
  bsc: { address: Address; verified: boolean };
};

type ExecutionRecord = {
  proposalId?: string;
  messageHash?: Hex;
  bsc?: {
    executor?: Address;
    target?: Address;
  };
};

function loadEnv() {
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) process.env[match[1].trim()] ||= match[2].trim();
    }
  } catch {}
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function loadJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), relativePath), "utf8")) as T;
}

function parseHash(value: string | undefined, label: string): Hex | undefined {
  if (value === undefined) return undefined;
  if (!isHex(value) || value.length !== 66) {
    throw new Error(`${label} must be bytes32`);
  }
  return value as Hex;
}

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

async function main() {
  loadEnv();
  const recordPath = argument("--record");
  const record = recordPath ? loadJson<ExecutionRecord>(recordPath) : undefined;
  const stage1 = loadJson<Stage1>("deployments/ccip-v2-mainnet-stage1.json");
  if (!stage1.bsc.verified) throw new Error("Verified CCIP V2 BSC deployment required");

  const explicitHash = parseHash(argument("--message-hash"), "--message-hash");
  const recordHash = parseHash(record?.messageHash, "record.messageHash");
  const nonceArg = argument("--nonce");
  const targetArg = argument("--target");
  const calldataArg = argument("--calldata");
  let derivedHash: Hex | undefined;
  if (nonceArg || targetArg || calldataArg) {
    if (!nonceArg || !targetArg || !calldataArg) {
      throw new Error("--nonce, --target and --calldata must be provided together");
    }
    if (!/^\d+$/.test(nonceArg)) throw new Error("--nonce must be unsigned");
    if (!isHex(calldataArg) || calldataArg.length < 10) {
      throw new Error("--calldata must contain a selector");
    }
    derivedHash = messageHash(
      BigInt(nonceArg),
      getAddress(targetArg),
      calldataArg as Hex,
    );
  }

  const hash = explicitHash ?? recordHash ?? derivedHash;
  if (!hash) {
    throw new Error(
      "Provide --record, --message-hash, or --nonce/--target/--calldata",
    );
  }
  for (const candidate of [explicitHash, recordHash, derivedHash]) {
    if (candidate && candidate.toLowerCase() !== hash.toLowerCase()) {
      throw new Error("Provided and derived message hashes disagree");
    }
  }

  const executor = getAddress(record?.bsc?.executor ?? stage1.bsc.address);
  const client = createPublicClient({
    chain: bsc,
    transport: http(
      process.env.BSC_MAINNET_RPC_URL?.trim() ||
        "https://bsc-rpc.publicnode.com",
    ),
  });
  const [chainId, blockNumber, code, threshold, status, attempts] =
    await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
      client.getCode({ address: executor }),
      client.readContract({
        address: executor,
        abi: executorAbi,
        functionName: "threshold",
      }),
      client.readContract({
        address: executor,
        abi: executorAbi,
        functionName: "confirmStatus",
        args: [hash],
      }),
      client.readContract({
        address: executor,
        abi: executorAbi,
        functionName: "executionAttempts",
        args: [hash],
      }),
    ]);
  if (chainId !== 56) throw new Error(`BSC RPC chain mismatch: ${chainId}`);
  if (!code || code === "0x") throw new Error("Executor has no runtime code");

  const output = {
    checkedAt: new Date().toISOString(),
    readOnly: true,
    transactionSent: false,
    proposalId: record?.proposalId,
    bscBlock: blockNumber,
    executor,
    target: record?.bsc?.target,
    messageHash: hash,
    threshold,
    confirmations: {
      layerZero: status[0],
      chainlinkCcip: status[1],
      axelar: status[2],
      count: status[3],
    },
    executed: status[4],
    executionAttempts: attempts,
    healthy:
      status[3] >= threshold &&
      status[4] &&
      attempts === 1n,
  };
  process.stdout.write(`${stringify(output)}\n`);

  if (process.argv.includes("--require-executed") && !output.healthy) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
