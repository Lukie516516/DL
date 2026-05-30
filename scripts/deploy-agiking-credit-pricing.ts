/**
 * Minimal Agiking deploy for:
 * - DC and AGI fee credit pricing through official DL pairs
 * - reward-rate guard: A + B + C minted reward cannot exceed protocol fee
 *
 * Reuses data-bearing contracts and existing liquidity:
 * - DealCoin/DC, AUSD, USDT, WrappedAGI
 * - DealInfoNFT, DealCreditGraph, governance activity
 * - DCDomain, DCDomainRank, DCDomain readers
 * - existing DL/AUSD, DL/USDT, DL/AGI pairs
 * - DealRouter, DealRouterQuoter, DealSwapOrderBook
 *
 * Deploys only contracts that must link to the new DealLib or new Factory:
 * - DealLib
 * - DealNoAsset, DealAAssetNft, DealBAssetNft, DealOpenTokenToken
 * - DealFactory, DealPairManager, DealMessageHub, DealActivityIndex,
 *   DealResultIndex, DealImplementationRegistry
 * - DCDomainSwap and DCDomainHall, because their constructor stores Factory
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, formatEther, getAddress, parseGwei, zeroAddress, type Address } from "viem";
import { loadAgikingDeploymentAddresses } from "./load-agiking-deployment.js";

const AGIKING_CHAIN_ID = 31415926;
const DEPLOYMENT_FILE = "agiking-31415926.json";
const LEGACY_FACTORY_PAIR_SETTER_ABI = [
  {
    type: "function",
    name: "setPairFactory",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pair", type: "address" },
      { name: "f", type: "address" },
    ],
    outputs: [],
  },
] as const;

type AnyContract = {
  address: Address;
  abi?: unknown[];
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
  const p = join(process.cwd(), "deployments", DEPLOYMENT_FILE);
  return JSON.parse(readFileSync(p, "utf8")) as {
    addresses: Record<string, string>;
    abi: Record<string, unknown[]>;
    notes?: string[];
  };
}

function requiredAddress(name: string, value: Address | undefined): Address {
  if (!value) throw new Error(`Missing required deployment address: ${name}`);
  return value;
}

function ratioParts(r: any): [number, number] {
  if (Array.isArray(r)) return [Number(r[0]), Number(r[1])];
  return [Number(r.num), Number(r.den)];
}

function gasOptions(extra: Record<string, unknown> = {}) {
  const gwei = process.env.AGIKING_GAS_PRICE_GWEI ?? "2";
  return { gasPrice: parseGwei(gwei), ...extra };
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
    console.log(`  SKIP ${label}: ${err?.shortMessage ?? err?.message ?? err}`);
  }
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

function refreshAbi(existingAbi: Record<string, unknown[]> = {}) {
  return {
    ...existingAbi,
    DealLib: loadAbi("utils/DealLib.sol/DealLib.json"),
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
    DealSwapAssetRegistry: loadAbi("DealSwapAssetRegistry.sol/DealSwapAssetRegistry.json"),
    DCDomainSwap: loadAbi("DCdomainswap.sol/DCDomainSwap.json"),
    DCDomainHall: loadAbi("DCDomainHall.sol/DCDomainHall.json"),
  };
}

function writeHandoff(file: string, deployedAt: string, deployer: Address, a: Record<string, string>) {
  const md = `# Agiking 信用分折算与返利上限部署交接

部署时间：${deployedAt}

部署钱包：\`${deployer}\`

链：Agiking \`${AGIKING_CHAIN_ID}\`

## 本次目的

- DC/DC 点对点 deal：手续费可按官方 DC/稳定币 pair 折算成 U 价值，并写入信用分。
- AGI 相关点对点 deal：手续费先按 AGI/DC pair 折成 DC，再按 DC/稳定币 pair 折成 U 价值，并写入信用分。
- 返利参数增加链上保护：A、B、C 三方理论最高返利总和不得超过协议手续费，允许相等。

## 前端必须切换的新地址

| 模块 | 地址 |
| --- | --- |
| DealFactory | \`${a.dealFactory}\` |
| DealPairManager | \`${a.dealPairManager}\` |
| DealMessageHub | \`${a.dealMessageHub}\` |
| DealActivityIndex | \`${a.dealActivityIndex}\` |
| DealResultIndex | \`${a.dealResultIndex}\` |
| DealImplementationRegistry | \`${a.dealImplementationRegistry}\` |
| DealSwapAssetRegistry | \`${a.dealSwapAssetRegistry}\` |
| DCDomainSwap | \`${a.dcDomainSwap}\` |
| DCDomainHall | \`${a.dcDomainHall}\` |

## 新模板实现

| 模板 | 地址 |
| --- | --- |
| DealLib | \`${a.dealLib}\` |
| DealNoAsset | \`${a.dealNoAssetImplementation}\` |
| DealAAssetNft | \`${a.dealAAssetNftImplementation}\` |
| DealBAssetNft | \`${a.dealBAssetNftImplementation}\` |
| DealOpenTokenToken | \`${a.dealOpenTokenTokenImplementation}\` |

## 复用地址

| 模块 | 地址 |
| --- | --- |
| DealCoin/DC | \`${a.dlToken}\` |
| AUSD | \`${a.ausd}\` |
| USDT | \`${a.usdt}\` |
| WrappedAGI | \`${a.wrappedNative}\` |
| DealInfoNFT | \`${a.dealInfoNFT}\` |
| DealCreditGraph | \`${a.dealCreditGraph}\` |
| DealReader | \`${a.dealReader}\` |
| DealRouter | \`${a.dealRouter}\` |
| DealRouterQuoter | \`${a.dealRouterQuoter ?? ""}\` |
| DealSwapOrderBook | \`${a.dealSwapOrderBook}\` |
| DCDomain | \`${a.dcDomain}\` |
| DCDomainRank | \`${a.dcDomainRank}\` |
| DCDomainRankReader | \`${a.dcDomainRankReader ?? ""}\` |
| DCDomainListReader | \`${a.dcDomainListReader ?? ""}\` |

## 官方 pair

| pair | 地址 |
| --- | --- |
| DC/AUSD | \`${a.pairDlAusd}\` |
| DC/USDT | \`${a.pairDlUsdt}\` |
| DC/AGI | \`${a.pairDlAgi ?? ""}\` |

## 前端注意

- 开新 deal、域名下创建 deal、消息、交易时间线和奖励结果全部使用新的 \`DealFactory\` 周边地址。
- 官方 swap 资产发现继续优先读 \`DealSwapAssetRegistry.getSwapPairSet()\`。
- 三个官方 pair 的控制权已接到新 \`DealPairManager\`，后续虚拟流动性/手续费调参走新 \`DealPairManager\`。
- \`DealReader\` 没有状态，本次复用旧地址即可。
- 旧 deal 不会迁移；新 Factory 生效后创建的 deal 才会使用新的信用分折算逻辑。
- 完整 ABI 和地址已写入 \`deployments/${DEPLOYMENT_FILE}\`。
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
  const requiredOwner = getAddress(await oldFactory.read.owner()) as Address;
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

  console.log("\n--- Deploy new DealLib and template implementations ---");
  const dealLib = await deploy(viem, "DealLib", [], { client });
  const dealNoAssetImpl = await deploy(viem, "DealNoAsset", [], {
    client,
    libraries: { DealLib: dealLib.address },
  });
  const dealAAssetNftImpl = await deploy(viem, "DealAAssetNft", [], {
    client,
    libraries: { DealLib: dealLib.address, DealAssetNftLib: requiredAddress("dealAssetNftLib", base.dealAssetNftLib) },
  });
  const dealBAssetNftImpl = await deploy(viem, "DealBAssetNft", [], {
    client,
    libraries: { DealLib: dealLib.address, DealAssetNftLib: requiredAddress("dealAssetNftLib", base.dealAssetNftLib) },
  });
  const dealOpenTokenTokenImpl = await deploy(viem, "DealOpenTokenToken", [], {
    client,
    libraries: { DealLib: dealLib.address },
  });
  console.log("DealLib", dealLib.address);
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

  console.log("\n--- Deploy new domain entry contracts ---");
  const domainSwap = await deploy(viem, "DCDomainSwap", [base.dcDomain, base.dcDomainRank, factory.address], { client });
  const domainHall = await deploy(viem, "DCDomainHall", [base.dcDomainRank, base.dcDomain, factory.address], { client });
  console.log("DCDomainSwap", domainSwap.address);
  console.log("DCDomainHall", domainHall.address);

  console.log("\n--- Update or redeploy swap asset registry ---");
  let swapAssetRegistryAddress = base.dealSwapAssetRegistry;
  if (swapAssetRegistryAddress) {
    const swapAssetRegistry = await viem.getContractAt("DealSwapAssetRegistry", swapAssetRegistryAddress, { client }) as AnyContract;
    try {
      await tx("DealSwapAssetRegistry.setSwapAssets", publicClient, swapAssetRegistry.write.setSwapAssets([
        pairManager.address,
        base.dealRouter,
        base.dlToken,
        base.wrappedNative,
        base.usdt,
        base.ausd,
      ], gasOptions()));
    } catch (err: any) {
      console.log(`  REDEPLOY DealSwapAssetRegistry: ${err?.shortMessage ?? err?.message ?? err}`);
      const newRegistry = await deploy(viem, "DealSwapAssetRegistry", [
        dep,
        pairManager.address,
        base.dealRouter,
        base.dlToken,
        base.wrappedNative,
        base.usdt,
        base.ausd,
      ], { client });
      swapAssetRegistryAddress = newRegistry.address;
      console.log("DealSwapAssetRegistry", swapAssetRegistryAddress);
    }
  } else {
    const newRegistry = await deploy(viem, "DealSwapAssetRegistry", [
      dep,
      pairManager.address,
      base.dealRouter,
      base.dlToken,
      base.wrappedNative,
      base.usdt,
      base.ausd,
    ], { client });
    swapAssetRegistryAddress = newRegistry.address;
    console.log("DealSwapAssetRegistry", swapAssetRegistryAddress);
  }

  console.log("\n--- Wire new Factory stack ---");
  await writeTx("Factory.setCoreGlobals", publicClient, factory, "setCoreGlobals", [
    base.dlToken,
    base.dealInfoNFT,
    base.wrappedNative,
    pairManager.address,
  ]);
  await writeTx("Factory.setServiceGlobals", publicClient, factory, "setServiceGlobals", [
    messageHub.address,
    requiredAddress("dealCreditGraph", base.dealCreditGraph),
    requiredAddress("dealActivityIndex", activityIndex.address),
    requiredAddress("dealResultIndex", resultIndex.address),
    registry.address,
  ]);
  await writeTx("Factory.setOpsGlobals", publicClient, factory, "setOpsGlobals", [
    base.dealSwapOrderBook,
    base.dealNftGovernanceActivity ?? zeroAddress,
    base.dcDomainRank,
  ]);
  await writeTx("Registry.setDealImplementations", publicClient, registry, "setDealImplementations", [
    base.dealImplementation,
    dealNoAssetImpl.address,
    dealAAssetNftImpl.address,
    dealBAssetNftImpl.address,
    requiredAddress("dealAAssetNftOnlyImplementation", base.dealAAssetNftOnlyImplementation),
    requiredAddress("dealBAssetNftOnlyImplementation", base.dealBAssetNftOnlyImplementation),
    dealOpenTokenTokenImpl.address,
  ]);
  await writeTx("Factory.setRecognizedTokens", publicClient, factory, "setRecognizedTokens", [base.ausd, base.usdt]);
  await writeTx("Factory.setFeesAndMintOnFees", publicClient, factory, "setFeesAndMintOnFees", [
    oldFeeNonDL[0],
    oldFeeNonDL[1],
    oldMintOnFees[0],
    oldMintOnFees[1],
  ]);
  if (oldTreasury !== zeroAddress) {
    await writeTx("Factory.setTreasuryByAdmin", publicClient, factory, "setTreasuryByAdmin", [oldTreasury]);
  }
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
  if (getAddress(oldAdmin) !== getAddress(dep)) {
    await writeTx("Factory.setAdmin(old admin)", publicClient, factory, "setAdmin", [oldAdmin]);
  }

  console.log("\n--- Move existing pair control to new PairManager and map pairs ---");
  async function movePairFactory(label: string, pair: Address) {
    const pairContract = await viem.getContractAt("DealSwapTemplate", pair, { client }) as AnyContract;
    const controller = getAddress(await pairContract.read.factory()) as Address;
    if (controller === getAddress(pairManager.address)) {
      console.log(`  OK ${label} pair already controlled by new PairManager`);
      return;
    }
    const controllerContract = await viem.getContractAt("DealPairManager", controller, { client }) as AnyContract;
    await maybeTx(`${label} controller.setPairFactory(new PairManager)`, publicClient, () =>
      controllerContract.write.setPairFactory([pair, pairManager.address], gasOptions())
    );
    const afterDirect = getAddress(await pairContract.read.factory()) as Address;
    if (afterDirect === getAddress(pairManager.address)) return;

    // Some older PairManager versions only allow their parent Factory to call setPairFactory.
    try {
      const legacyFactory = getAddress(await controllerContract.read.factory()) as Address;
      await tx(`${label} legacy Factory.setPairFactory(new PairManager)`, publicClient, deployer.writeContract({
        address: legacyFactory,
        abi: LEGACY_FACTORY_PAIR_SETTER_ABI,
        functionName: "setPairFactory",
        args: [pair, pairManager.address],
        ...gasOptions(),
      }));
    } catch (err: any) {
      console.log(`  SKIP ${label} legacy Factory.setPairFactory: ${err?.shortMessage ?? err?.message ?? err}`);
    }
  }
  await movePairFactory("DL/AUSD", base.pairDlAusd);
  await movePairFactory("DL/USDT", base.pairDlUsdt);
  if (base.pairDlAgi) await movePairFactory("DL/AGI", base.pairDlAgi);
  await writeTx("PairManager.mapExistingPair AUSD", publicClient, pairManager, "mapExistingPair", [base.ausd, base.pairDlAusd]);
  await writeTx("PairManager.mapExistingPair USDT", publicClient, pairManager, "mapExistingPair", [base.usdt, base.pairDlUsdt]);
  if (base.pairDlAgi) {
    await writeTx("PairManager.mapExistingPair AGI", publicClient, pairManager, "mapExistingPair", [base.wrappedNative, base.pairDlAgi]);
  }

  console.log("\n--- Permission wiring ---");
  const dl = await viem.getContractAt("DCToken", base.dlToken, { client }) as AnyContract;
  const minterRole = await dl.read.MINTER_ROLE();
  await maybeTx("DCToken.grantRole(MINTER_ROLE, newFactory)", publicClient, () => dl.write.grantRole([minterRole, factory.address], gasOptions()));
  const infoNft = await viem.getContractAt("DealInfoNFT", base.dealInfoNFT, { client }) as AnyContract;
  await maybeTx("DealInfoNFT.addFactory(newFactory)", publicClient, () => infoNft.write.addFactory([factory.address], gasOptions()));
  await writeTx("DealInfoNFT.setFactory(newFactory)", publicClient, infoNft, "setFactory", [factory.address]);
  const creditGraph = await viem.getContractAt("DealCreditGraph", requiredAddress("dealCreditGraph", base.dealCreditGraph), { client }) as AnyContract;
  await maybeTx("DealCreditGraph.setRecorder(newFactory)", publicClient, () => creditGraph.write.setRecorder([factory.address, true], gasOptions()));
  if (base.dealNftGovernanceActivity) {
    const activity = await viem.getContractAt("DealNftGovernanceActivity", base.dealNftGovernanceActivity, { client }) as AnyContract;
    await maybeTx("DealNftGovernanceActivity.setRecorder(newFactory)", publicClient, () => activity.write.setRecorder([factory.address, true], gasOptions()));
  }
  await writeTx("Factory.allow DCDomainSwap", publicClient, factory, "setAllowedCreateFor", [domainSwap.address, true]);
  await writeTx("Factory.allow DCDomainHall", publicClient, factory, "setAllowedCreateFor", [domainHall.address, true]);
  const domainRank = await viem.getContractAt("DCDomainRank", base.dcDomainRank, { client }) as AnyContract;
  await writeTx("DCDomainRank.setAutoCloser(Factory)", publicClient, domainRank, "setAutoCloser", [factory.address]);
  await writeTx("DCDomainRank.reporter Swap", publicClient, domainRank, "setDealReporter", [domainSwap.address, true]);
  await writeTx("DCDomainRank.reporter Hall", publicClient, domainRank, "setDealReporter", [domainHall.address, true]);

  console.log("\n--- Smoke checks ---");
  const factoryOwner = getAddress(await factory.read.owner()) as Address;
  const factoryPairManager = getAddress(await factory.read.dealPairManager()) as Address;
  const rankFromFactory = getAddress(await factory.read.dcDomainRank()) as Address;
  const autoCloser = getAddress(await domainRank.read.autoCloser()) as Address;
  const primaryFactory = getAddress(await infoNft.read.factory()) as Address;
  const pairAgi = base.pairDlAgi ? getAddress(await pairManager.read.pairForToken([base.wrappedNative])) : undefined;
  const pairUsdt = getAddress(await pairManager.read.pairForToken([base.usdt])) as Address;
  const pairAusd = getAddress(await pairManager.read.pairForToken([base.ausd])) as Address;
  const pairAusdContract = await viem.getContractAt("DealSwapTemplate", base.pairDlAusd, { client }) as AnyContract;
  const pairUsdtContract = await viem.getContractAt("DealSwapTemplate", base.pairDlUsdt, { client }) as AnyContract;
  const pairAusdController = getAddress(await pairAusdContract.read.factory()) as Address;
  const pairUsdtController = getAddress(await pairUsdtContract.read.factory()) as Address;
  const pairAgiController = base.pairDlAgi
    ? getAddress(await (await viem.getContractAt("DealSwapTemplate", base.pairDlAgi, { client }) as AnyContract).read.factory()) as Address
    : undefined;
  const isSwapAllowed = await factory.read.isAllowedCreateFor([domainSwap.address]) as boolean;
  const isHallAllowed = await factory.read.isAllowedCreateFor([domainHall.address]) as boolean;
  const isRecorder = await creditGraph.read.isRecorder([factory.address]) as boolean;
  if (factoryOwner !== requiredOwner) throw new Error("Factory owner mismatch");
  if (factoryPairManager !== getAddress(pairManager.address)) throw new Error("Factory pair manager mismatch");
  if (rankFromFactory !== getAddress(base.dcDomainRank)) throw new Error("Factory domain rank mismatch");
  if (autoCloser !== getAddress(factory.address)) throw new Error("Domain rank auto closer mismatch");
  if (primaryFactory !== getAddress(factory.address)) throw new Error("InfoNFT primary factory mismatch");
  if (pairAusd !== getAddress(base.pairDlAusd)) throw new Error("AUSD pair mapping mismatch");
  if (pairUsdt !== getAddress(base.pairDlUsdt)) throw new Error("USDT pair mapping mismatch");
  if (base.pairDlAgi && pairAgi !== getAddress(base.pairDlAgi)) throw new Error("AGI pair mapping mismatch");
  if (pairAusdController !== getAddress(pairManager.address)) throw new Error("AUSD pair controller mismatch");
  if (pairUsdtController !== getAddress(pairManager.address)) throw new Error("USDT pair controller mismatch");
  if (base.pairDlAgi && pairAgiController !== getAddress(pairManager.address)) throw new Error("AGI pair controller mismatch");
  if (!isSwapAllowed || !isHallAllowed) throw new Error("Domain entries not allowed on new Factory");
  if (!isRecorder) throw new Error("CreditGraph recorder missing");
  console.log("  OK factory/templates/pairs/domain/credit wiring");

  const deployedAt = new Date().toISOString();
  const stamp = deployedAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = join(process.cwd(), "deployments");
  const backupDir = join(dir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const currentFile = join(dir, DEPLOYMENT_FILE);
  const backupFile = join(backupDir, `agiking-31415926.before-credit-pricing-${stamp}.json`);
  copyFileSync(currentFile, backupFile);

  const addresses: Record<string, string> = {
    ...current.addresses,
    dealLib: getAddress(dealLib.address),
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
    dealSwapAssetRegistry: getAddress(swapAssetRegistryAddress),
    dcDomainSwap: getAddress(domainSwap.address),
    dcDomainHall: getAddress(domainHall.address),
  };

  const out = {
    ...current,
    chainId: AGIKING_CHAIN_ID,
    rpcUrl,
    deployedAt,
    deployer: dep,
    previousDeployment: backupFile,
    upgrade: "deal-credit-pricing-and-reward-cap",
    addresses,
    abi: refreshAbi(current.abi),
    notes: [
      ...(current.notes ?? []),
      "DC and AGI deal fees now produce credit by quoting through official DC pairs.",
      "Factory reward config now enforces A+B+C minted reward rate <= protocol fee rate.",
      "Existing tokens, pairs, router, order book, DealReader, and domain rank data were reused.",
      "Existing official pair controllers were moved to the new DealPairManager for future fee and virtual-liquidity operations.",
    ],
  };

  const timestampedFile = join(dir, `agiking-31415926-${stamp}.json`);
  writeFileSync(currentFile, JSON.stringify(out, null, 2), "utf8");
  writeFileSync(timestampedFile, JSON.stringify(out, null, 2), "utf8");

  const handoffFile = join(dir, `frontend-handoff-credit-pricing-${stamp}.md`);
  writeHandoff(handoffFile, deployedAt, dep, addresses);
  writeHandoff(join(process.cwd(), "docs", "前端部署地址交接文档.md"), deployedAt, dep, addresses);

  console.log("\n========== DEPLOYED ADDRESSES ==========");
  console.log(JSON.stringify({
    dealLib: addresses.dealLib,
    dealFactory: addresses.dealFactory,
    dealPairManager: addresses.dealPairManager,
    dealSwapAssetRegistry: addresses.dealSwapAssetRegistry,
    dealNoAssetImplementation: addresses.dealNoAssetImplementation,
    dealAAssetNftImplementation: addresses.dealAAssetNftImplementation,
    dealBAssetNftImplementation: addresses.dealBAssetNftImplementation,
    dealOpenTokenTokenImplementation: addresses.dealOpenTokenTokenImplementation,
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
