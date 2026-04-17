/**
 * Agiking 链上：探测「虚拟 OTHER 深度」(token1BalanceInit) 与挂单砸穿行为。
 *
 * 用法：
 *   1) 只读（无需私钥）——看已部署 DL↔AUSD / DL↔USDT 池是否带虚拟垫高
 *      npx tsx scripts/agiking-virtual-smash-probe.ts
 *
 *   2) 完整沙盒（需 DealFactory owner 私钥，会发链上交易：部署测试币、建池、init 虚拟深度、试 placeSellDL）
 *      set AGIKING_PRIVATE_KEY=0x...
 *      npx tsx scripts/agiking-virtual-smash-probe.ts --sandbox
 *
 * 环境变量：
 *   AGIKING_RPC_URL — 默认读 deployments/agiking-31415926.json 里的 rpcUrl
 *   AGIKING_PRIVATE_KEY — 可选；与 --sandbox 一起用于发交易
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const AGIKING_CHAIN_ID = 31415926n;
const ONE = 10n ** 18n;

type Deployment = {
  chainId: number;
  rpcUrl: string;
  addresses: Record<string, Address>;
};

function loadDeployment(): Deployment {
  const p = join(process.cwd(), "deployments", "agiking-31415926.json");
  return JSON.parse(readFileSync(p, "utf8")) as Deployment;
}

const abiPair = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token1BalanceInit() view returns (uint256)",
]);

const abiErc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
]);

const abiFactory = parseAbi([
  "function owner() view returns (address)",
  "function createPair(address tokenOther,uint32 feeNum,uint32 feeDen) returns (address)",
  "function initPair(address pair,uint256 _b1) returns (uint256,uint256)",
  "function pairForToken(address) view returns (address)",
]);

const abiOrderBook = parseAbi([
  "function placeSellDL(address pair,uint256 amount0In) returns (uint256,uint256,uint256)",
  "function maxImmediateSellIn(address pair) view returns (uint256)",
]);

const abiDCTokenJson = JSON.parse(
  readFileSync(join(process.cwd(), "artifacts", "contracts", "DL.sol", "DCToken.json"), "utf8"),
) as { abi: readonly unknown[]; bytecode: Hex };

async function probePair(
  publicClient: ReturnType<typeof createPublicClient>,
  label: string,
  pair: Address,
) {
  const t1 = await publicClient.readContract({ address: pair, abi: abiPair, functionName: "token1" });
  const reserves = await publicClient.readContract({ address: pair, abi: abiPair, functionName: "getReserves" });
  const init1 = await publicClient.readContract({
    address: pair,
    abi: abiPair,
    functionName: "token1BalanceInit",
  });
  const r0 = reserves[0];
  const r1 = reserves[1];
  const real1 = await publicClient.readContract({
    address: t1,
    abi: abiErc20,
    functionName: "balanceOf",
    args: [pair],
  });
  let sym = "?";
  try {
    sym = await publicClient.readContract({ address: t1, abi: abiErc20, functionName: "symbol" });
  } catch {
    /* ignore */
  }

  console.log(`\n--- ${label} ${pair} ---`);
  console.log(`  token1 (${sym}): ${t1}`);
  console.log(`  token1BalanceInit (虚拟垫高): ${init1.toString()}`);
  console.log(`  getReserves r0/r1 (会计):     ${r0.toString()} / ${r1.toString()}`);
  console.log(`  真实 token1 在池余额:        ${real1.toString()}`);
  if (init1.result === 0n) {
    console.log("  => 当前池 init 为 0，与主网部署脚本一致；「虚拟砸穿」需在沙盒池复现。");
  } else if (real1 < r1) {
    console.log("  => 会计 r1 大于真实余额，存在虚拟垫高；大额卖单可能因 OTHER 不足 revert。");
  }
}

async function readOnlyMain() {
  const dep = loadDeployment();
  const rpcUrl = process.env.AGIKING_RPC_URL?.trim() || dep.rpcUrl;
  const chain = defineChain({
    id: Number(AGIKING_CHAIN_ID),
    name: "Agiking",
    nativeCurrency: { name: "N", symbol: "N", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  const { pairDlAusd, pairDlUsdt, dealFactory } = dep.addresses;
  console.log(`RPC: ${rpcUrl}`);
  console.log(`DealFactory: ${dealFactory}`);

  const fo = await publicClient.readContract({
    address: dealFactory,
    abi: abiFactory,
    functionName: "owner",
  });
  console.log(`Factory owner: ${fo}`);

  await probePair(publicClient, "DL↔AUSD", pairDlAusd);
  await probePair(publicClient, "DL↔USDT", pairDlUsdt);

  const ob = dep.addresses.dealSwapOrderBook;
  const maxA = await publicClient.readContract({
    address: ob,
    abi: abiOrderBook,
    functionName: "maxImmediateSellIn",
    args: [pairDlAusd],
  });
  const maxU = await publicClient.readContract({
    address: ob,
    abi: abiOrderBook,
    functionName: "maxImmediateSellIn",
    args: [pairDlUsdt],
  });
  console.log(`\nOrderBook maxImmediateSellIn(AUSD pair): ${maxA.toString()}`);
  console.log(`OrderBook maxImmediateSellIn(USDT pair): ${maxU.toString()}`);
}

async function sandboxMain() {
  const pk = process.env.AGIKING_PRIVATE_KEY?.trim();
  if (!pk?.startsWith("0x")) {
    console.error("缺少 AGIKING_PRIVATE_KEY（0x 开头），无法执行 --sandbox");
    process.exit(1);
  }

  const dep = loadDeployment();
  const rpcUrl = process.env.AGIKING_RPC_URL?.trim() || dep.rpcUrl;
  const chain = defineChain({
    id: Number(AGIKING_CHAIN_ID),
    name: "Agiking",
    nativeCurrency: { name: "N", symbol: "N", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const account = privateKeyToAccount(pk as Hex);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const factory = dep.addresses.dealFactory;
  const dl = dep.addresses.dlToken;
  const orderBook = dep.addresses.dealSwapOrderBook;

  const owner = await publicClient.readContract({ address: factory, abi: abiFactory, functionName: "owner" });
  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    console.error(`当前钱包 ${account.address} 不是 DealFactory owner (${owner})，无法 createPair/initPair。`);
    process.exit(1);
  }

  console.log("Sandbox: 部署临时 OTHER、建池、虚拟 init、试砸穿 placeSellDL …");

  const deployHash = await walletClient.deployContract({
    abi: abiDCTokenJson.abi,
    bytecode: abiDCTokenJson.bytecode,
    args: ["VirtSmash Other", "VSO", 0n, account.address, account.address],
  });
  const deployRc = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  const vso = deployRc.contractAddress;
  if (!vso) {
    console.error("部署 VSO 失败");
    process.exit(1);
  }
  console.log("VSO token:", vso);

  const createHash = await walletClient.writeContract({
    address: factory,
    abi: abiFactory,
    functionName: "createPair",
    args: [vso, 3, 1000],
  });
  await publicClient.waitForTransactionReceipt({ hash: createHash });
  const pair = await publicClient.readContract({
    address: factory,
    abi: abiFactory,
    functionName: "pairForToken",
    args: [vso],
  });
  console.log("Sandbox pair:", pair);

  const tokenWalletAbi = parseAbi([
    "function mint(address to,uint256 amount) external",
    "function approve(address spender,uint256 amount) external returns (bool)",
    "function transfer(address to,uint256 amount) external returns (bool)",
  ]);

  const fundDl = 1_000n * ONE;
  const fundVsoReal = 10n * ONE;
  const virtualB1 = 90n * ONE;

  await walletClient.writeContract({
    address: dl,
    abi: tokenWalletAbi,
    functionName: "mint",
    args: [account.address, fundDl * 2n],
  });
  await walletClient.writeContract({
    address: vso,
    abi: tokenWalletAbi,
    functionName: "mint",
    args: [account.address, fundVsoReal * 2n],
  });

  await walletClient.writeContract({
    address: dl,
    abi: tokenWalletAbi,
    functionName: "transfer",
    args: [pair, fundDl],
  });
  await walletClient.writeContract({
    address: vso,
    abi: tokenWalletAbi,
    functionName: "transfer",
    args: [pair, fundVsoReal],
  });

  const initHash = await walletClient.writeContract({
    address: factory,
    abi: abiFactory,
    functionName: "initPair",
    args: [pair, virtualB1],
  });
  await publicClient.waitForTransactionReceipt({ hash: initHash });

  await probePair(publicClient, "沙盒池", pair);

  const probeIn = 200n * ONE;
  const quoteSellAbi = parseAbi([
    "function quoteSell(uint256 amount0In) view returns (uint256 feeIn,uint256 out1)",
  ]);
  const qSell = await publicClient.readContract({
    address: pair,
    abi: quoteSellAbi,
    functionName: "quoteSell",
    args: [probeIn],
  });
  const qOut1 = qSell[1];
  const real1 = await publicClient.readContract({
    address: vso,
    abi: abiErc20,
    functionName: "balanceOf",
    args: [pair],
  });
  console.log(`\nquoteSell(${probeIn}) => out1=${qOut1}, 真实 VSO 余额=${real1}`);
  if (qOut1 <= real1) {
    console.log("注意: 当前参数下 quote 未超过真实余额，可适当增大 probeIn 或调整虚拟/实仓比例。");
  }

  await walletClient.writeContract({
    address: dl,
    abi: tokenWalletAbi,
    functionName: "approve",
    args: [orderBook, probeIn],
  });

  console.log("\n模拟 placeSellDL（应因 OTHER 不足 revert）…");
  try {
    await publicClient.simulateContract({
      address: orderBook,
      abi: abiOrderBook,
      functionName: "placeSellDL",
      args: [pair, probeIn],
      account: account.address,
    });
    console.error("预期应 revert，但 simulate 成功 — 请检查池参数。");
    process.exit(1);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("simulate 失败（符合预期）:", msg.slice(0, 200));
  }

  console.log("\n沙盒完成。VSO / 新 pair 留在链上，仅用于测试；如需清理可 owner 自行处理。");
}

const sandbox = process.argv.includes("--sandbox");

if (sandbox) {
  await sandboxMain();
} else {
  await readOnlyMain();
  console.log(
    "\n若要在链上完整复现「虚拟砸穿 + placeSellDL」，请使用工厂 owner 私钥并执行:\n" +
      "  set AGIKING_PRIVATE_KEY=0x...\n" +
      "  npx tsx scripts/agiking-virtual-smash-probe.ts --sandbox",
  );
}
