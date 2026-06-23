/**
 * 跨链 DVN 多节点安全配置脚本
 *
 * 作用：为 Dispatcher（Sepolia）和 Executor（BSC）配置多个必须验证节点，
 *       使单一 DVN 被攻破不足以伪造跨链消息。
 *
 * 用法：
 *   # 先检查当前配置（只读，不写入）
 *   npx ts-node scripts/configure-dvn.ts check
 *
 *   # 写入测试网配置（单 DVN，仅 LZ Labs）
 *   npx ts-node scripts/configure-dvn.ts set testnet
 *
 *   # 写入主网配置（三 DVN：LZ + Polyhedra + Google）
 *   npx ts-node scripts/configure-dvn.ts set mainnet
 */

import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, encodeAbiParameters,
         getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, bsc, bscTestnet } from "viem/chains";

// ─── 环境变量 ─────────────────────────────────────────────────────────────────

try {
  readFileSync(".env", "utf8").split("\n").forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] ||= m[2].trim();
  });
} catch {}

const rawPK = process.env.SEPOLIA_PRIVATE_KEY ?? process.env.BSC_TESTNET_PRIVATE_KEY ?? process.env.AGIKING_PRIVATE_KEY ?? "";
const PK = (rawPK.startsWith("0x") ? rawPK : `0x${rawPK}`) as `0x${string}`;

// ─── 部署地址 ─────────────────────────────────────────────────────────────────

const SEPOLIA_DEPLOYMENT  = JSON.parse(readFileSync("deployments/sepolia-11155111.json", "utf8"));

const LZ_ENDPOINT         = "0x6EDCE65403992e310A62460808c4b910D972f10f" as Address; // Sepolia & BSC Testnet 通用
const DISPATCHER          = SEPOLIA_DEPLOYMENT.lzDispatcher as Address;
const EXECUTOR            = SEPOLIA_DEPLOYMENT.lzExecutor   as Address;

const EID_SEPOLIA         = 40161;  // Sepolia testnet EID
const EID_BSC_TESTNET     = 40102;  // BSC testnet EID
const EID_ETHEREUM        = 30101;  // Ethereum mainnet EID
const EID_BSC_MAINNET     = 30102;  // BSC mainnet EID

const CONFIG_TYPE_ULN     = 2;      // UlnConfig 的 configType

// ─── DVN 地址表 ───────────────────────────────────────────────────────────────
// 来源：https://docs.layerzero.network/v2/developers/evm/technical-reference/dvn-addresses
// 上主网前请核对官方文档最新地址

const DVN: Record<string, Record<string, Address>> = {
  // 测试网：只有 LZ Labs 官方 DVN
  sepoliaTestnet: {
    lzLabs: "0x8eebf8b423B73bFCa51a1Db4B7354AA0bFCA9193",
  },
  bscTestnet: {
    lzLabs: "0x0eE552262f7B562eFcED6DD4A7e2878AB897d405",
  },
  // 主网：三个独立 DVN
  ethereum: {
    lzLabs:      "0x589dedBD617e0CBcB916A9223F4d1300c294236b",
    polyhedra:   "0x8ddF05F9A5c488b4973897E278B58895bF87Cb24",
    googleCloud: "0xD56e4eAb23cb81f43168F9F45211Eb027b9aC7cc",
  },
  bscMainnet: {
    lzLabs:      "0xfD6865c841c2d64565562fCc7e05e2E813BF8aB7",
    polyhedra:   "0x8ddF05F9A5c488b4973897E278B58895bF87Cb24",
    googleCloud: "0xD56e4eAb23cb81f43168F9F45211Eb027b9aC7cc",
  },
};

// ─── ABI ─────────────────────────────────────────────────────────────────────

const ENDPOINT_ABI = [
  // 查当前使用的发送库
  {
    name: "getSendLibrary",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "sender", type: "address" }, { name: "dstEid", type: "uint32" }],
    outputs: [{ name: "lib",    type: "address" }],
  },
  // 查当前使用的接收库
  {
    name: "getReceiveLibrary",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "receiver", type: "address" }, { name: "srcEid", type: "uint32" }],
    outputs: [{ name: "lib", type: "address" }, { name: "isDefault", type: "bool" }],
  },
  // 查当前 DVN 配置
  {
    name: "getConfig",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "oapp",       type: "address" },
      { name: "lib",        type: "address" },
      { name: "eid",        type: "uint32"  },
      { name: "configType", type: "uint32"  },
    ],
    outputs: [{ name: "config", type: "bytes" }],
  },
  // 写入新配置
  {
    name: "setConfig",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "oappAddress",    type: "address" },
      { name: "sendLibAddress", type: "address" },
      {
        name: "params",
        type: "tuple[]",
        components: [
          { name: "eid",        type: "uint32" },
          { name: "configType", type: "uint32" },
          { name: "config",     type: "bytes"  },
        ],
      },
    ],
    outputs: [],
  },
] as const;

// ─── UlnConfig 编码 ───────────────────────────────────────────────────────────

function encodeUlnConfig(dvns: Address[], confirmations = 15n): `0x${string}` {
  // DVN 地址必须升序排列（LZ 要求）
  const sorted = [...dvns].map(a => getAddress(a)).sort((a, b) => a.localeCompare(b)) as Address[];
  // 必须用 tuple 方式，等价 Solidity abi.encode(struct)，第一个 word 是 0x20 的 offset
  return encodeAbiParameters(
    [{
      type: "tuple",
      components: [
        { name: "confirmations",       type: "uint64"    },
        { name: "requiredDVNCount",    type: "uint8"     },
        { name: "optionalDVNCount",    type: "uint8"     },
        { name: "optionalDVNThreshold",type: "uint8"     },
        { name: "requiredDVNs",        type: "address[]" },
        { name: "optionalDVNs",        type: "address[]" },
      ],
    }],
    [{ confirmations, requiredDVNCount: sorted.length, optionalDVNCount: 0, optionalDVNThreshold: 0, requiredDVNs: sorted, optionalDVNs: [] }]
  );
}

// ─── 工具 ─────────────────────────────────────────────────────────────────────

function sortAddrs(addrs: Address[]): Address[] {
  return [...addrs].map(a => getAddress(a)).sort((a, b) => a.localeCompare(b)) as Address[];
}

async function checkConfig(
  pub: ReturnType<typeof createPublicClient>,
  oapp: Address,
  peerEid: number,
  label: string,
  isSend: boolean,
) {
  const libResult = isSend
    ? await pub.readContract({ address: LZ_ENDPOINT, abi: ENDPOINT_ABI, functionName: "getSendLibrary", args: [oapp, peerEid] })
    : (await pub.readContract({ address: LZ_ENDPOINT, abi: ENDPOINT_ABI, functionName: "getReceiveLibrary", args: [oapp, peerEid] }))[0];

  console.log(`\n[${label}] 使用的 ${isSend ? "Send" : "Receive"} Library: ${libResult}`);

  try {
    const rawConfig = await pub.readContract({
      address: LZ_ENDPOINT,
      abi: ENDPOINT_ABI,
      functionName: "getConfig",
      args: [oapp, libResult as Address, peerEid, CONFIG_TYPE_ULN],
    });
    console.log(`[${label}] 当前 UlnConfig (raw hex):`, rawConfig);
  } catch (e: any) {
    console.log(`[${label}] 无法解析当前 config:`, e?.shortMessage ?? e?.message);
  }
}

async function applyConfig(
  pub: ReturnType<typeof createPublicClient>,
  wallet: ReturnType<typeof createWalletClient>,
  oapp: Address,
  peerEid: number,
  dvns: Address[],
  label: string,
  isSend: boolean,
) {
  const libResult = isSend
    ? await pub.readContract({ address: LZ_ENDPOINT, abi: ENDPOINT_ABI, functionName: "getSendLibrary", args: [oapp, peerEid] })
    : (await pub.readContract({ address: LZ_ENDPOINT, abi: ENDPOINT_ABI, functionName: "getReceiveLibrary", args: [oapp, peerEid] }))[0];

  const lib = libResult as Address;
  const config = encodeUlnConfig(dvns);
  const sorted = sortAddrs(dvns);

  console.log(`\n[${label}] DVN 数量: ${dvns.length}，节点: ${sorted.join(", ")}`);
  console.log(`[${label}] Library: ${lib}`);

  const hash = await wallet.writeContract({
    address: LZ_ENDPOINT,
    abi: ENDPOINT_ABI,
    functionName: "setConfig",
    args: [
      oapp,
      lib,
      [{ eid: peerEid, configType: CONFIG_TYPE_ULN, config }],
    ],
    account: wallet.account!,
    chain: wallet.chain,
  });

  console.log(`[${label}] TX: ${hash}`);
  await pub.waitForTransactionReceipt({ hash });
  console.log(`[${label}] ✓ 配置写入成功`);
}

// ─── 主逻辑 ──────────────────────────────────────────────────────────────────

const [, , mode, network] = process.argv;

if (mode === "check") {
  console.log("=== 检查当前 DVN 配置 ===");
  console.log(`Dispatcher (Sepolia): ${DISPATCHER}`);
  console.log(`Executor   (BSC):     ${EXECUTOR}`);

  const sepoliaPub = createPublicClient({ chain: sepolia,     transport: http(process.env.SEPOLIA_RPC_URL) });
  const bscPub     = createPublicClient({ chain: bscTestnet, transport: http(process.env.BSC_TESTNET_RPC_URL ?? "https://bsc-testnet.publicnode.com") });

  await checkConfig(sepoliaPub, DISPATCHER, EID_BSC_TESTNET, "Dispatcher→BSCTestnet SEND",   true);
  await checkConfig(bscPub,     EXECUTOR,   EID_SEPOLIA,      "Executor←Sepolia     RECEIVE", false);

} else if (mode === "set") {

  const account = privateKeyToAccount(PK);

  if (network === "testnet") {
    console.log("=== 写入测试网 DVN 配置（单 DVN：LZ Labs）===");
    console.log("注意：测试网上 Polyhedra / Google Cloud DVN 不可用，仅使用 LZ Labs。");

    const bscTestnetRpc  = process.env.BSC_TESTNET_RPC_URL ?? "https://bsc-testnet.publicnode.com";
    const sepoliaPub    = createPublicClient({ chain: sepolia,     transport: http(process.env.SEPOLIA_RPC_URL) });
    const bscPub        = createPublicClient({ chain: bscTestnet,  transport: http(bscTestnetRpc) });
    const sepoliaWallet = createWalletClient({ account, chain: sepolia,    transport: http(process.env.SEPOLIA_RPC_URL) });
    const bscWallet     = createWalletClient({ account, chain: bscTestnet, transport: http(bscTestnetRpc) });

    // Sepolia 侧：配置 Dispatcher 发送方向的 DVN
    await applyConfig(
      sepoliaPub, sepoliaWallet,
      DISPATCHER, EID_BSC_TESTNET,
      [DVN.sepoliaTestnet.lzLabs],
      "Dispatcher SEND → BSCTestnet",
      true,
    );

    // BSC 侧：配置 Executor 接收方向的 DVN
    await applyConfig(
      bscPub, bscWallet,
      EXECUTOR, EID_SEPOLIA,
      [DVN.bscTestnet.lzLabs],
      "Executor RECEIVE ← Sepolia",
      false,
    );

  } else if (network === "mainnet") {
    console.log("=== 写入主网 DVN 配置（三 DVN：LZ Labs + Polyhedra + Google Cloud）===");
    console.log("⚠️  执行前请在 https://docs.layerzero.network/v2/developers/evm/technical-reference/dvn-addresses 核对 DVN 地址");
    console.log("⚠️  主网操作不可撤销，确认无误再继续");

    const { createPublicClient: cpc, createWalletClient: cwc } = await import("viem");
    const { mainnet } = await import("viem/chains");

    const ethPub    = createPublicClient({ chain: mainnet, transport: http(process.env.ETH_MAINNET_RPC_URL) });
    const bscPub    = createPublicClient({ chain: bsc,     transport: http(process.env.BSC_MAINNET_RPC_URL ?? "https://bsc-dataseed.binance.org") });
    const ethWallet = createWalletClient({ account, chain: mainnet, transport: http(process.env.ETH_MAINNET_RPC_URL) });
    const bscWallet = createWalletClient({ account, chain: bsc,     transport: http(process.env.BSC_MAINNET_RPC_URL ?? "https://bsc-dataseed.binance.org") });

    const ethDvns = [DVN.ethereum.lzLabs, DVN.ethereum.polyhedra, DVN.ethereum.googleCloud];
    const bscDvns = [DVN.bscMainnet.lzLabs, DVN.bscMainnet.polyhedra, DVN.bscMainnet.googleCloud];

    // 主网上 Dispatcher 发送方向（目标链 BSC mainnet EID 30102）
    await applyConfig(
      ethPub, ethWallet,
      DISPATCHER, EID_BSC_MAINNET,
      ethDvns,
      "Dispatcher SEND → BSCMainnet (3 DVN)",
      true,
    );

    // 主网上 Executor 接收方向（来源链 Ethereum mainnet EID 30101）
    await applyConfig(
      bscPub, bscWallet,
      EXECUTOR, EID_ETHEREUM,
      bscDvns,
      "Executor RECEIVE ← Ethereum (3 DVN)",
      false,
    );

  } else {
    console.error("用法: ts-node scripts/configure-dvn.ts set [testnet|mainnet]");
    process.exit(1);
  }

} else {
  console.log(`
用法：
  npx ts-node scripts/configure-dvn.ts check              # 查看当前配置
  npx ts-node scripts/configure-dvn.ts set testnet        # 测试网（单 DVN）
  npx ts-node scripts/configure-dvn.ts set mainnet        # 主网（三 DVN）
`);
}
