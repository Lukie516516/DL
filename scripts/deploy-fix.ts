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
  const dealMessageHub = await viem.deployContract("DealMessageHub", [newFactory.address], { client });
  console.log("DealMessageHub:", dealMessageHub.address);

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
  await waitFor(publicClient, await newFactory.write.setGlobal(["swapOrderBook", EXISTING.dealSwapOrderBook]));
  console.log("  setGlobal swapOrderBook OK");
  await waitFor(publicClient, await newFactory.write.setRecognizedTokens([EXISTING.ausd, EXISTING.usdt]));
  console.log("  setRecognizedTokens OK");
  await waitFor(publicClient, await newFactory.write.setTreasuryByAdmin([dep]));
  console.log("  setTreasuryByAdmin OK");

  // Grant DL MINTER_ROLE to new factory
  const dlContract = await viem.getContractAt("DCToken", EXISTING.dlToken, { client });
  const minterRole = await dlContract.read.MINTER_ROLE();
  await waitFor(publicClient, await dlContract.write.grantRole([minterRole, newFactory.address]));
  console.log("  DL MINTER_ROLE granted");

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

  // Allow DCDomainHall to call createDealFor / chargeMessageFeeFrom
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
    dealImplementation: EXISTING.dealImplementation,
    pairImplementation: EXISTING.pairImplementation,
    dealFactory: newFactory.address,
    dealMessageHub: dealMessageHub.address,
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
      Deal: loadAbi("Deal.sol/Deal.json"),
      DealFactory: loadAbi("DealFactory.sol/DealFactory.json"),
      DealMessageHub: loadAbi("DealMessageHub.sol/DealMessageHub.json"),
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
