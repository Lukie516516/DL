/**
 * health-check.ts — 链上状态健康检查
 */

import { network } from "hardhat";
import { defineChain, formatEther, parseGwei, type Address } from "viem";

const AGIKING_CHAIN_ID = 31415926;

const NEW = {
  dcDomain:         "0x481Fc5092485df2eDc549e69C9F1aC4F99239009" as Address,
  activity:         "0x309a8d8cF2BE2CBF6A0371D8642423e276af8Cb7" as Address,
  nftApproval:      "0xdc2dD233Cb033bB6fC1728016C9326331B00bc0A" as Address,
  nftVeto:          "0x2343dbEA14EE94C6eB4C79ECF999365938727D52" as Address,
  govImpl:          "0x20790CE2C362c6D3a6Ba788a9c02e2f21a460562" as Address,
  govProxy:         "0xd74b24e657ed9a93fBd9774bB75324cb5FDc660e" as Address,
  seatVeto:         "0xdB1A242d0A7f47A2Ccd84550963516413092957E" as Address,
  dcRankProxy:      "0x64939D6Badff45eE73B936fd4F5cEAE6cbCb4a3B" as Address,
  dcRankImpl:       "0x020fE913D93ccD9b91722C83932cE69efE76F9db" as Address,
  dcSwap:           "0x3BddfeC5bAcAC7cfF2dbB7Ae896CBEEdc7374250" as Address,
  listReader:       "0x1c9BB38aE595D7F16CECf1d7EDaCDD051A8Ac86F" as Address,
  rankReader:       "0x9a70B45342e7056Dd912F035b2f3275b55AE74c2" as Address,
  orderBook:        "0x8FfBC5Edc77697E6d35C7ad0C842BBCCc983883b" as Address,
  router:           "0x6F8E1d0d80E034Ef470C399Ab8761a12A30C698F" as Address,
  hall:             "0x1849e96CAB80B672357bAeab165A670a1638F0bf" as Address,
  msgHub:           "0xf2C6C565D74340B6cD9EDb0C233ccBC960737ab4" as Address,
  voteClaimer:      "0x19a6d70CDF58070963EE34392a615F906685b065" as Address,
  market:           "0x79A708bCc27e942d35D83C6933aD506000b369D8" as Address,
  ccExecutor:       "0x0F1AEb5E625e0aea83b141794aE5115aF807F33a" as Address,
};

const FACTORY  = "0xd0Fc2685945790df25bDdeaA69426a348D05775B" as Address;
const INFO_NFT = "0x7E4eD273FAc90A87Ea4C2205B7c37d4A31B08844" as Address;
const DISPATCH = "0x42A59a08f7Ec25c75Ab97815981333F18395805b" as Address;
const DL_TOKEN = "0x802C43662C38aAd9b4299c2f723A6B16f228217A" as Address;
const D_TOKEN  = "0xA57b99E48f2fc24282E8F263D24468a51C5242DB" as Address;
const TREASURY = "0xe88c63d29ece76e3336b0db747e10876c3bf9893" as Address;

let passed = 0, failed = 0;

function check(label: string, got: unknown, want: unknown) {
  // normalise: lowercase strings, stringify bigints for numeric comparison
  const norm = (v: unknown) => {
    if (typeof v === "string")  return v.toLowerCase();
    if (typeof v === "bigint")  return v.toString();
    if (typeof v === "number")  return v.toString();
    return v;
  };
  if (norm(got) === norm(want)) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}\n      got : ${got}\n      want: ${want}`); failed++; }
}

function checkCode(label: string, code: string) {
  if (code && code !== "0x") { console.log(`  ✓ ${label} (bytecode exists)`); passed++; }
  else { console.log(`  ✗ ${label}: NO BYTECODE`); failed++; }
}

async function main() {
  const rpcUrl = (process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop").trim();
  const chain  = defineChain({
    id: AGIKING_CHAIN_ID, name: "Agiking",
    nativeCurrency: { decimals: 18, name: "AGI", symbol: "AGI" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const { viem } = await (network as any).connect({ network: "agiking", chainType: "l1" });
  const pub = await viem.getPublicClient({ chain });
  const [w]  = await viem.getWalletClients({ chain });
  const client = { public: pub, wallet: w } as const;

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("链上健康检查");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // ── 1. 字节码存在（合约确实部署了）──────────────────────────────────────────
  console.log("── [1] 字节码检查 ──");
  for (const [name, addr] of Object.entries(NEW)) {
    const code = await pub.getBytecode({ address: addr });
    checkCode(name, code ?? "0x");
  }

  // ── 2. DealGovernance proxy ────────────────────────────────────────────────
  console.log("\n── [2] DealGovernance ──");
  const gov = await viem.getContractAt("DealGovernance", NEW.govProxy, { client });
  check("dToken",              await gov.read.dToken(),              D_TOKEN);
  check("nftVetoRegistry",     await gov.read.nftVetoRegistry(),     NEW.nftApproval);
  check("activationThreshold", await gov.read.activationThreshold(), 25n * 10n**17n);
  check("fastPassThreshold",   await gov.read.fastPassThreshold(),   70n * 10n**18n);

  // ── 3. NftApprovalRegistry ─────────────────────────────────────────────────
  console.log("\n── [3] NftApprovalRegistry ──");
  const nftA = await viem.getContractAt("NftApprovalRegistry", NEW.nftApproval, { client });
  check("infoNft",                    await nftA.read.infoNft(),                   INFO_NFT);
  check("isGovernor(govProxy)=true",  await nftA.read.isGovernor([NEW.govProxy]),  true);
  check("isGovernor(seatVeto)=false", await nftA.read.isGovernor([NEW.seatVeto]),  false);

  // ── 4. NftVetoRegistry ────────────────────────────────────────────────────
  console.log("\n── [4] NftVetoRegistry ──");
  const nftV = await viem.getContractAt("NftVetoRegistry", NEW.nftVeto, { client });
  check("isGovernor(seatVeto)=true",   await nftV.read.isGovernor([NEW.seatVeto]), true);
  check("isGovernor(govProxy)=false",  await nftV.read.isGovernor([NEW.govProxy]), false);

  // ── 5. DealNftGovernanceActivity ──────────────────────────────────────────
  console.log("\n── [5] DealNftGovernanceActivity ──");
  const act = await viem.getContractAt("DealNftGovernanceActivity", NEW.activity, { client });
  check("isRecorder(NftApproval)", await act.read.isRecorder([NEW.nftApproval]), true);
  check("isRecorder(NftVeto)",     await act.read.isRecorder([NEW.nftVeto]),     true);
  check("isRecorder(VoteClaimer)", await act.read.isRecorder([NEW.voteClaimer]), true);
  check("isRecorder(Factory)",     await act.read.isRecorder([FACTORY]),         true);

  // ── 6. DealSeatVetoGovernor ───────────────────────────────────────────────
  console.log("\n── [6] DealSeatVetoGovernor ──");
  const svgov = await viem.getContractAt("DealSeatVetoGovernor", NEW.seatVeto, { client });
  check("dToken",          await svgov.read.dToken(),          D_TOKEN);
  check("nftVetoRegistry", await svgov.read.nftVetoRegistry(), NEW.nftVeto);

  // ── 7. DCdomainrank proxy ─────────────────────────────────────────────────
  console.log("\n── [7] DCdomainrank (proxy) ──");
  const rank = await viem.getContractAt("DCDomainRank", NEW.dcRankProxy, { client });
  check("dcDomain", await rank.read.dcDomain(), NEW.dcDomain);
  check("dcToken",  await rank.read.dcToken(),  D_TOKEN);
  check("treasury", await rank.read.treasury(), TREASURY);

  // ── 8. DCdomainswap ───────────────────────────────────────────────────────
  console.log("\n── [8] DCdomainswap ──");
  const swap = await viem.getContractAt("DCDomainSwap", NEW.dcSwap, { client });
  check("dcDomain", await swap.read.dcDomain(), NEW.dcDomain);
  check("dcRank",   await swap.read.dcRank(),   NEW.dcRankProxy);
  check("FACTORY",  await swap.read.FACTORY(),  FACTORY);

  // ── 9. DealSwapOrderBook ─────────────────────────────────────────────────
  console.log("\n── [9] DealSwapOrderBook ──");
  const ob = await viem.getContractAt("DealSwapOrderBook", NEW.orderBook, { client });
  check("router",   await ob.read.router(),   NEW.router);
  check("treasury", await ob.read.treasury(), TREASURY);

  // ── 10. DealSwapRouter (DealRouter) ──────────────────────────────────────
  console.log("\n── [10] DealSwapRouter ──");
  const router = await viem.getContractAt("DealRouter", NEW.router, { client });
  check("ORDER_BOOK",   await router.read.ORDER_BOOK(),   NEW.orderBook);
  check("PAIR_MANAGER", await router.read.PAIR_MANAGER(), "0x66Ae5a605a566B59cFB33dbCf1DDC0cFB853A8a5");

  // ── 11. DCDomainHall ─────────────────────────────────────────────────────
  console.log("\n── [11] DCDomainHall ──");
  const hall = await viem.getContractAt("DCDomainHall", NEW.hall, { client });
  check("rank",        await hall.read.rank(),        NEW.dcRankProxy);
  check("dcDomain",    await hall.read.dcDomain(),    NEW.dcDomain);
  check("dealFactory", await hall.read.dealFactory(), FACTORY);

  // ── 12. DealMessageHub ───────────────────────────────────────────────────
  console.log("\n── [12] DealMessageHub ──");
  const hub = await viem.getContractAt("DealMessageHub", NEW.msgHub, { client });
  check("factory", await hub.read.factory(), FACTORY);

  // ── 13. VoteDividendClaimer ──────────────────────────────────────────────
  console.log("\n── [13] VoteDividendClaimer ──");
  const vc = await viem.getContractAt("VoteDividendClaimer", NEW.voteClaimer, { client });
  check("votesToken",         await vc.read.votesToken(),         D_TOKEN);
  check("dlc",                await vc.read.dlc(),                DL_TOKEN);
  check("governanceActivity", await vc.read.governanceActivity(), NEW.activity);
  check("governanceContract", await vc.read.governanceContract(), NEW.govProxy);

  // ── 14. DCdomain ─────────────────────────────────────────────────────────
  console.log("\n── [14] DCdomain ──");
  const dc = await viem.getContractAt("DCDomain", NEW.dcDomain, { client });
  check("domainMarket", await dc.read.domainMarket(), NEW.market);

  // ── 15. DCDomainMarket ───────────────────────────────────────────────────
  console.log("\n── [15] DCDomainMarket ──");
  const mkt = await viem.getContractAt("DCDomainMarket", NEW.market, { client });
  check("dcDomain",     await mkt.read.dcDomain(),     NEW.dcDomain);
  check("paymentToken", await mkt.read.paymentToken(), DL_TOKEN);
  check("feeBps",       await mkt.read.feeBps(),       100n);
  check("feeRecipient", await mkt.read.feeRecipient(), TREASURY);

  // ── 16. CrossChainExecutor ───────────────────────────────────────────────
  console.log("\n── [16] CrossChainExecutor ──");
  const ex = await viem.getContractAt("CrossChainExecutor", NEW.ccExecutor, { client });
  check("ethChainId",  await ex.read.ethChainId(),  1n);
  check("dispatcher",  await ex.read.dispatcher(),  DISPATCH);

  // ── 17. DealFactory 接线验证 ─────────────────────────────────────────────
  console.log("\n── [17] DealFactory (接线验证) ──");
  const fac = await viem.getContractAt("DealFactory", FACTORY, { client });
  check("dealMessageHub",          await fac.read.dealMessageHub(),             NEW.msgHub);
  check("swapOrderBook",           await fac.read.swapOrderBook(),              NEW.orderBook);
  check("dealNftGovernanceActivity",await fac.read.dealNftGovernanceActivity(), NEW.activity);
  check("dcDomainRank",            await fac.read.dcDomainRank(),              NEW.dcRankProxy);
  check("isAllowedCreateFor(hall)", await fac.read.isAllowedCreateFor([NEW.hall]), true);

  // ── 18. CrossChainDispatcher 接线验证 ────────────────────────────────────
  console.log("\n── [18] CrossChainDispatcher (接线验证) ──");
  const disp = await viem.getContractAt("CrossChainDispatcher", DISPATCH, { client });
  check("executor(1)", await disp.read.executor([1n]), NEW.ccExecutor);
  check("governance",  await disp.read.governance(),   NEW.govProxy);

  // ── 总结 ─────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`结果: ${passed} 通过, ${failed} 失败`);
  if (failed === 0) console.log("✓ 所有合约状态健康");
  else { console.log("✗ 有失败项，请检查上方"); process.exitCode = 1; }
  console.log("═══════════════════════════════════════════════════════════════");
}

await main().catch(err => { console.error(err); process.exitCode = 1; });
