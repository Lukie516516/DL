/**
 * Production CCIP V1 retirement stage 1.
 *
 * Authorized scope only:
 *   1. BSC V1 Executor revokes BSC DealFactory.
 *   2. BSC V1 Executor revokes the legacy test Probe.
 *   3. ETH V1 Broadcaster pauses the BSC route.
 *   4. BSC V2 Executor revokes the V2 upgrade-test Probe.
 *   5. ETH proposer mints and approves exactly one current Major fee.
 *   6. ETH proposer creates one Major policy-cleanup proposal.
 *
 * There is deliberately no stake, proposal execution, cross-chain broadcast,
 * contract upgrade, Treasury transfer, Git commit, or Git push path.
 *
 * Read-only preflight:
 *   node --import tsx/esm scripts/execute-mainnet-ccip-v1-retirement-stage1.ts --preflight
 *
 * Explicit write gate:
 *   CCIP_V1_RETIREMENT_STAGE1_CONFIRM=EXECUTE_OWNER_CLEANUP_AND_CREATE_MAJOR_NO_STAKE_NO_EXECUTE \
 *     node --import tsx/esm scripts/execute-mainnet-ccip-v1-retirement-stage1.ts
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
  keccak256,
  parseAbi,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, mainnet } from "viem/chains";

type CanonicalDeployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
};

type CrossChainDeployment = {
  eth: { deployer: Address; broadcaster: Address };
  bsc: { deployer: Address; executor: Address };
  params: {
    ethGovernance: Address;
    bscChainKey: number;
    bscDealFactory: Address;
  };
};

type V2Deployment = {
  stage: string;
  eth: { address: Address; verified: boolean };
  bsc: { address: Address; verified: boolean };
};

type GovernanceProbeDeployment = {
  eth: { proxy: Address };
  bsc: { proxy: Address };
};

type UpgradeProbeDeployment = {
  stage: string;
  eth: { proxy: { address: Address } };
  bsc: { proxy: { address: Address } };
};

type Rule = {
  allowed: boolean;
  validateNestedBroadcast: boolean;
  nestedOnly: boolean;
  maxValue: bigint;
};

type RuleInput = Rule & {
  kind: number;
  target: Address;
  selector: Hex;
};

type TxRecord = {
  txHash: Hex;
  chainId: number;
  nonce?: number;
  blockNumber?: string;
  gasUsed?: string;
  verified: boolean;
};

type StageState = {
  schemaVersion: 1;
  scope: string;
  stage:
    | "prepared"
    | "v1_factory_revoked"
    | "v1_probe_revoked"
    | "v1_route_paused"
    | "v2_probe_revoked"
    | "fee_minted"
    | "fee_approved"
    | "proposal_created";
  startedAt: string;
  updatedAt: string;
  proposer: Address;
  governance: Address;
  registry: Address;
  dc: Address;
  treasury: Address;
  oldBroadcaster: Address;
  oldExecutor: Address;
  v2Broadcaster: Address;
  v2Executor: Address;
  bscFactory: Address;
  bscLegacyProbe: Address;
  bscUpgradeProbe: Address;
  proposalCountBefore: string;
  majorFee: string;
  totalSupplyBefore: string;
  treasuryBalanceBefore: string;
  description: string;
  setRulesCalldata: Hex;
  createProposalCalldata: Hex;
  directCalldata: {
    revokeV1Factory: Hex;
    revokeV1Probe: Hex;
    pauseV1Route: Hex;
    revokeV2Probe: Hex;
  };
  actions: {
    revokeV1Factory?: TxRecord;
    revokeV1Probe?: TxRecord;
    pauseV1Route?: TxRecord;
    revokeV2Probe?: TxRecord;
    mintFee?: TxRecord;
    approveFee?: TxRecord;
    createProposal?: TxRecord;
  };
  proposalId?: string;
  verification?: {
    proposalState: string;
    totalStaked: string;
    executed: boolean;
    descriptionMatched: boolean;
    actionsMatched: boolean;
    v1RouteInactive: boolean;
    v2RouteActive: boolean;
    v1FactoryRevoked: boolean;
    v1ProbeRevoked: boolean;
    v2ProbeRevoked: boolean;
    v2FactoryPreserved: boolean;
    cleanupRulesStillActive: number;
    v2RulesPreserved: boolean;
    proposerDcBalance: string;
    proposerAllowance: string;
    totalSupplyDelta: string;
    treasuryBalanceDelta: string;
    noStakeOrExecution: boolean;
  };
};

const ROOT = process.cwd();
const OUTPUT_FILE = join(ROOT, "deployments", "ccip-v1-retirement-stage1.json");
const WRITE_CONFIRM =
  "EXECUTE_OWNER_CLEANUP_AND_CREATE_MAJOR_NO_STAKE_NO_EXECUTE";
const SCOPE =
  "four exact owner cleanup transactions plus one exact Major fee mint/approve and proposal creation; no stake, proposal execution, broadcast, upgrade, commit or push";
const PARAMETER = 0;
const MAJOR = 2;
const PENDING = 1;
const EXPECTED_MAJOR_FEE = parseEther("1000");
const EXPECTED_BROADCAST_MAX_VALUE = parseEther("0.01");
const EXPECTED_SET_RULES_HASH =
  "0x0c92065a29c2404cabd02b223c7d873d9b3939febaff342df7225b980de8b886";
const EXPECTED_CREATE_PROPOSAL_HASH =
  "0xc1ab85c84f59bd716f5ded1945998a3e7f2e2eb4b397a71adc55ad1fd33d8297";
const STALE_V1_MESSAGE_HASH =
  "0xf8f150336a2e72ec5b053eb46835f19c00102484983e9fb94b468af32121012e";
const BROADCAST_SELECTOR = toFunctionSelector(
  "broadcast(uint32[],address[],bytes,uint128)"
);
const MARKER_SELECTOR = toFunctionSelector("recordMarker(bytes32)");
const UPGRADE_SELECTOR = toFunctionSelector("upgradeToAndCall(address,bytes)");
const DESCRIPTION =
  "关闭跨链V1与测试权限\n\n" +
  "本提案只关闭旧 V1 Broadcaster 的 Parameter/Major 广播策略，并关闭 ETH/BSC 无资产测试 Probe 的 marker 和升级策略。" +
  "V2 Broadcaster、V2 Executor、BSC DealFactory、代币、国库和业务参数均不改变；不发送跨链消息，不升级任何业务合约。";

const governanceAbi = parseAbi([
  "function dcToken() view returns (address)",
  "function treasury() view returns (address)",
  "function policyRegistry() view returns (address)",
  "function proposalCount() view returns (uint256)",
  "function majorProposalFee() view returns (uint256)",
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
const oldBroadcasterAbi = parseAbi([
  "function owner() view returns (address)",
  "function governance() view returns (address)",
  "function broadcastNonce() view returns (uint256)",
  "function chains(uint32) view returns (uint32 lzDstEid,uint16 whDstChain,address whDstAddress,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
  "function setChainActive(uint32,bool)",
]);
const v2BroadcasterAbi = parseAbi([
  "function owner() view returns (address)",
  "function governance() view returns (address)",
  "function broadcastNonce() view returns (uint256)",
  "function chains(uint32) view returns (uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
]);
const executorAbi = parseAbi([
  "function owner() view returns (address)",
  "function threshold() view returns (uint256)",
  "function allowedTargets(address) view returns (bool)",
  "function confirmStatus(bytes32) view returns (bool first,bool second,bool third,uint256 count,bool isExecuted)",
  "function setAllowedTarget(address,bool)",
]);
const factoryAbi = parseAbi([
  "function crossChainGovernance() view returns (address)",
]);

loadEnv();

function loadEnv() {
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(
      /\r?\n/
    )) {
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

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2
  );
}

function save(state: StageState) {
  state.updatedAt = new Date().toISOString();
  writeFileSync(OUTPUT_FILE, `${stringify(state)}\n`, "utf8");
}

function sameAddress(a: unknown, b: Address): boolean {
  return String(a).toLowerCase() === b.toLowerCase();
}

function sameHex(a: unknown, b: Hex): boolean {
  return String(a).toLowerCase() === b.toLowerCase();
}

function normalizeRule(value: any): Rule {
  return {
    allowed: Boolean(value.allowed ?? value[0]),
    validateNestedBroadcast: Boolean(value.validateNestedBroadcast ?? value[1]),
    nestedOnly: Boolean(value.nestedOnly ?? value[2]),
    maxValue: BigInt(value.maxValue ?? value[3]),
  };
}

function assertRule(label: string, actual: Rule, expected: Rule) {
  for (const key of [
    "allowed",
    "validateNestedBroadcast",
    "nestedOnly",
    "maxValue",
  ] as const) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `${label}.${key} mismatch: ${String(actual[key])} != ${String(
          expected[key]
        )}`
      );
    }
  }
}

async function assertCode(client: any, label: string, address: Address) {
  const code = await client.getCode({ address });
  if (!code || code === "0x")
    throw new Error(`${label} has no code: ${address}`);
}

async function nonceState(client: any, address: Address) {
  const [latest, pending] = await Promise.all([
    client.getTransactionCount({ address, blockTag: "latest" }),
    client.getTransactionCount({ address, blockTag: "pending" }),
  ]);
  return { latest: Number(latest), pending: Number(pending) };
}

async function verifyTx(
  client: any,
  hash: Hex,
  expectedFrom: Address,
  expectedTo: Address,
  expectedInput: Hex
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
    chainId: await client.getChainId(),
    nonce: tx.nonce,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    verified: true,
  };
}

async function sendExact(
  state: StageState,
  actionKey: keyof StageState["actions"],
  client: any,
  wallet: any,
  signer: Address,
  target: Address,
  data: Hex
): Promise<TxRecord> {
  const existing = state.actions[actionKey];
  let hash: Hex;
  if (existing) {
    hash = existing.txHash;
    console.log(`Resuming ${actionKey}: ${hash}`);
  } else {
    const nonce = await nonceState(client, signer);
    if (nonce.latest !== nonce.pending) {
      throw new Error(`${actionKey}: signer has pending transactions`);
    }
    await client.call({ account: signer, to: target, data, value: 0n });
    hash = await wallet.sendTransaction({
      account: wallet.account,
      to: target,
      data,
      value: 0n,
    });
    state.actions[actionKey] = {
      txHash: hash,
      chainId: await client.getChainId(),
      nonce: nonce.pending,
      verified: false,
    };
    save(state);
    console.log(`Submitted ${actionKey}: ${hash}`);
  }
  const verified = await verifyTx(client, hash, signer, target, data);
  state.actions[actionKey] = verified;
  save(state);
  console.log(
    `Verified ${actionKey}: block=${verified.blockNumber} gas=${verified.gasUsed}`
  );
  return verified;
}

async function findExactProposal(
  client: any,
  governance: Address,
  registry: Address,
  setRulesCalldata: Hex,
  fromId: bigint,
  toId: bigint
): Promise<bigint | undefined> {
  for (let id = fromId; id <= toId; ++id) {
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
      sameAddress(targets[0], registry) &&
      values[0] === 0n &&
      sameHex(calldatas[0], setRulesCalldata)
    ) {
      return id;
    }
  }
  return undefined;
}

async function main() {
  const preflightOnly = process.argv.includes("--preflight");
  const writeEnabled =
    process.env.CCIP_V1_RETIREMENT_STAGE1_CONFIRM === WRITE_CONFIRM;
  if (!preflightOnly && !writeEnabled) {
    throw new Error(
      `Write gate closed: set CCIP_V1_RETIREMENT_STAGE1_CONFIRM=${WRITE_CONFIRM}`
    );
  }

  const ethDeployment = loadJson<CanonicalDeployment>(
    "deployments/eth-mainnet-1.json"
  );
  const bscDeployment = loadJson<CanonicalDeployment>(
    "deployments/bsc-mainnet-56.json"
  );
  const crossChain = loadJson<CrossChainDeployment>(
    "deployments/mainnet-cross-chain.json"
  );
  const v2 = loadJson<V2Deployment>("deployments/ccip-v2-mainnet-stage1.json");
  const legacyProbe = loadJson<GovernanceProbeDeployment>(
    "deployments/governance-probe-mainnet.json"
  );
  const upgradeProbe = loadJson<UpgradeProbeDeployment>(
    "deployments/cross-chain-v2-upgrade-probe-stage1.json"
  );
  if (
    ethDeployment.chainId !== 1 ||
    bscDeployment.chainId !== 56 ||
    v2.stage !== "both_deployed" ||
    !v2.eth.verified ||
    !v2.bsc.verified ||
    upgradeProbe.stage !== "both_deployed"
  ) {
    throw new Error("Canonical production deployment records are not ready");
  }

  const proposer = getAddress(ethDeployment.deployer);
  const bscSignerExpected = getAddress(bscDeployment.deployer);
  const governance = getAddress(ethDeployment.addresses.dealGovernance);
  const registry = getAddress(ethDeployment.addresses.governancePolicyRegistry);
  const dc = getAddress(ethDeployment.addresses.dlToken);
  const treasury = getAddress(ethDeployment.addresses.protocolTreasury);
  const oldBroadcaster = getAddress(crossChain.eth.broadcaster);
  const oldExecutor = getAddress(crossChain.bsc.executor);
  const v2Broadcaster = getAddress(v2.eth.address);
  const v2Executor = getAddress(v2.bsc.address);
  const bscFactory = getAddress(crossChain.params.bscDealFactory);
  const bscLegacyProbe = getAddress(legacyProbe.bsc.proxy);
  const bscUpgradeProbe = getAddress(upgradeProbe.bsc.proxy.address);
  const ethLegacyProbe = getAddress(legacyProbe.eth.proxy);
  const ethUpgradeProbe = getAddress(upgradeProbe.eth.proxy.address);
  const bscChainKey = Number(crossChain.params.bscChainKey);
  const existingState = existsSync(OUTPUT_FILE)
    ? loadJson<StageState>("deployments/ccip-v1-retirement-stage1.json")
    : undefined;

  if (
    !sameAddress(crossChain.eth.deployer, proposer) ||
    !sameAddress(crossChain.bsc.deployer, bscSignerExpected) ||
    !sameAddress(crossChain.params.ethGovernance, governance)
  ) {
    throw new Error("Cross-chain deployment authority record mismatch");
  }

  const ethAccount = privateKeyToAccount(
    privateKey("ETH_MAINNET_PRIVATE_KEY", "AGIKING_PRIVATE_KEY")
  );
  const bscAccount = privateKeyToAccount(
    privateKey("BSC_MAINNET_PRIVATE_KEY", "AGIKING_PRIVATE_KEY")
  );
  if (
    !sameAddress(ethAccount.address, proposer) ||
    !sameAddress(bscAccount.address, bscSignerExpected)
  ) {
    throw new Error("Configured signers do not match deployment records");
  }

  const ethRpc =
    process.env.ETH_MAINNET_RPC_URL?.trim() ||
    "https://ethereum-rpc.publicnode.com";
  const bscRpc =
    process.env.BSC_MAINNET_RPC_URL?.trim() ||
    "https://bsc-mainnet.public.blastapi.io";
  const ethClient = createPublicClient({
    chain: mainnet,
    transport: http(ethRpc, { timeout: 30_000 }),
  });
  const bscClient = createPublicClient({
    chain: bsc,
    transport: http(bscRpc, { timeout: 30_000 }),
  });
  const ethWallet = createWalletClient({
    account: ethAccount,
    chain: mainnet,
    transport: http(ethRpc, { timeout: 30_000 }),
  });
  const bscWallet = createWalletClient({
    account: bscAccount,
    chain: bsc,
    transport: http(bscRpc, { timeout: 30_000 }),
  });

  const rules: RuleInput[] = [
    {
      kind: PARAMETER,
      target: oldBroadcaster,
      selector: BROADCAST_SELECTOR,
      allowed: false,
      validateNestedBroadcast: false,
      nestedOnly: false,
      maxValue: 0n,
    },
    {
      kind: MAJOR,
      target: oldBroadcaster,
      selector: BROADCAST_SELECTOR,
      allowed: false,
      validateNestedBroadcast: false,
      nestedOnly: false,
      maxValue: 0n,
    },
    ...[
      [PARAMETER, ethLegacyProbe, MARKER_SELECTOR],
      [PARAMETER, bscLegacyProbe, MARKER_SELECTOR],
      [MAJOR, ethLegacyProbe, MARKER_SELECTOR],
      [MAJOR, bscLegacyProbe, MARKER_SELECTOR],
      [MAJOR, ethLegacyProbe, UPGRADE_SELECTOR],
      [MAJOR, bscLegacyProbe, UPGRADE_SELECTOR],
      [MAJOR, ethUpgradeProbe, UPGRADE_SELECTOR],
      [MAJOR, bscUpgradeProbe, UPGRADE_SELECTOR],
    ].map(([kind, target, selector]) => ({
      kind: Number(kind),
      target: target as Address,
      selector: selector as Hex,
      allowed: false,
      validateNestedBroadcast: false,
      nestedOnly: false,
      maxValue: 0n,
    })),
  ];
  const setRulesCalldata = encodeFunctionData({
    abi: registryAbi,
    functionName: "setRules",
    args: [rules],
  });
  const createProposalCalldata = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [[registry], [0n], [setRulesCalldata], DESCRIPTION, MAJOR],
  });
  if (
    !sameHex(keccak256(setRulesCalldata), EXPECTED_SET_RULES_HASH) ||
    !sameHex(keccak256(createProposalCalldata), EXPECTED_CREATE_PROPOSAL_HASH)
  ) {
    throw new Error("Retirement calldata hash differs from audited baseline");
  }

  const revokeV1FactoryCalldata = encodeFunctionData({
    abi: executorAbi,
    functionName: "setAllowedTarget",
    args: [bscFactory, false],
  });
  const revokeV1ProbeCalldata = encodeFunctionData({
    abi: executorAbi,
    functionName: "setAllowedTarget",
    args: [bscLegacyProbe, false],
  });
  const pauseV1RouteCalldata = encodeFunctionData({
    abi: oldBroadcasterAbi,
    functionName: "setChainActive",
    args: [bscChainKey, false],
  });
  const revokeV2ProbeCalldata = encodeFunctionData({
    abi: executorAbi,
    functionName: "setAllowedTarget",
    args: [bscUpgradeProbe, false],
  });
  const mintFeeCalldata = encodeFunctionData({
    abi: tokenAbi,
    functionName: "mint",
    args: [proposer, EXPECTED_MAJOR_FEE],
  });
  const approveFeeCalldata = encodeFunctionData({
    abi: tokenAbi,
    functionName: "approve",
    args: [governance, EXPECTED_MAJOR_FEE],
  });

  for (const [label, client, address] of [
    ["DealGovernance", ethClient, governance],
    ["GovernancePolicyRegistry", ethClient, registry],
    ["DC", ethClient, dc],
    ["V1 Broadcaster", ethClient, oldBroadcaster],
    ["V2 Broadcaster", ethClient, v2Broadcaster],
    ["BSC DealFactory", bscClient, bscFactory],
    ["V1 Executor", bscClient, oldExecutor],
    ["V2 Executor", bscClient, v2Executor],
  ] as const) {
    await assertCode(client, label, address);
  }

  const minterRole = await ethClient.readContract({
    address: dc,
    abi: tokenAbi,
    functionName: "MINTER_ROLE",
  });
  const [
    ethChainId,
    bscChainId,
    ethNonce,
    bscNonce,
    nativeEth,
    nativeBnb,
    chainDc,
    chainTreasury,
    chainRegistry,
    registryGovernance,
    majorFee,
    proposalCount,
    canMint,
    paused,
    totalSupply,
    proposerDcBalance,
    proposerAllowance,
    treasuryBalance,
    oldBroadcasterOwner,
    oldBroadcasterGovernance,
    oldRoute,
    v2BroadcasterGovernance,
    v2Route,
    oldExecutorOwner,
    oldThreshold,
    v2ExecutorOwner,
    v2Threshold,
    factoryController,
    oldFactoryAllowed,
    oldProbeAllowed,
    v2FactoryAllowed,
    v2ProbeAllowed,
    staleMessageStatus,
    registryAcceptsAction,
  ] = await Promise.all([
    ethClient.getChainId(),
    bscClient.getChainId(),
    nonceState(ethClient, proposer),
    nonceState(bscClient, bscSignerExpected),
    ethClient.getBalance({ address: proposer }),
    bscClient.getBalance({ address: bscSignerExpected }),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "dcToken",
    }),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "treasury",
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
      address: dc,
      abi: tokenAbi,
      functionName: "hasRole",
      args: [minterRole, proposer],
    }),
    ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "paused",
    }),
    ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "totalSupply",
    }),
    ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [proposer],
    }),
    ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [proposer, governance],
    }),
    ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [treasury],
    }),
    ethClient.readContract({
      address: oldBroadcaster,
      abi: oldBroadcasterAbi,
      functionName: "owner",
    }),
    ethClient.readContract({
      address: oldBroadcaster,
      abi: oldBroadcasterAbi,
      functionName: "governance",
    }),
    ethClient.readContract({
      address: oldBroadcaster,
      abi: oldBroadcasterAbi,
      functionName: "chains",
      args: [bscChainKey],
    }),
    ethClient.readContract({
      address: v2Broadcaster,
      abi: v2BroadcasterAbi,
      functionName: "governance",
    }),
    ethClient.readContract({
      address: v2Broadcaster,
      abi: v2BroadcasterAbi,
      functionName: "chains",
      args: [bscChainKey],
    }),
    bscClient.readContract({
      address: oldExecutor,
      abi: executorAbi,
      functionName: "owner",
    }),
    bscClient.readContract({
      address: oldExecutor,
      abi: executorAbi,
      functionName: "threshold",
    }),
    bscClient.readContract({
      address: v2Executor,
      abi: executorAbi,
      functionName: "owner",
    }),
    bscClient.readContract({
      address: v2Executor,
      abi: executorAbi,
      functionName: "threshold",
    }),
    bscClient.readContract({
      address: bscFactory,
      abi: factoryAbi,
      functionName: "crossChainGovernance",
    }),
    bscClient.readContract({
      address: oldExecutor,
      abi: executorAbi,
      functionName: "allowedTargets",
      args: [bscFactory],
    }),
    bscClient.readContract({
      address: oldExecutor,
      abi: executorAbi,
      functionName: "allowedTargets",
      args: [bscLegacyProbe],
    }),
    bscClient.readContract({
      address: v2Executor,
      abi: executorAbi,
      functionName: "allowedTargets",
      args: [bscFactory],
    }),
    bscClient.readContract({
      address: v2Executor,
      abi: executorAbi,
      functionName: "allowedTargets",
      args: [bscUpgradeProbe],
    }),
    bscClient.readContract({
      address: oldExecutor,
      abi: executorAbi,
      functionName: "confirmStatus",
      args: [STALE_V1_MESSAGE_HASH],
    }),
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "isActionAllowed",
      args: [MAJOR, registry, 0n, setRulesCalldata],
    }),
  ]);

  if (ethChainId !== 1 || bscChainId !== 56) {
    throw new Error(`Wrong chains: ${ethChainId}/${bscChainId}`);
  }
  if (
    !nonceStateCompatible(existingState, 1, ethNonce.latest, ethNonce.pending) ||
    !nonceStateCompatible(existingState, 56, bscNonce.latest, bscNonce.pending)
  ) {
    throw new Error(
      "Signer has an unrecorded pending transaction or an incompatible pending nonce"
    );
  }
  if (nativeEth === 0n || nativeBnb === 0n) {
    throw new Error("Signer lacks native gas balance");
  }
  for (const [label, actual, expected] of [
    ["Governance DC", chainDc, dc],
    ["Governance Treasury", chainTreasury, treasury],
    ["Governance Registry", chainRegistry, registry],
    ["Registry governance", registryGovernance, governance],
    ["V1 Broadcaster owner", oldBroadcasterOwner, proposer],
    ["V1 Broadcaster governance", oldBroadcasterGovernance, governance],
    ["V2 Broadcaster governance", v2BroadcasterGovernance, governance],
    ["V1 Executor owner", oldExecutorOwner, bscSignerExpected],
    ["V2 Executor owner", v2ExecutorOwner, bscSignerExpected],
    ["BSC Factory controller", factoryController, v2Executor],
  ] as const) {
    if (!sameAddress(actual, expected)) {
      throw new Error(`${label} mismatch: ${String(actual)} != ${expected}`);
    }
  }
  if (
    oldThreshold !== 2n ||
    v2Threshold !== 2n ||
    !v2Route[6] ||
    !v2FactoryAllowed
  ) {
    throw new Error("V2 production path is not healthy");
  }
  if (majorFee !== EXPECTED_MAJOR_FEE || !canMint || paused) {
    throw new Error("Major fee/minter/token state changed");
  }
  if (!registryAcceptsAction) {
    throw new Error("Registry rejects the exact Major cleanup action");
  }
  if (
    !stateCompatible(
      existingState,
      oldRoute[6],
      oldFactoryAllowed,
      oldProbeAllowed,
      v2ProbeAllowed,
      proposerDcBalance,
      proposerAllowance,
      majorFee
    )
  ) {
    throw new Error(
      "Live state is partially changed without a matching record"
    );
  }
  if (!staleMessageStatus[4]) {
    try {
      await bscClient.call({
        account: oldExecutor,
        to: bscFactory,
        data: "0xa7e5d8a10000000000000000000000000000000000000000000000000000000000000001000000000000000000000000ff5efe3b23762170a99f8f4c66abea11613b982d0000000000000000000000000000000000000000000000058788cb94b1d80000",
      });
      throw new Error("Stale V1 message target call unexpectedly succeeds");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Stale V1 message target call unexpectedly succeeds"
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("NOT_AUTHORIZED")) {
        throw new Error(
          `Could not prove stale V1 call is blocked by the Factory controller: ${message}`
        );
      }
    }
  }

  const activeRules = [
    {
      label: "V1 Parameter broadcast",
      kind: PARAMETER,
      target: oldBroadcaster,
      selector: BROADCAST_SELECTOR,
      expected: {
        allowed: true,
        validateNestedBroadcast: true,
        nestedOnly: false,
        maxValue: EXPECTED_BROADCAST_MAX_VALUE,
      },
    },
    {
      label: "V1 Major broadcast",
      kind: MAJOR,
      target: oldBroadcaster,
      selector: BROADCAST_SELECTOR,
      expected: {
        allowed: true,
        validateNestedBroadcast: true,
        nestedOnly: false,
        maxValue: EXPECTED_BROADCAST_MAX_VALUE,
      },
    },
    ...[
      [
        "Legacy ETH Parameter marker",
        PARAMETER,
        ethLegacyProbe,
        MARKER_SELECTOR,
        false,
      ],
      [
        "Legacy BSC Parameter marker",
        PARAMETER,
        bscLegacyProbe,
        MARKER_SELECTOR,
        true,
      ],
      [
        "Legacy ETH Major marker",
        MAJOR,
        ethLegacyProbe,
        MARKER_SELECTOR,
        false,
      ],
      ["Legacy BSC Major marker", MAJOR, bscLegacyProbe, MARKER_SELECTOR, true],
      [
        "Legacy ETH Major upgrade",
        MAJOR,
        ethLegacyProbe,
        UPGRADE_SELECTOR,
        false,
      ],
      [
        "Legacy BSC Major upgrade",
        MAJOR,
        bscLegacyProbe,
        UPGRADE_SELECTOR,
        true,
      ],
      [
        "V2 ETH Probe Major upgrade",
        MAJOR,
        ethUpgradeProbe,
        UPGRADE_SELECTOR,
        false,
      ],
      [
        "V2 BSC Probe Major upgrade",
        MAJOR,
        bscUpgradeProbe,
        UPGRADE_SELECTOR,
        true,
      ],
    ].map(([label, kind, target, selector, nestedOnly]) => ({
      label: String(label),
      kind: Number(kind),
      target: target as Address,
      selector: selector as Hex,
      expected: {
        allowed: true,
        validateNestedBroadcast: false,
        nestedOnly: Boolean(nestedOnly),
        maxValue: 0n,
      },
    })),
  ];
  for (const spec of activeRules) {
    const current = normalizeRule(
      await ethClient.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "getRule",
        args: [spec.kind, spec.target, spec.selector],
      })
    );
    assertRule(spec.label, current, spec.expected);
  }
  for (const [kind, label] of [
    [PARAMETER, "V2 Parameter broadcast"],
    [MAJOR, "V2 Major broadcast"],
  ] as const) {
    assertRule(
      label,
      normalizeRule(
        await ethClient.readContract({
          address: registry,
          abi: registryAbi,
          functionName: "getRule",
          args: [kind, v2Broadcaster, BROADCAST_SELECTOR],
        })
      ),
      {
        allowed: true,
        validateNestedBroadcast: true,
        nestedOnly: false,
        maxValue: EXPECTED_BROADCAST_MAX_VALUE,
      }
    );
  }
  await ethClient.call({
    account: governance,
    to: registry,
    data: setRulesCalldata,
  });
  await Promise.all([
    bscClient.call({
      account: bscSignerExpected,
      to: oldExecutor,
      data: revokeV1FactoryCalldata,
    }),
    bscClient.call({
      account: bscSignerExpected,
      to: oldExecutor,
      data: revokeV1ProbeCalldata,
    }),
    ethClient.call({
      account: proposer,
      to: oldBroadcaster,
      data: pauseV1RouteCalldata,
    }),
    bscClient.call({
      account: bscSignerExpected,
      to: v2Executor,
      data: revokeV2ProbeCalldata,
    }),
    ethClient.call({ account: proposer, to: dc, data: mintFeeCalldata }),
    ethClient.call({ account: proposer, to: dc, data: approveFeeCalldata }),
  ]);

  const duplicate = await findExactProposal(
    ethClient,
    governance,
    registry,
    setRulesCalldata,
    1n,
    proposalCount
  );
  if (duplicate !== undefined && !existingState?.actions.createProposal) {
    throw new Error(`Exact retirement proposal already exists: ${duplicate}`);
  }

  const state: StageState = existingState ?? {
    schemaVersion: 1,
    scope: SCOPE,
    stage: "prepared",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    proposer,
    governance,
    registry,
    dc,
    treasury,
    oldBroadcaster,
    oldExecutor,
    v2Broadcaster,
    v2Executor,
    bscFactory,
    bscLegacyProbe,
    bscUpgradeProbe,
    proposalCountBefore: proposalCount.toString(),
    majorFee: majorFee.toString(),
    totalSupplyBefore: totalSupply.toString(),
    treasuryBalanceBefore: treasuryBalance.toString(),
    description: DESCRIPTION,
    setRulesCalldata,
    createProposalCalldata,
    directCalldata: {
      revokeV1Factory: revokeV1FactoryCalldata,
      revokeV1Probe: revokeV1ProbeCalldata,
      pauseV1Route: pauseV1RouteCalldata,
      revokeV2Probe: revokeV2ProbeCalldata,
    },
    actions: {},
  };
  assertState(state, {
    proposer,
    governance,
    registry,
    dc,
    treasury,
    oldBroadcaster,
    oldExecutor,
    v2Broadcaster,
    v2Executor,
    bscFactory,
    bscLegacyProbe,
    bscUpgradeProbe,
    setRulesCalldata,
    createProposalCalldata,
  });

  console.log("=== CCIP V1 retirement stage 1 preflight ===");
  console.log(
    `ETH/BSC blocks: ${await ethClient.getBlockNumber()} / ${await bscClient.getBlockNumber()}`
  );
  console.log(`Signer: ${proposer}`);
  console.log(`ETH/BNB: ${formatEther(nativeEth)} / ${formatEther(nativeBnb)}`);
  console.log(
    `Proposal count: ${proposalCount}; predicted id: ${proposalCount + 1n}`
  );
  console.log(
    `V1 stale message: ${staleMessageStatus[3]}/2, executed=${staleMessageStatus[4]}`
  );
  console.log(`setRules hash: ${keccak256(setRulesCalldata)}`);
  console.log(`createProposal hash: ${keccak256(createProposalCalldata)}`);
  console.log(`Write enabled: ${writeEnabled}`);

  if (preflightOnly) {
    console.log("Read-only preflight complete. No transaction sent.");
    return;
  }
  if (!existingState) save(state);

  await sendExact(
    state,
    "revokeV1Factory",
    bscClient,
    bscWallet,
    bscSignerExpected,
    oldExecutor,
    revokeV1FactoryCalldata
  );
  if (
    await bscClient.readContract({
      address: oldExecutor,
      abi: executorAbi,
      functionName: "allowedTargets",
      args: [bscFactory],
    })
  ) {
    throw new Error("V1 Factory allowlist revocation did not persist");
  }
  state.stage = "v1_factory_revoked";
  save(state);

  await sendExact(
    state,
    "revokeV1Probe",
    bscClient,
    bscWallet,
    bscSignerExpected,
    oldExecutor,
    revokeV1ProbeCalldata
  );
  if (
    await bscClient.readContract({
      address: oldExecutor,
      abi: executorAbi,
      functionName: "allowedTargets",
      args: [bscLegacyProbe],
    })
  ) {
    throw new Error("V1 Probe allowlist revocation did not persist");
  }
  state.stage = "v1_probe_revoked";
  save(state);

  await sendExact(
    state,
    "pauseV1Route",
    ethClient,
    ethWallet,
    proposer,
    oldBroadcaster,
    pauseV1RouteCalldata
  );
  const oldRouteAfter = await ethClient.readContract({
    address: oldBroadcaster,
    abi: oldBroadcasterAbi,
    functionName: "chains",
    args: [bscChainKey],
  });
  if (oldRouteAfter[6]) throw new Error("V1 route pause did not persist");
  state.stage = "v1_route_paused";
  save(state);

  await sendExact(
    state,
    "revokeV2Probe",
    bscClient,
    bscWallet,
    bscSignerExpected,
    v2Executor,
    revokeV2ProbeCalldata
  );
  if (
    await bscClient.readContract({
      address: v2Executor,
      abi: executorAbi,
      functionName: "allowedTargets",
      args: [bscUpgradeProbe],
    })
  ) {
    throw new Error("V2 Probe allowlist revocation did not persist");
  }
  state.stage = "v2_probe_revoked";
  save(state);

  await sendExact(
    state,
    "mintFee",
    ethClient,
    ethWallet,
    proposer,
    dc,
    mintFeeCalldata
  );
  if (
    (await ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [proposer],
    })) !== majorFee &&
    !state.actions.createProposal
  ) {
    throw new Error("Exact Major fee balance was not minted");
  }
  state.stage = "fee_minted";
  save(state);

  await sendExact(
    state,
    "approveFee",
    ethClient,
    ethWallet,
    proposer,
    dc,
    approveFeeCalldata
  );
  if (
    (await ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [proposer, governance],
    })) !== majorFee &&
    !state.actions.createProposal
  ) {
    throw new Error("Exact Major fee allowance was not approved");
  }
  state.stage = "fee_approved";
  save(state);

  const countImmediatelyBeforeCreate = await ethClient.readContract({
    address: governance,
    abi: governanceAbi,
    functionName: "proposalCount",
  });
  const resumingProposalCreation = Boolean(state.actions.createProposal);
  if (!resumingProposalCreation) {
    const duplicateBeforeCreate = await findExactProposal(
      ethClient,
      governance,
      registry,
      setRulesCalldata,
      1n,
      countImmediatelyBeforeCreate
    );
    if (duplicateBeforeCreate !== undefined) {
      throw new Error(
        `Exact retirement proposal appeared before creation: ${duplicateBeforeCreate}`
      );
    }
  }
  await sendExact(
    state,
    "createProposal",
    ethClient,
    ethWallet,
    proposer,
    governance,
    createProposalCalldata
  );
  const proposalCountAfter = await ethClient.readContract({
    address: governance,
    abi: governanceAbi,
    functionName: "proposalCount",
  });
  const proposalId = await findExactProposal(
    ethClient,
    governance,
    registry,
    setRulesCalldata,
    resumingProposalCreation ? 1n : countImmediatelyBeforeCreate + 1n,
    proposalCountAfter
  );
  if (proposalId === undefined) {
    throw new Error(
      "Created transaction succeeded but exact proposal not found"
    );
  }
  state.proposalId = proposalId.toString();
  state.stage = "proposal_created";

  const [
    proposalState,
    proposal,
    actions,
    finalSupply,
    finalTreasury,
    finalBalance,
    finalAllowance,
  ] = await Promise.all([
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "state",
      args: [proposalId],
    }),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "getProposal",
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
      functionName: "totalSupply",
    }),
    ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [treasury],
    }),
    ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [proposer],
    }),
    ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [proposer, governance],
    }),
  ]);
  const descriptionMatched = proposal.description === DESCRIPTION;
  const actionsMatched =
    actions[0].length === 1 &&
    actions[1].length === 1 &&
    actions[2].length === 1 &&
    sameAddress(actions[0][0], registry) &&
    actions[1][0] === 0n &&
    sameHex(actions[2][0], setRulesCalldata);
  const noStakeOrExecution =
    proposalState === PENDING &&
    proposal.totalStaked === 0n &&
    proposal.windowEndsAt === 0n &&
    !proposal.executed;
  if (
    !descriptionMatched ||
    !actionsMatched ||
    !noStakeOrExecution ||
    finalBalance !== 0n ||
    finalAllowance !== 0n ||
    finalSupply - BigInt(state.totalSupplyBefore) !== majorFee ||
    finalTreasury - BigInt(state.treasuryBalanceBefore) !== majorFee
  ) {
    throw new Error("Post-proposal verification failed");
  }

  let cleanupRulesStillActive = 0;
  for (const spec of activeRules) {
    const current = normalizeRule(
      await ethClient.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "getRule",
        args: [spec.kind, spec.target, spec.selector],
      })
    );
    if (current.allowed) ++cleanupRulesStillActive;
  }
  const v2RulesPreserved = await verifyV2Rules(
    ethClient,
    registry,
    v2Broadcaster
  );
  state.verification = {
    proposalState: proposalState.toString(),
    totalStaked: proposal.totalStaked.toString(),
    executed: proposal.executed,
    descriptionMatched,
    actionsMatched,
    v1RouteInactive: !oldRouteAfter[6],
    v2RouteActive: v2Route[6],
    v1FactoryRevoked: true,
    v1ProbeRevoked: true,
    v2ProbeRevoked: true,
    v2FactoryPreserved: v2FactoryAllowed,
    cleanupRulesStillActive,
    v2RulesPreserved,
    proposerDcBalance: finalBalance.toString(),
    proposerAllowance: finalAllowance.toString(),
    totalSupplyDelta: (
      finalSupply - BigInt(state.totalSupplyBefore)
    ).toString(),
    treasuryBalanceDelta: (
      finalTreasury - BigInt(state.treasuryBalanceBefore)
    ).toString(),
    noStakeOrExecution,
  };
  save(state);

  console.log("=== Stage 1 complete ===");
  console.log(`Proposal: ${proposalId}`);
  console.log(`State: ${proposalState}; totalStaked=${proposal.totalStaked}`);
  console.log(`Executed: ${proposal.executed}`);
  console.log(
    `Cleanup rules still active until proposal execution: ${cleanupRulesStillActive}`
  );
  console.log("No stake or proposal execution was performed.");
}

function stateCompatible(
  state: StageState | undefined,
  oldRouteActive: boolean,
  oldFactoryAllowed: boolean,
  oldProbeAllowed: boolean,
  v2ProbeAllowed: boolean,
  proposerBalance: bigint,
  proposerAllowance: bigint,
  majorFee: bigint
): boolean {
  if (!state) {
    return (
      oldRouteActive &&
      oldFactoryAllowed &&
      oldProbeAllowed &&
      v2ProbeAllowed &&
      proposerBalance === 0n &&
      proposerAllowance === 0n
    );
  }
  if (state.stage === "proposal_created") {
    return (
      !oldRouteActive &&
      !oldFactoryAllowed &&
      !oldProbeAllowed &&
      !v2ProbeAllowed &&
      proposerBalance === 0n &&
      proposerAllowance === 0n
    );
  }
  if (!booleanActionCompatible(state.actions.revokeV1Factory, oldFactoryAllowed))
    return false;
  if (!booleanActionCompatible(state.actions.revokeV1Probe, oldProbeAllowed))
    return false;
  if (!booleanActionCompatible(state.actions.pauseV1Route, oldRouteActive))
    return false;
  if (!booleanActionCompatible(state.actions.revokeV2Probe, v2ProbeAllowed))
    return false;

  const createRecord = state.actions.createProposal;
  if (createRecord) {
    return createRecord.verified
      ? proposerBalance === 0n && proposerAllowance === 0n
      : (proposerBalance === majorFee || proposerBalance === 0n) &&
          (proposerAllowance === majorFee || proposerAllowance === 0n);
  }

  const approveRecord = state.actions.approveFee;
  if (approveRecord) {
    return (
      proposerBalance === majorFee &&
      (approveRecord.verified
        ? proposerAllowance === majorFee
        : proposerAllowance === 0n || proposerAllowance === majorFee)
    );
  }

  const mintRecord = state.actions.mintFee;
  if (mintRecord) {
    return (
      proposerAllowance === 0n &&
      (mintRecord.verified
        ? proposerBalance === majorFee
        : proposerBalance === 0n || proposerBalance === majorFee)
    );
  }

  return proposerBalance === 0n && proposerAllowance === 0n;
}

function booleanActionCompatible(
  record: TxRecord | undefined,
  currentEnabled: boolean
): boolean {
  if (!record) return currentEnabled;
  if (!record.verified) return true;
  return !currentEnabled;
}

function nonceStateCompatible(
  state: StageState | undefined,
  chainId: number,
  latest: number,
  pending: number
): boolean {
  if (latest === pending) return true;
  if (!state || pending !== latest + 1) return false;
  return Object.values(state.actions).some(
    (record) =>
      record?.chainId === chainId &&
      !record.verified &&
      record.nonce === latest
  );
}

function assertState(
  state: StageState,
  expected: {
    proposer: Address;
    governance: Address;
    registry: Address;
    dc: Address;
    treasury: Address;
    oldBroadcaster: Address;
    oldExecutor: Address;
    v2Broadcaster: Address;
    v2Executor: Address;
    bscFactory: Address;
    bscLegacyProbe: Address;
    bscUpgradeProbe: Address;
    setRulesCalldata: Hex;
    createProposalCalldata: Hex;
  }
) {
  if (state.schemaVersion !== 1 || state.scope !== SCOPE) {
    throw new Error("Existing retirement state file has incompatible scope");
  }
  for (const key of [
    "proposer",
    "governance",
    "registry",
    "dc",
    "treasury",
    "oldBroadcaster",
    "oldExecutor",
    "v2Broadcaster",
    "v2Executor",
    "bscFactory",
    "bscLegacyProbe",
    "bscUpgradeProbe",
  ] as const) {
    if (!sameAddress(state[key], expected[key])) {
      throw new Error(`Existing state ${key} mismatch`);
    }
  }
  if (
    !sameHex(state.setRulesCalldata, expected.setRulesCalldata) ||
    !sameHex(state.createProposalCalldata, expected.createProposalCalldata)
  ) {
    throw new Error("Existing state calldata mismatch");
  }
}

async function verifyV2Rules(
  client: any,
  registry: Address,
  v2Broadcaster: Address
): Promise<boolean> {
  for (const kind of [PARAMETER, MAJOR]) {
    const rule = normalizeRule(
      await client.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "getRule",
        args: [kind, v2Broadcaster, BROADCAST_SELECTOR],
      })
    );
    if (
      !rule.allowed ||
      !rule.validateNestedBroadcast ||
      rule.nestedOnly ||
      rule.maxValue !== EXPECTED_BROADCAST_MAX_VALUE
    ) {
      return false;
    }
  }
  return true;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
