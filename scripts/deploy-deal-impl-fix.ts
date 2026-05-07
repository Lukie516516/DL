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
  });
  const newDealImpl = dealImpl.address;
  console.log("New Deal implementation:", newDealImpl);
  const dealNoAssetImpl = await viem.deployContract("DealNoAsset", [], {
    client: { public: publicClient, wallet: deployer },
    libraries: { DealLib: EXISTING.dealLib },
  });
  console.log("New DealNoAsset implementation:", dealNoAssetImpl.address);
  const dealAAssetNftImpl = await viem.deployContract("DealAAssetNft", [], {
    client: { public: publicClient, wallet: deployer },
    libraries: {
      DealLib: EXISTING.dealLib,
      DealAssetNftLib: dealAssetNftLib.address,
    },
  });
  console.log("New DealAAssetNft implementation:", dealAAssetNftImpl.address);
  const dealBAssetNftImpl = await viem.deployContract("DealBAssetNft", [], {
    client: { public: publicClient, wallet: deployer },
    libraries: {
      DealLib: EXISTING.dealLib,
      DealAssetNftLib: dealAssetNftLib.address,
    },
  });
  console.log("New DealBAssetNft implementation:", dealBAssetNftImpl.address);
  const dealAAssetNftOnlyImpl = await viem.deployContract("DealAAssetNftOnly", [], {
    client: { public: publicClient, wallet: deployer },
    libraries: { DealAssetNftLib: dealAssetNftLib.address },
  });
  console.log("New DealAAssetNftOnly implementation:", dealAAssetNftOnlyImpl.address);
  const dealBAssetNftOnlyImpl = await viem.deployContract("DealBAssetNftOnly", [], {
    client: { public: publicClient, wallet: deployer },
    libraries: { DealAssetNftLib: dealAssetNftLib.address },
  });
  console.log("New DealBAssetNftOnly implementation:", dealBAssetNftOnlyImpl.address);
  const dealOpenTokenTokenImpl = await viem.deployContract("DealOpenTokenToken", [], {
    client: { public: publicClient, wallet: deployer },
    libraries: { DealLib: EXISTING.dealLib },
  });
  console.log("New DealOpenTokenToken implementation:", dealOpenTokenTokenImpl.address);

  // ═══════════════ 2. Update DealFactory's dealImplementation ═══════════════
  console.log("\n--- Updating DealFactory.dealImplementation ---");
  const factory = await viem.getContractAt("DealFactory", EXISTING.dealFactory, {
    client: { public: publicClient, wallet: deployer },
  });
  const dealActivityIndex = await viem.deployContract("DealActivityIndex", [EXISTING.dealFactory], {
    client: { public: publicClient, wallet: deployer },
  });
  console.log("New DealActivityIndex:", dealActivityIndex.address);
  const dealImplementationRegistry = await viem.deployContract("DealImplementationRegistry", [], {
    client: { public: publicClient, wallet: deployer },
  });
  console.log("New DealImplementationRegistry:", dealImplementationRegistry.address);
  await waitFor(publicClient, await factory.write.setGlobal(["dealActivityIndex", dealActivityIndex.address]));
  console.log("DealFactory.setGlobal(dealActivityIndex) OK");
  await waitFor(publicClient, await factory.write.setDealImplementation([newDealImpl]));
  console.log("DealFactory.setDealImplementation OK");
  await waitFor(
    publicClient,
    await dealImplementationRegistry.write.setDealImplementations([
      newDealImpl,
      dealNoAssetImpl.address,
      dealAAssetNftImpl.address,
      dealBAssetNftImpl.address,
      dealAAssetNftOnlyImpl.address,
      dealBAssetNftOnlyImpl.address,
      dealOpenTokenTokenImpl.address,
    ]),
  );
  console.log("DealImplementationRegistry.setDealImplementations OK");
  await waitFor(publicClient, await factory.write.setGlobal(["dealImplementationRegistry", dealImplementationRegistry.address]));
  console.log("DealFactory.setGlobal(dealImplementationRegistry) OK");

  // ═══════════════ Summary ═══════════════
  console.log("\n========== RESULT ==========");
  console.log("New Deal implementation:", newDealImpl);
  console.log("New DealNoAsset implementation:", dealNoAssetImpl.address);
  console.log("New DealAAssetNft implementation:", dealAAssetNftImpl.address);
  console.log("New DealBAssetNft implementation:", dealBAssetNftImpl.address);
  console.log("New DealAAssetNftOnly implementation:", dealAAssetNftOnlyImpl.address);
  console.log("New DealBAssetNftOnly implementation:", dealBAssetNftOnlyImpl.address);
  console.log("New DealOpenTokenToken implementation:", dealOpenTokenTokenImpl.address);
  console.log("New DealActivityIndex:", dealActivityIndex.address);
  console.log("New DealImplementationRegistry:", dealImplementationRegistry.address);
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
    newDealNoAssetImplementation: dealNoAssetImpl.address,
    newDealAAssetNftImplementation: dealAAssetNftImpl.address,
    newDealBAssetNftImplementation: dealBAssetNftImpl.address,
    newDealAAssetNftOnlyImplementation: dealAAssetNftOnlyImpl.address,
    newDealBAssetNftOnlyImplementation: dealBAssetNftOnlyImpl.address,
    newDealOpenTokenTokenImplementation: dealOpenTokenTokenImpl.address,
    newDealActivityIndex: dealActivityIndex.address,
    newDealImplementationRegistry: dealImplementationRegistry.address,
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
