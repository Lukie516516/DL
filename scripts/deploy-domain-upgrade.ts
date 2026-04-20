/**
 * Redeploy domain stack: DCDomainRank, DCDomainMarket, DCDomainSwap, DCDomainHall
 * - Reads existing core addresses from deployments/agiking-31415926.json
 * - setDomainMarket, setDealReporter, DealFactory.setAllowedCreateFor for new Swap/Hall
 * - Merges new addresses + updated ABIs back into agiking-31415926.json
 *
 * Usage (PowerShell):
 *   $env:AGIKING_RPC_URL="https://rpc.agikingrpc.shop"
 *   $env:AGIKING_PRIVATE_KEY="0x..."
 *   npx hardhat run scripts/deploy-domain-upgrade.ts --network agiking
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, getAddress, type Address } from "viem";

const AGIKING_CHAIN_ID = 31415926;
const DEPLOYMENT_FILE = "agiking-31415926.json";

type DeploymentJson = {
  chainId: number;
  rpcUrl: string;
  deployedAt: string;
  deployer: string;
  addresses: Record<string, string>;
  abi: Record<string, unknown[]>;
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

async function waitFor(
  publicClient: { waitForTransactionReceipt: (a: { hash: `0x${string}` }) => Promise<unknown> },
  hash: `0x${string}`,
) {
  return publicClient.waitForTransactionReceipt({ hash });
}

function loadDeployment(): DeploymentJson {
  const path = join(process.cwd(), "deployments", DEPLOYMENT_FILE);
  return JSON.parse(readFileSync(path, "utf8")) as DeploymentJson;
}

async function main() {
  const rpcUrl = process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop";
  const chain = agikingChain(rpcUrl.trim());

  const base = loadDeployment();
  const a = base.addresses;

  const EXISTING = {
    dlToken: getAddress(a.dlToken) as Address,
    dcDomain: getAddress(a.dcDomain) as Address,
    dealFactory: getAddress(a.dealFactory) as Address,
  };

  const { viem } = await network.connect({ network: "agiking", chainType: "l1" });
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer] = await viem.getWalletClients({ chain });
  const client = { public: publicClient, wallet: deployer } as const;
  const dep = deployer.account.address;

  console.log("Chain", chain.id, "deployer", dep);
  console.log("Using from", DEPLOYMENT_FILE, "dlToken", EXISTING.dlToken, "dcDomain", EXISTING.dcDomain);

  console.log("\n--- Deploying DCDomainRank ---");
  const dcRank = await viem.deployContract(
    "DCDomainRank",
    [EXISTING.dlToken, EXISTING.dcDomain, dep],
    { client },
  );
  console.log("DCDomainRank:", dcRank.address);

  console.log("\n--- Deploying DCDomainMarket ---");
  const dcMarket = await viem.deployContract(
    "DCDomainMarket",
    [EXISTING.dcDomain, EXISTING.dlToken, dep, 100n],
    { client },
  );
  console.log("DCDomainMarket:", dcMarket.address);

  console.log("\n--- Deploying DCDomainSwap ---");
  const dcSwap = await viem.deployContract(
    "DCDomainSwap",
    [EXISTING.dcDomain, dcRank.address, EXISTING.dealFactory],
    { client },
  );
  console.log("DCDomainSwap:", dcSwap.address);

  console.log("\n--- Deploying DCDomainHall ---");
  const dcHall = await viem.deployContract(
    "DCDomainHall",
    [dcRank.address, EXISTING.dcDomain, EXISTING.dealFactory],
    { client },
  );
  console.log("DCDomainHall:", dcHall.address);

  console.log("\n--- Configuring ---");
  const dcDomain = await viem.getContractAt("DCDomain", EXISTING.dcDomain, { client });
  await waitFor(publicClient, await dcDomain.write.setDomainMarket([dcMarket.address]));
  console.log("  DCDomain.setDomainMarket →", dcMarket.address);

  await waitFor(publicClient, await dcRank.write.setDealReporter([dcSwap.address, true]));
  console.log("  DCDomainRank.setDealReporter(Swap) OK");
  await waitFor(publicClient, await dcRank.write.setDealReporter([dcHall.address, true]));
  console.log("  DCDomainRank.setDealReporter(Hall) OK");

  const factory = await viem.getContractAt("DealFactory", EXISTING.dealFactory, { client });
  await waitFor(publicClient, await factory.write.setAllowedCreateFor([dcSwap.address, true]));
  console.log("  DealFactory.setAllowedCreateFor(Swap) OK");
  await waitFor(publicClient, await factory.write.setAllowedCreateFor([dcHall.address, true]));
  console.log("  DealFactory.setAllowedCreateFor(Hall) OK");

  const mergedAddresses = {
    ...base.addresses,
    dcDomainRank: getAddress(dcRank.address),
    dcDomainMarket: getAddress(dcMarket.address),
    dcDomainSwap: getAddress(dcSwap.address),
    dcDomainHall: getAddress(dcHall.address),
  };

  const mergedAbi = {
    ...base.abi,
    DCDomainRank: loadAbi("DCdomainrank.sol/DCDomainRank.json"),
    DCDomainMarket: loadAbi("DCDomainMarket.sol/DCDomainMarket.json"),
    DCDomainSwap: loadAbi("DCdomainswap.sol/DCDomainSwap.json"),
    DCDomainHall: loadAbi("DCDomainHall.sol/DCDomainHall.json"),
  };

  const out: DeploymentJson = {
    chainId: AGIKING_CHAIN_ID,
    rpcUrl: rpcUrl.trim(),
    deployedAt: new Date().toISOString(),
    deployer: dep,
    addresses: mergedAddresses,
    abi: mergedAbi,
  };

  const dir = join(process.cwd(), "deployments");
  mkdirSync(dir, { recursive: true });
  const mainFile = join(dir, DEPLOYMENT_FILE);
  writeFileSync(mainFile, JSON.stringify(out, null, 2), "utf8");
  console.log("\nWrote", mainFile);

  const snap = join(dir, `agiking-domain-upgrade-${Date.now()}.json`);
  writeFileSync(snap, JSON.stringify(out, null, 2), "utf8");
  console.log("Wrote snapshot", snap);

  console.log("\n--- Update docs/Domain_Frontend_Call_Guide.md §1 with: ---");
  console.log("- `DL / DC`: `" + mergedAddresses.dlToken + "`");
  console.log("- `DCDomain`: `" + mergedAddresses.dcDomain + "`");
  console.log("- `DCDomainRank`: `" + mergedAddresses.dcDomainRank + "`");
  console.log("- `DCDomainMarket`: `" + mergedAddresses.dcDomainMarket + "`");
  console.log("- `DCDomainSwap`: `" + mergedAddresses.dcDomainSwap + "`");
  console.log("- `DCDomainHall`: `" + mergedAddresses.dcDomainHall + "`");
  console.log("- `DealFactory`: `" + mergedAddresses.dealFactory + "`");
  console.log("- `DealReader`: `" + mergedAddresses.dealReader + "`");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
