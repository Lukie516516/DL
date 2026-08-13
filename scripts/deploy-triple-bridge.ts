/**
 * deploy-triple-bridge.ts
 *
 * 当前三桥 PoC 路径：
 *   Sepolia CrossChainBroadcaster
 *   BSC Testnet DualBridgeExecutor
 *
 * 命令：
 *   deploy    - 部署 Broadcaster + Executor，保存地址到 .triple-bridge-state.json
 *   wire      - 设置 LZ peer、WH/AX 来源，并在 Broadcaster 注册 BSC 链配置
 *   broadcast - 发一条测试消息
 *   status    - 查询 Executor 上某 msgHash 的确认状态
 *
 * 用法：
 *   node --import tsx/esm scripts/deploy-triple-bridge.ts deploy
 *   node --import tsx/esm scripts/deploy-triple-bridge.ts wire
 *   node --import tsx/esm scripts/deploy-triple-bridge.ts broadcast
 *   node --import tsx/esm scripts/deploy-triple-bridge.ts status <msgHash>
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  getAddress,
  http,
  padHex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet, sepolia } from "viem/chains";

// LayerZero
const LZ_ENDPOINT_SEPOLIA     = "0x6EDCE65403992e310A62460808c4b910D972f10f" as Address;
const LZ_ENDPOINT_BSC_TESTNET = "0x6EDCE65403992e310A62460808c4b910D972f10f" as Address;
const LZ_EID_BSC_TESTNET      = 40102;
const LZ_EID_SEPOLIA          = 40161;

// Wormhole
const WH_RELAYER_SEPOLIA      = "0x7B1bD7a6b4E61c2a123AC6BC2cbfC614437D0470" as Address;
const WH_RELAYER_BSC_TESTNET  = "0x80aC94316391752A193C1c47E27D382b507c93F3" as Address;
const WH_CHAIN_SEPOLIA        = 10002;
const WH_CHAIN_BSC_TESTNET    = 4;

// Axelar testnet
const AX_GATEWAY_SEPOLIA      = "0xe432150cce91c13a887f7D836923d5597adD8E31" as Address;
const AX_GAS_SERVICE_SEPOLIA  = "0xbE406F0189A0B4cf3A05C286473D23791Dd44Cc6" as Address;
const AX_GATEWAY_BSC_TESTNET  = "0x4D147dCb984e6affEEC47e44293DA442580A3Ec0" as Address;
const AX_CHAIN_BSC_TESTNET    = "binance";
const AX_CHAIN_SEPOLIA        = "ethereum-sepolia";
const AX_MIN_FEE              = 5_000_000_000_000_000n; // 0.005 ETH

try {
  readFileSync(".env", "utf8").split("\n").forEach((line) => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] ||= m[2].trim();
  });
} catch {}

const rawPK = process.env.SEPOLIA_PRIVATE_KEY ?? process.env.AGIKING_PRIVATE_KEY ?? "";
if (!rawPK) throw new Error("Missing SEPOLIA_PRIVATE_KEY or AGIKING_PRIVATE_KEY");
const PK = (rawPK.startsWith("0x") ? rawPK : `0x${rawPK}`) as `0x${string}`;
const account = privateKeyToAccount(PK);

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://rpc.sepolia.org";
const BSC_RPC = process.env.BSC_TESTNET_RPC_URL ?? "https://bsc-testnet.publicnode.com";

const sepoliaPub = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
const bscPub = createPublicClient({ chain: bscTestnet, transport: http(BSC_RPC) });
const sepoliaWlt = createWalletClient({ account, chain: sepolia, transport: http(SEPOLIA_RPC) });
const bscWlt = createWalletClient({ account, chain: bscTestnet, transport: http(BSC_RPC) });

const STATE_FILE = ".triple-bridge-state.json";

type Artifact = { abi: readonly unknown[]; bytecode: `0x${string}` };

function artifact(path: string): Artifact {
  return JSON.parse(readFileSync(`artifacts/contracts/${path}`, "utf8")) as Artifact;
}

const broadcasterArtifact = () => artifact("bridge/CrossChainBroadcaster.sol/CrossChainBroadcaster.json");
const executorArtifact = () => artifact("bridge/DualBridgeExecutor.sol/DualBridgeExecutor.json");

function loadState(): Record<string, string> {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
}

function saveState(s: Record<string, string>) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function addrToBytes32(addr: Address): `0x${string}` {
  return padHex(addr.toLowerCase() as `0x${string}`, { size: 32 });
}

function bscChainConfig(executor: Address) {
  return {
    lzDstEid: LZ_EID_BSC_TESTNET,
    whDstChain: WH_CHAIN_BSC_TESTNET,
    whDstAddress: executor,
    axDstChain: AX_CHAIN_BSC_TESTNET,
    axDstAddress: executor.toLowerCase(),
    axMinFee: AX_MIN_FEE,
    active: true,
  };
}

async function waitFor(client: typeof sepoliaPub | typeof bscPub, hash: `0x${string}`, label: string) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  console.log(`  ✓ ${label}: ${hash}`);
  return receipt;
}

const [,, cmd, arg1] = process.argv;

if (cmd === "deploy") {
  const bcArt = broadcasterArtifact();
  const exArt = executorArtifact();

  console.log("=== Deploy CrossChainBroadcaster (Sepolia) ===");
  const broadcasterData = encodeDeployData({
    abi: bcArt.abi,
    bytecode: bcArt.bytecode,
    args: [
      LZ_ENDPOINT_SEPOLIA,
      account.address,
      account.address, // test governance; production should be DealGovernance
      WH_RELAYER_SEPOLIA,
      AX_GATEWAY_SEPOLIA,
      AX_GAS_SERVICE_SEPOLIA,
    ],
  });
  const bHash = await sepoliaWlt.sendTransaction({ data: broadcasterData, account, chain: sepolia });
  const bReceipt = await waitFor(sepoliaPub, bHash, "Broadcaster deploy");
  const broadcaster = getAddress(bReceipt.contractAddress!) as Address;
  console.log("  Broadcaster:", broadcaster);

  console.log("\n=== Deploy DualBridgeExecutor (BSC Testnet) ===");
  const executorData = encodeDeployData({
    abi: exArt.abi,
    bytecode: exArt.bytecode,
    args: [
      LZ_ENDPOINT_BSC_TESTNET,
      account.address,
      WH_RELAYER_BSC_TESTNET,
      WH_CHAIN_SEPOLIA,
      addrToBytes32(broadcaster),
      AX_GATEWAY_BSC_TESTNET,
      AX_CHAIN_SEPOLIA,
      broadcaster,
      2n,
    ],
  });
  const eHash = await bscWlt.sendTransaction({ data: executorData, account, chain: bscTestnet });
  const eReceipt = await waitFor(bscPub, eHash, "Executor deploy");
  const executor = getAddress(eReceipt.contractAddress!) as Address;
  console.log("  Executor:", executor);

  saveState({ broadcaster, executor });
  console.log("\nSaved:", STATE_FILE);
  console.log("Next: node --import tsx/esm scripts/deploy-triple-bridge.ts wire");

} else if (cmd === "redeploy-broadcaster") {
  const { executor } = loadState();
  if (!executor) throw new Error("Missing executor in state; run deploy first");
  const bcArt = broadcasterArtifact();

  console.log("=== Redeploy CrossChainBroadcaster (Sepolia) ===");
  const broadcasterData = encodeDeployData({
    abi: bcArt.abi,
    bytecode: bcArt.bytecode,
    args: [
      LZ_ENDPOINT_SEPOLIA,
      account.address,
      account.address,
      WH_RELAYER_SEPOLIA,
      AX_GATEWAY_SEPOLIA,
      AX_GAS_SERVICE_SEPOLIA,
    ],
  });
  const hash = await sepoliaWlt.sendTransaction({ data: broadcasterData, account, chain: sepolia });
  const receipt = await waitFor(sepoliaPub, hash, "Broadcaster redeploy");
  const broadcaster = getAddress(receipt.contractAddress!) as Address;
  saveState({ ...loadState(), broadcaster });
  console.log("  Broadcaster:", broadcaster);
  console.log("Next: wire");

} else if (cmd === "wire") {
  const { broadcaster, executor } = loadState();
  if (!broadcaster || !executor) throw new Error("Missing broadcaster/executor; run deploy first");
  const bc = getAddress(broadcaster) as Address;
  const ex = getAddress(executor) as Address;
  const bcAbi = broadcasterArtifact().abi;
  const exAbi = executorArtifact().abi;

  console.log("=== LZ peers ===");
  await waitFor(
    sepoliaPub,
    await sepoliaWlt.writeContract({
      address: bc,
      abi: bcAbi,
      functionName: "setPeer",
      args: [LZ_EID_BSC_TESTNET, addrToBytes32(ex)],
      account,
      chain: sepolia,
    }),
    "Broadcaster.setPeer(BSC, Executor)",
  );

  await waitFor(
    bscPub,
    await bscWlt.writeContract({
      address: ex,
      abi: exAbi,
      functionName: "setPeer",
      args: [LZ_EID_SEPOLIA, addrToBytes32(bc)],
      account,
      chain: bscTestnet,
    }),
    "Executor.setPeer(Sepolia, Broadcaster)",
  );

  console.log("\n=== Executor WH/AX source ===");
  await waitFor(
    bscPub,
    await bscWlt.writeContract({
      address: ex,
      abi: exAbi,
      functionName: "setWhSrc",
      args: [WH_CHAIN_SEPOLIA, addrToBytes32(bc)],
      account,
      chain: bscTestnet,
    }),
    "Executor.setWhSrc",
  );

  await waitFor(
    bscPub,
    await bscWlt.writeContract({
      address: ex,
      abi: exAbi,
      functionName: "setAxSrc",
      args: [AX_CHAIN_SEPOLIA, bc],
      account,
      chain: bscTestnet,
    }),
    "Executor.setAxSrc",
  );

  console.log("\n=== Broadcaster chain config ===");
  const chainIds = await sepoliaPub.readContract({
    address: bc,
    abi: bcAbi,
    functionName: "getChainIds",
  }) as readonly number[];
  const hasBsc = chainIds.some((id) => Number(id) === LZ_EID_BSC_TESTNET);
  const fn = hasBsc ? "setChain" : "addChain";
  await waitFor(
    sepoliaPub,
    await sepoliaWlt.writeContract({
      address: bc,
      abi: bcAbi,
      functionName: fn,
      args: [LZ_EID_BSC_TESTNET, bscChainConfig(ex)],
      account,
      chain: sepolia,
    }),
    `Broadcaster.${fn}(BSC config)`,
  );

  saveState({ ...loadState(), broadcaster: bc, executor: ex, bscChainKey: String(LZ_EID_BSC_TESTNET) });
  console.log("\nWire complete. Next: broadcast");

} else if (cmd === "broadcast") {
  const { broadcaster } = loadState();
  if (!broadcaster) throw new Error("Missing broadcaster; run deploy first");
  const bc = getAddress(broadcaster) as Address;
  const bcAbi = broadcasterArtifact().abi;

  const target = "0x000000000000000000000000000000000000dEaD" as Address;
  const data = "0x" as `0x${string}`;
  const lzGas = 200_000n;
  const targetChainIds = [LZ_EID_BSC_TESTNET];
  const targets = [target];

  const totalFee = await sepoliaPub.readContract({
    address: bc,
    abi: bcAbi,
    functionName: "quoteFees",
    args: [targetChainIds, targets, data, lzGas],
  }) as bigint;
  console.log(`Total fee: ${totalFee}`);

  const hash = await sepoliaWlt.writeContract({
    address: bc,
    abi: bcAbi,
    functionName: "broadcast",
    args: [targetChainIds, targets, data, lzGas],
    value: totalFee + 1_000_000_000_000_000n,
    account,
    chain: sepolia,
  } as any);
  const receipt = await waitFor(sepoliaPub, hash, "broadcast");
  console.log("  block:", receipt.blockNumber.toString());

} else if (cmd === "status") {
  const { executor } = loadState();
  if (!executor) throw new Error("Missing executor; run deploy first");
  if (!arg1) throw new Error("Usage: status <msgHash>");
  const ex = getAddress(executor) as Address;
  const exAbi = executorArtifact().abi;
  const [lzConfirmed, whConfirmed, axConfirmed, count, executed] = await bscPub.readContract({
    address: ex,
    abi: exAbi,
    functionName: "confirmStatus",
    args: [arg1 as `0x${string}`],
  }) as [boolean, boolean, boolean, bigint, boolean];
  const threshold = await bscPub.readContract({ address: ex, abi: exAbi, functionName: "threshold" }) as bigint;
  console.log(`msgHash: ${arg1}`);
  console.log(`  LZ: ${lzConfirmed}`);
  console.log(`  WH: ${whConfirmed}`);
  console.log(`  AX: ${axConfirmed}`);
  console.log(`  confirmations: ${count}/${threshold}`);
  console.log(`  executed: ${executed}`);

} else {
  console.log("Usage: node --import tsx/esm scripts/deploy-triple-bridge.ts [deploy|redeploy-broadcaster|wire|broadcast|status <msgHash>]");
}
