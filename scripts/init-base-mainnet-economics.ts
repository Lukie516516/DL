/**
 * Read-only by default. Set BASE_MAINNET_INITIALIZE=1 to execute the exact
 * Base launch allocation after the protocol deployment file exists.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  fallback,
  formatEther,
  getAddress,
  http,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { planBaseInitialization } from "./lib/base-initialization-plan.js";
import {
  BASE_LEGACY_POOL_PLANS,
  BASE_REAL_OTHER_SMALLEST_UNIT,
  BASE_TOTAL_INITIAL_DC,
  BASE_TREASURY_INITIAL_DC,
} from "./lib/base-launch-economics.js";
import { BASE_MAINNET } from "./lib/evm-chain-config.js";

type Deployment = {
  chainId: number;
  network: string;
  deployer: Address;
  rpcUrl?: string;
  addresses: Record<string, Address>;
  params?: Record<string, unknown>;
};

const DEFAULT_DEPLOYMENT_FILE = join("deployments", "base-mainnet-8453.json");
const WRITE_GATE = "BASE_MAINNET_INITIALIZE";
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const DEFAULT_MIN_BASE_ETH = "0.01";

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function mint(address,uint256)",
  "function MINTER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
]);
const wethAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function deposit() payable",
]);
const pairManagerAbi = parseAbi([
  "function owner() view returns (address)",
  "function pairForToken(address) view returns (address)",
  "function initPair(address,uint256) returns (uint256,uint256)",
]);
const pairAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function liquidityInited() view returns (bool)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function getVirtualReserves() view returns (uint256,uint256)",
  "function getEffectiveReserves() view returns (uint256,uint256,uint32)",
]);

function loadEnv() {
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match && !process.env[match[1].trim()]) process.env[match[1].trim()] = match[2].trim();
    }
  } catch {
    // Optional.
  }
}

function same(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function privateKey(): Hex {
  const raw = process.env.BASE_MAINNET_PRIVATE_KEY || process.env.AGIKING_PRIVATE_KEY;
  if (!raw) throw new Error("Missing BASE_MAINNET_PRIVATE_KEY or AGIKING_PRIVATE_KEY");
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

async function waitFor(publicClient: any, hash: Hex, label: string) {
  console.log(`${label}: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  return hash;
}

async function main() {
  loadEnv();
  const deploymentFile = process.env.BASE_DEPLOYMENT_FILE?.trim() || DEFAULT_DEPLOYMENT_FILE;
  if (!existsSync(deploymentFile)) {
    throw new Error(`Base deployment file does not exist yet: ${deploymentFile}`);
  }
  const deployment = JSON.parse(readFileSync(deploymentFile, "utf8")) as Deployment;
  if (deployment.chainId !== BASE_MAINNET.chainId || deployment.network !== "base-mainnet") {
    throw new Error(`Wrong deployment target: ${deployment.network}/${deployment.chainId}`);
  }
  if (deployment.params?.deployDao !== false) {
    throw new Error("Base must be deployed as a secondary chain with deployDao=false");
  }
  for (const forbidden of ["dToken", "dealGovernance", "satoshiVault", "voteDividendClaimer"]) {
    if (deployment.addresses[forbidden] && deployment.addresses[forbidden] !== ZERO) {
      throw new Error(`Secondary-chain deployment unexpectedly contains ${forbidden}`);
    }
  }

  const addresses = deployment.addresses;
  const dc = getAddress(addresses.dlToken);
  const treasury = getAddress(addresses.protocolTreasury);
  const pairManager = getAddress(addresses.dealPairManager);
  const expectedAssets: Record<string, Address> = {
    stable0: BASE_MAINNET.usdc,
    stable1: BASE_MAINNET.usdt,
    wrappedNative: BASE_MAINNET.weth,
  };
  for (const [key, expected] of Object.entries(expectedAssets)) {
    if (!addresses[key] || !same(addresses[key], expected)) {
      throw new Error(`${key} mismatch: ${addresses[key]} != ${expected}`);
    }
  }

  const rpc = process.env.BASE_MAINNET_RPC_URL?.trim()
    || deployment.rpcUrl
    || "https://mainnet.base.org";
  // viem 2.55's standalone TypeScript overloads currently require an internal
  // authorizationList field for every read. Runtime clients are unaffected.
  const publicClient: any = createPublicClient({
    chain: base,
    transport: fallback([http(rpc, { timeout: 30_000 }), http("https://mainnet.base.org")], { rank: false }),
  });
  if (await publicClient.getChainId() !== BASE_MAINNET.chainId) throw new Error("RPC is not Base mainnet");

  const [totalSupply, treasuryDcBalance, pairManagerOwner] = await Promise.all([
    publicClient.readContract({ address: dc, abi: erc20Abi, functionName: "totalSupply" }),
    publicClient.readContract({ address: dc, abi: erc20Abi, functionName: "balanceOf", args: [treasury] }),
    publicClient.readContract({ address: pairManager, abi: pairManagerAbi, functionName: "owner" }),
  ]);

  const poolRuntime = [];
  for (const expected of BASE_LEGACY_POOL_PLANS) {
    const pair = getAddress(addresses[expected.key]);
    const [mapped, token0, token1, initialized, dcBalance, otherBalance, virtual] = await Promise.all([
      publicClient.readContract({ address: pairManager, abi: pairManagerAbi, functionName: "pairForToken", args: [expected.token] }),
      publicClient.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
      publicClient.readContract({ address: pair, abi: pairAbi, functionName: "token1" }),
      publicClient.readContract({ address: pair, abi: pairAbi, functionName: "liquidityInited" }),
      publicClient.readContract({ address: dc, abi: erc20Abi, functionName: "balanceOf", args: [pair] }),
      publicClient.readContract({ address: expected.token, abi: erc20Abi, functionName: "balanceOf", args: [pair] }),
      publicClient.readContract({ address: pair, abi: pairAbi, functionName: "getVirtualReserves" }),
    ]);
    if (!same(mapped, pair)) throw new Error(`${expected.label} PairManager mapping mismatch`);
    if (!same(token0, dc) || !same(token1, expected.token)) {
      throw new Error(`${expected.label} token order mismatch`);
    }
    poolRuntime.push({
      key: expected.key,
      label: expected.label,
      pair,
      token: expected.token,
      initialized,
      dcBalance,
      otherBalance,
      virtualDc: virtual[0],
      virtualOther: virtual[1],
    });
  }

  const initializationRecorded = Boolean(deployment.params?.baseInitialEconomics);
  const plan = planBaseInitialization({
    initializationRecorded,
    totalSupply,
    treasuryDcBalance,
    pools: poolRuntime.map((pool) => ({
      key: pool.key,
      initialized: pool.initialized,
      dcBalance: pool.dcBalance,
      otherBalance: pool.otherBalance,
      virtualDc: pool.virtualDc,
      virtualOther: pool.virtualOther,
    })),
  });

  const output = {
    scope: "Base mainnet exact launch economics",
    mode: plan.auditOnly ? "audit-only: initialization already recorded" : "initialization plan",
    chainId: BASE_MAINNET.chainId,
    deploymentFile,
    deployer: getAddress(deployment.deployer),
    dc,
    treasury,
    pairManager,
    pairManagerOwner: getAddress(pairManagerOwner),
    currentTotalSupply: totalSupply.toString(),
    currentTreasuryDc: treasuryDcBalance.toString(),
    targetTotalSupply: BASE_TOTAL_INITIAL_DC.toString(),
    targetTreasuryDc: BASE_TREASURY_INITIAL_DC.toString(),
    plan: {
      auditOnly: plan.auditOnly,
      treasuryDcMint: plan.treasuryDcMint.toString(),
      totalDcMint: plan.totalDcMint.toString(),
      pools: plan.pools.map((pool) => ({
        ...pool,
        dcMint: pool.dcMint.toString(),
        otherTransfer: pool.otherTransfer.toString(),
        virtualOther: pool.virtualOther.toString(),
      })),
    },
  };
  console.log(JSON.stringify(output, null, 2));

  if (plan.auditOnly) return;
  if (process.env[WRITE_GATE] !== "1") {
    console.log(`Read-only complete. No transaction sent. Set ${WRITE_GATE}=1 only for approved execution.`);
    return;
  }

  const account = privateKeyToAccount(privateKey());
  if (!same(account.address, deployment.deployer)) {
    throw new Error(`Signer mismatch: ${account.address} != ${deployment.deployer}`);
  }
  if (!same(pairManagerOwner, account.address)) {
    throw new Error(`Signer is not PairManager owner: ${pairManagerOwner}`);
  }
  const minterRole = await publicClient.readContract({ address: dc, abi: erc20Abi, functionName: "MINTER_ROLE" });
  const canMint = await publicClient.readContract({
    address: dc,
    abi: erc20Abi,
    functionName: "hasRole",
    args: [minterRole, account.address],
  });
  if (!canMint) throw new Error("Signer does not have DC MINTER_ROLE");

  const minimumBaseEth = parseEther(
    process.env.BASE_MAINNET_MIN_ETH?.trim() || DEFAULT_MIN_BASE_ETH,
  );
  const nativeBalance = await publicClient.getBalance({ address: account.address });
  if (nativeBalance < minimumBaseEth) {
    throw new Error(
      `Base ETH below ${formatEther(minimumBaseEth)} safety floor: ${formatEther(nativeBalance)}`,
    );
  }
  console.log(`Base ETH execution balance: ${formatEther(nativeBalance)}; safety floor: ${formatEther(minimumBaseEth)}`);
  const requiredByToken = new Map<Address, bigint>();
  for (const action of plan.pools) {
    const runtime = poolRuntime.find((pool) => pool.key === action.key)!;
    requiredByToken.set(runtime.token, (requiredByToken.get(runtime.token) || 0n) + action.otherTransfer);
  }
  for (const [token, required] of requiredByToken) {
    if (token === BASE_MAINNET.weth) continue;
    const balance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    if (balance < required) throw new Error(`Signer lacks required counterasset ${token}: ${balance} < ${required}`);
  }

  const wallet: any = createWalletClient({ account, chain: base, transport: http(rpc, { timeout: 30_000 }) });
  let nextNonce = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  console.log(`Base execution nonce starts at: ${nextNonce}`);
  const transactions: Array<{ label: string; hash: Hex }> = [];
  async function send(label: string, hashPromise: Promise<Hex>) {
    const hash = await waitFor(publicClient, await hashPromise, label);
    transactions.push({ label, hash });
    nextNonce += 1;
  }

  if (plan.treasuryDcMint > 0n) {
    await send("DC.mint(Treasury)", wallet.writeContract({
      address: dc,
      abi: erc20Abi,
      functionName: "mint",
      args: [treasury, plan.treasuryDcMint],
      nonce: nextNonce,
    }));
  }
  for (const action of plan.pools) {
    if (!action.initialize) continue;
    const runtime = poolRuntime.find((pool) => pool.key === action.key)!;
    if (action.dcMint > 0n) {
      await send(`${action.label} DC.mint`, wallet.writeContract({
        address: dc,
        abi: erc20Abi,
        functionName: "mint",
        args: [runtime.pair, action.dcMint],
        nonce: nextNonce,
      }));
    }
    if (action.otherTransfer > 0n) {
      if (runtime.token === BASE_MAINNET.weth) {
        const wethBalance = await publicClient.readContract({
          address: runtime.token,
          abi: wethAbi,
          functionName: "balanceOf",
          args: [account.address],
        });
        if (wethBalance < action.otherTransfer) {
          await send("WETH.deposit", wallet.writeContract({
            address: runtime.token,
            abi: wethAbi,
            functionName: "deposit",
            value: action.otherTransfer - wethBalance,
            nonce: nextNonce,
          }));
        }
      }
      await send(`${action.label} counterasset.transfer`, wallet.writeContract({
        address: runtime.token,
        abi: erc20Abi,
        functionName: "transfer",
        args: [runtime.pair, action.otherTransfer],
        nonce: nextNonce,
      }));
    }
    await send(`${action.label} PairManager.initPair`, wallet.writeContract({
      address: pairManager,
      abi: pairManagerAbi,
      functionName: "initPair",
      args: [runtime.pair, action.virtualOther],
      nonce: nextNonce,
    }));
  }

  const [finalSupply, finalTreasury] = await Promise.all([
    publicClient.readContract({ address: dc, abi: erc20Abi, functionName: "totalSupply" }),
    publicClient.readContract({ address: dc, abi: erc20Abi, functionName: "balanceOf", args: [treasury] }),
  ]);
  if (finalSupply !== BASE_TOTAL_INITIAL_DC || finalTreasury !== BASE_TREASURY_INITIAL_DC) {
    throw new Error(`Final DC verification failed: supply=${finalSupply}, treasury=${finalTreasury}`);
  }
  const verifiedPools = [];
  for (const expected of BASE_LEGACY_POOL_PLANS) {
    const runtime = poolRuntime.find((pool) => pool.key === expected.key)!;
    const [initialized, reserves, virtuals, effective] = await Promise.all([
      publicClient.readContract({ address: runtime.pair, abi: pairAbi, functionName: "liquidityInited" }),
      publicClient.readContract({ address: runtime.pair, abi: pairAbi, functionName: "getReserves" }),
      publicClient.readContract({ address: runtime.pair, abi: pairAbi, functionName: "getVirtualReserves" }),
      publicClient.readContract({ address: runtime.pair, abi: pairAbi, functionName: "getEffectiveReserves" }),
    ]);
    const expectedVirtual = expected.effectiveOther - BASE_REAL_OTHER_SMALLEST_UNIT;
    if (!initialized
      || reserves[0] !== expected.realDc
      || reserves[1] !== BASE_REAL_OTHER_SMALLEST_UNIT
      || virtuals[0] !== 0n
      || virtuals[1] !== expectedVirtual
      || effective[0] !== expected.realDc
      || effective[1] !== expected.effectiveOther) {
      throw new Error(`${expected.label} final reserve verification failed`);
    }
    verifiedPools.push({
      label: expected.label,
      pair: runtime.pair,
      reserves: [reserves[0].toString(), reserves[1].toString()],
      virtualReserves: [virtuals[0].toString(), virtuals[1].toString()],
      effectiveReserves: [effective[0].toString(), effective[1].toString()],
    });
  }

  const initializedAt = new Date().toISOString();
  const record = {
    initializedAt,
    mode: "ETH legacy parity: real DC + 1 smallest counterasset unit + virtual counterasset reserve",
    noSatoshiAccount: true,
    treasuryDc: finalTreasury.toString(),
    totalSupply: finalSupply.toString(),
    pools: verifiedPools,
    transactions,
  };
  const backupDir = join(dirname(deploymentFile), "backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = initializedAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  copyFileSync(deploymentFile, join(backupDir, `base-mainnet-8453.before-economics-${stamp}.json`));
  deployment.params = { ...(deployment.params || {}), baseInitialEconomics: record };
  writeFileSync(deploymentFile, `${JSON.stringify(deployment, null, 2)}\n`, "utf8");
  writeFileSync(
    join(dirname(deploymentFile), `base-mainnet-economics-${stamp}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  console.log(`Initialization verified and recorded in ${deploymentFile}`);
}

await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
