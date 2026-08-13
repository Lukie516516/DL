/**
 * Deploy the current update set without redeploying unchanged tokens:
 * - new Deal templates changed in this branch
 * - new DealFactory + DealPairManager + MessageHub/ActivityIndex/ResultIndex/Registry
 * - new AGI/WAGI swap lane + Router + SwapAssetRegistry
 * - new DCDomain/DCDomainRank/DCDomainSwap/DCDomainHall/DCDomainListReader stack
 *
 * Reuses: DealCoin/DC, AUSD, USDT, DealInfoNFT, DealCreditGraph, DealSwapTemplate impl,
 * DealLib, DealAssetNftLib, old AUSD/USDT pairs, old OrderBook.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, formatEther, getAddress, parseEther, zeroAddress, type Address } from "viem";
import { loadAgikingDeploymentAddresses } from "./load-agiking-deployment.js";

const AGIKING_CHAIN_ID = 31415926;
const DEPLOYMENT_FILE = "agiking-31415926.json";
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const ONE = 10n ** 18n;

type AnyContract = {
  address: Address;
  abi: unknown[];
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

function envBigInt(key: string, fallback: bigint): bigint {
  const v = process.env[key]?.trim();
  return v ? BigInt(v) : fallback;
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
    DealFactory: loadAbi("DealFactory.sol/DealFactory.json"),
    DealPairManager: loadAbi("DealPairManager.sol/DealPairManager.json"),
    DealImplementationRegistry: loadAbi("DealImplementationRegistry.sol/DealImplementationRegistry.json"),
    DealMessageHub: loadAbi("DealMessageHub.sol/DealMessageHub.json"),
    DealActivityIndex: loadAbi("DealActivityIndex.sol/DealActivityIndex.json"),
    DealResultIndex: loadAbi("DealResultIndex.sol/DealResultIndex.json"),
    DealSwapAssetRegistry: loadAbi("DealSwapAssetRegistry.sol/DealSwapAssetRegistry.json"),
    WrappedAGI: loadAbi("WrappedAGI.sol/WrappedAGI.json"),
    DealRouter: loadAbi("DealSwapRouter.sol/DealRouter.json"),
    DealRouterQuoter: loadAbi("DealRouterQuoter.sol/DealRouterQuoter.json"),
    DCDomain: loadAbi("DCdomain.sol/DCDomain.json"),
    DCDomainRank: loadAbi("DCdomainrank.sol/DCDomainRank.json"),
    DCDomainRankReader: loadAbi("DCDomainRankReader.sol/DCDomainRankReader.json"),
    DCDomainListReader: loadAbi("DCDomainListReader.sol/DCDomainListReader.json"),
    DCDomainMarket: loadAbi("DCDomainMarket.sol/DCDomainMarket.json"),
    DCDomainSwap: loadAbi("DCdomainswap.sol/DCDomainSwap.json"),
    DCDomainHall: loadAbi("DCDomainHall.sol/DCDomainHall.json"),
    DCToken: loadAbi("DL.sol/DCToken.json"),
    DealInfoNFT: loadAbi("DealInfoNft.sol/DealInfoNFT.json"),
    DealInfoNFTRenderer: loadAbi("DealInfoNFTRenderer.sol/DealInfoNFTRenderer.json"),
    DealCreditGraph: loadAbi("DealCreditGraph.sol/DealCreditGraph.json"),
    DealSwapTemplate: loadAbi("DealSwapTemplate.sol/DealSwapTemplate.json"),
    DealSwapOrderBook: loadAbi("DealSwapOrderBook.sol/DealSwapOrderBook.json"),
    DealReader: loadAbi("DealReader.sol/DealReader.json"),
  };
}

async function main() {
  const rpcUrl = (process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop").trim();
  const chain = agikingChain(rpcUrl);
  const base = loadAgikingDeploymentAddresses(DEPLOYMENT_FILE);

  const { viem } = await network.connect({ network: "agiking", chainType: "l1" }) as unknown as { viem: any };
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer] = await viem.getWalletClients({ chain });
  const client = { public: publicClient, wallet: deployer } as const;
  const dep = deployer.account.address as Address;
  const nativeBalance = await publicClient.getBalance({ address: dep });
  console.log("Chain", AGIKING_CHAIN_ID, "deployer", dep, "native", formatEther(nativeBalance));

  const oldFactory = await viem.getContractAt("DealFactory", base.dealFactory, { client }) as AnyContract;
  const dl = await viem.getContractAt("DCToken", base.dlToken, { client }) as AnyContract;
  const infoNft = await viem.getContractAt("DealInfoNFT", base.dealInfoNFT, { client }) as AnyContract;
  const creditGraph = await viem.getContractAt("DealCreditGraph", base.dealCreditGraph, { client }) as AnyContract;
  const orderBook = await viem.getContractAt("DealSwapOrderBook", base.dealSwapOrderBook, { client }) as AnyContract;

  const oldFeeNonDL = await oldFactory.read.defaultFeeNonDL();
  const oldMintOnFees = await oldFactory.read.defaultMintOnFees();
  const oldTreasury = await oldFactory.read.treasury() as Address;
  const oldSpecialNoFeeToken = await oldFactory.read.specialNoFeeToken() as Address;
  const oldMsgPriceEnabled = await oldFactory.read.msgPriceEnabled();
  const oldMsgPriceToken = await oldFactory.read.msgPriceToken() as Address;
  const oldMsgPriceAmount = await oldFactory.read.msgPriceAmountInToken();
  const oldCreateBurnEnabled = await oldFactory.read.createBurnEnabled();
  const oldCreateBurnToken = await oldFactory.read.createBurnPricingToken() as Address;
  const oldCreateBurnAmount = await oldFactory.read.createBurnAmountInToken();
  const oldMinWindowSec = await oldFactory.read.minWindowSec();
  const oldMinTimeout = await oldFactory.read.minTimeoutSeconds();

  console.log("\n--- Deploy current Deal templates ---");
  const dealNoAssetImpl = await viem.deployContract("DealNoAsset", [], {
    client,
    libraries: { DealLib: base.dealLib },
  }) as AnyContract;
  console.log("DealNoAsset", dealNoAssetImpl.address);
  const dealAAssetNftImpl = await viem.deployContract("DealAAssetNft", [], {
    client,
    libraries: { DealLib: base.dealLib, DealAssetNftLib: base.dealAssetNftLib },
  }) as AnyContract;
  console.log("DealAAssetNft", dealAAssetNftImpl.address);
  const dealBAssetNftImpl = await viem.deployContract("DealBAssetNft", [], {
    client,
    libraries: { DealLib: base.dealLib, DealAssetNftLib: base.dealAssetNftLib },
  }) as AnyContract;
  console.log("DealBAssetNft", dealBAssetNftImpl.address);
  const dealAAssetNftOnlyImpl = await viem.deployContract("DealAAssetNftOnly", [], {
    client,
    libraries: { DealAssetNftLib: base.dealAssetNftLib },
  }) as AnyContract;
  console.log("DealAAssetNftOnly", dealAAssetNftOnlyImpl.address);
  const dealBAssetNftOnlyImpl = await viem.deployContract("DealBAssetNftOnly", [], {
    client,
    libraries: { DealAssetNftLib: base.dealAssetNftLib },
  }) as AnyContract;
  console.log("DealBAssetNftOnly", dealBAssetNftOnlyImpl.address);
  const dealOpenTokenTokenImpl = await viem.deployContract("DealOpenTokenToken", [], {
    client,
    libraries: { DealLib: base.dealLib },
  }) as AnyContract;
  console.log("DealOpenTokenToken", dealOpenTokenTokenImpl.address);

  console.log("\n--- Deploy new Factory stack ---");
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

  console.log("\n--- Deploy AGI/WAGI lane ---");
  const wrappedAGI = await viem.deployContract("WrappedAGI", [], { client }) as AnyContract;
  console.log("WrappedAGI", wrappedAGI.address);
  const router = await viem.deployContract("DealRouter", [wrappedAGI.address, base.dealSwapOrderBook, base.dealPairManager], { client }) as AnyContract;
  console.log("DealRouter", router.address);
  const routerQuoter = await viem.deployContract("DealRouterQuoter", [base.dealSwapOrderBook], { client }) as AnyContract;
  console.log("DealRouterQuoter", routerQuoter.address);
  const swapAssetRegistry = await viem.deployContract("DealSwapAssetRegistry", [
    dep,
    pairManager.address,
    router.address,
    base.dlToken,
    wrappedAGI.address,
    base.usdt,
    base.ausd,
  ], { client }) as AnyContract;
  console.log("DealSwapAssetRegistry", swapAssetRegistry.address);

  console.log("\n--- Wire new Factory ---");
  await tx("Factory.setCoreGlobals", publicClient, factory.write.setCoreGlobals([
    base.dlToken,
    base.dealInfoNFT,
    wrappedAGI.address,
    pairManager.address,
  ]));
  await tx("Factory.setServiceGlobals", publicClient, factory.write.setServiceGlobals([
    messageHub.address,
    creditGraph.address,
    activityIndex.address,
    resultIndex.address,
    registry.address,
  ]));
  await tx("Factory.setOpsGlobals orderBook", publicClient, factory.write.setOpsGlobals([
    base.dealSwapOrderBook,
    ZERO,
    ZERO,
  ]));
  await tx("Registry.setDealImplementations", publicClient, registry.write.setDealImplementations([
    base.dealImplementation,
    dealNoAssetImpl.address,
    dealAAssetNftImpl.address,
    dealBAssetNftImpl.address,
    dealAAssetNftOnlyImpl.address,
    dealBAssetNftOnlyImpl.address,
    dealOpenTokenTokenImpl.address,
  ]));
  await tx("Factory.setRecognizedTokens", publicClient, factory.write.setRecognizedTokens([base.ausd, base.usdt]));
  if (oldTreasury !== zeroAddress) await tx("Factory.setTreasuryByAdmin", publicClient, factory.write.setTreasuryByAdmin([oldTreasury]));
  await tx("Factory.setFeesAndMintOnFees", publicClient, factory.write.setFeesAndMintOnFees([
    oldFeeNonDL[0],
    oldFeeNonDL[1],
    oldMintOnFees[0],
    oldMintOnFees[1],
  ]));
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
  await tx("PairManager.mapExistingPair AUSD", publicClient, pairManager.write.mapExistingPair([base.ausd, base.pairDlAusd]));
  await tx("PairManager.mapExistingPair USDT", publicClient, pairManager.write.mapExistingPair([base.usdt, base.pairDlUsdt]));

  console.log("\n--- Permissions ---");
  const minterRole = await dl.read.MINTER_ROLE();
  await maybeTx("DealCoin.grantRole(MINTER_ROLE, newFactory)", publicClient, () => dl.write.grantRole([minterRole, factory.address]));
  await maybeTx("DealInfoNFT.addFactory(newFactory)", publicClient, () => infoNft.write.addFactory([factory.address]));
  await maybeTx("DealInfoNFT.setFactory(newFactory)", publicClient, () => infoNft.write.setFactory([factory.address]));
  await maybeTx("DealCreditGraph.setRecorder(newFactory)", publicClient, () => creditGraph.write.setRecorder([factory.address, true]));
  await maybeTx("OrderBook.setRouter(newRouter)", publicClient, () => orderBook.write.setRouter([router.address]));

  console.log("\n--- Create DC-AGI pair ---");
  await tx("PairManager.createPair AGI", publicClient, pairManager.write.createPair([wrappedAGI.address, 3, 1000]));
  const pairDlAgi = await pairManager.read.pairForToken([wrappedAGI.address]) as Address;
  console.log("DC-AGI Pair", pairDlAgi);
  const initDl = envBigInt("PAIR_INIT_DL", 100_000n * ONE);
  const initAgi = envBigInt("PAIR_INIT_AGI", parseEther("100000"));
  if (initDl > 0n && initAgi > 0n) {
    await tx("DealCoin.transfer pairDlAgi", publicClient, dl.write.transfer([pairDlAgi, initDl]));
    await tx("WrappedAGI.deposit", publicClient, wrappedAGI.write.deposit({ value: initAgi }));
    await tx("WrappedAGI.transfer pairDlAgi", publicClient, wrappedAGI.write.transfer([pairDlAgi, initAgi]));
    await tx("PairManager.initPair AGI", publicClient, pairManager.write.initPair([pairDlAgi, 0n]));
  } else {
    console.log("  SKIP AGI pair init because PAIR_INIT_DL or PAIR_INIT_AGI is 0");
  }

  console.log("\n--- Deploy updated domain stack ---");
  const dcDomain = await viem.deployContract("DCDomain", [base.dlToken, dep], { client }) as AnyContract;
  console.log("DCDomain", dcDomain.address);
  const dcRank = await viem.deployContract("DCDomainRank", [base.dlToken, dcDomain.address, dep], { client }) as AnyContract;
  console.log("DCDomainRank", dcRank.address);
  const dcRankReader = await viem.deployContract("DCDomainRankReader", [dcRank.address], { client }) as AnyContract;
  console.log("DCDomainRankReader", dcRankReader.address);
  const dcDomainListReader = await viem.deployContract("DCDomainListReader", [dcDomain.address, dcRank.address], { client }) as AnyContract;
  console.log("DCDomainListReader", dcDomainListReader.address);
  const dcMarket = await viem.deployContract("DCDomainMarket", [dcDomain.address, base.dlToken, dep, 100n], { client }) as AnyContract;
  console.log("DCDomainMarket", dcMarket.address);
  const dcSwap = await viem.deployContract("DCDomainSwap", [dcDomain.address, dcRank.address, factory.address], { client }) as AnyContract;
  console.log("DCDomainSwap", dcSwap.address);
  const dcHall = await viem.deployContract("DCDomainHall", [dcRank.address, dcDomain.address, factory.address], { client }) as AnyContract;
  console.log("DCDomainHall", dcHall.address);

  await tx("DCDomain.setDomainMarket", publicClient, dcDomain.write.setDomainMarket([dcMarket.address]));
  await tx("Factory.setOpsGlobals dcDomainRank", publicClient, factory.write.setOpsGlobals([ZERO, ZERO, dcRank.address]));
  await tx("DCDomainRank.setAutoCloser", publicClient, dcRank.write.setAutoCloser([factory.address]));
  await tx("Factory.allow DCDomainSwap", publicClient, factory.write.setAllowedCreateFor([dcSwap.address, true]));
  await tx("Factory.allow DCDomainHall", publicClient, factory.write.setAllowedCreateFor([dcHall.address, true]));
  await tx("DCDomainRank.reporter Swap", publicClient, dcRank.write.setDealReporter([dcSwap.address, true]));
  await tx("DCDomainRank.reporter Hall", publicClient, dcRank.write.setDealReporter([dcHall.address, true]));

  const deployedAt = new Date().toISOString();
  const mergedAddresses: Record<string, string> = {
    ...base,
    wrappedNative: getAddress(wrappedAGI.address),
    agi: getAddress(wrappedAGI.address),
    dealNoAssetImplementation: getAddress(dealNoAssetImpl.address),
    dealAAssetNftImplementation: getAddress(dealAAssetNftImpl.address),
    dealBAssetNftImplementation: getAddress(dealBAssetNftImpl.address),
    dealAAssetNftOnlyImplementation: getAddress(dealAAssetNftOnlyImpl.address),
    dealBAssetNftOnlyImplementation: getAddress(dealBAssetNftOnlyImpl.address),
    dealOpenTokenTokenImplementation: getAddress(dealOpenTokenTokenImpl.address),
    dealFactory: getAddress(factory.address),
    dealPairManager: getAddress(pairManager.address),
    dealMessageHub: getAddress(messageHub.address),
    dealActivityIndex: getAddress(activityIndex.address),
    dealResultIndex: getAddress(resultIndex.address),
    dealImplementationRegistry: getAddress(registry.address),
    dealRouter: getAddress(router.address),
    dealRouterQuoter: getAddress(routerQuoter.address),
    dealSwapAssetRegistry: getAddress(swapAssetRegistry.address),
    pairDlAgi: getAddress(pairDlAgi),
    dcDomain: getAddress(dcDomain.address),
    dcDomainRank: getAddress(dcRank.address),
    dcDomainRankReader: getAddress(dcRankReader.address),
    dcDomainListReader: getAddress(dcDomainListReader.address),
    dcDomainMarket: getAddress(dcMarket.address),
    dcDomainSwap: getAddress(dcSwap.address),
    dcDomainHall: getAddress(dcHall.address),
  };

  const out = {
    chainId: AGIKING_CHAIN_ID,
    rpcUrl,
    deployedAt,
    deployer: dep,
    addresses: mergedAddresses,
    abi: deploymentAbi(),
  };

  mkdirSync("deployments", { recursive: true });
  copyFileSync(join("deployments", DEPLOYMENT_FILE), join("deployments", `${DEPLOYMENT_FILE}.bak-${Date.now()}`));
  writeFileSync(join("deployments", DEPLOYMENT_FILE), JSON.stringify(out, null, 2));

  const handoffName = `frontend-handoff-agiking-${AGIKING_CHAIN_ID}-${deployedAt.replace(/[-:T]/g, "").slice(0, 15)}.md`;
  const handoff = `# Agiking 当前更新部署交接

部署时间：${deployedAt}

部署钱包：\`${dep}\`

## 前端主地址

| 模块 | 地址 |
| --- | --- |
| DealFactory | \`${mergedAddresses.dealFactory}\` |
| DealPairManager | \`${mergedAddresses.dealPairManager}\` |
| DealMessageHub | \`${mergedAddresses.dealMessageHub}\` |
| DealActivityIndex | \`${mergedAddresses.dealActivityIndex}\` |
| DealResultIndex | \`${mergedAddresses.dealResultIndex}\` |
| DealRouter | \`${mergedAddresses.dealRouter}\` |
| DealSwapAssetRegistry | \`${mergedAddresses.dealSwapAssetRegistry}\` |
| WrappedAGI/WAGI | \`${mergedAddresses.wrappedNative}\` |
| DC-AGI Pair | \`${mergedAddresses.pairDlAgi}\` |
| DC-USDT Pair | \`${mergedAddresses.pairDlUsdt}\` |
| DC-AUSD Pair | \`${mergedAddresses.pairDlAusd}\` |
| DCDomain | \`${mergedAddresses.dcDomain}\` |
| DCDomainRank | \`${mergedAddresses.dcDomainRank}\` |
| DCDomainRankReader | \`${mergedAddresses.dcDomainRankReader}\` |
| DCDomainListReader | \`${mergedAddresses.dcDomainListReader}\` |
| DCDomainSwap | \`${mergedAddresses.dcDomainSwap}\` |
| DCDomainHall | \`${mergedAddresses.dcDomainHall}\` |

完整 ABI 和地址已写入：

\`\`\`text
deployments/${DEPLOYMENT_FILE}
\`\`\`

## 本次重点

- Factory 已换新版：pair 运维入口迁到 DealPairManager。
- 前端查官方 swap pair 优先读 DealSwapAssetRegistry.getSwapPairSet()。
- 域名栈已换新版：新域名数据从新 DCDomain 开始。
- DealCoin(DC)/AUSD/USDT/DealInfoNFT/DealCreditGraph/OrderBook 复用旧合约。
`;
  writeFileSync(join("deployments", handoffName), handoff);
  console.log("\nWrote deployments/" + DEPLOYMENT_FILE);
  console.log("Wrote deployments/" + handoffName);
}

await main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
