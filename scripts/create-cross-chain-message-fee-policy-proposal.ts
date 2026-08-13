/**
 * Production stage 1 for the BSC + Base message-fee resonance:
 *   1. Remove the obsolete BSC test Probe from the BSC Executor allowlist.
 *   2. Mint/approve exactly one Major fee and create only the policy proposal.
 *
 * It never stakes, executes, broadcasts, changes a business parameter, or
 * submits a Base transaction.
 *
 * Read-only:
 *   node --import tsx scripts/create-cross-chain-message-fee-policy-proposal.ts preflight
 *
 * Write gate:
 *   CROSS_CHAIN_MESSAGE_FEE_POLICY_CONFIRM=CLOSE_BSC_PROBE_AND_CREATE_EXACT_POLICY \
 *     node --import tsx scripts/create-cross-chain-message-fee-policy-proposal.ts execute
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
import { bsc, mainnet } from "viem/chains";

import {
  BASE_EXECUTOR,
  BASE_FACTORY,
  BASE_PROBE,
  BROADCASTER,
  BSC_EXECUTOR,
  BSC_FACTORY,
  BSC_PROBE,
  EXECUTOR_ALLOWLIST_SELECTOR,
  GOVERNANCE,
  MAJOR,
  MAJOR_PROPOSAL_FEE,
  MESSAGE_FEE_SETTER_SELECTOR,
  OWNER,
  POLICY_DESCRIPTION,
  PROBE_MARKER_SELECTOR,
  REGISTRY,
  broadcasterAbi,
  buildPolicyProposalCalldata,
  buildSetRulesCalldata,
  executorAbi,
  governanceAbi,
  isEmptyRule,
  isExactNestedRule,
  registryAbi,
} from "./lib/cross-chain-message-fee-canary.js";

const STATE_FILE = "deployments/cross-chain-message-fee-policy-proposal.json";
const CONFIRM = "CLOSE_BSC_PROBE_AND_CREATE_EXACT_POLICY";
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

type TxRecord = { hash: Hex; nonce: number; blockNumber: string; gasUsed: string; verified: true };
type State = {
  schemaVersion: 1;
  stage: "started" | "bsc-probe-closed" | "fee-minted" | "fee-approved" | "proposal-created";
  startedAt: string;
  updatedAt: string;
  proposalCountBefore: string;
  expectedProposalId: string;
  dc: Address;
  treasury: Address;
  totalSupplyBefore: string;
  treasuryBalanceBefore: string;
  broadcastNonceBefore: string;
  setRulesCalldata: Hex;
  createProposalCalldata: Hex;
  transactions: { bscProbeCleanup?: TxRecord; mint?: TxRecord; approve?: TxRecord; createProposal?: TxRecord };
  verification?: Record<string, unknown>;
};

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) process.env[match[1].trim()] = match[2].trim();
  }
}
function required(name: string, fallback?: string) {
  const value = process.env[name]?.trim() || fallback;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function key(...names: string[]): Hex {
  for (const name of names) {
    const raw = process.env[name]?.trim();
    if (raw) return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  }
  throw new Error(`Missing signing key: ${names.join(" or ")}`);
}
function same(a: unknown, b: unknown) { return String(a).toLowerCase() === String(b).toLowerCase(); }
function assertThat(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function stringify(value: unknown) {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}
function save(state: State) {
  state.updatedAt = new Date().toISOString();
  writeFileSync(STATE_FILE, `${stringify(state)}\n`, "utf8");
}
async function waitExact(client: any, hash: Hex, sender: Address, target: Address, calldata: Hex): Promise<TxRecord> {
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 300_000 });
  const tx = await client.getTransaction({ hash });
  assertThat(receipt.status === "success", `transaction reverted: ${hash}`);
  assertThat(same(tx.from, sender) && tx.to && same(tx.to, target), `sender/target mismatch: ${hash}`);
  assertThat(same(tx.input, calldata) && tx.value === 0n, `calldata/value mismatch: ${hash}`);
  return { hash, nonce: tx.nonce, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), verified: true };
}
async function findDuplicate(client: any, count: bigint, action: Hex) {
  for (let id = 1n; id <= count; id++) {
    const [targets, values, calldatas] = await client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [id] });
    if (targets.length === 1 && same(targets[0], REGISTRY) && values[0] === 0n && same(calldatas[0], action)) return id;
  }
  return undefined;
}
async function rules(client: any) {
  const [bscProbe, baseProbe, bscFee, baseFee, baseExecutor] = await Promise.all([
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BSC_PROBE, PROBE_MARKER_SELECTOR] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_PROBE, PROBE_MARKER_SELECTOR] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BSC_FACTORY, MESSAGE_FEE_SETTER_SELECTOR] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_FACTORY, MESSAGE_FEE_SETTER_SELECTOR] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_EXECUTOR, EXECUTOR_ALLOWLIST_SELECTOR] }),
  ]);
  return { bscProbe, baseProbe, bscFee, baseFee, baseExecutor };
}
function rulesArePrerequisite(value: Awaited<ReturnType<typeof rules>>) {
  return isExactNestedRule(value.bscProbe) && isExactNestedRule(value.baseProbe)
    && isEmptyRule(value.bscFee) && isEmptyRule(value.baseFee) && isEmptyRule(value.baseExecutor);
}

async function main() {
  loadEnv();
  const mode = process.argv[2] || "preflight";
  assertThat(mode === "preflight" || mode === "execute", "mode must be preflight or execute");
  const ethRpc = required("ETH_MAINNET_RPC_URL", "https://eth-mainnet.public.blastapi.io");
  const bscRpc = required("BSC_MAINNET_RPC_URL", "https://bsc-mainnet.public.blastapi.io");
  const eth: any = createPublicClient({ chain: mainnet, transport: http(ethRpc, { timeout: 30_000 }) });
  const bscClient: any = createPublicClient({ chain: bsc, transport: http(bscRpc, { timeout: 30_000 }) });
  assertThat(await eth.getChainId() === 1 && await bscClient.getChainId() === 56, "RPC chain mismatch");
  const setRulesCalldata = buildSetRulesCalldata();
  const createProposalCalldata = buildPolicyProposalCalldata();
  const dc = getAddress(await eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "dcToken" }));
  const treasury = getAddress(await eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "treasury" }));
  const minterRole = await eth.readContract({ address: dc, abi: tokenAbi, functionName: "MINTER_ROLE" });
  const [proposalCount, fee, canMint, paused, balance, allowance, supply, treasuryBalance, registryAddress,
    registryGovernance, policyAllowed, nonce, latestNonce, pendingNonce, bscOwner, bscProbeAllowed,
    bscLatestNonce, bscPendingNonce, bscGas] = await Promise.all([
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "majorProposalFee" }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "hasRole", args: [minterRole, OWNER] }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "paused" }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "policyRegistry" }),
    eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "governance" }),
    eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isActionAllowed", args: [MAJOR, REGISTRY, 0n, setRulesCalldata] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    eth.getTransactionCount({ address: OWNER, blockTag: "latest" }),
    eth.getTransactionCount({ address: OWNER, blockTag: "pending" }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "owner" }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BSC_PROBE] }),
    bscClient.getTransactionCount({ address: OWNER, blockTag: "latest" }),
    bscClient.getTransactionCount({ address: OWNER, blockTag: "pending" }),
    bscClient.getBalance({ address: OWNER }),
  ]);
  const liveRules = await rules(eth);
  const duplicate = await findDuplicate(eth, proposalCount, setRulesCalldata);
  assertThat(same(registryAddress, REGISTRY) && same(registryGovernance, GOVERNANCE), "registry wiring mismatch");
  assertThat(fee === MAJOR_PROPOSAL_FEE && canMint && !paused, "Major fee prerequisites failed");
  assertThat(rulesArePrerequisite(liveRules), "policy prerequisite state is partial/unexpected");
  assertThat(policyAllowed, "exact policy action blocked");
  assertThat(latestNonce === pendingNonce && bscLatestNonce === bscPendingNonce, "pending signer transaction exists");
  assertThat(same(bscOwner, OWNER), "BSC Executor owner mismatch");
  assertThat(bscGas > 0n, "BSC signer has no gas");
  assertThat(duplicate === undefined, `duplicate exact policy proposal exists: ${duplicate}`);
  const resumableState = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, "utf8")) as State
    : undefined;
  if (resumableState) {
    assertThat(resumableState.schemaVersion === 1, "existing state schema mismatch");
    assertThat(same(resumableState.dc, dc) && same(resumableState.treasury, treasury), "existing state address mismatch");
    assertThat(same(resumableState.setRulesCalldata, setRulesCalldata), "existing state policy mismatch");
    assertThat(BigInt(resumableState.expectedProposalId) === proposalCount + 1n || resumableState.stage === "proposal-created", "existing state proposal id mismatch");
  }

  console.log(stringify({ status: "PASS", mode, proposalCount, expectedProposalId: proposalCount + 1n,
    bscProbeAllowed, bscGas, ethSignerNonce: pendingNonce, bscSignerNonce: bscPendingNonce,
    description: POLICY_DESCRIPTION, resumableStage: resumableState?.stage ?? null, noStakeExecutionOrBroadcast: true }));
  if (mode === "preflight") return;
  assertThat(process.env.CROSS_CHAIN_MESSAGE_FEE_POLICY_CONFIRM === CONFIRM, "write gate is closed");

  const ethAccount = privateKeyToAccount(key("ETH_MAINNET_PRIVATE_KEY", "AGIKING_PRIVATE_KEY"));
  const bscAccount = privateKeyToAccount(key("BSC_MAINNET_PRIVATE_KEY", "AGIKING_PRIVATE_KEY"));
  assertThat(same(ethAccount.address, OWNER) && same(bscAccount.address, OWNER), "signer address mismatch");
  const ethWallet: any = createWalletClient({ account: ethAccount, chain: mainnet, transport: http(ethRpc, { timeout: 30_000 }) });
  const bscWallet: any = createWalletClient({ account: bscAccount, chain: bsc, transport: http(bscRpc, { timeout: 30_000 }) });
  const state: State = resumableState ?? { schemaVersion: 1, stage: "started", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      proposalCountBefore: proposalCount.toString(), expectedProposalId: (proposalCount + 1n).toString(), dc, treasury,
      totalSupplyBefore: supply.toString(), treasuryBalanceBefore: treasuryBalance.toString(), broadcastNonceBefore: nonce.toString(),
      setRulesCalldata, createProposalCalldata, transactions: {} };
  if (!resumableState) save(state);

  if (bscProbeAllowed && !state.transactions.bscProbeCleanup) {
    const calldata = encodeFunctionData({ abi: executorAbi, functionName: "setAllowedTarget", args: [BSC_PROBE, false] });
    await bscClient.simulateContract({ account: OWNER, address: BSC_EXECUTOR, abi: executorAbi, functionName: "setAllowedTarget", args: [BSC_PROBE, false] });
    const hash = await bscWallet.writeContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "setAllowedTarget", args: [BSC_PROBE, false] });
    state.transactions.bscProbeCleanup = await waitExact(bscClient, hash, OWNER, BSC_EXECUTOR, calldata);
  }
  assertThat(await bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BSC_PROBE] }) === false, "BSC Probe remains allowed");
  assertThat(await bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BSC_FACTORY] }) === true, "BSC Factory allowlist changed");
  state.stage = "bsc-probe-closed"; save(state);

  const mintData = encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [OWNER, MAJOR_PROPOSAL_FEE] });
  if (!state.transactions.mint) {
    assertThat(await eth.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }) === 0n, "unexpected pre-mint DC balance");
    const mintHash = await ethWallet.writeContract({ address: dc, abi: tokenAbi, functionName: "mint", args: [OWNER, MAJOR_PROPOSAL_FEE] });
    state.transactions.mint = await waitExact(eth, mintHash, OWNER, dc, mintData); state.stage = "fee-minted"; save(state);
  }

  const approveData = encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [GOVERNANCE, MAJOR_PROPOSAL_FEE] });
  if (!state.transactions.approve) {
    assertThat(await eth.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }) === MAJOR_PROPOSAL_FEE, "minted balance mismatch");
    const approveHash = await ethWallet.writeContract({ address: dc, abi: tokenAbi, functionName: "approve", args: [GOVERNANCE, MAJOR_PROPOSAL_FEE] });
    state.transactions.approve = await waitExact(eth, approveHash, OWNER, dc, approveData); state.stage = "fee-approved"; save(state);
  }

  const args = [[REGISTRY], [0n], [setRulesCalldata], POLICY_DESCRIPTION, MAJOR] as const;
  if (!state.transactions.createProposal) {
    assertThat(await eth.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }) === MAJOR_PROPOSAL_FEE, "approved allowance mismatch");
    const simulation = await eth.simulateContract({ account: OWNER, address: GOVERNANCE, abi: governanceAbi, functionName: "createProposal", args });
    assertThat(simulation.result === BigInt(state.expectedProposalId), "simulated proposal id mismatch");
    const createHash = await ethWallet.writeContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "createProposal", args });
    state.transactions.createProposal = await waitExact(eth, createHash, OWNER, GOVERNANCE, createProposalCalldata);
  }

  const id = BigInt(state.expectedProposalId);
  const [countAfter, proposal, actions, proposalState, balanceAfter, allowanceAfter, supplyAfter, treasuryAfter, nonceAfter, rulesAfter] = await Promise.all([
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [id] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [id] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [id] }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    rules(eth),
  ]);
  assertThat(countAfter === id && proposalState === 1, "proposal is not new Pending");
  assertThat(same(proposal.proposer, OWNER) && proposal.kind === MAJOR && proposal.totalStaked === 0n && !proposal.executed, "proposal identity/state mismatch");
  assertThat(proposal.description === POLICY_DESCRIPTION && proposal.createdAt > 0, "description/time mismatch");
  assertThat(actions[0].length === 1 && same(actions[0][0], REGISTRY) && actions[1][0] === 0n && same(actions[2][0], setRulesCalldata), "proposal action mismatch");
  assertThat(balanceAfter === 0n && allowanceAfter === 0n, "proposer DC residue");
  assertThat(supplyAfter === BigInt(state.totalSupplyBefore) + MAJOR_PROPOSAL_FEE && treasuryAfter === BigInt(state.treasuryBalanceBefore) + MAJOR_PROPOSAL_FEE, "proposal fee accounting mismatch");
  assertThat(nonceAfter === BigInt(state.broadcastNonceBefore) && rulesArePrerequisite(rulesAfter), "policy activated or broadcast occurred prematurely");
  state.stage = "proposal-created";
  state.verification = { proposalId: id, proposalState, totalStaked: proposal.totalStaked, bscProbeAllowed: false,
    rulesStillInactive: true, feeMovedToTreasury: MAJOR_PROPOSAL_FEE, noStake: true, noExecution: true, noBroadcast: true };
  save(state);
  console.log(stringify({ status: "PASS", stateFile: STATE_FILE, transactions: state.transactions, verification: state.verification }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
