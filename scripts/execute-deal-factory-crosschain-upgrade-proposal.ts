/** Executes only DealFactory cross-chain upgrade proposal #23. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  fallback,
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

const CONFIRM = "EXECUTE_FACTORY_CROSSCHAIN_UPGRADE_PROPOSAL_23";
const PROPOSAL_FILE = "deployments/deal-factory-crosschain-upgrade-proposal.json";
const OUTPUT_FILE = "deployments/deal-factory-crosschain-upgrade-execution.json";
const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const GOVERNANCE = getAddress("0x9a41a9A85C16F590789C846Fb933fF8C715407F7");
const BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const BSC_EXECUTOR = getAddress("0x407381d841DD48bBBd40Bd37f9dB268CE75950A8");
const BASE_EXECUTOR = getAddress("0xf92cE4DBA86eDbfAdEA32880a04FF1123a188218");
const BSC_FACTORY = getAddress("0x1Ca748Feb347d0d177E844E7D4CDCA908957c256");
const BASE_FACTORY = getAddress("0x591625Be924B98ACcAb7e2c8aF698c858Aa2608D");
const TARGET_IMPLEMENTATION = getAddress("0x7fC9145A2539F0eD52Cf6E7E34Ce485635A9887E");
const PROPOSAL_ID = 23n;
const SUCCEEDED = 3;
const EXECUTED = 6;
const FAST_PASS = parseEther("70");
const EXECUTION_VALUE = parseEther("0.005");
const BSC_CHAIN_KEY = 30_102;
const BASE_CHAIN_KEY = 30_184;
const LZ_GAS = 500_000n;
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

const governanceAbi = parseAbi([
  "function state(uint256) view returns (uint8)",
  "function fastPassThreshold() view returns (uint256)",
  "function getProposal(uint256) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description,uint48 createdAt))",
  "function getActions(uint256) view returns (address[] targets,uint256[] values,bytes[] calldatas)",
  "function execute(uint256) payable",
  "event ProposalExecuted(uint256 indexed proposalId)",
]);
const broadcasterAbi = parseAbi([
  "function getChainIds() view returns (uint32[])",
  "function chains(uint32) view returns (uint32,uint64,address,string,string,uint256,bool)",
  "function broadcastNonce() view returns (uint256)",
  "function quoteFees(uint32[],address[],bytes,uint128) view returns (uint256)",
  "event Broadcast(uint256 indexed nonce,uint32[] targetChainIds,address[] targets,bytes data)",
  "event BroadcastToChain(uint256 indexed nonce,uint32 indexed chainId,address indexed target,bytes32 lzGuid,bytes32 ccipMessageId)",
]);
const executorAbi = parseAbi([
  "function threshold() view returns (uint256)",
  "function allowedTargets(address) view returns (bool)",
  "function confirmStatus(bytes32) view returns (bool,bool,bool,uint256,bool)",
  "function executionAttempts(bytes32) view returns (uint256)",
]);

type ProposalRecord = {
  stage: string;
  proposalId: string;
  broadcastNonceBefore: string;
  description: string;
  innerUpgradeCalldata: Hex;
  broadcastCalldata: Hex;
  executionValueBudget: string;
  bscImplementationBefore: Address;
  baseImplementationBefore: Address;
};

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] ||= value;
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
function slotAddress(word: Hex | undefined): Address {
  assertThat(word && word.length === 66, "implementation slot unavailable");
  return getAddress(`0x${word.slice(-40)}`);
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
  assertThat(BigInt(saved.executionValueBudget) === EXECUTION_VALUE, "execution budget mismatch");
  assertThat(saved.bscImplementationBefore === TARGET_IMPLEMENTATION && saved.baseImplementationBefore !== TARGET_IMPLEMENTATION, "destination baseline mismatch");

  const account = privateKeyToAccount(key());
  assertThat(same(account.address, OWNER), `signer mismatch: ${account.address}`);
  const configuredEthRpc = process.env.ETH_MAINNET_RPC_URL?.trim();
  const eth: any = createPublicClient({ chain: mainnet, transport: fallback([
    ...(configuredEthRpc ? [http(configuredEthRpc, { timeout: 30_000 })] : []),
    http("https://eth-mainnet.public.blastapi.io", { timeout: 30_000 }),
    http("https://eth.llamarpc.com", { timeout: 30_000 }),
  ], { rank: false }) });
  const bscClient: any = createPublicClient({ chain: bsc, transport: fallback([
    http(process.env.BSC_MAINNET_RPC_URL?.trim() || "https://bsc-mainnet.public.blastapi.io"),
    http("https://bsc-dataseed.binance.org"),
  ], { rank: false }) });
  const baseClient: any = createPublicClient({ chain: base, transport: fallback([
    http(process.env.BASE_MAINNET_RPC_URL?.trim() || "https://base-mainnet.public.blastapi.io"),
    http("https://mainnet.base.org"),
  ], { rank: false }) });
  assertThat(await eth.getChainId() === 1 && await bscClient.getChainId() === 56 && await baseClient.getChainId() === 8453, "RPC chain mismatch");

  const nextBroadcastNonce = BigInt(saved.broadcastNonceBefore) + 1n;
  const bscMessageHash = messageHash(nextBroadcastNonce, BSC_FACTORY, saved.innerUpgradeCalldata);
  const baseMessageHash = messageHash(nextBroadcastNonce, BASE_FACTORY, saved.innerUpgradeCalldata);
  const [proposalState, proposal, actions, fastPass, chainIds, broadcastNonce,
    bscRoute, baseRoute, liveQuote, walletBalance, latestNonce, pendingNonce,
    bscThreshold, baseThreshold, bscAllowed, baseAllowed, bscSlot, baseSlot,
    bscStatus, baseStatus, bscAttempts, baseAttempts] = await Promise.all([
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "fastPassThreshold" }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "getChainIds" }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BSC_CHAIN_KEY] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "quoteFees", args: [[BSC_CHAIN_KEY, BASE_CHAIN_KEY], [BSC_FACTORY, BASE_FACTORY], saved.innerUpgradeCalldata, LZ_GAS] }),
    eth.getBalance({ address: OWNER }),
    eth.getTransactionCount({ address: OWNER, blockTag: "latest" }),
    eth.getTransactionCount({ address: OWNER, blockTag: "pending" }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BSC_FACTORY] }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BASE_FACTORY] }),
    bscClient.getStorageAt({ address: BSC_FACTORY, slot: IMPLEMENTATION_SLOT }),
    baseClient.getStorageAt({ address: BASE_FACTORY, slot: IMPLEMENTATION_SLOT }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "confirmStatus", args: [bscMessageHash] }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "confirmStatus", args: [baseMessageHash] }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "executionAttempts", args: [bscMessageHash] }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "executionAttempts", args: [baseMessageHash] }),
  ]);
  const actionsExact = actions[0].length === 1 && same(actions[0][0], BROADCASTER)
    && actions[1][0] === EXECUTION_VALUE && same(actions[2][0], saved.broadcastCalldata);
  assertThat(proposalState === SUCCEEDED && proposal.totalStaked >= FAST_PASS && !proposal.executed, "proposal #23 is not executable");
  assertThat(proposal.description === saved.description && fastPass === FAST_PASS && actionsExact, "proposal action/threshold mismatch");
  assertThat(chainIds.join(",") === `${BSC_CHAIN_KEY},${BASE_CHAIN_KEY}` && bscRoute[6] && baseRoute[6], "active route mismatch");
  assertThat(broadcastNonce === BigInt(saved.broadcastNonceBefore), "broadcast nonce changed before execution");
  assertThat(bscThreshold === 2n && baseThreshold === 2n && bscAllowed && baseAllowed, "destination threshold/allowlist mismatch");
  assertThat(slotAddress(bscSlot) === TARGET_IMPLEMENTATION && slotAddress(baseSlot) === saved.baseImplementationBefore, "destination implementation changed before execution");
  assertThat(emptyStatus(bscStatus, bscAttempts) && emptyStatus(baseStatus, baseAttempts), "message hash was already used");
  assertThat(liveQuote > 0n && liveQuote <= EXECUTION_VALUE, `live quote ${liveQuote} exceeds execution budget`);
  assertThat(latestNonce === pendingNonce, "execution signer has pending Ethereum transaction");
  await eth.simulateContract({ account: OWNER, address: GOVERNANCE, abi: governanceAbi, functionName: "execute", args: [PROPOSAL_ID], value: EXECUTION_VALUE });
  const estimatedGas = await eth.estimateContractGas({ account: OWNER, address: GOVERNANCE, abi: governanceAbi, functionName: "execute", args: [PROPOSAL_ID], value: EXECUTION_VALUE });
  assertThat(walletBalance > EXECUTION_VALUE, "execution wallet ETH balance is insufficient");
  const preflight = {
    status: "PASS", mode, proposalId: PROPOSAL_ID, proposalState,
    totalStakedD: formatEther(proposal.totalStaked), liveQuote, executionValue: EXECUTION_VALUE,
    estimatedGas, walletBalanceEth: formatEther(walletBalance), signerNonce: pendingNonce,
    broadcastNonceBefore: broadcastNonce, expectedBroadcastNonce: nextBroadcastNonce,
    bscMessageHash, baseMessageHash, actionsExact, simulationPassed: true,
  };
  console.log(stringify(preflight));
  if (mode === "preflight") return;

  assertThat(process.env.DEAL_FACTORY_CROSSCHAIN_UPGRADE_EXECUTION_CONFIRM === CONFIRM, "write gate closed");
  assertThat(!existsSync(OUTPUT_FILE), "execution record already exists; refusing to resend");
  const writeRpc = process.env.ETH_WRITE_RPC_URL?.trim() || "https://eth-mainnet.public.blastapi.io";
  const wallet: any = createWalletClient({ account, chain: mainnet, transport: http(writeRpc, { timeout: 30_000 }) });
  const executeCalldata = encodeFunctionData({ abi: governanceAbi, functionName: "execute", args: [PROPOSAL_ID] });
  const hash = await wallet.writeContract({
    account, address: GOVERNANCE, abi: governanceAbi, functionName: "execute",
    args: [PROPOSAL_ID], value: EXECUTION_VALUE, nonce: pendingNonce,
  });
  const receipt = await eth.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
  const transaction = await eth.getTransaction({ hash });
  assertThat(receipt.status === "success", `execution reverted: ${hash}`);
  assertThat(same(transaction.from, OWNER) && transaction.to && same(transaction.to, GOVERNANCE), "execution endpoints mismatch");
  assertThat(transaction.value === EXECUTION_VALUE && same(transaction.input, executeCalldata), "execution calldata/value mismatch");

  const proposalTopic = toEventSelector("ProposalExecuted(uint256)");
  const broadcastTopic = toEventSelector("Broadcast(uint256,uint32[],address[],bytes)");
  const toChainTopic = toEventSelector("BroadcastToChain(uint256,uint32,address,bytes32,bytes32)");
  const proposalLog = receipt.logs.find((log: any) => same(log.address, GOVERNANCE) && log.topics[0] === proposalTopic);
  const broadcastLog = receipt.logs.find((log: any) => same(log.address, BROADCASTER) && log.topics[0] === broadcastTopic);
  const chainLogs = receipt.logs.filter((log: any) => same(log.address, BROADCASTER) && log.topics[0] === toChainTopic);
  assertThat(proposalLog && broadcastLog && chainLogs.length === 2, "expected execution/broadcast events missing");
  const decoded: any = decodeEventLog({ abi: broadcasterAbi, data: broadcastLog.data, topics: broadcastLog.topics });
  assertThat(decoded.args.nonce === nextBroadcastNonce, "broadcast nonce mismatch");
  assertThat(decoded.args.targetChainIds.join(",") === `${BSC_CHAIN_KEY},${BASE_CHAIN_KEY}`, "broadcast chain ids mismatch");
  assertThat(same(decoded.args.targets[0], BSC_FACTORY) && same(decoded.args.targets[1], BASE_FACTORY), "broadcast targets mismatch");
  assertThat(same(decoded.args.data, saved.innerUpgradeCalldata), "broadcast inner calldata mismatch");
  const decodedChains = chainLogs.map((log: any) => decodeEventLog({ abi: broadcasterAbi, data: log.data, topics: log.topics }) as any);
  for (const event of decodedChains) {
    assertThat(event.args.nonce === nextBroadcastNonce, "per-chain event nonce mismatch");
    assertThat(event.args.lzGuid !== `0x${"00".repeat(32)}` && event.args.ccipMessageId !== `0x${"00".repeat(32)}`, "bridge send id missing");
  }
  const [finalState, finalProposal, finalNonce] = await Promise.all([
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [PROPOSAL_ID] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
  ]);
  assertThat(finalState === EXECUTED && finalProposal.executed && finalNonce === nextBroadcastNonce, "Ethereum execution verification failed");
  const output = {
    schemaVersion: 1, stage: "broadcast-sent", executedAt: new Date().toISOString(),
    proposalId: PROPOSAL_ID, preflight,
    transaction: { hash, nonce: transaction.nonce, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, value: transaction.value, status: receipt.status, calldataMatched: true },
    broadcast: {
      nonce: nextBroadcastNonce, bscMessageHash, baseMessageHash,
      targetChainIds: [BSC_CHAIN_KEY, BASE_CHAIN_KEY], targets: [BSC_FACTORY, BASE_FACTORY],
      innerUpgradeCalldata: saved.innerUpgradeCalldata, eventsMatched: true,
      perChainEvents: decodedChains.map((event: any) => ({ chainId: event.args.chainId, target: event.args.target, lzGuid: event.args.lzGuid, ccipMessageId: event.args.ccipMessageId })),
    },
  };
  writeFileSync(OUTPUT_FILE, `${stringify(output)}\n`, "utf8");
  console.log(stringify({ status: "PASS_BROADCAST_SENT", outputFile: OUTPUT_FILE, ...output }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
