/**
 * Deploy new Deal implementation (added openJoinFor) and update DealFactory pointer.
 * DealLib is unchanged, reuse existing address.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, type Address } from "viem";
import { loadAgikingDeploymentAddresses } from "./load-agiking-deployment.js";

const AGIKING_CHAIN_ID = 31415926;

const a = loadAgikingDeploymentAddresses();
const EXISTING = { dealLib: a.dealLib, dealFactory: a.dealFactory };

function agikingChain(rpcUrl: string) {
  return defineChain({
    id: AGIKING_CHAIN_ID,
    name: "Agiking",
    nativeCurrency: { decimals: 18, name: "Native", symbol: "NATIVE" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
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
  const dep = deployer.account.address;

  console.log("Chain", chain.id, "deployer", dep);

  // ═══════════════ 1. Deploy DealAssetNftLib + Deal implementation (reuse existing DealLib) ═══════════════
  console.log("\n--- Deploying DealAssetNftLib ---");
  const dealAssetNftLib = await viem.deployContract("DealAssetNftLib", [], {
    client: { public: publicClient, wallet: deployer },
  });
  console.log("DealAssetNftLib:", dealAssetNftLib.address);

  console.log("\n--- Deploying Deal implementation (with openJoinFor) ---");
  const dealImpl = await viem.deployContract("Deal", [], {
    client: { public: publicClient, wallet: deployer },
    libraries: {
      DealLib: EXISTING.dealLib,
      DealAssetNftLib: dealAssetNftLib.address,
    },
  });
  const newDealImpl = dealImpl.address;
  console.log("New Deal implementation:", newDealImpl);

  // ═══════════════ 2. Update DealFactory's dealImplementation ═══════════════
  console.log("\n--- Updating DealFactory.dealImplementation ---");
  const factory = await viem.getContractAt("DealFactory", EXISTING.dealFactory, {
    client: { public: publicClient, wallet: deployer },
  });
  await waitFor(publicClient, await factory.write.setDealImplementation([newDealImpl]));
  console.log("DealFactory.setDealImplementation OK");

  // ═══════════════ Summary ═══════════════
  console.log("\n========== RESULT ==========");
  console.log("New Deal implementation:", newDealImpl);
  console.log("DealFactory (unchanged):", EXISTING.dealFactory);
  console.log("DealLib (unchanged):", EXISTING.dealLib);
  console.log("DealAssetNftLib (new):", dealAssetNftLib.address);

  const dir = join(process.cwd(), "deployments");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "deal-impl-update.json");
  writeFileSync(file, JSON.stringify({
    chainId: AGIKING_CHAIN_ID,
    deployedAt: new Date().toISOString(),
    newDealImplementation: newDealImpl,
    dealFactory: EXISTING.dealFactory,
    dealLib: EXISTING.dealLib,
    dealAssetNftLib: dealAssetNftLib.address,
  }, null, 2), "utf8");
  console.log("Wrote", file);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
