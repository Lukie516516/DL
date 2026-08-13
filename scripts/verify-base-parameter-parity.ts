/**
 * Read-only ETH/BSC/Base business-parameter matrix.
 * Address-valued wiring is validated against each chain's own deployment;
 * only portable business values are compared across chains.
 */
import { readFileSync } from "node:fs";

import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  parseAbi,
  type Address,
} from "viem";
import { base, bsc, mainnet } from "viem/chains";

type Deployment = {
  network: string;
  chainId: number;
  addresses: Record<string, Address>;
};

const factoryAbi = parseAbi([
  "function minTimeoutSeconds() view returns (uint64)",
  "function minWindowSec() view returns (uint32)",
  "function recognizedToken0() view returns (address)",
  "function recognizedToken1() view returns (address)",
  "function defaultFeeNonDL() view returns (uint32 num,uint32 den)",
  "function defaultMintOnFees() view returns (uint32 num,uint32 den)",
  "function specialNoFeeToken() view returns (address)",
  "function treasury() view returns (address)",
  "function msgPriceEnabled() view returns (bool)",
  "function msgPriceToken() view returns (address)",
  "function msgPriceAmountInToken() view returns (uint256)",
  "function createBurnEnabled() view returns (bool)",
  "function createBurnPricingToken() view returns (address)",
  "function createBurnAmountInToken() view returns (uint256)",
]);
const infoNftAbi = parseAbi([
  "function factory() view returns (address)",
  "function mintPriceDL() view returns (uint256)",
  "function maxImageDataBytes() view returns (uint256)",
  "function currentSeason() view returns (uint16)",
]);
const domainAbi = parseAbi([
  "function basePrice() view returns (uint256)",
  "function paymentToken() view returns (address)",
  "function treasury() view returns (address)",
  "function domainMarket() view returns (address)",
]);
const marketAbi = parseAbi([
  "function paymentToken() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function feeBps() view returns (uint256)",
]);
const rankAbi = parseAbi([
  "function treasury() view returns (address)",
  "function autoCloser() view returns (address)",
  "function minDeposit() view returns (uint256)",
  "function baseHourlyRate() view returns (uint256)",
  "function depositRateBps() view returns (uint256)",
  "function protocolFeeBps() view returns (uint256)",
  "function kickInactivitySeconds() view returns (uint256)",
]);
const domainSwapAbi = parseAbi([
  "function replaceTimeoutSeconds() view returns (uint64)",
]);
const pairAbi = parseAbi([
  "function feeNum() view returns (uint32)",
  "function feeDen() view returns (uint32)",
]);

function load(path: string): Deployment {
  return JSON.parse(readFileSync(path, "utf8")) as Deployment;
}

function same(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function serializable(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializable(item)]));
  }
  return value;
}

async function snapshot(input: {
  deployment: Deployment;
  client: any;
}) {
  const { deployment: d, client } = input;
  const a = d.addresses;
  const factory = getAddress(a.dealFactory);
  const infoNft = getAddress(a.dealInfoNFT);
  const domain = getAddress(a.dcDomain);
  const market = getAddress(a.dcDomainMarket);
  const rank = getAddress(a.dcDomainRank);
  const domainSwap = getAddress(a.dcDomainSwap);
  const call = (address: Address, abi: any, functionName: string) =>
    client.readContract({ address, abi, functionName });

  const [
    minTimeoutSeconds, minWindowSec, recognizedToken0, recognizedToken1,
    defaultFeeNonDL, defaultMintOnFees, specialNoFeeToken, factoryTreasury,
    msgPriceEnabled, msgPriceToken, msgPriceAmountInToken,
    createBurnEnabled, createBurnPricingToken, createBurnAmountInToken,
    infoFactory, mintPriceDL, maxImageDataBytes, currentSeason,
    domainBasePrice, domainPaymentToken, domainTreasury, domainMarket,
    marketPaymentToken, marketFeeRecipient, marketFeeBps,
    rankTreasury, rankAutoCloser, rankMinDeposit, rankBaseHourlyRate,
    rankDepositRateBps, rankProtocolFeeBps, rankKickInactivitySeconds,
    replaceTimeoutSeconds,
    stable0FeeNum, stable0FeeDen, stable1FeeNum, stable1FeeDen,
    wrappedFeeNum, wrappedFeeDen,
  ] = await Promise.all([
    call(factory, factoryAbi, "minTimeoutSeconds"), call(factory, factoryAbi, "minWindowSec"),
    call(factory, factoryAbi, "recognizedToken0"), call(factory, factoryAbi, "recognizedToken1"),
    call(factory, factoryAbi, "defaultFeeNonDL"), call(factory, factoryAbi, "defaultMintOnFees"),
    call(factory, factoryAbi, "specialNoFeeToken"), call(factory, factoryAbi, "treasury"),
    call(factory, factoryAbi, "msgPriceEnabled"), call(factory, factoryAbi, "msgPriceToken"),
    call(factory, factoryAbi, "msgPriceAmountInToken"), call(factory, factoryAbi, "createBurnEnabled"),
    call(factory, factoryAbi, "createBurnPricingToken"), call(factory, factoryAbi, "createBurnAmountInToken"),
    call(infoNft, infoNftAbi, "factory"), call(infoNft, infoNftAbi, "mintPriceDL"),
    call(infoNft, infoNftAbi, "maxImageDataBytes"), call(infoNft, infoNftAbi, "currentSeason"),
    call(domain, domainAbi, "basePrice"), call(domain, domainAbi, "paymentToken"),
    call(domain, domainAbi, "treasury"), call(domain, domainAbi, "domainMarket"),
    call(market, marketAbi, "paymentToken"), call(market, marketAbi, "feeRecipient"),
    call(market, marketAbi, "feeBps"), call(rank, rankAbi, "treasury"),
    call(rank, rankAbi, "autoCloser"), call(rank, rankAbi, "minDeposit"),
    call(rank, rankAbi, "baseHourlyRate"), call(rank, rankAbi, "depositRateBps"),
    call(rank, rankAbi, "protocolFeeBps"), call(rank, rankAbi, "kickInactivitySeconds"),
    call(domainSwap, domainSwapAbi, "replaceTimeoutSeconds"),
    call(getAddress(a.pairStable0), pairAbi, "feeNum"), call(getAddress(a.pairStable0), pairAbi, "feeDen"),
    call(getAddress(a.pairStable1), pairAbi, "feeNum"), call(getAddress(a.pairStable1), pairAbi, "feeDen"),
    call(getAddress(a.pairWrappedNative), pairAbi, "feeNum"), call(getAddress(a.pairWrappedNative), pairAbi, "feeDen"),
  ]);

  const values = {
    minTimeoutSeconds,
    minWindowSec,
    dealFee: defaultFeeNonDL,
    dealReward: defaultMintOnFees,
    specialNoFeeToken,
    messagePrice: { enabled: msgPriceEnabled, amount: msgPriceAmountInToken },
    createBurn: { enabled: createBurnEnabled, amount: createBurnAmountInToken },
    infoNft: { mintPriceDL, maxImageDataBytes, currentSeason },
    domain: { basePrice: domainBasePrice, marketFeeBps },
    domainRank: {
      minDeposit: rankMinDeposit,
      baseHourlyRate: rankBaseHourlyRate,
      depositRateBps: rankDepositRateBps,
      protocolFeeBps: rankProtocolFeeBps,
      kickInactivitySeconds: rankKickInactivitySeconds,
    },
    domainSwap: { replaceTimeoutSeconds },
    pairFees: {
      stable0: [stable0FeeNum, stable0FeeDen],
      stable1: [stable1FeeNum, stable1FeeDen],
      wrappedNative: [wrappedFeeNum, wrappedFeeDen],
    },
  };
  const wiring = {
    recognizedTokensMatchChainAssets:
      same(recognizedToken0, a.stable0) && same(recognizedToken1, a.stable1),
    factoryTreasuryMatches: same(factoryTreasury, a.protocolTreasury),
    messageTokenMatchesDc: same(msgPriceToken, a.dlToken),
    createBurnTokenMatchesDcOrDisabled:
      !createBurnEnabled || same(createBurnPricingToken, a.dlToken),
    infoNftFactoryMatches: same(infoFactory, a.dealFactory),
    domainPaymentTokenMatchesDc: same(domainPaymentToken, a.dlToken),
    domainTreasuryMatches: same(domainTreasury, a.protocolTreasury),
    domainMarketMatches: same(domainMarket, a.dcDomainMarket),
    marketPaymentTokenMatchesDc: same(marketPaymentToken, a.dlToken),
    marketFeeRecipientMatchesTreasury: same(marketFeeRecipient, a.protocolTreasury),
    rankTreasuryMatches: same(rankTreasury, a.protocolTreasury),
    rankAutoCloserHasCode: (await client.getCode({ address: getAddress(rankAutoCloser) })) !== undefined,
  };
  return { network: d.network, chainId: d.chainId, blockNumber: await client.getBlockNumber(), values, wiring };
}

const deployments = {
  eth: load("deployments/eth-mainnet-1.json"),
  bsc: load("deployments/bsc-mainnet-56.json"),
  base: load("deployments/base-mainnet-8453.json"),
};
const clients = {
  eth: createPublicClient({ chain: mainnet, transport: fallback([
    http(process.env.ETH_MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com", { timeout: 30_000 }),
    http("https://eth.llamarpc.com", { timeout: 30_000 }),
  ], { rank: false }) }),
  bsc: createPublicClient({ chain: bsc, transport: fallback([
    http(process.env.BSC_MAINNET_RPC_URL || "https://bsc-rpc.publicnode.com", { timeout: 30_000 }),
    http("https://bsc-dataseed.binance.org", { timeout: 30_000 }),
  ], { rank: false }) }),
  base: createPublicClient({ chain: base, transport: fallback([
    http(process.env.BASE_MAINNET_RPC_URL || "https://base-rpc.publicnode.com", { timeout: 30_000 }),
    http("https://mainnet.base.org", { timeout: 30_000 }),
  ], { rank: false }) }),
};

const [eth, bscSnapshot, baseSnapshot] = await Promise.all([
  snapshot({ deployment: deployments.eth, client: clients.eth }),
  snapshot({ deployment: deployments.bsc, client: clients.bsc }),
  snapshot({ deployment: deployments.base, client: clients.base }),
]);
const normalized = (value: unknown) => JSON.stringify(serializable(value));
const portableKeys = Object.keys(eth.values) as Array<keyof typeof eth.values>;
const diffs = portableKeys.flatMap((key) => {
  const ethValue = normalized(eth.values[key]);
  const bscValue = normalized(bscSnapshot.values[key]);
  const baseValue = normalized(baseSnapshot.values[key]);
  return baseValue === ethValue
    ? []
    : [{ key, eth: serializable(eth.values[key]), bsc: serializable(bscSnapshot.values[key]), base: serializable(baseSnapshot.values[key]) }];
});
const baseWiringFailures = Object.entries(baseSnapshot.wiring)
  .filter(([, passed]) => !passed)
  .map(([key]) => key);

console.log(JSON.stringify(serializable({
  status: diffs.length === 0 && baseWiringFailures.length === 0 ? "PASS" : "REVIEW_REQUIRED",
  readOnly: true,
  comparisonRule: "Base portable business values are compared with ETH; chain-specific addresses are checked against each deployment manifest",
  snapshots: { eth, bsc: bscSnapshot, base: baseSnapshot },
  baseVsEthPortableDiffs: diffs,
  baseWiringFailures,
}), null, 2));
