/**
 * Stage 4B only: fund one exact Major proposal fee and create one zero-business-
 * change cross-chain canary proposal.
 *
 * Allowed writes (exactly three):
 *   1. DC.mint(proposer, 1000 DC)
 *   2. DC.approve(DealGovernance, 1000 DC)
 *   3. DealGovernance.createProposal(...) with one Major V2 broadcast action
 *
 * The proposal sends BSC DealFactory.setDealImplementation(current value).
 * It does not stake, execute, broadcast, change a live implementation address,
 * disable V1, change bridge config, move Treasury funds, commit or push Git.
 *
 * Read-only preflight:
 *   node --import tsx/esm scripts/propose-mainnet-ccip-v2-stage4-canary.ts --preflight
 *
 * Explicit write gate:
 *   CCIP_V2_STAGE4_CANARY_PROPOSE=1 \
 *     node --import tsx/esm scripts/propose-mainnet-ccip-v2-stage4-canary.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, mainnet } from "viem/chains";

try {
  readFileSync(".env", "utf8")
    .split("\n")
    .forEach((line) => {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) process.env[match[1].trim()] ||= match[2].trim();
    });
} catch {}

type EthDeployment = {
  chainId: number;
  deployer: Address;
  addresses: {
    dealGovernance: Address;
    governancePolicyRegistry: Address;
    dlToken: Address;
    protocolTreasury: Address;
  };
};

type CrossChainDeployment = {
  eth: { broadcaster: Address };
  bsc: { executor: Address };
  params: {
    bscChainKey: number;
    bscDealFactory: Address;
  };
};

type Stage1State = {
  stage: string;
  eth: { address: Address; verified?: boolean };
  bsc: { address: Address; verified?: boolean };
};

type Stage2State = {
  stage: string;
  broadcaster: Address;
  executor: Address;
};

type Stage4CutoverState = {
  stage: string;
  broadcaster: Address;
  executor: Address;
  bscFactory: Address;
  verification?: {
    routeActive?: boolean;
    factoryController?: Address;
    broadcastNonce?: string;
    minWindowSec?: number;
  };
};

type ActionReceipt = {
  nonce: number;
  txHash: Hex;
  blockNumber?: string;
  verified?: boolean;
};

type ProposalStateFile = {
  schemaVersion: 1;
  scope: string;
  stage:
    | "prepared"
    | "old_proposal_cancel_submitted"
    | "old_proposal_canceled"
    | "fee_mint_submitted"
    | "fee_minted"
    | "fee_approval_submitted"
    | "fee_approved"
    | "proposal_submitted"
    | "proposal_created";
  startedAt: string;
  updatedAt: string;
  proposer: Address;
  governance: Address;
  registry: Address;
  dc: Address;
  oldBroadcaster: Address;
  newBroadcaster: Address;
  oldExecutor: Address;
  newExecutor: Address;
  bscFactory: Address;
  bscDealImplementation: Address;
  proposalKind: number;
  description: string;
  actionValueWei: string;
  liveQuoteWei: string;
  innerCalldata: Hex;
  broadcastCalldata: Hex;
  createProposalCalldata: Hex;
  proposalCountBefore: string;
  expectedProposalId: string;
  feeWei: string;
  before: {
    totalSupplyWei: string;
    proposerDcWei: string;
    treasuryDcWei: string;
    allowanceWei: string;
  };
  actions: Partial<
    Record<
      "cancelOldProposal" | "mintFee" | "approveFee" | "createProposal",
      ActionReceipt
    >
  >;
  proposalId?: string;
  verification?: Record<string, unknown>;
};

const ROOT = process.cwd();
const REPLACE_PROPOSAL_14 = process.argv.includes("--replace-14");
const OUTPUT_FILE = join(
  ROOT,
  "deployments",
  REPLACE_PROPOSAL_14
    ? "ccip-v2-mainnet-stage4-canary-proposal-v2.json"
    : "ccip-v2-mainnet-stage4-canary-proposal.json"
);
const deployment = JSON.parse(
  readFileSync(join(ROOT, "deployments", "eth-mainnet-1.json"), "utf8")
) as EthDeployment;
const crossChain = JSON.parse(
  readFileSync(join(ROOT, "deployments", "mainnet-cross-chain.json"), "utf8")
) as CrossChainDeployment;
const stage1 = JSON.parse(
  readFileSync(join(ROOT, "deployments", "ccip-v2-mainnet-stage1.json"), "utf8")
) as Stage1State;
const stage2 = JSON.parse(
  readFileSync(join(ROOT, "deployments", "ccip-v2-mainnet-stage2.json"), "utf8")
) as Stage2State;
const stage4 = JSON.parse(
  readFileSync(
    join(ROOT, "deployments", "ccip-v2-mainnet-stage4-cutover.json"),
    "utf8"
  )
) as Stage4CutoverState;

const ETH_RPC =
  process.env.ETH_MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com";
const BSC_RPC =
  process.env.BSC_MAINNET_RPC_URL || "https://bsc-dataseed.binance.org";
const MAJOR = 2;
const PENDING = 1;
const EXECUTED = 6;
const PROPOSAL_13 = 13n;
const PROPOSAL_14 = 14n;
const CANCELED = 5;
const LZ_GAS = 500_000n;
const ACTION_VALUE = parseEther("0.002");
const EXPECTED_FEE = parseEther("1000");
const POLICY_MAX_VALUE = parseEther("0.01");
const BROADCAST_SELECTOR = toFunctionSelector(
  "broadcast(uint32[],address[],bytes,uint128)"
);
const INNER_SELECTOR = toFunctionSelector("setDealImplementation(address)");
const SCOPE = REPLACE_PROPOSAL_14
  ? "cancel pending proposal #14, mint and spend one exact 1000 DC Major proposal fee, then create the same zero-business-change V2 canary with a short Chinese title and body; no stake, execute or broadcast"
  : "mint and spend one exact 1000 DC Major proposal fee, then create only a zero-business-change V2 cross-chain canary proposal; no stake, execute, broadcast, implementation change, V1 disable or bridge config write";

const governanceAbi = parseAbi([
  "function treasury() view returns (address)",
  "function dcToken() view returns (address)",
  "function policyRegistry() view returns (address)",
  "function majorProposalFee() view returns (uint256)",
  "function proposalCount() view returns (uint256)",
  "function state(uint256 proposalId) view returns (uint8)",
  "function getProposal(uint256 proposalId) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description))",
  "function getActions(uint256 proposalId) view returns (address[] targets,uint256[] values,bytes[] calldatas)",
  "function createProposal(address[] targets,uint256[] values,bytes[] calldatas,string description,uint8 kind) returns (uint256)",
  "function cancel(uint256 proposalId)",
]);
const registryAbi = parseAbi([
  "function governance() view returns (address)",
  "function getRule(uint8 kind,address target,bytes4 selector) view returns ((bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue))",
  "function isActionAllowed(uint8 kind,address target,uint256 value,bytes data) view returns (bool)",
]);
const dcAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function mint(address to,uint256 amount)",
  "function MINTER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
]);
const broadcasterAbi = parseAbi([
  "function governance() view returns (address)",
  "function broadcastNonce() view returns (uint256)",
  "function chains(uint32 chainId) view returns (uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
  "function quoteFees(uint32[] targetChainIds,address[] targets,bytes data,uint128 lzGas) view returns (uint256)",
  "function broadcast(uint32[] targetChainIds,address[] targets,bytes data,uint128 lzGas)",
]);
const factoryAbi = parseAbi([
  "function crossChainGovernance() view returns (address)",
  "function dealImplementation() view returns (address)",
  "function setDealImplementation(address impl)",
]);

function privateKey(): Hex {
  for (const name of ["ETH_MAINNET_PRIVATE_KEY", "AGIKING_PRIVATE_KEY"]) {
    const raw = process.env[name]?.trim();
    if (raw) return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  }
  throw new Error("Missing ETH_MAINNET_PRIVATE_KEY or AGIKING_PRIVATE_KEY");
}

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function sameHex(a: Hex, b: Hex): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function save(state: ProposalStateFile) {
  state.updatedAt = new Date().toISOString();
  writeFileSync(OUTPUT_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function nonceState(client: PublicClient, address: Address) {
  const [latest, pending] = await Promise.all([
    client.getTransactionCount({ address, blockTag: "latest" }),
    client.getTransactionCount({ address, blockTag: "pending" }),
  ]);
  return { latest, pending };
}

async function assertNoPending(
  client: PublicClient,
  address: Address,
  label: string
) {
  const nonces = await nonceState(client, address);
  if (nonces.latest !== nonces.pending) {
    throw new Error(
      `${label} has pending transactions: ${nonces.latest}/${nonces.pending}`
    );
  }
  return nonces.pending;
}

async function requireCode(
  client: PublicClient,
  address: Address,
  label: string
) {
  const code = await client.getCode({ address });
  if (!code || code === "0x") throw new Error(`${label} has no runtime code`);
}

function assertOuterMajorRule(
  rule: any
) {
  const allowed = Boolean(rule.allowed ?? rule[0]);
  const validateNestedBroadcast = Boolean(
    rule.validateNestedBroadcast ?? rule[1]
  );
  const nestedOnly = Boolean(rule.nestedOnly ?? rule[2]);
  const maxValue = BigInt(rule.maxValue ?? rule[3]);
  if (
    !allowed ||
    !validateNestedBroadcast ||
    nestedOnly ||
    maxValue !== POLICY_MAX_VALUE
  ) {
    throw new Error("V2 Broadcaster Major rule mismatch");
  }
}

function assertInnerMajorRule(
  rule: any
) {
  const allowed = Boolean(rule.allowed ?? rule[0]);
  const validateNestedBroadcast = Boolean(
    rule.validateNestedBroadcast ?? rule[1]
  );
  const nestedOnly = Boolean(rule.nestedOnly ?? rule[2]);
  const maxValue = BigInt(rule.maxValue ?? rule[3]);
  if (
    !allowed ||
    validateNestedBroadcast ||
    !nestedOnly ||
    maxValue !== 0n
  ) {
    throw new Error("BSC Factory setDealImplementation Major rule mismatch");
  }
}

async function findExactDuplicate(
  client: PublicClient,
  governance: Address,
  broadcaster: Address,
  actionValue: bigint,
  broadcastData: Hex,
  proposalCount: bigint
) {
  for (let id = 1n; id <= proposalCount; ++id) {
    const [targets, values, calldatas] = await client.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "getActions",
      args: [id],
    });
    if (
      targets.length === 1 &&
      values.length === 1 &&
      calldatas.length === 1 &&
      sameAddress(targets[0], broadcaster) &&
      values[0] === actionValue &&
      sameHex(calldatas[0], broadcastData)
    ) {
      return id;
    }
  }
  return undefined;
}

async function mainRun() {
  const preflightOnly = process.argv.includes("--preflight");
  const writeGateOpen = REPLACE_PROPOSAL_14
    ? process.env.CCIP_V2_STAGE4_CANARY_REPROPOSE === "1"
    : process.env.CCIP_V2_STAGE4_CANARY_PROPOSE === "1";
  if (!writeGateOpen && !preflightOnly) {
    throw new Error(
      REPLACE_PROPOSAL_14
        ? "Write gate closed: set CCIP_V2_STAGE4_CANARY_REPROPOSE=1 only after exact cancel/mint/approve/reproposal authorization"
        : "Write gate closed: set CCIP_V2_STAGE4_CANARY_PROPOSE=1 only after exact fee-mint/approve/proposal authorization"
    );
  }
  if (
    deployment.chainId !== 1 ||
    stage1.stage !== "both_deployed" ||
    !stage1.eth.verified ||
    !stage1.bsc.verified ||
    stage2.stage !== "complete" ||
    stage4.stage !== "complete"
  ) {
    throw new Error("Verified stage 1/2/4A records are required");
  }

  const proposer = getAddress(
    privateKeyToAccount(privateKey()).address
  );
  const expectedProposer = getAddress(deployment.deployer);
  const governance = getAddress(deployment.addresses.dealGovernance);
  const registry = getAddress(deployment.addresses.governancePolicyRegistry);
  const dc = getAddress(deployment.addresses.dlToken);
  const treasury = getAddress(deployment.addresses.protocolTreasury);
  const oldBroadcaster = getAddress(crossChain.eth.broadcaster);
  const newBroadcaster = getAddress(stage1.eth.address);
  const oldExecutor = getAddress(crossChain.bsc.executor);
  const newExecutor = getAddress(stage1.bsc.address);
  const bscFactory = getAddress(crossChain.params.bscDealFactory);
  const bscChainKey = crossChain.params.bscChainKey;

  if (
    !sameAddress(proposer, expectedProposer) ||
    !sameAddress(stage2.broadcaster, newBroadcaster) ||
    !sameAddress(stage2.executor, newExecutor) ||
    !sameAddress(stage4.broadcaster, newBroadcaster) ||
    !sameAddress(stage4.executor, newExecutor) ||
    !sameAddress(stage4.bscFactory, bscFactory)
  ) {
    throw new Error("Signer or stage address mismatch");
  }

  const account = privateKeyToAccount(privateKey());
  const ethPublic = createPublicClient({
    chain: mainnet,
    transport: http(ETH_RPC),
  });
  const bscPublic = createPublicClient({
    chain: bsc,
    transport: http(BSC_RPC),
  });
  const wallet = createWalletClient({
    account,
    chain: mainnet,
    transport: http(ETH_RPC),
  });
  if ((await ethPublic.getChainId()) !== 1) {
    throw new Error("ETH RPC is not mainnet");
  }
  if ((await bscPublic.getChainId()) !== 56) {
    throw new Error("BSC RPC is not mainnet");
  }

  await Promise.all([
    requireCode(ethPublic, governance, "DealGovernance"),
    requireCode(ethPublic, registry, "GovernancePolicyRegistry"),
    requireCode(ethPublic, dc, "DC"),
    requireCode(ethPublic, newBroadcaster, "V2 Broadcaster"),
    requireCode(bscPublic, newExecutor, "V2 Executor"),
    requireCode(bscPublic, bscFactory, "BSC DealFactory"),
  ]);

  const [
    governanceTreasury,
    governanceDc,
    governanceRegistry,
    registryGovernance,
    broadcasterGovernance,
    broadcastNonce,
    route,
    factoryController,
    bscDealImplementation,
    majorFee,
    proposalCount,
    proposal13State,
    minterRole,
    totalSupply,
    proposerDc,
    allowance,
    treasuryDc,
    proposerEth,
    governanceEth,
    nonces,
  ] = await Promise.all([
    ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "treasury",
    }),
    ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "dcToken",
    }),
    ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "policyRegistry",
    }),
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "governance",
    }),
    ethPublic.readContract({
      address: newBroadcaster,
      abi: broadcasterAbi,
      functionName: "governance",
    }),
    ethPublic.readContract({
      address: newBroadcaster,
      abi: broadcasterAbi,
      functionName: "broadcastNonce",
    }),
    ethPublic.readContract({
      address: newBroadcaster,
      abi: broadcasterAbi,
      functionName: "chains",
      args: [bscChainKey],
    }),
    bscPublic.readContract({
      address: bscFactory,
      abi: factoryAbi,
      functionName: "crossChainGovernance",
    }),
    bscPublic.readContract({
      address: bscFactory,
      abi: factoryAbi,
      functionName: "dealImplementation",
    }),
    ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "majorProposalFee",
    }),
    ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "proposalCount",
    }),
    ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "state",
      args: [PROPOSAL_13],
    }),
    ethPublic.readContract({
      address: dc,
      abi: dcAbi,
      functionName: "MINTER_ROLE",
    }),
    ethPublic.readContract({
      address: dc,
      abi: dcAbi,
      functionName: "totalSupply",
    }),
    ethPublic.readContract({
      address: dc,
      abi: dcAbi,
      functionName: "balanceOf",
      args: [proposer],
    }),
    ethPublic.readContract({
      address: dc,
      abi: dcAbi,
      functionName: "allowance",
      args: [proposer, governance],
    }),
    ethPublic.readContract({
      address: dc,
      abi: dcAbi,
      functionName: "balanceOf",
      args: [treasury],
    }),
    ethPublic.getBalance({ address: proposer }),
    ethPublic.getBalance({ address: governance }),
    nonceState(ethPublic, proposer),
  ]);

  const hasMinterRole = await ethPublic.readContract({
    address: dc,
    abi: dcAbi,
    functionName: "hasRole",
    args: [minterRole, proposer],
  });

  if (
    !sameAddress(governanceTreasury, treasury) ||
    !sameAddress(governanceDc, dc) ||
    !sameAddress(governanceRegistry, registry) ||
    !sameAddress(registryGovernance, governance) ||
    !sameAddress(broadcasterGovernance, governance)
  ) {
    throw new Error("Governance/Registry/DC/Broadcaster wiring mismatch");
  }
  if (
    !route[6] ||
    !sameAddress(factoryController, newExecutor) ||
    broadcastNonce !== 0n ||
    proposal13State !== EXECUTED
  ) {
    throw new Error(
      "Stage 4A live state mismatch: route/controller/nonce/proposal13"
    );
  }
  if (
    majorFee !== EXPECTED_FEE ||
    !hasMinterRole ||
    nonces.latest !== nonces.pending ||
    proposerEth < parseEther("0.005") ||
    governanceEth < ACTION_VALUE
  ) {
    throw new Error("Fee/signer/nonce/native-balance preflight failed");
  }

  const description = REPLACE_PROPOSAL_14
    ? `跨链 V2 通道测试\n\n` +
      `本提案只测试 ETH DAO 能否通过新的跨链通道向 BSC 发送一条治理消息。` +
      `BSC 收到后，会把 Deal 实现地址设置为当前相同的地址，因此不会发生升级，` +
      `不改参数、不转账、不铸币、不动国库，业务影响为 0。` +
      `本次测试验证 LayerZero、Chainlink CCIP 和 Axelar 三条通道及 2/3 确认机制。` +
      `执行最多使用 0.002 ETH 跨链费用，未使用部分退回 DAO。`
    : `TEST ONLY - ETH to BSC CCIP V2 Major zero-business-change canary. ` +
      `This proposal sends exactly one governance message through CrossChainBroadcasterV2 ${newBroadcaster} ` +
      `to BSC DealFactory ${bscFactory} and calls setDealImplementation(${bscDealImplementation}), ` +
      `which exactly equals the current BSC dealImplementation value at proposal creation. ` +
      `Purpose: verify the production LayerZero, Chainlink CCIP and Axelar paths, 2-of-3 confirmation aggregation, ` +
      `Major nested-policy validation, source and target authorization, and one-time BSC execution. ` +
      `Expected business impact: zero. The proposal action does not change the implementation address, perform a proxy upgrade, ` +
      `transfer or mint tokens, move Treasury funds, change business parameters, disable V1 policies, or call any other target. ` +
      `Maximum bridge fee budget is 0.002 ETH; the broadcaster refunds unused value to the DAO.`;
  const innerData = encodeFunctionData({
    abi: factoryAbi,
    functionName: "setDealImplementation",
    args: [bscDealImplementation],
  });
  const broadcastData = encodeFunctionData({
    abi: broadcasterAbi,
    functionName: "broadcast",
    args: [[bscChainKey], [bscFactory], innerData, LZ_GAS],
  });
  const createProposalData = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [
      [newBroadcaster],
      [ACTION_VALUE],
      [broadcastData],
      description,
      MAJOR,
    ],
  });
  const actionsHash = keccak256(
    encodeAbiParameters(
      [
        { type: "address[]" },
        { type: "uint256[]" },
        { type: "bytes[]" },
      ],
      [[newBroadcaster], [ACTION_VALUE], [broadcastData]]
    )
  );

  const [liveQuote, outerRule, innerRule, actionAllowed] = await Promise.all([
    ethPublic.readContract({
      address: newBroadcaster,
      abi: broadcasterAbi,
      functionName: "quoteFees",
      args: [[bscChainKey], [bscFactory], innerData, LZ_GAS],
    }),
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, newBroadcaster, BROADCAST_SELECTOR],
    }),
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, bscFactory, INNER_SELECTOR],
    }),
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "isActionAllowed",
      args: [MAJOR, newBroadcaster, ACTION_VALUE, broadcastData],
    }),
  ]);
  assertOuterMajorRule(outerRule);
  assertInnerMajorRule(innerRule);
  if (!actionAllowed) throw new Error("Exact Major canary action is not allowed");
  if (liveQuote <= 0n || liveQuote > ACTION_VALUE) {
    throw new Error(
      `Live quote ${liveQuote} exceeds action value ${ACTION_VALUE}`
    );
  }

  const duplicate = await findExactDuplicate(
    ethPublic,
    governance,
    newBroadcaster,
    ACTION_VALUE,
    broadcastData,
    proposalCount
  );
  if (
    duplicate !== undefined &&
    !(REPLACE_PROPOSAL_14 && duplicate === PROPOSAL_14)
  ) {
    throw new Error(`Exact canary action already exists as proposal #${duplicate}`);
  }
  if (REPLACE_PROPOSAL_14) {
    if (proposalCount !== PROPOSAL_14 || duplicate !== PROPOSAL_14) {
      throw new Error("Replacement requires proposal #14 to be the exact live canary");
    }
    const oldState = await ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "state",
      args: [PROPOSAL_14],
    });
    if (oldState !== PENDING && oldState !== CANCELED) {
      throw new Error(`Proposal #14 cannot be replaced from state ${oldState}`);
    }
  }

  const freshStart = !existsSync(OUTPUT_FILE);
  if (freshStart && (proposerDc !== 0n || allowance !== 0n)) {
    throw new Error(
      `Fresh exact-fee flow requires proposer DC/allowance 0/0, got ${proposerDc}/${allowance}`
    );
  }

  const summary = {
    blocks: {
      ethereum: (await ethPublic.getBlockNumber()).toString(),
      bsc: (await bscPublic.getBlockNumber()).toString(),
    },
    proposer,
    nonce: nonces.pending,
    proposalCount: proposalCount.toString(),
    expectedProposalId: (proposalCount + 1n).toString(),
    proposalKind: "Major (2)",
    bscDealImplementation,
    routeActive: route[6],
    factoryController,
    broadcastNonce: broadcastNonce.toString(),
    liveQuoteWei: liveQuote.toString(),
    actionValueWei: ACTION_VALUE.toString(),
    majorFeeWei: majorFee.toString(),
    proposerDcWei: proposerDc.toString(),
    allowanceWei: allowance.toString(),
    totalSupplyWei: totalSupply.toString(),
    treasuryDcWei: treasuryDc.toString(),
    proposerEth: formatEther(proposerEth),
    governanceEth: formatEther(governanceEth),
    hasMinterRole,
    actionAllowed,
    description,
    replacement: REPLACE_PROPOSAL_14
      ? {
          oldProposalId: PROPOSAL_14.toString(),
          oldProposalWillBeCanceled: true,
        }
      : undefined,
    innerData,
    broadcastData,
    createProposalData,
  };

  if (preflightOnly) {
    console.log(JSON.stringify(summary, null, 2));
    console.log("Stage-4B read-only preflight passed.");
    console.log("No transaction was signed or sent.");
    return;
  }

  let state: ProposalStateFile;
  if (existsSync(OUTPUT_FILE)) {
    state = JSON.parse(
      readFileSync(OUTPUT_FILE, "utf8")
    ) as ProposalStateFile;
    if (
      !sameAddress(state.proposer, proposer) ||
      !sameAddress(state.governance, governance) ||
      !sameAddress(state.newBroadcaster, newBroadcaster) ||
      !sameAddress(state.bscFactory, bscFactory) ||
      !sameAddress(state.bscDealImplementation, bscDealImplementation) ||
      state.actionValueWei !== ACTION_VALUE.toString() ||
      state.feeWei !== EXPECTED_FEE.toString() ||
      state.description !== description ||
      !sameHex(state.broadcastCalldata, broadcastData)
    ) {
      throw new Error("Existing stage-4B record differs from exact plan");
    }
  } else {
    state = {
      schemaVersion: 1,
      scope: SCOPE,
      stage: "prepared",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      proposer,
      governance,
      registry,
      dc,
      oldBroadcaster,
      newBroadcaster,
      oldExecutor,
      newExecutor,
      bscFactory,
      bscDealImplementation,
      proposalKind: MAJOR,
      description,
      actionValueWei: ACTION_VALUE.toString(),
      liveQuoteWei: liveQuote.toString(),
      innerCalldata: innerData,
      broadcastCalldata: broadcastData,
      createProposalCalldata: createProposalData,
      proposalCountBefore: proposalCount.toString(),
      expectedProposalId: (proposalCount + 1n).toString(),
      feeWei: EXPECTED_FEE.toString(),
      before: {
        totalSupplyWei: totalSupply.toString(),
        proposerDcWei: proposerDc.toString(),
        treasuryDcWei: treasuryDc.toString(),
        allowanceWei: allowance.toString(),
      },
      actions: {},
    };
    save(state);
  }

  const initialSupply = BigInt(state.before.totalSupplyWei);
  const initialTreasury = BigInt(state.before.treasuryDcWei);
  const expectedProposalId = BigInt(state.expectedProposalId);

  if (REPLACE_PROPOSAL_14) {
    let oldState = await ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "state",
      args: [PROPOSAL_14],
    });
    if (!state.actions.cancelOldProposal) {
      if (oldState !== PENDING) {
        throw new Error(`Proposal #14 is not Pending before cancellation: ${oldState}`);
      }
      const nonce = await assertNoPending(ethPublic, proposer, "ETH signer");
      const simulation = await ethPublic.simulateContract({
        account,
        address: governance,
        abi: governanceAbi,
        functionName: "cancel",
        args: [PROPOSAL_14],
      });
      const txHash = await wallet.writeContract(simulation.request);
      state.stage = "old_proposal_cancel_submitted";
      state.actions.cancelOldProposal = { nonce, txHash };
      save(state);
      console.log(`Proposal #14 cancellation submitted: ${txHash}`);
    }
    if (!state.actions.cancelOldProposal.verified) {
      const receipt = await ethPublic.waitForTransactionReceipt({
        hash: state.actions.cancelOldProposal.txHash,
        confirmations: 2,
        timeout: 180_000,
      });
      if (receipt.status !== "success") {
        throw new Error("Proposal #14 cancellation reverted");
      }
      state.stage = "old_proposal_canceled";
      state.actions.cancelOldProposal.blockNumber = receipt.blockNumber.toString();
      state.actions.cancelOldProposal.verified = true;
      save(state);
    }
    oldState = await ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "state",
      args: [PROPOSAL_14],
    });
    if (oldState !== CANCELED) {
      throw new Error(`Proposal #14 cancellation state mismatch: ${oldState}`);
    }
  }

  let currentProposerDc = await ethPublic.readContract({
    address: dc,
    abi: dcAbi,
    functionName: "balanceOf",
    args: [proposer],
  });
  let currentSupply = await ethPublic.readContract({
    address: dc,
    abi: dcAbi,
    functionName: "totalSupply",
  });
  if (!state.actions.mintFee) {
    if (currentProposerDc !== 0n || currentSupply !== initialSupply) {
      throw new Error("Unexpected DC state before exact fee mint");
    }
    const nonce = await assertNoPending(ethPublic, proposer, "ETH signer");
    const simulation = await ethPublic.simulateContract({
      account,
      address: dc,
      abi: dcAbi,
      functionName: "mint",
      args: [proposer, EXPECTED_FEE],
    });
    const txHash = await wallet.writeContract(simulation.request);
    state.stage = "fee_mint_submitted";
    state.actions.mintFee = { nonce, txHash };
    save(state);
    console.log(`Exact 1000 DC fee mint submitted: ${txHash}`);
  }
  if (!state.actions.mintFee.verified) {
    const receipt = await ethPublic.waitForTransactionReceipt({
      hash: state.actions.mintFee.txHash,
      confirmations: 2,
      timeout: 180_000,
    });
    if (receipt.status !== "success") throw new Error("Fee mint reverted");
    state.stage = "fee_minted";
    state.actions.mintFee.blockNumber = receipt.blockNumber.toString();
    state.actions.mintFee.verified = true;
    save(state);
  }
  [currentProposerDc, currentSupply] = await Promise.all([
    ethPublic.readContract({
      address: dc,
      abi: dcAbi,
      functionName: "balanceOf",
      args: [proposer],
    }),
    ethPublic.readContract({
      address: dc,
      abi: dcAbi,
      functionName: "totalSupply",
    }),
  ]);
  if (
    currentProposerDc !== EXPECTED_FEE ||
    currentSupply !== initialSupply + EXPECTED_FEE
  ) {
    throw new Error("Exact fee mint post-state mismatch");
  }

  let currentAllowance = await ethPublic.readContract({
    address: dc,
    abi: dcAbi,
    functionName: "allowance",
    args: [proposer, governance],
  });
  if (!state.actions.approveFee) {
    if (currentAllowance !== 0n) {
      throw new Error(`Unexpected allowance before approval: ${currentAllowance}`);
    }
    const nonce = await assertNoPending(ethPublic, proposer, "ETH signer");
    const simulation = await ethPublic.simulateContract({
      account,
      address: dc,
      abi: dcAbi,
      functionName: "approve",
      args: [governance, EXPECTED_FEE],
    });
    const txHash = await wallet.writeContract(simulation.request);
    state.stage = "fee_approval_submitted";
    state.actions.approveFee = { nonce, txHash };
    save(state);
    console.log(`Exact 1000 DC fee approval submitted: ${txHash}`);
  }
  if (!state.actions.approveFee.verified) {
    const receipt = await ethPublic.waitForTransactionReceipt({
      hash: state.actions.approveFee.txHash,
      confirmations: 2,
      timeout: 180_000,
    });
    if (receipt.status !== "success") throw new Error("Fee approval reverted");
    state.stage = "fee_approved";
    state.actions.approveFee.blockNumber = receipt.blockNumber.toString();
    state.actions.approveFee.verified = true;
    save(state);
  }
  currentAllowance = await ethPublic.readContract({
    address: dc,
    abi: dcAbi,
    functionName: "allowance",
    args: [proposer, governance],
  });
  if (currentAllowance !== EXPECTED_FEE) {
    throw new Error("Exact fee allowance mismatch");
  }

  const countBeforeWrite = await ethPublic.readContract({
    address: governance,
    abi: governanceAbi,
    functionName: "proposalCount",
  });
  if (!state.actions.createProposal && countBeforeWrite !== expectedProposalId - 1n) {
    throw new Error(
      `proposalCount changed before creation: ${countBeforeWrite}`
    );
  }
  if (!state.actions.createProposal) {
    const refreshedQuote = await ethPublic.readContract({
      address: newBroadcaster,
      abi: broadcasterAbi,
      functionName: "quoteFees",
      args: [[bscChainKey], [bscFactory], innerData, LZ_GAS],
    });
    if (refreshedQuote <= 0n || refreshedQuote > ACTION_VALUE) {
      throw new Error(`Refreshed quote outside action budget: ${refreshedQuote}`);
    }
    const nonce = await assertNoPending(ethPublic, proposer, "ETH signer");
    const simulation = await ethPublic.simulateContract({
      account,
      address: governance,
      abi: governanceAbi,
      functionName: "createProposal",
      args: [
        [newBroadcaster],
        [ACTION_VALUE],
        [broadcastData],
        description,
        MAJOR,
      ],
    });
    const txHash = await wallet.writeContract(simulation.request);
    state.stage = "proposal_submitted";
    state.liveQuoteWei = refreshedQuote.toString();
    state.actions.createProposal = { nonce, txHash };
    save(state);
    console.log(`Major zero-change canary proposal submitted: ${txHash}`);
  }
  if (!state.actions.createProposal.verified) {
    const receipt = await ethPublic.waitForTransactionReceipt({
      hash: state.actions.createProposal.txHash,
      confirmations: 2,
      timeout: 180_000,
    });
    if (receipt.status !== "success") throw new Error("Proposal creation reverted");
    state.actions.createProposal.blockNumber = receipt.blockNumber.toString();
    state.actions.createProposal.verified = true;
    save(state);
  }

  const [
    proposalCountAfter,
    proposalState,
    proposal,
    actions,
    proposerDcAfter,
    allowanceAfter,
    treasuryAfter,
    supplyAfter,
    nonceAfter,
    routeAfter,
    controllerAfter,
    implementationAfter,
  ] = await Promise.all([
    ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "proposalCount",
    }),
    ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "state",
      args: [expectedProposalId],
    }),
    ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "getProposal",
      args: [expectedProposalId],
    }),
    ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "getActions",
      args: [expectedProposalId],
    }),
    ethPublic.readContract({
      address: dc,
      abi: dcAbi,
      functionName: "balanceOf",
      args: [proposer],
    }),
    ethPublic.readContract({
      address: dc,
      abi: dcAbi,
      functionName: "allowance",
      args: [proposer, governance],
    }),
    ethPublic.readContract({
      address: dc,
      abi: dcAbi,
      functionName: "balanceOf",
      args: [treasury],
    }),
    ethPublic.readContract({
      address: dc,
      abi: dcAbi,
      functionName: "totalSupply",
    }),
    ethPublic.readContract({
      address: newBroadcaster,
      abi: broadcasterAbi,
      functionName: "broadcastNonce",
    }),
    ethPublic.readContract({
      address: newBroadcaster,
      abi: broadcasterAbi,
      functionName: "chains",
      args: [bscChainKey],
    }),
    bscPublic.readContract({
      address: bscFactory,
      abi: factoryAbi,
      functionName: "crossChainGovernance",
    }),
    bscPublic.readContract({
      address: bscFactory,
      abi: factoryAbi,
      functionName: "dealImplementation",
    }),
  ]);

  if (
    proposalCountAfter !== expectedProposalId ||
    proposalState !== PENDING ||
    !sameAddress(proposal.proposer, proposer) ||
    proposal.kind !== MAJOR ||
    proposal.totalStaked !== 0n ||
    proposal.windowEndsAt !== 0n ||
    proposal.vetoed ||
    proposal.canceled ||
    proposal.executed ||
    proposal.actionsHash !== actionsHash ||
    proposal.description !== description
  ) {
    throw new Error("Created proposal metadata/state mismatch");
  }
  if (
    actions[0].length !== 1 ||
    actions[1].length !== 1 ||
    actions[2].length !== 1 ||
    !sameAddress(actions[0][0], newBroadcaster) ||
    actions[1][0] !== ACTION_VALUE ||
    !sameHex(actions[2][0], broadcastData)
  ) {
    throw new Error("Created proposal action mismatch");
  }
  if (
    proposerDcAfter !== 0n ||
    allowanceAfter !== 0n ||
    treasuryAfter !== initialTreasury + EXPECTED_FEE ||
    supplyAfter !== initialSupply + EXPECTED_FEE ||
    nonceAfter !== 0n ||
    !routeAfter[6] ||
    !sameAddress(controllerAfter, newExecutor) ||
    !sameAddress(implementationAfter, bscDealImplementation)
  ) {
    throw new Error("Post-proposal safety invariant mismatch");
  }

  if (REPLACE_PROPOSAL_14) {
    const record = state.actions.cancelOldProposal;
    if (!record) throw new Error("Missing cancelOldProposal record");
    const [tx, receipt] = await Promise.all([
      ethPublic.getTransaction({ hash: record.txHash }),
      ethPublic.getTransactionReceipt({ hash: record.txHash }),
    ]);
    const cancelData = encodeFunctionData({
      abi: governanceAbi,
      functionName: "cancel",
      args: [PROPOSAL_14],
    });
    if (
      !sameAddress(tx.from, proposer) ||
      !tx.to ||
      !sameAddress(tx.to, governance) ||
      !sameHex(tx.input, cancelData) ||
      tx.value !== 0n ||
      receipt.status !== "success"
    ) {
      throw new Error("cancelOldProposal independent transaction verification failed");
    }
  }

  for (const [key, address, data] of [
    [
      "mintFee",
      dc,
      encodeFunctionData({
        abi: dcAbi,
        functionName: "mint",
        args: [proposer, EXPECTED_FEE],
      }),
    ],
    [
      "approveFee",
      dc,
      encodeFunctionData({
        abi: dcAbi,
        functionName: "approve",
        args: [governance, EXPECTED_FEE],
      }),
    ],
    ["createProposal", governance, createProposalData],
  ] as const) {
    const record = state.actions[key];
    if (!record) throw new Error(`Missing ${key} record`);
    const tx = await ethPublic.getTransaction({ hash: record.txHash });
    const receipt = await ethPublic.getTransactionReceipt({
      hash: record.txHash,
    });
    if (
      !sameAddress(tx.from, proposer) ||
      !tx.to ||
      !sameAddress(tx.to, address) ||
      !sameHex(tx.input, data) ||
      tx.value !== 0n ||
      receipt.status !== "success"
    ) {
      throw new Error(`${key} independent transaction verification failed`);
    }
  }

  state.stage = "proposal_created";
  state.proposalId = expectedProposalId.toString();
  state.verification = {
    proposalState: "Pending (1)",
    proposalKind: "Major (2)",
    totalStakedWei: proposal.totalStaked.toString(),
    windowEndsAt: proposal.windowEndsAt.toString(),
    executed: proposal.executed,
    actionTarget: actions[0][0],
    actionValueWei: actions[1][0].toString(),
    bscDealImplementationBeforeAndAfter: bscDealImplementation,
    routeActive: routeAfter[6],
    factoryController: controllerAfter,
    broadcastNonce: nonceAfter.toString(),
    dcSupplyIncreaseWei: EXPECTED_FEE.toString(),
    feeCreditedToTreasuryWei: EXPECTED_FEE.toString(),
    proposerDcAfterWei: proposerDcAfter.toString(),
    allowanceAfterWei: allowanceAfter.toString(),
    stakeNotSent: true,
    executeNotSent: true,
    broadcastNotSent: true,
    replacedProposalId: REPLACE_PROPOSAL_14
      ? PROPOSAL_14.toString()
      : undefined,
    replacedProposalState: REPLACE_PROPOSAL_14
      ? "Canceled (5)"
      : undefined,
  };
  save(state);

  console.log(JSON.stringify(state, null, 2));
  console.log("Stage-4B Major canary proposal creation complete.");
  console.log("No stake, execute or broadcast transaction was sent.");
}

mainRun().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
