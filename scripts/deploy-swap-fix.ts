/**
 * Redeploy DCDomainSwap (now uses createDealFor instead of createDeal)
 * and grant it isAllowedCreateFor on DealFactory.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain } from "viem";
import { loadAgikingDeploymentAddresses } from "./load-agiking-deployment.js";

const AGIKING_CHAIN_ID = 31415926;

const a = loadAgikingDeploymentAddresses();
const EXISTING = { dcDomain: a.dcDomain, dcDomainRank: a.dcDomainRank, dealFactory: a.dealFactory };

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

  // Deploy new DCDomainSwap
  console.log("\n--- Deploying DCDomainSwap (uses createDealFor) ---");
  const dcSwap = await viem.deployContract(
    "DCDomainSwap",
    [EXISTING.dcDomain, EXISTING.dcDomainRank, EXISTING.dealFactory],
    { client },
  );
  console.log("DCDomainSwap:", dcSwap.address);

  // Grant DCDomainSwap createDealFor permission
  const factory = await viem.getContractAt("DealFactory", EXISTING.dealFactory, { client });
  await waitFor(publicClient, await factory.write.setAllowedCreateFor([dcSwap.address, true]));
  console.log("  DealFactory.setAllowedCreateFor(DCDomainSwap) OK");

  // Update DCDomainRank deal reporter
  const dcRank = await viem.getContractAt("DCDomainRank", EXISTING.dcDomainRank, { client });
  await waitFor(publicClient, await dcRank.write.setDealReporter([dcSwap.address, true]));
  console.log("  DCDomainRank.setDealReporter(DCDomainSwap) OK");

  console.log("\n========== UPDATED ==========");
  console.log("DCDomainSwap:", dcSwap.address);

  // Save
  const dir = join(process.cwd(), "deployments");
  mkdirSync(dir, { recursive: true });
  const out = {
    chainId: AGIKING_CHAIN_ID,
    rpcUrl: rpcUrl.trim(),
    deployedAt: new Date().toISOString(),
    deployer: dep,
    dcDomainSwap: dcSwap.address,
    abi: { DCDomainSwap: loadAbi("DCdomainswap.sol/DCDomainSwap.json") },
  };
  const file = join(dir, `agiking-swap-fix-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
  console.log("Wrote", file);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
