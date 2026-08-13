/**
 * Fixes the Base DualBridgeExecutorV2 Axelar source-address casing and, when
 * the historical Axelar approval is still available, records its late third
 * confirmation. Read-only by default.
 *
 * Preflight:
 *   node --import tsx/esm scripts/fix-base-cross-chain-v2-axelar-source.ts preflight
 * Execute (explicit write gate):
 *   BASE_AXELAR_FIX_EXECUTE=1 node --import tsx/esm scripts/fix-base-cross-chain-v2-axelar-source.ts execute
 */
import { readFileSync } from "node:fs";

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  fallback,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const DEPLOYMENT_FILE = "deployments/base-mainnet-8453.json";
const FINAL_VERIFICATION_FILE = "deployments/base-cross-chain-v2-canary-final-verification.json";
const EXECUTION_FILE = "deployments/base-cross-chain-v2-canary-execution.json";
const SOURCE_CHAIN = "Ethereum";
const WRITE_GATE = "BASE_AXELAR_FIX_EXECUTE";

const executorAbi = parseAbi([
  "function owner() view returns (address)",
  "function axSrcChain() view returns (string)",
  "function axSrcAddress() view returns (string)",
  "function setAxSrc(string,string)",
  "function execute(bytes32,string,string,bytes)",
  "function confirmStatus(bytes32) view returns (bool,bool,bool,uint256,bool)",
  "function executionAttempts(bytes32) view returns (uint256)",
]);
const gatewayAbi = parseAbi([
  "function isContractCallApproved(bytes32,string,string,address,bytes32) view returns (bool)",
]);
const probeAbi = parseAbi([
  "function marker() view returns (bytes32)",
  "function updateCount() view returns (uint256)",
]);

type Deployment = {
  chainId: number;
  deployer: Address;
  crossChainV2: {
    executor: Address;
    governanceProbe: Address;
    ethBroadcaster: Address;
  };
};
type FinalVerification = {
  marker: Hex;
  base: {
    messageHash: Hex;
    axelar: { commandId: Hex };
  };
};
type Execution = {
  broadcast: {
    nonce: string;
    markerCalldata: Hex;
  };
};

function loadEnv() {
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match && !process.env[match[1].trim()]) {
        process.env[match[1].trim()] = match[2].trim();
      }
    }
  } catch {
    // Optional.
  }
}

function assertThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameAddress(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function privateKey(): Hex {
  const raw = process.env.BASE_MAINNET_PRIVATE_KEY || process.env.AGIKING_PRIVATE_KEY;
  if (!raw) throw new Error("Missing BASE_MAINNET_PRIVATE_KEY or AGIKING_PRIVATE_KEY");
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

async function eventually<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  label: string,
): Promise<T> {
  let last: T | undefined;
  for (let attempt = 0; attempt < 30; ++attempt) {
    last = await read();
    if (matches(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} was not visible after RPC consistency wait: ${String(last)}`);
}

async function main() {
  loadEnv();
  const mode = process.argv[2] || "preflight";
  assertThat(mode === "preflight" || mode === "execute", `Unsupported mode: ${mode}`);
  if (mode === "execute") {
    assertThat(process.env[WRITE_GATE] === "1", `Set ${WRITE_GATE}=1 for execution`);
  }

  const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Deployment;
  const finalVerification = JSON.parse(
    readFileSync(FINAL_VERIFICATION_FILE, "utf8"),
  ) as FinalVerification;
  const execution = JSON.parse(readFileSync(EXECUTION_FILE, "utf8")) as Execution;
  assertThat(deployment.chainId === 8453, "Deployment is not Base mainnet");

  const executor = getAddress(deployment.crossChainV2.executor);
  const probe = getAddress(deployment.crossChainV2.governanceProbe);
  const broadcaster = getAddress(deployment.crossChainV2.ethBroadcaster);
  const deployer = getAddress(deployment.deployer);
  const commandId = finalVerification.base.axelar.commandId;
  const expectedMessageHash = finalVerification.base.messageHash;
  const payload = encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
    [BigInt(execution.broadcast.nonce), probe, execution.broadcast.markerCalldata],
  );
  assertThat(keccak256(payload) === expectedMessageHash, "Reconstructed Axelar payload hash mismatch");

  const rpc = process.env.BASE_MAINNET_RPC_URL?.trim() || "https://base-rpc.publicnode.com";
  const publicClient: any = createPublicClient({
    chain: base,
    transport: fallback([
      http(rpc, { timeout: 30_000 }),
      http("https://mainnet.base.org", { timeout: 30_000 }),
    ], { rank: false }),
  });
  assertThat(await publicClient.getChainId() === 8453, "RPC is not Base mainnet");

  const [owner, sourceChain, sourceAddress, status, attempts, marker, updateCount] = await Promise.all([
    publicClient.readContract({ address: executor, abi: executorAbi, functionName: "owner" }),
    publicClient.readContract({ address: executor, abi: executorAbi, functionName: "axSrcChain" }),
    publicClient.readContract({ address: executor, abi: executorAbi, functionName: "axSrcAddress" }),
    publicClient.readContract({ address: executor, abi: executorAbi, functionName: "confirmStatus", args: [expectedMessageHash] }),
    publicClient.readContract({ address: executor, abi: executorAbi, functionName: "executionAttempts", args: [expectedMessageHash] }),
    publicClient.readContract({ address: probe, abi: probeAbi, functionName: "marker" }),
    publicClient.readContract({ address: probe, abi: probeAbi, functionName: "updateCount" }),
  ]);
  assertThat(sameAddress(owner, deployer), `Executor owner mismatch: ${owner}`);
  assertThat(sourceChain === SOURCE_CHAIN, `Unexpected Axelar source chain: ${sourceChain}`);
  assertThat(sourceAddress === broadcaster.toLowerCase() || sourceAddress === broadcaster,
    `Unexpected Axelar source address: ${sourceAddress}`);
  assertThat(status[0] && status[1] && status[3] >= 2n && status[4], "Base 2-of-3 canary state is not intact");
  assertThat(attempts === 1n, `Unexpected executionAttempts: ${attempts}`);
  assertThat(marker === finalVerification.marker && updateCount === 1n, "Probe invariant mismatch before fix");

  const gateway = getAddress("0xe432150cce91c13a887f7D836923d5597adD8E31");
  const approved = status[2] ? false : await publicClient.readContract({
    address: gateway,
    abi: gatewayAbi,
    functionName: "isContractCallApproved",
    args: [commandId, SOURCE_CHAIN, broadcaster, executor, expectedMessageHash],
  });
  const preflight = {
    status: "PASS",
    mode,
    executor,
    owner,
    sourceChain,
    sourceAddressBefore: sourceAddress,
    sourceAddressTarget: broadcaster,
    messageHash: expectedMessageHash,
    commandId,
    gatewayApproved: approved,
    confirmationsBefore: status.map((value: unknown) => typeof value === "bigint" ? value.toString() : value),
    executionAttemptsBefore: attempts.toString(),
    marker,
    updateCount: updateCount.toString(),
    noBusinessChange: true,
  };
  console.log(JSON.stringify(preflight, null, 2));
  if (mode === "preflight") return;

  if (sourceAddress !== broadcaster) {
    const account = privateKeyToAccount(privateKey());
    assertThat(sameAddress(account.address, deployer), `Signer mismatch: ${account.address}`);
    await publicClient.simulateContract({
      account,
      address: executor,
      abi: executorAbi,
      functionName: "setAxSrc",
      args: [SOURCE_CHAIN, broadcaster],
    });
    const wallet: any = createWalletClient({ account, chain: base, transport: http(rpc, { timeout: 30_000 }) });
    const hash = await wallet.writeContract({
      account,
      address: executor,
      abi: executorAbi,
      functionName: "setAxSrc",
      args: [SOURCE_CHAIN, broadcaster],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assertThat(receipt.status === "success", `Executor.setAxSrc failed: ${hash}`);
    console.log(JSON.stringify({ transaction: "Executor.setAxSrc", hash, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() }));
  }

  const sourceAddressAfter = await eventually(
    () => publicClient.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "axSrcAddress",
    }),
    (value) => value === broadcaster,
    "Axelar source fix",
  );

  let statusAfterFix = await publicClient.readContract({
    address: executor,
    abi: executorAbi,
    functionName: "confirmStatus",
    args: [expectedMessageHash],
  });
  if (!statusAfterFix[2]) {
    assertThat(approved, "Axelar command is not approved for the checksum source address");
    const account = privateKeyToAccount(privateKey());
    const wallet: any = createWalletClient({ account, chain: base, transport: http(rpc, { timeout: 30_000 }) });
    await publicClient.simulateContract({
      account,
      address: executor,
      abi: executorAbi,
      functionName: "execute",
      args: [commandId, SOURCE_CHAIN, broadcaster, payload],
    });
    const hash = await wallet.writeContract({
      account,
      address: executor,
      abi: executorAbi,
      functionName: "execute",
      args: [commandId, SOURCE_CHAIN, broadcaster, payload],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assertThat(receipt.status === "success", `Axelar late confirmation failed: ${hash}`);
    console.log(JSON.stringify({ transaction: "Executor.execute(Axelar late confirmation)", hash, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() }));
    statusAfterFix = await eventually(
      () => publicClient.readContract({
        address: executor,
        abi: executorAbi,
        functionName: "confirmStatus",
        args: [expectedMessageHash],
      }),
      (value) => value[2] && value[3] === 3n && value[4],
      "Axelar late confirmation",
    );
  }

  const [attemptsAfter, markerAfter, updateCountAfter] = await Promise.all([
    publicClient.readContract({ address: executor, abi: executorAbi, functionName: "executionAttempts", args: [expectedMessageHash] }),
    publicClient.readContract({ address: probe, abi: probeAbi, functionName: "marker" }),
    publicClient.readContract({ address: probe, abi: probeAbi, functionName: "updateCount" }),
  ]);
  assertThat(statusAfterFix[0] && statusAfterFix[1] && statusAfterFix[2] && statusAfterFix[3] === 3n && statusAfterFix[4],
    "Base did not reach a healthy 3-of-3 confirmation state");
  assertThat(attemptsAfter === 1n, "Late Axelar confirmation caused duplicate execution attempt");
  assertThat(markerAfter === finalVerification.marker && updateCountAfter === 1n,
    "Late Axelar confirmation changed the business result");
  console.log(JSON.stringify({
    status: "PASS",
    baseAxelarSourceAddressCasingFixed: true,
    confirmations: { layerZero: true, chainlinkCcip: true, axelar: true, count: 3 },
    executed: true,
    executionAttempts: attemptsAfter.toString(),
    marker: markerAfter,
    updateCount: updateCountAfter.toString(),
    duplicateBusinessExecution: false,
  }, null, 2));
}

await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
