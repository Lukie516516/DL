/**
 * Deploy only the DealGovernance implementation containing Proposal.createdAt.
 *
 * Default mode is a read-only preflight. The only write path requires:
 *
 * DAO_CREATED_AT_IMPLEMENTATION_DEPLOY=DEPLOY_ETH_DAO_CREATED_AT_IMPLEMENTATION \
 *   node --import tsx/esm scripts/deploy-eth-dao-created-at-implementation.ts
 *
 * This script never creates, stakes or executes a governance proposal.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  formatEther,
  getAddress,
  getContractAddress,
  http,
  keccak256,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

const CONFIRM = "DEPLOY_ETH_DAO_CREATED_AT_IMPLEMENTATION";
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const DEPLOYMENT_FILE = join(process.cwd(), "deployments", "eth-mainnet-1.json");
const ARTIFACT_FILE = join(
  process.cwd(),
  "artifacts",
  "contracts",
  "DealGovernance.sol",
  "DealGovernance.json",
);

type Deployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
};

type Artifact = {
  abi: Abi;
  bytecode: Hex;
};

const implementationAbi = parseAbi([
  "function proxiableUUID() view returns (bytes32)",
]);

function loadEnv(): void {
  for (const line of readFileSync(join(process.cwd(), ".env"), "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] ||= match[2].trim();
  }
}

function slotAddress(word: Hex | undefined): Address {
  if (!word || word.length !== 66) throw new Error("Implementation slot is missing");
  return getAddress(`0x${word.slice(-40)}`);
}

async function main(): Promise<void> {
  loadEnv();
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Deployment;
  const artifact = JSON.parse(readFileSync(ARTIFACT_FILE, "utf8")) as Artifact;
  if (deployment.chainId !== 1) throw new Error("Deployment file is not Ethereum mainnet");
  if (!artifact.bytecode || artifact.bytecode === "0x") {
    throw new Error("DealGovernance artifact has no bytecode");
  }

  const rpcUrl = process.env.ETH_MAINNET_RPC_URL?.trim();
  const rawKey =
    process.env.ETH_MAINNET_PRIVATE_KEY?.trim()
      || process.env.AGIKING_PRIVATE_KEY?.trim();
  if (!rpcUrl || !rawKey) throw new Error("Missing ETH mainnet RPC or private key");

  const account = privateKeyToAccount(
    (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex,
  );
  const expectedDeployer = getAddress(deployment.deployer);
  if (getAddress(account.address) !== expectedDeployer) {
    throw new Error(`Configured signer ${account.address} != recorded deployer ${expectedDeployer}`);
  }

  const governance = getAddress(deployment.addresses.dealGovernance);
  const expectedCurrentImplementation = getAddress(
    deployment.addresses.dealGovernanceImpl,
  );
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: mainnet,
    transport: http(rpcUrl),
  });

  const [chainId, blockNumber, latestNonce, pendingNonce, balance, currentSlot] =
    await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlockNumber(),
      publicClient.getTransactionCount({
        address: account.address,
        blockTag: "latest",
      }),
      publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      }),
      publicClient.getBalance({ address: account.address }),
      publicClient.getStorageAt({
        address: governance,
        slot: IMPLEMENTATION_SLOT,
      }),
    ]);
  if (chainId !== 1) throw new Error(`Wrong chain ${chainId}`);
  if (latestNonce !== pendingNonce) throw new Error("Signer has pending transactions");
  if (slotAddress(currentSlot) !== expectedCurrentImplementation) {
    throw new Error("Current DealGovernance implementation does not match deployment baseline");
  }

  const predictedAddress = getContractAddress({
    from: account.address,
    nonce: BigInt(pendingNonce),
  });
  const predictedCode = await publicClient.getCode({ address: predictedAddress });
  if (predictedCode && predictedCode !== "0x") {
    throw new Error(`Predicted address already has code: ${predictedAddress}`);
  }

  const deployData = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
  });
  const [gasEstimate, feeEstimate] = await Promise.all([
    publicClient.estimateGas({ account: account.address, data: deployData }),
    publicClient.estimateFeesPerGas(),
  ]);
  const maxDeploymentCost = gasEstimate * feeEstimate.maxFeePerGas;
  if (balance <= maxDeploymentCost) {
    throw new Error("Insufficient ETH for implementation deployment");
  }

  console.log(JSON.stringify({
    mode:
      process.env.DAO_CREATED_AT_IMPLEMENTATION_DEPLOY === CONFIRM
        ? "write"
        : "dry-run",
    checkedAt: new Date().toISOString(),
    chainId,
    blockNumber: blockNumber.toString(),
    deployer: account.address,
    nonce: pendingNonce,
    balanceWei: balance.toString(),
    governance,
    currentImplementation: expectedCurrentImplementation,
    predictedImplementation: predictedAddress,
    creationBytecodeHash: keccak256(artifact.bytecode),
    gasEstimate: gasEstimate.toString(),
    maxFeePerGasWei: feeEstimate.maxFeePerGas.toString(),
    maxDeploymentCostWei: maxDeploymentCost.toString(),
    maxDeploymentCostEth: formatEther(maxDeploymentCost),
  }, null, 2));

  if (process.env.DAO_CREATED_AT_IMPLEMENTATION_DEPLOY !== CONFIRM) {
    console.log("DRY-RUN ONLY: no transaction sent.");
    return;
  }

  const hash = await walletClient.deployContract({
    account,
    chain: mainnet,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`Implementation deployment failed: ${hash}`);
  }
  if (
    !receipt.contractAddress
      || getAddress(receipt.contractAddress) !== getAddress(predictedAddress)
  ) {
    throw new Error(`Unexpected implementation address: ${String(receipt.contractAddress)}`);
  }

  const [runtimeCode, proxiableUuid] = await Promise.all([
    publicClient.getCode({ address: receipt.contractAddress }),
    publicClient.readContract({
      address: receipt.contractAddress,
      abi: implementationAbi,
      functionName: "proxiableUUID",
    }),
  ]);
  if (!runtimeCode || runtimeCode === "0x") {
    throw new Error("Implementation runtime code is empty");
  }
  if (proxiableUuid !== IMPLEMENTATION_SLOT) {
    throw new Error(`Unexpected proxiableUUID: ${proxiableUuid}`);
  }

  console.log(JSON.stringify({
    deployed: true,
    implementation: receipt.contractAddress,
    transactionHash: hash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    runtimeCodeHash: keccak256(runtimeCode),
    proxiableUUID: proxiableUuid,
    note: "Implementation only. No proposal was created, staked or executed.",
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
