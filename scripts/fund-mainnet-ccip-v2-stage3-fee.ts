/**
 * One-purpose Ethereum mainnet funding script for CCIP V2 migration stage 3.
 *
 * Default mode is read-only. Write mode can only mint the current exact Major
 * proposal fee to the recorded proposer. It has no approve, proposal, stake,
 * execute, bridge, deployment, or configuration path.
 *
 * Write gate:
 *   CCIP_V2_STAGE3_FEE_MINT=MINT_EXACT_STAGE3_MAJOR_FEE_TO_PROPOSER
 *   node node_modules/hardhat/dist/src/cli.js run \
 *     scripts/fund-mainnet-ccip-v2-stage3-fee.ts --network ethMainnet
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { network } from "hardhat";
import {
  encodeFunctionData,
  formatEther,
  getAddress,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from "viem";

const DEPLOYMENT_FILE = "deployments/eth-mainnet-1.json";
const OUTPUT_FILE = "deployments/ccip-v2-mainnet-stage3-fee.json";
const WRITE_CONFIRM = "MINT_EXACT_STAGE3_MAJOR_FEE_TO_PROPOSER";
const EXPECTED_MAJOR_FEE = parseEther("1000");
const EXPECTED_PROPOSAL_COUNT = 12n;

type Deployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
};

const governanceAbi = parseAbi([
  "function dcToken() view returns (address)",
  "function majorProposalFee() view returns (uint256)",
  "function proposalCount() view returns (uint256)",
]);

const tokenAbi = parseAbi([
  "function MINTER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function paused() view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function mint(address,uint256)",
]);

function loadDeployment(): Deployment {
  return JSON.parse(
    readFileSync(join(process.cwd(), DEPLOYMENT_FILE), "utf8")
  ) as Deployment;
}

function sameAddress(a: unknown, b: Address): boolean {
  return String(a).toLowerCase() === b.toLowerCase();
}

async function nonceState(client: any, address: Address) {
  const [latest, pending] = await Promise.all([
    client.getTransactionCount({ address, blockTag: "latest" }),
    client.getTransactionCount({ address, blockTag: "pending" }),
  ]);
  return { latest, pending };
}

async function main() {
  const deployment = loadDeployment();
  if (deployment.chainId !== 1)
    throw new Error("Deployment is not Ethereum mainnet");
  if (existsSync(join(process.cwd(), OUTPUT_FILE))) {
    throw new Error(
      `Stage 3 fee funding record already exists: ${OUTPUT_FILE}`
    );
  }

  const governance = getAddress(deployment.addresses.dealGovernance);
  const dc = getAddress(deployment.addresses.dlToken);
  const expectedProposer = getAddress(deployment.deployer);
  const writeEnabled = process.env.CCIP_V2_STAGE3_FEE_MINT === WRITE_CONFIRM;

  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  if ((await publicClient.getChainId()) !== 1) {
    throw new Error("Refusing non-Ethereum-mainnet network");
  }
  for (const [label, address] of [
    ["DealGovernance", governance],
    ["DC", dc],
  ] as const) {
    const code = await publicClient.getCode({ address });
    if (!code || code === "0x")
      throw new Error(`${label} has no code at ${address}`);
  }
  const wallets = await viem.getWalletClients();
  const wallet = wallets[0];
  if (!wallet) throw new Error("Configured Ethereum wallet is required");
  const proposer = getAddress(wallet.account.address);
  if (!sameAddress(proposer, expectedProposer)) {
    throw new Error(
      `Configured wallet ${proposer} is not recorded proposer ${expectedProposer}`
    );
  }

  const nonce = await nonceState(publicClient, proposer);
  if (nonce.latest !== nonce.pending)
    throw new Error("Proposer has pending transactions");
  const minterRole = await publicClient.readContract({
    address: dc,
    abi: tokenAbi,
    functionName: "MINTER_ROLE",
  });
  const [
    chainDc,
    majorFee,
    proposalCount,
    canMint,
    paused,
    supplyBefore,
    balanceBefore,
    allowanceBefore,
    nativeBalance,
  ] = await Promise.all([
    publicClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "dcToken",
    }),
    publicClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "majorProposalFee",
    }),
    publicClient.readContract({
      address: governance,
      abi: governanceAbi,
      functionName: "proposalCount",
    }),
    publicClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "hasRole",
      args: [minterRole, proposer],
    }),
    publicClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "paused",
    }),
    publicClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "totalSupply",
    }),
    publicClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [proposer],
    }),
    publicClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [proposer, governance],
    }),
    publicClient.getBalance({ address: proposer }),
  ]);
  if (!sameAddress(chainDc, dc))
    throw new Error("DealGovernance DC address mismatch");
  if (majorFee !== EXPECTED_MAJOR_FEE) {
    throw new Error(`Major fee changed: ${majorFee} != ${EXPECTED_MAJOR_FEE}`);
  }
  if (proposalCount !== EXPECTED_PROPOSAL_COUNT) {
    throw new Error(
      `proposalCount changed: ${proposalCount} != ${EXPECTED_PROPOSAL_COUNT}`
    );
  }
  if (!canMint)
    throw new Error("Configured proposer does not hold DC MINTER_ROLE");
  if (paused) throw new Error("DC is paused");
  if (balanceBefore !== 0n || allowanceBefore !== 0n) {
    throw new Error(
      `Expected zero proposer DC/allowance before exact funding, got ${balanceBefore}/${allowanceBefore}`
    );
  }
  if (nativeBalance === 0n) throw new Error("Proposer has no ETH for gas");

  const mintData = encodeFunctionData({
    abi: tokenAbi,
    functionName: "mint",
    args: [proposer, majorFee],
  });
  await publicClient.simulateContract({
    account: proposer,
    address: dc,
    abi: tokenAbi,
    functionName: "mint",
    args: [proposer, majorFee],
  });
  console.log("=== CCIP V2 stage 3 fee funding preflight ===");
  console.log(`Block: ${await publicClient.getBlockNumber()}`);
  console.log(
    `Proposer: ${proposer}; nonce latest=${nonce.latest}, pending=${nonce.pending}`
  );
  console.log(`Major fee: ${formatEther(majorFee)} DC`);
  console.log(
    `DC balance/allowance before: ${formatEther(balanceBefore)}/${formatEther(
      allowanceBefore
    )} DC`
  );
  console.log(`Total supply before: ${formatEther(supplyBefore)} DC`);
  console.log(`Exact mint calldata: ${mintData}`);

  if (!writeEnabled) {
    console.log("DRY-RUN ONLY: no transaction was signed or sent.");
    return;
  }

  const client = { public: publicClient, wallet } as const;
  const token = await viem.getContractAt("DCToken", dc, { client });
  console.log(
    "--- MAINNET WRITE: mint exact one-time Major fee to proposer ---"
  );
  const hash = await token.write.mint([proposer, majorFee]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success")
    throw new Error(`Exact fee mint failed: ${hash}`);
  const tx = await publicClient.getTransaction({ hash });
  if (!sameAddress(tx.from, proposer) || !sameAddress(tx.to, dc)) {
    throw new Error("Mint transaction from/to mismatch");
  }
  if (tx.input.toLowerCase() !== mintData.toLowerCase()) {
    throw new Error("Mint transaction calldata mismatch");
  }
  const [supplyAfter, balanceAfter, allowanceAfter, proposalCountAfter] =
    await Promise.all([
      publicClient.readContract({
        address: dc,
        abi: tokenAbi,
        functionName: "totalSupply",
      }),
      publicClient.readContract({
        address: dc,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [proposer],
      }),
      publicClient.readContract({
        address: dc,
        abi: tokenAbi,
        functionName: "allowance",
        args: [proposer, governance],
      }),
      publicClient.readContract({
        address: governance,
        abi: governanceAbi,
        functionName: "proposalCount",
      }),
    ]);
  if (supplyAfter !== supplyBefore + majorFee)
    throw new Error("DC total supply delta mismatch");
  if (balanceAfter !== majorFee)
    throw new Error("Proposer did not receive the exact Major fee");
  if (allowanceAfter !== 0n)
    throw new Error("Mint unexpectedly changed allowance");
  if (proposalCountAfter !== proposalCount)
    throw new Error("Mint unexpectedly changed proposalCount");

  const state = {
    schemaVersion: 1,
    scope:
      "mint exactly one current Major proposal fee to the recorded stage 3 proposer only",
    stage: "fee_funded",
    executedAt: new Date().toISOString(),
    chainId: 1,
    blockNumber: receipt.blockNumber.toString(),
    proposer,
    governance,
    dc,
    amountWei: majorFee.toString(),
    transaction: {
      hash,
      nonce: tx.nonce,
      from: tx.from,
      to: tx.to,
      calldataMatched: true,
      receiptSuccess: true,
    },
    before: {
      totalSupplyWei: supplyBefore.toString(),
      proposerBalanceWei: balanceBefore.toString(),
      allowanceWei: allowanceBefore.toString(),
      proposalCount: proposalCount.toString(),
    },
    after: {
      totalSupplyWei: supplyAfter.toString(),
      proposerBalanceWei: balanceAfter.toString(),
      allowanceWei: allowanceAfter.toString(),
      proposalCount: proposalCountAfter.toString(),
    },
  };
  writeFileSync(
    join(process.cwd(), OUTPUT_FILE),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8"
  );
  console.log(`OK exact fee mint: ${hash}`);
  console.log(`Wrote ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
