/**
 * deploy-bsc-testnet.ts
 *
 * 在 BSC Testnet 部署跨链 DAO PoC 的镜像链合约：
 *   1. LZGovernanceExecutor（接收 Sepolia 来的消息并执行）
 *   2. MirrorParams（被 Executor 调用，存储镜像参数）
 *
 * LZ endpoint BSC Testnet: 0x6EDCE65403992e310A62460808c4b910D972f10f (EID 40102)
 *
 * 前提：已运行 deploy-sepolia.ts，deployments/sepolia-11155111.json 存在。
 * 部署后更新 deployments/sepolia-11155111.json 填入 lzExecutor & mirrorParams。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { formatEther, type Address } from "viem";

const LZ_ENDPOINT_BSC  = "0x6EDCE65403992e310A62460808c4b910D972f10f" as Address;
const DEPLOYMENT_FILE  = join(process.cwd(), "deployments", "sepolia-11155111.json");

function loadAbi(contractPath: string): unknown[] {
  const artifactPath = join(process.cwd(), "artifacts", "contracts", contractPath);
  return (JSON.parse(readFileSync(artifactPath, "utf8")) as { abi: unknown[] }).abi;
}

function loadBytecode(contractPath: string): `0x${string}` {
  const artifactPath = join(process.cwd(), "artifacts", "contracts", contractPath);
  return (JSON.parse(readFileSync(artifactPath, "utf8")) as { bytecode: `0x${string}` }).bytecode;
}

async function waitFor(pub: any, hash: `0x${string}`, label: string) {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`FAILED: ${label} (${hash})`);
  console.log(`  ✓ ${label}`);
  return r;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const { viem } = await (network as any).connect({ network: "bscTestnet", chainType: "l1" });
const pub  = await viem.getPublicClient();
const [dep] = await viem.getWalletClients();
const deployer = dep.account.address as Address;
console.log(`Deployer: ${deployer}`);
const bal = await pub.getBalance({ address: deployer });
console.log(`Balance:  ${formatEther(bal)} BNB`);

// ── 1. Deploy LZGovernanceExecutor ───────────────────────────────────────────
console.log("\n[1] Deploying LZGovernanceExecutor...");
const execTx = await dep.deployContract({
  abi:      loadAbi("bridge/LZGovernanceExecutor.sol/LZGovernanceExecutor.json"),
  bytecode: loadBytecode("bridge/LZGovernanceExecutor.sol/LZGovernanceExecutor.json"),
  args:     [LZ_ENDPOINT_BSC, deployer],
});
await waitFor(pub, execTx, "executor deploy");
const execR    = await pub.waitForTransactionReceipt({ hash: execTx });
const EXECUTOR = execR.contractAddress as Address;
console.log(`  Executor: ${EXECUTOR}`);

// ── 2. Deploy MirrorParams ────────────────────────────────────────────────────
console.log("\n[2] Deploying MirrorParams...");
const mirrorTx = await dep.deployContract({
  abi:      loadAbi("bridge/MirrorParams.sol/MirrorParams.json"),
  bytecode: loadBytecode("bridge/MirrorParams.sol/MirrorParams.json"),
  args:     [EXECUTOR],
});
await waitFor(pub, mirrorTx, "MirrorParams deploy");
const mirrorR  = await pub.waitForTransactionReceipt({ hash: mirrorTx });
const MIRROR   = mirrorR.contractAddress as Address;
console.log(`  MirrorParams: ${MIRROR}`);

// ── 3. Update deployment JSON ─────────────────────────────────────────────────
const dep_json = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
dep_json.lzExecutor   = EXECUTOR;
dep_json.mirrorParams = MIRROR;
writeFileSync(DEPLOYMENT_FILE, JSON.stringify(dep_json, null, 2));
console.log(`\nUpdated ${DEPLOYMENT_FILE}`);

console.log("\n═══════════════════════════════════════════════════════");
console.log("BSC Testnet deployment complete. Next step:");
console.log("  Run scripts/wire-cross-chain.ts");
console.log("═══════════════════════════════════════════════════════");
console.log("\nAddresses:");
console.log(`  LZ Executor:  ${EXECUTOR}`);
console.log(`  MirrorParams: ${MIRROR}`);
