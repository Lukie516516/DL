/**
 * check-factory-bsc.ts
 * 读取 BSC 上 DealFactory 的当前状态，验证参数变更和合约升级结果
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { type Address } from "viem";

const DEPLOYMENT_FILE = join(process.cwd(), "deployments", "sepolia-11155111.json");
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

function loadAbi(p: string) {
  return (JSON.parse(readFileSync(join(process.cwd(), "artifacts", "contracts", p), "utf8")) as any).abi;
}

const dep     = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
const FACTORY = dep.dealFactoryBsc     as Address;
const IMPL_V1 = dep.dealFactoryImplBsc as Address;
const IMPL_V2 = dep.dealFactoryImplBscV2 as Address | undefined;

if (!FACTORY) throw new Error("Run deploy-factory-bsc.ts first");

const { viem } = await (network as any).connect({ network: "bscTestnet", chainType: "l1" });
const pub = await viem.getPublicClient();
const factoryAbi = loadAbi("DealFactory.sol/DealFactory.json");

const [minTimeout, owner, implSlot] = await Promise.all([
  pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: "minTimeoutSeconds" }),
  pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: "owner" }),
  pub.getStorageAt({ address: FACTORY, slot: IMPL_SLOT }),
]);

const currentImpl = ("0x" + implSlot!.slice(-40)) as Address;

console.log("\nDealFactory on BSC Testnet:");
console.log(`  Proxy address:      ${FACTORY}`);
console.log(`  owner():            ${owner}`);
console.log(`  minTimeoutSeconds:  ${minTimeout}s`);
console.log(`\n  Implementation (EIP-1967 slot):`);
console.log(`    Current:  ${currentImpl}`);
console.log(`    Impl V1:  ${IMPL_V1}`);
if (IMPL_V2) console.log(`    Impl V2:  ${IMPL_V2}`);

console.log("\n--- Checks ---");
if (BigInt(minTimeout as bigint) === 7200n) {
  console.log("  ✓ minTimeoutSeconds = 7200  (param change confirmed)");
} else if (BigInt(minTimeout as bigint) === 3600n) {
  console.log("  ⏳ minTimeoutSeconds = 3600  (param change not yet arrived)");
} else {
  console.log(`  ? minTimeoutSeconds = ${minTimeout}`);
}

if (IMPL_V2 && currentImpl.toLowerCase() === IMPL_V2.toLowerCase()) {
  console.log("  ✓ Implementation = V2       (contract upgrade confirmed)");
} else if (currentImpl.toLowerCase() === IMPL_V1.toLowerCase()) {
  console.log("  ⏳ Implementation = V1       (upgrade not yet arrived)");
} else {
  console.log(`  ? Implementation = ${currentImpl}`);
}
