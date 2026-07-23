/**
 * CCIP V2 mainnet migration stage 3.
 *
 * Default mode is strictly read-only. It verifies the deployed/wired-but-inactive
 * V2 path and prints the exact Major proposal payload.
 *
 * Write mode may send at most two Ethereum transactions:
 *   1. approve exactly one Major proposal fee, but only when allowance is low;
 *   2. create the Major proposal that copies the V1 Parameter/Major broadcast
 *      rules to the V2 broadcaster.
 *
 * It contains no stake, execute, route activation, BSC Factory switch, broadcast,
 * V1 policy disable, mint, deployment, commit, or push path.
 *
 * Write gate:
 *   CCIP_V2_STAGE3_PROPOSE=CREATE_CCIP_V2_STAGE3_MAJOR_PROPOSAL
 *   node node_modules/hardhat/dist/src/cli.js run \
 *     scripts/propose-mainnet-ccip-v2-stage3.ts --network ethMainnet
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { network } from "hardhat";
import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  parseAbi,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

const ETH_DEPLOYMENT_FILE = "deployments/eth-mainnet-1.json";
const CROSS_CHAIN_FILE = "deployments/mainnet-cross-chain.json";
const STAGE1_FILE = "deployments/ccip-v2-mainnet-stage1.json";
const STAGE2_FILE = "deployments/ccip-v2-mainnet-stage2.json";
const STAGE3_FILE = "deployments/ccip-v2-mainnet-stage3.json";
const WRITE_CONFIRM = "CREATE_CCIP_V2_STAGE3_MAJOR_PROPOSAL";
const BSC_CHAIN_KEY = 30102;
const PARAMETER = 0;
const MAJOR = 2;
const PENDING_STATE = 1;
const BROADCAST_SIGNATURE = "broadcast(uint32[],address[],bytes,uint128)";
const BROADCAST_SELECTOR = toFunctionSelector(BROADCAST_SIGNATURE);
const EXPECTED_BROADCAST_MAX_VALUE = parseEther("0.01");
const DESCRIPTION =
  "DAO V2 cross-chain migration stage 3: copy the existing V1 Parameter and Major broadcast rules to CrossChainBroadcasterV2 0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6 while preserving the V1 rules. This proposal only updates GovernancePolicyRegistry. It does not activate the BSC route, switch the BSC DealFactory executor, send any cross-chain message, or disable V1. Purpose: prepare a controlled zero-business-change canary; immediate business impact: none.";

type Deployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
};

type CrossChainDeployment = {
  eth: { broadcaster: Address };
  bsc: { executor: Address };
  params: { bscDealFactory: Address; bscChainKey: number };
};

type Stage1State = {
  stage: string;
  eth: { address: Address; verified: boolean };
  bsc: { address: Address; verified: boolean };
};

type Stage2State = {
  stage: string;
  broadcaster: Address;
  executor: Address;
  verification: {
    chainId: number;
    chainActive: boolean;
    factoryAllowed: boolean;
    factoryStillControlledByV1: boolean;
    newBroadcasterPolicyEnabled: boolean;
    oldBroadcasterPolicyPreserved: boolean;
  };
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

const governanceAbi = parseAbi([
  "function dcToken() view returns (address)",
  "function treasury() view returns (address)",
  "function policyRegistry() view returns (address)",
  "function majorProposalFee() view returns (uint256)",
  "function proposalCount() view returns (uint256)",
  "function state(uint256) view returns (uint8)",
  "function getProposal(uint256) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description))",
  "function getActions(uint256) view returns (address[] targets,uint256[] values,bytes[] calldatas)",
  "function createProposal(address[],uint256[],bytes[],string,uint8) returns (uint256)",
]);

const registryAbi = parseAbi([
  "function governance() view returns (address)",
  "function getRule(uint8,address,bytes4) view returns ((bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue))",
  "function isActionAllowed(uint8,address,uint256,bytes) view returns (bool)",
  "function setRules((uint8 kind,address target,bytes4 selector,bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)[])",
]);

const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

const broadcasterAbi = parseAbi([
  "function governance() view returns (address)",
  "function getChainIds() view returns (uint32[])",
  "function chains(uint32) view returns (uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
]);

const bscFactoryAbi = parseAbi([
  "function crossChainGovernance() view returns (address)",
]);

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), path), "utf8")) as T;
}

function sameAddress(a: unknown, b: Address): boolean {
  return String(a).toLowerCase() === b.toLowerCase();
}

function sameHex(a: unknown, b: Hex): boolean {
  return String(a).toLowerCase() === b.toLowerCase();
}

function assertAddress(
  label: string,
  actual: unknown,
  expected: Address
): void {
  if (!sameAddress(actual, expected)) {
    throw new Error(`${label} mismatch: ${String(actual)} != ${expected}`);
  }
}

function normalizeRule(value: any): Rule {
  return {
    allowed: Boolean(value.allowed ?? value[0]),
    validateNestedBroadcast: Boolean(value.validateNestedBroadcast ?? value[1]),
    nestedOnly: Boolean(value.nestedOnly ?? value[2]),
    maxValue: BigInt(value.maxValue ?? value[3]),
  };
}

function assertRule(label: string, actual: Rule, expected: Rule): void {
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

async function assertCode(
  client: any,
  label: string,
  address: Address
): Promise<void> {
  const code = await client.getCode({ address });
  if (!code || code === "0x")
    throw new Error(`${label} has no code at ${address}`);
}

async function nonceState(client: any, address: Address) {
  const [latest, pending] = await Promise.all([
    client.getTransactionCount({ address, blockTag: "latest" }),
    client.getTransactionCount({ address, blockTag: "pending" }),
  ]);
  return { latest, pending };
}

async function waitFor(client: any, hash: Hex, label: string) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  console.log(`  OK ${label}: ${hash}`);
  return receipt;
}

function writeState(state: Record<string, unknown>): void {
  writeFileSync(
    join(process.cwd(), STAGE3_FILE),
    JSON.stringify(
      state,
      (_, value) => (typeof value === "bigint" ? value.toString() : value),
      2
    ) + "\n",
    "utf8"
  );
}

async function findDuplicateProposal(
  client: any,
  governance: Address,
  registry: Address,
  setRulesData: Hex,
  proposalCount: bigint
): Promise<bigint | undefined> {
  for (let id = 1n; id <= proposalCount; id += 1n) {
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
      sameHex(calldatas[0], setRulesData)
    ) {
      return id;
    }
  }
  return undefined;
}

async function main() {
  const deployment = loadJson<Deployment>(ETH_DEPLOYMENT_FILE);
  const crossChain = loadJson<CrossChainDeployment>(CROSS_CHAIN_FILE);
  const stage1 = loadJson<Stage1State>(STAGE1_FILE);
  const stage2 = loadJson<Stage2State>(STAGE2_FILE);
  if (deployment.chainId !== 1)
    throw new Error("ETH deployment chainId must be 1");
  if (
    stage1.stage !== "both_deployed" ||
    !stage1.eth.verified ||
    !stage1.bsc.verified
  ) {
    throw new Error("Stage 1 deployment is not fully verified");
  }
  if (stage2.stage !== "complete")
    throw new Error("Stage 2 wiring is not complete");
  if (
    stage2.verification.chainId !== BSC_CHAIN_KEY ||
    stage2.verification.chainActive ||
    !stage2.verification.factoryAllowed ||
    !stage2.verification.factoryStillControlledByV1 ||
    stage2.verification.newBroadcasterPolicyEnabled ||
    !stage2.verification.oldBroadcasterPolicyPreserved
  ) {
    throw new Error(
      "Stage 2 saved safety invariants do not match the expected inactive state"
    );
  }

  const governance = getAddress(deployment.addresses.dealGovernance);
  const registry = getAddress(deployment.addresses.governancePolicyRegistry);
  const dc = getAddress(deployment.addresses.dlToken);
  const treasury = getAddress(deployment.addresses.protocolTreasury);
  const oldBroadcaster = getAddress(deployment.addresses.crossChainBroadcaster);
  const newBroadcaster = getAddress(stage1.eth.address);
  const newExecutor = getAddress(stage1.bsc.address);
  const oldExecutor = getAddress(crossChain.bsc.executor);
  const bscFactory = getAddress(crossChain.params.bscDealFactory);
  const expectedSigner = getAddress(deployment.deployer);
  if (crossChain.params.bscChainKey !== BSC_CHAIN_KEY) {
    throw new Error(
      `Unexpected BSC chain key ${crossChain.params.bscChainKey}`
    );
  }
  assertAddress("Stage 2 broadcaster", stage2.broadcaster, newBroadcaster);
  assertAddress("Stage 2 executor", stage2.executor, newExecutor);
  assertAddress("V1 broadcaster", crossChain.eth.broadcaster, oldBroadcaster);

  const writeEnabled = process.env.CCIP_V2_STAGE3_PROPOSE === WRITE_CONFIRM;
  const { viem } = await network.connect();
  const ethPublic = await viem.getPublicClient();
  if ((await ethPublic.getChainId()) !== 1)
    throw new Error("Refusing non-Ethereum-mainnet network");
  const bscRpc =
    process.env.BSC_MAINNET_RPC_URL?.trim() ||
    "https://bsc-dataseed.binance.org";
  const bscPublic = createPublicClient({ transport: http(bscRpc) });
  if ((await bscPublic.getChainId()) !== 56)
    throw new Error("BSC RPC is not chainId 56");

  for (const [label, address] of [
    ["DealGovernance", governance],
    ["GovernancePolicyRegistry", registry],
    ["DC", dc],
    ["ProtocolTreasury", treasury],
    ["V1 Broadcaster", oldBroadcaster],
    ["V2 Broadcaster", newBroadcaster],
  ] as const) {
    await assertCode(ethPublic, label, address);
  }
  await assertCode(bscPublic, "BSC V1 Executor", oldExecutor);
  await assertCode(bscPublic, "BSC V2 Executor", newExecutor);
  await assertCode(bscPublic, "BSC DealFactory", bscFactory);

  const [
    chainRegistry,
    chainDc,
    chainTreasury,
    registryGovernance,
    v2Governance,
  ] = await Promise.all([
    ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "policyRegistry",
    }),
    ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "dcToken",
    }),
    ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "treasury",
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
  ]);
  assertAddress("DealGovernance.policyRegistry", chainRegistry, registry);
  assertAddress("DealGovernance.dcToken", chainDc, dc);
  assertAddress("DealGovernance.treasury", chainTreasury, treasury);
  assertAddress("Registry.governance", registryGovernance, governance);
  assertAddress("V2 Broadcaster.governance", v2Governance, governance);

  const [chainIds, chainConfig, factoryController] = await Promise.all([
    ethPublic.readContract({
      address: newBroadcaster,
      abi: broadcasterAbi,
      functionName: "getChainIds",
    }),
    ethPublic.readContract({
      address: newBroadcaster,
      abi: broadcasterAbi,
      functionName: "chains",
      args: [BSC_CHAIN_KEY],
    }),
    bscPublic.readContract({
      address: bscFactory,
      abi: bscFactoryAbi,
      functionName: "crossChainGovernance",
    }),
  ]);
  if (chainIds.length !== 1 || chainIds[0] !== BSC_CHAIN_KEY) {
    throw new Error(
      `V2 broadcaster chain list mismatch: ${chainIds.join(",")}`
    );
  }
  if (chainConfig[6])
    throw new Error(
      "V2 BSC route is already active; refusing proposal creation"
    );
  assertAddress("BSC Factory controller", factoryController, oldExecutor);

  const [oldParameterRaw, oldMajorRaw, newParameterRaw, newMajorRaw] =
    await Promise.all([
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
      ethPublic.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "getRule",
        args: [PARAMETER, newBroadcaster, BROADCAST_SELECTOR],
      }),
      ethPublic.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "getRule",
        args: [MAJOR, newBroadcaster, BROADCAST_SELECTOR],
      }),
    ]);
  const oldParameter = normalizeRule(oldParameterRaw);
  const oldMajor = normalizeRule(oldMajorRaw);
  const newParameter = normalizeRule(newParameterRaw);
  const newMajor = normalizeRule(newMajorRaw);
  const expectedOldRule: Rule = {
    allowed: true,
    validateNestedBroadcast: true,
    nestedOnly: false,
    maxValue: EXPECTED_BROADCAST_MAX_VALUE,
  };
  const expectedDisabledRule: Rule = {
    allowed: false,
    validateNestedBroadcast: false,
    nestedOnly: false,
    maxValue: 0n,
  };
  assertRule("V1 Parameter broadcast rule", oldParameter, expectedOldRule);
  assertRule("V1 Major broadcast rule", oldMajor, expectedOldRule);
  assertRule("V2 Parameter broadcast rule", newParameter, expectedDisabledRule);
  assertRule("V2 Major broadcast rule", newMajor, expectedDisabledRule);

  const rules: RuleInput[] = [
    {
      kind: PARAMETER,
      target: newBroadcaster,
      selector: BROADCAST_SELECTOR,
      ...oldParameter,
    },
    {
      kind: MAJOR,
      target: newBroadcaster,
      selector: BROADCAST_SELECTOR,
      ...oldMajor,
    },
  ];
  const setRulesData = encodeFunctionData({
    abi: registryAbi,
    functionName: "setRules",
    args: [rules],
  });
  const policyActionAllowed = await ethPublic.readContract({
    address: registry,
    abi: registryAbi,
    functionName: "isActionAllowed",
    args: [MAJOR, registry, 0n, setRulesData],
  });
  if (!policyActionAllowed)
    throw new Error("Registry rejects its own exact two-rule Major action");

  const wallets = await viem.getWalletClients();
  const wallet = wallets[0];
  if (!wallet)
    throw new Error(
      "Configured Ethereum wallet is required for signer verification"
    );
  const proposer = getAddress(wallet.account.address);
  assertAddress("Configured proposal signer", proposer, expectedSigner);
  const nonce = await nonceState(ethPublic, proposer);
  const [
    nativeBalance,
    majorFee,
    proposerDcBefore,
    treasuryDcBefore,
    allowanceBefore,
    proposalCountBefore,
  ] = await Promise.all([
    ethPublic.getBalance({ address: proposer }),
    ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "majorProposalFee",
    }),
    ethPublic.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [proposer],
    }),
    ethPublic.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [treasury],
    }),
    ethPublic.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [proposer, governance],
    }),
    ethPublic.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "proposalCount",
    }),
  ]);
  if (nonce.latest !== nonce.pending)
    throw new Error("Configured signer has pending transactions");
  if (nativeBalance === 0n)
    throw new Error("Configured signer has no ETH for gas");
  if (majorFee <= 0n)
    throw new Error("Major proposal fee is unexpectedly zero");
  const feeBalanceReady = proposerDcBefore >= majorFee;
  const duplicate = await findDuplicateProposal(
    ethPublic,
    governance,
    registry,
    setRulesData,
    proposalCountBefore
  );
  if (duplicate !== undefined)
    throw new Error(`Exact stage 3 proposal already exists as #${duplicate}`);

  const expectedProposalId = proposalCountBefore + 1n;
  const createProposalData = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [[registry], [0n], [setRulesData], DESCRIPTION, MAJOR],
  });
  const output: Record<string, unknown> = {
    schemaVersion: 1,
    scope:
      "create only the Major proposal that copies two V1 broadcast rules to V2; no stake, execute, activation, factory switch, broadcast, V1 disable or mint",
    stage: writeEnabled ? "preflight_complete" : "dry_run",
    preparedAt: new Date().toISOString(),
    ethBlock: (await ethPublic.getBlockNumber()).toString(),
    bscBlock: (await bscPublic.getBlockNumber()).toString(),
    proposer,
    governance,
    registry,
    dc,
    treasury,
    oldBroadcaster,
    newBroadcaster,
    oldExecutor,
    newExecutor,
    bscFactory,
    routeActive: false,
    factoryStillControlledByV1: true,
    proposalKind: MAJOR,
    description: DESCRIPTION,
    rules,
    setRulesCalldata: setRulesData,
    createProposalCalldata: createProposalData,
    proposalCountBefore: proposalCountBefore.toString(),
    expectedProposalId: expectedProposalId.toString(),
    majorFeeWei: majorFee.toString(),
    feeReadiness: {
      proposerDcBefore: proposerDcBefore.toString(),
      treasuryDcBefore: treasuryDcBefore.toString(),
      allowanceBefore: allowanceBefore.toString(),
      approvalRequired: allowanceBefore < majorFee,
    },
    signer: {
      nonceLatest: nonce.latest,
      noncePending: nonce.pending,
      nativeBalanceWei: nativeBalance.toString(),
    },
  };

  console.log("=== CCIP V2 stage 3 Major proposal preflight ===");
  console.log(`ETH block: ${output.ethBlock} | BSC block: ${output.bscBlock}`);
  console.log(
    `Proposer: ${proposer}; nonce latest=${nonce.latest}, pending=${nonce.pending}`
  );
  console.log(`Governance: ${governance}`);
  console.log(`Registry: ${registry}`);
  console.log(`V1 broadcaster preserved: ${oldBroadcaster}`);
  console.log(`V2 broadcaster to enable: ${newBroadcaster}`);
  console.log(
    `BSC route active: false; Factory controller remains V1: ${oldExecutor}`
  );
  console.log(`Selector: ${BROADCAST_SELECTOR}`);
  console.log(
    `Copied rule: allowed=true, nestedValidation=true, nestedOnly=false, maxValue=${formatEther(
      EXPECTED_BROADCAST_MAX_VALUE
    )} ETH`
  );
  console.log(`Major fee: ${formatEther(majorFee)} DC`);
  console.log(
    `Proposer DC: ${formatEther(proposerDcBefore)}; allowance: ${formatEther(
      allowanceBefore
    )} DC`
  );
  console.log(
    `Current proposalCount: ${proposalCountBefore}; expected proposalId: ${expectedProposalId}`
  );
  console.log(`Description: ${DESCRIPTION}`);
  console.log(`setRules calldata: ${setRulesData}`);

  if (!feeBalanceReady) {
    console.log(
      `BLOCKER: proposer needs ${formatEther(
        majorFee
      )} DC but currently holds ${formatEther(proposerDcBefore)} DC.`
    );
    console.log(
      "This script deliberately has no mint or treasury-transfer path."
    );
    if (writeEnabled) {
      throw new Error(
        "Refusing proposal write because the proposer cannot pay the Major fee"
      );
    }
    console.log("DRY-RUN ONLY: no transaction was signed or sent.");
    return;
  }

  if (!writeEnabled) {
    console.log("DRY-RUN ONLY: no transaction was signed or sent.");
    return;
  }

  const client = { public: ethPublic, wallet } as const;
  if (allowanceBefore < majorFee) {
    const token = await viem.getContractAt("DCToken", dc, { client });
    console.log("--- WRITE 1/2: approve exactly one Major proposal fee ---");
    const approvalHash = await token.write.approve([governance, majorFee]);
    const approvalReceipt = await waitFor(
      ethPublic,
      approvalHash,
      "approve exact Major fee"
    );
    const approvalTx = await ethPublic.getTransaction({ hash: approvalHash });
    assertAddress("Approval tx from", approvalTx.from, proposer);
    assertAddress("Approval tx to", approvalTx.to, dc);
    const expectedApprovalData = encodeFunctionData({
      abi: tokenAbi,
      functionName: "approve",
      args: [governance, majorFee],
    });
    if (!sameHex(approvalTx.input, expectedApprovalData))
      throw new Error("Approval calldata mismatch");
    const allowanceAfterApproval = await ethPublic.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [proposer, governance],
    });
    if (allowanceAfterApproval !== majorFee) {
      throw new Error(
        `Exact fee approval mismatch: ${allowanceAfterApproval} != ${majorFee}`
      );
    }
    output.stage = "fee_approved";
    output.approvalTx = approvalHash;
    output.approvalBlock = approvalReceipt.blockNumber.toString();
    output.approvalNonce = approvalTx.nonce;
    writeState(output);
  }

  const readyAllowance = await ethPublic.readContract({
    address: dc,
    abi: tokenAbi,
    functionName: "allowance",
    args: [proposer, governance],
  });
  if (readyAllowance < majorFee)
    throw new Error("Major fee allowance is still insufficient");
  const beforeProposalNonce = await nonceState(ethPublic, proposer);
  if (beforeProposalNonce.latest !== beforeProposalNonce.pending) {
    throw new Error(
      "Signer gained a pending transaction before proposal creation"
    );
  }

  await ethPublic.simulateContract({
    account: proposer,
    address: governance,
    abi: governanceAbi,
    functionName: "createProposal",
    args: [[registry], [0n], [setRulesData], DESCRIPTION, MAJOR],
  });
  const governanceContract = await viem.getContractAt(
    "DealGovernance",
    governance,
    { client }
  );
  console.log("--- WRITE 2/2: create the stage 3 Major proposal only ---");
  const proposalHash = await governanceContract.write.createProposal([
    [registry],
    [0n],
    [setRulesData],
    DESCRIPTION,
    MAJOR,
  ]);
  const proposalReceipt = await waitFor(
    ethPublic,
    proposalHash,
    "create stage 3 Major proposal"
  );
  const proposalTx = await ethPublic.getTransaction({ hash: proposalHash });
  assertAddress("Proposal tx from", proposalTx.from, proposer);
  assertAddress("Proposal tx to", proposalTx.to, governance);
  if (!sameHex(proposalTx.input, createProposalData))
    throw new Error("Proposal calldata mismatch");

  const [
    proposalCountAfter,
    proposalState,
    proposal,
    actions,
    proposerDcAfter,
    treasuryDcAfter,
    allowanceAfter,
    routeAfter,
    controllerAfter,
    newParameterAfterRaw,
    newMajorAfterRaw,
    oldParameterAfterRaw,
    oldMajorAfterRaw,
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
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [proposer],
    }),
    ethPublic.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [treasury],
    }),
    ethPublic.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [proposer, governance],
    }),
    ethPublic.readContract({
      address: newBroadcaster,
      abi: broadcasterAbi,
      functionName: "chains",
      args: [BSC_CHAIN_KEY],
    }),
    bscPublic.readContract({
      address: bscFactory,
      abi: bscFactoryAbi,
      functionName: "crossChainGovernance",
    }),
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [PARAMETER, newBroadcaster, BROADCAST_SELECTOR],
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
      args: [PARAMETER, oldBroadcaster, BROADCAST_SELECTOR],
    }),
    ethPublic.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, oldBroadcaster, BROADCAST_SELECTOR],
    }),
  ]);
  if (proposalCountAfter !== expectedProposalId) {
    throw new Error(
      `proposalCount mismatch: ${proposalCountAfter} != ${expectedProposalId}`
    );
  }
  if (proposalState !== PENDING_STATE)
    throw new Error(`New proposal state is ${proposalState}, expected Pending`);
  assertAddress("Proposal proposer", proposal.proposer, proposer);
  if (
    proposal.kind !== MAJOR ||
    proposal.totalStaked !== 0n ||
    proposal.windowEndsAt !== 0n
  ) {
    throw new Error("New proposal kind/stake/window mismatch");
  }
  if (proposal.vetoed || proposal.canceled || proposal.executed) {
    throw new Error("New proposal unexpectedly ended");
  }
  if (proposal.description !== DESCRIPTION)
    throw new Error("On-chain proposal description mismatch");
  if (
    actions[0].length !== 1 ||
    actions[1].length !== 1 ||
    actions[2].length !== 1 ||
    !sameAddress(actions[0][0], registry) ||
    actions[1][0] !== 0n ||
    !sameHex(actions[2][0], setRulesData)
  ) {
    throw new Error("On-chain proposal action mismatch");
  }
  if (proposerDcAfter !== proposerDcBefore - majorFee)
    throw new Error("Proposer DC fee debit mismatch");
  if (treasuryDcAfter !== treasuryDcBefore + majorFee)
    throw new Error("Treasury DC fee credit mismatch");
  if (allowanceAfter !== readyAllowance - majorFee)
    throw new Error("Post-proposal allowance mismatch");
  if (routeAfter[6])
    throw new Error("V2 route became active during proposal creation");
  assertAddress(
    "Post-proposal BSC Factory controller",
    controllerAfter,
    oldExecutor
  );
  assertRule(
    "Post-proposal V2 Parameter rule",
    normalizeRule(newParameterAfterRaw),
    expectedDisabledRule
  );
  assertRule(
    "Post-proposal V2 Major rule",
    normalizeRule(newMajorAfterRaw),
    expectedDisabledRule
  );
  assertRule(
    "Post-proposal V1 Parameter rule",
    normalizeRule(oldParameterAfterRaw),
    expectedOldRule
  );
  assertRule(
    "Post-proposal V1 Major rule",
    normalizeRule(oldMajorAfterRaw),
    expectedOldRule
  );

  output.stage = "proposal_created";
  output.updatedAt = new Date().toISOString();
  output.proposalTx = proposalHash;
  output.proposalBlock = proposalReceipt.blockNumber.toString();
  output.proposalNonce = proposalTx.nonce;
  output.proposalId = expectedProposalId.toString();
  output.verification = {
    receiptSuccess: true,
    transactionInputMatched: true,
    proposalState: "Pending",
    proposalKind: "Major",
    totalStakedWei: "0",
    windowEndsAt: "0",
    actionTarget: registry,
    actionValueWei: "0",
    actionCalldataMatched: true,
    majorFeeTransferredWei: majorFee.toString(),
    allowanceAfterWei: allowanceAfter.toString(),
    v2RulesStillDisabledUntilExecution: true,
    v1RulesPreserved: true,
    routeStillInactive: true,
    factoryStillControlledByV1: true,
  };
  writeState(output);
  console.log(`Proposal created: #${expectedProposalId}`);
  console.log(`Transaction: ${proposalHash}`);
  console.log(
    "Verified: Pending, Major, 0 D staked, no execution, route inactive, Factory on V1."
  );
  console.log(`Wrote ${STAGE3_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
