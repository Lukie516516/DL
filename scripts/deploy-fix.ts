/**
 * Redeploy DealFactory (added createDealFor + chargeMessageFeeFrom),
 * DCDomainSwap & DCDomainHall (fixed InitParams struct to match DealFactory).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, type Hex } from "viem";
import { loadAgikingDeploymentAddresses } from "./load-agiking-deployment.js";

const AGIKING_CHAIN_ID = 31415926;

const EXISTING = loadAgikingDeploymentAddresses();

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

  // ═══════════════ 1. Deploy new DealFactory ═══════════════
  console.log("\n--- Deploying new DealFactory (with createDealFor + chargeMessageFeeFrom) ---");
  const newFactory = await viem.deployContract(
    "DealFactory",
    [EXISTING.dealImplementation, EXISTING.pairImplementation, 3600],
    { client },
  );
  console.log("DealFactory:", newFactory.address);
  const dealNoAssetImpl = EXISTING.dealNoAssetImplementation
    ? await viem.getContractAt("DealNoAsset", EXISTING.dealNoAssetImplementation, { client })
    : await viem.deployContract("DealNoAsset", [], { client, libraries: { DealLib: EXISTING.dealLib } });
  console.log(EXISTING.dealNoAssetImplementation ? "DealNoAsset existing:" : "DealNoAsset:", dealNoAssetImpl.address);
  const dealAssetNftLib = EXISTING.dealAssetNftLib
    ? EXISTING.dealAssetNftLib
    : (await viem.deployContract("DealAssetNftLib", [], { client })).address;
  if (!EXISTING.dealAssetNftLib) console.log("DealAssetNftLib:", dealAssetNftLib);
  const dealAAssetNftImpl = EXISTING.dealAAssetNftImplementation
    ? await viem.getContractAt("DealAAssetNft", EXISTING.dealAAssetNftImplementation, { client })
    : await viem.deployContract("DealAAssetNft", [], {
        client,
        libraries: { DealLib: EXISTING.dealLib, DealAssetNftLib: dealAssetNftLib },
      });
  console.log(EXISTING.dealAAssetNftImplementation ? "DealAAssetNft existing:" : "DealAAssetNft:", dealAAssetNftImpl.address);
  const dealBAssetNftImpl = EXISTING.dealBAssetNftImplementation
    ? await viem.getContractAt("DealBAssetNft", EXISTING.dealBAssetNftImplementation, { client })
    : await viem.deployContract("DealBAssetNft", [], {
        client,
        libraries: { DealLib: EXISTING.dealLib, DealAssetNftLib: dealAssetNftLib },
  });
  console.log(EXISTING.dealBAssetNftImplementation ? "DealBAssetNft existing:" : "DealBAssetNft:", dealBAssetNftImpl.address);
  const dealAAssetNftOnlyImpl = EXISTING.dealAAssetNftOnlyImplementation
    ? await viem.getContractAt("DealAAssetNftOnly", EXISTING.dealAAssetNftOnlyImplementation, { client })
    : await viem.deployContract("DealAAssetNftOnly", [], {
        client,
        libraries: { DealAssetNftLib: dealAssetNftLib },
      });
  console.log(EXISTING.dealAAssetNftOnlyImplementation ? "DealAAssetNftOnly existing:" : "DealAAssetNftOnly:", dealAAssetNftOnlyImpl.address);
  const dealBAssetNftOnlyImpl = EXISTING.dealBAssetNftOnlyImplementation
    ? await viem.getContractAt("DealBAssetNftOnly", EXISTING.dealBAssetNftOnlyImplementation, { client })
    : await viem.deployContract("DealBAssetNftOnly", [], {
        client,
        libraries: { DealAssetNftLib: dealAssetNftLib },
      });
  console.log(EXISTING.dealBAssetNftOnlyImplementation ? "DealBAssetNftOnly existing:" : "DealBAssetNftOnly:", dealBAssetNftOnlyImpl.address);
  const dealOpenTokenTokenImpl = EXISTING.dealOpenTokenTokenImplementation
    ? await viem.getContractAt("DealOpenTokenToken", EXISTING.dealOpenTokenTokenImplementation, { client })
    : await viem.deployContract("DealOpenTokenToken", [], { client, libraries: { DealLib: EXISTING.dealLib } });
  console.log(
    EXISTING.dealOpenTokenTokenImplementation ? "DealOpenTokenToken existing:" : "DealOpenTokenToken:",
    dealOpenTokenTokenImpl.address,
  );
  const dealMessageHub = await viem.deployContract("DealMessageHub", [newFactory.address], { client });
  console.log("DealMessageHub:", dealMessageHub.address);
  const dealActivityIndex = await viem.deployContract("DealActivityIndex", [newFactory.address], { client });
  console.log("DealActivityIndex:", dealActivityIndex.address);
  const dealImplementationRegistry = await viem.deployContract("DealImplementationRegistry", [], { client });
  console.log("DealImplementationRegistry:", dealImplementationRegistry.address);
  const creditGraph = EXISTING.dealCreditGraph
    ? await viem.getContractAt("DealCreditGraph", EXISTING.dealCreditGraph, { client })
    : await viem.deployContract("DealCreditGraph", [EXISTING.dealInfoNFT], { client });
  console.log(EXISTING.dealCreditGraph ? "DealCreditGraph existing:" : "DealCreditGraph:", creditGraph.address);

  // Configure DealFactory
  console.log("\n--- Configuring DealFactory ---");
  await waitFor(publicClient, await newFactory.write.setGlobal(["dlToken", EXISTING.dlToken]));
  console.log("  setGlobal dlToken OK");
  await waitFor(publicClient, await newFactory.write.setGlobal(["infoNft", EXISTING.dealInfoNFT]));
  console.log("  setGlobal infoNft OK");
  await waitFor(publicClient, await newFactory.write.setGlobal(["wrappedNative", EXISTING.wrappedNative]));
  console.log("  setGlobal wrappedNative OK");
  await waitFor(publicClient, await newFactory.write.setGlobal(["dealMessageHub", dealMessageHub.address]));
  console.log("  setGlobal dealMessageHub OK");
  await waitFor(publicClient, await newFactory.write.setGlobal(["creditGraph", creditGraph.address]));
  console.log("  setGlobal creditGraph OK");
  await waitFor(publicClient, await newFactory.write.setGlobal(["dealActivityIndex", dealActivityIndex.address]));
  console.log("  setGlobal dealActivityIndex OK");
  await waitFor(
    publicClient,
    await dealImplementationRegistry.write.setDealImplementations([
      EXISTING.dealImplementation,
      dealNoAssetImpl.address,
      dealAAssetNftImpl.address,
      dealBAssetNftImpl.address,
      dealAAssetNftOnlyImpl.address,
      dealBAssetNftOnlyImpl.address,
      dealOpenTokenTokenImpl.address,
    ]),
  );
  console.log("  DealImplementationRegistry.setDealImplementations OK");
  await waitFor(publicClient, await newFactory.write.setGlobal(["dealImplementationRegistry", dealImplementationRegistry.address]));
  console.log("  setGlobal dealImplementationRegistry OK");
  await waitFor(publicClient, await creditGraph.write.setRecorder([newFactory.address, true]));
  console.log("  DealCreditGraph recorder OK");
  await waitFor(publicClient, await newFactory.write.setGlobal(["swapOrderBook", EXISTING.dealSwapOrderBook]));
  console.log("  setGlobal swapOrderBook OK");
  await waitFor(publicClient, await newFactory.write.setRecognizedTokens([EXISTING.ausd, EXISTING.usdt]));
  console.log("  setRecognizedTokens OK");
  await waitFor(publicClient, await newFactory.write.mapExistingPair([EXISTING.ausd, EXISTING.pairDlAusd]));
  console.log("  mapExistingPair AUSD OK");
  await waitFor(publicClient, await newFactory.write.mapExistingPair([EXISTING.usdt, EXISTING.pairDlUsdt]));
  console.log("  mapExistingPair USDT OK");
  await waitFor(publicClient, await newFactory.write.setTreasuryByAdmin([dep]));
  console.log("  setTreasuryByAdmin OK");

  const infoNft = await viem.getContractAt("DealInfoNFT", EXISTING.dealInfoNFT, { client });
  await waitFor(publicClient, await infoNft.write.addFactory([newFactory.address]));
  console.log("  DealInfoNFT.addFactory(newFactory) OK");
  await waitFor(publicClient, await infoNft.write.setFactory([newFactory.address]));
  console.log("  DealInfoNFT.setFactory(newFactory) OK");

  // Grant DealCoin/DC MINTER_ROLE to new factory
  const dlContract = await viem.getContractAt("DCToken", EXISTING.dlToken, { client });
  const minterRole = await dlContract.read.MINTER_ROLE();
  await waitFor(publicClient, await dlContract.write.grantRole([minterRole, newFactory.address]));
  console.log("  DealCoin/DC MINTER_ROLE granted");

  // ═══════════════ 2. Deploy DCDomainSwap (fixed struct) ═══════════════
  console.log("\n--- Deploying DCDomainSwap (fixed InitParams) ---");
  const dcSwap = await viem.deployContract(
    "DCDomainSwap",
    [EXISTING.dcDomain, EXISTING.dcDomainRank, newFactory.address],
    { client },
  );
  console.log("DCDomainSwap:", dcSwap.address);

  // ═══════════════ 3. Deploy DCDomainHall (fixed struct) ═══════════════
  console.log("\n--- Deploying DCDomainHall (fixed InitParams) ---");
  const dcHall = await viem.deployContract(
    "DCDomainHall",
    [EXISTING.dcDomainRank, EXISTING.dcDomain, newFactory.address],
    { client },
  );
  console.log("DCDomainHall:", dcHall.address);

  // ═══════════════ 4. Post-deployment config ═══════════════
  console.log("\n--- Post-deployment config ---");

  // Allow domain entry contracts to call createDealFor / chargeMessageFeeFrom
  await waitFor(publicClient, await newFactory.write.setAllowedCreateFor([dcSwap.address, true]));
  console.log("  DealFactory.setAllowedCreateFor(DCDomainSwap) OK");
  await waitFor(publicClient, await newFactory.write.setAllowedCreateFor([dcHall.address, true]));
  console.log("  DealFactory.setAllowedCreateFor(DCDomainHall) OK");

  // Update DCDomainRank deal reporters
  const dcRank = await viem.getContractAt("DCDomainRank", EXISTING.dcDomainRank, { client });
  await waitFor(publicClient, await dcRank.write.setDealReporter([dcSwap.address, true]));
  console.log("  DCDomainRank.setDealReporter(DCDomainSwap) OK");
  await waitFor(publicClient, await dcRank.write.setDealReporter([dcHall.address, true]));
  console.log("  DCDomainRank.setDealReporter(DCDomainHall) OK");

  // ═══════════════ Summary ═══════════════
  const allAddresses = {
    dlToken: EXISTING.dlToken,
    ausd: EXISTING.ausd,
    usdt: EXISTING.usdt,
    wrappedNative: EXISTING.wrappedNative,
    dealLib: EXISTING.dealLib,
    dealAssetNftLib,
    dealImplementation: EXISTING.dealImplementation,
    dealNoAssetImplementation: dealNoAssetImpl.address,
    dealAAssetNftImplementation: dealAAssetNftImpl.address,
    dealBAssetNftImplementation: dealBAssetNftImpl.address,
    dealAAssetNftOnlyImplementation: dealAAssetNftOnlyImpl.address,
    dealBAssetNftOnlyImplementation: dealBAssetNftOnlyImpl.address,
    dealOpenTokenTokenImplementation: dealOpenTokenTokenImpl.address,
    dealImplementationRegistry: dealImplementationRegistry.address,
    pairImplementation: EXISTING.pairImplementation,
    dealFactory: newFactory.address,
    dealMessageHub: dealMessageHub.address,
    dealCreditGraph: creditGraph.address,
    dealActivityIndex: dealActivityIndex.address,
    dealInfoNFT: EXISTING.dealInfoNFT,
    pairDlAusd: EXISTING.pairDlAusd,
    pairDlUsdt: EXISTING.pairDlUsdt,
    dealSwapOrderBook: EXISTING.dealSwapOrderBook,
    dealRouter: EXISTING.dealRouter,
    dealReader: EXISTING.dealReader,
    dcDomain: EXISTING.dcDomain,
    dcDomainRank: EXISTING.dcDomainRank,
    dcDomainMarket: EXISTING.dcDomainMarket,
    dcDomainSwap: dcSwap.address,
    dcDomainHall: dcHall.address,
    dToken: EXISTING.dToken,
    dealTimelock: EXISTING.dealTimelock,
    dealGovernor: EXISTING.dealGovernor,
    voteDividendClaimer: EXISTING.voteDividendClaimer,
  };

  console.log("\n========== ALL ADDRESSES (FINAL) ==========");
  console.log(JSON.stringify(allAddresses, null, 2));

  // Save
  const dir = join(process.cwd(), "deployments");
  mkdirSync(dir, { recursive: true });
  const out = {
    chainId: AGIKING_CHAIN_ID,
    rpcUrl: rpcUrl.trim(),
    deployedAt: new Date().toISOString(),
    deployer: dep,
    addresses: allAddresses,
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
      DCDomainRank: loadAbi("DCdomainrank.sol/DCDomainRank.json"),
      DCDomainMarket: loadAbi("DCDomainMarket.sol/DCDomainMarket.json"),
      DCDomainSwap: loadAbi("DCdomainswap.sol/DCDomainSwap.json"),
      DCDomainHall: loadAbi("DCDomainHall.sol/DCDomainHall.json"),
    },
  };
  const file = join(dir, `agiking-final-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
  console.log("\nWrote", file);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
