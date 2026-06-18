/**
 * redeploy-bsc-and-rewire.ts
 *
 * 修复：OAppBase 新增 allowInitializePath + nextNonce（LZ V2 endpoint 首次投递必须）。
 *
 * 步骤：
 *   1. BSC: 重新部署 LZGovernanceExecutor（含修复的 allowInitializePath）
 *   2. BSC: 重新部署 MirrorParams（指向新 executor）
 *   3. BSC: Executor.setPeer(SEP_EID, dispatcher)
 *   4. Sepolia: Dispatcher.setPeer(BSC_EID, newExecutor)  ← 更新到新地址
 *   5. 更新 deployments/sepolia-11155111.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { pad, type Address } from "viem";

const DEPLOYMENT_FILE   = join(process.cwd(), "deployments", "sepolia-11155111.json");
const LZ_ENDPOINT_BSC   = "0x6EDCE65403992e310A62460808c4b910D972f10f" as Address;

function loadAbi(p: string) {
  return (JSON.parse(readFileSync(join(process.cwd(), "artifacts", "contracts", p), "utf8")) as any).abi;
}
function loadBytecode(p: string): `0x${string}` {
  return (JSON.parse(readFileSync(join(process.cwd(), "artifacts", "contracts", p), "utf8")) as any).bytecode;
}
async function waitFor(pub: any, hash: `0x${string}`, label: string) {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
  return r;
}
function addrToBytes32(addr: Address): `0x${string}` {
  return pad(addr.toLowerCase() as `0x${string}`, { size: 32 });
}

const dep_json   = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
const DISPATCHER = dep_json.lzDispatcher    as Address;
const EID_BSC    = dep_json.lzEidBscTestnet as number;
const EID_SEP    = dep_json.lzEidSepolia    as number;

// ── BSC side ─────────────────────────────────────────────────────────────────
console.log("=== Deploying fixed contracts on BSC Testnet ===");
const { viem: bscViem } = await (network as any).connect({ network: "bscTestnet", chainType: "l1" });
const bscPub  = await bscViem.getPublicClient();
const [bscDep] = await bscViem.getWalletClients();
const bscDeployer = bscDep.account.address as Address;
console.log(`BSC Deployer: ${bscDeployer}`);

// 1. Deploy new Executor
console.log("\n[1] Deploying new LZGovernanceExecutor (with allowInitializePath)...");
const execTx = await bscDep.deployContract({
  abi:      loadAbi("bridge/LZGovernanceExecutor.sol/LZGovernanceExecutor.json"),
  bytecode: loadBytecode("bridge/LZGovernanceExecutor.sol/LZGovernanceExecutor.json"),
  args:     [LZ_ENDPOINT_BSC, bscDeployer],
});
await waitFor(bscPub, execTx, "executor deploy");
const execR       = await bscPub.waitForTransactionReceipt({ hash: execTx });
const NEW_EXECUTOR = execR.contractAddress as Address;
console.log(`  New Executor: ${NEW_EXECUTOR}`);

// 2. Deploy new MirrorParams pointing to new executor
console.log("\n[2] Deploying new MirrorParams...");
const mirrorTx = await bscDep.deployContract({
  abi:      loadAbi("bridge/MirrorParams.sol/MirrorParams.json"),
  bytecode: loadBytecode("bridge/MirrorParams.sol/MirrorParams.json"),
  args:     [NEW_EXECUTOR],
});
await waitFor(bscPub, mirrorTx, "MirrorParams deploy");
const mirrorR    = await bscPub.waitForTransactionReceipt({ hash: mirrorTx });
const NEW_MIRROR = mirrorR.contractAddress as Address;
console.log(`  New MirrorParams: ${NEW_MIRROR}`);

// 3. Wire BSC: Executor.setPeer(SEP_EID, dispatcher)
console.log("\n[3] Wiring BSC: Executor.setPeer(Sepolia, Dispatcher)...");
{
  const hash = await bscDep.writeContract({
    address:      NEW_EXECUTOR,
    abi:          loadAbi("bridge/LZGovernanceExecutor.sol/LZGovernanceExecutor.json"),
    functionName: "setPeer",
    args:         [EID_SEP, addrToBytes32(DISPATCHER)],
  });
  await waitFor(bscPub, hash, `Executor.setPeer(SEP=${EID_SEP}, dispatcher=${DISPATCHER})`);
}

// ── Sepolia side ──────────────────────────────────────────────────────────────
console.log("\n=== Updating Sepolia: Dispatcher.setPeer → newExecutor ===");
const { viem: sepViem } = await (network as any).connect({ network: "sepolia", chainType: "l1" });
const sepPub  = await sepViem.getPublicClient();
const [sepDep] = await sepViem.getWalletClients();

{
  const hash = await sepDep.writeContract({
    address:      DISPATCHER,
    abi:          loadAbi("bridge/LZGovernanceDispatcher.sol/LZGovernanceDispatcher.json"),
    functionName: "setPeer",
    args:         [EID_BSC, addrToBytes32(NEW_EXECUTOR)],
  });
  await waitFor(sepPub, hash, `Dispatcher.setPeer(BSC=${EID_BSC}, newExecutor=${NEW_EXECUTOR})`);
}

// ── Update JSON ───────────────────────────────────────────────────────────────
dep_json.lzExecutor   = NEW_EXECUTOR;
dep_json.mirrorParams = NEW_MIRROR;
writeFileSync(DEPLOYMENT_FILE, JSON.stringify(dep_json, null, 2));

console.log("\n═══════════════════════════════════════════════════════");
console.log("Redeploy + re-wire complete.");
console.log(`  New Executor:    ${NEW_EXECUTOR}`);
console.log(`  New MirrorParams:${NEW_MIRROR}`);
console.log(`  Dispatcher:      ${DISPATCHER}  (unchanged)`);
console.log("\nNow run: npx hardhat run scripts/test-cross-chain.ts");
console.log("═══════════════════════════════════════════════════════");
