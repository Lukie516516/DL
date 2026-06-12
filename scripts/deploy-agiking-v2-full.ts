/**
 * deploy-agiking-v2-full.ts
 *
 * Full v2 deployment for Agiking chain.
 *
 * Architecture changes vs. previous deployment:
 *   - DealFactory, DCdomainrank, DealGovernance deployed as UUPS proxies
 *   - New DealLib (M-2 reward split fix) + all linked implementations redeployed
 *   - DealSwapRouter: 3-arg constructor (WNATIVE, ORDER_BOOK, PAIR_MANAGER)
 *   - Full governance stack: DealGovernance, NftVetoRegistry v2,
 *     DealSeatVetoGovernor, DealNftGovernanceActivity, VoteDividendClaimer
 *   - CrossChainDispatcher + CrossChainExecutor (bridge placeholder)
 *
 * Keeps from existing deployment (addresses read from JSON file):
 *   - dlToken, ausd, usdt, wrappedNative
 *   - dealInfoNFT, dealCreditGraph
 *   - pairDlAusd, pairDlUsdt, pairDlAgi (existing swap pools)
 *   - dealImplementation (Deal.sol unchanged), dealAssetNftLib
 *
 * Env vars:
 *   AGIKING_RPC_URL      RPC endpoint (default: https://rpc.agikingrpc.shop)
 *   AGIKING_GAS_PRICE_GWEI  gas price in gwei (default: 2)
 *   TREASURY             treasury address (default: deployer)
 *   D_INITIAL_HOLDER     address that receives the 100 D tokens (default: deployer)
 *   DIVIDEND_EXECUTOR    VoteDividendClaimer executor (default: deployer)
 *   DIVIDEND_SOURCE      VoteDividendClaimer dividend source wallet (default: deployer)
 *   ETH_CHAIN_ID         chain ID of the ETH mainnet counterpart (default: 1)
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import {
  defineChain,
  encodeFunctionData,
  formatEther,
  getAddress,
  parseGwei,
  zeroAddress,
  type Address,
} from "viem";
import { loadAgikingDeploymentAddresses } from "./load-agiking-deployment.js";

const AGIKING_CHAIN_ID = 31415926;
const DEPLOYMENT_FILE = "agiking-31415926.json";
const ZERO = zeroAddress;

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
): Promise<AnyContract> {
  const opts = { ...gasOptions(), ...options };
  try {
    return await viem.deployContract(name, args, opts) as AnyContract;
  } catch (err: any) {
    const details = [
      err?.details, err?.shortMessage, err?.message,
      err?.cause?.details, err?.cause?.message,
    ].filter(Boolean).join("\n");
    const match = details.match(/insufficient gas for floor data gas cost: have \d+, want (\d+)/i);
    if (!match) throw err;
    const wanted = BigInt(match[1]);
    const gas = (wanted * 120n) / 100n + 50_000n;
    console.log(`  RETRY ${name} with gas ${gas}`);
    return await viem.deployContract(name, args, { ...opts, gas }) as AnyContract;
  }
}

/** Deploy a UUPS-upgradeable contract: impl → ERC1967Proxy(impl, initCalldata). */
async function deployUUPS(
  viem: any,
  client: { public: any; wallet: any },
  name: string,
  initInputs: readonly { name: string; type: string }[],
  initArgs: unknown[],
): Promise<AnyContract & { implAddress: Address }> {
  const impl = await deploy(viem, name, [], { client });
  console.log(`  ${name} impl: ${impl.address}`);

  const initData = encodeFunctionData({
    abi: [{ type: "function", name: "initialize", inputs: initInputs, outputs: [], stateMutability: "nonpayable" }],
    functionName: "initialize",
    args: initArgs,
  });
  const proxyRaw = await deploy(viem, "ERC1967Proxy", [impl.address, initData], { client });
  console.log(`  ${name} proxy: ${proxyRaw.address}`);

  const contract = await viem.getContractAt(name, proxyRaw.address, { client }) as AnyContract;
  return { ...contract, implAddress: impl.address };
}

function loadDeploymentJson() {
  return JSON.parse(readFileSync(join("deployments", DEPLOYMENT_FILE), "utf8")) as {
    chainId: number;
    rpcUrl: string;
    deployer: string;
    addresses: Record<string, string>;
    abi: Record<string, unknown[]>;
    notes?: string[];
  };
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

  const treasury = (process.env.TREASURY?.trim() || dep) as Address;
  const dInitialHolder = (process.env.D_INITIAL_HOLDER?.trim() || dep) as Address;
  const dividendExecutor = (process.env.DIVIDEND_EXECUTOR?.trim() || dep) as Address;
  const dividendSource = (process.env.DIVIDEND_SOURCE?.trim() || dep) as Address;
  const ethChainId = Number(process.env.ETH_CHAIN_ID ?? "1");

  // ── Unchanged contracts (read from existing deployment) ──────────────────────
  const dlToken = base.dlToken as Address;
  const ausd = base.ausd as Address;
  const usdt = base.usdt as Address;
  const wnative = base.wrappedNative as Address;
  const dealInfoNFTAddr = base.dealInfoNFT as Address;
  const dealCreditGraphAddr = base.dealCreditGraph as Address;
  const dealImplAddr = base.dealImplementation as Address;
  const dealAssetNftLibAddr = base.dealAssetNftLib as Address;
  const pairImplAddr = base.pairImplementation as Address;
  const pairDlAusd = base.pairDlAusd as Address;
  const pairDlUsdt = base.pairDlUsdt as Address;
  const pairDlAgi = (base.pairDlAgi ?? ZERO) as Address;

  const infoNft = await viem.getContractAt("DealInfoNFT", dealInfoNFTAddr, { client }) as AnyContract;
  const creditGraph = await viem.getContractAt("DealCreditGraph", dealCreditGraphAddr, { client }) as AnyContract;
  const dl = await viem.getContractAt("DCToken", dlToken, { client }) as AnyContract;

  // ── 1. Libraries ─────────────────────────────────────────────────────────────
  console.log("\n=== 1. Libraries ===");
  const dealLib = await deploy(viem, "DealLib", [], { client });
  console.log("DealLib", dealLib.address);
  // DealAssetNftLib unchanged — reuse existing
  console.log("DealAssetNftLib (reused)", dealAssetNftLibAddr);

  // ── 2. Deal implementation contracts ─────────────────────────────────────────
  console.log("\n=== 2. Deal implementations ===");
  const dealNoAssetImpl = await deploy(viem, "DealNoAsset", [], {
    client,
    libraries: { DealLib: dealLib.address },
  });
  const dealAAssetNftImpl = await deploy(viem, "DealAAssetNft", [], {
    client,
    libraries: { DealLib: dealLib.address, DealAssetNftLib: dealAssetNftLibAddr },
  });
  const dealBAssetNftImpl = await deploy(viem, "DealBAssetNft", [], {
    client,
    libraries: { DealLib: dealLib.address, DealAssetNftLib: dealAssetNftLibAddr },
  });
  const dealAAssetNftOnlyImpl = await deploy(viem, "DealAAssetNftOnly", [], {
    client,
    libraries: { DealAssetNftLib: dealAssetNftLibAddr },
  });
  const dealBAssetNftOnlyImpl = await deploy(viem, "DealBAssetNftOnly", [], {
    client,
    libraries: { DealAssetNftLib: dealAssetNftLibAddr },
  });
  const dealOpenTokenTokenImpl = await deploy(viem, "DealOpenTokenToken", [], {
    client,
    libraries: { DealLib: dealLib.address },
  });
  console.log("DealNoAsset", dealNoAssetImpl.address);
  console.log("DealAAssetNft", dealAAssetNftImpl.address);
  console.log("DealBAssetNft", dealBAssetNftImpl.address);
  console.log("DealAAssetNftOnly", dealAAssetNftOnlyImpl.address);
  console.log("DealBAssetNftOnly", dealBAssetNftOnlyImpl.address);
  console.log("DealOpenTokenToken", dealOpenTokenTokenImpl.address);
  console.log("Deal (reused)", dealImplAddr);

  // ── 3. DealImplementationRegistry ────────────────────────────────────────────
  console.log("\n=== 3. DealImplementationRegistry ===");
  const registry = await deploy(viem, "DealImplementationRegistry", [], { client });
  console.log("DealImplementationRegistry", registry.address);

  // ── 4. DealFactory UUPS proxy ─────────────────────────────────────────────────
  console.log("\n=== 4. DealFactory (UUPS proxy) ===");
  const factory = await deployUUPS(
    viem, client, "DealFactory",
    [
      { name: "_dealImpl",           type: "address" },
      { name: "_pairImpl",           type: "address" },
      { name: "_minTimeoutSeconds",  type: "uint64"  },
    ],
    [dealImplAddr, pairImplAddr, 3600n],
  );
  console.log("DealFactory", factory.address);

  // ── 5. Factory-dependent peripheral contracts ─────────────────────────────────
  console.log("\n=== 5. Factory-dependent contracts ===");
  const pairManager     = await deploy(viem, "DealPairManager",     [factory.address], { client });
  const messageHub      = await deploy(viem, "DealMessageHub",      [factory.address], { client });
  const activityIndex   = await deploy(viem, "DealActivityIndex",   [factory.address], { client });
  const resultIndex     = await deploy(viem, "DealResultIndex",     [factory.address], { client });
  console.log("DealPairManager",   pairManager.address);
  console.log("DealMessageHub",    messageHub.address);
  console.log("DealActivityIndex", activityIndex.address);
  console.log("DealResultIndex",   resultIndex.address);

  // ── 6. Swap order book + router + quoter ──────────────────────────────────────
  console.log("\n=== 6. Swap stack ===");
  const orderBook = await deploy(viem, "DealSwapOrderBook", [treasury], { client });
  const router    = await deploy(viem, "DealRouter",        [wnative, orderBook.address, pairManager.address], { client });
  const quoter    = await deploy(viem, "DealRouterQuoter",  [orderBook.address], { client });
  const swapAssetRegistry = await deploy(viem, "DealSwapAssetRegistry", [
    dep, pairManager.address, router.address, dlToken, wnative, usdt, ausd,
  ], { client });
  console.log("DealSwapOrderBook",    orderBook.address);
  console.log("DealRouter",           router.address);
  console.log("DealRouterQuoter",     quoter.address);
  console.log("DealSwapAssetRegistry", swapAssetRegistry.address);

  // ── 7. NFT renderer + reader ──────────────────────────────────────────────────
  console.log("\n=== 7. Renderer + Reader ===");
  const renderer  = await deploy(viem, "DealInfoNFTRenderer", [], { client });
  const dealReader = await deploy(viem, "DealReader", [], { client });
  console.log("DealInfoNFTRenderer", renderer.address);
  console.log("DealReader", dealReader.address);

  // ── 8. DCdomainrank UUPS proxy ────────────────────────────────────────────────
  console.log("\n=== 8. DCdomainrank (UUPS proxy) ===");
  // DCDomain must exist before DCdomainrank; deploy it now
  const dcDomain = await deploy(viem, "DCDomain", [dlToken, treasury], { client });
  console.log("DCDomain", dcDomain.address);

  const dcRank = await deployUUPS(
    viem, client, "DCDomainRank",
    [
      { name: "_dcToken",  type: "address" },
      { name: "_dcDomain", type: "address" },
      { name: "_treasury", type: "address" },
    ],
    [dlToken, dcDomain.address, treasury],
  );
  console.log("DCDomainRank", dcRank.address);

  // ── 9. Domain peripheral contracts ───────────────────────────────────────────
  console.log("\n=== 9. Domain peripherals ===");
  const dcRankReader      = await deploy(viem, "DCDomainRankReader", [dcRank.address], { client });
  const dcListReader      = await deploy(viem, "DCDomainListReader", [dcDomain.address, dcRank.address], { client });
  const dcMarket          = await deploy(viem, "DCDomainMarket",     [dcDomain.address, dlToken, treasury, 100n], { client });
  const dcSwap            = await deploy(viem, "DCDomainSwap",       [dcDomain.address, dcRank.address, factory.address], { client });
  const dcHall            = await deploy(viem, "DCDomainHall",       [dcRank.address, dcDomain.address, factory.address], { client });
  console.log("DCDomainRankReader", dcRankReader.address);
  console.log("DCDomainListReader", dcListReader.address);
  console.log("DCDomainMarket",     dcMarket.address);
  console.log("DCDomainSwap",       dcSwap.address);
  console.log("DCDomainHall",       dcHall.address);

  // ── 10. Governance stack ──────────────────────────────────────────────────────
  console.log("\n=== 10. Governance stack ===");
  const dToken        = await deploy(viem, "D", [dInitialHolder], { client });
  const nftActivity   = await deploy(viem, "DealNftGovernanceActivity", [dealInfoNFTAddr], { client });
  // NftVetoRegistry v2: pass address(0) for governor initially; set after DealSeatVetoGovernor deployed
  const nftVetoReg    = await deploy(viem, "NftVetoRegistry", [dealInfoNFTAddr, nftActivity.address], { client });
  const seatGov       = await deploy(viem, "DealSeatVetoGovernor", [dToken.address, nftVetoReg.address], { client });

  // DealGovernance UUPS proxy — nftVetoRegistry set to address(0); enable later via setNftVetoRegistry
  const governance = await deployUUPS(
    viem, client, "DealGovernance",
    [
      { name: "dToken_",           type: "address" },
      { name: "nftVetoRegistry_",  type: "address" },
      { name: "dcToken_",          type: "address" },
      { name: "treasury_",         type: "address" },
    ],
    [dToken.address, ZERO, dlToken, treasury],
  );

  const voteClaimer = await deploy(viem, "VoteDividendClaimer", [
    dToken.address, dlToken, dividendExecutor, dividendSource,
  ], { client });

  console.log("D",                       dToken.address);
  console.log("DealNftGovernanceActivity", nftActivity.address);
  console.log("NftVetoRegistry",          nftVetoReg.address);
  console.log("DealSeatVetoGovernor",     seatGov.address);
  console.log("DealGovernance",           governance.address);
  console.log("VoteDividendClaimer",      voteClaimer.address);

  // ── 11. Cross-chain (bridge placeholder) ─────────────────────────────────────
  console.log("\n=== 11. CrossChain (bridge placeholder) ===");
  const dispatcher = await deploy(viem, "CrossChainDispatcher", [governance.address], { client });
  // On Agiking test: dispatcher address is used as the trusted message source
  const executor   = await deploy(viem, "CrossChainExecutor", [ethChainId, dispatcher.address], { client });
  console.log("CrossChainDispatcher", dispatcher.address);
  console.log("CrossChainExecutor",   executor.address);

  // ── 12. Wire everything ───────────────────────────────────────────────────────
  console.log("\n=== 12. Wiring ===");

  // Factory core config
  await writeTx("Factory.setCoreGlobals", publicClient, factory, "setCoreGlobals", [
    dlToken, dealInfoNFTAddr, wnative, pairManager.address,
  ]);
  await writeTx("Factory.setServiceGlobals", publicClient, factory, "setServiceGlobals", [
    messageHub.address, dealCreditGraphAddr, activityIndex.address, resultIndex.address, registry.address,
  ]);
  await writeTx("Factory.setOpsGlobals", publicClient, factory, "setOpsGlobals", [
    orderBook.address, nftActivity.address, dcRank.address,
  ]);
  await writeTx("Factory.setRecognizedTokens", publicClient, factory, "setRecognizedTokens", [ausd, usdt]);
  await writeTx("Factory.setTreasuryByAdmin",  publicClient, factory, "setTreasuryByAdmin",  [treasury]);
  await writeTx("Factory.setCrossChainGovernance", publicClient, factory, "setCrossChainGovernance", [executor.address]);

  // Deal implementation registry
  await writeTx("Registry.setDealImplementations", publicClient, registry, "setDealImplementations", [
    dealImplAddr,
    dealNoAssetImpl.address,
    dealAAssetNftImpl.address,
    dealBAssetNftImpl.address,
    dealAAssetNftOnlyImpl.address,
    dealBAssetNftOnlyImpl.address,
    dealOpenTokenTokenImpl.address,
  ]);

  // Pair manager — map existing pools so they're usable immediately
  await writeTx("PairManager.mapExistingPair AUSD", publicClient, pairManager, "mapExistingPair", [ausd, pairDlAusd]);
  await writeTx("PairManager.mapExistingPair USDT", publicClient, pairManager, "mapExistingPair", [usdt, pairDlUsdt]);
  if (pairDlAgi !== ZERO) {
    await writeTx("PairManager.mapExistingPair AGI", publicClient, pairManager, "mapExistingPair", [wnative, pairDlAgi]);
  }

  // Order book router
  await writeTx("OrderBook.setRouter", publicClient, orderBook, "setRouter", [router.address]);

  // DealInfoNFT — grant new factory
  await maybeTx("InfoNFT.addFactory", publicClient, () => infoNft.write.addFactory([factory.address], gasOptions()));
  await maybeTx("InfoNFT.setFactory", publicClient, () => infoNft.write.setFactory([factory.address], gasOptions()));
  // Renderer
  await maybeTx("InfoNFT.setRenderer", publicClient, () => infoNft.write.setRenderer([renderer.address], gasOptions()));

  // DealCreditGraph — grant new factory
  await maybeTx("CreditGraph.setRecorder factory", publicClient, () =>
    creditGraph.write.setRecorder([factory.address, true], gasOptions()),
  );

  // DC token — grant MINTER_ROLE to new factory
  const minterRole = await dl.read.MINTER_ROLE() as `0x${string}`;
  await maybeTx("DL.grantRole MINTER factory", publicClient, () =>
    dl.write.grantRole([minterRole, factory.address], gasOptions()),
  );

  // DCdomainrank wiring
  await writeTx("DCRank.setAutoCloser",        publicClient, dcRank, "setAutoCloser",   [factory.address]);
  await writeTx("DCRank.reporter DCDomainSwap", publicClient, dcRank, "setDealReporter", [dcSwap.address, true]);
  await writeTx("DCRank.reporter DCDomainHall", publicClient, dcRank, "setDealReporter", [dcHall.address, true]);

  // DCDomain market
  await writeTx("DCDomain.setDomainMarket", publicClient, dcDomain, "setDomainMarket", [dcMarket.address]);

  // Factory allow DCDomainSwap and DCDomainHall to create deals
  await writeTx("Factory.allow DCDomainSwap", publicClient, factory, "setAllowedCreateFor", [dcSwap.address, true]);
  await writeTx("Factory.allow DCDomainHall", publicClient, factory, "setAllowedCreateFor", [dcHall.address, true]);

  // Governance activity recorders
  await writeTx("NftActivity.setRecorder factory",     publicClient, nftActivity, "setRecorder", [factory.address, true]);
  await writeTx("NftActivity.setRecorder nftVetoReg",  publicClient, nftActivity, "setRecorder", [nftVetoReg.address, true]);
  await writeTx("NftActivity.setRecorder voteClaimer", publicClient, nftActivity, "setRecorder", [voteClaimer.address, true]);

  // NftVetoRegistry — set governor
  await writeTx("NftVetoReg.setGovernor seatGov", publicClient, nftVetoReg, "setGovernor", [seatGov.address, true]);

  // VoteDividendClaimer wiring
  await writeTx("VoteClaimer.setGovernanceActivity", publicClient, voteClaimer, "setGovernanceActivity", [
    dealInfoNFTAddr, nftActivity.address,
  ]);
  await writeTx("VoteClaimer.setGovernanceContract", publicClient, voteClaimer, "setGovernanceContract", [
    governance.address,
  ]);

  // CrossChainDispatcher: register executor on Agiking (self-referential for testing)
  await writeTx("Dispatcher.registerExecutor", publicClient, dispatcher, "registerExecutor", [
    AGIKING_CHAIN_ID, executor.address,
  ]);

  // ── 13. Save deployment file ──────────────────────────────────────────────────
  console.log("\n=== 13. Saving deployment ===");

  const deployedAt = new Date().toISOString();

  const addresses: Record<string, string> = {
    // unchanged
    deployer:                  dep,
    dlToken,
    ausd,
    usdt,
    wrappedNative:             wnative,
    agi:                       wnative,
    dealInfoNFT:               dealInfoNFTAddr,
    dealCreditGraph:           dealCreditGraphAddr,
    dealImplementation:        dealImplAddr,
    dealAssetNftLib:           dealAssetNftLibAddr,
    pairImplementation:        pairImplAddr,
    pairDlAusd,
    pairDlUsdt,
    pairDlAgi,
    pairDlOldAusd:             pairDlAusd,
    pairDlOldUsdt:             pairDlUsdt,
    // new
    dealLib:                   getAddress(dealLib.address),
    dealNoAssetImplementation: getAddress(dealNoAssetImpl.address),
    dealAAssetNftImplementation:     getAddress(dealAAssetNftImpl.address),
    dealBAssetNftImplementation:     getAddress(dealBAssetNftImpl.address),
    dealAAssetNftOnlyImplementation: getAddress(dealAAssetNftOnlyImpl.address),
    dealBAssetNftOnlyImplementation: getAddress(dealBAssetNftOnlyImpl.address),
    dealOpenTokenTokenImplementation: getAddress(dealOpenTokenTokenImpl.address),
    dealImplementationRegistry: getAddress(registry.address),
    dealFactory:               getAddress(factory.address),
    dealFactoryImpl:           getAddress(factory.implAddress),
    dealPairManager:           getAddress(pairManager.address),
    dealMessageHub:            getAddress(messageHub.address),
    dealActivityIndex:         getAddress(activityIndex.address),
    dealResultIndex:           getAddress(resultIndex.address),
    dealSwapOrderBook:         getAddress(orderBook.address),
    dealRouter:                getAddress(router.address),
    dealRouterQuoter:          getAddress(quoter.address),
    dealSwapAssetRegistry:     getAddress(swapAssetRegistry.address),
    dealInfoNFTRenderer:       getAddress(renderer.address),
    dealReader:                getAddress(dealReader.address),
    dcDomain:                  getAddress(dcDomain.address),
    dcDomainRank:              getAddress(dcRank.address),
    dcDomainRankImpl:          getAddress(dcRank.implAddress),
    dcDomainRankReader:        getAddress(dcRankReader.address),
    dcDomainListReader:        getAddress(dcListReader.address),
    dcDomainMarket:            getAddress(dcMarket.address),
    dcDomainSwap:              getAddress(dcSwap.address),
    dcDomainHall:              getAddress(dcHall.address),
    dToken:                    getAddress(dToken.address),
    dealNftGovernanceActivity: getAddress(nftActivity.address),
    nftVetoRegistry:           getAddress(nftVetoReg.address),
    dealSeatVetoGovernor:      getAddress(seatGov.address),
    dealGovernance:            getAddress(governance.address),
    dealGovernanceImpl:        getAddress(governance.implAddress),
    voteDividendClaimer:       getAddress(voteClaimer.address),
    crossChainDispatcher:      getAddress(dispatcher.address),
    crossChainExecutor:        getAddress(executor.address),
  };

  const abi: Record<string, unknown[]> = {
    DealLib:                   loadAbi("utils/DealLib.sol/DealLib.json"),
    DealAssetNftLib:           loadAbi("utils/DealAssetNftLib.sol/DealAssetNftLib.json"),
    Deal:                      loadAbi("Deal.sol/Deal.json"),
    DealNoAsset:               loadAbi("DealNoAsset.sol/DealNoAsset.json"),
    DealAAssetNft:             loadAbi("DealAAssetNft.sol/DealAAssetNft.json"),
    DealBAssetNft:             loadAbi("DealBAssetNft.sol/DealBAssetNft.json"),
    DealAAssetNftOnly:         loadAbi("DealAAssetNftOnly.sol/DealAAssetNftOnly.json"),
    DealBAssetNftOnly:         loadAbi("DealBAssetNftOnly.sol/DealBAssetNftOnly.json"),
    DealOpenTokenToken:        loadAbi("DealOpenTokenToken.sol/DealOpenTokenToken.json"),
    DealImplementationRegistry: loadAbi("DealImplementationRegistry.sol/DealImplementationRegistry.json"),
    DealFactory:               loadAbi("DealFactory.sol/DealFactory.json"),
    DealPairManager:           loadAbi("DealPairManager.sol/DealPairManager.json"),
    DealMessageHub:            loadAbi("DealMessageHub.sol/DealMessageHub.json"),
    DealActivityIndex:         loadAbi("DealActivityIndex.sol/DealActivityIndex.json"),
    DealResultIndex:           loadAbi("DealResultIndex.sol/DealResultIndex.json"),
    DealSwapOrderBook:         loadAbi("DealSwapOrderBook.sol/DealSwapOrderBook.json"),
    DealRouter:                loadAbi("DealSwapRouter.sol/DealRouter.json"),
    DealRouterQuoter:          loadAbi("DealRouterQuoter.sol/DealRouterQuoter.json"),
    DealSwapAssetRegistry:     loadAbi("DealSwapAssetRegistry.sol/DealSwapAssetRegistry.json"),
    DealInfoNFT:               loadAbi("DealInfoNft.sol/DealInfoNFT.json"),
    DealInfoNFTRenderer:       loadAbi("DealInfoNFTRenderer.sol/DealInfoNFTRenderer.json"),
    DealReader:                loadAbi("DealReader.sol/DealReader.json"),
    DealCreditGraph:           loadAbi("DealCreditGraph.sol/DealCreditGraph.json"),
    DealSwapTemplate:          loadAbi("DealSwapTemplate.sol/DealSwapTemplate.json"),
    DCToken:                   loadAbi("DL.sol/DCToken.json"),
    DCDomain:                  loadAbi("DCdomain.sol/DCDomain.json"),
    DCDomainRank:              loadAbi("DCdomainrank.sol/DCDomainRank.json"),
    DCDomainRankReader:        loadAbi("DCDomainRankReader.sol/DCDomainRankReader.json"),
    DCDomainListReader:        loadAbi("DCDomainListReader.sol/DCDomainListReader.json"),
    DCDomainMarket:            loadAbi("DCDomainMarket.sol/DCDomainMarket.json"),
    DCDomainSwap:              loadAbi("DCdomainswap.sol/DCDomainSwap.json"),
    DCDomainHall:              loadAbi("DCDomainHall.sol/DCDomainHall.json"),
    D:                         loadAbi("D.sol/D.json"),
    DealNftGovernanceActivity: loadAbi("DealNftGovernanceActivity.sol/DealNftGovernanceActivity.json"),
    NftVetoRegistry:           loadAbi("NftVetoRegistry.sol/NftVetoRegistry.json"),
    DealSeatVetoGovernor:      loadAbi("DealSeatVetoGovernor.sol/DealSeatVetoGovernor.json"),
    DealGovernance:            loadAbi("DealGovernance.sol/DealGovernance.json"),
    VoteDividendClaimer:       loadAbi("VoteDividendClaimer.sol/VoteDividendClaimer.json"),
    CrossChainDispatcher:      loadAbi("CrossChainDispatcher.sol/CrossChainDispatcher.json"),
    CrossChainExecutor:        loadAbi("CrossChainExecutor.sol/CrossChainExecutor.json"),
  };

  const out = {
    chainId: AGIKING_CHAIN_ID,
    rpcUrl,
    deployedAt,
    deployer: dep,
    upgrade: "v2-full-uups",
    addresses,
    abi,
    notes: [
      "DealFactory, DCdomainrank, DealGovernance are UUPS proxies. Impl addresses stored as *Impl keys.",
      "Existing swap pools (pairDlAusd/pairDlUsdt/pairDlAgi), dealInfoNFT, dealCreditGraph, tokens are reused.",
      "DealGovernance nftVetoRegistry defaults to address(0) (disabled). Enable via setNftVetoRegistry proposal.",
      "CrossChainDispatcher/_Executor are bridge placeholders. Wire real bridge adapter via setBridgeAdapter().",
      "D token: 100 D minted to D_INITIAL_HOLDER. Distribute seats before enabling governance proposals.",
    ],
  };

  const dir = join(process.cwd(), "deployments");
  const backupDir = join(dir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const currentFile = join(dir, DEPLOYMENT_FILE);
  const stamp = deployedAt.replace(/[-:T]/g, "").slice(0, 14);
  if (existsSync(currentFile)) {
    copyFileSync(currentFile, join(backupDir, `agiking-31415926.before-v2-full-${stamp}.json`));
  }
  const snapshotFile = join(dir, `agiking-31415926-${stamp}.json`);
  writeFileSync(currentFile, JSON.stringify(out, null, 2), "utf8");
  writeFileSync(snapshotFile, JSON.stringify(out, null, 2), "utf8");

  // Frontend handoff
  const handoffMd = `# Agiking v2 Full 部署地址交接

部署时间：${deployedAt}
部署钱包：\`${dep}\`
链：Agiking \`${AGIKING_CHAIN_ID}\`

## 核心合约

| 合约 | 地址 |
|------|------|
| DealFactory (proxy) | \`${addresses.dealFactory}\` |
| DealPairManager | \`${addresses.dealPairManager}\` |
| DealMessageHub | \`${addresses.dealMessageHub}\` |
| DealActivityIndex | \`${addresses.dealActivityIndex}\` |
| DealResultIndex | \`${addresses.dealResultIndex}\` |
| DealImplementationRegistry | \`${addresses.dealImplementationRegistry}\` |
| DealReader | \`${addresses.dealReader}\` |
| DealInfoNFT (reused) | \`${addresses.dealInfoNFT}\` |
| DealCreditGraph (reused) | \`${addresses.dealCreditGraph}\` |

## Swap

| 合约 | 地址 |
|------|------|
| DealSwapOrderBook | \`${addresses.dealSwapOrderBook}\` |
| DealRouter | \`${addresses.dealRouter}\` |
| DealRouterQuoter | \`${addresses.dealRouterQuoter}\` |
| DealSwapAssetRegistry | \`${addresses.dealSwapAssetRegistry}\` |
| pairDlAusd (reused) | \`${addresses.pairDlAusd}\` |
| pairDlUsdt (reused) | \`${addresses.pairDlUsdt}\` |

## Domain

| 合约 | 地址 |
|------|------|
| DCDomain | \`${addresses.dcDomain}\` |
| DCDomainRank (proxy) | \`${addresses.dcDomainRank}\` |
| DCDomainRankReader | \`${addresses.dcDomainRankReader}\` |
| DCDomainListReader | \`${addresses.dcDomainListReader}\` |
| DCDomainMarket | \`${addresses.dcDomainMarket}\` |
| DCDomainSwap | \`${addresses.dcDomainSwap}\` |
| DCDomainHall | \`${addresses.dcDomainHall}\` |

## 代币

| 合约 | 地址 |
|------|------|
| DealCoin/DC (reused) | \`${addresses.dlToken}\` |
| AUSD (reused) | \`${addresses.ausd}\` |
| USDT (reused) | \`${addresses.usdt}\` |
| D (治理) | \`${addresses.dToken}\` |

## 治理

| 合约 | 地址 |
|------|------|
| DealGovernance (proxy) | \`${addresses.dealGovernance}\` |
| DealSeatVetoGovernor | \`${addresses.dealSeatVetoGovernor}\` |
| NftVetoRegistry | \`${addresses.nftVetoRegistry}\` |
| DealNftGovernanceActivity | \`${addresses.dealNftGovernanceActivity}\` |
| VoteDividendClaimer | \`${addresses.voteDividendClaimer}\` |

## 跨链（占位）

| 合约 | 地址 |
|------|------|
| CrossChainDispatcher | \`${addresses.crossChainDispatcher}\` |
| CrossChainExecutor | \`${addresses.crossChainExecutor}\` |

## 前端注意事项

- DealFactory / DCdomainrank / DealGovernance 是 UUPS 代理，ABI 不变，地址是 proxy 地址
- 旧测试 deal 历史（ActivityIndex/ResultIndex）已重置，但个人 Deal 合约仍在链上
- D 代币分发到 \`${dInitialHolder}\`，需要手动分发席位后才能启用治理提案
- DealGovernance 的 NFT veto 默认关闭（address(0)），需通过提案 setNftVetoRegistry 启用
- 完整 ABI 在 \`deployments/${DEPLOYMENT_FILE}\`
`;
  writeFileSync(join(dir, `frontend-handoff-v2-full-${stamp}.md`), handoffMd, "utf8");
  mkdirSync(join(process.cwd(), "docs"), { recursive: true });
  writeFileSync(join(process.cwd(), "docs", "前端部署地址交接文档.md"), handoffMd, "utf8");

  console.log("\nWrote", currentFile);
  console.log("Wrote", snapshotFile);
  console.log("Wrote deployments/frontend-handoff-v2-full-" + stamp + ".md");
  console.log("Wrote docs/前端部署地址交接文档.md");
  console.log("\n=== All done ===");
  console.log(JSON.stringify(
    Object.fromEntries(
      ["dealFactory","dcDomainRank","dealGovernance","dealRouter","dealSwapOrderBook","dToken","crossChainDispatcher","crossChainExecutor"]
        .map(k => [k, addresses[k]])
    ), null, 2)
  );
}

await main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
