/**
 * Resume deployment: deploy DealSeatVetoGovernor + VoteDividendClaimer, wire roles, write final JSON.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, type Address } from "viem";
import { loadAgikingDeploymentAddresses } from "./load-agiking-deployment.js";

const ONE = 10n ** 18n;
const AGIKING_CHAIN_ID = 31415926;

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
  const j = JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[] };
  return j.abi;
}

async function waitFor(
  publicClient: Awaited<ReturnType<Awaited<ReturnType<typeof network.connect>>["viem"]["getPublicClient"]>>,
  hash: `0x${string}`,
) {
  return publicClient.waitForTransactionReceipt({ hash });
}

const prev = loadAgikingDeploymentAddresses();

async function main() {
  const rpcUrl = process.env.AGIKING_RPC_URL;
  if (!rpcUrl?.trim()) throw new Error("Set AGIKING_RPC_URL");

  const chain = agikingChain(rpcUrl.trim());

  const { viem } = await network.connect({ network: "agiking", chainType: "l1" });
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer] = await viem.getWalletClients({ chain });
  const client = { public: publicClient, wallet: deployer } as const;
  const dep = deployer.account.address;

  console.log("Resuming on chain", chain.id, "deployer", dep);

  const nftActivity = await viem.deployContract("DealNftGovernanceActivity", [prev.dealInfoNFT], { client });
  console.log("DealNftGovernanceActivity", nftActivity.address);
  await waitFor(publicClient, await (await viem.getContractAt("DealFactory", prev.dealFactory, { client })).write.setGlobal(["dealNftGovernanceActivity", nftActivity.address]));

  const nftVetoRegistry = await viem.deployContract("NftVetoRegistry", [prev.dealInfoNFT, nftActivity.address], { client });
  console.log("NftVetoRegistry", nftVetoRegistry.address);

  const seatVetoGovernor = await viem.deployContract("DealSeatVetoGovernor", [prev.dToken, nftVetoRegistry.address], { client });
  console.log("DealSeatVetoGovernor", seatVetoGovernor.address);
  await waitFor(publicClient, await nftVetoRegistry.write.setGovernor([seatVetoGovernor.address, true]));
  await waitFor(publicClient, await nftActivity.write.setRecorder([prev.dealFactory, true]));
  await waitFor(publicClient, await nftActivity.write.setRecorder([nftVetoRegistry.address, true]));

  const voteClaimer = await viem.deployContract(
    "VoteDividendClaimer",
    [
      prev.dToken,
      prev.dlToken,
      (process.env.DIVIDEND_EXECUTOR?.trim() || dep) as Address,
      (process.env.DIVIDEND_SOURCE?.trim() || dep) as Address,
    ],
    { client },
  );
  console.log("VoteDividendClaimer", voteClaimer.address);
  await waitFor(publicClient, await nftActivity.write.setRecorder([voteClaimer.address, true]));
  await waitFor(publicClient, await voteClaimer.write.setGovernanceActivity([prev.dealInfoNFT, nftActivity.address]));

  const addresses = {
    ...prev,
    dealNftGovernanceActivity: nftActivity.address,
    nftVetoRegistry: nftVetoRegistry.address,
    dealSeatVetoGovernor: seatVetoGovernor.address,
    voteDividendClaimer: voteClaimer.address,
  };

  const out = {
    chainId: AGIKING_CHAIN_ID,
    rpcUrl: rpcUrl.trim(),
    deployedAt: new Date().toISOString(),
    deployer: dep,
    addresses,
    abi: {
      Deal: loadAbi("Deal.sol/Deal.json"),
      DealSwapTemplate: loadAbi("DealSwapTemplate.sol/DealSwapTemplate.json"),
      DCToken: loadAbi("DL.sol/DCToken.json"),
      DealFactory: loadAbi("DealFactory.sol/DealFactory.json"),
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
      DealNftGovernanceActivity: loadAbi("DealNftGovernanceActivity.sol/DealNftGovernanceActivity.json"),
      NftVetoRegistry: loadAbi("NftVetoRegistry.sol/NftVetoRegistry.json"),
      DealSeatVetoGovernor: loadAbi("DealSeatVetoGovernor.sol/DealSeatVetoGovernor.json"),
      VoteDividendClaimer: loadAbi("VoteDividendClaimer.sol/VoteDividendClaimer.json"),
    },
    notes: [
      "Deal chat storage is externalized through DealMessageHub; Deal.postMessage remains available, and readers should use the hub for message pagination.",
      "DCDomain registration / DCDomainMarket / DCDomainRank use DL as payment and ranking token; treasury = deployer.",
      "Test-only contracts (TestWNative, ExampleAdminTarget, GovHelper, duplicate test governors) are not deployed.",
    ],
  };

  const dir = join(process.cwd(), "deployments");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `agiking-${AGIKING_CHAIN_ID}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
  console.log("Wrote", file);
  console.log(JSON.stringify(addresses, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
