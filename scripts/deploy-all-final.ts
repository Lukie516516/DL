/**
 * FINAL: Redeploy DealFactory (with mapExistingPair), DCDomainSwap, DCDomainHall.
 * Configure everything including pair mappings.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, type Address } from "viem";

const AGIKING_CHAIN_ID = 31415926;

const E = {
  dlToken: "0x39f27267184d3ff8522d5ed209fbf32fc7cbf3bb" as Address,
  ausd: "0xe2ba57ad85b33a3e2e09b69175974e7315264179" as Address,
  usdt: "0xedc6e1ebc966f19a32ac58b09fe667ba59ec149a" as Address,
  wrappedNative: "0x298d8871bfa6129a74d1ab324f4728794848c5b3" as Address,
  dealLib: "0x38edeb51ef5a502a1c1c6829059edcbdccf3f928" as Address,
  dealImpl: "0xd094a855a3571c8f4566e59fca1387a5b6b86d90" as Address,
  pairImpl: "0x6613540b2451ced2dd8a7a48db89ca2c8414b163" as Address,
  dealInfoNFT: "0x00fcc7f1a406ebfe6e5a1077821cc53c6752c789" as Address,
  pairDlAusd: "0xc48b652C9c240FB18aFCf4ADac67471f28fb70e5" as Address,
  pairDlUsdt: "0x8ca50e47b9a142bE5665E35d4697f475eC93C765" as Address,
  orderBook: "0xb43ad4748459d82cf59efb56aca96fdf1d2d82f3" as Address,
  dealRouter: "0x1e957fa8e7cf3e927398f4305b06e7c000101aea" as Address,
  dealReader: "0x970a096690d9bbf6bb199da683b93ec334057297" as Address,
  dcDomain: "0xb68b18ef2df7b39d315bf67e6df1d9343f2fec7a" as Address,
  dcDomainRank: "0x970303bcf10d9d864b93bc8c5b3e1f134bce0538" as Address,
  dcDomainMarket: "0x8f179db52943246e45f2492f955b3ba8026b6e70" as Address,
  dToken: "0x7a4a195bac5ff77af01fc1ce13f1fc5a1770b429" as Address,
  dealTimelock: "0xaad9988a5f6fcb3cf3f0ab8f9730592eb3826468" as Address,
  dealGovernor: "0xc51da2df1f71ad40b5d9560b85ca89a3454e436c" as Address,
  voteClaimer: "0x9c348e5955f2e9634645a26e2e4eb9f770f7d4ca" as Address,
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

  // Configure globals
  await w(pc, await factory.write.setGlobal(["dlToken", E.dlToken]));
  await w(pc, await factory.write.setGlobal(["infoNft", E.dealInfoNFT]));
  await w(pc, await factory.write.setGlobal(["wrappedNative", E.wrappedNative]));
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
    dealImplementation: E.dealImpl,
    pairImplementation: E.pairImpl,
    dealFactory: factory.address,
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
    dealTimelock: E.dealTimelock,
    dealGovernor: E.dealGovernor,
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
      Deal: loadAbi("Deal.sol/Deal.json"),
      DealFactory: loadAbi("DealFactory.sol/DealFactory.json"),
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
      DealTimelock: loadAbi("TestDealTimeLock.sol/DealTimelock.json"),
      DealGovernor: loadAbi("DealDao.sol/DealGovernor.json"),
      VoteDividendClaimer: loadAbi("VoteDividendClaimer.sol/VoteDividendClaimer.json"),
    },
  };
  const file = join(dir, "agiking-31415926.json");
  writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
  console.log("\nWrote", file);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
