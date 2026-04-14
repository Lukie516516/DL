/**
 * Redeploy the 4 domain-related contracts that were modified:
 *   DCDomainRank, DCDomainMarket, DCDomainSwap, DCDomainHall
 * Then reconfigure references (setDomainMarket, setDealReporter).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, type Address } from "viem";

const AGIKING_CHAIN_ID = 31415926;

const EXISTING = {
  dlToken: "0x39f27267184d3ff8522d5ed209fbf32fc7cbf3bb" as Address,
  ausd: "0xe2ba57ad85b33a3e2e09b69175974e7315264179" as Address,
  usdt: "0xedc6e1ebc966f19a32ac58b09fe667ba59ec149a" as Address,
  wrappedNative: "0x298d8871bfa6129a74d1ab324f4728794848c5b3" as Address,
  dealLib: "0x38edeb51ef5a502a1c1c6829059edcbdccf3f928" as Address,
  dealImplementation: "0xd094a855a3571c8f4566e59fca1387a5b6b86d90" as Address,
  pairImplementation: "0x6613540b2451ced2dd8a7a48db89ca2c8414b163" as Address,
  dealFactory: "0x907f84e4127049bb65c82f50ce29c1ff67f344d5" as Address,
  oldDealFactory: "0xf2d1a17ff3bfb32907414adce00bf2777b92ce03" as Address,
  dealInfoNFT: "0x00fcc7f1a406ebfe6e5a1077821cc53c6752c789" as Address,
  pairDlAusd: "0xc48b652C9c240FB18aFCf4ADac67471f28fb70e5" as Address,
  pairDlUsdt: "0x8ca50e47b9a142bE5665E35d4697f475eC93C765" as Address,
  dealSwapOrderBook: "0xb43ad4748459d82cf59efb56aca96fdf1d2d82f3" as Address,
  dealRouter: "0x1e957fa8e7cf3e927398f4305b06e7c000101aea" as Address,
  dealReader: "0x970a096690d9bbf6bb199da683b93ec334057297" as Address,
  dcDomain: "0xb68b18ef2df7b39d315bf67e6df1d9343f2fec7a" as Address,
  dToken: "0x7a4a195bac5ff77af01fc1ce13f1fc5a1770b429" as Address,
  dealTimelock: "0xaad9988a5f6fcb3cf3f0ab8f9730592eb3826468" as Address,
  dealGovernor: "0xc51da2df1f71ad40b5d9560b85ca89a3454e436c" as Address,
  voteDividendClaimer: "0x9c348e5955f2e9634645a26e2e4eb9f770f7d4ca" as Address,
};

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

  // ═══════════════ 1. Deploy DCDomainRank ═══════════════
  console.log("\n--- Deploying DCDomainRank ---");
  const dcRank = await viem.deployContract(
    "DCDomainRank",
    [EXISTING.ausd, EXISTING.dcDomain, dep],
    { client },
  );
  console.log("DCDomainRank:", dcRank.address);

  // ═══════════════ 2. Deploy DCDomainMarket ═══════════════
  console.log("\n--- Deploying DCDomainMarket ---");
  const dcMarket = await viem.deployContract(
    "DCDomainMarket",
    [EXISTING.dcDomain, EXISTING.ausd, dep, 100n],
    { client },
  );
  console.log("DCDomainMarket:", dcMarket.address);

  // ═══════════════ 3. Deploy DCDomainSwap ═══════════════
  console.log("\n--- Deploying DCDomainSwap ---");
  const dcSwap = await viem.deployContract(
    "DCDomainSwap",
    [EXISTING.dcDomain, dcRank.address, EXISTING.dealFactory],
    { client },
  );
  console.log("DCDomainSwap:", dcSwap.address);

  // ═══════════════ 4. Deploy DCDomainHall ═══════════════
  console.log("\n--- Deploying DCDomainHall ---");
  const dcHall = await viem.deployContract(
    "DCDomainHall",
    [dcRank.address, EXISTING.dcDomain, EXISTING.dealFactory],
    { client },
  );
  console.log("DCDomainHall:", dcHall.address);

  // ═══════════════ 5. Configure ═══════════════
  console.log("\n--- Configuring ---");

  // DCDomain.setDomainMarket → new market
  const dcDomain = await viem.getContractAt("DCDomain", EXISTING.dcDomain, { client });
  await waitFor(publicClient, await dcDomain.write.setDomainMarket([dcMarket.address]));
  console.log("  DCDomain.setDomainMarket →", dcMarket.address);

  // DCDomainRank.setDealReporter for Swap and Hall
  await waitFor(publicClient, await dcRank.write.setDealReporter([dcSwap.address, true]));
  console.log("  DCDomainRank.setDealReporter(DCDomainSwap) OK");

  await waitFor(publicClient, await dcRank.write.setDealReporter([dcHall.address, true]));
  console.log("  DCDomainRank.setDealReporter(DCDomainHall) OK");

  // ═══════════════ Summary ═══════════════
  const newDomainAddresses = {
    dcDomainRank: dcRank.address,
    dcDomainMarket: dcMarket.address,
    dcDomainSwap: dcSwap.address,
    dcDomainHall: dcHall.address,
  };

  const allAddresses = {
    dlToken: EXISTING.dlToken,
    ausd: EXISTING.ausd,
    usdt: EXISTING.usdt,
    wrappedNative: EXISTING.wrappedNative,
    dealLib: EXISTING.dealLib,
    dealImplementation: EXISTING.dealImplementation,
    pairImplementation: EXISTING.pairImplementation,
    dealFactory: EXISTING.dealFactory,
    dealInfoNFT: EXISTING.dealInfoNFT,
    pairDlAusd: EXISTING.pairDlAusd,
    pairDlUsdt: EXISTING.pairDlUsdt,
    dealSwapOrderBook: EXISTING.dealSwapOrderBook,
    dealRouter: EXISTING.dealRouter,
    dealReader: EXISTING.dealReader,
    dcDomain: EXISTING.dcDomain,
    dcDomainRank: dcRank.address,
    dcDomainMarket: dcMarket.address,
    dcDomainSwap: dcSwap.address,
    dcDomainHall: dcHall.address,
    dToken: EXISTING.dToken,
    dealTimelock: EXISTING.dealTimelock,
    dealGovernor: EXISTING.dealGovernor,
    voteDividendClaimer: EXISTING.voteDividendClaimer,
  };

  console.log("\n========== NEW DOMAIN DEPLOYMENTS ==========");
  console.log(JSON.stringify(newDomainAddresses, null, 2));
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
      DCDomainRank: loadAbi("DCdomainrank.sol/DCDomainRank.json"),
      DCDomainMarket: loadAbi("DCDomainMarket.sol/DCDomainMarket.json"),
      DCDomainSwap: loadAbi("DCdomainswap.sol/DCDomainSwap.json"),
      DCDomainHall: loadAbi("DCDomainHall.sol/DCDomainHall.json"),
    },
  };

  const file = join(dir, `agiking-domain-upgrade-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
  console.log("\nWrote", file);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
