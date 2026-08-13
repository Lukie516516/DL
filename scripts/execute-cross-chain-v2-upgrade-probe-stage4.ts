/**
 * Executes only the already-succeeded asset-free Probe proposal #17.
 *
 * No stake, mint, approve, proposal creation, retry, owner write, Git commit,
 * or Git push path exists in this script.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, mainnet } from "viem/chains";

const ROOT = process.cwd();
const OUTPUT_FILE = join(
  ROOT,
  "deployments",
  "cross-chain-v2-upgrade-probe-stage4-execution.json",
);
const WRITE_CONFIRM = "EXECUTE_PROPOSAL_17_ONLY";
const PROPOSAL_ID = 17n;
const SUCCEEDED = 3;
const EXECUTED = 6;
const EXECUTION_VALUE = parseEther("0.002");
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

type CanonicalDeployment = {
  deployer: Address;
};
type Stage1 = {
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
type Stage3 = {
  stage: string;
  proposalId?: string;
  proposer: Address;
  governance: Address;
  broadcaster: Address;
  executor: Address;
  ethProxy: Address;
  ethV2Implementation: Address;
  bscProxy: Address;
  bscV2Implementation: Address;
  bridgeFeeBudget: string;
  broadcastNonceBefore: string;
  ethUpgradeCalldata: Hex;
  bscUpgradeCalldata: Hex;
  broadcastCalldata: Hex;
};

const governanceAbi = parseAbi([
  "function state(uint256) view returns (uint8)",
  "function getProposal(uint256) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description))",
  "function getActions(uint256) view returns (address[] targets,uint256[] values,bytes[] calldatas)",
  "function execute(uint256) payable",
  "event ProposalExecuted(uint256 indexed proposalId)",
]);
const broadcasterAbi = parseAbi([
  "function broadcastNonce() view returns (uint256)",
  "function quoteFees(uint32[],address[],bytes,uint128) view returns (uint256)",
  "event Broadcast(uint256 indexed nonce,uint32[] targetChainIds,address[] targets,bytes data)",
  "event BroadcastToChain(uint256 indexed nonce,uint32 indexed chainId,address indexed target,bytes32 lzGuid,bytes32 ccipMessageId)",
]);
const probeAbi = parseAbi([
  "function controller() view returns (address)",
  "function marker() view returns (bytes32)",
  "function updateCount() view returns (uint256)",
  "function version() view returns (uint256)",
]);
const executorAbi = parseAbi([
  "function confirmStatus(bytes32) view returns (bool lzConfirmed,bool ccipConfirmed,bool axConfirmed,uint256 count,bool isExecuted)",
  "function executionAttempts(bytes32) view returns (uint256)",
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

async function main() {
  const preflightOnly = process.argv.includes("--preflight");
  const writeEnabled =
    process.env.CROSS_CHAIN_V2_UPGRADE_PROBE_STAGE4_CONFIRM === WRITE_CONFIRM;
  if (!preflightOnly && !writeEnabled) {
    throw new Error(
      `Write gate closed: set CROSS_CHAIN_V2_UPGRADE_PROBE_STAGE4_CONFIRM=${WRITE_CONFIRM}`,
    );
  }

  const canonical = loadJson<CanonicalDeployment>(
    "deployments/eth-mainnet-1.json",
  );
  const stage1 = loadJson<Stage1>(
    "deployments/cross-chain-v2-upgrade-probe-stage1.json",
  );
  const stage3 = loadJson<Stage3>(
    "deployments/cross-chain-v2-upgrade-probe-stage3-proposal.json",
  );
  if (
    stage3.stage !== "proposal_created" ||
    stage3.proposalId !== PROPOSAL_ID.toString() ||
    BigInt(stage3.bridgeFeeBudget) !== EXECUTION_VALUE
  ) {
    throw new Error("Stage 3 proposal record mismatch");
  }

  const raw =
    process.env.ETH_MAINNET_PRIVATE_KEY?.trim() ||
    process.env.AGIKING_PRIVATE_KEY?.trim();
  if (!raw) throw new Error("Missing ETH execution private key");
  const account = privateKeyToAccount(
    (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex,
  );
  if (
    !sameAddress(account.address, canonical.deployer) ||
    !sameAddress(account.address, stage3.proposer)
  ) {
    throw new Error("Configured execution wallet does not match records");
  }

  const ethRpc =
    process.env.ETH_MAINNET_RPC_URL?.trim() ||
    "https://ethereum-rpc.publicnode.com";
  const bscRpc =
    process.env.BSC_MAINNET_RPC_URL?.trim() ||
    "https://bsc-mainnet.public.blastapi.io";
  const ethClient: any = createPublicClient({
    chain: mainnet,
    transport: http(ethRpc),
  });
  const bscClient: any = createPublicClient({
    chain: bsc,
    transport: http(bscRpc),
  });
  const wallet: any = createWalletClient({
    account,
    chain: mainnet,
    transport: http(ethRpc),
  });

  const executeData = encodeFunctionData({
    abi: governanceAbi,
    functionName: "execute",
    args: [PROPOSAL_ID],
  });
  const [
    ethBlock,
    bscBlock,
    proposalState,
    proposal,
    actions,
    walletBalance,
    latestNonce,
    pendingNonce,
    liveQuote,
    broadcastNonceBefore,
    ethVersionBefore,
    bscVersionBefore,
    ethControllerBefore,
    bscControllerBefore,
    ethMarkerBefore,
    bscMarkerBefore,
    ethUpdateCountBefore,
    bscUpdateCountBefore,
    ethImplementationBefore,
    bscImplementationBefore,
  ] = await Promise.all([
    ethClient.getBlockNumber(),
    bscClient.getBlockNumber(),
    ethClient.readContract({
      address: stage3.governance,
      abi: governanceAbi,
      functionName: "state",
      args: [PROPOSAL_ID],
    }),
    ethClient.readContract({
      address: stage3.governance,
      abi: governanceAbi,
      functionName: "getProposal",
      args: [PROPOSAL_ID],
    }),
    ethClient.readContract({
      address: stage3.governance,
      abi: governanceAbi,
      functionName: "getActions",
      args: [PROPOSAL_ID],
    }),
    ethClient.getBalance({ address: account.address }),
    ethClient.getTransactionCount({
      address: account.address,
      blockTag: "latest",
    }),
    ethClient.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    }),
    ethClient.readContract({
      address: stage3.broadcaster,
      abi: broadcasterAbi,
      functionName: "quoteFees",
      args: [[30102], [stage3.bscProxy], stage3.bscUpgradeCalldata, 500_000n],
    }),
    ethClient.readContract({
      address: stage3.broadcaster,
      abi: broadcasterAbi,
      functionName: "broadcastNonce",
    }),
    ethClient.readContract({
      address: stage3.ethProxy,
      abi: probeAbi,
      functionName: "version",
    }),
    bscClient.readContract({
      address: stage3.bscProxy,
      abi: probeAbi,
      functionName: "version",
    }),
    ethClient.readContract({
      address: stage3.ethProxy,
      abi: probeAbi,
      functionName: "controller",
    }),
    bscClient.readContract({
      address: stage3.bscProxy,
      abi: probeAbi,
      functionName: "controller",
    }),
    ethClient.readContract({
      address: stage3.ethProxy,
      abi: probeAbi,
      functionName: "marker",
    }),
    bscClient.readContract({
      address: stage3.bscProxy,
      abi: probeAbi,
      functionName: "marker",
    }),
    ethClient.readContract({
      address: stage3.ethProxy,
      abi: probeAbi,
      functionName: "updateCount",
    }),
    bscClient.readContract({
      address: stage3.bscProxy,
      abi: probeAbi,
      functionName: "updateCount",
    }),
    ethClient.getStorageAt({
      address: stage3.ethProxy,
      slot: IMPLEMENTATION_SLOT,
    }),
    bscClient.getStorageAt({
      address: stage3.bscProxy,
      slot: IMPLEMENTATION_SLOT,
    }),
  ]);

  const actionsExact =
    actions[0].length === 2 &&
    actions[1].length === 2 &&
    actions[2].length === 2 &&
    sameAddress(actions[0][0], stage3.ethProxy) &&
    sameAddress(actions[0][1], stage3.broadcaster) &&
    actions[1][0] === 0n &&
    actions[1][1] === EXECUTION_VALUE &&
    sameHex(actions[2][0], stage3.ethUpgradeCalldata) &&
    sameHex(actions[2][1], stage3.broadcastCalldata);
  if (
    proposalState !== SUCCEEDED ||
    proposal.totalStaked < parseEther("70") ||
    proposal.executed ||
    !actionsExact ||
    walletBalance <= EXECUTION_VALUE ||
    latestNonce !== pendingNonce ||
    liveQuote > EXECUTION_VALUE ||
    broadcastNonceBefore !== BigInt(stage3.broadcastNonceBefore) ||
    ethVersionBefore !== 1n ||
    bscVersionBefore !== 1n ||
    !sameAddress(ethControllerBefore, stage1.eth.controller) ||
    !sameAddress(bscControllerBefore, stage1.bsc.controller) ||
    !sameAddress(slotAddress(ethImplementationBefore), stage1.eth.v1Implementation.address) ||
    !sameAddress(slotAddress(bscImplementationBefore), stage1.bsc.v1Implementation.address)
  ) {
    throw new Error("Stage 4 preflight state mismatch");
  }

  await ethClient.simulateContract({
    account: account.address,
    address: stage3.governance,
    abi: governanceAbi,
    functionName: "execute",
    args: [PROPOSAL_ID],
    value: EXECUTION_VALUE,
  });
  const estimatedGas = await ethClient.estimateContractGas({
    account: account.address,
    address: stage3.governance,
    abi: governanceAbi,
    functionName: "execute",
    args: [PROPOSAL_ID],
    value: EXECUTION_VALUE,
  });
  const preflight = {
    preflightOnly,
    ethBlock,
    bscBlock,
    proposalId: PROPOSAL_ID,
    proposalState,
    totalStakedD: formatEther(proposal.totalStaked),
    executionWallet: account.address,
    walletBalanceEth: formatEther(walletBalance),
    executionValueEth: formatEther(EXECUTION_VALUE),
    liveQuoteEth: formatEther(liveQuote),
    estimatedGas,
    latestNonce,
    pendingNonce,
    actionsExact,
    ethVersionBefore,
    bscVersionBefore,
    broadcastNonceBefore,
    simulationPassed: true,
  };
  console.log(stringify(preflight));
  if (preflightOnly) return;

  const hash = await wallet.writeContract({
    account,
    address: stage3.governance,
    abi: governanceAbi,
    functionName: "execute",
    args: [PROPOSAL_ID],
    value: EXECUTION_VALUE,
    nonce: pendingNonce,
  });
  const receipt = await ethClient.waitForTransactionReceipt({
    hash,
    confirmations: 2,
    timeout: 300_000,
  });
  const tx = await ethClient.getTransaction({ hash });
  if (
    receipt.status !== "success" ||
    !sameAddress(tx.from, account.address) ||
    !tx.to ||
    !sameAddress(tx.to, stage3.governance) ||
    !sameHex(tx.input, executeData) ||
    tx.value !== EXECUTION_VALUE
  ) {
    throw new Error(`Execution transaction mismatch: ${hash}`);
  }

  const proposalExecutedTopic = toEventSelector("ProposalExecuted(uint256)");
  const broadcastTopic = toEventSelector(
    "Broadcast(uint256,uint32[],address[],bytes)",
  );
  const upgradedTopic = toEventSelector("Upgraded(address)");
  const proposalExecutedLog = receipt.logs.find(
    (log: any) =>
      sameAddress(log.address, stage3.governance) &&
      log.topics[0] === proposalExecutedTopic,
  );
  const broadcastLog = receipt.logs.find(
    (log: any) =>
      sameAddress(log.address, stage3.broadcaster) &&
      log.topics[0] === broadcastTopic,
  );
  const upgradedLog = receipt.logs.find(
    (log: any) =>
      sameAddress(log.address, stage3.ethProxy) &&
      log.topics[0] === upgradedTopic,
  );
  if (!proposalExecutedLog || !broadcastLog || !upgradedLog) {
    throw new Error("Expected execute/broadcast/upgrade event missing");
  }
  const decodedBroadcast: any = decodeEventLog({
    abi: broadcasterAbi,
    data: broadcastLog.data,
    topics: broadcastLog.topics,
  });
  const expectedBroadcastNonce = broadcastNonceBefore + 1n;
  if (
    decodedBroadcast.eventName !== "Broadcast" ||
    decodedBroadcast.args.nonce !== expectedBroadcastNonce ||
    decodedBroadcast.args.targetChainIds.length !== 1 ||
    decodedBroadcast.args.targetChainIds[0] !== 30102 ||
    decodedBroadcast.args.targets.length !== 1 ||
    !sameAddress(decodedBroadcast.args.targets[0], stage3.bscProxy) ||
    !sameHex(decodedBroadcast.args.data, stage3.bscUpgradeCalldata)
  ) {
    throw new Error("Broadcast event payload mismatch");
  }

  const payloadHash = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
      [expectedBroadcastNonce, stage3.bscProxy, stage3.bscUpgradeCalldata],
    ),
  );
  const [
    finalProposalState,
    finalProposal,
    ethVersionAfter,
    bscVersionAfter,
    ethControllerAfter,
    ethMarkerAfter,
    ethUpdateCountAfter,
    ethImplementationAfter,
    broadcastNonceAfter,
    confirmStatus,
    executionAttempts,
  ] = await Promise.all([
    ethClient.readContract({
      address: stage3.governance,
      abi: governanceAbi,
      functionName: "state",
      args: [PROPOSAL_ID],
    }),
    ethClient.readContract({
      address: stage3.governance,
      abi: governanceAbi,
      functionName: "getProposal",
      args: [PROPOSAL_ID],
    }),
    ethClient.readContract({
      address: stage3.ethProxy,
      abi: probeAbi,
      functionName: "version",
    }),
    bscClient.readContract({
      address: stage3.bscProxy,
      abi: probeAbi,
      functionName: "version",
    }),
    ethClient.readContract({
      address: stage3.ethProxy,
      abi: probeAbi,
      functionName: "controller",
    }),
    ethClient.readContract({
      address: stage3.ethProxy,
      abi: probeAbi,
      functionName: "marker",
    }),
    ethClient.readContract({
      address: stage3.ethProxy,
      abi: probeAbi,
      functionName: "updateCount",
    }),
    ethClient.getStorageAt({
      address: stage3.ethProxy,
      slot: IMPLEMENTATION_SLOT,
    }),
    ethClient.readContract({
      address: stage3.broadcaster,
      abi: broadcasterAbi,
      functionName: "broadcastNonce",
    }),
    bscClient.readContract({
      address: stage3.executor,
      abi: executorAbi,
      functionName: "confirmStatus",
      args: [payloadHash],
    }),
    bscClient.readContract({
      address: stage3.executor,
      abi: executorAbi,
      functionName: "executionAttempts",
      args: [payloadHash],
    }),
  ]);
  if (
    finalProposalState !== EXECUTED ||
    !finalProposal.executed ||
    ethVersionAfter !== 2n ||
    !sameAddress(slotAddress(ethImplementationAfter), stage3.ethV2Implementation) ||
    !sameAddress(ethControllerAfter, ethControllerBefore) ||
    ethMarkerAfter !== ethMarkerBefore ||
    ethUpdateCountAfter !== ethUpdateCountBefore ||
    broadcastNonceAfter !== expectedBroadcastNonce
  ) {
    throw new Error("Immediate ETH execution verification failed");
  }

  const output = {
    schemaVersion: 1,
    executedAt: new Date().toISOString(),
    scope: "execute proposal 17 only",
    preflight,
    transaction: {
      txHash: hash,
      nonce: tx.nonce,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      nativeCostWei:
        BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) +
        EXECUTION_VALUE,
      valueWei: tx.value,
      calldataMatched: true,
      receiptStatus: receipt.status,
    },
    events: {
      proposalExecuted: true,
      ethProxyUpgraded: true,
      broadcastDecodedAndMatched: true,
      broadcastNonce: expectedBroadcastNonce,
    },
    payload: {
      nonce: expectedBroadcastNonce,
      target: stage3.bscProxy,
      data: stage3.bscUpgradeCalldata,
      msgHash: payloadHash,
    },
    immediateVerification: {
      proposalState: finalProposalState,
      proposalExecuted: finalProposal.executed,
      ethProxyVersion: ethVersionAfter,
      ethProxyImplementation: slotAddress(ethImplementationAfter),
      ethControllerPreserved: sameAddress(ethControllerAfter, ethControllerBefore),
      ethMarkerPreserved: ethMarkerAfter === ethMarkerBefore,
      ethUpdateCountPreserved: ethUpdateCountAfter === ethUpdateCountBefore,
      broadcasterNonce: broadcastNonceAfter,
      bscProxyVersion: bscVersionAfter,
      bscMarkerBefore,
      bscUpdateCountBefore,
      bscConfirmStatus: confirmStatus,
      bscExecutionAttempts: executionAttempts,
    },
  };
  writeFileSync(OUTPUT_FILE, `${stringify(output)}\n`, "utf8");
  process.stdout.write(`${stringify(output)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
