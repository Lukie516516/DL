/**
 * FINAL: Redeploy DealFactory (with mapExistingPair), DCDomainSwap, DCDomainHall.
 * Configure everything including pair mappings.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain } from "viem";
import { loadAgikingDeploymentAddresses } from "./load-agiking-deployment.js";

const AGIKING_CHAIN_ID = 31415926;

const base = loadAgikingDeploymentAddresses();
const E = {
  dlToken: base.dlToken,
  ausd: base.ausd,
  usdt: base.usdt,
  wrappedNative: base.wrappedNative,
  dealLib: base.dealLib,
  dealImpl: base.dealImplementation,
  dealNoAssetImpl: base.dealNoAssetImplementation,
  dealAAssetNftImpl: base.dealAAssetNftImplementation,
  dealBAssetNftImpl: base.dealBAssetNftImplementation,
  dealAAssetNftOnlyImpl: base.dealAAssetNftOnlyImplementation,
  dealBAssetNftOnlyImpl: base.dealBAssetNftOnlyImplementation,
  dealOpenTokenTokenImpl: base.dealOpenTokenTokenImplementation,
  dealAssetNftLib: base.dealAssetNftLib,
  pairImpl: base.pairImplementation,
  dealInfoNFT: base.dealInfoNFT,
  dealCreditGraph: base.dealCreditGraph,
  pairDlAusd: base.pairDlAusd,
  pairDlUsdt: base.pairDlUsdt,
  orderBook: base.dealSwapOrderBook,
  dealRouter: base.dealRouter,
  dealReader: base.dealReader,
  dcDomain: base.dcDomain,
  dcDomainRank: base.dcDomainRank,
  dcDomainMarket: base.dcDomainMarket,
  dToken: base.dToken,
  dealNftGovernanceActivity: base.dealNftGovernanceActivity,
  nftVetoRegistry: base.nftVetoRegistry,
  dealSeatVetoGovernor: base.dealSeatVetoGovernor,
  voteClaimer: base.voteDividendClaimer,
};

function agikingChain(rpcUrl: string) {
  return defineChain({
    id: AGIKING_CHAIN_ID, name: "Agiking",
    nativeCurrency: { decimals: 18, name: "Native", symbol: "NATIVE" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function loadAbi(rel: string): unknown[] {
  const p = join(process.cwd(), "artifacts", "contracts", rel);
  return (JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[] }).abi;
}

async function w(pc: any, h: `0x${string}`) { return pc.waitForTransactionReceipt({ hash: h }); }

async function main() {
  const rpcUrl = process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop";
  const chain = agikingChain(rpcUrl.trim());
  const { viem } = await network.connect({ network: "agiking", chainType: "l1" });
  const pc = await viem.getPublicClient({ chain });
  const [deployer] = await viem.getWalletClients({ chain });
  const cl = { public: pc, wallet: deployer } as const;
  const dep = deployer.account.address;
  console.log("Chain", chain.id, "deployer", dep);

  // ═══ 1. Deploy DealFactory ═══
  console.log("\n--- DealFactory ---");
  const factory = await viem.deployContract("DealFactory", [E.dealImpl, E.pairImpl, 3600], { client: cl });
  console.log("DealFactory:", factory.address);
  const dealNoAssetImpl = E.dealNoAssetImpl
    ? await viem.getContractAt("DealNoAsset", E.dealNoAssetImpl, { client: cl })
    : await viem.deployContract("DealNoAsset", [], { client: cl, libraries: { DealLib: E.dealLib } });
  console.log(E.dealNoAssetImpl ? "DealNoAsset existing:" : "DealNoAsset:", dealNoAssetImpl.address);
  const dealAssetNftLib = E.dealAssetNftLib
    ? E.dealAssetNftLib
    : (await viem.deployContract("DealAssetNftLib", [], { client: cl })).address;
  if (!E.dealAssetNftLib) console.log("DealAssetNftLib:", dealAssetNftLib);
  const dealAAssetNftImpl = E.dealAAssetNftImpl
    ? await viem.getContractAt("DealAAssetNft", E.dealAAssetNftImpl, { client: cl })
    : await viem.deployContract("DealAAssetNft", [], {
        client: cl,
        libraries: { DealLib: E.dealLib, DealAssetNftLib: dealAssetNftLib },
      });
  console.log(E.dealAAssetNftImpl ? "DealAAssetNft existing:" : "DealAAssetNft:", dealAAssetNftImpl.address);
  const dealBAssetNftImpl = E.dealBAssetNftImpl
    ? await viem.getContractAt("DealBAssetNft", E.dealBAssetNftImpl, { client: cl })
    : await viem.deployContract("DealBAssetNft", [], {
        client: cl,
        libraries: { DealLib: E.dealLib, DealAssetNftLib: dealAssetNftLib },
      });
  console.log(E.dealBAssetNftImpl ? "DealBAssetNft existing:" : "DealBAssetNft:", dealBAssetNftImpl.address);
  const dealAAssetNftOnlyImpl = E.dealAAssetNftOnlyImpl
    ? await viem.getContractAt("DealAAssetNftOnly", E.dealAAssetNftOnlyImpl, { client: cl })
    : await viem.deployContract("DealAAssetNftOnly", [], {
        client: cl,
        libraries: { DealAssetNftLib: dealAssetNftLib },
      });
  console.log(E.dealAAssetNftOnlyImpl ? "DealAAssetNftOnly existing:" : "DealAAssetNftOnly:", dealAAssetNftOnlyImpl.address);
  const dealBAssetNftOnlyImpl = E.dealBAssetNftOnlyImpl
    ? await viem.getContractAt("DealBAssetNftOnly", E.dealBAssetNftOnlyImpl, { client: cl })
    : await viem.deployContract("DealBAssetNftOnly", [], {
        client: cl,
        libraries: { DealAssetNftLib: dealAssetNftLib },
      });
  console.log(E.dealBAssetNftOnlyImpl ? "DealBAssetNftOnly existing:" : "DealBAssetNftOnly:", dealBAssetNftOnlyImpl.address);
  const dealOpenTokenTokenImpl = E.dealOpenTokenTokenImpl
    ? await viem.getContractAt("DealOpenTokenToken", E.dealOpenTokenTokenImpl, { client: cl })
    : await viem.deployContract("DealOpenTokenToken", [], { client: cl, libraries: { DealLib: E.dealLib } });
  console.log(E.dealOpenTokenTokenImpl ? "DealOpenTokenToken existing:" : "DealOpenTokenToken:", dealOpenTokenTokenImpl.address);
  const dealMessageHub = await viem.deployContract("DealMessageHub", [factory.address], { client: cl });
  console.log("DealMessageHub:", dealMessageHub.address);
  const dealActivityIndex = await viem.deployContract("DealActivityIndex", [factory.address], { client: cl });
  console.log("DealActivityIndex:", dealActivityIndex.address);
  const dealImplementationRegistry = await viem.deployContract("DealImplementationRegistry", [], { client: cl });
  console.log("DealImplementationRegistry:", dealImplementationRegistry.address);
  const creditGraph = E.dealCreditGraph
    ? await viem.getContractAt("DealCreditGraph", E.dealCreditGraph, { client: cl })
    : await viem.deployContract("DealCreditGraph", [E.dealInfoNFT], { client: cl });
  console.log(E.dealCreditGraph ? "DealCreditGraph existing:" : "DealCreditGraph:", creditGraph.address);

  // Configure globals
  await w(pc, await factory.write.setGlobal(["dlToken", E.dlToken]));
  await w(pc, await factory.write.setGlobal(["infoNft", E.dealInfoNFT]));
  await w(pc, await factory.write.setGlobal(["wrappedNative", E.wrappedNative]));
  await w(pc, await factory.write.setGlobal(["dealMessageHub", dealMessageHub.address]));
  await w(pc, await factory.write.setGlobal(["dealActivityIndex", dealActivityIndex.address]));
  await w(pc, await dealImplementationRegistry.write.setDealImplementations([
    E.dealImpl,
    dealNoAssetImpl.address,
    dealAAssetNftImpl.address,
    dealBAssetNftImpl.address,
    dealAAssetNftOnlyImpl.address,
    dealBAssetNftOnlyImpl.address,
    dealOpenTokenTokenImpl.address,
  ]));
  await w(pc, await factory.write.setGlobal(["dealImplementationRegistry", dealImplementationRegistry.address]));
  await w(pc, await creditGraph.write.setRecorder([factory.address, true]));
  await w(pc, await factory.write.setGlobal(["swapOrderBook", E.orderBook]));
  await w(pc, await factory.write.setRecognizedTokens([E.ausd, E.usdt]));
  await w(pc, await factory.write.setTreasuryByAdmin([dep]));
  console.log("  globals OK");

  // Map existing pairs
  await w(pc, await factory.write.mapExistingPair([E.ausd, E.pairDlAusd]));
  await w(pc, await factory.write.mapExistingPair([E.usdt, E.pairDlUsdt]));
  console.log("  pairForToken AUSD →", E.pairDlAusd);
  console.log("  pairForToken USDT →", E.pairDlUsdt);

  // Grant DL MINTER_ROLE
  const dl = await viem.getContractAt("DCToken", E.dlToken, { client: cl });
  const minterRole = await dl.read.MINTER_ROLE();
  await w(pc, await dl.write.grantRole([minterRole, factory.address]));
  console.log("  MINTER_ROLE granted");

  // ═══ 2. Deploy DCDomainSwap ═══
  console.log("\n--- DCDomainSwap ---");
  const dcSwap = await viem.deployContract("DCDomainSwap", [E.dcDomain, E.dcDomainRank, factory.address], { client: cl });
  console.log("DCDomainSwap:", dcSwap.address);

  // ═══ 3. Deploy DCDomainHall ═══
  console.log("\n--- DCDomainHall ---");
  const dcHall = await viem.deployContract("DCDomainHall", [E.dcDomainRank, E.dcDomain, factory.address], { client: cl });
  console.log("DCDomainHall:", dcHall.address);

  // ═══ 4. Permissions ═══
  console.log("\n--- Permissions ---");
  await w(pc, await factory.write.setAllowedCreateFor([dcSwap.address, true]));
  await w(pc, await factory.write.setAllowedCreateFor([dcHall.address, true]));
  console.log("  allowedCreateFor: Swap + Hall OK");

  const rank = await viem.getContractAt("DCDomainRank", E.dcDomainRank, { client: cl });
  await w(pc, await rank.write.setDealReporter([dcSwap.address, true]));
  await w(pc, await rank.write.setDealReporter([dcHall.address, true]));
  console.log("  dealReporter: Swap + Hall OK");

  // ═══ Summary ═══
  const all = {
    dlToken: E.dlToken,
    ausd: E.ausd,
    usdt: E.usdt,
    wrappedNative: E.wrappedNative,
    dealLib: E.dealLib,
    dealAssetNftLib,
    dealImplementation: E.dealImpl,
    dealNoAssetImplementation: dealNoAssetImpl.address,
    dealAAssetNftImplementation: dealAAssetNftImpl.address,
    dealBAssetNftImplementation: dealBAssetNftImpl.address,
    dealAAssetNftOnlyImplementation: dealAAssetNftOnlyImpl.address,
    dealBAssetNftOnlyImplementation: dealBAssetNftOnlyImpl.address,
    dealOpenTokenTokenImplementation: dealOpenTokenTokenImpl.address,
    dealImplementationRegistry: dealImplementationRegistry.address,
    pairImplementation: E.pairImpl,
    dealFactory: factory.address,
    dealMessageHub: dealMessageHub.address,
    dealCreditGraph: creditGraph.address,
    dealActivityIndex: dealActivityIndex.address,
    dealInfoNFT: E.dealInfoNFT,
    pairDlAusd: E.pairDlAusd,
    pairDlUsdt: E.pairDlUsdt,
    dealSwapOrderBook: E.orderBook,
    dealRouter: E.dealRouter,
    dealReader: E.dealReader,
    dcDomain: E.dcDomain,
    dcDomainRank: E.dcDomainRank,
    dcDomainMarket: E.dcDomainMarket,
    dcDomainSwap: dcSwap.address,
    dcDomainHall: dcHall.address,
    dToken: E.dToken,
    dealNftGovernanceActivity: E.dealNftGovernanceActivity,
    nftVetoRegistry: E.nftVetoRegistry,
    dealSeatVetoGovernor: E.dealSeatVetoGovernor,
    voteDividendClaimer: E.voteClaimer,
  };

  console.log("\n========== ALL ADDRESSES ==========");
  console.log(JSON.stringify(all, null, 2));

  const dir = join(process.cwd(), "deployments");
  mkdirSync(dir, { recursive: true });
  const out = {
    chainId: AGIKING_CHAIN_ID, rpcUrl: rpcUrl.trim(),
    deployedAt: new Date().toISOString(), deployer: dep,
    addresses: all,
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
      DealFactory: loadAbi("DealFactory.sol/DealFactory.json"),
      DealMessageHub: loadAbi("DealMessageHub.sol/DealMessageHub.json"),
      DealCreditGraph: loadAbi("DealCreditGraph.sol/DealCreditGraph.json"),
      DealActivityIndex: loadAbi("DealActivityIndex.sol/DealActivityIndex.json"),
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
      DealNftGovernanceActivity: loadAbi("DealNftGovernanceActivity.sol/DealNftGovernanceActivity.json"),
      NftVetoRegistry: loadAbi("NftVetoRegistry.sol/NftVetoRegistry.json"),
      DealSeatVetoGovernor: loadAbi("DealSeatVetoGovernor.sol/DealSeatVetoGovernor.json"),
      VoteDividendClaimer: loadAbi("VoteDividendClaimer.sol/VoteDividendClaimer.json"),
    },
  };
  const file = join(dir, "agiking-31415926.json");
  writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
  console.log("\nWrote", file);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
