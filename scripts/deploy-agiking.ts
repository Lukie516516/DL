/**
 * Deploy the full production contract set on `agiking` network.
 * Deal.sol uses viaIR:false override and omits on-chain chat to stay under EIP-170.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
| DealOpenTokenToken implementation | \`${addresses.dealOpenTokenTokenImplementation}\` | 公开币币单模板 ABI |
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
3. 点对点币币公开单使用新的 \`DealOpenTokenToken\` ABI，关注 \`replaceInactiveBAndJoin\`、\`replaceNonVotingBAndJoin\`、\`replaceTimeoutSeconds\`。
4. 交易过程时间线读 \`DealResultIndex.getTimeline\`；历史奖励/信用增量读 \`DealResultIndex\`，不要扫历史 logs。
5. 域名入口切到新的 \`DCDomainSwap\` / \`DCDomainHall\`。
6. 域名排行榜分页、搜索和统计切到新的 \`DCDomainRankReader.getLeaderboard/domainEntryCount/getDomainDealInfo/getDomainStatusCounts\`；域名列表切到 \`DCDomainListReader.getDomainsByVolume/getDomainsByCreator\`。
7. 域名广告充值仍调新的 \`DCDomainRank.deposit\`；终局后系统会自动结算退款，\`closeDeal\` 只作为兜底；域名收益领取调用 \`DCDomainRank.withdraw(domainName)\`。
8. 创建 \`openTokenTokenFast = true\` 的 deal 时传 \`replaceTimeoutSeconds\`，范围 60 秒到 1 天；建议默认 120 秒。
9. 创建 deal 不再传 \`timeStart/timeEnd\`；创建时间/结束时间读 \`createdAt/endedAt\`。
10. 本次重新部署了测试 \`DealCoin(DC)/AUSD/USDT/WNATIVE/InfoNFT/DCDomain/D\`，旧测试币和旧 NFT 不进入新系统；需要重新领取/发放测试币。

## ABI

完整 ABI 在：

\`\`\`
deployments/agiking-31415926.json
\`\`\`

## 相关前端文档

| 文档 | 用途 |
| --- | --- |
| \`docs/Domain_Frontend_Call_Guide.md\` | 域名注册、域名交易、大厅、排行榜、分页 |
| \`docs/DealOpenTokenToken_前端接入说明.md\` | OpenTokenToken 创建参数、加入/顶替/成交流程 |
| \`docs/OpenTokenToken_B方踢人与超时字段说明.md\` | B 方踢人、C 顶替、\`replaceTimeoutSeconds\` |
| \`docs/DCDomainSwap_身份NFT创建说明.md\` | 域名下创建币币合同时绑定 A 的官方身份 NFT |
| \`docs/Deal_前端事件与工厂索引说明.md\` | 事件索引、系统提示、奖励/信用/时间线读取 |

## 验证结果

- 新 Factory 已配置 Hub、CreditGraph、ActivityIndex、ResultIndex、PairManager、ImplementationRegistry。
- 新 Factory 已获得新 DealCoin（DC）的 \`MINTER_ROLE\`。
- 新 DealInfoNFT 初始绑定新 Factory。
- 新 DCDomainSwap / DCDomainHall 已获得新 Factory 创建权限。
- 新 DCDomainRank 已授权新的 Swap / Hall reporter。
- 新 DCDomainRank 已设置自动结算入口：\`autoCloser = DealFactory\`。
- 新 DCDomainRankReader 已指向新的 DCDomainRank。
`;
  writeFileSync(file, md, "utf8");
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
  const dealLib = await viem.deployContract("DealLib", [], { client });
  console.log("DealLib", dealLib.address);
  const dealAssetNftLib = await viem.deployContract("DealAssetNftLib", [], { client });
  console.log("DealAssetNftLib", dealAssetNftLib.address);

  const dealImpl = await viem.deployContract("Deal", [], { client });
  console.log("Deal impl", dealImpl.address);
  const dealNoAssetImpl = await viem.deployContract("DealNoAsset", [], {
    client,
    libraries: { DealLib: dealLib.address },
  });
  console.log("DealNoAsset impl", dealNoAssetImpl.address);
  const dealAAssetNftImpl = await viem.deployContract("DealAAssetNft", [], {
    client,
    libraries: {
      DealLib: dealLib.address,
      DealAssetNftLib: dealAssetNftLib.address,
    },
  });
  console.log("DealAAssetNft impl", dealAAssetNftImpl.address);
  const dealBAssetNftImpl = await viem.deployContract("DealBAssetNft", [], {
    client,
    libraries: {
      DealLib: dealLib.address,
      DealAssetNftLib: dealAssetNftLib.address,
    },
  });
  console.log("DealBAssetNft impl", dealBAssetNftImpl.address);
  const dealAAssetNftOnlyImpl = await viem.deployContract("DealAAssetNftOnly", [], {
    client,
    libraries: { DealAssetNftLib: dealAssetNftLib.address },
  });
  console.log("DealAAssetNftOnly impl", dealAAssetNftOnlyImpl.address);
  const dealBAssetNftOnlyImpl = await viem.deployContract("DealBAssetNftOnly", [], {
    client,
    libraries: { DealAssetNftLib: dealAssetNftLib.address },
  });
  console.log("DealBAssetNftOnly impl", dealBAssetNftOnlyImpl.address);
  const dealOpenTokenTokenImpl = await viem.deployContract("DealOpenTokenToken", [], {
    client,
    libraries: { DealLib: dealLib.address },
  });
  console.log("DealOpenTokenToken impl", dealOpenTokenTokenImpl.address);

  const pairImpl = await viem.deployContract("DealSwapTemplate", [], { client });
  console.log("DealSwapTemplate impl", pairImpl.address);

  const dl = await viem.deployContract("DCToken", ["DealCoin", "DC", 0n, dep, dep], { client });
  const ausd = await viem.deployContract("DCToken", ["AUSD", "AUSD", 0n, dep, dep], { client });
  const usdt = await viem.deployContract("DCToken", ["USDT", "USDT", 0n, dep, dep], { client });
  const wrappedNative = await viem.deployContract(
    "DCToken",
    ["Wrapped Native", "WNATIVE", 0n, dep, dep],
    { client },
  );
  console.log("DealCoin/DC / AUSD / USDT / WNATIVE", dl.address, ausd.address, usdt.address, wrappedNative.address);

  const factory = await viem.deployContract("DealFactory", [dealImpl.address, pairImpl.address, 3600], {
    client,
  });
  console.log("DealFactory", factory.address);
  const dealPairManager = await viem.deployContract("DealPairManager", [factory.address], { client });
  console.log("DealPairManager", dealPairManager.address);
  const dealMessageHub = await viem.deployContract("DealMessageHub", [factory.address], { client });
  console.log("DealMessageHub", dealMessageHub.address);
  const dealActivityIndex = await viem.deployContract("DealActivityIndex", [factory.address], { client });
  console.log("DealActivityIndex", dealActivityIndex.address);
  const dealResultIndex = await viem.deployContract("DealResultIndex", [factory.address], { client });
  console.log("DealResultIndex", dealResultIndex.address);
  const dealImplementationRegistry = await viem.deployContract("DealImplementationRegistry", [], { client });
  console.log("DealImplementationRegistry", dealImplementationRegistry.address);

  const infoNft = await viem.deployContract("DealInfoNFT", [factory.address, zeroAddress, 0n], { client });
  console.log("DealInfoNFT", infoNft.address);
  const creditGraph = await viem.deployContract("DealCreditGraph", [infoNft.address], { client });
  console.log("DealCreditGraph", creditGraph.address);

  const minterRole = await dl.read.MINTER_ROLE();

  await waitFor(publicClient, await factory.write.setCoreGlobals([
    dl.address,
    infoNft.address,
    wrappedNative.address,
    dealPairManager.address,
  ]));
  await waitFor(
    publicClient,
    await dealImplementationRegistry.write.setDealImplementations([
      dealImpl.address,
      dealNoAssetImpl.address,
      dealAAssetNftImpl.address,
      dealBAssetNftImpl.address,
      dealAAssetNftOnlyImpl.address,
      dealBAssetNftOnlyImpl.address,
      dealOpenTokenTokenImpl.address,
    ]),
  );
  await waitFor(publicClient, await factory.write.setServiceGlobals([
    dealMessageHub.address,
    creditGraph.address,
    dealActivityIndex.address,
    dealResultIndex.address,
    dealImplementationRegistry.address,
  ]));
  await waitFor(publicClient, await creditGraph.write.setRecorder([factory.address, true]));
  await waitFor(publicClient, await factory.write.setRecognizedTokens([ausd.address, usdt.address]));
  await waitFor(publicClient, await factory.write.setTreasuryByAdmin([dep]));
  await waitFor(publicClient, await dl.write.grantRole([minterRole, factory.address]));

  const mintAmount = 10_000_000n * ONE;
  for (const token of [dl, ausd, usdt, wrappedNative]) {
    await waitFor(publicClient, await token.write.mint([dep, mintAmount]));
  }

  async function createInitPair(tokenAddr: Address) {
    await waitFor(publicClient, await dealPairManager.write.createPair([tokenAddr, 3, 1000]));
    const pair = await dealPairManager.read.pairForToken([tokenAddr]);
    await waitFor(publicClient, await dl.write.transfer([pair, 1_000_000n * ONE]));
    const t = await viem.getContractAt("DCToken", tokenAddr, { client });
    await waitFor(publicClient, await t.write.transfer([pair, 1_000_000n * ONE]));
    await waitFor(publicClient, await dealPairManager.write.initPair([pair, 0n]));
    return pair;
  }

  const pairAusd = await createInitPair(ausd.address);
  const pairUsdt = await createInitPair(usdt.address);
  console.log("pair DC↔AUSD", pairAusd, "pair DC↔USDT", pairUsdt);
  await waitFor(publicClient, await infoNft.write.setMintPriceU([pairAusd, 88n * ONE]));
  console.log("DealInfoNFT mint price set to 88 U via DC↔AUSD pair");

  // —— Order book + router ——
  const orderBook = await viem.deployContract("DealSwapOrderBook", [dep], { client });
  console.log("DealSwapOrderBook", orderBook.address);

  await waitFor(publicClient, await factory.write.setOpsGlobals([orderBook.address, zeroAddress, zeroAddress]));

  const router = await viem.deployContract("DealRouter", [wrappedNative.address, orderBook.address], {
    client,
  });
  console.log("DealRouter", router.address);

  await waitFor(publicClient, await orderBook.write.setRouter([router.address]));

  // —— Reader (stateless) ——
  const dealReader = await viem.deployContract("DealReader", [], { client });
  console.log("DealReader", dealReader.address);

  // —— DC domain stack (registration = DealCoin/DC, rank stake = AUSD) ——
  const dcDomain = await viem.deployContract("DCDomain", [dl.address, dep], { client });
  console.log("DCDomain", dcDomain.address);

  const dcRank = await viem.deployContract("DCDomainRank", [dl.address, dcDomain.address, dep], { client });
  console.log("DCDomainRank", dcRank.address);
  const dcRankReader = await viem.deployContract("DCDomainRankReader", [dcRank.address], { client });
  console.log("DCDomainRankReader", dcRankReader.address);
  const dcDomainListReader = await viem.deployContract("DCDomainListReader", [dcDomain.address, dcRank.address], { client });
  console.log("DCDomainListReader", dcDomainListReader.address);
  await waitFor(publicClient, await factory.write.setOpsGlobals([zeroAddress, zeroAddress, dcRank.address]));
  await waitFor(publicClient, await dcRank.write.setAutoCloser([factory.address]));

  const dcMarket = await viem.deployContract(
    "DCDomainMarket",
    [dcDomain.address, dl.address, dep, 100n],
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

  await waitFor(publicClient, await factory.write.setAllowedCreateFor([dcSwap.address, true]));
  await waitFor(publicClient, await factory.write.setAllowedCreateFor([dcHall.address, true]));
  await waitFor(publicClient, await dcRank.write.setDealReporter([dcSwap.address, true]));
  await waitFor(publicClient, await dcRank.write.setDealReporter([dcHall.address, true]));
  console.log("Domain entry permissions OK");

  // —— Governance (D + seat-veto governor) ——
  const dInitialHolder = (process.env.D_INITIAL_HOLDER?.trim() || dep) as Address;
  const dToken = await viem.deployContract("D", [dInitialHolder], { client });
  console.log("D (votes)", dToken.address);
  console.log("D initial holder", dInitialHolder);

  const nftActivity = await viem.deployContract("DealNftGovernanceActivity", [infoNft.address], { client });
  console.log("DealNftGovernanceActivity", nftActivity.address);
  await waitFor(publicClient, await factory.write.setOpsGlobals([zeroAddress, nftActivity.address, zeroAddress]));

  const nftVetoRegistry = await viem.deployContract("NftVetoRegistry", [infoNft.address, nftActivity.address], { client });
  console.log("NftVetoRegistry", nftVetoRegistry.address);

  const seatVetoGovernor = await viem.deployContract("DealSeatVetoGovernor", [dToken.address, nftVetoRegistry.address], { client });
  console.log("DealSeatVetoGovernor", seatVetoGovernor.address);
  await waitFor(publicClient, await nftVetoRegistry.write.setGovernor([seatVetoGovernor.address, true]));
  await waitFor(publicClient, await nftActivity.write.setRecorder([factory.address, true]));
  await waitFor(publicClient, await nftActivity.write.setRecorder([nftVetoRegistry.address, true]));

  // —— Vote dividend (DealCoin/DC as payout token) ——
  const dividendExecutor = (process.env.DIVIDEND_EXECUTOR?.trim() || dep) as Address;
  const dividendSource = (process.env.DIVIDEND_SOURCE?.trim() || dep) as Address;
  const voteClaimer = await viem.deployContract(
    "VoteDividendClaimer",
    [dToken.address, dl.address, dividendExecutor, dividendSource],
    { client },
  );
  console.log("VoteDividendClaimer", voteClaimer.address);
  console.log("Dividend executor", dividendExecutor);
  console.log("Dividend source", dividendSource);
  await waitFor(publicClient, await nftActivity.write.setRecorder([voteClaimer.address, true]));
  await waitFor(publicClient, await voteClaimer.write.setGovernanceActivity([infoNft.address, nftActivity.address]));

  const addresses = {
    dlToken: dl.address,
    ausd: ausd.address,
    usdt: usdt.address,
    wrappedNative: wrappedNative.address,
    dealLib: dealLib.address,
    dealAssetNftLib: dealAssetNftLib.address,
    dealImplementation: dealImpl.address,
    dealNoAssetImplementation: dealNoAssetImpl.address,
    dealAAssetNftImplementation: dealAAssetNftImpl.address,
    dealBAssetNftImplementation: dealBAssetNftImpl.address,
    dealAAssetNftOnlyImplementation: dealAAssetNftOnlyImpl.address,
    dealBAssetNftOnlyImplementation: dealBAssetNftOnlyImpl.address,
    dealOpenTokenTokenImplementation: dealOpenTokenTokenImpl.address,
    dealImplementationRegistry: dealImplementationRegistry.address,
    pairImplementation: pairImpl.address,
    dealFactory: factory.address,
    dealPairManager: dealPairManager.address,
    dealMessageHub: dealMessageHub.address,
    dealCreditGraph: creditGraph.address,
    dealActivityIndex: dealActivityIndex.address,
    dealResultIndex: dealResultIndex.address,
    dealInfoNFT: infoNft.address,
    pairDlAusd: pairAusd,
    pairDlUsdt: pairUsdt,
    dealSwapOrderBook: orderBook.address,
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
    addresses,
    abi: {
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
    },
    notes: [
      "Deal chat storage is externalized through DealMessageHub; Deal.postMessage remains available, and readers should use the hub for message pagination.",
      "Deal process timelines and final reward/credit records are indexed through DealResultIndex; readers should use it instead of scanning historical deal logs.",
      "DCDomain registration / DCDomainMarket / DCDomainRank use DealCoin (DC) as payment and ranking token; treasury = deployer.",
      "DCDomainSwap and DCDomainHall are allowlisted on DealFactory and can create domain-scoped deals through the current Factory ABI.",
      "Test-only contracts (TestWNative, ExampleAdminTarget, GovHelper, duplicate test governors) are intentionally not deployed.",
    ],
  };

  const dir = join(process.cwd(), "deployments");
  mkdirSync(dir, { recursive: true });
  const backupDir = join(dir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const file = join(dir, `agiking-${AGIKING_CHAIN_ID}.json`);
  const stamp = deployedAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  if (existsSync(file)) {
    copyFileSync(file, join(backupDir, `agiking-${AGIKING_CHAIN_ID}.before-full-redeploy-${stamp}.json`));
  }
  writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
  const handoffFile = join(dir, `frontend-handoff-agiking-${AGIKING_CHAIN_ID}-${stamp}.md`);
  writeFrontendHandoff(handoffFile, deployedAt, dep, addresses);
  writeFrontendHandoff(join(process.cwd(), "docs", "前端部署地址交接文档.md"), deployedAt, dep, addresses);
  console.log("Wrote", file);
  console.log("Wrote", handoffFile);
  console.log("Wrote", join(process.cwd(), "docs", "前端部署地址交接文档.md"));
  console.log(JSON.stringify(addresses, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
