/** Execute only Major policy proposal #24; never stake or broadcast. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, mainnet } from "viem/chains";
import {
  BASE_EXECUTOR, BASE_FACTORY, BASE_PROBE, BROADCASTER, BSC_EXECUTOR, BSC_FACTORY, BSC_PROBE,
  EXECUTOR_ALLOWLIST_SELECTOR, GOVERNANCE, MAJOR, MESSAGE_FEE_SETTER_SELECTOR, OWNER,
  POLICY_DESCRIPTION, PROBE_MARKER_SELECTOR, REGISTRY, broadcasterAbi, buildSetRulesCalldata,
  executorAbi, governanceAbi, isEmptyRule, isExactNestedRule, registryAbi,
} from "./lib/cross-chain-message-fee-canary.js";

const PROPOSAL_ID = 24n;
const PASSED = 3;
const EXECUTED = 6;
const CONFIRM = "EXECUTE_EXACT_MESSAGE_FEE_POLICY_24";
const PROPOSAL_FILE = "deployments/cross-chain-message-fee-policy-proposal.json";
const OUTPUT_FILE = "deployments/cross-chain-message-fee-policy-execution.json";

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) process.env[match[1].trim()] = match[2].trim();
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

async function readRules(client: any) {
  const [bscProbe, baseProbe, bscFee, baseFee, baseExecutor] = await Promise.all([
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BSC_PROBE, PROBE_MARKER_SELECTOR] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_PROBE, PROBE_MARKER_SELECTOR] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BSC_FACTORY, MESSAGE_FEE_SETTER_SELECTOR] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_FACTORY, MESSAGE_FEE_SETTER_SELECTOR] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_EXECUTOR, EXECUTOR_ALLOWLIST_SELECTOR] }),
  ]);
  return { bscProbe, baseProbe, bscFee, baseFee, baseExecutor };
}
function prerequisiteRules(value: Awaited<ReturnType<typeof readRules>>) {
  return isExactNestedRule(value.bscProbe) && isExactNestedRule(value.baseProbe)
    && isEmptyRule(value.bscFee) && isEmptyRule(value.baseFee) && isEmptyRule(value.baseExecutor);
}
function finalRules(value: Awaited<ReturnType<typeof readRules>>) {
  return isEmptyRule(value.bscProbe) && isEmptyRule(value.baseProbe)
    && isExactNestedRule(value.bscFee) && isExactNestedRule(value.baseFee) && isExactNestedRule(value.baseExecutor);
}

async function main() {
  loadEnv();
  const mode = process.argv[2] || "preflight";
  assertThat(mode === "preflight" || mode === "execute", "mode must be preflight or execute");
  const saved = JSON.parse(readFileSync(PROPOSAL_FILE, "utf8"));
  assertThat(saved.stage === "proposal-created" && BigInt(saved.verification.proposalId) === PROPOSAL_ID, "proposal record mismatch");
  assertThat(same(saved.setRulesCalldata, buildSetRulesCalldata()), "saved policy calldata mismatch");
  if (existsSync(OUTPUT_FILE)) {
    const output = JSON.parse(readFileSync(OUTPUT_FILE, "utf8"));
    console.log(stringify({ status: "PASS_ALREADY_RECORDED", outputFile: OUTPUT_FILE, ...output }));
    return;
  }

  const rpc = process.env.ETH_MAINNET_RPC_URL?.trim() || "https://eth-mainnet.public.blastapi.io";
  const bscRpc = process.env.BSC_MAINNET_RPC_URL?.trim() || "https://bsc-mainnet.public.blastapi.io";
  const eth: any = createPublicClient({ chain: mainnet, transport: http(rpc, { timeout: 30_000 }) });
  const bscClient: any = createPublicClient({ chain: bsc, transport: http(bscRpc, { timeout: 30_000 }) });
  assertThat(await eth.getChainId() === 1 && await bscClient.getChainId() === 56, "RPC chain mismatch");
  const [count, state, proposal, actions, rulesBefore, nonceBefore, latestNonce, pendingNonce,
    bscProbeAllowed, bscFactoryAllowed] = await Promise.all([
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [PROPOSAL_ID] }),
    readRules(eth),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
    eth.getTransactionCount({ address: OWNER, blockTag: "latest" }),
    eth.getTransactionCount({ address: OWNER, blockTag: "pending" }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BSC_PROBE] }),
    bscClient.readContract({ address: BSC_EXECUTOR, abi: executorAbi, functionName: "allowedTargets", args: [BSC_FACTORY] }),
  ]);
  assertThat(count >= PROPOSAL_ID && (state === PASSED || state === EXECUTED) && proposal.totalStaked >= 70n * 10n ** 18n, "proposal #24 is neither Passed nor Executed");
  assertThat(proposal.description === POLICY_DESCRIPTION, "proposal description mismatch");
  assertThat(actions[0].length === 1 && same(actions[0][0], REGISTRY) && actions[1][0] === 0n && same(actions[2][0], saved.setRulesCalldata), "proposal action mismatch");
  if (state === PASSED) assertThat(prerequisiteRules(rulesBefore), "pending policy prerequisite rules are partial");
  if (state === EXECUTED) assertThat(proposal.executed && finalRules(rulesBefore), "executed policy rules are not exact");
  assertThat(!bscProbeAllowed && bscFactoryAllowed, "BSC allowlist safety state mismatch");
  assertThat(latestNonce === pendingNonce, "signer has pending Ethereum transaction");
  if (state === EXECUTED) {
    assertThat(nonceBefore === BigInt(saved.broadcastNonceBefore), "policy execution unexpectedly broadcast cross-chain");
    const event = parseAbi(["event ProposalExecuted(uint256 indexed proposalId)"])[0];
    const latestBlock = await eth.getBlockNumber();
    const fromBlock = BigInt(saved.transactions.createProposal.blockNumber);
    const logs: any[] = [];
    for (let start = fromBlock; start <= latestBlock; start += 10n) {
      const end = start + 9n < latestBlock ? start + 9n : latestBlock;
      logs.push(...await eth.getLogs({ address: GOVERNANCE, event, args: { proposalId: PROPOSAL_ID }, fromBlock: start, toBlock: end }));
    }
    assertThat(logs.length === 1, `expected one ProposalExecuted log, got ${logs.length}`);
    const receipt = await eth.getTransactionReceipt({ hash: logs[0].transactionHash });
    const tx = await eth.getTransaction({ hash: logs[0].transactionHash });
    const calldata = encodeFunctionData({ abi: governanceAbi, functionName: "execute", args: [PROPOSAL_ID] });
    assertThat(receipt.status === "success" && tx.to && same(tx.to, GOVERNANCE) && same(tx.input, calldata) && tx.value === 0n, "external execution transaction mismatch");
    const output = { schemaVersion: 1, stage: "executed", observedAt: new Date().toISOString(), proposalId: PROPOSAL_ID,
      transaction: { hash: tx.hash, sender: tx.from, nonce: tx.nonce, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, status: receipt.status },
      verification: { finalState: state, fiveRulesExact: true, bscProbeAllowed: false, bscFactoryAllowed: true, noBroadcast: true, externallyExecuted: true } };
    console.log(stringify({ status: "PASS_ALREADY_EXECUTED", mode, ...output }));
    if (mode === "execute") writeFileSync(OUTPUT_FILE, `${stringify(output)}\n`, "utf8");
    return;
  }
  await eth.simulateContract({ account: OWNER, address: GOVERNANCE, abi: governanceAbi, functionName: "execute", args: [PROPOSAL_ID] });
  const estimatedGas = await eth.estimateContractGas({ account: OWNER, address: GOVERNANCE, abi: governanceAbi, functionName: "execute", args: [PROPOSAL_ID] });
  console.log(stringify({ status: "PASS", mode, proposalId: PROPOSAL_ID, totalStaked: proposal.totalStaked, estimatedGas, signerNonce: pendingNonce, noBroadcast: true }));
  if (mode === "preflight") return;

  assertThat(process.env.CROSS_CHAIN_MESSAGE_FEE_POLICY_EXECUTION_CONFIRM === CONFIRM, "write gate closed");
  const account = privateKeyToAccount(key());
  assertThat(same(account.address, OWNER), `signer mismatch: ${account.address}`);
  const wallet: any = createWalletClient({ account, chain: mainnet, transport: http(rpc, { timeout: 30_000 }) });
  const calldata = encodeFunctionData({ abi: governanceAbi, functionName: "execute", args: [PROPOSAL_ID] });
  const hash = await wallet.writeContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "execute", args: [PROPOSAL_ID], nonce: pendingNonce });
  const receipt = await eth.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 300_000 });
  const tx = await eth.getTransaction({ hash });
  assertThat(receipt.status === "success" && same(tx.from, OWNER) && tx.to && same(tx.to, GOVERNANCE), "execution receipt/endpoints mismatch");
  assertThat(tx.value === 0n && same(tx.input, calldata), "execution calldata/value mismatch");
  const [finalState, finalProposal, rulesAfter, nonceAfter] = await Promise.all([
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [PROPOSAL_ID] }),
    eth.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [PROPOSAL_ID] }),
    readRules(eth),
    eth.readContract({ address: BROADCASTER, abi: broadcasterAbi, functionName: "broadcastNonce" }),
  ]);
  assertThat(finalState === EXECUTED && finalProposal.executed, "proposal did not reach Executed");
  assertThat(finalRules(rulesAfter), "one or more exact policy rules did not activate");
  assertThat(nonceAfter === nonceBefore, "unexpected cross-chain broadcast");
  const output = { schemaVersion: 1, stage: "executed", executedAt: new Date().toISOString(), proposalId: PROPOSAL_ID,
    transaction: { hash, nonce: tx.nonce, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, status: receipt.status },
    verification: { finalState, fiveRulesExact: true, bscProbeAllowed: false, bscFactoryAllowed: true, noBroadcast: true } };
  writeFileSync(OUTPUT_FILE, `${stringify(output)}\n`, "utf8");
  console.log(stringify({ status: "PASS", outputFile: OUTPUT_FILE, ...output }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
