/**
 * Redeploy the domain trading entry contracts for open domain access.
 *
 * Scope:
 * - new DCDomainRank, because visitor/merchant restrictions are removed
 * - new DCDomainSwap and DCDomainHall, both wired to the new Rank
 * - existing DCDomain, DCDomainMarket, DealFactory and core Deal stack are reused
 */
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, formatEther, getAddress, isAddress, type Address } from "viem";

const AGIKING_CHAIN_ID = 31415926;
const DEPLOYMENT_FILE = "agiking-31415926.json";

type DeploymentJson = {
  chainId: number;
  rpcUrl: string;
  deployedAt: string;
  deployer: Address;
  previousDeployment?: string;
  upgrade?: string;
  addresses: Record<string, Address>;
  abi: Record<string, unknown[]>;
  notes?: string[];
};

function agikingChain(rpcUrl: string) {
  return defineChain({
    id: AGIKING_CHAIN_ID,
    name: "Agiking",
    nativeCurrency: { decimals: 18, name: "Native", symbol: "NATIVE" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function loadAbi(relativeArtifactJson: string): unknown[] {
  const p = join(process.cwd(), "artifacts", "contracts", relativeArtifactJson);
  return (JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[] }).abi;
}

async function waitFor(publicClient: any, hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
  return receipt;
}

async function tx(label: string, publicClient: any, hashPromise: Promise<`0x${string}`>) {
  const hash = await hashPromise;
  await waitFor(publicClient, hash);
  console.log(`  OK ${label}: ${hash}`);
}

function writeHandoff(file: string, deployedAt: string, deployer: Address, addresses: Record<string, Address>) {
  const md = `# 域名大厅开放参与部署交接

部署时间：${deployedAt}

部署钱包：\`${deployer}\`

链：Agiking \`${AGIKING_CHAIN_ID}\`

## 本次新部署地址

| 模块 | 地址 | 前端用途 |
| --- | --- | --- |
| DCDomainRank | \`${addresses.dcDomainRank}\` | 域名有效用户、黑名单、排行榜；visitor 入口仅兼容 |
| DCDomainRankReader | \`${addresses.dcDomainRankReader}\` | 域名排行榜分页、deal 精确搜索/终局详情，只读 helper |
| DCDomainSwap | \`${addresses.dcDomainSwap}\` | 域名下创建币币 deal，支持身份 NFT 参数 |
| DCDomainHall | \`${addresses.dcDomainHall}\` | 域名大厅单；不再区分 visitor/merchant |

## 复用地址

| 模块 | 地址 |
| --- | --- |
| DCDomain | \`${addresses.dcDomain}\` |
| DCDomainMarket | \`${addresses.dcDomainMarket}\` |
| DealFactory | \`${addresses.dealFactory}\` |
| DealReader | \`${addresses.dealReader}\` |
| DealMessageHub | \`${addresses.dealMessageHub}\` |
| DealInfoNFT | \`${addresses.dealInfoNFT}\` |
| DL Token | \`${addresses.dlToken}\` |

## 前端接线

1. 域名有效用户/排行榜查询切到新的 \`DCDomainRank\`。
2. 域名普通币币入口切到新的 \`DCDomainSwap\`。
3. 域名大厅入口切到新的 \`DCDomainHall\`。
4. 域名排行榜分页和终局 deal 精确搜索调用新的 \`DCDomainRankReader\`：\`getLeaderboard\`、\`domainEntryCount\`、\`getDomainDealInfo\`。
5. ABI 使用 \`deployments/${DEPLOYMENT_FILE}\` 里的 \`DCDomainRank\`、\`DCDomainRankReader\`、\`DCDomainSwap\`、\`DCDomainHall\`。
6. 大厅不再要求 visitor/merchant 身份；前端不需要 enterDomain/leaveVisitor，只需要按黑名单和有效域名判断。

## 链上接线

- \`DealFactory.setAllowedCreateFor(DCDomainSwap, true)\` 已完成。
- \`DealFactory.setAllowedCreateFor(DCDomainHall, true)\` 已完成。
- \`DCDomainRank.setDealReporter(DCDomainSwap, true)\` 已完成。
- \`DCDomainRank.setDealReporter(DCDomainHall, true)\` 已完成。
- \`DCDomainSwap.replaceTimeoutSeconds()\` 校验为 \`120\` 秒。

## 注意

这次重部署了 \`DCDomainRank\`，新的排行榜和广告充值状态从新 Rank 开始记录；visitor 状态不再作为业务权限。域名 NFT、域名 Market、DealFactory、DealReader、MessageHub、InfoNFT 没有重部署。
`;
  writeFileSync(file, md, "utf8");
}

function removeOldDeploymentHandoffs(dir: string, keepFile: string) {
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("frontend-handoff-") || !name.endsWith(".md")) continue;
    const file = join(dir, name);
    if (file === keepFile) continue;
    rmSync(file);
    console.log("Removed old handoff:", file);
  }
}

async function main() {
  const rpcUrl = process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop";
  const chain = agikingChain(rpcUrl.trim());

  const dir = join(process.cwd(), "deployments");
  const currentFile = join(dir, DEPLOYMENT_FILE);
  const current = JSON.parse(readFileSync(currentFile, "utf8")) as DeploymentJson;
  const oldAddresses = current.addresses;

  const { viem } = await network.connect({ network: "agiking", chainType: "l1" });
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer] = await viem.getWalletClients({ chain });
  const client = { public: publicClient, wallet: deployer } as const;
  const dep = getAddress(deployer.account.address) as Address;
  const balance = await publicClient.getBalance({ address: dep });

  console.log("Chain:", chain.id);
  console.log("Deployer:", dep);
  console.log("Native balance:", formatEther(balance));
  if (balance === 0n) throw new Error("Deployer has zero native balance; cannot pay deployment gas.");

  console.log("\n--- Deploy DCDomainRank ---");
  const resumeRank = process.env.DC_DOMAIN_RANK;
  const rankAddress = resumeRank && isAddress(resumeRank)
    ? (getAddress(resumeRank) as Address)
    : undefined;
  const rank = rankAddress
    ? await viem.getContractAt("DCDomainRank", rankAddress, { client })
    : await viem.deployContract("DCDomainRank", [
        oldAddresses.dlToken,
        oldAddresses.dcDomain,
        dep,
      ], { client });
  console.log("DCDomainRank:", rank.address, rankAddress ? "(resume)" : "");

  console.log("\n--- Deploy DCDomainRankReader ---");
  const resumeRankReader = process.env.DC_DOMAIN_RANK_READER;
  const rankReaderAddress = resumeRankReader && isAddress(resumeRankReader)
    ? (getAddress(resumeRankReader) as Address)
    : undefined;
  const rankReader = rankReaderAddress
    ? await viem.getContractAt("DCDomainRankReader", rankReaderAddress, { client })
    : await viem.deployContract("DCDomainRankReader", [rank.address], { client });
  console.log("DCDomainRankReader:", rankReader.address, rankReaderAddress ? "(resume)" : "");

  console.log("\n--- Deploy DCDomainSwap ---");
  const resumeSwap = process.env.DC_DOMAIN_SWAP;
  const swapAddress = resumeSwap && isAddress(resumeSwap)
    ? (getAddress(resumeSwap) as Address)
    : undefined;
  const swap = swapAddress
    ? await viem.getContractAt("DCDomainSwap", swapAddress, { client })
    : await viem.deployContract("DCDomainSwap", [
        oldAddresses.dcDomain,
        rank.address,
        oldAddresses.dealFactory,
      ], { client });
  console.log("DCDomainSwap:", swap.address, swapAddress ? "(resume)" : "");

  console.log("\n--- Deploy DCDomainHall ---");
  const resumeHall = process.env.DC_DOMAIN_HALL;
  const hallAddress = resumeHall && isAddress(resumeHall)
    ? (getAddress(resumeHall) as Address)
    : undefined;
  const hall = hallAddress
    ? await viem.getContractAt("DCDomainHall", hallAddress, { client })
    : await viem.deployContract("DCDomainHall", [
        rank.address,
        oldAddresses.dcDomain,
        oldAddresses.dealFactory,
      ], { client });
  console.log("DCDomainHall:", hall.address, hallAddress ? "(resume)" : "");

  console.log("\n--- Wire permissions ---");
  const factory = await viem.getContractAt("DealFactory", oldAddresses.dealFactory, { client });
  if (await factory.read.isAllowedCreateFor([swap.address])) {
    console.log("  OK Factory.allow DCDomainSwap: already true");
  } else {
    await tx("Factory.allow DCDomainSwap", publicClient, factory.write.setAllowedCreateFor([swap.address, true]));
  }
  if (await factory.read.isAllowedCreateFor([hall.address])) {
    console.log("  OK Factory.allow DCDomainHall: already true");
  } else {
    await tx("Factory.allow DCDomainHall", publicClient, factory.write.setAllowedCreateFor([hall.address, true]));
  }
  if (await rank.read.isDealReporter([swap.address])) {
    console.log("  OK Rank.reporter DCDomainSwap: already true");
  } else {
    await tx("Rank.reporter DCDomainSwap", publicClient, rank.write.setDealReporter([swap.address, true]));
  }
  if (await rank.read.isDealReporter([hall.address])) {
    console.log("  OK Rank.reporter DCDomainHall: already true");
  } else {
    await tx("Rank.reporter DCDomainHall", publicClient, rank.write.setDealReporter([hall.address, true]));
  }

  console.log("\n--- Verify wiring ---");
  const deployedSwap = await viem.getContractAt("DCDomainSwap", swap.address, { client });
  const replaceTimeout = await deployedSwap.read.replaceTimeoutSeconds();
  const pointedFactory = await deployedSwap.read.FACTORY();
  const pointedRank = await deployedSwap.read.dcRank();
  const hallRank = await (await viem.getContractAt("DCDomainHall", hall.address, { client })).read.rank();
  const hallFactory = await (await viem.getContractAt("DCDomainHall", hall.address, { client })).read.dealFactory();
  const swapReporter = await rank.read.isDealReporter([swap.address]);
  const hallReporter = await rank.read.isDealReporter([hall.address]);
  const swapAllowed = await factory.read.isAllowedCreateFor([swap.address]);
  const hallAllowed = await factory.read.isAllowedCreateFor([hall.address]);

  if (String(replaceTimeout) !== "120") throw new Error("Unexpected DCDomainSwap replaceTimeoutSeconds");
  if (String(pointedFactory).toLowerCase() !== String(oldAddresses.dealFactory).toLowerCase()) {
    throw new Error("DCDomainSwap factory mismatch");
  }
  if (String(pointedRank).toLowerCase() !== String(rank.address).toLowerCase()) {
    throw new Error("DCDomainSwap rank mismatch");
  }
  if (String(hallRank).toLowerCase() !== String(rank.address).toLowerCase()) {
    throw new Error("DCDomainHall rank mismatch");
  }
  if (String(hallFactory).toLowerCase() !== String(oldAddresses.dealFactory).toLowerCase()) {
    throw new Error("DCDomainHall factory mismatch");
  }
  if (!swapReporter || !hallReporter || !swapAllowed || !hallAllowed) {
    throw new Error("Permission verification failed");
  }
  console.log("  OK replaceTimeoutSeconds:", String(replaceTimeout));
  console.log("  OK Factory + Rank pointers and permissions");

  const deployedAt = new Date().toISOString();
  const stamp = deployedAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const backupDir = join(dir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const backupFileName = `agiking-31415926.before-domain-open-access-${stamp}.json`;
  const backupFile = join(backupDir, backupFileName);
  const backupFileRef = `deployments/backups/${backupFileName}`;
  copyFileSync(currentFile, backupFile);

  const addresses: Record<string, Address> = {
    ...oldAddresses,
    dcDomainRank: getAddress(rank.address) as Address,
    dcDomainRankReader: getAddress(rankReader.address) as Address,
    dcDomainSwap: getAddress(swap.address) as Address,
    dcDomainHall: getAddress(hall.address) as Address,
  };

  const priorNotes = (current.notes ?? []).filter((note) =>
    !note.includes("domain-hall-autoswitch") &&
    !note.includes("visitor -> merchant") &&
    !note.includes("auto-switch")
  );

  const updated: DeploymentJson = {
    ...current,
    deployedAt,
    deployer: dep,
    previousDeployment: backupFileRef,
    upgrade: "domain-open-access",
    addresses,
    abi: {
      ...current.abi,
      DCDomainRank: loadAbi("DCdomainrank.sol/DCDomainRank.json"),
      DCDomainRankReader: loadAbi("DCDomainRankReader.sol/DCDomainRankReader.json"),
      DCDomainSwap: loadAbi("DCdomainswap.sol/DCDomainSwap.json"),
      DCDomainHall: loadAbi("DCDomainHall.sol/DCDomainHall.json"),
    },
    notes: [
      ...priorNotes,
      "DCDomainRank, DCDomainSwap and DCDomainHall redeployed for DCDomainHall open domain access.",
      "DCDomain, DCDomainMarket and the core Deal stack are reused.",
    ],
  };

  const snapshotFile = join(dir, `agiking-31415926-${stamp}.json`);
  const handoffFile = join(dir, `frontend-handoff-domain-open-access-${stamp}.md`);
  writeFileSync(currentFile, JSON.stringify(updated, null, 2), "utf8");
  writeFileSync(snapshotFile, JSON.stringify(updated, null, 2), "utf8");
  writeHandoff(handoffFile, deployedAt, dep, addresses);
  removeOldDeploymentHandoffs(dir, handoffFile);

  console.log("\n========== UPDATED ==========");
  console.log("DCDomainRank:", addresses.dcDomainRank);
  console.log("DCDomainRankReader:", addresses.dcDomainRankReader);
  console.log("DCDomainSwap:", addresses.dcDomainSwap);
  console.log("DCDomainHall:", addresses.dcDomainHall);
  console.log("replaceTimeoutSeconds:", String(replaceTimeout));
  console.log("\nWrote:");
  console.log(" ", currentFile);
  console.log(" ", snapshotFile);
  console.log(" ", backupFile);
  console.log(" ", handoffFile);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
