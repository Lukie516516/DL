/**
 * Creates only the ETH DAO Major proposal for Proposal.createdAt:
 *   1. mint exactly one current Major proposal fee;
 *   2. approve exactly that fee;
 *   3. create one Major proposal whose only action atomically upgrades the
 *      DealGovernance proxy and backfills all proposals that existed before it.
 *
 * There is deliberately no stake, execute, Reader deployment, Git commit or
 * Git push path in this script.
 *
 * Read-only preflight:
 *   node --import tsx/esm scripts/create-eth-dao-created-at-proposal.ts --preflight
 *
 * Explicit write gate:
 *   DAO_CREATED_AT_PROPOSAL_CONFIRM=CREATE_ETH_DAO_CREATED_AT_PROPOSAL_ONLY \
 *     node --import tsx/esm scripts/create-eth-dao-created-at-proposal.ts
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
import { mainnet } from "viem/chains";

import { collectProposalCreatedAtHistory } from "./lib/dao-created-at-history.js";

const ROOT = process.cwd();
const DEPLOYMENT_FILE = join(ROOT, "deployments", "eth-mainnet-1.json");
const IMPLEMENTATION_FILE = join(
  ROOT,
  "deployments",
  "dao-created-at",
  "eth-mainnet-implementation-20260727.json",
);
const OUTPUT_FILE = join(
  ROOT,
  "deployments",
  "dao-created-at",
  "eth-mainnet-created-at-proposal.json",
);
const WRITE_CONFIRM = "CREATE_ETH_DAO_CREATED_AT_PROPOSAL_ONLY";
const MAJOR = 2;
const PENDING = 1;
const EXPECTED_MAJOR_FEE = parseEther("1000");
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const UPGRADE_SELECTOR = toFunctionSelector("upgradeToAndCall(address,bytes)");
const TITLE = "DAO提案创建时间升级";
const BODY =
  "为DAO提案增加链上创建时间并回填现有记录，方便前端一次读取；不改变投票、质押、否决、执行、国库或跨链逻辑。";
const DESCRIPTION = `${TITLE}\n\n${BODY}`;
const SCOPE =
  "mint and approve exactly one Major fee, then create one Proposal.createdAt upgrade proposal; no stake, execute or Reader deployment";

type CanonicalDeployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
};

type ImplementationDeployment = {
  chainId: number;
  implementation: Address;
  verification: {
    governanceProxyImplementationAfterDeployment: Address;
    proxyUpgradePerformed: boolean;
  };
};

type TxRecord = {
  txHash: Hex;
  nonce: number;
  blockNumber: string;
  gasUsed: string;
  verified: boolean;
};

type ProposalStateRecord = {
  schemaVersion: 1;
  scope: string;
  stage: "prepared" | "fee_minted" | "fee_approved" | "proposal_created";
  startedAt: string;
  updatedAt: string;
  title: string;
  body: string;
  description: string;
  proposer: Address;
  governance: Address;
  registry: Address;
  dc: Address;
  treasury: Address;
  oldImplementation: Address;
  newImplementation: Address;
  majorFee: string;
  proposalCountBefore: string;
  historicalProposalIds: string[];
  historicalCreatedAts: number[];
  backfillCalldata: Hex;
  upgradeCalldata: Hex;
  createProposalCalldata: Hex;
  totalSupplyBefore: string;
  treasuryBalanceBefore: string;
  actions: {
    mintFee?: TxRecord;
    approveFee?: TxRecord;
    createProposal?: TxRecord;
  };
  proposalId?: string;
  verification?: {
    proposalState: string;
    totalStaked: string;
    executed: boolean;
    descriptionMatched: boolean;
    actionsMatched: boolean;
    proposerDcBalance: string;
    proposerAllowance: string;
    totalSupplyIncrease: string;
    treasuryBalanceIncrease: string;
    proxyImplementationUnchanged: boolean;
  };
};

type RuleView = readonly [boolean, boolean, boolean, bigint] & {
  allowed?: boolean;
  validateNestedBroadcast?: boolean;
  nestedOnly?: boolean;
  maxValue?: bigint;
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
  "function backfillProposalCreatedAt(uint256 firstProposalId,uint48[] createdAts)",
  "function upgradeToAndCall(address newImplementation,bytes data) payable",
  "function createProposal(address[],uint256[],bytes[],string,uint8) returns (uint256)",
]);
const registryAbi = parseAbi([
  "function governance() view returns (address)",
  "function getRule(uint8,address,bytes4) view returns (bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue)",
  "function isActionAllowed(uint8,address,uint256,bytes) view returns (bool)",
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
const implementationAbi = parseAbi([
  "function proxiableUUID() view returns (bytes32)",
]);

function loadEnv(): void {
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) process.env[match[1].trim()] ||= match[2].trim();
    }
  } catch {}
}

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
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

function ruleTuple(rule: RuleView): [boolean, boolean, boolean, bigint] {
  return [
    rule.allowed ?? rule[0],
    rule.validateNestedBroadcast ?? rule[1],
    rule.nestedOnly ?? rule[2],
    rule.maxValue ?? rule[3],
  ];
}

function save(state: ProposalStateRecord): void {
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
    receipt.status !== "success"
      || !sameAddress(tx.from, expectedFrom)
      || !tx.to
      || !sameAddress(tx.to, expectedTo)
      || !sameHex(tx.input, expectedInput)
      || tx.value !== 0n
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
  upgradeCalldata: Hex,
  count: bigint,
): Promise<bigint | undefined> {
  for (let id = 1n; id <= count; id += 1n) {
    const actions = await client.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "getActions",
      args: [id],
    });
    if (
      actions[0].length === 1
        && actions[1].length === 1
        && actions[2].length === 1
        && sameAddress(actions[0][0], governance)
        && actions[1][0] === 0n
        && sameHex(actions[2][0], upgradeCalldata)
    ) {
      return id;
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  loadEnv();
  const preflightOnly = process.argv.includes("--preflight");
  const writeEnabled =
    process.env.DAO_CREATED_AT_PROPOSAL_CONFIRM === WRITE_CONFIRM;
  if (!preflightOnly && !writeEnabled) {
    throw new Error(
      `Write gate closed: set DAO_CREATED_AT_PROPOSAL_CONFIRM=${WRITE_CONFIRM}`,
    );
  }

  const canonical = JSON.parse(
    readFileSync(DEPLOYMENT_FILE, "utf8"),
  ) as CanonicalDeployment;
  const implementationDeployment = JSON.parse(
    readFileSync(IMPLEMENTATION_FILE, "utf8"),
  ) as ImplementationDeployment;
  if (
    canonical.chainId !== 1
      || implementationDeployment.chainId !== 1
      || implementationDeployment.verification.proxyUpgradePerformed
  ) {
    throw new Error("Canonical implementation deployment record mismatch");
  }

  const rawKey =
    process.env.ETH_MAINNET_PRIVATE_KEY?.trim()
      || process.env.AGIKING_PRIVATE_KEY?.trim();
  const rpcUrl = process.env.ETH_MAINNET_RPC_URL?.trim();
  const writeRpcUrl =
    process.env.ETH_MAINNET_WRITE_RPC_URL?.trim() || rpcUrl;
  if (!rawKey || !rpcUrl) throw new Error("Missing ETH RPC or private key");
  const account = privateKeyToAccount(
    (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex,
  );

  const governance = getAddress(canonical.addresses.dealGovernance);
  const registry = getAddress(canonical.addresses.governancePolicyRegistry);
  const dc = getAddress(canonical.addresses.dlToken);
  const treasury = getAddress(canonical.addresses.protocolTreasury);
  const oldImplementation = getAddress(canonical.addresses.dealGovernanceImpl);
  const newImplementation = getAddress(implementationDeployment.implementation);
  if (!sameAddress(account.address, canonical.deployer)) {
    throw new Error("Configured signer does not match canonical deployer");
  }

  const client: any = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });
  const wallet: any = createWalletClient({
    account,
    chain: mainnet,
    transport: http(writeRpcUrl),
  });
  const history = await collectProposalCreatedAtHistory({
    publicClient: client,
    governance,
  });
  const historicalProposalIds = history.entries.map((entry) =>
    entry.proposalId.toString()
  );
  const historicalCreatedAts = history.entries.map((entry) => {
    const createdAt = Number(entry.createdAt);
    if (!Number.isSafeInteger(createdAt) || BigInt(createdAt) !== entry.createdAt) {
      throw new Error(`Proposal ${entry.proposalId} createdAt is not a safe uint48`);
    }
    return createdAt;
  });
  const backfillCalldata = encodeFunctionData({
    abi: governanceAbi,
    functionName: "backfillProposalCreatedAt",
    args: [1n, historicalCreatedAts],
  });
  const upgradeCalldata = encodeFunctionData({
    abi: governanceAbi,
    functionName: "upgradeToAndCall",
    args: [newImplementation, backfillCalldata],
  });
  const createProposalCalldata = encodeFunctionData({
    abi: governanceAbi,
    functionName: "createProposal",
    args: [[governance], [0n], [upgradeCalldata], DESCRIPTION, MAJOR],
  });

  const minterRole = await client.readContract({
    address: dc,
    abi: tokenAbi,
    functionName: "MINTER_ROLE",
  });
  const [
    chainId,
    blockNumber,
    nonces,
    chainDc,
    chainTreasury,
    chainRegistry,
    registryGovernance,
    majorFee,
    proposalCount,
    canMint,
    paused,
    proposerBalance,
    proposerAllowance,
    totalSupply,
    treasuryBalance,
    implementationCode,
    proxiableUuid,
    proxyImplementationWord,
    ruleRaw,
    actionAllowed,
  ] = await Promise.all([
    client.getChainId(),
    client.getBlockNumber(),
    nonceState(client, account.address),
    client.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "dcToken",
    }),
    client.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "treasury",
    }),
    client.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "policyRegistry",
    }),
    client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "governance",
    }),
    client.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "majorProposalFee",
    }),
    client.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "proposalCount",
    }),
    client.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "hasRole",
      args: [minterRole, account.address],
    }),
    client.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "paused",
    }),
    client.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    client.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [account.address, governance],
    }),
    client.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "totalSupply",
    }),
    client.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [treasury],
    }),
    client.getCode({ address: newImplementation }),
    client.readContract({
      address: newImplementation,
      abi: implementationAbi,
      functionName: "proxiableUUID",
    }),
    client.getStorageAt({
      address: governance,
      slot: IMPLEMENTATION_SLOT,
    }),
    client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getRule",
      args: [MAJOR, governance, UPGRADE_SELECTOR],
    }),
    client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "isActionAllowed",
      args: [MAJOR, governance, 0n, upgradeCalldata],
    }),
  ]);
  const rule = ruleTuple(ruleRaw as RuleView);

  if (
    chainId !== 1
      || !sameAddress(chainDc, dc)
      || !sameAddress(chainTreasury, treasury)
      || !sameAddress(chainRegistry, registry)
      || !sameAddress(registryGovernance, governance)
  ) {
    throw new Error("DAO/DC/Treasury/Registry wiring mismatch");
  }
  if (
    majorFee !== EXPECTED_MAJOR_FEE
      || !canMint
      || paused
      || !implementationCode
      || implementationCode === "0x"
      || proxiableUuid !== IMPLEMENTATION_SLOT
      || !sameAddress(slotAddress(proxyImplementationWord), oldImplementation)
  ) {
    throw new Error("Fee, token, implementation or proxy baseline mismatch");
  }
  if (
    !rule[0]
      || rule[1]
      || rule[2]
      || rule[3] !== 0n
      || !actionAllowed
  ) {
    throw new Error("Exact Major governance upgrade policy is not active");
  }
  if (
    proposalCount !== history.proposalCount
      || history.entries.length !== Number(proposalCount)
  ) {
    throw new Error("Proposal history coverage changed during preflight");
  }
  const duplicate = await findDuplicateProposal(
    client,
    governance,
    upgradeCalldata,
    proposalCount,
  );
  if (duplicate !== undefined) {
    throw new Error(`Duplicate createdAt upgrade proposal already exists: ${duplicate}`);
  }

  const hasExistingState = existsSync(OUTPUT_FILE);
  let state = hasExistingState
    ? JSON.parse(readFileSync(OUTPUT_FILE, "utf8")) as ProposalStateRecord
    : undefined;
  if (state) {
    if (
      state.scope !== SCOPE
        || state.description !== DESCRIPTION
        || !sameAddress(state.proposer, account.address)
        || !sameAddress(state.newImplementation, newImplementation)
        || !sameHex(state.backfillCalldata, backfillCalldata)
        || !sameHex(state.upgradeCalldata, upgradeCalldata)
        || !sameHex(state.createProposalCalldata, createProposalCalldata)
    ) {
      throw new Error("Existing createdAt proposal state record mismatch");
    }
  }

  console.log(stringify({
    mode: preflightOnly ? "read-only preflight" : "write",
    blockNumber,
    title: TITLE,
    body: BODY,
    proposer: account.address,
    nonce: nonces,
    governance,
    oldImplementation,
    newImplementation,
    proposalCount,
    expectedProposalId: proposalCount + 1n,
    historyCount: history.entries.length,
    historyFromProposalId: historicalProposalIds.at(0),
    historyThroughProposalId: historicalProposalIds.at(-1),
    majorFeeDc: formatEther(majorFee),
    proposerBalanceDc: formatEther(proposerBalance),
    proposerAllowanceDc: formatEther(proposerAllowance),
    exactPolicyAllowed: actionAllowed,
    backfillCalldata,
    upgradeCalldata,
    createProposalCalldata,
  }));

  if (preflightOnly) {
    if (
      hasExistingState
        || proposerBalance !== 0n
        || proposerAllowance !== 0n
        || nonces.latest !== nonces.pending
    ) {
      throw new Error("Clean createdAt proposal preflight invariants not satisfied");
    }
    await client.simulateContract({
      account: account.address,
      address: dc,
      abi: tokenAbi,
      functionName: "mint",
      args: [account.address, majorFee],
    });
    console.log("createdAt proposal preflight passed. No transaction was signed or sent.");
    return;
  }

  if (!state) {
    if (
      proposerBalance !== 0n
        || proposerAllowance !== 0n
        || nonces.latest !== nonces.pending
    ) {
      throw new Error("Clean createdAt proposal write invariants not satisfied");
    }
    state = {
      schemaVersion: 1,
      scope: SCOPE,
      stage: "prepared",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: TITLE,
      body: BODY,
      description: DESCRIPTION,
      proposer: account.address,
      governance,
      registry,
      dc,
      treasury,
      oldImplementation,
      newImplementation,
      majorFee: majorFee.toString(),
      proposalCountBefore: proposalCount.toString(),
      historicalProposalIds,
      historicalCreatedAts,
      backfillCalldata,
      upgradeCalldata,
      createProposalCalldata,
      totalSupplyBefore: totalSupply.toString(),
      treasuryBalanceBefore: treasuryBalance.toString(),
      actions: {},
    };
    save(state);
  }

  if (!state.actions.mintFee) {
    const mintData = encodeFunctionData({
      abi: tokenAbi,
      functionName: "mint",
      args: [account.address, majorFee],
    });
    const nonce = await nonceState(client, account.address);
    if (nonce.latest !== nonce.pending) throw new Error("ETH pending nonce before mint");
    const hash = await wallet.writeContract({
      account,
      address: dc,
      abi: tokenAbi,
      functionName: "mint",
      args: [account.address, majorFee],
      nonce: nonce.pending,
    });
    state.actions.mintFee = await waitAndVerify(
      client,
      hash,
      account.address,
      dc,
      mintData,
    );
    state.stage = "fee_minted";
    save(state);
  }

  if (!state.actions.approveFee) {
    const [balance, allowance] = await Promise.all([
      client.readContract({
        address: dc,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [account.address],
      }),
      client.readContract({
        address: dc,
        abi: tokenAbi,
        functionName: "allowance",
        args: [account.address, governance],
      }),
    ]);
    if (balance !== majorFee || allowance !== 0n) {
      throw new Error("Exact post-mint balance/allowance mismatch");
    }
    const approveData = encodeFunctionData({
      abi: tokenAbi,
      functionName: "approve",
      args: [governance, majorFee],
    });
    const nonce = await nonceState(client, account.address);
    if (nonce.latest !== nonce.pending) throw new Error("ETH pending nonce before approve");
    const hash = await wallet.writeContract({
      account,
      address: dc,
      abi: tokenAbi,
      functionName: "approve",
      args: [governance, majorFee],
      nonce: nonce.pending,
    });
    state.actions.approveFee = await waitAndVerify(
      client,
      hash,
      account.address,
      dc,
      approveData,
    );
    state.stage = "fee_approved";
    save(state);
  }

  if (!state.actions.createProposal) {
    const [count, balance, allowance, proxyWord, stillAllowed] =
      await Promise.all([
        client.readContract({
          address: governance,
          abi: governanceAbi,
          functionName: "proposalCount",
        }),
        client.readContract({
          address: dc,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [account.address],
        }),
        client.readContract({
          address: dc,
          abi: tokenAbi,
          functionName: "allowance",
          args: [account.address, governance],
        }),
        client.getStorageAt({
          address: governance,
          slot: IMPLEMENTATION_SLOT,
        }),
        client.readContract({
          address: registry,
          abi: registryAbi,
          functionName: "isActionAllowed",
          args: [MAJOR, governance, 0n, upgradeCalldata],
        }),
      ]);
    if (
      count !== BigInt(state.proposalCountBefore)
        || balance !== majorFee
        || allowance !== majorFee
        || !sameAddress(slotAddress(proxyWord), oldImplementation)
        || !stillAllowed
    ) {
      throw new Error("Proposal count, exact fee, proxy or policy changed");
    }
    await client.simulateContract({
      account: account.address,
      address: governance,
      abi: governanceAbi,
      functionName: "createProposal",
      args: [[governance], [0n], [upgradeCalldata], DESCRIPTION, MAJOR],
    });
    const nonce = await nonceState(client, account.address);
    if (nonce.latest !== nonce.pending) throw new Error("ETH pending nonce before proposal");
    const hash = await wallet.writeContract({
      account,
      address: governance,
      abi: governanceAbi,
      functionName: "createProposal",
      args: [[governance], [0n], [upgradeCalldata], DESCRIPTION, MAJOR],
      nonce: nonce.pending,
    });
    state.actions.createProposal = await waitAndVerify(
      client,
      hash,
      account.address,
      governance,
      createProposalCalldata,
    );
    const countAfter = await client.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "proposalCount",
    });
    if (countAfter !== count + 1n) {
      throw new Error("Proposal count did not increment exactly once");
    }
    state.proposalId = countAfter.toString();
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
    finalSupply,
    finalTreasuryBalance,
    finalProxyWord,
  ] = await Promise.all([
    client.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "getProposal",
      args: [proposalId],
    }),
    client.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "state",
      args: [proposalId],
    }),
    client.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "getActions",
      args: [proposalId],
    }),
    client.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    client.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [account.address, governance],
    }),
    client.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "totalSupply",
    }),
    client.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [treasury],
    }),
    client.getStorageAt({
      address: governance,
      slot: IMPLEMENTATION_SLOT,
    }),
  ]);
  const descriptionMatched = proposal.description === DESCRIPTION;
  const actionsMatched =
    actions[0].length === 1
      && actions[1].length === 1
      && actions[2].length === 1
      && sameAddress(actions[0][0], governance)
      && actions[1][0] === 0n
      && sameHex(actions[2][0], upgradeCalldata);
  const supplyIncrease = finalSupply - BigInt(state.totalSupplyBefore);
  const treasuryIncrease =
    finalTreasuryBalance - BigInt(state.treasuryBalanceBefore);
  const proxyImplementationUnchanged =
    sameAddress(slotAddress(finalProxyWord), oldImplementation);
  if (
    proposal.kind !== MAJOR
      || proposal.totalStaked !== 0n
      || proposal.executed
      || proposalState !== PENDING
      || !descriptionMatched
      || !actionsMatched
      || finalBalance !== 0n
      || finalAllowance !== 0n
      || supplyIncrease !== majorFee
      || treasuryIncrease !== majorFee
      || !proxyImplementationUnchanged
  ) {
    throw new Error("createdAt proposal final verification failed");
  }

  state.verification = {
    proposalState: proposalState.toString(),
    totalStaked: proposal.totalStaked.toString(),
    executed: proposal.executed,
    descriptionMatched,
    actionsMatched,
    proposerDcBalance: finalBalance.toString(),
    proposerAllowance: finalAllowance.toString(),
    totalSupplyIncrease: supplyIncrease.toString(),
    treasuryBalanceIncrease: treasuryIncrease.toString(),
    proxyImplementationUnchanged,
  };
  save(state);
  console.log(stringify(state));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
