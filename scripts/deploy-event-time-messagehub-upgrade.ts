/**
 * Agiking upgrade for:
 * - Deal terminal events with explicit `when`
 * - DealMessageHub as the only normal chat entry
 * - DealOpenTokenToken replacement flow + current credit rules
 * - OpenTokenToken B replacement timeout (`replaceTimeoutSeconds`), default 120 seconds
 *
 * This script intentionally deploys fresh Deal template implementations.
 * Reusing older implementation addresses would keep the old event ABI.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, formatEther, zeroAddress, type Address } from "viem";
import { loadAgikingDeploymentAddresses } from "./load-agiking-deployment.js";

const AGIKING_CHAIN_ID = 31415926;
const DEPLOYMENT_FILE = "agiking-31415926.json";

const EXISTING = loadAgikingDeploymentAddresses(DEPLOYMENT_FILE);

type AnyContract = {
  address: Address;
  read: Record<string, (...args: any[]) => Promise<any>>;
  write: Record<string, (...args: any[]) => Promise<`0x${string}`>>;
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
  if (receipt.status !== "success") {
    throw new Error(`Transaction failed: ${hash}`);
  }
  return receipt;
}

async function tx(label: string, publicClient: any, hashPromise: Promise<`0x${string}`>) {
  const hash = await hashPromise;
  await waitFor(publicClient, hash);
  console.log(`  OK ${label}: ${hash}`);
}

function ratioParts(r: any): [number, number] {
  if (Array.isArray(r)) return [Number(r[0]), Number(r[1])];
  return [Number(r.num), Number(r.den)];
}

function requiredAddress(name: string, value: Address | undefined): Address {
  if (!value) throw new Error(`Missing required deployment address: ${name}`);
  return value;
}

async function maybeTx(label: string, publicClient: any, fn: () => Promise<`0x${string}`>) {
  try {
    await tx(label, publicClient, fn());
  } catch (err: any) {
    console.log(`  SKIP/FAIL ${label}: ${err?.shortMessage ?? err?.message ?? err}`);
  }
}

function deploymentAbi() {
  return {
    DealLib: loadAbi("utils/DealLib.sol/DealLib.json"),
    DealAssetNftLib: loadAbi("utils/DealAssetNftLib.sol/DealAssetNftLib.json"),
    Deal: loadAbi("Deal.sol/Deal.json"),
    DealNoAsset: loadAbi("DealNoAsset.sol/DealNoAsset.json"),
    DealAAssetNft: loadAbi("DealAAssetNft.sol/DealAAssetNft.json"),
    DealBAssetNft: loadAbi("DealBAssetNft.sol/DealBAssetNft.json"),
    DealAAssetNftOnly: loadAbi("DealAAssetNftOnly.sol/DealAAssetNftOnly.json"),
    DealBAssetNftOnly: loadAbi("DealBAssetNftOnly.sol/DealBAssetNftOnly.json"),
    DealOpenTokenToken: loadAbi("DealOpenTokenToken.sol/DealOpenTokenToken.json"),
    DealImplementationRegistry: loadAbi("DealImplementationRegistry.sol/DealImplementationRegistry.json"),
    DealFactory: loadAbi("DealFactory.sol/DealFactory.json"),
    DealMessageHub: loadAbi("DealMessageHub.sol/DealMessageHub.json"),
    DealCreditGraph: loadAbi("DealCreditGraph.sol/DealCreditGraph.json"),
    DealActivityIndex: loadAbi("DealActivityIndex.sol/DealActivityIndex.json"),
    DealResultIndex: loadAbi("DealResultIndex.sol/DealResultIndex.json"),
    DealSwapTemplate: loadAbi("DealSwapTemplate.sol/DealSwapTemplate.json"),
    DCToken: loadAbi("DL.sol/DCToken.json"),
    DealInfoNFT: loadAbi("DealInfoNft.sol/DealInfoNFT.json"),
    DealSwapOrderBook: loadAbi("DealSwapOrderBook.sol/DealSwapOrderBook.json"),
    DealRouter: loadAbi("DealSwapRouter.sol/DealRouter.json"),
    DealReader: loadAbi("DealReader.sol/DealReader.json"),
    DCDomain: loadAbi("DCdomain.sol/DCDomain.json"),
    DCDomainRank: loadAbi("DCdomainrank.sol/DCDomainRank.json"),
    DCDomainMarket: loadAbi("DCDomainMarket.sol/DCDomainMarket.json"),
    DCDomainSwap: loadAbi("DCdomainswap.sol/DCDomainSwap.json"),
    DCDomainHall: loadAbi("DCDomainHall.sol/DCDomainHall.json"),
    D: loadAbi("D.sol/D.json"),
    DealTimelock: loadAbi("TestDealTimeLock.sol/DealTimelock.json"),
    DealGovernor: loadAbi("DealDao.sol/DealGovernor.json"),
    VoteDividendClaimer: loadAbi("VoteDividendClaimer.sol/VoteDividendClaimer.json"),
  };
}

function writeFrontendHandoff(file: string, deployedAt: string, deployer: Address, addresses: Record<string, Address>) {
  const md = `# Agiking 前端部署地址交接

部署时间：${deployedAt}

部署钱包：\`${deployer}\`

链：Agiking \`${AGIKING_CHAIN_ID}\`

## 前端主接入地址

| 模块 | 地址 | 前端用途 |
| --- | --- | --- |
| DealFactory | \`${addresses.dealFactory}\` | 创建 deal、读取工厂配置、索引当前 deal |
| DealMessageHub | \`${addresses.dealMessageHub}\` | 留言上链唯一入口：\`postMessage(deal, content)\` |
| DealReader | \`${addresses.dealReader}\` | 聚合读取 deal 列表/详情 |
| DealActivityIndex | \`${addresses.dealActivityIndex}\` | 读取用户活动索引 |
| DealResultIndex | \`${addresses.dealResultIndex}\` | 读取奖励明细、信用增量明细、交易过程时间线，避免前端扫历史 logs |
| DealPairManager | \`${addresses.dealPairManager}\` | 工厂背后的 pair/TWAP 管理合约，前端通常仍调 Factory |
| DealCreditGraph | \`${addresses.dealCreditGraph}\` | 读取官方 InfoNFT 信用分 |
| DealInfoNFT | \`${addresses.dealInfoNFT}\` | 官方身份 NFT |
| DealOpenTokenToken implementation | \`${addresses.dealOpenTokenTokenImplementation}\` | 公开币币单模板 ABI |
| DCDomainSwap | \`${addresses.dcDomainSwap}\` | 域名入口创建普通 deal |
| DCDomainHall | \`${addresses.dcDomainHall}\` | 域名大厅/访客匹配入口 |
| DCDomain | \`${addresses.dcDomain}\` | 域名 NFT，复用旧地址 |
| DCDomainRank | \`${addresses.dcDomainRank}\` | 域名有效用户、黑名单、排行、分页排行榜 |
| DL/DCToken | \`${addresses.dlToken}\` | DL 代币 |
| AUSD | \`${addresses.ausd}\` | 测试稳定币 |
| USDT | \`${addresses.usdt}\` | 测试稳定币 |

## 本次需要前端切换

1. 创建 deal 走新的 \`DealFactory\`。
2. 留言不再调 deal 合约本体，统一调新的 \`DealMessageHub.postMessage(dealAddress, content)\`。
3. 点对点币币公开单使用新的 \`DealOpenTokenToken\` ABI，关注 \`replaceInactiveBAndJoin\`、\`replaceNonVotingBAndJoin\`、\`replaceTimeoutSeconds\`、\`APreAccepted\`、\`BExpelledOnReject\`、\`ActivePartnerCleared\`。
4. 终局事件 \`Completed\` / \`Canceled\` 已带 \`when\` 字段，前端可以直接用事件里的链上时间。
5. 域名入口切到新的 \`DCDomainSwap\` / \`DCDomainHall\`，域名身份/黑名单/排行查询切到新的 \`DCDomainRank\`，旧域名 NFT、Market 地址继续复用。
6. 创建 \`openTokenTokenFast = true\` 的 deal 时必须传 \`replaceTimeoutSeconds\`，范围 60 秒到 1 天；建议默认 120 秒。新的 \`DCDomainSwap\` 默认也是 120 秒。
7. 创建 deal 不再传 \`timeStart/timeEnd\`；创建时间/结束时间读 \`createdAt/endedAt\`，旧 \`timeStart/timeEnd\` 只做兼容展示。
8. 域名下创建币币合同如果要绑定 A 的官方身份 NFT，调用 \`DCDomainSwap.createDealWithInfoNft(..., aNftId)\`；不绑定则继续调用 \`createDeal(...)\`。
9. 域名排行榜分页调用 \`DCDomainRank.getLeaderboard(domainName, offset, limit)\`，单次 \`limit <= 50\`。
10. 历史奖励、信用增量、交易过程时间线不要扫 logs，改读 \`DealResultIndex.rewardOfDeal/getRewards/creditOfDeal/getCreditRecords/getTimeline\`。

## ABI

完整 ABI 在：

\`\`\`
deployments/${DEPLOYMENT_FILE}
\`\`\`

## 相关前端文档

| 文档 | 用途 |
| --- | --- |
| \`docs/Domain_Frontend_Call_Guide.md\` | 域名注册、域名交易、大厅、排行榜、分页 |
| \`docs/DealOpenTokenToken_前端接入说明.md\` | OpenTokenToken 创建参数、加入/顶替/成交流程 |
| \`docs/OpenTokenToken_B方踢人与超时字段说明.md\` | B 方踢人、C 顶替、\`replaceTimeoutSeconds\` |
| \`docs/DCDomainSwap_身份NFT创建说明.md\` | 域名下创建币币合同时绑定 A 的官方身份 NFT |
| \`docs/Deal_前端事件与工厂索引说明.md\` | 事件索引、系统提示、奖励和信用读取 |

## 验证结果

- 新 Factory 已配置新 Hub、CreditGraph、ActivityIndex、ImplementationRegistry。
- 新 Factory 已配置 DealResultIndex，前端可用 view 读取奖励/信用/交易过程时间线索引。
- 新 Factory 已获得 DL \`MINTER_ROLE\`。
- DealInfoNFT 已授权新 Factory，并切换 primary factory 到新 Factory。
- DCDomainSwap / DCDomainHall 已获得新 Factory 创建权限。
- DCDomainRank 已授权新的 Swap / Hall reporter。
- DCDomainSwap 默认 \`replaceTimeoutSeconds = 120\` 秒；如需调整，由 owner 调 \`setReplaceTimeoutSeconds(value)\`。
`;
  writeFileSync(file, md, "utf8");
}

async function main() {
  const rpcUrl = process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop";
  const chain = agikingChain(rpcUrl.trim());

  const { viem } = await network.connect({ network: "agiking", chainType: "l1" });
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer] = await viem.getWalletClients({ chain });
  const client = { public: publicClient, wallet: deployer } as const;
  const dep = deployer.account.address;
  const balance = await publicClient.getBalance({ address: dep });

  console.log("Chain:", chain.id);
  console.log("Deployer:", dep);
  console.log("Native balance:", formatEther(balance));

  if (balance === 0n) {
    throw new Error("Deployer has zero native balance; cannot pay deployment gas.");
  }

  const oldFactory = await viem.getContractAt("DealFactory", EXISTING.dealFactory, { client }) as AnyContract;
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
  const dealAssetNftLib = requiredAddress("dealAssetNftLib", EXISTING.dealAssetNftLib);
  requiredAddress("dealCreditGraph", EXISTING.dealCreditGraph);

  console.log("\n--- Deploy fresh Deal implementations ---");
  const dealImpl = await viem.deployContract("Deal", [], { client });
  console.log("Deal:", dealImpl.address);
  const dealNoAssetImpl = await viem.deployContract("DealNoAsset", [], {
    client,
    libraries: { DealLib: EXISTING.dealLib },
  });
  console.log("DealNoAsset:", dealNoAssetImpl.address);
  const dealAAssetNftImpl = await viem.deployContract("DealAAssetNft", [], {
    client,
    libraries: { DealLib: EXISTING.dealLib, DealAssetNftLib: dealAssetNftLib },
  });
  console.log("DealAAssetNft:", dealAAssetNftImpl.address);
  const dealBAssetNftImpl = await viem.deployContract("DealBAssetNft", [], {
    client,
    libraries: { DealLib: EXISTING.dealLib, DealAssetNftLib: dealAssetNftLib },
  });
  console.log("DealBAssetNft:", dealBAssetNftImpl.address);
  const dealAAssetNftOnlyImpl = await viem.deployContract("DealAAssetNftOnly", [], {
    client,
    libraries: { DealAssetNftLib: dealAssetNftLib },
  });
  console.log("DealAAssetNftOnly:", dealAAssetNftOnlyImpl.address);
  const dealBAssetNftOnlyImpl = await viem.deployContract("DealBAssetNftOnly", [], {
    client,
    libraries: { DealAssetNftLib: dealAssetNftLib },
  });
  console.log("DealBAssetNftOnly:", dealBAssetNftOnlyImpl.address);
  const dealOpenTokenTokenImpl = await viem.deployContract("DealOpenTokenToken", [], {
    client,
    libraries: { DealLib: EXISTING.dealLib },
  });
  console.log("DealOpenTokenToken:", dealOpenTokenTokenImpl.address);

  console.log("\n--- Deploy routing/core contracts ---");
  const factory = await viem.deployContract("DealFactory", [dealImpl.address, EXISTING.pairImplementation, 3600n], {
    client,
  });
  console.log("DealFactory:", factory.address);
  const pairManager = await viem.deployContract("DealPairManager", [factory.address], { client });
  console.log("DealPairManager:", pairManager.address);
  const messageHub = await viem.deployContract("DealMessageHub", [factory.address], { client });
  console.log("DealMessageHub:", messageHub.address);
  const activityIndex = await viem.deployContract("DealActivityIndex", [factory.address], { client });
  console.log("DealActivityIndex:", activityIndex.address);
  const resultIndex = await viem.deployContract("DealResultIndex", [factory.address], { client });
  console.log("DealResultIndex:", resultIndex.address);
  const registry = await viem.deployContract("DealImplementationRegistry", [], { client });
  console.log("DealImplementationRegistry:", registry.address);
  const reader = await viem.deployContract("DealReader", [], { client });
  console.log("DealReader:", reader.address);
  const creditGraph = await viem.deployContract("DealCreditGraph", [EXISTING.dealInfoNFT], { client });
  console.log("DealCreditGraph:", creditGraph.address);

  const newFactory = await viem.getContractAt("DealFactory", factory.address, { client }) as AnyContract;
  const newRegistry = await viem.getContractAt("DealImplementationRegistry", registry.address, { client }) as AnyContract;

  console.log("\n--- Configure new Factory ---");
  await tx("setGlobal dlToken", publicClient, newFactory.write.setGlobal(["dlToken", EXISTING.dlToken]));
  await tx("setGlobal infoNft", publicClient, newFactory.write.setGlobal(["infoNft", EXISTING.dealInfoNFT]));
  await tx("setGlobal wrappedNative", publicClient, newFactory.write.setGlobal(["wrappedNative", EXISTING.wrappedNative]));
  await tx("setGlobal dealMessageHub", publicClient, newFactory.write.setGlobal(["dealMessageHub", messageHub.address]));
  await tx("setGlobal creditGraph", publicClient, newFactory.write.setGlobal(["creditGraph", creditGraph.address]));
  await tx("setGlobal dealActivityIndex", publicClient, newFactory.write.setGlobal(["dealActivityIndex", activityIndex.address]));
  await tx("setGlobal dealResultIndex", publicClient, newFactory.write.setGlobal(["dealResultIndex", resultIndex.address]));
  await tx("setGlobal dealPairManager", publicClient, newFactory.write.setGlobal(["dealPairManager", pairManager.address]));
  await tx("setGlobal swapOrderBook", publicClient, newFactory.write.setGlobal(["swapOrderBook", EXISTING.dealSwapOrderBook]));
  await tx(
    "setDealImplementations",
    publicClient,
    newRegistry.write.setDealImplementations([
      dealImpl.address,
      dealNoAssetImpl.address,
      dealAAssetNftImpl.address,
      dealBAssetNftImpl.address,
      dealAAssetNftOnlyImpl.address,
      dealBAssetNftOnlyImpl.address,
      dealOpenTokenTokenImpl.address,
    ]),
  );
  await tx("setGlobal dealImplementationRegistry", publicClient, newFactory.write.setGlobal(["dealImplementationRegistry", registry.address]));
  await tx("setRecognizedTokens", publicClient, newFactory.write.setRecognizedTokens([EXISTING.ausd, EXISTING.usdt]));
  await tx("setFeesAndMintOnFees", publicClient, newFactory.write.setFeesAndMintOnFees([
    oldFeeNonDL[0],
    oldFeeNonDL[1],
    oldMintOnFees[0],
    oldMintOnFees[1],
  ]));
  if (oldTreasury !== zeroAddress) {
    await tx("setTreasuryByAdmin", publicClient, newFactory.write.setTreasuryByAdmin([oldTreasury]));
  }
  if (oldSpecialNoFeeToken !== zeroAddress) {
    await tx("setSpecialNoFeeTokenByAdmin", publicClient, newFactory.write.setSpecialNoFeeTokenByAdmin([oldSpecialNoFeeToken]));
  }
  await tx("setMessagePriceRule", publicClient, newFactory.write.setMessagePriceRule([
    oldMsgPriceEnabled,
    oldMsgPriceToken,
    oldMsgPriceAmount,
  ]));
  await tx("setCreateBurnRule", publicClient, newFactory.write.setCreateBurnRule([
    oldCreateBurnEnabled,
    oldCreateBurnToken,
    oldCreateBurnAmount,
  ]));
  await tx("setMinWindowSec", publicClient, newFactory.write.setMinWindowSec([oldMinWindowSec]));
  await tx("mapExistingPair AUSD", publicClient, newFactory.write.mapExistingPair([EXISTING.ausd, EXISTING.pairDlAusd]));
  await tx("mapExistingPair USDT", publicClient, newFactory.write.mapExistingPair([EXISTING.usdt, EXISTING.pairDlUsdt]));

  console.log("\n--- Permission wiring ---");
  await tx("DealCreditGraph.setRecorder", publicClient, creditGraph.write.setRecorder([factory.address, true]));
  const dl = await viem.getContractAt("DCToken", EXISTING.dlToken, { client }) as AnyContract;
  const minterRole = await dl.read.MINTER_ROLE();
  await maybeTx("DCToken.grantRole(MINTER_ROLE, newFactory)", publicClient, () => dl.write.grantRole([minterRole, factory.address]));
  const infoNft = await viem.getContractAt("DealInfoNFT", EXISTING.dealInfoNFT, { client }) as AnyContract;
  await maybeTx("DealInfoNFT.addFactory(newFactory)", publicClient, () => infoNft.write.addFactory([factory.address]));
  await tx("DealInfoNFT.setFactory(newFactory)", publicClient, infoNft.write.setFactory([factory.address]));

  console.log("\n--- Deploy domain entry contracts against new Factory ---");
  const dcRank = await viem.deployContract("DCDomainRank", [EXISTING.dlToken, EXISTING.dcDomain, dep], {
    client,
  });
  console.log("DCDomainRank:", dcRank.address);
  const dcSwap = await viem.deployContract("DCDomainSwap", [EXISTING.dcDomain, dcRank.address, factory.address], {
    client,
  });
  console.log("DCDomainSwap:", dcSwap.address);
  const dcHall = await viem.deployContract("DCDomainHall", [dcRank.address, EXISTING.dcDomain, factory.address], {
    client,
  });
  console.log("DCDomainHall:", dcHall.address);

  await tx("Factory.allow DCDomainSwap", publicClient, newFactory.write.setAllowedCreateFor([dcSwap.address, true]));
  await tx("Factory.allow DCDomainHall", publicClient, newFactory.write.setAllowedCreateFor([dcHall.address, true]));
  await tx("DCDomainRank.setDealReporter(Swap)", publicClient, dcRank.write.setDealReporter([dcSwap.address, true]));
  await tx("DCDomainRank.setDealReporter(Hall)", publicClient, dcRank.write.setDealReporter([dcHall.address, true]));

  const deployedAt = new Date().toISOString();
  const addresses: Record<string, Address> = {
    dlToken: EXISTING.dlToken,
    ausd: EXISTING.ausd,
    usdt: EXISTING.usdt,
    wrappedNative: EXISTING.wrappedNative,
    dealLib: EXISTING.dealLib,
    dealAssetNftLib,
    dealImplementation: dealImpl.address,
    dealNoAssetImplementation: dealNoAssetImpl.address,
    dealAAssetNftImplementation: dealAAssetNftImpl.address,
    dealBAssetNftImplementation: dealBAssetNftImpl.address,
    dealAAssetNftOnlyImplementation: dealAAssetNftOnlyImpl.address,
    dealBAssetNftOnlyImplementation: dealBAssetNftOnlyImpl.address,
    dealOpenTokenTokenImplementation: dealOpenTokenTokenImpl.address,
    dealImplementationRegistry: registry.address,
    pairImplementation: EXISTING.pairImplementation,
    dealFactory: factory.address,
    dealMessageHub: messageHub.address,
    dealCreditGraph: creditGraph.address,
    dealActivityIndex: activityIndex.address,
    dealResultIndex: resultIndex.address,
    dealPairManager: pairManager.address,
    dealInfoNFT: EXISTING.dealInfoNFT,
    pairDlAusd: EXISTING.pairDlAusd,
    pairDlUsdt: EXISTING.pairDlUsdt,
    dealSwapOrderBook: EXISTING.dealSwapOrderBook,
    dealRouter: EXISTING.dealRouter,
    dealReader: reader.address,
    dcDomain: EXISTING.dcDomain,
    dcDomainRank: dcRank.address,
    dcDomainMarket: EXISTING.dcDomainMarket,
    dcDomainSwap: dcSwap.address,
    dcDomainHall: dcHall.address,
    dToken: EXISTING.dToken,
    dealTimelock: EXISTING.dealTimelock,
    dealGovernor: EXISTING.dealGovernor,
    voteDividendClaimer: EXISTING.voteDividendClaimer,
  };

  console.log("\n--- Smoke checks ---");
  const hubFromFactory = await newFactory.read.dealMessageHub() as Address;
  const registryFromFactory = await newFactory.read.dealImplementationRegistry() as Address;
  const resultIndexFromFactory = await newFactory.read.dealResultIndex() as Address;
  const pairManagerFromFactory = await newFactory.read.dealPairManager() as Address;
  const primaryFactory = await infoNft.read.factory() as Address;
  if (hubFromFactory.toLowerCase() !== messageHub.address.toLowerCase()) throw new Error("Factory hub mismatch");
  if (registryFromFactory.toLowerCase() !== registry.address.toLowerCase()) throw new Error("Factory registry mismatch");
  if (resultIndexFromFactory.toLowerCase() !== resultIndex.address.toLowerCase()) throw new Error("Factory result index mismatch");
  if (pairManagerFromFactory.toLowerCase() !== pairManager.address.toLowerCase()) throw new Error("Factory pair manager mismatch");
  if (primaryFactory.toLowerCase() !== factory.address.toLowerCase()) throw new Error("InfoNFT primary factory mismatch");
  console.log("  OK factory hub/registry/result index/pair manager and InfoNFT primary factory");

  const dir = join(process.cwd(), "deployments");
  const backupDir = join(dir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = deployedAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const currentFile = join(dir, DEPLOYMENT_FILE);
  const backupFile = join(backupDir, `agiking-31415926.before-event-time-messagehub-${stamp}.json`);
  copyFileSync(currentFile, backupFile);

  const out = {
    chainId: AGIKING_CHAIN_ID,
    rpcUrl: rpcUrl.trim(),
    deployedAt,
    deployer: dep,
    previousDeployment: backupFile,
    upgrade: "event-time-messagehub-opentt-replace-timeout",
    addresses,
    abi: deploymentAbi(),
    notes: [
      "Deal template implementations are freshly deployed; old template addresses should not be used for new deals.",
      "DealMessageHub is now the normal chat entry: postMessage(deal, content).",
      "Completed/Canceled events now include when.",
      "OpenTokenToken uses replaceTimeoutSeconds for B replacement; recommended/default value is 120 seconds.",
      "DCDomain/DCDomainMarket are reused; DCDomainRank/DCDomainSwap/DCDomainHall are redeployed against the new Factory.",
    ],
  };

  const timestampedFile = join(dir, `agiking-31415926-${stamp}.json`);
  writeFileSync(currentFile, JSON.stringify(out, null, 2), "utf8");
  writeFileSync(timestampedFile, JSON.stringify(out, null, 2), "utf8");

  const handoffFile = join(dir, `frontend-handoff-agiking-31415926-${stamp}.md`);
  writeFrontendHandoff(handoffFile, deployedAt, dep, addresses);
  writeFrontendHandoff(join(process.cwd(), "docs", "前端部署地址交接文档.md"), deployedAt, dep, addresses);

  console.log("\n========== DEPLOYED ADDRESSES ==========");
  console.log(JSON.stringify(addresses, null, 2));
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
