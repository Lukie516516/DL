/**
 * Stage 1 only: deploy the CCIP V2 broadcaster on Ethereum and executor on BSC.
 *
 * This script intentionally contains no peer/config/allowlist/factory/policy writes.
 * It is resumable through deployments/ccip-v2-mainnet-stage1.json and refuses to
 * deploy unless both live chains, signer identities, V1 authority, nonces, balances,
 * CCIP lanes and predicted CREATE addresses pass the preflight.
 *
 * Explicit write gate:
 *   CCIP_V2_STAGE1_DEPLOY=1 node --import tsx/esm scripts/deploy-mainnet-ccip-v2-stage1.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  getContractAddress,
  http,
  parseAbi,
  parseEther,
  zeroAddress,
  type Abi,
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

type Artifact = {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableReferences: Record<string, Array<{ start: number; length: number }>>;
};

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
    ethGovernance: Address;
    bscDealFactory: Address;
  };
};

type EthDeployment = {
  addresses: { governancePolicyRegistry: Address };
};

type ChainDeployment = {
  address: Address;
  predictedNonce: number;
  txHash?: Hex;
  blockNumber?: string;
  verified?: boolean;
};

type StageState = {
  schemaVersion: 1;
  scope: string;
  stage:
    | "prepared"
    | "eth_submitted"
    | "eth_deployed"
    | "bsc_submitted"
    | "both_deployed";
  startedAt: string;
  updatedAt: string;
  signers: { eth: Address; bsc: Address };
  eth: ChainDeployment;
  bsc: ChainDeployment;
  verification?: Record<string, unknown>;
};

const ROOT = process.cwd();
const OUTPUT_FILE = join(ROOT, "deployments", "ccip-v2-mainnet-stage1.json");
const current = JSON.parse(
  readFileSync(join(ROOT, "deployments", "mainnet-cross-chain.json"), "utf8")
) as CurrentBridgeState;
const ethDeployment = JSON.parse(
  readFileSync(join(ROOT, "deployments", "eth-mainnet-1.json"), "utf8")
) as EthDeployment;

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
const MIN_DEPLOYER_BALANCE = parseEther("0.005");
const SCOPE =
  "deploy two V2 contracts only; no wiring, activation, factory switch, DAO proposal or canary";

const commonReadAbi = parseAbi([
  "function owner() view returns (address)",
  "function endpoint() view returns (address)",
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
  "function crossChainGovernance() view returns (address)",
]);
const routerAbi = parseAbi([
  "function isChainSupported(uint64 destinationChainSelector) view returns (bool)",
]);
const endpointAbi = parseAbi([
  "function delegates(address oapp) view returns (address)",
]);
const registryAbi = parseAbi([
  "function getRule(uint8 kind,address target,bytes4 selector) view returns (bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)",
]);
const BROADCAST_SELECTOR = "0xfd9c0ab9";

function artifact(path: string): Artifact {
  return JSON.parse(
    readFileSync(join(ROOT, "artifacts", "contracts", path), "utf8")
  ) as Artifact;
}

function privateKey(names: string[]): Hex {
  for (const name of names) {
    const raw = process.env[name]?.trim();
    if (raw) return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  }
  throw new Error(`Missing deployment key: ${names.join(" or ")}`);
}

function same(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function runtimeBytes(hex: Hex): number {
  return (hex.length - 2) / 2;
}

function maskImmutables(
  hex: Hex,
  refs: Artifact["immutableReferences"]
): string {
  const body = hex.slice(2).split("");
  for (const ranges of Object.values(refs)) {
    for (const range of ranges) {
      for (
        let offset = range.start;
        offset < range.start + range.length;
        ++offset
      ) {
        body[offset * 2] = "0";
        body[offset * 2 + 1] = "0";
      }
    }
  }
  return body.join("");
}

async function assertRuntime(
  client: PublicClient,
  label: string,
  address: Address,
  expected: Artifact
) {
  const code = await client.getCode({ address });
  if (!code || code === "0x")
    throw new Error(`${label} has no runtime code at ${address}`);
  if (runtimeBytes(code) !== runtimeBytes(expected.deployedBytecode)) {
    throw new Error(
      `${label} runtime size mismatch: ${runtimeBytes(code)} != ${runtimeBytes(
        expected.deployedBytecode
      )}`
    );
  }
  if (
    maskImmutables(code, expected.immutableReferences) !==
    maskImmutables(expected.deployedBytecode, expected.immutableReferences)
  ) {
    throw new Error(
      `${label} runtime bytecode mismatch outside immutable slots`
    );
  }
}

function save(state: StageState) {
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

async function assertCommonState(
  client: PublicClient,
  label: string,
  address: Address,
  expectedOwner: Address,
  expectedEndpoint: Address
) {
  const [owner, endpoint] = await Promise.all([
    client.readContract({ address, abi: commonReadAbi, functionName: "owner" }),
    client.readContract({
      address,
      abi: commonReadAbi,
      functionName: "endpoint",
    }),
  ]);
  if (!same(owner, expectedOwner))
    throw new Error(`${label} owner mismatch: ${owner}`);
  if (!same(endpoint, expectedEndpoint))
    throw new Error(`${label} endpoint mismatch: ${endpoint}`);
}

async function mainRun() {
  const preflightOnly = process.argv.includes("--preflight");
  if (process.env.CCIP_V2_STAGE1_DEPLOY !== "1" && !preflightOnly) {
    throw new Error(
      "Write gate closed: set CCIP_V2_STAGE1_DEPLOY=1 for the explicitly authorized stage-1 deploy"
    );
  }

  const broadcasterArtifact = artifact(
    "bridge/CrossChainBroadcasterV2.sol/CrossChainBroadcasterV2.json"
  );
  const executorArtifact = artifact(
    "bridge/DualBridgeExecutorV2.sol/DualBridgeExecutorV2.json"
  );
  const ethAccount = privateKeyToAccount(
    privateKey(["ETH_MAINNET_PRIVATE_KEY", "AGIKING_PRIVATE_KEY"])
  );
  const bscAccount = privateKeyToAccount(
    privateKey(["BSC_MAINNET_PRIVATE_KEY", "AGIKING_PRIVATE_KEY"])
  );
  const expectedEthDeployer = getAddress(current.eth.deployer);
  const expectedBscDeployer = getAddress(current.bsc.deployer);
  if (!same(ethAccount.address, expectedEthDeployer)) {
    throw new Error(
      `ETH signer ${ethAccount.address} != expected deployer ${expectedEthDeployer}`
    );
  }
  if (!same(bscAccount.address, expectedBscDeployer)) {
    throw new Error(
      `BSC signer ${bscAccount.address} != expected deployer ${expectedBscDeployer}`
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
    oldBroadcasterOwner,
    oldBroadcasterGovernance,
    oldExecutorOwner,
    oldThreshold,
    factoryGovernance,
    ethLane,
    bscLane,
  ] = await Promise.all([
    ethPublic.getChainId(),
    bscPublic.getChainId(),
    nonceState(ethPublic, ethAccount.address),
    nonceState(bscPublic, bscAccount.address),
    ethPublic.getBalance({ address: ethAccount.address }),
    bscPublic.getBalance({ address: bscAccount.address }),
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
      address: getAddress(current.params.bscDealFactory),
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
  ]);

  if (ethChainId !== 1 || bscChainId !== 56) {
    throw new Error(
      `Wrong RPC chain ids: ETH=${ethChainId}, BSC=${bscChainId}`
    );
  }
  if (
    ethNonce.latest !== ethNonce.pending ||
    bscNonce.latest !== bscNonce.pending
  ) {
    throw new Error(
      `Pending transaction detected: ETH ${ethNonce.latest}/${ethNonce.pending}, BSC ${bscNonce.latest}/${bscNonce.pending}`
    );
  }
  if (ethBalance < MIN_DEPLOYER_BALANCE || bscBalance < MIN_DEPLOYER_BALANCE) {
    throw new Error(
      `Low deployer balance: ETH=${ethBalance}, BSC=${bscBalance}`
    );
  }
  if (!same(oldBroadcasterOwner, expectedEthDeployer))
    throw new Error("V1 broadcaster owner changed");
  if (
    !same(oldBroadcasterGovernance, getAddress(current.params.ethGovernance))
  ) {
    throw new Error("V1 broadcaster governance changed");
  }
  if (!same(oldExecutorOwner, expectedBscDeployer) || oldThreshold !== 2n) {
    throw new Error("V1 executor owner/threshold changed");
  }
  if (!same(factoryGovernance, getAddress(current.bsc.executor))) {
    throw new Error("BSC Factory is no longer controlled by the V1 executor");
  }
  if (!ethLane || !bscLane)
    throw new Error(`CCIP lane unsupported: ETH=${ethLane}, BSC=${bscLane}`);

  const predictedBroadcaster = getContractAddress({
    from: ethAccount.address,
    nonce: BigInt(ethNonce.pending),
  });
  const predictedExecutor = getContractAddress({
    from: bscAccount.address,
    nonce: BigInt(bscNonce.pending),
  });
  if (preflightOnly) {
    const [ethPredictedCode, bscPredictedCode] = await Promise.all([
      ethPublic.getCode({ address: predictedBroadcaster }),
      bscPublic.getCode({ address: predictedExecutor }),
    ]);
    if (
      (ethPredictedCode && ethPredictedCode !== "0x") ||
      (bscPredictedCode && bscPredictedCode !== "0x")
    ) {
      throw new Error("A predicted CREATE address already has runtime code");
    }
    console.log("Stage-1 deployment preflight passed.");
    console.log(
      `ETH signer: ${ethAccount.address}, nonce=${ethNonce.pending}, predicted=${predictedBroadcaster}`
    );
    console.log(
      `BSC signer: ${bscAccount.address}, nonce=${bscNonce.pending}, predicted=${predictedExecutor}`
    );
    console.log(`Balances: ETH=${ethBalance} wei, BSC=${bscBalance} wei`);
    console.log("No transaction was signed or sent.");
    return;
  }
  let state: StageState;
  if (existsSync(OUTPUT_FILE)) {
    state = JSON.parse(readFileSync(OUTPUT_FILE, "utf8")) as StageState;
    if (
      !same(state.signers.eth, ethAccount.address) ||
      !same(state.signers.bsc, bscAccount.address)
    ) {
      throw new Error("Existing stage-1 state signer mismatch");
    }
  } else {
    state = {
      schemaVersion: 1,
      scope: SCOPE,
      stage: "prepared",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      signers: { eth: ethAccount.address, bsc: bscAccount.address },
      eth: { address: predictedBroadcaster, predictedNonce: ethNonce.pending },
      bsc: { address: predictedExecutor, predictedNonce: bscNonce.pending },
    };
    const [ethPredictedCode, bscPredictedCode] = await Promise.all([
      ethPublic.getCode({ address: predictedBroadcaster }),
      bscPublic.getCode({ address: predictedExecutor }),
    ]);
    if (
      (ethPredictedCode && ethPredictedCode !== "0x") ||
      (bscPredictedCode && bscPredictedCode !== "0x")
    ) {
      throw new Error("A predicted CREATE address already has runtime code");
    }
    save(state);
  }

  const broadcasterArgs = [
    getAddress(current.params.ethLzEndpoint),
    ethAccount.address,
    getAddress(current.params.ethGovernance),
    ETH_CCIP_ROUTER,
    getAddress(current.params.ethAxelarGateway),
    getAddress(current.params.ethAxelarGasService),
  ] as const;

  let ethCode = await ethPublic.getCode({ address: state.eth.address });
  if (!ethCode || ethCode === "0x") {
    const latestNonce = await nonceState(ethPublic, ethAccount.address);
    if (
      latestNonce.latest !== state.eth.predictedNonce ||
      latestNonce.pending !== state.eth.predictedNonce
    ) {
      throw new Error(
        `ETH nonce changed before deployment: ${latestNonce.latest}/${latestNonce.pending}`
      );
    }
    console.log(
      `Deploying ETH CrossChainBroadcasterV2 at ${state.eth.address}`
    );
    const hash = await ethWallet.deployContract({
      account: ethAccount,
      abi: broadcasterArtifact.abi,
      bytecode: broadcasterArtifact.bytecode,
      args: broadcasterArgs,
      nonce: state.eth.predictedNonce,
    });
    state.stage = "eth_submitted";
    state.eth.txHash = hash;
    save(state);
    console.log(`ETH deployment tx: ${hash}`);
    const receipt = await ethPublic.waitForTransactionReceipt({
      hash,
      confirmations: 2,
      timeout: 240_000,
    });
    if (receipt.status !== "success" || !receipt.contractAddress) {
      throw new Error(`ETH deployment failed: ${hash}`);
    }
    if (!same(receipt.contractAddress, state.eth.address)) {
      throw new Error(
        `ETH receipt address mismatch: ${receipt.contractAddress}`
      );
    }
    state.eth.blockNumber = receipt.blockNumber.toString();
  }

  await assertRuntime(
    ethPublic,
    "CrossChainBroadcasterV2",
    state.eth.address,
    broadcasterArtifact
  );
  await assertCommonState(
    ethPublic,
    "CrossChainBroadcasterV2",
    state.eth.address,
    ethAccount.address,
    getAddress(current.params.ethLzEndpoint)
  );
  const broadcasterRead = parseAbi([
    "function governance() view returns (address)",
    "function ccipRouter() view returns (address)",
    "function axelarGateway() view returns (address)",
    "function axelarGasService() view returns (address)",
    "function broadcastNonce() view returns (uint256)",
    "function getChainIds() view returns (uint32[])",
  ]);
  const [
    governance,
    ethRouter,
    ethAxGateway,
    ethAxGas,
    broadcastNonce,
    chainIds,
    ethDelegate,
  ] = await Promise.all([
    ethPublic.readContract({
      address: state.eth.address,
      abi: broadcasterRead,
      functionName: "governance",
    }),
    ethPublic.readContract({
      address: state.eth.address,
      abi: broadcasterRead,
      functionName: "ccipRouter",
    }),
    ethPublic.readContract({
      address: state.eth.address,
      abi: broadcasterRead,
      functionName: "axelarGateway",
    }),
    ethPublic.readContract({
      address: state.eth.address,
      abi: broadcasterRead,
      functionName: "axelarGasService",
    }),
    ethPublic.readContract({
      address: state.eth.address,
      abi: broadcasterRead,
      functionName: "broadcastNonce",
    }),
    ethPublic.readContract({
      address: state.eth.address,
      abi: broadcasterRead,
      functionName: "getChainIds",
    }),
    ethPublic.readContract({
      address: getAddress(current.params.ethLzEndpoint),
      abi: endpointAbi,
      functionName: "delegates",
      args: [state.eth.address],
    }),
  ]);
  if (
    !same(governance, getAddress(current.params.ethGovernance)) ||
    !same(ethRouter, ETH_CCIP_ROUTER) ||
    !same(ethAxGateway, getAddress(current.params.ethAxelarGateway)) ||
    !same(ethAxGas, getAddress(current.params.ethAxelarGasService)) ||
    !same(ethDelegate, ethAccount.address) ||
    broadcastNonce !== 0n ||
    chainIds.length !== 0
  ) {
    throw new Error("CrossChainBroadcasterV2 constructor/readback mismatch");
  }
  state.eth.verified = true;
  state.stage = "eth_deployed";
  save(state);

  const executorArgs = [
    getAddress(current.params.bscLzEndpoint),
    bscAccount.address,
    BSC_CCIP_ROUTER,
    ETH_CCIP_SELECTOR,
    state.eth.address,
    getAddress(current.params.bscAxelarGateway),
    current.params.ethAxelarChainName,
    state.eth.address,
    2n,
  ] as const;

  let bscCode = await bscPublic.getCode({ address: state.bsc.address });
  if (!bscCode || bscCode === "0x") {
    const latestNonce = await nonceState(bscPublic, bscAccount.address);
    if (
      latestNonce.latest !== state.bsc.predictedNonce ||
      latestNonce.pending !== state.bsc.predictedNonce
    ) {
      throw new Error(
        `BSC nonce changed before deployment: ${latestNonce.latest}/${latestNonce.pending}`
      );
    }
    console.log(`Deploying BSC DualBridgeExecutorV2 at ${state.bsc.address}`);
    const hash = await bscWallet.deployContract({
      account: bscAccount,
      abi: executorArtifact.abi,
      bytecode: executorArtifact.bytecode,
      args: executorArgs,
      nonce: state.bsc.predictedNonce,
    });
    state.stage = "bsc_submitted";
    state.bsc.txHash = hash;
    save(state);
    console.log(`BSC deployment tx: ${hash}`);
    const receipt = await bscPublic.waitForTransactionReceipt({
      hash,
      confirmations: 5,
      timeout: 240_000,
    });
    if (receipt.status !== "success" || !receipt.contractAddress) {
      throw new Error(`BSC deployment failed: ${hash}`);
    }
    if (!same(receipt.contractAddress, state.bsc.address)) {
      throw new Error(
        `BSC receipt address mismatch: ${receipt.contractAddress}`
      );
    }
    state.bsc.blockNumber = receipt.blockNumber.toString();
  }

  await assertRuntime(
    bscPublic,
    "DualBridgeExecutorV2",
    state.bsc.address,
    executorArtifact
  );
  await assertCommonState(
    bscPublic,
    "DualBridgeExecutorV2",
    state.bsc.address,
    bscAccount.address,
    getAddress(current.params.bscLzEndpoint)
  );
  const executorRead = parseAbi([
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
  const [
    bscRouter,
    ccipSelector,
    ccipSender,
    bscAxGateway,
    axChain,
    axAddress,
    threshold,
    unsetPeer,
    factoryAllowed,
    bscDelegate,
  ] = await Promise.all([
    bscPublic.readContract({
      address: state.bsc.address,
      abi: executorRead,
      functionName: "ccipRouter",
    }),
    bscPublic.readContract({
      address: state.bsc.address,
      abi: executorRead,
      functionName: "ccipSrcChainSelector",
    }),
    bscPublic.readContract({
      address: state.bsc.address,
      abi: executorRead,
      functionName: "ccipSrcSender",
    }),
    bscPublic.readContract({
      address: state.bsc.address,
      abi: executorRead,
      functionName: "axelarGateway",
    }),
    bscPublic.readContract({
      address: state.bsc.address,
      abi: executorRead,
      functionName: "axSrcChain",
    }),
    bscPublic.readContract({
      address: state.bsc.address,
      abi: executorRead,
      functionName: "axSrcAddress",
    }),
    bscPublic.readContract({
      address: state.bsc.address,
      abi: executorRead,
      functionName: "threshold",
    }),
    bscPublic.readContract({
      address: state.bsc.address,
      abi: executorRead,
      functionName: "peers",
      args: [current.params.ethLzEid],
    }),
    bscPublic.readContract({
      address: state.bsc.address,
      abi: executorRead,
      functionName: "allowedTargets",
      args: [getAddress(current.params.bscDealFactory)],
    }),
    bscPublic.readContract({
      address: getAddress(current.params.bscLzEndpoint),
      abi: endpointAbi,
      functionName: "delegates",
      args: [state.bsc.address],
    }),
  ]);
  if (
    !same(bscRouter, BSC_CCIP_ROUTER) ||
    ccipSelector !== ETH_CCIP_SELECTOR ||
    !same(ccipSender, state.eth.address) ||
    !same(bscAxGateway, getAddress(current.params.bscAxelarGateway)) ||
    axChain !== current.params.ethAxelarChainName ||
    axAddress !== state.eth.address ||
    threshold !== 2n ||
    unsetPeer !== `0x${"0".repeat(64)}` ||
    factoryAllowed ||
    !same(bscDelegate, bscAccount.address)
  ) {
    throw new Error(
      "DualBridgeExecutorV2 constructor/readback mismatch or route unexpectedly wired"
    );
  }

  const registry = getAddress(ethDeployment.addresses.governancePolicyRegistry);
  const [newParameterRule, newMajorRule, oldParameterRule, oldMajorRule] =
    await Promise.all([
      ethPublic.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "getRule",
        args: [0, state.eth.address, BROADCAST_SELECTOR],
      }),
      ethPublic.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "getRule",
        args: [2, state.eth.address, BROADCAST_SELECTOR],
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
  if (newParameterRule[0] || newMajorRule[0]) {
    throw new Error(
      "New broadcaster DAO policy was unexpectedly enabled during deploy-only stage"
    );
  }
  if (
    !oldParameterRule[0] ||
    !oldParameterRule[1] ||
    oldParameterRule[2] ||
    !oldMajorRule[0] ||
    !oldMajorRule[1] ||
    oldMajorRule[2]
  ) {
    throw new Error(
      "V1 broadcaster DAO policy changed during deploy-only stage"
    );
  }

  state.bsc.verified = true;
  state.stage = "both_deployed";
  state.verification = {
    runtimeBytes: {
      broadcaster: runtimeBytes(broadcasterArtifact.deployedBytecode),
      executor: runtimeBytes(executorArtifact.deployedBytecode),
    },
    broadcasterChainCount: chainIds.length,
    executorPeerUnset: true,
    factoryAllowed: false,
    factoryStillControlledByV1: true,
    daoPolicyChanged: false,
    newBroadcasterPolicyEnabled: false,
    oldBroadcasterPolicyPreserved: true,
  };
  save(state);

  console.log("Stage 1 complete and read back successfully.");
  console.log(
    `ETH CrossChainBroadcasterV2: ${state.eth.address} tx=${
      state.eth.txHash ?? "recovered"
    }`
  );
  console.log(
    `BSC DualBridgeExecutorV2: ${state.bsc.address} tx=${
      state.bsc.txHash ?? "recovered"
    }`
  );
  console.log(`State file: ${OUTPUT_FILE}`);
  console.log(
    "No peer, chain config, allowlist, factory, DAO policy or canary transaction was sent."
  );
}

mainRun().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
