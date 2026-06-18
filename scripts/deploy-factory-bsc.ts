/**
 * deploy-factory-bsc.ts
 *
 * 在 BSC Testnet 部署真实的 DealFactory（UUPS proxy），
 * 然后把 owner 转给已有的 LZGovernanceExecutor，
 * 使 Sepolia DAO 可以跨链控制 DealFactory 的参数和升级。
 *
 * initialize(dealImpl, pairImpl, minTimeoutSeconds):
 *   - dealImpl / pairImpl 在测试中用 deployer 地址占位（只测治理，不实际创建 deal）
 *   - minTimeoutSeconds = 3600 (1小时，生产最低值)
 *
 * 完成后更新 deployments/sepolia-11155111.json
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

const dep   = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
const EXECUTOR = dep.lzExecutor as Address;

console.log("=== Deploy DealFactory on BSC Testnet ===");
const { viem } = await (network as any).connect({ network: "bscTestnet", chainType: "l1" });
const pub    = await viem.getPublicClient();
const [signer] = await viem.getWalletClients();
const deployer = signer.account.address as Address;
console.log(`Deployer:  ${deployer}`);
console.log(`Executor:  ${EXECUTOR}  (will become owner)`);
console.log(`Balance:   ${formatEther(await pub.getBalance({ address: deployer }))} BNB`);

const factoryAbi      = loadAbi("DealFactory.sol/DealFactory.json");
const factoryBytecode = loadBytecode("DealFactory.sol/DealFactory.json");
const proxyAbi        = loadAbi("TestProxy.sol/ERC1967Proxy.json");
const proxyBytecode   = loadBytecode("TestProxy.sol/ERC1967Proxy.json");

// 1. Deploy implementation
console.log("\n[1] Deploying DealFactory implementation...");
const implTx = await signer.deployContract({ abi: factoryAbi, bytecode: factoryBytecode, args: [] });
await waitFor(pub, implTx, "DealFactory impl deploy");
const implR = await pub.waitForTransactionReceipt({ hash: implTx });
const IMPL  = implR.contractAddress as Address;
console.log(`  Impl: ${IMPL}`);

// 2. Deploy proxy with initialize
console.log("\n[2] Deploying ERC1967Proxy (with initialize)...");
const initData = encodeFunctionData({
  abi: factoryAbi,
  functionName: "initialize",
  // dealImpl + pairImpl: use deployer as placeholder (won't call createDeal in test)
  args: [deployer, deployer, 3600n],
});
const proxyTx = await signer.deployContract({
  abi: proxyAbi, bytecode: proxyBytecode,
  args: [IMPL, initData],
});
await waitFor(pub, proxyTx, "Proxy deploy");
const proxyR  = await pub.waitForTransactionReceipt({ hash: proxyTx });
const FACTORY = proxyR.contractAddress as Address;
console.log(`  Factory proxy: ${FACTORY}`);

// Verify initial minTimeoutSeconds
const minTimeout = await pub.readContract({
  address: FACTORY, abi: factoryAbi, functionName: "minTimeoutSeconds",
}) as bigint;
console.log(`  minTimeoutSeconds: ${minTimeout}s ✓`);

// 3. Transfer ownership to executor (so DAO can control params AND upgrades)
console.log(`\n[3] transferOwnership → executor (${EXECUTOR})...`);
{
  const hash = await signer.writeContract({
    address: FACTORY, abi: factoryAbi,
    functionName: "transferOwnership",
    args: [EXECUTOR],
  });
  await waitFor(pub, hash, "transferOwnership(executor)");
}

const newOwner = await pub.readContract({
  address: FACTORY, abi: factoryAbi, functionName: "owner",
}) as string;
console.log(`  New owner: ${newOwner}`);
if (newOwner.toLowerCase() !== EXECUTOR.toLowerCase()) {
  throw new Error("Owner transfer failed");
}
console.log(`  ✓ Executor is now owner`);

// 4. Save
dep.dealFactoryBsc      = FACTORY;
dep.dealFactoryImplBsc  = IMPL;
writeFileSync(DEPLOYMENT_FILE, JSON.stringify(dep, null, 2));

console.log("\n═══════════════════════════════════════════════════════");
console.log("DealFactory deployed and wired on BSC Testnet.");
console.log(`  Proxy:  ${FACTORY}`);
console.log(`  Impl:   ${IMPL}`);
console.log(`  Owner:  ${EXECUTOR}  (executor = DAO controlled)`);
console.log("\nNext:");
console.log("  1. npx hardhat run scripts/test-param-change.ts  — 改参数");
console.log("  2. npx hardhat run scripts/test-upgrade.ts       — 升级合约");
console.log("═══════════════════════════════════════════════════════");
