import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatUnits, http, parseUnits } from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

type Address = `0x${string}`;

const DEPLOYMENT_FILE = "deployments/eth-mainnet-1.json";
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const REAL_OTHER = 1n;

function loadDotenv() {
  try {
    for (const line of readFileSync(".env", "utf8").split(/\n/)) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
    }
  } catch {
    // .env is optional.
  }
}

function privateKey(): `0x${string}` {
  const raw = process.env.ETH_MAINNET_PRIVATE_KEY || process.env.AGIKING_PRIVATE_KEY;
  if (!raw) throw new Error("Missing ETH_MAINNET_PRIVATE_KEY or AGIKING_PRIVATE_KEY");
  return raw.startsWith("0x") ? (raw as `0x${string}`) : `0x${raw}`;
}

function same(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

async function waitFor(publicClient: ReturnType<typeof createPublicClient>, hash: Address, label: string) {
  console.log(`${label}: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  return receipt;
}

const erc20Abi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "MINTER_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] },
] as const;

const ownableAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const wethAbi = [
  ...erc20Abi,
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
] as const;

const pairManagerAbi = [
  { type: "function", name: "initPair", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "pairForToken", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
] as const;

const pairAbi = [
  { type: "function", name: "liquidityInited", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }] },
  { type: "function", name: "getVirtualReserves", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "getEffectiveReserves", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint32" }] },
] as const;

async function main() {
  loadDotenv();

  const rpc = process.env.ETH_MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com";
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
  const addresses = deployment.addresses as Record<string, Address>;
  const account = privateKeyToAccount(privateKey());
  const publicClient = createPublicClient({ chain: mainnet, transport: http(rpc, { timeout: 30_000 }) });
  const wallet = createWalletClient({ account, chain: mainnet, transport: http(rpc, { timeout: 30_000 }) });

  const chainId = await publicClient.getChainId();
  if (chainId !== 1) throw new Error(`Wrong chain: ${chainId}`);
  if (!same(account.address, deployment.deployer)) {
    throw new Error(`Wrong deployer: ${account.address}; expected ${deployment.deployer}`);
  }

  const pairManagerOwner = await publicClient.readContract({
    address: addresses.dealPairManager,
    abi: ownableAbi,
    functionName: "owner",
  });
  if (!same(pairManagerOwner, account.address)) {
    throw new Error(`Signer is not PairManager owner: ${pairManagerOwner}`);
  }

  const minterRole = await publicClient.readContract({
    address: addresses.dlToken,
    abi: erc20Abi,
    functionName: "MINTER_ROLE",
  });
  const canMint = await publicClient.readContract({
    address: addresses.dlToken,
    abi: erc20Abi,
    functionName: "hasRole",
    args: [minterRole, account.address],
  });
  if (!canMint) throw new Error("Signer does not have DC MINTER_ROLE");

  const nativeBalance = await publicClient.getBalance({ address: account.address });
  if (nativeBalance <= parseUnits("0.005", 18)) {
    throw new Error(`ETH balance too low for safe initialization: ${formatUnits(nativeBalance, 18)}`);
  }

  const pairPlans = [
    {
      label: "DC/USDC",
      pairKey: "pairStable0",
      tokenKey: "stable0",
      realDc: parseUnits("5000000", 18),
      targetOther: "500",
    },
    {
      label: "DC/USDT",
      pairKey: "pairStable1",
      tokenKey: "stable1",
      realDc: parseUnits("500000000", 18),
      targetOther: "50000",
    },
    {
      label: "DC/WETH",
      pairKey: "pairWrappedNative",
      tokenKey: "wrappedNative",
      realDc: parseUnits("500000000", 18),
      targetOther: "32",
      wrapNative: true,
    },
  ];

  const results: Record<string, unknown> = {};

  for (const plan of pairPlans) {
    const pair = addresses[plan.pairKey];
    const token = addresses[plan.tokenKey];
    if (!pair || pair === ZERO) throw new Error(`${plan.label} pair missing`);
    if (!token || token === ZERO) throw new Error(`${plan.label} token missing`);

    const mapped = await publicClient.readContract({
      address: addresses.dealPairManager,
      abi: pairManagerAbi,
      functionName: "pairForToken",
      args: [token],
    });
    if (!same(mapped, pair)) throw new Error(`${plan.label} pair mapping mismatch: ${mapped} != ${pair}`);

    const [t0, t1, inited] = await Promise.all([
      publicClient.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
      publicClient.readContract({ address: pair, abi: pairAbi, functionName: "token1" }),
      publicClient.readContract({ address: pair, abi: pairAbi, functionName: "liquidityInited" }),
    ]);
    if (!same(t0, addresses.dlToken)) throw new Error(`${plan.label} token0 is not DC: ${t0}`);
    if (!same(t1, token)) throw new Error(`${plan.label} token1 mismatch: ${t1}`);

    const decimals = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    });
    const symbol = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "symbol",
    }).catch(() => plan.label.split("/")[1]);
    const targetOther = parseUnits(plan.targetOther, decimals);
    if (targetOther <= REAL_OTHER) throw new Error(`${plan.label} target other too small`);
    const virtualOther = targetOther - REAL_OTHER;

    console.log(`\n${plan.label}`);
    console.log(`pair=${pair}`);
    console.log(`realDC=${formatUnits(plan.realDc, 18)} DC`);
    console.log(`realOther=${REAL_OTHER.toString()} smallest unit ${symbol}`);
    console.log(`virtualOther=${formatUnits(virtualOther, decimals)} ${symbol}`);

    if (inited) {
      console.log(`${plan.label} already initialized, skip.`);
    } else {
      await waitFor(
        publicClient,
        await wallet.writeContract({
          address: addresses.dlToken,
          abi: erc20Abi,
          functionName: "mint",
          args: [pair, plan.realDc],
        }),
        `${plan.label} DC.mint(pair)`,
      );

      if (plan.wrapNative) {
        await waitFor(
          publicClient,
          await wallet.writeContract({
            address: token,
            abi: wethAbi,
            functionName: "deposit",
            value: REAL_OTHER,
          }),
          `${plan.label} WETH.deposit(1 wei)`,
        );
      }

      await waitFor(
        publicClient,
        await wallet.writeContract({
          address: token,
          abi: erc20Abi,
          functionName: "transfer",
          args: [pair, REAL_OTHER],
        }),
        `${plan.label} token.transfer(pair, 1 smallest unit)`,
      );

      await waitFor(
        publicClient,
        await wallet.writeContract({
          address: addresses.dealPairManager,
          abi: pairManagerAbi,
          functionName: "initPair",
          args: [pair, virtualOther],
        }),
        `${plan.label} PairManager.initPair`,
      );
    }

    const [reserves, virtuals, effective] = await Promise.all([
      publicClient.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" }),
      publicClient.readContract({ address: pair, abi: pairAbi, functionName: "getVirtualReserves" }),
      publicClient.readContract({ address: pair, abi: pairAbi, functionName: "getEffectiveReserves" }),
    ]);
    console.log(`${plan.label} reserves=${reserves.map(String).join(",")}`);
    console.log(`${plan.label} virtual=${virtuals.map(String).join(",")}`);
    console.log(`${plan.label} effective=${effective.map(String).join(",")}`);

    results[plan.label] = {
      pair,
      token,
      realDc: plan.realDc.toString(),
      realOther: REAL_OTHER.toString(),
      virtualOther: virtualOther.toString(),
      targetOther: targetOther.toString(),
      reserves: reserves.map(String),
      virtualReserves: virtuals.map(String),
      effectiveReserves: effective.map(String),
    };
  }

  deployment.params = {
    ...(deployment.params || {}),
    ethInitialLiquidity: {
      initializedAt: new Date().toISOString(),
      mode: "real DC + 1 smallest unit real token1 + virtual token1 reserve",
      results,
    },
  };
  writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`\nUpdated ${DEPLOYMENT_FILE}`);
}

await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
