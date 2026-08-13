/**
 * Create only the Base CrossChain V2 canary prerequisite policy proposal.
 *
 * Read-only:
 *   node --import tsx/esm scripts/create-base-cross-chain-v2-policy-proposal.ts preflight
 *
 * Explicit write gate:
 *   BASE_CROSS_CHAIN_V2_POLICY_PROPOSAL_CONFIRM=MINT_APPROVE_CREATE_EXACT_MAJOR_POLICY \
 *     node --import tsx/esm scripts/create-base-cross-chain-v2-policy-proposal.ts execute
 *
 * This script never stakes, executes a proposal, enables a route, or changes
 * an Executor allowlist.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

const PLAN_FILE = "deployments/base-cross-chain-v2-canary-plan.json";
const STATE_FILE = "deployments/base-cross-chain-v2-policy-proposal.json";
const CONFIRM = "MINT_APPROVE_CREATE_EXACT_MAJOR_POLICY";

const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const GOVERNANCE = getAddress("0x9a41a9A85C16F590789C846Fb933fF8C715407F7");
const REGISTRY = getAddress("0xBFF01F91291476e671f0F310846D5dDb460e2382");
const BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const BSC_PROBE = getAddress("0xd31C6417aE0C267F8C5bd634B96dA7590E6E6aB3");
const BASE_PROBE = getAddress("0x61921eCb954FFaAf8cd3Fd2e71EeCB14B3eD529f");
const BASE_CHAIN_KEY = 30_184;
const MAJOR = 2;
const FEE = parseEther("1000");
const SELECTOR = toFunctionSelector("recordMarker(bytes32)");
const DESCRIPTION =
  "Base跨链测试授权\n\n仅为BSC和Base无资产测试合约开放测试标记权限，不涉及代币、国库、分红或业务合约。";

const governanceAbi = parseAbi([
  "function dcToken() view returns (address)",
  "function treasury() view returns (address)",
  "function policyRegistry() view returns (address)",
  "function majorProposalFee() view returns (uint256)",
  "function proposalCount() view returns (uint256)",
  "function state(uint256) view returns (uint8)",
  "function getProposal(uint256) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description))",
  "function getActions(uint256) view returns (address[] targets,uint256[] values,bytes[] calldatas)",
  "function createProposal(address[],uint256[],bytes[],string,uint8) returns (uint256)",
]);
const registryAbi = parseAbi([
  "function governance() view returns (address)",
  "function getRule(uint8,address,bytes4) view returns (bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)",
  "function isActionAllowed(uint8,address,uint256,bytes) view returns (bool)",
  "function setRules((uint8 kind,address target,bytes4 selector,bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)[])",
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
const broadcasterAbi = parseAbi([
  "function chains(uint32) view returns (uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
  "function broadcastNonce() view returns (uint256)",
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
  scope: string;
  stage: "started" | "fee-minted" | "fee-approved" | "proposal-created";
  startedAt: string;
  updatedAt: string;
  proposer: Address;
  governance: Address;
  registry: Address;
  dc: Address;
  treasury: Address;
  description: string;
  fee: string;
  proposalCountBefore: string;
  expectedProposalId: string;
  totalSupplyBefore: string;
  treasuryBalanceBefore: string;
  broadcastNonceBefore: string;
  setRulesCalldata: Hex;
  createProposalCalldata: Hex;
  transactions: { mint?: TxRecord; approve?: TxRecord; createProposal?: TxRecord };
  proposalId?: string;
  verification?: Record<string, unknown>;
};
type Plan = {
  readOnly: boolean;
  transactionSent: boolean;
  addresses: Record<string, string>;
  currentState: { proposalCount: string; expectedPolicyProposalId: string };
  policy: {
    description: string;
    setRulesCalldata: Hex;
    createProposalCalldata: Hex;
    canCreatePolicyProposal: boolean;
    blockers: string[];
  };
};

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
}
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
function signerKey(): Hex {
  const raw = process.env.ETH_MAINNET_PRIVATE_KEY?.trim()
    || process.env.AGIKING_PRIVATE_KEY?.trim();
  if (!raw) throw new Error("Missing ETH_MAINNET_PRIVATE_KEY or AGIKING_PRIVATE_KEY");
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
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
function save(state: State) {
  state.updatedAt = new Date().toISOString();
  writeFileSync(STATE_FILE, `${stringify(state)}\n`, "utf8");
}
function ruleIsEmpty(rule: readonly [boolean, boolean, boolean, bigint]) {
  return !rule[0] && !rule[1] && !rule[2] && rule[3] === 0n;
}

async function nonceState(client: any) {
  const [latest, pending] = await Promise.all([
    client.getTransactionCount({ address: OWNER, blockTag: "latest" }),
    client.getTransactionCount({ address: OWNER, blockTag: "pending" }),
  ]);
  return { latest: Number(latest), pending: Number(pending) };
}

async function waitAndVerify(
  client: any,
  hash: Hex,
  expectedTo: Address,
  expectedInput: Hex,
): Promise<TxRecord> {
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: 2,
    timeout: 300_000,
  });
  const tx = await client.getTransaction({ hash });
  assertThat(receipt.status === "success", `transaction reverted: ${hash}`);
  assertThat(same(tx.from, OWNER), `unexpected sender: ${hash}`);
  assertThat(tx.to && same(tx.to, expectedTo), `unexpected target: ${hash}`);
  assertThat(same(tx.input, expectedInput), `unexpected calldata: ${hash}`);
  assertThat(tx.value === 0n, `unexpected native value: ${hash}`);
  return {
    hash,
    nonce: tx.nonce,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    verified: true,
  };
}

async function findDuplicate(client: any, count: bigint, calldata: Hex) {
  const reads = Array.from({ length: Number(count) }, (_, index) => {
    const id = BigInt(index + 1);
    return client.readContract({
      address: GOVERNANCE,
      abi: governanceAbi,
      functionName: "getActions",
      args: [id],
    }).then((actions: readonly [Address[], bigint[], Hex[]]) => ({ id, actions }));
  });
  for (const { id, actions } of await Promise.all(reads)) {
    if (
      actions[0].length === 1 && same(actions[0][0], REGISTRY)
      && actions[1].length === 1 && actions[1][0] === 0n
      && actions[2].length === 1 && same(actions[2][0], calldata)
    ) return id;
  }
  return undefined;
}

async function main() {
  loadEnv();
  const mode = process.argv[2] || "preflight";
  assertThat(mode === "preflight" || mode === "execute", "mode must be preflight or execute");

  const exactRules = [BSC_PROBE, BASE_PROBE].map((target) => ({
    kind: MAJOR,
    target,
    selector: SELECTOR,
    allowed: true,
    validateNestedBroadcast: false,
    nestedOnly: true,
    maxValue: 0n,
  }));
  const setRulesCalldata = encodeFunctionData({
    abi: registryAbi,
    functionName: "setRules",
    args: [exactRules],
  });
  const createProposalCalldata = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [[REGISTRY], [0n], [setRulesCalldata], DESCRIPTION, MAJOR],
  });
  const plan = JSON.parse(readFileSync(PLAN_FILE, "utf8")) as Plan;
  assertThat(plan.readOnly && !plan.transactionSent, "canonical plan is not read-only");
  assertThat(same(plan.addresses.governance, GOVERNANCE), "plan governance mismatch");
  assertThat(same(plan.addresses.registry, REGISTRY), "plan registry mismatch");
  assertThat(same(plan.addresses.bscProbe, BSC_PROBE), "plan BSC Probe mismatch");
  assertThat(same(plan.addresses.baseProbe, BASE_PROBE), "plan Base Probe mismatch");
  assertThat(plan.policy.description === DESCRIPTION, "plan description mismatch");
  assertThat(same(plan.policy.setRulesCalldata, setRulesCalldata), "plan setRules calldata mismatch");
  assertThat(same(plan.policy.createProposalCalldata, createProposalCalldata), "plan proposal calldata mismatch");
  assertThat(plan.policy.canCreatePolicyProposal && plan.policy.blockers.length === 0, "canonical plan has blockers");

  const rpc = required("ETH_MAINNET_RPC_URL");
  const client: any = createPublicClient({ chain: mainnet, transport: http(rpc, { timeout: 30_000 }) });
  assertThat(await client.getChainId() === 1, "RPC is not Ethereum mainnet");
  const dc = getAddress(await client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "dcToken" }));
  const treasury = getAddress(await client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "treasury" }));
  const minterRole = await client.readContract({ address: dc, abi: tokenAbi, functionName: "MINTER_ROLE" });
  const [
    governanceRegistry, registryGovernance, majorFee, proposalCount, canMint, paused,
    balance, allowance, totalSupply, treasuryBalance, bscRule, baseRule, baseRoute,
    broadcastNonce, nonces,
  ] = await Promise.all([
    client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "policyRegistry" }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "governance" }),
    client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "majorProposalFee" }),
    client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }),
    client.readContract({ address: dc, abi: tokenAbi, functionName: "hasRole", args: [minterRole, OWNER] }),
    client.readContract({ address: dc, abi: tokenAbi, functionName: "paused" }),
    client.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
    client.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }),
    client.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    client.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BSC_PROBE, SELECTOR] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_PROBE, SELECTOR] }),
    client.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
    client.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    nonceState(client),
  ]);
  assertThat(same(governanceRegistry, REGISTRY) && same(registryGovernance, GOVERNANCE), "governance wiring mismatch");
  assertThat(majorFee === FEE, "Major fee is not exactly 1000 DC");
  assertThat(canMint && !paused, "DC mint preconditions failed");
  assertThat(ruleIsEmpty(bscRule) && ruleIsEmpty(baseRule), "one target policy is already configured");
  assertThat(baseRoute[6] === false, "Base route must remain inactive");
  assertThat(nonces.latest === nonces.pending, "signer has a pending Ethereum transaction");
  const duplicate = await findDuplicate(client, proposalCount, setRulesCalldata);
  assertThat(duplicate === undefined, `duplicate policy proposal already exists: ${duplicate}`);
  assertThat(proposalCount.toString() === plan.currentState.proposalCount, "proposal count changed after plan generation");
  assertThat((proposalCount + 1n).toString() === plan.currentState.expectedPolicyProposalId, "expected proposal id changed");

  const preflight = {
    status: "PASS",
    mode,
    blockNumber: (await client.getBlockNumber()).toString(),
    proposalCount: proposalCount.toString(),
    expectedProposalId: (proposalCount + 1n).toString(),
    balance: balance.toString(),
    allowance: allowance.toString(),
    pendingNonce: nonces.pending,
    baseRouteActive: baseRoute[6],
    duplicateProposal: null,
    exactDescription: DESCRIPTION,
    exactSetRulesCalldata: setRulesCalldata,
    exactCreateProposalCalldata: createProposalCalldata,
  };
  console.log(stringify(preflight));
  if (mode === "preflight") return;

  assertThat(process.env.BASE_CROSS_CHAIN_V2_POLICY_PROPOSAL_CONFIRM === CONFIRM, "write gate is closed");
  const account = privateKeyToAccount(signerKey());
  assertThat(same(account.address, OWNER), `signer mismatch: ${account.address}`);
  const wallet: any = createWalletClient({ account, chain: mainnet, transport: http(rpc, { timeout: 30_000 }) });

  let state: State;
  if (existsSync(STATE_FILE)) {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    assertThat(same(state.proposer, OWNER) && same(state.setRulesCalldata, setRulesCalldata), "existing state mismatch");
  } else {
    assertThat(balance === 0n && allowance === 0n, "proposer DC balance/allowance must start at zero");
    state = {
      schemaVersion: 1,
      scope: "mint/approve one exact Major fee and create Base CrossChain V2 canary policy proposal only",
      stage: "started",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      proposer: OWNER,
      governance: GOVERNANCE,
      registry: REGISTRY,
      dc,
      treasury,
      description: DESCRIPTION,
      fee: FEE.toString(),
      proposalCountBefore: proposalCount.toString(),
      expectedProposalId: (proposalCount + 1n).toString(),
      totalSupplyBefore: totalSupply.toString(),
      treasuryBalanceBefore: treasuryBalance.toString(),
      broadcastNonceBefore: broadcastNonce.toString(),
      setRulesCalldata,
      createProposalCalldata,
      transactions: {},
    };
    save(state);
  }

  const mintCalldata = encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [OWNER, FEE] });
  if (!state.transactions.mint) {
    const hash = await wallet.writeContract({ address: dc, abi: tokenAbi, functionName: "mint", args: [OWNER, FEE] });
    state.transactions.mint = await waitAndVerify(client, hash, dc, mintCalldata);
    state.stage = "fee-minted";
    save(state);
  }
  const [balanceAfterMint, supplyAfterMint] = await Promise.all([
    client.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
    client.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
  ]);
  assertThat(balanceAfterMint === FEE, "exact minted balance mismatch");
  assertThat(supplyAfterMint === BigInt(state.totalSupplyBefore) + FEE, "total supply mint delta mismatch");

  const approveCalldata = encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [GOVERNANCE, FEE] });
  if (!state.transactions.approve) {
    const hash = await wallet.writeContract({ address: dc, abi: tokenAbi, functionName: "approve", args: [GOVERNANCE, FEE] });
    state.transactions.approve = await waitAndVerify(client, hash, dc, approveCalldata);
    state.stage = "fee-approved";
    save(state);
  }
  assertThat(await client.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }) === FEE, "exact allowance mismatch");

  assertThat(await client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }) === BigInt(state.proposalCountBefore), "proposal count changed before creation");
  const proposalArgs = [[REGISTRY], [0n], [setRulesCalldata], DESCRIPTION, MAJOR] as const;
  const simulation = await client.simulateContract({ account: OWNER, address: GOVERNANCE, abi: governanceAbi, functionName: "createProposal", args: proposalArgs });
  assertThat(simulation.result === BigInt(state.expectedProposalId), "simulated proposal id mismatch");
  if (!state.transactions.createProposal) {
    const hash = await wallet.writeContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "createProposal", args: proposalArgs });
    state.transactions.createProposal = await waitAndVerify(client, hash, GOVERNANCE, createProposalCalldata);
    state.stage = "proposal-created";
    state.proposalId = state.expectedProposalId;
    save(state);
  }

  const proposalId = BigInt(state.expectedProposalId);
  const [
    countAfter, proposal, actions, proposalState, balanceAfter, allowanceAfter,
    supplyAfter, treasuryAfter, bscRuleAfter, baseRuleAfter, baseRouteAfter,
    nonceAfter,
  ] = await Promise.all([
    client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }),
    client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [proposalId] }),
    client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [proposalId] }),
    client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [proposalId] }),
    client.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
    client.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }),
    client.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    client.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BSC_PROBE, SELECTOR] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_PROBE, SELECTOR] }),
    client.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
    client.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
  ]);
  assertThat(countAfter === proposalId && proposalState === 1, "proposal is not newly Pending");
  assertThat(same(proposal.proposer, OWNER) && proposal.kind === MAJOR && proposal.totalStaked === 0n, "proposal metadata mismatch");
  assertThat(!proposal.executed && proposal.description === DESCRIPTION, "proposal description/executed state mismatch");
  assertThat(actions[0].length === 1 && same(actions[0][0], REGISTRY), "proposal target mismatch");
  assertThat(actions[1].length === 1 && actions[1][0] === 0n, "proposal value mismatch");
  assertThat(actions[2].length === 1 && same(actions[2][0], setRulesCalldata), "proposal calldata mismatch");
  assertThat(balanceAfter === 0n && allowanceAfter === 0n, "proposal fee balance/allowance mismatch");
  assertThat(supplyAfter === BigInt(state.totalSupplyBefore) + FEE, "final supply delta mismatch");
  assertThat(treasuryAfter === BigInt(state.treasuryBalanceBefore) + FEE, "treasury fee delta mismatch");
  assertThat(ruleIsEmpty(bscRuleAfter) && ruleIsEmpty(baseRuleAfter), "rules changed before proposal execution");
  assertThat(baseRouteAfter[6] === false, "Base route was unexpectedly activated");
  assertThat(nonceAfter === BigInt(state.broadcastNonceBefore), "broadcast nonce changed");

  state.verification = {
    proposalState: Number(proposalState),
    totalStaked: proposal.totalStaked.toString(),
    descriptionMatched: proposal.description === DESCRIPTION,
    actionsMatched: true,
    proposerBalance: balanceAfter.toString(),
    proposerAllowance: allowanceAfter.toString(),
    treasuryFeeDelta: (treasuryAfter - BigInt(state.treasuryBalanceBefore)).toString(),
    rulesStillInactive: true,
    baseRouteActive: baseRouteAfter[6],
    broadcastNonce: nonceAfter.toString(),
    noStake: proposal.totalStaked === 0n,
    noExecution: !proposal.executed,
  };
  save(state);
  console.log(stringify({ status: "PASS", proposalId: state.proposalId, stateFile: STATE_FILE, transactions: state.transactions, verification: state.verification }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
