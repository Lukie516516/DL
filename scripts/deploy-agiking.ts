/**
 * Deploy the full production contract set on `agiking` network.
 * Deal.sol uses viaIR:false override and omits on-chain chat to stay under EIP-170.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, zeroAddress, type Address } from "viem";

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

async function main() {
  const rpcUrl = process.env.AGIKING_RPC_URL;
  if (!rpcUrl?.trim()) {
    throw new Error("Set AGIKING_RPC_URL (e.g. https://rpc.agikingrpc.shop)");
  }

  const chain = agikingChain(rpcUrl.trim());

  const { viem } = await network.connect({
    network: "agiking",
    chainType: "l1",
  });

  const publicClient = await viem.getPublicClient({ chain });
  const [deployer] = await viem.getWalletClients({ chain });
  const client = { public: publicClient, wallet: deployer } as const;
  const dep = deployer.account.address;

  console.log("Chain", chain.id, "deployer", dep);

  // —— Core AMM + Deal ——
  const dealImpl = await viem.deployContract("Deal", [], { client });
  console.log("Deal impl", dealImpl.address);

  const pairImpl = await viem.deployContract("DealSwapTemplate", [], { client });
  console.log("DealSwapTemplate impl", pairImpl.address);

  const dl = await viem.deployContract("DCToken", ["Deal DL", "DL", 0n, dep, dep], { client });
  const ausd = await viem.deployContract("DCToken", ["AUSD", "AUSD", 0n, dep, dep], { client });
  const usdt = await viem.deployContract("DCToken", ["USDT", "USDT", 0n, dep, dep], { client });
  const wrappedNative = await viem.deployContract(
    "DCToken",
    ["Wrapped Native", "WNATIVE", 0n, dep, dep],
    { client },
  );
  console.log("DL / AUSD / USDT / WNATIVE", dl.address, ausd.address, usdt.address, wrappedNative.address);

  const factory = await viem.deployContract("DealFactory", [dealImpl.address, pairImpl.address, 3600], {
    client,
  });
  console.log("DealFactory", factory.address);
  const dealMessageHub = await viem.deployContract("DealMessageHub", [factory.address], { client });
  console.log("DealMessageHub", dealMessageHub.address);

  const infoNft = await viem.deployContract("DealInfoNFT", [factory.address, zeroAddress, 0n], { client });
  console.log("DealInfoNFT", infoNft.address);

  const minterRole = await dl.read.MINTER_ROLE();

  await waitFor(publicClient, await factory.write.setGlobal(["dlToken", dl.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["infoNft", infoNft.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["wrappedNative", wrappedNative.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["dealMessageHub", dealMessageHub.address]));
  await waitFor(publicClient, await factory.write.setRecognizedTokens([ausd.address, usdt.address]));
  await waitFor(publicClient, await factory.write.setTreasuryByAdmin([dep]));
  await waitFor(publicClient, await dl.write.grantRole([minterRole, factory.address]));

  const mintAmount = 10_000_000n * ONE;
  for (const token of [dl, ausd, usdt, wrappedNative]) {
    await waitFor(publicClient, await token.write.mint([dep, mintAmount]));
  }

  async function createInitPair(tokenAddr: Address) {
    await waitFor(publicClient, await factory.write.createPair([tokenAddr, 3, 1000]));
    const pair = await factory.read.pairForToken([tokenAddr]);
    await waitFor(publicClient, await dl.write.transfer([pair, 1_000_000n * ONE]));
    const t = await viem.getContractAt("DCToken", tokenAddr, { client });
    await waitFor(publicClient, await t.write.transfer([pair, 1_000_000n * ONE]));
    await waitFor(publicClient, await factory.write.initPair([pair, 0n]));
    return pair;
  }

  const pairAusd = await createInitPair(ausd.address);
  const pairUsdt = await createInitPair(usdt.address);
  console.log("pair DL↔AUSD", pairAusd, "pair DL↔USDT", pairUsdt);

  // —— Order book + router ——
  const orderBook = await viem.deployContract("DealSwapOrderBook", [dep], { client });
  console.log("DealSwapOrderBook", orderBook.address);

  await waitFor(publicClient, await factory.write.setGlobal(["swapOrderBook", orderBook.address]));

  const router = await viem.deployContract("DealRouter", [wrappedNative.address, orderBook.address], {
    client,
  });
  console.log("DealRouter", router.address);

  await waitFor(publicClient, await orderBook.write.setRouter([router.address]));

  // —— Reader (stateless) ——
  const dealReader = await viem.deployContract("DealReader", [], { client });
  console.log("DealReader", dealReader.address);

  // —— DC domain stack (payment + rank stake = AUSD) ——
  const dcDomain = await viem.deployContract("DCDomain", [ausd.address, dep], { client });
  console.log("DCDomain", dcDomain.address);

  const dcRank = await viem.deployContract("DCDomainRank", [ausd.address, dcDomain.address, dep], { client });
  console.log("DCDomainRank", dcRank.address);

  const dcMarket = await viem.deployContract(
    "DCDomainMarket",
    [dcDomain.address, ausd.address, dep, 100n],
    { client },
  );
  console.log("DCDomainMarket", dcMarket.address);

  await waitFor(publicClient, await dcDomain.write.setDomainMarket([dcMarket.address]));

  const dcSwap = await viem.deployContract("DCDomainSwap", [dcDomain.address, dcRank.address, factory.address], {
    client,
  });
  console.log("DCDomainSwap", dcSwap.address);

  const dcHall = await viem.deployContract("DCDomainHall", [dcRank.address, dcDomain.address, factory.address], {
    client,
  });
  console.log("DCDomainHall", dcHall.address);

  // —— Governance (D + timelock + governor) ——
  const dToken = await viem.deployContract("D", [], { client });
  console.log("D (votes)", dToken.address);

  const timelock = await viem.deployContract(
    "DealTimelock",
    [1n, [dep] as Address[], [dep] as Address[], dep],
    { client },
  );
  console.log("DealTimelock", timelock.address);

  const governor = await viem.deployContract("contracts/DealDao.sol:DealGovernor", [dToken.address, timelock.address], { client });
  console.log("DealGovernor", governor.address);

  const PROPOSER_ROLE = await timelock.read.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await timelock.read.EXECUTOR_ROLE();
  const CANCELLER_ROLE = await timelock.read.CANCELLER_ROLE();

  await waitFor(publicClient, await timelock.write.grantRole([PROPOSER_ROLE, governor.address]));
  await waitFor(publicClient, await timelock.write.grantRole([EXECUTOR_ROLE, governor.address]));
  await waitFor(publicClient, await timelock.write.grantRole([CANCELLER_ROLE, governor.address]));

  // —— Vote dividend (DL as payout token) ——
  const voteClaimer = await viem.deployContract("VoteDividendClaimer", [dToken.address, dl.address, dep], {
    client,
  });
  console.log("VoteDividendClaimer", voteClaimer.address);

  const addresses = {
    dlToken: dl.address,
    ausd: ausd.address,
    usdt: usdt.address,
    wrappedNative: wrappedNative.address,
    dealImplementation: dealImpl.address,
    pairImplementation: pairImpl.address,
    dealFactory: factory.address,
    dealMessageHub: dealMessageHub.address,
    dealInfoNFT: infoNft.address,
    pairDlAusd: pairAusd,
    pairDlUsdt: pairUsdt,
    dealSwapOrderBook: orderBook.address,
    dealRouter: router.address,
    dealReader: dealReader.address,
    dcDomain: dcDomain.address,
    dcDomainRank: dcRank.address,
    dcDomainMarket: dcMarket.address,
    dcDomainSwap: dcSwap.address,
    dcDomainHall: dcHall.address,
    dToken: dToken.address,
    dealTimelock: timelock.address,
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
      DealMessageHub: loadAbi("DealMessageHub.sol/DealMessageHub.json"),
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
      "Deal chat storage is externalized through DealMessageHub; Deal.postMessage remains available, and readers should use the hub for message pagination.",
      "DCDomain / DCDomainRank use AUSD as payment & stake token; treasury = deployer.",
      "DCDomainHall.createDealFor / chargeMessageFeeFrom are not on this DealFactory ABI; hall auto-create paths need a factory upgrade or different entrypoints.",
      "Test-only contracts (TestWNative, ExampleAdminTarget, GovHelper, duplicate test governors) are intentionally not deployed.",
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
