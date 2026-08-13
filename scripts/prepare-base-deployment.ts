/**
 * Read-only Base mainnet deployment preflight.
 *
 * No private key, wallet client, deployment or transaction path exists here.
 * Usage:
 *   BASE_MAINNET_RPC_URL=... node --import tsx/esm scripts/prepare-base-deployment.ts
 * Optional:
 *   BASE_EXPECTED_DEPLOYER_ADDRESS=0x... to include the Base ETH balance check.
 */
import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  parseAbi,
  parseEther,
  type Address,
} from "viem";
import { base } from "viem/chains";

import { BASE_MAINNET } from "./lib/evm-chain-config.js";

const ETH_CCIP_ROUTER = getAddress("0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D");
const ETH_RPCS = [
  process.env.ETH_MAINNET_RPC_URL,
  "https://ethereum-rpc.publicnode.com",
].filter((url, index, values): url is string => Boolean(url) && values.indexOf(url) === index);
const BASE_RPCS = [
  process.env.BASE_MAINNET_RPC_URL,
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
].filter((url, index, values): url is string => Boolean(url) && values.indexOf(url) === index);

const metadataAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);
const bridgedTokenAbi = parseAbi([
  "function l1Token() view returns (address)",
  "function l2Bridge() view returns (address)",
]);
const ccipRouterAbi = parseAbi([
  "function isChainSupported(uint64 destinationChainSelector) view returns (bool)",
]);

type Check = { name: string; ok: boolean; value: string };

async function codeCheck(client: any, name: string, address: Address): Promise<Check> {
  const code = await client.getCode({ address });
  return { name, ok: Boolean(code && code !== "0x"), value: address };
}

async function tokenChecks(
  client: any,
  name: string,
  address: Address,
  expectedSymbol: string,
  expectedDecimals: number,
): Promise<Check[]> {
  const [code, symbol, decimals] = await Promise.all([
    client.getCode({ address }),
    client.readContract({ address, abi: metadataAbi, functionName: "symbol" }),
    client.readContract({ address, abi: metadataAbi, functionName: "decimals" }),
  ]);
  return [
    { name: `${name}.runtime`, ok: Boolean(code && code !== "0x"), value: address },
    { name: `${name}.symbol`, ok: symbol === expectedSymbol, value: String(symbol) },
    { name: `${name}.decimals`, ok: Number(decimals) === expectedDecimals, value: String(decimals) },
  ];
}

async function main() {
  const baseClient = createPublicClient({
    chain: base,
    transport: fallback(BASE_RPCS.map((url) => http(url)), { rank: false }),
  });
  const ethClient = createPublicClient({
    transport: fallback(ETH_RPCS.map((url) => http(url)), { rank: false }),
  });
  const checks: Check[] = [];

  const [baseChainId, ethChainId] = await Promise.all([
    baseClient.getChainId(),
    ethClient.getChainId(),
  ]);
  checks.push({ name: "base.chainId", ok: baseChainId === BASE_MAINNET.chainId, value: String(baseChainId) });
  checks.push({ name: "ethereum.chainId", ok: ethChainId === 1, value: String(ethChainId) });

  checks.push(...await tokenChecks(baseClient, "USDC", BASE_MAINNET.usdc, "USDC", 6));
  checks.push(...await tokenChecks(baseClient, "bridgedUSDT", BASE_MAINNET.usdt, "USDT", 6));
  checks.push(...await tokenChecks(baseClient, "WETH", BASE_MAINNET.weth, "WETH", 18));

  const [l1Token, l2Bridge] = await Promise.all([
    baseClient.readContract({ address: BASE_MAINNET.usdt, abi: bridgedTokenAbi, functionName: "l1Token" }),
    baseClient.readContract({ address: BASE_MAINNET.usdt, abi: bridgedTokenAbi, functionName: "l2Bridge" }),
  ]);
  checks.push({
    name: "bridgedUSDT.l1Token",
    ok: getAddress(l1Token).toLowerCase() === BASE_MAINNET.ethereumUsdt.toLowerCase(),
    value: getAddress(l1Token),
  });
  checks.push({
    name: "bridgedUSDT.l2Bridge",
    ok: getAddress(l2Bridge).toLowerCase() === BASE_MAINNET.standardBridge.toLowerCase(),
    value: getAddress(l2Bridge),
  });

  checks.push(await codeCheck(baseClient, "layerZero.endpoint", BASE_MAINNET.lzEndpoint));
  checks.push(await codeCheck(baseClient, "ccip.router", BASE_MAINNET.ccipRouter));
  checks.push(await codeCheck(baseClient, "axelar.gateway", BASE_MAINNET.axelarGateway));

  const ethSupportsBase = await ethClient.readContract({
    address: ETH_CCIP_ROUTER,
    abi: ccipRouterAbi,
    functionName: "isChainSupported",
    args: [BASE_MAINNET.ccipChainSelector],
  });
  checks.push({ name: "ethereumCCIP.supportsBase", ok: ethSupportsBase, value: String(ethSupportsBase) });

  const deployerRaw = process.env.BASE_EXPECTED_DEPLOYER_ADDRESS?.trim();
  let deployer: Address | undefined;
  let deployerBalanceWei: bigint | undefined;
  let deployerUsdc: bigint | undefined;
  let deployerUsdt: bigint | undefined;
  if (deployerRaw) {
    deployer = getAddress(deployerRaw);
    [deployerBalanceWei, deployerUsdc, deployerUsdt] = await Promise.all([
      baseClient.getBalance({ address: deployer }),
      baseClient.readContract({
        address: BASE_MAINNET.usdc,
        abi: metadataAbi,
        functionName: "balanceOf",
        args: [deployer],
      }),
      baseClient.readContract({
        address: BASE_MAINNET.usdt,
        abi: metadataAbi,
        functionName: "balanceOf",
        args: [deployer],
      }),
    ]);
    checks.push({
      name: "deployer.baseEthBalance",
      ok: deployerBalanceWei >= parseEther("0.01"),
      value: deployerBalanceWei.toString(),
    });
    checks.push({
      name: "deployer.usdcSmallestUnit",
      ok: deployerUsdc >= 1n,
      value: deployerUsdc.toString(),
    });
    checks.push({
      name: "deployer.usdtSmallestUnit",
      ok: deployerUsdt >= 1n,
      value: deployerUsdt.toString(),
    });
  }

  const blockers = checks.filter((check) => !check.ok).map((check) => check.name);
  const result = {
    scope: "read-only Base protocol and bridge preflight; no deployment or transaction",
    checkedAt: new Date().toISOString(),
    baseBlock: (await baseClient.getBlockNumber()).toString(),
    ethereumBlock: (await ethClient.getBlockNumber()).toString(),
    rpcCandidates: { base: BASE_RPCS.length, ethereum: ETH_RPCS.length },
    assets: {
      stable0: { symbol: "USDC", address: BASE_MAINNET.usdc, kind: "Circle-native" },
      stable1: {
        symbol: "USDT",
        address: BASE_MAINNET.usdt,
        kind: "Base Standard Bridge representation of Ethereum USDT",
      },
      wrappedNative: { symbol: "WETH", address: BASE_MAINNET.weth },
    },
    pools: ["DC/USDC", "DC/USDT", "DC/WETH"],
    crossChain: {
      lzEid: BASE_MAINNET.lzEid,
      ccipChainSelector: BASE_MAINNET.ccipChainSelector.toString(),
      axelarChainName: BASE_MAINNET.axelarChainName,
    },
    deployer,
    deployerBalanceWei: deployerBalanceWei?.toString(),
    deployerUsdc: deployerUsdc?.toString(),
    deployerUsdt: deployerUsdt?.toString(),
    checks,
    blockers,
    readyForForkRehearsal: blockers.length === 0,
    readyForMainnetDeployment: false,
    mainnetReason: "Mainnet deployment requires a separate explicit authorization and write gate.",
  };
  console.log(JSON.stringify(result, null, 2));
  if (blockers.length !== 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
