/**
 * Deploy the minimal Agiking stack needed for domain trade volume to count only
 * deals that finish as Completed.
 *
 * Required because DealFactory -> DCDomainRank auto-close ABI changed to include
 * a `completed` boolean. Existing DCDomain/Market/tokens/pairs/router are reused.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, formatEther, getAddress, zeroAddress, type Address } from "viem";
import { loadAgikingDeploymentAddresses } from "./load-agiking-deployment.js";

const AGIKING_CHAIN_ID = 31415926;
const DEPLOYMENT_FILE = "agiking-31415926.json";

type AnyContract = {
  address: Address;
  read: Record<string, (...args: any[]) => Promise<any>>;
  write: Record<string, (...args: any[]) => Promise<`0x${string}`>>;
};

function agikingChain(rpcUrl: string) {
  return defineChain({
    id: AGIKING_CHAIN_ID,
    name: "Agiking",
    nativeCurrency: { decimals: 18, name: "AGI", symbol: "AGI" },
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

async function maybeTx(label: string, publicClient: any, fn: () => Promise<`0x${string}`>) {
  try {
    await tx(label, publicClient, fn());
  } catch (err: any) {
    console.log(`  SKIP/FAIL ${label}: ${err?.shortMessage ?? err?.message ?? err}`);
  }
}

function ratioParts(r: any): [number, number] {
  if (Array.isArray(r)) return [Number(r[0]), Number(r[1])];
  return [Number(r.num), Number(r.den)];
}

function requiredAddress(name: string, value: Address | undefined): Address {
  if (!value) throw new Error(`Missing required deployment address: ${name}`);
  return value;
}

function loadDeploymentJson() {
  const file = join(process.cwd(), "deployments", DEPLOYMENT_FILE);
  return JSON.parse(readFileSync(file, "utf8")) as any;
}

function refreshAbi(existingAbi: Record<string, unknown[]> = {}) {
  return {
    ...existingAbi,
    DealFactory: loadAbi("DealFactory.sol/DealFactory.json"),
    DealPairManager: loadAbi("DealPairManager.sol/DealPairManager.json"),
    DealMessageHub: loadAbi("DealMessageHub.sol/DealMessageHub.json"),
    DealActivityIndex: loadAbi("DealActivityIndex.sol/DealActivityIndex.json"),
    DealResultIndex: loadAbi("DealResultIndex.sol/DealResultIndex.json"),
    DealImplementationRegistry: loadAbi("DealImplementationRegistry.sol/DealImplementationRegistry.json"),
    DealReader: loadAbi("DealReader.sol/DealReader.json"),
    DCDomainRank: loadAbi("DCdomainrank.sol/DCDomainRank.json"),
    DCDomainRankReader: loadAbi("DCDomainRankReader.sol/DCDomainRankReader.json"),
    DCDomainListReader: loadAbi("DCDomainListReader.sol/DCDomainListReader.json"),
    DCDomainSwap: loadAbi("DCdomainswap.sol/DCDomainSwap.json"),
    DCDomainHall: loadAbi("DCDomainHall.sol/DCDomainHall.json"),
  };
}

function writeHandoff(file: string, deployedAt: string, deployer: Address, a: Record<string, string>) {
  const md = `# 域名 Completed 成交额部署交接

部署时间：${deployedAt}

部署钱包：\`${deployer}\`

链：Agiking \`${AGIKING_CHAIN_ID}\`

## 本次目的

域名累计成交额 \`tradeVolume\` 改为只统计已 \`Completed\` 的域名 deal。

\`Ready / Active / Locked / Canceled / Abandoned\` 不计入域名成交额，也不参与按成交额排序的域名排名。

## 新前端接入地址

| 模块 | 地址 |
| --- | --- |
| DealFactory | \`${a.dealFactory}\` |
| DealPairManager | \`${a.dealPairManager}\` |
| DealMessageHub | \`${a.dealMessageHub}\` |
| DealActivityIndex | \`${a.dealActivityIndex}\` |
| DealResultIndex | \`${a.dealResultIndex}\` |
| DealImplementationRegistry | \`${a.dealImplementationRegistry}\` |
| DealReader | \`${a.dealReader}\` |
| DCDomainRank | \`${a.dcDomainRank}\` |
| DCDomainRankReader | \`${a.dcDomainRankReader}\` |
| DCDomainListReader | \`${a.dcDomainListReader}\` |
| DCDomainSwap | \`${a.dcDomainSwap}\` |
| DCDomainHall | \`${a.dcDomainHall}\` |

## 复用地址

| 模块 | 地址 |
| --- | --- |
| DCDomain | \`${a.dcDomain}\` |
| DCDomainMarket | \`${a.dcDomainMarket}\` |
| DealInfoNFT | \`${a.dealInfoNFT}\` |
| DealCreditGraph | \`${a.dealCreditGraph}\` |
| DealCoin/DC | \`${a.dlToken}\` |
| AUSD | \`${a.ausd}\` |
| USDT | \`${a.usdt}\` |
| WrappedAGI | \`${a.wrappedNative}\` |
| DealRouter | \`${a.dealRouter}\` |
| DealSwapOrderBook | \`${a.dealSwapOrderBook}\` |

## 接线结果

- 新 \`DealFactory\` 已设置 \`dcDomainRank = DCDomainRank\`。
- 新 \`DCDomainRank\` 已设置 \`autoCloser = DealFactory\`。
- 新 \`DCDomainSwap / DCDomainHall\` 已获得新 \`DealFactory.createDealFor\` 权限。
- 新 \`DCDomainSwap / DCDomainHall\` 已获得新 \`DCDomainRank.reportDealWithVolume\` reporter 权限。
- 新 \`DCDomainListReader\` 指向旧 \`DCDomain\` 和新 \`DCDomainRank\`。

## 前端注意

- 域名列表 / 搜索 / 我的域名改用新的 \`DCDomainListReader\`。
- 域名排行榜、广告费充值和收益读取改用新的 \`DCDomainRank / DCDomainRankReader\`。
- 旧的进行中域名 deal 不会迁移到新 \`DCDomainRank\`；新地址生效后创建的域名 deal 才按新成交额规则累计。

完整 ABI 和地址已更新：

\`\`\`text
deployments/${DEPLOYMENT_FILE}
\`\`\`
`;
  writeFileSync(file, md, "utf8");
}

async function main() {
  const rpcUrl = (process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop").trim();
  const chain = agikingChain(rpcUrl);
  const current = loadDeploymentJson();
  const base = loadAgikingDeploymentAddresses(DEPLOYMENT_FILE);

  const { viem } = await network.connect({ network: "agiking", chainType: "l1" }) as unknown as { viem: any };
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer] = await viem.getWalletClients({ chain });
  const client = { public: publicClient, wallet: deployer } as const;
  const dep = deployer.account.address as Address;
  const nativeBalance = await publicClient.getBalance({ address: dep });
  console.log("Chain", AGIKING_CHAIN_ID, "deployer", dep, "native", formatEther(nativeBalance));
  if (nativeBalance === 0n) throw new Error("Deployer has zero native balance; cannot pay deployment gas.");

  const oldFactory = await viem.getContractAt("DealFactory", base.dealFactory, { client }) as AnyContract;
  const requiredOwner = getAddress(await oldFactory.read.owner());
  if (getAddress(dep) !== requiredOwner) {
    throw new Error(`Deployer ${dep} is not current DealFactory owner ${requiredOwner}; aborting before deployment.`);
  }

  const oldFeeNonDL = ratioParts(await oldFactory.read.defaultFeeNonDL());
  const oldMintOnFees = ratioParts(await oldFactory.read.defaultMintOnFees());
  const oldTreasury = await oldFactory.read.treasury().catch(() => dep) as Address;
  const oldSpecialNoFeeToken = await oldFactory.read.specialNoFeeToken().catch(() => zeroAddress) as Address;
  const oldMsgPriceEnabled = await oldFactory.read.msgPriceEnabled().catch(() => false) as boolean;
  const oldMsgPriceToken = await oldFactory.read.msgPriceToken().catch(() => zeroAddress) as Address;
  const oldMsgPriceAmount = await oldFactory.read.msgPriceAmountInToken().catch(() => 0n) as bigint;
  const oldCreateBurnEnabled = await oldFactory.read.createBurnEnabled().catch(() => false) as boolean;
  const oldCreateBurnToken = await oldFactory.read.createBurnPricingToken().catch(() => zeroAddress) as Address;
  const oldCreateBurnAmount = await oldFactory.read.createBurnAmountInToken().catch(() => 0n) as bigint;
  const oldMinWindowSec = await oldFactory.read.minWindowSec().catch(() => 30) as number;
  const oldMinTimeout = await oldFactory.read.minTimeoutSeconds().catch(() => 3600n) as bigint;
  const oldAdmin = await oldFactory.read.admin().catch(() => dep) as Address;

  console.log("\n--- Deploy new Factory support contracts ---");
  const factory = await viem.deployContract("DealFactory", [
    base.dealImplementation,
    base.pairImplementation,
    oldMinTimeout,
  ], { client }) as AnyContract;
  console.log("DealFactory", factory.address);
  const pairManager = await viem.deployContract("DealPairManager", [factory.address], { client }) as AnyContract;
  console.log("DealPairManager", pairManager.address);
  const messageHub = await viem.deployContract("DealMessageHub", [factory.address], { client }) as AnyContract;
  console.log("DealMessageHub", messageHub.address);
  const activityIndex = await viem.deployContract("DealActivityIndex", [factory.address], { client }) as AnyContract;
  console.log("DealActivityIndex", activityIndex.address);
  const resultIndex = await viem.deployContract("DealResultIndex", [factory.address], { client }) as AnyContract;
  console.log("DealResultIndex", resultIndex.address);
  const registry = await viem.deployContract("DealImplementationRegistry", [], { client }) as AnyContract;
  console.log("DealImplementationRegistry", registry.address);
  const reader = await viem.deployContract("DealReader", [], { client }) as AnyContract;
  console.log("DealReader", reader.address);

  console.log("\n--- Configure new Factory ---");
  await tx("Factory.setCoreGlobals", publicClient, factory.write.setCoreGlobals([
    base.dlToken,
    base.dealInfoNFT,
    base.wrappedNative,
    pairManager.address,
  ]));
  await tx("Factory.setServiceGlobals", publicClient, factory.write.setServiceGlobals([
    messageHub.address,
    requiredAddress("dealCreditGraph", base.dealCreditGraph),
    activityIndex.address,
    resultIndex.address,
    registry.address,
  ]));
  await tx("Factory.setOpsGlobals", publicClient, factory.write.setOpsGlobals([
    base.dealSwapOrderBook,
    base.dealNftGovernanceActivity ?? zeroAddress,
    zeroAddress,
  ]));
  await tx("Registry.setDealImplementations", publicClient, registry.write.setDealImplementations([
    base.dealImplementation,
    requiredAddress("dealNoAssetImplementation", base.dealNoAssetImplementation),
    requiredAddress("dealAAssetNftImplementation", base.dealAAssetNftImplementation),
    requiredAddress("dealBAssetNftImplementation", base.dealBAssetNftImplementation),
    requiredAddress("dealAAssetNftOnlyImplementation", base.dealAAssetNftOnlyImplementation),
    requiredAddress("dealBAssetNftOnlyImplementation", base.dealBAssetNftOnlyImplementation),
    requiredAddress("dealOpenTokenTokenImplementation", base.dealOpenTokenTokenImplementation),
  ]));
  await tx("Factory.setRecognizedTokens", publicClient, factory.write.setRecognizedTokens([base.ausd, base.usdt]));
  await tx("Factory.setFeesAndMintOnFees", publicClient, factory.write.setFeesAndMintOnFees([
    oldFeeNonDL[0],
    oldFeeNonDL[1],
    oldMintOnFees[0],
    oldMintOnFees[1],
  ]));
  if (oldTreasury !== zeroAddress) {
    await tx("Factory.setTreasuryByAdmin", publicClient, factory.write.setTreasuryByAdmin([oldTreasury]));
  }
  if (oldSpecialNoFeeToken !== zeroAddress) {
    await tx("Factory.setSpecialNoFeeTokenByAdmin", publicClient, factory.write.setSpecialNoFeeTokenByAdmin([oldSpecialNoFeeToken]));
  }
  await tx("Factory.setMessagePriceRule", publicClient, factory.write.setMessagePriceRule([
    oldMsgPriceEnabled,
    oldMsgPriceToken,
    oldMsgPriceAmount,
  ]));
  await tx("Factory.setCreateBurnRule", publicClient, factory.write.setCreateBurnRule([
    oldCreateBurnEnabled,
    oldCreateBurnToken,
    oldCreateBurnAmount,
  ]));
  await tx("Factory.setMinWindowSec", publicClient, factory.write.setMinWindowSec([oldMinWindowSec]));
  if (oldAdmin !== dep) {
    await tx("Factory.setAdmin(old admin)", publicClient, factory.write.setAdmin([oldAdmin]));
  }

  console.log("\n--- Map existing pairs ---");
  await tx("PairManager.mapExistingPair AUSD", publicClient, pairManager.write.mapExistingPair([base.ausd, base.pairDlAusd]));
  await tx("PairManager.mapExistingPair USDT", publicClient, pairManager.write.mapExistingPair([base.usdt, base.pairDlUsdt]));
  if (base.pairDlAgi) {
    await tx("PairManager.mapExistingPair AGI", publicClient, pairManager.write.mapExistingPair([base.wrappedNative, base.pairDlAgi]));
  }

  console.log("\n--- Permission wiring ---");
  const dl = await viem.getContractAt("DCToken", base.dlToken, { client }) as AnyContract;
  const minterRole = await dl.read.MINTER_ROLE();
  await maybeTx("DCToken.grantRole(MINTER_ROLE, newFactory)", publicClient, () => dl.write.grantRole([minterRole, factory.address]));
  const infoNft = await viem.getContractAt("DealInfoNFT", base.dealInfoNFT, { client }) as AnyContract;
  await maybeTx("DealInfoNFT.addFactory(newFactory)", publicClient, () => infoNft.write.addFactory([factory.address]));
  await tx("DealInfoNFT.setFactory(newFactory)", publicClient, infoNft.write.setFactory([factory.address]));
  const creditGraph = await viem.getContractAt("DealCreditGraph", requiredAddress("dealCreditGraph", base.dealCreditGraph), { client }) as AnyContract;
  await maybeTx("DealCreditGraph.setRecorder(newFactory)", publicClient, () => creditGraph.write.setRecorder([factory.address, true]));
  if (base.dealNftGovernanceActivity) {
    const activity = await viem.getContractAt("DealNftGovernanceActivity", base.dealNftGovernanceActivity, { client }) as AnyContract;
    await maybeTx("DealNftGovernanceActivity.setRecorder(newFactory)", publicClient, () => activity.write.setRecorder([factory.address, true]));
  }

  console.log("\n--- Deploy completed-only domain stack ---");
  const dcRank = await viem.deployContract("DCDomainRank", [base.dlToken, base.dcDomain, dep], { client }) as AnyContract;
  console.log("DCDomainRank", dcRank.address);
  const dcRankReader = await viem.deployContract("DCDomainRankReader", [dcRank.address], { client }) as AnyContract;
  console.log("DCDomainRankReader", dcRankReader.address);
  const dcDomainListReader = await viem.deployContract("DCDomainListReader", [base.dcDomain, dcRank.address], { client }) as AnyContract;
  console.log("DCDomainListReader", dcDomainListReader.address);
  const dcSwap = await viem.deployContract("DCDomainSwap", [base.dcDomain, dcRank.address, factory.address], { client }) as AnyContract;
  console.log("DCDomainSwap", dcSwap.address);
  const dcHall = await viem.deployContract("DCDomainHall", [dcRank.address, base.dcDomain, factory.address], { client }) as AnyContract;
  console.log("DCDomainHall", dcHall.address);

  await tx("Factory.setOpsGlobals domain rank", publicClient, factory.write.setOpsGlobals([
    base.dealSwapOrderBook,
    base.dealNftGovernanceActivity ?? zeroAddress,
    dcRank.address,
  ]));
  await tx("DCDomainRank.setAutoCloser(Factory)", publicClient, dcRank.write.setAutoCloser([factory.address]));
  await tx("Factory.allow DCDomainSwap", publicClient, factory.write.setAllowedCreateFor([dcSwap.address, true]));
  await tx("Factory.allow DCDomainHall", publicClient, factory.write.setAllowedCreateFor([dcHall.address, true]));
  await tx("DCDomainRank.reporter Swap", publicClient, dcRank.write.setDealReporter([dcSwap.address, true]));
  await tx("DCDomainRank.reporter Hall", publicClient, dcRank.write.setDealReporter([dcHall.address, true]));

  console.log("\n--- Smoke checks ---");
  const rankFromFactory = await factory.read.dcDomainRank() as Address;
  const autoCloser = await dcRank.read.autoCloser() as Address;
  const primaryFactory = await infoNft.read.factory() as Address;
  const listRank = await dcDomainListReader.read.rank() as Address;
  const isSwapAllowed = await factory.read.isAllowedCreateFor([dcSwap.address]) as boolean;
  const isHallAllowed = await factory.read.isAllowedCreateFor([dcHall.address]) as boolean;
  if (rankFromFactory.toLowerCase() !== dcRank.address.toLowerCase()) throw new Error("Factory domain rank mismatch");
  if (autoCloser.toLowerCase() !== factory.address.toLowerCase()) throw new Error("Rank auto closer mismatch");
  if (primaryFactory.toLowerCase() !== factory.address.toLowerCase()) throw new Error("InfoNFT primary factory mismatch");
  if (listRank.toLowerCase() !== dcRank.address.toLowerCase()) throw new Error("ListReader rank mismatch");
  if (!isSwapAllowed || !isHallAllowed) throw new Error("Domain entries not allowed on factory");
  console.log("  OK factory/rank/list-reader/domain-entry wiring");

  const deployedAt = new Date().toISOString();
  const stamp = deployedAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = join(process.cwd(), "deployments");
  const backupDir = join(dir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const currentFile = join(dir, DEPLOYMENT_FILE);
  const backupFile = join(backupDir, `agiking-31415926.before-domain-completed-volume-${stamp}.json`);
  copyFileSync(currentFile, backupFile);

  const addresses: Record<string, string> = {
    ...current.addresses,
    dealFactory: getAddress(factory.address),
    dealPairManager: getAddress(pairManager.address),
    dealMessageHub: getAddress(messageHub.address),
    dealActivityIndex: getAddress(activityIndex.address),
    dealResultIndex: getAddress(resultIndex.address),
    dealImplementationRegistry: getAddress(registry.address),
    dealReader: getAddress(reader.address),
    dcDomainRank: getAddress(dcRank.address),
    dcDomainRankReader: getAddress(dcRankReader.address),
    dcDomainListReader: getAddress(dcDomainListReader.address),
    dcDomainSwap: getAddress(dcSwap.address),
    dcDomainHall: getAddress(dcHall.address),
  };

  const out = {
    ...current,
    chainId: AGIKING_CHAIN_ID,
    rpcUrl,
    deployedAt,
    deployer: dep,
    previousDeployment: backupFile,
    upgrade: "domain-completed-trade-volume",
    addresses,
    abi: refreshAbi(current.abi),
    notes: [
      ...(current.notes ?? []),
      "Domain tradeVolume now only counts deals that finish as Completed.",
      "DealFactory auto-closes domain deals through DCDomainRank.closeDealFromAutoCloser(domain, deal, completed).",
      "DCDomain/DCDomainMarket/tokens/pairs/router/order book were reused; Factory, Rank, domain readers, Swap, and Hall were redeployed.",
    ],
  };

  const timestampedFile = join(dir, `agiking-31415926-${stamp}.json`);
  writeFileSync(currentFile, JSON.stringify(out, null, 2), "utf8");
  writeFileSync(timestampedFile, JSON.stringify(out, null, 2), "utf8");

  const handoffFile = join(dir, `frontend-handoff-domain-completed-volume-${stamp}.md`);
  writeHandoff(handoffFile, deployedAt, dep, addresses);
  writeHandoff(join(process.cwd(), "docs", "前端部署地址交接文档.md"), deployedAt, dep, addresses);

  console.log("\n========== DEPLOYED ADDRESSES ==========");
  console.log(JSON.stringify({
    dealFactory: addresses.dealFactory,
    dcDomainRank: addresses.dcDomainRank,
    dcDomainRankReader: addresses.dcDomainRankReader,
    dcDomainListReader: addresses.dcDomainListReader,
    dcDomainSwap: addresses.dcDomainSwap,
    dcDomainHall: addresses.dcDomainHall,
  }, null, 2));
  console.log("\nWrote:");
  console.log(" ", currentFile);
  console.log(" ", timestampedFile);
  console.log(" ", backupFile);
  console.log(" ", handoffFile);
  console.log(" ", join(process.cwd(), "docs", "前端部署地址交接文档.md"));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
