/**
 * Independent, read-only verification for the BSC + Base Canary proposal.
 * Uses public RPC endpoints by default and never loads a private key.
 */
import { readFileSync } from "node:fs";

import {
  createPublicClient,
  encodeFunctionData,
  fallback,
  getAddress,
  http,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { base, bsc, mainnet } from "viem/chains";

const STATE_FILE = "deployments/base-cross-chain-v2-canary-proposal.json";
const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const GOVERNANCE = getAddress("0x9a41a9A85C16F590789C846Fb933fF8C715407F7");
const DC = getAddress("0x591625Be924B98ACcAb7e2c8aF698c858Aa2608D");
const TREASURY = getAddress("0x19CC1320DcF7e1396404599209D7c9a844A21b8a");
const BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const BSC_PROBE = getAddress("0xd31C6417aE0C267F8C5bd634B96dA7590E6E6aB3");
const BASE_PROBE = getAddress("0x61921eCb954FFaAf8cd3Fd2e71EeCB14B3eD529f");
const BSC_CHAIN_KEY = 30_102;
const BASE_CHAIN_KEY = 30_184;
const MAJOR = 2;
const FEE = parseEther("1000");
const FEE_BUDGET = parseEther("0.005");
const ZERO_MARKER = `0x${"00".repeat(32)}` as Hex;

const governanceAbi = parseAbi([
  "function proposalCount() view returns (uint256)",
  "function state(uint256) view returns (uint8)",
  "function getProposal(uint256) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description))",
  "function getActions(uint256) view returns (address[] targets,uint256[] values,bytes[] calldatas)",
  "function createProposal(address[],uint256[],bytes[],string,uint8) returns (uint256)",
]);
const tokenAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function mint(address,uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const broadcasterAbi = parseAbi([
  "function chains(uint32) view returns (uint32 lzDstEid,uint64 ccipDstChainSelector,address ccipReceiver,string axDstChain,string axDstAddress,uint256 axMinFee,bool active)",
  "function broadcastNonce() view returns (uint256)",
]);
const probeAbi = parseAbi([
  "function marker() view returns (bytes32)",
  "function updateCount() view returns (uint256)",
]);

type TxRecord = { hash: Hex };
type State = {
  stage: string;
  proposer: Address;
  governance: Address;
  broadcaster: Address;
  description: string;
  expectedProposalId: string;
  proposalCountBefore: string;
  totalSupplyBefore: string;
  treasuryBalanceBefore: string;
  broadcastNonceBefore: string;
  broadcastCalldata: Hex;
  createProposalCalldata: Hex;
  transactions: { mint: TxRecord; approve: TxRecord; createProposal: TxRecord };
};

function same(a: unknown, b: unknown) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}
function assertThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function stringify(value: unknown) {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

async function main() {
  const saved = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  assertThat(saved.stage === "proposal-created", "proposal state record is incomplete");
  assertThat(same(saved.proposer, OWNER) && same(saved.governance, GOVERNANCE), "saved authority mismatch");
  assertThat(same(saved.broadcaster, BROADCASTER), "saved Broadcaster mismatch");

  const eth = createPublicClient({
    chain: mainnet,
    transport: fallback([
      http(process.env.ETH_INDEPENDENT_RPC_URL || "https://ethereum-rpc.publicnode.com"),
      http("https://eth.llamarpc.com"),
    ], { rank: false }),
  });
  const bscClient = createPublicClient({
    chain: bsc,
    transport: fallback([
      http(process.env.BSC_INDEPENDENT_RPC_URL || "https://bsc-dataseed.binance.org"),
      http("https://bsc-rpc.publicnode.com"),
    ], { rank: false }),
  });
  const baseClient = createPublicClient({
    chain: base,
    transport: fallback([
      http(process.env.BASE_INDEPENDENT_RPC_URL || "https://mainnet.base.org"),
      http("https://base-rpc.publicnode.com"),
    ], { rank: false }),
  });
  assertThat(await eth.getChainId() === 1, "independent ETH RPC chain mismatch");
  assertThat(await bscClient.getChainId() === 56, "independent BSC RPC chain mismatch");
  assertThat(await baseClient.getChainId() === 8453, "independent Base RPC chain mismatch");

  const mintCalldata = encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [OWNER, FEE] });
  const approveCalldata = encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [GOVERNANCE, FEE] });
  const expectedTransactions = [
    [saved.transactions.mint.hash, DC, mintCalldata],
    [saved.transactions.approve.hash, DC, approveCalldata],
    [saved.transactions.createProposal.hash, GOVERNANCE, saved.createProposalCalldata],
  ] as const;
  const receiptResults = [];
  for (const [hash, target, input] of expectedTransactions) {
    const [receipt, transaction] = await Promise.all([
      eth.getTransactionReceipt({ hash }),
      eth.getTransaction({ hash }),
    ]);
    assertThat(receipt.status === "success", `failed receipt: ${hash}`);
    assertThat(same(transaction.from, OWNER) && transaction.to && same(transaction.to, target), `sender/target mismatch: ${hash}`);
    assertThat(transaction.value === 0n && same(transaction.input, input), `value/calldata mismatch: ${hash}`);
    receiptResults.push({ hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, verified: true });
  }

  const proposalId = BigInt(saved.expectedProposalId);
  const [count, proposalState, proposal, actions, ownerBalance, allowance, totalSupply,
    treasuryBalance, broadcastNonce, bscRoute, baseRoute, bscMarker, bscCount,
    baseMarker, baseCount] = await Promise.all([
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [proposalId] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [proposalId] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [proposalId] }),
    eth.readContract({ address: DC, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
    eth.readContract({ address: DC, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }),
    eth.readContract({ address: DC, abi: tokenAbi, functionName: "totalSupply" }),
    eth.readContract({ address: DC, abi: tokenAbi, functionName: "balanceOf", args: [TREASURY] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BSC_CHAIN_KEY] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "chains", args: [BASE_CHAIN_KEY] }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "marker" }),
    bscClient.readContract({ address: BSC_PROBE, abi: probeAbi, functionName: "updateCount" }),
    baseClient.readContract({ address: BASE_PROBE, abi: probeAbi, functionName: "marker" }),
    baseClient.readContract({ address: BASE_PROBE, abi: probeAbi, functionName: "updateCount" }),
  ]);

  assertThat(count === proposalId && proposalState === 1, "proposal 21 is not Pending");
  assertThat(same(proposal.proposer, OWNER) && proposal.kind === MAJOR, "proposal identity mismatch");
  assertThat(proposal.totalStaked === 0n && !proposal.executed, "proposal unexpectedly staked or executed");
  assertThat(proposal.description === saved.description, "description mismatch");
  assertThat(actions[0].length === 1 && same(actions[0][0], BROADCASTER), "proposal target mismatch");
  assertThat(actions[1].length === 1 && actions[1][0] === FEE_BUDGET, "proposal value mismatch");
  assertThat(actions[2].length === 1 && same(actions[2][0], saved.broadcastCalldata), "proposal calldata mismatch");
  assertThat(ownerBalance === 0n && allowance === 0n, "fee balance/allowance was not fully consumed");
  assertThat(totalSupply === BigInt(saved.totalSupplyBefore) + FEE, "total supply delta mismatch");
  assertThat(treasuryBalance === BigInt(saved.treasuryBalanceBefore) + FEE, "Treasury fee delta mismatch");
  assertThat(broadcastNonce === BigInt(saved.broadcastNonceBefore), "broadcast nonce changed");
  assertThat(bscRoute[6] && baseRoute[6], "route was deactivated");
  assertThat(bscMarker === ZERO_MARKER && bscCount === 0n, "BSC Probe changed before execution");
  assertThat(baseMarker === ZERO_MARKER && baseCount === 0n, "Base Probe changed before execution");

  console.log(stringify({
    status: "PASS",
    readOnly: true,
    independentRpcChains: { eth: 1, bsc: 56, base: 8453 },
    receipts: receiptResults,
    proposal: {
      id: proposalId,
      state: Number(proposalState),
      kind: Number(proposal.kind),
      totalStaked: proposal.totalStaked,
      executed: proposal.executed,
      description: proposal.description,
      target: actions[0][0],
      value: actions[1][0],
      calldataMatched: true,
    },
    accounting: { ownerBalance, allowance, treasuryFeeDelta: treasuryBalance - BigInt(saved.treasuryBalanceBefore) },
    noBroadcast: { broadcastNonce, bscProbeCount: bscCount, baseProbeCount: baseCount },
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
