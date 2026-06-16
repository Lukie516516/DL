/**
 * redeploy-dispatcher.ts
 *
 * 仅重新部署 LZGovernanceDispatcher（修复了 options 编码 bug），
 * 并重新接线两端 peers。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { pad, type Address } from "viem";

const DEPLOYMENT_FILE = join(process.cwd(), "deployments", "sepolia-11155111.json");
const LZ_ENDPOINT_SEPOLIA = "0x6EDCE65403992e310A62460808c4b910D972f10f" as Address;

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

const dep_json = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
const GOV_PROXY = dep_json.dealGovernance as Address;
const EXECUTOR  = dep_json.lzExecutor    as Address;
const EID_BSC   = dep_json.lzEidBscTestnet as number;
const EID_SEP   = dep_json.lzEidSepolia   as number;

// ── Deploy new Dispatcher on Sepolia ─────────────────────────────────────────
console.log("Redeploying LZGovernanceDispatcher on Sepolia...");
const { viem: sepoliaViem } = await (network as any).connect({ network: "sepolia", chainType: "l1" });
const sepPub  = await sepoliaViem.getPublicClient();
const [sepDep] = await sepoliaViem.getWalletClients();
const deployer = sepDep.account.address as Address;

const dispTx = await sepDep.deployContract({
  abi:      loadAbi("bridge/LZGovernanceDispatcher.sol/LZGovernanceDispatcher.json"),
  bytecode: loadBytecode("bridge/LZGovernanceDispatcher.sol/LZGovernanceDispatcher.json"),
  args:     [LZ_ENDPOINT_SEPOLIA, deployer, GOV_PROXY],
});
await waitFor(sepPub, dispTx, "dispatcher deploy");
const dispR    = await sepPub.waitForTransactionReceipt({ hash: dispTx });
const NEW_DISP = dispR.contractAddress as Address;
console.log(`  New Dispatcher: ${NEW_DISP}`);

// ── Wire Sepolia side ─────────────────────────────────────────────────────────
const dispAbi = loadAbi("bridge/LZGovernanceDispatcher.sol/LZGovernanceDispatcher.json");
{
  const hash = await sepDep.writeContract({
    address:      NEW_DISP,
    abi:          dispAbi,
    functionName: "setPeer",
    args:         [EID_BSC, addrToBytes32(EXECUTOR)],
  });
  await waitFor(sepPub, hash, `Dispatcher.setPeer(BSC=${EID_BSC}, executor)`);
}

// ── Wire BSC side ─────────────────────────────────────────────────────────────
console.log("\nWiring BSC Testnet side...");
const { viem: bscViem } = await (network as any).connect({ network: "bscTestnet", chainType: "l1" });
const bscPub  = await bscViem.getPublicClient();
const [bscDep] = await bscViem.getWalletClients();
const execAbi = loadAbi("bridge/LZGovernanceExecutor.sol/LZGovernanceExecutor.json");

{
  // First clear old dispatcher peer (set to zero)
  const hashClear = await bscDep.writeContract({
    address:      EXECUTOR,
    abi:          execAbi,
    functionName: "setPeer",
    args:         [EID_SEP, "0x0000000000000000000000000000000000000000000000000000000000000000"],
  });
  await waitFor(bscPub, hashClear, `Executor.setPeer(SEP, zero) — clear old`);

  const hashNew = await bscDep.writeContract({
    address:      EXECUTOR,
    abi:          execAbi,
    functionName: "setPeer",
    args:         [EID_SEP, addrToBytes32(NEW_DISP)],
  });
  await waitFor(bscPub, hashNew, `Executor.setPeer(SEP=${EID_SEP}, newDispatcher)`);
}

// ── Update deployment JSON ────────────────────────────────────────────────────
dep_json.lzDispatcher = NEW_DISP;
writeFileSync(DEPLOYMENT_FILE, JSON.stringify(dep_json, null, 2));

console.log("\n═══════════════════════════════════════════════════════");
console.log(`New Dispatcher: ${NEW_DISP}`);
console.log("Re-wiring complete. Now run: scripts/test-cross-chain.ts");
console.log("═══════════════════════════════════════════════════════");
