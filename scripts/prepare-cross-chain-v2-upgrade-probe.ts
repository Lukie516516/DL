/**
 * Read-only production planner for a fresh, asset-free ETH/BSC UUPS upgrade probe.
 *
 * This script never loads a private key, never signs, and never sends a transaction.
 * Predicted addresses remain valid only while both recorded deployer nonces stay unchanged.
 *
 * Usage:
 *   node --import tsx/esm scripts/prepare-cross-chain-v2-upgrade-probe.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  getContractAddress,
  http,
  parseAbi,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { bsc, mainnet } from "viem/chains";

const ROOT = process.cwd();
const MAJOR = 2;
const BSC_CHAIN_KEY = 30102;
const LZ_GAS = 500_000n;
const FEE_BUDGET = parseEther("0.002");
const UPGRADE_SELECTOR = toFunctionSelector("upgradeToAndCall(address,bytes)");
const SET_RULES_SELECTOR = toFunctionSelector(
  "setRules((uint8,address,bytes4,bool,bool,bool,uint256)[])",
);
const BROADCAST_SELECTOR = toFunctionSelector(
  "broadcast(uint32[],address[],bytes,uint128)",
);
const POLICY_DESCRIPTION =
  "跨链升级探针授权\n\n仅授权全新无资产测试 Probe 的 UUPS 升级：ETH 仅允许 DAO 直接调用，BSC 仅允许跨链嵌套调用，value 均为 0；不涉及代币、国库、分红、中本聪账户、Factory 或任何业务合约。";
const UPGRADE_DESCRIPTION =
  "跨链升级探针测试\n\n把独立无资产 Probe 从 V1 升至 V2：ETH 由 DAO 直接升级，BSC 由 CrossChainBroadcasterV2 广播并在任意 2/3 桥确认后升级。只新增 version=2 只读能力，不转移资产、不修改业务地址或参数。";

type Artifact = {
  abi: readonly unknown[];
  bytecode: Hex;
  deployedBytecode: Hex;
};

type Deployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
};

type Stage1 = {
  stage: string;
  signers: { eth: Address; bsc: Address };
  eth: { address: Address; verified: boolean };
  bsc: { address: Address; verified: boolean };
};

type RuleView = readonly [boolean, boolean, boolean, bigint] & {
  allowed?: boolean;
  validateNestedBroadcast?: boolean;
  nestedOnly?: boolean;
  maxValue?: bigint;
};

const governanceAbi = parseAbi([
  "function policyRegistry() view returns (address)",
  "function proposalCount() view returns (uint256)",
  "function majorProposalFee() view returns (uint256)",
  "function activationThreshold() view returns (uint256)",
  "function createProposal(address[],uint256[],bytes[],string,uint8) returns (uint256)",
]);
const registryAbi = parseAbi([
  "function governance() view returns (address)",
  "function getRule(uint8,address,bytes4) view returns (bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)",
  "function isActionAllowed(uint8,address,uint256,bytes) view returns (bool)",
  "function setRules((uint8 kind,address target,bytes4 selector,bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)[])",
]);
const broadcasterAbi = parseAbi([
  "function owner() view returns (address)",
  "function governance() view returns (address)",
  "function broadcastNonce() view returns (uint256)",
  "function getChainIds() view returns (uint32[])",
  "function chains(uint32) view returns (uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
  "function quoteFees(uint32[],address[],bytes,uint128) view returns (uint256)",
  "function broadcast(uint32[],address[],bytes,uint128) payable",
]);
const executorAbi = parseAbi([
  "function owner() view returns (address)",
  "function threshold() view returns (uint256)",
  "function allowedTargets(address) view returns (bool)",
  "function setAllowedTarget(address,bool)",
]);
const dcAbi = parseAbi([
  "function MINTER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const probeAbi = parseAbi([
  "function initialize(address)",
  "function upgradeToAndCall(address,bytes) payable",
]);

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

function artifact(relativePath: string): Artifact {
  return loadJson<Artifact>(join("artifacts", relativePath));
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function ruleTuple(rule: RuleView): [boolean, boolean, boolean, bigint] {
  return [
    rule.allowed ?? rule[0],
    rule.validateNestedBroadcast ?? rule[1],
    rule.nestedOnly ?? rule[2],
    rule.maxValue ?? rule[3],
  ];
}

function runtimeBytes(artifact_: Artifact): number {
  return (artifact_.deployedBytecode.length - 2) / 2;
}

async function main() {
  loadEnv();
  const ethDeployment = loadJson<Deployment>("deployments/eth-mainnet-1.json");
  const bscDeployment = loadJson<Deployment>("deployments/bsc-mainnet-56.json");
  const stage1 = loadJson<Stage1>("deployments/ccip-v2-mainnet-stage1.json");
  if (ethDeployment.chainId !== 1 || bscDeployment.chainId !== 56) {
    throw new Error("Canonical deployment files must be ETH=1 and BSC=56");
  }
  if (
    stage1.stage !== "both_deployed" ||
    !stage1.eth.verified ||
    !stage1.bsc.verified
  ) {
    throw new Error("Verified CrossChainBroadcasterV2/ExecutorV2 deployment required");
  }

  const ethDeployer = getAddress(ethDeployment.deployer);
  const bscDeployer = getAddress(bscDeployment.deployer);
  if (
    getAddress(stage1.signers.eth) !== ethDeployer ||
    getAddress(stage1.signers.bsc) !== bscDeployer
  ) {
    throw new Error("Recorded deployment signers do not match canonical deployers");
  }

  const governance = getAddress(ethDeployment.addresses.dealGovernance);
  const registry = getAddress(ethDeployment.addresses.governancePolicyRegistry);
  const dc = getAddress(ethDeployment.addresses.dlToken);
  const broadcaster = getAddress(stage1.eth.address);
  const executor = getAddress(stage1.bsc.address);
  const ethClient = createPublicClient({
    chain: mainnet,
    transport: http(requiredEnv("ETH_MAINNET_RPC_URL")),
  });
  const bscClient = createPublicClient({
    chain: bsc,
    transport: http(
      process.env.BSC_MAINNET_RPC_URL?.trim() ||
        "https://bsc-mainnet.public.blastapi.io",
    ),
  });

  const [
    ethBlock,
    bscBlock,
    ethNonce,
    ethPendingNonce,
    bscNonce,
    bscPendingNonce,
    ethBalance,
    bscBalance,
    governanceRegistry,
    registryGovernance,
    broadcasterGovernance,
    broadcasterOwner,
    executorOwner,
    threshold,
    chainIds,
    route,
    broadcastNonce,
    proposalCount,
    majorProposalFee,
    activationThreshold,
    minterRole,
  ] = await Promise.all([
    ethClient.getBlockNumber(),
    bscClient.getBlockNumber(),
    ethClient.getTransactionCount({ address: ethDeployer }),
    ethClient.getTransactionCount({ address: ethDeployer, blockTag: "pending" }),
    bscClient.getTransactionCount({ address: bscDeployer }),
    bscClient.getTransactionCount({ address: bscDeployer, blockTag: "pending" }),
    ethClient.getBalance({ address: ethDeployer }),
    bscClient.getBalance({ address: bscDeployer }),
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
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "owner",
    }),
    bscClient.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "owner",
    }),
    bscClient.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "threshold",
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
      functionName: "broadcastNonce",
    }),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "proposalCount",
    }),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "majorProposalFee",
    }),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "activationThreshold",
    }),
    ethClient.readContract({
      address: dc,
      abi: dcAbi,
      functionName: "MINTER_ROLE",
    }),
  ]);

  const ethAddresses = {
    v1Implementation: getContractAddress({
      from: ethDeployer,
      nonce: BigInt(ethPendingNonce),
    }),
    proxy: getContractAddress({
      from: ethDeployer,
      nonce: BigInt(ethPendingNonce + 1),
    }),
    v2Implementation: getContractAddress({
      from: ethDeployer,
      nonce: BigInt(ethPendingNonce + 2),
    }),
  };
  const bscAddresses = {
    v1Implementation: getContractAddress({
      from: bscDeployer,
      nonce: BigInt(bscPendingNonce),
    }),
    proxy: getContractAddress({
      from: bscDeployer,
      nonce: BigInt(bscPendingNonce + 1),
    }),
    v2Implementation: getContractAddress({
      from: bscDeployer,
      nonce: BigInt(bscPendingNonce + 2),
    }),
  };

  const probeArtifact = artifact(
    "contracts/GovernanceProbe.sol/GovernanceProbe.json",
  );
  const upgradeArtifact = artifact(
    "contracts/test/GovernanceProbeUpgradeMock.sol/GovernanceProbeUpgradeMock.json",
  );
  const proxyArtifact = artifact("contracts/TestProxy.sol/ERC1967Proxy.json");
  const ethInit = encodeFunctionData({
    abi: probeAbi,
    functionName: "initialize",
    args: [governance],
  });
  const bscInit = encodeFunctionData({
    abi: probeAbi,
    functionName: "initialize",
    args: [executor],
  });
  const ethDeployData = [
    encodeDeployData({ abi: probeArtifact.abi, bytecode: probeArtifact.bytecode }),
    encodeDeployData({
      abi: proxyArtifact.abi,
      bytecode: proxyArtifact.bytecode,
      args: [ethAddresses.v1Implementation, ethInit],
    }),
    encodeDeployData({
      abi: upgradeArtifact.abi,
      bytecode: upgradeArtifact.bytecode,
    }),
  ];
  const bscDeployData = [
    encodeDeployData({ abi: probeArtifact.abi, bytecode: probeArtifact.bytecode }),
    encodeDeployData({
      abi: proxyArtifact.abi,
      bytecode: proxyArtifact.bytecode,
      args: [bscAddresses.v1Implementation, bscInit],
    }),
    encodeDeployData({
      abi: upgradeArtifact.abi,
      bytecode: upgradeArtifact.bytecode,
    }),
  ];

  const [
    ethCodes,
    bscCodes,
    ethV1Gas,
    ethV2Gas,
    bscV1Gas,
    bscV2Gas,
  ] = await Promise.all([
    Promise.all(
      Object.values(ethAddresses).map((address) =>
        ethClient.getCode({ address }),
      ),
    ),
    Promise.all(
      Object.values(bscAddresses).map((address) =>
        bscClient.getCode({ address }),
      ),
    ),
    ethClient.estimateGas({ account: ethDeployer, data: ethDeployData[0] }),
    ethClient.estimateGas({ account: ethDeployer, data: ethDeployData[2] }),
    bscClient.estimateGas({ account: bscDeployer, data: bscDeployData[0] }),
    bscClient.estimateGas({ account: bscDeployer, data: bscDeployData[2] }),
  ]);

  const rules = [
    {
      kind: MAJOR,
      target: ethAddresses.proxy,
      selector: UPGRADE_SELECTOR,
      allowed: true,
      validateNestedBroadcast: false,
      nestedOnly: false,
      maxValue: 0n,
    },
    {
      kind: MAJOR,
      target: bscAddresses.proxy,
      selector: UPGRADE_SELECTOR,
      allowed: true,
      validateNestedBroadcast: false,
      nestedOnly: true,
      maxValue: 0n,
    },
  ];
  const setRulesData = encodeFunctionData({
    abi: registryAbi,
    functionName: "setRules",
    args: [rules],
  });
  const ethUpgradeData = encodeFunctionData({
    abi: probeAbi,
    functionName: "upgradeToAndCall",
    args: [ethAddresses.v2Implementation, "0x"],
  });
  const bscUpgradeData = encodeFunctionData({
    abi: probeAbi,
    functionName: "upgradeToAndCall",
    args: [bscAddresses.v2Implementation, "0x"],
  });
  const broadcastData = encodeFunctionData({
    abi: broadcasterAbi,
    functionName: "broadcast",
    args: [[BSC_CHAIN_KEY], [bscAddresses.proxy], bscUpgradeData, LZ_GAS],
  });
  const policyProposalData = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [[registry], [0n], [setRulesData], POLICY_DESCRIPTION, MAJOR],
  });
  const upgradeProposalData = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [
      [ethAddresses.proxy, broadcaster],
      [0n, FEE_BUDGET],
      [ethUpgradeData, broadcastData],
      UPGRADE_DESCRIPTION,
      MAJOR,
    ],
  });

  const [
    setRulesPolicy,
    broadcasterPolicy,
    liveQuote,
    deployerIsMinter,
    deployerDcBalance,
    predictedBscAllowed,
  ] = await Promise.all([
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, registry, SET_RULES_SELECTOR],
    }) as Promise<RuleView>,
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, broadcaster, BROADCAST_SELECTOR],
    }) as Promise<RuleView>,
    ethClient.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "quoteFees",
      args: [[BSC_CHAIN_KEY], [bscAddresses.proxy], bscUpgradeData, LZ_GAS],
    }),
    ethClient.readContract({
      address: dc,
      abi: dcAbi,
      functionName: "hasRole",
      args: [minterRole, ethDeployer],
    }),
    ethClient.readContract({
      address: dc,
      abi: dcAbi,
      functionName: "balanceOf",
      args: [ethDeployer],
    }),
    bscClient.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "allowedTargets",
      args: [bscAddresses.proxy],
    }),
  ]);

  const blockers: string[] = [];
  if (ethNonce !== ethPendingNonce) blockers.push("ETH deployer has pending nonce");
  if (bscNonce !== bscPendingNonce) blockers.push("BSC deployer has pending nonce");
  if (ethCodes.some((code) => code && code !== "0x")) {
    blockers.push("An ETH predicted address already has code");
  }
  if (bscCodes.some((code) => code && code !== "0x")) {
    blockers.push("A BSC predicted address already has code");
  }
  if (
    getAddress(governanceRegistry) !== registry ||
    getAddress(registryGovernance) !== governance ||
    getAddress(broadcasterGovernance) !== governance
  ) {
    blockers.push("Governance/Registry/Broadcaster wiring mismatch");
  }
  if (getAddress(broadcasterOwner) !== ethDeployer) {
    blockers.push("Broadcaster owner is not the recorded ETH deployer");
  }
  if (getAddress(executorOwner) !== bscDeployer) {
    blockers.push("Executor owner is not the recorded BSC deployer");
  }
  if (threshold !== 2n) blockers.push(`Executor threshold is ${threshold}, not 2`);
  if (!chainIds.includes(BSC_CHAIN_KEY) || !route[6]) {
    blockers.push("BSC V2 route is not active");
  }
  const [setRulesAllowed, setRulesNested, setRulesNestedOnly, setRulesMax] =
    ruleTuple(setRulesPolicy);
  if (
    !setRulesAllowed ||
    setRulesNested ||
    setRulesNestedOnly ||
    setRulesMax !== 0n
  ) {
    blockers.push("Major setRules policy is not exact");
  }
  const [
    broadcastAllowed,
    broadcastValidatesNested,
    broadcastNestedOnly,
    broadcastMax,
  ] = ruleTuple(broadcasterPolicy);
  if (
    !broadcastAllowed ||
    !broadcastValidatesNested ||
    broadcastNestedOnly ||
    broadcastMax < FEE_BUDGET
  ) {
    blockers.push("Major broadcaster policy is missing or too narrow");
  }
  if (liveQuote > FEE_BUDGET) {
    blockers.push(`Live bridge quote ${liveQuote} exceeds fee budget ${FEE_BUDGET}`);
  }
  if (!deployerIsMinter) blockers.push("Recorded ETH deployer lacks DC MINTER_ROLE");
  if (predictedBscAllowed) {
    blockers.push("Predicted BSC proxy is unexpectedly already allowlisted");
  }

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    transactionSent: false,
    safeToStartDeployment: blockers.length === 0,
    blockers,
    snapshot: {
      ethBlock,
      bscBlock,
      governance,
      registry,
      broadcaster,
      executor,
      broadcasterNonce: broadcastNonce,
      proposalCount,
      expectedPolicyProposalId: proposalCount + 1n,
      expectedUpgradeProposalIdIfNoInterveningProposal: proposalCount + 2n,
      executorThreshold: threshold,
      routeActive: route[6],
      majorProposalFee,
      majorProposalFeeDc: formatUnits(majorProposalFee, 18),
      totalTwoProposalFeesDc: formatUnits(majorProposalFee * 2n, 18),
      activationThresholdD: formatUnits(activationThreshold, 18),
      ethDeployer,
      ethDeployerBalanceEth: formatEther(ethBalance),
      bscDeployer,
      bscDeployerBalanceBnb: formatEther(bscBalance),
      deployerDcBalance: formatUnits(deployerDcBalance, 18),
      deployerIsDcMinter: deployerIsMinter,
    },
    contracts: {
      source: "GovernanceProbe -> GovernanceProbeUpgradeMock",
      businessAssetsHeld: false,
      runtimeBytes: {
        v1: runtimeBytes(probeArtifact),
        v2: runtimeBytes(upgradeArtifact),
      },
      eth: {
        nonces: [ethPendingNonce, ethPendingNonce + 1, ethPendingNonce + 2],
        ...ethAddresses,
        controller: governance,
        estimatedDeploymentGas: {
          v1Implementation: ethV1Gas,
          proxy:
            "estimated only after V1 implementation exists; constructor delegates initialize",
          v2Implementation: ethV2Gas,
        },
      },
      bsc: {
        nonces: [bscPendingNonce, bscPendingNonce + 1, bscPendingNonce + 2],
        ...bscAddresses,
        controller: executor,
        estimatedDeploymentGas: {
          v1Implementation: bscV1Gas,
          proxy:
            "estimated only after V1 implementation exists; constructor delegates initialize",
          v2Implementation: bscV2Gas,
        },
      },
      addressWarning:
        "Predicted addresses are valid only if neither deployer nonce changes before its three deployments.",
    },
    setupAfterDeployment: {
      bscAllowlistTarget: executor,
      bscAllowlistCalldata: encodeFunctionData({
        abi: executorAbi,
        functionName: "setAllowedTarget",
        args: [bscAddresses.proxy, true],
      }),
      registryTarget: registry,
      rules,
      setRulesCalldata: setRulesData,
      policyProposalDescription: POLICY_DESCRIPTION,
      policyProposalCalldata: policyProposalData,
    },
    upgradeProposal: {
      description: UPGRADE_DESCRIPTION,
      ethUpgradeData,
      bscUpgradeData,
      broadcastData,
      bridgeFeeBudgetWei: FEE_BUDGET,
      liveBridgeQuoteWei: liveQuote,
      liveBridgeQuoteEth: formatEther(liveQuote),
      predictedBroadcastNonce: broadcastNonce + 1n,
      createProposalCalldata: upgradeProposalData,
    },
    forbiddenWithoutSeparateAuthorization: [
      "deploy contracts",
      "allowlist BSC target",
      "mint or approve DC",
      "create either proposal",
      "stake",
      "execute",
      "commit or push",
    ],
  };
  process.stdout.write(`${stringify(output)}\n`);
  if (blockers.length > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
