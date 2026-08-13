/**
 * test-triple-bridge-e2e.ts
 *
 * 三桥跨链端到端测试：
 *   Sepolia CrossChainBroadcaster.broadcast([BSC], [MockTarget], setParam(42))
 *   -> LZ / Wormhole / Axelar 到达 BSC testnet DualBridgeExecutor
 *   -> 2-of-3 阈值满足后执行 MockTarget.setParam(42)
 *
 * 用法：
 *   node --import tsx/esm scripts/test-triple-bridge-e2e.ts setup
 *   node --import tsx/esm scripts/test-triple-bridge-e2e.ts broadcast
 *   node --import tsx/esm scripts/test-triple-bridge-e2e.ts check
 *   node --import tsx/esm scripts/test-triple-bridge-e2e.ts deliver
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  http,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet, sepolia } from "viem/chains";

const LZ_EID_BSC_TESTNET = 40102;
const WH_RELAYER_BSC_TESTNET = "0x80aC94316391752A193C1c47E27D382b507c93F3" as Address;
const WH_CHAIN_SEPOLIA = 10002;
const WH_EMITTER = "0000000000000000000000007b1bd7a6b4e61c2a123ac6bc2cbfc614437d0470";

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

const BRIDGE_STATE = ".triple-bridge-state.json";
const E2E_STATE = ".triple-bridge-e2e-state.json";

type Artifact = { abi: readonly unknown[]; bytecode: `0x${string}` };

function artifact(path: string): Artifact {
  return JSON.parse(readFileSync(`artifacts/contracts/${path}`, "utf8")) as Artifact;
}

function loadBridge(): { broadcaster: Address; executor: Address } {
  const s = JSON.parse(readFileSync(BRIDGE_STATE, "utf8"));
  return { broadcaster: getAddress(s.broadcaster), executor: getAddress(s.executor) };
}

function loadE2E(): Record<string, string> {
  return existsSync(E2E_STATE) ? JSON.parse(readFileSync(E2E_STATE, "utf8")) : {};
}

function saveE2E(s: Record<string, string>) {
  writeFileSync(E2E_STATE, JSON.stringify(s, null, 2));
}

async function waitFor(client: typeof sepoliaPub | typeof bscPub, hash: `0x${string}`, label: string) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  console.log(`  ✓ ${label}: ${hash}`);
  return receipt;
}

const broadcasterAbi = () => artifact("bridge/CrossChainBroadcaster.sol/CrossChainBroadcaster.json").abi;
const executorAbi = () => artifact("bridge/DualBridgeExecutor.sol/DualBridgeExecutor.json").abi;
const mockArtifact = () => artifact("test/MockTarget.sol/MockTarget.json");

const MOCK_TARGET_ABI = [
  { name: "setParam", type: "function", stateMutability: "nonpayable", inputs: [{ name: "value", type: "uint256" }], outputs: [] },
  { name: "param", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "lastCaller", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "callCount", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const [,, cmd] = process.argv;

if (cmd === "setup") {
  const { executor } = loadBridge();
  const mock = mockArtifact();
  console.log("Executor:", executor);
  console.log("Deployer:", account.address);

  const deployData = encodeDeployData({ abi: mock.abi, bytecode: mock.bytecode, args: [] });
  const deployHash = await bscWlt.sendTransaction({ data: deployData, account, chain: bscTestnet });
  const deployReceipt = await waitFor(bscPub, deployHash, "MockTarget deploy");
  const mockTarget = getAddress(deployReceipt.contractAddress!) as Address;
  console.log("MockTarget:", mockTarget);

  await waitFor(
    bscPub,
    await bscWlt.writeContract({
      address: executor,
      abi: executorAbi(),
      functionName: "setAllowedTarget",
      args: [mockTarget, true],
      account,
      chain: bscTestnet,
    }),
    "Executor.setAllowedTarget(MockTarget, true)",
  );

  const [allowed, threshold] = await Promise.all([
    bscPub.readContract({ address: executor, abi: executorAbi(), functionName: "allowedTargets", args: [mockTarget] }),
    bscPub.readContract({ address: executor, abi: executorAbi(), functionName: "threshold" }),
  ]);
  console.log("allowed:", allowed);
  console.log("threshold:", threshold);
  saveE2E({ ...loadE2E(), mockTarget });

} else if (cmd === "broadcast") {
  const { broadcaster, executor } = loadBridge();
  const state = loadE2E();
  if (!state.mockTarget) throw new Error("Run setup first");

  const bcAbi = broadcasterAbi();
  const exAbi = executorAbi();
  const mockTarget = getAddress(state.mockTarget) as Address;
  const value = 42n;
  const lzGas = 200_000n;
  const calldata = encodeFunctionData({ abi: MOCK_TARGET_ABI, functionName: "setParam", args: [value] });
  const targetChainIds = [LZ_EID_BSC_TESTNET];
  const targets = [mockTarget];

  const totalFee = await sepoliaPub.readContract({
    address: broadcaster,
    abi: bcAbi,
    functionName: "quoteFees",
    args: [targetChainIds, targets, calldata, lzGas],
  }) as bigint;
  const nonceBefore = await sepoliaPub.readContract({
    address: broadcaster,
    abi: bcAbi,
    functionName: "broadcastNonce",
  }) as bigint;
  const nonce = nonceBefore + 1n;
  const msgHash = await bscPub.readContract({
    address: executor,
    abi: exAbi,
    functionName: "calcMsgHash",
    args: [nonce, mockTarget, calldata],
  }) as `0x${string}`;

  console.log("target:", mockTarget);
  console.log("msgHash:", msgHash);
  console.log("totalFee:", totalFee.toString());

  const hash = await sepoliaWlt.writeContract({
    address: broadcaster,
    abi: bcAbi,
    functionName: "broadcast",
    args: [targetChainIds, targets, calldata, lzGas],
    value: totalFee + 2_000_000_000_000_000n,
    account,
    chain: sepolia,
  } as any);
  const receipt = await waitFor(sepoliaPub, hash, "Broadcaster.broadcast");
  console.log("block:", receipt.blockNumber.toString());

  saveE2E({
    ...state,
    msgHash,
    broadcastTx: hash,
    expectedParam: String(value),
  });
  console.log("Wait 1-3 minutes, then run check. If WH is missing, run deliver.");

} else if (cmd === "check") {
  const { executor } = loadBridge();
  const state = loadE2E();
  if (!state.msgHash || !state.mockTarget) throw new Error("Run broadcast first");

  const exAbi = executorAbi();
  const mockTarget = getAddress(state.mockTarget) as Address;
  const expectedParam = BigInt(state.expectedParam ?? "42");
  const msgHash = state.msgHash as `0x${string}`;

  const [status, threshold, param, lastCaller, callCount] = await Promise.all([
    bscPub.readContract({ address: executor, abi: exAbi, functionName: "confirmStatus", args: [msgHash] }) as Promise<[boolean, boolean, boolean, bigint, boolean]>,
    bscPub.readContract({ address: executor, abi: exAbi, functionName: "threshold" }) as Promise<bigint>,
    bscPub.readContract({ address: mockTarget, abi: MOCK_TARGET_ABI, functionName: "param" }) as Promise<bigint>,
    bscPub.readContract({ address: mockTarget, abi: MOCK_TARGET_ABI, functionName: "lastCaller" }) as Promise<Address>,
    bscPub.readContract({ address: mockTarget, abi: MOCK_TARGET_ABI, functionName: "callCount" }) as Promise<bigint>,
  ]);
  const [lz, wh, ax, count, executed] = status;
  console.log(`confirmations: LZ=${lz} WH=${wh} AX=${ax} ${count}/${threshold}`);
  console.log("executed:", executed);
  console.log("param:", param.toString(), "expected:", expectedParam.toString());
  console.log("lastCaller:", lastCaller);
  console.log("callCount:", callCount.toString());

} else if (cmd === "deliver") {
  const state = loadE2E();
  if (!state.broadcastTx) throw new Error("Run broadcast first");

  const receipt = await sepoliaPub.getTransactionReceipt({ hash: state.broadcastTx as `0x${string}` });
  let whSeq: bigint | undefined;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: broadcasterAbi(),
        eventName: "BroadcastToChain",
        topics: log.topics,
        data: log.data,
      });
      const args = decoded.args as { chainId: bigint | number; target: Address; whSeq: bigint };
      if (Number(args.chainId) === LZ_EID_BSC_TESTNET) {
        whSeq = args.whSeq;
        break;
      }
    } catch {}
  }
  if (whSeq === undefined) throw new Error("BroadcastToChain event not found");

  const url = `https://api.testnet.wormholescan.io/v1/signed_vaa/${WH_CHAIN_SEPOLIA}/${WH_EMITTER}/${whSeq}`;
  console.log("VAA:", url);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`VAA not ready: ${resp.status} ${await resp.text()}`);
  const json = await resp.json() as { vaaBytes?: string };
  if (!json.vaaBytes) throw new Error("Missing vaaBytes: " + JSON.stringify(json).slice(0, 200));
  const vaaHex = ("0x" + Buffer.from(json.vaaBytes, "base64").toString("hex")) as `0x${string}`;

  const deliverAbi = [{
    name: "deliver",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "encodedVMs", type: "bytes[]" },
      { name: "encodedDeliveryVAA", type: "bytes" },
      { name: "relayerRefundAddress", type: "address" },
      { name: "deliveryOverrides", type: "bytes" },
    ],
    outputs: [],
  }] as const;

  await waitFor(
    bscPub,
    await bscWlt.writeContract({
      address: WH_RELAYER_BSC_TESTNET,
      abi: deliverAbi,
      functionName: "deliver",
      args: [[], vaaHex, account.address, "0x"],
      value: 10_000_000_000_000_000n,
      account,
      chain: bscTestnet,
    }),
    "Wormhole manual deliver",
  );

} else {
  console.log("Usage: node --import tsx/esm scripts/test-triple-bridge-e2e.ts [setup|broadcast|check|deliver]");
}
