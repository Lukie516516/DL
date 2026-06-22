/**
 * deploy-governance-v4.ts
 *
 * 升级 DealGovernance 至 v4：新增集体否决（vetoStake）功能。
 *
 * 变更摘要：
 *   - 新增 vetoStakeOf / totalVetoStaked 两个 mapping
 *   - 新增 vetoStake(proposalId, amount) 函数：任何人可分次投否决票，
 *     累计达到 activationThreshold（2.5 D）即触发否决，D 被锁定
 *   - claimBack() 同时退还支持票和否决票
 *   - 修复 phantom contribution bug：claimBack 时同步扣减 totalVetoStaked
 *
 * 部署策略：
 *   _authorizeUpgrade 要求 msg.sender == address(this)，只能通过治理提案升级，
 *   因此采用和 v3 相同的方式：重新部署 impl + proxy，然后接线。
 *
 * 接线（deployer 直接执行，无需提案）：
 *   1. CrossChainDispatcher.setGovernance(newProxy)
 *   2. NftVetoRegistry.setGovernor(oldProxy, false) → setGovernor(newProxy, true)
 *   3. VoteDividendClaimer.setGovernanceContract(newProxy)
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

// ── 当前链上地址（不变）────────────────────────────────────────────────────────
const CURRENT = {
  dToken:               "0xa57b99e48f2fc24282e8f263d24468a51c5242db" as Address,
  dlToken:              "0x802c43662c38aad9b4299c2f723a6b16f228217a" as Address,
  treasury:             "0xe88c63d29ece76e3336b0db747e10876c3bf9893" as Address,
  oldGovernanceProxy:   "0x281B18d6755869A0552088ef190ED9BBcceAfA1C" as Address,
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
  const gasOpts = { gasPrice: parseGwei(process.env.AGIKING_GAS_PRICE_GWEI ?? "12") };
  const chain   = agikingChain(rpcUrl);

  const { viem } = await network.connect({ network: "agiking", chainType: "l1" }) as unknown as { viem: any };
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer]   = await viem.getWalletClients({ chain });
  const client       = { public: publicClient, wallet: deployer } as const;
  const dep          = deployer.account.address as Address;

  console.log("Chain", AGIKING_CHAIN_ID, "deployer", dep);
  console.log("Balance", formatEther(await publicClient.getBalance({ address: dep })), "AGI");

  // ── 1. 编译检查 ─────────────────────────────────────────────────────────────
  console.log("\n=== 1. Pre-flight: 确认 vetoStake 存在于 artifact ===");
  const govAbi = loadAbi("DealGovernance.sol/DealGovernance.json");
  const hasVetoStake     = govAbi.some((x: any) => x.name === "vetoStake"     && x.type === "function");
  const hasVetoStakeOf   = govAbi.some((x: any) => x.name === "vetoStakeOf"   && x.type === "function");
  const hasTotalVeto     = govAbi.some((x: any) => x.name === "totalVetoStaked" && x.type === "function");
  const hasVetoStakedEvt = govAbi.some((x: any) => x.name === "VetoStaked"    && x.type === "event");
  if (!hasVetoStake || !hasVetoStakeOf || !hasTotalVeto || !hasVetoStakedEvt) {
    throw new Error("ABI 缺少 vetoStake 相关成员，请先运行 npx hardhat compile");
  }
  console.log("  ✓ vetoStake / vetoStakeOf / totalVetoStaked / VetoStaked 均存在");

  // ── 2. 部署新 DealGovernance 实现合约 ──────────────────────────────────────
  console.log("\n=== 2. Deploy DealGovernance v4 impl ===");
  const implContract = await viem.deployContract("DealGovernance", [], { client, ...gasOpts });
  const implAddress  = getAddress(implContract.address) as Address;
  console.log("  impl:", implAddress);

  // ── 3. 部署新 ERC1967Proxy ────────────────────────────────────────────────
  console.log("\n=== 3. Deploy ERC1967Proxy ===");
  const initData = encodeFunctionData({
    abi: implContract.abi,
    functionName: "initialize",
    args: [
      CURRENT.dToken,
      zeroAddress,        // nftVetoRegistry 保持关闭
      CURRENT.dlToken,
      CURRENT.treasury,
    ],
  });
  const proxyContract = await viem.deployContract("ERC1967Proxy", [implAddress, initData], { client, ...gasOpts });
  const proxyAddress  = getAddress(proxyContract.address) as Address;
  console.log("  proxy:", proxyAddress);

  // ── 4. 参数验证 ─────────────────────────────────────────────────────────────
  console.log("\n=== 4. 验证初始化参数 ===");
  const governance   = await viem.getContractAt("DealGovernance", proxyAddress, { client });
  const actThresh    = await governance.read.activationThreshold();
  const fpThresh     = await governance.read.fastPassThreshold();
  const majFee       = await governance.read.majorProposalFee();
  console.log("  activationThreshold:", actThresh.toString(), "(expect 2500000000000000000)");
  console.log("  fastPassThreshold:  ", fpThresh.toString(),  "(expect 70000000000000000000)");
  console.log("  majorProposalFee:   ", majFee.toString(),    "(expect 1000000000000000000000)");
  if (actThresh !== 25n * 10n ** 17n) throw new Error("activationThreshold mismatch");
  if (fpThresh  !== 70n * 10n ** 18n) throw new Error("fastPassThreshold mismatch");
  if (majFee    !== 1000n * 10n ** 18n) throw new Error("majorProposalFee mismatch");

  // 验证 vetoStake 接口可调用（只读，发地址 0 不会 revert）
  const vetoTotal = await governance.read.totalVetoStaked([0n]);
  console.log("  totalVetoStaked(0):", vetoTotal.toString(), "(expect 0)");

  // ── 5. 接线 ───────────────────────────────────────────────────────────────
  console.log("\n=== 5. 接线 ===");

  const dispatcher = await viem.getContractAt("CrossChainDispatcher", CURRENT.crossChainDispatcher, { client });
  await waitFor(publicClient,
    await dispatcher.write.setGovernance([proxyAddress], gasOpts),
    "CrossChainDispatcher.setGovernance",
  );

  const nftVetoReg = await viem.getContractAt("NftVetoRegistry", CURRENT.nftVetoRegistry, { client });
  await waitFor(publicClient,
    await nftVetoReg.write.setGovernor([CURRENT.oldGovernanceProxy, false], gasOpts),
    "NftVetoRegistry.setGovernor(old, false)",
  );
  await waitFor(publicClient,
    await nftVetoReg.write.setGovernor([proxyAddress, true], gasOpts),
    "NftVetoRegistry.setGovernor(new, true)",
  );

  const voteClaimer = await viem.getContractAt("VoteDividendClaimer", CURRENT.voteDividendClaimer, { client });
  await waitFor(publicClient,
    await voteClaimer.write.setGovernanceContract([proxyAddress], gasOpts),
    "VoteDividendClaimer.setGovernanceContract",
  );

  // ── 6. 更新 deployments JSON ──────────────────────────────────────────────
  console.log("\n=== 6. 更新部署文件 ===");
  const deployedAt = new Date().toISOString();
  const dir        = join(process.cwd(), "deployments");
  const filePath   = join(dir, DEPLOYMENT_FILE);
  mkdirSync(join(dir, "backups"), { recursive: true });

  const existing = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, any>;
  const stamp    = deployedAt.replace(/[-:T]/g, "").slice(0, 14);
  if (existsSync(filePath)) {
    copyFileSync(filePath, join(dir, "backups", `agiking-31415926.before-gov-v4-${stamp}.json`));
  }

  existing.addresses["dealGovernance"]     = proxyAddress;
  existing.addresses["dealGovernanceImpl"] = implAddress;
  existing.abi = existing.abi ?? {};
  existing.abi["DealGovernance"] = govAbi;
  existing.deployedAt = deployedAt;
  existing.upgrade    = "v4-veto-stake";
  existing.notes = [
    ...(existing.notes ?? []),
    `[${deployedAt}] DealGovernance v4: proxy=${proxyAddress} impl=${implAddress} (vetoStake feature)`,
  ];

  writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf8");
  console.log("  Updated:", filePath);

  // ── 完成 ──────────────────────────────────────────────────────────────────
  console.log("\n=== 完成 ===");
  console.log("  新 proxy  :", proxyAddress);
  console.log("  新 impl   :", implAddress);
  console.log("  旧 proxy  :", CURRENT.oldGovernanceProxy, "(已废弃)");

  // 输出供 health-check 和前端使用
  process.env["NEW_GOV_PROXY"] = proxyAddress;
  process.env["NEW_GOV_IMPL"]  = implAddress;
}

await main().catch(err => { console.error(err); process.exitCode = 1; });
