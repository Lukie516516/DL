/**
 * Read-only ETH -> BSC bridge migration preflight.
 *
 * This script intentionally has no wallet client and no transaction-sending branch.
 * It verifies current mainnet authority/state, checks the official CCIP routers and lane,
 * predicts deployment addresses from pending nonces, and encodes the future transactions.
 *
 * Run:
 *   node --import tsx/esm scripts/prepare-mainnet-ccip-migration.ts
 *   node --import tsx/esm scripts/prepare-mainnet-ccip-migration.ts --json
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  concatHex,
  createPublicClient,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  http,
  padHex,
  parseAbi,
  toHex,
  toFunctionSelector,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { bsc, mainnet } from "viem/chains";

type Artifact = {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
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
    bscAxelarChainName: string;
    axelarMinFeeWei: string;
    ethGovernance: Address;
    bscChainKey: number;
    bscDealFactory: Address;
  };
};

type Deployment = {
  addresses: {
    governancePolicyRegistry: Address;
  };
};

type Stage1Deployment = {
  stage: string;
  eth: { address: Address; verified?: boolean };
  bsc: { address: Address; verified?: boolean };
};

type Stage2Deployment = {
  stage: string;
  broadcaster: Address;
  executor: Address;
  verification?: { chainActive?: boolean; factoryAllowed?: boolean };
};

const ROOT = process.cwd();
const state = JSON.parse(
  readFileSync(join(ROOT, "deployments", "mainnet-cross-chain.json"), "utf8")
) as CurrentBridgeState;
const ethDeployment = JSON.parse(
  readFileSync(join(ROOT, "deployments", "eth-mainnet-1.json"), "utf8")
) as Deployment;
const stage1Path = join(ROOT, "deployments", "ccip-v2-mainnet-stage1.json");
const stage1 = existsSync(stage1Path)
  ? (JSON.parse(readFileSync(stage1Path, "utf8")) as Stage1Deployment)
  : undefined;
const stage1Deployed =
  stage1?.stage === "both_deployed" &&
  stage1.eth.verified === true &&
  stage1.bsc.verified === true;
const stage2Path = join(ROOT, "deployments", "ccip-v2-mainnet-stage2.json");
const stage2 = existsSync(stage2Path)
  ? (JSON.parse(readFileSync(stage2Path, "utf8")) as Stage2Deployment)
  : undefined;
const stage2Complete =
  stage2?.stage === "complete" &&
  stage2.verification?.chainActive === false &&
  stage2.verification?.factoryAllowed === true;

const ETH_RPC =
  process.env.ETH_MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com";
const BSC_RPC =
  process.env.BSC_MAINNET_RPC_URL || "https://bsc-dataseed.binance.org";

// Chainlink CCIP Directory mainnet values, rechecked by this script against the routers.
const ETH_CCIP_ROUTER = getAddress(
  "0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D"
);
const BSC_CCIP_ROUTER = getAddress(
  "0x34B03Cb9086d7D758AC55af71584F81A598759FE"
);
const ETH_CCIP_SELECTOR = 5_009_297_550_715_157_269n;
const BSC_CCIP_SELECTOR = 11_344_663_589_394_136_015n;
const BROADCAST_SIGNATURE = "broadcast(uint32[],address[],bytes,uint128)";
const BROADCAST_SELECTOR = toFunctionSelector(BROADCAST_SIGNATURE);
const PARAMETER = 0;
const MAJOR = 2;
const MAX_BROADCAST_VALUE = 10_000_000_000_000_000n;

const eth = createPublicClient({ chain: mainnet, transport: http(ETH_RPC) });
const bscClient = createPublicClient({ chain: bsc, transport: http(BSC_RPC) });

const broadcasterReadAbi = parseAbi([
  "function owner() view returns (address)",
  "function governance() view returns (address)",
]);
const executorReadAbi = parseAbi([
  "function owner() view returns (address)",
  "function threshold() view returns (uint256)",
]);
const factoryReadAbi = parseAbi([
  "function owner() view returns (address)",
  "function crossChainGovernance() view returns (address)",
  "function minWindowSec() view returns (uint32)",
]);
const routerAbi = parseAbi([
  "function isChainSupported(uint64 destinationChainSelector) view returns (bool)",
  "function getFee(uint64 destinationChainSelector,(bytes receiver,bytes data,(address token,uint256 amount)[] tokenAmounts,address feeToken,bytes extraArgs) message) view returns (uint256 fee)",
]);
const lzEndpointAbi = parseAbi([
  "function quote((uint32 dstEid,bytes32 receiver,bytes message,bytes options,bool payInLzToken) params,address sender) view returns ((uint256 nativeFee,uint256 lzTokenFee) fee)",
]);
const registryReadAbi = parseAbi([
  "function getRule(uint8 kind,address target,bytes4 selector) view returns (bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)",
]);
const v2BroadcasterReadAbi = parseAbi([
  "function owner() view returns (address)",
  "function governance() view returns (address)",
  "function endpoint() view returns (address)",
  "function ccipRouter() view returns (address)",
  "function getChainIds() view returns (uint32[])",
  "function peers(uint32 eid) view returns (bytes32)",
  "function chains(uint32 chainId) view returns (uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
]);
const v2ExecutorReadAbi = parseAbi([
  "function owner() view returns (address)",
  "function endpoint() view returns (address)",
  "function ccipRouter() view returns (address)",
  "function ccipSrcChainSelector() view returns (uint64)",
  "function ccipSrcSender() view returns (address)",
  "function axSrcChain() view returns (string)",
  "function axSrcAddress() view returns (string)",
  "function threshold() view returns (uint256)",
  "function peers(uint32 eid) view returns (bytes32)",
  "function allowedTargets(address target) view returns (bool)",
]);

function artifact(path: string): Artifact {
  return JSON.parse(
    readFileSync(join(ROOT, "artifacts", "contracts", path), "utf8")
  ) as Artifact;
}

function same(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function hasCode(code: Hex | undefined): boolean {
  return Boolean(code && code !== "0x");
}

function addrToBytes32(address: Address): Hex {
  return padHex(address.toLowerCase() as Hex, { size: 32 });
}

function byteLength(hex: Hex): number {
  return (hex.length - 2) / 2;
}

async function mainRun() {
  const broadcasterArtifact = artifact(
    "bridge/CrossChainBroadcasterV2.sol/CrossChainBroadcasterV2.json"
  );
  const executorArtifact = artifact(
    "bridge/DualBridgeExecutorV2.sol/DualBridgeExecutorV2.json"
  );
  const registryArtifact = artifact(
    "GovernancePolicyRegistry.sol/GovernancePolicyRegistry.json"
  );

  const ethDeployer = getAddress(state.eth.deployer);
  const bscDeployer = getAddress(state.bsc.deployer);
  const oldBroadcaster = getAddress(state.eth.broadcaster);
  const oldExecutor = getAddress(state.bsc.executor);
  const governance = getAddress(state.params.ethGovernance);
  const registry = getAddress(ethDeployment.addresses.governancePolicyRegistry);
  const bscFactory = getAddress(state.params.bscDealFactory);

  const [
    ethBlock,
    bscBlock,
    ethPendingNonce,
    bscPendingNonce,
    oldBroadcasterOwner,
    oldBroadcasterGovernance,
    oldExecutorOwner,
    oldThreshold,
    bscFactoryOwner,
    bscFactoryGovernance,
    bscMinWindowSec,
    ethLaneSupported,
    bscLaneSupported,
    ethRouterCode,
    bscRouterCode,
    parameterRule,
    majorRule,
    ethChainId,
    bscChainId,
    ethLzCode,
    bscLzCode,
    ethAxelarGatewayCode,
    ethAxelarGasServiceCode,
    bscAxelarGatewayCode,
    governanceBalance,
    ethDeployerBalance,
    bscDeployerBalance,
  ] = await Promise.all([
    eth.getBlockNumber(),
    bscClient.getBlockNumber(),
    eth.getTransactionCount({ address: ethDeployer, blockTag: "pending" }),
    bscClient.getTransactionCount({
      address: bscDeployer,
      blockTag: "pending",
    }),
    eth.readContract({
      address: oldBroadcaster,
      abi: broadcasterReadAbi,
      functionName: "owner",
    }),
    eth.readContract({
      address: oldBroadcaster,
      abi: broadcasterReadAbi,
      functionName: "governance",
    }),
    bscClient.readContract({
      address: oldExecutor,
      abi: executorReadAbi,
      functionName: "owner",
    }),
    bscClient.readContract({
      address: oldExecutor,
      abi: executorReadAbi,
      functionName: "threshold",
    }),
    bscClient.readContract({
      address: bscFactory,
      abi: factoryReadAbi,
      functionName: "owner",
    }),
    bscClient.readContract({
      address: bscFactory,
      abi: factoryReadAbi,
      functionName: "crossChainGovernance",
    }),
    bscClient.readContract({
      address: bscFactory,
      abi: factoryReadAbi,
      functionName: "minWindowSec",
    }),
    eth.readContract({
      address: ETH_CCIP_ROUTER,
      abi: routerAbi,
      functionName: "isChainSupported",
      args: [BSC_CCIP_SELECTOR],
    }),
    bscClient.readContract({
      address: BSC_CCIP_ROUTER,
      abi: routerAbi,
      functionName: "isChainSupported",
      args: [ETH_CCIP_SELECTOR],
    }),
    eth.getCode({ address: ETH_CCIP_ROUTER }),
    bscClient.getCode({ address: BSC_CCIP_ROUTER }),
    eth.readContract({
      address: registry,
      abi: registryReadAbi,
      functionName: "getRule",
      args: [PARAMETER, oldBroadcaster, BROADCAST_SELECTOR],
    }),
    eth.readContract({
      address: registry,
      abi: registryReadAbi,
      functionName: "getRule",
      args: [MAJOR, oldBroadcaster, BROADCAST_SELECTOR],
    }),
    eth.getChainId(),
    bscClient.getChainId(),
    eth.getCode({ address: getAddress(state.params.ethLzEndpoint) }),
    bscClient.getCode({ address: getAddress(state.params.bscLzEndpoint) }),
    eth.getCode({ address: getAddress(state.params.ethAxelarGateway) }),
    eth.getCode({ address: getAddress(state.params.ethAxelarGasService) }),
    bscClient.getCode({ address: getAddress(state.params.bscAxelarGateway) }),
    eth.getBalance({ address: governance }),
    eth.getBalance({ address: ethDeployer }),
    bscClient.getBalance({ address: bscDeployer }),
  ]);

  const predictedBroadcaster = getContractAddress({
    from: ethDeployer,
    nonce: BigInt(ethPendingNonce),
  });
  const predictedExecutor = getContractAddress({
    from: bscDeployer,
    nonce: BigInt(bscPendingNonce),
  });
  const newBroadcaster = stage1Deployed
    ? getAddress(stage1!.eth.address)
    : predictedBroadcaster;
  const newExecutor = stage1Deployed
    ? getAddress(stage1!.bsc.address)
    : predictedExecutor;
  const [newBroadcasterCode, newExecutorCode] = await Promise.all([
    eth.getCode({ address: newBroadcaster }),
    bscClient.getCode({ address: newExecutor }),
  ]);
  const stage1Readback = stage1Deployed
    ? await Promise.all([
        eth.readContract({
          address: newBroadcaster,
          abi: v2BroadcasterReadAbi,
          functionName: "owner",
        }),
        eth.readContract({
          address: newBroadcaster,
          abi: v2BroadcasterReadAbi,
          functionName: "governance",
        }),
        eth.readContract({
          address: newBroadcaster,
          abi: v2BroadcasterReadAbi,
          functionName: "endpoint",
        }),
        eth.readContract({
          address: newBroadcaster,
          abi: v2BroadcasterReadAbi,
          functionName: "ccipRouter",
        }),
        eth.readContract({
          address: newBroadcaster,
          abi: v2BroadcasterReadAbi,
          functionName: "getChainIds",
        }),
        bscClient.readContract({
          address: newExecutor,
          abi: v2ExecutorReadAbi,
          functionName: "owner",
        }),
        bscClient.readContract({
          address: newExecutor,
          abi: v2ExecutorReadAbi,
          functionName: "endpoint",
        }),
        bscClient.readContract({
          address: newExecutor,
          abi: v2ExecutorReadAbi,
          functionName: "ccipRouter",
        }),
        bscClient.readContract({
          address: newExecutor,
          abi: v2ExecutorReadAbi,
          functionName: "ccipSrcChainSelector",
        }),
        bscClient.readContract({
          address: newExecutor,
          abi: v2ExecutorReadAbi,
          functionName: "ccipSrcSender",
        }),
        bscClient.readContract({
          address: newExecutor,
          abi: v2ExecutorReadAbi,
          functionName: "axSrcChain",
        }),
        bscClient.readContract({
          address: newExecutor,
          abi: v2ExecutorReadAbi,
          functionName: "axSrcAddress",
        }),
        bscClient.readContract({
          address: newExecutor,
          abi: v2ExecutorReadAbi,
          functionName: "threshold",
        }),
        bscClient.readContract({
          address: newExecutor,
          abi: v2ExecutorReadAbi,
          functionName: "peers",
          args: [state.params.ethLzEid],
        }),
        bscClient.readContract({
          address: newExecutor,
          abi: v2ExecutorReadAbi,
          functionName: "allowedTargets",
          args: [bscFactory],
        }),
        eth.readContract({
          address: registry,
          abi: registryReadAbi,
          functionName: "getRule",
          args: [PARAMETER, newBroadcaster, BROADCAST_SELECTOR],
        }),
        eth.readContract({
          address: registry,
          abi: registryReadAbi,
          functionName: "getRule",
          args: [MAJOR, newBroadcaster, BROADCAST_SELECTOR],
        }),
        eth.readContract({
          address: newBroadcaster,
          abi: v2BroadcasterReadAbi,
          functionName: "peers",
          args: [state.params.bscLzEid],
        }),
        eth.readContract({
          address: newBroadcaster,
          abi: v2BroadcasterReadAbi,
          functionName: "chains",
          args: [state.params.bscChainKey],
        }),
      ])
    : undefined;
  const canaryInnerData = encodeFunctionData({
    abi: parseAbi(["function setMinWindowSec(uint32 seconds_)"]),
    functionName: "setMinWindowSec",
    args: [bscMinWindowSec],
  });
  const ccipFeeProbePayload = encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
    [1n, bscFactory, canaryInnerData]
  );
  const ccipExtraArgs = concatHex([
    "0x181dcf10",
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "bool" }],
      [500_000n, true]
    ),
  ]);
  const sampleCcipNativeFee = await eth.readContract({
    address: ETH_CCIP_ROUTER,
    abi: routerAbi,
    functionName: "getFee",
    args: [
      BSC_CCIP_SELECTOR,
      {
        receiver: encodeAbiParameters([{ type: "address" }], [newExecutor]),
        data: ccipFeeProbePayload,
        tokenAmounts: [],
        feeToken: zeroAddress,
        extraArgs: ccipExtraArgs,
      },
    ],
  });
  const lzOptions = concatHex([
    toHex(3, { size: 2 }),
    toHex(1, { size: 1 }),
    toHex(17, { size: 2 }),
    toHex(1, { size: 1 }),
    toHex(500_000, { size: 16 }),
  ]);
  const sampleLzFee = await eth.readContract({
    address: getAddress(state.params.ethLzEndpoint),
    abi: lzEndpointAbi,
    functionName: "quote",
    args: [
      {
        dstEid: state.params.bscLzEid,
        receiver: addrToBytes32(newExecutor),
        message: ccipFeeProbePayload,
        options: lzOptions,
        payInLzToken: false,
      },
      newBroadcaster,
    ],
  });
  const sampleLzNativeFee = sampleLzFee.nativeFee;
  const sampleTotalNativeFee =
    sampleLzNativeFee +
    sampleCcipNativeFee +
    BigInt(state.params.axelarMinFeeWei);

  const blockers: string[] = [];
  const expect = (condition: boolean, message: string) => {
    if (!condition) blockers.push(message);
  };
  expect(
    same(oldBroadcasterOwner, ethDeployer),
    "old ETH broadcaster owner != expected deployer"
  );
  expect(
    same(oldBroadcasterGovernance, governance),
    "old ETH broadcaster governance != DAO proxy"
  );
  expect(
    same(oldExecutorOwner, bscDeployer),
    "old BSC executor owner != expected deployer"
  );
  expect(oldThreshold === 2n, "old BSC executor threshold != 2");
  expect(
    same(bscFactoryOwner, bscDeployer),
    "BSC factory owner != expected deployer"
  );
  expect(
    same(bscFactoryGovernance, oldExecutor),
    "BSC factory is not controlled by old executor"
  );
  expect(ethChainId === 1, `ETH RPC returned chain ${ethChainId}`);
  expect(bscChainId === 56, `BSC RPC returned chain ${bscChainId}`);
  expect(ethLaneSupported, "ETH CCIP router does not support BSC selector");
  expect(bscLaneSupported, "BSC CCIP router does not support ETH selector");
  expect(
    sampleCcipNativeFee > 0n,
    "ETH CCIP Router returned a zero sample fee"
  );
  expect(
    sampleLzNativeFee > 0n,
    "ETH LayerZero endpoint returned a zero sample fee"
  );
  expect(
    governanceBalance >= sampleTotalNativeFee,
    "DAO proxy ETH balance is below the current three-bridge sample fee"
  );
  expect(ethDeployerBalance > 0n, "ETH deployer has no native deployment gas");
  expect(bscDeployerBalance > 0n, "BSC deployer has no native deployment gas");
  expect(hasCode(ethRouterCode), "ETH CCIP router has no code");
  expect(hasCode(bscRouterCode), "BSC CCIP router has no code");
  expect(hasCode(ethLzCode), "ETH LayerZero endpoint has no code");
  expect(hasCode(bscLzCode), "BSC LayerZero endpoint has no code");
  expect(hasCode(ethAxelarGatewayCode), "ETH Axelar gateway has no code");
  expect(
    hasCode(ethAxelarGasServiceCode),
    "ETH Axelar gas service has no code"
  );
  expect(hasCode(bscAxelarGatewayCode), "BSC Axelar gateway has no code");
  if (stage1Deployed) {
    expect(hasCode(newBroadcasterCode), "deployed ETH broadcaster has no code");
    expect(hasCode(newExecutorCode), "deployed BSC executor has no code");
    if (hasCode(newBroadcasterCode)) {
      expect(
        byteLength(newBroadcasterCode!) ===
          byteLength(broadcasterArtifact.deployedBytecode),
        "deployed ETH broadcaster runtime size mismatch"
      );
    }
    if (hasCode(newExecutorCode)) {
      expect(
        byteLength(newExecutorCode!) ===
          byteLength(executorArtifact.deployedBytecode),
        "deployed BSC executor runtime size mismatch"
      );
    }
    expect(
      same(stage1Readback![0], ethDeployer),
      "deployed broadcaster owner mismatch"
    );
    expect(
      same(stage1Readback![1], governance),
      "deployed broadcaster governance mismatch"
    );
    expect(
      same(stage1Readback![2], getAddress(state.params.ethLzEndpoint)),
      "deployed broadcaster endpoint mismatch"
    );
    expect(
      same(stage1Readback![3], ETH_CCIP_ROUTER),
      "deployed broadcaster CCIP router mismatch"
    );
    expect(
      same(stage1Readback![5], bscDeployer),
      "deployed executor owner mismatch"
    );
    expect(
      same(stage1Readback![6], getAddress(state.params.bscLzEndpoint)),
      "deployed executor endpoint mismatch"
    );
    expect(
      same(stage1Readback![7], BSC_CCIP_ROUTER),
      "deployed executor CCIP router mismatch"
    );
    expect(
      stage1Readback![8] === ETH_CCIP_SELECTOR,
      "deployed executor CCIP selector mismatch"
    );
    expect(
      same(stage1Readback![9], newBroadcaster),
      "deployed executor CCIP sender mismatch"
    );
    expect(
      stage1Readback![10] === state.params.ethAxelarChainName,
      "deployed executor Axelar chain mismatch"
    );
    expect(
      stage1Readback![11] === newBroadcaster,
      "deployed executor Axelar sender mismatch"
    );
    expect(stage1Readback![12] === 2n, "deployed executor threshold mismatch");
    expect(
      stage1Readback![15][0] === false && stage1Readback![16][0] === false,
      "deployed broadcaster DAO policy already enabled"
    );
    if (stage2Complete) {
      expect(
        same(getAddress(stage2!.broadcaster), newBroadcaster) &&
          same(getAddress(stage2!.executor), newExecutor),
        "stage-2 record points to different V2 contracts"
      );
      expect(
        stage1Readback![4].length === 1 &&
          stage1Readback![4][0] === state.params.bscChainKey,
        "stage-2 broadcaster chain list mismatch"
      );
      expect(
        stage1Readback![13].toLowerCase() ===
          addrToBytes32(newBroadcaster).toLowerCase(),
        "stage-2 executor LayerZero peer mismatch"
      );
      expect(stage1Readback![14] === true, "stage-2 factory allowlist missing");
      expect(
        stage1Readback![17].toLowerCase() ===
          addrToBytes32(newExecutor).toLowerCase(),
        "stage-2 broadcaster LayerZero peer mismatch"
      );
      const cfg = stage1Readback![18];
      expect(
        cfg[0] === state.params.bscLzEid,
        "stage-2 LZ destination mismatch"
      );
      expect(cfg[1] === BSC_CCIP_SELECTOR, "stage-2 CCIP selector mismatch");
      expect(same(cfg[2], newExecutor), "stage-2 CCIP receiver mismatch");
      expect(
        cfg[3] === state.params.bscAxelarChainName,
        "stage-2 Axelar chain mismatch"
      );
      expect(
        cfg[4] === newExecutor.toLowerCase(),
        "stage-2 Axelar destination mismatch"
      );
      expect(
        cfg[5] === BigInt(state.params.axelarMinFeeWei),
        "stage-2 Axelar fee mismatch"
      );
      expect(cfg[6] === false, "stage-2 route unexpectedly active");
    } else {
      expect(
        stage1Readback![4].length === 0,
        "deployed broadcaster is already configured without completed stage-2 record"
      );
      expect(
        stage1Readback![13] === `0x${"0".repeat(64)}`,
        "deployed executor LayerZero peer already set without completed stage-2 record"
      );
      expect(
        stage1Readback![14] === false,
        "deployed executor factory allowlist already set without completed stage-2 record"
      );
      expect(
        stage1Readback![17] === `0x${"0".repeat(64)}`,
        "deployed broadcaster LayerZero peer already set without completed stage-2 record"
      );
    }
  } else {
    expect(
      !hasCode(newBroadcasterCode),
      "predicted ETH broadcaster address already has code"
    );
    expect(
      !hasCode(newExecutorCode),
      "predicted BSC executor address already has code"
    );
  }
  expect(
    parameterRule[0] && parameterRule[1] && !parameterRule[2],
    "old Parameter broadcast rule changed"
  );
  expect(
    majorRule[0] && majorRule[1] && !majorRule[2],
    "old Major broadcast rule changed"
  );
  expect(
    parameterRule[3] === MAX_BROADCAST_VALUE,
    "old Parameter broadcast maxValue changed"
  );
  expect(
    majorRule[3] === MAX_BROADCAST_VALUE,
    "old Major broadcast maxValue changed"
  );
  expect(
    byteLength(broadcasterArtifact.deployedBytecode) <= 24_576,
    "broadcaster runtime exceeds EIP-170"
  );
  expect(
    byteLength(executorArtifact.deployedBytecode) <= 24_576,
    "executor runtime exceeds EIP-170"
  );

  const broadcasterDeployData = encodeDeployData({
    abi: broadcasterArtifact.abi,
    bytecode: broadcasterArtifact.bytecode,
    args: [
      getAddress(state.params.ethLzEndpoint),
      ethDeployer,
      governance,
      ETH_CCIP_ROUTER,
      getAddress(state.params.ethAxelarGateway),
      getAddress(state.params.ethAxelarGasService),
    ],
  });
  const executorDeployData = encodeDeployData({
    abi: executorArtifact.abi,
    bytecode: executorArtifact.bytecode,
    args: [
      getAddress(state.params.bscLzEndpoint),
      bscDeployer,
      BSC_CCIP_ROUTER,
      ETH_CCIP_SELECTOR,
      newBroadcaster,
      getAddress(state.params.bscAxelarGateway),
      state.params.ethAxelarChainName,
      newBroadcaster,
      2n,
    ],
  });

  const parameterNewRule = {
    kind: PARAMETER,
    target: newBroadcaster,
    selector: BROADCAST_SELECTOR,
    allowed: true,
    validateNestedBroadcast: true,
    nestedOnly: false,
    maxValue: parameterRule[3],
  };
  const majorNewRule = {
    ...parameterNewRule,
    kind: MAJOR,
    maxValue: majorRule[3],
  };
  const enableNewRules = encodeFunctionData({
    abi: registryArtifact.abi,
    functionName: "setRules",
    args: [[parameterNewRule, majorNewRule]],
  });
  const disableOldRules = encodeFunctionData({
    abi: registryArtifact.abi,
    functionName: "setRules",
    args: [
      [
        {
          ...parameterNewRule,
          target: oldBroadcaster,
          allowed: false,
          validateNestedBroadcast: false,
          maxValue: 0n,
        },
        {
          ...majorNewRule,
          target: oldBroadcaster,
          allowed: false,
          validateNestedBroadcast: false,
          maxValue: 0n,
        },
      ],
    ],
  });

  const bscChainConfig = {
    lzDstEid: state.params.bscLzEid,
    ccipDstChainSelector: BSC_CCIP_SELECTOR,
    ccipReceiver: newExecutor,
    axDstChain: state.params.bscAxelarChainName,
    axDstAddress: newExecutor.toLowerCase(),
    axMinFee: BigInt(state.params.axelarMinFeeWei),
    active: false,
  };
  const canaryBroadcastData = encodeFunctionData({
    abi: broadcasterArtifact.abi,
    functionName: "broadcast",
    args: [[state.params.bscChainKey], [bscFactory], canaryInnerData, 500_000n],
  });

  const wiring = {
    eth: {
      setPeer: encodeFunctionData({
        abi: broadcasterArtifact.abi,
        functionName: "setPeer",
        args: [state.params.bscLzEid, addrToBytes32(newExecutor)],
      }),
      addBscInactive: encodeFunctionData({
        abi: broadcasterArtifact.abi,
        functionName: "addChain",
        args: [state.params.bscChainKey, bscChainConfig],
      }),
      activateBsc: encodeFunctionData({
        abi: broadcasterArtifact.abi,
        functionName: "setChainActive",
        args: [state.params.bscChainKey, true],
      }),
      emergencyPauseBsc: encodeFunctionData({
        abi: broadcasterArtifact.abi,
        functionName: "setChainActive",
        args: [state.params.bscChainKey, false],
      }),
    },
    bsc: {
      setPeer: encodeFunctionData({
        abi: executorArtifact.abi,
        functionName: "setPeer",
        args: [state.params.ethLzEid, addrToBytes32(newBroadcaster)],
      }),
      allowFactory: encodeFunctionData({
        abi: executorArtifact.abi,
        functionName: "setAllowedTarget",
        args: [bscFactory, true],
      }),
      switchFactoryToV2: encodeFunctionData({
        abi: parseAbi(["function setCrossChainGovernance(address executor)"]),
        functionName: "setCrossChainGovernance",
        args: [newExecutor],
      }),
      rollbackFactoryToV1: encodeFunctionData({
        abi: parseAbi(["function setCrossChainGovernance(address executor)"]),
        functionName: "setCrossChainGovernance",
        args: [oldExecutor],
      }),
    },
  };

  const plan = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    snapshot: { ethBlock: ethBlock.toString(), bscBlock: bscBlock.toString() },
    blockers,
    current: {
      ethDeployer,
      bscDeployer,
      governance,
      registry,
      oldBroadcaster,
      oldExecutor,
      bscFactory,
      bscMinWindowSec,
      parameterRule,
      majorRule,
    },
    ccip: {
      ethRouter: ETH_CCIP_ROUTER,
      bscRouter: BSC_CCIP_ROUTER,
      ethSelector: ETH_CCIP_SELECTOR,
      bscSelector: BSC_CCIP_SELECTOR,
      ethToBscSupported: ethLaneSupported,
      bscToEthSupported: bscLaneSupported,
      sampleNativeFeeWei: sampleCcipNativeFee,
      sampleLzNativeFeeWei: sampleLzNativeFee,
      sampleTotalNativeFeeWei: sampleTotalNativeFee,
    },
    balances: { governanceBalance, ethDeployerBalance, bscDeployerBalance },
    v2: {
      stage1Deployed,
      stage2Complete,
      newBroadcaster,
      newExecutor,
      broadcasterRuntimeBytes: byteLength(broadcasterArtifact.deployedBytecode),
      executorRuntimeBytes: byteLength(executorArtifact.deployedBytecode),
    },
    deploymentPrediction: stage1Deployed
      ? null
      : {
          ethPendingNonce,
          bscPendingNonce,
          predictedBroadcaster,
          predictedExecutor,
        },
    deployData: stage1Deployed
      ? null
      : { broadcasterDeployData, executorDeployData },
    wiring,
    daoPolicy: {
      enableNewBroadcaster: {
        target: registry,
        value: 0n,
        data: enableNewRules,
      },
      disableOldBroadcasterAfterCanary: {
        target: registry,
        value: 0n,
        data: disableOldRules,
      },
    },
    canary: {
      meaning:
        "BSC setMinWindowSec(current value): authorization/path test with no semantic parameter change",
      target: newBroadcaster,
      innerTarget: bscFactory,
      innerData: canaryInnerData,
      broadcastData: canaryBroadcastData,
      actionValue:
        "quoteFees after deployment and immediately before proposal creation",
    },
    sequencing: [
      ...(stage1Deployed
        ? [
            "Stage 1 is already deployed and read back; do not deploy another V2 pair.",
          ]
        : [
            "Deploy both V2 contracts at the predicted nonces; abort if either nonce changes.",
          ]),
      ...(stage2Complete
        ? [
            "Stage 2 exact wiring is already complete and the BSC route remains inactive; do not wire again.",
          ]
        : [
            "Wire peers, add BSC inactive, allow only the BSC factory, then read back every field.",
          ]),
      "Create/execute a Major policy proposal that enables the new broadcaster; keep V1 enabled.",
      "Activate V2 BSC route, owner-switch BSC factory governance from V1 executor to V2 executor.",
      "Quote exact V2 fee and execute the same-value minWindowSec canary through DAO 2-of-3.",
      "If canary fails, pause V2 and owner-rollback factory to V1. If it passes, disable V1 rules by Major proposal.",
    ],
  };

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        plan,
        (_, value) => (typeof value === "bigint" ? value.toString() : value),
        2
      )
    );
  } else {
    console.log("=== CCIP bridge migration read-only preflight ===");
    console.log(`ETH block: ${ethBlock} | BSC block: ${bscBlock}`);
    console.log(`Current V1: ${oldBroadcaster} -> ${oldExecutor}`);
    console.log(
      `${
        stage1Deployed ? "Deployed" : "Predicted"
      } V2: ${newBroadcaster} -> ${newExecutor}`
    );
    if (stage2Complete)
      console.log("Stage 2 wiring: complete, route active=false");
    console.log(
      `CCIP lane: ETH->BSC=${ethLaneSupported}, BSC->ETH=${bscLaneSupported}`
    );
    console.log(`CCIP live sample fee: ${sampleCcipNativeFee} wei`);
    console.log(`LZ live sample fee: ${sampleLzNativeFee} wei`);
    console.log(`Three-bridge live sample total: ${sampleTotalNativeFee} wei`);
    console.log(`DAO ETH balance: ${governanceBalance} wei`);
    console.log(
      `Runtime bytes: broadcaster=${byteLength(
        broadcasterArtifact.deployedBytecode
      )}, executor=${byteLength(executorArtifact.deployedBytecode)}`
    );
    console.log(`Current BSC canary value: minWindowSec=${bscMinWindowSec}`);
    console.log(
      `Blockers (${blockers.length}): ${
        blockers.length ? blockers.join("; ") : "none"
      }`
    );
    console.log(
      "No transaction was signed or sent. Use --json for exact constructor/wiring calldata."
    );
  }

  if (blockers.length) process.exitCode = 2;
}

mainRun().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
