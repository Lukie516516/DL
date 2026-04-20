/**
 * Generate the final combined deployment JSON with ALL latest addresses and ALL ABIs.
 * Addresses are taken from `deployments/agiking-31415926.json`; ABIs are refreshed from `artifacts`.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function loadAbi(relativeArtifactJson: string): unknown[] {
  const p = join(process.cwd(), "artifacts", "contracts", relativeArtifactJson);
  return (JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[] }).abi;
}

const DEPLOYMENT_FILE = "agiking-31415926.json";
const depPath = join(process.cwd(), "deployments", DEPLOYMENT_FILE);
const existingMeta = JSON.parse(readFileSync(depPath, "utf8")) as {
  chainId: number;
  rpcUrl: string;
  deployer: string;
  addresses: Record<string, string>;
};
const allAddresses = existingMeta.addresses;

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
  chainId: existingMeta.chainId,
  rpcUrl: existingMeta.rpcUrl,
  deployedAt: new Date().toISOString(),
  deployer: existingMeta.deployer,
  addresses: allAddresses,
  abi: allAbi,
  notes: [
    "Addresses are copied from the existing deployment file; ABIs are regenerated from local artifacts.",
  ],
};

const dir = join(process.cwd(), "deployments");
mkdirSync(dir, { recursive: true });
const file = join(dir, DEPLOYMENT_FILE);
writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
console.log("Wrote final combined deployment:", file);
console.log("\nAddresses:\n", JSON.stringify(allAddresses, null, 2));
