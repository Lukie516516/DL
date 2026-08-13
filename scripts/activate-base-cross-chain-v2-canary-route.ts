/**
 * Prepare the live BSC + Base V2 canary route after policy proposal 20 has
 * executed. The only writes are:
 *   1. BSC Executor.setAllowedTarget(asset-free BSC Probe, true)
 *   2. ETH Broadcaster.setChainActive(Base, true)
 *
 * No proposal, stake, execution, broadcast, token, treasury, pool, or Base
 * business authority write exists in this script.
 *
 * Read-only:
 *   node --import tsx/esm scripts/activate-base-cross-chain-v2-canary-route.ts preflight
 *
 * Explicit write gate:
 *   BASE_CROSS_CHAIN_V2_ACTIVATION_CONFIRM=ENABLE_BSC_PROBE_AND_ACTIVATE_BASE_ROUTE \
 *     node --import tsx/esm scripts/activate-base-cross-chain-v2-canary-route.ts execute
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  fallback,
  formatEther,
  getAddress,
  http,
  padHex,
  parseAbi,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, bsc, mainnet } from "viem/chains";

const PLAN_FILE = "deployments/base-cross-chain-v2-canary-plan.json";
const POLICY_FILE = "deployments/base-cross-chain-v2-policy-proposal.json";
const STATE_FILE = "deployments/base-cross-chain-v2-canary-route-activation.json";
const CONFIRM = "ENABLE_BSC_PROBE_AND_ACTIVATE_BASE_ROUTE";

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
const ETH_LZ_EID = 30_101;
const BASE_CCIP_SELECTOR = 15_971_525_489_660_198_786n;
const MAJOR = 2;
const POLICY_PROPOSAL_ID = 20n;
const FEE_BUDGET = parseEther("0.005");
const SELECTOR = toFunctionSelector("recordMarker(bytes32)");
const ZERO_MARKER = `0x${"00".repeat(32)}` as Hex;

const governanceAbi = parseAbi([
  "function state(uint256) view returns (uint8)",
  "function getProposal(uint256) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description))",
  "function getActions(uint256) view returns (address[] targets,uint256[] values,bytes[] calldatas)",
]);
const registryAbi = parseAbi([
  "function getRule(uint8,address,bytes4) view returns (bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)",
  "function isActionAllowed(uint8,address,uint256,bytes) view returns (bool)",
]);
const broadcasterAbi = parseAbi([
  "function owner() view returns (address)",
  "function governance() view returns (address)",
  "function getChainIds() view returns (uint32[])",
  "function chains(uint32) view returns (uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
  "function peers(uint32) view returns (bytes32)",
  "function broadcastNonce() view returns (uint256)",
  "function quoteFees(uint32[],address[],bytes,uint128) view returns (uint256)",
  "function setChainActive(uint32,bool)",
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
]);

type Plan = {
  addresses: Record<string, string>;
  policy: { setRulesCalldata: Hex };
  canary: {
    markerCalldata: Hex;
    broadcastCalldata: Hex;
    targetChainKeys: number[];
    targets: Address[];
    lzGas: string;
    feeBudgetWei: string;
  };
};
type PolicyState = {
  proposalId: string;
  description: string;
  setRulesCalldata: Hex;
};
type TxRecord = {
  chainId: number;
  hash: Hex;
  nonce: number;
  blockNumber: string;
  gasUsed: string;
  verified: true;
};
type State = {
  schemaVersion: 1;
  scope: string;
  stage: "started" | "bsc-probe-enabled" | "base-route-active" | "ready";
  startedAt: string;
  updatedAt: string;
  owner: Address;
  bscExecutor: Address;
  bscProbe: Address;
  broadcaster: Address;
  baseExecutor: Address;
  baseProbe: Address;
  broadcastNonceBefore: string;
  bscMarkerBefore: Hex;
  bscUpdateCountBefore: string;
  baseMarkerBefore: Hex;
  baseUpdateCountBefore: string;
  bscRouteBefore: string;
  transactions: { bscAllowlist?: TxRecord; baseActivation?: TxRecord };
  verification?: Record<string, unknown>;
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
function routeFingerprint(route: readonly unknown[]) {
  return stringify(route);
}
function nestedRule(rule: any) {
  return (rule.allowed ?? rule[0]) === true
    && (rule.validateNestedBroadcast ?? rule[1]) === false
    && (rule.nestedOnly ?? rule[2]) === true
    && BigInt(rule.maxValue ?? rule[3]) === 0n;
}
async function nonceState(client: any, chainLabel: string) {
  const [latest, pending] = await Promise.all([
    client.getTransactionCount({ address: OWNER, blockTag: "latest" }),
    client.getTransactionCount({ address: OWNER, blockTag: "pending" }),
  ]);
  assertThat(latest === pending, `${chainLabel} signer has a pending transaction`);
  return Number(pending);
}
async function waitAndVerify(
  client: any,
  chainId: number,
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
    chainId,
    hash,
    nonce: tx.nonce,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    verified: true,
  };
}

async function main() {
  loadEnv();
  const mode = process.argv[2] || "preflight";
  assertThat(mode === "preflight" || mode === "execute", "mode must be preflight or execute");
  const plan = JSON.parse(readFileSync(PLAN_FILE, "utf8")) as Plan;
  const policy = JSON.parse(readFileSync(POLICY_FILE, "utf8")) as PolicyState;
  assertThat(policy.proposalId === POLICY_PROPOSAL_ID.toString(), "policy proposal id mismatch");
  assertThat(same(policy.setRulesCalldata, plan.policy.setRulesCalldata), "policy calldata mismatch");
  assertThat(same(plan.addresses.bscExecutor, BSC_EXECUTOR), "plan BSC Executor mismatch");
  assertThat(same(plan.addresses.bscProbe, BSC_PROBE), "plan BSC Probe mismatch");
  assertThat(same(plan.addresses.baseExecutor, BASE_EXECUTOR), "plan Base Executor mismatch");
  assertThat(same(plan.addresses.baseProbe, BASE_PROBE), "plan Base Probe mismatch");
  assertThat(BigInt(plan.canary.feeBudgetWei) === FEE_BUDGET, "canary fee budget mismatch");
  assertThat(plan.canary.targetChainKeys.join(",") === `${BSC_CHAIN_KEY},${BASE_CHAIN_KEY}`, "canary chain keys mismatch");
  assertThat(same(plan.canary.targets[0], BSC_PROBE) && same(plan.canary.targets[1], BASE_PROBE), "canary targets mismatch");

  const ethRpc = required("ETH_MAINNET_RPC_URL");
  const bscRpc = process.env.BSC_MAINNET_RPC_URL?.trim() || "https://bsc-mainnet.public.blastapi.io";
  const baseRpc = process.env.BASE_MAINNET_RPC_URL?.trim() || "https://base-mainnet.public.blastapi.io";
  const ethClient: any = createPublicClient({ chain: mainnet, transport: http(ethRpc, { timeout: 30_000 }) });
  const bscClient: any = createPublicClient({
    chain: bsc,
    transport: fallback([http(bscRpc, { timeout: 30_000 }), http("https://bsc-dataseed.binance.org", { timeout: 30_000 })], { rank: false }),
  });
  const baseClient: any = createPublicClient({
    chain: base,
    transport: fallback([http(baseRpc, { timeout: 30_000 }), http("https://mainnet.base.org", { timeout: 30_000 })], { rank: false }),
  });
  assertThat(await ethClient.getChainId() === 1 && await bscClient.getChainId() === 56 && await baseClient.getChainId() === 8453, "RPC chain mismatch");

  const [
    proposalState, proposal, actions, bscRule, baseRule, canaryPolicyAllowed,
    broadcasterOwner, broadcasterGovernance, chainIds, bscRoute, baseRoute,
    basePeer, broadcastNonce, bscOwner, bscThreshold, bscAllowed,
    bscController, bscVersion, bscMarker, bscUpdateCount, baseOwner,
    baseThreshold, baseAllowed, baseController, baseVersion, baseMarker,
    baseUpdateCount, baseEthPeer, ethNonce, bscNonce, ethBalance, bscBalance,
  ] = await Promise.all([
    ethClient.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [POLICY_PROPOSAL_ID] }),
    ethClient.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [POLICY_PROPOSAL_ID] }),
    ethClient.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [POLICY_PROPOSAL_ID] }),
    ethClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BSC_PROBE, SELECTOR] }),
    ethClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_PROBE, SELECTOR] }),
    ethClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isActionAllowed", args: [MAJOR, BROADCASTER, FEE_BUDGET, plan.canary.broadcastCalldata] }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "owner" }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "governance" }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "getChainIds" }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BSC_CHAIN_KEY] }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "peers", args: [BASE_CHAIN_KEY] }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "owner" }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BSC_PROBE] }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "controller" }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "version" }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "marker" }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "updateCount" }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "owner" }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BASE_PROBE] }),
    baseClient.readContract({ address: BASE_PROBE, abi: probeAbi, functionName: "controller" }),
    baseClient.readContract({ address: BASE_PROBE, abi: probeAbi, functionName: "version" }),
    baseClient.readContract({ address: BASE_PROBE, abi: probeAbi, functionName: "marker" }),
    baseClient.readContract({ address: BASE_PROBE, abi: probeAbi, functionName: "updateCount" }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "peers", args: [ETH_LZ_EID] }),
    nonceState(ethClient, "Ethereum"),
    nonceState(bscClient, "BSC"),
    ethClient.getBalance({ address: OWNER }),
    bscClient.getBalance({ address: OWNER }),
  ]);
  assertThat(proposalState === 6 && proposal.executed && proposal.totalStaked === parseEther("70"), "proposal 20 is not exactly executed with 70 D");
  assertThat(actions[0].length === 1 && same(actions[0][0], REGISTRY) && actions[1][0] === 0n && same(actions[2][0], policy.setRulesCalldata), "proposal 20 actions mismatch");
  assertThat(nestedRule(bscRule) && nestedRule(baseRule) && canaryPolicyAllowed, "exact canary policy is not active");
  assertThat(same(broadcasterOwner, OWNER) && same(broadcasterGovernance, GOVERNANCE), "Broadcaster authority mismatch");
  assertThat(chainIds.join(",") === `${BSC_CHAIN_KEY},${BASE_CHAIN_KEY}`, "Broadcaster chain list mismatch");
  assertThat(bscRoute[6] === true, "BSC route is not active");
  assertThat(baseRoute[0] === BASE_CHAIN_KEY && baseRoute[1] === BASE_CCIP_SELECTOR && same(baseRoute[2], BASE_EXECUTOR) && baseRoute[3] === "base" && String(baseRoute[4]).toLowerCase() === BASE_EXECUTOR.toLowerCase() && baseRoute[5] === parseEther("0.001"), "Base route fields mismatch");
  assertThat(same(basePeer, padHex(BASE_EXECUTOR, { size: 32 })), "ETH Base peer mismatch");
  assertThat(same(bscOwner, OWNER) && bscThreshold === 2n && same(bscController, BSC_EXECUTOR) && bscVersion === 2n, "BSC Executor/Probe mismatch");
  assertThat(same(baseOwner, OWNER) && baseThreshold === 2n && baseAllowed && same(baseController, BASE_EXECUTOR) && baseVersion === 1n, "Base Executor/Probe mismatch");
  assertThat(same(baseEthPeer, padHex(BROADCASTER, { size: 32 })), "Base Ethereum peer mismatch");
  assertThat(bscMarker === ZERO_MARKER && bscUpdateCount === 0n && baseMarker === ZERO_MARKER && baseUpdateCount === 0n, "Probe state is not pristine");
  assertThat(ethBalance >= parseEther("0.001") && bscBalance > 0n, "owner gas balance too low");

  const bscAllowCalldata = encodeFunctionData({ abi: executorAbi, functionName: "setAllowedTarget", args: [BSC_PROBE, true] });
  const baseActivateCalldata = encodeFunctionData({ abi: broadcasterAbi, functionName: "setChainActive", args: [BASE_CHAIN_KEY, true] });
  if (!bscAllowed) {
    await bscClient.simulateContract({ account: OWNER, address: BSC_EXECUTOR, abi: executorAbi, functionName: "setAllowedTarget", args: [BSC_PROBE, true] });
  }
  if (!baseRoute[6]) {
    await ethClient.simulateContract({ account: OWNER, address: BROADCASTER, abi: broadcasterAbi, functionName: "setChainActive", args: [BASE_CHAIN_KEY, true] });
  }
  const preflight = {
    status: "PASS",
    mode,
    blocks: { eth: (await ethClient.getBlockNumber()).toString(), bsc: (await bscClient.getBlockNumber()).toString(), base: (await baseClient.getBlockNumber()).toString() },
    nonces: { eth: ethNonce, bsc: bscNonce },
    balances: { eth: formatEther(ethBalance), bnb: formatEther(bscBalance) },
    proposal20: { state: proposalState, totalStaked: proposal.totalStaked, executed: proposal.executed },
    policy: { bscNestedOnly: true, baseNestedOnly: true, exactBroadcastAllowed: canaryPolicyAllowed },
    current: { bscProbeAllowed: bscAllowed, baseRouteActive: baseRoute[6], broadcastNonce },
    plannedWrites: [
      ...(bscAllowed ? [] : [{ chainId: 56, target: BSC_EXECUTOR, calldata: bscAllowCalldata }]),
      ...(baseRoute[6] ? [] : [{ chainId: 1, target: BROADCASTER, calldata: baseActivateCalldata }]),
    ],
  };
  console.log(stringify(preflight));
  if (mode === "preflight") return;

  assertThat(process.env.BASE_CROSS_CHAIN_V2_ACTIVATION_CONFIRM === CONFIRM, "write gate is closed");
  const account = privateKeyToAccount(signerKey());
  assertThat(same(account.address, OWNER), `signer mismatch: ${account.address}`);
  const ethWallet: any = createWalletClient({ account, chain: mainnet, transport: http(ethRpc, { timeout: 30_000 }) });
  const bscWallet: any = createWalletClient({ account, chain: bsc, transport: http(bscRpc, { timeout: 30_000 }) });
  let state: State;
  if (existsSync(STATE_FILE)) {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    assertThat(same(state.owner, OWNER) && same(state.bscProbe, BSC_PROBE) && same(state.baseProbe, BASE_PROBE), "existing activation state mismatch");
  } else {
    assertThat(!bscAllowed && !baseRoute[6], "fresh activation must start with BSC disabled and Base inactive");
    state = {
      schemaVersion: 1,
      scope: "enable only BSC asset-free Probe and activate only the registered Base route",
      stage: "started",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      owner: OWNER,
      bscExecutor: BSC_EXECUTOR,
      bscProbe: BSC_PROBE,
      broadcaster: BROADCASTER,
      baseExecutor: BASE_EXECUTOR,
      baseProbe: BASE_PROBE,
      broadcastNonceBefore: broadcastNonce.toString(),
      bscMarkerBefore: bscMarker,
      bscUpdateCountBefore: bscUpdateCount.toString(),
      baseMarkerBefore: baseMarker,
      baseUpdateCountBefore: baseUpdateCount.toString(),
      bscRouteBefore: routeFingerprint(bscRoute),
      transactions: {},
    };
    save(state);
  }

  if (!state.transactions.bscAllowlist) {
    const hash = await bscWallet.writeContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "setAllowedTarget", args: [BSC_PROBE, true] });
    state.transactions.bscAllowlist = await waitAndVerify(bscClient, 56, hash, BSC_EXECUTOR, bscAllowCalldata);
    state.stage = "bsc-probe-enabled";
    save(state);
  }
  assertThat(await bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BSC_PROBE] }) === true, "BSC Probe allowlist write failed");

  if (!state.transactions.baseActivation) {
    const hash = await ethWallet.writeContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "setChainActive", args: [BASE_CHAIN_KEY, true] });
    state.transactions.baseActivation = await waitAndVerify(ethClient, 1, hash, BROADCASTER, baseActivateCalldata);
    state.stage = "base-route-active";
    save(state);
  }

  const [bscAllowedAfter, baseRouteAfter, bscRouteAfter, nonceAfter, bscMarkerAfter, bscCountAfter, baseMarkerAfter, baseCountAfter, combinedQuote] = await Promise.all([
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BSC_PROBE] }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BSC_CHAIN_KEY] }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "marker" }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "updateCount" }),
    baseClient.readContract({ address: BASE_PROBE, abi: probeAbi, functionName: "marker" }),
    baseClient.readContract({ address: BASE_PROBE, abi: probeAbi, functionName: "updateCount" }),
    ethClient.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "quoteFees", args: [plan.canary.targetChainKeys, plan.canary.targets, plan.canary.markerCalldata, BigInt(plan.canary.lzGas)] }),
  ]);
  assertThat(bscAllowedAfter && baseRouteAfter[6] === true, "activation state mismatch");
  assertThat(routeFingerprint(bscRouteAfter) === state.bscRouteBefore, "BSC route changed");
  assertThat(nonceAfter === BigInt(state.broadcastNonceBefore), "broadcast nonce changed");
  assertThat(bscMarkerAfter === state.bscMarkerBefore && bscCountAfter.toString() === state.bscUpdateCountBefore, "BSC Probe was called");
  assertThat(baseMarkerAfter === state.baseMarkerBefore && baseCountAfter.toString() === state.baseUpdateCountBefore, "Base Probe was called");
  assertThat(combinedQuote > 0n && combinedQuote <= FEE_BUDGET, `combined quote ${combinedQuote} exceeds ${FEE_BUDGET}`);
  state.stage = "ready";
  state.verification = {
    bscProbeAllowed: bscAllowedAfter,
    baseRouteActive: baseRouteAfter[6],
    bscRoutePreserved: true,
    broadcastNonce: nonceAfter.toString(),
    probeStatePreserved: true,
    combinedQuoteWei: combinedQuote.toString(),
    feeBudgetWei: FEE_BUDGET.toString(),
    noBroadcastSent: true,
  };
  save(state);
  console.log(stringify({ status: "PASS", stateFile: STATE_FILE, transactions: state.transactions, verification: state.verification }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
