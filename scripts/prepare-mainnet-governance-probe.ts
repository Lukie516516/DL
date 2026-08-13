/**
 * Prepare and, only behind exact command-specific confirmations, deploy the
 * asset-free GovernanceProbe on Ethereum and BSC mainnet.
 *
 * Read-only preparation:
 *   node --import tsx/esm scripts/prepare-mainnet-governance-probe.ts status
 *
 * The only supported writes are deliberately split into independent phases:
 *   GOVERNANCE_PROBE_ETH_DEPLOY_CONFIRM=DEPLOY_GOVERNANCE_PROBE_ON_ETH_MAINNET \
 *     node --import tsx/esm scripts/prepare-mainnet-governance-probe.ts deploy-eth
 *   GOVERNANCE_PROBE_BSC_DEPLOY_CONFIRM=DEPLOY_GOVERNANCE_PROBE_ON_BSC_MAINNET \
 *     node --import tsx/esm scripts/prepare-mainnet-governance-probe.ts deploy-bsc
 *   GOVERNANCE_PROBE_BSC_ALLOWLIST_CONFIRM=ALLOWLIST_GOVERNANCE_PROBE_ON_BSC_MAINNET \
 *     node --import tsx/esm scripts/prepare-mainnet-governance-probe.ts allowlist-bsc
 *   GOVERNANCE_PROBE_POLICY_PROPOSAL_CONFIRM=CREATE_GOVERNANCE_PROBE_POLICY_PROPOSAL_ON_ETH_MAINNET \
 *     node --import tsx/esm scripts/prepare-mainnet-governance-probe.ts create-policy-proposal
 *   GOVERNANCE_PROBE_MAJOR_MARKER_POLICY_CONFIRM=CREATE_MAJOR_MARKER_POLICY_PROPOSAL_ON_ETH_MAINNET \
 *     node --import tsx/esm scripts/prepare-mainnet-governance-probe.ts create-major-marker-policy-proposal
 *   GOVERNANCE_PROBE_MAJOR_MARKER_PROPOSAL_CONFIRM=CREATE_MAJOR_MARKER_PROPOSAL_ON_ETH_MAINNET \
 *     node --import tsx/esm scripts/prepare-mainnet-governance-probe.ts create-major-marker-proposal
 *
 * The proposal phase is limited to exact-fee mint, exact approve, and proposal
 * creation. This script has no stake, execute, broadcast, upgrade, commit, or
 * push path.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  getAddress,
  getContractAddress,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, mainnet } from "viem/chains";

const STATE_FILE = join(process.cwd(), "deployments", "governance-probe-mainnet.json");
const ETH_DEPLOY_CONFIRM = "DEPLOY_GOVERNANCE_PROBE_ON_ETH_MAINNET";
const BSC_DEPLOY_CONFIRM = "DEPLOY_GOVERNANCE_PROBE_ON_BSC_MAINNET";
const BSC_ALLOWLIST_CONFIRM = "ALLOWLIST_GOVERNANCE_PROBE_ON_BSC_MAINNET";
const POLICY_PROPOSAL_CONFIRM = "CREATE_GOVERNANCE_PROBE_POLICY_PROPOSAL_ON_ETH_MAINNET";
const MAJOR_MARKER_POLICY_CONFIRM = "CREATE_MAJOR_MARKER_POLICY_PROPOSAL_ON_ETH_MAINNET";
const MAJOR_MARKER_PROPOSAL_CONFIRM = "CREATE_MAJOR_MARKER_PROPOSAL_ON_ETH_MAINNET";
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const ETH_CHAIN_ID = 1;
const BSC_CHAIN_ID = 56;
const BSC_CHAIN_KEY = 30102;
const BSC_MIN_GAS_PRICE = 50_000_000n;
const LZ_GAS = 500_000n;
const PARAMETER = 0;
const MAJOR = 2;
const ZERO_MARKER = `0x${"00".repeat(32)}` as Hex;
const MARKER = keccak256(stringToHex("DEAL_CROSS_CHAIN_GOVERNANCE_PROBE_V1"));
const POLICY_DESCRIPTION = "Enable ETH/BSC GovernanceProbe marker and UUPS rules";
const MAJOR_MARKER_POLICY_DESCRIPTION =
  "纯跨链治理测试前置策略（不影响现有业务）：唯一行为是为已部署的 ETH/BSC GovernanceProbe " +
  "新增 Major 类型 recordMarker(bytes32) 精确权限，使后续 Major 测试提案可以在两条链写入同一个测试 marker。" +
  "本提案本身不写 marker、不发送跨链消息、不转移代币，不调用国库/中本聪/分红，不升级合约，" +
  "不修改任何业务地址或业务参数；仅新增上述两条探针测试权限，且 action maxValue 均为 0。";
const MARKER_DESCRIPTION =
  "纯跨链治理链路测试（对现有业务干扰项=0）：执行时仅在 ETH GovernanceProbe 写入固定测试 marker，" +
  "并由 CrossChainBroadcaster 向 BSC GovernanceProbe 广播相同 recordMarker calldata，" +
  "以验证 ETH DAO→Broadcaster→BSC DualBridgeExecutor 的 2/3 确认与执行链路。" +
  "所有 action 仅作用于无业务资产的测试 Probe；不转移代币，不调用国库/中本聪/分红，不升级合约，" +
  "不修改业务地址或参数。创建时仅按 DAO 既定规则支付 1000 DC Major 提案费；" +
  "执行时除必要跨链消息费外 action value 为 0。";

type Artifact = { abi: readonly unknown[]; bytecode: Hex; deployedBytecode: Hex };
type Deployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
};
type CrossChainDeployment = {
  eth: { deployer: Address; broadcaster: Address };
  bsc: { deployer: Address; executor: Address };
  params: { bscChainKey: number };
};
type ProbeState = {
  preparedAt?: string;
  eth?: {
    implementation: Address;
    proxy: Address;
    deploymentTxs: Hex[];
    deployedAt: string;
  };
  bsc?: {
    implementation: Address;
    proxy: Address;
    deploymentTxs: Hex[];
    deployedAt: string;
    allowlistTx?: Hex;
  };
  policyProposal?: {
    proposalId: string;
    description: string;
    mintTx: Hex;
    approveTx: Hex;
    createTx: Hex;
    createdAt: string;
  };
  majorMarkerPolicyProposal?: {
    proposalId: string;
    description: string;
    mintTx: Hex;
    approveTx: Hex;
    createTx: Hex;
    createdAt: string;
    executionTx?: Hex;
    executedAt?: string;
  };
  majorMarkerProposal?: {
    proposalId: string;
    description: string;
    marker: Hex;
    feeQuoteWei: string;
    mintTx: Hex;
    approveTx: Hex;
    createTx: Hex;
    createdAt: string;
    stakedD?: string;
    executionTx?: Hex;
    executionBlock?: string;
    executedAt?: string;
    broadcastNonce?: string;
    messageHash?: Hex;
    bscExecutionTx?: Hex;
    bscExecutionBlock?: string;
    bscExecutedAt?: string;
    bridgeConfirmations?: {
      layerZero: { confirmed: boolean; tx?: Hex; block?: string; confirmedAt?: string };
      wormhole: { confirmed: boolean; tx?: Hex; block?: string; confirmedAt?: string; observedAt?: string };
      axelar: { confirmed: boolean; tx?: Hex; block?: string; confirmedAt?: string };
    };
  };
};

const governanceAbi = parseAbi([
  "function majorProposalFee() view returns (uint256)",
  "function activationThreshold() view returns (uint256)",
  "function fastPassThreshold() view returns (uint256)",
  "function treasury() view returns (address)",
  "function proposalCount() view returns (uint256)",
  "function createProposal(address[],uint256[],bytes[],string,uint8) returns (uint256)",
  "function getProposal(uint256) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description))",
  "function getActions(uint256) view returns (address[] targets,uint256[] values,bytes[] calldatas)",
  "function state(uint256) view returns (uint8)",
]);
const tokenAbi = parseAbi([
  "function MINTER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function mint(address,uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const registryAbi = parseAbi([
  "function governance() view returns (address)",
  "function getRule(uint8,address,bytes4) view returns ((bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue))",
  "function isActionAllowed(uint8,address,uint256,bytes) view returns (bool)",
  "function setRules((uint8 kind,address target,bytes4 selector,bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)[])"
]);
const broadcasterAbi = parseAbi([
  "function owner() view returns (address)",
  "function governance() view returns (address)",
  "function broadcastNonce() view returns (uint256)",
  "function getChainIds() view returns (uint32[])",
  "function chains(uint32) view returns (uint32 lzDstEid,uint16 whDstChain,address whDstAddress,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
  "function quoteFees(uint32[],address[],bytes,uint128) view returns (uint256)",
  "function broadcast(uint32[],address[],bytes,uint128) payable",
]);
const executorAbi = parseAbi([
  "function owner() view returns (address)",
  "function threshold() view returns (uint256)",
  "function allowedTargets(address) view returns (bool)",
  "function setAllowedTarget(address,bool)",
]);
const probeAbi = parseAbi([
  "function initialize(address)",
  "function controller() view returns (address)",
  "function marker() view returns (bytes32)",
  "function updateCount() view returns (uint256)",
  "function version() view returns (uint256)",
  "function recordMarker(bytes32)",
  "function proxiableUUID() view returns (bytes32)",
  "function upgradeToAndCall(address,bytes) payable",
]);

loadEnv();

const ethDeployment = loadJson<Deployment>("deployments/eth-mainnet-1.json");
const bscDeployment = loadJson<Deployment>("deployments/bsc-mainnet-56.json");
const crossChain = loadJson<CrossChainDeployment>("deployments/mainnet-cross-chain.json");
const governance = getAddress(ethDeployment.addresses.dealGovernance);
const registry = getAddress(ethDeployment.addresses.governancePolicyRegistry);
const broadcaster = getAddress(ethDeployment.addresses.crossChainBroadcaster);
const dc = getAddress(ethDeployment.addresses.dlToken);
const d = getAddress(ethDeployment.addresses.dToken);
const executor = getAddress(crossChain.bsc.executor);

const ethRpc = requiredEnv("ETH_MAINNET_RPC_URL");
const bscRpc = process.env.BSC_MAINNET_RPC_URL?.trim() || "https://bsc-rpc.publicnode.com";
const ethAccount = privateKeyToAccount(privateKey("ETH_MAINNET_PRIVATE_KEY", "AGIKING_PRIVATE_KEY"));
const bscAccount = privateKeyToAccount(privateKey("BSC_MAINNET_PRIVATE_KEY", "AGIKING_PRIVATE_KEY"));
const ethPublic = createPublicClient({ chain: mainnet, transport: http(ethRpc) });
const bscPublic = createPublicClient({ chain: bsc, transport: http(bscRpc) });
const ethWallet = createWalletClient({ account: ethAccount, chain: mainnet, transport: http(ethRpc) });
const bscWallet = createWalletClient({ account: bscAccount, chain: bsc, transport: http(bscRpc) });

const probeArtifact = artifact("contracts/GovernanceProbe.sol/GovernanceProbe.json");
const proxyArtifact = artifact("contracts/TestProxy.sol/ERC1967Proxy.json");

function loadEnv() {
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) process.env[match[1].trim()] ||= match[2].trim();
    }
  } catch {}
}

function loadJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), relativePath), "utf8")) as T;
}

function artifact(relativePath: string): Artifact {
  return loadJson<Artifact>(join("artifacts", relativePath));
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function privateKey(primary: string, fallback: string): Hex {
  const raw = process.env[primary]?.trim() || process.env[fallback]?.trim();
  if (!raw) throw new Error(`Missing ${primary} and fallback ${fallback}`);
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

function loadState(): ProbeState {
  return existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, "utf8")) as ProbeState
    : {};
}

function saveState(state: ProbeState) {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function size(bytecode: Hex): number {
  return (bytecode.length - 2) / 2;
}

function sameAddress(actual: unknown, expected: Address): boolean {
  return String(actual).toLowerCase() === expected.toLowerCase();
}

function slotAddress(word: Hex | undefined): Address {
  if (!word || word.length !== 66) throw new Error("Proxy implementation slot is missing");
  return getAddress(`0x${word.slice(-40)}`);
}

async function assertCode(client: typeof ethPublic | typeof bscPublic, label: string, address: Address) {
  const code = await client.getCode({ address });
  if (!code || code === "0x") throw new Error(`${label} has no code at ${address}`);
}

async function assertEmpty(client: typeof ethPublic | typeof bscPublic, label: string, address: Address) {
  const code = await client.getCode({ address });
  if (code && code !== "0x") throw new Error(`${label} already has code at ${address}`);
}

async function waitFor(client: typeof ethPublic | typeof bscPublic, hash: Hex, label: string) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  console.log(`  OK ${label}: ${hash}`);
  return receipt;
}

async function verifyProbe(
  client: typeof ethPublic | typeof bscPublic,
  implementation: Address,
  proxy: Address,
  expectedController: Address,
  expectedMarker: Hex = ZERO_MARKER,
  expectedCount = 0n,
) {
  await assertCode(client, "GovernanceProbe implementation", implementation);
  await assertCode(client, "GovernanceProbe proxy", proxy);
  const [uuid, slot, controller, marker, count, version] = await Promise.all([
    client.readContract({ address: implementation, abi: probeAbi, functionName: "proxiableUUID" }),
    client.getStorageAt({ address: proxy, slot: IMPLEMENTATION_SLOT }),
    client.readContract({ address: proxy, abi: probeAbi, functionName: "controller" }),
    client.readContract({ address: proxy, abi: probeAbi, functionName: "marker" }),
    client.readContract({ address: proxy, abi: probeAbi, functionName: "updateCount" }),
    client.readContract({ address: proxy, abi: probeAbi, functionName: "version" }),
  ]);
  if (uuid.toLowerCase() !== IMPLEMENTATION_SLOT.toLowerCase()) throw new Error("Unexpected UUPS UUID");
  if (!sameAddress(slotAddress(slot), implementation)) throw new Error("Proxy implementation mismatch");
  if (!sameAddress(controller, expectedController)) throw new Error("Probe controller mismatch");
  if (marker !== expectedMarker || count !== expectedCount || version !== 1n) {
    throw new Error(
      `GovernanceProbe state mismatch: marker=${marker}, count=${count}, version=${version}`,
    );
  }
}

async function main() {
  const supportedCommands = [
    "status",
    "deploy-eth",
    "deploy-bsc",
    "allowlist-bsc",
    "create-policy-proposal",
    "create-major-marker-policy-proposal",
    "create-major-marker-proposal",
  ] as const;
  const command = process.argv.find((arg): arg is typeof supportedCommands[number] =>
    supportedCommands.includes(arg as typeof supportedCommands[number])
  ) || "status";
  if (!supportedCommands.includes(command)) {
    throw new Error(`Unknown command ${command}`);
  }
  if (ethDeployment.chainId !== ETH_CHAIN_ID || bscDeployment.chainId !== BSC_CHAIN_ID) {
    throw new Error("Deployment files do not match ETH=1 and BSC=56");
  }
  if (crossChain.params.bscChainKey !== BSC_CHAIN_KEY) throw new Error("Unexpected BSC chain key");
  if (!sameAddress(crossChain.eth.broadcaster, broadcaster) ||
      !sameAddress(crossChain.bsc.executor, executor)) {
    throw new Error("Cross-chain deployment addresses do not match the canonical deployment files");
  }
  if (!sameAddress(ethAccount.address, ethDeployment.deployer) ||
      !sameAddress(bscAccount.address, bscDeployment.deployer)) {
    throw new Error("Configured deployment wallet does not match the recorded mainnet deployer");
  }

  const [ethChainId, bscChainId, ethBlock, bscBlock, ethNonce, ethPending, bscNonce, bscPending] =
    await Promise.all([
      ethPublic.getChainId(),
      bscPublic.getChainId(),
      ethPublic.getBlockNumber(),
      bscPublic.getBlockNumber(),
      ethPublic.getTransactionCount({ address: ethAccount.address }),
      ethPublic.getTransactionCount({ address: ethAccount.address, blockTag: "pending" }),
      bscPublic.getTransactionCount({ address: bscAccount.address }),
      bscPublic.getTransactionCount({ address: bscAccount.address, blockTag: "pending" }),
    ]);
  if (ethChainId !== ETH_CHAIN_ID || bscChainId !== BSC_CHAIN_ID) throw new Error("RPC chain mismatch");
  if (ethNonce !== ethPending || bscNonce !== bscPending) {
    throw new Error("Refusing to prepare while the configured wallet has pending transactions");
  }

  const state = loadState();
  const ethImplementation = state.eth?.implementation || getContractAddress({
    from: ethAccount.address,
    nonce: BigInt(ethPending),
  });
  const ethProxy = state.eth?.proxy || getContractAddress({
    from: ethAccount.address,
    nonce: BigInt(ethPending + 1),
  });
  const bscImplementation = state.bsc?.implementation || getContractAddress({
    from: bscAccount.address,
    nonce: BigInt(bscPending),
  });
  const bscProxy = state.bsc?.proxy || getContractAddress({
    from: bscAccount.address,
    nonce: BigInt(bscPending + 1),
  });
  const ethInit = encodeFunctionData({ abi: probeAbi, functionName: "initialize", args: [governance] });
  const bscInit = encodeFunctionData({ abi: probeAbi, functionName: "initialize", args: [executor] });
  const ethImplementationDeployData = encodeDeployData({
    abi: probeArtifact.abi,
    bytecode: probeArtifact.bytecode,
  });
  const bscImplementationDeployData = ethImplementationDeployData;
  const ethProxyDeployData = encodeDeployData({
    abi: proxyArtifact.abi,
    bytecode: proxyArtifact.bytecode,
    args: [ethImplementation, ethInit],
  });
  const bscProxyDeployData = encodeDeployData({
    abi: proxyArtifact.abi,
    bytecode: proxyArtifact.bytecode,
    args: [bscImplementation, bscInit],
  });

  for (const [label, runtime, creation] of [
    ["GovernanceProbe", size(probeArtifact.deployedBytecode), size(probeArtifact.bytecode)],
    ["ERC1967Proxy", size(proxyArtifact.deployedBytecode), size(proxyArtifact.bytecode)],
  ] as const) {
    if (runtime > 24_576 || creation > 49_152) throw new Error(`${label} exceeds EVM code-size limit`);
  }

  for (const [client, label, address] of [
    [ethPublic, "ETH DealGovernance", governance],
    [ethPublic, "GovernancePolicyRegistry", registry],
    [ethPublic, "CrossChainBroadcaster", broadcaster],
    [bscPublic, "DualBridgeExecutor", executor],
  ] as const) await assertCode(client, label, address);

  const [ethNative, bscNative, broadcasterOwner, broadcasterGovernance, executorOwner, threshold,
    registryGovernance, chainIds, bscChainConfig, broadcastNonce, majorFee, activation, fastPass,
    proposalCount, dcBalance, dcAllowance, dBalance] = await Promise.all([
      ethPublic.getBalance({ address: ethAccount.address }),
      bscPublic.getBalance({ address: bscAccount.address }),
      ethPublic.readContract({ address: broadcaster, abi: broadcasterAbi, functionName: "owner" }),
      ethPublic.readContract({ address: broadcaster, abi: broadcasterAbi, functionName: "governance" }),
      bscPublic.readContract({ address: executor, abi: executorAbi, functionName: "owner" }),
      bscPublic.readContract({ address: executor, abi: executorAbi, functionName: "threshold" }),
      ethPublic.readContract({ address: registry, abi: registryAbi, functionName: "governance" }),
      ethPublic.readContract({ address: broadcaster, abi: broadcasterAbi, functionName: "getChainIds" }),
      ethPublic.readContract({ address: broadcaster, abi: broadcasterAbi, functionName: "chains", args: [BSC_CHAIN_KEY] }),
      ethPublic.readContract({ address: broadcaster, abi: broadcasterAbi, functionName: "broadcastNonce" }),
      ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "majorProposalFee" }),
      ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "activationThreshold" }),
      ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "fastPassThreshold" }),
      ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "proposalCount" }),
      ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [ethAccount.address] }),
      ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [ethAccount.address, governance] }),
      ethPublic.readContract({ address: d, abi: tokenAbi, functionName: "balanceOf", args: [ethAccount.address] }),
    ]);
  for (const [label, actual, expected] of [
    ["Broadcaster owner", broadcasterOwner, ethAccount.address],
    ["Broadcaster governance", broadcasterGovernance, governance],
    ["Executor owner", executorOwner, bscAccount.address],
    ["Registry governance", registryGovernance, governance],
  ] as const) if (!sameAddress(actual, expected)) throw new Error(`${label} mismatch`);
  if (threshold !== 2n) throw new Error(`Unexpected executor threshold ${threshold}`);
  if (chainIds.length !== 1 || chainIds[0] !== BSC_CHAIN_KEY || !bscChainConfig[6]) {
    throw new Error("Expected BSC to be the only active satellite chain");
  }

  if (state.eth) await verifyProbe(
    ethPublic,
    ethImplementation,
    ethProxy,
    governance,
    state.majorMarkerProposal?.executedAt ? state.majorMarkerProposal.marker : ZERO_MARKER,
    state.majorMarkerProposal?.executedAt ? 1n : 0n,
  );
  else await Promise.all([
    assertEmpty(ethPublic, "predicted ETH implementation", ethImplementation),
    assertEmpty(ethPublic, "predicted ETH proxy", ethProxy),
  ]);
  if (state.bsc) await verifyProbe(
    bscPublic,
    bscImplementation,
    bscProxy,
    executor,
    state.majorMarkerProposal?.bscExecutedAt ? state.majorMarkerProposal.marker : ZERO_MARKER,
    state.majorMarkerProposal?.bscExecutedAt ? 1n : 0n,
  );
  else await Promise.all([
    assertEmpty(bscPublic, "predicted BSC implementation", bscImplementation),
    assertEmpty(bscPublic, "predicted BSC proxy", bscProxy),
  ]);

  const markerData = encodeFunctionData({ abi: probeAbi, functionName: "recordMarker", args: [MARKER] });
  const markerSelector = toFunctionSelector("recordMarker(bytes32)");
  const upgradeSelector = toFunctionSelector("upgradeToAndCall(address,bytes)");
  const probeRules = [
    { kind: PARAMETER, target: ethProxy, selector: markerSelector, allowed: true, validateNestedBroadcast: false, nestedOnly: false, maxValue: 0n },
    { kind: PARAMETER, target: bscProxy, selector: markerSelector, allowed: true, validateNestedBroadcast: false, nestedOnly: true, maxValue: 0n },
    { kind: MAJOR, target: ethProxy, selector: upgradeSelector, allowed: true, validateNestedBroadcast: false, nestedOnly: false, maxValue: 0n },
    { kind: MAJOR, target: bscProxy, selector: upgradeSelector, allowed: true, validateNestedBroadcast: false, nestedOnly: true, maxValue: 0n },
  ];
  const majorMarkerRules = [
    { kind: MAJOR, target: ethProxy, selector: markerSelector, allowed: true, validateNestedBroadcast: false, nestedOnly: false, maxValue: 0n },
    { kind: MAJOR, target: bscProxy, selector: markerSelector, allowed: true, validateNestedBroadcast: false, nestedOnly: true, maxValue: 0n },
  ];
  const setRulesData = encodeFunctionData({ abi: registryAbi, functionName: "setRules", args: [probeRules] });
  const setMajorMarkerRulesData = encodeFunctionData({
    abi: registryAbi,
    functionName: "setRules",
    args: [majorMarkerRules],
  });
  const [policyAllowed, majorMarkerPolicyAllowed] = await Promise.all([
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "isActionAllowed",
      args: [MAJOR, registry, 0n, setRulesData],
    }),
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "isActionAllowed",
      args: [MAJOR, registry, 0n, setMajorMarkerRulesData],
    }),
  ]);
  if (!policyAllowed) throw new Error("Current policy does not allow the four-rule Major proposal");
  if (!majorMarkerPolicyAllowed) throw new Error("Current policy does not allow the Major marker policy proposal");
  const feeQuote = await ethPublic.readContract({
    address: broadcaster,
    abi: broadcasterAbi,
    functionName: "quoteFees",
    args: [[BSC_CHAIN_KEY], [bscProxy], markerData, LZ_GAS],
  });
  const broadcastSelector = toFunctionSelector("broadcast(uint32[],address[],bytes,uint128)");
  const [parameterBroadcastRule, majorBroadcastRule] = await Promise.all([
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [PARAMETER, broadcaster, broadcastSelector],
    }),
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, broadcaster, broadcastSelector],
    }),
  ]);
  for (const [label, rule] of [
    ["Parameter broadcaster rule", parameterBroadcastRule],
    ["Major broadcaster rule", majorBroadcastRule],
  ] as const) {
    if (!rule.allowed || !rule.validateNestedBroadcast || rule.nestedOnly || rule.maxValue < feeQuote) {
      throw new Error(`${label} is missing, malformed, or below the current fee quote`);
    }
  }
  const broadcastData = encodeFunctionData({
    abi: broadcasterAbi,
    functionName: "broadcast",
    args: [[BSC_CHAIN_KEY], [bscProxy], markerData, LZ_GAS],
  });
  const policyProposalCalldata = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [[registry], [0n], [setRulesData], POLICY_DESCRIPTION, MAJOR],
  });
  const majorMarkerPolicyProposalCalldata = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [[registry], [0n], [setMajorMarkerRulesData], MAJOR_MARKER_POLICY_DESCRIPTION, MAJOR],
  });
  const markerProposalCalldata = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [[ethProxy, broadcaster], [0n, feeQuote], [markerData, broadcastData], MARKER_DESCRIPTION, PARAMETER],
  });
  const majorMarkerProposalCalldata = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [[ethProxy, broadcaster], [0n, feeQuote], [markerData, broadcastData], MARKER_DESCRIPTION, MAJOR],
  });
  const allowlistCalldata = encodeFunctionData({
    abi: executorAbi,
    functionName: "setAllowedTarget",
    args: [bscProxy, true],
  });
  const bscAllowed = await bscPublic.readContract({
    address: executor,
    abi: executorAbi,
    functionName: "allowedTargets",
    args: [bscProxy],
  });

  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    blocks: { eth: ethBlock.toString(), bsc: bscBlock.toString() },
    wallet: {
      address: ethAccount.address,
      eth: formatEther(ethNative),
      bnb: formatEther(bscNative),
      nonce: { eth: ethPending, bsc: bscPending },
    },
    contracts: { governance, registry, broadcaster, executor },
    probe: {
      marker: MARKER,
      eth: { implementation: ethImplementation, proxy: ethProxy, controller: governance },
      bsc: { implementation: bscImplementation, proxy: bscProxy, controller: executor, allowed: bscAllowed },
      sizes: {
        implementationCreation: size(probeArtifact.bytecode),
        implementationRuntime: size(probeArtifact.deployedBytecode),
        proxyCreation: size(proxyArtifact.bytecode),
        proxyRuntime: size(proxyArtifact.deployedBytecode),
      },
    },
    governanceReadiness: {
      proposalCount: proposalCount.toString(),
      majorFeeDC: formatEther(majorFee),
      walletDC: formatEther(dcBalance),
      walletDCAllowance: formatEther(dcAllowance),
      activationThresholdD: formatEther(activation),
      fastPassThresholdD: formatEther(fastPass),
      walletD: formatEther(dBalance),
      broadcastNonce: broadcastNonce.toString(),
      parameterBroadcastMaxValueWei: parameterBroadcastRule.maxValue.toString(),
      majorBroadcastMaxValueWei: majorBroadcastRule.maxValue.toString(),
      lzGas: LZ_GAS.toString(),
      feeQuoteWei: feeQuote.toString(),
    },
    rules: probeRules,
    majorMarkerRules,
    transactionData: {
      ethImplementationDeploy: ethImplementationDeployData,
      ethProxyDeploy: ethProxyDeployData,
      bscImplementationDeploy: bscImplementationDeployData,
      bscProxyDeploy: bscProxyDeployData,
      bscAllowlist: allowlistCalldata,
      policySetRules: setRulesData,
      policyProposal: policyProposalCalldata,
      majorMarkerPolicySetRules: setMajorMarkerRulesData,
      majorMarkerPolicyProposal: majorMarkerPolicyProposalCalldata,
      markerAction: markerData,
      markerBroadcast: broadcastData,
      markerProposal: markerProposalCalldata,
      majorMarkerProposal: majorMarkerProposalCalldata,
    },
  }, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));

  if (command === "status") {
    console.log("\nDRY-RUN ONLY: no transaction sent and no state file changed.");
    return;
  }
  if (command === "deploy-eth") {
    if (process.env.GOVERNANCE_PROBE_ETH_DEPLOY_CONFIRM !== ETH_DEPLOY_CONFIRM) {
      throw new Error("Missing exact ETH deployment confirmation");
    }
    if (state.eth) throw new Error("ETH GovernanceProbe is already recorded as deployed");
    const implementationHash = await ethWallet.sendTransaction({
      account: ethAccount,
      chain: mainnet,
      data: ethImplementationDeployData,
    });
    const implementationReceipt = await waitFor(ethPublic, implementationHash, "deploy ETH implementation");
    if (!sameAddress(implementationReceipt.contractAddress, ethImplementation)) throw new Error("ETH implementation address mismatch");
    const proxyHash = await ethWallet.sendTransaction({ account: ethAccount, chain: mainnet, data: ethProxyDeployData });
    const proxyReceipt = await waitFor(ethPublic, proxyHash, "deploy ETH proxy");
    if (!sameAddress(proxyReceipt.contractAddress, ethProxy)) throw new Error("ETH proxy address mismatch");
    await verifyProbe(ethPublic, ethImplementation, ethProxy, governance);
    saveState({
      ...state,
      preparedAt: new Date().toISOString(),
      eth: { implementation: ethImplementation, proxy: ethProxy, deploymentTxs: [implementationHash, proxyHash], deployedAt: new Date().toISOString() },
    });
    return;
  }
  if (command === "deploy-bsc") {
    if (process.env.GOVERNANCE_PROBE_BSC_DEPLOY_CONFIRM !== BSC_DEPLOY_CONFIRM) {
      throw new Error("Missing exact BSC deployment confirmation");
    }
    if (state.bsc) throw new Error("BSC GovernanceProbe is already recorded as deployed");
    const implementationHash = await bscWallet.sendTransaction({
      account: bscAccount,
      chain: bsc,
      data: bscImplementationDeployData,
      gasPrice: BSC_MIN_GAS_PRICE,
    });
    const implementationReceipt = await waitFor(bscPublic, implementationHash, "deploy BSC implementation");
    if (!sameAddress(implementationReceipt.contractAddress, bscImplementation)) throw new Error("BSC implementation address mismatch");
    const proxyHash = await bscWallet.sendTransaction({
      account: bscAccount,
      chain: bsc,
      data: bscProxyDeployData,
      gasPrice: BSC_MIN_GAS_PRICE,
    });
    const proxyReceipt = await waitFor(bscPublic, proxyHash, "deploy BSC proxy");
    if (!sameAddress(proxyReceipt.contractAddress, bscProxy)) throw new Error("BSC proxy address mismatch");
    await verifyProbe(bscPublic, bscImplementation, bscProxy, executor);
    saveState({
      ...state,
      preparedAt: new Date().toISOString(),
      bsc: { implementation: bscImplementation, proxy: bscProxy, deploymentTxs: [implementationHash, proxyHash], deployedAt: new Date().toISOString() },
    });
    return;
  }
  if (command === "allowlist-bsc") {
    if (process.env.GOVERNANCE_PROBE_BSC_ALLOWLIST_CONFIRM !== BSC_ALLOWLIST_CONFIRM) {
      throw new Error("Missing exact BSC allowlist confirmation");
    }
    if (!state.bsc) throw new Error("BSC GovernanceProbe deployment is not recorded");
    if (bscAllowed) throw new Error("BSC GovernanceProbe is already allowlisted");
    const allowlistHash = await bscWallet.writeContract({
      account: bscAccount,
      chain: bsc,
      address: executor,
      abi: executorAbi,
      functionName: "setAllowedTarget",
      args: [bscProxy, true],
      gasPrice: BSC_MIN_GAS_PRICE,
    });
    await waitFor(bscPublic, allowlistHash, "allowlist BSC GovernanceProbe proxy");
    if (!(await bscPublic.readContract({ address: executor, abi: executorAbi, functionName: "allowedTargets", args: [bscProxy] }))) {
      throw new Error("BSC allowlist verification failed");
    }
    saveState({ ...state, bsc: { ...state.bsc, allowlistTx: allowlistHash } });
    return;
  }

  if (command === "create-major-marker-policy-proposal") {
    if (process.env.GOVERNANCE_PROBE_MAJOR_MARKER_POLICY_CONFIRM !== MAJOR_MARKER_POLICY_CONFIRM) {
      throw new Error("Missing exact Major marker policy proposal confirmation");
    }
    if (!state.eth || !state.bsc) throw new Error("Both GovernanceProbe deployments must be recorded");
    if (!bscAllowed) throw new Error("BSC GovernanceProbe proxy is not allowlisted");
    if (state.majorMarkerPolicyProposal) {
      throw new Error(
        `Major marker policy proposal ${state.majorMarkerPolicyProposal.proposalId} is already recorded`,
      );
    }
    if (majorFee !== 1_000n * 10n ** 18n) throw new Error(`Unexpected Major proposal fee ${majorFee}`);
    if (dcBalance !== 0n || dcAllowance !== 0n) {
      throw new Error(`Expected exact zero proposer DC balance/allowance before mint, got ${dcBalance}/${dcAllowance}`);
    }

    const currentMajorMarkerRules = await Promise.all(majorMarkerRules.map((rule) =>
      ethPublic.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "getRule",
        args: [rule.kind, rule.target, rule.selector],
      })
    ));
    if (currentMajorMarkerRules.some((rule) =>
      rule.allowed || rule.validateNestedBroadcast || rule.nestedOnly || rule.maxValue !== 0n
    )) {
      throw new Error("At least one Major GovernanceProbe marker rule is already configured");
    }

    const [minterRole, treasury, totalSupplyBefore] = await Promise.all([
      ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "MINTER_ROLE" }),
      ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "treasury" }),
      ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    ]);
    const [canMint, treasuryBalanceBefore] = await Promise.all([
      ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "hasRole", args: [minterRole, ethAccount.address] }),
      ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
    ]);
    if (!canMint) throw new Error("Configured ETH wallet does not have DC MINTER_ROLE");

    const mintHash = await ethWallet.writeContract({
      account: ethAccount,
      chain: mainnet,
      address: dc,
      abi: tokenAbi,
      functionName: "mint",
      args: [ethAccount.address, majorFee],
    });
    await waitFor(ethPublic, mintHash, "mint exact Major marker policy proposal fee");
    const [balanceAfterMint, supplyAfterMint] = await Promise.all([
      ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [ethAccount.address] }),
      ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    ]);
    if (balanceAfterMint !== majorFee || supplyAfterMint !== totalSupplyBefore + majorFee) {
      throw new Error("Exact DC mint verification failed");
    }

    const approveHash = await ethWallet.writeContract({
      account: ethAccount,
      chain: mainnet,
      address: dc,
      abi: tokenAbi,
      functionName: "approve",
      args: [governance, majorFee],
    });
    await waitFor(ethPublic, approveHash, "approve exact Major marker policy proposal fee");
    if ((await ethPublic.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [ethAccount.address, governance],
    })) !== majorFee) {
      throw new Error("Exact DC allowance verification failed");
    }

    const proposalArgs = [
      [registry],
      [0n],
      [setMajorMarkerRulesData],
      MAJOR_MARKER_POLICY_DESCRIPTION,
      MAJOR,
    ] as const;
    const simulation = await ethPublic.simulateContract({
      account: ethAccount.address,
      address: governance,
      abi: governanceAbi,
      functionName: "createProposal",
      args: proposalArgs,
    });
    if (simulation.result !== proposalCount + 1n) throw new Error("Unexpected simulated proposal id");

    const createHash = await ethWallet.writeContract({
      account: ethAccount,
      chain: mainnet,
      address: governance,
      abi: governanceAbi,
      functionName: "createProposal",
      args: proposalArgs,
    });
    await waitFor(ethPublic, createHash, "create Major marker policy proposal");

    const proposalId = proposalCount + 1n;
    const zeroMarker = `0x${"00".repeat(32)}`;
    const [proposalCountAfter, proposal, actions, proposalState, balanceAfter, allowanceAfter,
      supplyAfter, treasuryBalanceAfter, rulesAfter, ethMarkerAfter, ethCountAfter,
      bscMarkerAfter, bscCountAfter, broadcastNonceAfter] = await Promise.all([
        ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "proposalCount" }),
        ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "getProposal", args: [proposalId] }),
        ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "getActions", args: [proposalId] }),
        ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "state", args: [proposalId] }),
        ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [ethAccount.address] }),
        ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [ethAccount.address, governance] }),
        ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
        ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
        Promise.all(majorMarkerRules.map((rule) => ethPublic.readContract({
          address: registry,
          abi: registryAbi,
          functionName: "getRule",
          args: [rule.kind, rule.target, rule.selector],
        }))),
        ethPublic.readContract({ address: ethProxy, abi: probeAbi, functionName: "marker" }),
        ethPublic.readContract({ address: ethProxy, abi: probeAbi, functionName: "updateCount" }),
        bscPublic.readContract({ address: bscProxy, abi: probeAbi, functionName: "marker" }),
        bscPublic.readContract({ address: bscProxy, abi: probeAbi, functionName: "updateCount" }),
        ethPublic.readContract({ address: broadcaster, abi: broadcasterAbi, functionName: "broadcastNonce" }),
      ]);
    if (proposalCountAfter !== proposalId || proposalState !== 1) {
      throw new Error("Created Major marker policy proposal is not Pending");
    }
    if (!sameAddress(proposal.proposer, ethAccount.address) || proposal.kind !== MAJOR ||
        proposal.totalStaked !== 0n || proposal.description !== MAJOR_MARKER_POLICY_DESCRIPTION) {
      throw new Error("Created Major marker policy proposal metadata mismatch");
    }
    if (actions[0].length !== 1 || !sameAddress(actions[0][0], registry) ||
        actions[1].length !== 1 || actions[1][0] !== 0n ||
        actions[2].length !== 1 || actions[2][0].toLowerCase() !== setMajorMarkerRulesData.toLowerCase()) {
      throw new Error("Created Major marker policy proposal actions mismatch");
    }
    if (balanceAfter !== 0n || allowanceAfter !== 0n || supplyAfter !== totalSupplyBefore + majorFee ||
        treasuryBalanceAfter !== treasuryBalanceBefore + majorFee) {
      throw new Error("Major marker policy proposal fee accounting mismatch");
    }
    if (rulesAfter.some((rule) =>
      rule.allowed || rule.validateNestedBroadcast || rule.nestedOnly || rule.maxValue !== 0n
    )) {
      throw new Error("Major marker rules changed before proposal execution");
    }
    if (ethMarkerAfter !== zeroMarker || ethCountAfter !== 0n ||
        bscMarkerAfter !== zeroMarker || bscCountAfter !== 0n || broadcastNonceAfter !== broadcastNonce) {
      throw new Error("Probe or broadcaster state changed during proposal creation");
    }
    saveState({
      ...state,
      majorMarkerPolicyProposal: {
        proposalId: proposalId.toString(),
        description: MAJOR_MARKER_POLICY_DESCRIPTION,
        mintTx: mintHash,
        approveTx: approveHash,
        createTx: createHash,
        createdAt: new Date().toISOString(),
      },
    });
    console.log(`  proposalId: ${proposalId}`);
    return;
  }

  if (command === "create-major-marker-proposal") {
    if (process.env.GOVERNANCE_PROBE_MAJOR_MARKER_PROPOSAL_CONFIRM !== MAJOR_MARKER_PROPOSAL_CONFIRM) {
      throw new Error("Missing exact Major marker proposal confirmation");
    }
    if (!state.eth || !state.bsc) throw new Error("Both GovernanceProbe deployments must be recorded");
    if (!bscAllowed) throw new Error("BSC GovernanceProbe proxy is not allowlisted");
    if (!state.majorMarkerPolicyProposal) throw new Error("Major marker policy proposal is not recorded");
    if (state.majorMarkerProposal) {
      throw new Error(`Major marker proposal ${state.majorMarkerProposal.proposalId} is already recorded`);
    }
    if (majorFee !== 1_000n * 10n ** 18n) throw new Error(`Unexpected Major proposal fee ${majorFee}`);
    if (dcBalance !== 0n || dcAllowance !== 0n) {
      throw new Error(`Expected exact zero proposer DC balance/allowance before mint, got ${dcBalance}/${dcAllowance}`);
    }

    const policyProposalId = BigInt(state.majorMarkerPolicyProposal.proposalId);
    const [policyProposal, policyProposalState, currentMajorMarkerRules] = await Promise.all([
      ethPublic.readContract({
        address: governance,
        abi: governanceAbi,
        functionName: "getProposal",
        args: [policyProposalId],
      }),
      ethPublic.readContract({
        address: governance,
        abi: governanceAbi,
        functionName: "state",
        args: [policyProposalId],
      }),
      Promise.all(majorMarkerRules.map((rule) => ethPublic.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "getRule",
        args: [rule.kind, rule.target, rule.selector],
      }))),
    ]);
    if (!policyProposal.executed || policyProposalState !== 6) {
      throw new Error(`Major marker policy proposal ${policyProposalId} is not Executed`);
    }
    if (currentMajorMarkerRules.some((actual, index) => {
      const expected = majorMarkerRules[index];
      return actual.allowed !== expected.allowed ||
        actual.validateNestedBroadcast !== expected.validateNestedBroadcast ||
        actual.nestedOnly !== expected.nestedOnly ||
        actual.maxValue !== expected.maxValue;
    })) {
      throw new Error("Major marker rules do not exactly match the executed policy proposal");
    }

    const [minterRole, treasury, totalSupplyBefore] = await Promise.all([
      ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "MINTER_ROLE" }),
      ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "treasury" }),
      ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    ]);
    const [canMint, treasuryBalanceBefore] = await Promise.all([
      ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "hasRole", args: [minterRole, ethAccount.address] }),
      ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
    ]);
    if (!canMint) throw new Error("Configured ETH wallet does not have DC MINTER_ROLE");

    const mintHash = await ethWallet.writeContract({
      account: ethAccount,
      chain: mainnet,
      address: dc,
      abi: tokenAbi,
      functionName: "mint",
      args: [ethAccount.address, majorFee],
    });
    await waitFor(ethPublic, mintHash, "mint exact Major marker proposal fee");
    const [balanceAfterMint, supplyAfterMint] = await Promise.all([
      ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [ethAccount.address] }),
      ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    ]);
    if (balanceAfterMint !== majorFee || supplyAfterMint !== totalSupplyBefore + majorFee) {
      throw new Error("Exact DC mint verification failed");
    }

    const approveHash = await ethWallet.writeContract({
      account: ethAccount,
      chain: mainnet,
      address: dc,
      abi: tokenAbi,
      functionName: "approve",
      args: [governance, majorFee],
    });
    await waitFor(ethPublic, approveHash, "approve exact Major marker proposal fee");
    if ((await ethPublic.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [ethAccount.address, governance],
    })) !== majorFee) {
      throw new Error("Exact DC allowance verification failed");
    }

    const proposalArgs = [
      [ethProxy, broadcaster],
      [0n, feeQuote],
      [markerData, broadcastData],
      MARKER_DESCRIPTION,
      MAJOR,
    ] as const;
    const simulation = await ethPublic.simulateContract({
      account: ethAccount.address,
      address: governance,
      abi: governanceAbi,
      functionName: "createProposal",
      args: proposalArgs,
    });
    if (simulation.result !== proposalCount + 1n) throw new Error("Unexpected simulated proposal id");

    const createHash = await ethWallet.writeContract({
      account: ethAccount,
      chain: mainnet,
      address: governance,
      abi: governanceAbi,
      functionName: "createProposal",
      args: proposalArgs,
    });
    await waitFor(ethPublic, createHash, "create Major cross-chain marker proposal");

    const proposalId = proposalCount + 1n;
    const zeroMarker = `0x${"00".repeat(32)}`;
    const [proposalCountAfter, proposal, actions, proposalState, balanceAfter, allowanceAfter,
      supplyAfter, treasuryBalanceAfter, rulesAfter, ethMarkerAfter, ethCountAfter,
      bscMarkerAfter, bscCountAfter, broadcastNonceAfter] = await Promise.all([
        ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "proposalCount" }),
        ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "getProposal", args: [proposalId] }),
        ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "getActions", args: [proposalId] }),
        ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "state", args: [proposalId] }),
        ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [ethAccount.address] }),
        ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [ethAccount.address, governance] }),
        ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
        ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
        Promise.all(majorMarkerRules.map((rule) => ethPublic.readContract({
          address: registry,
          abi: registryAbi,
          functionName: "getRule",
          args: [rule.kind, rule.target, rule.selector],
        }))),
        ethPublic.readContract({ address: ethProxy, abi: probeAbi, functionName: "marker" }),
        ethPublic.readContract({ address: ethProxy, abi: probeAbi, functionName: "updateCount" }),
        bscPublic.readContract({ address: bscProxy, abi: probeAbi, functionName: "marker" }),
        bscPublic.readContract({ address: bscProxy, abi: probeAbi, functionName: "updateCount" }),
        ethPublic.readContract({ address: broadcaster, abi: broadcasterAbi, functionName: "broadcastNonce" }),
      ]);
    if (proposalCountAfter !== proposalId || proposalState !== 1) {
      throw new Error("Created Major marker proposal is not Pending");
    }
    if (!sameAddress(proposal.proposer, ethAccount.address) || proposal.kind !== MAJOR ||
        proposal.totalStaked !== 0n || proposal.description !== MARKER_DESCRIPTION) {
      throw new Error("Created Major marker proposal metadata mismatch");
    }
    if (actions[0].length !== 2 || !sameAddress(actions[0][0], ethProxy) ||
        !sameAddress(actions[0][1], broadcaster) || actions[1].length !== 2 ||
        actions[1][0] !== 0n || actions[1][1] !== feeQuote || actions[2].length !== 2 ||
        actions[2][0].toLowerCase() !== markerData.toLowerCase() ||
        actions[2][1].toLowerCase() !== broadcastData.toLowerCase()) {
      throw new Error("Created Major marker proposal actions mismatch");
    }
    if (balanceAfter !== 0n || allowanceAfter !== 0n || supplyAfter !== totalSupplyBefore + majorFee ||
        treasuryBalanceAfter !== treasuryBalanceBefore + majorFee) {
      throw new Error("Major marker proposal fee accounting mismatch");
    }
    if (rulesAfter.some((actual, index) => {
      const expected = majorMarkerRules[index];
      return actual.allowed !== expected.allowed ||
        actual.validateNestedBroadcast !== expected.validateNestedBroadcast ||
        actual.nestedOnly !== expected.nestedOnly ||
        actual.maxValue !== expected.maxValue;
    })) {
      throw new Error("Major marker rules changed during proposal creation");
    }
    if (ethMarkerAfter !== zeroMarker || ethCountAfter !== 0n ||
        bscMarkerAfter !== zeroMarker || bscCountAfter !== 0n || broadcastNonceAfter !== broadcastNonce) {
      throw new Error("Probe or broadcaster state changed during proposal creation");
    }
    saveState({
      ...state,
      majorMarkerProposal: {
        proposalId: proposalId.toString(),
        description: MARKER_DESCRIPTION,
        marker: MARKER,
        feeQuoteWei: feeQuote.toString(),
        mintTx: mintHash,
        approveTx: approveHash,
        createTx: createHash,
        createdAt: new Date().toISOString(),
      },
    });
    console.log(`  proposalId: ${proposalId}`);
    return;
  }

  if (process.env.GOVERNANCE_PROBE_POLICY_PROPOSAL_CONFIRM !== POLICY_PROPOSAL_CONFIRM) {
    throw new Error("Missing exact GovernanceProbe policy proposal confirmation");
  }
  if (!state.eth || !state.bsc) throw new Error("Both GovernanceProbe deployments must be recorded");
  if (!bscAllowed) throw new Error("BSC GovernanceProbe proxy is not allowlisted");
  if (state.policyProposal) throw new Error(`GovernanceProbe policy proposal ${state.policyProposal.proposalId} is already recorded`);
  if (majorFee !== 1_000n * 10n ** 18n) throw new Error(`Unexpected Major proposal fee ${majorFee}`);
  if (dcBalance !== 0n || dcAllowance !== 0n) {
    throw new Error(`Expected exact zero proposer DC balance/allowance before mint, got ${dcBalance}/${dcAllowance}`);
  }

  const currentRules = await Promise.all(probeRules.map((rule) =>
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [rule.kind, rule.target, rule.selector],
    })
  ));
  if (currentRules.some((rule) => rule.allowed || rule.validateNestedBroadcast || rule.nestedOnly || rule.maxValue !== 0n)) {
    throw new Error("At least one GovernanceProbe rule is already configured");
  }

  const [minterRole, treasury, totalSupplyBefore] = await Promise.all([
    ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "MINTER_ROLE" }),
    ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "treasury" }),
    ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
  ]);
  const [canMint, treasuryBalanceBefore] = await Promise.all([
    ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "hasRole", args: [minterRole, ethAccount.address] }),
    ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
  ]);
  if (!canMint) throw new Error("Configured ETH wallet does not have DC MINTER_ROLE");

  const mintHash = await ethWallet.writeContract({
    account: ethAccount,
    chain: mainnet,
    address: dc,
    abi: tokenAbi,
    functionName: "mint",
    args: [ethAccount.address, majorFee],
  });
  await waitFor(ethPublic, mintHash, "mint exact GovernanceProbe Major proposal fee");
  const [balanceAfterMint, supplyAfterMint] = await Promise.all([
    ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [ethAccount.address] }),
    ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
  ]);
  if (balanceAfterMint !== majorFee || supplyAfterMint !== totalSupplyBefore + majorFee) {
    throw new Error("Exact DC mint verification failed");
  }

  const approveHash = await ethWallet.writeContract({
    account: ethAccount,
    chain: mainnet,
    address: dc,
    abi: tokenAbi,
    functionName: "approve",
    args: [governance, majorFee],
  });
  await waitFor(ethPublic, approveHash, "approve exact GovernanceProbe Major proposal fee");
  if ((await ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [ethAccount.address, governance] })) !== majorFee) {
    throw new Error("Exact DC allowance verification failed");
  }

  const proposalArgs = [[registry], [0n], [setRulesData], POLICY_DESCRIPTION, MAJOR] as const;
  const simulation = await ethPublic.simulateContract({
    account: ethAccount.address,
    address: governance,
    abi: governanceAbi,
    functionName: "createProposal",
    args: proposalArgs,
  });
  if (simulation.result !== proposalCount + 1n) throw new Error("Unexpected simulated proposal id");
  const createHash = await ethWallet.writeContract({
    account: ethAccount,
    chain: mainnet,
    address: governance,
    abi: governanceAbi,
    functionName: "createProposal",
    args: proposalArgs,
  });
  await waitFor(ethPublic, createHash, "create GovernanceProbe four-rule Major proposal");

  const proposalId = proposalCount + 1n;
  const [proposalCountAfter, proposal, actions, proposalState, balanceAfter, allowanceAfter,
    supplyAfter, treasuryBalanceAfter, rulesAfter] = await Promise.all([
      ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "proposalCount" }),
      ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "getProposal", args: [proposalId] }),
      ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "getActions", args: [proposalId] }),
      ethPublic.readContract({ address: governance, abi: governanceAbi, functionName: "state", args: [proposalId] }),
      ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [ethAccount.address] }),
      ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [ethAccount.address, governance] }),
      ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
      ethPublic.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
      Promise.all(probeRules.map((rule) => ethPublic.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "getRule",
        args: [rule.kind, rule.target, rule.selector],
      }))),
    ]);
  if (proposalCountAfter !== proposalId || proposalState !== 1) throw new Error("Created proposal is not Pending");
  if (!sameAddress(proposal.proposer, ethAccount.address) || proposal.kind !== MAJOR ||
      proposal.totalStaked !== 0n || proposal.description !== POLICY_DESCRIPTION) {
    throw new Error("Created proposal metadata mismatch");
  }
  if (actions[0].length !== 1 || !sameAddress(actions[0][0], registry) ||
      actions[1].length !== 1 || actions[1][0] !== 0n ||
      actions[2].length !== 1 || actions[2][0].toLowerCase() !== setRulesData.toLowerCase()) {
    throw new Error("Created proposal actions mismatch");
  }
  if (balanceAfter !== 0n || allowanceAfter !== 0n || supplyAfter !== totalSupplyBefore + majorFee ||
      treasuryBalanceAfter !== treasuryBalanceBefore + majorFee) {
    throw new Error("Major proposal fee accounting mismatch");
  }
  if (rulesAfter.some((rule) => rule.allowed || rule.validateNestedBroadcast || rule.nestedOnly || rule.maxValue !== 0n)) {
    throw new Error("GovernanceProbe rules changed before proposal execution");
  }
  saveState({
    ...state,
    policyProposal: {
      proposalId: proposalId.toString(),
      description: POLICY_DESCRIPTION,
      mintTx: mintHash,
      approveTx: approveHash,
      createTx: createHash,
      createdAt: new Date().toISOString(),
    },
  });
  console.log(`  proposalId: ${proposalId}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
