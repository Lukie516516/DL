/**
 * Read-only production preflight for retiring the legacy ETH -> BSC V1 route.
 *
 * This script has no wallet client and no transaction-sending branch. It:
 * - audits every historical V1 Broadcast event against the BSC V1 Executor;
 * - checks the current V1/V2 routes, controllers, allowlists and DAO rules;
 * - proves stale V1 messages cannot call the current BSC DealFactory;
 * - encodes and eth_call-simulates the exact owner and DAO cleanup actions.
 *
 * Run:
 *   node --import tsx/esm scripts/prepare-mainnet-ccip-v1-retirement.ts
 *   node --import tsx/esm scripts/prepare-mainnet-ccip-v1-retirement.ts --json
 *
 * Optional RPC overrides:
 *   ETH_MAINNET_RPC_URL=...
 *   ETH_ARCHIVE_RPC_URL=...   # must support historical eth_getLogs
 *   BSC_MAINNET_RPC_URL=...
 *   V1_BROADCAST_BLOCKS=0x...,0x... # exact known event blocks; count is still checked against broadcastNonce
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { bsc, mainnet } from "viem/chains";

type MainnetCrossChain = {
  eth: { deployer: Address; broadcaster: Address };
  bsc: { deployer: Address; executor: Address };
  params: {
    ethGovernance: Address;
    bscChainKey: number;
    bscDealFactory: Address;
  };
};

type EthDeployment = {
  addresses: {
    dlToken: Address;
    governancePolicyRegistry: Address;
  };
};

type V2Deployment = {
  eth: { address: Address };
  bsc: { address: Address };
};

type GovernanceProbeDeployment = {
  eth: { proxy: Address };
  bsc: { proxy: Address };
};

type UpgradeProbeDeployment = {
  eth: { proxy: { address: Address } };
  bsc: { proxy: { address: Address } };
};

type RuleView = readonly [boolean, boolean, boolean, bigint] & {
  allowed?: boolean;
  validateNestedBroadcast?: boolean;
  nestedOnly?: boolean;
  maxValue?: bigint;
};

type RuleInput = {
  kind: number;
  target: Address;
  selector: Hex;
  allowed: boolean;
  validateNestedBroadcast: boolean;
  nestedOnly: boolean;
  maxValue: bigint;
};

type RuleSpec = {
  label: string;
  kind: number;
  target: Address;
  selector: Hex;
};

type BroadcastAudit = {
  nonce: bigint;
  ethBlock: bigint;
  ethTxHash: Hex;
  chainId: number;
  target: Address;
  data: Hex;
  selector: Hex;
  selectorName: string;
  messageHash: Hex;
  status: {
    layerZero: boolean;
    wormhole: boolean;
    axelar: boolean;
    count: bigint;
    executed: boolean;
  };
  currentCallFromV1Executor?: {
    succeeds: boolean;
    error?: string;
  };
};

const ROOT = process.cwd();
const loadJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(join(ROOT, relativePath), "utf8")) as T;

const crossChain = loadJson<MainnetCrossChain>(
  "deployments/mainnet-cross-chain.json"
);
const ethDeployment = loadJson<EthDeployment>("deployments/eth-mainnet-1.json");
const v2Deployment = loadJson<V2Deployment>(
  "deployments/ccip-v2-mainnet-stage1.json"
);
const governanceProbe = loadJson<GovernanceProbeDeployment>(
  "deployments/governance-probe-mainnet.json"
);
const upgradeProbe = loadJson<UpgradeProbeDeployment>(
  "deployments/cross-chain-v2-upgrade-probe-stage1.json"
);

const ETH_RPC =
  process.env.ETH_MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com";
const ETH_ARCHIVE_RPC =
  process.env.ETH_ARCHIVE_RPC_URL || "https://eth.drpc.org";
const BSC_RPC =
  process.env.BSC_MAINNET_RPC_URL || "https://bsc-rpc.publicnode.com";

const eth = createPublicClient({
  chain: mainnet,
  transport: http(ETH_RPC, { timeout: 30_000 }),
});
const ethArchive = createPublicClient({
  chain: mainnet,
  transport: http(ETH_ARCHIVE_RPC, { timeout: 30_000 }),
});
const bscClient = createPublicClient({
  chain: bsc,
  transport: http(BSC_RPC, { timeout: 30_000 }),
});

const PARAMETER = 0;
const MAJOR = 2;
const BSC_CHAIN_KEY = Number(crossChain.params.bscChainKey);
const BROADCAST_SELECTOR = toFunctionSelector(
  "broadcast(uint32[],address[],bytes,uint128)"
);
const MARKER_SELECTOR = toFunctionSelector("recordMarker(bytes32)");
const UPGRADE_SELECTOR = toFunctionSelector("upgradeToAndCall(address,bytes)");
const MESSAGE_PRICE_RULE_SELECTOR = toFunctionSelector(
  "setMessagePriceRule(bool,address,uint256)"
);
const V1_SCAN_FROM_BLOCK = 25_300_000n;
const LOG_CHUNK_SIZE = 9_000n;
const EXACT_V1_BROADCAST_BLOCKS = (
  process.env.V1_BROADCAST_BLOCKS || ""
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => BigInt(value));

const governance = getAddress(crossChain.params.ethGovernance);
const registry = getAddress(ethDeployment.addresses.governancePolicyRegistry);
const dc = getAddress(ethDeployment.addresses.dlToken);
const proposer = getAddress(crossChain.eth.deployer);
const oldBroadcaster = getAddress(crossChain.eth.broadcaster);
const oldExecutor = getAddress(crossChain.bsc.executor);
const v2Broadcaster = getAddress(v2Deployment.eth.address);
const v2Executor = getAddress(v2Deployment.bsc.address);
const bscFactory = getAddress(crossChain.params.bscDealFactory);
const ethLegacyProbe = getAddress(governanceProbe.eth.proxy);
const bscLegacyProbe = getAddress(governanceProbe.bsc.proxy);
const ethUpgradeProbe = getAddress(upgradeProbe.eth.proxy.address);
const bscUpgradeProbe = getAddress(upgradeProbe.bsc.proxy.address);

const governanceAbi = parseAbi([
  "function dcToken() view returns (address)",
  "function policyRegistry() view returns (address)",
  "function proposalCount() view returns (uint256)",
  "function majorProposalFee() view returns (uint256)",
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
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function mint(address,uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const oldBroadcasterAbi = parseAbi([
  "function owner() view returns (address)",
  "function governance() view returns (address)",
  "function broadcastNonce() view returns (uint256)",
  "function getChainIds() view returns (uint32[])",
  "function chains(uint32) view returns (uint32 lzDstEid,uint16 whDstChain,address whDstAddress,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
  "function setChainActive(uint32,bool)",
]);
const v2BroadcasterAbi = parseAbi([
  "function owner() view returns (address)",
  "function governance() view returns (address)",
  "function broadcastNonce() view returns (uint256)",
  "function getChainIds() view returns (uint32[])",
  "function chains(uint32) view returns (uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
]);
const executorAbi = parseAbi([
  "function owner() view returns (address)",
  "function threshold() view returns (uint256)",
  "function allowedTargets(address) view returns (bool)",
  "function confirmStatus(bytes32) view returns (bool lzConfirmed,bool middleBridgeConfirmed,bool axConfirmed,uint256 count,bool isExecuted)",
  "function setAllowedTarget(address,bool)",
]);
const factoryAbi = parseAbi([
  "function crossChainGovernance() view returns (address)",
]);
const probeAbi = parseAbi([
  "function controller() view returns (address)",
  "function version() view returns (uint256)",
]);
const v1BroadcastEvent = parseAbiItem(
  "event Broadcast(uint256 indexed nonce,uint32[] targetChainIds,address[] targets,bytes data)"
);

const DESCRIPTION =
  "关闭跨链V1与测试权限\n\n" +
  "本提案只关闭旧 V1 Broadcaster 的 Parameter/Major 广播策略，并关闭 ETH/BSC 无资产测试 Probe 的 marker 和升级策略。" +
  "V2 Broadcaster、V2 Executor、BSC DealFactory、代币、国库和业务参数均不改变；不发送跨链消息，不升级任何业务合约。";

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function ruleObject(rule: RuleView) {
  return {
    allowed: Boolean(rule.allowed ?? rule[0]),
    validateNestedBroadcast: Boolean(rule.validateNestedBroadcast ?? rule[1]),
    nestedOnly: Boolean(rule.nestedOnly ?? rule[2]),
    maxValue: BigInt(rule.maxValue ?? rule[3]),
  };
}

function shortError(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "shortMessage" in error &&
    typeof (error as { shortMessage?: unknown }).shortMessage === "string"
  ) {
    return (error as { shortMessage: string }).shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

async function simulateCall(
  client: typeof eth | typeof bscClient,
  account: Address,
  to: Address,
  data: Hex
) {
  try {
    await client.call({ account, to, data });
    const estimatedGas = await client.estimateGas({ account, to, data });
    return { succeeds: true, estimatedGas };
  } catch (error) {
    return { succeeds: false, error: shortError(error) };
  }
}

function selectorName(selector: Hex): string {
  if (selector === MESSAGE_PRICE_RULE_SELECTOR) {
    return "setMessagePriceRule(bool,address,uint256)";
  }
  if (selector === MARKER_SELECTOR) return "recordMarker(bytes32)";
  return "unknown";
}

async function getV1LogsAdaptive(
  fromBlock: bigint,
  toBlock: bigint
): Promise<Awaited<ReturnType<typeof ethArchive.getLogs>>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; ++attempt) {
    try {
      return await ethArchive.getLogs({
        address: oldBroadcaster,
        event: v1BroadcastEvent,
        fromBlock,
        toBlock,
      });
    } catch (error) {
      lastError = error;
    }
  }

  const blockCount = toBlock - fromBlock + 1n;
  if (blockCount <= 256n) throw lastError;

  const midpoint = fromBlock + blockCount / 2n - 1n;
  const left = await getV1LogsAdaptive(fromBlock, midpoint);
  const right = await getV1LogsAdaptive(midpoint + 1n, toBlock);
  return [...left, ...right];
}

async function scanV1Broadcasts(
  latestBlock: bigint,
  expectedNonce: bigint
): Promise<BroadcastAudit[]> {
  const logs: Awaited<ReturnType<typeof ethArchive.getLogs>> = [];
  if (EXACT_V1_BROADCAST_BLOCKS.length > 0) {
    const uniqueBlocks = [...new Set(EXACT_V1_BROADCAST_BLOCKS)];
    if (
      uniqueBlocks.length !== EXACT_V1_BROADCAST_BLOCKS.length ||
      uniqueBlocks.some(
        (block) => block < V1_SCAN_FROM_BLOCK || block > latestBlock
      )
    ) {
      throw new Error("Invalid or duplicate V1_BROADCAST_BLOCKS");
    }
    for (const block of uniqueBlocks) {
      logs.push(...(await getV1LogsAdaptive(block, block)));
    }
  } else {
    for (
      let start = V1_SCAN_FROM_BLOCK;
      start <= latestBlock;
      start += LOG_CHUNK_SIZE
    ) {
      const end =
        start + LOG_CHUNK_SIZE - 1n > latestBlock
          ? latestBlock
          : start + LOG_CHUNK_SIZE - 1n;
      logs.push(...(await getV1LogsAdaptive(start, end)));
    }
  }

  logs.sort((a, b) => {
    const blockOrder = Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n));
    if (blockOrder !== 0) return blockOrder;
    return Number((a.logIndex ?? 0) - (b.logIndex ?? 0));
  });

  if (BigInt(logs.length) !== expectedNonce) {
    throw new Error(
      `V1 event scan incomplete: found ${logs.length} Broadcast events but broadcastNonce=${expectedNonce}`
    );
  }

  const rows: BroadcastAudit[] = [];
  for (const log of logs) {
    const args = log.args as {
      nonce: bigint;
      targetChainIds: readonly number[];
      targets: readonly Address[];
      data: Hex;
    };
    if (
      args.targetChainIds.length === 0 ||
      args.targetChainIds.length !== args.targets.length
    ) {
      throw new Error(`Malformed V1 Broadcast event in ${log.transactionHash}`);
    }

    for (let i = 0; i < args.targetChainIds.length; ++i) {
      const target = getAddress(args.targets[i]);
      const payload = encodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
        [args.nonce, target, args.data]
      );
      const messageHash = keccak256(payload);
      const status = await bscClient.readContract({
        address: oldExecutor,
        abi: executorAbi,
        functionName: "confirmStatus",
        args: [messageHash],
      });
      const selector = args.data.slice(0, 10) as Hex;
      rows.push({
        nonce: args.nonce,
        ethBlock: log.blockNumber ?? 0n,
        ethTxHash: log.transactionHash ?? ("0x" as Hex),
        chainId: args.targetChainIds[i],
        target,
        data: args.data,
        selector,
        selectorName: selectorName(selector),
        messageHash,
        status: {
          layerZero: status[0],
          wormhole: status[1],
          axelar: status[2],
          count: status[3],
          executed: status[4],
        },
      });
    }
  }

  for (const row of rows.filter((item) => !item.status.executed)) {
    const simulation = await simulateCall(
      bscClient,
      oldExecutor,
      row.target,
      row.data
    );
    row.currentCallFromV1Executor = {
      succeeds: simulation.succeeds,
      ...(simulation.error ? { error: simulation.error } : {}),
    };
  }
  return rows;
}

async function main() {
  const checkedAt = new Date().toISOString();
  const [
    ethBlock,
    bscBlock,
    registryGovernance,
    governanceRegistry,
    governanceDc,
    proposalCount,
    majorFee,
    minterRole,
    oldBroadcasterOwner,
    oldBroadcasterGovernance,
    oldBroadcastNonce,
    oldChainIds,
    v2BroadcasterOwner,
    v2BroadcasterGovernance,
    v2BroadcastNonce,
    v2ChainIds,
    oldExecutorOwner,
    oldThreshold,
    v2ExecutorOwner,
    v2Threshold,
    factoryController,
    oldFactoryAllowed,
    oldLegacyProbeAllowed,
    v2FactoryAllowed,
    v2UpgradeProbeAllowed,
    ethLegacyProbeController,
    bscLegacyProbeController,
    ethUpgradeProbeController,
    bscUpgradeProbeController,
    ethLegacyProbeVersion,
    bscLegacyProbeVersion,
    ethUpgradeProbeVersion,
    bscUpgradeProbeVersion,
    proposerDcBalance,
    proposerAllowance,
  ] = await Promise.all([
    eth.getBlockNumber(),
    bscClient.getBlockNumber(),
    eth.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "governance",
    }),
    eth.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "policyRegistry",
    }),
    eth.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "dcToken",
    }),
    eth.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "proposalCount",
    }),
    eth.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "majorProposalFee",
    }),
    eth.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "MINTER_ROLE",
    }),
    eth.readContract({
      address: oldBroadcaster,
      abi: oldBroadcasterAbi,
      functionName: "owner",
    }),
    eth.readContract({
      address: oldBroadcaster,
      abi: oldBroadcasterAbi,
      functionName: "governance",
    }),
    eth.readContract({
      address: oldBroadcaster,
      abi: oldBroadcasterAbi,
      functionName: "broadcastNonce",
    }),
    eth.readContract({
      address: oldBroadcaster,
      abi: oldBroadcasterAbi,
      functionName: "getChainIds",
    }),
    eth.readContract({
      address: v2Broadcaster,
      abi: v2BroadcasterAbi,
      functionName: "owner",
    }),
    eth.readContract({
      address: v2Broadcaster,
      abi: v2BroadcasterAbi,
      functionName: "governance",
    }),
    eth.readContract({
      address: v2Broadcaster,
      abi: v2BroadcasterAbi,
      functionName: "broadcastNonce",
    }),
    eth.readContract({
      address: v2Broadcaster,
      abi: v2BroadcasterAbi,
      functionName: "getChainIds",
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
    eth.readContract({
      address: ethLegacyProbe,
      abi: probeAbi,
      functionName: "controller",
    }),
    bscClient.readContract({
      address: bscLegacyProbe,
      abi: probeAbi,
      functionName: "controller",
    }),
    eth.readContract({
      address: ethUpgradeProbe,
      abi: probeAbi,
      functionName: "controller",
    }),
    bscClient.readContract({
      address: bscUpgradeProbe,
      abi: probeAbi,
      functionName: "controller",
    }),
    eth.readContract({
      address: ethLegacyProbe,
      abi: probeAbi,
      functionName: "version",
    }),
    bscClient.readContract({
      address: bscLegacyProbe,
      abi: probeAbi,
      functionName: "version",
    }),
    eth.readContract({
      address: ethUpgradeProbe,
      abi: probeAbi,
      functionName: "version",
    }),
    bscClient.readContract({
      address: bscUpgradeProbe,
      abi: probeAbi,
      functionName: "version",
    }),
    eth.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [proposer],
    }),
    eth.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [proposer, governance],
    }),
  ]);

  if (
    oldChainIds.length !== 1 ||
    oldChainIds[0] !== BSC_CHAIN_KEY ||
    v2ChainIds.length !== 1 ||
    v2ChainIds[0] !== BSC_CHAIN_KEY
  ) {
    throw new Error("Unexpected V1/V2 chain set");
  }

  const [oldChainConfig, v2ChainConfig, proposerIsMinter, broadcasts] =
    await Promise.all([
      eth.readContract({
        address: oldBroadcaster,
        abi: oldBroadcasterAbi,
        functionName: "chains",
        args: [BSC_CHAIN_KEY],
      }),
      eth.readContract({
        address: v2Broadcaster,
        abi: v2BroadcasterAbi,
        functionName: "chains",
        args: [BSC_CHAIN_KEY],
      }),
      eth.readContract({
        address: dc,
        abi: tokenAbi,
        functionName: "hasRole",
        args: [minterRole, proposer],
      }),
      scanV1Broadcasts(ethBlock, oldBroadcastNonce),
    ]);

  const ruleSpecs: RuleSpec[] = [
    {
      label: "V1 Parameter broadcast",
      kind: PARAMETER,
      target: oldBroadcaster,
      selector: BROADCAST_SELECTOR,
    },
    {
      label: "V1 Major broadcast",
      kind: MAJOR,
      target: oldBroadcaster,
      selector: BROADCAST_SELECTOR,
    },
    {
      label: "Legacy ETH Probe Parameter marker",
      kind: PARAMETER,
      target: ethLegacyProbe,
      selector: MARKER_SELECTOR,
    },
    {
      label: "Legacy BSC Probe Parameter marker",
      kind: PARAMETER,
      target: bscLegacyProbe,
      selector: MARKER_SELECTOR,
    },
    {
      label: "Legacy ETH Probe Major marker",
      kind: MAJOR,
      target: ethLegacyProbe,
      selector: MARKER_SELECTOR,
    },
    {
      label: "Legacy BSC Probe Major marker",
      kind: MAJOR,
      target: bscLegacyProbe,
      selector: MARKER_SELECTOR,
    },
    {
      label: "Legacy ETH Probe Major upgrade",
      kind: MAJOR,
      target: ethLegacyProbe,
      selector: UPGRADE_SELECTOR,
    },
    {
      label: "Legacy BSC Probe Major upgrade",
      kind: MAJOR,
      target: bscLegacyProbe,
      selector: UPGRADE_SELECTOR,
    },
    {
      label: "V2 ETH Upgrade Probe Major upgrade",
      kind: MAJOR,
      target: ethUpgradeProbe,
      selector: UPGRADE_SELECTOR,
    },
    {
      label: "V2 BSC Upgrade Probe Major upgrade",
      kind: MAJOR,
      target: bscUpgradeProbe,
      selector: UPGRADE_SELECTOR,
    },
  ];

  const currentRules = await Promise.all(
    ruleSpecs.map(async (spec) => ({
      ...spec,
      current: ruleObject(
        await eth.readContract({
          address: registry,
          abi: registryAbi,
          functionName: "getRule",
          args: [spec.kind, spec.target, spec.selector],
        })
      ),
    }))
  );
  const [v2ParameterRule, v2MajorRule] = await Promise.all([
    eth.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [PARAMETER, v2Broadcaster, BROADCAST_SELECTOR],
    }),
    eth.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, v2Broadcaster, BROADCAST_SELECTOR],
    }),
  ]);

  const disabledRules: RuleInput[] = ruleSpecs.map((spec) => ({
    kind: spec.kind,
    target: spec.target,
    selector: spec.selector,
    allowed: false,
    validateNestedBroadcast: false,
    nestedOnly: false,
    maxValue: 0n,
  }));
  const setRulesCalldata = encodeFunctionData({
    abi: registryAbi,
    functionName: "setRules",
    args: [disabledRules],
  });
  const createProposalCalldata = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [[registry], [0n], [setRulesCalldata], DESCRIPTION, MAJOR],
  });
  const mintFeeCalldata = encodeFunctionData({
    abi: tokenAbi,
    functionName: "mint",
    args: [proposer, majorFee],
  });
  const approveFeeCalldata = encodeFunctionData({
    abi: tokenAbi,
    functionName: "approve",
    args: [governance, majorFee],
  });
  const pauseV1RouteCalldata = encodeFunctionData({
    abi: oldBroadcasterAbi,
    functionName: "setChainActive",
    args: [BSC_CHAIN_KEY, false],
  });
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
  const revokeV2ProbeCalldata = encodeFunctionData({
    abi: executorAbi,
    functionName: "setAllowedTarget",
    args: [bscUpgradeProbe, false],
  });

  const [
    registryAcceptsPolicyAction,
    registryDryRun,
    pauseV1RouteDryRun,
    revokeV1FactoryDryRun,
    revokeV1ProbeDryRun,
    revokeV2ProbeDryRun,
  ] = await Promise.all([
    eth.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "isActionAllowed",
      args: [MAJOR, registry, 0n, setRulesCalldata],
    }),
    simulateCall(eth, governance, registry, setRulesCalldata),
    simulateCall(
      eth,
      getAddress(oldBroadcasterOwner),
      oldBroadcaster,
      pauseV1RouteCalldata
    ),
    simulateCall(
      bscClient,
      getAddress(oldExecutorOwner),
      oldExecutor,
      revokeV1FactoryCalldata
    ),
    simulateCall(
      bscClient,
      getAddress(oldExecutorOwner),
      oldExecutor,
      revokeV1ProbeCalldata
    ),
    simulateCall(
      bscClient,
      getAddress(v2ExecutorOwner),
      v2Executor,
      revokeV2ProbeCalldata
    ),
  ]);

  const blockers: string[] = [];
  const warnings: string[] = [];
  const expectedGovernance = governance;
  const expectedOwner = proposer;
  const v2Parameter = ruleObject(v2ParameterRule);
  const v2Major = ruleObject(v2MajorRule);

  if (!sameAddress(getAddress(registryGovernance), governance)) {
    blockers.push("Registry governance is not the DealGovernance proxy");
  }
  if (!sameAddress(getAddress(governanceRegistry), registry)) {
    blockers.push("DealGovernance policyRegistry differs from deployment");
  }
  if (!sameAddress(getAddress(governanceDc), dc)) {
    blockers.push("DealGovernance DC token differs from deployment");
  }
  if (
    !sameAddress(getAddress(oldBroadcasterOwner), expectedOwner) ||
    !sameAddress(getAddress(v2BroadcasterOwner), expectedOwner) ||
    !sameAddress(getAddress(oldExecutorOwner), expectedOwner) ||
    !sameAddress(getAddress(v2ExecutorOwner), expectedOwner)
  ) {
    blockers.push("At least one direct cleanup owner differs from proposer");
  }
  if (
    !sameAddress(getAddress(oldBroadcasterGovernance), expectedGovernance) ||
    !sameAddress(getAddress(v2BroadcasterGovernance), expectedGovernance)
  ) {
    blockers.push("V1/V2 broadcaster governance mismatch");
  }
  if (!sameAddress(getAddress(factoryController), v2Executor)) {
    blockers.push("BSC DealFactory is not controlled by V2 Executor");
  }
  if (oldThreshold !== 2n || v2Threshold !== 2n) {
    blockers.push("V1/V2 executor threshold is not 2");
  }
  if (!oldChainConfig[6]) warnings.push("V1 BSC route is already inactive");
  if (!v2ChainConfig[6]) blockers.push("V2 BSC route is not active");
  if (!v2FactoryAllowed) {
    blockers.push("V2 Executor does not allow the BSC DealFactory");
  }
  if (
    !v2Parameter.allowed ||
    !v2Parameter.validateNestedBroadcast ||
    v2Parameter.nestedOnly ||
    !v2Major.allowed ||
    !v2Major.validateNestedBroadcast ||
    v2Major.nestedOnly
  ) {
    blockers.push("V2 broadcaster DAO rules are not active and well formed");
  }
  if (!registryAcceptsPolicyAction) {
    blockers.push("Registry rejects the exact ten-rule Major cleanup action");
  }
  for (const [label, result] of [
    ["Registry setRules", registryDryRun],
    ["pause V1 route", pauseV1RouteDryRun],
    ["revoke V1 Factory", revokeV1FactoryDryRun],
    ["revoke V1 legacy Probe", revokeV1ProbeDryRun],
    ["revoke V2 upgrade Probe", revokeV2ProbeDryRun],
  ] as const) {
    if (!result.succeeds)
      blockers.push(`${label} dry-run failed: ${result.error}`);
  }

  const unfinished = broadcasts.filter((item) => !item.status.executed);
  for (const item of unfinished) {
    if (item.currentCallFromV1Executor?.succeeds) {
      blockers.push(
        `Unfinished V1 nonce ${item.nonce} can still call ${item.target}`
      );
    } else {
      warnings.push(
        `V1 nonce ${item.nonce} is unfinished (${item.status.count}/2), but its exact target call is rejected under the current controller`
      );
    }
  }

  if (oldFactoryAllowed) {
    warnings.push("V1 Executor still allowlists the BSC DealFactory");
  }
  if (oldLegacyProbeAllowed) {
    warnings.push("V1 Executor still allowlists the legacy BSC Probe");
  }
  if (v2UpgradeProbeAllowed) {
    warnings.push("V2 Executor still allowlists the upgrade-test BSC Probe");
  }
  const activeCleanupRules = currentRules.filter(
    (item) => item.current.allowed
  ).length;
  if (activeCleanupRules > 0) {
    warnings.push(`${activeCleanupRules} legacy/test DAO rules remain active`);
  }
  if (proposerDcBalance < majorFee || proposerAllowance < majorFee) {
    warnings.push(
      "Future proposal creation still needs separately authorized DC funding/approval"
    );
  }

  const report = {
    schemaVersion: 1,
    scope:
      "read-only V1 retirement and test-permission cleanup audit; no transaction, proposal, stake, execution, commit or push",
    checkedAt,
    blocks: { ethereum: ethBlock, bsc: bscBlock },
    addresses: {
      proposer,
      governance,
      registry,
      dc,
      oldBroadcaster,
      oldExecutor,
      v2Broadcaster,
      v2Executor,
      bscFactory,
      probes: {
        legacy: { ethereum: ethLegacyProbe, bsc: bscLegacyProbe },
        upgradeV2: { ethereum: ethUpgradeProbe, bsc: bscUpgradeProbe },
      },
    },
    currentState: {
      factoryController,
      oldRouteActive: oldChainConfig[6],
      v2RouteActive: v2ChainConfig[6],
      oldBroadcastNonce,
      v2BroadcastNonce,
      thresholds: { old: oldThreshold, v2: v2Threshold },
      allowlists: {
        oldExecutor: {
          bscFactory: oldFactoryAllowed,
          legacyProbe: oldLegacyProbeAllowed,
        },
        v2Executor: {
          bscFactory: v2FactoryAllowed,
          upgradeProbe: v2UpgradeProbeAllowed,
        },
      },
      probes: {
        legacy: {
          ethereum: {
            controller: ethLegacyProbeController,
            version: ethLegacyProbeVersion,
          },
          bsc: {
            controller: bscLegacyProbeController,
            version: bscLegacyProbeVersion,
          },
        },
        upgradeV2: {
          ethereum: {
            controller: ethUpgradeProbeController,
            version: ethUpgradeProbeVersion,
          },
          bsc: {
            controller: bscUpgradeProbeController,
            version: bscUpgradeProbeVersion,
          },
        },
      },
      v2Rules: { parameter: v2Parameter, major: v2Major },
      cleanupRules: currentRules,
    },
    v1MessageAudit: {
      scannedFromBlock: V1_SCAN_FROM_BLOCK,
      scannedToBlock: ethBlock,
      eventCount: broadcasts.length,
      expectedEventCount: oldBroadcastNonce,
      unfinishedCount: unfinished.length,
      messages: broadcasts,
    },
    exactActions: {
      directOwnerActions: [
        {
          order: 1,
          chain: 56,
          target: oldExecutor,
          description:
            "V1 Executor revoke BSC DealFactory before any stale bridge confirmation",
          calldata: revokeV1FactoryCalldata,
          dryRun: revokeV1FactoryDryRun,
        },
        {
          order: 2,
          chain: 56,
          target: oldExecutor,
          description: "V1 Executor revoke legacy BSC Probe",
          calldata: revokeV1ProbeCalldata,
          dryRun: revokeV1ProbeDryRun,
        },
        {
          order: 3,
          chain: 1,
          target: oldBroadcaster,
          description: "Pause the V1 BSC route",
          calldata: pauseV1RouteCalldata,
          dryRun: pauseV1RouteDryRun,
        },
        {
          order: 4,
          chain: 56,
          target: v2Executor,
          description: "V2 Executor revoke upgrade-test BSC Probe",
          calldata: revokeV2ProbeCalldata,
          dryRun: revokeV2ProbeDryRun,
        },
      ],
      majorPolicyProposal: {
        predictedProposalId: proposalCount + 1n,
        kind: MAJOR,
        description: DESCRIPTION,
        target: registry,
        value: 0n,
        rules: disabledRules,
        setRulesCalldata,
        createProposalCalldata,
        registryAcceptsPolicyAction,
        setRulesDryRun: registryDryRun,
      },
      futureFeePreparation: {
        majorFee,
        majorFeeDC: formatEther(majorFee),
        proposerDcBalance,
        proposerAllowance,
        proposerIsMinter,
        mintFeeCalldata,
        approveFeeCalldata,
      },
    },
    assessment: {
      activeCleanupRules,
      readyForRetirementActions: blockers.length === 0,
      blockers,
      warnings,
      noTransactionSent: true,
    },
  };

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        report,
        (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        2
      )
    );
    return;
  }

  console.log("CCIP V1 retirement preflight (READ ONLY)");
  console.log(`Checked at: ${checkedAt}`);
  console.log(`ETH/BSC blocks: ${ethBlock} / ${bscBlock}`);
  console.log(`BSC Factory controller: ${factoryController}`);
  console.log(`V1/V2 route active: ${oldChainConfig[6]} / ${v2ChainConfig[6]}`);
  console.log(
    `V1 broadcasts audited: ${broadcasts.length}/${oldBroadcastNonce}`
  );
  console.log(`Unfinished V1 messages: ${unfinished.length}`);
  for (const item of unfinished) {
    console.log(
      `  nonce=${item.nonce} hash=${item.messageHash} confirmations=${item.status.count}/2 currentCallSucceeds=${item.currentCallFromV1Executor?.succeeds}`
    );
  }
  console.log(`Active legacy/test rules: ${activeCleanupRules}`);
  console.log(
    `Dry-runs: registry=${registryDryRun.succeeds} pauseV1=${pauseV1RouteDryRun.succeeds} revokeOldFactory=${revokeV1FactoryDryRun.succeeds} revokeOldProbe=${revokeV1ProbeDryRun.succeeds} revokeV2Probe=${revokeV2ProbeDryRun.succeeds}`
  );
  console.log(`Ready: ${blockers.length === 0}`);
  console.log(
    `Blockers: ${blockers.length === 0 ? "[]" : blockers.join(" | ")}`
  );
  console.log(`Warnings: ${warnings.join(" | ")}`);
  console.log(`Predicted proposal id: ${proposalCount + 1n}`);
  console.log(
    `setRules calldata: ${
      (setRulesCalldata.length - 2) / 2
    } bytes, hash=${keccak256(setRulesCalldata)}`
  );
  console.log(
    `createProposal calldata: ${
      (createProposalCalldata.length - 2) / 2
    } bytes, hash=${keccak256(createProposalCalldata)}`
  );
  console.log("Use --json to print the full exact calldata.");
  console.log("No transaction was sent.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
