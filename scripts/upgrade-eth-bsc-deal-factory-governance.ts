/** First production upgrade of ETH/BSC DealFactory proxies to the governance-control implementation. */
import { existsSync, readFileSync } from "node:fs";

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, mainnet } from "viem/chains";

const WRITE_CONFIRM = "UPGRADE_ETH_BSC_DEAL_FACTORY_GOVERNANCE_CONTROL";
const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const IMPLEMENTATION = getAddress("0x7fC9145A2539F0eD52Cf6E7E34Ce485635A9887E");
const EXPECTED_CODE_HASH = "0xdc7b6c061c5d97b62294659bf5ee9d40353238010763d1bd8c804a1974676002" as Hex;
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

const abi = parseAbi([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function crossChainGovernance() view returns (address)",
  "function treasury() view returns (address)",
  "function specialNoFeeToken() view returns (address)",
  "function msgPriceEnabled() view returns (bool)",
  "function msgPriceToken() view returns (address)",
  "function msgPriceAmountInToken() view returns (uint256)",
  "function createBurnEnabled() view returns (bool)",
  "function createBurnPricingToken() view returns (address)",
  "function createBurnAmountInToken() view returns (uint256)",
  "function minTimeoutSeconds() view returns (uint64)",
  "function minWindowSec() view returns (uint32)",
  "function defaultFeeNonDL() view returns (uint32 num,uint32 den)",
  "function defaultMintOnFees() view returns (uint32 num,uint32 den)",
  "function setMessagePriceAmount(uint256)",
  "function setCreateBurnAmount(uint256)",
  "function setTreasury(address)",
  "function setSpecialNoFeeToken(address)",
  "function upgradeToAndCall(address,bytes) payable",
]);

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

function keyFor(...names: string[]): Hex {
  for (const name of [...names, "AGIKING_PRIVATE_KEY"]) {
    const value = process.env[name]?.trim();
    if (value) return (value.startsWith("0x") ? value : `0x${value}`) as Hex;
  }
  throw new Error(`Missing private key: ${names.join(" or ")}`);
}

function implementationAddress(word: Hex | undefined): Address {
  if (!word) throw new Error("missing implementation slot");
  return getAddress(`0x${word.slice(-40)}`);
}

function json(value: unknown) {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

async function snapshot(client: any, factory: Address) {
  const [owner, admin, crossChainGovernance, treasury, specialNoFeeToken, msgPriceEnabled,
    msgPriceToken, msgPriceAmountInToken, createBurnEnabled, createBurnPricingToken,
    createBurnAmountInToken, minTimeoutSeconds, minWindowSec, defaultFeeNonDL,
    defaultMintOnFees] = await Promise.all([
      client.readContract({ address: factory, abi, functionName: "owner" }),
      client.readContract({ address: factory, abi, functionName: "admin" }),
      client.readContract({ address: factory, abi, functionName: "crossChainGovernance" }),
      client.readContract({ address: factory, abi, functionName: "treasury" }),
      client.readContract({ address: factory, abi, functionName: "specialNoFeeToken" }),
      client.readContract({ address: factory, abi, functionName: "msgPriceEnabled" }),
      client.readContract({ address: factory, abi, functionName: "msgPriceToken" }),
      client.readContract({ address: factory, abi, functionName: "msgPriceAmountInToken" }),
      client.readContract({ address: factory, abi, functionName: "createBurnEnabled" }),
      client.readContract({ address: factory, abi, functionName: "createBurnPricingToken" }),
      client.readContract({ address: factory, abi, functionName: "createBurnAmountInToken" }),
      client.readContract({ address: factory, abi, functionName: "minTimeoutSeconds" }),
      client.readContract({ address: factory, abi, functionName: "minWindowSec" }),
      client.readContract({ address: factory, abi, functionName: "defaultFeeNonDL" }),
      client.readContract({ address: factory, abi, functionName: "defaultMintOnFees" }),
    ]);
  return { owner, admin, crossChainGovernance, treasury, specialNoFeeToken, msgPriceEnabled,
    msgPriceToken, msgPriceAmountInToken, createBurnEnabled, createBurnPricingToken,
    createBurnAmountInToken, minTimeoutSeconds, minWindowSec, defaultFeeNonDL,
    defaultMintOnFees };
}

loadEnv();
if (process.env.DEAL_FACTORY_GOVERNANCE_UPGRADE_CONFIRM !== WRITE_CONFIRM) {
  throw new Error(`Write gate closed: set DEAL_FACTORY_GOVERNANCE_UPGRADE_CONFIRM=${WRITE_CONFIRM}`);
}

const configs = [
  { label: "BSC", id: 56, chain: bsc, factory: getAddress("0x1Ca748Feb347d0d177E844E7D4CDCA908957c256"), rpc: process.env.BSC_MAINNET_RPC_URL || "https://bsc-mainnet.public.blastapi.io", key: keyFor("BSC_MAINNET_PRIVATE_KEY") },
  { label: "ETH", id: 1, chain: mainnet, factory: getAddress("0x02330431f96b21776274f3147bd4c233caf7d752"), rpc: process.env.ETH_MAINNET_RPC_URL || "https://eth-mainnet.public.blastapi.io", key: keyFor("ETH_MAINNET_PRIVATE_KEY") },
] as const;

const results: unknown[] = [];
for (const config of configs) {
  const account = privateKeyToAccount(config.key);
  if (getAddress(account.address) !== OWNER) throw new Error(`${config.label} signer mismatch`);
  const transport = http(config.rpc, { timeout: 30_000 });
  const publicClient = createPublicClient({ chain: config.chain, transport });
  const walletClient = createWalletClient({ account, chain: config.chain, transport });
  if (await publicClient.getChainId() !== config.id) throw new Error(`${config.label} chain mismatch`);
  const [code, latestNonce, pendingNonce, slotBefore] = await Promise.all([
    publicClient.getCode({ address: IMPLEMENTATION }),
    publicClient.getTransactionCount({ address: OWNER, blockTag: "latest" }),
    publicClient.getTransactionCount({ address: OWNER, blockTag: "pending" }),
    publicClient.getStorageAt({ address: config.factory, slot: IMPLEMENTATION_SLOT }),
  ]);
  if (!code || code === "0x" || keccak256(code) !== EXPECTED_CODE_HASH) throw new Error(`${config.label} implementation code mismatch`);
  if (latestNonce !== pendingNonce) throw new Error(`${config.label} signer has pending transaction`);
  const before = await snapshot(publicClient, config.factory);
  if (getAddress(before.owner as Address) !== OWNER) throw new Error(`${config.label} Factory owner mismatch`);
  if (implementationAddress(slotBefore) === IMPLEMENTATION) {
    results.push({ label: config.label, status: "ALREADY_UPGRADED", factory: config.factory, implementation: IMPLEMENTATION });
    continue;
  }
  let hash: Hex;
  if (config.label === "ETH" && process.env.DEAL_FACTORY_ETH_PREVALIDATED_SEND === "1") {
    // Several public ETH RPCs return HTTP 520 for this eth_call despite the
    // same calldata passing the pinned mainnet fork. The write path remains
    // gated and uses a bounded gas limit after all code/owner/nonce checks.
    hash = await walletClient.writeContract({
      account,
      address: config.factory,
      abi,
      functionName: "upgradeToAndCall",
      args: [IMPLEMENTATION, "0x"],
      gas: 150_000n,
    });
  } else {
    const simulation = await publicClient.simulateContract({
      account,
      address: config.factory,
      abi,
      functionName: "upgradeToAndCall",
      args: [IMPLEMENTATION, "0x"],
    });
    hash = await walletClient.writeContract(simulation.request);
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`${config.label} upgrade failed: ${hash}`);
  const [slotAfter, after] = await Promise.all([
    publicClient.getStorageAt({ address: config.factory, slot: IMPLEMENTATION_SLOT }),
    snapshot(publicClient, config.factory),
  ]);
  if (implementationAddress(slotAfter) !== IMPLEMENTATION) throw new Error(`${config.label} implementation slot mismatch`);
  if (json(after) !== json(before)) throw new Error(`${config.label} Factory state changed during upgrade`);
  await publicClient.simulateContract({ account: before.crossChainGovernance as Address, address: config.factory, abi, functionName: "setMessagePriceAmount", args: [before.msgPriceAmountInToken as bigint] });
  results.push({
    label: config.label,
    status: "UPGRADED",
    factory: config.factory,
    oldImplementation: implementationAddress(slotBefore),
    newImplementation: IMPLEMENTATION,
    txHash: hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    statePreserved: true,
    governanceSelectorCallable: true,
  });
  console.log(json(results[results.length - 1]));
}
console.log(json({ status: "PASS", transactionSent: true, results }));
