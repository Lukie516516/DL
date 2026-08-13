/**
 * Independent read-only verification of the Stage 3 upgrade proposal.
 *
 * No private key is loaded and no transaction can be sent.
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
  "cross-chain-v2-upgrade-probe-stage3-proposal.json",
);
const OUTPUT_FILE = join(
  ROOT,
  "deployments",
  "cross-chain-v2-upgrade-probe-stage3-proposal-verification.json",
);
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const MAJOR = 2;
const PENDING = 1;
const BSC_CHAIN_KEY = 30102;
const LZ_GAS = 500_000n;
const UPGRADE_SELECTOR = toFunctionSelector("upgradeToAndCall(address,bytes)");
const TITLE = "跨链升级测试";
const BODY =
  "将 ETH 和 BSC 上两个无资产测试合约从 V1 升级到 V2，只验证 DAO 跨链升级流程，不影响任何业务。";
const DESCRIPTION = `${TITLE}\n\n${BODY}`;

type TxRecord = {
  txHash: Hex;
  nonce: number;
  blockNumber: string;
  gasUsed: string;
  verified: boolean;
};

type Stage3State = {
  stage: string;
  description: string;
  proposer: Address;
  governance: Address;
  registry: Address;
  dc: Address;
  broadcaster: Address;
  executor: Address;
  ethProxy: Address;
  ethV2Implementation: Address;
  bscProxy: Address;
  bscV2Implementation: Address;
  majorFee: string;
  bridgeFeeBudget: string;
  broadcastNonceBefore: string;
  ethUpgradeCalldata: Hex;
  bscUpgradeCalldata: Hex;
  broadcastCalldata: Hex;
  createProposalCalldata: Hex;
  proposalId?: string;
  actions: {
    mintFee?: TxRecord;
    approveFee?: TxRecord;
    createProposal?: TxRecord;
  };
};

type Stage1State = {
  eth: {
    controller: Address;
    v1Implementation: { address: Address };
  };
  bsc: {
    controller: Address;
    v1Implementation: { address: Address };
  };
};

type CanonicalDeployment = {
  deployer: Address;
};

const governanceAbi = parseAbi([
  "function proposalCount() view returns (uint256)",
  "function state(uint256) view returns (uint8)",
  "function getProposal(uint256) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description))",
  "function getActions(uint256) view returns (address[] targets,uint256[] values,bytes[] calldatas)",
  "function createProposal(address[],uint256[],bytes[],string,uint8) returns (uint256)",
]);
const registryAbi = parseAbi([
  "function isActionAllowed(uint8,address,uint256,bytes) view returns (bool)",
  "function getRule(uint8,address,bytes4) view returns (bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)",
]);
const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function mint(address,uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const broadcasterAbi = parseAbi([
  "function broadcastNonce() view returns (uint256)",
  "function quoteFees(uint32[],address[],bytes,uint128) view returns (uint256)",
  "function broadcast(uint32[],address[],bytes,uint128) payable",
]);
const executorAbi = parseAbi([
  "function allowedTargets(address) view returns (bool)",
]);
const probeAbi = parseAbi([
  "function controller() view returns (address)",
  "function version() view returns (uint256)",
  "function upgradeToAndCall(address,bytes) payable",
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

function slotAddress(word: Hex | undefined): Address {
  if (!word || word.length !== 66) throw new Error("Implementation slot missing");
  return getAddress(`0x${word.slice(-40)}`);
}

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

async function verifyTransaction(
  client: any,
  record: TxRecord | undefined,
  from: Address,
  to: Address,
  input: Hex,
) {
  if (!record) throw new Error("Stage 3 transaction record missing");
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash: record.txHash }),
    client.getTransactionReceipt({ hash: record.txHash }),
  ]);
  if (
    receipt.status !== "success" ||
    !sameAddress(tx.from, from) ||
    !tx.to ||
    !sameAddress(tx.to, to) ||
    !sameHex(tx.input, input) ||
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
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Stage3State;
  const stage1 = loadJson<Stage1State>(
    "deployments/cross-chain-v2-upgrade-probe-stage1.json",
  );
  const ethDeployment = loadJson<CanonicalDeployment>(
    "deployments/eth-mainnet-1.json",
  );
  if (
    state.stage !== "proposal_created" ||
    !state.proposalId ||
    state.description !== DESCRIPTION
  ) {
    throw new Error("Stage 3 state record is incomplete");
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
  const feeBudget = BigInt(state.bridgeFeeBudget);

  const ethUpgradeData = encodeFunctionData({
    abi: probeAbi,
    functionName: "upgradeToAndCall",
    args: [state.ethV2Implementation, "0x"],
  });
  const bscUpgradeData = encodeFunctionData({
    abi: probeAbi,
    functionName: "upgradeToAndCall",
    args: [state.bscV2Implementation, "0x"],
  });
  const broadcastData = encodeFunctionData({
    abi: broadcasterAbi,
    functionName: "broadcast",
    args: [[BSC_CHAIN_KEY], [state.bscProxy], bscUpgradeData, LZ_GAS],
  });
  const createProposalData = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [
      [state.ethProxy, state.broadcaster],
      [0n, feeBudget],
      [ethUpgradeData, broadcastData],
      DESCRIPTION,
      MAJOR,
    ],
  });
  if (
    !sameHex(ethUpgradeData, state.ethUpgradeCalldata) ||
    !sameHex(bscUpgradeData, state.bscUpgradeCalldata) ||
    !sameHex(broadcastData, state.broadcastCalldata) ||
    !sameHex(createProposalData, state.createProposalCalldata)
  ) {
    throw new Error("Stage 3 calldata reconstruction mismatch");
  }

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
  const [
    mintTx,
    approveTx,
    createTx,
    ethBlock,
    bscBlock,
    proposalCount,
    proposal,
    proposalState,
    actions,
    balance,
    allowance,
    ethAllowed,
    broadcastAllowed,
    liveQuote,
    broadcastNonce,
    bscAllowlisted,
    ethImplementationWord,
    bscImplementationWord,
    ethController,
    bscController,
    ethVersion,
    bscVersion,
    ethV2Version,
    bscV2Version,
  ] = await Promise.all([
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
    ethClient.readContract({
      address: state.registry,
      abi: registryAbi,
      functionName: "isActionAllowed",
      args: [MAJOR, state.ethProxy, 0n, ethUpgradeData],
    }),
    ethClient.readContract({
      address: state.registry,
      abi: registryAbi,
      functionName: "isActionAllowed",
      args: [MAJOR, state.broadcaster, feeBudget, broadcastData],
    }),
    ethClient.readContract({
      address: state.broadcaster,
      abi: broadcasterAbi,
      functionName: "quoteFees",
      args: [[BSC_CHAIN_KEY], [state.bscProxy], bscUpgradeData, LZ_GAS],
    }),
    ethClient.readContract({
      address: state.broadcaster,
      abi: broadcasterAbi,
      functionName: "broadcastNonce",
    }),
    bscClient.readContract({
      address: state.executor,
      abi: executorAbi,
      functionName: "allowedTargets",
      args: [state.bscProxy],
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
      address: state.ethV2Implementation,
      abi: probeAbi,
      functionName: "version",
    }),
    bscClient.readContract({
      address: state.bscV2Implementation,
      abi: probeAbi,
      functionName: "version",
    }),
  ]);

  const actionsMatched =
    actions[0].length === 2 &&
    actions[1].length === 2 &&
    actions[2].length === 2 &&
    sameAddress(actions[0][0], state.ethProxy) &&
    sameAddress(actions[0][1], state.broadcaster) &&
    actions[1][0] === 0n &&
    actions[1][1] === feeBudget &&
    sameHex(actions[2][0], ethUpgradeData) &&
    sameHex(actions[2][1], broadcastData);
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
    balance !== 0n ||
    allowance !== 0n ||
    !ethAllowed ||
    !broadcastAllowed ||
    liveQuote > feeBudget ||
    broadcastNonce !== BigInt(state.broadcastNonceBefore) ||
    !bscAllowlisted ||
    !sameAddress(slotAddress(ethImplementationWord), stage1.eth.v1Implementation.address) ||
    !sameAddress(slotAddress(bscImplementationWord), stage1.bsc.v1Implementation.address) ||
    !sameAddress(ethController, stage1.eth.controller) ||
    !sameAddress(bscController, stage1.bsc.controller) ||
    ethVersion !== 1n ||
    bscVersion !== 1n ||
    ethV2Version !== 2n ||
    bscV2Version !== 2n
  ) {
    throw new Error("Independent Stage 3 verification failed");
  }

  const output = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    readOnly: true,
    privateKeyLoaded: false,
    transactionSentByVerification: false,
    sourceDeployment:
      "deployments/cross-chain-v2-upgrade-probe-stage3-proposal.json",
    snapshot: {
      ethBlock,
      bscBlock,
      proposalCount,
      proposalId,
      proposalState,
      liveBridgeQuoteWei: liveQuote,
      bridgeFeeBudgetWei: feeBudget,
      broadcastNonce,
    },
    leaderDisplay: {
      title: TITLE,
      body: BODY,
      exactDescriptionMatched: true,
    },
    transactions: {
      mintExactMajorFee: mintTx,
      approveExactMajorFee: approveTx,
      createProposal: createTx,
    },
    proposal: {
      proposer: getAddress(proposal.proposer),
      kind: proposal.kind,
      totalStaked: proposal.totalStaked,
      executed: proposal.executed,
      actionsMatched,
    },
    scopeGuards: {
      bothActionsCurrentlyAllowed: ethAllowed && broadcastAllowed,
      bscProbeAllowlisted: bscAllowlisted,
      bothProxiesStillOnV1: ethVersion === 1n && bscVersion === 1n,
      bothV2ImplementationsReady: ethV2Version === 2n && bscV2Version === 2n,
      noStake: proposal.totalStaked === 0n,
      noExecution: !proposal.executed,
      noBroadcast: broadcastNonce === BigInt(state.broadcastNonceBefore),
      proposerDcBalance: balance,
      proposerDcAllowance: allowance,
    },
    result: {
      allThreeReceiptsSuccessful: true,
      allThreeTargetsAndCalldataMatched: true,
      exactTwoActionMajorProposalStored: true,
      quoteWithinStoredBudget: true,
      proxyUpgradeNotPerformed: true,
      stage3ScopeRespected: true,
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
