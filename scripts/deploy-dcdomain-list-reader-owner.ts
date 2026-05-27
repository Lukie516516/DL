/**
 * Redeploy only DCDomainListReader after adding current-owner domain queries.
 *
 * Scope:
 * - new DCDomainListReader address + ABI
 * - existing DCDomain, DCDomainRank and all deal/domain state are reused
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, formatEther, getAddress, type Address } from "viem";

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

function writeHandoff(file: string, deployedAt: string, deployer: Address, addresses: Record<string, Address>) {
  const md = `# DCDomainListReader 当前持有人查询部署交接

部署时间：${deployedAt}

部署钱包：\`${deployer}\`

链：Agiking \`${AGIKING_CHAIN_ID}\`

## 本次新部署地址

| 模块 | 地址 | 前端用途 |
| --- | --- | --- |
| DCDomainListReader | \`${addresses.dcDomainListReader}\` | 域名列表分页、默认成交额排序、域名搜索、当前持有人“我的域名” |

## 复用地址

| 模块 | 地址 |
| --- | --- |
| DCDomain | \`${addresses.dcDomain}\` |
| DCDomainRank | \`${addresses.dcDomainRank}\` |
| DCDomainSwap | \`${addresses.dcDomainSwap}\` |
| DCDomainHall | \`${addresses.dcDomainHall}\` |

## 前端接线

1. “我的域名”改调用 \`DCDomainListReader.getDomainsByOwner(owner, offset, limit)\`。
2. \`owner\` 传当前钱包地址，返回该地址当前持有的域名 NFT。
3. \`getDomainsByCreator(creator, offset, limit)\` 继续保留，但它是首次注册创建者历史口径，不适合“我的域名”。
4. 默认域名列表仍调用 \`getDomainsByVolume(offset, limit)\`。
5. 名称/ID/解析地址搜索仍调用 \`getDomainByName\`、\`getDomainById\`、\`getDomainsByResolve\`。
6. 单次 \`limit\` 范围仍是 \`1..50\`。

## ABI

完整地址和 ABI 已写入：

\`\`\`text
deployments/${DEPLOYMENT_FILE}
\`\`\`

## 重部署范围

只重部署 \`DCDomainListReader\`。

\`DCDomain\`、\`DCDomainRank\`、\`DCDomainSwap\`、\`DCDomainHall\`、\`DealFactory\` 均未重部署，链上域名和排行榜状态不迁移、不丢失。
`;
  writeFileSync(file, md, "utf8");
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

  console.log("\n--- Deploy DCDomainListReader ---");
  const listReader = await viem.deployContract("DCDomainListReader", [
    oldAddresses.dcDomain,
    oldAddresses.dcDomainRank,
  ], { client });
  console.log("DCDomainListReader:", listReader.address);

  const deployed = await viem.getContractAt("DCDomainListReader", listReader.address, { client });
  const domainPointer = await deployed.read.dcDomain();
  const rankPointer = await deployed.read.rank();
  if (String(domainPointer).toLowerCase() !== String(oldAddresses.dcDomain).toLowerCase()) {
    throw new Error("DCDomainListReader dcDomain mismatch");
  }
  if (String(rankPointer).toLowerCase() !== String(oldAddresses.dcDomainRank).toLowerCase()) {
    throw new Error("DCDomainListReader rank mismatch");
  }
  console.log("  OK pointers");

  const deployedAt = new Date().toISOString();
  const stamp = deployedAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const backupDir = join(dir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const backupFileName = `agiking-31415926.before-domain-list-reader-owner-${stamp}.json`;
  const backupFile = join(backupDir, backupFileName);
  const backupFileRef = `deployments/backups/${backupFileName}`;
  copyFileSync(currentFile, backupFile);

  const addresses: Record<string, Address> = {
    ...oldAddresses,
    dcDomainListReader: getAddress(listReader.address) as Address,
  };

  const priorNotes = current.notes ?? [];
  const updated: DeploymentJson = {
    ...current,
    deployedAt,
    deployer: dep,
    previousDeployment: backupFileRef,
    upgrade: "domain-list-reader-owner-query",
    addresses,
    abi: {
      ...current.abi,
      DCDomainListReader: loadAbi("DCDomainListReader.sol/DCDomainListReader.json"),
    },
    notes: [
      ...priorNotes,
      "DCDomainListReader redeployed with getDomainsByOwner(owner, offset, limit) for current-holder domain lists.",
    ],
  };

  const snapshotFile = join(dir, `agiking-31415926-${stamp}.json`);
  const handoffFile = join(dir, `frontend-handoff-domain-list-reader-owner-${stamp}.md`);
  writeFileSync(currentFile, JSON.stringify(updated, null, 2), "utf8");
  writeFileSync(snapshotFile, JSON.stringify(updated, null, 2), "utf8");
  writeHandoff(handoffFile, deployedAt, dep, addresses);

  console.log("\n========== UPDATED ==========");
  console.log("DCDomainListReader:", addresses.dcDomainListReader);
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
