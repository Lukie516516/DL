/**
 * Stage 2 only: wire the already-deployed CCIP V2 pair while keeping it inactive.
 *
 * Allowed writes (exactly four, skipped safely when already completed by this script):
 *   1. BSC Executor.setPeer(ETH)
 *   2. BSC Executor.setAllowedTarget(BSC DealFactory, true)
 *   3. ETH Broadcaster.setPeer(BSC)
 *   4. ETH Broadcaster.addChain(BSC, active=false)
 *
 * There is intentionally no setChainActive, Factory, Registry, proposal or broadcast call.
 *
 * Read-only preflight:
 *   node --import tsx/esm scripts/wire-mainnet-ccip-v2-stage2.ts --preflight
 * Explicit write gate:
 *   CCIP_V2_STAGE2_WIRE=1 node --import tsx/esm scripts/wire-mainnet-ccip-v2-stage2.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
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

type Stage1Deployment = {
  stage: string;
  eth: { address: Address; verified?: boolean };
  bsc: { address: Address; verified?: boolean };
};

type ActionReceipt = {
  chain: "ethereum" | "bsc";
  nonce: number;
  txHash: Hex;
  blockNumber?: string;
  verified?: boolean;
};

type Stage2State = {
  schemaVersion: 1;
  scope: string;
  stage: "prepared" | "bsc_peer" | "bsc_allow" | "eth_peer" | "complete";
  startedAt: string;
  updatedAt: string;
  broadcaster: Address;
  executor: Address;
  actions: Partial<
    Record<
      "bscSetPeer" | "bscAllowFactory" | "ethSetPeer" | "ethAddBscInactive",
      ActionReceipt
    >
  >;
  verification?: Record<string, unknown>;
};

const ROOT = process.cwd();
const OUTPUT_FILE = join(ROOT, "deployments", "ccip-v2-mainnet-stage2.json");
const current = JSON.parse(
  readFileSync(join(ROOT, "deployments", "mainnet-cross-chain.json"), "utf8")
) as CurrentBridgeState;
const ethDeployment = JSON.parse(
  readFileSync(join(ROOT, "deployments", "eth-mainnet-1.json"), "utf8")
) as EthDeployment;
const stage1 = JSON.parse(
  readFileSync(join(ROOT, "deployments", "ccip-v2-mainnet-stage1.json"), "utf8")
) as Stage1Deployment;

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
const MIN_WIRING_BALANCE = parseEther("0.001");
const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;
const SCOPE =
  "wire V2 peers, add inactive BSC config, allow only BSC DealFactory; no activation, factory switch, DAO proposal or canary";

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
  "function setPeer(uint32 eid,bytes32 peer)",
  "function addChain(uint32 chainId,(uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active) cfg)",
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
  "function setPeer(uint32 eid,bytes32 peer)",
  "function setAllowedTarget(address target,bool allowed)",
]);
const oldBroadcasterAbi = parseAbi([
  "function owner() view returns (address)",
  "function governance() view returns (address)",
]);
const oldExecutorAbi = parseAbi([
  "function owner() view returns (address)",
  "function threshold() view returns (uint256)",
]);
const factoryAbi = parseAbi([
  "function owner() view returns (address)",
  "function crossChainGovernance() view returns (address)",
]);
const routerAbi = parseAbi([
  "function isChainSupported(uint64 destinationChainSelector) view returns (bool)",
]);
const registryAbi = parseAbi([
  "function getRule(uint8 kind,address target,bytes4 selector) view returns (bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)",
]);

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

function save(state: Stage2State) {
  state.updatedAt = new Date().toISOString();
  writeFileSync(OUTPUT_FILE, JSON.stringify(state, null, 2), "utf8");
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

function assertRuleOff(
  rule: readonly [boolean, boolean, boolean, bigint],
  label: string
) {
  if (rule[0] || rule[1] || rule[2] || rule[3] !== 0n) {
    throw new Error(`${label} should remain disabled`);
  }
}

function assertOldRule(
  rule: readonly [boolean, boolean, boolean, bigint],
  label: string
) {
  if (!rule[0] || !rule[1] || rule[2] || rule[3] !== 10_000_000_000_000_000n) {
    throw new Error(`${label} changed unexpectedly`);
  }
}

async function mainRun() {
  const preflightOnly = process.argv.includes("--preflight");
  if (process.env.CCIP_V2_STAGE2_WIRE !== "1" && !preflightOnly) {
    throw new Error(
      "Write gate closed: set CCIP_V2_STAGE2_WIRE=1 after explicit stage-2 authorization"
    );
  }
  if (
    stage1.stage !== "both_deployed" ||
    !stage1.eth.verified ||
    !stage1.bsc.verified
  ) {
    throw new Error("Verified stage-1 deployment record is required");
  }

  const broadcaster = getAddress(stage1.eth.address);
  const executor = getAddress(stage1.bsc.address);
  const ethDeployer = getAddress(current.eth.deployer);
  const bscDeployer = getAddress(current.bsc.deployer);
  const governance = getAddress(current.params.ethGovernance);
  const bscFactory = getAddress(current.params.bscDealFactory);
  const registry = getAddress(ethDeployment.addresses.governancePolicyRegistry);
  const expectedBscPeer = addressBytes32(executor);
  const expectedEthPeer = addressBytes32(broadcaster);
  const expectedConfig = {
    lzDstEid: current.params.bscLzEid,
    ccipDstChainSelector: BSC_CCIP_SELECTOR,
    ccipReceiver: executor,
    axDstChain: current.params.bscAxelarChainName,
    axDstAddress: executor.toLowerCase(),
    axMinFee: BigInt(current.params.axelarMinFeeWei),
    active: false,
  } as const;

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

  const [
    ethChainId,
    bscChainId,
    ethNonce,
    bscNonce,
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
    oldBroadcasterOwner,
    oldBroadcasterGovernance,
    oldExecutorOwner,
    oldThreshold,
    factoryOwner,
    factoryController,
    ethLane,
    bscLane,
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
    ethPublic.readContract({
      address: getAddress(current.eth.broadcaster),
      abi: oldBroadcasterAbi,
      functionName: "owner",
    }),
    ethPublic.readContract({
      address: getAddress(current.eth.broadcaster),
      abi: oldBroadcasterAbi,
      functionName: "governance",
    }),
    bscPublic.readContract({
      address: getAddress(current.bsc.executor),
      abi: oldExecutorAbi,
      functionName: "owner",
    }),
    bscPublic.readContract({
      address: getAddress(current.bsc.executor),
      abi: oldExecutorAbi,
      functionName: "threshold",
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
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [0, broadcaster, BROADCAST_SELECTOR],
    }),
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [2, broadcaster, BROADCAST_SELECTOR],
    }),
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [0, getAddress(current.eth.broadcaster), BROADCAST_SELECTOR],
    }),
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [2, getAddress(current.eth.broadcaster), BROADCAST_SELECTOR],
    }),
  ]);

  if (ethChainId !== 1 || bscChainId !== 56)
    throw new Error(`Wrong RPC chain: ${ethChainId}/${bscChainId}`);
  if (
    ethNonce.latest !== ethNonce.pending ||
    bscNonce.latest !== bscNonce.pending
  ) {
    throw new Error(
      `Pending transactions exist: ETH=${ethNonce.latest}/${ethNonce.pending}, BSC=${bscNonce.latest}/${bscNonce.pending}`
    );
  }
  if (ethBalance < MIN_WIRING_BALANCE || bscBalance < MIN_WIRING_BALANCE) {
    throw new Error(`Low wiring balance: ETH=${ethBalance}, BSC=${bscBalance}`);
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
    throw new Error("Broadcaster immutable/authority state mismatch");
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
    threshold !== 2n
  ) {
    throw new Error("Executor immutable/source/threshold state mismatch");
  }
  if (
    !same(oldBroadcasterOwner, ethDeployer) ||
    !same(oldBroadcasterGovernance, governance) ||
    !same(oldExecutorOwner, bscDeployer) ||
    oldThreshold !== 2n ||
    !same(factoryOwner, bscDeployer) ||
    !same(factoryController, getAddress(current.bsc.executor))
  ) {
    throw new Error("V1 authority or BSC Factory controller changed");
  }
  if (!ethLane || !bscLane)
    throw new Error(`CCIP lane unsupported: ${ethLane}/${bscLane}`);
  assertRuleOff(newParameterRule, "new Parameter rule");
  assertRuleOff(newMajorRule, "new Major rule");
  assertOldRule(oldParameterRule, "old Parameter rule");
  assertOldRule(oldMajorRule, "old Major rule");

  const chainAlreadyConfigured = chainIds.length !== 0;
  if (chainAlreadyConfigured) {
    if (chainIds.length !== 1 || chainIds[0] !== current.params.bscChainKey) {
      throw new Error(
        `Unexpected Broadcaster chain ids: ${chainIds.join(",")}`
      );
    }
    const cfg = await ethPublic.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "chains",
      args: [current.params.bscChainKey],
    });
    if (
      cfg[0] !== expectedConfig.lzDstEid ||
      cfg[1] !== expectedConfig.ccipDstChainSelector ||
      !same(cfg[2], expectedConfig.ccipReceiver) ||
      cfg[3] !== expectedConfig.axDstChain ||
      cfg[4] !== expectedConfig.axDstAddress ||
      cfg[5] !== expectedConfig.axMinFee ||
      cfg[6] !== false
    ) {
      throw new Error(
        "Existing BSC chain config differs from the exact inactive plan"
      );
    }
  }
  if (bscPeer !== ZERO_BYTES32 && bscPeer !== expectedBscPeer) {
    throw new Error(`Unexpected Broadcaster BSC peer: ${bscPeer}`);
  }
  if (ethPeer !== ZERO_BYTES32 && ethPeer !== expectedEthPeer) {
    throw new Error(`Unexpected Executor ETH peer: ${ethPeer}`);
  }

  if (preflightOnly) {
    if (existsSync(OUTPUT_FILE)) {
      console.log(`Existing resumable stage-2 state: ${OUTPUT_FILE}`);
    }
    console.log("Stage-2 read-only preflight passed.");
    console.log(`ETH nonce=${ethNonce.pending}, BSC nonce=${bscNonce.pending}`);
    console.log(
      `Current wiring: bscPeer=${bscPeer === expectedBscPeer}, ethPeer=${
        ethPeer === expectedEthPeer
      }, factoryAllowed=${factoryAllowed}, chainConfigured=${chainAlreadyConfigured}`
    );
    console.log("Route remains inactive; no transaction was signed or sent.");
    return;
  }

  let state: Stage2State;
  if (existsSync(OUTPUT_FILE)) {
    state = JSON.parse(readFileSync(OUTPUT_FILE, "utf8")) as Stage2State;
    if (
      !same(state.broadcaster, broadcaster) ||
      !same(state.executor, executor)
    ) {
      throw new Error(
        "Existing stage-2 state points to different V2 contracts"
      );
    }
  } else {
    if (
      bscPeer !== ZERO_BYTES32 ||
      ethPeer !== ZERO_BYTES32 ||
      factoryAllowed ||
      chainAlreadyConfigured
    ) {
      throw new Error(
        "Wiring already exists without a stage-2 state record; manual investigation required"
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
      actions: {},
    };
    save(state);
  }

  async function sendBsc(
    key: "bscSetPeer" | "bscAllowFactory",
    functionName: "setPeer" | "setAllowedTarget",
    args: readonly unknown[],
    stage: Stage2State["stage"]
  ) {
    const nonce = await assertNoPending(
      bscPublic,
      bscAccount.address,
      "BSC signer"
    );
    const hash = await bscWallet.writeContract({
      account: bscAccount,
      address: executor,
      abi: executorAbi,
      functionName,
      args,
      nonce,
    } as never);
    state.actions[key] = { chain: "bsc", nonce, txHash: hash };
    state.stage = stage;
    save(state);
    console.log(`${key}: ${hash}`);
    const receipt = await bscPublic.waitForTransactionReceipt({
      hash,
      confirmations: 5,
      timeout: 240_000,
    });
    if (receipt.status !== "success") throw new Error(`${key} failed: ${hash}`);
    state.actions[key]!.blockNumber = receipt.blockNumber.toString();
    state.actions[key]!.verified = true;
    save(state);
  }

  async function sendEth(
    key: "ethSetPeer" | "ethAddBscInactive",
    functionName: "setPeer" | "addChain",
    args: readonly unknown[],
    stage: Stage2State["stage"]
  ) {
    const nonce = await assertNoPending(
      ethPublic,
      ethAccount.address,
      "ETH signer"
    );
    const hash = await ethWallet.writeContract({
      account: ethAccount,
      address: broadcaster,
      abi: broadcasterAbi,
      functionName,
      args,
      nonce,
    } as never);
    state.actions[key] = { chain: "ethereum", nonce, txHash: hash };
    state.stage = stage;
    save(state);
    console.log(`${key}: ${hash}`);
    const receipt = await ethPublic.waitForTransactionReceipt({
      hash,
      confirmations: 2,
      timeout: 240_000,
    });
    if (receipt.status !== "success") throw new Error(`${key} failed: ${hash}`);
    state.actions[key]!.blockNumber = receipt.blockNumber.toString();
    state.actions[key]!.verified = true;
    save(state);
  }

  if (ethPeer === ZERO_BYTES32) {
    await sendBsc(
      "bscSetPeer",
      "setPeer",
      [current.params.ethLzEid, expectedEthPeer],
      "bsc_peer"
    );
  }
  let currentFactoryAllowed = await bscPublic.readContract({
    address: executor,
    abi: executorAbi,
    functionName: "allowedTargets",
    args: [bscFactory],
  });
  if (!currentFactoryAllowed) {
    await sendBsc(
      "bscAllowFactory",
      "setAllowedTarget",
      [bscFactory, true],
      "bsc_allow"
    );
  }
  const currentBscPeer = await ethPublic.readContract({
    address: broadcaster,
    abi: broadcasterAbi,
    functionName: "peers",
    args: [current.params.bscLzEid],
  });
  if (currentBscPeer === ZERO_BYTES32) {
    await sendEth(
      "ethSetPeer",
      "setPeer",
      [current.params.bscLzEid, expectedBscPeer],
      "eth_peer"
    );
  }
  const currentChainIds = await ethPublic.readContract({
    address: broadcaster,
    abi: broadcasterAbi,
    functionName: "getChainIds",
  });
  if (currentChainIds.length === 0) {
    await sendEth(
      "ethAddBscInactive",
      "addChain",
      [current.params.bscChainKey, expectedConfig],
      "complete"
    );
  }

  const [
    finalBscPeer,
    finalEthPeer,
    finalAllowed,
    finalChainIds,
    finalFactoryController,
  ] = await Promise.all([
    ethPublic.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "peers",
      args: [current.params.bscLzEid],
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
    ethPublic.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "getChainIds",
    }),
    bscPublic.readContract({
      address: bscFactory,
      abi: factoryAbi,
      functionName: "crossChainGovernance",
    }),
  ]);
  const finalConfig = await ethPublic.readContract({
    address: broadcaster,
    abi: broadcasterAbi,
    functionName: "chains",
    args: [current.params.bscChainKey],
  });
  if (
    finalBscPeer !== expectedBscPeer ||
    finalEthPeer !== expectedEthPeer ||
    !finalAllowed ||
    finalChainIds.length !== 1 ||
    finalChainIds[0] !== current.params.bscChainKey ||
    finalConfig[0] !== expectedConfig.lzDstEid ||
    finalConfig[1] !== expectedConfig.ccipDstChainSelector ||
    !same(finalConfig[2], executor) ||
    finalConfig[3] !== expectedConfig.axDstChain ||
    finalConfig[4] !== expectedConfig.axDstAddress ||
    finalConfig[5] !== expectedConfig.axMinFee ||
    finalConfig[6] !== false ||
    !same(finalFactoryController, getAddress(current.bsc.executor))
  ) {
    throw new Error("Final stage-2 readback mismatch");
  }

  let inactiveQuoteReverted = false;
  try {
    await ethPublic.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "quoteFees",
      args: [
        [current.params.bscChainKey],
        [bscFactory],
        encodeAbiParameters([{ type: "uint256" }], [1n]),
        500_000n,
      ],
    });
  } catch {
    inactiveQuoteReverted = true;
  }
  if (!inactiveQuoteReverted)
    throw new Error("Inactive Broadcaster unexpectedly returned a fee quote");

  const [
    finalNewParameterRule,
    finalNewMajorRule,
    finalOldParameterRule,
    finalOldMajorRule,
  ] = await Promise.all([
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [0, broadcaster, BROADCAST_SELECTOR],
    }),
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [2, broadcaster, BROADCAST_SELECTOR],
    }),
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [0, getAddress(current.eth.broadcaster), BROADCAST_SELECTOR],
    }),
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [2, getAddress(current.eth.broadcaster), BROADCAST_SELECTOR],
    }),
  ]);
  assertRuleOff(finalNewParameterRule, "final new Parameter rule");
  assertRuleOff(finalNewMajorRule, "final new Major rule");
  assertOldRule(finalOldParameterRule, "final old Parameter rule");
  assertOldRule(finalOldMajorRule, "final old Major rule");

  state.stage = "complete";
  state.verification = {
    broadcasterPeer: finalBscPeer,
    executorPeer: finalEthPeer,
    chainId: finalChainIds[0],
    chainActive: finalConfig[6],
    ccipReceiver: finalConfig[2],
    axelarDestination: finalConfig[4],
    factoryAllowed: finalAllowed,
    inactiveQuoteReverted,
    factoryStillControlledByV1: true,
    newBroadcasterPolicyEnabled: false,
    oldBroadcasterPolicyPreserved: true,
  };
  save(state);

  console.log(
    "Stage 2 complete: exact wiring is present and route is still inactive."
  );
  for (const [key, action] of Object.entries(state.actions)) {
    console.log(`${key}: ${action.txHash}`);
  }
  console.log(`State file: ${OUTPUT_FILE}`);
  console.log(
    "No activation, Factory switch, DAO policy/proposal or broadcast transaction was sent."
  );
}

mainRun().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
