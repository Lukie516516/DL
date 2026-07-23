/**
 * Deploy the Deal protocol stack on ETH/BSC mainnet-style networks.
 *
 * This script is intentionally safer than the Agiking bootstrap:
 * - It deploys DealCoin/DC and protocol contracts.
 * - It does NOT deploy fake USDT/USDC by default.
 * - It does NOT initialize liquidity by default.
 * - It deploys DealFactory behind ERC1967Proxy, which is the correct UUPS path.
 *
 * Example ETH:
 *   export ETH_MAINNET_RPC_URL=...
 *   export ETH_MAINNET_PRIVATE_KEY=...
 *   export MAINNET_STABLE0_ADDRESS=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 # USDC
 *   export MAINNET_STABLE1_ADDRESS=0xdAC17F958D2ee523a2206206994597C13D831ec7 # USDT
 *   export MAINNET_WRAPPED_NATIVE_ADDRESS=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 # WETH
 *   node node_modules/hardhat/dist/src/cli.js run scripts/deploy-mainnet-protocol.ts --network ethMainnet
 *
 * Example BSC:
 *   export BSC_MAINNET_RPC_URL=...
 *   export BSC_MAINNET_PRIVATE_KEY=...
 *   export MAINNET_STABLE0_ADDRESS=0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d # USDC
 *   export MAINNET_STABLE1_ADDRESS=0x55d398326f99059fF775485246999027B3197955 # USDT
 *   export MAINNET_WRAPPED_NATIVE_ADDRESS=0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c # WBNB
 *   node node_modules/hardhat/dist/src/cli.js run scripts/deploy-mainnet-protocol.ts --network bscMainnet
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { encodeFunctionData, getAddress, zeroAddress, type Address } from "viem";

const ONE = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const INFO_NFT_MINT_PRICE_DC = envBigInt("MAINNET_INFO_NFT_MINT_PRICE_DC", 100_000n * ONE);
const MESSAGE_PRICE_DC = envBigInt("MAINNET_MESSAGE_PRICE_DC", 100n * ONE);
const MIN_TIMEOUT_SECONDS = Number(envBigInt("MAINNET_MIN_TIMEOUT_SECONDS", 3600n));
const PAIR_FEE_NUM = Number(envBigInt("MAINNET_PAIR_FEE_NUM", 3n));
const PAIR_FEE_DEN = Number(envBigInt("MAINNET_PAIR_FEE_DEN", 1000n));
const DEFAULT_FEE_NUM = Number(envBigInt("MAINNET_DEAL_FEE_NUM", 3n));
const DEFAULT_MINT_REWARD_NUM = Number(envBigInt("MAINNET_DEAL_REWARD_NUM", 1n));

type AnyContract = Record<string, any> & { address: Address };
type DeploymentJson = {
  chainId: number;
  network: string;
  rpcUrl?: string;
  deployedAt: string;
  deployer: Address;
  addresses: Record<string, Address>;
  abi: Record<string, unknown[]>;
  params: Record<string, string | number | boolean>;
  notes: string[];
};

const erc20Abi = [
  { type: "function", name: "transfer", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
] as const;

function loadEnv() {
  try {
    readFileSync(".env", "utf8").split("\n").forEach((line) => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] ||= m[2].trim();
    });
  } catch {}
}

function envBool(key: string, fallback = false): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

function envBigInt(key: string, fallback?: bigint): bigint {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env ${key}`);
  }
  return BigInt(raw);
}

function envAddress(key: string, fallback?: Address): Address {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env ${key}`);
  }
  try {
    return getAddress(raw.trim()) as Address;
  } catch {
    throw new Error(`Invalid address for ${key}: ${raw}`);
  }
}

function optionalAddress(key: string): Address | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return undefined;
  return envAddress(key);
}

function optionalAddressFrom(keys: string[]): Address | undefined {
  for (const key of keys) {
    const value = optionalAddress(key);
    if (value) return value;
  }
  return undefined;
}

function loadAbi(relativeArtifactJson: string): unknown[] {
  const p = join(process.cwd(), "artifacts", "contracts", relativeArtifactJson);
  const j = JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[] };
  return j.abi;
}

function artifactAbi(name: string): unknown[] {
  if (name === "ERC1967Proxy") {
    const candidates = [
      join(process.cwd(), "artifacts", "contracts", "TestProxy.sol", "ERC1967Proxy.json"),
      join(process.cwd(), "artifacts", "@openzeppelin", "contracts", "proxy", "ERC1967", "ERC1967Proxy.sol", "ERC1967Proxy.json"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return (JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[] }).abi;
    }
    throw new Error("ERC1967Proxy artifact not found. Run hardhat compile first.");
  }
  throw new Error(`Unknown external artifact ${name}`);
}

async function waitFor(publicClient: any, hash: `0x${string}`, label?: string) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label ?? "tx"} failed: ${hash}`);
  if (label) console.log(`  ok ${label}: ${hash}`);
  return receipt;
}

async function main() {
  loadEnv();

  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const client = { public: publicClient, wallet: deployer } as const;
  const chainId = Number(await publicClient.getChainId());
  const networkName = chainId === 1 ? "eth-mainnet" : chainId === 56 ? "bsc-mainnet" : `chain-${chainId}`;
  const dep = deployer.account.address as Address;
  const deployDao = envBool("MAINNET_DEPLOY_DAO", chainId === 1);

  const admin = envAddress("MAINNET_ADMIN_ADDRESS", dep);
  const dInitialHolder = envAddress("MAINNET_D_INITIAL_HOLDER", dep);
  const requestedTreasury = chainId === 56
    ? optionalAddress("BSC_MAINNET_TREASURY_ADDRESS")
    : optionalAddressFrom([chainId === 1 ? "ETH_MAINNET_TREASURY_ADDRESS" : "", "MAINNET_TREASURY_ADDRESS"].filter(Boolean));
  const useProtocolTreasury = envBool("MAINNET_USE_PROTOCOL_TREASURY", true);
  const treasuryControllerInput = optionalAddress("MAINNET_TREASURY_CONTROLLER_ADDRESS");
  const lockTreasuryBootstrap = envBool("MAINNET_LOCK_TREASURY_BOOTSTRAP", false);
  const dividendExecutorInput = optionalAddress("MAINNET_DIVIDEND_EXECUTOR");
  const dividendSourceInput = optionalAddress("MAINNET_DIVIDEND_SOURCE");
  let treasury = requestedTreasury ?? dep;

  const stable0 = optionalAddress("MAINNET_STABLE0_ADDRESS");
  const stable1 = optionalAddress("MAINNET_STABLE1_ADDRESS");
  const deployMockStables = envBool("MAINNET_DEPLOY_MOCK_STABLES", false);
  if ((!stable0 || !stable1) && !deployMockStables) {
    throw new Error("Set MAINNET_STABLE0_ADDRESS and MAINNET_STABLE1_ADDRESS, or explicitly set MAINNET_DEPLOY_MOCK_STABLES=1");
  }

  const wrappedNativeInput = optionalAddress("MAINNET_WRAPPED_NATIVE_ADDRESS");
  const deployWrappedNative = envBool("MAINNET_DEPLOY_WRAPPED_NATIVE", false);
  if (!wrappedNativeInput && !deployWrappedNative) {
    throw new Error("Set MAINNET_WRAPPED_NATIVE_ADDRESS, or explicitly set MAINNET_DEPLOY_WRAPPED_NATIVE=1");
  }

  const createPairs = envBool("MAINNET_CREATE_PAIRS", true);
  const initPairs = envBool("MAINNET_INIT_PAIRS", false);
  const mintDcToDeployer = envBigInt("MAINNET_MINT_DC_TO_DEPLOYER", 0n);
  const activateMessageFee = envBool("MAINNET_MESSAGE_FEE_ENABLED", true);

  async function deploy(name: string, args: unknown[] = [], options: Record<string, unknown> = {}) {
    const contract = await viem.deployContract(name, args, { client, ...options }) as AnyContract;
    console.log(`${name}: ${contract.address}`);
    return contract;
  }

  async function tx(label: string, hashPromise: Promise<`0x${string}`>) {
    await waitFor(publicClient, await hashPromise, label);
  }

  let protocolTreasury: AnyContract | undefined;
  let protocolTreasuryController: Address = ZERO;
  if (useProtocolTreasury && !requestedTreasury) {
    protocolTreasuryController = treasuryControllerInput ?? dividendExecutorInput ?? dep;
    protocolTreasury = await deploy("ProtocolTreasury", [protocolTreasuryController, dep]);
    treasury = protocolTreasury.address;
    if (lockTreasuryBootstrap) {
      await tx("ProtocolTreasury.lockBootstrap", protocolTreasury.write.lockBootstrap());
    }
  } else if (requestedTreasury) {
    protocolTreasuryController = treasuryControllerInput ?? ZERO;
  }

  const dividendSource = dividendSourceInput ?? treasury;
  const finalDividendExecutor = dividendExecutorInput ?? (protocolTreasury ? treasury : dep);

  console.log(`Network: ${networkName} (${chainId})`);
  console.log(`Deployer: ${dep}`);
  console.log(`Treasury: ${treasury}`);
  console.log(`Admin: ${admin}`);
  console.log(`ProtocolTreasury: ${protocolTreasury?.address ?? "EXTERNAL_OR_DISABLED"}`);
  console.log(`ProtocolTreasury controller: ${protocolTreasuryController}`);
  console.log(`Dividend executor: ${finalDividendExecutor}`);
  console.log(`Dividend source: ${dividendSource}`);
  console.log(`Stable0: ${stable0 ?? "DEPLOY_MOCK"}`);
  console.log(`Stable1: ${stable1 ?? "DEPLOY_MOCK"}`);
  console.log(`Wrapped native: ${wrappedNativeInput ?? "DEPLOY_WRAPPER"}`);
  console.log(`Create pairs: ${createPairs}`);
  console.log(`Init pairs: ${initPairs}`);
  console.log(`Deploy DAO stack: ${deployDao}`);

  // Libraries + implementations.
  const dealLib = await deploy("DealLib");
  const dealAssetNftLib = await deploy("DealAssetNftLib");
  const dealImpl = await deploy("Deal");
  const dealNoAssetImpl = await deploy("DealNoAsset", [], { libraries: { DealLib: dealLib.address } });
  const dealAAssetNftImpl = await deploy("DealAAssetNft", [], {
    libraries: { DealLib: dealLib.address, DealAssetNftLib: dealAssetNftLib.address },
  });
  const dealBAssetNftImpl = await deploy("DealBAssetNft", [], {
    libraries: { DealLib: dealLib.address, DealAssetNftLib: dealAssetNftLib.address },
  });
  const dealAAssetNftOnlyImpl = await deploy("DealAAssetNftOnly", [], {
    libraries: { DealAssetNftLib: dealAssetNftLib.address },
  });
  const dealBAssetNftOnlyImpl = await deploy("DealBAssetNftOnly", [], {
    libraries: { DealAssetNftLib: dealAssetNftLib.address },
  });
  const dealOpenTokenTokenImpl = await deploy("DealOpenTokenToken", [], {
    libraries: { DealLib: dealLib.address },
  });
  const pairImpl = await deploy("DealSwapTemplate");

  // Tokens.
  const dl = await deploy("DCToken", ["DealCoin", "DC", 0n, dep, dep]);
  const stable0Contract = stable0
    ? await viem.getContractAt("DCToken", stable0)
    : await deploy("DCToken", [process.env.MAINNET_STABLE0_NAME ?? "USDC", process.env.MAINNET_STABLE0_SYMBOL ?? "USDC", 0n, dep, dep]);
  const stable1Contract = stable1
    ? await viem.getContractAt("DCToken", stable1)
    : await deploy("DCToken", [process.env.MAINNET_STABLE1_NAME ?? "USDT", process.env.MAINNET_STABLE1_SYMBOL ?? "USDT", 0n, dep, dep]);
  const stable0Address = stable0 ?? (stable0Contract.address as Address);
  const stable1Address = stable1 ?? (stable1Contract.address as Address);
  const wrappedNative = wrappedNativeInput
    ? await viem.getContractAt("WrappedAGI", wrappedNativeInput)
    : await deploy("WrappedAGI");
  const wrappedNativeAddress = wrappedNativeInput ?? (wrappedNative.address as Address);

  // Factory as UUPS implementation + proxy.
  const factoryImpl = await deploy("DealFactory");
  const factoryInitData = encodeFunctionData({
    abi: [{
      type: "function",
      name: "initialize",
      inputs: [
        { name: "_dealImpl", type: "address" },
        { name: "_pairImpl", type: "address" },
        { name: "_minTimeoutSeconds", type: "uint64" },
      ],
    }],
    functionName: "initialize",
    args: [dealImpl.address, pairImpl.address, BigInt(MIN_TIMEOUT_SECONDS)],
  });
  const factoryProxy = await deploy("ERC1967Proxy", [factoryImpl.address, factoryInitData]);
  const factory = await viem.getContractAt("DealFactory", factoryProxy.address);
  console.log(`DealFactory proxy: ${factory.address}`);

  const dealPairManager = await deploy("DealPairManager", [factory.address]);
  const dealMessageHub = await deploy("DealMessageHub", [factory.address]);
  const dealActivityIndex = await deploy("DealActivityIndex", [factory.address]);
  const dealResultIndex = await deploy("DealResultIndex", [factory.address]);
  const dealImplementationRegistry = await deploy("DealImplementationRegistry");
  const infoNft = await deploy("DealInfoNFT", [factory.address, zeroAddress, INFO_NFT_MINT_PRICE_DC]);
  const infoNftRenderer = await deploy("DealInfoNFTRenderer");
  const creditGraph = await deploy("DealCreditGraph", [infoNft.address]);

  await tx("InfoNFT.setRenderer", infoNft.write.setRenderer([infoNftRenderer.address]));
  await tx("Factory.setCoreGlobals", factory.write.setCoreGlobals([dl.address, infoNft.address, wrappedNativeAddress, dealPairManager.address]));
  await tx("Registry.setDealImplementations", dealImplementationRegistry.write.setDealImplementations([
    dealImpl.address,
    dealNoAssetImpl.address,
    dealAAssetNftImpl.address,
    dealBAssetNftImpl.address,
    dealAAssetNftOnlyImpl.address,
    dealBAssetNftOnlyImpl.address,
    dealOpenTokenTokenImpl.address,
  ]));
  await tx("Factory.setServiceGlobals", factory.write.setServiceGlobals([
    dealMessageHub.address,
    creditGraph.address,
    dealActivityIndex.address,
    dealResultIndex.address,
    dealImplementationRegistry.address,
  ]));
  await tx("Factory.setRecognizedTokens", factory.write.setRecognizedTokens([stable0Address, stable1Address]));
  await tx("Factory.setFeesAndMintOnFees", factory.write.setFeesAndMintOnFees([DEFAULT_FEE_NUM, 1000, DEFAULT_MINT_REWARD_NUM, 1000]));
  await tx("Factory.setAllowedMarginToken(stable0)", factory.write.setAllowedMarginToken([stable0Address, true]));
  await tx("Factory.setAllowedMarginToken(stable1)", factory.write.setAllowedMarginToken([stable1Address, true]));
  await tx("Factory.setAllowedMarginToken(wrappedNative)", factory.write.setAllowedMarginToken([wrappedNativeAddress, true]));
  await tx("Factory.setTreasuryByAdmin", factory.write.setTreasuryByAdmin([treasury]));
  await tx("CreditGraph.setRecorder(factory)", creditGraph.write.setRecorder([factory.address, true]));

  const minterRole = await dl.read.MINTER_ROLE();
  await tx("DC.grantRole(MINTER_ROLE, factory)", dl.write.grantRole([minterRole, factory.address]));
  if (mintDcToDeployer > 0n) {
    await tx("DC.mint(deployer)", dl.write.mint([dep, mintDcToDeployer]));
  }
  await tx("InfoNFT.setMintPriceU", infoNft.write.setMintPriceU([zeroAddress, INFO_NFT_MINT_PRICE_DC]));
  await tx("Factory.setMessagePriceRule", factory.write.setMessagePriceRule([activateMessageFee, dl.address, MESSAGE_PRICE_DC]));

  async function createPair(label: string, token: Address, realDcEnv: string, realOtherEnv: string, virtualOtherEnv: string) {
    if (!createPairs) return ZERO;
    await tx(`PairManager.createPair(${label})`, dealPairManager.write.createPair([token, PAIR_FEE_NUM, PAIR_FEE_DEN]));
    const pair = await dealPairManager.read.pairForToken([token]) as Address;
    console.log(`${label} pair: ${pair}`);
    if (!initPairs) return pair;
    const realDc = envBigInt(realDcEnv);
    const realOther = envBigInt(realOtherEnv);
    const virtualOther = envBigInt(virtualOtherEnv, 0n);
    if (realDc <= 0n || realOther <= 0n) throw new Error(`${label} pair init amounts must be > 0`);
    await tx(`DC.transfer(${label} pair)`, dl.write.transfer([pair, realDc]));
    await tx(`${label}.transfer(pair)`, deployer.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [pair, realOther] }));
    await tx(`PairManager.initPair(${label})`, dealPairManager.write.initPair([pair, virtualOther]));
    return pair;
  }

  const pairStable0 = await createPair("stable0", stable0Address, "MAINNET_STABLE0_PAIR_REAL_DC", "MAINNET_STABLE0_PAIR_REAL_OTHER", "MAINNET_STABLE0_PAIR_VIRTUAL_OTHER");
  const pairStable1 = await createPair("stable1", stable1Address, "MAINNET_STABLE1_PAIR_REAL_DC", "MAINNET_STABLE1_PAIR_REAL_OTHER", "MAINNET_STABLE1_PAIR_VIRTUAL_OTHER");
  const pairNative = await createPair("wrappedNative", wrappedNativeAddress, "MAINNET_NATIVE_PAIR_REAL_DC", "MAINNET_NATIVE_PAIR_REAL_OTHER", "MAINNET_NATIVE_PAIR_VIRTUAL_OTHER");

  const orderBook = await deploy("DealSwapOrderBook", [treasury]);
  await tx("Factory.setOpsGlobals(orderBook)", factory.write.setOpsGlobals([orderBook.address, zeroAddress, zeroAddress]));
  const router = await deploy("DealRouter", [wrappedNativeAddress, orderBook.address, dealPairManager.address]);
  const routerQuoter = await deploy("DealRouterQuoter", [orderBook.address]);
  await tx("OrderBook.setRouter", orderBook.write.setRouter([router.address]));
  const swapAssetRegistry = await deploy("DealSwapAssetRegistry", [
    dep,
    dealPairManager.address,
    router.address,
    dl.address,
    wrappedNativeAddress,
    stable1Address,
    stable0Address,
  ]);
  const dealReader = await deploy("DealReader");

  const dcDomain = await deploy("DCDomain", [dl.address, treasury]);
  const dcRankImpl = await deploy("DCDomainRank");
  const dcRankInitData = encodeFunctionData({
    abi: [{
      type: "function",
      name: "initialize",
      inputs: [
        { name: "_dcToken", type: "address" },
        { name: "_dcDomain", type: "address" },
        { name: "_treasury", type: "address" },
      ],
    }],
    functionName: "initialize",
    args: [dl.address, dcDomain.address, treasury],
  });
  const dcRankProxy = await deploy("ERC1967Proxy", [dcRankImpl.address, dcRankInitData]);
  const dcRank = await viem.getContractAt("DCDomainRank", dcRankProxy.address);
  console.log(`DCDomainRank proxy: ${dcRank.address}`);
  const dcRankReader = await deploy("DCDomainRankReader", [dcRank.address]);
  const dcDomainListReader = await deploy("DCDomainListReader", [dcDomain.address, dcRank.address]);
  await tx("Factory.setOpsGlobals(domainRank)", factory.write.setOpsGlobals([zeroAddress, zeroAddress, dcRank.address]));
  await tx("DomainRank.setAutoCloser", dcRank.write.setAutoCloser([factory.address]));
  const dcMarket = await deploy("DCDomainMarket", [dcDomain.address, dl.address, treasury, 100n]);
  await tx("DCDomain.setDomainMarket", dcDomain.write.setDomainMarket([dcMarket.address]));
  const dcSwap = await deploy("DCDomainSwap", [dcDomain.address, dcRank.address, factory.address]);
  const dcHall = await deploy("DCDomainHall", [dcRank.address, dcDomain.address, factory.address, zeroAddress]);
  await tx("Factory.allow DCDomainSwap", factory.write.setAllowedCreateFor([dcSwap.address, true]));
  await tx("Factory.allow DCDomainHall", factory.write.setAllowedCreateFor([dcHall.address, true]));
  await tx("DomainRank.reporter swap", dcRank.write.setDealReporter([dcSwap.address, true]));
  await tx("DomainRank.reporter hall", dcRank.write.setDealReporter([dcHall.address, true]));

  let dToken: AnyContract | undefined;
  let nftActivity: AnyContract | undefined;
  let nftVetoRegistry: AnyContract | undefined;
  let seatVetoGovernor: AnyContract | undefined;
  let voteClaimer: AnyContract | undefined;
  if (deployDao) {
    dToken = await deploy("D", [dInitialHolder]);
    nftActivity = await deploy("DealNftGovernanceActivity", [infoNft.address]);
    await tx("Factory.setOpsGlobals(nftActivity)", factory.write.setOpsGlobals([zeroAddress, nftActivity.address, zeroAddress]));
    nftVetoRegistry = await deploy("NftVetoRegistry", [infoNft.address, nftActivity.address]);
    seatVetoGovernor = await deploy("DealSeatVetoGovernor", [dToken.address, nftVetoRegistry.address]);
    await tx("NftVetoRegistry.setGovernor", nftVetoRegistry.write.setGovernor([seatVetoGovernor.address, true]));
    await tx("NftActivity.setRecorder(factory)", nftActivity.write.setRecorder([factory.address, true]));
    await tx("NftActivity.setRecorder(vetoRegistry)", nftActivity.write.setRecorder([nftVetoRegistry.address, true]));
    voteClaimer = await deploy("VoteDividendClaimer", [dToken.address, dl.address, dep, dividendSource]);
    await tx("NftActivity.setRecorder(voteClaimer)", nftActivity.write.setRecorder([voteClaimer.address, true]));
    await tx("VoteClaimer.setGovernanceActivity", voteClaimer.write.setGovernanceActivity([infoNft.address, nftActivity.address]));
    if (finalDividendExecutor.toLowerCase() !== dep.toLowerCase()) {
      await tx("VoteClaimer.setExecutor(final)", voteClaimer.write.setExecutor([finalDividendExecutor]));
    }
  }

  if (admin.toLowerCase() !== dep.toLowerCase()) {
    await tx("Factory.setAdmin", factory.write.setAdmin([admin]));
    await tx("InfoNFT.setAdmin", infoNft.write.setAdmin([admin]));
  }

  const addresses: Record<string, Address> = {
    dlToken: dl.address,
    stable0: stable0Address,
    stable1: stable1Address,
    wrappedNative: wrappedNativeAddress,
    dealLib: dealLib.address,
    dealAssetNftLib: dealAssetNftLib.address,
    dealImplementation: dealImpl.address,
    dealNoAssetImplementation: dealNoAssetImpl.address,
    dealAAssetNftImplementation: dealAAssetNftImpl.address,
    dealBAssetNftImplementation: dealBAssetNftImpl.address,
    dealAAssetNftOnlyImplementation: dealAAssetNftOnlyImpl.address,
    dealBAssetNftOnlyImplementation: dealBAssetNftOnlyImpl.address,
    dealOpenTokenTokenImplementation: dealOpenTokenTokenImpl.address,
    dealImplementationRegistry: dealImplementationRegistry.address,
    pairImplementation: pairImpl.address,
    dealFactoryImplementation: factoryImpl.address,
    dealFactory: factory.address,
    dealPairManager: dealPairManager.address,
    dealMessageHub: dealMessageHub.address,
    dealCreditGraph: creditGraph.address,
    dealActivityIndex: dealActivityIndex.address,
    dealResultIndex: dealResultIndex.address,
    dealInfoNFT: infoNft.address,
    dealInfoNFTRenderer: infoNftRenderer.address,
    pairStable0,
    pairStable1,
    pairWrappedNative: pairNative,
    dealSwapOrderBook: orderBook.address,
    dealRouter: router.address,
    dealRouterQuoter: routerQuoter.address,
    dealSwapAssetRegistry: swapAssetRegistry.address,
    dealReader: dealReader.address,
    dcDomain: dcDomain.address,
    dcDomainRankImplementation: dcRankImpl.address,
    dcDomainRank: dcRank.address,
    dcDomainRankReader: dcRankReader.address,
    dcDomainListReader: dcDomainListReader.address,
    dcDomainMarket: dcMarket.address,
    dcDomainSwap: dcSwap.address,
    dcDomainHall: dcHall.address,
  };
  if (deployDao && dToken && nftActivity && nftVetoRegistry && seatVetoGovernor && voteClaimer) {
    addresses.dToken = dToken.address;
    addresses.dealNftGovernanceActivity = nftActivity.address;
    addresses.nftVetoRegistry = nftVetoRegistry.address;
    addresses.dealSeatVetoGovernor = seatVetoGovernor.address;
    addresses.voteDividendClaimer = voteClaimer.address;
  }
  if (protocolTreasury) {
    addresses.protocolTreasury = protocolTreasury.address;
  }

  const deployedAt = new Date().toISOString();
  const out: DeploymentJson = {
    chainId,
    network: networkName,
    rpcUrl: chainId === 1
      ? process.env.ETH_MAINNET_RPC_URL
      : chainId === 56
        ? process.env.BSC_MAINNET_RPC_URL
        : (process.env.ETH_MAINNET_RPC_URL ?? process.env.BSC_MAINNET_RPC_URL),
    deployedAt,
    deployer: dep,
    addresses,
    abi: {
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
      DealSwapTemplate: loadAbi("DealSwapTemplate.sol/DealSwapTemplate.json"),
      DCToken: loadAbi("DL.sol/DCToken.json"),
      WrappedAGI: loadAbi("WrappedAGI.sol/WrappedAGI.json"),
      ERC1967Proxy: artifactAbi("ERC1967Proxy"),
      DealFactory: loadAbi("DealFactory.sol/DealFactory.json"),
      DealMessageHub: loadAbi("DealMessageHub.sol/DealMessageHub.json"),
      DealCreditGraph: loadAbi("DealCreditGraph.sol/DealCreditGraph.json"),
      DealActivityIndex: loadAbi("DealActivityIndex.sol/DealActivityIndex.json"),
      DealResultIndex: loadAbi("DealResultIndex.sol/DealResultIndex.json"),
      DealInfoNFT: loadAbi("DealInfoNft.sol/DealInfoNFT.json"),
      DealInfoNFTRenderer: loadAbi("DealInfoNFTRenderer.sol/DealInfoNFTRenderer.json"),
      DealSwapOrderBook: loadAbi("DealSwapOrderBook.sol/DealSwapOrderBook.json"),
      DealRouter: loadAbi("DealSwapRouter.sol/DealRouter.json"),
      DealRouterQuoter: loadAbi("DealRouterQuoter.sol/DealRouterQuoter.json"),
      DealSwapAssetRegistry: loadAbi("DealSwapAssetRegistry.sol/DealSwapAssetRegistry.json"),
      DealReader: loadAbi("DealReader.sol/DealReader.json"),
      DCDomain: loadAbi("DCdomain.sol/DCDomain.json"),
      DCDomainRank: loadAbi("DCdomainrank.sol/DCDomainRank.json"),
      DCDomainRankReader: loadAbi("DCDomainRankReader.sol/DCDomainRankReader.json"),
      DCDomainListReader: loadAbi("DCDomainListReader.sol/DCDomainListReader.json"),
      DCDomainMarket: loadAbi("DCDomainMarket.sol/DCDomainMarket.json"),
      DCDomainSwap: loadAbi("DCdomainswap.sol/DCDomainSwap.json"),
      DCDomainHall: loadAbi("DCDomainHall.sol/DCDomainHall.json"),
      D: loadAbi("D.sol/D.json"),
      DealNftGovernanceActivity: loadAbi("DealNftGovernanceActivity.sol/DealNftGovernanceActivity.json"),
      NftVetoRegistry: loadAbi("NftVetoRegistry.sol/NftVetoRegistry.json"),
      DealSeatVetoGovernor: loadAbi("DealSeatVetoGovernor.sol/DealSeatVetoGovernor.json"),
      VoteDividendClaimer: loadAbi("VoteDividendClaimer.sol/VoteDividendClaimer.json"),
      ProtocolTreasury: loadAbi("ProtocolTreasury.sol/ProtocolTreasury.json"),
    },
    params: {
      treasury,
      admin,
      protocolTreasuryEnabled: Boolean(protocolTreasury),
      protocolTreasury: protocolTreasury?.address ?? "",
      protocolTreasuryController,
      protocolTreasuryBootstrapLocked: protocolTreasury ? lockTreasuryBootstrap : false,
      dividendExecutor: finalDividendExecutor,
      dividendSource,
      stable0: stable0Address,
      stable1: stable1Address,
      wrappedNative: wrappedNativeAddress,
      infoNftMintPriceDc: INFO_NFT_MINT_PRICE_DC.toString(),
      messagePriceDc: MESSAGE_PRICE_DC.toString(),
      messageFeeEnabled: activateMessageFee,
      minTimeoutSeconds: MIN_TIMEOUT_SECONDS,
      dealFee: `${DEFAULT_FEE_NUM}/1000`,
      dealReward: `${DEFAULT_MINT_REWARD_NUM}/1000`,
      pairFee: `${PAIR_FEE_NUM}/${PAIR_FEE_DEN}`,
      createPairs,
      initPairs,
      deployDao,
    },
    notes: [
      "DealFactory is deployed behind ERC1967Proxy. Use addresses.dealFactory for frontend and governance calls.",
      "ProtocolTreasury is the default treasury when MAINNET_USE_PROTOCOL_TREASURY is not disabled. If bootstrap is not locked, wire DAO/timelock/executor and lock it before public launch.",
      "MAINNET_STABLE0_ADDRESS and MAINNET_STABLE1_ADDRESS should be real production tokens unless MAINNET_DEPLOY_MOCK_STABLES=1 was explicitly used.",
      "Pair creation is separate from pair initialization. If MAINNET_INIT_PAIRS=false, liquidity and virtual reserves still need a later controlled setup transaction.",
      "Cross-chain governance is not enabled by this script. Deploy/wire CrossChainBroadcaster and DualBridgeExecutor separately, then call DealFactory.setCrossChainGovernance(executor).",
      "MAINNET_DEPLOY_DAO=false is intended for secondary target chains such as BSC where DAO lives on ETH and cross-chain executor controls target parameters.",
    ],
  };

  const dir = join(process.cwd(), "deployments");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "backups"), { recursive: true });
  const file = join(dir, `${networkName}-${chainId}.json`);
  const stamp = deployedAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  if (existsSync(file)) {
    copyFileSync(file, join(dir, "backups", `${networkName}-${chainId}.before-${stamp}.json`));
  }
  writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
  writeFileSync(
    join(dir, `frontend-handoff-${networkName}-${chainId}-${stamp}.md`),
    renderHandoff(networkName, chainId, deployedAt, dep, addresses, out.params),
    "utf8",
  );

  console.log(`Wrote ${file}`);
  console.log(JSON.stringify(addresses, null, 2));
}

function renderHandoff(
  networkName: string,
  chainId: number,
  deployedAt: string,
  deployer: Address,
  addresses: Record<string, Address>,
  params: Record<string, string | number | boolean>,
) {
  return `# ${networkName} 前端部署地址交接

部署时间：${deployedAt}

链：${networkName} (${chainId})

部署钱包：\`${deployer}\`

## 重要说明

- Factory 使用 UUPS proxy；前端和治理统一使用 \`DealFactory\` proxy 地址。
- \`stable0/stable1\` 是本链配置的官方认可交易币地址。
- 跨链治理尚未由本脚本开启，需要后续部署并接线 \`CrossChainBroadcaster / DualBridgeExecutor\`。

## 核心地址

| 模块 | 地址 |
| --- | --- |
| DealFactory | \`${addresses.dealFactory}\` |
| DealFactory implementation | \`${addresses.dealFactoryImplementation}\` |
| DealReader | \`${addresses.dealReader}\` |
| DealMessageHub | \`${addresses.dealMessageHub}\` |
| DealResultIndex | \`${addresses.dealResultIndex}\` |
| DealActivityIndex | \`${addresses.dealActivityIndex}\` |
| DealPairManager | \`${addresses.dealPairManager}\` |
| DealImplementationRegistry | \`${addresses.dealImplementationRegistry}\` |
| DealCoin/DC | \`${addresses.dlToken}\` |
| ProtocolTreasury / Treasury | \`${addresses.protocolTreasury ?? treasury}\` |
| stable0 | \`${addresses.stable0}\` |
| stable1 | \`${addresses.stable1}\` |
| wrappedNative | \`${addresses.wrappedNative}\` |
| DealInfoNFT | \`${addresses.dealInfoNFT}\` |
| DealCreditGraph | \`${addresses.dealCreditGraph}\` |
| DCDomain | \`${addresses.dcDomain}\` |
| DCDomainRank | \`${addresses.dcDomainRank}\` |
| DCDomainSwap | \`${addresses.dcDomainSwap}\` |
| DCDomainHall | \`${addresses.dcDomainHall}\` |
${addresses.dToken ? `| D | \`${addresses.dToken}\` |
| DealSeatVetoGovernor | \`${addresses.dealSeatVetoGovernor}\` |
| VoteDividendClaimer | \`${addresses.voteDividendClaimer}\` |` : "| DAO stack | `not deployed on this chain` |"}

## 初始化参数

\`\`\`json
${JSON.stringify(params, null, 2)}
\`\`\`
`;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
