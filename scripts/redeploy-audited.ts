/**
 * redeploy-audited.ts
 *
 * 用审计修复后的合约重新部署完整跨链栈，并接线。
 *
 * Sepolia（ETH 主网角色）:
 *   - 重新部署 LZGovernanceDispatcher（tx.origin→msg.sender、zero checks、receive()）
 *   - DealGovernance 不动（已有提案历史）
 *
 * BSC Testnet（目标链角色）:
 *   - 重新部署 LZGovernanceExecutor（+allowedTargets 白名单）
 *   - 重新部署 DealFactory proxy（owner=新 executor）
 *   - setAllowedTarget(DealFactory, true)
 *
 * 接线:
 *   - Dispatcher.setPeer(BSC_EID, newExecutor)
 *   - Executor.setPeer(SEP_EID, newDispatcher)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { encodeFunctionData, formatEther, pad, type Address } from "viem";

const DEPLOYMENT_FILE    = join(process.cwd(), "deployments", "sepolia-11155111.json");
const LZ_ENDPOINT_SEP   = "0x6EDCE65403992e310A62460808c4b910D972f10f" as Address;
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
function toBytes32(addr: Address): `0x${string}` {
  return pad(addr.toLowerCase() as `0x${string}`, { size: 32 });
}

const dep        = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
const GOV_PROXY  = dep.dealGovernance  as Address;
const EID_BSC    = dep.lzEidBscTestnet as number;
const EID_SEP    = dep.lzEidSepolia    as number;

// ── BSC: 部署新 Executor + DealFactory ───────────────────────────────────────
console.log("═══════════ BSC Testnet ═══════════");
const { viem: bscViem } = await (network as any).connect({ network: "bscTestnet", chainType: "l1" });
const bscPub  = await bscViem.getPublicClient();
const [bscDep] = await bscViem.getWalletClients();
const bscAddr  = bscDep.account.address as Address;
console.log(`Deployer: ${bscAddr}  (${formatEther(await bscPub.getBalance({ address: bscAddr }))} BNB)`);

// 1. New Executor (with allowedTargets whitelist)
console.log("\n[1] Deploy LZGovernanceExecutor (audited)...");
const execTx = await bscDep.deployContract({
  abi:      loadAbi("bridge/LZGovernanceExecutor.sol/LZGovernanceExecutor.json"),
  bytecode: loadBytecode("bridge/LZGovernanceExecutor.sol/LZGovernanceExecutor.json"),
  args:     [LZ_ENDPOINT_BSC, bscAddr],
});
await waitFor(bscPub, execTx, "Executor deploy");
const execR     = await bscPub.waitForTransactionReceipt({ hash: execTx });
const EXECUTOR  = execR.contractAddress as Address;
console.log(`  Executor: ${EXECUTOR}`);

// 2. New DealFactory proxy (owner = new executor)
console.log("\n[2] Deploy DealFactory (UUPS proxy, owner=executor)...");
const factoryAbi      = loadAbi("DealFactory.sol/DealFactory.json");
const factoryBytecode = loadBytecode("DealFactory.sol/DealFactory.json");
const proxyAbi        = loadAbi("TestProxy.sol/ERC1967Proxy.json");
const proxyBytecode   = loadBytecode("TestProxy.sol/ERC1967Proxy.json");

const implTx = await bscDep.deployContract({ abi: factoryAbi, bytecode: factoryBytecode, args: [] });
await waitFor(bscPub, implTx, "DealFactory impl deploy");
const implR  = await bscPub.waitForTransactionReceipt({ hash: implTx });
const IMPL   = implR.contractAddress as Address;

const initData = encodeFunctionData({
  abi: factoryAbi, functionName: "initialize",
  args: [bscAddr, bscAddr, 3600n], // placeholder impls, min timeout
});
const proxyTx = await bscDep.deployContract({
  abi: proxyAbi, bytecode: proxyBytecode, args: [IMPL, initData],
});
await waitFor(bscPub, proxyTx, "DealFactory proxy deploy");
const proxyR  = await bscPub.waitForTransactionReceipt({ hash: proxyTx });
const FACTORY = proxyR.contractAddress as Address;
console.log(`  Factory: ${FACTORY}`);

// Transfer factory ownership to executor
{
  const h = await bscDep.writeContract({
    address: FACTORY, abi: factoryAbi,
    functionName: "transferOwnership", args: [EXECUTOR],
  });
  await waitFor(bscPub, h, `DealFactory.transferOwnership(${EXECUTOR})`);
}

const execAbi = loadAbi("bridge/LZGovernanceExecutor.sol/LZGovernanceExecutor.json");

// 3. setAllowedTarget(DealFactory) — KEY new step after audit
console.log("\n[3] Executor.setAllowedTarget(DealFactory, true)...");
{
  const h = await bscDep.writeContract({
    address: EXECUTOR, abi: execAbi,
    functionName: "setAllowedTarget", args: [FACTORY, true],
  });
  await waitFor(bscPub, h, "setAllowedTarget(DealFactory)");
}

// Verify
const allowed = await bscPub.readContract({
  address: EXECUTOR, abi: execAbi, functionName: "allowedTargets", args: [FACTORY],
});
console.log(`  allowedTargets[DealFactory] = ${allowed} ✓`);

// ── Sepolia: 部署新 Dispatcher ────────────────────────────────────────────────
console.log("\n═══════════ Sepolia ═══════════");
const { viem: sepViem } = await (network as any).connect({ network: "sepolia", chainType: "l1" });
const sepPub  = await sepViem.getPublicClient();
const [sepDep] = await sepViem.getWalletClients();
const sepAddr  = sepDep.account.address as Address;
console.log(`Deployer: ${sepAddr}  (${formatEther(await sepPub.getBalance({ address: sepAddr }))} ETH)`);

// 4. New Dispatcher (tx.origin→msg.sender, zero checks, receive())
console.log("\n[4] Deploy LZGovernanceDispatcher (audited)...");
const dispAbi = loadAbi("bridge/LZGovernanceDispatcher.sol/LZGovernanceDispatcher.json");
const dispTx = await sepDep.deployContract({
  abi:      dispAbi,
  bytecode: loadBytecode("bridge/LZGovernanceDispatcher.sol/LZGovernanceDispatcher.json"),
  args:     [LZ_ENDPOINT_SEP, sepAddr, GOV_PROXY],
});
await waitFor(sepPub, dispTx, "Dispatcher deploy");
const dispR      = await sepPub.waitForTransactionReceipt({ hash: dispTx });
const DISPATCHER = dispR.contractAddress as Address;
console.log(`  Dispatcher: ${DISPATCHER}`);

// ── Wire peers ────────────────────────────────────────────────────────────────
console.log("\n═══════════ Wiring peers ═══════════");

// Dispatcher → Executor
{
  const h = await sepDep.writeContract({
    address: DISPATCHER, abi: dispAbi,
    functionName: "setPeer", args: [EID_BSC, toBytes32(EXECUTOR)],
  });
  await waitFor(sepPub, h, `Dispatcher.setPeer(BSC=${EID_BSC}, executor)`);
}

// Executor → Dispatcher
{
  const h = await bscDep.writeContract({
    address: EXECUTOR, abi: execAbi,
    functionName: "setPeer", args: [EID_SEP, toBytes32(DISPATCHER)],
  });
  await waitFor(bscPub, h, `Executor.setPeer(SEP=${EID_SEP}, dispatcher)`);
}

// ── Update JSON ───────────────────────────────────────────────────────────────
dep.lzDispatcher      = DISPATCHER;
dep.lzExecutor        = EXECUTOR;
dep.dealFactoryBsc    = FACTORY;
dep.dealFactoryImplBsc = IMPL;
delete dep.dealFactoryImplBscV2;
writeFileSync(DEPLOYMENT_FILE, JSON.stringify(dep, null, 2));

console.log("\n═══════════════════════════════════════════════════════");
console.log("全部部署 + 接线完成（审计修复版本）");
console.log(`  Dispatcher:  ${DISPATCHER}  (Sepolia)`);
console.log(`  Executor:    ${EXECUTOR}  (BSC)`);
console.log(`  DealFactory: ${FACTORY}  (BSC, owner=executor)`);
console.log("\n下一步：");
console.log("  npx hardhat run scripts/test-param-change.ts");
console.log("  npx hardhat run scripts/test-upgrade.ts");
console.log("═══════════════════════════════════════════════════════");
