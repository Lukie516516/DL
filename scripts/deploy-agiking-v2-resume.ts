/**
 * deploy-agiking-v2-resume.ts
 * Resume script: all contracts already deployed.
 * Only does: Dispatcher.setExecutor + saves deployment JSON.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, formatEther, getAddress, parseGwei, type Address } from "viem";

const AGIKING_CHAIN_ID = 31415926;
const DEPLOYMENT_FILE = "agiking-31415926.json";

// ── All addresses from the completed run ──────────────────────────────────────
const deployed = {
  // unchanged
  dlToken:             "0x802c43662c38aad9b4299c2f723a6b16f228217a" as Address,
  ausd:                "0x8fc6dB736Dce11233078EA6f6EBa4c9F44E4C123" as Address,
  usdt:                "0x1035F65fc63342F9878C4D03e4372718Dbb33d32" as Address,
  wrappedNative:       "0x391747e54d24aa8cef1388fe1c13f8fd57051153" as Address,
  dealInfoNFT:         "0x7e4ed273fac90a87ea4c2205b7c37d4a31b08844" as Address,
  dealCreditGraph:     "0x186312887782596fbe83c964b734b485110da4ad" as Address,
  dealImplementation:  "0xd198726d2033542b26259245a03f441fac707305" as Address,
  dealAssetNftLib:     "0xa937721bf80d91fe0feea4ea9cf2c5a08c3b6eba" as Address,
  pairImplementation:  "0x5555c709bcaf2423155b2c0f3da236351ccdb6c5" as Address,
  pairDlAusd:          "0xEb92069fDDbD0435F194E3608D37B3D2E81286c9" as Address,
  pairDlUsdt:          "0x88b399d8E41D392Db6A56ADAAdcFb18f37c9DDFc" as Address,
  pairDlAgi:           "0x16FD32B9f1060392272F1145b28110C3A18fc7C5" as Address,
  // newly deployed
  dealLib:                          "0x1257d38db0213ccdf1a44ed7a2267c416a0d1fee" as Address,
  dealNoAssetImplementation:        "0x2d88250530690c7caca08e2ea1dd9c29eee59391" as Address,
  dealAAssetNftImplementation:      "0x5e9bdb4ec4643d51fbf7f8fa9248de884f8e27df" as Address,
  dealBAssetNftImplementation:      "0xd8d59d9e8cb8d7972003e3ed6aa99f37da4401d3" as Address,
  dealAAssetNftOnlyImplementation:  "0xad0dc2c46c0d02ab456a05f4f03c11c22980b79a" as Address,
  dealBAssetNftOnlyImplementation:  "0xaaacda6cff9b91306ab0d31dd607d7237851de45" as Address,
  dealOpenTokenTokenImplementation: "0xf194c4c69352f22d60489bda063979a120796608" as Address,
  dealImplementationRegistry:       "0x8bb59bb5269ee46f56fddd7bdbcc498c17b84de3" as Address,
  dealFactoryImpl:     "0x9c0e10155bdfe97451fcd1d159fa4b89bc8e669c" as Address,
  dealFactory:         "0xd0fc2685945790df25bddeaa69426a348d05775b" as Address,
  dealPairManager:     "0x66ae5a605a566b59cfb33dbcf1ddc0cfb853a8a5" as Address,
  dealMessageHub:      "0x84e1940e1a5ad8100f41248254881fb6015926df" as Address,
  dealActivityIndex:   "0x1e0b2ba7572df0338be4edae63af67c0bddb222a" as Address,
  dealResultIndex:     "0x7d3f79d24972d6b7a9f5d9358d550895ed612278" as Address,
  dealSwapOrderBook:   "0x71d8a47ad749ab8aaf5e184b428b2e2b6b891606" as Address,
  dealRouter:          "0x624324b79ca78d0eb45f804fa5a076ba285a5f35" as Address,
  dealRouterQuoter:    "0x0171e0445ba759bed1dcd3aa39d5b9a9c297b56f" as Address,
  dealSwapAssetRegistry: "0x77ea130d6b7f293579b0bcd5d19b3f22eca45528" as Address,
  dealInfoNFTRenderer: "0x2f678cd7ff82f1828621718eefb67b514f9a0c16" as Address,
  dealReader:          "0x10340c8138c29f6772061a0aae34982e74d3780e" as Address,
  dcDomain:            "0x0a18a23b7b709ae063d9dff397008029f2b07eb7" as Address,
  dcDomainRankImpl:    "0x4bf05220e5190cfc8a178a2bb8b3f45049dc103d" as Address,
  dcDomainRank:        "0x347f39116bdfca98788ebd60841e14226f63c761" as Address,
  dcDomainRankReader:  "0x3160026ffcda4481d5601c1b2563dde0adf78bc7" as Address,
  dcDomainListReader:  "0xeecf3206152e6ca3d1938b6191e4284e15d89c75" as Address,
  dcDomainMarket:      "0x85cac6b96fc473f4c57a26068500514d092fe48e" as Address,
  dcDomainSwap:        "0x79d16213e4acdf1fb9cf471ffb8b812169095d34" as Address,
  dcDomainHall:        "0x3fe565c12fb8080d946bbc56d57641f9272d472c" as Address,
  dealGovernanceImpl:  "0xc909b5752baa0d8ebab511ef10bdd15ad8fa564b" as Address,
  dealGovernance:      "0x281b18d6755869a0552088ef190ed9bbcceafa1c" as Address,
  dToken:              "0xa57b99e48f2fc24282e8f263d24468a51c5242db" as Address,
  dealNftGovernanceActivity: "0x9fda424449e52d2c38fe19080a8d681a085d536a" as Address,
  nftVetoRegistry:     "0xd8ed220604fbf0f861d64caee2cae88c1a7258a8" as Address,
  dealSeatVetoGovernor:"0x17406e466443da378817a8d69f212b4fc359e48c" as Address,
  voteDividendClaimer: "0xefe550df7bd394c7791aa56f64efc2d938c576f9" as Address,
  crossChainDispatcher:"0x42a59a08f7ec25c75ab97815981333f18395805b" as Address,
  crossChainExecutor:  "0x1abc100ca6eab03ca9a0a75f65239ca9e3fe9a7e" as Address,
};

function agikingChain(rpcUrl: string) {
  return defineChain({
    id: AGIKING_CHAIN_ID, name: "Agiking",
    nativeCurrency: { decimals: 18, name: "AGI", symbol: "AGI" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function loadAbi(rel: string): unknown[] {
  return (JSON.parse(readFileSync(join(process.cwd(), "artifacts", "contracts", rel), "utf8")) as { abi: unknown[] }).abi;
}

async function waitFor(publicClient: any, hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
  return receipt;
}

async function main() {
  const rpcUrl = (process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop").trim();
  const chain = agikingChain(rpcUrl);
  const { viem } = await network.connect({ network: "agiking", chainType: "l1" }) as unknown as { viem: any };
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer] = await viem.getWalletClients({ chain });
  const client = { public: publicClient, wallet: deployer } as const;
  const dep = deployer.account.address as Address;
  console.log("deployer", dep, "balance", formatEther(await publicClient.getBalance({ address: dep })));

  const dispatcher = await viem.getContractAt("CrossChainDispatcher", deployed.crossChainDispatcher, { client });
  const gasOpts = { gasPrice: parseGwei(process.env.AGIKING_GAS_PRICE_GWEI ?? "2") };

  console.log("Calling Dispatcher.setExecutor...");
  const hash = await dispatcher.write.setExecutor([AGIKING_CHAIN_ID, deployed.crossChainExecutor], gasOpts);
  await waitFor(publicClient, hash);
  console.log("  OK Dispatcher.setExecutor:", hash);

  // ── Save deployment JSON ──────────────────────────────────────────────────────
  const deployedAt = new Date().toISOString();
  const addresses: Record<string, string> = {
    deployer: dep,
    ...Object.fromEntries(Object.entries(deployed).map(([k, v]) => [k, getAddress(v)])),
    agi: getAddress(deployed.wrappedNative),
    pairDlOldAusd: getAddress(deployed.pairDlAusd),
    pairDlOldUsdt: getAddress(deployed.pairDlUsdt),
  };

  const abi: Record<string, unknown[]> = {
    DealLib:                   loadAbi("utils/DealLib.sol/DealLib.json"),
    DealAssetNftLib:           loadAbi("utils/DealAssetNftLib.sol/DealAssetNftLib.json"),
    Deal:                      loadAbi("Deal.sol/Deal.json"),
    DealNoAsset:               loadAbi("DealNoAsset.sol/DealNoAsset.json"),
    DealAAssetNft:             loadAbi("DealAAssetNft.sol/DealAAssetNft.json"),
    DealBAssetNft:             loadAbi("DealBAssetNft.sol/DealBAssetNft.json"),
    DealAAssetNftOnly:         loadAbi("DealAAssetNftOnly.sol/DealAAssetNftOnly.json"),
    DealBAssetNftOnly:         loadAbi("DealBAssetNftOnly.sol/DealBAssetNftOnly.json"),
    DealOpenTokenToken:        loadAbi("DealOpenTokenToken.sol/DealOpenTokenToken.json"),
    DealImplementationRegistry: loadAbi("DealImplementationRegistry.sol/DealImplementationRegistry.json"),
    DealFactory:               loadAbi("DealFactory.sol/DealFactory.json"),
    DealPairManager:           loadAbi("DealPairManager.sol/DealPairManager.json"),
    DealMessageHub:            loadAbi("DealMessageHub.sol/DealMessageHub.json"),
    DealActivityIndex:         loadAbi("DealActivityIndex.sol/DealActivityIndex.json"),
    DealResultIndex:           loadAbi("DealResultIndex.sol/DealResultIndex.json"),
    DealSwapOrderBook:         loadAbi("DealSwapOrderBook.sol/DealSwapOrderBook.json"),
    DealRouter:                loadAbi("DealSwapRouter.sol/DealRouter.json"),
    DealRouterQuoter:          loadAbi("DealRouterQuoter.sol/DealRouterQuoter.json"),
    DealSwapAssetRegistry:     loadAbi("DealSwapAssetRegistry.sol/DealSwapAssetRegistry.json"),
    DealInfoNFT:               loadAbi("DealInfoNft.sol/DealInfoNFT.json"),
    DealInfoNFTRenderer:       loadAbi("DealInfoNFTRenderer.sol/DealInfoNFTRenderer.json"),
    DealReader:                loadAbi("DealReader.sol/DealReader.json"),
    DealCreditGraph:           loadAbi("DealCreditGraph.sol/DealCreditGraph.json"),
    DealSwapTemplate:          loadAbi("DealSwapTemplate.sol/DealSwapTemplate.json"),
    DCToken:                   loadAbi("DL.sol/DCToken.json"),
    DCDomain:                  loadAbi("DCdomain.sol/DCDomain.json"),
    DCDomainRank:              loadAbi("DCdomainrank.sol/DCDomainRank.json"),
    DCDomainRankReader:        loadAbi("DCDomainRankReader.sol/DCDomainRankReader.json"),
    DCDomainListReader:        loadAbi("DCDomainListReader.sol/DCDomainListReader.json"),
    DCDomainMarket:            loadAbi("DCDomainMarket.sol/DCDomainMarket.json"),
    DCDomainSwap:              loadAbi("DCdomainswap.sol/DCDomainSwap.json"),
    DCDomainHall:              loadAbi("DCDomainHall.sol/DCDomainHall.json"),
    D:                         loadAbi("D.sol/D.json"),
    DealNftGovernanceActivity: loadAbi("DealNftGovernanceActivity.sol/DealNftGovernanceActivity.json"),
    NftVetoRegistry:           loadAbi("NftVetoRegistry.sol/NftVetoRegistry.json"),
    DealSeatVetoGovernor:      loadAbi("DealSeatVetoGovernor.sol/DealSeatVetoGovernor.json"),
    DealGovernance:            loadAbi("DealGovernance.sol/DealGovernance.json"),
    VoteDividendClaimer:       loadAbi("VoteDividendClaimer.sol/VoteDividendClaimer.json"),
    CrossChainDispatcher:      loadAbi("CrossChainDispatcher.sol/CrossChainDispatcher.json"),
    CrossChainExecutor:        loadAbi("CrossChainExecutor.sol/CrossChainExecutor.json"),
  };

  const out = {
    chainId: AGIKING_CHAIN_ID, rpcUrl, deployedAt, deployer: dep,
    upgrade: "v2-full-uups",
    addresses, abi,
    notes: [
      "DealFactory, DCdomainrank, DealGovernance are UUPS proxies. Impl addresses stored as *Impl keys.",
      "Existing swap pools (pairDlAusd/pairDlUsdt/pairDlAgi), dealInfoNFT, dealCreditGraph, tokens are reused.",
      "DealGovernance nftVetoRegistry defaults to address(0). Enable via setNftVetoRegistry proposal.",
      "CrossChainDispatcher/_Executor are bridge placeholders. Wire real bridge via setBridgeAdapter().",
      "D token: 100 D minted to deployer. Distribute seats before enabling governance proposals.",
    ],
  };

  const dir = join(process.cwd(), "deployments");
  mkdirSync(join(dir, "backups"), { recursive: true });
  const currentFile = join(dir, DEPLOYMENT_FILE);
  const stamp = deployedAt.replace(/[-:T]/g, "").slice(0, 14);
  if (existsSync(currentFile)) {
    copyFileSync(currentFile, join(dir, "backups", `agiking-31415926.before-v2-full-${stamp}.json`));
  }
  writeFileSync(currentFile, JSON.stringify(out, null, 2), "utf8");
  writeFileSync(join(dir, `agiking-31415926-${stamp}.json`), JSON.stringify(out, null, 2), "utf8");
  console.log("Wrote", currentFile);
  console.log("\n=== Key addresses ===");
  const keyContracts = ["dealFactory","dcDomainRank","dealGovernance","dealRouter","dealSwapOrderBook","dToken","crossChainDispatcher","crossChainExecutor"];
  for (const k of keyContracts) console.log(` ${k}: ${addresses[k]}`);
}

await main().catch(err => { console.error(err); process.exitCode = 1; });
