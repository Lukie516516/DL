/**
 * verify-governance-v3.ts
 * 逐项读取链上状态，验证 v3 部署和接线是否正确。
 */
import { network } from "hardhat";
import { defineChain, formatEther, getAddress, type Address } from "viem";

const AGIKING_CHAIN_ID = 31415926;

const ADDR = {
  dToken:               "0xa57b99e48f2fc24282e8f263d24468a51c5242db" as Address,
  dlToken:              "0x802c43662c38aad9b4299c2f723a6b16f228217a" as Address,
  treasury:             "0xe88c63d29ece76e3336b0db747e10876c3bf9893" as Address,
  newGovernance:        "0xa56dEC8Ec251dF5Dc9E1E8f35B38827FF0DaF190" as Address,
  oldGovernance:        "0x8f4A698395D77aBd2eB71881E2AFb2C1cF539961" as Address,
  crossChainDispatcher: "0x42a59a08f7ec25c75ab97815981333f18395805b" as Address,
  nftVetoRegistry:      "0xd8ed220604fbf0f861d64caee2cae88c1a7258a8" as Address,
  voteDividendClaimer:  "0xefe550df7bd394c7791aa56f64efc2d938c576f9" as Address,
};

const D_UNIT = 10n ** 18n;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = String(actual).toLowerCase() === String(expected).toLowerCase();
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) console.log(`      got      : ${actual}`);
  if (!ok) console.log(`      expected : ${expected}`);
  return ok;
}

function agikingChain(rpcUrl: string) {
  return defineChain({
    id: AGIKING_CHAIN_ID, name: "Agiking",
    nativeCurrency: { decimals: 18, name: "AGI", symbol: "AGI" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

async function main() {
  const rpcUrl = (process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop").trim();
  const chain  = agikingChain(rpcUrl);
  const { viem } = await network.connect({ network: "agiking", chainType: "l1" }) as unknown as { viem: any };
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer]   = await viem.getWalletClients({ chain });
  const client       = { public: publicClient, wallet: deployer } as const;

  let allOk = true;
  const fail = () => { allOk = false; };

  // ── 1. DealGovernance 参数 ────────────────────────────────────────────────
  console.log("\n=== 1. DealGovernance 链上参数 ===");
  const gov = await viem.getContractAt("DealGovernance", ADDR.newGovernance, { client });

  const actThresh    = await gov.read.activationThreshold();
  const fpThresh     = await gov.read.fastPassThreshold();
  const tresThresh   = await gov.read.treasuryPassThreshold();
  const satThresh    = await gov.read.satoshiPassThreshold();
  const paramWin     = await gov.read.paramWindowSeconds();
  const majorWin     = await gov.read.majorWindowSeconds();
  const nftBps       = await gov.read.nftVetoThresholdBps();
  const majorFee     = await gov.read.majorProposalFee();
  const dTokenAddr   = await gov.read.dToken();
  const dcTokenAddr  = await gov.read.dcToken();
  const treasuryAddr = await gov.read.treasury();
  const nftReg       = await gov.read.nftVetoRegistry();
  const proposalCnt  = await gov.read.proposalCount();

  if (!check("activationThreshold = 2.5 D",    actThresh,    25n * D_UNIT / 10n)) fail();
  if (!check("fastPassThreshold = 70 D",        fpThresh,     70n * D_UNIT))       fail();
  if (!check("treasuryPassThreshold = 70 D",   tresThresh,   70n * D_UNIT))       fail();
  if (!check("satoshiPassThreshold = 90 D",    satThresh,    90n * D_UNIT))       fail();
  if (!check("paramWindowSeconds = 24h",        paramWin,     86400n))             fail();
  if (!check("majorWindowSeconds = 120h",       majorWin,     432000n))            fail();
  if (!check("nftVetoThresholdBps = 1000",      nftBps,       1000n))              fail();
  if (!check("majorProposalFee = 1000 DC",      majorFee,     1000n * D_UNIT))     fail();
  if (!check("dToken = D token",                getAddress(dTokenAddr),  getAddress(ADDR.dToken)))  fail();
  if (!check("dcToken = DL token",              getAddress(dcTokenAddr), getAddress(ADDR.dlToken))) fail();
  if (!check("treasury = deployer",             getAddress(treasuryAddr),getAddress(ADDR.treasury)))fail();
  if (!check("nftVetoRegistry = address(0)",   getAddress(nftReg),      "0x0000000000000000000000000000000000000000")) fail();
  console.log(`  ℹ proposalCount = ${proposalCnt} (expected 0, fresh proxy)`);

  // ── 2. 接线验证 ───────────────────────────────────────────────────────────
  console.log("\n=== 2. 接线验证 ===");

  // CrossChainDispatcher.governance
  const dispatcher = await viem.getContractAt("CrossChainDispatcher", ADDR.crossChainDispatcher, { client });
  const dispGov    = await dispatcher.read.governance();
  if (!check("Dispatcher.governance = 新proxy",
    getAddress(dispGov), getAddress(ADDR.newGovernance))) fail();

  // NftVetoRegistry: 旧proxy已撤销，新proxy已授权
  const nftVeto  = await viem.getContractAt("NftVetoRegistry", ADDR.nftVetoRegistry, { client });
  const oldIsGov = await nftVeto.read.isGovernor([ADDR.oldGovernance]);
  const newIsGov = await nftVeto.read.isGovernor([ADDR.newGovernance]);
  if (!check("NftVetoRegistry.isGovernor(旧proxy) = false", oldIsGov, false)) fail();
  if (!check("NftVetoRegistry.isGovernor(新proxy) = true",  newIsGov, true))  fail();

  // VoteDividendClaimer.governanceContract
  const voteClaimer = await viem.getContractAt("VoteDividendClaimer", ADDR.voteDividendClaimer, { client });
  const claimerGov  = await voteClaimer.read.governanceContract();
  if (!check("VoteClaimer.governanceContract = 新proxy",
    getAddress(claimerGov), getAddress(ADDR.newGovernance))) fail();

  // ── 3. D Token 状态 ───────────────────────────────────────────────────────
  console.log("\n=== 3. D Token 状态 ===");
  const dToken = await viem.getContractAt("D", ADDR.dToken, { client });
  const totalSupply   = await dToken.read.totalSupply();
  const deployerBal   = await dToken.read.balanceOf([ADDR.treasury]);
  const seatThreshold = await dToken.read.SEAT_THRESHOLD();

  if (!check("totalSupply = 100 D",         totalSupply,   100n * D_UNIT))      fail();
  if (!check("SEAT_THRESHOLD = 2.5 D",      seatThreshold, 25n * D_UNIT / 10n)) fail();
  console.log(`  ℹ deployer D balance = ${formatEther(deployerBal)} D (待分配给席位持有者)`);

  // ── 4. 新函数可调用 ───────────────────────────────────────────────────────
  console.log("\n=== 4. 新函数可读取 ===");
  // approvalVotes(0) 应该返回 0（不 revert）
  try {
    const av = await gov.read.approvalVotes([0n]);
    check("approvalVotes(0) 可读取，返回 0", av, 0n);
  } catch (e: any) {
    console.log("  ✗ approvalVotes() revert:", e.message);
    fail();
  }

  // ── 5. 旧 proxy 状态（应该坏的）─────────────────────────────────────────
  console.log("\n=== 5. 旧 proxy 状态确认 ===");
  const oldGov = await viem.getContractAt("DealGovernance", ADDR.oldGovernance, { client });
  const oldAct = await oldGov.read.activationThreshold();
  console.log(`  ℹ 旧proxy activationThreshold = ${oldAct} (应为 0，确认已废弃)`);

  // ── 结果 ─────────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(50));
  if (allOk) {
    console.log("✅ 全部验证通过 — DAO 可以正常使用");
  } else {
    console.log("❌ 有验证项未通过，请检查上方错误");
    process.exitCode = 1;
  }
}

await main().catch(err => { console.error(err); process.exitCode = 1; });
