/**
 * deploy-governance-v3.ts
 *
 * 重部署 DealGovernance（impl + proxy）并重新接线。
 *
 * 原因：链上旧 proxy 的 initialize() 未设参数默认值，
 *       activationThreshold 等全部为 0，治理无法使用。
 *       本脚本部署修复版实现 + 新 proxy，并完成 3 笔接线。
 *
 * 接线（deployer 钱包即可，无需治理提案）：
 *   1. CrossChainDispatcher.setGovernance(newProxy)
 *   2. NftVetoRegistry.setGovernor(oldProxy, false)   — 撤销旧权限
 *      NftVetoRegistry.setGovernor(newProxy, true)    — 授权新地址
 *   3. VoteDividendClaimer.setGovernanceContract(newProxy)
 *
 * 部署完成后自动更新 deployments/agiking-31415926.json。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import {
  defineChain, encodeFunctionData, formatEther, getAddress,
  parseGwei, zeroAddress, type Address,
} from "viem";

const AGIKING_CHAIN_ID = 31415926;
const DEPLOYMENT_FILE  = "agiking-31415926.json";

// ── 已有链上地址（不变）────────────────────────────────────────────────────────
const EXISTING = {
  dToken:               "0xa57b99e48f2fc24282e8f263d24468a51c5242db" as Address,
  dlToken:              "0x802c43662c38aad9b4299c2f723a6b16f228217a" as Address, // dcToken for gov fee
  treasury:             "0xe88c63d29ece76e3336b0db747e10876c3bf9893" as Address,
  oldGovernanceProxy:   "0x281b18d6755869a0552088ef190ed9bbcceafa1c" as Address,
  crossChainDispatcher: "0x42a59a08f7ec25c75ab97815981333f18395805b" as Address,
  nftVetoRegistry:      "0xd8ed220604fbf0f861d64caee2cae88c1a7258a8" as Address,
  voteDividendClaimer:  "0xefe550df7bd394c7791aa56f64efc2d938c576f9" as Address,
};

function agikingChain(rpcUrl: string) {
  return defineChain({
    id: AGIKING_CHAIN_ID, name: "Agiking",
    nativeCurrency: { decimals: 18, name: "AGI", symbol: "AGI" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function loadAbi(rel: string): unknown[] {
  return (JSON.parse(readFileSync(
    join(process.cwd(), "artifacts", "contracts", rel), "utf8",
  )) as { abi: unknown[] }).abi;
}

async function waitFor(publicClient: any, hash: `0x${string}`, label: string) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`FAILED: ${label} (${hash})`);
  console.log(`  ✓ ${label}`);
  return receipt;
}

async function main() {
  const rpcUrl  = (process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop").trim();
  const gasOpts = { gasPrice: parseGwei(process.env.AGIKING_GAS_PRICE_GWEI ?? "2") };
  const chain   = agikingChain(rpcUrl);

  const { viem } = await network.connect({ network: "agiking", chainType: "l1" }) as unknown as { viem: any };
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer]   = await viem.getWalletClients({ chain });
  const client       = { public: publicClient, wallet: deployer } as const;
  const dep          = deployer.account.address as Address;

  console.log("Chain", AGIKING_CHAIN_ID, "deployer", dep);
  console.log("Balance", formatEther(await publicClient.getBalance({ address: dep })), "AGI");

  // ── 1. 部署新 DealGovernance 实现合约 ──────────────────────────────────────
  console.log("\n=== 1. Deploy DealGovernance impl ===");
  const implContract = await viem.deployContract("DealGovernance", [], { client, ...gasOpts });
  const implAddress  = getAddress(implContract.address) as Address;
  console.log("  impl:", implAddress);

  // ── 2. 部署新 ERC1967Proxy ────────────────────────────────────────────────
  console.log("\n=== 2. Deploy ERC1967Proxy (new governance proxy) ===");
  const initData = encodeFunctionData({
    abi: implContract.abi,
    functionName: "initialize",
    args: [
      EXISTING.dToken,
      zeroAddress,            // nftVetoRegistry = address(0)，保持关闭
      EXISTING.dlToken,       // dcToken for Major proposal fee
      EXISTING.treasury,
    ],
  });
  const proxyContract  = await viem.deployContract("ERC1967Proxy", [implAddress, initData], { client, ...gasOpts });
  const proxyAddress   = getAddress(proxyContract.address) as Address;
  console.log("  proxy:", proxyAddress);

  // 验证参数写入正确
  const governance = await viem.getContractAt("DealGovernance", proxyAddress, { client });
  const actThresh  = await governance.read.activationThreshold();
  const fpThresh   = await governance.read.fastPassThreshold();
  console.log("  activationThreshold:", actThresh.toString(), "(expect 2500000000000000000)");
  console.log("  fastPassThreshold:  ", fpThresh.toString(),  "(expect 70000000000000000000)");
  if (actThresh !== 25n * 10n ** 17n) throw new Error("activationThreshold mismatch — abort");
  if (fpThresh  !== 70n * 10n ** 18n) throw new Error("fastPassThreshold mismatch — abort");

  // ── 3. 接线 ───────────────────────────────────────────────────────────────
  console.log("\n=== 3. Rewire ===");

  // 3-a. CrossChainDispatcher.setGovernance
  const dispatcher = await viem.getContractAt("CrossChainDispatcher", EXISTING.crossChainDispatcher, { client });
  await waitFor(publicClient,
    await dispatcher.write.setGovernance([proxyAddress], gasOpts),
    "CrossChainDispatcher.setGovernance",
  );

  // 3-b. NftVetoRegistry: 撤销旧 proxy 权限，授权新 proxy
  const nftVetoReg = await viem.getContractAt("NftVetoRegistry", EXISTING.nftVetoRegistry, { client });
  await waitFor(publicClient,
    await nftVetoReg.write.setGovernor([EXISTING.oldGovernanceProxy, false], gasOpts),
    "NftVetoRegistry.setGovernor(old, false)",
  );
  await waitFor(publicClient,
    await nftVetoReg.write.setGovernor([proxyAddress, true], gasOpts),
    "NftVetoRegistry.setGovernor(new, true)",
  );

  // 3-c. VoteDividendClaimer.setGovernanceContract
  const voteClaimer = await viem.getContractAt("VoteDividendClaimer", EXISTING.voteDividendClaimer, { client });
  await waitFor(publicClient,
    await voteClaimer.write.setGovernanceContract([proxyAddress], gasOpts),
    "VoteDividendClaimer.setGovernanceContract",
  );

  // ── 4. 更新 deployments/agiking-31415926.json ─────────────────────────────
  console.log("\n=== 4. Update deployment JSON ===");
  const deployedAt = new Date().toISOString();
  const dir        = join(process.cwd(), "deployments");
  const filePath   = join(dir, DEPLOYMENT_FILE);
  mkdirSync(join(dir, "backups"), { recursive: true });

  const existing = JSON.parse(readFileSync(filePath, "utf8")) as {
    addresses: Record<string, string>;
    abi: Record<string, unknown[]>;
    [k: string]: unknown;
  };

  const stamp = deployedAt.replace(/[-:T]/g, "").slice(0, 14);
  if (existsSync(filePath)) {
    copyFileSync(filePath, join(dir, "backups", `agiking-31415926.before-gov-v3-${stamp}.json`));
  }

  existing.addresses["dealGovernance"]     = proxyAddress;
  existing.addresses["dealGovernanceImpl"] = implAddress;
  existing.abi["DealGovernance"]           = loadAbi("DealGovernance.sol/DealGovernance.json");

  const updated = {
    ...existing,
    deployedAt,
    upgrade: "v3-governance",
    notes: [
      ...(existing.notes as string[] ?? []),
      `[${deployedAt}] DealGovernance redeployed (v3): proxy=${proxyAddress} impl=${implAddress}`,
      "v3 fixes: initialize() now sets all defaults; adds approve() fast-pass; Pending-stage veto; Satoshi unstake-after-pass.",
    ],
  };

  writeFileSync(filePath, JSON.stringify(updated, null, 2), "utf8");
  console.log("  Updated", filePath);

  // ── 完成 ──────────────────────────────────────────────────────────────────
  console.log("\n=== Done ===");
  console.log("  新 DealGovernance proxy :", proxyAddress);
  console.log("  新 DealGovernance impl  :", implAddress);
  console.log("  旧 proxy（已废弃）      :", EXISTING.oldGovernanceProxy);
  console.log("\n前端需要更新的地址：");
  console.log(`  dealGovernance     = ${proxyAddress}`);
  console.log(`  dealGovernanceImpl = ${implAddress}`);
  console.log("\n所有 DAO 功能现已可用：");
  console.log("  - Parameter / Major / Treasury / Satoshi 提案");
  console.log("  - Pending 阶段否决（pre-veto）");
  console.log("  - 快速通过（approve() 累计 >= 70D）");
  console.log("  - Satoshi 通过后自由撤票不影响执行");
}

await main().catch(err => { console.error(err); process.exitCode = 1; });
