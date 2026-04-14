/**
 * Resume deployment: deploy DealGovernor + VoteDividendClaimer, wire roles, write final JSON.
 * Uses addresses from the partial run that succeeded up to DealTimelock.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, type Address } from "viem";

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

const prev = {
  dlToken: "0x39f27267184d3ff8522d5ed209fbf32fc7cbf3bb" as Address,
  ausd: "0xe2ba57ad85b33a3e2e09b69175974e7315264179" as Address,
  usdt: "0xedc6e1ebc966f19a32ac58b09fe667ba59ec149a" as Address,
  wrappedNative: "0x298d8871bfa6129a74d1ab324f4728794848c5b3" as Address,
  dealImplementation: "0xd9b9d95e493603202cb182e772df771981a171f4" as Address,
  pairImplementation: "0x6613540b2451ced2dd8a7a48db89ca2c8414b163" as Address,
  dealFactory: "0xf2d1a17ff3bfb32907414adce00bf2777b92ce03" as Address,
  dealInfoNFT: "0x00fcc7f1a406ebfe6e5a1077821cc53c6752c789" as Address,
  pairDlAusd: "0xc48b652C9c240FB18aFCf4ADac67471f28fb70e5" as Address,
  pairDlUsdt: "0x8ca50e47b9a142bE5665E35d4697f475eC93C765" as Address,
  dealSwapOrderBook: "0xb43ad4748459d82cf59efb56aca96fdf1d2d82f3" as Address,
  dealRouter: "0x1e957fa8e7cf3e927398f4305b06e7c000101aea" as Address,
  dealReader: "0x970a096690d9bbf6bb199da683b93ec334057297" as Address,
  dcDomain: "0xb68b18ef2df7b39d315bf67e6df1d9343f2fec7a" as Address,
  dcDomainRank: "0x2324aa5622460870f80ed4daa5283ab42b17c1aa" as Address,
  dcDomainMarket: "0xe8b74981514c24faee70a2fd84e366bb8a506cee" as Address,
  dcDomainSwap: "0x2d2f79769ba047429ef599e4ae613d6478cb21f8" as Address,
  dcDomainHall: "0x64b28ca7ca62c9dde59288fd2a13976a2108e046" as Address,
  dToken: "0x7a4a195bac5ff77af01fc1ce13f1fc5a1770b429" as Address,
  dealTimelock: "0xaad9988a5f6fcb3cf3f0ab8f9730592eb3826468" as Address,
};

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

  const timelock = await viem.getContractAt("DealTimelock", prev.dealTimelock, { client });

  const governor = await viem.deployContract(
    "contracts/DealDao.sol:DealGovernor",
    [prev.dToken, prev.dealTimelock],
    { client },
  );
  console.log("DealGovernor", governor.address);

  const PROPOSER_ROLE = await timelock.read.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await timelock.read.EXECUTOR_ROLE();
  const CANCELLER_ROLE = await timelock.read.CANCELLER_ROLE();

  await waitFor(publicClient, await timelock.write.grantRole([PROPOSER_ROLE, governor.address]));
  await waitFor(publicClient, await timelock.write.grantRole([EXECUTOR_ROLE, governor.address]));
  await waitFor(publicClient, await timelock.write.grantRole([CANCELLER_ROLE, governor.address]));
  console.log("Governor roles granted");

  const voteClaimer = await viem.deployContract(
    "VoteDividendClaimer",
    [prev.dToken, prev.dlToken, dep],
    { client },
  );
  console.log("VoteDividendClaimer", voteClaimer.address);

  const addresses = {
    ...prev,
    dealGovernor: governor.address,
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
      DealTimelock: loadAbi("TestDealTimeLock.sol/DealTimelock.json"),
      DealGovernor: loadAbi("DealDao.sol/DealGovernor.json"),
      VoteDividendClaimer: loadAbi("VoteDividendClaimer.sol/VoteDividendClaimer.json"),
    },
    notes: [
      "Deal: no postMessage/getMessages (EIP-170); use DCDomainHall for hall messaging.",
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
