/** Create only the 104 -> 105 DC BSC+Base resonance proposal; never stake, execute or broadcast. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, parseAbi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, bsc, mainnet } from "viem/chains";
import {
  ACTION_FEE_BUDGET, BASE_EXECUTOR, BASE_FACTORY, BROADCASTER, BSC_EXECUTOR, BSC_FACTORY,
  CANARY_DESCRIPTION, CANARY_MESSAGE_FEE, CHAIN_FEE_CONFIGS, CURRENT_MESSAGE_FEE, GOVERNANCE,
  LZ_GAS, MAJOR, MAJOR_PROPOSAL_FEE, OWNER, REGISTRY, RESTORE_DESCRIPTION, broadcasterAbi, buildMessageFeeActions,
  buildMessageFeeProposalCalldata, executorAbi, factoryAbi, governanceAbi, registryAbi,
} from "./lib/cross-chain-message-fee-canary.js";

const POLICY_ID = 24n;
const EXECUTED = 6;
const RESTORE = process.argv.includes("--restore");
const TARGET_PRICE = RESTORE ? CURRENT_MESSAGE_FEE : CANARY_MESSAGE_FEE;
const SOURCE_PRICE = RESTORE ? CANARY_MESSAGE_FEE : CURRENT_MESSAGE_FEE;
const DESCRIPTION = RESTORE ? RESTORE_DESCRIPTION : CANARY_DESCRIPTION;
const CONFIRM = RESTORE ? "MINT_APPROVE_CREATE_EXACT_MESSAGE_FEE_RESTORE" : "MINT_APPROVE_CREATE_EXACT_MESSAGE_FEE_CANARY";
const POLICY_FILE = "deployments/cross-chain-message-fee-policy-execution.json";
const CANARY_FINAL_FILE = "deployments/cross-chain-message-fee-canary-final-verification.json";
const STATE_FILE = RESTORE
  ? "deployments/cross-chain-message-fee-restore-proposal.json"
  : "deployments/cross-chain-message-fee-canary-proposal.json";
const tokenAbi = parseAbi([
  "function MINTER_ROLE() view returns (bytes32)", "function hasRole(bytes32,address) view returns (bool)",
  "function paused() view returns (bool)", "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)",
  "function mint(address,uint256)", "function approve(address,uint256) returns (bool)",
]);
type TxRecord = { hash: Hex; nonce: number; blockNumber: string; gasUsed: string; verified: true };
type State = {
  schemaVersion: 1; stage: "started" | "fee-minted" | "fee-approved" | "proposal-created";
  startedAt: string; updatedAt: string; proposalCountBefore: string; expectedProposalId: string;
  dc: Address; treasury: Address; totalSupplyBefore: string; treasuryBalanceBefore: string;
  broadcastNonceBefore: string; liveQuoteBefore: string; broadcastCalldata: Hex; createProposalCalldata: Hex;
  transactions: { mint?: TxRecord; approve?: TxRecord; createProposal?: TxRecord }; verification?: Record<string, unknown>;
};
function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/); if (match && !process.env[match[1].trim()]) process.env[match[1].trim()] = match[2].trim();
  }
}
function key(): Hex {
  const raw = process.env.ETH_MAINNET_PRIVATE_KEY?.trim() || process.env.AGIKING_PRIVATE_KEY?.trim();
  if (!raw) throw new Error("Missing ETH_MAINNET_PRIVATE_KEY or AGIKING_PRIVATE_KEY");
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}
function same(a: unknown, b: unknown) { return String(a).toLowerCase() === String(b).toLowerCase(); }
function assertThat(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function stringify(value: unknown) { return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2); }
function save(state: State) { state.updatedAt = new Date().toISOString(); writeFileSync(STATE_FILE, `${stringify(state)}\n`, "utf8"); }
async function waitExact(client: any, hash: Hex, target: Address, calldata: Hex): Promise<TxRecord> {
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 300_000 });
  const tx = await client.getTransaction({ hash });
  assertThat(receipt.status === "success" && same(tx.from, OWNER) && tx.to && same(tx.to, target), `receipt/endpoints mismatch: ${hash}`);
  assertThat(tx.value === 0n && same(tx.input, calldata), `calldata/value mismatch: ${hash}`);
  return { hash, nonce: tx.nonce, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), verified: true };
}
async function findDuplicate(client: any, count: bigint, calldata: Hex) {
  const reads = Array.from({ length: Number(count) }, (_, index) => {
    const id = BigInt(index + 1);
    return client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [id] }).then((actions: any) => ({ id, actions }));
  });
  for (const { id, actions } of await Promise.all(reads)) {
    if (actions[0].length === 1 && same(actions[0][0], BROADCASTER) && actions[1][0] === ACTION_FEE_BUDGET && same(actions[2][0], calldata)) return id;
  }
  return undefined;
}

async function main() {
  loadEnv();
  const mode = process.argv[2] || "preflight";
  assertThat(mode === "preflight" || mode === "execute", "mode must be preflight or execute");
  assertThat(existsSync(POLICY_FILE), "verified #24 execution record missing");
  const policyRecord = JSON.parse(readFileSync(POLICY_FILE, "utf8"));
  assertThat(policyRecord.stage === "executed" && BigInt(policyRecord.proposalId) === POLICY_ID && policyRecord.verification.fiveRulesExact, "#24 execution record mismatch");
  if (RESTORE) {
    assertThat(existsSync(CANARY_FINAL_FILE), "verified 105 DC canary final record missing");
    const final = JSON.parse(readFileSync(CANARY_FINAL_FILE, "utf8"));
    assertThat(final.stage === "destinations-executed" && final.healthy === true && BigInt(final.targetPrice) === CANARY_MESSAGE_FEE, "105 DC canary final record mismatch");
  }
  let existing: State | undefined;
  if (existsSync(STATE_FILE)) {
    existing = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    if (existing.stage === "proposal-created") { console.log(stringify({ status: "PASS_ALREADY_CREATED", stateFile: STATE_FILE, ...existing.verification })); return; }
  }
  const ethRpc = process.env.ETH_MAINNET_RPC_URL?.trim() || "https://eth-mainnet.public.blastapi.io";
  const bscRpc = process.env.BSC_MAINNET_RPC_URL?.trim() || "https://bsc-mainnet.public.blastapi.io";
  const baseRpc = process.env.BASE_MAINNET_RPC_URL?.trim() || "https://base-mainnet.public.blastapi.io";
  const eth: any = createPublicClient({ chain: mainnet, transport: http(ethRpc, { timeout: 30_000 }) });
  const bscClient: any = createPublicClient({ chain: bsc, transport: http(bscRpc, { timeout: 30_000 }) });
  const baseClient: any = createPublicClient({ chain: base, transport: http(baseRpc, { timeout: 30_000 }) });
  assertThat(await eth.getChainId() === 1 && await bscClient.getChainId() === 56 && await baseClient.getChainId() === 8453, "RPC chain mismatch");
  const action = buildMessageFeeActions(TARGET_PRICE)[0];
  const createProposalCalldata = buildMessageFeeProposalCalldata(TARGET_PRICE, DESCRIPTION);
  const dc = getAddress(await eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "dcToken" }));
  const treasury = getAddress(await eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "treasury" }));
  const minterRole = await eth.readContract({ address: dc, abi: tokenAbi, functionName: "MINTER_ROLE" });
  const [policyState, policy, count, fee, canMint, paused, balance, allowance, supply, treasuryBalance,
    actionAllowed, broadcastNonce, quote, governanceEth, latestNonce, pendingNonce,
    bscPrice, basePrice, bscAllowed, baseAllowed, bscThreshold, baseThreshold] = await Promise.all([
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [POLICY_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [POLICY_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "majorProposalFee" }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "hasRole", args: [minterRole, OWNER] }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "paused" }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
    eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isActionAllowed", args: [MAJOR, BROADCASTER, ACTION_FEE_BUDGET, action.calldata] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "quoteFees", args: [CHAIN_FEE_CONFIGS.map(x => x.chainKey), CHAIN_FEE_CONFIGS.map(x => x.factory), action.innerCalldata, LZ_GAS] }),
    eth.getBalance({ address: GOVERNANCE }), eth.getTransactionCount({ address: OWNER, blockTag: "latest" }), eth.getTransactionCount({ address: OWNER, blockTag: "pending" }),
    bscClient.readContract({ address: BSC_FACTORY, abi: factoryAbi, functionName: "msgPriceAmountInToken" }),
    baseClient.readContract({ address: BASE_FACTORY, abi: factoryAbi, functionName: "msgPriceAmountInToken" }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BSC_FACTORY] }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BASE_FACTORY] }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
    baseClient.readContract({ address: BASE_EXECUTOR, abi: executorAbi, functionName: "threshold" }),
  ]);
  assertThat(policyState === EXECUTED && policy.executed, "#24 is not executed");
  assertThat(fee === MAJOR_PROPOSAL_FEE && canMint && !paused, "proposal fee prerequisites failed");
  assertThat(actionAllowed && quote > 0n && quote <= ACTION_FEE_BUDGET && governanceEth >= ACTION_FEE_BUDGET, "canary action/fee budget blocked");
  assertThat(bscPrice === SOURCE_PRICE && basePrice === SOURCE_PRICE, `destination price is not expected source price ${SOURCE_PRICE}`);
  assertThat(bscAllowed && baseAllowed && bscThreshold === 2n && baseThreshold === 2n, "destination 2-of-3 allowlist state mismatch");
  assertThat(latestNonce === pendingNonce, "signer has pending Ethereum transaction");
  const duplicate = await findDuplicate(eth, count, action.calldata);
  assertThat(duplicate === undefined, `duplicate exact canary proposal exists: ${duplicate}`);
  if (!existing) assertThat(balance === 0n && allowance === 0n, "fresh proposer DC balance/allowance must be zero");
  if (existing) {
    assertThat(existing.schemaVersion === 1 && same(existing.dc, dc) && same(existing.treasury, treasury), "partial state address/schema mismatch");
    assertThat(same(existing.broadcastCalldata, action.calldata) && same(existing.createProposalCalldata, createProposalCalldata), "partial state action mismatch");
    assertThat(BigInt(existing.proposalCountBefore) === count && BigInt(existing.expectedProposalId) === count + 1n, "partial state proposal count mismatch");
    assertThat(existing.transactions.approve === undefined && existing.transactions.createProposal === undefined, "partial state contains unexpected later transaction");
    const mintCalldata = encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [OWNER, MAJOR_PROPOSAL_FEE] });
    if (!existing.transactions.mint && balance === MAJOR_PROPOSAL_FEE && allowance === 0n) {
      const mintReceipt = await eth.getTransactionReceipt({ hash: "0xccb9d08d90692571fcaa3f2aec0146b7c99a15178cc5effe3c885c7b9a006e5c" });
      const mintTx = await eth.getTransaction({ hash: mintReceipt.transactionHash });
      assertThat(mintReceipt.status === "success" && same(mintTx.from, OWNER) && mintTx.to && same(mintTx.to, dc) && same(mintTx.input, mintCalldata) && mintTx.value === 0n, "unrecorded mint transaction mismatch");
      existing.transactions.mint = { hash: mintTx.hash, nonce: mintTx.nonce, blockNumber: mintReceipt.blockNumber.toString(), gasUsed: mintReceipt.gasUsed.toString(), verified: true };
      existing.stage = "fee-minted"; save(existing);
    }
    assertThat(existing.transactions.mint && balance === MAJOR_PROPOSAL_FEE && allowance === 0n, "partial state is not exactly post-mint");
  }
  console.log(stringify({ status: "PASS", mode, operation: RESTORE ? "restore" : "canary", proposalCount: count, expectedProposalId: count + 1n, description: DESCRIPTION,
    currentPrice: SOURCE_PRICE, targetPrice: TARGET_PRICE, quote, executionBudget: ACTION_FEE_BUDGET, noStakeExecutionOrBroadcast: true }));
  if (mode === "preflight") return;
  const confirmation = RESTORE ? process.env.CROSS_CHAIN_MESSAGE_FEE_RESTORE_CONFIRM : process.env.CROSS_CHAIN_MESSAGE_FEE_CANARY_CONFIRM;
  assertThat(confirmation === CONFIRM, "write gate closed");
  const account = privateKeyToAccount(key()); assertThat(same(account.address, OWNER), `signer mismatch: ${account.address}`);
  const wallet: any = createWalletClient({ account, chain: mainnet, transport: http(ethRpc, { timeout: 30_000 }) });
  const state: State = existing ?? { schemaVersion: 1, stage: "started", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      proposalCountBefore: count.toString(), expectedProposalId: (count + 1n).toString(), dc, treasury, totalSupplyBefore: supply.toString(),
      treasuryBalanceBefore: treasuryBalance.toString(), broadcastNonceBefore: broadcastNonce.toString(), liveQuoteBefore: quote.toString(),
      broadcastCalldata: action.calldata, createProposalCalldata, transactions: {} };
  if (!existing) save(state);
  const mintData = encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [OWNER, MAJOR_PROPOSAL_FEE] });
  if (!state.transactions.mint) {
    const mintHash = await wallet.writeContract({ address: dc, abi: tokenAbi, functionName: "mint", args: [OWNER, MAJOR_PROPOSAL_FEE] });
    state.transactions.mint = await waitExact(eth, mintHash, dc, mintData); state.stage = "fee-minted"; save(state);
  }
  const approveData = encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [GOVERNANCE, MAJOR_PROPOSAL_FEE] });
  const approveHash = await wallet.writeContract({ address: dc, abi: tokenAbi, functionName: "approve", args: [GOVERNANCE, MAJOR_PROPOSAL_FEE] });
  state.transactions.approve = await waitExact(eth, approveHash, dc, approveData); state.stage = "fee-approved"; save(state);
  const args = [[BROADCASTER], [ACTION_FEE_BUDGET], [action.calldata], DESCRIPTION, MAJOR] as const;
  const simulation = await eth.simulateContract({ account: OWNER, address: GOVERNANCE, abi: governanceAbi, functionName: "createProposal", args });
  assertThat(simulation.result === count + 1n, "simulated proposal id mismatch");
  const createHash = await wallet.writeContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "createProposal", args });
  state.transactions.createProposal = await waitExact(eth, createHash, GOVERNANCE, createProposalCalldata);
  const id = count + 1n;
  const [finalCount, proposalAfter, proposalState, actionsAfter, balanceAfter, allowanceAfter, supplyAfter, treasuryAfter,
    nonceAfter, bscPriceAfter, basePriceAfter] = await Promise.all([
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [id] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [id] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [id] }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    eth.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    bscClient.readContract({ address: BSC_FACTORY, abi: factoryAbi, functionName: "msgPriceAmountInToken" }),
    baseClient.readContract({ address: BASE_FACTORY, abi: factoryAbi, functionName: "msgPriceAmountInToken" }),
  ]);
  assertThat(finalCount === id && proposalState === 1 && proposalAfter.kind === MAJOR && proposalAfter.totalStaked === 0n && !proposalAfter.executed, "new proposal state mismatch");
  assertThat(proposalAfter.description === DESCRIPTION && proposalAfter.createdAt > 0, "description/time mismatch");
  assertThat(actionsAfter[0].length === 1 && same(actionsAfter[0][0], BROADCASTER) && actionsAfter[1][0] === ACTION_FEE_BUDGET && same(actionsAfter[2][0], action.calldata), "new proposal action mismatch");
  assertThat(balanceAfter === 0n && allowanceAfter === 0n && supplyAfter === BigInt(state.totalSupplyBefore) + MAJOR_PROPOSAL_FEE && treasuryAfter === BigInt(state.treasuryBalanceBefore) + MAJOR_PROPOSAL_FEE, "proposal fee accounting mismatch");
  assertThat(nonceAfter === BigInt(state.broadcastNonceBefore) && bscPriceAfter === SOURCE_PRICE && basePriceAfter === SOURCE_PRICE, "broadcast or parameter change occurred prematurely");
  state.stage = "proposal-created"; state.verification = { proposalId: id, proposalState, totalStaked: proposalAfter.totalStaked,
    description: DESCRIPTION, feeMovedToTreasury: MAJOR_PROPOSAL_FEE, sourcePriceUnchanged: SOURCE_PRICE, targetPrice: TARGET_PRICE, noStake: true, noExecution: true, noBroadcast: true }; save(state);
  console.log(stringify({ status: "PASS", stateFile: STATE_FILE, transactions: state.transactions, verification: state.verification }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
