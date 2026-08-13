/**
 * Register Base on the production ETH CrossChainBroadcasterV2 as inactive,
 * then set the LayerZero peer. Inactive registration cannot receive a
 * broadcast and does not change the existing active BSC route.
 *
 * Read-only:
 *   node --import tsx/esm scripts/configure-base-cross-chain-v2-route-stage2.ts status
 *
 * Explicit write gate:
 *   BASE_CROSS_CHAIN_V2_ROUTE_STAGE2_CONFIRM=REGISTER_BASE_ROUTE_INACTIVE \
 *     node --import tsx/esm scripts/configure-base-cross-chain-v2-route-stage2.ts execute
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  createPublicClient,
  createWalletClient,
  fallback,
  formatEther,
  getAddress,
  http,
  padHex,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, mainnet } from "viem/chains";

import { BASE_MAINNET } from "./lib/evm-chain-config.js";

const STATE1_FILE = "deployments/base-cross-chain-v2-stage1.json";
const STATE2_FILE = "deployments/base-cross-chain-v2-route-stage2.json";
const CONFIRM = "REGISTER_BASE_ROUTE_INACTIVE";
const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const GOVERNANCE = getAddress("0x9a41a9A85C16F590789C846Fb933fF8C715407F7");
const BSC_CHAIN_KEY = 30_102;
const BASE_CHAIN_KEY = 30_184;
const BASE_CCIP_SELECTOR = 15_971_525_489_660_198_786n;
const AX_MIN_FEE = 1_000_000_000_000_000n;
const MIN_ETH_BALANCE = parseEther("0.003");

type Stage1 = { chainId: number; stage: string; executor: Address; probe: Address };
type ReceiptRow = { label: string; hash: Hex; blockNumber: string; gasUsed: string };
type Stage2 = {
  scope: string;
  chainId: number;
  broadcaster: Address;
  baseChainKey: number;
  executor: Address;
  active: false;
  transactions: ReceiptRow[];
  verifiedAt?: string;
  verifiedBlock?: string;
};

const broadcasterAbi = parseAbi([
  "function owner() view returns (address)",
  "function governance() view returns (address)",
  "function getChainIds() view returns (uint32[])",
  "function chains(uint32) view returns (uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
  "function peers(uint32) view returns (bytes32)",
  "function addChain(uint32,(uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active))",
  "function setPeer(uint32,bytes32)",
]);
const ccipAbi = parseAbi(["function isChainSupported(uint64) view returns (bool)"]);
const executorAbi = parseAbi([
  "function owner() view returns (address)",
  "function peers(uint32) view returns (bytes32)",
  "function threshold() view returns (uint256)",
]);

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) process.env[match[1].trim()] = match[2].trim();
  }
}
function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}
function privateKey(): Hex {
  const raw = process.env.ETH_MAINNET_PRIVATE_KEY || process.env.AGIKING_PRIVATE_KEY;
  if (!raw) throw new Error("Missing ETH_MAINNET_PRIVATE_KEY or AGIKING_PRIVATE_KEY");
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}
function same(a: unknown, b: unknown) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}
function assertThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function routeJson(route: readonly unknown[]) {
  return {
    lzDstEid: String(route[0]),
    ccipDstChainSelector: String(route[1]),
    ccipReceiver: route[2],
    axDstChain: route[3],
    axDstAddress: route[4],
    axMinFee: String(route[5]),
    active: route[6],
  };
}
function exactBaseRoute(route: readonly unknown[], executor: Address) {
  return Number(route[0]) === BASE_CHAIN_KEY
    && BigInt(route[1] as bigint) === BASE_CCIP_SELECTOR
    && same(route[2], executor)
    && route[3] === "base"
    && String(route[4]).toLowerCase() === executor.toLowerCase()
    && BigInt(route[5] as bigint) === AX_MIN_FEE
    && route[6] === false;
}

async function main() {
  loadEnv();
  const mode = process.argv[2] || "status";
  if (mode !== "status" && mode !== "execute") throw new Error("Mode must be status or execute");
  const stage1 = JSON.parse(readFileSync(STATE1_FILE, "utf8")) as Stage1;
  assertThat(stage1.chainId === 8453 && stage1.stage === "configured", "Base stage 1 is incomplete");
  const executor = getAddress(stage1.executor);
  const ethRpc = required("ETH_MAINNET_RPC_URL");
  const baseRpc = process.env.BASE_MAINNET_RPC_URL?.trim() || "https://mainnet.base.org";
  const ethPublic: any = createPublicClient({ chain: mainnet, transport: http(ethRpc, { timeout: 30_000 }) });
  const basePublic: any = createPublicClient({
    chain: base,
    transport: fallback([http(baseRpc), http("https://base-mainnet.public.blastapi.io")], { rank: false }),
  });
  assertThat(await ethPublic.getChainId() === 1 && await basePublic.getChainId() === 8453, "RPC chain mismatch");

  const [
    owner,
    governance,
    chainIds,
    bscRoute,
    baseRoute,
    basePeer,
    baseCcipSupported,
    executorCode,
    executorOwner,
    executorEthPeer,
    threshold,
  ] = await Promise.all([
    ethPublic.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "owner" }),
    ethPublic.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "governance" }),
    ethPublic.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "getChainIds" }),
    ethPublic.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BSC_CHAIN_KEY] }),
    ethPublic.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
    ethPublic.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "peers", args: [BASE_CHAIN_KEY] }),
    ethPublic.readContract({ address: "0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D", abi: ccipAbi, functionName: "isChainSupported", args: [BASE_CCIP_SELECTOR] }),
    basePublic.getCode({ address: executor }),
    basePublic.readContract({ address: executor, abi: executorAbi, functionName: "owner" }),
    basePublic.readContract({ address: executor, abi: executorAbi, functionName: "peers", args: [30_101] }),
    basePublic.readContract({ address: executor, abi: executorAbi, functionName: "threshold" }),
  ]);
  assertThat(same(owner, OWNER) && same(governance, GOVERNANCE), "Broadcaster authority mismatch");
  assertThat(baseCcipSupported, "Ethereum CCIP router does not support Base");
  assertThat(executorCode && executorCode !== "0x", "Base Executor has no code");
  assertThat(same(executorOwner, OWNER) && threshold === 2n, "Base Executor stage-1 state mismatch");
  assertThat(same(executorEthPeer, padHex(BROADCASTER, { size: 32 })), "Base Executor Ethereum peer mismatch");

  const routeExists = chainIds.includes(BASE_CHAIN_KEY);
  if (routeExists) assertThat(exactBaseRoute(baseRoute, executor), "existing Base route differs from the approved inactive config");
  const peerExpected = padHex(executor, { size: 32 });
  assertThat(same(basePeer, ZERO32) || same(basePeer, peerExpected), "unexpected existing Base LayerZero peer");

  const accountForSimulation = { address: OWNER, type: "json-rpc" } as const;
  const routeConfig = {
    lzDstEid: BASE_CHAIN_KEY,
    ccipDstChainSelector: BASE_CCIP_SELECTOR,
    ccipReceiver: executor,
    axDstChain: "base",
    axDstAddress: executor.toLowerCase(),
    axMinFee: AX_MIN_FEE,
    active: false,
  } as const;
  let addChainGas = 0n;
  if (!routeExists) {
    await ethPublic.simulateContract({
      account: accountForSimulation,
      address: BROADCASTER,
      abi: broadcasterAbi,
      functionName: "addChain",
      args: [BASE_CHAIN_KEY, routeConfig],
    });
    addChainGas = await ethPublic.estimateContractGas({
      account: accountForSimulation,
      address: BROADCASTER,
      abi: broadcasterAbi,
      functionName: "addChain",
      args: [BASE_CHAIN_KEY, routeConfig],
    });
  }
  let setPeerGas = 0n;
  if (!same(basePeer, peerExpected)) {
    await ethPublic.simulateContract({
      account: accountForSimulation,
      address: BROADCASTER,
      abi: broadcasterAbi,
      functionName: "setPeer",
      args: [BASE_CHAIN_KEY, peerExpected],
    });
    setPeerGas = await ethPublic.estimateContractGas({
      account: accountForSimulation,
      address: BROADCASTER,
      abi: broadcasterAbi,
      functionName: "setPeer",
      args: [BASE_CHAIN_KEY, peerExpected],
    });
  }

  const status = {
    scope: "register Base route inactive on ETH CrossChainBroadcasterV2",
    mode,
    ethereumBlock: (await ethPublic.getBlockNumber()).toString(),
    baseBlock: (await basePublic.getBlockNumber()).toString(),
    broadcaster: BROADCASTER,
    owner,
    governance,
    executor,
    currentChainIds: chainIds,
    bscRoute: routeJson(bscRoute),
    baseRoute: routeJson(baseRoute),
    basePeer,
    plannedBaseRoute: {
      lzDstEid: routeConfig.lzDstEid,
      ccipDstChainSelector: routeConfig.ccipDstChainSelector.toString(),
      ccipReceiver: routeConfig.ccipReceiver,
      axDstChain: routeConfig.axDstChain,
      axDstAddress: routeConfig.axDstAddress,
      axMinFee: routeConfig.axMinFee.toString(),
      active: routeConfig.active,
    },
    plannedPeer: peerExpected,
    estimatedGas: { addChain: addChainGas.toString(), setPeer: setPeerGas.toString() },
    ownerEthBalance: formatEther(await ethPublic.getBalance({ address: OWNER })),
    businessEffect: "none: Base remains inactive and BSC remains the only active route",
  };
  console.log(JSON.stringify(status, null, 2));
  if (mode === "status") {
    console.log(`Read-only complete. Use ${CONFIRM} only after approval.`);
    return;
  }

  assertThat(process.env.BASE_CROSS_CHAIN_V2_ROUTE_STAGE2_CONFIRM === CONFIRM, "stage 2 write gate is closed");
  const account = privateKeyToAccount(privateKey());
  assertThat(same(account.address, OWNER), `signer mismatch: ${account.address}`);
  assertThat(await ethPublic.getBalance({ address: OWNER }) >= MIN_ETH_BALANCE, "ETH balance below stage-2 safety floor");
  const wallet = createWalletClient({ account, chain: mainnet, transport: http(ethRpc, { timeout: 30_000 }) });
  const state: Stage2 = existsSync(STATE2_FILE)
    ? JSON.parse(readFileSync(STATE2_FILE, "utf8")) as Stage2
    : {
      scope: "ETH Broadcaster Base route registration (inactive)",
      chainId: 1,
      broadcaster: BROADCASTER,
      baseChainKey: BASE_CHAIN_KEY,
      executor,
      active: false,
      transactions: [],
    };
  async function send(label: string, functionName: "addChain" | "setPeer", args: readonly unknown[]) {
    const hash = await wallet.writeContract({ account, address: BROADCASTER, abi: broadcasterAbi, functionName, args });
    const receipt = await ethPublic.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 300_000 });
    assertThat(receipt.status === "success", `${label} failed: ${hash}`);
    state.transactions.push({ label, hash, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() });
    writeFileSync(STATE2_FILE, JSON.stringify(state, null, 2), "utf8");
  }
  if (!routeExists) await send("Broadcaster.addChain(Base inactive)", "addChain", [BASE_CHAIN_KEY, routeConfig]);
  if (!same(basePeer, peerExpected)) await send("Broadcaster.setPeer(Base Executor)", "setPeer", [BASE_CHAIN_KEY, peerExpected]);

  const [finalChainIds, finalBsc, finalBase, finalPeer] = await Promise.all([
    ethPublic.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "getChainIds" }),
    ethPublic.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BSC_CHAIN_KEY] }),
    ethPublic.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
    ethPublic.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "peers", args: [BASE_CHAIN_KEY] }),
  ]);
  assertThat(finalChainIds.includes(BSC_CHAIN_KEY) && finalChainIds.includes(BASE_CHAIN_KEY), "final route list mismatch");
  assertThat(JSON.stringify(routeJson(finalBsc)) === JSON.stringify(routeJson(bscRoute)), "BSC route changed");
  assertThat(exactBaseRoute(finalBase, executor), "Base inactive route verification failed");
  assertThat(same(finalPeer, peerExpected), "Base peer verification failed");
  state.verifiedAt = new Date().toISOString();
  state.verifiedBlock = (await ethPublic.getBlockNumber()).toString();
  writeFileSync(STATE2_FILE, JSON.stringify(state, null, 2), "utf8");
  console.log(JSON.stringify({
    status: "PASS",
    stateFile: STATE2_FILE,
    executor,
    routeActive: false,
    bscRoutePreserved: true,
    transactionCount: state.transactions.length,
    remainingEth: formatEther(await ethPublic.getBalance({ address: OWNER })),
  }, null, 2));
}

const ZERO32 = `0x${"00".repeat(32)}` as Hex;

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
