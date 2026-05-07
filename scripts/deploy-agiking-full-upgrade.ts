/**
 * Full upgrade deploy on Agiking:
 * - New Deal (linked DealLib) + new DealFactory (InitParams: isDomainDeal / domainName)
 * - New DCDomain (description / background / totalDomains)
 * - New DCDomainMarket, DCDomainRank, DCDomainSwap, DCDomainHall
 * - New DealReader
 * Reuses: DL, AUSD, USDT, WNATIVE, DealLib, pair impl, InfoNFT, pairs, order book, router, governance stack.
 *
 * Requires: AGIKING_RPC_URL, AGIKING_PRIVATE_KEY (hardhat config)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain } from "viem";
import { loadAgikingDeploymentAddresses } from "./load-agiking-deployment.js";

const AGIKING_CHAIN_ID = 31415926;

const a = loadAgikingDeploymentAddresses();
const EXISTING = {
  dlToken: a.dlToken,
  ausd: a.ausd,
  usdt: a.usdt,
  wrappedNative: a.wrappedNative,
  dealLib: a.dealLib,
  dealAssetNftLib: a.dealAssetNftLib,
  pairImplementation: a.pairImplementation,
  dealNoAssetImplementation: a.dealNoAssetImplementation,
  dealAAssetNftImplementation: a.dealAAssetNftImplementation,
  dealBAssetNftImplementation: a.dealBAssetNftImplementation,
  dealAAssetNftOnlyImplementation: a.dealAAssetNftOnlyImplementation,
  dealBAssetNftOnlyImplementation: a.dealBAssetNftOnlyImplementation,
  dealOpenTokenTokenImplementation: a.dealOpenTokenTokenImplementation,
  dealInfoNFT: a.dealInfoNFT,
  dealCreditGraph: a.dealCreditGraph,
  pairDlAusd: a.pairDlAusd,
  pairDlUsdt: a.pairDlUsdt,
  dealSwapOrderBook: a.dealSwapOrderBook,
  dealRouter: a.dealRouter,
  dToken: a.dToken,
  dealTimelock: a.dealTimelock,
  dealGovernor: a.dealGovernor,
  voteDividendClaimer: a.voteDividendClaimer,
};

function agikingChain(rpcUrl: string) {
  return defineChain({
    id: AGIKING_CHAIN_ID,
    name: "Agiking",
    nativeCurrency: { decimals: 18, name: "Native", symbol: "NATIVE" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function loadAbi(rel: string): unknown[] {
  const p = join(process.cwd(), "artifacts", "contracts", rel);
  return (JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[] }).abi;
}

async function waitFor(publicClient: { waitForTransactionReceipt: (a: { hash: `0x${string}` }) => Promise<unknown> }, hash: `0x${string}`) {
  return publicClient.waitForTransactionReceipt({ hash });
}

async function main() {
  const rpcUrl = process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop";
  const chain = agikingChain(rpcUrl.trim());

  const { viem } = await network.connect({ network: "agiking", chainType: "l1" });
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer] = await viem.getWalletClients({ chain });
  const client = { public: publicClient, wallet: deployer } as const;
  const dep = deployer.account.address;

  console.log("Chain", chain.id, "deployer", dep);

  // 1) Deal implementations
  const dealAssetNftLib = EXISTING.dealAssetNftLib
    ? EXISTING.dealAssetNftLib
    : (await viem.deployContract("DealAssetNftLib", [], { client })).address;
  if (!EXISTING.dealAssetNftLib) console.log("dealAssetNftLib:", dealAssetNftLib);

  console.log("\n--- Deal implementation ---");
  const dealImplContract = await viem.deployContract("Deal", [], { client });
  const dealImpl = dealImplContract.address;
  console.log("dealImplementation:", dealImpl);
  const dealNoAssetImpl = EXISTING.dealNoAssetImplementation
    ? await viem.getContractAt("DealNoAsset", EXISTING.dealNoAssetImplementation, { client })
    : await viem.deployContract("DealNoAsset", [], { client, libraries: { DealLib: EXISTING.dealLib } });
  console.log(EXISTING.dealNoAssetImplementation ? "dealNoAssetImplementation existing:" : "dealNoAssetImplementation:", dealNoAssetImpl.address);
  const dealAAssetNftImpl = EXISTING.dealAAssetNftImplementation
    ? await viem.getContractAt("DealAAssetNft", EXISTING.dealAAssetNftImplementation, { client })
    : await viem.deployContract("DealAAssetNft", [], {
        client,
        libraries: { DealLib: EXISTING.dealLib, DealAssetNftLib: dealAssetNftLib },
      });
  console.log(EXISTING.dealAAssetNftImplementation ? "dealAAssetNftImplementation existing:" : "dealAAssetNftImplementation:", dealAAssetNftImpl.address);
  const dealBAssetNftImpl = EXISTING.dealBAssetNftImplementation
    ? await viem.getContractAt("DealBAssetNft", EXISTING.dealBAssetNftImplementation, { client })
    : await viem.deployContract("DealBAssetNft", [], {
        client,
        libraries: { DealLib: EXISTING.dealLib, DealAssetNftLib: dealAssetNftLib },
  });
  console.log(EXISTING.dealBAssetNftImplementation ? "dealBAssetNftImplementation existing:" : "dealBAssetNftImplementation:", dealBAssetNftImpl.address);
  const dealAAssetNftOnlyImpl = EXISTING.dealAAssetNftOnlyImplementation
    ? await viem.getContractAt("DealAAssetNftOnly", EXISTING.dealAAssetNftOnlyImplementation, { client })
    : await viem.deployContract("DealAAssetNftOnly", [], {
        client,
        libraries: { DealAssetNftLib: dealAssetNftLib },
      });
  console.log(EXISTING.dealAAssetNftOnlyImplementation ? "dealAAssetNftOnlyImplementation existing:" : "dealAAssetNftOnlyImplementation:", dealAAssetNftOnlyImpl.address);
  const dealBAssetNftOnlyImpl = EXISTING.dealBAssetNftOnlyImplementation
    ? await viem.getContractAt("DealBAssetNftOnly", EXISTING.dealBAssetNftOnlyImplementation, { client })
    : await viem.deployContract("DealBAssetNftOnly", [], {
        client,
        libraries: { DealAssetNftLib: dealAssetNftLib },
      });
  console.log(EXISTING.dealBAssetNftOnlyImplementation ? "dealBAssetNftOnlyImplementation existing:" : "dealBAssetNftOnlyImplementation:", dealBAssetNftOnlyImpl.address);
  const dealOpenTokenTokenImpl = EXISTING.dealOpenTokenTokenImplementation
    ? await viem.getContractAt("DealOpenTokenToken", EXISTING.dealOpenTokenTokenImplementation, { client })
    : await viem.deployContract("DealOpenTokenToken", [], { client, libraries: { DealLib: EXISTING.dealLib } });
  console.log(
    EXISTING.dealOpenTokenTokenImplementation ? "dealOpenTokenTokenImplementation existing:" : "dealOpenTokenTokenImplementation:",
    dealOpenTokenTokenImpl.address,
  );

  // 2) DealFactory
  console.log("\n--- DealFactory ---");
  const factory = await viem.deployContract(
    "DealFactory",
    [dealImpl, EXISTING.pairImplementation, 3600n],
    { client },
  );
  console.log("dealFactory:", factory.address);
  const dealMessageHub = await viem.deployContract("DealMessageHub", [factory.address], { client });
  console.log("dealMessageHub:", dealMessageHub.address);
  const dealActivityIndex = await viem.deployContract("DealActivityIndex", [factory.address], { client });
  console.log("dealActivityIndex:", dealActivityIndex.address);
  const dealImplementationRegistry = await viem.deployContract("DealImplementationRegistry", [], { client });
  console.log("dealImplementationRegistry:", dealImplementationRegistry.address);
  const creditGraph = EXISTING.dealCreditGraph
    ? await viem.getContractAt("DealCreditGraph", EXISTING.dealCreditGraph, { client })
    : await viem.deployContract("DealCreditGraph", [EXISTING.dealInfoNFT], { client });
  console.log(EXISTING.dealCreditGraph ? "dealCreditGraph existing:" : "dealCreditGraph:", creditGraph.address);

  await waitFor(publicClient, await factory.write.setGlobal(["dlToken", EXISTING.dlToken]));
  await waitFor(publicClient, await factory.write.setGlobal(["infoNft", EXISTING.dealInfoNFT]));
  await waitFor(publicClient, await factory.write.setGlobal(["wrappedNative", EXISTING.wrappedNative]));
  await waitFor(publicClient, await factory.write.setGlobal(["dealMessageHub", dealMessageHub.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["creditGraph", creditGraph.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["dealActivityIndex", dealActivityIndex.address]));
  await waitFor(
    publicClient,
    await dealImplementationRegistry.write.setDealImplementations([
      dealImpl,
      dealNoAssetImpl.address,
      dealAAssetNftImpl.address,
      dealBAssetNftImpl.address,
      dealAAssetNftOnlyImpl.address,
      dealBAssetNftOnlyImpl.address,
      dealOpenTokenTokenImpl.address,
    ]),
  );
  await waitFor(publicClient, await factory.write.setGlobal(["dealImplementationRegistry", dealImplementationRegistry.address]));
  await waitFor(publicClient, await creditGraph.write.setRecorder([factory.address, true]));
  await waitFor(publicClient, await factory.write.setGlobal(["swapOrderBook", EXISTING.dealSwapOrderBook]));
  await waitFor(publicClient, await factory.write.setRecognizedTokens([EXISTING.ausd, EXISTING.usdt]));
  await waitFor(publicClient, await factory.write.setTreasuryByAdmin([dep]));
  await waitFor(publicClient, await factory.write.mapExistingPair([EXISTING.ausd, EXISTING.pairDlAusd]));
  await waitFor(publicClient, await factory.write.mapExistingPair([EXISTING.usdt, EXISTING.pairDlUsdt]));
  console.log("  factory globals + mapExistingPair OK");

  const dl = await viem.getContractAt("DCToken", EXISTING.dlToken, { client });
  const minterRole = await dl.read.MINTER_ROLE();
  await waitFor(publicClient, await dl.write.grantRole([minterRole, factory.address]));
  console.log("  DL MINTER_ROLE granted");

  const infoNft = await viem.getContractAt("DealInfoNFT", EXISTING.dealInfoNFT, { client });
  await waitFor(publicClient, await infoNft.write.addFactory([factory.address]));
  await waitFor(publicClient, await infoNft.write.setFactory([factory.address]));
  console.log("  DealInfoNFT factory auth updated");

  // 3) DealReader
  console.log("\n--- DealReader ---");
  const reader = await viem.deployContract("DealReader", [], { client });
  console.log("dealReader:", reader.address);

  // 4) DCDomain stack
  console.log("\n--- DCDomain ---");
  const dcDomain = await viem.deployContract("DCDomain", [EXISTING.dlToken, dep], { client });
  console.log("dcDomain:", dcDomain.address);

  console.log("\n--- DCDomainMarket ---");
  const dcMarket = await viem.deployContract(
    "DCDomainMarket",
    [dcDomain.address, EXISTING.dlToken, dep, 100n],
    { client },
  );
  console.log("dcDomainMarket:", dcMarket.address);
  await waitFor(publicClient, await dcDomain.write.setDomainMarket([dcMarket.address]));

  console.log("\n--- DCDomainRank ---");
  const dcRank = await viem.deployContract("DCDomainRank", [EXISTING.dlToken, dcDomain.address, dep], { client });
  console.log("dcDomainRank:", dcRank.address);

  console.log("\n--- DCDomainSwap / Hall ---");
  const dcSwap = await viem.deployContract("DCDomainSwap", [dcDomain.address, dcRank.address, factory.address], {
    client,
  });
  const dcHall = await viem.deployContract("DCDomainHall", [dcRank.address, dcDomain.address, factory.address], {
    client,
  });
  console.log("dcDomainSwap:", dcSwap.address);
  console.log("dcDomainHall:", dcHall.address);

  await waitFor(publicClient, await factory.write.setAllowedCreateFor([dcSwap.address, true]));
  await waitFor(publicClient, await factory.write.setAllowedCreateFor([dcHall.address, true]));
  await waitFor(publicClient, await dcRank.write.setDealReporter([dcSwap.address, true]));
  await waitFor(publicClient, await dcRank.write.setDealReporter([dcHall.address, true]));
  console.log("  setAllowedCreateFor + setDealReporter OK");

  const addresses = {
    dlToken: EXISTING.dlToken,
    ausd: EXISTING.ausd,
    usdt: EXISTING.usdt,
    wrappedNative: EXISTING.wrappedNative,
    dealLib: EXISTING.dealLib,
    dealAssetNftLib,
    dealImplementation: dealImpl,
    dealNoAssetImplementation: dealNoAssetImpl.address,
    dealAAssetNftImplementation: dealAAssetNftImpl.address,
    dealBAssetNftImplementation: dealBAssetNftImpl.address,
    dealAAssetNftOnlyImplementation: dealAAssetNftOnlyImpl.address,
    dealBAssetNftOnlyImplementation: dealBAssetNftOnlyImpl.address,
    dealOpenTokenTokenImplementation: dealOpenTokenTokenImpl.address,
    dealImplementationRegistry: dealImplementationRegistry.address,
    pairImplementation: EXISTING.pairImplementation,
    dealFactory: factory.address,
    dealMessageHub: dealMessageHub.address,
    dealCreditGraph: creditGraph.address,
    dealActivityIndex: dealActivityIndex.address,
    dealInfoNFT: EXISTING.dealInfoNFT,
    pairDlAusd: EXISTING.pairDlAusd,
    pairDlUsdt: EXISTING.pairDlUsdt,
    dealSwapOrderBook: EXISTING.dealSwapOrderBook,
    dealRouter: EXISTING.dealRouter,
    dealReader: reader.address,
    dcDomain: dcDomain.address,
    dcDomainRank: dcRank.address,
    dcDomainMarket: dcMarket.address,
    dcDomainSwap: dcSwap.address,
    dcDomainHall: dcHall.address,
    dToken: EXISTING.dToken,
    dealTimelock: EXISTING.dealTimelock,
    dealGovernor: EXISTING.dealGovernor,
    voteDividendClaimer: EXISTING.voteDividendClaimer,
  };

  console.log("\n========== ADDRESSES ==========\n", JSON.stringify(addresses, null, 2));

  const dir = join(process.cwd(), "deployments");
  mkdirSync(dir, { recursive: true });

  const out = {
    chainId: AGIKING_CHAIN_ID,
    rpcUrl: rpcUrl.trim(),
    deployedAt: new Date().toISOString(),
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
      DealFactory: loadAbi("DealFactory.sol/DealFactory.json"),
      DealMessageHub: loadAbi("DealMessageHub.sol/DealMessageHub.json"),
      DealCreditGraph: loadAbi("DealCreditGraph.sol/DealCreditGraph.json"),
      DealActivityIndex: loadAbi("DealActivityIndex.sol/DealActivityIndex.json"),
      DealReader: loadAbi("DealReader.sol/DealReader.json"),
      DCDomain: loadAbi("DCdomain.sol/DCDomain.json"),
      DCDomainRank: loadAbi("DCdomainrank.sol/DCDomainRank.json"),
      DCDomainMarket: loadAbi("DCDomainMarket.sol/DCDomainMarket.json"),
      DCDomainSwap: loadAbi("DCdomainswap.sol/DCDomainSwap.json"),
      DCDomainHall: loadAbi("DCDomainHall.sol/DCDomainHall.json"),
    },
    notes: [
      "New DCDomain: old domain NFTs stay on old contract; this is a fresh registry.",
      "DealFactory.createDeal requires isDomainDeal=false and domainName empty; domain deals use Swap/Hall.",
    ],
  };

  const file = join(dir, "agiking-31415926.json");
  const prevPath = join(dir, "agiking-31415926.json");
  let prev: { abi?: Record<string, unknown[]> } = {};
  try {
    prev = JSON.parse(readFileSync(prevPath, "utf8")) as { abi?: Record<string, unknown[]> };
  } catch {
    /* fresh */
  }
  const mergedAbi = { ...(prev.abi ?? {}), ...out.abi };
  const finalOut = {
    chainId: AGIKING_CHAIN_ID,
    rpcUrl: rpcUrl.trim(),
    deployedAt: new Date().toISOString(),
    deployer: dep,
    addresses,
    abi: mergedAbi,
    notes: out.notes,
  };
  writeFileSync(file, JSON.stringify(finalOut, null, 2), "utf8");
  console.log("\nWrote", file, "(merged ABI with previous file)");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
