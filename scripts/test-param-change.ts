/**
 * test-param-change.ts
 *
 * 测试 1：通过 Sepolia DAO 提案跨链修改 BSC 上 DealFactory.minTimeoutSeconds
 *
 * 流程：
 *   Sepolia DAO → createProposal → stake → fast-pass → execute
 *   → LZDispatcher → LZ → LZExecutor(BSC) → DealFactory.setMinTimeoutSeconds(7200)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { encodeFunctionData, formatEther, type Address } from "viem";

const DEPLOYMENT_FILE = join(process.cwd(), "deployments", "sepolia-11155111.json");

function loadAbi(p: string) {
  return (JSON.parse(readFileSync(join(process.cwd(), "artifacts", "contracts", p), "utf8")) as any).abi;
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
const BSC_EID    = dep.lzEidBscTestnet as number;

if (!FACTORY) throw new Error("Run deploy-factory-bsc.ts first");

const NEW_TIMEOUT = 7200n; // 2小时，从 3600 改成 7200 作为验证

const { viem } = await (network as any).connect({ network: "sepolia", chainType: "l1" });
const pub    = await viem.getPublicClient();
const [signer] = await viem.getWalletClients();
const deployer = signer.account.address as Address;

const govAbi    = loadAbi("DealGovernance.sol/DealGovernance.json");
const dAbi      = loadAbi("D.sol/D.json");
const dispAbi   = loadAbi("bridge/LZGovernanceDispatcher.sol/LZGovernanceDispatcher.json");
const factoryAbi = loadAbi("DealFactory.sol/DealFactory.json");

// Read current state
const [curTimeout, dBal] = await Promise.all([
  // BSC state — need BSC client
  Promise.resolve(3600n), // will confirm below
  pub.readContract({ address: D_TOKEN, abi: dAbi, functionName: "balanceOf", args: [deployer] }) as Promise<bigint>,
]);
console.log(`D balance:          ${formatEther(dBal)} D`);
console.log(`Target: minTimeoutSeconds: 3600 → ${NEW_TIMEOUT}`);

// Build cross-chain calldata: DealFactory.setMinTimeoutSeconds(7200)
const factoryCalldata = encodeFunctionData({
  abi: factoryAbi,
  functionName: "setMinTimeoutSeconds",
  args: [NEW_TIMEOUT],
});

// Build dispatch calldata: dispatcher.dispatch(BSC_EID, factory, factoryCalldata, 200_000)
const dispatchCalldata = encodeFunctionData({
  abi: dispAbi,
  functionName: "dispatch",
  args: [BSC_EID, FACTORY, factoryCalldata, 200_000n],
});

// Quote fee
const lzFee = await pub.readContract({
  address: DISPATCHER, abi: dispAbi,
  functionName: "quoteFee",
  args: [BSC_EID, FACTORY, factoryCalldata, 200_000n],
}) as bigint;
console.log(`LZ fee: ${formatEther(lzFee)} ETH`);

// Proposal: one action = dispatch cross-chain
const targets   = [DISPATCHER] as Address[];
const values    = [lzFee + (lzFee / 10n)] as bigint[]; // 10% buffer
const calldatas = [dispatchCalldata] as `0x${string}`[];
const executeValue = lzFee + (lzFee / 10n);

console.log(`\n[1] Approve D...`);
{
  const hash = await signer.writeContract({
    address: D_TOKEN, abi: dAbi,
    functionName: "approve",
    args: [GOV_PROXY, (dBal as bigint)],
  });
  await waitFor(pub, hash, "D.approve");
}

console.log(`\n[2] Create proposal: setMinTimeoutSeconds(${NEW_TIMEOUT})...`);
let proposalId: bigint;
{
  const hash = await signer.writeContract({
    address: GOV_PROXY, abi: govAbi,
    functionName: "createProposal",
    args: [targets, values, calldatas, `DAO: set DealFactory.minTimeoutSeconds = ${NEW_TIMEOUT}`, 0],
  });
  const r = await waitFor(pub, hash, "createProposal");
  proposalId = BigInt(r.logs[0]?.topics[1] as string);
  console.log(`  Proposal ID: ${proposalId}`);
}

console.log(`\n[3] Stake 5 D to activate...`);
{
  const hash = await signer.writeContract({
    address: GOV_PROXY, abi: govAbi,
    functionName: "stake",
    args: [proposalId, BigInt(5e18)],
  });
  await waitFor(pub, hash, "stake(5D)");
}

console.log(`\n[4] Fast-pass approve...`);
{
  const hash = await signer.writeContract({
    address: GOV_PROXY, abi: govAbi,
    functionName: "approve",
    args: [proposalId],
  });
  await waitFor(pub, hash, "approve() fast-pass");
}

const state = await pub.readContract({
  address: GOV_PROXY, abi: govAbi, functionName: "state", args: [proposalId],
});
console.log(`  State: ${state} (expected 3=Succeeded)`);
if (state !== 3) { console.error("Not succeeded, abort"); process.exit(1); }

console.log(`\n[5] Execute (sending ${formatEther(executeValue)} ETH for LZ fee)...`);
{
  const hash = await signer.writeContract({
    address: GOV_PROXY, abi: govAbi,
    functionName: "execute",
    args: [proposalId],
    value: executeValue,
  });
  await waitFor(pub, hash, "execute()");
}

console.log("\n═══════════════════════════════════════════════════════");
console.log("Proposal executed. LZ message sent to BSC.");
console.log(`Expect DealFactory.minTimeoutSeconds = ${NEW_TIMEOUT} on BSC.`);
console.log("\nRun in ~1 min:");
console.log("  npx hardhat run scripts/check-factory-bsc.ts");
console.log("═══════════════════════════════════════════════════════");
