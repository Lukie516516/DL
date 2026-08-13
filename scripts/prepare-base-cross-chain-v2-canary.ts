/**
 * Read-only planner for the first ETH -> Base production CrossChain V2 canary.
 *
 * It never loads a private key and has no transaction-writing branch.
 *
 * Usage:
 *   node --import tsx/esm scripts/prepare-base-cross-chain-v2-canary.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  createPublicClient,
  encodeFunctionData,
  fallback,
  getAddress,
  http,
  keccak256,
  padHex,
  parseAbi,
  parseEther,
  stringToHex,
  toFunctionSelector,
  type Address,
} from "viem";
import { base, bsc, mainnet } from "viem/chains";

const OUTPUT_FILE = "deployments/base-cross-chain-v2-canary-plan.json";
const STAGE1_FILE = "deployments/base-cross-chain-v2-stage1.json";

const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const GOVERNANCE = getAddress("0x9a41a9A85C16F590789C846Fb933fF8C715407F7");
const REGISTRY = getAddress("0xBFF01F91291476e671f0F310846D5dDb460e2382");
const BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const BSC_EXECUTOR = getAddress("0x407381d841DD48bBBd40Bd37f9dB268CE75950A8");
const BSC_PROBE = getAddress("0xd31C6417aE0C267F8C5bd634B96dA7590E6E6aB3");
const BSC_CHAIN_KEY = 30_102;
const BASE_CHAIN_KEY = 30_184;
const MAJOR = 2;
const LZ_GAS = 500_000n;
const FEE_BUDGET = parseEther("0.005");
const RECORD_MARKER_SELECTOR = toFunctionSelector("recordMarker(bytes32)");
const MARKER = keccak256(stringToHex("BASE_CROSS_CHAIN_V2_CANARY_20260807"));
const POLICY_DESCRIPTION =
  "Base跨链测试授权\n\n仅为BSC和Base无资产测试合约开放测试标记权限，不涉及代币、国库、分红或业务合约。";
const CANARY_DESCRIPTION =
  "Base跨链测试\n\n向BSC和Base无资产测试合约写入同一测试标记，只验证跨链链路，不影响业务。";

type Stage1 = {
  chainId: number;
  stage: string;
  executor: Address;
  probeImplementation: Address;
  probe: Address;
};
type Rule = readonly [boolean, boolean, boolean, bigint] & {
  allowed?: boolean;
  validateNestedBroadcast?: boolean;
  nestedOnly?: boolean;
  maxValue?: bigint;
};

const broadcasterAbi = parseAbi([
  "function owner() view returns (address)",
  "function governance() view returns (address)",
  "function broadcastNonce() view returns (uint256)",
  "function getChainIds() view returns (uint32[])",
  "function chains(uint32) view returns (uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
  "function peers(uint32) view returns (bytes32)",
  "function quoteFees(uint32[],address[],bytes,uint128) view returns (uint256)",
  "function setChainActive(uint32,bool)",
  "function broadcast(uint32[],address[],bytes,uint128) payable",
]);
const executorAbi = parseAbi([
  "function owner() view returns (address)",
  "function threshold() view returns (uint256)",
  "function peers(uint32) view returns (bytes32)",
  "function allowedTargets(address) view returns (bool)",
  "function setAllowedTarget(address,bool)",
]);
const probeAbi = parseAbi([
  "function controller() view returns (address)",
  "function version() view returns (uint256)",
  "function marker() view returns (bytes32)",
  "function updateCount() view returns (uint256)",
  "function recordMarker(bytes32)",
]);
const registryAbi = parseAbi([
  "function governance() view returns (address)",
  "function getRule(uint8,address,bytes4) view returns (bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)",
  "function isActionAllowed(uint8,address,uint256,bytes) view returns (bool)",
  "function setRules((uint8 kind,address target,bytes4 selector,bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)[])",
]);
const governanceAbi = parseAbi([
  "function dcToken() view returns (address)",
  "function policyRegistry() view returns (address)",
  "function majorProposalFee() view returns (uint256)",
  "function proposalCount() view returns (uint256)",
  "function createProposal(address[],uint256[],bytes[],string,uint8) returns (uint256)",
]);
const tokenAbi = parseAbi([
  "function MINTER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function paused() view returns (bool)",
]);

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
function same(a: unknown, b: unknown) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}
function exactRule(rule: Rule, nestedOnly: boolean) {
  return Boolean(rule.allowed ?? rule[0])
    && !(rule.validateNestedBroadcast ?? rule[1])
    && Boolean(rule.nestedOnly ?? rule[2]) === nestedOnly
    && BigInt(rule.maxValue ?? rule[3]) === 0n;
}
function ruleJson(rule: Rule) {
  return {
    allowed: Boolean(rule.allowed ?? rule[0]),
    validateNestedBroadcast: Boolean(rule.validateNestedBroadcast ?? rule[1]),
    nestedOnly: Boolean(rule.nestedOnly ?? rule[2]),
    maxValue: BigInt(rule.maxValue ?? rule[3]).toString(),
  };
}
function stringify(value: unknown) {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

async function main() {
  loadEnv();
  const stage1 = JSON.parse(readFileSync(STAGE1_FILE, "utf8")) as Stage1;
  if (stage1.chainId !== 8453 || stage1.stage !== "configured") {
    throw new Error("Base CrossChain V2 stage 1 is incomplete");
  }
  const baseExecutor = getAddress(stage1.executor);
  const baseProbe = getAddress(stage1.probe);
  const ethClient: any = createPublicClient({
    chain: mainnet,
    transport: http(required("ETH_MAINNET_RPC_URL"), { timeout: 30_000 }),
  });
  const bscClient: any = createPublicClient({
    chain: bsc,
    transport: fallback([
      http(process.env.BSC_MAINNET_RPC_URL?.trim() || "https://bsc-rpc.publicnode.com"),
      http("https://bsc-dataseed.binance.org"),
    ], { rank: false }),
  });
  const baseClient: any = createPublicClient({
    chain: base,
    transport: fallback([
      http(process.env.BASE_MAINNET_RPC_URL?.trim() || "https://mainnet.base.org"),
      http("https://base-mainnet.public.blastapi.io"),
    ], { rank: false }),
  });
  if (await ethClient.getChainId() !== 1 || await bscClient.getChainId() !== 56 || await baseClient.getChainId() !== 8453) {
    throw new Error("RPC chain mismatch");
  }

  const markerData = encodeFunctionData({
    abi: probeAbi,
    functionName: "recordMarker",
    args: [MARKER],
  });
  const rules = [BSC_PROBE, baseProbe].map((target) => ({
    kind: MAJOR,
    target,
    selector: RECORD_MARKER_SELECTOR,
    allowed: true,
    validateNestedBroadcast: false,
    nestedOnly: true,
    maxValue: 0n,
  }));
  const setRulesCalldata = encodeFunctionData({
    abi: registryAbi,
    functionName: "setRules",
    args: [rules],
  });
  const policyProposalCalldata = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [[REGISTRY], [0n], [setRulesCalldata], POLICY_DESCRIPTION, MAJOR],
  });
  const broadcastCalldata = encodeFunctionData({
    abi: broadcasterAbi,
    functionName: "broadcast",
    args: [
      [BSC_CHAIN_KEY, BASE_CHAIN_KEY],
      [BSC_PROBE, baseProbe],
      markerData,
      LZ_GAS,
    ],
  });
  const canaryProposalCalldata = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [[BROADCASTER], [FEE_BUDGET], [broadcastCalldata], CANARY_DESCRIPTION, MAJOR],
  });

  const minterRole = await ethClient.readContract({ address: await ethClient.readContract({
    address: GOVERNANCE, abi: governanceAbi, functionName: "dcToken",
  }), abi: tokenAbi, functionName: "MINTER_ROLE" });
  const dc = getAddress(await ethClient.readContract({
    address: GOVERNANCE, abi: governanceAbi, functionName: "dcToken",
  }));
  const [
    ethBlock, bscBlock, baseBlock, owner, broadcasterGovernance, registryGovernance,
    governanceRegistry, chainIds, bscRoute, baseRoute, basePeer, broadcastNonce,
    majorProposalFee, proposalCount, canMint, dcPaused, registryActionAllowed,
    bscRule, baseRule, broadcasterRule, currentCanaryAllowed, bscAllowed, baseAllowed,
    bscThreshold, baseThreshold, bscController, baseController, bscVersion, baseVersion,
    bscMarker, baseMarker, bscUpdateCount, baseUpdateCount, baseExecutorOwner,
  ] = await Promise.all([
    ethClient.getBlockNumber(), bscClient.getBlockNumber(), baseClient.getBlockNumber(),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "owner" }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "governance" }),
    ethClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "governance" }),
    ethClient.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "policyRegistry" }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "getChainIds" }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BSC_CHAIN_KEY] }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "peers", args: [BASE_CHAIN_KEY] }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    ethClient.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "majorProposalFee" }),
    ethClient.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }),
    ethClient.readContract({ address: dc, abi: tokenAbi, functionName: "hasRole", args: [minterRole, OWNER] }),
    ethClient.readContract({ address: dc, abi: tokenAbi, functionName: "paused" }),
    ethClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isActionAllowed", args: [MAJOR, REGISTRY, 0n, setRulesCalldata] }),
    ethClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BSC_PROBE, RECORD_MARKER_SELECTOR] }),
    ethClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, baseProbe, RECORD_MARKER_SELECTOR] }),
    ethClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BROADCASTER, toFunctionSelector("broadcast(uint32[],address[],bytes,uint128)")] }),
    ethClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isActionAllowed", args: [MAJOR, BROADCASTER, FEE_BUDGET, broadcastCalldata] }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BSC_PROBE] }),
    baseClient.readContract({ address: baseExecutor, abi: executorAbi, functionName: "allowedTargets", args: [baseProbe] }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
    baseClient.readContract({ address: baseExecutor, abi: executorAbi, functionName: "threshold" }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "controller" }),
    baseClient.readContract({ address: baseProbe, abi: probeAbi, functionName: "controller" }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "version" }),
    baseClient.readContract({ address: baseProbe, abi: probeAbi, functionName: "version" }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "marker" }),
    baseClient.readContract({ address: baseProbe, abi: probeAbi, functionName: "marker" }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "updateCount" }),
    baseClient.readContract({ address: baseProbe, abi: probeAbi, functionName: "updateCount" }),
    baseClient.readContract({ address: baseExecutor, abi: executorAbi, functionName: "owner" }),
  ]) as any[];

  const authorityHealthy = same(owner, OWNER)
    && same(broadcasterGovernance, GOVERNANCE)
    && same(registryGovernance, GOVERNANCE)
    && same(governanceRegistry, REGISTRY);
  const routeHealthy = chainIds.includes(BSC_CHAIN_KEY)
    && chainIds.includes(BASE_CHAIN_KEY)
    && bscRoute[6] === true
    && baseRoute[0] === BASE_CHAIN_KEY
    && same(baseRoute[2], baseExecutor)
    && same(basePeer, padHex(baseExecutor, { size: 32 }));
  const destinationHealthy = bscThreshold === 2n
    && baseThreshold === 2n
    && same(bscController, BSC_EXECUTOR)
    && same(baseController, baseExecutor)
    && same(baseExecutorOwner, OWNER)
    && baseAllowed === true;
  const policyProposalBlockers: string[] = [];
  if (!authorityHealthy) policyProposalBlockers.push("authority wiring mismatch");
  if (!routeHealthy) policyProposalBlockers.push("Broadcaster route/peer mismatch");
  if (!destinationHealthy) policyProposalBlockers.push("destination Executor/Probe wiring mismatch");
  if (!registryActionAllowed) policyProposalBlockers.push("Registry rejects the exact two-rule setRules action");
  if (!canMint || dcPaused) policyProposalBlockers.push("exact Major proposal fee cannot be minted");
  if (majorProposalFee !== parseEther("1000")) policyProposalBlockers.push("unexpected Major proposal fee");

  let bscOnlyQuote = 0n;
  try {
    bscOnlyQuote = await ethClient.readContract({
      address: BROADCASTER,
      abi: broadcasterAbi,
      functionName: "quoteFees",
      args: [[BSC_CHAIN_KEY], [BSC_PROBE], markerData, LZ_GAS],
    });
  } catch {}

  const prerequisites = [
    ...(exactRule(bscRule as Rule, true) ? [] : ["execute Major nested recordMarker policy for BSC Probe"]),
    ...(exactRule(baseRule as Rule, true) ? [] : ["execute Major nested recordMarker policy for Base Probe"]),
    ...(bscAllowed ? [] : ["BSC Executor allowlist the asset-free BSC Probe"]),
    ...(baseRoute[6] ? [] : ["activate Base route only after policy execution"]),
    "after activation, re-read the combined BSC + Base live quote and require it <= 0.005 ETH",
  ];

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    transactionSent: false,
    scope: "first ETH -> BSC + Base CrossChain V2 zero-asset canary",
    snapshots: { ethBlock, bscBlock, baseBlock },
    addresses: {
      governance: GOVERNANCE, registry: REGISTRY, broadcaster: BROADCASTER, dc,
      bscExecutor: BSC_EXECUTOR, bscProbe: BSC_PROBE, baseExecutor, baseProbe,
      baseProbeImplementation: stage1.probeImplementation,
    },
    currentState: {
      authorityHealthy,
      routeHealthy,
      destinationHealthy,
      chainIds,
      bscActive: bscRoute[6],
      baseActive: baseRoute[6],
      bscProbeAllowed: bscAllowed,
      baseProbeAllowed: baseAllowed,
      bscProbe: { version: bscVersion, marker: bscMarker, updateCount: bscUpdateCount },
      baseProbe: { version: baseVersion, marker: baseMarker, updateCount: baseUpdateCount },
      broadcastNonce,
      proposalCount,
      expectedPolicyProposalId: proposalCount + 1n,
      majorProposalFee,
      ownerCanMintDc: canMint,
      dcPaused,
      bscOnlyLiveQuoteWei: bscOnlyQuote,
    },
    policy: {
      bscCurrent: ruleJson(bscRule as Rule),
      baseCurrent: ruleJson(baseRule as Rule),
      broadcasterCurrent: ruleJson(broadcasterRule as Rule),
      exactRules: rules,
      setRulesCalldata,
      actionAllowedNow: registryActionAllowed,
      description: POLICY_DESCRIPTION,
      createProposalCalldata: policyProposalCalldata,
      canCreatePolicyProposal: policyProposalBlockers.length === 0,
      blockers: policyProposalBlockers,
    },
    canary: {
      marker: MARKER,
      markerCalldata: markerData,
      description: CANARY_DESCRIPTION,
      targetChainKeys: [BSC_CHAIN_KEY, BASE_CHAIN_KEY],
      targets: [BSC_PROBE, baseProbe],
      lzGas: LZ_GAS,
      feeBudgetWei: FEE_BUDGET,
      broadcastCalldata,
      createProposalCalldata: canaryProposalCalldata,
      actionAllowedBeforePolicy: currentCanaryAllowed,
      prerequisites,
      businessEffect: "only two asset-free GovernanceProbe markers change after 2-of-3 confirmation",
    },
    excluded: [
      "no production Factory/Treasury/DC authority handoff",
      "no bootstrap lock",
      "no token transfer, mint to users, pool initialization, upgrade, commit or push",
    ],
  };
  writeFileSync(OUTPUT_FILE, `${stringify(output)}\n`, "utf8");
  process.stdout.write(`${stringify(output)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
