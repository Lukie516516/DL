import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, getAddress, zeroAddress, type Address } from "viem";

const ONE = 10n ** 18n;
const WEI = 1n;
const GWEI = 10n ** 9n;
const GAS_PRICE = BigInt(process.env.AGIKING_GAS_PRICE_GWEI ?? "2") * GWEI;
const AGIKING_CHAIN_ID = 31415926;

const SATOSHI_ACCOUNT = getAddress("0xa66BB85467AA820F294934D947a2630bb6761483") as Address;
const MARKET_MAKER_ACCOUNT = getAddress("0xeB8B726a72aeCA86fbf3e1932f97834243f967Ef") as Address;

const SATOSHI_DC = 5_000_000_000n * ONE;
const MARKET_MAKER_DC = 500_000_000n * ONE;

const PAIR_USDT_REAL_DC = 500_000_000n * ONE;
const PAIR_USDT_REAL_OTHER = WEI;
const PAIR_USDT_VIRTUAL_OTHER = 50_000n * ONE;

const PAIR_AUSD_REAL_DC = 500_000_000n * ONE;
const PAIR_AUSD_REAL_OTHER = WEI;
const PAIR_AUSD_VIRTUAL_OTHER = 200_000n * ONE;

const PAIR_AGI_REAL_DC = 50_000_000n * ONE;
const PAIR_AGI_REAL_OTHER = WEI;
const PAIR_AGI_VIRTUAL_OTHER = 50_000n * ONE;

const P: Record<string, Address> = {
  dlToken: "0x802c43662c38aad9b4299c2f723a6b16f228217a",
  ausd: "0xa6f5539dab221a6d4506c88ef461f0b4fca13f35",
  usdt: "0xd4940de68d2ac09aabad8342dab845c0cb42efe5",
  wrappedNative: "0x391747e54d24aa8cef1388fe1c13f8fd57051153",
  agi: "0x391747e54d24aa8cef1388fe1c13f8fd57051153",
  dealLib: "0x855a5fd643dcfc60b9740f3fefba69dc5e20df0d",
  dealAssetNftLib: "0xa937721bf80d91fe0feea4ea9cf2c5a08c3b6eba",
  dealImplementation: "0xd198726d2033542b26259245a03f441fac707305",
  dealNoAssetImplementation: "0x75f05eebe36c1c5100bee17805be3a14a264b04e",
  dealAAssetNftImplementation: "0xe0a662c5e8634a736774b5eabf88f142245441df",
  dealBAssetNftImplementation: "0x021e3d76a09bdfd46dd3c17ad28f176ebe9d0e46",
  dealAAssetNftOnlyImplementation: "0x905c72dd8ea5153ecc30b47817c199e7b122f8e0",
  dealBAssetNftOnlyImplementation: "0xd2c7df0d5f843f219582c4f75f1b10cb93ddf1c7",
  dealOpenTokenTokenImplementation: "0x09e457e3583c15fa3219716c60ca3c7ce1b542c4",
  pairImplementation: "0x5555c709bcaf2423155b2c0f3da236351ccdb6c5",
  dealFactory: "0x4adaa0097cd4ba6f93b468d869072e2daa17bc2e",
  dealPairManager: "0x32af581d3a9f7e630aa2c8fccb6a559372b19c2a",
  dealMessageHub: "0x8170dd805d78d399542c30b922b2c2a5605b848e",
  dealActivityIndex: "0x299cb40f3395629d6cc8dfa0d3a413d0da9098c0",
  dealResultIndex: "0x8947874ad9c28379ec35263ffbb4d862b9d9f154",
  dealImplementationRegistry: "0x36b4ac38253daf1a61bd601eefa2e495c96652ab",
  dealInfoNFT: "0x7e4ed273fac90a87ea4c2205b7c37d4a31b08844",
  dealInfoNFTRenderer: "0xa62eef802cb4b29d5d2300c024aff30d9a8a57ff",
  dealCreditGraph: "0x186312887782596fbe83c964b734b485110da4ad",
};

function agikingChain(rpcUrl: string) {
  return defineChain({
    id: AGIKING_CHAIN_ID,
    name: "Agiking",
    nativeCurrency: { decimals: 18, name: "AGI", symbol: "AGI" },
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

async function deploy(viem: any, name: string, args: unknown[], client: unknown) {
  const c = await viem.deployContract(name, args, { client, gasPrice: GAS_PRICE });
  console.log(name, c.address);
  return withGas(c);
}

function withGas<T extends Record<string, any>>(contract: T): T {
  return new Proxy(contract, {
    get(target, prop, receiver) {
      if (prop !== "write") return Reflect.get(target, prop, receiver);
      const write = Reflect.get(target, prop, receiver);
      return new Proxy(write, {
        get(writeTarget, method, writeReceiver) {
          const fn = Reflect.get(writeTarget, method, writeReceiver);
          if (typeof fn !== "function") return fn;
          return (first?: unknown, second?: Record<string, unknown>) => {
            if (Array.isArray(first)) return fn(first, { gasPrice: GAS_PRICE, ...(second ?? {}) });
            return fn({ gasPrice: GAS_PRICE, ...((first as Record<string, unknown>) ?? {}) });
          };
        },
      });
    },
  });
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
    WrappedAGI: loadAbi("WrappedAGI.sol/WrappedAGI.json"),
    DealFactory: loadAbi("DealFactory.sol/DealFactory.json"),
    DealPairManager: loadAbi("DealPairManager.sol/DealPairManager.json"),
    DealMessageHub: loadAbi("DealMessageHub.sol/DealMessageHub.json"),
    DealCreditGraph: loadAbi("DealCreditGraph.sol/DealCreditGraph.json"),
    DealActivityIndex: loadAbi("DealActivityIndex.sol/DealActivityIndex.json"),
    DealResultIndex: loadAbi("DealResultIndex.sol/DealResultIndex.json"),
    DealInfoNFT: loadAbi("DealInfoNft.sol/DealInfoNFT.json"),
    DealInfoNFTRenderer: loadAbi("DealInfoNFTRenderer.sol/DealInfoNFTRenderer.json"),
    DealSwapOrderBook: loadAbi("DealSwapOrderBook.sol/DealSwapOrderBook.json"),
    DealRouter: loadAbi("DealSwapRouter.sol/DealRouter.json"),
    DealRouterQuoter: loadAbi("DealRouterQuoter.sol/DealRouterQuoter.json"),
    DealSwapAssetRegistry: loadAbi("DealSwapAssetRegistry.sol/DealSwapAssetRegistry.json"),
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

> 这次是整套正式初始化重新部署。前端请以本文件和 \`deployments/agiking-31415926.json\` 为准，不要继续使用旧地址。

## 前端主接入地址

| 模块 | 地址 | 前端用途 |
| --- | --- | --- |
| DealFactory | \`${addresses.dealFactory}\` | 创建 deal、读取工厂配置、索引当前 deal |
| DealMessageHub | \`${addresses.dealMessageHub}\` | 留言上链入口 |
| DealReader | \`${addresses.dealReader}\` | 聚合读取 deal 列表/详情 |
| DealActivityIndex | \`${addresses.dealActivityIndex}\` | 用户活动索引 |
| DealResultIndex | \`${addresses.dealResultIndex}\` | 奖励、信用增量、交易过程时间线 |
| DealPairManager | \`${addresses.dealPairManager}\` | pair/TWAP/虚拟流动性管理 |
| DealCreditGraph | \`${addresses.dealCreditGraph}\` | 官方 InfoNFT 信用分 |
| DealInfoNFT | \`${addresses.dealInfoNFT}\` | 官方身份 NFT |
| DealOpenTokenToken implementation | \`${addresses.dealOpenTokenTokenImplementation}\` | 公开币币单模板 ABI |
| DCDomainSwap | \`${addresses.dcDomainSwap}\` | 域名入口创建普通 deal |
| DCDomainHall | \`${addresses.dcDomainHall}\` | 域名大厅/匹配入口 |
| DCDomain | \`${addresses.dcDomain}\` | 域名 NFT |
| DCDomainRank | \`${addresses.dcDomainRank}\` | 域名黑名单、广告充值/结算、域名收益 |
| DCDomainRankReader | \`${addresses.dcDomainRankReader}\` | 域名排行榜分页、deal 搜索/统计 |
| DCDomainListReader | \`${addresses.dcDomainListReader}\` | 域名列表分页、排序、搜索、我的域名 |
| DCDomainMarket | \`${addresses.dcDomainMarket}\` | 域名市场 |
| DealCoin/DC | \`${addresses.dlToken}\` | 主代币 DC |
| AUSD | \`${addresses.ausd}\` | 官方 AUSD |
| USDT | \`${addresses.usdt}\` | 官方 USDT |
| WAGI | \`${addresses.wrappedNative}\` | 包装原生 AGI |
| DealSwapAssetRegistry | \`${addresses.dealSwapAssetRegistry}\` | 前端读取三组官方 swap pair |
| DealRouter | \`${addresses.dealRouter}\` | swap/router |
| DealSwapOrderBook | \`${addresses.dealSwapOrderBook}\` | swap order book |
| D | \`${addresses.dToken}\` | DAO/分红权代币 |
| VoteDividendClaimer | \`${addresses.voteDividendClaimer}\` | D 持有人分红领取 |

## DEX 初始口径

| Pair | 真实 DC | 真实另一侧 | 虚拟另一侧 |
| --- | ---: | ---: | ---: |
| DC/USDT | 500,000,000 DC | 1 wei USDT | 50,000 USDT |
| DC/AUSD | 500,000,000 DC | 1 wei AUSD | 200,000 AUSD |
| DC/WAGI | 50,000,000 DC | 1 wei WAGI | 50,000 AGI |

## 初始 DC 发放

| 账户 | 地址 | 数量 |
| --- | --- | ---: |
| 中本聪账户 | \`${SATOSHI_ACCOUNT}\` | 5,000,000,000 DC |
| 做市商账户 | \`${MARKET_MAKER_ACCOUNT}\` | 500,000,000 DC |

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
  const dep = deployer.account.address as Address;
  console.log("Resume formal deploy", chain.id, dep, "gasPrice", GAS_PRICE.toString());

  const dl = withGas(await viem.getContractAt("DCToken", P.dlToken, { client }));
  const ausd = withGas(await viem.getContractAt("DCToken", P.ausd, { client }));
  const usdt = withGas(await viem.getContractAt("DCToken", P.usdt, { client }));
  const wrappedNative = withGas(await viem.getContractAt("WrappedAGI", P.wrappedNative, { client }));
  const factory = withGas(await viem.getContractAt("DealFactory", P.dealFactory, { client }));
  const dealPairManager = withGas(await viem.getContractAt("DealPairManager", P.dealPairManager, { client }));
  const infoNft = withGas(await viem.getContractAt("DealInfoNFT", P.dealInfoNFT, { client }));

  async function ensureBalance(token: any, to: Address, target: bigint, label: string) {
    const current = await token.read.balanceOf([to]);
    if (current >= target) {
      console.log(`  SKIP ${label}`);
      return;
    }
    await tx(label, publicClient, token.write.transfer([to, target - current]));
  }

  await ensureBalance(dl, SATOSHI_ACCOUNT, SATOSHI_DC, "DC transfer to satoshi");
  await ensureBalance(dl, MARKET_MAKER_ACCOUNT, MARKET_MAKER_DC, "DC transfer to market maker");

  async function createInitPair(token: any, tokenAddr: Address, realDc: bigint, realOther: bigint, virtualOther: bigint) {
    let pair = await dealPairManager.read.pairForToken([tokenAddr]);
    if (pair === zeroAddress) {
      await tx(`createPair ${tokenAddr}`, publicClient, dealPairManager.write.createPair([tokenAddr, 3, 1000]));
      pair = await dealPairManager.read.pairForToken([tokenAddr]);
    }
    await ensureBalance(dl, pair, realDc, `DC transfer to pair ${pair}`);
    await ensureBalance(token, pair, realOther, `OTHER transfer to pair ${pair}`);
    const pairContract = await viem.getContractAt("DealSwapTemplate", pair, { client });
    const inited = await pairContract.read.liquidityInited();
    if (!inited) {
      await tx(`initPair ${pair}`, publicClient, dealPairManager.write.initPair([pair, virtualOther]));
    } else {
      console.log(`  SKIP initPair ${pair}`);
    }
    return pair as Address;
  }

  const wagiBalance = await wrappedNative.read.balanceOf([dep]);
  if (wagiBalance < PAIR_AGI_REAL_OTHER) {
    await tx("WAGI deposit 1 wei", publicClient, wrappedNative.write.deposit({ value: PAIR_AGI_REAL_OTHER - wagiBalance }));
  }

  const pairAusd = await createInitPair(ausd, P.ausd, PAIR_AUSD_REAL_DC, PAIR_AUSD_REAL_OTHER, PAIR_AUSD_VIRTUAL_OTHER);
  const pairUsdt = await createInitPair(usdt, P.usdt, PAIR_USDT_REAL_DC, PAIR_USDT_REAL_OTHER, PAIR_USDT_VIRTUAL_OTHER);
  const pairAgi = await createInitPair(wrappedNative, P.wrappedNative, PAIR_AGI_REAL_DC, PAIR_AGI_REAL_OTHER, PAIR_AGI_VIRTUAL_OTHER);
  await tx("InfoNFT mint price 88 DC", publicClient, infoNft.write.setMintPriceU([zeroAddress, 88n * ONE]));

  const orderBook = await deploy(viem, "DealSwapOrderBook", [dep], client);
  await tx("Factory.setOpsGlobals orderBook", publicClient, factory.write.setOpsGlobals([orderBook.address, zeroAddress, zeroAddress]));
  const router = await deploy(viem, "DealRouter", [P.wrappedNative, orderBook.address], client);
  const routerQuoter = await deploy(viem, "DealRouterQuoter", [orderBook.address], client);
  await tx("OrderBook.setRouter", publicClient, orderBook.write.setRouter([router.address]));
  const swapAssetRegistry = await deploy(viem, "DealSwapAssetRegistry", [
    dep,
    P.dealPairManager,
    router.address,
    P.dlToken,
    P.wrappedNative,
    P.usdt,
    P.ausd,
  ], client);

  const dealReader = await deploy(viem, "DealReader", [], client);
  const dcDomain = await deploy(viem, "DCDomain", [P.dlToken, dep], client);
  const dcRank = await deploy(viem, "DCDomainRank", [P.dlToken, dcDomain.address, dep], client);
  const dcRankReader = await deploy(viem, "DCDomainRankReader", [dcRank.address], client);
  const dcDomainListReader = await deploy(viem, "DCDomainListReader", [dcDomain.address, dcRank.address], client);
  await tx("Factory.setOpsGlobals dcDomainRank", publicClient, factory.write.setOpsGlobals([zeroAddress, zeroAddress, dcRank.address]));
  await tx("Rank.setAutoCloser", publicClient, dcRank.write.setAutoCloser([P.dealFactory]));
  const dcMarket = await deploy(viem, "DCDomainMarket", [dcDomain.address, P.dlToken, dep, 100n], client);
  await tx("DCDomain.setDomainMarket", publicClient, dcDomain.write.setDomainMarket([dcMarket.address]));
  const dcSwap = await deploy(viem, "DCDomainSwap", [dcDomain.address, dcRank.address, P.dealFactory], client);
  const dcHall = await deploy(viem, "DCDomainHall", [dcRank.address, dcDomain.address, P.dealFactory], client);
  await tx("Factory.allow DCDomainSwap", publicClient, factory.write.setAllowedCreateFor([dcSwap.address, true]));
  await tx("Factory.allow DCDomainHall", publicClient, factory.write.setAllowedCreateFor([dcHall.address, true]));
  await tx("Rank.reporter DCDomainSwap", publicClient, dcRank.write.setDealReporter([dcSwap.address, true]));
  await tx("Rank.reporter DCDomainHall", publicClient, dcRank.write.setDealReporter([dcHall.address, true]));

  const dToken = await deploy(viem, "D", [(process.env.D_INITIAL_HOLDER?.trim() || dep) as Address], client);
  const nftActivity = await deploy(viem, "DealNftGovernanceActivity", [P.dealInfoNFT], client);
  await tx("Factory.setOpsGlobals activity", publicClient, factory.write.setOpsGlobals([zeroAddress, nftActivity.address, zeroAddress]));
  const nftVetoRegistry = await deploy(viem, "NftVetoRegistry", [P.dealInfoNFT, nftActivity.address], client);
  const seatVetoGovernor = await deploy(viem, "DealSeatVetoGovernor", [dToken.address, nftVetoRegistry.address], client);
  await tx("NftVetoRegistry.setGovernor", publicClient, nftVetoRegistry.write.setGovernor([seatVetoGovernor.address, true]));
  await tx("NftActivity.recorder Factory", publicClient, nftActivity.write.setRecorder([P.dealFactory, true]));
  await tx("NftActivity.recorder NftVetoRegistry", publicClient, nftActivity.write.setRecorder([nftVetoRegistry.address, true]));
  const voteClaimer = await deploy(viem, "VoteDividendClaimer", [
    dToken.address,
    P.dlToken,
    (process.env.DIVIDEND_EXECUTOR?.trim() || dep) as Address,
    (process.env.DIVIDEND_SOURCE?.trim() || dep) as Address,
  ], client);
  await tx("NftActivity.recorder VoteDividendClaimer", publicClient, nftActivity.write.setRecorder([voteClaimer.address, true]));
  await tx("VoteDividendClaimer.setGovernanceActivity", publicClient, voteClaimer.write.setGovernanceActivity([P.dealInfoNFT, nftActivity.address]));

  const addresses: Record<string, Address> = {
    ...P,
    pairDlAusd: pairAusd,
    pairDlUsdt: pairUsdt,
    pairDlAgi: pairAgi,
    dealSwapOrderBook: orderBook.address,
    dealRouter: router.address,
    dealRouterQuoter: routerQuoter.address,
    dealSwapAssetRegistry: swapAssetRegistry.address,
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
    abi: deploymentAbi(),
  };
  const dir = join(process.cwd(), "deployments");
  mkdirSync(dir, { recursive: true });
  const backupDir = join(dir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const file = join(dir, `agiking-${AGIKING_CHAIN_ID}.json`);
  const stamp = deployedAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  if (existsSync(file)) copyFileSync(file, join(backupDir, `agiking-${AGIKING_CHAIN_ID}.before-formal-resume-${stamp}.json`));
  writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
  const handoff = join(dir, `frontend-handoff-agiking-${AGIKING_CHAIN_ID}-${stamp}.md`);
  writeFrontendHandoff(handoff, deployedAt, dep, addresses);
  writeFrontendHandoff(join(process.cwd(), "docs", "前端部署地址交接文档.md"), deployedAt, dep, addresses);
  console.log("Wrote", file);
  console.log("Wrote", handoff);
  console.log(JSON.stringify(addresses, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
