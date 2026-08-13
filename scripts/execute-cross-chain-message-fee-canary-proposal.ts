/** Execute only proposal #25 and emit a monitorable BSC+Base message record. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, decodeEventLog, encodeAbiParameters, encodeFunctionData,
  getAddress, http, keccak256, parseAbi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, bsc, mainnet } from "viem/chains";
import {
  ACTION_FEE_BUDGET, BASE_CHAIN_KEY, BASE_EXECUTOR, BASE_FACTORY, BROADCASTER,
  BSC_CHAIN_KEY, BSC_EXECUTOR, BSC_FACTORY, CANARY_DESCRIPTION, CANARY_MESSAGE_FEE,
  CHAIN_FEE_CONFIGS, CURRENT_MESSAGE_FEE, GOVERNANCE, LZ_GAS, MAJOR, OWNER, REGISTRY, RESTORE_DESCRIPTION,
  broadcasterAbi, buildMessageFeeActions, executorAbi, factoryAbi, governanceAbi, registryAbi,
} from "./lib/cross-chain-message-fee-canary.js";

const RESTORE = process.argv.includes("--restore");
const PROPOSAL_ID = RESTORE ? 26n : 25n;
const TARGET_PRICE = RESTORE ? CURRENT_MESSAGE_FEE : CANARY_MESSAGE_FEE;
const SOURCE_PRICE = RESTORE ? CANARY_MESSAGE_FEE : CURRENT_MESSAGE_FEE;
const DESCRIPTION = RESTORE ? RESTORE_DESCRIPTION : CANARY_DESCRIPTION;
const PASSED = 3;
const EXECUTED = 6;
const CONFIRM = RESTORE ? "EXECUTE_EXACT_MESSAGE_FEE_RESTORE_26" : "EXECUTE_EXACT_MESSAGE_FEE_CANARY_25";
const PROPOSAL_FILE = RESTORE
  ? "deployments/cross-chain-message-fee-restore-proposal.json"
  : "deployments/cross-chain-message-fee-canary-proposal.json";
const OUTPUT_FILE = RESTORE
  ? "deployments/cross-chain-message-fee-restore-execution.json"
  : "deployments/cross-chain-message-fee-canary-execution.json";
const eventsAbi = parseAbi([
  "event ProposalExecuted(uint256 indexed proposalId)",
  "event Broadcast(uint256 indexed nonce,uint32[] targetChainIds,address[] targets,bytes data)",
  "event BroadcastToChain(uint256 indexed nonce,uint32 indexed chainId,address indexed target,bytes32 lzGuid,bytes32 ccipMessageId)",
]);
type Status = readonly [boolean, boolean, boolean, bigint, boolean];

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/); if (match && !process.env[match[1].trim()]) process.env[match[1].trim()] = match[2].trim();
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
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "bytes" }], [nonce, target, data]));
}
function emptyStatus(status: Status, attempts: bigint) {
  return !status[0] && !status[1] && !status[2] && status[3] === 0n && !status[4] && attempts === 0n;
}

async function main() {
  loadEnv();
  const mode = process.argv[2] || "preflight";
  assertThat(mode === "preflight" || mode === "execute", "mode must be preflight or execute");
  const saved = JSON.parse(readFileSync(PROPOSAL_FILE, "utf8"));
  assertThat(saved.stage === "proposal-created" && BigInt(saved.verification.proposalId) === PROPOSAL_ID, "proposal record mismatch");
  if (existsSync(OUTPUT_FILE)) {
    const output = JSON.parse(readFileSync(OUTPUT_FILE, "utf8"));
    console.log(stringify({ status: "PASS_ALREADY_EXECUTED", outputFile: OUTPUT_FILE, ...output })); return;
  }
  const ethRpc = process.env.ETH_MAINNET_RPC_URL?.trim() || "https://eth-mainnet.public.blastapi.io";
  const bscRpc = process.env.BSC_MAINNET_RPC_URL?.trim() || "https://bsc-mainnet.public.blastapi.io";
  const baseRpc = process.env.BASE_MAINNET_RPC_URL?.trim() || "https://base-mainnet.public.blastapi.io";
  const eth: any = createPublicClient({ chain: mainnet, transport: http(ethRpc, { timeout: 30_000 }) });
  const bscClient: any = createPublicClient({ chain: bsc, transport: http(bscRpc, { timeout: 30_000 }) });
  const baseClient: any = createPublicClient({ chain: base, transport: http(baseRpc, { timeout: 30_000 }) });
  assertThat(await eth.getChainId() === 1 && await bscClient.getChainId() === 56 && await baseClient.getChainId() === 8453, "RPC chain mismatch");
  const action = buildMessageFeeActions(TARGET_PRICE)[0];
  assertThat(same(saved.broadcastCalldata, action.calldata), "saved broadcast calldata mismatch");
  const expectedNonce = BigInt(saved.broadcastNonceBefore) + 1n;
  const bscHash = messageHash(expectedNonce, BSC_FACTORY, action.innerCalldata);
  const baseHash = messageHash(expectedNonce, BASE_FACTORY, action.innerCalldata);
  const [state, proposal, actions, actionAllowed, broadcastNonce, quote, chainIds, bscRoute, baseRoute,
    latestNonce, pendingNonce, walletEth, bscPrice, basePrice, bscAllowed, baseAllowed, bscThreshold,
    baseThreshold, bscStatus, baseStatus, bscAttempts, baseAttempts] = await Promise.all([
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [PROPOSAL_ID] }),
    eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isActionAllowed", args: [MAJOR, BROADCASTER, ACTION_FEE_BUDGET, action.calldata] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "quoteFees", args: [CHAIN_FEE_CONFIGS.map(x => x.chainKey), CHAIN_FEE_CONFIGS.map(x => x.factory), action.innerCalldata, LZ_GAS] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "getChainIds" }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BSC_CHAIN_KEY] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
    eth.getTransactionCount({ address: OWNER, blockTag: "latest" }), eth.getTransactionCount({ address: OWNER, blockTag: "pending" }), eth.getBalance({ address: OWNER }),
    bscClient.readContract({ address: BSC_FACTORY, abi: factoryAbi, functionName: "msgPriceAmountInToken" }),
    baseClient.readContract({ address: BASE_FACTORY, abi: factoryAbi, functionName: "msgPriceAmountInToken" }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BSC_FACTORY] }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BASE_FACTORY] }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "confirmStatus", args: [bscHash] }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "confirmStatus", args: [baseHash] }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "executionAttempts", args: [bscHash] }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "executionAttempts", args: [baseHash] }),
  ]);
  assertThat(state === PASSED && proposal.totalStaked >= 70n * 10n ** 18n && !proposal.executed, "#25 is not executable");
  assertThat(proposal.description === DESCRIPTION && actions[0].length === 1 && same(actions[0][0], BROADCASTER)
    && actions[1][0] === ACTION_FEE_BUDGET && same(actions[2][0], action.calldata), "proposal action/description mismatch");
  assertThat(actionAllowed && broadcastNonce === BigInt(saved.broadcastNonceBefore), "policy or broadcast nonce mismatch");
  assertThat(chainIds.join(",") === `${BSC_CHAIN_KEY},${BASE_CHAIN_KEY}` && bscRoute[6] && baseRoute[6], "active routes mismatch");
  assertThat(quote > 0n && quote <= ACTION_FEE_BUDGET && walletEth > ACTION_FEE_BUDGET, "execution fee budget unavailable");
  assertThat(latestNonce === pendingNonce, "signer has pending Ethereum transaction");
  assertThat(bscPrice === SOURCE_PRICE && basePrice === SOURCE_PRICE, "destination price changed before execution");
  assertThat(bscAllowed && baseAllowed && bscThreshold === 2n && baseThreshold === 2n, "destination 2-of-3 state mismatch");
  assertThat(emptyStatus(bscStatus, bscAttempts) && emptyStatus(baseStatus, baseAttempts), "expected message hash already used");
  await eth.simulateContract({ account: OWNER, address: GOVERNANCE, abi: governanceAbi, functionName: "execute", args: [PROPOSAL_ID], value: ACTION_FEE_BUDGET });
  const gas = await eth.estimateContractGas({ account: OWNER, address: GOVERNANCE, abi: governanceAbi, functionName: "execute", args: [PROPOSAL_ID], value: ACTION_FEE_BUDGET });
  console.log(stringify({ status: "PASS", mode, proposalId: PROPOSAL_ID, quote, executionValue: ACTION_FEE_BUDGET,
    estimatedGas: gas, broadcastNonceBefore: broadcastNonce, expectedNonce, bscMessageHash: bscHash, baseMessageHash: baseHash, noDestinationChangeYet: true }));
  if (mode === "preflight") return;
  const confirmation = RESTORE ? process.env.CROSS_CHAIN_MESSAGE_FEE_RESTORE_EXECUTION_CONFIRM : process.env.CROSS_CHAIN_MESSAGE_FEE_CANARY_EXECUTION_CONFIRM;
  assertThat(confirmation === CONFIRM, "write gate closed");
  const account = privateKeyToAccount(key()); assertThat(same(account.address, OWNER), `signer mismatch: ${account.address}`);
  const wallet: any = createWalletClient({ account, chain: mainnet, transport: http(ethRpc, { timeout: 30_000 }) });
  const calldata = encodeFunctionData({ abi: governanceAbi, functionName: "execute", args: [PROPOSAL_ID] });
  const hash = await wallet.writeContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "execute", args: [PROPOSAL_ID], value: ACTION_FEE_BUDGET, nonce: pendingNonce });
  const receipt = await eth.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
  const tx = await eth.getTransaction({ hash });
  assertThat(receipt.status === "success" && same(tx.from, OWNER) && tx.to && same(tx.to, GOVERNANCE), "execution receipt/endpoints mismatch");
  assertThat(tx.value === ACTION_FEE_BUDGET && same(tx.input, calldata), "execution calldata/value mismatch");
  const proposalLogs = receipt.logs.filter((log: any) => same(log.address, GOVERNANCE)).map((log: any) => {
    try { return decodeEventLog({ abi: eventsAbi, topics: log.topics, data: log.data }); } catch { return undefined; }
  }).filter(Boolean) as any[];
  const broadcasterLogs = receipt.logs.filter((log: any) => same(log.address, BROADCASTER)).map((log: any) => {
    try { return decodeEventLog({ abi: eventsAbi, topics: log.topics, data: log.data }); } catch { return undefined; }
  }).filter(Boolean) as any[];
  const proposalEvent = proposalLogs.find(x => x.eventName === "ProposalExecuted");
  const broadcastEvent = broadcasterLogs.find(x => x.eventName === "Broadcast");
  const chainEvents = broadcasterLogs.filter(x => x.eventName === "BroadcastToChain");
  assertThat(proposalEvent?.args.proposalId === PROPOSAL_ID && broadcastEvent?.args.nonce === expectedNonce && chainEvents.length === 2, "execution/broadcast events missing");
  assertThat(broadcastEvent.args.targetChainIds.join(",") === `${BSC_CHAIN_KEY},${BASE_CHAIN_KEY}`
    && same(broadcastEvent.args.targets[0], BSC_FACTORY) && same(broadcastEvent.args.targets[1], BASE_FACTORY)
    && same(broadcastEvent.args.data, action.innerCalldata), "broadcast event payload mismatch");
  const [finalState, finalProposal, finalNonce] = await Promise.all([
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [PROPOSAL_ID] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
  ]);
  assertThat(finalState === EXECUTED && finalProposal.executed && finalNonce === expectedNonce, "Ethereum execution state mismatch");
  const output = { schemaVersion: 1, stage: "broadcast-sent", executedAt: new Date().toISOString(), proposalId: PROPOSAL_ID,
    transaction: { hash, nonce: tx.nonce, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, value: tx.value, status: receipt.status },
    broadcast: { nonce: expectedNonce, innerCalldata: action.innerCalldata, targetPrice: TARGET_PRICE,
      bsc: { chainKey: BSC_CHAIN_KEY, executor: BSC_EXECUTOR, target: BSC_FACTORY, messageHash: bscHash },
      base: { chainKey: BASE_CHAIN_KEY, executor: BASE_EXECUTOR, target: BASE_FACTORY, messageHash: baseHash },
      perChainEvents: chainEvents.map(x => ({ chainId: x.args.chainId, target: x.args.target, lzGuid: x.args.lzGuid, ccipMessageId: x.args.ccipMessageId })) },
    verification: { ethExecuted: true, broadcastNonceExact: true, twoChainEvents: true } };
  writeFileSync(OUTPUT_FILE, `${stringify(output)}\n`, "utf8");
  console.log(stringify({ status: "PASS_BROADCAST_SENT", outputFile: OUTPUT_FILE, ...output }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
