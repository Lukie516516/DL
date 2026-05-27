/**
 * Resume the 2026-05 Agiking full redeploy after the first run stopped at
 * DealRouter deployment because the deployer ran out of native gas.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, formatEther, type Address } from "viem";

const AGIKING_CHAIN_ID = 31415926;
const ONE = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

const P: Record<string, Address> = {
  dlToken: "0x0688c9148d968bf4c2422caa8739112a04ddb5a5",
  ausd: "0xb91cf0c6edd1b9ec971343237fd8a119f77c7abf",
  usdt: "0x21e6f21aa27ae519a6b7272611a1f2fd3b82dcda",
  wrappedNative: "0x018f505703b4ce5c4f9374390652b27e96330f5d",
  dealLib: "0xefc77a73b630acb1ace85b8dfcc7b7073d96961c",
  dealAssetNftLib: "0xabb1871111463ee36dfb8408889339be80785173",
  dealImplementation: "0xd366e85e5c8928bd59f8305bff4a5ecd86f15053",
  dealNoAssetImplementation: "0x6d3907647d135659e1371dd5f22cd16b45513d31",
  dealAAssetNftImplementation: "0x871d31907a5a35909f42d3c1a4dabf61a7edcff7",
  dealBAssetNftImplementation: "0xcf4ac6fe050c642e44a3c3c6f2d3452d56eb94bc",
  dealAAssetNftOnlyImplementation: "0x49acfc40e1a288115303845092a1ee193aa044bc",
  dealBAssetNftOnlyImplementation: "0x10f400062fd5a3ea7866648ce625c4f158d66c2c",
  dealOpenTokenTokenImplementation: "0x11987639eda8bf5b9dcab73fbca0ebd34b353e79",
  dealImplementationRegistry: "0xdfd6b53b2cbb49d7ba158439cddc094a329ce4ff",
  pairImplementation: "0xb1203a0895c11278d43fc83ad921e2562ba4e5cc",
  dealFactory: "0xd0018b79034942f741f66d941a3db2b50efe0c80",
  dealPairManager: "0x9a38e13611dfc01d6f25a6b363c9a6cfb084ef6b",
  dealMessageHub: "0xd2eff4ed6c0abca70f2bcd40a8e1ae3edfbc8e01",
  dealCreditGraph: "0x2020586881220d8be36c67b941f1369799eb717a",
  dealActivityIndex: "0x752da4ab18b38c6f38f6e91f4f612085c9de5ca9",
  dealResultIndex: "0xe9cca83a282608dc0f7c1b8cf44eba29de31928f",
  dealInfoNFT: "0x7e4b75c7b059bbaac69d00486e57990034e6e278",
  pairDlAusd: "0x29401FAf6Db21a2e0DB8EdC07069D450d5926C14",
  pairDlUsdt: "0x54c6F62cfC3E0bCc0CE3ee43E35F2B150Ec0A1dD",
  dealSwapOrderBook: "0xec83bfdc0b684642e409a29d6673ae03bd31ee67",
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

async function waitFor(publicClient: any, hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
  return receipt;
}

async function tx(label: string, publicClient: any, hashPromise: Promise<`0x${string}`>) {
  const hash = await hashPromise;
  await waitFor(publicClient, hash);
  console.log(`  OK ${label}: ${hash}`);
}

function deploymentAbi() {
  return {
    DealLib: loadAbi("utils/DealLib.sol/DealLib.json"),
    DealAssetNftLib: loadAbi("utils/DealAssetNftLib.sol/DealAssetNftLib.json"),
    Deal: loadAbi("Deal.sol/Deal.json"),
    DealNoAsset: loadAbi("DealNoAsset.sol/DealNoAsset.json"),
    DealAAssetNft: loadAbi("DealAAssetNft.sol/DealAAssetNft.json"),
    DealBAssetNft: loadAbi("DealBAssetNft.sol/DealBAssetNft.json"),
    DealAAssetNftOnly: loadAbi("DealAAssetNftOnly.sol/DealAAssetNftOnly.json"),
    DealBAssetNftOnly: loadAbi("DealBAssetNftOnly.sol/DealBAssetNftOnly.json"),
    DealOpenTokenToken: loadAbi("DealOpenTokenToken.sol/DealOpenTokenToken.json"),
    DealImplementationRegistry: loadAbi("DealImplementationRegistry.sol/DealImplementationRegistry.json"),
    DealSwapTemplate: loadAbi("DealSwapTemplate.sol/DealSwapTemplate.json"),
    DCToken: loadAbi("DL.sol/DCToken.json"),
    DealFactory: loadAbi("DealFactory.sol/DealFactory.json"),
    DealMessageHub: loadAbi("DealMessageHub.sol/DealMessageHub.json"),
    DealCreditGraph: loadAbi("DealCreditGraph.sol/DealCreditGraph.json"),
    DealActivityIndex: loadAbi("DealActivityIndex.sol/DealActivityIndex.json"),
    DealResultIndex: loadAbi("DealResultIndex.sol/DealResultIndex.json"),
    DealInfoNFT: loadAbi("DealInfoNft.sol/DealInfoNFT.json"),
    DealSwapOrderBook: loadAbi("DealSwapOrderBook.sol/DealSwapOrderBook.json"),
    DealRouter: loadAbi("DealSwapRouter.sol/DealRouter.json"),
    DealReader: loadAbi("DealReader.sol/DealReader.json"),
    DCDomain: loadAbi("DCdomain.sol/DCDomain.json"),
    DCDomainRank: loadAbi("DCdomainrank.sol/DCDomainRank.json"),
    DCDomainRankReader: loadAbi("DCDomainRankReader.sol/DCDomainRankReader.json"),
    DCDomainListReader: loadAbi("DCDomainListReader.sol/DCDomainListReader.json"),
    DCDomainMarket: loadAbi("DCDomainMarket.sol/DCDomainMarket.json"),
    DCDomainSwap: loadAbi("DCdomainswap.sol/DCDomainSwap.json"),
    DCDomainHall: loadAbi("DCDomainHall.sol/DCDomainHall.json"),
    D: loadAbi("D.sol/D.json"),
    DealNftGovernanceActivity: loadAbi("DealNftGovernanceActivity.sol/DealNftGovernanceActivity.json"),
    NftVetoRegistry: loadAbi("NftVetoRegistry.sol/NftVetoRegistry.json"),
    DealSeatVetoGovernor: loadAbi("DealSeatVetoGovernor.sol/DealSeatVetoGovernor.json"),
    VoteDividendClaimer: loadAbi("VoteDividendClaimer.sol/VoteDividendClaimer.json"),
  };
}

function writeFrontendHandoff(file: string, deployedAt: string, deployer: Address, addresses: Record<string, Address>) {
  const md = `# Agiking 前端部署地址交接

部署时间：${deployedAt}

部署钱包：\`${deployer}\`

链：Agiking \`${AGIKING_CHAIN_ID}\`

> 这次是整套测试环境重新部署。前端请以本文件和 \`deployments/agiking-31415926.json\` 为准，不要继续使用旧地址。

## 前端主接入地址

| 模块 | 地址 | 前端用途 |
| --- | --- | --- |
| DealFactory | \`${addresses.dealFactory}\` | 创建 deal、读取工厂配置、索引当前 deal |
| DealMessageHub | \`${addresses.dealMessageHub}\` | 留言上链入口：\`postMessage(deal, content)\` |
| DealReader | \`${addresses.dealReader}\` | 聚合读取 deal 列表/详情 |
| DealActivityIndex | \`${addresses.dealActivityIndex}\` | 读取用户活动索引 |
| DealResultIndex | \`${addresses.dealResultIndex}\` | 读取奖励明细、信用增量、交易过程时间线，避免扫历史 logs |
| DealPairManager | \`${addresses.dealPairManager}\` | Factory 背后的 pair/TWAP 管理，前端通常仍调 Factory |
| DealCreditGraph | \`${addresses.dealCreditGraph}\` | 读取官方 InfoNFT 信用分 |
| DealInfoNFT | \`${addresses.dealInfoNFT}\` | 官方身份 NFT |
| DCDomainSwap | \`${addresses.dcDomainSwap}\` | 域名入口创建普通 deal |
| DCDomainHall | \`${addresses.dcDomainHall}\` | 域名大厅/匹配入口 |
| DCDomain | \`${addresses.dcDomain}\` | 域名 NFT |
| DCDomainRank | \`${addresses.dcDomainRank}\` | 域名黑名单、广告充值/结算、域名收益 |
| DCDomainRankReader | \`${addresses.dcDomainRankReader}\` | 域名排行榜分页、deal 精确搜索/终局详情 |
| DCDomainListReader | \`${addresses.dcDomainListReader}\` | 域名列表分页、按成交额排序、按名称/ID/解析地址/创建者查询 |
| DCDomainMarket | \`${addresses.dcDomainMarket}\` | 域名市场 |
| DealCoin/DCToken | \`${addresses.dlToken}\` | DealCoin（DC）主代币 |
| AUSD | \`${addresses.ausd}\` | 测试稳定币 |
| USDT | \`${addresses.usdt}\` | 测试稳定币 |
| WNATIVE | \`${addresses.wrappedNative}\` | 包装原生币 |
| DealRouter | \`${addresses.dealRouter}\` | swap/router |
| DealSwapOrderBook | \`${addresses.dealSwapOrderBook}\` | swap order book |
| D | \`${addresses.dToken}\` | DAO/分红权代币 |
| VoteDividendClaimer | \`${addresses.voteDividendClaimer}\` | D 持有人分红领取 |

## 本次前端必须切换

1. 创建 deal 走新的 \`DealFactory\`。
2. 留言统一调新的 \`DealMessageHub.postMessage(dealAddress, content)\`。
3. 交易过程时间线和奖励/信用明细读 \`DealResultIndex\`。
4. 域名入口切到新的 \`DCDomainSwap\` / \`DCDomainHall\`。
5. 域名排行榜分页、搜索和统计切到新的 \`DCDomainRankReader.getLeaderboard/domainEntryCount/getDomainDealInfo/getDomainStatusCounts\`；域名列表切到 \`DCDomainListReader.getDomainsByVolume/getDomainsByCreator\`。
6. 域名广告充值仍调新的 \`DCDomainRank.deposit\`；终局后系统会自动结算退款，\`closeDeal\` 只作为兜底；域名收益领取调用 \`DCDomainRank.withdraw(domainName)\`。
7. 创建 \`openTokenTokenFast = true\` 的 deal 时传 \`replaceTimeoutSeconds\`，范围 60 秒到 1 天；建议默认 120 秒。
8. 本次重新部署了测试 \`DealCoin(DC)/AUSD/USDT/WNATIVE/InfoNFT/DCDomain/D\`，旧测试币和旧 NFT 不进入新系统；需要重新领取/发放测试币。

完整 ABI 在 \`deployments/agiking-31415926.json\`。
`;
  writeFileSync(file, md, "utf8");
}

async function main() {
  const rpcUrl = process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop";
  const chain = agikingChain(rpcUrl.trim());
  const { viem } = await network.connect({ network: "agiking", chainType: "l1" });
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer] = await viem.getWalletClients({ chain });
  const client = { public: publicClient, wallet: deployer } as const;
  const dep = deployer.account.address;
  const balance = await publicClient.getBalance({ address: dep });
  console.log("Chain", chain.id, "deployer", dep, "balance", formatEther(balance));

  const factory = await viem.getContractAt("DealFactory", P.dealFactory, { client });
  const orderBook = await viem.getContractAt("DealSwapOrderBook", P.dealSwapOrderBook, { client });

  console.log("\n--- Resume at router ---");
  const router = await viem.deployContract("DealRouter", [P.wrappedNative, P.dealSwapOrderBook], { client });
  console.log("DealRouter", router.address);
  await tx("OrderBook.setRouter", publicClient, orderBook.write.setRouter([router.address]));

  const dealReader = await viem.deployContract("DealReader", [], { client });
  console.log("DealReader", dealReader.address);

  console.log("\n--- Domain stack ---");
  const dcDomain = await viem.deployContract("DCDomain", [P.dlToken, dep], { client });
  console.log("DCDomain", dcDomain.address);
  const dcRank = await viem.deployContract("DCDomainRank", [P.dlToken, dcDomain.address, dep], { client });
  console.log("DCDomainRank", dcRank.address);
  const dcRankReader = await viem.deployContract("DCDomainRankReader", [dcRank.address], { client });
  console.log("DCDomainRankReader", dcRankReader.address);
  const dcDomainListReader = await viem.deployContract("DCDomainListReader", [dcDomain.address, dcRank.address], { client });
  console.log("DCDomainListReader", dcDomainListReader.address);
  await tx("Factory.setOpsGlobals dcDomainRank", publicClient, factory.write.setOpsGlobals([ZERO, ZERO, dcRank.address]));
  await tx("Rank.setAutoCloser Factory", publicClient, dcRank.write.setAutoCloser([P.dealFactory]));
  const dcMarket = await viem.deployContract("DCDomainMarket", [dcDomain.address, P.dlToken, dep, 100n], { client });
  console.log("DCDomainMarket", dcMarket.address);
  await tx("DCDomain.setDomainMarket", publicClient, dcDomain.write.setDomainMarket([dcMarket.address]));

  const dcSwap = await viem.deployContract("DCDomainSwap", [dcDomain.address, dcRank.address, P.dealFactory], { client });
  console.log("DCDomainSwap", dcSwap.address);
  const dcHall = await viem.deployContract("DCDomainHall", [dcRank.address, dcDomain.address, P.dealFactory], { client });
  console.log("DCDomainHall", dcHall.address);
  await tx("Factory.allow DCDomainSwap", publicClient, factory.write.setAllowedCreateFor([dcSwap.address, true]));
  await tx("Factory.allow DCDomainHall", publicClient, factory.write.setAllowedCreateFor([dcHall.address, true]));
  await tx("Rank.reporter DCDomainSwap", publicClient, dcRank.write.setDealReporter([dcSwap.address, true]));
  await tx("Rank.reporter DCDomainHall", publicClient, dcRank.write.setDealReporter([dcHall.address, true]));

  console.log("\n--- Governance/dividend ---");
  const dInitialHolder = (process.env.D_INITIAL_HOLDER?.trim() || dep) as Address;
  const dToken = await viem.deployContract("D", [dInitialHolder], { client });
  console.log("D", dToken.address);
  const nftActivity = await viem.deployContract("DealNftGovernanceActivity", [P.dealInfoNFT], { client });
  console.log("DealNftGovernanceActivity", nftActivity.address);
  await tx("Factory.setOpsGlobals dealNftGovernanceActivity", publicClient, factory.write.setOpsGlobals([ZERO, nftActivity.address, ZERO]));
  const nftVetoRegistry = await viem.deployContract("NftVetoRegistry", [P.dealInfoNFT, nftActivity.address], { client });
  console.log("NftVetoRegistry", nftVetoRegistry.address);
  const seatVetoGovernor = await viem.deployContract("DealSeatVetoGovernor", [dToken.address, nftVetoRegistry.address], { client });
  console.log("DealSeatVetoGovernor", seatVetoGovernor.address);
  await tx("NftVetoRegistry.setGovernor", publicClient, nftVetoRegistry.write.setGovernor([seatVetoGovernor.address, true]));
  await tx("NftActivity.setRecorder Factory", publicClient, nftActivity.write.setRecorder([P.dealFactory, true]));
  await tx("NftActivity.setRecorder NftVetoRegistry", publicClient, nftActivity.write.setRecorder([nftVetoRegistry.address, true]));

  const dividendExecutor = (process.env.DIVIDEND_EXECUTOR?.trim() || dep) as Address;
  const dividendSource = (process.env.DIVIDEND_SOURCE?.trim() || dep) as Address;
  const voteClaimer = await viem.deployContract(
    "VoteDividendClaimer",
    [dToken.address, P.dlToken, dividendExecutor, dividendSource],
    { client },
  );
  console.log("VoteDividendClaimer", voteClaimer.address);
  await tx("NftActivity.setRecorder VoteDividendClaimer", publicClient, nftActivity.write.setRecorder([voteClaimer.address, true]));
  await tx("VoteDividendClaimer.setGovernanceActivity", publicClient, voteClaimer.write.setGovernanceActivity([P.dealInfoNFT, nftActivity.address]));

  const addresses: Record<string, Address> = {
    ...P,
    dealRouter: router.address,
    dealReader: dealReader.address,
    dcDomain: dcDomain.address,
    dcDomainRank: dcRank.address,
    dcDomainRankReader: dcRankReader.address,
    dcDomainListReader: dcDomainListReader.address,
    dcDomainMarket: dcMarket.address,
    dcDomainSwap: dcSwap.address,
    dcDomainHall: dcHall.address,
    dToken: dToken.address,
    dealNftGovernanceActivity: nftActivity.address,
    nftVetoRegistry: nftVetoRegistry.address,
    dealSeatVetoGovernor: seatVetoGovernor.address,
    voteDividendClaimer: voteClaimer.address,
  };

  const deployedAt = new Date().toISOString();
  const out = {
    chainId: AGIKING_CHAIN_ID,
    rpcUrl: rpcUrl.trim(),
    deployedAt,
    deployer: dep,
    upgrade: "full-redeploy-resumed",
    addresses,
    abi: deploymentAbi(),
    notes: [
      "Full test deployment resumed from DealRouter after the first run exhausted native gas.",
      "All active app-facing contracts in this deployment are owned/controlled by the deployer wallet.",
      "Old test tokens/NFTs/deals are not part of this new deployment state.",
    ],
  };

  const dir = join(process.cwd(), "deployments");
  const backupDir = join(dir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const currentFile = join(dir, "agiking-31415926.json");
  const stamp = deployedAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  if (existsSync(currentFile)) {
    copyFileSync(currentFile, join(backupDir, `agiking-31415926.before-full-resume-${stamp}.json`));
  }
  const snapshotFile = join(dir, `agiking-31415926-${stamp}.json`);
  const handoffFile = join(dir, `frontend-handoff-agiking-31415926-${stamp}.md`);
  writeFileSync(currentFile, JSON.stringify(out, null, 2), "utf8");
  writeFileSync(snapshotFile, JSON.stringify(out, null, 2), "utf8");
  writeFrontendHandoff(handoffFile, deployedAt, dep, addresses);
  writeFrontendHandoff(join(process.cwd(), "docs", "前端部署地址交接文档.md"), deployedAt, dep, addresses);

  console.log("\nWrote", currentFile);
  console.log("Wrote", snapshotFile);
  console.log("Wrote", handoffFile);
  console.log("Wrote", join(process.cwd(), "docs", "前端部署地址交接文档.md"));
  console.log(JSON.stringify(addresses, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
