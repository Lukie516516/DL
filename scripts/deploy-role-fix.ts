/**
 * Redeploy DCDomainRank (isMerchant fix: exclude visitors & blacklisted),
 * DCDomainSwap & DCDomainHall (redundant checks removed, new Rank address).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain } from "viem";
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

  // ═══════════════ 1. Deploy new DCDomainRank ═══════════════
  console.log("\n--- Deploying DCDomainRank (isMerchant fix) ---");
  const dcRank = await viem.deployContract(
    "DCDomainRank",
    [EXISTING.dlToken, EXISTING.dcDomain, dep],
    { client },
  );
  console.log("DCDomainRank:", dcRank.address);

  // ═══════════════ 2. Deploy new DCDomainSwap ═══════════════
  console.log("\n--- Deploying DCDomainSwap (redundant checks removed) ---");
  const dcSwap = await viem.deployContract(
    "DCDomainSwap",
    [EXISTING.dcDomain, dcRank.address, EXISTING.dealFactory],
    { client },
  );
  console.log("DCDomainSwap:", dcSwap.address);

  // ═══════════════ 3. Deploy new DCDomainHall ═══════════════
  console.log("\n--- Deploying DCDomainHall (redundant checks removed) ---");
  const dcHall = await viem.deployContract(
    "DCDomainHall",
    [dcRank.address, EXISTING.dcDomain, EXISTING.dealFactory],
    { client },
  );
  console.log("DCDomainHall:", dcHall.address);

  // ═══════════════ 4. Post-deployment config ═══════════════
  console.log("\n--- Post-deployment config ---");

  // DCDomainRank: setDealReporter for new Swap & Hall
  await waitFor(publicClient, await dcRank.write.setDealReporter([dcSwap.address, true]));
  console.log("  DCDomainRank.setDealReporter(DCDomainSwap) OK");
  await waitFor(publicClient, await dcRank.write.setDealReporter([dcHall.address, true]));
  console.log("  DCDomainRank.setDealReporter(DCDomainHall) OK");

  // DealFactory: setAllowedCreateFor for new Swap & Hall
  const factory = await viem.getContractAt("DealFactory", EXISTING.dealFactory, { client });
  await waitFor(publicClient, await factory.write.setAllowedCreateFor([dcSwap.address, true]));
  console.log("  DealFactory.setAllowedCreateFor(DCDomainSwap) OK");
  await waitFor(publicClient, await factory.write.setAllowedCreateFor([dcHall.address, true]));
  console.log("  DealFactory.setAllowedCreateFor(DCDomainHall) OK");

  // ═══════════════ Summary ═══════════════
  const allAddresses = {
    dlToken: EXISTING.dlToken,
    ausd: EXISTING.ausd,
    usdt: EXISTING.usdt,
    wrappedNative: EXISTING.wrappedNative,
    dealLib: EXISTING.dealLib,
    dealImplementation: EXISTING.dealImplementation,
    pairImplementation: EXISTING.pairImplementation,
    dealFactory: EXISTING.dealFactory,
    dealMessageHub: EXISTING.dealMessageHub ?? "UNSET_DEAL_MESSAGE_HUB",
    dealInfoNFT: EXISTING.dealInfoNFT,
    pairDlAusd: EXISTING.pairDlAusd,
    pairDlUsdt: EXISTING.pairDlUsdt,
    dealSwapOrderBook: EXISTING.dealSwapOrderBook,
    dealRouter: EXISTING.dealRouter,
    dealReader: EXISTING.dealReader,
    dcDomain: EXISTING.dcDomain,
    dcDomainRank: dcRank.address,
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
  const file = join(dir, `agiking-role-fix-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
  console.log("\nWrote", file);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
