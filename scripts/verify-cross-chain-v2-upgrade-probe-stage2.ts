/**
 * Independent read-only verification of upgrade-probe Stage 2.
 *
 * This script loads no private key and cannot send a transaction. It verifies:
 *   - the BSC Probe allowlist transaction;
 *   - the exact 1000 DC mint and approval transactions;
 *   - the exact Major proposal creation transaction and stored proposal data;
 *   - the proposal has no stake and has not executed;
 *   - both policy rules are still inactive and both proxies are still on V1.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { bsc, mainnet } from "viem/chains";

const ROOT = process.cwd();
const STATE_FILE = join(
  ROOT,
  "deployments",
  "cross-chain-v2-upgrade-probe-stage2.json",
);
const OUTPUT_FILE = join(
  ROOT,
  "deployments",
  "cross-chain-v2-upgrade-probe-stage2-verification.json",
);
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const MAJOR = 2;
const PENDING = 1;
const UPGRADE_SELECTOR = toFunctionSelector("upgradeToAndCall(address,bytes)");
const TITLE = "跨链升级功能测试授权";
const BODY =
  "这是一次无业务影响的跨链升级测试。本提案只给 ETH 和 BSC 上两个独立测试合约开放升级权限，不涉及代币、国库、分红或任何业务合约；本提案通过后也不会立即升级，真正执行测试还需要另一个提案。";
const DESCRIPTION = `${TITLE}\n\n${BODY}`;

type TxRecord = {
  txHash: Hex;
  nonce: number;
  blockNumber: string;
  gasUsed: string;
  verified: boolean;
};

type Stage2State = {
  stage: string;
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
  proposalId?: string;
  actions: {
    bscAllowlist?: TxRecord;
    mintFee?: TxRecord;
    approveFee?: TxRecord;
    createProposal?: TxRecord;
  };
};

type Stage1State = {
  eth: {
    controller: Address;
    v1Implementation: { address: Address };
    proxy: { address: Address };
    v2Implementation: { address: Address };
  };
  bsc: {
    controller: Address;
    v1Implementation: { address: Address };
    proxy: { address: Address };
    v2Implementation: { address: Address };
  };
};

type CanonicalDeployment = {
  deployer: Address;
};

type CcipStage1 = {
  eth: { address: Address };
  bsc: { address: Address };
};

const governanceAbi = parseAbi([
  "function proposalCount() view returns (uint256)",
  "function state(uint256) view returns (uint8)",
  "function getProposal(uint256) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description))",
  "function getActions(uint256) view returns (address[] targets,uint256[] values,bytes[] calldatas)",
  "function createProposal(address[],uint256[],bytes[],string,uint8) returns (uint256)",
]);
const registryAbi = parseAbi([
  "function getRule(uint8,address,bytes4) view returns (bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)",
]);
const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function mint(address,uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const executorAbi = parseAbi([
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

function slotAddress(word: Hex | undefined): Address {
  if (!word || word.length !== 66) throw new Error("Implementation slot missing");
  return getAddress(`0x${word.slice(-40)}`);
}

async function verifyTransaction(
  client: any,
  record: TxRecord | undefined,
  expectedFrom: Address,
  expectedTo: Address,
  expectedInput: Hex,
) {
  if (!record) throw new Error("Stage 2 transaction record missing");
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash: record.txHash }),
    client.getTransactionReceipt({ hash: record.txHash }),
  ]);
  if (
    receipt.status !== "success" ||
    !sameAddress(tx.from, expectedFrom) ||
    !tx.to ||
    !sameAddress(tx.to, expectedTo) ||
    !sameHex(tx.input, expectedInput) ||
    tx.value !== 0n ||
    tx.nonce !== record.nonce ||
    receipt.blockNumber.toString() !== record.blockNumber ||
    receipt.gasUsed.toString() !== record.gasUsed
  ) {
    throw new Error(`Transaction mismatch: ${record.txHash}`);
  }
  return {
    txHash: record.txHash,
    status: receipt.status,
    from: getAddress(tx.from),
    to: getAddress(tx.to),
    nonce: tx.nonce,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    calldataMatched: true,
    valueWei: tx.value,
  };
}

async function main() {
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Stage2State;
  const stage1 = loadJson<Stage1State>(
    "deployments/cross-chain-v2-upgrade-probe-stage1.json",
  );
  const ethDeployment = loadJson<CanonicalDeployment>(
    "deployments/eth-mainnet-1.json",
  );
  const bscDeployment = loadJson<CanonicalDeployment>(
    "deployments/bsc-mainnet-56.json",
  );
  const ccipStage1 = loadJson<CcipStage1>(
    "deployments/ccip-v2-mainnet-stage1.json",
  );
  if (
    state.stage !== "proposal_created" ||
    !state.proposalId ||
    state.description !== DESCRIPTION ||
    !sameAddress(state.ethProxy, stage1.eth.proxy.address) ||
    !sameAddress(state.bscProxy, stage1.bsc.proxy.address)
  ) {
    throw new Error("Stage 2 state record is incomplete or inconsistent");
  }

  const ethClient: any = createPublicClient({
    chain: mainnet,
    transport: http(
      process.env.ETH_MAINNET_RPC_URL?.trim() ||
        "https://ethereum-rpc.publicnode.com",
    ),
  });
  const bscClient: any = createPublicClient({
    chain: bsc,
    transport: http(
      process.env.BSC_MAINNET_RPC_URL?.trim() ||
        "https://bsc-mainnet.public.blastapi.io",
    ),
  });
  const proposalId = BigInt(state.proposalId);
  const majorFee = BigInt(state.majorFee);

  const allowlistData = encodeFunctionData({
    abi: executorAbi,
    functionName: "setAllowedTarget",
    args: [state.bscProxy, true],
  });
  const mintData = encodeFunctionData({
    abi: tokenAbi,
    functionName: "mint",
    args: [state.proposer, majorFee],
  });
  const approveData = encodeFunctionData({
    abi: tokenAbi,
    functionName: "approve",
    args: [state.governance, majorFee],
  });
  const createProposalData = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [
      [state.registry],
      [0n],
      [state.setRulesCalldata],
      DESCRIPTION,
      MAJOR,
    ],
  });
  if (!sameHex(createProposalData, state.createProposalCalldata)) {
    throw new Error("Stored proposal calldata does not match reconstruction");
  }

  const [
    bscAllowlistTx,
    mintTx,
    approveTx,
    createProposalTx,
    ethBlock,
    bscBlock,
    proposalCount,
    proposal,
    proposalState,
    actions,
    proposerBalance,
    proposerAllowance,
    bscAllowlisted,
    ethRule,
    bscRule,
    ethImplementationWord,
    bscImplementationWord,
    ethController,
    bscController,
    ethVersion,
    bscVersion,
    ethV2Version,
    bscV2Version,
    broadcastNonce,
  ] = await Promise.all([
    verifyTransaction(
      bscClient,
      state.actions.bscAllowlist,
      getAddress(bscDeployment.deployer),
      state.executor,
      allowlistData,
    ),
    verifyTransaction(
      ethClient,
      state.actions.mintFee,
      getAddress(ethDeployment.deployer),
      state.dc,
      mintData,
    ),
    verifyTransaction(
      ethClient,
      state.actions.approveFee,
      getAddress(ethDeployment.deployer),
      state.dc,
      approveData,
    ),
    verifyTransaction(
      ethClient,
      state.actions.createProposal,
      getAddress(ethDeployment.deployer),
      state.governance,
      createProposalData,
    ),
    ethClient.getBlockNumber(),
    bscClient.getBlockNumber(),
    ethClient.readContract({
      address: state.governance,
      abi: governanceAbi,
      functionName: "proposalCount",
    }),
    ethClient.readContract({
      address: state.governance,
      abi: governanceAbi,
      functionName: "getProposal",
      args: [proposalId],
    }),
    ethClient.readContract({
      address: state.governance,
      abi: governanceAbi,
      functionName: "state",
      args: [proposalId],
    }),
    ethClient.readContract({
      address: state.governance,
      abi: governanceAbi,
      functionName: "getActions",
      args: [proposalId],
    }),
    ethClient.readContract({
      address: state.dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [state.proposer],
    }),
    ethClient.readContract({
      address: state.dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [state.proposer, state.governance],
    }),
    bscClient.readContract({
      address: state.executor,
      abi: executorAbi,
      functionName: "allowedTargets",
      args: [state.bscProxy],
    }),
    ethClient.readContract({
      address: state.registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, state.ethProxy, UPGRADE_SELECTOR],
    }),
    ethClient.readContract({
      address: state.registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, state.bscProxy, UPGRADE_SELECTOR],
    }),
    ethClient.getStorageAt({
      address: state.ethProxy,
      slot: IMPLEMENTATION_SLOT,
    }),
    bscClient.getStorageAt({
      address: state.bscProxy,
      slot: IMPLEMENTATION_SLOT,
    }),
    ethClient.readContract({
      address: state.ethProxy,
      abi: probeAbi,
      functionName: "controller",
    }),
    bscClient.readContract({
      address: state.bscProxy,
      abi: probeAbi,
      functionName: "controller",
    }),
    ethClient.readContract({
      address: state.ethProxy,
      abi: probeAbi,
      functionName: "version",
    }),
    bscClient.readContract({
      address: state.bscProxy,
      abi: probeAbi,
      functionName: "version",
    }),
    ethClient.readContract({
      address: stage1.eth.v2Implementation.address,
      abi: probeAbi,
      functionName: "version",
    }),
    bscClient.readContract({
      address: stage1.bsc.v2Implementation.address,
      abi: probeAbi,
      functionName: "version",
    }),
    ethClient.readContract({
      address: getAddress(ccipStage1.eth.address),
      abi: broadcasterAbi,
      functionName: "broadcastNonce",
    }),
  ]);

  const actionsMatched =
    actions[0].length === 1 &&
    actions[1].length === 1 &&
    actions[2].length === 1 &&
    sameAddress(actions[0][0], state.registry) &&
    actions[1][0] === 0n &&
    sameHex(actions[2][0], state.setRulesCalldata);
  const ethRuleInactive =
    !ethRule[0] && !ethRule[1] && !ethRule[2] && ethRule[3] === 0n;
  const bscRuleInactive =
    !bscRule[0] && !bscRule[1] && !bscRule[2] && bscRule[3] === 0n;
  if (
    proposalCount < proposalId ||
    !sameAddress(proposal.proposer, state.proposer) ||
    proposal.kind !== MAJOR ||
    proposal.totalStaked !== 0n ||
    proposal.vetoed ||
    proposal.canceled ||
    proposal.executed ||
    proposal.description !== DESCRIPTION ||
    proposalState !== PENDING ||
    !actionsMatched ||
    proposerBalance !== 0n ||
    proposerAllowance !== 0n ||
    !bscAllowlisted ||
    !ethRuleInactive ||
    !bscRuleInactive ||
    !sameAddress(slotAddress(ethImplementationWord), stage1.eth.v1Implementation.address) ||
    !sameAddress(slotAddress(bscImplementationWord), stage1.bsc.v1Implementation.address) ||
    !sameAddress(ethController, stage1.eth.controller) ||
    !sameAddress(bscController, stage1.bsc.controller) ||
    ethVersion !== 1n ||
    bscVersion !== 1n ||
    ethV2Version !== 2n ||
    bscV2Version !== 2n
  ) {
    throw new Error("Independent Stage 2 verification failed");
  }

  const output = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    readOnly: true,
    privateKeyLoaded: false,
    transactionSentByVerification: false,
    sourceDeployment: "deployments/cross-chain-v2-upgrade-probe-stage2.json",
    snapshot: {
      ethBlock,
      bscBlock,
      proposalCount,
      proposalId,
      proposalState,
      broadcastNonce,
    },
    leaderDisplay: {
      title: TITLE,
      body: BODY,
      exactDescriptionMatched: true,
    },
    transactions: {
      bscAllowlist: bscAllowlistTx,
      mintExactMajorFee: mintTx,
      approveExactMajorFee: approveTx,
      createProposal: createProposalTx,
    },
    proposal: {
      proposer: getAddress(proposal.proposer),
      kind: proposal.kind,
      totalStaked: proposal.totalStaked,
      vetoed: proposal.vetoed,
      canceled: proposal.canceled,
      executed: proposal.executed,
      description: proposal.description,
      actionsMatched,
    },
    scopeGuards: {
      bscProbeAllowlisted: bscAllowlisted,
      ethUpgradeRuleStillInactive: ethRuleInactive,
      bscUpgradeRuleStillInactive: bscRuleInactive,
      ethProxyImplementation: slotAddress(ethImplementationWord),
      bscProxyImplementation: slotAddress(bscImplementationWord),
      bothProxiesStillOnV1: ethVersion === 1n && bscVersion === 1n,
      bothV2ImplementationsReady: ethV2Version === 2n && bscV2Version === 2n,
      noStake: proposal.totalStaked === 0n,
      noExecution: !proposal.executed,
      noBroadcastByStage2: true,
      proposerDcBalance: proposerBalance,
      proposerDcAllowance: proposerAllowance,
    },
    result: {
      allFourReceiptsSuccessful: true,
      allFourTransactionTargetsAndCalldataMatched: true,
      exactMajorProposalStored: true,
      policiesNotYetActivated: true,
      proxyUpgradeNotPerformed: true,
      stage2ScopeRespected: true,
    },
  };
  const rendered = `${stringify(output)}\n`;
  writeFileSync(OUTPUT_FILE, rendered, "utf8");
  process.stdout.write(rendered);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
