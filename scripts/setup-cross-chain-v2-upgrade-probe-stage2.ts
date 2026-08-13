/**
 * Stage 2 only for the asset-free cross-chain upgrade probe:
 *   1. BSC Executor V2 allowlists the BSC Probe proxy.
 *   2. ETH signer mints exactly one current Major proposal fee (1000 DC).
 *   3. ETH signer approves exactly that fee.
 *   4. ETH signer creates one Major proposal containing only two Probe upgrade rules.
 *
 * The proposal description is intentionally short and leader-readable.
 * This script has no stake, execute, broadcast, proxy upgrade, second proposal,
 * deployment, Git commit, or Git push path.
 *
 * Read-only preflight:
 *   node --import tsx/esm scripts/setup-cross-chain-v2-upgrade-probe-stage2.ts --preflight
 *
 * Explicit write gate:
 *   CROSS_CHAIN_V2_UPGRADE_PROBE_STAGE2_CONFIRM=ALLOWLIST_AND_CREATE_PROBE_POLICY_PROPOSAL \
 *     node --import tsx/esm scripts/setup-cross-chain-v2-upgrade-probe-stage2.ts
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
  parseAbi,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, mainnet } from "viem/chains";

const ROOT = process.cwd();
const OUTPUT_FILE = join(
  ROOT,
  "deployments",
  "cross-chain-v2-upgrade-probe-stage2.json",
);
const WRITE_CONFIRM = "ALLOWLIST_AND_CREATE_PROBE_POLICY_PROPOSAL";
const MAJOR = 2;
const PENDING = 1;
const EXPECTED_MAJOR_FEE = parseEther("1000");
const UPGRADE_SELECTOR = toFunctionSelector("upgradeToAndCall(address,bytes)");
const SET_RULES_SELECTOR = toFunctionSelector(
  "setRules((uint8,address,bytes4,bool,bool,bool,uint256)[])",
);
const TITLE = "跨链升级功能测试授权";
const BODY =
  "这是一次无业务影响的跨链升级测试。本提案只给 ETH 和 BSC 上两个独立测试合约开放升级权限，不涉及代币、国库、分红或任何业务合约；本提案通过后也不会立即升级，真正执行测试还需要另一个提案。";
const DESCRIPTION = `${TITLE}\n\n${BODY}`;
const SCOPE =
  "allowlist only the BSC Probe, mint/approve one exact Major fee, create one policy proposal; no stake, execute, broadcast or upgrade";

type CanonicalDeployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
};

type ProbeDeployment = {
  stage: string;
  signers: { eth: Address; bsc: Address };
  eth: {
    controller: Address;
    proxy: { address: Address };
    v2Implementation: { address: Address };
  };
  bsc: {
    controller: Address;
    proxy: { address: Address };
    v2Implementation: { address: Address };
  };
};

type CcipStage1 = {
  eth: { address: Address; verified: boolean };
  bsc: { address: Address; verified: boolean };
};

type TxRecord = {
  txHash: Hex;
  nonce: number;
  blockNumber: string;
  gasUsed: string;
  verified: boolean;
};

type Stage2State = {
  schemaVersion: 1;
  scope: string;
  stage:
    | "prepared"
    | "bsc_allowlisted"
    | "fee_minted"
    | "fee_approved"
    | "proposal_created";
  startedAt: string;
  updatedAt: string;
  description: string;
  proposer: Address;
  governance: Address;
  registry: Address;
  dc: Address;
  treasury: Address;
  executor: Address;
  ethProxy: Address;
  bscProxy: Address;
  majorFee: string;
  proposalCountBefore: string;
  setRulesCalldata: Hex;
  createProposalCalldata: Hex;
  actions: {
    bscAllowlist?: TxRecord;
    mintFee?: TxRecord;
    approveFee?: TxRecord;
    createProposal?: TxRecord;
  };
  proposalId?: string;
  verification?: {
    proposalState: string;
    totalStaked: string;
    descriptionMatched: boolean;
    actionsMatched: boolean;
    bscAllowlisted: boolean;
    ethRuleStillInactive: boolean;
    bscRuleStillInactive: boolean;
    ethProxyVersion: string;
    bscProxyVersion: string;
    broadcasterNonce: string;
    proposerDcBalance: string;
    proposerAllowance: string;
  };
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
const executorAbi = parseAbi([
  "function owner() view returns (address)",
  "function allowedTargets(address) view returns (bool)",
  "function setAllowedTarget(address,bool)",
]);
const probeAbi = parseAbi([
  "function controller() view returns (address)",
  "function version() view returns (uint256)",
]);
const broadcasterAbi = parseAbi([
  "function broadcastNonce() view returns (uint256)",
]);

loadEnv();

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

function privateKey(primary: string, fallback: string): Hex {
  const raw = process.env[primary]?.trim() || process.env[fallback]?.trim();
  if (!raw) throw new Error(`Missing ${primary} and fallback ${fallback}`);
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

function sameAddress(a: unknown, b: Address): boolean {
  return String(a).toLowerCase() === b.toLowerCase();
}

function sameHex(a: unknown, b: Hex): boolean {
  return String(a).toLowerCase() === b.toLowerCase();
}

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function save(state: Stage2State) {
  state.updatedAt = new Date().toISOString();
  writeFileSync(OUTPUT_FILE, `${stringify(state)}\n`, "utf8");
}

async function nonceState(client: any, address: Address) {
  const [latest, pending] = await Promise.all([
    client.getTransactionCount({ address, blockTag: "latest" }),
    client.getTransactionCount({ address, blockTag: "pending" }),
  ]);
  return { latest: Number(latest), pending: Number(pending) };
}

async function assertCode(client: any, label: string, address: Address) {
  const code = await client.getCode({ address });
  if (!code || code === "0x") throw new Error(`${label} has no code at ${address}`);
}

async function waitAndVerify(
  client: any,
  hash: Hex,
  expectedFrom: Address,
  expectedTo: Address,
  expectedInput: Hex,
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
    nonce: tx.nonce,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    verified: true,
  };
}

async function findDuplicateProposal(
  client: any,
  governance: Address,
  registry: Address,
  setRulesData: Hex,
  count: bigint,
): Promise<bigint | undefined> {
  for (let proposalId = 1n; proposalId <= count; proposalId += 1n) {
    const [targets, values, calldatas] = await client.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "getActions",
      args: [proposalId],
    });
    if (
      targets.length === 1 &&
      values.length === 1 &&
      calldatas.length === 1 &&
      sameAddress(targets[0], registry) &&
      values[0] === 0n &&
      sameHex(calldatas[0], setRulesData)
    ) {
      return proposalId;
    }
  }
  return undefined;
}

async function main() {
  const preflightOnly = process.argv.includes("--preflight");
  const writeEnabled =
    process.env.CROSS_CHAIN_V2_UPGRADE_PROBE_STAGE2_CONFIRM === WRITE_CONFIRM;
  if (!preflightOnly && !writeEnabled) {
    throw new Error(
      `Write gate closed: set CROSS_CHAIN_V2_UPGRADE_PROBE_STAGE2_CONFIRM=${WRITE_CONFIRM}`,
    );
  }

  const ethDeployment = loadJson<CanonicalDeployment>(
    "deployments/eth-mainnet-1.json",
  );
  const bscDeployment = loadJson<CanonicalDeployment>(
    "deployments/bsc-mainnet-56.json",
  );
  const probeDeployment = loadJson<ProbeDeployment>(
    "deployments/cross-chain-v2-upgrade-probe-stage1.json",
  );
  const ccipStage1 = loadJson<CcipStage1>(
    "deployments/ccip-v2-mainnet-stage1.json",
  );
  if (
    ethDeployment.chainId !== 1 ||
    bscDeployment.chainId !== 56 ||
    probeDeployment.stage !== "both_deployed" ||
    !ccipStage1.eth.verified ||
    !ccipStage1.bsc.verified
  ) {
    throw new Error("Canonical deployment records are not ready for Stage 2");
  }

  const governance = getAddress(ethDeployment.addresses.dealGovernance);
  const registry = getAddress(ethDeployment.addresses.governancePolicyRegistry);
  const dc = getAddress(ethDeployment.addresses.dlToken);
  const broadcaster = getAddress(ccipStage1.eth.address);
  const executor = getAddress(ccipStage1.bsc.address);
  const ethProxy = getAddress(probeDeployment.eth.proxy.address);
  const bscProxy = getAddress(probeDeployment.bsc.proxy.address);
  const ethSignerExpected = getAddress(ethDeployment.deployer);
  const bscSignerExpected = getAddress(bscDeployment.deployer);
  const ethAccount = privateKeyToAccount(
    privateKey("ETH_MAINNET_PRIVATE_KEY", "AGIKING_PRIVATE_KEY"),
  );
  const bscAccount = privateKeyToAccount(
    privateKey("BSC_MAINNET_PRIVATE_KEY", "AGIKING_PRIVATE_KEY"),
  );
  if (
    !sameAddress(ethAccount.address, ethSignerExpected) ||
    !sameAddress(bscAccount.address, bscSignerExpected) ||
    !sameAddress(probeDeployment.signers.eth, ethAccount.address) ||
    !sameAddress(probeDeployment.signers.bsc, bscAccount.address)
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
    transport: http(ethRpc),
  });
  const bscClient = createPublicClient({
    chain: bsc,
    transport: http(bscRpc),
  });
  const ethWallet = createWalletClient({
    account: ethAccount,
    chain: mainnet,
    transport: http(ethRpc),
  });
  const bscWallet = createWalletClient({
    account: bscAccount,
    chain: bsc,
    transport: http(bscRpc),
  });

  for (const [label, client, address] of [
    ["Governance", ethClient, governance],
    ["Registry", ethClient, registry],
    ["DC", ethClient, dc],
    ["Broadcaster V2", ethClient, broadcaster],
    ["ETH Probe", ethClient, ethProxy],
    ["Executor V2", bscClient, executor],
    ["BSC Probe", bscClient, bscProxy],
  ] as const) {
    await assertCode(client, label, address);
  }

  const rules = [
    {
      kind: MAJOR,
      target: ethProxy,
      selector: UPGRADE_SELECTOR,
      allowed: true,
      validateNestedBroadcast: false,
      nestedOnly: false,
      maxValue: 0n,
    },
    {
      kind: MAJOR,
      target: bscProxy,
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
  const createProposalData = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [[registry], [0n], [setRulesData], DESCRIPTION, MAJOR],
  });
  const allowlistData = encodeFunctionData({
    abi: executorAbi,
    functionName: "setAllowedTarget",
    args: [bscProxy, true],
  });

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
    chainDc,
    treasury,
    chainRegistry,
    registryGovernance,
    majorFee,
    proposalCount,
    canMint,
    paused,
    totalSupply,
    proposerBalance,
    proposerAllowance,
    treasuryBalance,
    executorOwner,
    bscAllowlisted,
    ethController,
    bscController,
    ethVersion,
    bscVersion,
    ethRule,
    bscRule,
    setRulesPolicy,
    actionAllowed,
    broadcastNonce,
  ] = await Promise.all([
    ethClient.getChainId(),
    bscClient.getChainId(),
    nonceState(ethClient, ethAccount.address),
    nonceState(bscClient, bscAccount.address),
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
      args: [minterRole, ethAccount.address],
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
      args: [ethAccount.address],
    }),
    ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [ethAccount.address, governance],
    }),
    ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [
        await ethClient.readContract({
          address: governance,
          abi: governanceAbi,
          functionName: "treasury",
        }),
      ],
    }),
    bscClient.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "owner",
    }),
    bscClient.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "allowedTargets",
      args: [bscProxy],
    }),
    ethClient.readContract({
      address: ethProxy,
      abi: probeAbi,
      functionName: "controller",
    }),
    bscClient.readContract({
      address: bscProxy,
      abi: probeAbi,
      functionName: "controller",
    }),
    ethClient.readContract({
      address: ethProxy,
      abi: probeAbi,
      functionName: "version",
    }),
    bscClient.readContract({
      address: bscProxy,
      abi: probeAbi,
      functionName: "version",
    }),
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, ethProxy, UPGRADE_SELECTOR],
    }),
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, bscProxy, UPGRADE_SELECTOR],
    }),
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, registry, SET_RULES_SELECTOR],
    }),
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "isActionAllowed",
      args: [MAJOR, registry, 0n, setRulesData],
    }),
    ethClient.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "broadcastNonce",
    }),
  ]);

  if (ethChainId !== 1 || bscChainId !== 56) {
    throw new Error(`RPC chain mismatch: ${ethChainId}/${bscChainId}`);
  }
  if (
    !sameAddress(chainDc, dc) ||
    !sameAddress(chainRegistry, registry) ||
    !sameAddress(registryGovernance, governance) ||
    !sameAddress(executorOwner, bscAccount.address) ||
    !sameAddress(ethController, governance) ||
    !sameAddress(bscController, executor)
  ) {
    throw new Error("Governance/Registry/Executor/Probe wiring mismatch");
  }
  if (
    majorFee !== EXPECTED_MAJOR_FEE ||
    !canMint ||
    paused ||
    ethVersion !== 1n ||
    bscVersion !== 1n
  ) {
    throw new Error("Fee/minter/token/probe state mismatch");
  }
  if (
    !setRulesPolicy[0] ||
    setRulesPolicy[1] ||
    setRulesPolicy[2] ||
    setRulesPolicy[3] !== 0n ||
    !actionAllowed
  ) {
    throw new Error("Major Registry.setRules policy is not exact");
  }
  if (ethRule[0] || bscRule[0]) {
    throw new Error("Probe upgrade policy is already active");
  }

  const duplicate = await findDuplicateProposal(
    ethClient,
    governance,
    registry,
    setRulesData,
    proposalCount,
  );
  if (duplicate !== undefined) {
    throw new Error(`Duplicate Probe policy proposal already exists: ${duplicate}`);
  }

  const hasExistingState = existsSync(OUTPUT_FILE);
  let state: Stage2State | undefined = hasExistingState
    ? (JSON.parse(readFileSync(OUTPUT_FILE, "utf8")) as Stage2State)
    : undefined;
  if (state) {
    if (
      state.scope !== SCOPE ||
      !sameAddress(state.proposer, ethAccount.address) ||
      !sameAddress(state.ethProxy, ethProxy) ||
      !sameAddress(state.bscProxy, bscProxy) ||
      !sameHex(state.setRulesCalldata, setRulesData) ||
      state.description !== DESCRIPTION
    ) {
      throw new Error("Existing Stage 2 state mismatch");
    }
  }

  console.log(
    stringify({
      preflightOnly,
      ethBlock: await ethClient.getBlockNumber(),
      bscBlock: await bscClient.getBlockNumber(),
      title: TITLE,
      body: BODY,
      description: DESCRIPTION,
      proposalCount,
      expectedProposalId: proposalCount + 1n,
      majorFeeDc: formatEther(majorFee),
      ethNonce,
      bscNonce,
      proposerBalanceDc: formatEther(proposerBalance),
      proposerAllowanceDc: formatEther(proposerAllowance),
      treasury,
      treasuryBalanceDc: formatEther(treasuryBalance),
      totalSupplyDc: formatEther(totalSupply),
      bscAllowlisted,
      ethRuleAllowed: ethRule[0],
      bscRuleAllowed: bscRule[0],
      broadcasterNonce: broadcastNonce,
      setRulesData,
      createProposalData,
    }),
  );

  if (preflightOnly) {
    if (
      hasExistingState ||
      bscAllowlisted ||
      proposerBalance !== 0n ||
      proposerAllowance !== 0n ||
      ethNonce.latest !== ethNonce.pending ||
      bscNonce.latest !== bscNonce.pending
    ) {
      throw new Error("Clean Stage 2 preflight invariants not satisfied");
    }
    await Promise.all([
      bscClient.simulateContract({
        account: bscAccount.address,
        address: executor,
        abi: executorAbi,
        functionName: "setAllowedTarget",
        args: [bscProxy, true],
      }),
      ethClient.simulateContract({
        account: ethAccount.address,
        address: dc,
        abi: tokenAbi,
        functionName: "mint",
        args: [ethAccount.address, majorFee],
      }),
    ]);
    console.log("Stage 2 preflight passed. No transaction was signed or sent.");
    return;
  }

  if (!state) {
    if (
      bscAllowlisted ||
      proposerBalance !== 0n ||
      proposerAllowance !== 0n ||
      ethNonce.latest !== ethNonce.pending ||
      bscNonce.latest !== bscNonce.pending
    ) {
      throw new Error("Clean Stage 2 write invariants not satisfied");
    }
    state = {
      schemaVersion: 1,
      scope: SCOPE,
      stage: "prepared",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      description: DESCRIPTION,
      proposer: ethAccount.address,
      governance,
      registry,
      dc,
      treasury: getAddress(treasury),
      executor,
      ethProxy,
      bscProxy,
      majorFee: majorFee.toString(),
      proposalCountBefore: proposalCount.toString(),
      setRulesCalldata: setRulesData,
      createProposalCalldata: createProposalData,
      actions: {},
    };
    save(state);
  }

  if (!state.actions.bscAllowlist) {
    const nonce = await nonceState(bscClient, bscAccount.address);
    if (nonce.latest !== nonce.pending) throw new Error("BSC pending nonce");
    const hash = await bscWallet.writeContract({
      account: bscAccount,
      address: executor,
      abi: executorAbi,
      functionName: "setAllowedTarget",
      args: [bscProxy, true],
      nonce: nonce.pending,
    });
    state.actions.bscAllowlist = await waitAndVerify(
      bscClient,
      hash,
      bscAccount.address,
      executor,
      allowlistData,
    );
    state.stage = "bsc_allowlisted";
    save(state);
  }
  if (
    !(await bscClient.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "allowedTargets",
      args: [bscProxy],
    }))
  ) {
    throw new Error("BSC Probe allowlist write did not persist");
  }

  if (!state.actions.mintFee) {
    const [balanceBeforeMint, allowanceBeforeMint] = await Promise.all([
      ethClient.readContract({
        address: dc,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [ethAccount.address],
      }),
      ethClient.readContract({
        address: dc,
        abi: tokenAbi,
        functionName: "allowance",
        args: [ethAccount.address, governance],
      }),
    ]);
    if (balanceBeforeMint !== 0n || allowanceBeforeMint !== 0n) {
      throw new Error("Expected zero DC balance/allowance before exact mint");
    }
    const mintData = encodeFunctionData({
      abi: tokenAbi,
      functionName: "mint",
      args: [ethAccount.address, majorFee],
    });
    const nonce = await nonceState(ethClient, ethAccount.address);
    if (nonce.latest !== nonce.pending) throw new Error("ETH pending nonce");
    const hash = await ethWallet.writeContract({
      account: ethAccount,
      address: dc,
      abi: tokenAbi,
      functionName: "mint",
      args: [ethAccount.address, majorFee],
      nonce: nonce.pending,
    });
    state.actions.mintFee = await waitAndVerify(
      ethClient,
      hash,
      ethAccount.address,
      dc,
      mintData,
    );
    state.stage = "fee_minted";
    save(state);
  }

  if (!state.actions.approveFee) {
    const [balanceBeforeApprove, allowanceBeforeApprove] = await Promise.all([
      ethClient.readContract({
        address: dc,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [ethAccount.address],
      }),
      ethClient.readContract({
        address: dc,
        abi: tokenAbi,
        functionName: "allowance",
        args: [ethAccount.address, governance],
      }),
    ]);
    if (balanceBeforeApprove !== majorFee || allowanceBeforeApprove !== 0n) {
      throw new Error("Exact post-mint balance/allowance mismatch");
    }
    const approveData = encodeFunctionData({
      abi: tokenAbi,
      functionName: "approve",
      args: [governance, majorFee],
    });
    const nonce = await nonceState(ethClient, ethAccount.address);
    if (nonce.latest !== nonce.pending) throw new Error("ETH pending nonce");
    const hash = await ethWallet.writeContract({
      account: ethAccount,
      address: dc,
      abi: tokenAbi,
      functionName: "approve",
      args: [governance, majorFee],
      nonce: nonce.pending,
    });
    state.actions.approveFee = await waitAndVerify(
      ethClient,
      hash,
      ethAccount.address,
      dc,
      approveData,
    );
    state.stage = "fee_approved";
    save(state);
  }

  if (!state.actions.createProposal) {
    const [countBeforeCreate, balanceBeforeCreate, allowanceBeforeCreate] =
      await Promise.all([
        ethClient.readContract({
          address: governance,
          abi: governanceAbi,
          functionName: "proposalCount",
        }),
        ethClient.readContract({
          address: dc,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [ethAccount.address],
        }),
        ethClient.readContract({
          address: dc,
          abi: tokenAbi,
          functionName: "allowance",
          args: [ethAccount.address, governance],
        }),
      ]);
    if (
      countBeforeCreate !== BigInt(state.proposalCountBefore) ||
      balanceBeforeCreate !== majorFee ||
      allowanceBeforeCreate !== majorFee
    ) {
      throw new Error("Proposal count or exact fee state changed before creation");
    }
    await ethClient.simulateContract({
      account: ethAccount.address,
      address: governance,
      abi: governanceAbi,
      functionName: "createProposal",
      args: [[registry], [0n], [setRulesData], DESCRIPTION, MAJOR],
    });
    const nonce = await nonceState(ethClient, ethAccount.address);
    if (nonce.latest !== nonce.pending) throw new Error("ETH pending nonce");
    const hash = await ethWallet.writeContract({
      account: ethAccount,
      address: governance,
      abi: governanceAbi,
      functionName: "createProposal",
      args: [[registry], [0n], [setRulesData], DESCRIPTION, MAJOR],
      nonce: nonce.pending,
    });
    state.actions.createProposal = await waitAndVerify(
      ethClient,
      hash,
      ethAccount.address,
      governance,
      createProposalData,
    );
    const countAfterCreate = await ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "proposalCount",
    });
    if (countAfterCreate !== countBeforeCreate + 1n) {
      throw new Error("Proposal count did not increment exactly once");
    }
    state.proposalId = countAfterCreate.toString();
    state.stage = "proposal_created";
    save(state);
  }

  if (!state.proposalId) throw new Error("Missing proposalId");
  const proposalId = BigInt(state.proposalId);
  const [
    proposal,
    proposalState,
    actions,
    finalBalance,
    finalAllowance,
    finalEthRule,
    finalBscRule,
    finalEthVersion,
    finalBscVersion,
    finalBroadcastNonce,
    finalAllowlisted,
  ] = await Promise.all([
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "getProposal",
      args: [proposalId],
    }),
    ethClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "state",
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
      functionName: "balanceOf",
      args: [ethAccount.address],
    }),
    ethClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [ethAccount.address, governance],
    }),
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, ethProxy, UPGRADE_SELECTOR],
    }),
    ethClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, bscProxy, UPGRADE_SELECTOR],
    }),
    ethClient.readContract({
      address: ethProxy,
      abi: probeAbi,
      functionName: "version",
    }),
    bscClient.readContract({
      address: bscProxy,
      abi: probeAbi,
      functionName: "version",
    }),
    ethClient.readContract({
      address: broadcaster,
      abi: broadcasterAbi,
      functionName: "broadcastNonce",
    }),
    bscClient.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "allowedTargets",
      args: [bscProxy],
    }),
  ]);
  const descriptionMatched = proposal.description === DESCRIPTION;
  const actionsMatched =
    actions[0].length === 1 &&
    actions[1].length === 1 &&
    actions[2].length === 1 &&
    sameAddress(actions[0][0], registry) &&
    actions[1][0] === 0n &&
    sameHex(actions[2][0], setRulesData);
  if (
    proposal.kind !== MAJOR ||
    proposal.totalStaked !== 0n ||
    proposal.executed ||
    proposalState !== PENDING ||
    !descriptionMatched ||
    !actionsMatched ||
    finalBalance !== 0n ||
    finalAllowance !== 0n ||
    finalEthRule[0] ||
    finalBscRule[0] ||
    finalEthVersion !== 1n ||
    finalBscVersion !== 1n ||
    finalBroadcastNonce !== broadcastNonce ||
    !finalAllowlisted
  ) {
    throw new Error("Stage 2 final verification failed");
  }

  state.verification = {
    proposalState: proposalState.toString(),
    totalStaked: proposal.totalStaked.toString(),
    descriptionMatched,
    actionsMatched,
    bscAllowlisted: finalAllowlisted,
    ethRuleStillInactive: !finalEthRule[0],
    bscRuleStillInactive: !finalBscRule[0],
    ethProxyVersion: finalEthVersion.toString(),
    bscProxyVersion: finalBscVersion.toString(),
    broadcasterNonce: finalBroadcastNonce.toString(),
    proposerDcBalance: finalBalance.toString(),
    proposerAllowance: finalAllowance.toString(),
  };
  save(state);
  console.log(stringify(state));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
