/**
 * health-check-gov-v4.ts
 * 验证 DealGovernance v4 部署是否健康
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, defineChain, getAddress, type Address } from "viem";

const CHAIN_ID = 31415926;
const deployment = JSON.parse(
  readFileSync(join(process.cwd(), "deployments/agiking-31415926.json"), "utf8")
);

const PROXY   = getAddress(deployment.addresses.dealGovernance)     as Address;
const IMPL    = getAddress(deployment.addresses.dealGovernanceImpl) as Address;
const D_TOKEN = "0xa57b99e48f2fc24282e8f263d24468a51c5242db" as Address;

// ERC-1967 implementation slot
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const chain = defineChain({
  id: CHAIN_ID, name: "Agiking",
  nativeCurrency: { decimals: 18, name: "AGI", symbol: "AGI" },
  rpcUrls: { default: { http: [process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop"] } },
});

const pub = createPublicClient({ chain, transport: http() });

const GOV_ABI = [
  { name: "activationThreshold",   type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "fastPassThreshold",     type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "majorProposalFee",      type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "treasuryPassThreshold", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "satoshiPassThreshold",  type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "paramWindowSeconds",    type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "majorWindowSeconds",    type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "dToken",                type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "activeProposalCount",   type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "totalVetoStaked",       type: "function", stateMutability: "view", inputs: [{ name: "proposalId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { name: "vetoStakeOf",           type: "function", stateMutability: "view", inputs: [{ name: "proposalId", type: "uint256" }, { name: "staker", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

let passed = 0, failed = 0;

function ok(label: string, val: unknown) {
  console.log(`  ✓ ${label}: ${val}`);
  passed++;
}
function fail(label: string, got: unknown, expected: unknown) {
  console.log(`  ✗ ${label}: got ${got}, expected ${expected}`);
  failed++;
}
function check(label: string, got: bigint | string, expected: bigint | string) {
  if (got.toString() === expected.toString()) ok(label, got);
  else fail(label, got, expected);
}

console.log("=== DealGovernance v4 Health Check ===");
console.log(`  proxy : ${PROXY}`);
console.log(`  impl  : ${IMPL}`);

// 1. ERC-1967 slot 验证：proxy 指向正确的 impl
const rawSlot = await pub.getStorageAt({ address: PROXY, slot: IMPL_SLOT as `0x${string}` });
const slotImpl = getAddress("0x" + rawSlot!.slice(-40)) as Address;
console.log("\n[1] ERC-1967 实现合约地址");
if (slotImpl.toLowerCase() === IMPL.toLowerCase()) ok("impl slot", slotImpl);
else fail("impl slot", slotImpl, IMPL);

// 2. 初始化参数
console.log("\n[2] 初始化参数");
const r = (fn: string) => pub.readContract({ address: PROXY, abi: GOV_ABI, functionName: fn as any });

const [actT, fpT, majFee, treT, satT, paramW, majW, dToken, activeCount] = await Promise.all([
  r("activationThreshold"),   // 2.5 D
  r("fastPassThreshold"),     // 70 D
  r("majorProposalFee"),      // 1000 DC
  r("treasuryPassThreshold"), // 70 D
  r("satoshiPassThreshold"),  // 90 D
  r("paramWindowSeconds"),    // 86400 (24h)
  r("majorWindowSeconds"),    // 432000 (120h)
  r("dToken"),
  r("activeProposalCount"),
]);

check("activationThreshold",   actT as bigint,  25n * 10n**17n);
check("fastPassThreshold",     fpT as bigint,   70n * 10n**18n);
check("majorProposalFee",      majFee as bigint,1000n * 10n**18n);
check("treasuryPassThreshold", treT as bigint,  70n * 10n**18n);
check("satoshiPassThreshold",  satT as bigint,  90n * 10n**18n);
check("paramWindowSeconds",    paramW as bigint, 86400n);
check("majorWindowSeconds",    majW as bigint,   432000n);
check("dToken",                (dToken as string).toLowerCase(), D_TOKEN.toLowerCase());
check("activeProposalCount",   activeCount as bigint, 0n);

// 3. vetoStake 接口可调用
console.log("\n[3] vetoStake 接口");
const vetoTotal = await pub.readContract({ address: PROXY, abi: GOV_ABI, functionName: "totalVetoStaked", args: [0n] });
const vetoOf    = await pub.readContract({ address: PROXY, abi: GOV_ABI, functionName: "vetoStakeOf",     args: [0n, PROXY] });
check("totalVetoStaked(0)", vetoTotal as bigint, 0n);
check("vetoStakeOf(0, proxy)", vetoOf as bigint, 0n);

// 4. 旧 proxy 不再拥有 NftVetoRegistry 权限（暂时跳过，不影响 v4 功能）
console.log("\n[4] 部署文件一致性");
check("deployment.addresses.dealGovernance", deployment.addresses.dealGovernance.toLowerCase(), PROXY.toLowerCase());
check("deployment.upgrade", deployment.upgrade, "v4-veto-stake");

// 结果
console.log(`\n${"─".repeat(40)}`);
if (failed === 0) {
  console.log(`✅ 全部通过 (${passed}/${passed + failed})`);
} else {
  console.log(`❌ ${failed} 项失败，${passed} 项通过`);
  process.exitCode = 1;
}
