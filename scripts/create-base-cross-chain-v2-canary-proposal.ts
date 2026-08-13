/**
 * Create only the BSC + Base zero-asset CrossChain V2 Canary Major proposal.
 * This script never stakes or executes the proposal and never broadcasts.
 *
 * Read-only:
 *   node --import tsx/esm scripts/create-base-cross-chain-v2-canary-proposal.ts preflight
 *
 * Explicit write gate:
 *   BASE_CROSS_CHAIN_V2_CANARY_PROPOSAL_CONFIRM=MINT_APPROVE_CREATE_EXACT_CANARY \
 *     node --import tsx/esm scripts/create-base-cross-chain-v2-canary-proposal.ts execute
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  fallback,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  stringToHex,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, bsc, mainnet } from "viem/chains";

const PLAN_FILE = "deployments/base-cross-chain-v2-canary-plan.json";
const ACTIVATION_FILE = "deployments/base-cross-chain-v2-canary-route-activation.json";
const STATE_FILE = "deployments/base-cross-chain-v2-canary-proposal.json";
const CONFIRM = "MINT_APPROVE_CREATE_EXACT_CANARY";

const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const GOVERNANCE = getAddress("0x9a41a9A85C16F590789C846Fb933fF8C715407F7");
const REGISTRY = getAddress("0xBFF01F91291476e671f0F310846D5dDb460e2382");
const BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const BSC_EXECUTOR = getAddress("0x407381d841DD48bBBd40Bd37f9dB268CE75950A8");
const BSC_PROBE = getAddress("0xd31C6417aE0C267F8C5bd634B96dA7590E6E6aB3");
const BASE_EXECUTOR = getAddress("0xf92cE4DBA86eDbfAdEA32880a04FF1123a188218");
const BASE_PROBE = getAddress("0x61921eCb954FFaAf8cd3Fd2e71EeCB14B3eD529f");
const BSC_CHAIN_KEY = 30_102;
const BASE_CHAIN_KEY = 30_184;
const MAJOR = 2;
const POLICY_PROPOSAL_ID = 20n;
const FEE = parseEther("1000");
const FEE_BUDGET = parseEther("0.005");
const LZ_GAS = 500_000n;
const MARKER = keccak256(stringToHex("BASE_CROSS_CHAIN_V2_CANARY_20260807"));
const SELECTOR = toFunctionSelector("recordMarker(bytes32)");
const DESCRIPTION =
  "Base跨链测试\n\n向BSC和Base无资产测试合约写入同一测试标记，只验证跨链链路，不影响业务。";
const ZERO_MARKER = `0x${"00".repeat(32)}` as Hex;

const governanceAbi = parseAbi([
  "function dcToken() view returns (address)",
  "function treasury() view returns (address)",
  "function majorProposalFee() view returns (uint256)",
  "function proposalCount() view returns (uint256)",
  "function state(uint256) view returns (uint8)",
  "function getProposal(uint256) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description))",
  "function getActions(uint256) view returns (address[] targets,uint256[] values,bytes[] calldatas)",
  "function createProposal(address[],uint256[],bytes[],string,uint8) returns (uint256)",
]);
const tokenAbi = parseAbi([
  "function MINTER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function paused() view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function mint(address,uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const registryAbi = parseAbi([
  "function getRule(uint8,address,bytes4) view returns (bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)",
  "function isActionAllowed(uint8,address,uint256,bytes) view returns (bool)",
]);
const broadcasterAbi = parseAbi([
  "function getChainIds() view returns (uint32[])",
  "function chains(uint32) view returns (uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
  "function broadcastNonce() view returns (uint256)",
  "function quoteFees(uint32[],address[],bytes,uint128) view returns (uint256)",
  "function broadcast(uint32[],address[],bytes,uint128) payable",
]);
const executorAbi = parseAbi([
  "function allowedTargets(address) view returns (bool)",
]);
const probeAbi = parseAbi([
  "function marker() view returns (bytes32)",
  "function updateCount() view returns (uint256)",
  "function recordMarker(bytes32)",
]);

type Plan = {
  addresses: Record<string, string>;
  canary: {
    marker: Hex;
    markerCalldata: Hex;
    description: string;
    targetChainKeys: number[];
    targets: Address[];
    lzGas: string;
    feeBudgetWei: string;
    broadcastCalldata: Hex;
    createProposalCalldata: Hex;
  };
};
type ActivationState = { stage: string; verification?: { noBroadcastSent?: boolean } };
type TxRecord = { hash: Hex; nonce: number; blockNumber: string; gasUsed: string; verified: true };
type State = {
  schemaVersion: 1;
  scope: string;
  stage: "started" | "fee-minted" | "fee-approved" | "proposal-created";
  startedAt: string;
  updatedAt: string;
  proposer: Address;
  governance: Address;
  broadcaster: Address;
  description: string;
  marker: Hex;
  fee: string;
  executionValueBudget: string;
  liveQuoteBefore: string;
  proposalCountBefore: string;
  expectedProposalId: string;
  totalSupplyBefore: string;
  treasuryBalanceBefore: string;
  broadcastNonceBefore: string;
  markerCalldata: Hex;
  broadcastCalldata: Hex;
  createProposalCalldata: Hex;
  transactions: { mint?: TxRecord; approve?: TxRecord; createProposal?: TxRecord };
  proposalId?: string;
  verification?: Record<string, unknown>;
};

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) process.env[match[1].trim()] = match[2].trim();
  }
}
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
function signerKey(): Hex {
  const raw = process.env.ETH_MAINNET_PRIVATE_KEY?.trim() || process.env.AGIKING_PRIVATE_KEY?.trim();
  if (!raw) throw new Error("Missing ETH_MAINNET_PRIVATE_KEY or AGIKING_PRIVATE_KEY");
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}
function same(a: unknown, b: unknown) { return String(a).toLowerCase() === String(b).toLowerCase(); }
function assertThat(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function stringify(value: unknown) { return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2); }
function save(state: State) { state.updatedAt = new Date().toISOString(); writeFileSync(STATE_FILE, `${stringify(state)}\n`, "utf8"); }
function nestedRule(rule: any) {
  return (rule.allowed ?? rule[0]) === true
    && (rule.validateNestedBroadcast ?? rule[1]) === false
    && (rule.nestedOnly ?? rule[2]) === true
    && BigInt(rule.maxValue ?? rule[3]) === 0n;
}
async function nonceState(client: any) {
  const [latest, pending] = await Promise.all([
    client.getTransactionCount({ address: OWNER, blockTag: "latest" }),
    client.getTransactionCount({ address: OWNER, blockTag: "pending" }),
  ]);
  assertThat(latest === pending, "signer has a pending Ethereum transaction");
  return Number(pending);
}
async function waitAndVerify(client: any, hash: Hex, expectedTo: Address, expectedInput: Hex): Promise<TxRecord> {
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 300_000 });
  const tx = await client.getTransaction({ hash });
  assertThat(receipt.status === "success", `transaction reverted: ${hash}`);
  assertThat(same(tx.from, OWNER) && tx.to && same(tx.to, expectedTo), `sender/target mismatch: ${hash}`);
  assertThat(same(tx.input, expectedInput) && tx.value === 0n, `calldata/value mismatch: ${hash}`);
  return { hash, nonce: tx.nonce, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), verified: true };
}
async function findDuplicate(client: any, count: bigint, broadcastCalldata: Hex) {
  const reads = Array.from({ length: Number(count) }, (_, index) => {
    const id = BigInt(index + 1);
    return client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [id] })
      .then((actions: readonly [Address[], bigint[], Hex[]]) => ({ id, actions }));
  });
  for (const { id, actions } of await Promise.all(reads)) {
    if (actions[0].length === 1 && same(actions[0][0], BROADCASTER)
      && actions[1].length === 1 && actions[1][0] === FEE_BUDGET
      && actions[2].length === 1 && same(actions[2][0], broadcastCalldata)) return id;
  }
  return undefined;
}

async function main() {
  loadEnv();
  const mode = process.argv[2] || "preflight";
  assertThat(mode === "preflight" || mode === "execute", "mode must be preflight or execute");
  const plan = JSON.parse(readFileSync(PLAN_FILE, "utf8")) as Plan;
  const activation = JSON.parse(readFileSync(ACTIVATION_FILE, "utf8")) as ActivationState;
  assertThat(activation.stage === "ready" && activation.verification?.noBroadcastSent === true, "route activation record is not ready");

  const markerCalldata = encodeFunctionData({ abi: probeAbi, functionName: "recordMarker", args: [MARKER] });
  const broadcastCalldata = encodeFunctionData({
    abi: broadcasterAbi,
    functionName: "broadcast",
    args: [[BSC_CHAIN_KEY, BASE_CHAIN_KEY], [BSC_PROBE, BASE_PROBE], markerCalldata, LZ_GAS],
  });
  const createProposalCalldata = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [[BROADCASTER], [FEE_BUDGET], [broadcastCalldata], DESCRIPTION, MAJOR],
  });
  assertThat(same(plan.addresses.governance, GOVERNANCE) && same(plan.addresses.registry, REGISTRY) && same(plan.addresses.broadcaster, BROADCASTER), "plan ETH addresses mismatch");
  assertThat(same(plan.addresses.bscExecutor, BSC_EXECUTOR) && same(plan.addresses.baseExecutor, BASE_EXECUTOR), "plan Executor mismatch");
  assertThat(plan.canary.marker === MARKER && same(plan.canary.markerCalldata, markerCalldata), "plan marker mismatch");
  assertThat(plan.canary.description === DESCRIPTION && same(plan.canary.broadcastCalldata, broadcastCalldata), "plan canary action mismatch");
  assertThat(same(plan.canary.createProposalCalldata, createProposalCalldata), "plan proposal calldata mismatch");
  assertThat(BigInt(plan.canary.feeBudgetWei) === FEE_BUDGET && BigInt(plan.canary.lzGas) === LZ_GAS, "plan fee/gas mismatch");

  const ethRpc = required("ETH_MAINNET_RPC_URL");
  const bscRpc = process.env.BSC_MAINNET_RPC_URL?.trim() || "https://bsc-mainnet.public.blastapi.io";
  const baseRpc = process.env.BASE_MAINNET_RPC_URL?.trim() || "https://base-mainnet.public.blastapi.io";
  const ethClient: any = createPublicClient({ chain: mainnet, transport: http(ethRpc, { timeout: 30_000 }) });
  const bscClient: any = createPublicClient({ chain: bsc, transport: fallback([http(bscRpc), http("https://bsc-dataseed.binance.org")], { rank: false }) });
  const baseClient: any = createPublicClient({ chain: base, transport: fallback([http(baseRpc), http("https://mainnet.base.org")], { rank: false }) });
  assertThat(await ethClient.getChainId() === 1 && await bscClient.getChainId() === 56 && await baseClient.getChainId() === 8453, "RPC chain mismatch");
  const dc = getAddress(await ethClient.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "dcToken" }));
  const treasury = getAddress(await ethClient.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "treasury" }));
  const minterRole = await ethClient.readContract({ address: dc, abi: tokenAbi, functionName: "MINTER_ROLE" });
  const [
    policyState, policyProposal, majorFee, proposalCount, canMint, paused, balance,
    allowance, totalSupply, treasuryBalance, bscRule, baseRule, actionAllowed,
    chainIds, bscRoute, baseRoute, broadcastNonce, liveQuote, bscAllowed,
    baseAllowed, bscMarker, bscCount, baseMarker, baseCount, pendingNonce,
  ] = await Promise.all([
    ethClient.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [POLICY_PROPOSAL_ID] }),
    ethClient.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [POLICY_PROPOSAL_ID] }),
    ethClient.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "majorProposalFee" }),
    ethClient.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }),
    ethClient.readContract({ address: dc, abi: tokenAbi, functionName: "hasRole", args: [minterRole, OWNER] }),
    ethClient.readContract({ address: dc, abi: tokenAbi, functionName: "paused" }),
    ethClient.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
    ethClient.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }),
    ethClient.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    ethClient.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
    ethClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BSC_PROBE, SELECTOR] }),
    ethClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_PROBE, SELECTOR] }),
    ethClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isActionAllowed", args: [MAJOR, BROADCASTER, FEE_BUDGET, broadcastCalldata] }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "getChainIds" }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BSC_CHAIN_KEY] }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "quoteFees", args: [[BSC_CHAIN_KEY, BASE_CHAIN_KEY], [BSC_PROBE, BASE_PROBE], markerCalldata, LZ_GAS] }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BSC_PROBE] }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BASE_PROBE] }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "marker" }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "updateCount" }),
    baseClient.readContract({ address: BASE_PROBE, abi: probeAbi, functionName: "marker" }),
    baseClient.readContract({ address: BASE_PROBE, abi: probeAbi, functionName: "updateCount" }),
    nonceState(ethClient),
  ]);
  assertThat(policyState === 6 && policyProposal.executed && policyProposal.totalStaked === parseEther("70"), "policy proposal 20 is not executed");
  assertThat(majorFee === FEE && canMint && !paused, "DC fee/mint preconditions failed");
  assertThat(nestedRule(bscRule) && nestedRule(baseRule) && actionAllowed, "canary policy mismatch");
  assertThat(chainIds.join(",") === `${BSC_CHAIN_KEY},${BASE_CHAIN_KEY}` && bscRoute[6] && baseRoute[6], "both routes must be active");
  assertThat(bscAllowed && baseAllowed, "both Probe targets must be allowlisted");
  assertThat(bscMarker === ZERO_MARKER && bscCount === 0n && baseMarker === ZERO_MARKER && baseCount === 0n, "Probe state is not pristine");
  assertThat(liveQuote > 0n && liveQuote <= FEE_BUDGET, `live quote ${liveQuote} exceeds ${FEE_BUDGET}`);
  const duplicate = await findDuplicate(ethClient, proposalCount, broadcastCalldata);
  assertThat(duplicate === undefined, `duplicate Canary proposal already exists: ${duplicate}`);
  const preflight = {
    status: "PASS", mode, blockNumber: (await ethClient.getBlockNumber()).toString(),
    proposalCount: proposalCount.toString(), expectedProposalId: (proposalCount + 1n).toString(),
    pendingNonce, liveQuoteWei: liveQuote, feeBudgetWei: FEE_BUDGET,
    proposerBalance: balance, proposerAllowance: allowance, broadcastNonce,
    exactDescription: DESCRIPTION, exactCreateProposalCalldata: createProposalCalldata,
  };
  console.log(stringify(preflight));
  if (mode === "preflight") return;

  assertThat(process.env.BASE_CROSS_CHAIN_V2_CANARY_PROPOSAL_CONFIRM === CONFIRM, "write gate is closed");
  const account = privateKeyToAccount(signerKey());
  assertThat(same(account.address, OWNER), `signer mismatch: ${account.address}`);
  const wallet: any = createWalletClient({ account, chain: mainnet, transport: http(ethRpc, { timeout: 30_000 }) });
  let state: State;
  if (existsSync(STATE_FILE)) {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    assertThat(same(state.proposer, OWNER) && same(state.broadcastCalldata, broadcastCalldata), "existing state mismatch");
  } else {
    assertThat(balance === 0n && allowance === 0n, "proposer DC balance/allowance must start at zero");
    state = {
      schemaVersion: 1,
      scope: "mint/approve one exact Major fee and create one BSC + Base zero-asset Canary proposal only",
      stage: "started",
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      proposer: OWNER, governance: GOVERNANCE, broadcaster: BROADCASTER,
      description: DESCRIPTION, marker: MARKER, fee: FEE.toString(),
      executionValueBudget: FEE_BUDGET.toString(), liveQuoteBefore: liveQuote.toString(),
      proposalCountBefore: proposalCount.toString(), expectedProposalId: (proposalCount + 1n).toString(),
      totalSupplyBefore: totalSupply.toString(), treasuryBalanceBefore: treasuryBalance.toString(),
      broadcastNonceBefore: broadcastNonce.toString(), markerCalldata, broadcastCalldata,
      createProposalCalldata, transactions: {},
    };
    save(state);
  }

  const mintCalldata = encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [OWNER, FEE] });
  if (!state.transactions.mint) {
    const hash = await wallet.writeContract({ address: dc, abi: tokenAbi, functionName: "mint", args: [OWNER, FEE] });
    state.transactions.mint = await waitAndVerify(ethClient, hash, dc, mintCalldata);
    state.stage = "fee-minted"; save(state);
  }
  assertThat(await ethClient.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }) === FEE, "minted balance mismatch");
  assertThat(await ethClient.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }) === BigInt(state.totalSupplyBefore) + FEE, "supply mint delta mismatch");

  const approveCalldata = encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [GOVERNANCE, FEE] });
  if (!state.transactions.approve) {
    const hash = await wallet.writeContract({ address: dc, abi: tokenAbi, functionName: "approve", args: [GOVERNANCE, FEE] });
    state.transactions.approve = await waitAndVerify(ethClient, hash, dc, approveCalldata);
    state.stage = "fee-approved"; save(state);
  }
  assertThat(await ethClient.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }) === FEE, "allowance mismatch");

  assertThat(await ethClient.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }) === BigInt(state.proposalCountBefore), "proposal count changed before creation");
  const proposalArgs = [[BROADCASTER], [FEE_BUDGET], [broadcastCalldata], DESCRIPTION, MAJOR] as const;
  const simulation = await ethClient.simulateContract({ account: OWNER, address: GOVERNANCE, abi: governanceAbi, functionName: "createProposal", args: proposalArgs });
  assertThat(simulation.result === BigInt(state.expectedProposalId), "simulated proposal id mismatch");
  if (!state.transactions.createProposal) {
    const hash = await wallet.writeContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "createProposal", args: proposalArgs });
    state.transactions.createProposal = await waitAndVerify(ethClient, hash, GOVERNANCE, createProposalCalldata);
    state.stage = "proposal-created"; state.proposalId = state.expectedProposalId; save(state);
  }

  const proposalId = BigInt(state.expectedProposalId);
  const [countAfter, proposal, actions, proposalState, balanceAfter, allowanceAfter, supplyAfter, treasuryAfter, nonceAfter, bscMarkerAfter, bscCountAfter, baseMarkerAfter, baseCountAfter] = await Promise.all([
    ethClient.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }),
    ethClient.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [proposalId] }),
    ethClient.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [proposalId] }),
    ethClient.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [proposalId] }),
    ethClient.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
    ethClient.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }),
    ethClient.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    ethClient.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "marker" }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "updateCount" }),
    baseClient.readContract({ address: BASE_PROBE, abi: probeAbi, functionName: "marker" }),
    baseClient.readContract({ address: BASE_PROBE, abi: probeAbi, functionName: "updateCount" }),
  ]);
  assertThat(countAfter === proposalId && proposalState === 1, "Canary proposal is not newly Pending");
  assertThat(same(proposal.proposer, OWNER) && proposal.kind === MAJOR && proposal.totalStaked === 0n && !proposal.executed && proposal.description === DESCRIPTION, "proposal metadata mismatch");
  assertThat(actions[0].length === 1 && same(actions[0][0], BROADCASTER) && actions[1][0] === FEE_BUDGET && same(actions[2][0], broadcastCalldata), "proposal action mismatch");
  assertThat(balanceAfter === 0n && allowanceAfter === 0n, "proposal fee balance/allowance mismatch");
  assertThat(supplyAfter === BigInt(state.totalSupplyBefore) + FEE && treasuryAfter === BigInt(state.treasuryBalanceBefore) + FEE, "proposal fee accounting mismatch");
  assertThat(nonceAfter === BigInt(state.broadcastNonceBefore), "broadcast occurred during proposal creation");
  assertThat(bscMarkerAfter === ZERO_MARKER && bscCountAfter === 0n && baseMarkerAfter === ZERO_MARKER && baseCountAfter === 0n, "Probe state changed during proposal creation");
  state.verification = {
    proposalState: Number(proposalState), totalStaked: proposal.totalStaked.toString(),
    descriptionMatched: true, actionsMatched: true, proposerBalance: balanceAfter.toString(),
    proposerAllowance: allowanceAfter.toString(), treasuryFeeDelta: (treasuryAfter - BigInt(state.treasuryBalanceBefore)).toString(),
    broadcastNonce: nonceAfter.toString(), probeStatePreserved: true,
    noStake: proposal.totalStaked === 0n, noExecution: !proposal.executed, noBroadcast: true,
  };
  save(state);
  console.log(stringify({ status: "PASS", proposalId: state.proposalId, stateFile: STATE_FILE, transactions: state.transactions, verification: state.verification }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
