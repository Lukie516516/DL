/**
 * One-purpose BSC mainnet Treasury funding script.
 *
 * Default mode is a strict read-only dry-run.
 * Exact authorized write:
 *
 * BSC_TREASURY_DC_CONFIRM=MINT_5B_DC_TO_BSC_TREASURY \
 *   node --import tsx/esm scripts/fund-bsc-mainnet-dc-treasury.ts execute
 *
 * There is no controller change, bootstrap lock, transfer, proposal, upgrade,
 * cross-chain message, SatoshiVault deployment, or second mint path.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";

const CONFIRM = "MINT_5B_DC_TO_BSC_TREASURY";
const BSC_MIN_GAS_PRICE = 50_000_000n;
const MINT_AMOUNT = parseUnits("5000000000", 18);
const EXPECTED_TREASURY_BEFORE = parseUnits("500", 18);
const EXPECTED_SUPPLY_BEFORE = 1004999998333335185183127575n;
const OUTPUT = join(
  process.cwd(),
  "deployments",
  "bsc-mainnet-dc-treasury-reserve-20260723.json",
);

type Deployment = {
  chainId: number;
  deployer: Address;
  rpcUrl?: string;
  addresses: Record<string, Address>;
};

const tokenAbi = parseAbi([
  "function MINTER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function paused() view returns (bool)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address,uint256)",
]);

const treasuryAbi = parseAbi([
  "function controller() view returns (address)",
  "function bootstrapAdmin() view returns (address)",
  "function bootstrapLocked() view returns (bool)",
]);

function loadEnv() {
  for (const line of readFileSync(join(process.cwd(), ".env"), "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] ||= match[2].trim();
  }
}

function sameAddress(a: unknown, b: Address) {
  return String(a).toLowerCase() === b.toLowerCase();
}

async function main() {
  loadEnv();

  const deployment = JSON.parse(
    readFileSync(join(process.cwd(), "deployments", "bsc-mainnet-56.json"), "utf8"),
  ) as Deployment;
  if (deployment.chainId !== 56) throw new Error("Deployment is not BSC mainnet");

  const rpc = process.env.BSC_MAINNET_RPC_URL?.trim() || deployment.rpcUrl?.trim();
  const rawKey = process.env.BSC_MAINNET_PRIVATE_KEY?.trim()
    || process.env.AGIKING_PRIVATE_KEY?.trim();
  if (!rpc || !rawKey) throw new Error("Missing BSC mainnet RPC or private key");

  const account = privateKeyToAccount(
    (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex,
  );
  if (!sameAddress(account.address, getAddress(deployment.deployer))) {
    throw new Error("Configured signer is not the recorded BSC deployer");
  }

  const dc = getAddress(deployment.addresses.dlToken);
  const treasury = getAddress(deployment.addresses.protocolTreasury);
  const publicClient = createPublicClient({ chain: bsc, transport: http(rpc) });
  const walletClient = createWalletClient({ account, chain: bsc, transport: http(rpc) });

  const [chainId, blockNumber, latestNonce, pendingNonce, treasuryCode, minterRole] =
    await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlockNumber(),
      publicClient.getTransactionCount({ address: account.address, blockTag: "latest" }),
      publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
      publicClient.getCode({ address: treasury }),
      publicClient.readContract({ address: dc, abi: tokenAbi, functionName: "MINTER_ROLE" }),
    ]);
  if (chainId !== 56) throw new Error(`Wrong chain ${chainId}`);
  if (latestNonce !== pendingNonce) throw new Error("Signer has pending transactions");
  if (!treasuryCode || treasuryCode === "0x") throw new Error("BSC Treasury has no code");
  if (existsSync(OUTPUT)) throw new Error(`Funding record already exists: ${OUTPUT}`);

  const [canMint, paused, decimals, supplyBefore, treasuryBefore, controller, bootstrapAdmin, bootstrapLocked] =
    await Promise.all([
      publicClient.readContract({
        address: dc,
        abi: tokenAbi,
        functionName: "hasRole",
        args: [minterRole, account.address],
      }),
      publicClient.readContract({ address: dc, abi: tokenAbi, functionName: "paused" }),
      publicClient.readContract({ address: dc, abi: tokenAbi, functionName: "decimals" }),
      publicClient.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
      publicClient.readContract({
        address: dc,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [treasury],
      }),
      publicClient.readContract({ address: treasury, abi: treasuryAbi, functionName: "controller" }),
      publicClient.readContract({ address: treasury, abi: treasuryAbi, functionName: "bootstrapAdmin" }),
      publicClient.readContract({ address: treasury, abi: treasuryAbi, functionName: "bootstrapLocked" }),
    ]);

  if (!canMint || paused) throw new Error("Signer cannot mint or BSC DC is paused");
  if (decimals !== 18) throw new Error(`Unexpected BSC DC decimals: ${decimals}`);
  if (supplyBefore !== EXPECTED_SUPPLY_BEFORE) {
    throw new Error(`Unexpected supply before mint: ${supplyBefore}`);
  }
  if (treasuryBefore !== EXPECTED_TREASURY_BEFORE) {
    throw new Error(`Unexpected Treasury balance before mint: ${treasuryBefore}`);
  }
  if (!sameAddress(controller, account.address) || !sameAddress(bootstrapAdmin, account.address)) {
    throw new Error("Unexpected BSC Treasury controller/bootstrap admin");
  }

  await publicClient.simulateContract({
    account: account.address,
    address: dc,
    abi: tokenAbi,
    functionName: "mint",
    args: [treasury, MINT_AMOUNT],
  });

  const snapshot = {
    dryRun: process.argv[2] !== "execute",
    checkedAt: new Date().toISOString(),
    chainId,
    blockNumber: blockNumber.toString(),
    signer: account.address,
    nonce: pendingNonce,
    dc,
    treasury: {
      address: treasury,
      controller,
      bootstrapAdmin,
      bootstrapLocked,
    },
    before: {
      totalSupply: supplyBefore.toString(),
      treasuryBalance: treasuryBefore.toString(),
    },
    mintAmount: MINT_AMOUNT.toString(),
    afterExpected: {
      totalSupply: (supplyBefore + MINT_AMOUNT).toString(),
      treasuryBalance: (treasuryBefore + MINT_AMOUNT).toString(),
    },
    display: {
      beforeSupplyDC: formatUnits(supplyBefore, 18),
      beforeTreasuryDC: formatUnits(treasuryBefore, 18),
      mintDC: formatUnits(MINT_AMOUNT, 18),
      afterSupplyDC: formatUnits(supplyBefore + MINT_AMOUNT, 18),
      afterTreasuryDC: formatUnits(treasuryBefore + MINT_AMOUNT, 18),
    },
  };
  console.log(JSON.stringify(snapshot, null, 2));

  if (process.argv[2] !== "execute") {
    console.log("DRY-RUN ONLY: no transaction sent.");
    return;
  }
  if (process.env.BSC_TREASURY_DC_CONFIRM !== CONFIRM) {
    throw new Error("Missing exact BSC Treasury funding confirmation");
  }

  const hash = await walletClient.writeContract({
    account,
    chain: bsc,
    address: dc,
    abi: tokenAbi,
    functionName: "mint",
    args: [treasury, MINT_AMOUNT],
    gasPrice: BSC_MIN_GAS_PRICE,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`BSC Treasury mint failed: ${hash}`);

  const [supplyAfter, treasuryAfter] = await Promise.all([
    publicClient.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    publicClient.readContract({
      address: dc,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [treasury],
    }),
  ]);
  if (
    supplyAfter !== supplyBefore + MINT_AMOUNT
    || treasuryAfter !== treasuryBefore + MINT_AMOUNT
  ) {
    throw new Error("BSC Treasury mint post-state mismatch");
  }

  const result = {
    ...snapshot,
    dryRun: false,
    executedAt: new Date().toISOString(),
    transaction: {
      hash,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      status: receipt.status,
    },
    after: {
      totalSupply: supplyAfter.toString(),
      treasuryBalance: treasuryAfter.toString(),
    },
    displayAfter: {
      totalSupplyDC: formatUnits(supplyAfter, 18),
      treasuryBalanceDC: formatUnits(treasuryAfter, 18),
    },
  };
  writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
  console.log(`Wrote ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
