/**
 * Creates only the prerequisite Major policy proposal for the BSC + Base
 * minimum-timeout canary. It never stakes, votes, executes or broadcasts.
 *
 * Read-only:
 *   node --import tsx/esm scripts/create-cross-chain-min-timeout-policy-proposal.ts preflight
 *
 * Explicit write gate:
 *   CROSS_CHAIN_MIN_TIMEOUT_POLICY_CONFIRM=MINT_APPROVE_CREATE_EXACT_TIMEOUT_POLICY \
 *     node --import tsx/esm scripts/create-cross-chain-min-timeout-policy-proposal.ts execute
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import {
  BASE_FACTORY,
  BROADCASTER,
  BSC_FACTORY,
  GOVERNANCE,
  MAJOR,
  MAJOR_PROPOSAL_FEE,
  MIN_TIMEOUT_SETTER_SELECTOR,
  OWNER,
  POLICY_DESCRIPTION,
  REGISTRY,
  buildPolicyProposalCalldata,
  buildSetRulesCalldata,
  broadcasterAbi,
  governanceAbi,
  isEmptyRule,
  registryAbi,
} from "./lib/cross-chain-min-timeout-canary.js";

const STATE_FILE = "deployments/cross-chain-min-timeout-policy-proposal.json";
const CONFIRM = "MINT_APPROVE_CREATE_EXACT_TIMEOUT_POLICY";
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

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) process.env[match[1].trim()] = match[2].trim();
  }
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function signerKey(): Hex {
  const raw = process.env.ETH_MAINNET_PRIVATE_KEY?.trim() || process.env.AGIKING_PRIVATE_KEY?.trim();
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

async function waitAndVerify(client: any, hash: Hex, target: Address, calldata: Hex): Promise<TxRecord> {
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 300_000 });
  const tx = await client.getTransaction({ hash });
  assertThat(receipt.status === "success", `transaction reverted: ${hash}`);
  assertThat(same(tx.from, OWNER), `unexpected sender: ${hash}`);
  assertThat(tx.to && same(tx.to, target), `unexpected target: ${hash}`);
  assertThat(same(tx.input, calldata), `unexpected calldata: ${hash}`);
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
  for (let id = 1n; id <= count; id += 1n) {
    const actions = await client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [id] });
    if (
      actions[0].length === 1 && same(actions[0][0], REGISTRY)
      && actions[1].length === 1 && actions[1][0] === 0n
      && actions[2].length === 1 && same(actions[2][0], calldata)
    ) return id;
  }
  return undefined;
}

async function verifyCreated(client: any, state: State) {
  const id = BigInt(state.expectedProposalId);
  const [count, proposal, actions, proposalState, balance, allowance, supply, treasuryBalance, bscRule, baseRule, nonce] = await Promise.all([
    client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }),
    client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [id] }),
    client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [id] }),
    client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [id] }),
    client.readContract({ address: state.dc, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
    client.readContract({ address: state.dc, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }),
    client.readContract({ address: state.dc, abi: tokenAbi, functionName: "totalSupply" }),
    client.readContract({ address: state.dc, abi: tokenAbi, functionName: "balanceOf", args: [state.treasury] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BSC_FACTORY, MIN_TIMEOUT_SETTER_SELECTOR] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_FACTORY, MIN_TIMEOUT_SETTER_SELECTOR] }),
    client.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
  ]);
  assertThat(count === id && proposalState === 1, "proposal is not newly Pending");
  assertThat(same(proposal.proposer, OWNER) && proposal.kind === MAJOR, "proposal identity mismatch");
  assertThat(proposal.totalStaked === 0n && !proposal.executed, "proposal was staked or executed");
  assertThat(proposal.description === POLICY_DESCRIPTION && proposal.createdAt > 0, "proposal description/time mismatch");
  assertThat(actions[0].length === 1 && same(actions[0][0], REGISTRY), "proposal target mismatch");
  assertThat(actions[1].length === 1 && actions[1][0] === 0n, "proposal value mismatch");
  assertThat(actions[2].length === 1 && same(actions[2][0], state.setRulesCalldata), "proposal calldata mismatch");
  assertThat(balance === 0n && allowance === 0n, "proposer DC balance/allowance mismatch");
  assertThat(supply === BigInt(state.totalSupplyBefore) + MAJOR_PROPOSAL_FEE, "total supply delta mismatch");
  assertThat(treasuryBalance === BigInt(state.treasuryBalanceBefore) + MAJOR_PROPOSAL_FEE, "treasury fee delta mismatch");
  assertThat(isEmptyRule(bscRule) && isEmptyRule(baseRule), "policy activated before proposal execution");
  assertThat(nonce === BigInt(state.broadcastNonceBefore), "broadcast nonce changed");
  state.stage = "proposal-created";
  state.proposalId = id.toString();
  state.verification = {
    proposalState: Number(proposalState),
    createdAt: proposal.createdAt.toString(),
    totalStaked: proposal.totalStaked.toString(),
    descriptionMatched: true,
    actionsMatched: true,
    feeMovedToTreasury: MAJOR_PROPOSAL_FEE.toString(),
    rulesStillInactive: true,
    noStake: true,
    noExecution: true,
    noBroadcast: true,
  };
  save(state);
  return state.verification;
}

async function main() {
  loadEnv();
  const mode = process.argv[2] || "preflight";
  assertThat(mode === "preflight" || mode === "execute", "mode must be preflight or execute");
  const rpc = required("ETH_MAINNET_RPC_URL");
  const client: any = createPublicClient({ chain: mainnet, transport: http(rpc, { timeout: 30_000 }) });
  assertThat(await client.getChainId() === 1, "RPC is not Ethereum mainnet");
  const setRulesCalldata = buildSetRulesCalldata();
  const createProposalCalldata = buildPolicyProposalCalldata();

  if (existsSync(STATE_FILE)) {
    const existing = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    assertThat(same(existing.proposer, OWNER) && same(existing.setRulesCalldata, setRulesCalldata), "existing state mismatch");
    if (existing.stage === "proposal-created") {
      const verification = await verifyCreated(client, existing);
      console.log(stringify({ status: "PASS_ALREADY_CREATED", proposalId: existing.proposalId, stateFile: STATE_FILE, verification }));
      return;
    }
  }

  const dc = getAddress(await client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "dcToken" }));
  const treasury = getAddress(await client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "treasury" }));
  const minterRole = await client.readContract({ address: dc, abi: tokenAbi, functionName: "MINTER_ROLE" });
  const [
    governanceRegistry, registryGovernance, majorFee, proposalCount, canMint, paused,
    balance, allowance, totalSupply, treasuryBalance, bscRule, baseRule,
    policyAllowed, broadcastNonce, latestNonce, pendingNonce,
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
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BSC_FACTORY, MIN_TIMEOUT_SETTER_SELECTOR] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_FACTORY, MIN_TIMEOUT_SETTER_SELECTOR] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isActionAllowed", args: [MAJOR, REGISTRY, 0n, setRulesCalldata] }),
    client.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    client.getTransactionCount({ address: OWNER, blockTag: "latest" }),
    client.getTransactionCount({ address: OWNER, blockTag: "pending" }),
  ]);
  assertThat(same(governanceRegistry, REGISTRY) && same(registryGovernance, GOVERNANCE), "governance/registry wiring mismatch");
  assertThat(majorFee === MAJOR_PROPOSAL_FEE && canMint && !paused, "Major fee preconditions failed");
  assertThat(isEmptyRule(bscRule) && isEmptyRule(baseRule), "policy is already active or partial");
  assertThat(policyAllowed, "exact policy action is not allowed");
  assertThat(latestNonce === pendingNonce, "signer has a pending Ethereum transaction");
  const duplicate = await findDuplicate(client, proposalCount, setRulesCalldata);
  assertThat(duplicate === undefined, `duplicate exact policy proposal exists: ${duplicate}`);

  const preflight = {
    status: "PASS",
    mode,
    blockNumber: await client.getBlockNumber(),
    proposalCount,
    expectedProposalId: proposalCount + 1n,
    signerNonce: pendingNonce,
    balance,
    allowance,
    description: POLICY_DESCRIPTION,
    setRulesCalldata,
    createProposalCalldata,
    duplicateProposal: null,
    noStakeOrExecutionInScript: true,
  };
  console.log(stringify(preflight));
  if (mode === "preflight") return;

  assertThat(process.env.CROSS_CHAIN_MIN_TIMEOUT_POLICY_CONFIRM === CONFIRM, "write gate is closed");
  const account = privateKeyToAccount(signerKey());
  assertThat(same(account.address, OWNER), `signer mismatch: ${account.address}`);
  const wallet: any = createWalletClient({ account, chain: mainnet, transport: http(rpc, { timeout: 30_000 }) });

  let state: State;
  if (existsSync(STATE_FILE)) {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } else {
    assertThat(balance === 0n && allowance === 0n, "proposer DC balance/allowance must start at zero");
    state = {
      schemaVersion: 1,
      scope: "mint and approve one exact Major fee, then create only the BSC+Base minimum-timeout policy proposal",
      stage: "started",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      proposer: OWNER,
      governance: GOVERNANCE,
      registry: REGISTRY,
      dc,
      treasury,
      description: POLICY_DESCRIPTION,
      fee: MAJOR_PROPOSAL_FEE.toString(),
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

  const mintCalldata = encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [OWNER, MAJOR_PROPOSAL_FEE] });
  if (!state.transactions.mint) {
    const hash = await wallet.writeContract({ address: dc, abi: tokenAbi, functionName: "mint", args: [OWNER, MAJOR_PROPOSAL_FEE] });
    state.transactions.mint = await waitAndVerify(client, hash, dc, mintCalldata);
    state.stage = "fee-minted";
    save(state);
  }
  assertThat(await client.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }) === MAJOR_PROPOSAL_FEE, "minted fee balance mismatch");
  assertThat(await client.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }) === BigInt(state.totalSupplyBefore) + MAJOR_PROPOSAL_FEE, "mint supply delta mismatch");

  const approveCalldata = encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [GOVERNANCE, MAJOR_PROPOSAL_FEE] });
  if (!state.transactions.approve) {
    const hash = await wallet.writeContract({ address: dc, abi: tokenAbi, functionName: "approve", args: [GOVERNANCE, MAJOR_PROPOSAL_FEE] });
    state.transactions.approve = await waitAndVerify(client, hash, dc, approveCalldata);
    state.stage = "fee-approved";
    save(state);
  }
  assertThat(await client.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }) === MAJOR_PROPOSAL_FEE, "allowance mismatch");
  assertThat(await client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }) === BigInt(state.proposalCountBefore), "proposal count changed before creation");

  const proposalArgs = [[REGISTRY], [0n], [setRulesCalldata], POLICY_DESCRIPTION, MAJOR] as const;
  const simulation = await client.simulateContract({ account: OWNER, address: GOVERNANCE, abi: governanceAbi, functionName: "createProposal", args: proposalArgs });
  assertThat(simulation.result === BigInt(state.expectedProposalId), "simulated proposal id mismatch");
  if (!state.transactions.createProposal) {
    const hash = await wallet.writeContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "createProposal", args: proposalArgs });
    state.transactions.createProposal = await waitAndVerify(client, hash, GOVERNANCE, createProposalCalldata);
    state.stage = "proposal-created";
    state.proposalId = state.expectedProposalId;
    save(state);
  }
  const verification = await verifyCreated(client, state);
  console.log(stringify({ status: "PASS", proposalId: state.proposalId, stateFile: STATE_FILE, transactions: state.transactions, verification }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
