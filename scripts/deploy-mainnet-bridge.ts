/**
 * Deploy and wire the ETH -> BSC triple-bridge governance path.
 *
 * This is intentionally separated from protocol deployment:
 * 1. Deploy protocol stack on ETH and BSC first.
 * 2. Deploy CrossChainBroadcaster on ETH and DualBridgeExecutor on BSC.
 * 3. Wire LZ peer, Wormhole source, Axelar source, and BSC allowed targets.
 * 4. Enable BSC only after addresses and target allowlist are verified.
 *
 * Commands:
 *   node --import tsx/esm scripts/deploy-mainnet-bridge.ts env
 *   node --import tsx/esm scripts/deploy-mainnet-bridge.ts deploy
 *   node --import tsx/esm scripts/deploy-mainnet-bridge.ts wire
 *   node --import tsx/esm scripts/deploy-mainnet-bridge.ts activate-bsc
 *   node --import tsx/esm scripts/deploy-mainnet-bridge.ts status
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  getAddress,
  http,
  padHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, mainnet } from "viem/chains";

type Artifact = { abi: readonly unknown[]; bytecode: Hex };
type State = {
  deployedAt?: string;
  wiredAt?: string;
  activatedAt?: string;
  eth?: { chainId: 1; deployer: Address; broadcaster: Address };
  bsc?: { chainId: 56; deployer: Address; executor: Address };
  params?: Record<string, string | number | boolean>;
};

loadEnv();

const STATE_FILE = process.env.MAINNET_CROSSCHAIN_STATE_FILE
  ?? join(process.cwd(), "deployments", "mainnet-cross-chain.json");

const ETH_RPC = mustEnv("ETH_MAINNET_RPC_URL");
const BSC_RPC = mustEnv("BSC_MAINNET_RPC_URL");
const ETH_PK = privateKey("ETH_MAINNET_PRIVATE_KEY");
const BSC_PK = privateKey("BSC_MAINNET_PRIVATE_KEY");
const ethAccount = privateKeyToAccount(ETH_PK);
const bscAccount = privateKeyToAccount(BSC_PK);

const ethPub = createPublicClient({ chain: mainnet, transport: http(ETH_RPC) });
const bscPub = createPublicClient({ chain: bsc, transport: http(BSC_RPC) });
const ethWallet = createWalletClient({ account: ethAccount, chain: mainnet, transport: http(ETH_RPC) });
const bscWallet = createWalletClient({ account: bscAccount, chain: bsc, transport: http(BSC_RPC) });

const ETH_LZ_ENDPOINT = envAddress("ETH_LZ_ENDPOINT");
const BSC_LZ_ENDPOINT = envAddress("BSC_LZ_ENDPOINT");
const ETH_LZ_EID = envNumber("ETH_LZ_EID", 30101);
const BSC_LZ_EID = envNumber("BSC_LZ_EID", 30102);

const ETH_WORMHOLE_RELAYER = envAddress("ETH_WORMHOLE_RELAYER");
const BSC_WORMHOLE_RELAYER = envAddress("BSC_WORMHOLE_RELAYER");
const ETH_WORMHOLE_CHAIN_ID = envNumber("ETH_WORMHOLE_CHAIN_ID", 2);
const BSC_WORMHOLE_CHAIN_ID = envNumber("BSC_WORMHOLE_CHAIN_ID", 4);

const ETH_AXELAR_GATEWAY = envAddress("ETH_AXELAR_GATEWAY");
const ETH_AXELAR_GAS_SERVICE = envAddress("ETH_AXELAR_GAS_SERVICE");
const BSC_AXELAR_GATEWAY = envAddress("BSC_AXELAR_GATEWAY");
const ETH_AXELAR_CHAIN_NAME = mustEnv("ETH_AXELAR_CHAIN_NAME");
const BSC_AXELAR_CHAIN_NAME = mustEnv("BSC_AXELAR_CHAIN_NAME");
const AXELAR_MIN_FEE_WEI = envBigInt("AXELAR_MIN_FEE_WEI");

const ETH_GOVERNANCE_ADDRESS = envAddress("ETH_GOVERNANCE_ADDRESS");
const BSC_CHAIN_KEY = envNumber("BSC_CHAIN_KEY", BSC_LZ_EID);
const BSC_ALLOWED_TARGETS = parseAddressList(process.env.BSC_ALLOWED_TARGETS ?? "");
const BSC_DEAL_FACTORY_ADDRESS = optionalAddress("BSC_DEAL_FACTORY_ADDRESS");
const SET_BSC_FACTORY_CROSSCHAIN = envBool("SET_BSC_FACTORY_CROSSCHAIN", false);
const BSC_CHAIN_ACTIVE_ON_WIRE = envBool("BSC_CHAIN_ACTIVE_ON_WIRE", false);
const EFFECTIVE_BSC_ALLOWED_TARGETS = uniqueAddresses([
  ...BSC_ALLOWED_TARGETS,
  ...(SET_BSC_FACTORY_CROSSCHAIN && BSC_DEAL_FACTORY_ADDRESS ? [BSC_DEAL_FACTORY_ADDRESS] : []),
]);

const [,, cmd = "env"] = process.argv;

async function main() {
  if (cmd === "env") {
    printEnvSummary();
    return;
  }
  if (cmd === "deploy") {
    await deployBoth();
    return;
  }
  if (cmd === "wire") {
    await wireBoth(false);
    return;
  }
  if (cmd === "activate-bsc") {
    await activateBsc();
    return;
  }
  if (cmd === "status") {
    await status();
    return;
  }
  throw new Error(`Unknown command: ${cmd}`);
}

function loadEnv() {
  try {
    readFileSync(".env", "utf8").split("\n").forEach((line) => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] ||= m[2].trim();
    });
  } catch {}
}

function mustEnv(key: string): string {
  const raw = process.env[key];
  if (!raw) throw new Error(`Missing required env ${key}`);
  return raw.trim();
}

function envBool(key: string, fallback = false): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

function envNumber(key: string, fallback?: number): number {
  const raw = process.env[key];
  if (!raw) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env ${key}`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid number env ${key}: ${raw}`);
  return n;
}

function envBigInt(key: string): bigint {
  const raw = mustEnv(key);
  return BigInt(raw);
}

function envAddress(key: string): Address {
  return getAddress(mustEnv(key)) as Address;
}

function optionalAddress(key: string): Address | undefined {
  const raw = process.env[key];
  if (!raw) return undefined;
  return getAddress(raw) as Address;
}

function parseAddressList(raw: string): Address[] {
  if (!raw.trim()) return [];
  return raw.split(",").map((s) => getAddress(s.trim()) as Address);
}

function uniqueAddresses(addresses: Address[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const address of addresses) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

function privateKey(key: string): Hex {
  const raw = mustEnv(key);
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

function artifact(path: string): Artifact {
  return JSON.parse(readFileSync(join(process.cwd(), "artifacts", "contracts", path), "utf8")) as Artifact;
}

function broadcasterArtifact() {
  return artifact("bridge/CrossChainBroadcaster.sol/CrossChainBroadcaster.json");
}

function executorArtifact() {
  return artifact("bridge/DualBridgeExecutor.sol/DualBridgeExecutor.json");
}

function factoryArtifact() {
  return artifact("DealFactory.sol/DealFactory.json");
}

function loadState(): State {
  if (!existsSync(STATE_FILE)) return {};
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
}

function saveState(state: State) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function addrToBytes32(addr: Address): Hex {
  return padHex(addr.toLowerCase() as Hex, { size: 32 });
}

async function waitFor(client: typeof ethPub | typeof bscPub, hash: Hex, label: string) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  console.log(`  ok ${label}: ${hash}`);
  return receipt;
}

function bscConfig(executor: Address, active: boolean) {
  return {
    lzDstEid: BSC_LZ_EID,
    whDstChain: BSC_WORMHOLE_CHAIN_ID,
    whDstAddress: executor,
    axDstChain: BSC_AXELAR_CHAIN_NAME,
    axDstAddress: executor.toLowerCase(),
    axMinFee: AXELAR_MIN_FEE_WEI,
    active,
  };
}

function commonParams(): Record<string, string | number | boolean> {
  return {
    ethLzEndpoint: ETH_LZ_ENDPOINT,
    bscLzEndpoint: BSC_LZ_ENDPOINT,
    ethLzEid: ETH_LZ_EID,
    bscLzEid: BSC_LZ_EID,
    ethWormholeRelayer: ETH_WORMHOLE_RELAYER,
    bscWormholeRelayer: BSC_WORMHOLE_RELAYER,
    ethWormholeChainId: ETH_WORMHOLE_CHAIN_ID,
    bscWormholeChainId: BSC_WORMHOLE_CHAIN_ID,
    ethAxelarGateway: ETH_AXELAR_GATEWAY,
    ethAxelarGasService: ETH_AXELAR_GAS_SERVICE,
    bscAxelarGateway: BSC_AXELAR_GATEWAY,
    ethAxelarChainName: ETH_AXELAR_CHAIN_NAME,
    bscAxelarChainName: BSC_AXELAR_CHAIN_NAME,
    axelarMinFeeWei: AXELAR_MIN_FEE_WEI.toString(),
    ethGovernance: ETH_GOVERNANCE_ADDRESS,
    bscChainKey: BSC_CHAIN_KEY,
    bscDealFactory: BSC_DEAL_FACTORY_ADDRESS ?? "",
    setBscFactoryCrosschain: SET_BSC_FACTORY_CROSSCHAIN,
    bscChainActiveOnWire: BSC_CHAIN_ACTIVE_ON_WIRE,
  };
}

function printEnvSummary() {
  console.log("ETH deployer:", ethAccount.address);
  console.log("BSC deployer:", bscAccount.address);
  console.log("State file:", STATE_FILE);
  console.log("BSC allowed targets:", EFFECTIVE_BSC_ALLOWED_TARGETS.length ? EFFECTIVE_BSC_ALLOWED_TARGETS.join(", ") : "(empty)");
  console.log(JSON.stringify(commonParams(), null, 2));
  console.log("\nRequired next commands:");
  console.log("  node --import tsx/esm scripts/deploy-mainnet-bridge.ts deploy");
  console.log("  node --import tsx/esm scripts/deploy-mainnet-bridge.ts wire");
  console.log("  node --import tsx/esm scripts/deploy-mainnet-bridge.ts activate-bsc");
}

async function deployBoth() {
  const bcArt = broadcasterArtifact();
  const exArt = executorArtifact();

  console.log("=== Deploy CrossChainBroadcaster on ETH ===");
  const bcData = encodeDeployData({
    abi: bcArt.abi,
    bytecode: bcArt.bytecode,
    args: [
      ETH_LZ_ENDPOINT,
      ethAccount.address,
      ETH_GOVERNANCE_ADDRESS,
      ETH_WORMHOLE_RELAYER,
      ETH_AXELAR_GATEWAY,
      ETH_AXELAR_GAS_SERVICE,
    ],
  });
  const bcHash = await ethWallet.sendTransaction({ data: bcData, account: ethAccount, chain: mainnet });
  const bcReceipt = await waitFor(ethPub, bcHash, "ETH Broadcaster deploy");
  const broadcaster = getAddress(bcReceipt.contractAddress!) as Address;
  console.log("Broadcaster:", broadcaster);

  console.log("\n=== Deploy DualBridgeExecutor on BSC ===");
  const exData = encodeDeployData({
    abi: exArt.abi,
    bytecode: exArt.bytecode,
    args: [
      BSC_LZ_ENDPOINT,
      bscAccount.address,
      BSC_WORMHOLE_RELAYER,
      ETH_WORMHOLE_CHAIN_ID,
      addrToBytes32(broadcaster),
      BSC_AXELAR_GATEWAY,
      ETH_AXELAR_CHAIN_NAME,
      broadcaster,
      2n,
    ],
  });
  const exHash = await bscWallet.sendTransaction({ data: exData, account: bscAccount, chain: bsc });
  const exReceipt = await waitFor(bscPub, exHash, "BSC Executor deploy");
  const executor = getAddress(exReceipt.contractAddress!) as Address;
  console.log("Executor:", executor);

  const state: State = {
    ...loadState(),
    deployedAt: new Date().toISOString(),
    eth: { chainId: 1, deployer: ethAccount.address, broadcaster },
    bsc: { chainId: 56, deployer: bscAccount.address, executor },
    params: commonParams(),
  };
  saveState(state);
  console.log("Saved:", STATE_FILE);
}

async function wireBoth(active: boolean) {
  const state = loadState();
  const broadcaster = state.eth?.broadcaster;
  const executor = state.bsc?.executor;
  if (!broadcaster || !executor) throw new Error("Missing broadcaster/executor in state. Run deploy first.");
  const bcAbi = broadcasterArtifact().abi;
  const exAbi = executorArtifact().abi;

  console.log("=== Wire LayerZero peers ===");
  await waitFor(ethPub, await ethWallet.writeContract({
    address: broadcaster,
    abi: bcAbi,
    functionName: "setPeer",
    args: [BSC_LZ_EID, addrToBytes32(executor)],
    account: ethAccount,
    chain: mainnet,
  }), "Broadcaster.setPeer(BSC)");
  await waitFor(bscPub, await bscWallet.writeContract({
    address: executor,
    abi: exAbi,
    functionName: "setPeer",
    args: [ETH_LZ_EID, addrToBytes32(broadcaster)],
    account: bscAccount,
    chain: bsc,
  }), "Executor.setPeer(ETH)");

  console.log("\n=== Wire Wormhole / Axelar source ===");
  await waitFor(bscPub, await bscWallet.writeContract({
    address: executor,
    abi: exAbi,
    functionName: "setWhSrc",
    args: [ETH_WORMHOLE_CHAIN_ID, addrToBytes32(broadcaster)],
    account: bscAccount,
    chain: bsc,
  }), "Executor.setWhSrc");
  await waitFor(bscPub, await bscWallet.writeContract({
    address: executor,
    abi: exAbi,
    functionName: "setAxSrc",
    args: [ETH_AXELAR_CHAIN_NAME, broadcaster],
    account: bscAccount,
    chain: bsc,
  }), "Executor.setAxSrc");

  if (EFFECTIVE_BSC_ALLOWED_TARGETS.length) {
    console.log("\n=== Allow BSC execution targets ===");
    for (const target of EFFECTIVE_BSC_ALLOWED_TARGETS) {
      await waitFor(bscPub, await bscWallet.writeContract({
        address: executor,
        abi: exAbi,
        functionName: "setAllowedTarget",
        args: [target, true],
        account: bscAccount,
        chain: bsc,
      }), `Executor.allowTarget(${target})`);
    }
  }

  if (SET_BSC_FACTORY_CROSSCHAIN) {
    if (!BSC_DEAL_FACTORY_ADDRESS) throw new Error("SET_BSC_FACTORY_CROSSCHAIN=1 requires BSC_DEAL_FACTORY_ADDRESS");
    await waitFor(bscPub, await bscWallet.writeContract({
      address: BSC_DEAL_FACTORY_ADDRESS,
      abi: factoryArtifact().abi,
      functionName: "setCrossChainGovernance",
      args: [executor],
      account: bscAccount,
      chain: bsc,
    }), "BSC Factory.setCrossChainGovernance");
  }

  console.log("\n=== Register BSC chain on ETH Broadcaster ===");
  const chainIds = await ethPub.readContract({
    address: broadcaster,
    abi: bcAbi,
    functionName: "getChainIds",
  }) as readonly number[];
  const fn = chainIds.some((id) => Number(id) === BSC_CHAIN_KEY) ? "setChain" : "addChain";
  await waitFor(ethPub, await ethWallet.writeContract({
    address: broadcaster,
    abi: bcAbi,
    functionName: fn,
    args: [BSC_CHAIN_KEY, bscConfig(executor, active || BSC_CHAIN_ACTIVE_ON_WIRE)],
    account: ethAccount,
    chain: mainnet,
  }), `Broadcaster.${fn}(BSC active=${active || BSC_CHAIN_ACTIVE_ON_WIRE})`);

  saveState({
    ...state,
    wiredAt: new Date().toISOString(),
    params: commonParams(),
  });
}

async function activateBsc() {
  const state = loadState();
  const broadcaster = state.eth?.broadcaster;
  if (!broadcaster) throw new Error("Missing broadcaster in state. Run deploy first.");
  const bcAbi = broadcasterArtifact().abi;
  await waitFor(ethPub, await ethWallet.writeContract({
    address: broadcaster,
    abi: bcAbi,
    functionName: "setChainActive",
    args: [BSC_CHAIN_KEY, true],
    account: ethAccount,
    chain: mainnet,
  }), "Broadcaster.setChainActive(BSC,true)");
  saveState({ ...state, activatedAt: new Date().toISOString(), params: commonParams() });
}

async function status() {
  const state = loadState();
  console.log(JSON.stringify(state, null, 2));
  if (!state.eth?.broadcaster || !state.bsc?.executor) return;
  const bcAbi = broadcasterArtifact().abi;
  const exAbi = executorArtifact().abi;
  const chainIds = await ethPub.readContract({
    address: state.eth.broadcaster,
    abi: bcAbi,
    functionName: "getChainIds",
  });
  const threshold = await bscPub.readContract({
    address: state.bsc.executor,
    abi: exAbi,
    functionName: "threshold",
  });
  console.log("Broadcaster chain ids:", chainIds);
  console.log("Executor threshold:", threshold);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
