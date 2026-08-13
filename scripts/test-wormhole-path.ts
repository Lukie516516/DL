/**
 * test-wormhole-path.ts
 *
 * 验证 Wormhole Sepolia → BSC Testnet 通路。
 *
 * 命令：
 *   deploy   — 部署 Sender(Sepolia) + Receiver(BSC testnet)
 *   send     — 从 Sepolia 发消息，保存 sequence 到 state 文件
 *   deliver  — 手动从 Wormhole Scan 拉 VAA，调用 BSC WormholeRelayer.deliver()
 *   check    — 查 BSC Receiver 是否收到消息
 *
 * 用法：
 *   node --import tsx/esm scripts/test-wormhole-path.ts deploy
 *   node --import tsx/esm scripts/test-wormhole-path.ts send
 *   node --import tsx/esm scripts/test-wormhole-path.ts deliver
 *   node --import tsx/esm scripts/test-wormhole-path.ts check
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  createPublicClient, createWalletClient, http, getAddress,
  decodeEventLog, parseEventLogs, formatUnits,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, bscTestnet } from "viem/chains";

// ─── Wormhole 地址 ────────────────────────────────────────────────────────────
const WH_RELAYER_SEPOLIA     = "0x7B1bD7a6b4E61c2a123AC6BC2cbfC614437D0470" as Address;
const WH_RELAYER_BSC_TESTNET = "0x80aC94316391752A193C1c47E27D382b507c93F3" as Address;
const WH_CHAIN_BSC_TESTNET   = 4;      // Wormhole chain ID for BSC testnet
const WH_CHAIN_SEPOLIA       = 10002;  // Wormhole chain ID for Sepolia
// Wormhole Scan API (testnet)
const WH_SCAN_BASE = "https://api.testnet.wormholescan.io/api/v1";
// emitter = WormholeRelayer on Sepolia (lowercase, no 0x)
const WH_EMITTER  = WH_RELAYER_SEPOLIA.slice(2).toLowerCase();

// ─── ABI ─────────────────────────────────────────────────────────────────────
const SENDER_ABI = [
  { name: "quoteFee", type: "function", stateMutability: "view",    inputs: [], outputs: [{ type: "uint256" }] },
  { name: "send",     type: "function", stateMutability: "payable", inputs: [{ name: "receiver", type: "address" }, { name: "payload", type: "bytes" }], outputs: [] },
  { name: "Sent",     type: "event",    inputs: [{ name: "sequence", type: "uint64", indexed: false }, { name: "payload", type: "bytes", indexed: false }] },
] as const;

const RECEIVER_ABI = [
  { name: "messageCount",  type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "latestMessage", type: "function", stateMutability: "view", inputs: [], outputs: [{ components: [{ name: "sourceAddress", type: "bytes32" }, { name: "sourceChain", type: "uint16" }, { name: "payload", type: "bytes" }, { name: "receivedAt", type: "uint256" }], type: "tuple" }] },
] as const;

const WH_RELAYER_DELIVER_ABI = [
  {
    name: "deliver",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "encodedVMs",          type: "bytes[]" },
      { name: "encodedDeliveryVAA",  type: "bytes"   },
      { name: "relayerRefundAddress",type: "address" },
      { name: "deliveryOverrides",   type: "bytes"   },
    ],
    outputs: [],
  },
] as const;

// ─── 环境 ─────────────────────────────────────────────────────────────────────
try {
  readFileSync(".env", "utf8").split("\n").forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] ||= m[2].trim();
  });
} catch {}

// 支持三个 env var fallback
const rawPK = process.env.SEPOLIA_PRIVATE_KEY
           ?? process.env.BSC_TESTNET_PRIVATE_KEY
           ?? process.env.AGIKING_PRIVATE_KEY
           ?? "";
const PK      = (rawPK.startsWith("0x") ? rawPK : `0x${rawPK}`) as `0x${string}`;
const account = privateKeyToAccount(PK);

const BSC_RPC    = process.env.BSC_TESTNET_RPC_URL ?? "https://bsc-testnet.publicnode.com";
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://rpc.sepolia.org";

const sepoliaPub  = createPublicClient({ chain: sepolia,    transport: http(SEPOLIA_RPC) });
const bscPub      = createPublicClient({ chain: bscTestnet, transport: http(BSC_RPC) });
const sepoliaWlt  = createWalletClient({ account, chain: sepolia,    transport: http(SEPOLIA_RPC) });
const bscWlt      = createWalletClient({ account, chain: bscTestnet, transport: http(BSC_RPC) });

// ─── 状态文件 ─────────────────────────────────────────────────────────────────
const STATE_FILE = ".wormhole-test-state.json";
function loadState(): Record<string, string> {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
}
function saveState(s: Record<string, string>) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function loadBytecode(name: string): `0x${string}` {
  const art = JSON.parse(readFileSync(`artifacts/contracts/test/WormholeTest.sol/${name}.json`, "utf8"));
  return art.bytecode as `0x${string}`;
}

// ─── 辅助：从 Wormhole Scan 拉 VAA bytes ──────────────────────────────────────
async function fetchVaaBytes(sequence: string): Promise<`0x${string}`> {
  const url = `${WH_SCAN_BASE}/vaas/${WH_CHAIN_SEPOLIA}/${WH_EMITTER}/${sequence}`;
  console.log("拉 VAA:", url);
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Wormhole Scan API ${res.status}: ${await res.text()}`);
  const data = await res.json() as any;
  if (!data?.data?.vaa) throw new Error("VAA 尚未签名，稍后再试");
  // base64 → hex
  const vaaHex = `0x${Buffer.from(data.data.vaa, "base64").toString("hex")}` as `0x${string}`;
  console.log("VAA 长度:", vaaHex.length / 2 - 1, "bytes");
  return vaaHex;
}

// ─── 命令分发 ─────────────────────────────────────────────────────────────────
const [,,cmd] = process.argv;

// ── deploy ────────────────────────────────────────────────────────────────────
if (cmd === "deploy") {
  console.log("=== 部署 WormholeTestSender (Sepolia) ===");
  const { encodeDeployData } = await import("viem");

  const senderData = encodeDeployData({
    abi: [{ type: "constructor", inputs: [{ name: "relayer_", type: "address" }] }],
    bytecode: loadBytecode("WormholeTestSender"),
    args: [WH_RELAYER_SEPOLIA],
  });
  const sH = await sepoliaWlt.sendTransaction({ data: senderData, account, chain: sepolia });
  const sR = await sepoliaPub.waitForTransactionReceipt({ hash: sH });
  console.log("  Sender:", sR.contractAddress, "TX:", sH);

  console.log("\n=== 部署 WormholeTestReceiver (BSC Testnet) ===");
  const receiverData = encodeDeployData({
    abi: [{ type: "constructor", inputs: [{ name: "wormholeRelayer_", type: "address" }] }],
    bytecode: loadBytecode("WormholeTestReceiver"),
    args: [WH_RELAYER_BSC_TESTNET],
  });
  const rH = await bscWlt.sendTransaction({ data: receiverData, account, chain: bscTestnet });
  const rR = await bscPub.waitForTransactionReceipt({ hash: rH });
  console.log("  Receiver:", rR.contractAddress, "TX:", rH);

  saveState({ sender: sR.contractAddress!, receiver: rR.contractAddress! });
  console.log("\n地址已保存到", STATE_FILE);

// ── send ──────────────────────────────────────────────────────────────────────
} else if (cmd === "send") {
  const state = loadState();
  if (!state.sender || !state.receiver) throw new Error("先运行 deploy");

  const sender   = getAddress(state.sender)   as Address;
  const receiver = getAddress(state.receiver) as Address;

  const fee = await sepoliaPub.readContract({ address: sender, abi: SENDER_ABI, functionName: "quoteFee" });
  console.log("预估 Wormhole 费用:", formatUnits(fee, 18), "ETH");

  const payload = new TextEncoder().encode("hello from Sepolia " + Date.now());
  const hash = await sepoliaWlt.writeContract({
    address: sender, abi: SENDER_ABI, functionName: "send",
    args: [receiver, `0x${Buffer.from(payload).toString("hex")}`],
    value: fee, account, chain: sepolia,
  });
  const receipt = await sepoliaPub.waitForTransactionReceipt({ hash });
  console.log("TX:", hash, "  block:", receipt.blockNumber.toString());

  // 从 Sent 事件提取 sequence
  let sequence: string | undefined;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: SENDER_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "Sent") {
        sequence = (decoded.args as any).sequence.toString();
        break;
      }
    } catch {}
  }

  if (sequence) {
    console.log("Wormhole sequence:", sequence);
    saveState({ ...state, sequence });
    console.log("\n✅ 消息已发送，sequence 已保存");
    console.log("等约 1 分钟让 Guardian 签名，然后运行 deliver 手动投递");
  } else {
    console.log("⚠️  未从日志里找到 sequence，请手动查 TX");
  }

// ── deliver ───────────────────────────────────────────────────────────────────
} else if (cmd === "deliver") {
  const state = loadState();
  if (!state.sequence) throw new Error("先运行 send 保存 sequence");
  if (!state.receiver) throw new Error("缺少 receiver 地址");

  // 1. 从 Wormhole Scan 拿 VAA
  const vaaBytes = await fetchVaaBytes(state.sequence);

  // 2. 检查当前 BSC 余额
  const bal = await bscPub.getBalance({ address: account.address });
  console.log("BSC testnet tBNB:", formatUnits(bal, 18));

  // 3. 调用 WormholeRelayer.deliver() — 我们作为 manual relayer 提交 VAA
  //    msg.value 覆盖目标链 gas 费用；WormholeRelayer 会用 VAA 里预存的 budget 偿还我们
  //    保守给 0.01 BNB（远超实际所需）
  const gasValue = 10_000_000_000_000_000n; // 0.01 BNB

  console.log("\n调用 WormholeRelayer.deliver() on BSC testnet...");
  const hash = await bscWlt.writeContract({
    address: WH_RELAYER_BSC_TESTNET,
    abi: WH_RELAYER_DELIVER_ABI,
    functionName: "deliver",
    args: [
      [],           // encodedVMs（无附加 VAA）
      vaaBytes,     // encodedDeliveryVAA
      account.address as Address, // relayerRefundAddress（退款给我们）
      "0x",         // deliveryOverrides（不覆盖）
    ],
    value: gasValue,
    account, chain: bscTestnet,
  });
  const receipt = await bscPub.waitForTransactionReceipt({ hash });
  console.log("deliver TX:", hash);
  console.log("status:", receipt.status === "success" ? "✅ success" : "❌ reverted");
  console.log("gasUsed:", receipt.gasUsed.toString());

  // 4. 验证收到
  const count = await bscPub.readContract({ address: getAddress(state.receiver) as Address, abi: RECEIVER_ABI, functionName: "messageCount" });
  console.log("Receiver 消息数:", count.toString());
  if (count > 0n) {
    const msg = await bscPub.readContract({ address: getAddress(state.receiver) as Address, abi: RECEIVER_ABI, functionName: "latestMessage" });
    console.log("内容:", Buffer.from(msg.payload.slice(2), "hex").toString());
    console.log("\n✅ Wormhole 手动投递成功！接收端正常工作");
  }

// ── check ─────────────────────────────────────────────────────────────────────
} else if (cmd === "check") {
  const state = loadState();
  if (!state.receiver) throw new Error("先运行 deploy");
  const receiver = getAddress(state.receiver) as Address;
  const count = await bscPub.readContract({ address: receiver, abi: RECEIVER_ABI, functionName: "messageCount" });
  console.log("BSC Receiver 收到消息数:", count.toString());
  if (count > 0n) {
    const msg = await bscPub.readContract({ address: receiver, abi: RECEIVER_ABI, functionName: "latestMessage" });
    console.log("最新消息内容:", Buffer.from(msg.payload.slice(2), "hex").toString());
    console.log("来源链:", msg.sourceChain, "(10002=Sepolia)");
    console.log("收到时间:", new Date(Number(msg.receivedAt) * 1000).toISOString());
    console.log("✅ Wormhole Sepolia → BSC Testnet 通路验证成功");
  }

} else {
  console.log("用法: node --import tsx/esm scripts/test-wormhole-path.ts [deploy|send|deliver|check]");
}
