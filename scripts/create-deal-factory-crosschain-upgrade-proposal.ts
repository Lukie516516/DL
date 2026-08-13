/**
 * Creates only the Major proposal that broadcasts the DealFactory governance
 * implementation upgrade to the active BSC and Base routes.
 *
 * It never stakes, executes or broadcasts during proposal creation.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  fallback,
  getAddress,
  http,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, bsc, mainnet } from "viem/chains";

const CONFIRM = "MINT_APPROVE_CREATE_FACTORY_CROSSCHAIN_UPGRADE";
const STATE_FILE = "deployments/deal-factory-crosschain-upgrade-proposal.json";

const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const GOVERNANCE = getAddress("0x9a41a9A85C16F590789C846Fb933fF8C715407F7");
const REGISTRY = getAddress("0xBFF01F91291476e671f0F310846D5dDb460e2382");
const BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const BSC_FACTORY = getAddress("0x1Ca748Feb347d0d177E844E7D4CDCA908957c256");
const BASE_FACTORY = getAddress("0x591625Be924B98ACcAb7e2c8aF698c858Aa2608D");
const BSC_EXECUTOR = getAddress("0x407381d841DD48bBBd40Bd37f9dB268CE75950A8");
const BASE_EXECUTOR = getAddress("0xf92cE4DBA86eDbfAdEA32880a04FF1123a188218");
const IMPLEMENTATION = getAddress("0x7fC9145A2539F0eD52Cf6E7E34Ce485635A9887E");
const BSC_CHAIN_KEY = 30_102;
const BASE_CHAIN_KEY = 30_184;
const MAJOR = 2;
const POLICY_PROPOSAL_ID = 22n;
const MAJOR_FEE = parseEther("1000");
const EXECUTION_VALUE_BUDGET = parseEther("0.005");
const LZ_GAS = 500_000n;
const DESCRIPTION = "升级Base交易工厂，BSC同步校验，不修改业务参数。";
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

const factoryAbi = parseAbi(["function upgradeToAndCall(address,bytes) payable"]);
const broadcasterAbi = parseAbi([
  "function getChainIds() view returns (uint32[])",
  "function chains(uint32) view returns (uint32,uint64,address,string,string,uint256,bool)",
  "function broadcastNonce() view returns (uint256)",
  "function quoteFees(uint32[],address[],bytes,uint128) view returns (uint256)",
  "function broadcast(uint32[],address[],bytes,uint128) payable",
]);
const registryAbi = parseAbi([
  "function getRule(uint8,address,bytes4) view returns (bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)",
  "function isActionAllowed(uint8,address,uint256,bytes) view returns (bool)",
]);
const governanceAbi = parseAbi([
  "function dcToken() view returns (address)",
  "function treasury() view returns (address)",
  "function majorProposalFee() view returns (uint256)",
  "function proposalCount() view returns (uint256)",
  "function state(uint256) view returns (uint8)",
  "function getProposal(uint256) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description,uint48 createdAt))",
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
const executorAbi = parseAbi([
  "function threshold() view returns (uint256)",
  "function allowedTargets(address) view returns (bool)",
]);

type TxRecord = {
  hash: Hex;
  nonce: number;
  blockNumber: string;
  gasUsed: string;
  verified: true;
};
type State = {
  schemaVersion: 1;
  stage: "started" | "fee-minted" | "fee-approved" | "proposal-created";
  startedAt: string;
  updatedAt: string;
  proposalCountBefore: string;
  expectedProposalId: string;
  dc: Address;
  treasury: Address;
  totalSupplyBefore: string;
  treasuryBalanceBefore: string;
  broadcastNonceBefore: string;
  description: string;
  innerUpgradeCalldata: Hex;
  broadcastCalldata: Hex;
  createProposalCalldata: Hex;
  liveQuoteBefore: string;
  executionValueBudget: string;
  bscImplementationBefore: Address;
  baseImplementationBefore: Address;
  transactions: { mint?: TxRecord; approve?: TxRecord; createProposal?: TxRecord };
  proposalId?: string;
  verification?: Record<string, unknown>;
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
function save(state: State) { state.updatedAt = new Date().toISOString(); writeFileSync(STATE_FILE, `${stringify(state)}\n`, "utf8"); }
function slotAddress(word: Hex | undefined): Address {
  assertThat(word && word.length === 66, "implementation slot unavailable");
  return getAddress(`0x${word.slice(-40)}`);
}
function exactRule(rule: any) { return rule[0] === true && rule[1] === false && rule[2] === true && rule[3] === 0n; }

const innerUpgradeCalldata = encodeFunctionData({
  abi: factoryAbi,
  functionName: "upgradeToAndCall",
  args: [IMPLEMENTATION, "0x"],
});
const broadcastCalldata = encodeFunctionData({
  abi: broadcasterAbi,
  functionName: "broadcast",
  args: [
    [BSC_CHAIN_KEY, BASE_CHAIN_KEY],
    [BSC_FACTORY, BASE_FACTORY],
    innerUpgradeCalldata,
    LZ_GAS,
  ],
});
const createProposalCalldata = encodeFunctionData({
  abi: governanceAbi,
  functionName: "createProposal",
  args: [[BROADCASTER], [EXECUTION_VALUE_BUDGET], [broadcastCalldata], DESCRIPTION, MAJOR],
});

async function waitAndVerify(client: any, hash: Hex, expectedTo: Address, expectedInput: Hex): Promise<TxRecord> {
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
  const tx = await client.getTransaction({ hash });
  assertThat(receipt.status === "success", `transaction reverted: ${hash}`);
  assertThat(same(tx.from, OWNER) && tx.to && same(tx.to, expectedTo), `transaction endpoints mismatch: ${hash}`);
  assertThat(tx.value === 0n && same(tx.input, expectedInput), `transaction calldata/value mismatch: ${hash}`);
  return { hash, nonce: tx.nonce, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), verified: true };
}

async function findDuplicate(client: any, count: bigint): Promise<bigint | undefined> {
  for (let id = 1n; id <= count; id++) {
    const actions = await client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [id] });
    if (actions[0].length === 1 && same(actions[0][0], BROADCASTER)
      && actions[1][0] === EXECUTION_VALUE_BUDGET && same(actions[2][0], broadcastCalldata)) return id;
  }
  return undefined;
}

async function main() {
  loadEnv();
  const mode = process.argv[2] || "preflight";
  assertThat(mode === "preflight" || mode === "execute", "mode must be preflight or execute");
  const configuredEthRpc = process.env.ETH_MAINNET_RPC_URL?.trim();
  const readTransport = fallback([
    ...(configuredEthRpc ? [http(configuredEthRpc, { timeout: 30_000 })] : []),
    http("https://eth-mainnet.public.blastapi.io", { timeout: 30_000 }),
    http("https://eth.llamarpc.com", { timeout: 30_000 }),
  ], { rank: false });
  const eth: any = createPublicClient({ chain: mainnet, transport: readTransport });
  const bscClient: any = createPublicClient({ chain: bsc, transport: fallback([
    http(process.env.BSC_MAINNET_RPC_URL?.trim() || "https://bsc-mainnet.public.blastapi.io"),
    http("https://bsc-dataseed.binance.org"),
  ], { rank: false }) });
  const baseClient: any = createPublicClient({ chain: base, transport: fallback([
    http(process.env.BASE_MAINNET_RPC_URL?.trim() || "https://base-mainnet.public.blastapi.io"),
    http("https://mainnet.base.org"),
  ], { rank: false }) });
  assertThat(await eth.getChainId() === 1 && await bscClient.getChainId() === 56 && await baseClient.getChainId() === 8453, "RPC chain mismatch");

  const dc = getAddress(await eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "dcToken" }));
  const treasury = getAddress(await eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "treasury" }));
  const minterRole = await eth.readContract({ address: dc, abi: tokenAbi, functionName: "MINTER_ROLE" });
  const [policyState, policy, count, majorFee, balance, allowance, paused, canMint,
    supply, treasuryBalance, latestNonce, pendingNonce, bscRule, baseRule,
    actionAllowed, chainIds, bscRoute, baseRoute, liveQuote, broadcastNonce,
    bscAllowed, baseAllowed, bscThreshold, baseThreshold, bscSlot, baseSlot] = await Promise.all([
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [POLICY_PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [POLICY_PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "majorProposalFee" }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "paused" }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "hasRole", args: [minterRole, OWNER] }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
    eth.getTransactionCount({ address: OWNER, blockTag: "latest" }),
    eth.getTransactionCount({ address: OWNER, blockTag: "pending" }),
    eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BSC_FACTORY, "0x4f1ef286"] }),
    eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_FACTORY, "0x4f1ef286"] }),
    eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isActionAllowed", args: [MAJOR, BROADCASTER, EXECUTION_VALUE_BUDGET, broadcastCalldata] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "getChainIds" }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BSC_CHAIN_KEY] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "quoteFees", args: [[BSC_CHAIN_KEY, BASE_CHAIN_KEY], [BSC_FACTORY, BASE_FACTORY], innerUpgradeCalldata, LZ_GAS] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BSC_FACTORY] }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BASE_FACTORY] }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
    bscClient.getStorageAt({ address: BSC_FACTORY, slot: IMPLEMENTATION_SLOT }),
    baseClient.getStorageAt({ address: BASE_FACTORY, slot: IMPLEMENTATION_SLOT }),
  ]);
  const bscImplementationBefore = slotAddress(bscSlot);
  const baseImplementationBefore = slotAddress(baseSlot);
  assertThat(policyState === 6 && policy.executed && policy.totalStaked === parseEther("70"), "policy proposal #22 is not executed with 70 D");
  assertThat(majorFee === MAJOR_FEE && !paused && canMint, "Major fee/DC mint preconditions failed");
  const existingState = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, "utf8")) as State
    : undefined;
  if (existingState) {
    assertThat(existingState.expectedProposalId === (count + 1n).toString(), "existing state proposal id mismatch");
    assertThat(same(existingState.broadcastCalldata, broadcastCalldata), "existing state broadcast calldata mismatch");
    assertThat(existingState.stage === "fee-minted" && balance === MAJOR_FEE && allowance === 0n,
      "existing state is not safely resumable from fee-minted");
  } else {
    assertThat(balance === 0n && allowance === 0n, "proposer DC balance/allowance must start at zero");
  }
  assertThat(latestNonce === pendingNonce, "signer has a pending Ethereum transaction");
  assertThat(exactRule(bscRule) && exactRule(baseRule) && actionAllowed, "exact upgrade policy is not active");
  assertThat(chainIds.join(",") === `${BSC_CHAIN_KEY},${BASE_CHAIN_KEY}` && bscRoute[6] && baseRoute[6], "active route set mismatch");
  assertThat(bscAllowed && baseAllowed && bscThreshold === 2n && baseThreshold === 2n, "destination Executor mismatch");
  assertThat(bscImplementationBefore === IMPLEMENTATION, "BSC is not on the replay-safe target implementation");
  assertThat(baseImplementationBefore !== IMPLEMENTATION, "Base is already on the target implementation");
  assertThat(liveQuote > 0n && liveQuote <= EXECUTION_VALUE_BUDGET, "live bridge quote exceeds proposal value budget");
  const duplicate = await findDuplicate(eth, count);
  assertThat(duplicate === undefined, `duplicate upgrade proposal already exists: ${duplicate}`);

  const summary = {
    status: "PASS",
    mode,
    blockNumber: (await eth.getBlockNumber()).toString(),
    proposalCount: count.toString(),
    expectedProposalId: (count + 1n).toString(),
    description: DESCRIPTION,
    liveQuote: liveQuote.toString(),
    executionValueBudget: EXECUTION_VALUE_BUDGET.toString(),
    bscImplementationBefore,
    baseImplementationBefore,
    broadcastNonce: broadcastNonce.toString(),
    innerUpgradeCalldata,
    broadcastCalldata,
    createProposalCalldata,
  };
  console.log(stringify(summary));
  if (mode === "preflight") return;

  assertThat(process.env.DEAL_FACTORY_CROSSCHAIN_UPGRADE_PROPOSAL_CONFIRM === CONFIRM, "write gate closed");
  const account = privateKeyToAccount(key());
  assertThat(same(account.address, OWNER), `signer mismatch: ${account.address}`);
  const writeRpc = process.env.ETH_WRITE_RPC_URL?.trim() || "https://eth-mainnet.public.blastapi.io";
  const wallet: any = createWalletClient({ account, chain: mainnet, transport: http(writeRpc, { timeout: 30_000 }) });

  const state: State = existingState || {
    schemaVersion: 1,
    stage: "started",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    proposalCountBefore: count.toString(),
    expectedProposalId: (count + 1n).toString(),
    dc,
    treasury,
    totalSupplyBefore: supply.toString(),
    treasuryBalanceBefore: treasuryBalance.toString(),
    broadcastNonceBefore: broadcastNonce.toString(),
    description: DESCRIPTION,
    innerUpgradeCalldata,
    broadcastCalldata,
    createProposalCalldata,
    liveQuoteBefore: liveQuote.toString(),
    executionValueBudget: EXECUTION_VALUE_BUDGET.toString(),
    bscImplementationBefore,
    baseImplementationBefore,
    transactions: {},
  };
  if (!existingState) save(state);

  const mintCalldata = encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [OWNER, MAJOR_FEE] });
  if (!state.transactions.mint) {
    state.transactions.mint = await waitAndVerify(eth, await wallet.writeContract({
      account, address: dc, abi: tokenAbi, functionName: "mint", args: [OWNER, MAJOR_FEE], gas: 150_000n,
    }), dc, mintCalldata);
    state.stage = "fee-minted"; save(state);
  }

  const approveCalldata = encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [GOVERNANCE, MAJOR_FEE] });
  if (!state.transactions.approve) {
    state.transactions.approve = await waitAndVerify(eth, await wallet.writeContract({
      account, address: dc, abi: tokenAbi, functionName: "approve", args: [GOVERNANCE, MAJOR_FEE], gas: 100_000n,
    }), dc, approveCalldata);
    state.stage = "fee-approved"; save(state);
  }

  const proposalArgs = [[BROADCASTER], [EXECUTION_VALUE_BUDGET], [broadcastCalldata], DESCRIPTION, MAJOR] as const;
  const simulation = await eth.simulateContract({ account: OWNER, address: GOVERNANCE, abi: governanceAbi, functionName: "createProposal", args: proposalArgs });
  assertThat(simulation.result === BigInt(state.expectedProposalId), "simulated proposal id mismatch");
  if (!state.transactions.createProposal) {
    state.transactions.createProposal = await waitAndVerify(eth, await wallet.writeContract({
      account, address: GOVERNANCE, abi: governanceAbi, functionName: "createProposal", args: proposalArgs, gas: 1_000_000n,
    }), GOVERNANCE, createProposalCalldata);
    state.stage = "proposal-created";
    state.proposalId = state.expectedProposalId;
    save(state);
  }

  const proposalId = BigInt(state.expectedProposalId);
  const [countAfter, proposalState, proposal, actions, balanceAfter, allowanceAfter,
    supplyAfter, treasuryAfter, broadcastNonceAfter, bscSlotAfter, baseSlotAfter] = await Promise.all([
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [proposalId] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [proposalId] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [proposalId] }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    bscClient.getStorageAt({ address: BSC_FACTORY, slot: IMPLEMENTATION_SLOT }),
    baseClient.getStorageAt({ address: BASE_FACTORY, slot: IMPLEMENTATION_SLOT }),
  ]);
  assertThat(countAfter === proposalId && proposalState === 1, "new proposal is not Pending");
  assertThat(same(proposal.proposer, OWNER) && proposal.kind === MAJOR && proposal.totalStaked === 0n && !proposal.executed, "proposal metadata mismatch");
  assertThat(proposal.description === DESCRIPTION && proposal.createdAt > 0, "proposal description/time mismatch");
  assertThat(actions[0].length === 1 && same(actions[0][0], BROADCASTER) && actions[1][0] === EXECUTION_VALUE_BUDGET && same(actions[2][0], broadcastCalldata), "proposal action mismatch");
  assertThat(balanceAfter === 0n && allowanceAfter === 0n, "fee balance/allowance was not consumed exactly");
  assertThat(supplyAfter === supply + MAJOR_FEE && treasuryAfter === treasuryBalance + MAJOR_FEE, "proposal fee accounting mismatch");
  assertThat(broadcastNonceAfter === broadcastNonce, "broadcast occurred during proposal creation");
  assertThat(slotAddress(bscSlotAfter) === bscImplementationBefore && slotAddress(baseSlotAfter) === baseImplementationBefore, "destination proxy changed during proposal creation");
  state.verification = {
    proposalState: Number(proposalState),
    totalStaked: proposal.totalStaked.toString(),
    noExecution: !proposal.executed,
    noBroadcast: true,
    feeConsumed: MAJOR_FEE.toString(),
    actionsMatched: true,
    destinationStatePreserved: true,
  };
  save(state);
  console.log(stringify({ status: "PASS_PROPOSAL_CREATED", proposalId: state.proposalId, transactions: state.transactions, verification: state.verification, stateFile: STATE_FILE }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
