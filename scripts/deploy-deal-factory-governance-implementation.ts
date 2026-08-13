/** Deploys the exact production DealFactory implementation to ETH/BSC/Base at one CREATE2 address. */
import { existsSync, readFileSync } from "node:fs";

import {
  concat,
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  getCreate2Address,
  http,
  keccak256,
  stringToHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, bsc, mainnet } from "viem/chains";

const WRITE_CONFIRM = "DEPLOY_DEAL_FACTORY_GOVERNANCE_IMPLEMENTATION_ON_ETH_BSC_BASE";
const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const CREATE2_DEPLOYER = getAddress("0x4e59b44847b379578588920cA78FbF26c0B4956C");
const SALT = keccak256(stringToHex("DEAL_FACTORY_GOVERNANCE_CONTROL_2026_08_12_V1"));

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

function required(name: string, fallback?: string) {
  const value = process.env[name]?.trim() || fallback;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function keyFor(...names: string[]): Hex {
  for (const name of [...names, "AGIKING_PRIVATE_KEY"]) {
    const value = process.env[name]?.trim();
    if (value) return (value.startsWith("0x") ? value : `0x${value}`) as Hex;
  }
  throw new Error(`Missing private key: ${names.join(" or ")} or AGIKING_PRIVATE_KEY`);
}

function json(value: unknown) {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

loadEnv();
if (process.env.DEAL_FACTORY_GOVERNANCE_DEPLOY_CONFIRM !== WRITE_CONFIRM) {
  throw new Error(`Write gate closed: set DEAL_FACTORY_GOVERNANCE_DEPLOY_CONFIRM=${WRITE_CONFIRM}`);
}

const artifact = JSON.parse(
  readFileSync("artifacts/contracts/DealFactory.sol/DealFactory.json", "utf8"),
) as {
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableReferences: Record<string, Array<{ start: number; length: number }>>;
};
const creationCodeHash = keccak256(artifact.bytecode);
const runtimeCodeHash = keccak256(artifact.deployedBytecode);
const predicted = getCreate2Address({ from: CREATE2_DEPLOYER, salt: SALT, bytecodeHash: creationCodeHash });
function materializeRuntime(code: Hex): Hex {
  let body = code.slice(2);
  const value = predicted.slice(2).toLowerCase().padStart(64, "0");
  for (const refs of Object.values(artifact.immutableReferences)) {
    for (const ref of refs) {
      if (ref.length !== 32) throw new Error(`Unexpected immutable length ${ref.length}`);
      const start = ref.start * 2;
      body = `${body.slice(0, start)}${value}${body.slice(start + ref.length * 2)}`;
    }
  }
  return `0x${body}` as Hex;
}
const expectedRuntimeCodeHash = keccak256(materializeRuntime(artifact.deployedBytecode));
const calldata = concat([SALT, artifact.bytecode]);

const configs = [
  { label: "Base", id: 8453, chain: base, rpc: required("BASE_MAINNET_RPC_URL", "https://base-mainnet.public.blastapi.io"), key: keyFor("BASE_MAINNET_PRIVATE_KEY") },
  { label: "BSC", id: 56, chain: bsc, rpc: required("BSC_MAINNET_RPC_URL", "https://bsc-mainnet.public.blastapi.io"), key: keyFor("BSC_MAINNET_PRIVATE_KEY") },
  { label: "ETH", id: 1, chain: mainnet, rpc: required("ETH_MAINNET_RPC_URL", "https://eth-mainnet.public.blastapi.io"), key: keyFor("ETH_MAINNET_PRIVATE_KEY") },
] as const;

const results: unknown[] = [];
for (const config of configs) {
  const account = privateKeyToAccount(config.key);
  if (getAddress(account.address) !== OWNER) throw new Error(`${config.label} signer is not expected owner`);
  const transport = http(config.rpc, { timeout: 30_000 });
  const publicClient = createPublicClient({ chain: config.chain, transport });
  const walletClient = createWalletClient({ account, chain: config.chain, transport });
  if (await publicClient.getChainId() !== config.id) throw new Error(`${config.label} chain mismatch`);
  const [latestNonce, pendingNonce, balance, existingCode] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: "latest" }),
    publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
    publicClient.getBalance({ address: account.address }),
    publicClient.getCode({ address: predicted }),
  ]);
  if (latestNonce !== pendingNonce) throw new Error(`${config.label} signer has a pending transaction`);
  if (existingCode && existingCode !== "0x") {
    if (keccak256(existingCode) !== expectedRuntimeCodeHash) throw new Error(`${config.label} predicted address contains unexpected code`);
    results.push({ label: config.label, status: "ALREADY_DEPLOYED", address: predicted, codeHash: expectedRuntimeCodeHash });
    continue;
  }
  const gas = await publicClient.estimateGas({ account: account.address, to: CREATE2_DEPLOYER, data: calldata });
  const fees = await publicClient.estimateFeesPerGas();
  const maxPrice = "maxFeePerGas" in fees ? fees.maxFeePerGas : fees.gasPrice;
  const maxCost = gas * maxPrice;
  if (balance < maxCost) throw new Error(`${config.label} insufficient balance: ${formatEther(balance)} < max ${formatEther(maxCost)}`);
  const hash = await walletClient.sendTransaction({
    account,
    to: CREATE2_DEPLOYER,
    data: calldata,
    gas: (gas * 110n) / 100n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`${config.label} deployment failed: ${hash}`);
  const deployedCode = await publicClient.getCode({ address: predicted });
  if (!deployedCode || deployedCode === "0x" || keccak256(deployedCode) !== expectedRuntimeCodeHash) {
    throw new Error(`${config.label} deployed runtime mismatch`);
  }
  results.push({
    label: config.label,
    status: "DEPLOYED",
    address: predicted,
    txHash: hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    cost: receipt.gasUsed * receipt.effectiveGasPrice,
    codeHash: expectedRuntimeCodeHash,
  });
  console.log(json(results[results.length - 1]));
}

console.log(json({ status: "PASS", transactionSent: true, predictedImplementation: predicted, artifactRuntimeCodeHash: runtimeCodeHash, expectedRuntimeCodeHash, results }));
