/** Read-only planner for the ETH DAO -> BSC + Base message-fee canary. */
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
  BASE_PROBE,
  BROADCASTER,
  BSC_CHAIN_KEY,
  BSC_EXECUTOR,
  BSC_FACTORY,
  BSC_PROBE,
  CANARY_DESCRIPTION,
  CANARY_MESSAGE_FEE,
  CHAIN_FEE_CONFIGS,
  CURRENT_MESSAGE_FEE,
  EXECUTOR_ALLOWLIST_SELECTOR,
  GOVERNANCE,
  LZ_GAS,
  MAJOR,
  MAJOR_PROPOSAL_FEE,
  MESSAGE_FEE_SETTER_SELECTOR,
  OWNER,
  POLICY_DESCRIPTION,
  PROBE_MARKER_SELECTOR,
  REGISTRY,
  RESTORE_DESCRIPTION,
  broadcasterAbi,
  buildFactoryFeeCalldata,
  buildMessageFeeActions,
  buildMessageFeeProposalCalldata,
  buildPolicyProposalCalldata,
  buildSetRulesCalldata,
  executorAbi,
  factoryAbi,
  governanceAbi,
  isEmptyRule,
  isExactNestedRule,
  registryAbi,
} from "./lib/cross-chain-message-fee-canary.js";

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

loadEnv();
const eth = createPublicClient({ chain: mainnet, transport: http(required("ETH_MAINNET_RPC_URL"), { timeout: 30_000 }) });
const bscClient = createPublicClient({
  chain: bsc,
  transport: fallback([
    http(process.env.BSC_MAINNET_RPC_URL?.trim() || "https://bsc-rpc.publicnode.com"),
    http("https://bsc-dataseed.binance.org"),
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

const actions = buildMessageFeeActions(CANARY_MESSAGE_FEE);
const restoreActions = buildMessageFeeActions(CURRENT_MESSAGE_FEE);
const setRulesCalldata = buildSetRulesCalldata();
const policyProposalCalldata = buildPolicyProposalCalldata();
const canaryProposalCalldata = buildMessageFeeProposalCalldata(CANARY_MESSAGE_FEE, CANARY_DESCRIPTION);
const restoreProposalCalldata = buildMessageFeeProposalCalldata(CURRENT_MESSAGE_FEE, RESTORE_DESCRIPTION);
const amountSetterProbeCalldata = buildFactoryFeeCalldata(CURRENT_MESSAGE_FEE);

const [
  dTokenRaw, dcTokenRaw, treasuryRaw, registryRaw, majorFee, proposalCount,
  broadcasterGovernance, chainIds, bscRoute, baseRoute, governanceEthBalance,
  latestNonce, pendingNonce, registryGovernance,
  bscOwner, bscAdmin, bscGovernance, bscEnabled, bscToken, bscPrice, bscExecutorOwner, bscAllowed, bscThreshold,
  baseOwner, baseAdmin, baseGovernance, baseEnabled, baseToken, basePrice, baseExecutorOwner, baseAllowed, baseThreshold,
  bscRule, baseRule, bscProbeRule, baseProbeRule, baseExecutorRule, policyActionAllowed,
  bscProbeAllowed, baseProbeAllowed,
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
  eth.getBalance({ address: GOVERNANCE }),
  eth.getTransactionCount({ address: OWNER, blockTag: "latest" }),
  eth.getTransactionCount({ address: OWNER, blockTag: "pending" }),
  eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "governance" }),
  bscClient.readContract({ address: BSC_FACTORY, abi: factoryAbi, functionName: "owner" }),
  bscClient.readContract({ address: BSC_FACTORY, abi: factoryAbi, functionName: "admin" }),
  bscClient.readContract({ address: BSC_FACTORY, abi: factoryAbi, functionName: "crossChainGovernance" }),
  bscClient.readContract({ address: BSC_FACTORY, abi: factoryAbi, functionName: "msgPriceEnabled" }),
  bscClient.readContract({ address: BSC_FACTORY, abi: factoryAbi, functionName: "msgPriceToken" }),
  bscClient.readContract({ address: BSC_FACTORY, abi: factoryAbi, functionName: "msgPriceAmountInToken" }),
  bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "owner" }),
  bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BSC_FACTORY] }),
  bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
  baseClient.readContract({ address: BASE_FACTORY, abi: factoryAbi, functionName: "owner" }),
  baseClient.readContract({ address: BASE_FACTORY, abi: factoryAbi, functionName: "admin" }),
  baseClient.readContract({ address: BASE_FACTORY, abi: factoryAbi, functionName: "crossChainGovernance" }),
  baseClient.readContract({ address: BASE_FACTORY, abi: factoryAbi, functionName: "msgPriceEnabled" }),
  baseClient.readContract({ address: BASE_FACTORY, abi: factoryAbi, functionName: "msgPriceToken" }),
  baseClient.readContract({ address: BASE_FACTORY, abi: factoryAbi, functionName: "msgPriceAmountInToken" }),
  baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "owner" }),
  baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BASE_FACTORY] }),
  baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
  eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BSC_FACTORY, MESSAGE_FEE_SETTER_SELECTOR] }),
  eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_FACTORY, MESSAGE_FEE_SETTER_SELECTOR] }),
  eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BSC_PROBE, PROBE_MARKER_SELECTOR] }),
  eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_PROBE, PROBE_MARKER_SELECTOR] }),
  eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_EXECUTOR, EXECUTOR_ALLOWLIST_SELECTOR] }),
  eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isActionAllowed", args: [MAJOR, REGISTRY, 0n, setRulesCalldata] }),
  bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BSC_PROBE] }),
  baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BASE_PROBE] }),
]);

const dToken = getAddress(dTokenRaw);
const dcToken = getAddress(dcTokenRaw);
const treasury = getAddress(treasuryRaw);
const minterRole = await eth.readContract({ address: dcToken, abi: tokenAbi, functionName: "MINTER_ROLE" });
const [dBalance, dcBalance, allowance, canMintDc, dcPaused, quotes, currentActionAllowed] = await Promise.all([
  eth.readContract({ address: dToken, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
  eth.readContract({ address: dcToken, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
  eth.readContract({ address: dcToken, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }),
  eth.readContract({ address: dcToken, abi: tokenAbi, functionName: "hasRole", args: [minterRole, OWNER] }),
  eth.readContract({ address: dcToken, abi: tokenAbi, functionName: "paused" }),
  Promise.all(actions.map((action) => eth.readContract({
    address: BROADCASTER,
    abi: broadcasterAbi,
    functionName: "quoteFees",
    args: [
      CHAIN_FEE_CONFIGS.map((chain) => chain.chainKey),
      CHAIN_FEE_CONFIGS.map((chain) => chain.factory),
      action.innerCalldata,
      LZ_GAS,
    ],
  }))),
  Promise.all(actions.map((action) => eth.readContract({
    address: REGISTRY,
    abi: registryAbi,
    functionName: "isActionAllowed",
    args: [MAJOR, BROADCASTER, ACTION_FEE_BUDGET, action.calldata],
  }))),
]);
const [bscAmountSetterProbe, baseAmountSetterProbe] = await Promise.allSettled([
  bscClient.call({ account: BSC_EXECUTOR, to: BSC_FACTORY, data: amountSetterProbeCalldata }),
  baseClient.call({ account: BASE_EXECUTOR, to: BASE_FACTORY, data: amountSetterProbeCalldata }),
]);

const blockers: string[] = [];
if (!same(registryRaw, REGISTRY) || !same(registryGovernance, GOVERNANCE)) blockers.push("governance/registry wiring mismatch");
if (!same(broadcasterGovernance, GOVERNANCE)) blockers.push("broadcaster governance mismatch");
if (!bscRoute[6] || !baseRoute[6] || !chainIds.includes(BSC_CHAIN_KEY) || !chainIds.includes(BASE_CHAIN_KEY)) blockers.push("BSC/Base broadcast route inactive");
if (!same(bscGovernance, BSC_EXECUTOR) || !same(baseGovernance, BASE_EXECUTOR)) blockers.push("destination Factory crossChainGovernance mismatch");
if (bscAmountSetterProbe.status !== "fulfilled" || baseAmountSetterProbe.status !== "fulfilled") blockers.push("governance amount-only setter is not deployed/callable on both destination Factories");
if (!bscAllowed || !baseAllowed || bscThreshold !== 2n || baseThreshold !== 2n) blockers.push("destination Executor is not 2-of-3 ready");
if (!bscEnabled || !baseEnabled || bscPrice !== CURRENT_MESSAGE_FEE || basePrice !== CURRENT_MESSAGE_FEE) blockers.push("live message fee is not exactly 104 DC/enabled on both chains");
if (!same(bscToken, CHAIN_FEE_CONFIGS[0].dc) || !same(baseToken, CHAIN_FEE_CONFIGS[1].dc)) blockers.push("destination message-price token mismatch");
if (majorFee !== MAJOR_PROPOSAL_FEE || !canMintDc || dcPaused) blockers.push("Major proposal fee mint prerequisites failed");
if (!policyActionAllowed) blockers.push("Registry.setRules is not allowed for a Major proposal");
if (latestNonce !== pendingNonce) blockers.push("proposer has a pending Ethereum transaction");
quotes.forEach((quote) => {
  if (quote === 0n || quote > ACTION_FEE_BUDGET) blockers.push("combined BSC+Base live bridge quote exceeds 0.005 ETH budget");
});
if (governanceEthBalance < ACTION_FEE_BUDGET) blockers.push("Governance has less than the future 0.005 ETH execution budget");

const policiesReady = isExactNestedRule(bscRule)
  && isExactNestedRule(baseRule)
  && isEmptyRule(bscProbeRule)
  && isEmptyRule(baseProbeRule)
  && isExactNestedRule(baseExecutorRule);
const policyPrerequisiteReady = isEmptyRule(bscRule)
  && isEmptyRule(baseRule)
  && isExactNestedRule(bscProbeRule)
  && isExactNestedRule(baseProbeRule)
  && isEmptyRule(baseExecutorRule);
if (!policiesReady && !policyPrerequisiteReady) blockers.push("Probe/message-fee/Base-cleanup policy is in a partial or unexpected state");
if (policiesReady && currentActionAllowed.some((allowed) => !allowed)) blockers.push("exact canary action is blocked despite installed policy");
if (policyPrerequisiteReady && currentActionAllowed.some(Boolean)) blockers.push("exact canary action is unexpectedly allowed before policy");

console.log(stringify({
  status: blockers.length > 0
    ? "BLOCKED"
    : policiesReady ? "PASS_READY_FOR_CANARY" : "PASS_WITH_POLICY_PREREQUISITE",
  readOnly: true,
  transactionSent: false,
  blockNumbers: {
    ethereum: await eth.getBlockNumber(),
    bsc: await bscClient.getBlockNumber(),
    base: await baseClient.getBlockNumber(),
  },
  proposalCount,
  expectedNextProposalId: proposalCount + 1n,
  proposer: { address: OWNER, dBalance, dcBalance, allowance, canMintDc, dcPaused, latestNonce, pendingNonce },
  governance: { address: GOVERNANCE, treasury, majorFee, nativeBalance: governanceEthBalance, nativeBalanceEth: formatEther(governanceEthBalance) },
  policyProposal: {
    description: POLICY_DESCRIPTION,
    target: REGISTRY,
    value: 0n,
    setRulesCalldata,
    createProposalCalldata: policyProposalCalldata,
    actionAllowedNow: policyActionAllowed,
  },
  canaryProposal: {
    description: CANARY_DESCRIPTION,
    currentPrice: CURRENT_MESSAGE_FEE,
    targetPrice: CANARY_MESSAGE_FEE,
    actionFeeBudget: ACTION_FEE_BUDGET,
    totalExecutionBudget: ACTION_FEE_BUDGET,
    quotes,
    actions,
    createProposalCalldata: canaryProposalCalldata,
    exactActionsAllowedNow: currentActionAllowed,
  },
  restoreProposal: {
    description: RESTORE_DESCRIPTION,
    targetPrice: CURRENT_MESSAGE_FEE,
    actions: restoreActions,
    createProposalCalldata: restoreProposalCalldata,
    deliberatelySeparateFromCanary: true,
  },
  bsc: { owner: bscOwner, admin: bscAdmin, factory: BSC_FACTORY, executor: BSC_EXECUTOR, executorOwner: bscExecutorOwner, allowed: bscAllowed, probe: BSC_PROBE, probeAllowed: bscProbeAllowed, threshold: bscThreshold, enabled: bscEnabled, token: bscToken, price: bscPrice, amountSetterCallableByExecutor: bscAmountSetterProbe.status === "fulfilled", routeActive: bscRoute[6], feeRule: ruleJson(bscRule), probeRule: ruleJson(bscProbeRule) },
  base: { owner: baseOwner, admin: baseAdmin, factory: BASE_FACTORY, executor: BASE_EXECUTOR, executorOwner: baseExecutorOwner, allowed: baseAllowed, probe: BASE_PROBE, probeAllowed: baseProbeAllowed, threshold: baseThreshold, enabled: baseEnabled, token: baseToken, price: basePrice, amountSetterCallableByExecutor: baseAmountSetterProbe.status === "fulfilled", routeActive: baseRoute[6], feeRule: ruleJson(baseRule), probeRule: ruleJson(baseProbeRule), executorCleanupRule: ruleJson(baseExecutorRule) },
  blockers,
}));
