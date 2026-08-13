/**
 * Creates only the prerequisite Major policy proposal that permits the ETH DAO
 * to call upgradeToAndCall on the BSC and Base DealFactory proxies through the
 * all-active-chain broadcaster. It never stakes, executes or broadcasts.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
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

const CONFIRM = "MINT_APPROVE_CREATE_FACTORY_UPGRADE_POLICY";
const STATE_FILE = "deployments/deal-factory-governance-policy-proposal.json";
const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const GOVERNANCE = getAddress("0x9a41a9A85C16F590789C846Fb933fF8C715407F7");
const REGISTRY = getAddress("0xBFF01F91291476e671f0F310846D5dDb460e2382");
const BSC_FACTORY = getAddress("0x1Ca748Feb347d0d177E844E7D4CDCA908957c256");
const BASE_FACTORY = getAddress("0x591625Be924B98ACcAb7e2c8aF698c858Aa2608D");
const MAJOR = 2;
const FEE = parseEther("1000");
const SELECTOR = toFunctionSelector("upgradeToAndCall(address,bytes)");
const DESCRIPTION = "授权BSC和Base由DAO升级Factory，不修改业务参数。";

const governanceAbi = parseAbi([
  "function dcToken() view returns (address)",
  "function treasury() view returns (address)",
  "function policyRegistry() view returns (address)",
  "function majorProposalFee() view returns (uint256)",
  "function proposalCount() view returns (uint256)",
  "function state(uint256) view returns (uint8)",
  "function getProposal(uint256) view returns ((address proposer,uint8 kind,uint256 totalStaked,uint256 windowEndsAt,bool vetoed,bool canceled,bool executed,bool nftRegistered,bool satoshiSucceeded,bool activationReturnable,address vetoer,bytes32 actionsHash,string description,uint48 createdAt))",
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

type TxRecord = { hash: Hex; nonce: number; blockNumber: string; gasUsed: string; verified: true };
type State = {
  schemaVersion: 1;
  stage: "started" | "fee-minted" | "fee-approved" | "proposal-created";
  startedAt: string;
  updatedAt: string;
  proposalCountBefore: string;
  expectedProposalId: string;
  dc: Address;
  treasury: Address;
  totalSupplyBefore: string;
  treasuryBalanceBefore: string;
  description: string;
  setRulesCalldata: Hex;
  createProposalCalldata: Hex;
  transactions: { mint?: TxRecord; approve?: TxRecord; createProposal?: TxRecord };
  proposalId?: string;
  verification?: Record<string, unknown>;
};

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] ||= value;
  }
}
function rpc() { return process.env.ETH_MAINNET_RPC_URL?.trim() || "https://eth-mainnet.public.blastapi.io"; }
function signerKey(): Hex {
  const raw = process.env.ETH_MAINNET_PRIVATE_KEY?.trim() || process.env.AGIKING_PRIVATE_KEY?.trim();
  if (!raw) throw new Error("Missing ETH_MAINNET_PRIVATE_KEY or AGIKING_PRIVATE_KEY");
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}
function same(a: unknown, b: unknown) { return String(a).toLowerCase() === String(b).toLowerCase(); }
function assertThat(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function json(value: unknown) { return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2); }
function save(state: State) { state.updatedAt = new Date().toISOString(); writeFileSync(STATE_FILE, `${json(state)}\n`, "utf8"); }
function emptyRule(rule: any) { return !rule[0] && !rule[1] && !rule[2] && rule[3] === 0n; }

const rules = [BSC_FACTORY, BASE_FACTORY].map((target) => ({
  kind: MAJOR,
  target,
  selector: SELECTOR,
  allowed: true,
  validateNestedBroadcast: false,
  nestedOnly: true,
  maxValue: 0n,
}));
const setRulesCalldata = encodeFunctionData({ abi: registryAbi, functionName: "setRules", args: [rules] });
const createProposalCalldata = encodeFunctionData({
  abi: governanceAbi,
  functionName: "createProposal",
  args: [[REGISTRY], [0n], [setRulesCalldata], DESCRIPTION, MAJOR],
});

async function waitAndVerify(client: any, hash: Hex, target: Address, calldata: Hex): Promise<TxRecord> {
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
  const tx = await client.getTransaction({ hash });
  assertThat(receipt.status === "success", `transaction reverted: ${hash}`);
  assertThat(same(tx.from, OWNER) && tx.to && same(tx.to, target), `transaction endpoints mismatch: ${hash}`);
  assertThat(same(tx.input, calldata) && tx.value === 0n, `transaction calldata/value mismatch: ${hash}`);
  return { hash, nonce: tx.nonce, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), verified: true };
}

async function findDuplicate(client: any, count: bigint) {
  for (let id = 1n; id <= count; id++) {
    const actions = await client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [id] });
    if (actions[0].length === 1 && same(actions[0][0], REGISTRY) && actions[1][0] === 0n && same(actions[2][0], setRulesCalldata)) return id;
  }
  return undefined;
}

async function verifyCreated(client: any, state: State) {
  const id = BigInt(state.expectedProposalId);
  const [count, proposal, actions, proposalState, balance, allowance, supply, treasuryBalance, bscRule, baseRule] = await Promise.all([
    client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }),
    client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getProposal", args: [id] }),
    client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "getActions", args: [id] }),
    client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "state", args: [id] }),
    client.readContract({ address: state.dc, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
    client.readContract({ address: state.dc, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }),
    client.readContract({ address: state.dc, abi: tokenAbi, functionName: "totalSupply" }),
    client.readContract({ address: state.dc, abi: tokenAbi, functionName: "balanceOf", args: [state.treasury] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BSC_FACTORY, SELECTOR] }),
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_FACTORY, SELECTOR] }),
  ]);
  assertThat(count === id && proposalState === 1, "proposal is not newly Pending");
  assertThat(same(proposal.proposer, OWNER) && proposal.kind === MAJOR && proposal.totalStaked === 0n && !proposal.executed, "proposal identity/state mismatch");
  assertThat(proposal.description === DESCRIPTION && proposal.createdAt > 0, "proposal description/time mismatch");
  assertThat(actions[0].length === 1 && same(actions[0][0], REGISTRY) && actions[1][0] === 0n && same(actions[2][0], setRulesCalldata), "proposal action mismatch");
  assertThat(balance === 0n && allowance === 0n, "fee balance/allowance not consumed exactly");
  assertThat(supply === BigInt(state.totalSupplyBefore) + FEE, "total supply delta mismatch");
  assertThat(treasuryBalance === BigInt(state.treasuryBalanceBefore) + FEE, "treasury fee delta mismatch");
  assertThat(emptyRule(bscRule) && emptyRule(baseRule), "rules activated before proposal execution");
  state.stage = "proposal-created";
  state.proposalId = id.toString();
  state.verification = { proposalState: Number(proposalState), totalStaked: "0", noExecution: true, feeConsumed: FEE.toString(), rulesStillInactive: true };
  save(state);
}

async function main() {
  loadEnv();
  const mode = process.argv[2] || "preflight";
  assertThat(mode === "preflight" || mode === "execute", "mode must be preflight or execute");
  const transport = http(rpc(), { timeout: 30_000 });
  const client: any = createPublicClient({ chain: mainnet, transport });
  assertThat(await client.getChainId() === 1, "RPC chain mismatch");
  if (existsSync(STATE_FILE)) {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    assertThat(same(state.setRulesCalldata, setRulesCalldata), "existing state mismatch");
    if (state.stage === "proposal-created") {
      await verifyCreated(client, state);
      console.log(json({ status: "PASS_ALREADY_CREATED", proposalId: state.proposalId, stateFile: STATE_FILE, verification: state.verification }));
      return;
    }
  }

  const dc = getAddress(await client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "dcToken" }));
  const treasury = getAddress(await client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "treasury" }));
  const minterRole = await client.readContract({ address: dc, abi: tokenAbi, functionName: "MINTER_ROLE" });
  const [governanceRegistry, registryGovernance, majorFee, proposalCount, canMint, paused, balance, allowance, totalSupply,
    treasuryBalance, bscRule, baseRule, policyAllowed, latestNonce, pendingNonce] = await Promise.all([
      client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "policyRegistry" }),
      client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "governance" }),
      client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "majorProposalFee" }),
      client.readContract({ address: GOVERNANCE, abi: governanceAbi, functionName: "proposalCount" }),
      client.readContract({ address: dc, abi: tokenAbi, functionName: "hasRole", args: [minterRole, OWNER] }),
      client.readContract({ address: dc, abi: tokenAbi, functionName: "paused" }),
      client.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [OWNER] }),
      client.readContract({ address: dc, abi: tokenAbi, functionName: "allowance", args: [OWNER, GOVERNANCE] }),
      client.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
      client.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
      client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BSC_FACTORY, SELECTOR] }),
      client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "getRule", args: [MAJOR, BASE_FACTORY, SELECTOR] }),
      client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isActionAllowed", args: [MAJOR, REGISTRY, 0n, setRulesCalldata] }),
      client.getTransactionCount({ address: OWNER, blockTag: "latest" }),
      client.getTransactionCount({ address: OWNER, blockTag: "pending" }),
    ]);
  assertThat(same(governanceRegistry, REGISTRY) && same(registryGovernance, GOVERNANCE), "governance wiring mismatch");
  assertThat(majorFee === FEE && canMint && !paused, "Major fee preconditions failed");
  let resumedState = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, "utf8")) as State
    : undefined;
  if (resumedState?.stage === "started" && balance === FEE && allowance === 0n
    && totalSupply === BigInt(resumedState.totalSupplyBefore) + FEE) {
    // The mint receipt was confirmed after an RPC wait was interrupted.
    // Recover the exact successful transaction from the known owner nonce.
    const nonce = Number(resumedState.proposalCountBefore) >= 0
      ? await client.getTransactionCount({ address: OWNER, blockTag: "latest" }) - 1
      : -1;
    const latestBlock = await client.getBlockNumber();
    let recovered: TxRecord | undefined;
    for (let block = latestBlock; block + 30n >= latestBlock && block >= 0n; block--) {
      const item = await client.getBlock({ blockNumber: block, includeTransactions: true });
      for (const tx of item.transactions) {
        if (typeof tx !== "string" && tx.from.toLowerCase() === OWNER.toLowerCase()
          && tx.nonce === nonce && tx.to && same(tx.to, dc) && same(tx.input, encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [OWNER, FEE] }))) {
          const receipt = await client.getTransactionReceipt({ hash: tx.hash });
          assertThat(receipt.status === "success", "recovered mint reverted");
          recovered = { hash: tx.hash, nonce: tx.nonce, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), verified: true };
          break;
        }
      }
      if (recovered || block === 0n) break;
    }
    assertThat(recovered, "could not recover the confirmed mint transaction");
    resumedState.transactions.mint = recovered;
    resumedState.stage = "fee-minted";
    save(resumedState);
  }
  const currentStage = resumedState?.stage;
  assertThat(
    (currentStage === "fee-minted" && balance === FEE && allowance === 0n)
      || (currentStage === "fee-approved" && balance === FEE && allowance === FEE)
      || (!resumedState && balance === 0n && allowance === 0n),
    "proposer DC balance/allowance does not match resumable state",
  );
  assertThat(emptyRule(bscRule) && emptyRule(baseRule), "upgrade policy already active or partial");
  assertThat(policyAllowed, "exact policy action is not allowed");
  assertThat(latestNonce === pendingNonce, "signer has pending ETH transaction");
  const duplicate = await findDuplicate(client, proposalCount);
  assertThat(duplicate === undefined, `duplicate policy proposal exists: ${duplicate}`);
  console.log(json({ status: "PASS", mode, proposalCount, expectedProposalId: proposalCount + 1n, description: DESCRIPTION, selector: SELECTOR, balance, allowance, setRulesCalldata, createProposalCalldata }));
  if (mode === "preflight") return;

  assertThat(process.env.DEAL_FACTORY_GOVERNANCE_POLICY_CONFIRM === CONFIRM, "write gate closed");
  const account = privateKeyToAccount(signerKey());
  assertThat(same(account.address, OWNER), "signer mismatch");
  const wallet: any = createWalletClient({ account, chain: mainnet, transport });
  const state: State = resumedState || {
    schemaVersion: 1, stage: "started", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    proposalCountBefore: proposalCount.toString(), expectedProposalId: (proposalCount + 1n).toString(), dc, treasury,
    totalSupplyBefore: totalSupply.toString(), treasuryBalanceBefore: treasuryBalance.toString(), description: DESCRIPTION,
    setRulesCalldata, createProposalCalldata, transactions: {},
  };
  if (!resumedState) {
    save(state);
    const mintCalldata = encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [OWNER, FEE] });
    state.transactions.mint = await waitAndVerify(client, await wallet.writeContract({ account, address: dc, abi: tokenAbi, functionName: "mint", args: [OWNER, FEE], gas: 150_000n }), dc, mintCalldata);
    state.stage = "fee-minted"; save(state);
  }
  const approveCalldata = encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [GOVERNANCE, FEE] });
  if (state.stage === "fee-minted") {
    state.transactions.approve = await waitAndVerify(client, await wallet.writeContract({ account, address: dc, abi: tokenAbi, functionName: "approve", args: [GOVERNANCE, FEE], gas: 100_000n }), dc, approveCalldata);
    state.stage = "fee-approved"; save(state);
  }
  state.transactions.createProposal = await waitAndVerify(client, await wallet.writeContract({ account, address: GOVERNANCE, abi: governanceAbi, functionName: "createProposal", args: [[REGISTRY], [0n], [setRulesCalldata], DESCRIPTION, MAJOR], gas: 1_000_000n }), GOVERNANCE, createProposalCalldata);
  await verifyCreated(client, state);
  console.log(json({ status: "PASS_PROPOSAL_CREATED", proposalId: state.proposalId, description: DESCRIPTION, transactions: state.transactions, verification: state.verification, stateFile: STATE_FILE }));
}

await main();
