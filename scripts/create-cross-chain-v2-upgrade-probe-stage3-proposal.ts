/**
 * Stage 3 proposal creation only for the asset-free cross-chain upgrade probe:
 *   1. mint exactly one current Major proposal fee;
 *   2. approve exactly that fee;
 *   3. create one Major proposal containing:
 *      - direct ETH Probe V1 -> V2 upgrade;
 *      - CrossChainBroadcasterV2 broadcast of the BSC Probe V1 -> V2 upgrade.
 *
 * This script has no stake, execute, broadcast, proxy upgrade, deployment,
 * Git commit, or Git push path.
 *
 * Read-only preflight:
 *   node --import tsx/esm scripts/create-cross-chain-v2-upgrade-probe-stage3-proposal.ts --preflight
 *
 * Explicit write gate:
 *   CROSS_CHAIN_V2_UPGRADE_PROBE_STAGE3_CONFIRM=CREATE_UPGRADE_PROPOSAL_ONLY \
 *     node --import tsx/esm scripts/create-cross-chain-v2-upgrade-probe-stage3-proposal.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  parseAbi,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, mainnet } from "viem/chains";

const ROOT = process.cwd();
const OUTPUT_FILE = join(
  ROOT,
  "deployments",
  "cross-chain-v2-upgrade-probe-stage3-proposal.json",
);
const WRITE_CONFIRM = "CREATE_UPGRADE_PROPOSAL_ONLY";
const MAJOR = 2;
const PENDING = 1;
const EXECUTED = 6;
const BSC_CHAIN_KEY = 30102;
const LZ_GAS = 500_000n;
const FEE_BUDGET = parseEther("0.002");
const EXPECTED_MAJOR_FEE = parseEther("1000");
const UPGRADE_SELECTOR = toFunctionSelector("upgradeToAndCall(address,bytes)");
const BROADCAST_SELECTOR = toFunctionSelector(
  "broadcast(uint32[],address[],bytes,uint128)",
);
const TITLE = "跨链升级测试";
const BODY =
  "将 ETH 和 BSC 上两个无资产测试合约从 V1 升级到 V2，只验证 DAO 跨链升级流程，不影响任何业务。";
const DESCRIPTION = `${TITLE}\n\n${BODY}`;
const SCOPE =
  "mint/approve one exact Major fee and create one two-action Probe upgrade proposal; no stake, execute, broadcast or upgrade";

type CanonicalDeployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
};

type ProbeDeployment = {
  stage: string;
  signers: { eth: Address; bsc: Address };
  eth: {
    controller: Address;
    v1Implementation: { address: Address };
    proxy: { address: Address };
    v2Implementation: { address: Address };
  };
  bsc: {
    controller: Address;
    v1Implementation: { address: Address };
    proxy: { address: Address };
    v2Implementation: { address: Address };
  };
};

type Stage2State = {
  stage: string;
  proposalId?: string;
  proposer: Address;
  governance: Address;
  registry: Address;
  dc: Address;
  executor: Address;
  ethProxy: Address;
  bscProxy: Address;
};

type CcipStage1 = {
  eth: { address: Address; verified: boolean };
  bsc: { address: Address; verified: boolean };
};

type TxRecord = {
  txHash: Hex;
  nonce: number;
  blockNumber: string;
  gasUsed: string;
  verified: boolean;
};

type Stage3State = {
  schemaVersion: 1;
  scope: string;
  stage: "prepared" | "fee_minted" | "fee_approved" | "proposal_created";
  startedAt: string;
  updatedAt: string;
  description: string;
  proposer: Address;
  governance: Address;
  registry: Address;
  dc: Address;
  broadcaster: Address;
  executor: Address;
  ethProxy: Address;
  ethV2Implementation: Address;
  bscProxy: Address;
  bscV2Implementation: Address;
  majorFee: string;
  bridgeFeeBudget: string;
  liveQuoteAtPreflight: string;
  broadcastNonceBefore: string;
  proposalCountBefore: string;
  ethUpgradeCalldata: Hex;
  bscUpgradeCalldata: Hex;
  broadcastCalldata: Hex;
  createProposalCalldata: Hex;
  actions: {
    mintFee?: TxRecord;
    approveFee?: TxRecord;
    createProposal?: TxRecord;
  };
  proposalId?: string;
  verification?: {
    proposalState: string;
    totalStaked: string;
    descriptionMatched: boolean;
    actionsMatched: boolean;
    ethProxyVersion: string;
    bscProxyVersion: string;
    broadcasterNonce: string;
    proposerDcBalance: string;
    proposerAllowance: string;
  };
};

type RuleView = readonly [boolean, boolean, boolean, bigint] & {
  allowed?: boolean;
  validateNestedBroadcast?: boolean;
  nestedOnly?: boolean;
  maxValue?: bigint;
};

const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

const governanceAbi = parseAbi([
  "function dcToken() view returns (address)",
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
]);
const tokenAbi = parseAbi([
  "function MINTER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function paused() view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function mint(address,uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const broadcasterAbi = parseAbi([
  "function governance() view returns (address)",
  "function broadcastNonce() view returns (uint256)",
  "function getChainIds() view returns (uint32[])",
  "function chains(uint32) view returns (uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
  "function quoteFees(uint32[],address[],bytes,uint128) view returns (uint256)",
  "function broadcast(uint32[],address[],bytes,uint128) payable",
]);
const executorAbi = parseAbi([
  "function allowedTargets(address) view returns (bool)",
]);
const probeAbi = parseAbi([
  "function controller() view returns (address)",
  "function version() view returns (uint256)",
  "function upgradeToAndCall(address,bytes) payable",
]);

loadEnv();

function loadEnv() {
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) process.env[match[1].trim()] ||= match[2].trim();
    }
  } catch {}
}

function loadJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8")) as T;
}

function privateKey(primary: string, fallback: string): Hex {
  const raw = process.env[primary]?.trim() || process.env[fallback]?.trim();
  if (!raw) throw new Error(`Missing ${primary} and fallback ${fallback}`);
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

function sameAddress(a: unknown, b: Address): boolean {
  return String(a).toLowerCase() === b.toLowerCase();
}

function sameHex(a: unknown, b: Hex): boolean {
  return String(a).toLowerCase() === b.toLowerCase();
}

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function save(state: Stage3State) {
  state.updatedAt = new Date().toISOString();
  writeFileSync(OUTPUT_FILE, `${stringify(state)}\n`, "utf8");
}

function ruleTuple(rule: RuleView): [boolean, boolean, boolean, bigint] {
  return [
    rule.allowed ?? rule[0],
    rule.validateNestedBroadcast ?? rule[1],
    rule.nestedOnly ?? rule[2],
    rule.maxValue ?? rule[3],
  ];
}

function slotAddress(word: Hex | undefined): Address {
  if (!word || word.length !== 66) throw new Error("Implementation slot missing");
  return getAddress(`0x${word.slice(-40)}`);
}

async function nonceState(client: any, address: Address) {
  const [latest, pending] = await Promise.all([
    client.getTransactionCount({ address, blockTag: "latest" }),
    client.getTransactionCount({ address, blockTag: "pending" }),
  ]);
  return { latest: Number(latest), pending: Number(pending) };
}

async function waitAndVerify(
  client: any,
  hash: Hex,
  expectedFrom: Address,
  expectedTo: Address,
  expectedInput: Hex,
): Promise<TxRecord> {
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: 2,
    timeout: 300_000,
  });
  const tx = await client.getTransaction({ hash });
  if (
    receipt.status !== "success" ||
    !sameAddress(tx.from, expectedFrom) ||
    !tx.to ||
    !sameAddress(tx.to, expectedTo) ||
    !sameHex(tx.input, expectedInput) ||
    tx.value !== 0n
  ) {
    throw new Error(`Transaction verification failed: ${hash}`);
  }
  return {
    txHash: hash,
    nonce: tx.nonce,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    verified: true,
  };
}

async function findDuplicateProposal(
  client: any,
  governance: Address,
  expectedTargets: Address[],
  expectedValues: bigint[],
  expectedCalldatas: Hex[],
  count: bigint,
): Promise<bigint | undefined> {
  for (let id = 1n; id <= count; id += 1n) {
    const actions = await client.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "getActions",
      args: [id],
    });
    if (
      actions[0].length === expectedTargets.length &&
      actions[1].length === expectedValues.length &&
      actions[2].length === expectedCalldatas.length &&
      expectedTargets.every((target, i) => sameAddress(actions[0][i], target)) &&
      expectedValues.every((value, i) => actions[1][i] === value) &&
      expectedCalldatas.every((data, i) => sameHex(actions[2][i], data))
    ) {
      return id;
    }
  }
  return undefined;
}

async function main() {
  const preflightOnly = process.argv.includes("--preflight");
  const writeEnabled =
    process.env.CROSS_CHAIN_V2_UPGRADE_PROBE_STAGE3_CONFIRM === WRITE_CONFIRM;
  if (!preflightOnly && !writeEnabled) {
    throw new Error(
      `Write gate closed: set CROSS_CHAIN_V2_UPGRADE_PROBE_STAGE3_CONFIRM=${WRITE_CONFIRM}`,
    );
  }

  const ethDeployment = loadJson<CanonicalDeployment>(
    "deployments/eth-mainnet-1.json",
  );
  const bscDeployment = loadJson<CanonicalDeployment>(
    "deployments/bsc-mainnet-56.json",
  );
  const probe = loadJson<ProbeDeployment>(
    "deployments/cross-chain-v2-upgrade-probe-stage1.json",
  );
  const stage2 = loadJson<Stage2State>(
    "deployments/cross-chain-v2-upgrade-probe-stage2.json",
  );
  const ccip = loadJson<CcipStage1>(
    "deployments/ccip-v2-mainnet-stage1.json",
  );
  if (
    ethDeployment.chainId !== 1 ||
    bscDeployment.chainId !== 56 ||
    probe.stage !== "both_deployed" ||
    stage2.stage !== "proposal_created" ||
    !stage2.proposalId ||
    !ccip.eth.verified ||
    !ccip.bsc.verified
  ) {
    throw new Error("Canonical Stage 1/2 deployment records are not ready");
  }

  const governance = getAddress(ethDeployment.addresses.dealGovernance);
  const registry = getAddress(ethDeployment.addresses.governancePolicyRegistry);
  const dc = getAddress(ethDeployment.addresses.dlToken);
  const broadcaster = getAddress(ccip.eth.address);
  const executor = getAddress(ccip.bsc.address);
  const ethProxy = getAddress(probe.eth.proxy.address);
  const ethV2 = getAddress(probe.eth.v2Implementation.address);
  const bscProxy = getAddress(probe.bsc.proxy.address);
  const bscV2 = getAddress(probe.bsc.v2Implementation.address);
  const expectedSigner = getAddress(ethDeployment.deployer);
  const account = privateKeyToAccount(
    privateKey("ETH_MAINNET_PRIVATE_KEY", "AGIKING_PRIVATE_KEY"),
  );
  if (
    !sameAddress(account.address, expectedSigner) ||
    !sameAddress(account.address, probe.signers.eth) ||
    !sameAddress(account.address, stage2.proposer) ||
    !sameAddress(governance, stage2.governance) ||
    !sameAddress(registry, stage2.registry) ||
    !sameAddress(dc, stage2.dc) ||
    !sameAddress(executor, stage2.executor) ||
    !sameAddress(ethProxy, stage2.ethProxy) ||
    !sameAddress(bscProxy, stage2.bscProxy)
  ) {
    throw new Error("Signer or canonical address mismatch");
  }

  const ethRpc =
    process.env.ETH_MAINNET_RPC_URL?.trim() ||
    "https://ethereum-rpc.publicnode.com";
  const bscRpc =
    process.env.BSC_MAINNET_RPC_URL?.trim() ||
    "https://bsc-mainnet.public.blastapi.io";
  const ethClient: any = createPublicClient({
    chain: mainnet,
    transport: http(ethRpc),
  });
  const bscClient: any = createPublicClient({
    chain: bsc,
    transport: http(bscRpc),
  });
  const wallet: any = createWalletClient({
    account,
    chain: mainnet,
    transport: http(ethRpc),
  });

  const ethUpgradeData = encodeFunctionData({
    abi: probeAbi,
    functionName: "upgradeToAndCall",
    args: [ethV2, "0x"],
  });
  const bscUpgradeData = encodeFunctionData({
    abi: probeAbi,
    functionName: "upgradeToAndCall",
    args: [bscV2, "0x"],
  });
  const broadcastData = encodeFunctionData({
    abi: broadcasterAbi,
    functionName: "broadcast",
    args: [[BSC_CHAIN_KEY], [bscProxy], bscUpgradeData, LZ_GAS],
  });
  const targets = [ethProxy, broadcaster];
  const values = [0n, FEE_BUDGET];
  const calldatas = [ethUpgradeData, broadcastData];
  const createProposalData = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [targets, values, calldatas, DESCRIPTION, MAJOR],
  });

  const minterRole = await ethClient.readContract({
    address: dc,
    abi: tokenAbi,
    functionName: "MINTER_ROLE",
  });
  const [
    ethChainId,
    bscChainId,
    ethBlock,
    bscBlock,
    nonces,
    chainDc,
    chainRegistry,
    registryGovernance,
    broadcasterGovernance,
    majorFee,
    proposalCount,
    policyProposal,
    policyProposalState,
    canMint,
    paused,
    proposerBalance,
    proposerAllowance,
    chainIds,
    route,
    liveQuote,
    broadcastNonce,
    ethRuleRaw,
    bscRuleRaw,
    broadcasterRuleRaw,
    ethActionAllowed,
    broadcastActionAllowed,
    bscAllowlisted,
    ethController,
    bscController,
    ethVersion,
    bscVersion,
    ethV2Version,
    bscV2Version,
    ethImplementationWord,
    bscImplementationWord,
  ] = await Promise.all([
    ethClient.getChainId(),
    bscClient.getChainId(),
    ethClient.getBlockNumber(),
    bscClient.getBlockNumber(),
    nonceState(ethClient, account.address),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "dcToken",
    }),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "policyRegistry",
    }),
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "governance",
    }),
    ethClient.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "governance",
    }),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "majorProposalFee",
    }),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "proposalCount",
    }),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "getProposal",
      args: [BigInt(stage2.proposalId)],
    }),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "state",
      args: [BigInt(stage2.proposalId)],
    }),
    ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "hasRole",
      args: [minterRole, account.address],
    }),
    ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "paused",
    }),
    ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [account.address, governance],
    }),
    ethClient.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "getChainIds",
    }),
    ethClient.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "chains",
      args: [BSC_CHAIN_KEY],
    }),
    ethClient.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "quoteFees",
      args: [[BSC_CHAIN_KEY], [bscProxy], bscUpgradeData, LZ_GAS],
    }),
    ethClient.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "broadcastNonce",
    }),
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, ethProxy, UPGRADE_SELECTOR],
    }),
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, bscProxy, UPGRADE_SELECTOR],
    }),
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, broadcaster, BROADCAST_SELECTOR],
    }),
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "isActionAllowed",
      args: [MAJOR, ethProxy, 0n, ethUpgradeData],
    }),
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "isActionAllowed",
      args: [MAJOR, broadcaster, FEE_BUDGET, broadcastData],
    }),
    bscClient.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "allowedTargets",
      args: [bscProxy],
    }),
    ethClient.readContract({
      address: ethProxy,
      abi: probeAbi,
      functionName: "controller",
    }),
    bscClient.readContract({
      address: bscProxy,
      abi: probeAbi,
      functionName: "controller",
    }),
    ethClient.readContract({
      address: ethProxy,
      abi: probeAbi,
      functionName: "version",
    }),
    bscClient.readContract({
      address: bscProxy,
      abi: probeAbi,
      functionName: "version",
    }),
    ethClient.readContract({
      address: ethV2,
      abi: probeAbi,
      functionName: "version",
    }),
    bscClient.readContract({
      address: bscV2,
      abi: probeAbi,
      functionName: "version",
    }),
    ethClient.getStorageAt({ address: ethProxy, slot: IMPLEMENTATION_SLOT }),
    bscClient.getStorageAt({ address: bscProxy, slot: IMPLEMENTATION_SLOT }),
  ]);

  const ethRule = ruleTuple(ethRuleRaw as RuleView);
  const bscRule = ruleTuple(bscRuleRaw as RuleView);
  const broadcasterRule = ruleTuple(broadcasterRuleRaw as RuleView);
  if (ethChainId !== 1 || bscChainId !== 56) {
    throw new Error(`RPC chain mismatch: ${ethChainId}/${bscChainId}`);
  }
  if (
    !sameAddress(chainDc, dc) ||
    !sameAddress(chainRegistry, registry) ||
    !sameAddress(registryGovernance, governance) ||
    !sameAddress(broadcasterGovernance, governance) ||
    !sameAddress(ethController, governance) ||
    !sameAddress(bscController, executor)
  ) {
    throw new Error("Governance/Registry/Broadcaster/Probe wiring mismatch");
  }
  if (
    majorFee !== EXPECTED_MAJOR_FEE ||
    !canMint ||
    paused ||
    policyProposalState !== EXECUTED ||
    !policyProposal.executed ||
    policyProposal.totalStaked < parseEther("70")
  ) {
    throw new Error("Fee/token/policy proposal state mismatch");
  }
  if (
    !chainIds.includes(BSC_CHAIN_KEY) ||
    !route[6] ||
    liveQuote > FEE_BUDGET ||
    !bscAllowlisted
  ) {
    throw new Error("BSC route, quote, or allowlist is not ready");
  }
  if (
    !ethRule[0] ||
    ethRule[1] ||
    ethRule[2] ||
    ethRule[3] !== 0n ||
    !bscRule[0] ||
    bscRule[1] ||
    !bscRule[2] ||
    bscRule[3] !== 0n ||
    !broadcasterRule[0] ||
    !broadcasterRule[1] ||
    broadcasterRule[2] ||
    broadcasterRule[3] < FEE_BUDGET ||
    !ethActionAllowed ||
    !broadcastActionAllowed
  ) {
    throw new Error("Exact direct/nested/broadcaster policy validation failed");
  }
  if (
    ethVersion !== 1n ||
    bscVersion !== 1n ||
    ethV2Version !== 2n ||
    bscV2Version !== 2n ||
    !sameAddress(slotAddress(ethImplementationWord), probe.eth.v1Implementation.address) ||
    !sameAddress(slotAddress(bscImplementationWord), probe.bsc.v1Implementation.address)
  ) {
    throw new Error("Probe V1/V2 implementation state mismatch");
  }

  const duplicate = await findDuplicateProposal(
    ethClient,
    governance,
    targets,
    values,
    calldatas,
    proposalCount,
  );
  if (duplicate !== undefined) {
    throw new Error(`Duplicate Probe upgrade proposal already exists: ${duplicate}`);
  }

  const hasExistingState = existsSync(OUTPUT_FILE);
  let state: Stage3State | undefined = hasExistingState
    ? (JSON.parse(readFileSync(OUTPUT_FILE, "utf8")) as Stage3State)
    : undefined;
  if (state) {
    if (
      state.scope !== SCOPE ||
      state.description !== DESCRIPTION ||
      !sameAddress(state.proposer, account.address) ||
      !sameHex(state.ethUpgradeCalldata, ethUpgradeData) ||
      !sameHex(state.bscUpgradeCalldata, bscUpgradeData) ||
      !sameHex(state.broadcastCalldata, broadcastData) ||
      !sameHex(state.createProposalCalldata, createProposalData)
    ) {
      throw new Error("Existing Stage 3 state mismatch");
    }
  }

  console.log(
    stringify({
      preflightOnly,
      ethBlock,
      bscBlock,
      title: TITLE,
      body: BODY,
      proposalCount,
      expectedProposalId: proposalCount + 1n,
      majorFeeDc: formatEther(majorFee),
      nonce: nonces,
      proposerBalanceDc: formatEther(proposerBalance),
      proposerAllowanceDc: formatEther(proposerAllowance),
      policyProposalId: stage2.proposalId,
      policyProposalState,
      policyProposalExecuted: policyProposal.executed,
      liveBridgeQuoteWei: liveQuote,
      liveBridgeQuoteEth: formatEther(liveQuote),
      bridgeFeeBudgetWei: FEE_BUDGET,
      bridgeFeeBudgetEth: formatEther(FEE_BUDGET),
      broadcastNonce,
      bscAllowlisted,
      ethActionAllowed,
      broadcastActionAllowed,
      ethVersion,
      bscVersion,
      ethUpgradeData,
      bscUpgradeData,
      broadcastData,
      createProposalData,
    }),
  );

  if (preflightOnly) {
    if (
      hasExistingState ||
      proposerBalance !== 0n ||
      proposerAllowance !== 0n ||
      nonces.latest !== nonces.pending
    ) {
      throw new Error("Clean Stage 3 preflight invariants not satisfied");
    }
    await ethClient.simulateContract({
      account: account.address,
      address: dc,
      abi: tokenAbi,
      functionName: "mint",
      args: [account.address, majorFee],
    });
    console.log("Stage 3 preflight passed. No transaction was signed or sent.");
    return;
  }

  if (!state) {
    if (
      proposerBalance !== 0n ||
      proposerAllowance !== 0n ||
      nonces.latest !== nonces.pending
    ) {
      throw new Error("Clean Stage 3 write invariants not satisfied");
    }
    state = {
      schemaVersion: 1,
      scope: SCOPE,
      stage: "prepared",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      description: DESCRIPTION,
      proposer: account.address,
      governance,
      registry,
      dc,
      broadcaster,
      executor,
      ethProxy,
      ethV2Implementation: ethV2,
      bscProxy,
      bscV2Implementation: bscV2,
      majorFee: majorFee.toString(),
      bridgeFeeBudget: FEE_BUDGET.toString(),
      liveQuoteAtPreflight: liveQuote.toString(),
      broadcastNonceBefore: broadcastNonce.toString(),
      proposalCountBefore: proposalCount.toString(),
      ethUpgradeCalldata: ethUpgradeData,
      bscUpgradeCalldata: bscUpgradeData,
      broadcastCalldata: broadcastData,
      createProposalCalldata: createProposalData,
      actions: {},
    };
    save(state);
  }

  if (!state.actions.mintFee) {
    const mintData = encodeFunctionData({
      abi: tokenAbi,
      functionName: "mint",
      args: [account.address, majorFee],
    });
    const nonce = await nonceState(ethClient, account.address);
    if (nonce.latest !== nonce.pending) throw new Error("ETH pending nonce");
    const hash = await wallet.writeContract({
      account,
      address: dc,
      abi: tokenAbi,
      functionName: "mint",
      args: [account.address, majorFee],
      nonce: nonce.pending,
    });
    state.actions.mintFee = await waitAndVerify(
      ethClient,
      hash,
      account.address,
      dc,
      mintData,
    );
    state.stage = "fee_minted";
    save(state);
  }

  if (!state.actions.approveFee) {
    const [balance, allowance] = await Promise.all([
      ethClient.readContract({
        address: dc,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [account.address],
      }),
      ethClient.readContract({
        address: dc,
        abi: tokenAbi,
        functionName: "allowance",
        args: [account.address, governance],
      }),
    ]);
    if (balance !== majorFee || allowance !== 0n) {
      throw new Error("Exact post-mint balance/allowance mismatch");
    }
    const approveData = encodeFunctionData({
      abi: tokenAbi,
      functionName: "approve",
      args: [governance, majorFee],
    });
    const nonce = await nonceState(ethClient, account.address);
    if (nonce.latest !== nonce.pending) throw new Error("ETH pending nonce");
    const hash = await wallet.writeContract({
      account,
      address: dc,
      abi: tokenAbi,
      functionName: "approve",
      args: [governance, majorFee],
      nonce: nonce.pending,
    });
    state.actions.approveFee = await waitAndVerify(
      ethClient,
      hash,
      account.address,
      dc,
      approveData,
    );
    state.stage = "fee_approved";
    save(state);
  }

  if (!state.actions.createProposal) {
    const [count, balance, allowance, currentQuote, currentNonce] =
      await Promise.all([
        ethClient.readContract({
          address: governance,
          abi: governanceAbi,
          functionName: "proposalCount",
        }),
        ethClient.readContract({
          address: dc,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [account.address],
        }),
        ethClient.readContract({
          address: dc,
          abi: tokenAbi,
          functionName: "allowance",
          args: [account.address, governance],
        }),
        ethClient.readContract({
          address: broadcaster,
          abi: broadcasterAbi,
          functionName: "quoteFees",
          args: [[BSC_CHAIN_KEY], [bscProxy], bscUpgradeData, LZ_GAS],
        }),
        ethClient.readContract({
          address: broadcaster,
          abi: broadcasterAbi,
          functionName: "broadcastNonce",
        }),
      ]);
    if (
      count !== BigInt(state.proposalCountBefore) ||
      balance !== majorFee ||
      allowance !== majorFee ||
      currentQuote > FEE_BUDGET ||
      currentNonce !== BigInt(state.broadcastNonceBefore)
    ) {
      throw new Error("Proposal count, fee, quote, or broadcast nonce changed");
    }
    await ethClient.simulateContract({
      account: account.address,
      address: governance,
      abi: governanceAbi,
      functionName: "createProposal",
      args: [targets, values, calldatas, DESCRIPTION, MAJOR],
    });
    const nonce = await nonceState(ethClient, account.address);
    if (nonce.latest !== nonce.pending) throw new Error("ETH pending nonce");
    const hash = await wallet.writeContract({
      account,
      address: governance,
      abi: governanceAbi,
      functionName: "createProposal",
      args: [targets, values, calldatas, DESCRIPTION, MAJOR],
      nonce: nonce.pending,
    });
    state.actions.createProposal = await waitAndVerify(
      ethClient,
      hash,
      account.address,
      governance,
      createProposalData,
    );
    const countAfter = await ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "proposalCount",
    });
    if (countAfter !== count + 1n) {
      throw new Error("Proposal count did not increment exactly once");
    }
    state.proposalId = countAfter.toString();
    state.stage = "proposal_created";
    save(state);
  }

  if (!state.proposalId) throw new Error("Missing proposalId");
  const proposalId = BigInt(state.proposalId);
  const [
    proposal,
    proposalState,
    actions,
    finalBalance,
    finalAllowance,
    finalEthVersion,
    finalBscVersion,
    finalBroadcastNonce,
  ] = await Promise.all([
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "getProposal",
      args: [proposalId],
    }),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "state",
      args: [proposalId],
    }),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "getActions",
      args: [proposalId],
    }),
    ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [account.address, governance],
    }),
    ethClient.readContract({
      address: ethProxy,
      abi: probeAbi,
      functionName: "version",
    }),
    bscClient.readContract({
      address: bscProxy,
      abi: probeAbi,
      functionName: "version",
    }),
    ethClient.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "broadcastNonce",
    }),
  ]);
  const descriptionMatched = proposal.description === DESCRIPTION;
  const actionsMatched =
    actions[0].length === 2 &&
    actions[1].length === 2 &&
    actions[2].length === 2 &&
    sameAddress(actions[0][0], ethProxy) &&
    sameAddress(actions[0][1], broadcaster) &&
    actions[1][0] === 0n &&
    actions[1][1] === FEE_BUDGET &&
    sameHex(actions[2][0], ethUpgradeData) &&
    sameHex(actions[2][1], broadcastData);
  if (
    proposal.kind !== MAJOR ||
    proposal.totalStaked !== 0n ||
    proposal.executed ||
    proposalState !== PENDING ||
    !descriptionMatched ||
    !actionsMatched ||
    finalBalance !== 0n ||
    finalAllowance !== 0n ||
    finalEthVersion !== 1n ||
    finalBscVersion !== 1n ||
    finalBroadcastNonce !== BigInt(state.broadcastNonceBefore)
  ) {
    throw new Error("Stage 3 final verification failed");
  }

  state.verification = {
    proposalState: proposalState.toString(),
    totalStaked: proposal.totalStaked.toString(),
    descriptionMatched,
    actionsMatched,
    ethProxyVersion: finalEthVersion.toString(),
    bscProxyVersion: finalBscVersion.toString(),
    broadcasterNonce: finalBroadcastNonce.toString(),
    proposerDcBalance: finalBalance.toString(),
    proposerAllowance: finalAllowance.toString(),
  };
  save(state);
  console.log(stringify(state));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
