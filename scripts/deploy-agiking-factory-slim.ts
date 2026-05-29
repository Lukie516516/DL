/**
 * Minimal Agiking deploy for the Factory slimming update.
 *
 * Reuses data-bearing contracts:
 * - DealCoin/DC, AUSD, USDT, DealInfoNFT, DealCreditGraph
 * - DCDomain, DCDomainRank, DCDomainMarket/ListReader
 * - existing swap pairs and order book
 *
 * Deploys only contracts that must point at the new Factory:
 * - DealFactory, DealPairManager, MessageHub, ActivityIndex, ResultIndex, Registry
 * - changed deal template implementations
 * - Router/Quoter/SwapAssetRegistry for the current swap ABI
 * - DCDomainSwap and DCDomainHall, because their constructor stores the Factory
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, formatEther, getAddress, parseGwei, zeroAddress, type Address } from "viem";
import { loadAgikingDeploymentAddresses } from "./load-agiking-deployment.js";

const AGIKING_CHAIN_ID = 31415926;
const DEPLOYMENT_FILE = "agiking-31415926.json";
const ZERO = "0x0000000000000000000000000000000000000000" as const;

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

function loadDeploymentJson() {
  return JSON.parse(readFileSync(join("deployments", DEPLOYMENT_FILE), "utf8")) as {
    addresses: Record<string, string>;
    abi: Record<string, unknown[]>;
  };
}

async function waitFor(publicClient: any, hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
  return receipt;
}

function gasOptions(extra: Record<string, unknown> = {}) {
  const gwei = process.env.AGIKING_GAS_PRICE_GWEI ?? "2";
  return { gasPrice: parseGwei(gwei), ...extra };
}

async function tx(label: string, publicClient: any, hashPromise: Promise<`0x${string}`>) {
  const hash = await hashPromise;
  await waitFor(publicClient, hash);
  console.log(`  OK ${label}: ${hash}`);
}

async function writeTx(
  label: string,
  publicClient: any,
  contract: AnyContract,
  fn: string,
  args: unknown[] = [],
) {
  await tx(label, publicClient, contract.write[fn](args, gasOptions()));
}

async function maybeTx(label: string, publicClient: any, fn: () => Promise<`0x${string}`>) {
  try {
    await tx(label, publicClient, fn());
  } catch (err: any) {
    console.log(`  SKIP ${label}: ${err?.shortMessage ?? err?.message ?? err}`);
  }
}

async function deploy(
  viem: any,
  name: string,
  args: unknown[] = [],
  options: Record<string, unknown> = {},
) {
  const mergedOptions = { ...options, ...gasOptions() };
  try {
    return await viem.deployContract(name, args, mergedOptions) as AnyContract;
  } catch (err: any) {
    const details = [
      err?.details,
      err?.shortMessage,
      err?.message,
      err?.cause?.details,
      err?.cause?.message,
    ].filter(Boolean).join("\n");
    const match = details.match(/insufficient gas for floor data gas cost: have \d+, want (\d+)/i);
    if (!match) throw err;

    const wanted = BigInt(match[1]);
    const gas = (wanted * 120n) / 100n + 50_000n;
    console.log(`  RETRY ${name} with gas ${gas.toString()} for floor data cost`);
    return await viem.deployContract(name, args, { ...mergedOptions, gas }) as AnyContract;
  }
}

async function main() {
  const rpcUrl = (process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop").trim();
  const chain = agikingChain(rpcUrl);
  const base = loadAgikingDeploymentAddresses(DEPLOYMENT_FILE);
  const baseJson = loadDeploymentJson();

  const { viem } = await network.connect({ network: "agiking", chainType: "l1" }) as unknown as { viem: any };
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer] = await viem.getWalletClients({ chain });
  const client = { public: publicClient, wallet: deployer } as const;
  const dep = deployer.account.address as Address;
  const nativeBalance = await publicClient.getBalance({ address: dep });
  console.log("Chain", AGIKING_CHAIN_ID, "deployer", dep, "native", formatEther(nativeBalance));

  const oldFactory = await viem.getContractAt("DealFactory", base.dealFactory, { client }) as AnyContract;
  const oldOwner = await oldFactory.read.owner() as Address;
  if (getAddress(oldOwner) !== getAddress(dep)) {
    throw new Error(`Deployer ${dep} is not current DealFactory owner ${oldOwner}`);
  }

  const dl = await viem.getContractAt("DCToken", base.dlToken, { client }) as AnyContract;
  const infoNft = await viem.getContractAt("DealInfoNFT", base.dealInfoNFT, { client }) as AnyContract;
  const creditGraph = await viem.getContractAt("DealCreditGraph", base.dealCreditGraph!, { client }) as AnyContract;
  const orderBook = await viem.getContractAt("DealSwapOrderBook", base.dealSwapOrderBook, { client }) as AnyContract;
  const domainRank = await viem.getContractAt("DCDomainRank", base.dcDomainRank, { client }) as AnyContract;

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
  const oldSwapOrderBook = base.dealSwapOrderBook;

  console.log("\n--- Deploy changed template implementations ---");
  const dealNoAssetImpl = await deploy(viem, "DealNoAsset", [], {
    client,
    libraries: { DealLib: base.dealLib },
  });
  const dealAAssetNftImpl = await deploy(viem, "DealAAssetNft", [], {
    client,
    libraries: { DealLib: base.dealLib, DealAssetNftLib: base.dealAssetNftLib },
  });
  const dealBAssetNftImpl = await deploy(viem, "DealBAssetNft", [], {
    client,
    libraries: { DealLib: base.dealLib, DealAssetNftLib: base.dealAssetNftLib },
  });
  const dealOpenTokenTokenImpl = await deploy(viem, "DealOpenTokenToken", [], {
    client,
    libraries: { DealLib: base.dealLib },
  });
  console.log("DealNoAsset", dealNoAssetImpl.address);
  console.log("DealAAssetNft", dealAAssetNftImpl.address);
  console.log("DealBAssetNft", dealBAssetNftImpl.address);
  console.log("DealOpenTokenToken", dealOpenTokenTokenImpl.address);

  console.log("\n--- Deploy new Factory stack ---");
  const factory = await deploy(viem, "DealFactory", [
    base.dealImplementation,
    base.pairImplementation,
    oldMinTimeout,
  ], { client });
  const pairManager = await deploy(viem, "DealPairManager", [factory.address], { client });
  const messageHub = await deploy(viem, "DealMessageHub", [factory.address], { client });
  const activityIndex = await deploy(viem, "DealActivityIndex", [factory.address], { client });
  const resultIndex = await deploy(viem, "DealResultIndex", [factory.address], { client });
  const registry = await deploy(viem, "DealImplementationRegistry", [], { client });
  console.log("DealFactory", factory.address);
  console.log("DealPairManager", pairManager.address);
  console.log("DealMessageHub", messageHub.address);
  console.log("DealActivityIndex", activityIndex.address);
  console.log("DealResultIndex", resultIndex.address);
  console.log("DealImplementationRegistry", registry.address);

  console.log("\n--- Deploy Router/Quoter and domain entry contracts ---");
  const router = await deploy(viem, "DealRouter", [base.wrappedNative, oldSwapOrderBook], { client });
  const routerQuoter = await deploy(viem, "DealRouterQuoter", [oldSwapOrderBook], { client });
  const swapAssetRegistry = await deploy(viem, "DealSwapAssetRegistry", [
    dep,
    pairManager.address,
    router.address,
    base.dlToken,
    base.wrappedNative,
    base.usdt,
    base.ausd,
  ], { client });
  const domainSwap = await deploy(viem, "DCDomainSwap", [base.dcDomain, base.dcDomainRank, factory.address], { client });
  const domainHall = await deploy(viem, "DCDomainHall", [base.dcDomainRank, base.dcDomain, factory.address], { client });
  console.log("DealRouter", router.address);
  console.log("DealRouterQuoter", routerQuoter.address);
  console.log("DealSwapAssetRegistry", swapAssetRegistry.address);
  console.log("DCDomainSwap", domainSwap.address);
  console.log("DCDomainHall", domainHall.address);

  console.log("\n--- Wire new Factory stack ---");
  await writeTx("Factory.setCoreGlobals", publicClient, factory, "setCoreGlobals", [
    base.dlToken,
    base.dealInfoNFT,
    base.wrappedNative,
    pairManager.address,
  ]);
  await writeTx("Factory.setServiceGlobals", publicClient, factory, "setServiceGlobals", [
    messageHub.address,
    creditGraph.address,
    activityIndex.address,
    resultIndex.address,
    registry.address,
  ]);
  await writeTx("Factory.setOpsGlobals", publicClient, factory, "setOpsGlobals", [
    oldSwapOrderBook,
    base.dealNftGovernanceActivity ?? ZERO,
    base.dcDomainRank,
  ]);
  await writeTx("Registry.setDealImplementations", publicClient, registry, "setDealImplementations", [
    base.dealImplementation,
    dealNoAssetImpl.address,
    dealAAssetNftImpl.address,
    dealBAssetNftImpl.address,
    base.dealAAssetNftOnlyImplementation!,
    base.dealBAssetNftOnlyImplementation!,
    dealOpenTokenTokenImpl.address,
  ]);
  await writeTx("Factory.setRecognizedTokens", publicClient, factory, "setRecognizedTokens", [base.ausd, base.usdt]);
  if (oldTreasury !== zeroAddress) await writeTx("Factory.setTreasuryByAdmin", publicClient, factory, "setTreasuryByAdmin", [oldTreasury]);
  await writeTx("Factory.setFeesAndMintOnFees", publicClient, factory, "setFeesAndMintOnFees", [
    oldFeeNonDL[0],
    oldFeeNonDL[1],
    oldMintOnFees[0],
    oldMintOnFees[1],
  ]);
  if (oldSpecialNoFeeToken !== zeroAddress) {
    await writeTx("Factory.setSpecialNoFeeTokenByAdmin", publicClient, factory, "setSpecialNoFeeTokenByAdmin", [oldSpecialNoFeeToken]);
  }
  await writeTx("Factory.setMessagePriceRule", publicClient, factory, "setMessagePriceRule", [
    oldMsgPriceEnabled,
    oldMsgPriceToken,
    oldMsgPriceAmount,
  ]);
  await writeTx("Factory.setCreateBurnRule", publicClient, factory, "setCreateBurnRule", [
    oldCreateBurnEnabled,
    oldCreateBurnToken,
    oldCreateBurnAmount,
  ]);
  await writeTx("Factory.setMinWindowSec", publicClient, factory, "setMinWindowSec", [oldMinWindowSec]);
  await writeTx("PairManager.mapExistingPair AUSD", publicClient, pairManager, "mapExistingPair", [base.ausd, base.pairDlAusd]);
  await writeTx("PairManager.mapExistingPair USDT", publicClient, pairManager, "mapExistingPair", [base.usdt, base.pairDlUsdt]);
  if (base.pairDlAgi) {
    await writeTx("PairManager.mapExistingPair AGI", publicClient, pairManager, "mapExistingPair", [base.wrappedNative, base.pairDlAgi]);
  }

  console.log("\n--- Permissions and entry wiring ---");
  const minterRole = await dl.read.MINTER_ROLE();
  await maybeTx("DealCoin.grantRole(MINTER_ROLE, newFactory)", publicClient, () => dl.write.grantRole([minterRole, factory.address], gasOptions()));
  await maybeTx("DealInfoNFT.addFactory(newFactory)", publicClient, () => infoNft.write.addFactory([factory.address], gasOptions()));
  await maybeTx("DealInfoNFT.setFactory(newFactory)", publicClient, () => infoNft.write.setFactory([factory.address], gasOptions()));
  await maybeTx("DealCreditGraph.setRecorder(newFactory)", publicClient, () => creditGraph.write.setRecorder([factory.address, true], gasOptions()));
  if (base.dealNftGovernanceActivity) {
    const activity = await viem.getContractAt("DealNftGovernanceActivity", base.dealNftGovernanceActivity, { client }) as AnyContract;
    await maybeTx("DealNftGovernanceActivity.setRecorder(newFactory)", publicClient, () => activity.write.setRecorder([factory.address, true], gasOptions()));
  }
  await maybeTx("OrderBook.setRouter(newRouter)", publicClient, () => orderBook.write.setRouter([router.address], gasOptions()));
  await writeTx("Factory.allow DCDomainSwap", publicClient, factory, "setAllowedCreateFor", [domainSwap.address, true]);
  await writeTx("Factory.allow DCDomainHall", publicClient, factory, "setAllowedCreateFor", [domainHall.address, true]);
  await writeTx("DCDomainRank.setAutoCloser", publicClient, domainRank, "setAutoCloser", [factory.address]);
  await writeTx("DCDomainRank.reporter Swap", publicClient, domainRank, "setDealReporter", [domainSwap.address, true]);
  await writeTx("DCDomainRank.reporter Hall", publicClient, domainRank, "setDealReporter", [domainHall.address, true]);

  const deployedAt = new Date().toISOString();
  const mergedAddresses: Record<string, string> = {
    ...baseJson.addresses,
    dealNoAssetImplementation: getAddress(dealNoAssetImpl.address),
    dealAAssetNftImplementation: getAddress(dealAAssetNftImpl.address),
    dealBAssetNftImplementation: getAddress(dealBAssetNftImpl.address),
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
    dcDomainSwap: getAddress(domainSwap.address),
    dcDomainHall: getAddress(domainHall.address),
  };

  const mergedAbi = {
    ...baseJson.abi,
    DealNoAsset: loadAbi("DealNoAsset.sol/DealNoAsset.json"),
    DealAAssetNft: loadAbi("DealAAssetNft.sol/DealAAssetNft.json"),
    DealBAssetNft: loadAbi("DealBAssetNft.sol/DealBAssetNft.json"),
    DealOpenTokenToken: loadAbi("DealOpenTokenToken.sol/DealOpenTokenToken.json"),
    DealFactory: loadAbi("DealFactory.sol/DealFactory.json"),
    DealPairManager: loadAbi("DealPairManager.sol/DealPairManager.json"),
    DealMessageHub: loadAbi("DealMessageHub.sol/DealMessageHub.json"),
    DealActivityIndex: loadAbi("DealActivityIndex.sol/DealActivityIndex.json"),
    DealResultIndex: loadAbi("DealResultIndex.sol/DealResultIndex.json"),
    DealImplementationRegistry: loadAbi("DealImplementationRegistry.sol/DealImplementationRegistry.json"),
    DealRouter: loadAbi("DealSwapRouter.sol/DealRouter.json"),
    DealRouterQuoter: loadAbi("DealRouterQuoter.sol/DealRouterQuoter.json"),
    DealSwapAssetRegistry: loadAbi("DealSwapAssetRegistry.sol/DealSwapAssetRegistry.json"),
    DCDomainSwap: loadAbi("DCdomainswap.sol/DCDomainSwap.json"),
    DCDomainHall: loadAbi("DCDomainHall.sol/DCDomainHall.json"),
  };

  const out = {
    ...baseJson,
    chainId: AGIKING_CHAIN_ID,
    rpcUrl,
    deployedAt,
    deployer: dep,
    addresses: mergedAddresses,
    abi: mergedAbi,
  };

  mkdirSync("deployments/backups", { recursive: true });
  copyFileSync(
    join("deployments", DEPLOYMENT_FILE),
    join("deployments/backups", `agiking-31415926.before-factory-slim-${Date.now()}.json`),
  );
  writeFileSync(join("deployments", DEPLOYMENT_FILE), JSON.stringify(out, null, 2));

  const handoffStamp = deployedAt.replace(/\D/g, "").slice(0, 14);
  const handoffName = `frontend-handoff-factory-slim-${handoffStamp}.md`;
  const handoff = `# Agiking Factory 瘦身部署交接

部署时间：${deployedAt}

部署钱包：\`${dep}\`

## 新地址

| 模块 | 地址 |
| --- | --- |
| DealFactory | \`${mergedAddresses.dealFactory}\` |
| DealPairManager | \`${mergedAddresses.dealPairManager}\` |
| DealMessageHub | \`${mergedAddresses.dealMessageHub}\` |
| DealActivityIndex | \`${mergedAddresses.dealActivityIndex}\` |
| DealResultIndex | \`${mergedAddresses.dealResultIndex}\` |
| DealImplementationRegistry | \`${mergedAddresses.dealImplementationRegistry}\` |
| DealRouter | \`${mergedAddresses.dealRouter}\` |
| DealRouterQuoter | \`${mergedAddresses.dealRouterQuoter}\` |
| DealSwapAssetRegistry | \`${mergedAddresses.dealSwapAssetRegistry}\` |
| DCDomainSwap | \`${mergedAddresses.dcDomainSwap}\` |
| DCDomainHall | \`${mergedAddresses.dcDomainHall}\` |

## 复用地址

| 模块 | 地址 |
| --- | --- |
| DealCoin/DC | \`${mergedAddresses.dlToken}\` |
| DealInfoNFT | \`${mergedAddresses.dealInfoNFT}\` |
| DealCreditGraph | \`${mergedAddresses.dealCreditGraph}\` |
| DCDomain | \`${mergedAddresses.dcDomain}\` |
| DCDomainRank | \`${mergedAddresses.dcDomainRank}\` |
| DCDomainMarket | \`${mergedAddresses.dcDomainMarket}\` |
| DCDomainListReader | \`${mergedAddresses.dcDomainListReader ?? ""}\` |

## 前端注意

- active/completed deal 列表直接读 \`DealActivityIndex\`，不要再读 \`DealFactory.trackedCount/getTracked/isTracked/completedCount/getCompleted\`。
- \`DealFactory\` 只保留创建、权限、模块接线、奖励/信用回调。
- 完整地址和 ABI 已写入 \`deployments/${DEPLOYMENT_FILE}\`。
`;
  writeFileSync(join("deployments", handoffName), handoff);
  writeFileSync(
    join("docs", "前端部署地址交接文档.md"),
    `# 前端部署地址交接文档\n\n完整 ABI 和地址在：\n\n\`\`\`text\ndeployments/${DEPLOYMENT_FILE}\n\`\`\`\n\n前端可直接看的单次 handoff 文档：\n\n\`\`\`text\ndeployments/${handoffName}\n\`\`\`\n\n本次重点：\n\n- 新 \`DealFactory\`：\`${mergedAddresses.dealFactory}\`\n- 新 \`DealActivityIndex\`：\`${mergedAddresses.dealActivityIndex}\`\n- 新 \`DealResultIndex\`：\`${mergedAddresses.dealResultIndex}\`\n- 新 \`DealRouter\`：\`${mergedAddresses.dealRouter}\`\n- 新 \`DealRouterQuoter\`：\`${mergedAddresses.dealRouterQuoter}\`\n- 新 \`DCDomainSwap\`：\`${mergedAddresses.dcDomainSwap}\`\n- 新 \`DCDomainHall\`：\`${mergedAddresses.dcDomainHall}\`\n\n注意：active/completed deal 列表直接读 \`DealActivityIndex\`，不要再读 \`DealFactory\` 的旧只读壳函数。\n`,
  );

  console.log("\nWrote deployments/" + DEPLOYMENT_FILE);
  console.log("Wrote deployments/" + handoffName);
  console.log("Wrote docs/前端部署地址交接文档.md");
}

await main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
