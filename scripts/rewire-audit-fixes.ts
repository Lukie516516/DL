/**
 * rewire-audit-fixes.ts
 * 继续完成 deploy-audit-fixes 的接线（从 17-c 第4步起）
 * 前5步已确认上链：setGovernor x2, setRecorder x3
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, formatEther, getAddress, parseGwei, zeroAddress, type Address } from "viem";

const AGIKING_CHAIN_ID = 31415926;
const DEPLOYMENT_FILE  = "agiking-31415926.json";
const DEPLOYER         = "0xe88c63d29ece76e3336b0db747e10876c3bf9893" as Address;
const ETH_CHAIN_ID     = Number(process.env.ETH_CHAIN_ID ?? "1");

// ── 刚部署的新地址 ─────────────────────────────────────────────────────────────
const NEW = {
  dcDomain:                  "0x481Fc5092485df2eDc549e69C9F1aC4F99239009" as Address,
  dealNftGovernanceActivity: "0x309a8d8cF2BE2CBF6A0371D8642423e276af8Cb7" as Address,
  nftApprovalRegistry:       "0xdc2dD233Cb033bB6fC1728016C9326331B00bc0A" as Address,
  nftVetoRegistry:           "0x2343dbEA14EE94C6eB4C79ECF999365938727D52" as Address,
  dealGovernanceImpl:        "0x20790CE2C362c6D3a6Ba788a9c02e2f21a460562" as Address,
  dealGovernanceProxy:       "0xd74b24e657ed9a93fBd9774bB75324cb5FDc660e" as Address,
  dealSeatVetoGovernor:      "0xdB1A242d0A7f47A2Ccd84550963516413092957E" as Address,
  dcDomainRankImpl:          "0x020fE913D93ccD9b91722C83932cE69efE76F9db" as Address,
  dcDomainRankProxy:         "0x64939D6Badff45eE73B936fd4F5cEAE6cbCb4a3B" as Address,
  dcDomainSwap:              "0x3BddfeC5bAcAC7cfF2dbB7Ae896CBEEdc7374250" as Address,
  dcDomainListReader:        "0x1c9BB38aE595D7F16CECf1d7EDaCDD051A8Ac86F" as Address,
  dcDomainRankReader:        "0x9a70B45342e7056Dd912F035b2f3275b55AE74c2" as Address,
  dealSwapOrderBook:         "0x8FfBC5Edc77697E6d35C7ad0C842BBCCc983883b" as Address,
  dealRouter:                "0x6F8E1d0d80E034Ef470C399Ab8761a12A30C698F" as Address,
  dcDomainHall:              "0x1849e96CAB80B672357bAeab165A670a1638F0bf" as Address,
  dealMessageHub:            "0xf2C6C565D74340B6cD9EDb0C233ccBC960737ab4" as Address,
  voteDividendClaimer:       "0x19a6d70CDF58070963EE34392a615F906685b065" as Address,
  dcDomainMarket:            "0x79A708bCc27e942d35D83C6933aD506000b369D8" as Address,
  crossChainExecutor:        "0x0F1AEb5E625e0aea83b141794aE5115aF807F33a" as Address,
};

// ── 不变地址 ────────────────────────────────────────────────────────────────────
const EXISTING = {
  dToken:               "0xA57b99E48f2fc24282E8F263D24468a51C5242DB" as Address,
  dlToken:              "0x802C43662C38aAd9b4299c2f723A6B16f228217A" as Address,
  dealInfoNFT:          "0x7E4eD273FAc90A87Ea4C2205B7c37d4A31B08844" as Address,
  crossChainDispatcher: "0x42A59a08f7Ec25c75Ab97815981333F18395805b" as Address,
  dealFactory:          "0xd0Fc2685945790df25bDdeaA69426a348D05775B" as Address,
};

// ── 旧地址（存档）──────────────────────────────────────────────────────────────
const OLD = {
  dcDomain:             "0x0a18a23B7B709Ae063d9dFF397008029f2b07EB7" as Address,
  dcDomainRankProxy:    "0x347F39116BDfca98788EBD60841e14226f63c761" as Address,
  dcDomainRankImpl:     "0x4bf05220e5190cFC8A178A2Bb8b3f45049Dc103D" as Address,
  dcDomainSwap:         "0x79D16213e4AcdF1Fb9Cf471ffB8B812169095D34" as Address,
  dcDomainListReader:   "0xeeCF3206152E6ca3D1938b6191e4284e15D89c75" as Address,
  dcDomainRankReader:   "0x3160026ffcDa4481D5601c1b2563Dde0ADf78bc7" as Address,
  nftApprovalRegistry:  "0xD8Ed220604Fbf0F861D64CaEe2cAE88c1a7258a8" as Address,
  dealGovernanceProxy:  "0xa56dEC8Ec251dF5Dc9E1E8f35B38827FF0DaF190" as Address,
  dealGovernanceImpl:   "0x9757D67b39Fcd9e7c176A9Af90a263808e5D3a24" as Address,
  dealNftGovernanceActivity: "0x9FDA424449e52D2C38Fe19080a8D681A085D536a" as Address,
  dealSeatVetoGovernor: "0x17406e466443da378817A8d69f212B4FC359e48C" as Address,
  dealRouter:           "0x624324B79ca78d0eB45f804fA5a076bA285A5F35" as Address,
  dealSwapOrderBook:    "0x71d8a47AD749aB8aAf5e184b428B2e2B6b891606" as Address,
  dcDomainHall:         "0x3fE565C12fB8080d946BBC56D57641f9272D472C" as Address,
  dealMessageHub:       "0x84E1940E1a5Ad8100f41248254881fb6015926df" as Address,
  dcDomainMarket:       "0x85CaC6b96FC473f4C57A26068500514D092fe48e" as Address,
  crossChainExecutor:   "0x1ABC100Ca6eaB03Ca9a0a75f65239ca9e3FE9A7e" as Address,
};

function agikingChain(rpcUrl: string) {
  return defineChain({
    id: AGIKING_CHAIN_ID, name: "Agiking",
    nativeCurrency: { decimals: 18, name: "AGI", symbol: "AGI" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function loadAbi(rel: string): unknown[] {
  return (JSON.parse(readFileSync(
    join(process.cwd(), "artifacts", "contracts", rel), "utf8",
  )) as { abi: unknown[] }).abi;
}

async function waitFor(publicClient: any, hash: `0x${string}`, label: string) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`FAILED: ${label} (${hash})`);
  console.log(`  ✓ ${label}`);
  return receipt;
}

async function main() {
  const rpcUrl  = (process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop").trim();
  const gasOpts = { gasPrice: parseGwei(process.env.AGIKING_GAS_PRICE_GWEI ?? "12") };
  const chain   = agikingChain(rpcUrl);

  const { viem } = await (network as any).connect({ network: "agiking", chainType: "l1" });
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer]   = await viem.getWalletClients({ chain });
  const client       = { public: publicClient, wallet: deployer } as const;

  console.log("Chain", AGIKING_CHAIN_ID, "deployer", deployer.account.address);
  console.log("Balance", formatEther(await publicClient.getBalance({ address: DEPLOYER })), "AGI\n");

  console.log("=== 续接接线（从 17-c 第4步起）===\n");

  // 17-c 第4步: DealNftGovernanceActivity ← DealFactory
  const activityC = await viem.getContractAt("DealNftGovernanceActivity", NEW.dealNftGovernanceActivity, { client });
  await waitFor(publicClient,
    await activityC.write.setRecorder([EXISTING.dealFactory, true], gasOpts),
    "DealNftGovernanceActivity.setRecorder(DealFactory)",
  );

  // 17-d. DealSwapOrderBook ← 指向新 Router
  const orderBook = await viem.getContractAt("DealSwapOrderBook", NEW.dealSwapOrderBook, { client });
  await waitFor(publicClient,
    await orderBook.write.setRouter([NEW.dealRouter], gasOpts),
    "DealSwapOrderBook.setRouter(newRouter)",
  );

  // 17-e. DealFactory ← 更新 OrderBook + Activity + DcRankProxy
  const factory = await viem.getContractAt("DealFactory", EXISTING.dealFactory, { client });
  await waitFor(publicClient,
    await factory.write.setOpsGlobals([NEW.dealSwapOrderBook, NEW.dealNftGovernanceActivity, NEW.dcDomainRankProxy], gasOpts),
    "DealFactory.setOpsGlobals(newOrderBook, newActivity, newDcRankProxy)",
  );

  // 17-f. DealFactory ← 更新 MessageHub
  await waitFor(publicClient,
    await factory.write.setServiceGlobals([NEW.dealMessageHub, zeroAddress, zeroAddress, zeroAddress, zeroAddress], gasOpts),
    "DealFactory.setServiceGlobals(newMessageHub)",
  );

  // 17-g. DealFactory ← 新 Hall 接线，废弃旧 Hall
  await waitFor(publicClient,
    await factory.write.setAllowedCreateFor([NEW.dcDomainHall, true], gasOpts),
    "DealFactory.setAllowedCreateFor(newHall, true)",
  );
  await waitFor(publicClient,
    await factory.write.setAllowedCreateFor([OLD.dcDomainHall, false], gasOpts),
    "DealFactory.setAllowedCreateFor(oldHall, false)",
  );

  // 17-h. VoteDividendClaimer ← activity + governance
  const voteClaimer = await viem.getContractAt("VoteDividendClaimer", NEW.voteDividendClaimer, { client });
  await waitFor(publicClient,
    await voteClaimer.write.setGovernanceActivity([EXISTING.dealInfoNFT, NEW.dealNftGovernanceActivity], gasOpts),
    "VoteDividendClaimer.setGovernanceActivity",
  );
  await waitFor(publicClient,
    await voteClaimer.write.setGovernanceContract([NEW.dealGovernanceProxy], gasOpts),
    "VoteDividendClaimer.setGovernanceContract(newGov)",
  );

  // 17-i. DCdomain ← 设置 DomainMarket
  const dcDomainC = await viem.getContractAt("DCDomain", NEW.dcDomain, { client });
  await waitFor(publicClient,
    await dcDomainC.write.setDomainMarket([NEW.dcDomainMarket], gasOpts),
    "DCdomain.setDomainMarket(newMarket)",
  );

  // 17-j. CrossChainDispatcher ← 更新 executor + governance
  const dispatcher = await viem.getContractAt("CrossChainDispatcher", EXISTING.crossChainDispatcher, { client });
  await waitFor(publicClient,
    await dispatcher.write.setExecutor([ETH_CHAIN_ID, NEW.crossChainExecutor], gasOpts),
    `CrossChainDispatcher.setExecutor(${ETH_CHAIN_ID}, newExecutor)`,
  );
  await waitFor(publicClient,
    await dispatcher.write.setGovernance([NEW.dealGovernanceProxy], gasOpts),
    "CrossChainDispatcher.setGovernance(newGov)",
  );

  // ── 更新 deployments JSON ─────────────────────────────────────────────────────
  console.log("\n=== 更新 deployment JSON ===");
  const deployedAt = new Date().toISOString();
  const dir        = join(process.cwd(), "deployments");
  const filePath   = join(dir, DEPLOYMENT_FILE);
  mkdirSync(join(dir, "backups"), { recursive: true });

  const existingJson = JSON.parse(readFileSync(filePath, "utf8")) as {
    addresses: Record<string, string>;
    abi: Record<string, unknown[]>;
    notes?: string[];
    [k: string]: unknown;
  };

  const stamp = deployedAt.replace(/[-:T]/g, "").slice(0, 14);
  if (existsSync(filePath)) {
    copyFileSync(filePath, join(dir, "backups", `agiking-31415926.before-rewire-${stamp}.json`));
  }

  Object.assign(existingJson.addresses, {
    dcDomain:                   NEW.dcDomain,
    dcDomainRank:               NEW.dcDomainRankProxy,
    dcDomainRankImpl:           NEW.dcDomainRankImpl,
    dcDomainSwap:               NEW.dcDomainSwap,
    dcDomainListReader:         NEW.dcDomainListReader,
    dcDomainRankReader:         NEW.dcDomainRankReader,
    dealNftGovernanceActivity:  NEW.dealNftGovernanceActivity,
    nftApprovalRegistry:        NEW.nftApprovalRegistry,
    nftVetoRegistry:            NEW.nftVetoRegistry,
    dealGovernance:             NEW.dealGovernanceProxy,
    dealGovernanceImpl:         NEW.dealGovernanceImpl,
    dealSeatVetoGovernor:       NEW.dealSeatVetoGovernor,
    dealSwapOrderBook:          NEW.dealSwapOrderBook,
    dealRouter:                 NEW.dealRouter,
    dcDomainHall:               NEW.dcDomainHall,
    dealMessageHub:             NEW.dealMessageHub,
    voteDividendClaimer:        NEW.voteDividendClaimer,
    dcDomainMarket:             NEW.dcDomainMarket,
    crossChainExecutor:         NEW.crossChainExecutor,
    // 旧地址存档
    oldDcDomain:                OLD.dcDomain,
    oldDcDomainRankProxy:       OLD.dcDomainRankProxy,
    oldDealGovernance:          OLD.dealGovernanceProxy,
    oldDealNftGovernanceActivity: OLD.dealNftGovernanceActivity,
    oldDealSeatVetoGovernor:    OLD.dealSeatVetoGovernor,
    oldDealRouter:              OLD.dealRouter,
    oldDealSwapOrderBook:       OLD.dealSwapOrderBook,
    oldDcDomainHall:            OLD.dcDomainHall,
    oldDealMessageHub:          OLD.dealMessageHub,
    oldDcDomainMarket:          OLD.dcDomainMarket,
    oldCrossChainExecutor:      OLD.crossChainExecutor,
  });

  Object.assign(existingJson.abi, {
    DCdomain:                  loadAbi("DCdomain.sol/DCDomain.json"),
    DCDomainRank:              loadAbi("DCdomainrank.sol/DCDomainRank.json"),
    DCdomainswap:              loadAbi("DCdomainswap.sol/DCDomainSwap.json"),
    DCDomainListReader:        loadAbi("DCDomainListReader.sol/DCDomainListReader.json"),
    DCDomainRankReader:        loadAbi("DCDomainRankReader.sol/DCDomainRankReader.json"),
    DealNftGovernanceActivity: loadAbi("DealNftGovernanceActivity.sol/DealNftGovernanceActivity.json"),
    NftApprovalRegistry:       loadAbi("NftApprovalRegistry.sol/NftApprovalRegistry.json"),
    NftVetoRegistry:           loadAbi("NftVetoRegistry.sol/NftVetoRegistry.json"),
    DealGovernance:            loadAbi("DealGovernance.sol/DealGovernance.json"),
    DealSeatVetoGovernor:      loadAbi("DealSeatVetoGovernor.sol/DealSeatVetoGovernor.json"),
    DealSwapOrderBook:         loadAbi("DealSwapOrderBook.sol/DealSwapOrderBook.json"),
    DealSwapRouter:            loadAbi("DealSwapRouter.sol/DealRouter.json"),
    DCDomainHall:              loadAbi("DCDomainHall.sol/DCDomainHall.json"),
    DealMessageHub:            loadAbi("DealMessageHub.sol/DealMessageHub.json"),
    VoteDividendClaimer:       loadAbi("VoteDividendClaimer.sol/VoteDividendClaimer.json"),
    DCDomainMarket:            loadAbi("DCDomainMarket.sol/DCDomainMarket.json"),
    CrossChainExecutor:        loadAbi("CrossChainExecutor.sol/CrossChainExecutor.json"),
  });

  const updated = {
    ...existingJson,
    deployedAt,
    upgrade: "audit-fix-20260617",
    notes: [
      ...(existingJson.notes ?? []),
      `[${deployedAt}] Audit fix Round 1+2 rewire complete. 17 contracts live.`,
    ],
  };

  writeFileSync(filePath, JSON.stringify(updated, null, 2), "utf8");
  console.log("  Updated", filePath);

  console.log(`
════════════════════════════════════════════════════════════
接线完成 — 所有合约上线
════════════════════════════════════════════════════════════
DCdomain                   = ${NEW.dcDomain}
DCdomainrank proxy         = ${NEW.dcDomainRankProxy}
DCdomainrank impl          = ${NEW.dcDomainRankImpl}
DCdomainswap               = ${NEW.dcDomainSwap}
DCDomainListReader         = ${NEW.dcDomainListReader}
DCDomainRankReader         = ${NEW.dcDomainRankReader}
DealNftGovernanceActivity  = ${NEW.dealNftGovernanceActivity}
NftApprovalRegistry        = ${NEW.nftApprovalRegistry}
NftVetoRegistry            = ${NEW.nftVetoRegistry}
DealGovernance proxy       = ${NEW.dealGovernanceProxy}
DealGovernance impl        = ${NEW.dealGovernanceImpl}
DealSeatVetoGovernor       = ${NEW.dealSeatVetoGovernor}
DealSwapOrderBook          = ${NEW.dealSwapOrderBook}
DealSwapRouter             = ${NEW.dealRouter}
DCDomainHall               = ${NEW.dcDomainHall}
DealMessageHub             = ${NEW.dealMessageHub}
VoteDividendClaimer        = ${NEW.voteDividendClaimer}
DCDomainMarket             = ${NEW.dcDomainMarket}
CrossChainExecutor         = ${NEW.crossChainExecutor}

不变：
D (dToken)   = ${EXISTING.dToken}
DL (dlToken) = ${EXISTING.dlToken}
DealFactory  = ${EXISTING.dealFactory}
DealInfoNFT  = ${EXISTING.dealInfoNFT}
════════════════════════════════════════════════════════════`);
}

await main().catch(err => { console.error(err); process.exitCode = 1; });
