/** Read-only production planner for the BSC + Base minimum-timeout canary. */
import { existsSync, readFileSync } from "node:fs";

import {
  createPublicClient,
  fallback,
  formatEther,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { base, bsc, mainnet } from "viem/chains";

import {
  ACTION_FEE_BUDGET,
  BASE_CHAIN_KEY,
  BASE_EXECUTOR,
  BASE_FACTORY,
  BROADCASTER,
  BSC_CHAIN_KEY,
  BSC_EXECUTOR,
  BSC_FACTORY,
  CANARY_DESCRIPTION,
  CANARY_MIN_TIMEOUT,
  CHAINS,
  CURRENT_MIN_TIMEOUT,
  GOVERNANCE,
  LZ_GAS,
  MAJOR,
  MAJOR_PROPOSAL_FEE,
  MIN_TIMEOUT_SETTER_SELECTOR,
  OWNER,
  POLICY_DESCRIPTION,
  REGISTRY,
  RESTORE_DESCRIPTION,
  broadcasterAbi,
  buildBroadcastCalldata,
  buildCanaryProposalCalldata,
  buildMinTimeoutCalldata,
  buildPolicyProposalCalldata,
  buildSetRulesCalldata,
  executorAbi,
  factoryAbi,
  governanceAbi,
  isEmptyRule,
  isExactNestedRule,
  registryAbi,
} from "./lib/cross-chain-min-timeout-canary.js";

const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function MINTER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function paused() view returns (bool)",
]);

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

function same(a: unknown, b: unknown) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function stringify(value: unknown) {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function ruleJson(rule: any) {
  return {
    allowed: rule.allowed ?? rule[0],
    validateNestedBroadcast: rule.validateNestedBroadcast ?? rule[1],
    nestedOnly: rule.nestedOnly ?? rule[2],
    maxValue: BigInt(rule.maxValue ?? rule[3]),
  };
}

async function findDuplicate(client: any, count: bigint, target: Address, value: bigint, calldata: Hex) {
  for (let id = 1n; id <= count; id += 1n) {
    const actions = await client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [id] });
    if (
      actions[0].length === 1 && same(actions[0][0], target)
      && actions[1].length === 1 && actions[1][0] === value
      && actions[2].length === 1 && same(actions[2][0], calldata)
    ) return id;
  }
  return undefined;
}

loadEnv();
const eth = createPublicClient({ chain: mainnet, transport: http(required("ETH_MAINNET_RPC_URL"), { timeout: 30_000 }) });
const bscClient = createPublicClient({
  chain: bsc,
  transport: fallback([
    http(process.env.BSC_MAINNET_RPC_URL?.trim() || "https://bsc-rpc.publicnode.com"),
    http("https://bsc-mainnet.public.blastapi.io"),
  ], { rank: false }),
});
const baseClient = createPublicClient({
  chain: base,
  transport: fallback([
    http(process.env.BASE_MAINNET_RPC_URL?.trim() || "https://base-rpc.publicnode.com"),
    http("https://mainnet.base.org"),
  ], { rank: false }),
});
if (await eth.getChainId() !== 1 || await bscClient.getChainId() !== 56 || await baseClient.getChainId() !== 8453) {
  throw new Error("RPC chain mismatch");
}

const policyData = buildSetRulesCalldata();
const canaryInner = buildMinTimeoutCalldata(CANARY_MIN_TIMEOUT);
const canaryBroadcast = buildBroadcastCalldata(CANARY_MIN_TIMEOUT);
const restoreInner = buildMinTimeoutCalldata(CURRENT_MIN_TIMEOUT);
const restoreBroadcast = buildBroadcastCalldata(CURRENT_MIN_TIMEOUT);
const [
  dTokenRaw, dcTokenRaw, treasuryRaw, registryRaw, majorFee, proposalCount,
  broadcasterGovernance, chainIds, bscRoute, baseRoute, broadcastNonce, governanceBalance,
  latestNonce, pendingNonce, registryGovernance, bscRule, baseRule, policyAllowed,
  bscOwner, bscGovernance, bscTimeout, bscExecutorOwner, bscAllowed, bscThreshold,
  baseOwner, baseGovernance, baseTimeout, baseExecutorOwner, baseAllowed, baseThreshold,
] = await Promise.all([
  eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "dToken" }),
  eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "dcToken" }),
  eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "treasury" }),
  eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "policyRegistry" }),
  eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "majorProposalFee" }),
  eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }),
  eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "governance" }),
  eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "getChainIds" }),
  eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BSC_CHAIN_KEY] }),
  eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
  eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
  eth.getBalance({ address: GOVERNANCE }),
  eth.getTransactionCount({ address: OWNER, blockTag: "latest" }),
  eth.getTransactionCount({ address: OWNER, blockTag: "pending" }),
  eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "governance" }),
  eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BSC_FACTORY, MIN_TIMEOUT_SETTER_SELECTOR] }),
  eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_FACTORY, MIN_TIMEOUT_SETTER_SELECTOR] }),
  eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isActionAllowed", args: [MAJOR, REGISTRY, 0n, policyData] }),
  bscClient.readContract({ address: BSC_FACTORY, abi: factoryAbi, functionName: "owner" }),
  bscClient.readContract({ address: BSC_FACTORY, abi: factoryAbi, functionName: "crossChainGovernance" }),
  bscClient.readContract({ address: BSC_FACTORY, abi: factoryAbi, functionName: "minTimeoutSeconds" }),
  bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "owner" }),
  bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BSC_FACTORY] }),
  bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
  baseClient.readContract({ address: BASE_FACTORY, abi: factoryAbi, functionName: "owner" }),
  baseClient.readContract({ address: BASE_FACTORY, abi: factoryAbi, functionName: "crossChainGovernance" }),
  baseClient.readContract({ address: BASE_FACTORY, abi: factoryAbi, functionName: "minTimeoutSeconds" }),
  baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "owner" }),
  baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BASE_FACTORY] }),
  baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
]);

const dToken = getAddress(dTokenRaw);
const dcToken = getAddress(dcTokenRaw);
const treasury = getAddress(treasuryRaw);
const minterRole = await eth.readContract({ address: dcToken, abi: tokenAbi, functionName: "MINTER_ROLE" });
const [dBalance, dcBalance, allowance, canMintDc, dcPaused, quote, canaryAllowed, restoreAllowed] = await Promise.all([
  eth.readContract({ address: dToken, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
  eth.readContract({ address: dcToken, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
  eth.readContract({ address: dcToken, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }),
  eth.readContract({ address: dcToken, abi: tokenAbi, functionName: "hasRole", args: [minterRole, OWNER] }),
  eth.readContract({ address: dcToken, abi: tokenAbi, functionName: "paused" }),
  eth.readContract({
    address: BROADCASTER,
    abi: broadcasterAbi,
    functionName: "quoteFees",
    args: [CHAINS.map((chain) => chain.chainKey), CHAINS.map((chain) => chain.factory), canaryInner, LZ_GAS],
  }),
  eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isActionAllowed", args: [MAJOR, BROADCASTER, ACTION_FEE_BUDGET, canaryBroadcast] }),
  eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isActionAllowed", args: [MAJOR, BROADCASTER, ACTION_FEE_BUDGET, restoreBroadcast] }),
]);

const [duplicatePolicy, duplicateCanary, duplicateRestore] = await Promise.all([
  findDuplicate(eth, proposalCount, REGISTRY, 0n, policyData),
  findDuplicate(eth, proposalCount, BROADCASTER, ACTION_FEE_BUDGET, canaryBroadcast),
  findDuplicate(eth, proposalCount, BROADCASTER, ACTION_FEE_BUDGET, restoreBroadcast),
]);
const rulesReady = isExactNestedRule(bscRule) && isExactNestedRule(baseRule);
const rulesEmpty = isEmptyRule(bscRule) && isEmptyRule(baseRule);
const blockers: string[] = [];
if (!same(registryRaw, REGISTRY) || !same(registryGovernance, GOVERNANCE)) blockers.push("governance/registry wiring mismatch");
if (!same(broadcasterGovernance, GOVERNANCE)) blockers.push("broadcaster governance mismatch");
if (!bscRoute[6] || !baseRoute[6] || !chainIds.includes(BSC_CHAIN_KEY) || !chainIds.includes(BASE_CHAIN_KEY)) blockers.push("BSC/Base broadcaster route inactive");
if (!same(bscGovernance, BSC_EXECUTOR) || !same(baseGovernance, BASE_EXECUTOR)) blockers.push("Factory crossChainGovernance mismatch");
if (!bscAllowed || !baseAllowed || bscThreshold !== 2n || baseThreshold !== 2n) blockers.push("destination Executor is not 2-of-3 ready");
if (bscTimeout !== CURRENT_MIN_TIMEOUT || baseTimeout !== CURRENT_MIN_TIMEOUT) blockers.push("BSC/Base minimum timeout is not exactly 3600");
if (majorFee !== MAJOR_PROPOSAL_FEE || !canMintDc || dcPaused) blockers.push("Major proposal fee mint prerequisites failed");
if (!policyAllowed) blockers.push("exact Registry.setRules action is not allowed");
if (!rulesReady && !rulesEmpty) blockers.push("minimum-timeout policy is partial or unexpected");
if (rulesReady && (!canaryAllowed || !restoreAllowed)) blockers.push("policy is installed but exact broadcasts are blocked");
if (rulesEmpty && (canaryAllowed || restoreAllowed)) blockers.push("broadcast is unexpectedly allowed before policy");
if (quote === 0n || quote > ACTION_FEE_BUDGET) blockers.push("live bridge quote exceeds 0.005 ETH budget");
if (latestNonce !== pendingNonce) blockers.push("proposer has a pending Ethereum transaction");
if (duplicatePolicy || duplicateCanary || duplicateRestore) blockers.push("an exact duplicate proposal already exists");

console.log(stringify({
  status: blockers.length > 0 ? "BLOCKED" : rulesReady ? "PASS_READY_FOR_CANARY" : "PASS_WITH_POLICY_PREREQUISITE",
  readOnly: true,
  transactionSent: false,
  blocks: { ethereum: await eth.getBlockNumber(), bsc: await bscClient.getBlockNumber(), base: await baseClient.getBlockNumber() },
  proposalCount,
  expectedNextProposalId: proposalCount + 1n,
  proposer: { address: OWNER, dBalance, dcBalance, allowance, canMintDc, dcPaused, latestNonce, pendingNonce },
  governance: { address: GOVERNANCE, treasury, majorFee, balanceWei: governanceBalance, balanceEth: formatEther(governanceBalance) },
  broadcaster: { address: BROADCASTER, broadcastNonce, chainIds, quoteWei: quote, quoteEth: formatEther(quote), actionBudgetWei: ACTION_FEE_BUDGET },
  policyProposal: { description: POLICY_DESCRIPTION, setRulesCalldata: policyData, createProposalCalldata: buildPolicyProposalCalldata(), allowedNow: policyAllowed, duplicate: duplicatePolicy ?? null },
  canaryProposal: { description: CANARY_DESCRIPTION, from: CURRENT_MIN_TIMEOUT, to: CANARY_MIN_TIMEOUT, innerCalldata: canaryInner, broadcastCalldata: canaryBroadcast, createProposalCalldata: buildCanaryProposalCalldata(CANARY_MIN_TIMEOUT, CANARY_DESCRIPTION), allowedNow: canaryAllowed, duplicate: duplicateCanary ?? null },
  restoreProposal: { description: RESTORE_DESCRIPTION, from: CANARY_MIN_TIMEOUT, to: CURRENT_MIN_TIMEOUT, innerCalldata: restoreInner, broadcastCalldata: restoreBroadcast, createProposalCalldata: buildCanaryProposalCalldata(CURRENT_MIN_TIMEOUT, RESTORE_DESCRIPTION), allowedNow: restoreAllowed, duplicate: duplicateRestore ?? null, separateProposalRequired: true },
  bsc: { factory: BSC_FACTORY, owner: bscOwner, governance: bscGovernance, timeout: bscTimeout, executor: BSC_EXECUTOR, executorOwner: bscExecutorOwner, allowed: bscAllowed, threshold: bscThreshold, routeActive: bscRoute[6], rule: ruleJson(bscRule) },
  base: { factory: BASE_FACTORY, owner: baseOwner, governance: baseGovernance, timeout: baseTimeout, executor: BASE_EXECUTOR, executorOwner: baseExecutorOwner, allowed: baseAllowed, threshold: baseThreshold, routeActive: baseRoute[6], rule: ruleJson(baseRule) },
  blockers,
}));
