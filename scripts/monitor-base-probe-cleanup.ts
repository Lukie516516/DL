/** Read-only monitor for proposal #27's Base-only cleanup message. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { base, mainnet } from "viem/chains";
import {
  BASE_CHAIN_KEY, BASE_EXECUTOR, BASE_PROBE, BROADCASTER, BSC_CHAIN_KEY,
  GOVERNANCE, broadcasterAbi, executorAbi, governanceAbi,
} from "./lib/cross-chain-message-fee-canary.js";

const EXECUTION_FILE = "deployments/base-probe-cleanup-execution.json";
const FINAL_FILE = "deployments/base-probe-cleanup-final-verification.json";
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
  if (!existsSync(EXECUTION_FILE)) throw new Error("Base Probe cleanup execution record missing");
  const record = JSON.parse(readFileSync(EXECUTION_FILE, "utf8"));
  const eth: any = createPublicClient({ chain: mainnet, transport: http(process.env.ETH_MAINNET_RPC_URL?.trim() || "https://eth-mainnet.public.blastapi.io", { timeout: 30_000 }) });
  const baseClient: any = createPublicClient({ chain: base, transport: http(process.env.BASE_MAINNET_RPC_URL?.trim() || "https://base-mainnet.public.blastapi.io", { timeout: 30_000 }) });
  const timeoutMs = Number(process.env.BASE_PROBE_CLEANUP_MONITOR_TIMEOUT_MS || 1_200_000);
  const intervalMs = Number(process.env.BASE_PROBE_CLEANUP_MONITOR_INTERVAL_MS || 15_000);
  const started = Date.now();
  let last = "";
  while (Date.now() - started <= timeoutMs) {
    const [status, attempts, probeAllowed, selfAllowed, threshold, proposalState, proposal,
      broadcastNonce, bscRoute, baseRoute, baseBlock] = await Promise.all([
      baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "confirmStatus", args: [record.broadcast.messageHash] }),
      baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "executionAttempts", args: [record.broadcast.messageHash] }),
      baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BASE_PROBE] }),
      baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BASE_EXECUTOR] }),
      baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
      eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [27n] }),
      eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [27n] }),
      eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
      eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BSC_CHAIN_KEY] }),
      eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
      baseClient.getBlockNumber(),
    ]);
    const output = { checkedAt: new Date().toISOString(), transactionSent: false, eth: { proposalState, proposalExecuted: proposal.executed,
      broadcastNonce, bscRouteActive: bscRoute[6], baseRouteActive: baseRoute[6] }, base: { block: baseBlock,
      confirmations: { layerZero: status[0], chainlinkCcip: status[1], axelar: status[2], count: status[3] },
      executed: status[4], attempts, probeAllowed, executorSelfAllowed: selfAllowed, threshold } };
    const signature = stringify({ eth: output.eth, base: output.base });
    if (signature !== last) { console.log(stringify(output)); last = signature; }
    const healthy = proposalState === 6 && proposal.executed && broadcastNonce === BigInt(record.broadcast.nonce)
      && bscRoute[6] && baseRoute[6] && status[3] >= 2n && status[4] && attempts === 1n
      && !probeAllowed && selfAllowed && threshold === 2n;
    if (healthy) {
      const final = { schemaVersion: 1, stage: "base-probe-closed", verifiedAt: new Date().toISOString(), proposalId: 27,
        executionTransaction: record.transactions.execute.hash, broadcastNonce: record.broadcast.nonce,
        messageHash: record.broadcast.messageHash, ...output, healthy: true };
      writeFileSync(FINAL_FILE, `${stringify(final)}\n`, "utf8");
      console.log(stringify({ status: "PASS", finalFile: FINAL_FILE, ...final }));
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error("timeout waiting for Base Probe cleanup; latest state printed above");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
