/**
 * Generate the final combined deployment JSON with ALL latest addresses and ALL ABIs.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function loadAbi(relativeArtifactJson: string): unknown[] {
  const p = join(process.cwd(), "artifacts", "contracts", relativeArtifactJson);
  return (JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[] }).abi;
}

const allAddresses = {
  dlToken: "0x39f27267184d3ff8522d5ed209fbf32fc7cbf3bb",
  ausd: "0xe2ba57ad85b33a3e2e09b69175974e7315264179",
  usdt: "0xedc6e1ebc966f19a32ac58b09fe667ba59ec149a",
  wrappedNative: "0x298d8871bfa6129a74d1ab324f4728794848c5b3",
  dealLib: "0x38edeb51ef5a502a1c1c6829059edcbdccf3f928",
  dealImplementation: "0xd094a855a3571c8f4566e59fca1387a5b6b86d90",
  pairImplementation: "0x6613540b2451ced2dd8a7a48db89ca2c8414b163",
  dealFactory: "0xb59b21bab4ad5a011d6976e0a4ed66721fcd5985",
  dealMessageHub: "0x0000000000000000000000000000000000000000",
  dealInfoNFT: "0x00fcc7f1a406ebfe6e5a1077821cc53c6752c789",
  pairDlAusd: "0xc48b652C9c240FB18aFCf4ADac67471f28fb70e5",
  pairDlUsdt: "0x8ca50e47b9a142bE5665E35d4697f475eC93C765",
  dealSwapOrderBook: "0xb43ad4748459d82cf59efb56aca96fdf1d2d82f3",
  dealRouter: "0x1e957fa8e7cf3e927398f4305b06e7c000101aea",
  dealReader: "0x970a096690d9bbf6bb199da683b93ec334057297",
  dcDomain: "0xb68b18ef2df7b39d315bf67e6df1d9343f2fec7a",
  dcDomainRank: "0x970303bcf10d9d864b93bc8c5b3e1f134bce0538",
  dcDomainMarket: "0x8f179db52943246e45f2492f955b3ba8026b6e70",
  dcDomainSwap: "0xc2ba20a1b73b9a1ac788dd248cda86a08ab95d1c",
  dcDomainHall: "0x9f49371fe0628fe2d5244926a89aa5b5dd515f86",
  dToken: "0x7a4a195bac5ff77af01fc1ce13f1fc5a1770b429",
  dealTimelock: "0xaad9988a5f6fcb3cf3f0ab8f9730592eb3826468",
  dealGovernor: "0xc51da2df1f71ad40b5d9560b85ca89a3454e436c",
  voteDividendClaimer: "0x9c348e5955f2e9634645a26e2e4eb9f770f7d4ca",
};

const allAbi = {
  DealLib: loadAbi("utils/DealLib.sol/DealLib.json"),
  Deal: loadAbi("Deal.sol/Deal.json"),
  DealFactory: loadAbi("DealFactory.sol/DealFactory.json"),
  DealMessageHub: loadAbi("DealMessageHub.sol/DealMessageHub.json"),
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
};

const out = {
  chainId: 31415926,
  rpcUrl: "https://rpc.agikingrpc.shop",
  deployedAt: new Date().toISOString(),
  deployer: "0x6807ed8c44ae2a89ddb7706fa22a5b274ecd8785",
  addresses: allAddresses,
  abi: allAbi,
  notes: [
    "Replace addresses.dealMessageHub with the real deployed DealMessageHub before publishing this JSON.",
  ],
};

const dir = join(process.cwd(), "deployments");
mkdirSync(dir, { recursive: true });
const file = join(dir, "agiking-31415926.json");
writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
console.log("Wrote final combined deployment:", file);
console.log("\nAddresses:\n", JSON.stringify(allAddresses, null, 2));
