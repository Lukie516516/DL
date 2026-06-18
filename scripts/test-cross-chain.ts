/**
 * test-cross-chain.ts
 *
 * 端到端测试：Sepolia DAO 提案通过 → 参数变更 → BSC MirrorParams 同步
 *
 * 步骤：
 *   1. 授权 D spend
 *   2. 提交 Parameter 提案（两个 actions）:
 *        a. governance.setFastPassThreshold(50 D)     — 改本链参数
 *        b. dispatcher.dispatch(BSC_EID, mirror, calldata, 200_000)  — 跨链
 *   3. stake 足够 D 激活提案
 *   4. approve() 快速通过（deployer 有 100 D > 70 D 阈值）
 *   5. 查询 LZ 费用
 *   6. execute() + 附带 LZ fee as msg.value
 *   7. 等 LZ 中继，然后运行 check-bsc-mirror.ts 验证 BSC 上的值
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { parseEther, formatEther, encodeFunctionData, type Address } from "viem";

const DEPLOYMENT_FILE = join(process.cwd(), "deployments", "sepolia-11155111.json");

function loadAbi(contractPath: string): unknown[] {
  const p = join(process.cwd(), "artifacts", "contracts", contractPath);
  return (JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[] }).abi;
}

async function waitFor(pub: any, hash: `0x${string}`, label: string) {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
  return r;
}

// ── Load deployment ───────────────────────────────────────────────────────────
const dep_json   = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
const GOV_PROXY  = dep_json.dealGovernance as Address;
const D_TOKEN    = dep_json.dToken         as Address;
const DISPATCHER = dep_json.lzDispatcher   as Address;
const MIRROR     = dep_json.mirrorParams   as Address;
const BSC_EID    = dep_json.lzEidBscTestnet as number; // 40102

if (!MIRROR) throw new Error("Run deploy-bsc-testnet.ts and wire-cross-chain.ts first");

const { viem } = await (network as any).connect({ network: "sepolia", chainType: "l1" });
const pub  = await viem.getPublicClient();
const [dep] = await viem.getWalletClients();
const deployer = dep.account.address as Address;
console.log(`Deployer: ${deployer}`);

const govAbi    = loadAbi("DealGovernance.sol/DealGovernance.json");
const dAbi      = loadAbi("D.sol/D.json");
const dispAbi   = loadAbi("bridge/LZGovernanceDispatcher.sol/LZGovernanceDispatcher.json");
const mirrorAbi = loadAbi("bridge/MirrorParams.sol/MirrorParams.json");

// ── State before ──────────────────────────────────────────────────────────────
const [curThreshold, dBal, activThreshold] = await Promise.all([
  pub.readContract({ address: GOV_PROXY, abi: govAbi, functionName: "fastPassThreshold" }),
  pub.readContract({ address: D_TOKEN,   abi: dAbi,   functionName: "balanceOf", args: [deployer] }),
  pub.readContract({ address: GOV_PROXY, abi: govAbi, functionName: "activationThreshold" }),
]);
console.log(`fastPassThreshold:    ${formatEther(curThreshold as bigint)} D`);
console.log(`activationThreshold:  ${formatEther(activThreshold as bigint)} D`);
console.log(`Deployer D balance:   ${formatEther(dBal as bigint)} D`);

// ── New value ─────────────────────────────────────────────────────────────────
const NEW_FAST_PASS = parseEther("50"); // 50 D (down from 70)
console.log(`\nWill set fastPassThreshold → ${formatEther(NEW_FAST_PASS)} D`);

// ── 1: Approve D spend ────────────────────────────────────────────────────────
console.log("\n[1] Approving D for governance...");
{
  const hash = await dep.writeContract({
    address:      D_TOKEN,
    abi:          dAbi,
    functionName: "approve",
    args:         [GOV_PROXY, parseEther("1000")],
  });
  await waitFor(pub, hash, "D.approve(governance, 1000 D)");
}

// ── 2: Build proposal actions ─────────────────────────────────────────────────
// Action A: governance calls setFastPassThreshold on itself
const actionA_target   = GOV_PROXY;
const actionA_calldata = encodeFunctionData({
  abi: govAbi, functionName: "setFastPassThreshold", args: [NEW_FAST_PASS]
});

// Action B: governance calls dispatcher.dispatch to mirror param to BSC
const mirrorCalldata   = encodeFunctionData({
  abi: mirrorAbi, functionName: "setFastPassThreshold", args: [NEW_FAST_PASS]
});
// dispatcher.dispatch(dstEid, target, data, gas) — will be sent with ETH from governance
const actionB_target   = DISPATCHER;
const actionB_calldata = encodeFunctionData({
  abi: dispAbi, functionName: "dispatch",
  args: [BSC_EID, MIRROR, mirrorCalldata, 200_000n],
});

const targets   = [actionA_target, actionB_target] as Address[];
const values    = [0n, parseEther("0.01")] as bigint[]; // 0.01 ETH for LZ fee in action B
const calldatas = [actionA_calldata, actionB_calldata] as `0x${string}`[];

// ── 3: Submit proposal ────────────────────────────────────────────────────────
console.log("\n[2] Submitting Parameter proposal...");
let proposalId: bigint;
{
  const hash = await dep.writeContract({
    address:      GOV_PROXY,
    abi:          govAbi,
    functionName: "createProposal",
    args:         [targets, values, calldatas, "Cross-chain: set fastPassThreshold to 50D", 0],
    //             ProposalKind.Parameter = 0
  });
  const r = await waitFor(pub, hash, "createProposal()");
  // ProposalCreated(proposalId, proposer, kind, description) — first indexed = proposalId
  proposalId = BigInt(r.logs[0]?.topics[1] as string);
  console.log(`  Proposal ID: ${proposalId}`);
}

// ── 4: Stake D to activate ────────────────────────────────────────────────────
console.log(`\n[3] Staking D (${formatEther(activThreshold as bigint)} D needed to activate)...`);
{
  const hash = await dep.writeContract({
    address:      GOV_PROXY,
    abi:          govAbi,
    functionName: "stake",
    args:         [proposalId, parseEther("5")], // 5 D > 2.5 D activationThreshold
  });
  await waitFor(pub, hash, "stake(5 D)");
}

const state1 = await pub.readContract({
  address: GOV_PROXY, abi: govAbi, functionName: "state", args: [proposalId]
});
console.log(`  State: ${state1} (expected 2=Active)`);

// ── 5: Fast-pass via approve ───────────────────────────────────────────────────
console.log("\n[4] Calling approve() to fast-pass (deployer has 100 D > 70 D threshold)...");
{
  const hash = await dep.writeContract({
    address:      GOV_PROXY,
    abi:          govAbi,
    functionName: "approve",
    args:         [proposalId],
  });
  await waitFor(pub, hash, "approve() → fast-pass");
}

const state2 = await pub.readContract({
  address: GOV_PROXY, abi: govAbi, functionName: "state", args: [proposalId]
});
// ProposalState: 0=Missing, 1=Pending, 2=Active, 3=Succeeded, 4=Vetoed, 5=Canceled, 6=Executed
console.log(`  State: ${state2} (expected 3=Succeeded)`);

if (state2 !== 3) {
  console.error("  ✗ Proposal not in Succeeded state — aborting execute");
  process.exit(1);
}

// ── 6: Quote LZ fee ───────────────────────────────────────────────────────────
console.log("\n[5] Quoting LZ fee for dispatch action...");
const lzFee = await pub.readContract({
  address:      DISPATCHER,
  abi:          dispAbi,
  functionName: "quoteFee",
  args:         [BSC_EID, MIRROR, mirrorCalldata, 200_000n],
}) as bigint;
console.log(`  LZ fee: ${formatEther(lzFee)} ETH`);

// The execute will forward 0.01 ETH to the dispatcher (values[1]).
// We send 0.01 ETH as msg.value to governance.execute().
const executeValue = parseEther("0.01"); // slightly more than lzFee
console.log(`  Sending ${formatEther(executeValue)} ETH with execute() to cover LZ fee`);

// ── 7: Execute ────────────────────────────────────────────────────────────────
console.log("\n[6] Executing proposal...");
{
  const hash = await dep.writeContract({
    address:      GOV_PROXY,
    abi:          govAbi,
    functionName: "execute",
    args:         [proposalId],
    value:        executeValue,
  });
  await waitFor(pub, hash, "execute()");
}

// Verify local param change
const newFastPass = await pub.readContract({
  address: GOV_PROXY, abi: govAbi, functionName: "fastPassThreshold"
});
console.log(`\nSepolia fastPassThreshold: ${formatEther(newFastPass as bigint)} D ✓`);

console.log("\n═══════════════════════════════════════════════════════");
console.log("Execute complete! LZ message sent to BSC Testnet.");
console.log("\nWait 1-2 minutes for LZ relayer, then run:");
console.log("  npx hardhat run scripts/check-bsc-mirror.ts");
console.log("\nExpect BSC MirrorParams.fastPassThreshold = 50 D");
console.log("═══════════════════════════════════════════════════════");
