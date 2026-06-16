/**
 * check-bsc-mirror.ts
 *
 * 读取 BSC Testnet 上 MirrorParams 的当前状态，验证跨链同步结果。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { formatEther, type Address } from "viem";

const DEPLOYMENT_FILE = join(process.cwd(), "deployments", "sepolia-11155111.json");

function loadAbi(contractPath: string): unknown[] {
  const p = join(process.cwd(), "artifacts", "contracts", contractPath);
  return (JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[] }).abi;
}

const dep_json = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
const MIRROR   = dep_json.mirrorParams as Address;
const EXECUTOR = dep_json.lzExecutor   as Address;

if (!MIRROR) throw new Error("Run deploy-bsc-testnet.ts first");

const { viem } = await (network as any).connect({ network: "bscTestnet", chainType: "l1" });
const pub = await viem.getPublicClient();

const mirrorAbi = loadAbi("bridge/MirrorParams.sol/MirrorParams.json");

const [
  activation,
  fastPass,
  treasury,
  satoshi,
  paramWindow,
  majorWindow,
  executor,
] = await Promise.all([
  pub.readContract({ address: MIRROR, abi: mirrorAbi, functionName: "activationThreshold" }),
  pub.readContract({ address: MIRROR, abi: mirrorAbi, functionName: "fastPassThreshold" }),
  pub.readContract({ address: MIRROR, abi: mirrorAbi, functionName: "treasuryPassThreshold" }),
  pub.readContract({ address: MIRROR, abi: mirrorAbi, functionName: "satoshiPassThreshold" }),
  pub.readContract({ address: MIRROR, abi: mirrorAbi, functionName: "paramWindowSeconds" }),
  pub.readContract({ address: MIRROR, abi: mirrorAbi, functionName: "majorWindowSeconds" }),
  pub.readContract({ address: MIRROR, abi: mirrorAbi, functionName: "executor" }),
]);

console.log("\nMirrorParams on BSC Testnet:");
console.log(`  address:              ${MIRROR}`);
console.log(`  executor:             ${executor}  (expected: ${EXECUTOR})`);
console.log(`  activationThreshold:  ${formatEther(activation as bigint)} D`);
console.log(`  fastPassThreshold:    ${formatEther(fastPass as bigint)} D`);
console.log(`  treasuryPassThreshold:${formatEther(treasury as bigint)} D`);
console.log(`  satoshiPassThreshold: ${formatEther(satoshi as bigint)} D`);
console.log(`  paramWindowSeconds:   ${paramWindow}s`);
console.log(`  majorWindowSeconds:   ${majorWindow}s`);

if ((fastPass as bigint) === 0n) {
  console.log("\n  ⚠️  fastPassThreshold is still 0 — LZ message may not have arrived yet.");
  console.log("     Wait 1-2 minutes and retry.");
} else {
  console.log("\n  ✓ Cross-chain governance sync confirmed!");
}
