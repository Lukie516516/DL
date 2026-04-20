/**
 * Deploy new Deal implementation (added openJoinFor) and update DealFactory pointer.
 * DealLib is unchanged, reuse existing address.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, type Address, type Hex } from "viem";
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

  // ═══════════════ 1. Deploy Deal implementation (linked to existing DealLib) ═══════════════
  console.log("\n--- Deploying Deal implementation (with openJoinFor) ---");
  const dealArtifact = JSON.parse(
    readFileSync(join(process.cwd(), "artifacts/contracts/Deal.sol/Deal.json"), "utf8"),
  );
  const rawBytecode: string = dealArtifact.bytecode;

  const libAddrHex = EXISTING.dealLib.slice(2).toLowerCase().padStart(40, "0");
  const linkedBytecode = rawBytecode.replace(/__\$[a-f0-9]{34}\$__/g, libAddrHex) as Hex;

  if (linkedBytecode.includes("__$")) {
    throw new Error("Unresolved library placeholder in Deal bytecode");
  }

  const deployHash = await deployer.sendTransaction({ data: linkedBytecode, chain });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  const newDealImpl = deployReceipt.contractAddress as Address;
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

  const dir = join(process.cwd(), "deployments");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "deal-impl-update.json");
  writeFileSync(file, JSON.stringify({
    chainId: AGIKING_CHAIN_ID,
    deployedAt: new Date().toISOString(),
    newDealImplementation: newDealImpl,
    dealFactory: EXISTING.dealFactory,
    dealLib: EXISTING.dealLib,
  }, null, 2), "utf8");
  console.log("Wrote", file);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
