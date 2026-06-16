/**
 * wire-cross-chain.ts
 *
 * 对两端的 OApp 合约调用 setPeer，建立互信关系：
 *   Sepolia  → Dispatcher.setPeer(BSC_EID=40102, executor_as_bytes32)
 *   BSC      → Executor.setPeer(SEPOLIA_EID=40161, dispatcher_as_bytes32)
 *
 * 前提：deploy-sepolia.ts 和 deploy-bsc-testnet.ts 均已完成。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { pad, type Address } from "viem";

const DEPLOYMENT_FILE = join(process.cwd(), "deployments", "sepolia-11155111.json");

function loadAbi(contractPath: string): unknown[] {
  const artifactPath = join(process.cwd(), "artifacts", "contracts", contractPath);
  return (JSON.parse(readFileSync(artifactPath, "utf8")) as { abi: unknown[] }).abi;
}

async function waitFor(pub: any, hash: `0x${string}`, label: string) {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`FAILED: ${label} (${hash})`);
  console.log(`  ✓ ${label}`);
  return r;
}

function addrToBytes32(addr: Address): `0x${string}` {
  return pad(addr.toLowerCase() as `0x${string}`, { size: 32 });
}

// ── Load addresses ────────────────────────────────────────────────────────────
const dep_json = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
const DISPATCHER = dep_json.lzDispatcher as Address;
const EXECUTOR   = dep_json.lzExecutor   as Address;
const EID_SEPOLIA     = dep_json.lzEidSepolia    as number;   // 40161
const EID_BSC_TESTNET = dep_json.lzEidBscTestnet as number;   // 40102

if (!DISPATCHER || !EXECUTOR) {
  throw new Error("Missing dispatcher or executor address in deployment JSON");
}

console.log(`Dispatcher (Sepolia): ${DISPATCHER}`);
console.log(`Executor (BSC):       ${EXECUTOR}`);
console.log(`EID Sepolia:          ${EID_SEPOLIA}`);
console.log(`EID BSC Testnet:      ${EID_BSC_TESTNET}`);

// ── 1. Sepolia: Dispatcher.setPeer(BSC_EID, executor_as_bytes32) ──────────────
console.log("\n[1] Sepolia → Dispatcher.setPeer(BSC_EID, executor)...");
{
  const { viem } = await (network as any).connect({ network: "sepolia", chainType: "l1" });
  const pub  = await viem.getPublicClient();
  const [dep] = await viem.getWalletClients();
  const dispAbi = loadAbi("bridge/LZGovernanceDispatcher.sol/LZGovernanceDispatcher.json");

  const hash = await dep.writeContract({
    address:      DISPATCHER,
    abi:          dispAbi,
    functionName: "setPeer",
    args:         [EID_BSC_TESTNET, addrToBytes32(EXECUTOR)],
  });
  await waitFor(pub, hash, `Dispatcher.setPeer(${EID_BSC_TESTNET}, executor)`);
}

// ── 2. BSC: Executor.setPeer(SEPOLIA_EID, dispatcher_as_bytes32) ─────────────
console.log("\n[2] BSC Testnet → Executor.setPeer(SEPOLIA_EID, dispatcher)...");
{
  const { viem } = await (network as any).connect({ network: "bscTestnet", chainType: "l1" });
  const pub  = await viem.getPublicClient();
  const [dep] = await viem.getWalletClients();
  const execAbi = loadAbi("bridge/LZGovernanceExecutor.sol/LZGovernanceExecutor.json");

  const hash = await dep.writeContract({
    address:      EXECUTOR,
    abi:          execAbi,
    functionName: "setPeer",
    args:         [EID_SEPOLIA, addrToBytes32(DISPATCHER)],
  });
  await waitFor(pub, hash, `Executor.setPeer(${EID_SEPOLIA}, dispatcher)`);
}

console.log("\n═══════════════════════════════════════════════════════");
console.log("Cross-chain wiring complete!");
console.log("\nVerify on-chain:");
console.log(`  Sepolia Dispatcher: ${DISPATCHER}`);
console.log(`    → peers(${EID_BSC_TESTNET}) should = ${addrToBytes32(EXECUTOR)}`);
console.log(`  BSC Executor: ${EXECUTOR}`);
console.log(`    → peers(${EID_SEPOLIA}) should = ${addrToBytes32(DISPATCHER)}`);
console.log("\nNext: run scripts/test-cross-chain.ts for end-to-end test");
console.log("═══════════════════════════════════════════════════════");
