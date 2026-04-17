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
import { defineChain, type Address, type Hex } from "viem";

const AGIKING_CHAIN_ID = 31415926;

const EXISTING = {
  dlToken: "0x39f27267184d3ff8522d5ed209fbf32fc7cbf3bb" as Address,
  ausd: "0xe2ba57ad85b33a3e2e09b69175974e7315264179" as Address,
  usdt: "0xedc6e1ebc966f19a32ac58b09fe667ba59ec149a" as Address,
  wrappedNative: "0x298d8871bfa6129a74d1ab324f4728794848c5b3" as Address,
  dealLib: "0x38edeb51ef5a502a1c1c6829059edcbdccf3f928" as Address,
  pairImplementation: "0x6613540b2451ced2dd8a7a48db89ca2c8414b163" as Address,
  dealInfoNFT: "0x00fcc7f1a406ebfe6e5a1077821cc53c6752c789" as Address,
  pairDlAusd: "0xc48b652C9c240FB18aFCf4ADac67471f28fb70e5" as Address,
  pairDlUsdt: "0x8ca50e47b9a142bE5665E35d4697f475eC93C765" as Address,
  dealSwapOrderBook: "0xb43ad4748459d82cf59efb56aca96fdf1d2d82f3" as Address,
  dealRouter: "0x1e957fa8e7cf3e927398f4305b06e7c000101aea" as Address,
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

  // 1) Deal implementation (linked)
  console.log("\n--- Deal implementation (DealLib link) ---");
  const dealArtifact = JSON.parse(
    readFileSync(join(process.cwd(), "artifacts/contracts/Deal.sol/Deal.json"), "utf8"),
  ) as { bytecode: string };
  const libHex = EXISTING.dealLib.slice(2).toLowerCase().padStart(40, "0");
  const linked = dealArtifact.bytecode.replace(/__\$[a-f0-9]{34}\$__/g, libHex) as Hex;
  if (linked.includes("__$")) throw new Error("Deal bytecode still has library placeholder");
  const dealDeployHash = await deployer.sendTransaction({ data: linked, chain });
  const dealReceipt = await publicClient.waitForTransactionReceipt({ hash: dealDeployHash });
  const dealImpl = dealReceipt.contractAddress as Address;
  console.log("dealImplementation:", dealImpl);

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

  await waitFor(publicClient, await factory.write.setGlobal(["dlToken", EXISTING.dlToken]));
  await waitFor(publicClient, await factory.write.setGlobal(["infoNft", EXISTING.dealInfoNFT]));
  await waitFor(publicClient, await factory.write.setGlobal(["wrappedNative", EXISTING.wrappedNative]));
  await waitFor(publicClient, await factory.write.setGlobal(["dealMessageHub", dealMessageHub.address]));
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
  const dcDomain = await viem.deployContract("DCDomain", [EXISTING.ausd, dep], { client });
  console.log("dcDomain:", dcDomain.address);

  console.log("\n--- DCDomainMarket ---");
  const dcMarket = await viem.deployContract(
    "DCDomainMarket",
    [dcDomain.address, EXISTING.ausd, dep, 100n],
    { client },
  );
  console.log("dcDomainMarket:", dcMarket.address);
  await waitFor(publicClient, await dcDomain.write.setDomainMarket([dcMarket.address]));

  console.log("\n--- DCDomainRank ---");
  const dcRank = await viem.deployContract("DCDomainRank", [EXISTING.ausd, dcDomain.address, dep], { client });
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
    dealImplementation: dealImpl,
    pairImplementation: EXISTING.pairImplementation,
    dealFactory: factory.address,
    dealMessageHub: dealMessageHub.address,
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
      Deal: loadAbi("Deal.sol/Deal.json"),
      DealFactory: loadAbi("DealFactory.sol/DealFactory.json"),
      DealMessageHub: loadAbi("DealMessageHub.sol/DealMessageHub.json"),
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
