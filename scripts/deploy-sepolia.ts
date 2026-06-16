/**
 * deploy-sepolia.ts
 *
 * 在 Sepolia 部署跨链 DAO PoC 的主链合约：
 *   1. D token（ERC-20，1000 D 初始供应）
 *   2. DealGovernance（UUPS proxy）
 *   3. LZGovernanceDispatcher（指向 governance，等待 setPeer）
 *
 * LZ endpoint Sepolia: 0x6EDCE65403992e310A62460808c4b910D972f10f (EID 40161)
 * BSC Testnet EID:  40102
 *
 * 部署后输出地址保存到 deployments/sepolia-11155111.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { parseEther, formatEther, type Address } from "viem";

// ── Constants ────────────────────────────────────────────────────────────────
const LZ_ENDPOINT_SEPOLIA = "0x6EDCE65403992e310A62460808c4b910D972f10f" as Address;
const DEPLOYMENT_FILE      = join(process.cwd(), "deployments", "sepolia-11155111.json");

// ── Helpers ──────────────────────────────────────────────────────────────────
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
const { viem } = await (network as any).connect({ network: "sepolia", chainType: "l1" });
const pub  = await viem.getPublicClient();
const [dep] = await viem.getWalletClients();
const deployer = dep.account.address as Address;
console.log(`Deployer: ${deployer}`);
const bal = await pub.getBalance({ address: deployer });
console.log(`Balance:  ${formatEther(bal)} ETH`);

// ── 1. Deploy D token ────────────────────────────────────────────────────────
// D has fixed supply (100 D max), minted at deploy to initialHolder.
console.log("\n[1] Deploying D token...");
const dTokenTx = await dep.deployContract({
  abi:      loadAbi("D.sol/D.json"),
  bytecode: loadBytecode("D.sol/D.json"),
  args:     [deployer], // initialHolder — receives full 100 D supply
});
await waitFor(pub, dTokenTx, "D deploy tx");
const dTokenR = await pub.waitForTransactionReceipt({ hash: dTokenTx });
const D_ADDR  = dTokenR.contractAddress as Address;
console.log(`  D token: ${D_ADDR}`);

// ── 2. Deploy DealGovernance implementation ──────────────────────────────────
console.log("\n[2] Deploying DealGovernance implementation...");
const govImplTx = await dep.deployContract({
  abi:      loadAbi("DealGovernance.sol/DealGovernance.json"),
  bytecode: loadBytecode("DealGovernance.sol/DealGovernance.json"),
  args:     [],
});
await waitFor(pub, govImplTx, "governance impl deploy");
const govImplR  = await pub.waitForTransactionReceipt({ hash: govImplTx });
const GOV_IMPL  = govImplR.contractAddress as Address;
console.log(`  Impl: ${GOV_IMPL}`);

// ── 3. Deploy ERC1967Proxy wrapping governance ───────────────────────────────
console.log("\n[3] Deploying governance proxy...");
const govAbi   = loadAbi("DealGovernance.sol/DealGovernance.json");
const proxyAbi = loadAbi("TestProxy.sol/ERC1967Proxy.json");

const { encodeFunctionData } = await import("viem");
// initialize(dToken, dlToken, treasury, daoTreasury)
// dlToken = D for PoC (only used for fee burns, not critical)
const initCalldata = encodeFunctionData({
  abi:          govAbi,
  functionName: "initialize",
  args:         [D_ADDR, D_ADDR, deployer, deployer],
});

const proxyTx = await dep.deployContract({
  abi:      proxyAbi,
  bytecode: loadBytecode("TestProxy.sol/ERC1967Proxy.json"),
  args:     [GOV_IMPL, initCalldata],
});
await waitFor(pub, proxyTx, "governance proxy deploy");
const proxyR   = await pub.waitForTransactionReceipt({ hash: proxyTx });
const GOV_PROXY = proxyR.contractAddress as Address;
console.log(`  Proxy: ${GOV_PROXY}`);

// ── 4. Deploy LZGovernanceDispatcher ─────────────────────────────────────────
console.log("\n[4] Deploying LZGovernanceDispatcher...");
const dispatcherTx = await dep.deployContract({
  abi:      loadAbi("bridge/LZGovernanceDispatcher.sol/LZGovernanceDispatcher.json"),
  bytecode: loadBytecode("bridge/LZGovernanceDispatcher.sol/LZGovernanceDispatcher.json"),
  args:     [LZ_ENDPOINT_SEPOLIA, deployer, GOV_PROXY],
});
await waitFor(pub, dispatcherTx, "dispatcher deploy");
const dispatcherR  = await pub.waitForTransactionReceipt({ hash: dispatcherTx });
const DISPATCHER   = dispatcherR.contractAddress as Address;
console.log(`  Dispatcher: ${DISPATCHER}`);

// ── 5. Check D balance ────────────────────────────────────────────────────────
// D has fixed max supply of 100 D — no mint needed.
{
  const dAbi = loadAbi("D.sol/D.json");
  const dBal = await pub.readContract({
    address: D_ADDR, abi: dAbi, functionName: "balanceOf", args: [deployer]
  });
  console.log(`\n[5] D balance: ${formatEther(dBal as bigint)} D (deployer holds full supply)`);
}

// ── 6. Save deployment ────────────────────────────────────────────────────────
const deployment = {
  network:           "sepolia",
  chainId:           11155111,
  deployedAt:        new Date().toISOString(),
  deployer,
  lzEndpoint:        LZ_ENDPOINT_SEPOLIA,
  lzEidSepolia:      40161,
  lzEidBscTestnet:   40102,
  dToken:            D_ADDR,
  dealGovernanceImpl: GOV_IMPL,
  dealGovernance:    GOV_PROXY,
  lzDispatcher:      DISPATCHER,
  // filled after deploy-bsc-testnet.ts:
  lzExecutor:        "",
  mirrorParams:      "",
};

if (!existsSync(join(process.cwd(), "deployments"))) {
  mkdirSync(join(process.cwd(), "deployments"));
}
writeFileSync(DEPLOYMENT_FILE, JSON.stringify(deployment, null, 2));
console.log(`\nDeployment saved → ${DEPLOYMENT_FILE}`);

console.log("\n═══════════════════════════════════════════════════════");
console.log("Sepolia deployment complete. Next steps:");
console.log("  1. Run scripts/deploy-bsc-testnet.ts");
console.log("  2. Run scripts/wire-cross-chain.ts (sets peers on both sides)");
console.log("═══════════════════════════════════════════════════════");
console.log("\nAddresses:");
console.log(`  D token:       ${D_ADDR}`);
console.log(`  Gov impl:      ${GOV_IMPL}`);
console.log(`  Gov proxy:     ${GOV_PROXY}`);
console.log(`  LZ Dispatcher: ${DISPATCHER}`);
