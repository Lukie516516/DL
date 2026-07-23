/**
 * Stage 4A only: activate the already-wired ETH -> BSC V2 route, then switch
 * BSC DealFactory.crossChainGovernance from the V1 executor to the V2 executor.
 *
 * Allowed writes (exactly two, each skipped only when the exact expected
 * on-chain result is already present):
 *   1. ETH CrossChainBroadcasterV2.setChainActive(BSC, true)
 *   2. BSC DealFactory.setCrossChainGovernance(V2 executor)
 *
 * There is intentionally no proposal, stake, broadcast, canary, V1 policy
 * disable, threshold/source/peer/allowlist change, mint, commit or push path.
 *
 * Read-only preflight:
 *   node --import tsx/esm scripts/cutover-mainnet-ccip-v2-stage4.ts --preflight
 *
 * Explicit write gate:
 *   CCIP_V2_STAGE4_CUTOVER=1 \
 *     node --import tsx/esm scripts/cutover-mainnet-ccip-v2-stage4.ts
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
  padHex,
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

type CurrentBridgeState = {
  eth: { deployer: Address; broadcaster: Address };
  bsc: { deployer: Address; executor: Address };
  params: {
    ethLzEndpoint: Address;
    bscLzEndpoint: Address;
    ethLzEid: number;
    bscLzEid: number;
    ethAxelarGateway: Address;
    ethAxelarGasService: Address;
    bscAxelarGateway: Address;
    ethAxelarChainName: string;
    bscAxelarChainName: string;
    axelarMinFeeWei: string;
    ethGovernance: Address;
    bscChainKey: number;
    bscDealFactory: Address;
  };
};

type EthDeployment = {
  addresses: { governancePolicyRegistry: Address };
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

type Stage3State = {
  stage: string;
  governance: Address;
  registry: Address;
  oldBroadcaster: Address;
  newBroadcaster: Address;
  oldExecutor: Address;
  newExecutor: Address;
  bscFactory: Address;
  proposalId: string;
};

type ActionReceipt = {
  chain: "ethereum" | "bsc";
  nonce: number;
  txHash: Hex;
  blockNumber?: string;
  verified?: boolean;
};

type Stage4State = {
  schemaVersion: 1;
  scope: string;
  stage:
    | "prepared"
    | "route_submitted"
    | "route_active"
    | "factory_submitted"
    | "complete";
  startedAt: string;
  updatedAt: string;
  broadcaster: Address;
  executor: Address;
  bscFactory: Address;
  previousFactoryController: Address;
  actions: Partial<
    Record<"ethActivateRoute" | "bscSwitchFactory", ActionReceipt>
  >;
  canaryQuoteWei?: string;
  verification?: Record<string, unknown>;
};

const ROOT = process.cwd();
const OUTPUT_FILE = join(
  ROOT,
  "deployments",
  "ccip-v2-mainnet-stage4-cutover.json"
);
const current = JSON.parse(
  readFileSync(join(ROOT, "deployments", "mainnet-cross-chain.json"), "utf8")
) as CurrentBridgeState;
const ethDeployment = JSON.parse(
  readFileSync(join(ROOT, "deployments", "eth-mainnet-1.json"), "utf8")
) as EthDeployment;
const stage1 = JSON.parse(
  readFileSync(join(ROOT, "deployments", "ccip-v2-mainnet-stage1.json"), "utf8")
) as Stage1State;
const stage2 = JSON.parse(
  readFileSync(join(ROOT, "deployments", "ccip-v2-mainnet-stage2.json"), "utf8")
) as Stage2State;
const stage3 = JSON.parse(
  readFileSync(join(ROOT, "deployments", "ccip-v2-mainnet-stage3.json"), "utf8")
) as Stage3State;

const ETH_RPC =
  process.env.ETH_MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com";
const BSC_RPC =
  process.env.BSC_MAINNET_RPC_URL || "https://bsc-dataseed.binance.org";
const ETH_CCIP_ROUTER = getAddress(
  "0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D"
);
const BSC_CCIP_ROUTER = getAddress(
  "0x34B03Cb9086d7D758AC55af71584F81A598759FE"
);
const ETH_CCIP_SELECTOR = 5_009_297_550_715_157_269n;
const BSC_CCIP_SELECTOR = 11_344_663_589_394_136_015n;
const BROADCAST_SELECTOR = toFunctionSelector(
  "broadcast(uint32[],address[],bytes,uint128)"
);
const MIN_SIGNER_BALANCE = parseEther("0.001");
const MAX_DAO_ACTION_VALUE = parseEther("0.01");
const CANARY_LZ_GAS = 500_000n;
const EXECUTED_PROPOSAL_STATE = 6;
const PARAMETER = 0;
const MAJOR = 2;
const SCOPE =
  "activate the existing ETH-to-BSC V2 route and switch only BSC DealFactory governance from V1 executor to V2 executor; no proposal, stake, broadcast, canary or V1 disable";

const broadcasterAbi = parseAbi([
  "function owner() view returns (address)",
  "function governance() view returns (address)",
  "function endpoint() view returns (address)",
  "function ccipRouter() view returns (address)",
  "function axelarGateway() view returns (address)",
  "function axelarGasService() view returns (address)",
  "function broadcastNonce() view returns (uint256)",
  "function peers(uint32 eid) view returns (bytes32)",
  "function getChainIds() view returns (uint32[])",
  "function chains(uint32 chainId) view returns (uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
  "function quoteFees(uint32[] targetChainIds,address[] targets,bytes data,uint128 lzGas) view returns (uint256)",
  "function setChainActive(uint32 chainId,bool active)",
]);
const executorAbi = parseAbi([
  "function owner() view returns (address)",
  "function endpoint() view returns (address)",
  "function ccipRouter() view returns (address)",
  "function ccipSrcChainSelector() view returns (uint64)",
  "function ccipSrcSender() view returns (address)",
  "function axelarGateway() view returns (address)",
  "function axSrcChain() view returns (string)",
  "function axSrcAddress() view returns (string)",
  "function threshold() view returns (uint256)",
  "function peers(uint32 eid) view returns (bytes32)",
  "function allowedTargets(address target) view returns (bool)",
]);
const factoryAbi = parseAbi([
  "function owner() view returns (address)",
  "function crossChainGovernance() view returns (address)",
  "function minWindowSec() view returns (uint32)",
  "function setCrossChainGovernance(address addr)",
]);
const registryAbi = parseAbi([
  "function getRule(uint8 kind,address target,bytes4 selector) view returns (bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)",
]);
const governanceAbi = parseAbi([
  "function state(uint256 proposalId) view returns (uint8)",
  "function getProposal(uint256 proposalId) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description))",
]);
const routerAbi = parseAbi([
  "function isChainSupported(uint64 destinationChainSelector) view returns (bool)",
]);
const canaryAbi = parseAbi(["function setMinWindowSec(uint32 sec_)"]);

function privateKey(names: string[]): Hex {
  for (const name of names) {
    const raw = process.env[name]?.trim();
    if (raw) return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  }
  throw new Error(`Missing key: ${names.join(" or ")}`);
}

function same(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function addressBytes32(address: Address): Hex {
  return padHex(address.toLowerCase() as Hex, { size: 32 });
}

function save(state: Stage4State) {
  state.updatedAt = new Date().toISOString();
  writeFileSync(OUTPUT_FILE, JSON.stringify(state, null, 2), "utf8");
}

function assertRule(
  rule: readonly [boolean, boolean, boolean, bigint],
  label: string
) {
  if (
    !rule[0] ||
    !rule[1] ||
    rule[2] ||
    rule[3] !== MAX_DAO_ACTION_VALUE
  ) {
    throw new Error(`${label} differs from the exact enabled V1 baseline`);
  }
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

async function mainRun() {
  const preflightOnly = process.argv.includes("--preflight");
  if (process.env.CCIP_V2_STAGE4_CUTOVER !== "1" && !preflightOnly) {
    throw new Error(
      "Write gate closed: set CCIP_V2_STAGE4_CUTOVER=1 only after explicit stage-4 cutover authorization"
    );
  }
  if (
    stage1.stage !== "both_deployed" ||
    !stage1.eth.verified ||
    !stage1.bsc.verified ||
    stage2.stage !== "complete" ||
    stage3.stage !== "proposal_created"
  ) {
    throw new Error("Verified stage 1/2/3 records are required");
  }

  const broadcaster = getAddress(stage1.eth.address);
  const executor = getAddress(stage1.bsc.address);
  const oldBroadcaster = getAddress(current.eth.broadcaster);
  const oldExecutor = getAddress(current.bsc.executor);
  const bscFactory = getAddress(current.params.bscDealFactory);
  const governance = getAddress(current.params.ethGovernance);
  const registry = getAddress(ethDeployment.addresses.governancePolicyRegistry);
  const ethDeployer = getAddress(current.eth.deployer);
  const bscDeployer = getAddress(current.bsc.deployer);
  const proposalId = BigInt(stage3.proposalId);

  if (
    !same(stage2.broadcaster, broadcaster) ||
    !same(stage2.executor, executor) ||
    !same(stage3.governance, governance) ||
    !same(stage3.registry, registry) ||
    !same(stage3.oldBroadcaster, oldBroadcaster) ||
    !same(stage3.newBroadcaster, broadcaster) ||
    !same(stage3.oldExecutor, oldExecutor) ||
    !same(stage3.newExecutor, executor) ||
    !same(stage3.bscFactory, bscFactory)
  ) {
    throw new Error("Stage records disagree on production addresses");
  }

  const ethAccount = privateKeyToAccount(
    privateKey(["ETH_MAINNET_PRIVATE_KEY", "AGIKING_PRIVATE_KEY"])
  );
  const bscAccount = privateKeyToAccount(
    privateKey(["BSC_MAINNET_PRIVATE_KEY", "AGIKING_PRIVATE_KEY"])
  );
  if (
    !same(ethAccount.address, ethDeployer) ||
    !same(bscAccount.address, bscDeployer)
  ) {
    throw new Error(
      `Signer mismatch: ETH=${ethAccount.address}, BSC=${bscAccount.address}`
    );
  }

  const ethPublic = createPublicClient({
    chain: mainnet,
    transport: http(ETH_RPC),
  });
  const bscPublic = createPublicClient({
    chain: bsc,
    transport: http(BSC_RPC),
  });
  const ethWallet = createWalletClient({
    account: ethAccount,
    chain: mainnet,
    transport: http(ETH_RPC),
  });
  const bscWallet = createWalletClient({
    account: bscAccount,
    chain: bsc,
    transport: http(BSC_RPC),
  });

  await Promise.all([
    requireCode(ethPublic, broadcaster, "V2 Broadcaster"),
    requireCode(bscPublic, executor, "V2 Executor"),
    requireCode(bscPublic, bscFactory, "BSC DealFactory"),
  ]);

  const [
    ethChainId,
    bscChainId,
    ethNonces,
    bscNonces,
    ethBalance,
    bscBalance,
    broadcasterOwner,
    broadcasterGovernance,
    broadcasterEndpoint,
    broadcasterRouter,
    broadcasterAxGateway,
    broadcasterAxGas,
    broadcastNonce,
    chainIds,
    route,
    bscPeer,
    executorOwner,
    executorEndpoint,
    executorRouter,
    executorSelector,
    executorSender,
    executorAxGateway,
    executorAxChain,
    executorAxAddress,
    threshold,
    ethPeer,
    factoryAllowed,
    factoryOwner,
    factoryController,
    minWindowSec,
    ethLane,
    bscLane,
    proposalState,
    proposal,
    newParameterRule,
    newMajorRule,
    oldParameterRule,
    oldMajorRule,
  ] = await Promise.all([
    ethPublic.getChainId(),
    bscPublic.getChainId(),
    nonceState(ethPublic, ethAccount.address),
    nonceState(bscPublic, bscAccount.address),
    ethPublic.getBalance({ address: ethAccount.address }),
    bscPublic.getBalance({ address: bscAccount.address }),
    ethPublic.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "owner",
    }),
    ethPublic.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "governance",
    }),
    ethPublic.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "endpoint",
    }),
    ethPublic.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "ccipRouter",
    }),
    ethPublic.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "axelarGateway",
    }),
    ethPublic.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "axelarGasService",
    }),
    ethPublic.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "broadcastNonce",
    }),
    ethPublic.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "getChainIds",
    }),
    ethPublic.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "chains",
      args: [current.params.bscChainKey],
    }),
    ethPublic.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "peers",
      args: [current.params.bscLzEid],
    }),
    bscPublic.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "owner",
    }),
    bscPublic.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "endpoint",
    }),
    bscPublic.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "ccipRouter",
    }),
    bscPublic.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "ccipSrcChainSelector",
    }),
    bscPublic.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "ccipSrcSender",
    }),
    bscPublic.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "axelarGateway",
    }),
    bscPublic.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "axSrcChain",
    }),
    bscPublic.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "axSrcAddress",
    }),
    bscPublic.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "threshold",
    }),
    bscPublic.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "peers",
      args: [current.params.ethLzEid],
    }),
    bscPublic.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "allowedTargets",
      args: [bscFactory],
    }),
    bscPublic.readContract({
      address: bscFactory,
      abi: factoryAbi,
      functionName: "owner",
    }),
    bscPublic.readContract({
      address: bscFactory,
      abi: factoryAbi,
      functionName: "crossChainGovernance",
    }),
    bscPublic.readContract({
      address: bscFactory,
      abi: factoryAbi,
      functionName: "minWindowSec",
    }),
    ethPublic.readContract({
      address: ETH_CCIP_ROUTER,
      abi: routerAbi,
      functionName: "isChainSupported",
      args: [BSC_CCIP_SELECTOR],
    }),
    bscPublic.readContract({
      address: BSC_CCIP_ROUTER,
      abi: routerAbi,
      functionName: "isChainSupported",
      args: [ETH_CCIP_SELECTOR],
    }),
    ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "state",
      args: [proposalId],
    }),
    ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "getProposal",
      args: [proposalId],
    }),
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [PARAMETER, broadcaster, BROADCAST_SELECTOR],
    }),
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, broadcaster, BROADCAST_SELECTOR],
    }),
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [PARAMETER, oldBroadcaster, BROADCAST_SELECTOR],
    }),
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, oldBroadcaster, BROADCAST_SELECTOR],
    }),
  ]);

  if (ethChainId !== 1 || bscChainId !== 56) {
    throw new Error(`Wrong RPC chain: ETH=${ethChainId}, BSC=${bscChainId}`);
  }
  if (
    ethNonces.latest !== ethNonces.pending ||
    bscNonces.latest !== bscNonces.pending
  ) {
    throw new Error(
      `Pending transactions: ETH=${ethNonces.latest}/${ethNonces.pending}, BSC=${bscNonces.latest}/${bscNonces.pending}`
    );
  }
  if (
    ethBalance < MIN_SIGNER_BALANCE ||
    bscBalance < MIN_SIGNER_BALANCE
  ) {
    throw new Error(
      `Low signer balance: ETH=${formatEther(ethBalance)}, BSC=${formatEther(
        bscBalance
      )}`
    );
  }
  if (
    !same(broadcasterOwner, ethDeployer) ||
    !same(broadcasterGovernance, governance) ||
    !same(broadcasterEndpoint, getAddress(current.params.ethLzEndpoint)) ||
    !same(broadcasterRouter, ETH_CCIP_ROUTER) ||
    !same(broadcasterAxGateway, getAddress(current.params.ethAxelarGateway)) ||
    !same(broadcasterAxGas, getAddress(current.params.ethAxelarGasService)) ||
    broadcastNonce !== 0n
  ) {
    throw new Error("V2 Broadcaster authority/runtime state mismatch");
  }
  if (
    chainIds.length !== 1 ||
    chainIds[0] !== current.params.bscChainKey ||
    route[0] !== current.params.bscLzEid ||
    route[1] !== BSC_CCIP_SELECTOR ||
    !same(route[2], executor) ||
    route[3] !== current.params.bscAxelarChainName ||
    route[4] !== executor.toLowerCase() ||
    route[5] !== BigInt(current.params.axelarMinFeeWei) ||
    bscPeer !== addressBytes32(executor)
  ) {
    throw new Error("V2 Broadcaster BSC route differs from the staged config");
  }
  if (
    !same(executorOwner, bscDeployer) ||
    !same(executorEndpoint, getAddress(current.params.bscLzEndpoint)) ||
    !same(executorRouter, BSC_CCIP_ROUTER) ||
    executorSelector !== ETH_CCIP_SELECTOR ||
    !same(executorSender, broadcaster) ||
    !same(executorAxGateway, getAddress(current.params.bscAxelarGateway)) ||
    executorAxChain !== current.params.ethAxelarChainName ||
    executorAxAddress !== broadcaster ||
    threshold !== 2n ||
    ethPeer !== addressBytes32(broadcaster) ||
    !factoryAllowed
  ) {
    throw new Error("V2 Executor source/threshold/allowlist state mismatch");
  }
  if (!same(factoryOwner, bscDeployer)) {
    throw new Error(`BSC Factory owner mismatch: ${factoryOwner}`);
  }
  if (
    !same(factoryController, oldExecutor) &&
    !same(factoryController, executor)
  ) {
    throw new Error(`Unexpected BSC Factory controller: ${factoryController}`);
  }
  if (!ethLane || !bscLane) {
    throw new Error(`CCIP lane unsupported: ETH=${ethLane}, BSC=${bscLane}`);
  }
  if (
    proposalState !== EXECUTED_PROPOSAL_STATE ||
    !proposal.executed ||
    proposal.vetoed ||
    proposal.canceled
  ) {
    throw new Error(
      `Proposal #${proposalId} is not cleanly executed: state=${proposalState}`
    );
  }
  assertRule(newParameterRule, "V2 Parameter rule");
  assertRule(newMajorRule, "V2 Major rule");
  assertRule(oldParameterRule, "V1 Parameter rule");
  assertRule(oldMajorRule, "V1 Major rule");

  if (!route[6]) {
    await ethPublic.simulateContract({
      account: ethAccount,
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "setChainActive",
      args: [current.params.bscChainKey, true],
    });
  }
  if (!same(factoryController, executor)) {
    await bscPublic.simulateContract({
      account: bscAccount,
      address: bscFactory,
      abi: factoryAbi,
      functionName: "setCrossChainGovernance",
      args: [executor],
    });
  }

  const summary = {
    blocks: {
      ethereum: (await ethPublic.getBlockNumber()).toString(),
      bsc: (await bscPublic.getBlockNumber()).toString(),
    },
    signers: { ethereum: ethAccount.address, bsc: bscAccount.address },
    nonces: { ethereum: ethNonces.pending, bsc: bscNonces.pending },
    balances: {
      ethereum: formatEther(ethBalance),
      bsc: formatEther(bscBalance),
    },
    proposal13: {
      state: proposalState,
      executed: proposal.executed,
    },
    routeActive: route[6],
    factoryController,
    expectedV2Executor: executor,
    minWindowSec,
    v1RulesPreserved: true,
    simulationsPassed: true,
  };

  if (preflightOnly) {
    console.log(JSON.stringify(summary, null, 2));
    console.log("Stage-4A read-only preflight and both simulations passed.");
    console.log("No transaction was signed or sent.");
    return;
  }

  let state: Stage4State;
  if (existsSync(OUTPUT_FILE)) {
    state = JSON.parse(readFileSync(OUTPUT_FILE, "utf8")) as Stage4State;
    if (
      !same(state.broadcaster, broadcaster) ||
      !same(state.executor, executor) ||
      !same(state.bscFactory, bscFactory) ||
      !same(state.previousFactoryController, oldExecutor)
    ) {
      throw new Error("Existing stage-4 state points to different contracts");
    }
  } else {
    if (route[6] || same(factoryController, executor)) {
      throw new Error(
        "Stage-4 chain state changed without a resumable local record"
      );
    }
    state = {
      schemaVersion: 1,
      scope: SCOPE,
      stage: "prepared",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      broadcaster,
      executor,
      bscFactory,
      previousFactoryController: oldExecutor,
      actions: {},
    };
    save(state);
  }

  let routeActive = route[6];
  if (!routeActive) {
    const nonce = await assertNoPending(
      ethPublic,
      ethAccount.address,
      "ETH signer"
    );
    const simulation = await ethPublic.simulateContract({
      account: ethAccount,
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "setChainActive",
      args: [current.params.bscChainKey, true],
    });
    const txHash = await ethWallet.writeContract(simulation.request);
    state.stage = "route_submitted";
    state.actions.ethActivateRoute = {
      chain: "ethereum",
      nonce,
      txHash,
    };
    save(state);
    console.log(`ETH V2 route submitted: ${txHash}`);

    const receipt = await ethPublic.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 2,
      timeout: 180_000,
    });
    if (receipt.status !== "success") {
      throw new Error(`ETH route activation reverted: ${txHash}`);
    }
    const activatedRoute = await ethPublic.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "chains",
      args: [current.params.bscChainKey],
    });
    if (!activatedRoute[6]) {
      throw new Error("ETH route activation receipt succeeded but route is off");
    }
    state.stage = "route_active";
    state.actions.ethActivateRoute.blockNumber =
      receipt.blockNumber.toString();
    state.actions.ethActivateRoute.verified = true;
    save(state);
    routeActive = true;
  }

  const canaryData = encodeFunctionData({
    abi: canaryAbi,
    functionName: "setMinWindowSec",
    args: [minWindowSec],
  });
  const canaryQuote = await ethPublic.readContract({
    address: broadcaster,
    abi: broadcasterAbi,
    functionName: "quoteFees",
    args: [[current.params.bscChainKey], [bscFactory], canaryData, CANARY_LZ_GAS],
  });
  if (canaryQuote <= 0n || canaryQuote > MAX_DAO_ACTION_VALUE) {
    throw new Error(
      `Live canary quote ${canaryQuote} is outside (0, ${MAX_DAO_ACTION_VALUE}]`
    );
  }
  state.canaryQuoteWei = canaryQuote.toString();
  save(state);

  let controller = await bscPublic.readContract({
    address: bscFactory,
    abi: factoryAbi,
    functionName: "crossChainGovernance",
  });
  if (same(controller, oldExecutor)) {
    if (!routeActive) throw new Error("Refusing Factory switch while route is off");
    const nonce = await assertNoPending(
      bscPublic,
      bscAccount.address,
      "BSC signer"
    );
    const simulation = await bscPublic.simulateContract({
      account: bscAccount,
      address: bscFactory,
      abi: factoryAbi,
      functionName: "setCrossChainGovernance",
      args: [executor],
    });
    const txHash = await bscWallet.writeContract(simulation.request);
    state.stage = "factory_submitted";
    state.actions.bscSwitchFactory = {
      chain: "bsc",
      nonce,
      txHash,
    };
    save(state);
    console.log(`BSC Factory controller switch submitted: ${txHash}`);

    const receipt = await bscPublic.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 3,
      timeout: 180_000,
    });
    if (receipt.status !== "success") {
      throw new Error(`BSC Factory controller switch reverted: ${txHash}`);
    }
    controller = await bscPublic.readContract({
      address: bscFactory,
      abi: factoryAbi,
      functionName: "crossChainGovernance",
    });
    if (!same(controller, executor)) {
      throw new Error(
        "BSC switch receipt succeeded but Factory controller is not V2"
      );
    }
    state.actions.bscSwitchFactory.blockNumber =
      receipt.blockNumber.toString();
    state.actions.bscSwitchFactory.verified = true;
  }

  const [finalRoute, finalController, finalNonce, finalMinWindow] =
    await Promise.all([
      ethPublic.readContract({
        address: broadcaster,
        abi: broadcasterAbi,
        functionName: "chains",
        args: [current.params.bscChainKey],
      }),
      bscPublic.readContract({
        address: bscFactory,
        abi: factoryAbi,
        functionName: "crossChainGovernance",
      }),
      ethPublic.readContract({
        address: broadcaster,
        abi: broadcasterAbi,
        functionName: "broadcastNonce",
      }),
      bscPublic.readContract({
        address: bscFactory,
        abi: factoryAbi,
        functionName: "minWindowSec",
      }),
    ]);
  if (
    !finalRoute[6] ||
    !same(finalController, executor) ||
    finalNonce !== 0n ||
    finalMinWindow !== minWindowSec
  ) {
    throw new Error("Final stage-4A invariants failed");
  }

  state.stage = "complete";
  state.verification = {
    routeActive: true,
    factoryController: finalController,
    expectedExecutor: executor,
    broadcastNonce: finalNonce.toString(),
    minWindowSec: finalMinWindow,
    canaryQuoteWei: canaryQuote.toString(),
    canaryQuoteEth: formatEther(canaryQuote),
    v1PoliciesStillPreserved: true,
    canaryNotCreatedOrSent: true,
  };
  save(state);

  console.log(JSON.stringify(state, null, 2));
  console.log("Stage-4A cutover complete and read back successfully.");
  console.log("No proposal, stake, broadcast or canary transaction was sent.");
}

mainRun().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
