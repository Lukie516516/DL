/**
 * Execute only the already-succeeded BSC + Base Canary proposal #21.
 *
 * Read-only preflight:
 *   node --import tsx/esm scripts/execute-base-cross-chain-v2-canary-proposal.ts preflight
 *
 * Explicit write gate:
 *   BASE_CROSS_CHAIN_V2_CANARY_EXECUTION_CONFIRM=EXECUTE_PROPOSAL_21_ONLY \
 *     node --import tsx/esm scripts/execute-base-cross-chain-v2-canary-proposal.ts execute
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, bsc, mainnet } from "viem/chains";

const PROPOSAL_FILE = "deployments/base-cross-chain-v2-canary-proposal.json";
const OUTPUT_FILE = "deployments/base-cross-chain-v2-canary-execution.json";
const CONFIRM = "EXECUTE_PROPOSAL_21_ONLY";
const PROPOSAL_ID = 21n;
const SUCCEEDED = 3;
const EXECUTED = 6;
const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const GOVERNANCE = getAddress("0x9a41a9A85C16F590789C846Fb933fF8C715407F7");
const BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const BSC_EXECUTOR = getAddress("0x407381d841DD48bBBd40Bd37f9dB268CE75950A8");
const BSC_PROBE = getAddress("0xd31C6417aE0C267F8C5bd634B96dA7590E6E6aB3");
const BASE_EXECUTOR = getAddress("0xf92cE4DBA86eDbfAdEA32880a04FF1123a188218");
const BASE_PROBE = getAddress("0x61921eCb954FFaAf8cd3Fd2e71EeCB14B3eD529f");
const BSC_CHAIN_KEY = 30_102;
const BASE_CHAIN_KEY = 30_184;
const EXECUTION_VALUE = parseEther("0.005");
const FAST_PASS = parseEther("70");
const LZ_GAS = 500_000n;
const ZERO_MARKER = `0x${"00".repeat(32)}` as Hex;

const governanceAbi = parseAbi([
  "function state(uint256) view returns (uint8)",
  "function fastPassThreshold() view returns (uint256)",
  "function getProposal(uint256) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description))",
  "function getActions(uint256) view returns (address[] targets,uint256[] values,bytes[] calldatas)",
  "function execute(uint256) payable",
  "event ProposalExecuted(uint256 indexed proposalId)",
]);
const broadcasterAbi = parseAbi([
  "function chains(uint32) view returns (uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
  "function broadcastNonce() view returns (uint256)",
  "function quoteFees(uint32[],address[],bytes,uint128) view returns (uint256)",
  "event Broadcast(uint256 indexed nonce,uint32[] targetChainIds,address[] targets,bytes data)",
  "event BroadcastToChain(uint256 indexed nonce,uint32 indexed chainId,address indexed target,bytes32 lzGuid,bytes32 ccipMessageId)",
]);
const executorAbi = parseAbi([
  "function threshold() view returns (uint256)",
  "function allowedTargets(address) view returns (bool)",
  "function confirmStatus(bytes32) view returns (bool lzConfirmed,bool ccipConfirmed,bool axConfirmed,uint256 count,bool isExecuted)",
  "function executionAttempts(bytes32) view returns (uint256)",
]);
const probeAbi = parseAbi([
  "function marker() view returns (bytes32)",
  "function updateCount() view returns (uint256)",
]);

type ProposalRecord = {
  stage: string;
  proposalId: string;
  proposer: Address;
  governance: Address;
  broadcaster: Address;
  description: string;
  marker: Hex;
  markerCalldata: Hex;
  broadcastCalldata: Hex;
  executionValueBudget: string;
  broadcastNonceBefore: string;
};

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) process.env[match[1].trim()] = match[2].trim();
  }
}
function signerKey(): Hex {
  const raw = process.env.ETH_MAINNET_PRIVATE_KEY?.trim() || process.env.AGIKING_PRIVATE_KEY?.trim();
  if (!raw) throw new Error("Missing ETH_MAINNET_PRIVATE_KEY or AGIKING_PRIVATE_KEY");
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
function same(a: unknown, b: unknown) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}
function assertThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function stringify(value: unknown) {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}
function messageHash(nonce: bigint, target: Address, data: Hex) {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
    [nonce, target, data],
  ));
}
function emptyStatus(status: readonly [boolean, boolean, boolean, bigint, boolean], attempts: bigint) {
  return !status[0] && !status[1] && !status[2] && status[3] === 0n && !status[4] && attempts === 0n;
}

async function main() {
  loadEnv();
  const mode = process.argv[2] || "preflight";
  assertThat(mode === "preflight" || mode === "execute", "mode must be preflight or execute");
  const saved = JSON.parse(readFileSync(PROPOSAL_FILE, "utf8")) as ProposalRecord;
  assertThat(saved.stage === "proposal-created" && saved.proposalId === PROPOSAL_ID.toString(), "proposal record mismatch");
  assertThat(same(saved.proposer, OWNER) && same(saved.governance, GOVERNANCE) && same(saved.broadcaster, BROADCASTER), "authority record mismatch");
  assertThat(BigInt(saved.executionValueBudget) === EXECUTION_VALUE, "execution budget mismatch");

  const account = privateKeyToAccount(signerKey());
  assertThat(same(account.address, OWNER), `signer mismatch: ${account.address}`);
  const ethRpc = required("ETH_MAINNET_RPC_URL");
  const bscRpc = process.env.BSC_MAINNET_RPC_URL?.trim() || "https://bsc-mainnet.public.blastapi.io";
  const baseRpc = process.env.BASE_MAINNET_RPC_URL?.trim() || "https://base-mainnet.public.blastapi.io";
  const eth: any = createPublicClient({ chain: mainnet, transport: http(ethRpc, { timeout: 30_000 }) });
  const bscClient: any = createPublicClient({ chain: bsc, transport: http(bscRpc, { timeout: 30_000 }) });
  const baseClient: any = createPublicClient({ chain: base, transport: http(baseRpc, { timeout: 30_000 }) });
  assertThat(await eth.getChainId() === 1 && await bscClient.getChainId() === 56 && await baseClient.getChainId() === 8453, "RPC chain mismatch");

  const nextBroadcastNonce = BigInt(saved.broadcastNonceBefore) + 1n;
  const bscMessageHash = messageHash(nextBroadcastNonce, BSC_PROBE, saved.markerCalldata);
  const baseMessageHash = messageHash(nextBroadcastNonce, BASE_PROBE, saved.markerCalldata);
  const [proposalState, proposal, actions, fastPass, broadcastNonce, bscRoute, baseRoute,
    liveQuote, walletBalance, latestNonce, pendingNonce, bscThreshold, baseThreshold,
    bscAllowed, baseAllowed, bscMarker, bscCount, baseMarker, baseCount,
    bscStatus, bscAttempts, baseStatus, baseAttempts] = await Promise.all([
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "fastPassThreshold" }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BSC_CHAIN_KEY] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "quoteFees", args: [[BSC_CHAIN_KEY, BASE_CHAIN_KEY], [BSC_PROBE, BASE_PROBE], saved.markerCalldata, LZ_GAS] }),
    eth.getBalance({ address: OWNER }),
    eth.getTransactionCount({ address: OWNER, blockTag: "latest" }),
    eth.getTransactionCount({ address: OWNER, blockTag: "pending" }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BSC_PROBE] }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BASE_PROBE] }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "marker" }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "updateCount" }),
    baseClient.readContract({ address: BASE_PROBE, abi: probeAbi, functionName: "marker" }),
    baseClient.readContract({ address: BASE_PROBE, abi: probeAbi, functionName: "updateCount" }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "confirmStatus", args: [bscMessageHash] }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "executionAttempts", args: [bscMessageHash] }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "confirmStatus", args: [baseMessageHash] }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "executionAttempts", args: [baseMessageHash] }),
  ]);

  const actionsExact = actions[0].length === 1 && same(actions[0][0], BROADCASTER)
    && actions[1].length === 1 && actions[1][0] === EXECUTION_VALUE
    && actions[2].length === 1 && same(actions[2][0], saved.broadcastCalldata);
  assertThat(proposalState === SUCCEEDED && proposal.totalStaked >= FAST_PASS && !proposal.executed, "proposal 21 is not executable");
  assertThat(fastPass === FAST_PASS && actionsExact, "threshold or proposal action mismatch");
  assertThat(broadcastNonce === BigInt(saved.broadcastNonceBefore), "broadcast nonce changed before execution");
  assertThat(bscRoute[6] && baseRoute[6], "both routes must remain active");
  assertThat(bscThreshold === 2n && baseThreshold === 2n && bscAllowed && baseAllowed, "destination threshold/allowlist mismatch");
  assertThat(bscMarker === ZERO_MARKER && bscCount === 0n && baseMarker === ZERO_MARKER && baseCount === 0n, "Probe state is not pristine");
  assertThat(emptyStatus(bscStatus, bscAttempts) && emptyStatus(baseStatus, baseAttempts), "Canary message hash was already used");
  assertThat(liveQuote > 0n && liveQuote <= EXECUTION_VALUE, `live quote ${liveQuote} exceeds budget`);
  assertThat(latestNonce === pendingNonce, "execution signer has a pending Ethereum transaction");

  await eth.simulateContract({ account: OWNER, address: GOVERNANCE, abi: governanceAbi, functionName: "execute", args: [PROPOSAL_ID], value: EXECUTION_VALUE });
  const estimatedGas = await eth.estimateContractGas({ account: OWNER, address: GOVERNANCE, abi: governanceAbi, functionName: "execute", args: [PROPOSAL_ID], value: EXECUTION_VALUE });
  assertThat(walletBalance > EXECUTION_VALUE, "execution wallet ETH balance is insufficient");
  const preflight = {
    status: "PASS", mode, proposalId: PROPOSAL_ID, proposalState, totalStakedD: formatEther(proposal.totalStaked),
    liveQuoteWei: liveQuote, executionValueWei: EXECUTION_VALUE, estimatedGas,
    walletBalanceEth: formatEther(walletBalance), signerNonce: pendingNonce,
    broadcastNonceBefore: broadcastNonce, expectedBroadcastNonce: nextBroadcastNonce,
    bscMessageHash, baseMessageHash, actionsExact, simulationPassed: true,
  };
  console.log(stringify(preflight));
  if (mode === "preflight") return;

  assertThat(process.env.BASE_CROSS_CHAIN_V2_CANARY_EXECUTION_CONFIRM === CONFIRM, "write gate is closed");
  assertThat(!existsSync(OUTPUT_FILE), "execution record already exists; refusing to resend");
  const wallet: any = createWalletClient({ account, chain: mainnet, transport: http(ethRpc, { timeout: 30_000 }) });
  const executeCalldata = encodeFunctionData({ abi: governanceAbi, functionName: "execute", args: [PROPOSAL_ID] });
  const hash = await wallet.writeContract({
    account,
    address: GOVERNANCE,
    abi: governanceAbi,
    functionName: "execute",
    args: [PROPOSAL_ID],
    value: EXECUTION_VALUE,
    nonce: pendingNonce,
  });
  const receipt = await eth.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 300_000 });
  const transaction = await eth.getTransaction({ hash });
  assertThat(receipt.status === "success", `execution reverted: ${hash}`);
  assertThat(same(transaction.from, OWNER) && transaction.to && same(transaction.to, GOVERNANCE), "execution sender/target mismatch");
  assertThat(transaction.value === EXECUTION_VALUE && same(transaction.input, executeCalldata), "execution value/calldata mismatch");

  const proposalTopic = toEventSelector("ProposalExecuted(uint256)");
  const broadcastTopic = toEventSelector("Broadcast(uint256,uint32[],address[],bytes)");
  const toChainTopic = toEventSelector("BroadcastToChain(uint256,uint32,address,bytes32,bytes32)");
  const proposalLog = receipt.logs.find((log: any) => same(log.address, GOVERNANCE) && log.topics[0] === proposalTopic);
  const broadcastLog = receipt.logs.find((log: any) => same(log.address, BROADCASTER) && log.topics[0] === broadcastTopic);
  const chainLogs = receipt.logs.filter((log: any) => same(log.address, BROADCASTER) && log.topics[0] === toChainTopic);
  assertThat(proposalLog && broadcastLog && chainLogs.length === 2, "expected execution/broadcast events missing");
  const decodedBroadcast: any = decodeEventLog({ abi: broadcasterAbi, data: broadcastLog.data, topics: broadcastLog.topics });
  assertThat(decodedBroadcast.args.nonce === nextBroadcastNonce, "broadcast event nonce mismatch");
  assertThat(decodedBroadcast.args.targetChainIds.join(",") === `${BSC_CHAIN_KEY},${BASE_CHAIN_KEY}`, "broadcast event chain ids mismatch");
  assertThat(decodedBroadcast.args.targets.length === 2 && same(decodedBroadcast.args.targets[0], BSC_PROBE) && same(decodedBroadcast.args.targets[1], BASE_PROBE), "broadcast event targets mismatch");
  assertThat(same(decodedBroadcast.args.data, saved.markerCalldata), "broadcast event data mismatch");
  const decodedChains = chainLogs.map((log: any) => decodeEventLog({ abi: broadcasterAbi, data: log.data, topics: log.topics }) as any);
  for (const event of decodedChains) {
    assertThat(event.args.nonce === nextBroadcastNonce, "per-chain nonce mismatch");
    assertThat(event.args.lzGuid !== ZERO_MARKER && event.args.ccipMessageId !== ZERO_MARKER, "bridge send id missing");
  }

  const [finalState, finalProposal, finalNonce, immediateBscStatus, immediateBaseStatus,
    immediateBscMarker, immediateBscCount, immediateBaseMarker, immediateBaseCount] = await Promise.all([
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [PROPOSAL_ID] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "confirmStatus", args: [bscMessageHash] }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "confirmStatus", args: [baseMessageHash] }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "marker" }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "updateCount" }),
    baseClient.readContract({ address: BASE_PROBE, abi: probeAbi, functionName: "marker" }),
    baseClient.readContract({ address: BASE_PROBE, abi: probeAbi, functionName: "updateCount" }),
  ]);
  assertThat(finalState === EXECUTED && finalProposal.executed && finalNonce === nextBroadcastNonce, "immediate Ethereum execution verification failed");

  const output = {
    schemaVersion: 1,
    stage: "broadcast-sent",
    executedAt: new Date().toISOString(),
    scope: "execute proposal 21 and broadcast one zero-asset marker to BSC + Base",
    proposalId: PROPOSAL_ID,
    preflight,
    transaction: {
      hash,
      nonce: transaction.nonce,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      valueWei: transaction.value,
      receiptStatus: receipt.status,
      calldataMatched: true,
    },
    broadcast: {
      nonce: nextBroadcastNonce,
      bscMessageHash,
      baseMessageHash,
      targetChainIds: [BSC_CHAIN_KEY, BASE_CHAIN_KEY],
      targets: [BSC_PROBE, BASE_PROBE],
      marker: saved.marker,
      markerCalldata: saved.markerCalldata,
      eventsMatched: true,
      perChainEvents: decodedChains.map((event: any) => ({
        chainId: event.args.chainId,
        target: event.args.target,
        lzGuid: event.args.lzGuid,
        ccipMessageId: event.args.ccipMessageId,
      })),
    },
    immediateDestinationState: {
      bsc: { confirmStatus: immediateBscStatus, marker: immediateBscMarker, updateCount: immediateBscCount },
      base: { confirmStatus: immediateBaseStatus, marker: immediateBaseMarker, updateCount: immediateBaseCount },
    },
  };
  writeFileSync(OUTPUT_FILE, `${stringify(output)}\n`, "utf8");
  console.log(stringify({ status: "PASS", outputFile: OUTPUT_FILE, ...output }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
