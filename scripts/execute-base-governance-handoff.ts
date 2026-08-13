/**
 * Base production authority handoff. Read-only by default.
 *
 * Irreversible write gate:
 *   BASE_MAINNET_GOVERNANCE_HANDOFF=I_UNDERSTAND_THIS_IS_IRREVERSIBLE
 *
 * The executor is intentionally made self-owned in the final action. Every
 * action has a live-state predicate so interrupted runs can resume safely.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  fallback,
  formatEther,
  getAddress,
  http,
  padHex,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import {
  BASE_GOVERNANCE_ADDRESS_KEYS,
  DC_DEFAULT_ADMIN_ROLE,
  DC_MINTER_ROLE,
  DC_PAUSER_ROLE,
  ETH_LAYERZERO_EID,
  baseGovernanceTargets,
  buildBaseGovernanceHandoffPlan,
} from "./lib/base-governance-plan.js";
import {
  BASE_LEGACY_POOL_PLANS,
  BASE_REAL_OTHER_SMALLEST_UNIT,
  BASE_TOTAL_INITIAL_DC,
  BASE_TREASURY_INITIAL_DC,
} from "./lib/base-launch-economics.js";

const DEPLOYMENT_FILE = process.env.BASE_DEPLOYMENT_FILE?.trim()
  || join("deployments", "base-mainnet-8453.json");
const EXECUTION_FILE = process.env.BASE_GOVERNANCE_HANDOFF_EXECUTION_FILE?.trim()
  || join("deployments", "base-governance-handoff-execution.json");
const WRITE_CONFIRMATION = "I_UNDERSTAND_THIS_IS_IRREVERSIBLE";
const CURRENT_ETH_BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");

type Deployment = {
  chainId: number;
  network: string;
  deployer: Address;
  rpcUrl?: string;
  addresses: Record<string, Address>;
  params?: Record<string, any>;
};

type TransactionRecord = {
  index: number;
  phase: string;
  label: string;
  target: Address;
  hash: Hex;
  blockNumber: string;
  gasUsed: string;
};

const ownerAbi = parseAbi(["function owner() view returns (address)"]);
const executorAbi = parseAbi([
  "function owner() view returns (address)",
  "function endpoint() view returns (address)",
  "function peers(uint32) view returns (bytes32)",
  "function allowedTargets(address) view returns (bool)",
]);
const endpointAbi = parseAbi(["function delegates(address) view returns (address)"]);
const factoryAbi = parseAbi([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function crossChainGovernance() view returns (address)",
]);
const treasuryAbi = parseAbi([
  "function controller() view returns (address)",
  "function bootstrapAdmin() view returns (address)",
  "function bootstrapLocked() view returns (bool)",
]);
const tokenAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function hasRole(bytes32,address) view returns (bool)",
]);
const infoNftAbi = parseAbi(["function admin() view returns (address)"]);
const pairAbi = parseAbi([
  "function liquidityInited() view returns (bool)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function getVirtualReserves() view returns (uint256,uint256)",
  "function getEffectiveReserves() view returns (uint256,uint256,uint32)",
]);

function loadEnv() {
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match && !process.env[match[1].trim()]) process.env[match[1].trim()] = match[2].trim();
    }
  } catch {
    // Optional.
  }
}

function same(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function privateKey(): Hex {
  const raw = process.env.BASE_MAINNET_PRIVATE_KEY || process.env.AGIKING_PRIVATE_KEY;
  if (!raw) throw new Error("Missing BASE_MAINNET_PRIVATE_KEY or AGIKING_PRIVATE_KEY");
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

async function main() {
  loadEnv();
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Deployment;
  if (deployment.chainId !== 8453 || deployment.network !== "base-mainnet") {
    throw new Error(`Wrong deployment target: ${deployment.network}/${deployment.chainId}`);
  }
  if (!deployment.params?.baseInitialEconomics) {
    throw new Error("Base economic initialization is not recorded");
  }
  for (const key of BASE_GOVERNANCE_ADDRESS_KEYS) {
    if (!deployment.addresses[key]) throw new Error(`Missing Base deployment address: ${key}`);
  }

  const addresses = Object.fromEntries(
    Object.entries(deployment.addresses).map(([key, value]) => [key, getAddress(value)]),
  ) as Record<string, Address>;
  const deployer = getAddress(deployment.deployer);
  const executor = getAddress(addresses.dualBridgeExecutorV2);
  const broadcaster = getAddress(
    process.env.ETH_CROSS_CHAIN_V2_BROADCASTER?.trim() || CURRENT_ETH_BROADCASTER,
  );
  const factory = getAddress(addresses.dealFactory);
  const treasury = getAddress(addresses.protocolTreasury);
  const dc = getAddress(addresses.dlToken);
  const infoNft = getAddress(addresses.dealInfoNFT);
  const rpc = process.env.BASE_MAINNET_RPC_URL?.trim()
    || deployment.rpcUrl
    || "https://mainnet.base.org";
  const client: any = createPublicClient({
    chain: base,
    transport: fallback([
      http(rpc, { timeout: 30_000 }),
      http("https://mainnet.base.org", { timeout: 30_000 }),
      http("https://base.drpc.org", { timeout: 30_000 }),
    ], { rank: false }),
  });
  if (await client.getChainId() !== 8453) throw new Error("RPC is not Base mainnet");

  async function read(address: Address, abi: any, functionName: string, args?: readonly unknown[]) {
    return client.readContract({ address, abi, functionName, args });
  }
  async function owner(address: Address) {
    return getAddress(await read(address, ownerAbi, "owner") as Address);
  }
  async function hasRole(role: Hex, account: Address) {
    return Boolean(await read(dc, tokenAbi, "hasRole", [role, account]));
  }

  const actions = buildBaseGovernanceHandoffPlan({
    addresses,
    executor,
    deployer,
    ethBroadcaster: broadcaster,
  });
  if (actions.length !== 39 || !actions.at(-1)?.label.includes("MUST BE LAST")) {
    throw new Error("Unexpected governance handoff plan shape");
  }

  const applied = new Map<string, () => Promise<boolean>>();
  applied.set("Executor.setPeer(Ethereum)", async () => (
    String(await read(executor, executorAbi, "peers", [ETH_LAYERZERO_EID])).toLowerCase()
      === padHex(broadcaster, { size: 32 }).toLowerCase()
  ));
  for (const target of baseGovernanceTargets(addresses, executor)) {
    applied.set(`Executor.allow(${target.key})`, async () => Boolean(
      await read(executor, executorAbi, "allowedTargets", [target.address]),
    ));
  }
  applied.set("Executor.setDelegate(self)", async () => {
    const endpoint = getAddress(await read(executor, executorAbi, "endpoint") as Address);
    return same(await read(endpoint, endpointAbi, "delegates", [executor]) as Address, executor);
  });
  applied.set("Factory.setCrossChainGovernance", async () => same(
    await read(factory, factoryAbi, "crossChainGovernance") as Address, executor,
  ));
  applied.set("Factory.setAdmin", async () => same(
    await read(factory, factoryAbi, "admin") as Address, executor,
  ));
  applied.set("Factory.transferOwnership", async () => same(await owner(factory), executor));
  applied.set("Treasury.bootstrapSetController", async () => same(
    await read(treasury, treasuryAbi, "controller") as Address, executor,
  ));
  applied.set("Treasury.lockBootstrap", async () => Boolean(
    await read(treasury, treasuryAbi, "bootstrapLocked"),
  ));
  applied.set("DC.grant Factory MINTER_ROLE", async () => hasRole(DC_MINTER_ROLE, factory));
  applied.set("DC.grant Executor MINTER_ROLE", async () => hasRole(DC_MINTER_ROLE, executor));
  applied.set("DC.grant Executor PAUSER_ROLE", async () => hasRole(DC_PAUSER_ROLE, executor));
  applied.set("DC.grant Executor DEFAULT_ADMIN_ROLE", async () => hasRole(DC_DEFAULT_ADMIN_ROLE, executor));
  applied.set("DC.renounce deployer MINTER_ROLE", async () => !(await hasRole(DC_MINTER_ROLE, deployer)));
  applied.set("DC.renounce deployer DEFAULT_ADMIN_ROLE", async () => !(await hasRole(DC_DEFAULT_ADMIN_ROLE, deployer)));
  applied.set("InfoNFT.setAdmin", async () => same(
    await read(infoNft, infoNftAbi, "admin") as Address, executor,
  ));
  for (const [label, key] of [
    ["PairManager.transferOwner", "dealPairManager"],
    ["OrderBook.transferOwner", "dealSwapOrderBook"],
    ["AssetRegistry.transferOwner", "dealSwapAssetRegistry"],
    ["DCDomainSwap.transferOwner", "dcDomainSwap"],
    ["ImplementationRegistry.transferOwnership", "dealImplementationRegistry"],
    ["InfoNFT.transferOwnership", "dealInfoNFT"],
    ["CreditGraph.transferOwnership", "dealCreditGraph"],
    ["DCDomain.transferOwnership", "dcDomain"],
    ["DCDomainRank.transferOwnership", "dcDomainRank"],
    ["DCDomainMarket.transferOwnership", "dcDomainMarket"],
  ] as const) {
    applied.set(label, async () => same(await owner(getAddress(addresses[key])), executor));
  }
  applied.set("Executor.transferOwnership(self) — MUST BE LAST", async () => same(
    await owner(executor), executor,
  ));
  for (const action of actions) {
    if (!applied.has(action.label)) throw new Error(`Missing live-state predicate: ${action.label}`);
  }

  // Exact launch-economics preflight. This intentionally runs before any
  // irreversible authority mutation.
  const [totalSupply, treasuryBalance] = await Promise.all([
    read(dc, tokenAbi, "totalSupply") as Promise<bigint>,
    read(dc, tokenAbi, "balanceOf", [treasury]) as Promise<bigint>,
  ]);
  if (totalSupply !== BASE_TOTAL_INITIAL_DC || treasuryBalance !== BASE_TREASURY_INITIAL_DC) {
    throw new Error(`Economic preflight failed: supply=${totalSupply}, treasury=${treasuryBalance}`);
  }
  for (const expected of BASE_LEGACY_POOL_PLANS) {
    const pair = getAddress(addresses[expected.key]);
    const [initialized, reserves, virtuals, effective] = await Promise.all([
      read(pair, pairAbi, "liquidityInited") as Promise<boolean>,
      read(pair, pairAbi, "getReserves") as Promise<readonly [bigint, bigint, number]>,
      read(pair, pairAbi, "getVirtualReserves") as Promise<readonly [bigint, bigint]>,
      read(pair, pairAbi, "getEffectiveReserves") as Promise<readonly [bigint, bigint, number]>,
    ]);
    const expectedVirtual = expected.effectiveOther - BASE_REAL_OTHER_SMALLEST_UNIT;
    if (!initialized
      || reserves[0] !== expected.realDc
      || reserves[1] !== BASE_REAL_OTHER_SMALLEST_UNIT
      || virtuals[0] !== 0n
      || virtuals[1] !== expectedVirtual
      || effective[0] !== expected.realDc
      || effective[1] !== expected.effectiveOther) {
      throw new Error(`${expected.label} economic preflight failed`);
    }
  }

  const states = [];
  for (const [index, action] of actions.entries()) {
    states.push({ index: index + 1, label: action.label, phase: action.phase, applied: await applied.get(action.label)!() });
  }
  const pending = states.filter((state) => !state.applied);
  console.log(JSON.stringify({
    scope: "Base production governance handoff",
    mode: process.env.BASE_MAINNET_GOVERNANCE_HANDOFF === WRITE_CONFIRMATION ? "authorized execution" : "read-only preflight",
    chainId: 8453,
    deploymentFile: DEPLOYMENT_FILE,
    executionFile: EXECUTION_FILE,
    deployer,
    executor,
    broadcaster,
    actionCount: actions.length,
    alreadyApplied: states.length - pending.length,
    pendingCount: pending.length,
    pending,
  }, null, 2));

  if (pending.length === 0) {
    console.log("Governance handoff already complete; no transaction sent.");
    return;
  }
  if (process.env.BASE_MAINNET_GOVERNANCE_HANDOFF !== WRITE_CONFIRMATION) {
    console.log(`Read-only complete. Set BASE_MAINNET_GOVERNANCE_HANDOFF=${WRITE_CONFIRMATION} only after explicit authorization.`);
    return;
  }

  const account = privateKeyToAccount(privateKey());
  if (!same(account.address, deployer)) throw new Error(`Signer mismatch: ${account.address} != ${deployer}`);
  const executorOwner = await owner(executor);
  if (!same(executorOwner, deployer)) {
    throw new Error(`Executor owner is no longer the deployer while ${pending.length} actions remain: ${executorOwner}`);
  }
  const bootstrapAdmin = getAddress(await read(treasury, treasuryAbi, "bootstrapAdmin") as Address);
  if (!same(bootstrapAdmin, deployer)) throw new Error(`Treasury bootstrapAdmin mismatch: ${bootstrapAdmin}`);
  const minimumBalance = parseEther(process.env.BASE_MAINNET_HANDOFF_MIN_ETH?.trim() || "0.001");
  const nativeBalance = await client.getBalance({ address: deployer });
  if (nativeBalance < minimumBalance) {
    throw new Error(`Base ETH below safety floor: ${formatEther(nativeBalance)} < ${formatEther(minimumBalance)}`);
  }

  const wallet: any = createWalletClient({ account, chain: base, transport: http(rpc, { timeout: 30_000 }) });
  let nextNonce = await client.getTransactionCount({ address: deployer, blockTag: "pending" });
  const prior = existsSync(EXECUTION_FILE)
    ? JSON.parse(readFileSync(EXECUTION_FILE, "utf8")) as { transactions?: TransactionRecord[]; startedAt?: string }
    : {};
  const transactions = prior.transactions || [];
  const startedAt = prior.startedAt || new Date().toISOString();
  const skipped = states.filter((state) => state.applied).map((state) => state.label);

  for (const state of pending) {
    const action = actions[state.index - 1];
    const hash = await wallet.sendTransaction({
      to: action.target,
      data: action.data,
      nonce: nextNonce,
      gas: 400_000n,
    });
    console.log(`[${state.index}/39] ${action.label}: ${hash}`);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`${action.label} failed: ${hash}`);
    transactions.push({
      index: state.index,
      phase: action.phase,
      label: action.label,
      target: action.target,
      hash,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
    });
    writeFileSync(EXECUTION_FILE, JSON.stringify({
      scope: "Base production governance handoff",
      chainId: 8453,
      deploymentFile: DEPLOYMENT_FILE,
      deployer,
      executor,
      broadcaster,
      startedAt,
      updatedAt: new Date().toISOString(),
      complete: false,
      actionCount: actions.length,
      skipped,
      transactions,
    }, null, 2) + "\n", "utf8");
    nextNonce += 1;
  }

  writeFileSync(EXECUTION_FILE, JSON.stringify({
    scope: "Base production governance handoff",
    chainId: 8453,
    deploymentFile: DEPLOYMENT_FILE,
    deployer,
    executor,
    broadcaster,
    startedAt,
    completedAt: new Date().toISOString(),
    complete: true,
    actionCount: actions.length,
    skipped,
    transactions,
  }, null, 2) + "\n", "utf8");
  console.log(`Submitted ${transactions.length} successful transactions; post-handoff audit is still required.`);
}

await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
