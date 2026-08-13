/** Read-only monitor for the BSC+Base message-fee resonance broadcast. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { base, bsc } from "viem/chains";
import { CANARY_MESSAGE_FEE, CURRENT_MESSAGE_FEE, executorAbi, factoryAbi } from "./lib/cross-chain-message-fee-canary.js";

const RESTORE = process.argv.includes("--restore");
const TARGET_PRICE = RESTORE ? CURRENT_MESSAGE_FEE : CANARY_MESSAGE_FEE;
const EXECUTION_FILE = RESTORE
  ? "deployments/cross-chain-message-fee-restore-execution.json"
  : "deployments/cross-chain-message-fee-canary-execution.json";
const FINAL_FILE = RESTORE
  ? "deployments/cross-chain-message-fee-restore-final-verification.json"
  : "deployments/cross-chain-message-fee-canary-final-verification.json";
function stringify(value: unknown) { return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2); }
function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) process.env[match[1].trim()] = match[2].trim();
  }
}

async function main() {
  loadEnv();
  if (!existsSync(EXECUTION_FILE)) throw new Error("canary execution record missing");
  const record = JSON.parse(readFileSync(EXECUTION_FILE, "utf8"));
  const bscClient: any = createPublicClient({ chain: bsc, transport: http(process.env.BSC_MAINNET_RPC_URL?.trim() || "https://bsc-mainnet.public.blastapi.io", { timeout: 30_000 }) });
  const baseClient: any = createPublicClient({ chain: base, transport: http(process.env.BASE_MAINNET_RPC_URL?.trim() || "https://base-mainnet.public.blastapi.io", { timeout: 30_000 }) });
  const timeoutMs = Number(process.env.MESSAGE_FEE_MONITOR_TIMEOUT_MS || 1_200_000);
  const intervalMs = Number(process.env.MESSAGE_FEE_MONITOR_INTERVAL_MS || 15_000);
  const started = Date.now();
  let last = "";
  while (Date.now() - started <= timeoutMs) {
    const [bscStatus, baseStatus, bscAttempts, baseAttempts, bscPrice, basePrice, bscBlock, baseBlock] = await Promise.all([
      bscClient.readContract({ address: record.broadcast.bsc.executor, abi: executorAbi, functionName: "confirmStatus", args: [record.broadcast.bsc.messageHash] }),
      baseClient.readContract({ address: record.broadcast.base.executor, abi: executorAbi, functionName: "confirmStatus", args: [record.broadcast.base.messageHash] }),
      bscClient.readContract({ address: record.broadcast.bsc.executor, abi: executorAbi, functionName: "executionAttempts", args: [record.broadcast.bsc.messageHash] }),
      baseClient.readContract({ address: record.broadcast.base.executor, abi: executorAbi, functionName: "executionAttempts", args: [record.broadcast.base.messageHash] }),
      bscClient.readContract({ address: record.broadcast.bsc.target, abi: factoryAbi, functionName: "msgPriceAmountInToken" }),
      baseClient.readContract({ address: record.broadcast.base.target, abi: factoryAbi, functionName: "msgPriceAmountInToken" }),
      bscClient.getBlockNumber(), baseClient.getBlockNumber(),
    ]);
    const output = { checkedAt: new Date().toISOString(), transactionSent: false,
      bsc: { block: bscBlock, confirmations: { layerZero: bscStatus[0], chainlinkCcip: bscStatus[1], axelar: bscStatus[2], count: bscStatus[3] }, executed: bscStatus[4], attempts: bscAttempts, price: bscPrice },
      base: { block: baseBlock, confirmations: { layerZero: baseStatus[0], chainlinkCcip: baseStatus[1], axelar: baseStatus[2], count: baseStatus[3] }, executed: baseStatus[4], attempts: baseAttempts, price: basePrice } };
    const signature = stringify({ bsc: output.bsc, base: output.base });
    if (signature !== last) { console.log(stringify(output)); last = signature; }
    const healthy = bscStatus[3] >= 2n && bscStatus[4] && bscAttempts === 1n && bscPrice === TARGET_PRICE
      && baseStatus[3] >= 2n && baseStatus[4] && baseAttempts === 1n && basePrice === TARGET_PRICE;
    if (healthy) {
      const final = { schemaVersion: 1, stage: "destinations-executed", verifiedAt: new Date().toISOString(), proposalId: record.proposalId,
        ethTransaction: record.transaction.hash, broadcastNonce: record.broadcast.nonce, targetPrice: TARGET_PRICE, ...output, healthy: true };
      writeFileSync(FINAL_FILE, `${stringify(final)}\n`, "utf8");
      console.log(stringify({ status: "PASS", finalFile: FINAL_FILE, ...final }));
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for both destinations; latest state printed above`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
