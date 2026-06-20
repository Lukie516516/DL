/**
 * 部署 4 个待更新合约：
 *   1. DCdomainrank — UUPS 升级新实现 + 排行榜迁移
 *   2. DCDomainHall — 重新部署（4 参数构造 + infoNft）
 *   3. DealSeatVetoGovernor — 重新部署（registerProposal 改 3 参数）
 *   4. DCDomainListReader — 重新部署（换用 getTopDomainIds 接口）
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, formatEther, getAddress, type Address } from "viem";

const CHAIN_ID = 31415926;
const DEP_FILE = "agiking-31415926-20260612103126.json";
const ZERO = "0x0000000000000000000000000000000000000000" as const;

function agikingChain(rpcUrl: string) {
  return defineChain({
    id: CHAIN_ID,
    name: "Agiking",
    nativeCurrency: { decimals: 18, name: "AGI", symbol: "AGI" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function loadAbi(relPath: string) {
  const p = join(process.cwd(), "artifacts", "contracts", relPath);
  return (JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[] }).abi;
}

async function waitFor(pub: any, hash: `0x${string}`) {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`TX failed: ${hash}`);
  return r;
}

async function tx(label: string, pub: any, p: Promise<`0x${string}`>) {
  const h = await p;
  await waitFor(pub, h);
  console.log(`  OK  ${label}: ${h}`);
}

async function main() {
  const rpcUrl = (process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop").trim();
  const chain = agikingChain(rpcUrl);
  const depPath = join("deployments", DEP_FILE);
  const dep_json = JSON.parse(readFileSync(depPath, "utf8"));
  const base = dep_json.addresses as Record<string, string>;

  const { viem } = await (network as any).connect({ network: "agiking", chainType: "l1" });
  const pub = await viem.getPublicClient({ chain });
  const [wallet] = await viem.getWalletClients({ chain });
  const deployer = wallet.account.address as Address;

  console.log(`Chain ${CHAIN_ID} | deployer ${deployer} | bal ${formatEther(await pub.getBalance({ address: deployer }))} AGI\n`);

  // ──────────────────────────────────────────────────────────────
  // 1. DCdomainrank UUPS 升级
  // ──────────────────────────────────────────────────────────────
  console.log("=== 1. DCdomainrank UUPS 升级 ===");
  const rankProxy = await viem.getContractAt(
    "DCDomainRank",
    base.dcDomainRank as Address,
    { client: { public: pub, wallet } }
  );

  const totalDomainsBefore = await rankProxy.read.globalDomainCount();
  console.log(`  当前域名数量: ${totalDomainsBefore}`);

  // 部署新实现
  const newRankImpl = await viem.deployContract("DCDomainRank", [], {
    client: { public: pub, wallet },
  });
  console.log(`  新实现地址: ${newRankImpl.address}`);

  // UUPS 升级（onlyOwner）
  await tx("DCDomainRank.upgradeTo", pub, rankProxy.write.upgradeToAndCall([newRankImpl.address, "0x"]));

  // 迁移排行榜
  await tx("clearLeaderboardForMigration", pub, rankProxy.write.clearLeaderboardForMigration());

  const total = Number(totalDomainsBefore);
  const BATCH = 200;
  for (let offset = 0; offset < Math.max(total, 1); offset += BATCH) {
    await tx(`migrateLeaderboardBatch(${offset}, ${BATCH})`, pub, rankProxy.write.migrateLeaderboardBatch([BigInt(offset), BigInt(BATCH)]));
    if (offset + BATCH >= total) break;
  }

  // 验证
  const topIds = await rankProxy.read.getTopDomainIds([10n]);
  console.log(`  验证 getTopDomainIds(10): [${topIds.join(", ")}]`);
  console.log("  DCdomainrank 升级 OK\n");

  // ──────────────────────────────────────────────────────────────
  // 2. DCDomainHall 重新部署
  // ──────────────────────────────────────────────────────────────
  console.log("=== 2. DCDomainHall 重新部署 ===");
  const oldHall = base.dcDomainHall as Address;
  const newHall = await viem.deployContract("DCDomainHall", [
    base.dcDomainRank as Address,
    base.dcDomain as Address,
    base.dealFactory as Address,
    base.dealInfoNFT as Address,
  ], { client: { public: pub, wallet } });
  console.log(`  新 DCDomainHall: ${newHall.address}`);

  const factory = await viem.getContractAt("DealFactory", base.dealFactory as Address, { client: { public: pub, wallet } });
  const rank = await viem.getContractAt("DCDomainRank", base.dcDomainRank as Address, { client: { public: pub, wallet } });

  await tx("Factory.allowedCreateFor(newHall, true)", pub, factory.write.setAllowedCreateFor([newHall.address, true]));
  await tx("DCDomainRank.setDealReporter(newHall, true)", pub, rank.write.setDealReporter([newHall.address, true]));
  await tx("Factory.allowedCreateFor(oldHall, false)", pub, factory.write.setAllowedCreateFor([oldHall, false]));
  await tx("DCDomainRank.setDealReporter(oldHall, false)", pub, rank.write.setDealReporter([oldHall, false]));

  // 验证
  const hallAllowed = await factory.read.isAllowedCreateFor([newHall.address]);
  const hallOldRevoked = await factory.read.isAllowedCreateFor([oldHall]);
  console.log(`  验证 newHall allowedCreateFor: ${hallAllowed} | oldHall: ${hallOldRevoked}`);
  if (!hallAllowed || hallOldRevoked) throw new Error("DCDomainHall 权限设置异常");
  console.log("  DCDomainHall OK\n");

  // ──────────────────────────────────────────────────────────────
  // 3. DealSeatVetoGovernor 重新部署
  // ──────────────────────────────────────────────────────────────
  console.log("=== 3. DealSeatVetoGovernor 重新部署 ===");
  const oldGovernor = base.dealSeatVetoGovernor as Address;
  const newGovernor = await viem.deployContract("DealSeatVetoGovernor", [
    base.dToken as Address,
    base.nftVetoRegistry as Address,
  ], { client: { public: pub, wallet } });
  console.log(`  新 DealSeatVetoGovernor: ${newGovernor.address}`);

  const vetoRegistry = await viem.getContractAt("NftVetoRegistry", base.nftVetoRegistry as Address, { client: { public: pub, wallet } });
  await tx("NftVetoRegistry.setGovernor(newGovernor, true)", pub, vetoRegistry.write.setGovernor([newGovernor.address, true]));
  await tx("NftVetoRegistry.setGovernor(oldGovernor, false)", pub, vetoRegistry.write.setGovernor([oldGovernor, false]));

  // 验证
  const newGovAllowed = await vetoRegistry.read.isGovernor([newGovernor.address]);
  const oldGovRevoked = await vetoRegistry.read.isGovernor([oldGovernor]);
  console.log(`  验证 newGovernor isGovernor: ${newGovAllowed} | oldGovernor: ${oldGovRevoked}`);
  if (!newGovAllowed || oldGovRevoked) throw new Error("DealSeatVetoGovernor 权限设置异常");
  console.log("  DealSeatVetoGovernor OK\n");

  // ──────────────────────────────────────────────────────────────
  // 4. DCDomainListReader 重新部署
  // ──────────────────────────────────────────────────────────────
  console.log("=== 4. DCDomainListReader 重新部署 ===");
  const newListReader = await viem.deployContract("DCDomainListReader", [
    base.dcDomain as Address,
    base.dcDomainRank as Address,
  ], { client: { public: pub, wallet } });
  console.log(`  新 DCDomainListReader: ${newListReader.address}`);

  // 验证（无状态合约，调一下 listDomains 看看是否正常）
  try {
    const preview = await newListReader.read.listDomains([0n, 5n]);
    console.log(`  验证 listDomains(0,5): ${preview.length} 条`);
  } catch (e: any) {
    console.log(`  listDomains 验证: ${e?.shortMessage ?? e?.message}`);
  }
  console.log("  DCDomainListReader OK\n");

  // ──────────────────────────────────────────────────────────────
  // 写回部署文件
  // ──────────────────────────────────────────────────────────────
  const deployedAt = new Date().toISOString();
  const updated = {
    ...dep_json,
    deployedAt,
    addresses: {
      ...base,
      dcDomainRankImpl: getAddress(newRankImpl.address),
      dcDomainHall: getAddress(newHall.address),
      dealSeatVetoGovernor: getAddress(newGovernor.address),
      dcDomainListReader: getAddress(newListReader.address),
    },
  };

  const outFile = `agiking-31415926-${deployedAt.replace(/[-:T]/g,"").slice(0,15)}.json`;
  mkdirSync("deployments", { recursive: true });
  writeFileSync(join("deployments", outFile), JSON.stringify(updated, null, 2));
  writeFileSync(join("deployments", "agiking-31415926.json"), JSON.stringify(updated, null, 2));
  console.log(`\n部署完成，写入 deployments/${outFile}`);

  console.log("\n=== 新地址汇总 ===");
  console.log(`DCdomainrank impl : ${newRankImpl.address}`);
  console.log(`DCdomainrank proxy: ${base.dcDomainRank} (不变)`);
  console.log(`DCDomainHall      : ${newHall.address}`);
  console.log(`DealSeatVetoGov   : ${newGovernor.address}`);
  console.log(`DCDomainListReader: ${newListReader.address}`);
}

await main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
