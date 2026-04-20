/**
 * Deploy upgraded contracts: DealLib (new), Deal (changed), DealFactory (changed).
 * Links DealLib into Deal bytecode, configures the new DealFactory,
 * and updates the old DealFactory's dealImplementation.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, type Address, type Hex } from "viem";
import { loadAgikingDeploymentAddresses } from "./load-agiking-deployment.js";

const AGIKING_CHAIN_ID = 31415926;

const latest = loadAgikingDeploymentAddresses();
const EXISTING = {
  ...latest,
  oldDealImplementation: latest.dealImplementation,
  oldDealFactory: latest.dealFactory,
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
  publicClient: any,
  hash: `0x${string}`,
) {
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

  // ═══════════════ 1. Deploy DealLib ═══════════════
  console.log("\n--- Deploying DealLib ---");
  const dealLib = await viem.deployContract("DealLib", [], { client });
  console.log("DealLib:", dealLib.address);

  // ═══════════════ 2. Deploy Deal implementation (linked to DealLib) ═══════════════
  console.log("\n--- Deploying Deal implementation (linked to DealLib) ---");
  const dealArtifact = JSON.parse(
    readFileSync(join(process.cwd(), "artifacts/contracts/Deal.sol/Deal.json"), "utf8"),
  );
  const rawBytecode: string = dealArtifact.bytecode;

  // Library placeholder pattern: __$<34-char hash>$__
  const libAddrHex = dealLib.address.slice(2).toLowerCase().padStart(40, "0");
  const linkedBytecode = rawBytecode.replace(/__\$[a-f0-9]{34}\$__/g, libAddrHex) as Hex;

  if (linkedBytecode.includes("__$")) {
    throw new Error("Unresolved library placeholder in Deal bytecode");
  }

  const deployHash = await deployer.sendTransaction({ data: linkedBytecode, chain });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  const newDealImpl = deployReceipt.contractAddress as Address;
  console.log("Deal implementation:", newDealImpl);

  // ═══════════════ 3. Deploy new DealFactory ═══════════════
  console.log("\n--- Deploying new DealFactory ---");
  const newFactory = await viem.deployContract(
    "DealFactory",
    [newDealImpl, EXISTING.pairImplementation, 3600],
    { client },
  );
  console.log("New DealFactory:", newFactory.address);
  const dealMessageHub = await viem.deployContract("DealMessageHub", [newFactory.address], { client });
  console.log("DealMessageHub:", dealMessageHub.address);

  // ═══════════════ 4. Configure new DealFactory ═══════════════
  console.log("\n--- Configuring new DealFactory ---");

  await waitFor(publicClient, await newFactory.write.setGlobal(["dlToken", EXISTING.dlToken]));
  console.log("  setGlobal dlToken OK");

  await waitFor(publicClient, await newFactory.write.setGlobal(["infoNft", EXISTING.dealInfoNFT]));
  console.log("  setGlobal infoNft OK");

  await waitFor(publicClient, await newFactory.write.setGlobal(["wrappedNative", EXISTING.wrappedNative]));
  console.log("  setGlobal wrappedNative OK");
  await waitFor(publicClient, await newFactory.write.setGlobal(["dealMessageHub", dealMessageHub.address]));
  console.log("  setGlobal dealMessageHub OK");

  await waitFor(publicClient, await newFactory.write.setGlobal(["swapOrderBook", EXISTING.dealSwapOrderBook]));
  console.log("  setGlobal swapOrderBook OK");

  await waitFor(publicClient, await newFactory.write.setRecognizedTokens([EXISTING.ausd, EXISTING.usdt]));
  console.log("  setRecognizedTokens OK");

  await waitFor(publicClient, await newFactory.write.setTreasuryByAdmin([dep]));
  console.log("  setTreasuryByAdmin OK");

  // Grant MINTER_ROLE on DL token to the new factory
  const dlAbi = loadAbi("DL.sol/DCToken.json");
  const dlContract = await viem.getContractAt("DCToken", EXISTING.dlToken, { client });
  const minterRole = await dlContract.read.MINTER_ROLE();
  await waitFor(publicClient, await dlContract.write.grantRole([minterRole, newFactory.address]));
  console.log("  DL MINTER_ROLE granted to new factory");

  // ═══════════════ 5. Update OLD DealFactory's dealImplementation ═══════════════
  console.log("\n--- Updating old DealFactory's dealImplementation ---");
  const oldFactoryAbi = loadAbi("DealFactory.sol/DealFactory.json");
  const oldFactory = await viem.getContractAt("DealFactory", EXISTING.oldDealFactory, { client });
  await waitFor(publicClient, await oldFactory.write.setDealImplementation([newDealImpl]));
  console.log("  Old DealFactory dealImplementation updated to", newDealImpl);

  // ═══════════════ Summary ═══════════════
  const newAddresses = {
    dealLib: dealLib.address,
    dealImplementation: newDealImpl,
    dealFactory: newFactory.address,
    dealMessageHub: dealMessageHub.address,
  };

  const allAddresses = {
    dlToken: EXISTING.dlToken,
    ausd: EXISTING.ausd,
    usdt: EXISTING.usdt,
    wrappedNative: EXISTING.wrappedNative,
    dealLib: dealLib.address,
    dealImplementation: newDealImpl,
    oldDealImplementation: EXISTING.oldDealImplementation,
    pairImplementation: EXISTING.pairImplementation,
    dealFactory: newFactory.address,
    dealMessageHub: dealMessageHub.address,
    oldDealFactory: EXISTING.oldDealFactory,
    dealInfoNFT: EXISTING.dealInfoNFT,
    pairDlAusd: EXISTING.pairDlAusd,
    pairDlUsdt: EXISTING.pairDlUsdt,
    dealSwapOrderBook: EXISTING.dealSwapOrderBook,
    dealRouter: EXISTING.dealRouter,
    dealReader: EXISTING.dealReader,
    dcDomain: EXISTING.dcDomain,
    dcDomainRank: EXISTING.dcDomainRank,
    dcDomainMarket: EXISTING.dcDomainMarket,
    dcDomainSwap: EXISTING.dcDomainSwap,
    dcDomainHall: EXISTING.dcDomainHall,
    dToken: EXISTING.dToken,
    dealTimelock: EXISTING.dealTimelock,
    dealGovernor: EXISTING.dealGovernor,
    voteDividendClaimer: EXISTING.voteDividendClaimer,
  };

  console.log("\n========== NEW DEPLOYMENTS ==========");
  console.log(JSON.stringify(newAddresses, null, 2));
  console.log("\n========== ALL ADDRESSES ==========");
  console.log(JSON.stringify(allAddresses, null, 2));

  // Save deployment info
  const dir = join(process.cwd(), "deployments");
  mkdirSync(dir, { recursive: true });

  const out = {
    chainId: AGIKING_CHAIN_ID,
    rpcUrl: rpcUrl.trim(),
    deployedAt: new Date().toISOString(),
    deployer: dep,
    addresses: allAddresses,
    abi: {
      DealLib: loadAbi("utils/DealLib.sol/DealLib.json"),
      Deal: loadAbi("Deal.sol/Deal.json"),
      DealFactory: loadAbi("DealFactory.sol/DealFactory.json"),
      DealMessageHub: loadAbi("DealMessageHub.sol/DealMessageHub.json"),
    },
  };

  const file = join(dir, `agiking-upgrade-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
  console.log("\nWrote", file);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
