/**
 * deploy-audit-fixes.ts
 * 部署审计修复版本（2026-06-17，Round 1 + Round 2 全量）
 *
 * 新部署合约（按顺序）：
 *   0.  DCdomain                   — SafeERC20 + _update 自动同步 resolve
 *   1.  DealNftGovernanceActivity  — 懒惰清零 + MAX_ACTIVE_WINDOW 90d
 *   2.  NftApprovalRegistry        — O(1) 计数器，供 DealGovernance 使用
 *   3.  NftVetoRegistry            — 供 DealSeatVetoGovernor 使用（2-arg 接口）
 *   4.  DealGovernance impl+proxy  — cancel 修复 + rescueETH + window reset fix
 *   5.  DealSeatVetoGovernor       — vetoDeadline >= 修复
 *   6.  DCdomainrank impl+proxy    — 广告费改革（无商家数据，直接重部署 proxy）
 *   7.  DCdomainswap               — 引用新 dcDomain + 新 rank
 *   8.  DCDomainListReader         — 引用新 dcDomain + 新 rank
 *   9.  DCDomainRankReader         — 引用新 rank proxy
 *   10. DealSwapOrderBook          — 多处 OrderBook 修复
 *   11. DealSwapRouter             — 对子白名单 + settle before refund
 *   12. DCDomainHall               — expectedB 参数，引用新 dcDomain
 *   13. DealMessageHub             — postFromDeal sender 校验
 *   14. VoteDividendClaimer        — governanceContract 字段
 *   15. DCDomainMarket             — buy() maxPrice 参数，引用新 dcDomain
 *   16. CrossChainExecutor         — replay protection
 *
 * 不动的合约：
 *   - D.sol (dToken)    — 非升级合约，重部署清空所有余额，BurnDisabled 修复跳过
 *   - DL.sol (dlToken)  — 无变更
 *   - DealFactory       — 无变更，仅通过 setter 更新内部引用
 *
 * 接线：见步骤 17
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import {
  defineChain, encodeFunctionData, formatEther, getAddress,
  parseGwei, zeroAddress, type Address,
} from "viem";

const AGIKING_CHAIN_ID = 31415926;
const DEPLOYMENT_FILE  = "agiking-31415926.json";
const DEPLOYER         = "0xe88c63d29ece76e3336b0db747e10876c3bf9893" as Address;
const TREASURY         = DEPLOYER;

// Source chain ID for CrossChainExecutor — matches original deploy (ETH mainnet = 1).
// Override via env: ETH_CHAIN_ID=<id>
const ETH_CHAIN_ID = Number(process.env.ETH_CHAIN_ID ?? "1");

// DCDomainMarket: 1% fee (original deploy used 100 BPS)
const MARKET_FEE_BPS = 100;

// ── 不变的链上地址 ────────────────────────────────────────────────────────────
const EXISTING = {
  dToken:                 "0xA57b99E48f2fc24282E8F263D24468a51C5242DB" as Address,
  dlToken:                "0x802C43662C38aAd9b4299c2f723A6B16f228217A" as Address,
  ausd:                   "0x8fc6dB736Dce11233078EA6f6EBa4c9F44E4C123" as Address,
  dealInfoNFT:            "0x7E4eD273FAc90A87Ea4C2205B7c37d4A31B08844" as Address,
  crossChainDispatcher:   "0x42A59a08f7Ec25c75Ab97815981333F18395805b" as Address,
  dealFactory:            "0xd0Fc2685945790df25bDdeaA69426a348D05775B" as Address,
  dealPairManager:        "0x66Ae5a605a566B59cFB33dbCf1DDC0cFB853A8a5" as Address,
  wrappedNative:          "0x391747E54d24AA8Cef1388FE1C13f8fD57051153" as Address,
  voteDividendClaimer:    "0xEfe550dF7BD394c7791AA56f64efC2D938C576f9" as Address,
};

// ── 将被废弃的旧地址（存档用）────────────────────────────────────────────────
const OLD = {
  dcDomain:               "0x0a18a23B7B709Ae063d9dFF397008029f2b07EB7" as Address,
  dcDomainRankProxy:      "0x347F39116BDfca98788EBD60841e14226f63c761" as Address,
  dcDomainRankImpl:       "0x4bf05220e5190cFC8A178A2Bb8b3f45049Dc103D" as Address,
  dcDomainSwap:           "0x79D16213e4AcdF1Fb9Cf471ffB8B812169095D34" as Address,
  dcDomainListReader:     "0xeeCF3206152E6ca3D1938b6191e4284e15D89c75" as Address,
  dcDomainRankReader:     "0x3160026ffcDa4481D5601c1b2563Dde0ADf78bc7" as Address,
  nftApprovalRegistry:    "0xD8Ed220604Fbf0F861D64CaEe2cAE88c1a7258a8" as Address,
  dealGovernanceProxy:    "0xa56dEC8Ec251dF5Dc9E1E8f35B38827FF0DaF190" as Address,
  dealGovernanceImpl:     "0x9757D67b39Fcd9e7c176A9Af90a263808e5D3a24" as Address,
  dealNftGovernanceActivity: "0x9FDA424449e52D2C38Fe19080a8D681A085D536a" as Address,
  dealSeatVetoGovernor:   "0x17406e466443da378817A8d69f212B4FC359e48C" as Address,
  dealRouter:             "0x624324B79ca78d0eB45f804fA5a076bA285A5F35" as Address,
  dealSwapOrderBook:      "0x71d8a47AD749aB8aAf5e184b428B2e2B6b891606" as Address,
  dcDomainHall:           "0x3fE565C12fB8080d946BBC56D57641f9272D472C" as Address,
  dealMessageHub:         "0x84E1940E1a5Ad8100f41248254881fb6015926df" as Address,
  dcDomainMarket:         "0x85CaC6b96FC473f4C57A26068500514D092fe48e" as Address,
  crossChainExecutor:     "0x1ABC100Ca6eaB03Ca9a0a75f65239ca9e3FE9A7e" as Address,
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
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`FAILED: ${label} (${hash})`);
  console.log(`  ✓ ${label}`);
  return receipt;
}

async function main() {
  const rpcUrl  = (process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop").trim();
  const gasOpts = { gasPrice: parseGwei(process.env.AGIKING_GAS_PRICE_GWEI ?? "2") };
  const chain   = agikingChain(rpcUrl);

  const { viem } = await (network as any).connect({ network: "agiking", chainType: "l1" });
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer]   = await viem.getWalletClients({ chain });
  const client       = { public: publicClient, wallet: deployer } as const;

  console.log("Chain", AGIKING_CHAIN_ID, "deployer", deployer.account.address);
  console.log("Balance", formatEther(await publicClient.getBalance({ address: DEPLOYER })), "AGI\n");

  // ═══════════════════════════════════════════════════════════════════════════
  // 0. DCdomain（SafeERC20 + _update 自动同步 resolve）
  //    paymentToken = AUSD，treasury = TREASURY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("=== 0. Deploy DCdomain ===");
  const dcDomainContract = await viem.deployContract(
    "DCDomain",
    [EXISTING.ausd, TREASURY],
    { client, ...gasOpts },
  );
  const newDcDomain = getAddress(dcDomainContract.address) as Address;
  console.log("  DCdomain:", newDcDomain);

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. DealNftGovernanceActivity（懒惰清零）
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 1. Deploy DealNftGovernanceActivity ===");
  const activityContract = await viem.deployContract(
    "DealNftGovernanceActivity",
    [EXISTING.dealInfoNFT],
    { client, ...gasOpts },
  );
  const newActivity = getAddress(activityContract.address) as Address;
  console.log("  DealNftGovernanceActivity:", newActivity);

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. NftApprovalRegistry（O(1) 计数器，供 DealGovernance 使用）
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 2. Deploy NftApprovalRegistry ===");
  const nftApprovalContract = await viem.deployContract(
    "NftApprovalRegistry",
    [EXISTING.dealInfoNFT, newActivity],
    { client, ...gasOpts },
  );
  const newNftApprovalRegistry = getAddress(nftApprovalContract.address) as Address;
  console.log("  NftApprovalRegistry:", newNftApprovalRegistry);

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. NftVetoRegistry（2-arg registerProposal，供 DealSeatVetoGovernor 使用）
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 3. Deploy NftVetoRegistry ===");
  const nftVetoContract = await viem.deployContract(
    "NftVetoRegistry",
    [EXISTING.dealInfoNFT, newActivity],
    { client, ...gasOpts },
  );
  const newNftVetoRegistry = getAddress(nftVetoContract.address) as Address;
  console.log("  NftVetoRegistry:", newNftVetoRegistry);

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. DealGovernance impl + 新 proxy
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 4. Deploy DealGovernance impl + proxy ===");
  const govImplContract = await viem.deployContract("DealGovernance", [], { client, ...gasOpts });
  const newGovImpl = getAddress(govImplContract.address) as Address;
  console.log("  DealGovernance impl:", newGovImpl);

  const initData = encodeFunctionData({
    abi: govImplContract.abi,
    functionName: "initialize",
    args: [EXISTING.dToken, newNftApprovalRegistry, EXISTING.dlToken, TREASURY],
  });
  const proxyContract = await viem.deployContract("ERC1967Proxy", [newGovImpl, initData], { client, ...gasOpts });
  const newGovProxy   = getAddress(proxyContract.address) as Address;
  console.log("  DealGovernance proxy:", newGovProxy);

  const governance = await viem.getContractAt("DealGovernance", newGovProxy, { client });
  if (await governance.read.activationThreshold() !== 25n * 10n ** 17n) throw new Error("activationThreshold mismatch");
  if (await governance.read.fastPassThreshold()   !== 70n * 10n ** 18n) throw new Error("fastPassThreshold mismatch");
  console.log("  ✓ DealGovernance params verified");

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. DealSeatVetoGovernor（vetoDeadline >= 修复）
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 5. Deploy DealSeatVetoGovernor ===");
  const seatVetoContract = await viem.deployContract(
    "DealSeatVetoGovernor",
    [EXISTING.dToken, newNftVetoRegistry],
    { client, ...gasOpts },
  );
  const newSeatVetoGovernor = getAddress(seatVetoContract.address) as Address;
  console.log("  DealSeatVetoGovernor:", newSeatVetoGovernor);

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. DCdomainrank impl + 新 proxy（无商家数据，直接重部署）
  //    initialize(dToken, newDcDomain, treasury)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 6. Deploy DCdomainrank impl + proxy ===");
  const dcRankImplContract = await viem.deployContract("DCDomainRank", [], { client, ...gasOpts });
  const newDcRankImpl = getAddress(dcRankImplContract.address) as Address;
  console.log("  DCdomainrank impl:", newDcRankImpl);

  const dcRankInitData = encodeFunctionData({
    abi: dcRankImplContract.abi,
    functionName: "initialize",
    args: [EXISTING.dToken, newDcDomain, TREASURY],
  });
  const dcRankProxyContract = await viem.deployContract(
    "ERC1967Proxy",
    [newDcRankImpl, dcRankInitData],
    { client, ...gasOpts },
  );
  const newDcRankProxy = getAddress(dcRankProxyContract.address) as Address;
  console.log("  DCdomainrank proxy:", newDcRankProxy);

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. DCdomainswap（引用新 dcDomain + 新 rank proxy）
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 7. Deploy DCdomainswap ===");
  const dcSwapContract = await viem.deployContract(
    "DCDomainSwap",
    [newDcDomain, newDcRankProxy, EXISTING.dealFactory],
    { client, ...gasOpts },
  );
  const newDcDomainSwap = getAddress(dcSwapContract.address) as Address;
  console.log("  DCdomainswap:", newDcDomainSwap);

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. DCDomainListReader（view only，引用新 dcDomain + 新 rank proxy）
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 8. Deploy DCDomainListReader ===");
  const listReaderContract = await viem.deployContract(
    "DCDomainListReader",
    [newDcDomain, newDcRankProxy],
    { client, ...gasOpts },
  );
  const newDcDomainListReader = getAddress(listReaderContract.address) as Address;
  console.log("  DCDomainListReader:", newDcDomainListReader);

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. DCDomainRankReader（view only，引用新 rank proxy）
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 9. Deploy DCDomainRankReader ===");
  const rankReaderContract = await viem.deployContract(
    "DCDomainRankReader",
    [newDcRankProxy],
    { client, ...gasOpts },
  );
  const newDcDomainRankReader = getAddress(rankReaderContract.address) as Address;
  console.log("  DCDomainRankReader:", newDcDomainRankReader);

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. DealSwapOrderBook（多处 OrderBook 修复）
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 10. Deploy DealSwapOrderBook ===");
  const orderBookContract = await viem.deployContract(
    "DealSwapOrderBook",
    [TREASURY],
    { client, ...gasOpts },
  );
  const newOrderBook = getAddress(orderBookContract.address) as Address;
  console.log("  DealSwapOrderBook:", newOrderBook);

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. DealSwapRouter（对子白名单 + settle before refund）
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 11. Deploy DealSwapRouter ===");
  const routerContract = await viem.deployContract(
    "DealRouter",
    [EXISTING.wrappedNative, newOrderBook, EXISTING.dealPairManager],
    { client, ...gasOpts },
  );
  const newRouter = getAddress(routerContract.address) as Address;
  console.log("  DealSwapRouter:", newRouter);

  // ═══════════════════════════════════════════════════════════════════════════
  // 12. DCDomainHall（expectedB 参数，引用新 dcDomain）
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 12. Deploy DCDomainHall ===");
  const hallContract = await viem.deployContract(
    "DCDomainHall",
    [newDcRankProxy, newDcDomain, EXISTING.dealFactory],
    { client, ...gasOpts },
  );
  const newDcDomainHall = getAddress(hallContract.address) as Address;
  console.log("  DCDomainHall:", newDcDomainHall);

  // ═══════════════════════════════════════════════════════════════════════════
  // 13. DealMessageHub（postFromDeal sender 校验）
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 13. Deploy DealMessageHub ===");
  const messageHubContract = await viem.deployContract(
    "DealMessageHub",
    [EXISTING.dealFactory],
    { client, ...gasOpts },
  );
  const newMessageHub = getAddress(messageHubContract.address) as Address;
  console.log("  DealMessageHub:", newMessageHub);

  // ═══════════════════════════════════════════════════════════════════════════
  // 14. VoteDividendClaimer（governanceContract 字段）
  //   executor = DEPLOYER，dividendSource = TREASURY（需提前 approve DLC）
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 14. Deploy VoteDividendClaimer ===");
  const voteClaimerContract = await viem.deployContract(
    "VoteDividendClaimer",
    [EXISTING.dToken, EXISTING.dlToken, DEPLOYER, TREASURY],
    { client, ...gasOpts },
  );
  const newVoteDividendClaimer = getAddress(voteClaimerContract.address) as Address;
  console.log("  VoteDividendClaimer:", newVoteDividendClaimer);

  // ═══════════════════════════════════════════════════════════════════════════
  // 15. DCDomainMarket（buy() maxPrice，引用新 dcDomain）
  //   paymentToken = DL token，fee = 1%，feeRecipient = TREASURY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 15. Deploy DCDomainMarket ===");
  const marketContract = await viem.deployContract(
    "DCDomainMarket",
    [newDcDomain, EXISTING.dlToken, TREASURY, BigInt(MARKET_FEE_BPS)],
    { client, ...gasOpts },
  );
  const newDcDomainMarket = getAddress(marketContract.address) as Address;
  console.log("  DCDomainMarket:", newDcDomainMarket);

  // ═══════════════════════════════════════════════════════════════════════════
  // 16. CrossChainExecutor（replay protection）
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 16. Deploy CrossChainExecutor ===");
  const executorContract = await viem.deployContract(
    "CrossChainExecutor",
    [ETH_CHAIN_ID, EXISTING.crossChainDispatcher],
    { client, ...gasOpts },
  );
  const newCrossChainExecutor = getAddress(executorContract.address) as Address;
  console.log("  CrossChainExecutor:", newCrossChainExecutor);

  // ═══════════════════════════════════════════════════════════════════════════
  // 17. 接线
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 17. Rewire ===");

  // 17-a. NftApprovalRegistry ← 授权新 DealGovernance
  const nftApproval = await viem.getContractAt("NftApprovalRegistry", newNftApprovalRegistry, { client });
  await waitFor(publicClient,
    await nftApproval.write.setGovernor([newGovProxy, true], gasOpts),
    "NftApprovalRegistry.setGovernor(newGov)",
  );

  // 17-b. NftVetoRegistry ← 授权新 DealSeatVetoGovernor
  const nftVeto = await viem.getContractAt("NftVetoRegistry", newNftVetoRegistry, { client });
  await waitFor(publicClient,
    await nftVeto.write.setGovernor([newSeatVetoGovernor, true], gasOpts),
    "NftVetoRegistry.setGovernor(newSeatVetoGov)",
  );

  // 17-c. DealNftGovernanceActivity ← 注册所有 recorder
  const activityC = await viem.getContractAt("DealNftGovernanceActivity", newActivity, { client });
  for (const [addr, label] of [
    [newNftApprovalRegistry,  "NftApprovalRegistry"],
    [newNftVetoRegistry,      "NftVetoRegistry"],
    [newVoteDividendClaimer,  "VoteDividendClaimer"],
    [EXISTING.dealFactory,    "DealFactory"],
  ] as [Address, string][]) {
    await waitFor(publicClient,
      await activityC.write.setRecorder([addr, true], gasOpts),
      `DealNftGovernanceActivity.setRecorder(${label})`,
    );
  }

  // 17-d. DealSwapOrderBook ← 指向新 Router
  const orderBook = await viem.getContractAt("DealSwapOrderBook", newOrderBook, { client });
  await waitFor(publicClient,
    await orderBook.write.setRouter([newRouter], gasOpts),
    "DealSwapOrderBook.setRouter(newRouter)",
  );

  // 17-e. DealFactory ← 更新 OrderBook + Activity
  const factory = await viem.getContractAt("DealFactory", EXISTING.dealFactory, { client });
  await waitFor(publicClient,
    await factory.write.setOpsGlobals([newOrderBook, newActivity, newDcRankProxy], gasOpts),
    "DealFactory.setOpsGlobals(newOrderBook, newActivity, newDcRankProxy)",
  );

  // 17-f. DealFactory ← 更新 MessageHub
  await waitFor(publicClient,
    await factory.write.setServiceGlobals([newMessageHub, zeroAddress, zeroAddress, zeroAddress, zeroAddress], gasOpts),
    "DealFactory.setServiceGlobals(newMessageHub)",
  );

  // 17-g. DealFactory ← 新 Hall 接线，废弃旧 Hall
  await waitFor(publicClient,
    await factory.write.setAllowedCreateFor([newDcDomainHall, true], gasOpts),
    "DealFactory.setAllowedCreateFor(newHall, true)",
  );
  await waitFor(publicClient,
    await factory.write.setAllowedCreateFor([OLD.dcDomainHall, false], gasOpts),
    "DealFactory.setAllowedCreateFor(oldHall, false)",
  );

  // 17-h. VoteDividendClaimer ← activity + governance
  const voteClaimer = await viem.getContractAt("VoteDividendClaimer", newVoteDividendClaimer, { client });
  await waitFor(publicClient,
    await voteClaimer.write.setGovernanceActivity([EXISTING.dealInfoNFT, newActivity], gasOpts),
    "VoteDividendClaimer.setGovernanceActivity",
  );
  await waitFor(publicClient,
    await voteClaimer.write.setGovernanceContract([newGovProxy], gasOpts),
    "VoteDividendClaimer.setGovernanceContract(newGov)",
  );

  // 17-i. DCdomain ← 设置 DomainMarket
  const dcDomainC = await viem.getContractAt("DCDomain", newDcDomain, { client });
  await waitFor(publicClient,
    await dcDomainC.write.setDomainMarket([newDcDomainMarket], gasOpts),
    "DCdomain.setDomainMarket(newMarket)",
  );

  // 17-j. CrossChainDispatcher ← 更新 executor + governance
  const dispatcher = await viem.getContractAt("CrossChainDispatcher", EXISTING.crossChainDispatcher, { client });
  await waitFor(publicClient,
    await dispatcher.write.setExecutor([ETH_CHAIN_ID, newCrossChainExecutor], gasOpts),
    `CrossChainDispatcher.setExecutor(${ETH_CHAIN_ID}, newExecutor)`,
  );
  await waitFor(publicClient,
    await dispatcher.write.setGovernance([newGovProxy], gasOpts),
    "CrossChainDispatcher.setGovernance(newGov)",
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // 18. 更新 deployments/agiking-31415926.json
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 18. Update deployment JSON ===");
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
    copyFileSync(filePath, join(dir, "backups", `agiking-31415926.before-audit-fix-${stamp}.json`));
  }

  // 新地址
  Object.assign(existingJson.addresses, {
    dcDomain:                   newDcDomain,
    dcDomainRank:               newDcRankProxy,
    dcDomainRankImpl:           newDcRankImpl,
    dcDomainSwap:               newDcDomainSwap,
    dcDomainListReader:         newDcDomainListReader,
    dcDomainRankReader:         newDcDomainRankReader,
    dealNftGovernanceActivity:  newActivity,
    nftApprovalRegistry:        newNftApprovalRegistry,
    nftVetoRegistry:            newNftVetoRegistry,
    dealGovernance:             newGovProxy,
    dealGovernanceImpl:         newGovImpl,
    dealSeatVetoGovernor:       newSeatVetoGovernor,
    dealSwapOrderBook:          newOrderBook,
    dealRouter:                 newRouter,
    dcDomainHall:               newDcDomainHall,
    dealMessageHub:             newMessageHub,
    voteDividendClaimer:        newVoteDividendClaimer,
    dcDomainMarket:             newDcDomainMarket,
    crossChainExecutor:         newCrossChainExecutor,
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

  // ABI 更新
  Object.assign(existingJson.abi, {
    DCdomain:                 loadAbi("DCdomain.sol/DCDomain.json"),
    DCDomainRank:             loadAbi("DCdomainrank.sol/DCDomainRank.json"),
    DCdomainswap:             loadAbi("DCdomainswap.sol/DCDomainSwap.json"),
    DCDomainListReader:       loadAbi("DCDomainListReader.sol/DCDomainListReader.json"),
    DCDomainRankReader:       loadAbi("DCDomainRankReader.sol/DCDomainRankReader.json"),
    DealNftGovernanceActivity:loadAbi("DealNftGovernanceActivity.sol/DealNftGovernanceActivity.json"),
    NftApprovalRegistry:      loadAbi("NftApprovalRegistry.sol/NftApprovalRegistry.json"),
    NftVetoRegistry:          loadAbi("NftVetoRegistry.sol/NftVetoRegistry.json"),
    DealGovernance:           loadAbi("DealGovernance.sol/DealGovernance.json"),
    DealSeatVetoGovernor:     loadAbi("DealSeatVetoGovernor.sol/DealSeatVetoGovernor.json"),
    DealSwapOrderBook:        loadAbi("DealSwapOrderBook.sol/DealSwapOrderBook.json"),
    DealSwapRouter:           loadAbi("DealSwapRouter.sol/DealRouter.json"),
    DCDomainHall:             loadAbi("DCDomainHall.sol/DCDomainHall.json"),
    DealMessageHub:           loadAbi("DealMessageHub.sol/DealMessageHub.json"),
    VoteDividendClaimer:      loadAbi("VoteDividendClaimer.sol/VoteDividendClaimer.json"),
    DCDomainMarket:           loadAbi("DCDomainMarket.sol/DCDomainMarket.json"),
    CrossChainExecutor:       loadAbi("CrossChainExecutor.sol/CrossChainExecutor.json"),
  });

  const updated = {
    ...existingJson,
    deployedAt,
    upgrade: "audit-fix-20260617",
    notes: [
      ...(existingJson.notes ?? []),
      `[${deployedAt}] Audit fix Round 1+2: 17 contracts redeployed. D.sol/DL.sol/DealFactory unchanged.`,
    ],
  };

  writeFileSync(filePath, JSON.stringify(updated, null, 2), "utf8");
  console.log("  Updated", filePath);

  // ═══════════════════════════════════════════════════════════════════════════
  // 完成
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n════════════════════════════════════════════════════════════");
  console.log("审计修复部署完成");
  console.log(`
新地址：
  DCdomain                   = ${newDcDomain}   ← 前端需更新
  DCdomainrank proxy         = ${newDcRankProxy}   ← 前端需更新
  DCdomainrank impl          = ${newDcRankImpl}
  DCdomainswap               = ${newDcDomainSwap}
  DCDomainListReader         = ${newDcDomainListReader}
  DCDomainRankReader         = ${newDcDomainRankReader}
  DealNftGovernanceActivity  = ${newActivity}
  NftApprovalRegistry        = ${newNftApprovalRegistry}
  NftVetoRegistry            = ${newNftVetoRegistry}
  DealGovernance proxy       = ${newGovProxy}   ← 前端需更新
  DealGovernance impl        = ${newGovImpl}
  DealSeatVetoGovernor       = ${newSeatVetoGovernor}
  DealSwapOrderBook          = ${newOrderBook}
  DealSwapRouter             = ${newRouter}   ← 前端需更新
  DCDomainHall               = ${newDcDomainHall}   ← 前端需更新
  DealMessageHub             = ${newMessageHub}
  VoteDividendClaimer        = ${newVoteDividendClaimer}
  DCDomainMarket             = ${newDcDomainMarket}   ← 前端需更新
  CrossChainExecutor         = ${newCrossChainExecutor}

不变的合约：
  D (dToken)     = ${EXISTING.dToken}
  DL (dlToken)   = ${EXISTING.dlToken}
  DealFactory    = ${EXISTING.dealFactory}
  DealInfoNFT    = ${EXISTING.dealInfoNFT}

⚠️  手动确认事项：
  1. ETH_CHAIN_ID=${ETH_CHAIN_ID} 是否与实际 LayerZero 源链 ID 一致
  2. DCDomainMarket paymentToken=DL，feeBps=${MARKET_FEE_BPS} (${MARKET_FEE_BPS / 100}%) 与原部署一致
  3. VoteDividendClaimer.dividendSource=${TREASURY} 需提前 approve DLC 给新合约
  4. 旧 DCDomainMarket 挂单已丢失，需公告卖家重新挂单
  5. 旧 DealMessageHub 历史消息已丢失
════════════════════════════════════════════════════════════`);
}

await main().catch(err => { console.error(err); process.exitCode = 1; });
