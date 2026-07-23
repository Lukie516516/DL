/**
 * Deploy the permissionless, read-only DealGovernanceReader on ETH mainnet.
 *
 * Default mode is read-only and prints the exact predicted address and gas estimate.
 * The only write path requires this exact gate:
 *
 * DEAL_GOVERNANCE_READER_DEPLOY=DEPLOY_READ_ONLY_ETH_GOVERNANCE_READER \
 *   node --import tsx/esm scripts/deploy-eth-governance-reader.ts
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
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

const CONFIRM = "DEPLOY_READ_ONLY_ETH_GOVERNANCE_READER";
const DEPLOYMENT_FILE = join(process.cwd(), "deployments", "eth-mainnet-1.json");
const ARTIFACT_FILE = join(
  process.cwd(),
  "artifacts",
  "contracts",
  "DealGovernanceReader.sol",
  "DealGovernanceReader.json",
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

const governanceAbi = [
  {
    type: "function",
    stateMutability: "view",
    name: "proposalCount",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

function loadEnv() {
  for (const line of readFileSync(join(process.cwd(), ".env"), "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] ||= match[2].trim();
  }
}

function sameAddress(a: Address, b: Address) {
  return a.toLowerCase() === b.toLowerCase();
}

async function main() {
  loadEnv();

  const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Deployment;
  const artifact = JSON.parse(readFileSync(ARTIFACT_FILE, "utf8")) as Artifact;
  if (deployment.chainId !== 1) throw new Error("Deployment file is not Ethereum mainnet");
  if (!artifact.bytecode || artifact.bytecode === "0x") throw new Error("Reader artifact has no bytecode");

  const rpc = process.env.ETH_MAINNET_RPC_URL?.trim();
  const rawKey = process.env.ETH_MAINNET_PRIVATE_KEY?.trim()
    || process.env.AGIKING_PRIVATE_KEY?.trim();
  if (!rpc || !rawKey) throw new Error("Missing ETH mainnet RPC or private key");

  const account = privateKeyToAccount(
    (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex,
  );
  const expectedDeployer = getAddress(deployment.deployer);
  if (!sameAddress(account.address, expectedDeployer)) {
    throw new Error(`Configured signer ${account.address} != recorded deployer ${expectedDeployer}`);
  }

  const governance = getAddress(deployment.addresses.dealGovernance);
  const publicClient = createPublicClient({ chain: mainnet, transport: http(rpc) });
  const walletClient = createWalletClient({ account, chain: mainnet, transport: http(rpc) });

  const [chainId, blockNumber, latestNonce, pendingNonce, balance, governanceCode, proposalCount] =
    await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlockNumber(),
      publicClient.getTransactionCount({ address: account.address, blockTag: "latest" }),
      publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
      publicClient.getBalance({ address: account.address }),
      publicClient.getCode({ address: governance }),
      publicClient.readContract({ address: governance, abi: governanceAbi, functionName: "proposalCount" }),
    ]);

  if (chainId !== 1) throw new Error(`Wrong chain ${chainId}`);
  if (latestNonce !== pendingNonce) throw new Error("Signer has pending transactions");
  if (!governanceCode || governanceCode === "0x") throw new Error("Governance proxy has no code");

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
    args: [governance],
  });
  const [gasEstimate, feeEstimate] = await Promise.all([
    publicClient.estimateGas({ account: account.address, data: deployData }),
    publicClient.estimateFeesPerGas(),
  ]);
  const maxDeploymentCost = gasEstimate * feeEstimate.maxFeePerGas;
  if (balance <= maxDeploymentCost) throw new Error("Insufficient ETH for Reader deployment");

  const preflight = {
    mode: process.env.DEAL_GOVERNANCE_READER_DEPLOY === CONFIRM ? "write" : "dry-run",
    checkedAt: new Date().toISOString(),
    chainId,
    blockNumber: blockNumber.toString(),
    deployer: account.address,
    nonce: pendingNonce,
    balanceWei: balance.toString(),
    governance,
    proposalCount: proposalCount.toString(),
    predictedAddress,
    creationBytecodeHash: keccak256(artifact.bytecode),
    gasEstimate: gasEstimate.toString(),
    maxFeePerGasWei: feeEstimate.maxFeePerGas.toString(),
    maxDeploymentCostWei: maxDeploymentCost.toString(),
    maxDeploymentCostEth: formatEther(maxDeploymentCost),
  };
  console.log(JSON.stringify(preflight, null, 2));

  if (process.env.DEAL_GOVERNANCE_READER_DEPLOY !== CONFIRM) {
    console.log("DRY-RUN ONLY: no transaction sent.");
    return;
  }

  const hash = await walletClient.deployContract({
    account,
    chain: mainnet,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [governance],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Reader deployment failed: ${hash}`);
  if (!receipt.contractAddress || !sameAddress(receipt.contractAddress, predictedAddress)) {
    throw new Error(`Unexpected deployed address: ${String(receipt.contractAddress)}`);
  }

  const reader = {
    address: receipt.contractAddress,
    abi: artifact.abi,
  } as const;
  const [runtimeCode, configuredGovernance, maxPageSize, maxStateBatchSize, stats, proposal13] =
    await Promise.all([
      publicClient.getCode({ address: receipt.contractAddress }),
      publicClient.readContract({ ...reader, functionName: "governance" }),
      publicClient.readContract({ ...reader, functionName: "MAX_PAGE_SIZE" }),
      publicClient.readContract({ ...reader, functionName: "MAX_STATE_BATCH_SIZE" }),
      publicClient.readContract({ ...reader, functionName: "getGovernanceStats" }),
      publicClient.readContract({
        ...reader,
        functionName: "getProposalDetail",
        args: [13n, "0x0000000000000000000000000000000000000000"],
      }),
    ]);

  if (!runtimeCode || runtimeCode === "0x") throw new Error("Reader runtime code is empty");
  if (!sameAddress(configuredGovernance as Address, governance)) {
    throw new Error("Reader governance immutable mismatch");
  }
  if (maxPageSize !== 50n || maxStateBatchSize !== 100n) {
    throw new Error("Reader limits mismatch");
  }
  const returnedProposalCount = (stats as { proposalCount: bigint }).proposalCount;
  const proposal13View = (proposal13 as readonly [{ proposalId: bigint }, ...unknown[]])[0];
  if (returnedProposalCount !== proposalCount || proposal13View.proposalId !== 13n) {
    throw new Error("Reader live read verification failed");
  }

  console.log(JSON.stringify({
    deployed: true,
    address: receipt.contractAddress,
    transactionHash: hash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    governance: configuredGovernance,
    maxPageSize: maxPageSize.toString(),
    maxStateBatchSize: maxStateBatchSize.toString(),
    proposalCount: String(returnedProposalCount),
    proposal13Id: String(proposal13View.proposalId),
    runtimeCodeHash: keccak256(runtimeCode),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
