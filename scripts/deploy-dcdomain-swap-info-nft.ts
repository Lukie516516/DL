/**
 * Redeploy only DCDomainSwap against the current Agiking DealFactory.
 *
 * Purpose:
 * - keep the old createDeal(...) entry
 * - add createDealWithInfoNft(..., aNftId)
 * - update deployments/agiking-31415926.json with the new DCDomainSwap ABI/address
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, formatEther, type Address } from "viem";

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

function writeSwapHandoff(file: string, deployedAt: string, deployer: Address, addresses: Record<string, Address>) {
  const md = `# DCDomainSwap 身份 NFT 入口部署交接

部署时间：${deployedAt}

部署钱包：\`${deployer}\`

链：Agiking \`${AGIKING_CHAIN_ID}\`

## 本次更新地址

| 模块 | 地址 | 前端用途 |
| --- | --- | --- |
| DCDomainSwap | \`${addresses.dcDomainSwap}\` | 域名下创建币币 deal；新增 \`createDealWithInfoNft(..., aNftId)\` |
| DealFactory | \`${addresses.dealFactory}\` | 当前 DCDomainSwap 指向的工厂 |
| DCDomainRank | \`${addresses.dcDomainRank}\` | 已授权新 DCDomainSwap reporter |
| DCDomain | \`${addresses.dcDomain}\` | 域名 NFT，复用旧地址 |

## 前端改动

- 不绑定身份 NFT：继续调用旧 \`createDeal(...)\`。
- 绑定 A 的官方身份 NFT：调用 \`createDealWithInfoNft(..., aNftId)\`。
- 完整 ABI 见 \`deployments/${DEPLOYMENT_FILE}\`。
- 说明文档见 \`docs/DCDomainSwap_身份NFT创建说明.md\`。

## 链上接线

- \`DealFactory.setAllowedCreateFor(newDCDomainSwap, true)\` 已完成。
- \`DCDomainRank.setDealReporter(newDCDomainSwap, true)\` 已完成。
- \`DCDomainSwap.replaceTimeoutSeconds()\` 默认仍为 \`120\` 秒。
`;
  writeFileSync(file, md, "utf8");
}

async function main() {
  const rpcUrl = process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop";
  const chain = agikingChain(rpcUrl.trim());

  const currentFile = join(process.cwd(), "deployments", DEPLOYMENT_FILE);
  const current = JSON.parse(readFileSync(currentFile, "utf8")) as DeploymentJson;
  const addresses = { ...current.addresses };

  const { viem } = await network.connect({ network: "agiking", chainType: "l1" });
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer] = await viem.getWalletClients({ chain });
  const client = { public: publicClient, wallet: deployer } as const;
  const dep = deployer.account.address;
  const balance = await publicClient.getBalance({ address: dep });

  console.log("Chain:", chain.id);
  console.log("Deployer:", dep);
  console.log("Native balance:", formatEther(balance));
  if (balance === 0n) throw new Error("Deployer has zero native balance; cannot pay deployment gas.");

  console.log("\n--- Deploy DCDomainSwap with InfoNFT entry ---");
  const dcSwap = await viem.deployContract("DCDomainSwap", [
    addresses.dcDomain,
    addresses.dcDomainRank,
    addresses.dealFactory,
  ], { client });
  console.log("DCDomainSwap:", dcSwap.address);

  const factory = await viem.getContractAt("DealFactory", addresses.dealFactory, { client });
  await tx("Factory.allow DCDomainSwap", publicClient, factory.write.setAllowedCreateFor([dcSwap.address, true]));

  const dcRank = await viem.getContractAt("DCDomainRank", addresses.dcDomainRank, { client });
  await tx("DCDomainRank.setDealReporter(Swap)", publicClient, dcRank.write.setDealReporter([dcSwap.address, true]));

  const swap = await viem.getContractAt("DCDomainSwap", dcSwap.address, { client });
  const replaceTimeout = await swap.read.replaceTimeoutSeconds();
  const pointedFactory = await swap.read.FACTORY();
  if (String(replaceTimeout) !== "120") throw new Error("Unexpected DCDomainSwap replaceTimeoutSeconds");
  if (String(pointedFactory).toLowerCase() !== addresses.dealFactory.toLowerCase()) {
    throw new Error("DCDomainSwap factory mismatch");
  }

  const deployedAt = new Date().toISOString();
  const stamp = deployedAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = join(process.cwd(), "deployments");
  const backupDir = join(dir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const backupFile = join(backupDir, `agiking-31415926.before-dcdomain-swap-info-nft-${stamp}.json`);
  copyFileSync(currentFile, backupFile);

  addresses.dcDomainSwap = dcSwap.address;
  const updated: DeploymentJson = {
    ...current,
    deployedAt,
    deployer: dep,
    previousDeployment: backupFile,
    upgrade: "dcdomain-swap-info-nft",
    addresses,
    abi: {
      ...current.abi,
      DCDomainSwap: loadAbi("DCdomainswap.sol/DCDomainSwap.json"),
    },
    notes: [
      ...(current.notes ?? []),
      "DCDomainSwap redeployed with createDealWithInfoNft(..., aNftId); old createDeal(...) remains available.",
    ],
  };

  const timestampedFile = join(dir, `agiking-31415926-${stamp}.json`);
  const handoffFile = join(dir, `frontend-handoff-dcdomain-swap-info-nft-${stamp}.md`);
  writeFileSync(currentFile, JSON.stringify(updated, null, 2), "utf8");
  writeFileSync(timestampedFile, JSON.stringify(updated, null, 2), "utf8");
  writeSwapHandoff(handoffFile, deployedAt, dep, addresses);

  console.log("\n========== UPDATED ==========");
  console.log("DCDomainSwap:", dcSwap.address);
  console.log("replaceTimeoutSeconds:", String(replaceTimeout));
  console.log("\nWrote:");
  console.log(" ", currentFile);
  console.log(" ", timestampedFile);
  console.log(" ", backupFile);
  console.log(" ", handoffFile);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
