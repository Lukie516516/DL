/**
 * test-upgrade.ts
 *
 * 测试 2：通过 Sepolia DAO 提案跨链升级 BSC 上的 DealFactory 合约
 *
 * 流程：
 *   1. 在 BSC 部署新的 DealFactory implementation
 *   2. 在 Sepolia 提交 DAO 提案：upgradeToAndCall(newImpl, "0x")
 *   3. 提案通过 → execute → LZ → Executor → DealFactory.upgradeToAndCall(newImpl, "")
 *   4. 验证：BSC DealFactory 的 implementation 地址已变更
 *
 * 注：executor 是 DealFactory 的 owner，所以 _authorizeUpgrade(onlyOwner) 能通过
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { encodeFunctionData, formatEther, type Address } from "viem";

const DEPLOYMENT_FILE = join(process.cwd(), "deployments", "sepolia-11155111.json");

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

const dep        = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
const GOV_PROXY  = dep.dealGovernance  as Address;
const D_TOKEN    = dep.dToken          as Address;
const DISPATCHER = dep.lzDispatcher    as Address;
const FACTORY    = dep.dealFactoryBsc  as Address;
const OLD_IMPL   = dep.dealFactoryImplBsc as Address;
const BSC_EID    = dep.lzEidBscTestnet as number;

if (!FACTORY) throw new Error("Run deploy-factory-bsc.ts first");

const factoryAbi      = loadAbi("DealFactory.sol/DealFactory.json");
const dispAbi         = loadAbi("bridge/LZGovernanceDispatcher.sol/LZGovernanceDispatcher.json");
const govAbi          = loadAbi("DealGovernance.sol/DealGovernance.json");
const dAbi            = loadAbi("D.sol/D.json");

// EIP-1967 implementation slot
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

// ── STEP A: Deploy new DealFactory impl on BSC ───────────────────────────────
console.log("=== Step A: Deploy new DealFactory impl on BSC ===");
const { viem: bscViem } = await (network as any).connect({ network: "bscTestnet", chainType: "l1" });
const bscPub    = await bscViem.getPublicClient();
const [bscSigner] = await bscViem.getWalletClients();

// Check current impl via EIP-1967 slot
const currentImplSlot = await bscPub.getStorageAt({ address: FACTORY, slot: IMPL_SLOT });
const currentImpl = ("0x" + currentImplSlot!.slice(-40)) as Address;
console.log(`Current impl: ${currentImpl}`);
console.log(`Expected:     ${OLD_IMPL}`);

console.log("\nDeploying new DealFactory impl...");
const newImplTx = await bscSigner.deployContract({
  abi: factoryAbi, bytecode: loadBytecode("DealFactory.sol/DealFactory.json"), args: [],
});
await waitFor(bscPub, newImplTx, "new impl deploy");
const newImplR  = await bscPub.waitForTransactionReceipt({ hash: newImplTx });
const NEW_IMPL  = newImplR.contractAddress as Address;
console.log(`New impl: ${NEW_IMPL}`);

// Save new impl to JSON
dep.dealFactoryImplBscV2 = NEW_IMPL;
writeFileSync(DEPLOYMENT_FILE, JSON.stringify(dep, null, 2));

// ── STEP B: DAO proposal on Sepolia ─────────────────────────────────────────
console.log("\n=== Step B: Submit upgrade proposal on Sepolia DAO ===");
const { viem: sepViem } = await (network as any).connect({ network: "sepolia", chainType: "l1" });
const sepPub    = await sepViem.getPublicClient();
const [sepSigner] = await sepViem.getWalletClients();
const deployer   = sepSigner.account.address as Address;

const dBal = await sepPub.readContract({
  address: D_TOKEN, abi: dAbi, functionName: "balanceOf", args: [deployer],
}) as bigint;
console.log(`D balance: ${formatEther(dBal)} D`);

// upgradeToAndCall(newImpl, "") calldata for DealFactory
const upgradeCalldata = encodeFunctionData({
  abi: factoryAbi,
  functionName: "upgradeToAndCall",
  args: [NEW_IMPL, "0x"],
});

// dispatch calldata for Dispatcher
const dispatchCalldata = encodeFunctionData({
  abi: dispAbi,
  functionName: "dispatch",
  args: [BSC_EID, FACTORY, upgradeCalldata, 300_000n], // more gas for upgrade
});

// Quote LZ fee
const lzFee = await sepPub.readContract({
  address: DISPATCHER, abi: dispAbi,
  functionName: "quoteFee",
  args: [BSC_EID, FACTORY, upgradeCalldata, 300_000n],
}) as bigint;
console.log(`LZ fee: ${formatEther(lzFee)} ETH`);

const executeValue = lzFee + (lzFee / 5n); // 20% buffer for upgrade (more gas)

console.log(`\n[1] Approve D...`);
{
  const hash = await sepSigner.writeContract({
    address: D_TOKEN, abi: dAbi,
    functionName: "approve", args: [GOV_PROXY, dBal],
  });
  await waitFor(sepPub, hash, "D.approve");
}

console.log(`\n[2] Create proposal: upgradeToAndCall(${NEW_IMPL})...`);
let proposalId: bigint;
{
  const hash = await sepSigner.writeContract({
    address: GOV_PROXY, abi: govAbi,
    functionName: "createProposal",
    args: [
      [DISPATCHER] as Address[],
      [executeValue],
      [dispatchCalldata] as `0x${string}`[],
      `DAO: upgrade DealFactory impl → ${NEW_IMPL}`,
      0,
    ],
  });
  const r = await waitFor(sepPub, hash, "createProposal");
  proposalId = BigInt(r.logs[0]?.topics[1] as string);
  console.log(`  Proposal ID: ${proposalId}`);
}

console.log(`\n[3] Stake 5 D...`);
{
  const hash = await sepSigner.writeContract({
    address: GOV_PROXY, abi: govAbi,
    functionName: "stake", args: [proposalId, BigInt(5e18)],
  });
  await waitFor(sepPub, hash, "stake(5D)");
}

console.log(`\n[4] Fast-pass approve...`);
{
  const hash = await sepSigner.writeContract({
    address: GOV_PROXY, abi: govAbi,
    functionName: "approve", args: [proposalId],
  });
  await waitFor(sepPub, hash, "approve()");
}

const state = await sepPub.readContract({
  address: GOV_PROXY, abi: govAbi, functionName: "state", args: [proposalId],
});
if (state !== 3) { console.error(`State=${state}, expected 3. Abort.`); process.exit(1); }

console.log(`\n[5] Execute (${formatEther(executeValue)} ETH for LZ fee)...`);
{
  const hash = await sepSigner.writeContract({
    address: GOV_PROXY, abi: govAbi,
    functionName: "execute", args: [proposalId],
    value: executeValue,
  });
  await waitFor(sepPub, hash, "execute()");
}

console.log("\n═══════════════════════════════════════════════════════");
console.log("Upgrade proposal executed. LZ message sent to BSC.");
console.log(`Old impl: ${currentImpl}`);
console.log(`New impl: ${NEW_IMPL}`);
console.log("\nRun in ~1 min:");
console.log("  npx hardhat run scripts/check-factory-bsc.ts");
console.log("Expect implementation address to change.");
console.log("═══════════════════════════════════════════════════════");
