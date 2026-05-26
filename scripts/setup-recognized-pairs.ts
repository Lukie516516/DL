import { network } from "hardhat";

const DEFAULT_AUSD = "0x8fc6dB736Dce11233078EA6f6EBa4c9F44E4C123" as const;
const DEFAULT_USDT = "0x1035F65fc63342F9878C4D03e4372718Dbb33d32" as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

type Address = `0x${string}`;

function envAddress(key: string, fallback?: Address): Address {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env ${key}`);
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    throw new Error(`Invalid address for ${key}: ${raw}`);
  }
  return raw as Address;
}

function envBigInt(key: string): bigint | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return undefined;
  return BigInt(raw);
}

function envBool(key: string): boolean {
  return process.env[key] === "1" || process.env[key]?.toLowerCase() === "true";
}

async function waitFor(publicClient: Awaited<ReturnType<(typeof network)["connect"]>>["viem"]["getPublicClient"] extends (...args: never[]) => Promise<infer T> ? T : never, hash: Address) {
  return publicClient.waitForTransactionReceipt({ hash });
}

async function ensureRecognizedTokens(
  factory: Awaited<ReturnType<Awaited<ReturnType<typeof network.connect>>["viem"]["getContractAt"]>>,
  publicClient: Awaited<ReturnType<Awaited<ReturnType<typeof network.connect>>["viem"]["getPublicClient"]>>,
  ausd: Address,
  usdt: Address,
) {
  const current0 = await factory.read.recognizedToken0();
  const current1 = await factory.read.recognizedToken1();

  if (
    current0.toLowerCase() === ausd.toLowerCase() &&
    current1.toLowerCase() === usdt.toLowerCase()
  ) {
    console.log("Recognized tokens already configured.");
    return;
  }

  console.log("Updating recognized tokens...");
  const hash = await factory.write.setRecognizedTokens([ausd, usdt]);
  await waitFor(publicClient, hash);
  console.log(`Recognized tokens set to AUSD=${ausd}, USDT=${usdt}`);
}

async function ensurePair(
  pairManager: Awaited<ReturnType<Awaited<ReturnType<typeof network.connect>>["viem"]["getContractAt"]>>,
  publicClient: Awaited<ReturnType<Awaited<ReturnType<typeof network.connect>>["viem"]["getPublicClient"]>>,
  token: Address,
  label: string,
  feeNum: number,
  feeDen: number,
): Promise<Address> {
  const existing = await pairManager.read.pairForToken([token]);
  if (existing !== ZERO_ADDRESS) {
    console.log(`${label} pair already exists at ${existing}`);
    return existing;
  }

  console.log(`Creating ${label} pair...`);
  const hash = await pairManager.write.createPair([token, feeNum, feeDen]);
  await waitFor(publicClient, hash);

  const created = await pairManager.read.pairForToken([token]);
  if (created === ZERO_ADDRESS) {
    throw new Error(`Pair creation failed for ${label}`);
  }

  console.log(`${label} pair created at ${created}`);
  return created;
}

async function maybeInitPair(
  viem: Awaited<ReturnType<typeof network.connect>>["viem"],
  factory: Awaited<ReturnType<Awaited<ReturnType<typeof network.connect>>["viem"]["getContractAt"]>>,
  pairManager: Awaited<ReturnType<Awaited<ReturnType<typeof network.connect>>["viem"]["getContractAt"]>>,
  publicClient: Awaited<ReturnType<Awaited<ReturnType<typeof network.connect>>["viem"]["getPublicClient"]>>,
  pair: Address,
  token: Address,
  label: string,
  dlAmount: bigint | undefined,
  tokenAmount: bigint | undefined,
) {
  if (dlAmount === undefined && tokenAmount === undefined) return;
  if (dlAmount === undefined || tokenAmount === undefined) {
    throw new Error(`To init ${label}, set both ${label}_INIT_DL and ${label}_INIT_TOKEN`);
  }
  if (dlAmount <= 0n || tokenAmount <= 0n) {
    throw new Error(`${label} init amounts must be > 0`);
  }

  const dlAddress = await factory.read.dlToken();
  if (dlAddress === ZERO_ADDRESS) {
    throw new Error("Factory dlToken is not configured");
  }

  const pairContract = await viem.getContractAt("DealSwapTemplate", pair);
  const inited = await pairContract.read.liquidityInited();
  if (inited) {
    console.log(`${label} pair already initialized.`);
    return;
  }

  const dlToken = await viem.getContractAt("IERC20", dlAddress);
  const otherToken = await viem.getContractAt("IERC20", token);

  console.log(`Funding ${label} pair with DL=${dlAmount} token=${tokenAmount}...`);
  let hash = await dlToken.write.transfer([pair, dlAmount]);
  await waitFor(publicClient, hash);
  hash = await otherToken.write.transfer([pair, tokenAmount]);
  await waitFor(publicClient, hash);

  console.log(`Initializing ${label} pair...`);
  hash = await pairManager.write.initPair([pair, 0n]);
  await waitFor(publicClient, hash);
  console.log(`${label} pair initialized.`);
}

async function main() {
  const factoryAddress = envAddress("FACTORY_ADDRESS");
  const ausd = envAddress("AUSD_ADDRESS", DEFAULT_AUSD);
  const usdt = envAddress("USDT_ADDRESS", DEFAULT_USDT);
  const pairFeeNum = Number(process.env.PAIR_FEE_NUM ?? "3");
  const pairFeeDen = Number(process.env.PAIR_FEE_DEN ?? "1000");

  const ausdInitDl = envBigInt("AUSD_INIT_DL");
  const ausdInitToken = envBigInt("AUSD_INIT_TOKEN");
  const usdtInitDl = envBigInt("USDT_INIT_DL");
  const usdtInitToken = envBigInt("USDT_INIT_TOKEN");
  const skipInit = envBool("SKIP_INIT");

  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const factory = await viem.getContractAt("DealFactory", factoryAddress);
  const pairManagerAddress = await factory.read.dealPairManager();
  if (pairManagerAddress === ZERO_ADDRESS) throw new Error("Factory dealPairManager is not configured");
  const pairManager = await viem.getContractAt("DealPairManager", pairManagerAddress);

  console.log(`Factory: ${factoryAddress}`);
  console.log(`Default recognized tokens: AUSD=${ausd}, USDT=${usdt}`);

  await ensureRecognizedTokens(factory, publicClient, ausd, usdt);

  const ausdPair = await ensurePair(pairManager, publicClient, ausd, "AUSD", pairFeeNum, pairFeeDen);
  const usdtPair = await ensurePair(pairManager, publicClient, usdt, "USDT", pairFeeNum, pairFeeDen);

  if (!skipInit) {
    await maybeInitPair(viem, factory, pairManager, publicClient, ausdPair, ausd, "AUSD", ausdInitDl, ausdInitToken);
    await maybeInitPair(viem, factory, pairManager, publicClient, usdtPair, usdt, "USDT", usdtInitDl, usdtInitToken);
  } else {
    console.log("Skipping pair initialization because SKIP_INIT is enabled.");
  }

  console.log("Recognized pair setup complete.");
}

await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
