/**
 * One-purpose ETH mainnet funding script.
 *
 * Dry-run (default):
 *   node --import tsx/esm scripts/fund-eth-mainnet-dc-reserves.ts
 *
 * Exact authorized write:
 *   ETH_DC_RESERVES_CONFIRM=MINT_5B_DC_TO_ETH_TREASURY_AND_50B_DC_TO_SATOSHI_VAULT \
 *     node --import tsx/esm scripts/fund-eth-mainnet-dc-reserves.ts execute
 *
 * There is no transfer, proposal, stake, execute, upgrade, or cross-chain path.
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
import { mainnet } from "viem/chains";

const CONFIRM = "MINT_5B_DC_TO_ETH_TREASURY_AND_50B_DC_TO_SATOSHI_VAULT";
const TREASURY_AMOUNT = parseUnits("5000000000", 18);
const SATOSHI_AMOUNT = parseUnits("50000000000", 18);
const EXPECTED_TREASURY_BEFORE = parseUnits("3900", 18);
const EXPECTED_SATOSHI_BEFORE = 0n;
const OUTPUT = join(process.cwd(), "deployments", "eth-mainnet-dc-reserves-20260722.json");

type Deployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
};

const tokenAbi = parseAbi([
  "function MINTER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function paused() view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address,uint256)",
]);
const treasuryAbi = parseAbi([
  "function controller() view returns (address)",
  "function bootstrapLocked() view returns (bool)",
]);
const satoshiAbi = parseAbi([
  "function controller() view returns (address)",
  "function dealCoin() view returns (address)",
]);

function loadEnv() {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
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
    readFileSync(join(process.cwd(), "deployments", "eth-mainnet-1.json"), "utf8"),
  ) as Deployment;
  if (deployment.chainId !== 1) throw new Error("Deployment is not Ethereum mainnet");

  const rpc = process.env.ETH_MAINNET_RPC_URL?.trim();
  const rawKey = process.env.ETH_MAINNET_PRIVATE_KEY?.trim() || process.env.AGIKING_PRIVATE_KEY?.trim();
  if (!rpc || !rawKey) throw new Error("Missing ETH mainnet RPC or private key");
  const account = privateKeyToAccount((rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex);
  if (!sameAddress(account.address, deployment.deployer)) throw new Error("Configured wallet is not recorded deployer");

  const governance = getAddress(deployment.addresses.dealGovernance);
  const dc = getAddress(deployment.addresses.dlToken);
  const treasury = getAddress(deployment.addresses.protocolTreasury);
  const satoshiVault = getAddress(deployment.addresses.satoshiVault);
  const publicClient = createPublicClient({ chain: mainnet, transport: http(rpc) });
  const walletClient = createWalletClient({ account, chain: mainnet, transport: http(rpc) });

  const [chainId, blockNumber, nonce, pending, treasuryCode, satoshiCode, minterRole] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlockNumber(),
    publicClient.getTransactionCount({ address: account.address }),
    publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
    publicClient.getCode({ address: treasury }),
    publicClient.getCode({ address: satoshiVault }),
    publicClient.readContract({ address: dc, abi: tokenAbi, functionName: "MINTER_ROLE" }),
  ]);
  if (chainId !== 1 || nonce !== pending) throw new Error("Wrong chain or wallet has pending transactions");
  if (!treasuryCode || treasuryCode === "0x" || !satoshiCode || satoshiCode === "0x") {
    throw new Error("Funding target has no code");
  }

  const [canMint, paused, treasuryController, locked, satoshiController, satoshiDc,
    supplyBefore, treasuryBefore, satoshiBefore] = await Promise.all([
      publicClient.readContract({ address: dc, abi: tokenAbi, functionName: "hasRole", args: [minterRole, account.address] }),
      publicClient.readContract({ address: dc, abi: tokenAbi, functionName: "paused" }),
      publicClient.readContract({ address: treasury, abi: treasuryAbi, functionName: "controller" }),
      publicClient.readContract({ address: treasury, abi: treasuryAbi, functionName: "bootstrapLocked" }),
      publicClient.readContract({ address: satoshiVault, abi: satoshiAbi, functionName: "controller" }),
      publicClient.readContract({ address: satoshiVault, abi: satoshiAbi, functionName: "dealCoin" }),
      publicClient.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
      publicClient.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
      publicClient.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [satoshiVault] }),
    ]);
  if (!canMint || paused) throw new Error("Wallet cannot mint or DC is paused");
  if (!sameAddress(treasuryController, governance) || !locked) throw new Error("Treasury governance wiring mismatch");
  if (!sameAddress(satoshiController, governance) || !sameAddress(satoshiDc, dc)) {
    throw new Error("SatoshiVault governance/DC wiring mismatch");
  }
  if (treasuryBefore !== EXPECTED_TREASURY_BEFORE || satoshiBefore !== EXPECTED_SATOSHI_BEFORE) {
    throw new Error(`Unexpected target balances ${treasuryBefore}/${satoshiBefore}; refusing possible duplicate mint`);
  }
  if (existsSync(OUTPUT)) throw new Error(`Funding record already exists: ${OUTPUT}`);

  await Promise.all([
    publicClient.simulateContract({ account: account.address, address: dc, abi: tokenAbi, functionName: "mint", args: [treasury, TREASURY_AMOUNT] }),
    publicClient.simulateContract({ account: account.address, address: dc, abi: tokenAbi, functionName: "mint", args: [satoshiVault, SATOSHI_AMOUNT] }),
  ]);

  const snapshot = {
    dryRun: process.argv[2] !== "execute",
    checkedAt: new Date().toISOString(),
    chainId,
    blockNumber: blockNumber.toString(),
    wallet: account.address,
    nonce,
    dc,
    before: {
      totalSupply: supplyBefore.toString(),
      treasury: { address: treasury, balance: treasuryBefore.toString() },
      satoshiVault: { address: satoshiVault, balance: satoshiBefore.toString() },
    },
    mint: {
      treasury: TREASURY_AMOUNT.toString(),
      satoshiVault: SATOSHI_AMOUNT.toString(),
    },
    afterExpected: {
      totalSupply: (supplyBefore + TREASURY_AMOUNT + SATOSHI_AMOUNT).toString(),
      treasury: (treasuryBefore + TREASURY_AMOUNT).toString(),
      satoshiVault: (satoshiBefore + SATOSHI_AMOUNT).toString(),
    },
  };
  console.log(JSON.stringify(snapshot, null, 2));
  if (process.argv[2] !== "execute") {
    console.log("DRY-RUN ONLY: no transaction sent.");
    return;
  }
  if (process.env.ETH_DC_RESERVES_CONFIRM !== CONFIRM) throw new Error("Missing exact funding confirmation");

  const treasuryHash = await walletClient.writeContract({
    account,
    chain: mainnet,
    address: dc,
    abi: tokenAbi,
    functionName: "mint",
    args: [treasury, TREASURY_AMOUNT],
  });
  const treasuryReceipt = await publicClient.waitForTransactionReceipt({ hash: treasuryHash });
  if (treasuryReceipt.status !== "success") throw new Error(`Treasury mint failed: ${treasuryHash}`);
  const [supplyAfterTreasury, treasuryAfter] = await Promise.all([
    publicClient.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    publicClient.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
  ]);
  if (supplyAfterTreasury !== supplyBefore + TREASURY_AMOUNT || treasuryAfter !== treasuryBefore + TREASURY_AMOUNT) {
    throw new Error("Treasury mint post-state mismatch");
  }
  console.log(`OK treasury mint: ${treasuryHash}`);

  const satoshiHash = await walletClient.writeContract({
    account,
    chain: mainnet,
    address: dc,
    abi: tokenAbi,
    functionName: "mint",
    args: [satoshiVault, SATOSHI_AMOUNT],
  });
  const satoshiReceipt = await publicClient.waitForTransactionReceipt({ hash: satoshiHash });
  if (satoshiReceipt.status !== "success") throw new Error(`SatoshiVault mint failed: ${satoshiHash}`);
  const [supplyAfter, treasuryAfterFinal, satoshiAfter] = await Promise.all([
    publicClient.readContract({ address: dc, abi: tokenAbi, functionName: "totalSupply" }),
    publicClient.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [treasury] }),
    publicClient.readContract({ address: dc, abi: tokenAbi, functionName: "balanceOf", args: [satoshiVault] }),
  ]);
  if (supplyAfter !== supplyBefore + TREASURY_AMOUNT + SATOSHI_AMOUNT ||
      treasuryAfterFinal !== treasuryBefore + TREASURY_AMOUNT || satoshiAfter !== SATOSHI_AMOUNT) {
    throw new Error("Final exact funding state mismatch");
  }

  const result = {
    ...snapshot,
    dryRun: false,
    executedAt: new Date().toISOString(),
    transactions: {
      treasury: { hash: treasuryHash, blockNumber: treasuryReceipt.blockNumber.toString() },
      satoshiVault: { hash: satoshiHash, blockNumber: satoshiReceipt.blockNumber.toString() },
    },
    after: {
      totalSupply: supplyAfter.toString(),
      treasury: { address: treasury, balance: treasuryAfterFinal.toString() },
      satoshiVault: { address: satoshiVault, balance: satoshiAfter.toString() },
    },
    display: {
      totalSupply: formatUnits(supplyAfter, 18),
      treasury: formatUnits(treasuryAfterFinal, 18),
      satoshiVault: formatUnits(satoshiAfter, 18),
    },
  };
  writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`OK SatoshiVault mint: ${satoshiHash}`);
  console.log(`Wrote ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
