/**
 * Read-only comparison of the live ETH/BSC DC supply, Treasury and three pools.
 * Used to design Base issuance and liquidity without signing any transaction.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  fallback,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  type Address,
} from "viem";
import { bsc, mainnet } from "viem/chains";

type Deployment = {
  chainId: number;
  addresses: Record<string, Address>;
};

const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const pairAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint256 reserve0,uint256 reserve1)",
  "function token1BalanceInit() view returns (uint256)",
]);

function deployment(name: string): Deployment {
  return JSON.parse(readFileSync(join(process.cwd(), "deployments", name), "utf8")) as Deployment;
}

async function inspectChain(
  label: string,
  dep: Deployment,
  client: ReturnType<typeof createPublicClient>,
) {
  const dc = getAddress(dep.addresses.dlToken);
  const treasury = getAddress(dep.addresses.protocolTreasury);
  const [dcSupply, treasuryDc] = await Promise.all([
    client.readContract({ address: dc, abi: erc20Abi, functionName: "totalSupply" }),
    client.readContract({ address: dc, abi: erc20Abi, functionName: "balanceOf", args: [treasury] }),
  ]);
  const pairs = [];
  for (const [name, rawAddress] of [
    ["DC/stable0", dep.addresses.pairStable0],
    ["DC/stable1", dep.addresses.pairStable1],
    ["DC/wrappedNative", dep.addresses.pairWrappedNative],
  ] as const) {
    const address = getAddress(rawAddress);
    const [token0, token1, reserves, virtualOther] = await Promise.all([
      client.readContract({ address, abi: pairAbi, functionName: "token0" }),
      client.readContract({ address, abi: pairAbi, functionName: "token1" }),
      client.readContract({ address, abi: pairAbi, functionName: "getReserves" }),
      client.readContract({ address, abi: pairAbi, functionName: "token1BalanceInit" }),
    ]);
    const [symbol1, decimals1, real0, real1] = await Promise.all([
      client.readContract({ address: token1, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address: token1, abi: erc20Abi, functionName: "decimals" }),
      client.readContract({ address: token0, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      client.readContract({ address: token1, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    ]);
    pairs.push({
      name,
      address,
      token0: getAddress(token0),
      token1: getAddress(token1),
      token1Symbol: symbol1,
      token1Decimals: Number(decimals1),
      accountingReserve0: reserves[0].toString(),
      accountingReserve1: reserves[1].toString(),
      virtualOther: virtualOther.toString(),
      realDc: formatUnits(real0, 18),
      realOther: formatUnits(real1, Number(decimals1)),
    });
  }
  return {
    label,
    chainId: dep.chainId,
    blockNumber: (await client.getBlockNumber()).toString(),
    dc,
    dcTotalSupply: formatUnits(dcSupply, 18),
    treasury,
    treasuryDc: formatUnits(treasuryDc, 18),
    pairs,
  };
}

async function main() {
  const eth = deployment("eth-mainnet-1.json");
  const bnb = deployment("bsc-mainnet-56.json");
  const ethClient = createPublicClient({
    chain: mainnet,
    transport: fallback([
      ...(process.env.ETH_MAINNET_RPC_URL ? [http(process.env.ETH_MAINNET_RPC_URL)] : []),
      http("https://ethereum-rpc.publicnode.com"),
    ], { rank: false }),
  });
  const bscClient = createPublicClient({
    chain: bsc,
    transport: fallback([
      ...(process.env.BSC_MAINNET_RPC_URL ? [http(process.env.BSC_MAINNET_RPC_URL)] : []),
      http("https://bsc-dataseed.binance.org"),
    ], { rank: false }),
  });
  const [ethereum, bnbChain] = await Promise.all([
    inspectChain("ethereum", eth, ethClient),
    inspectChain("bsc", bnb, bscClient),
  ]);
  console.log(JSON.stringify({
    scope: "read-only live economics comparison; no wallet and no transaction",
    checkedAt: new Date().toISOString(),
    chains: [ethereum, bnbChain],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
