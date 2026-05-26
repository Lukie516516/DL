/**
 * Add the official AGI swap lane without redeploying Deal templates:
 * - deploy a real WETH-style WrappedAGI unless AGI_TOKEN_ADDRESS is provided
 * - set DealFactory.wrappedNative to AGI/WAGI
 * - create/init DL-AGI pair
 * - redeploy DealRouter with the new wrapped native token
 * - deploy DealSwapAssetRegistry for frontend pair discovery
 * - merge addresses + ABIs into deployments/agiking-31415926.json
 *
 * Usage:
 *   AGIKING_RPC_URL=... AGIKING_PRIVATE_KEY=... \
 *   PAIR_INIT_DL=1000000000000000000000000 \
 *   PAIR_INIT_AGI=1000000000000000000000000 \
 *   npx hardhat run scripts/deploy-agiking-agi-swap.ts --network agiking
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, getAddress, type Address } from "viem";

const AGIKING_CHAIN_ID = 31415926;
const DEPLOYMENT_FILE = "agiking-31415926.json";
const ZERO = "0x0000000000000000000000000000000000000000" as const;

type DeploymentJson = {
  chainId: number;
  rpcUrl: string;
  deployedAt: string;
  deployer: string;
  addresses: Record<string, string>;
  abi: Record<string, unknown[]>;
};

function agikingChain(rpcUrl: string) {
  return defineChain({
    id: AGIKING_CHAIN_ID,
    name: "Agiking",
    nativeCurrency: { decimals: 18, name: "AGI", symbol: "AGI" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function envBigInt(key: string): bigint | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  return BigInt(raw);
}

function envAddress(key: string): Address | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) throw new Error(`Invalid ${key}: ${raw}`);
  return getAddress(raw) as Address;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

function loadDeployment(): DeploymentJson {
  return JSON.parse(readFileSync(join(process.cwd(), "deployments", DEPLOYMENT_FILE), "utf8")) as DeploymentJson;
}

function loadAbi(relativeArtifactJson: string): unknown[] {
  const p = join(process.cwd(), "artifacts", "contracts", relativeArtifactJson);
  return (JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[] }).abi;
}

async function waitFor(
  publicClient: { waitForTransactionReceipt: (a: { hash: `0x${string}` }) => Promise<unknown> },
  hash: `0x${string}`,
) {
  return publicClient.waitForTransactionReceipt({ hash });
}

async function main() {
  const rpcUrl = (process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop").trim();
  const chain = agikingChain(rpcUrl);
  const base = loadDeployment();
  const a = base.addresses;

  const existing = {
    dlToken: getAddress(a.dlToken) as Address,
    ausd: getAddress(a.ausd) as Address,
    usdt: getAddress(a.usdt) as Address,
    dealFactory: getAddress(a.dealFactory) as Address,
    dealInfoNFT: getAddress(a.dealInfoNFT) as Address,
    dealPairManager: getAddress(a.dealPairManager) as Address,
    dealSwapOrderBook: getAddress(a.dealSwapOrderBook) as Address,
  };

  const { viem } = await network.connect({ network: "agiking", chainType: "l1" }) as unknown as { viem: any };
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer] = await viem.getWalletClients({ chain });
  const client = { public: publicClient, wallet: deployer } as const;
  const dep = deployer.account.address;

  const factory = await viem.getContractAt("DealFactory", existing.dealFactory, { client });
  const pairManager = await viem.getContractAt("DealPairManager", existing.dealPairManager, { client });
  const dl = await viem.getContractAt("IERC20", existing.dlToken, { client });
  const orderBook = await viem.getContractAt("DealSwapOrderBook", existing.dealSwapOrderBook, { client });

  console.log("Chain", chain.id, "deployer", dep);
  console.log("Factory", existing.dealFactory);

  let agi = envAddress("AGI_TOKEN_ADDRESS");
  let agiWasDeployed = false;
  if (agi === undefined) {
    const wrapped = await viem.deployContract("WrappedAGI", [], { client });
    agi = getAddress(wrapped.address) as Address;
    agiWasDeployed = true;
    console.log("WrappedAGI deployed:", agi);
  } else {
    console.log("Using provided AGI token:", agi);
  }

  if (envBool("SET_FACTORY_WRAPPED_NATIVE", true)) {
    const currentWrapped = await factory.read.wrappedNative();
    if (currentWrapped.toLowerCase() !== agi.toLowerCase()) {
      console.log("Updating Factory.wrappedNative...");
      await waitFor(publicClient, await factory.write.setCoreGlobals([
        existing.dlToken,
        existing.dealInfoNFT,
        agi,
        existing.dealPairManager,
      ]));
      console.log("Factory.wrappedNative =", agi);
    } else {
      console.log("Factory.wrappedNative already points to AGI.");
    }
  }

  const allowed = await factory.read.allowedMarginToken([agi]);
  if (!allowed) {
    console.log("Allowing AGI as margin token...");
    await waitFor(publicClient, await factory.write.setAllowedMarginToken([agi, true]));
  }

  const pairFeeNum = Number(process.env.PAIR_FEE_NUM ?? "3");
  const pairFeeDen = Number(process.env.PAIR_FEE_DEN ?? "1000");
  let pairDlAgi = await pairManager.read.pairForToken([agi]);
  if (pairDlAgi === ZERO) {
    console.log("Creating DL-AGI pair...");
    await waitFor(publicClient, await pairManager.write.createPair([agi, pairFeeNum, pairFeeDen]));
    pairDlAgi = await pairManager.read.pairForToken([agi]);
  }
  if (pairDlAgi === ZERO) throw new Error("DL-AGI pair creation failed");
  console.log("DL-AGI pair:", pairDlAgi);

  const pair = await viem.getContractAt("DealSwapTemplate", pairDlAgi, { client });
  const inited = await pair.read.liquidityInited();
  const initDl = envBigInt("PAIR_INIT_DL");
  const initAgi = envBigInt("PAIR_INIT_AGI");
  if (!inited && initDl !== undefined && initAgi !== undefined) {
    if (initDl <= 0n || initAgi <= 0n) throw new Error("PAIR_INIT_DL and PAIR_INIT_AGI must be > 0");
    console.log("Funding DL-AGI pair...");
    await waitFor(publicClient, await dl.write.transfer([pairDlAgi, initDl]));

    if (agiWasDeployed) {
      const wrappedAgi = await viem.getContractAt("WrappedAGI", agi, { client });
      await waitFor(publicClient, await wrappedAgi.write.deposit({ value: initAgi }));
      await waitFor(publicClient, await wrappedAgi.write.transfer([pairDlAgi, initAgi]));
    } else {
      const agiToken = await viem.getContractAt("IERC20", agi, { client });
      await waitFor(publicClient, await agiToken.write.transfer([pairDlAgi, initAgi]));
    }

    console.log("Initializing DL-AGI pair...");
    await waitFor(publicClient, await pairManager.write.initPair([pairDlAgi, 0n]));
  } else if (!inited) {
    console.log("DL-AGI pair is created but not initialized. Set PAIR_INIT_DL and PAIR_INIT_AGI to fund it.");
  } else {
    console.log("DL-AGI pair already initialized.");
  }

  let routerAddress = getAddress(a.dealRouter) as Address;
  if (envBool("REDEPLOY_ROUTER", true)) {
    const router = await viem.deployContract("DealRouter", [agi, existing.dealSwapOrderBook], { client });
    routerAddress = getAddress(router.address) as Address;
    console.log("DealRouter redeployed:", routerAddress);
    await waitFor(publicClient, await orderBook.write.setRouter([routerAddress]));
    console.log("OrderBook.router =", routerAddress);
  }

  const registry = await viem.deployContract(
    "DealSwapAssetRegistry",
    [dep, existing.dealPairManager, routerAddress, existing.dlToken, agi, existing.usdt, existing.ausd],
    { client },
  );
  console.log("DealSwapAssetRegistry:", registry.address);

  const mergedAddresses: Record<string, string> = {
    ...base.addresses,
    agi,
    wrappedNative: agi,
    dealRouter: routerAddress,
    pairDlAgi: getAddress(pairDlAgi),
    dealSwapAssetRegistry: getAddress(registry.address),
  };

  const mergedAbi = {
    ...base.abi,
    WrappedAGI: loadAbi("WrappedAGI.sol/WrappedAGI.json"),
    DealRouter: loadAbi("DealSwapRouter.sol/DealRouter.json"),
    DealSwapAssetRegistry: loadAbi("DealSwapAssetRegistry.sol/DealSwapAssetRegistry.json"),
  };

  const out: DeploymentJson = {
    chainId: AGIKING_CHAIN_ID,
    rpcUrl,
    deployedAt: new Date().toISOString(),
    deployer: dep,
    addresses: mergedAddresses,
    abi: mergedAbi,
  };

  mkdirSync(join(process.cwd(), "deployments"), { recursive: true });
  const mainFile = join(process.cwd(), "deployments", DEPLOYMENT_FILE);
  writeFileSync(mainFile, JSON.stringify(out, null, 2), "utf8");
  console.log("Wrote", mainFile);

  const handoffFile = join(
    process.cwd(),
    "deployments",
    `frontend-handoff-agiking-${AGIKING_CHAIN_ID}-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}.md`,
  );
  const handoff = `# AGI / USDT / AUSD Swap Frontend Handoff

## Core Addresses

| Name | Address | Note |
| --- | --- | --- |
| DL | \`${mergedAddresses.dlToken}\` | 统一中间资产 |
| AGI / WAGI | \`${mergedAddresses.agi}\` | 原生 AGI 的包装合约；前端原生币路径用 address(0)，ERC20 路径用本地址 |
| USDT | \`${mergedAddresses.usdt}\` | 官方 USDT 测试/映射币 |
| AUSD | \`${mergedAddresses.ausd}\` | 官方 AUSD 测试/映射币 |
| DealRouter | \`${mergedAddresses.dealRouter}\` | 普通 swap 主入口 |
| DealSwapAssetRegistry | \`${mergedAddresses.dealSwapAssetRegistry}\` | 查询三个官方 pair |
| DL-AGI Pair | \`${mergedAddresses.pairDlAgi}\` | DL <-> AGI |
| DL-USDT Pair | \`${mergedAddresses.pairDlUsdt}\` | DL <-> USDT |
| DL-AUSD Pair | \`${mergedAddresses.pairDlAusd}\` | DL <-> AUSD |

## Frontend Read

优先读 \`DealSwapAssetRegistry.getSwapPairSet()\`，一次拿到：

\`\`\`text
dl
agi
usdt
ausd
pairDlAgi
pairDlUsdt
pairDlAusd
router
\`\`\`

## Swap Rules

- 三个官方资产：AGI、USDT、AUSD。
- 三个官方 pair：DL-AGI、DL-USDT、DL-AUSD。
- AGI 是原生币时，前端用 Router 的 ETH/native 系列方法，并传 \`pairDlAgi\`。
- AGI 作为 ERC20 展示/授权时，用 \`agi\` 地址，也就是 WAGI。
- USDT/AUSD 走 ERC20 swap 方法。
- 双跳兑换继续用 \`ViaDL\` 路径，例如 AGI -> DL -> USDT。

## Deployment Notes

- 本次没有重部署 Deal 模板。
- 本次没有把 AGI 逻辑塞进 DealFactory 本体，只接线 \`wrappedNative\`、新 Router、独立 Registry 和新 Pair。
- 完整 ABI 已合并进 \`deployments/${DEPLOYMENT_FILE}\`。
`;
  writeFileSync(handoffFile, handoff, "utf8");
  console.log("Wrote", handoffFile);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
