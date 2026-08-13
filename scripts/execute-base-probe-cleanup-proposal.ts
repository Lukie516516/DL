/** Execute proposal #27 with temporary BSC route isolation, then always restore the route. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, decodeEventLog, encodeAbiParameters,
  encodeFunctionData, http, keccak256, parseAbi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, bsc, mainnet } from "viem/chains";
import {
  ACTION_FEE_BUDGET, BASE_CHAIN_KEY, BASE_EXECUTOR, BASE_FACTORY, BASE_PROBE,
  BROADCASTER, BSC_CHAIN_KEY, BSC_FACTORY, CANARY_MESSAGE_FEE, CURRENT_MESSAGE_FEE,
  GOVERNANCE, LZ_GAS, MAJOR, OWNER, REGISTRY, broadcasterAbi, executorAbi,
  factoryAbi, governanceAbi, registryAbi,
} from "./lib/cross-chain-message-fee-canary.js";
import {
  BASE_PROBE_CLEANUP_DESCRIPTION, buildBaseProbeCleanupBroadcastCalldata,
  buildBaseProbeCleanupInnerCalldata,
} from "./lib/base-probe-cleanup.js";

const PROPOSAL_ID = 27n;
const PASSED = 3;
const EXECUTED = 6;
const CONFIRM = "EXECUTE_EXACT_BASE_PROBE_CLEANUP_27";
const PROPOSAL_FILE = "deployments/base-probe-cleanup-proposal.json";
const RESTORE_FINAL_FILE = "deployments/cross-chain-message-fee-restore-final-verification.json";
const PROGRESS_FILE = "deployments/base-probe-cleanup-execution-progress.json";
const OUTPUT_FILE = "deployments/base-probe-cleanup-execution.json";
const eventsAbi = parseAbi([
  "event ProposalExecuted(uint256 indexed proposalId)",
  "event Broadcast(uint256 indexed nonce,uint32[] targetChainIds,address[] targets,bytes data)",
  "event BroadcastToChain(uint256 indexed nonce,uint32 indexed chainId,address indexed target,bytes32 lzGuid,bytes32 ccipMessageId)",
]);
type Status = readonly [boolean, boolean, boolean, bigint, boolean];

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) process.env[match[1].trim()] = match[2].trim();
  }
}
function key(): Hex {
  const raw = process.env.ETH_MAINNET_PRIVATE_KEY?.trim() || process.env.AGIKING_PRIVATE_KEY?.trim();
  if (!raw) throw new Error("Missing ETH_MAINNET_PRIVATE_KEY or AGIKING_PRIVATE_KEY");
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}
function same(a: unknown, b: unknown) { return String(a).toLowerCase() === String(b).toLowerCase(); }
function assertThat(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function stringify(value: unknown) { return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2); }
function messageHash(nonce: bigint, target: Address, data: Hex) {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
    [nonce, target, data],
  ));
}
function emptyStatus(status: Status, attempts: bigint) {
  return !status[0] && !status[1] && !status[2] && status[3] === 0n && !status[4] && attempts === 0n;
}

async function main() {
  loadEnv();
  const mode = process.argv[2] || "preflight";
  assertThat(mode === "preflight" || mode === "execute", "mode must be preflight or execute");
  if (existsSync(OUTPUT_FILE)) {
    console.log(stringify({ status: "PASS_ALREADY_EXECUTED", outputFile: OUTPUT_FILE, ...JSON.parse(readFileSync(OUTPUT_FILE, "utf8")) }));
    return;
  }
  const proposalRecord = JSON.parse(readFileSync(PROPOSAL_FILE, "utf8"));
  const restoreRecord = JSON.parse(readFileSync(RESTORE_FINAL_FILE, "utf8"));
  assertThat(proposalRecord.stage === "proposal-created" && BigInt(proposalRecord.verification.proposalId) === PROPOSAL_ID, "proposal record mismatch");
  assertThat(restoreRecord.stage === "destinations-executed" && restoreRecord.healthy === true
    && BigInt(restoreRecord.targetPrice) === CURRENT_MESSAGE_FEE, "proposal #26 destination restore is not final");

  const ethRpc = process.env.ETH_MAINNET_RPC_URL?.trim() || "https://eth-mainnet.public.blastapi.io";
  const bscRpc = process.env.BSC_MAINNET_RPC_URL?.trim() || "https://bsc-mainnet.public.blastapi.io";
  const baseRpc = process.env.BASE_MAINNET_RPC_URL?.trim() || "https://base-mainnet.public.blastapi.io";
  const eth: any = createPublicClient({ chain: mainnet, transport: http(ethRpc, { timeout: 30_000 }) });
  const bscClient: any = createPublicClient({ chain: bsc, transport: http(bscRpc, { timeout: 30_000 }) });
  const baseClient: any = createPublicClient({ chain: base, transport: http(baseRpc, { timeout: 30_000 }) });
  assertThat(await eth.getChainId() === 1 && await bscClient.getChainId() === 56 && await baseClient.getChainId() === 8453, "RPC chain mismatch");

  const inner = buildBaseProbeCleanupInnerCalldata();
  const outer = buildBaseProbeCleanupBroadcastCalldata();
  assertThat(same(proposalRecord.innerCalldata, inner) && same(proposalRecord.broadcastCalldata, outer), "saved cleanup calldata mismatch");
  const [state, proposal, actions, actionAllowed, broadcasterOwner, broadcastNonce, chainIds,
    bscRoute, baseRoute, bscPrice, basePrice, baseOwner, baseSelfAllowed, baseProbeAllowed,
    baseThreshold, latestNonce, pendingNonce, walletEth] = await Promise.all([
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [PROPOSAL_ID] }),
    eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isActionAllowed", args: [MAJOR, BROADCASTER, ACTION_FEE_BUDGET, outer] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "owner" }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "getChainIds" }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BSC_CHAIN_KEY] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
    bscClient.readContract({ address: BSC_FACTORY, abi: factoryAbi, functionName: "msgPriceAmountInToken" }),
    baseClient.readContract({ address: BASE_FACTORY, abi: factoryAbi, functionName: "msgPriceAmountInToken" }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "owner" }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BASE_EXECUTOR] }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BASE_PROBE] }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
    eth.getTransactionCount({ address: OWNER, blockTag: "latest" }),
    eth.getTransactionCount({ address: OWNER, blockTag: "pending" }),
    eth.getBalance({ address: OWNER }),
  ]);
  assertThat(state === PASSED && proposal.totalStaked >= 70n * 10n ** 18n && !proposal.executed, "proposal #27 is not executable");
  assertThat(proposal.description === BASE_PROBE_CLEANUP_DESCRIPTION && actions[0].length === 1
    && same(actions[0][0], BROADCASTER) && actions[1][0] === ACTION_FEE_BUDGET
    && same(actions[2][0], outer), "proposal #27 action/description mismatch");
  assertThat(actionAllowed && same(broadcasterOwner, OWNER), "policy or broadcaster owner mismatch");
  assertThat(chainIds.join(",") === `${BSC_CHAIN_KEY},${BASE_CHAIN_KEY}` && bscRoute[6] && baseRoute[6], "routes must both be active before isolation");
  assertThat(bscPrice === CURRENT_MESSAGE_FEE && basePrice === CURRENT_MESSAGE_FEE, "proposal #26 price restore is not live");
  assertThat(same(baseOwner, BASE_EXECUTOR) && baseSelfAllowed && baseProbeAllowed && baseThreshold === 2n, "Base Executor cleanup prerequisite mismatch");
  assertThat(latestNonce === pendingNonce && walletEth > ACTION_FEE_BUDGET, "signer nonce or ETH balance prerequisite failed");
  let blockedWithBothRoutes = false;
  try {
    await eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "quoteFees", args: [[BASE_CHAIN_KEY], [BASE_EXECUTOR], inner, LZ_GAS] });
  } catch { blockedWithBothRoutes = true; }
  assertThat(blockedWithBothRoutes, "Base-only action must be blocked while both routes are active");
  const expectedNonce = broadcastNonce + 1n;
  const baseHash = messageHash(expectedNonce, BASE_EXECUTOR, inner);
  const [baseStatus, baseAttempts] = await Promise.all([
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "confirmStatus", args: [baseHash] }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "executionAttempts", args: [baseHash] }),
  ]);
  assertThat(emptyStatus(baseStatus, baseAttempts), "expected Base cleanup message hash already used");
  console.log(stringify({ status: "PASS", mode, proposalId: PROPOSAL_ID, broadcastNonceBefore: broadcastNonce,
    expectedNonce, baseMessageHash: baseHash, bscAndBaseRoutesActive: true, baseOnlyActionBlockedUntilIsolation: true,
    bscAndBasePrice: CURRENT_MESSAGE_FEE, baseProbeAllowedBefore: true, noWriteYet: true }));
  if (mode === "preflight") return;
  assertThat(process.env.BASE_PROBE_CLEANUP_EXECUTION_CONFIRM === CONFIRM, "write gate closed");
  const account = privateKeyToAccount(key());
  assertThat(same(account.address, OWNER), `signer mismatch: ${account.address}`);
  const wallet: any = createWalletClient({ account, chain: mainnet, transport: http(ethRpc, { timeout: 30_000 }) });
  const progress: any = { schemaVersion: 1, stage: "starting", startedAt: new Date().toISOString(), proposalId: PROPOSAL_ID,
    broadcastNonceBefore: broadcastNonce, expectedNonce, baseMessageHash: baseHash, transactions: {} };
  const saveProgress = () => writeFileSync(PROGRESS_FILE, `${stringify(progress)}\n`, "utf8");
  saveProgress();

  let executeRecord: any;
  try {
    const disableData = encodeFunctionData({ abi: broadcasterAbi, functionName: "setChainActive", args: [BSC_CHAIN_KEY, false] });
    const disableHash = await wallet.writeContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "setChainActive", args: [BSC_CHAIN_KEY, false], nonce: pendingNonce });
    const disableReceipt = await eth.waitForTransactionReceipt({ hash: disableHash, confirmations: 1, timeout: 300_000 });
    const disableTx = await eth.getTransaction({ hash: disableHash });
    assertThat(disableReceipt.status === "success" && same(disableTx.from, OWNER) && disableTx.to && same(disableTx.to, BROADCASTER)
      && disableTx.value === 0n && same(disableTx.input, disableData), "BSC route isolation transaction mismatch");
    progress.stage = "bsc-route-isolated";
    progress.transactions.routeDisable = { hash: disableHash, nonce: disableTx.nonce, blockNumber: disableReceipt.blockNumber, gasUsed: disableReceipt.gasUsed, status: disableReceipt.status };
    saveProgress();
    const [isolatedBscRoute, isolatedBaseRoute, quote] = await Promise.all([
      eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BSC_CHAIN_KEY] }),
      eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
      eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "quoteFees", args: [[BASE_CHAIN_KEY], [BASE_EXECUTOR], inner, LZ_GAS] }),
    ]);
    assertThat(!isolatedBscRoute[6] && isolatedBaseRoute[6] && quote > 0n && quote <= ACTION_FEE_BUDGET, "route isolation or Base-only quote mismatch");
    await eth.simulateContract({ account: OWNER, address: GOVERNANCE, abi: governanceAbi, functionName: "execute", args: [PROPOSAL_ID], value: ACTION_FEE_BUDGET });
    const executeNonce = await eth.getTransactionCount({ address: OWNER, blockTag: "pending" });
    const executeData = encodeFunctionData({ abi: governanceAbi, functionName: "execute", args: [PROPOSAL_ID] });
    const executeHash = await wallet.writeContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "execute", args: [PROPOSAL_ID], value: ACTION_FEE_BUDGET, nonce: executeNonce });
    const executeReceipt = await eth.waitForTransactionReceipt({ hash: executeHash, confirmations: 1, timeout: 300_000 });
    const executeTx = await eth.getTransaction({ hash: executeHash });
    assertThat(executeReceipt.status === "success" && same(executeTx.from, OWNER) && executeTx.to && same(executeTx.to, GOVERNANCE)
      && executeTx.value === ACTION_FEE_BUDGET && same(executeTx.input, executeData), "proposal #27 execution transaction mismatch");
    const proposalLogs = executeReceipt.logs.filter((log: any) => same(log.address, GOVERNANCE)).map((log: any) => {
      try { return decodeEventLog({ abi: eventsAbi, topics: log.topics, data: log.data }); } catch { return undefined; }
    }).filter(Boolean) as any[];
    const broadcastLogs = executeReceipt.logs.filter((log: any) => same(log.address, BROADCASTER)).map((log: any) => {
      try { return decodeEventLog({ abi: eventsAbi, topics: log.topics, data: log.data }); } catch { return undefined; }
    }).filter(Boolean) as any[];
    const proposalEvent = proposalLogs.find(x => x.eventName === "ProposalExecuted");
    const broadcastEvent = broadcastLogs.find(x => x.eventName === "Broadcast");
    const chainEvents = broadcastLogs.filter(x => x.eventName === "BroadcastToChain");
    assertThat(proposalEvent?.args.proposalId === PROPOSAL_ID && broadcastEvent?.args.nonce === expectedNonce && chainEvents.length === 1, "execution/broadcast events missing");
    assertThat(broadcastEvent.args.targetChainIds.join(",") === `${BASE_CHAIN_KEY}` && same(broadcastEvent.args.targets[0], BASE_EXECUTOR)
      && same(broadcastEvent.args.data, inner) && chainEvents[0].args.chainId === BASE_CHAIN_KEY
      && same(chainEvents[0].args.target, BASE_EXECUTOR), "Base-only broadcast payload mismatch");
    executeRecord = { hash: executeHash, nonce: executeTx.nonce, blockNumber: executeReceipt.blockNumber,
      gasUsed: executeReceipt.gasUsed, value: executeTx.value, status: executeReceipt.status,
      quote, lzGuid: chainEvents[0].args.lzGuid, ccipMessageId: chainEvents[0].args.ccipMessageId };
    progress.stage = "base-broadcast-sent";
    progress.transactions.execute = executeRecord;
    saveProgress();
  } finally {
    // Re-read the route even if an earlier assertion or receipt wait failed. If the
    // isolation transaction landed, restoring BSC takes priority over propagating it.
    const route = await eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BSC_CHAIN_KEY] });
    if (!route[6]) {
      const restoreNonce = await eth.getTransactionCount({ address: OWNER, blockTag: "pending" });
      const restoreData = encodeFunctionData({ abi: broadcasterAbi, functionName: "setChainActive", args: [BSC_CHAIN_KEY, true] });
      const restoreHash = await wallet.writeContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "setChainActive", args: [BSC_CHAIN_KEY, true], nonce: restoreNonce });
      const restoreReceipt = await eth.waitForTransactionReceipt({ hash: restoreHash, confirmations: 1, timeout: 300_000 });
      const restoreTx = await eth.getTransaction({ hash: restoreHash });
      assertThat(restoreReceipt.status === "success" && same(restoreTx.from, OWNER) && restoreTx.to && same(restoreTx.to, BROADCASTER)
        && restoreTx.value === 0n && same(restoreTx.input, restoreData), "BSC route restoration transaction mismatch");
      progress.transactions.routeRestore = { hash: restoreHash, nonce: restoreTx.nonce, blockNumber: restoreReceipt.blockNumber,
        gasUsed: restoreReceipt.gasUsed, status: restoreReceipt.status };
    }
    progress.stage = executeRecord ? "route-restored-after-broadcast" : "route-restored-after-failure";
    saveProgress();
  }
  assertThat(executeRecord, "proposal #27 did not execute");
  const [finalState, finalProposal, finalNonce, finalBscRoute, finalBaseRoute] = await Promise.all([
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [PROPOSAL_ID] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BSC_CHAIN_KEY] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
  ]);
  assertThat(finalState === EXECUTED && finalProposal.executed && finalNonce === expectedNonce, "Ethereum execution state mismatch");
  assertThat(finalBscRoute[6] && finalBaseRoute[6], "BSC/Base routes not both restored");
  const output = { schemaVersion: 1, stage: "base-broadcast-sent-route-restored", executedAt: new Date().toISOString(), proposalId: PROPOSAL_ID,
    transactions: progress.transactions, broadcast: { nonce: expectedNonce, targetChainKey: BASE_CHAIN_KEY, target: BASE_EXECUTOR,
      innerCalldata: inner, messageHash: baseHash, lzGuid: executeRecord.lzGuid, ccipMessageId: executeRecord.ccipMessageId },
    verification: { ethExecuted: true, baseOnlyBroadcast: true, bscRouteRestored: true, baseRouteActive: true,
      baseProbeChangePendingTwoOfThree: true } };
  writeFileSync(OUTPUT_FILE, `${stringify(output)}\n`, "utf8");
  console.log(stringify({ status: "PASS_BASE_BROADCAST_SENT_AND_ROUTE_RESTORED", outputFile: OUTPUT_FILE, ...output }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
