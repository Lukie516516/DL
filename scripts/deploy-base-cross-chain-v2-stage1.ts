/**
 * Base CrossChain V2 stage 1: deploy an isolated 2-of-3 Executor and an
 * asset-free GovernanceProbe. This stage does not hand over any production
 * authority and does not touch DC supply, Treasury funds, or pool state.
 *
 * Read-only:
 *   node --import tsx/esm scripts/deploy-base-cross-chain-v2-stage1.ts status
 *
 * Explicit write gate:
 *   BASE_CROSS_CHAIN_V2_STAGE1_CONFIRM=DEPLOY_BASE_EXECUTOR_AND_ASSET_FREE_PROBE \
 *     node --import tsx/esm scripts/deploy-base-cross-chain-v2-stage1.ts deploy
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  fallback,
  formatEther,
  getAddress,
  getContractAddress,
  http,
  padHex,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, mainnet } from "viem/chains";

import { BASE_MAINNET } from "./lib/evm-chain-config.js";

const DEPLOYMENT_FILE = process.env.BASE_DEPLOYMENT_FILE?.trim()
  || join("deployments", "base-mainnet-8453.json");
const STATE_FILE = join("deployments", "base-cross-chain-v2-stage1.json");
const CONFIRM = "DEPLOY_BASE_EXECUTOR_AND_ASSET_FREE_PROBE";
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const BASE_CHAIN_KEY = 30_184;
const ETH_LZ_EID = 30_101;
const ETH_CCIP_SELECTOR = 5_009_297_550_715_157_269n;
const ETH_BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const ETH_GOVERNANCE = getAddress("0x9a41a9A85C16F590789C846Fb933fF8C715407F7");
const MIN_STAGE_BALANCE = parseEther("0.0001");

type Artifact = { abi: readonly unknown[]; bytecode: Hex; deployedBytecode: Hex };
type Deployment = {
  chainId: number;
  network: string;
  deployer: Address;
  addresses: Record<string, Address>;
};
type StageState = {
  scope: string;
  chainId: number;
  stage: "planned" | "executor-deployed" | "probe-implementation-deployed" | "probe-deployed" | "configured";
  initialNonce: number;
  deployer: Address;
  executor: Address;
  probeImplementation: Address;
  probe: Address;
  transactions: Array<{ label: string; hash: Hex; blockNumber: string; gasUsed: string }>;
  verifiedAt?: string;
  verifiedBlock?: string;
};

const executorAbi = parseAbi([
  "function owner() view returns (address)",
  "function endpoint() view returns (address)",
  "function peers(uint32) view returns (bytes32)",
  "function ccipRouter() view returns (address)",
  "function ccipSrcChainSelector() view returns (uint64)",
  "function ccipSrcSender() view returns (address)",
  "function axelarGateway() view returns (address)",
  "function axSrcChain() view returns (string)",
  "function axSrcAddress() view returns (string)",
  "function threshold() view returns (uint256)",
  "function allowedTargets(address) view returns (bool)",
  "function setPeer(uint32,bytes32)",
  "function setAllowedTarget(address,bool)",
  "function setDelegate(address)",
]);
const probeAbi = parseAbi([
  "function initialize(address)",
  "function controller() view returns (address)",
  "function marker() view returns (bytes32)",
  "function updateCount() view returns (uint256)",
  "function version() view returns (uint256)",
]);
const endpointAbi = parseAbi(["function delegates(address) view returns (address)"]);
const factoryAbi = parseAbi([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function crossChainGovernance() view returns (address)",
]);
const treasuryAbi = parseAbi([
  "function controller() view returns (address)",
  "function bootstrapLocked() view returns (bool)",
]);
const tokenAbi = parseAbi(["function totalSupply() view returns (uint256)"]);
const broadcasterAbi = parseAbi([
  "function owner() view returns (address)",
  "function governance() view returns (address)",
  "function getChainIds() view returns (uint32[])",
  "function chains(uint32) view returns (uint32,uint64,address,string,string,uint256,bool)",
]);

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) process.env[match[1].trim()] = match[2].trim();
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function privateKey(): Hex {
  const raw = process.env.BASE_MAINNET_PRIVATE_KEY || process.env.AGIKING_PRIVATE_KEY;
  if (!raw) throw new Error("Missing BASE_MAINNET_PRIVATE_KEY or AGIKING_PRIVATE_KEY");
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

function artifact(path: string): Artifact {
  return JSON.parse(readFileSync(join(process.cwd(), path), "utf8")) as Artifact;
}

function same(a: unknown, b: unknown) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function assertThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function implementationFromWord(word: Hex | undefined): Address {
  assertThat(word && word !== "0x", "GovernanceProbe proxy implementation slot is empty");
  return getAddress(`0x${word.slice(-40)}`);
}

function saveState(state: StageState) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

async function main() {
  loadEnv();
  const mode = process.argv[2] || "status";
  if (mode !== "status" && mode !== "deploy") throw new Error("Mode must be status or deploy");
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Deployment;
  assertThat(deployment.chainId === 8453 && deployment.network === "base-mainnet", "wrong Base deployment file");
  const expectedDeployer = getAddress(deployment.deployer);

  const baseRpc = process.env.BASE_MAINNET_RPC_URL?.trim() || "https://base-mainnet.public.blastapi.io";
  const ethRpc = required("ETH_MAINNET_RPC_URL");
  const basePublic: any = createPublicClient({
    chain: base,
    transport: fallback([
      http(baseRpc, { timeout: 30_000 }),
      http("https://mainnet.base.org", { timeout: 30_000 }),
      http("https://base-rpc.publicnode.com", { timeout: 30_000 }),
    ], { rank: false }),
  });
  const ethPublic: any = createPublicClient({ chain: mainnet, transport: http(ethRpc, { timeout: 30_000 }) });
  assertThat(await basePublic.getChainId() === 8453, "Base RPC chainId mismatch");
  assertThat(await ethPublic.getChainId() === 1, "Ethereum RPC chainId mismatch");

  const factory = getAddress(deployment.addresses.dealFactory);
  const treasury = getAddress(deployment.addresses.protocolTreasury);
  const dc = getAddress(deployment.addresses.dlToken);
  const [
    factoryOwner,
    factoryAdmin,
    crossChainGovernance,
    treasuryController,
    treasuryLocked,
    dcSupply,
    broadcasterOwner,
    broadcasterGovernance,
    chainIds,
    baseRoute,
  ] = await Promise.all([
    basePublic.readContract({ address: factory, abi: factoryAbi, functionName: "owner" }),
    basePublic.readContract({ address: factory, abi: factoryAbi, functionName: "admin" }),
    basePublic.readContract({ address: factory, abi: factoryAbi, functionName: "crossChainGovernance" }),
    basePublic.readContract({ address: treasury, abi: treasuryAbi, functionName: "controller" }),
    basePublic.readContract({ address: treasury, abi: treasuryAbi, functionName: "bootstrapLocked" }),
    basePublic.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    ethPublic.readContract({ address: ETH_BROADCASTER, abi: broadcasterAbi, functionName: "owner" }),
    ethPublic.readContract({ address: ETH_BROADCASTER, abi: broadcasterAbi, functionName: "governance" }),
    ethPublic.readContract({ address: ETH_BROADCASTER, abi: broadcasterAbi, functionName: "getChainIds" }),
    ethPublic.readContract({ address: ETH_BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
  ]);
  assertThat(same(factoryOwner, expectedDeployer) && same(factoryAdmin, expectedDeployer), "Factory authority changed before stage 1");
  assertThat(same(crossChainGovernance, ZERO), "Factory cross-chain governance already configured");
  assertThat(same(treasuryController, expectedDeployer) && treasuryLocked === false, "Treasury is not in recoverable pre-handoff state");
  assertThat(dcSupply === 0n, "DC supply changed before stage 1");
  assertThat(same(broadcasterOwner, expectedDeployer), "ETH broadcaster owner mismatch");
  assertThat(same(broadcasterGovernance, ETH_GOVERNANCE), "ETH broadcaster governance mismatch");

  const externalCode = await Promise.all([
    ["LayerZero Endpoint", BASE_MAINNET.lzEndpoint],
    ["CCIP Router", BASE_MAINNET.ccipRouter],
    ["Axelar Gateway", BASE_MAINNET.axelarGateway],
  ].map(async ([label, address]) => ({ label, address, code: await basePublic.getCode({ address }) })));
  assertThat(externalCode.every(({ code }) => code && code !== "0x"), "a Base bridge endpoint has no code");

  let state: StageState;
  if (existsSync(STATE_FILE)) {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as StageState;
    assertThat(same(state.deployer, expectedDeployer), "stage state deployer mismatch");
  } else {
    const initialNonce = await basePublic.getTransactionCount({ address: expectedDeployer, blockTag: "pending" });
    state = {
      scope: "Base CrossChain V2 stage 1: isolated Executor and asset-free GovernanceProbe",
      chainId: 8453,
      stage: "planned",
      initialNonce,
      deployer: expectedDeployer,
      executor: getContractAddress({ from: expectedDeployer, nonce: BigInt(initialNonce) }),
      probeImplementation: getContractAddress({ from: expectedDeployer, nonce: BigInt(initialNonce + 1) }),
      probe: getContractAddress({ from: expectedDeployer, nonce: BigInt(initialNonce + 2) }),
      transactions: [],
    };
    if (mode === "deploy") saveState(state);
  }

  const status = {
    scope: state.scope,
    mode,
    baseBlock: (await basePublic.getBlockNumber()).toString(),
    ethereumBlock: (await ethPublic.getBlockNumber()).toString(),
    deployer: expectedDeployer,
    deployerBaseEth: formatEther(await basePublic.getBalance({ address: expectedDeployer })),
    predictedOrRecorded: {
      executor: state.executor,
      probeImplementation: state.probeImplementation,
      probe: state.probe,
    },
    bridgeConfig: {
      baseChainKey: BASE_CHAIN_KEY,
      baseLzEid: BASE_MAINNET.lzEid,
      ethereumLzEid: ETH_LZ_EID,
      ethereumCcipSelector: ETH_CCIP_SELECTOR.toString(),
      ethereumBroadcaster: ETH_BROADCASTER,
      threshold: 2,
    },
    ethereumBroadcaster: {
      owner: broadcasterOwner,
      governance: broadcasterGovernance,
      currentChainIds: chainIds,
      baseRouteExists: chainIds.includes(BASE_CHAIN_KEY),
      baseRoute: {
        lzDstEid: String(baseRoute[0]),
        ccipDstChainSelector: String(baseRoute[1]),
        ccipReceiver: baseRoute[2],
        axDstChain: baseRoute[3],
        axDstAddress: baseRoute[4],
        axMinFee: String(baseRoute[5]),
        active: baseRoute[6],
      },
    },
    productionStatePreserved: {
      factoryOwner,
      factoryAdmin,
      crossChainGovernance,
      treasuryController,
      treasuryLocked,
      dcSupply: dcSupply.toString(),
    },
    stage: state.stage,
    transactions: state.transactions,
  };
  console.log(JSON.stringify(status, null, 2));
  if (mode === "status") {
    console.log(`Read-only complete. Set BASE_CROSS_CHAIN_V2_STAGE1_CONFIRM=${CONFIRM} and use deploy only after approval.`);
    return;
  }

  assertThat(process.env.BASE_CROSS_CHAIN_V2_STAGE1_CONFIRM === CONFIRM, "Base stage 1 write gate is closed");
  const account = privateKeyToAccount(privateKey());
  assertThat(same(account.address, expectedDeployer), `signer mismatch: ${account.address}`);
  const balance = await basePublic.getBalance({ address: expectedDeployer });
  assertThat(balance >= MIN_STAGE_BALANCE, `Base ETH below stage-1 floor: ${formatEther(balance)}`);
  const baseWallet = createWalletClient({ account, chain: base, transport: http(baseRpc, { timeout: 30_000 }) });
  const executorArtifact = artifact("artifacts/contracts/bridge/DualBridgeExecutorV2.sol/DualBridgeExecutorV2.json");
  const probeArtifact = artifact("artifacts/contracts/GovernanceProbe.sol/GovernanceProbe.json");
  const proxyArtifact = artifact("artifacts/contracts/TestProxy.sol/ERC1967Proxy.json");

  async function record(label: string, hash: Hex) {
    const receipt = await basePublic.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 240_000 });
    assertThat(receipt.status === "success", `${label} failed: ${hash}`);
    state.transactions.push({
      label,
      hash,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
    });
    saveState(state);
    return receipt;
  }

  async function deployAt(
    label: string,
    expected: Address,
    nonce: number,
    abi: readonly unknown[],
    bytecode: Hex,
    args: readonly unknown[],
  ) {
    const existingCode = await basePublic.getCode({ address: expected });
    if (existingCode && existingCode !== "0x") return;
    const pendingNonce = await basePublic.getTransactionCount({ address: expectedDeployer, blockTag: "pending" });
    assertThat(pendingNonce === nonce, `${label} nonce mismatch: ${pendingNonce} != ${nonce}`);
    const hash = await baseWallet.deployContract({ account, abi, bytecode, args, nonce });
    const receipt = await record(label, hash);
    assertThat(receipt.contractAddress && same(receipt.contractAddress, expected), `${label} deployed at unexpected address`);
  }

  await deployAt(
    "DualBridgeExecutorV2.deploy",
    state.executor,
    state.initialNonce,
    executorArtifact.abi,
    executorArtifact.bytecode,
    [
      BASE_MAINNET.lzEndpoint,
      expectedDeployer,
      BASE_MAINNET.ccipRouter,
      ETH_CCIP_SELECTOR,
      ETH_BROADCASTER,
      BASE_MAINNET.axelarGateway,
      "Ethereum",
      ETH_BROADCASTER,
      2n,
    ],
  );
  state.stage = "executor-deployed";
  saveState(state);
  await deployAt(
    "GovernanceProbe.implementation.deploy",
    state.probeImplementation,
    state.initialNonce + 1,
    probeArtifact.abi,
    probeArtifact.bytecode,
    [],
  );
  state.stage = "probe-implementation-deployed";
  saveState(state);
  await deployAt(
    "GovernanceProbe.proxy.deploy",
    state.probe,
    state.initialNonce + 2,
    proxyArtifact.abi,
    proxyArtifact.bytecode,
    [state.probeImplementation, encodeFunctionData({
      abi: probeAbi,
      functionName: "initialize",
      args: [state.executor],
    })],
  );
  state.stage = "probe-deployed";
  saveState(state);

  async function writeIf(label: string, done: () => Promise<boolean>, functionName: string, args: readonly unknown[]) {
    if (await done()) return;
    const hash = await baseWallet.writeContract({
      account,
      address: state.executor,
      abi: executorAbi,
      functionName,
      args,
    });
    await record(label, hash);
  }
  const broadcasterPeer = padHex(ETH_BROADCASTER, { size: 32 });
  await writeIf(
    "Executor.setPeer(Ethereum)",
    async () => same(await basePublic.readContract({ address: state.executor, abi: executorAbi, functionName: "peers", args: [ETH_LZ_EID] }), broadcasterPeer),
    "setPeer",
    [ETH_LZ_EID, broadcasterPeer],
  );
  await writeIf(
    "Executor.allow(self)",
    () => basePublic.readContract({ address: state.executor, abi: executorAbi, functionName: "allowedTargets", args: [state.executor] }),
    "setAllowedTarget",
    [state.executor, true],
  );
  await writeIf(
    "Executor.allow(GovernanceProbe)",
    () => basePublic.readContract({ address: state.executor, abi: executorAbi, functionName: "allowedTargets", args: [state.probe] }),
    "setAllowedTarget",
    [state.probe, true],
  );
  await writeIf(
    "Executor.setDelegate(self)",
    async () => same(await basePublic.readContract({ address: BASE_MAINNET.lzEndpoint, abi: endpointAbi, functionName: "delegates", args: [state.executor] }), state.executor),
    "setDelegate",
    [state.executor],
  );

  const [
    owner,
    endpoint,
    peer,
    ccipRouter,
    ccipSelector,
    ccipSender,
    axGateway,
    axChain,
    axAddress,
    threshold,
    allowSelf,
    allowProbe,
    delegate,
    probeController,
    probeMarker,
    probeCount,
    probeVersion,
    proxyImplementationWord,
  ] = await Promise.all([
    basePublic.readContract({ address: state.executor, abi: executorAbi, functionName: "owner" }),
    basePublic.readContract({ address: state.executor, abi: executorAbi, functionName: "endpoint" }),
    basePublic.readContract({ address: state.executor, abi: executorAbi, functionName: "peers", args: [ETH_LZ_EID] }),
    basePublic.readContract({ address: state.executor, abi: executorAbi, functionName: "ccipRouter" }),
    basePublic.readContract({ address: state.executor, abi: executorAbi, functionName: "ccipSrcChainSelector" }),
    basePublic.readContract({ address: state.executor, abi: executorAbi, functionName: "ccipSrcSender" }),
    basePublic.readContract({ address: state.executor, abi: executorAbi, functionName: "axelarGateway" }),
    basePublic.readContract({ address: state.executor, abi: executorAbi, functionName: "axSrcChain" }),
    basePublic.readContract({ address: state.executor, abi: executorAbi, functionName: "axSrcAddress" }),
    basePublic.readContract({ address: state.executor, abi: executorAbi, functionName: "threshold" }),
    basePublic.readContract({ address: state.executor, abi: executorAbi, functionName: "allowedTargets", args: [state.executor] }),
    basePublic.readContract({ address: state.executor, abi: executorAbi, functionName: "allowedTargets", args: [state.probe] }),
    basePublic.readContract({ address: BASE_MAINNET.lzEndpoint, abi: endpointAbi, functionName: "delegates", args: [state.executor] }),
    basePublic.readContract({ address: state.probe, abi: probeAbi, functionName: "controller" }),
    basePublic.readContract({ address: state.probe, abi: probeAbi, functionName: "marker" }),
    basePublic.readContract({ address: state.probe, abi: probeAbi, functionName: "updateCount" }),
    basePublic.readContract({ address: state.probe, abi: probeAbi, functionName: "version" }),
    basePublic.getStorageAt({ address: state.probe, slot: IMPLEMENTATION_SLOT }),
  ]);
  assertThat(same(owner, expectedDeployer), "Executor owner mismatch");
  assertThat(same(endpoint, BASE_MAINNET.lzEndpoint), "Executor LayerZero endpoint mismatch");
  assertThat(same(peer, broadcasterPeer), "Executor Ethereum peer mismatch");
  assertThat(same(ccipRouter, BASE_MAINNET.ccipRouter), "Executor CCIP router mismatch");
  assertThat(ccipSelector === ETH_CCIP_SELECTOR && same(ccipSender, ETH_BROADCASTER), "Executor CCIP source mismatch");
  assertThat(same(axGateway, BASE_MAINNET.axelarGateway), "Executor Axelar gateway mismatch");
  assertThat(axChain === "Ethereum" && axAddress === ETH_BROADCASTER, "Executor Axelar source mismatch");
  assertThat(threshold === 2n && allowSelf && allowProbe, "Executor threshold/allowlist mismatch");
  assertThat(same(delegate, state.executor), "Executor LayerZero delegate mismatch");
  assertThat(same(probeController, state.executor), "GovernanceProbe controller mismatch");
  assertThat(probeMarker === ZERO32 && probeCount === 0n && probeVersion === 1n, "GovernanceProbe is not pristine");
  assertThat(same(implementationFromWord(proxyImplementationWord), state.probeImplementation), "GovernanceProbe implementation mismatch");

  const [factoryOwnerAfter, factoryAdminAfter, crossChainAfter, treasuryControllerAfter, treasuryLockedAfter, dcSupplyAfter] =
    await Promise.all([
      basePublic.readContract({ address: factory, abi: factoryAbi, functionName: "owner" }),
      basePublic.readContract({ address: factory, abi: factoryAbi, functionName: "admin" }),
      basePublic.readContract({ address: factory, abi: factoryAbi, functionName: "crossChainGovernance" }),
      basePublic.readContract({ address: treasury, abi: treasuryAbi, functionName: "controller" }),
      basePublic.readContract({ address: treasury, abi: treasuryAbi, functionName: "bootstrapLocked" }),
      basePublic.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    ]);
  assertThat(same(factoryOwnerAfter, factoryOwner) && same(factoryAdminAfter, factoryAdmin), "Factory authority changed in stage 1");
  assertThat(same(crossChainAfter, crossChainGovernance), "Factory cross-chain governance changed in stage 1");
  assertThat(same(treasuryControllerAfter, treasuryController) && treasuryLockedAfter === treasuryLocked, "Treasury changed in stage 1");
  assertThat(dcSupplyAfter === dcSupply, "DC supply changed in stage 1");

  state.stage = "configured";
  state.verifiedAt = new Date().toISOString();
  state.verifiedBlock = (await basePublic.getBlockNumber()).toString();
  saveState(state);
  const backup = `${STATE_FILE}.verified-${state.verifiedBlock}.json`;
  copyFileSync(STATE_FILE, backup);
  console.log(JSON.stringify({
    status: "PASS",
    stateFile: STATE_FILE,
    backup,
    executor: state.executor,
    probeImplementation: state.probeImplementation,
    probe: state.probe,
    transactionCount: state.transactions.length,
    productionAuthorityChanged: false,
    dcSupplyChanged: false,
    treasuryChanged: false,
    poolsTouched: false,
    remainingBaseEth: formatEther(await basePublic.getBalance({ address: expectedDeployer })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
