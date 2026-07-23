/** Read-only verification for the completed CCIP V2 migration stage-3 proposal creation. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { network } from "hardhat";
import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

const FEE_FILE = "deployments/ccip-v2-mainnet-stage3-fee.json";
const STAGE3_FILE = "deployments/ccip-v2-mainnet-stage3.json";
const PARAMETER = 0;
const MAJOR = 2;
const PENDING = 1;
const BSC_CHAIN_KEY = 30102;

type FeeState = {
  stage: string;
  proposer: Address;
  governance: Address;
  dc: Address;
  amountWei: string;
  transaction: { hash: Hex; nonce: number };
  before: { totalSupplyWei: string };
  after: { totalSupplyWei: string };
};

type Stage3State = {
  stage: string;
  proposer: Address;
  governance: Address;
  registry: Address;
  dc: Address;
  treasury: Address;
  oldBroadcaster: Address;
  newBroadcaster: Address;
  oldExecutor: Address;
  newExecutor: Address;
  bscFactory: Address;
  description: string;
  setRulesCalldata: Hex;
  createProposalCalldata: Hex;
  majorFeeWei: string;
  approvalTx: Hex;
  approvalNonce: number;
  proposalTx: Hex;
  proposalNonce: number;
  proposalId: string;
};

const governanceAbi = parseAbi([
  "function proposalCount() view returns (uint256)",
  "function state(uint256) view returns (uint8)",
  "function getProposal(uint256) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description))",
  "function getActions(uint256) view returns (address[] targets,uint256[] values,bytes[] calldatas)",
]);

const tokenAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);

const registryAbi = parseAbi([
  "function getRule(uint8,address,bytes4) view returns ((bool allowed,bool validateNestedBroadcast,bool nestedOnly,uint256 maxValue))",
]);

const broadcasterAbi = parseAbi([
  "function chains(uint32) view returns (uint32,uint64,address,string,string,uint256,bool)",
]);

const bscFactoryAbi = parseAbi([
  "function crossChainGovernance() view returns (address)",
]);

function load<T>(file: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), file), "utf8")) as T;
}

function sameAddress(a: unknown, b: Address): boolean {
  return String(a).toLowerCase() === b.toLowerCase();
}

function sameHex(a: unknown, b: Hex): boolean {
  return String(a).toLowerCase() === b.toLowerCase();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertRule(label: string, actual: any, enabled: boolean): void {
  const expected = enabled
    ? [true, true, false, 10_000_000_000_000_000n]
    : [false, false, false, 0n];
  const values = [
    actual.allowed ?? actual[0],
    actual.validateNestedBroadcast ?? actual[1],
    actual.nestedOnly ?? actual[2],
    BigInt(actual.maxValue ?? actual[3]),
  ];
  assert(
    values.every((value, index) => value === expected[index]),
    `${label} mismatch: ${values.map(String).join("/")}`
  );
}

async function main() {
  const fee = load<FeeState>(FEE_FILE);
  const stage3 = load<Stage3State>(STAGE3_FILE);
  assert(fee.stage === "fee_funded", "Fee state is not complete");
  assert(stage3.stage === "proposal_created", "Stage 3 state is not complete");
  const proposer = getAddress(stage3.proposer);
  const governance = getAddress(stage3.governance);
  const registry = getAddress(stage3.registry);
  const dc = getAddress(stage3.dc);
  const treasury = getAddress(stage3.treasury);
  const oldBroadcaster = getAddress(stage3.oldBroadcaster);
  const newBroadcaster = getAddress(stage3.newBroadcaster);
  const oldExecutor = getAddress(stage3.oldExecutor);
  const bscFactory = getAddress(stage3.bscFactory);
  const proposalId = BigInt(stage3.proposalId);
  const majorFee = BigInt(stage3.majorFeeWei);
  assert(sameAddress(fee.proposer, proposer), "Fee proposer mismatch");
  assert(sameAddress(fee.governance, governance), "Fee governance mismatch");
  assert(sameAddress(fee.dc, dc), "Fee DC mismatch");
  assert(BigInt(fee.amountWei) === majorFee, "Fee amount mismatch");
  assert(
    BigInt(fee.after.totalSupplyWei) ===
      BigInt(fee.before.totalSupplyWei) + majorFee,
    "Saved supply delta mismatch"
  );

  const { viem } = await network.connect();
  const eth = await viem.getPublicClient();
  assert((await eth.getChainId()) === 1, "Wrong Ethereum chainId");
  const bscRpc =
    process.env.BSC_MAINNET_RPC_URL?.trim() ||
    "https://bsc-dataseed.binance.org";
  const bsc = createPublicClient({ transport: http(bscRpc) });
  assert((await bsc.getChainId()) === 56, "Wrong BSC chainId");

  const [mintReceipt, approvalReceipt, proposalReceipt] = await Promise.all([
    eth.getTransactionReceipt({ hash: fee.transaction.hash }),
    eth.getTransactionReceipt({ hash: stage3.approvalTx }),
    eth.getTransactionReceipt({ hash: stage3.proposalTx }),
  ]);
  assert(mintReceipt.status === "success", "Mint receipt failed");
  assert(approvalReceipt.status === "success", "Approval receipt failed");
  assert(proposalReceipt.status === "success", "Proposal receipt failed");
  const [mintTx, approvalTx, proposalTx] = await Promise.all([
    eth.getTransaction({ hash: fee.transaction.hash }),
    eth.getTransaction({ hash: stage3.approvalTx }),
    eth.getTransaction({ hash: stage3.proposalTx }),
  ]);
  assert(
    sameAddress(mintTx.from, proposer) && sameAddress(mintTx.to, dc),
    "Mint tx endpoints mismatch"
  );
  assert(
    sameAddress(approvalTx.from, proposer) && sameAddress(approvalTx.to, dc),
    "Approval tx endpoints mismatch"
  );
  assert(
    sameAddress(proposalTx.from, proposer) &&
      sameAddress(proposalTx.to, governance),
    "Proposal tx endpoints mismatch"
  );
  assert(mintTx.nonce === fee.transaction.nonce, "Mint nonce mismatch");
  assert(approvalTx.nonce === stage3.approvalNonce, "Approval nonce mismatch");
  assert(proposalTx.nonce === stage3.proposalNonce, "Proposal nonce mismatch");
  assert(
    sameHex(proposalTx.input, stage3.createProposalCalldata),
    "Proposal calldata mismatch"
  );

  const [
    proposalCount,
    proposalState,
    proposal,
    actions,
    supply,
    proposerDc,
    treasuryDc,
    allowance,
    nonceLatest,
    noncePending,
  ] = await Promise.all([
    eth.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "proposalCount",
    }),
    eth.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "state",
      args: [proposalId],
    }),
    eth.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "getProposal",
      args: [proposalId],
    }),
    eth.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "getActions",
      args: [proposalId],
    }),
    eth.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "totalSupply",
    }),
    eth.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [proposer],
    }),
    eth.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [treasury],
    }),
    eth.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [proposer, governance],
    }),
    eth.getTransactionCount({ address: proposer, blockTag: "latest" }),
    eth.getTransactionCount({ address: proposer, blockTag: "pending" }),
  ]);
  assert(
    proposalCount === proposalId,
    "proposalCount does not equal stage-3 proposalId"
  );
  assert(
    proposalState === PENDING,
    `Proposal state is ${proposalState}, not Pending`
  );
  assert(
    sameAddress(proposal.proposer, proposer),
    "Proposal proposer mismatch"
  );
  assert(proposal.kind === MAJOR, "Proposal kind is not Major");
  assert(
    proposal.totalStaked === 0n && proposal.windowEndsAt === 0n,
    "Proposal was activated or staked"
  );
  assert(
    !proposal.vetoed && !proposal.canceled && !proposal.executed,
    "Proposal unexpectedly ended"
  );
  assert(
    proposal.description === stage3.description,
    "Proposal description mismatch"
  );
  assert(
    actions[0].length === 1 && sameAddress(actions[0][0], registry),
    "Action target mismatch"
  );
  assert(
    actions[1].length === 1 && actions[1][0] === 0n,
    "Action value mismatch"
  );
  assert(
    actions[2].length === 1 && sameHex(actions[2][0], stage3.setRulesCalldata),
    "Action calldata mismatch"
  );
  assert(
    supply === BigInt(fee.after.totalSupplyWei),
    "Live DC total supply mismatch"
  );
  assert(
    proposerDc === 0n && allowance === 0n,
    "Proposal fee was not exactly consumed"
  );
  assert(treasuryDc >= majorFee, "Treasury did not receive proposal fee");
  assert(
    nonceLatest === noncePending && nonceLatest === stage3.proposalNonce + 1,
    "Signer nonce/pending mismatch"
  );

  const selector = "0xfd9c0ab9" as Hex;
  const [oldParameter, oldMajor, newParameter, newMajor, route, controller] =
    await Promise.all([
      eth.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "getRule",
        args: [PARAMETER, oldBroadcaster, selector],
      }),
      eth.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "getRule",
        args: [MAJOR, oldBroadcaster, selector],
      }),
      eth.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "getRule",
        args: [PARAMETER, newBroadcaster, selector],
      }),
      eth.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "getRule",
        args: [MAJOR, newBroadcaster, selector],
      }),
      eth.readContract({
        address: newBroadcaster,
        abi: broadcasterAbi,
        functionName: "chains",
        args: [BSC_CHAIN_KEY],
      }),
      bsc.readContract({
        address: bscFactory,
        abi: bscFactoryAbi,
        functionName: "crossChainGovernance",
      }),
    ]);
  assertRule("V1 Parameter", oldParameter, true);
  assertRule("V1 Major", oldMajor, true);
  assertRule("V2 Parameter", newParameter, false);
  assertRule("V2 Major", newMajor, false);
  assert(route[6] === false, "V2 route is active");
  assert(
    sameAddress(controller, oldExecutor),
    "BSC Factory no longer uses V1 Executor"
  );

  console.log("=== CCIP V2 stage 3 independent verification ===");
  console.log(
    `ETH block: ${await eth.getBlockNumber()} | BSC block: ${await bsc.getBlockNumber()}`
  );
  console.log(`Mint receipt: success ${fee.transaction.hash}`);
  console.log(`Approve receipt: success ${stage3.approvalTx}`);
  console.log(`Proposal receipt: success ${stage3.proposalTx}`);
  console.log(
    `Proposal #${proposalId}: Pending, Major, totalStaked=0, windowEndsAt=0, executed=false`
  );
  console.log(
    "Rules: V1 preserved; V2 still disabled until proposal execution"
  );
  console.log(
    "Cross-chain state: route inactive; BSC Factory still controlled by V1"
  );
  console.log("No transaction was signed or sent by this verifier.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
