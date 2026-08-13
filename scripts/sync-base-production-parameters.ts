/** Read-only by default; currently syncs the single audited ETH/BSC/Base difference. */
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  fallback,
  getAddress,
  http,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const DEPLOYMENT_FILE = "deployments/base-mainnet-8453.json";
const WRITE_GATE = "BASE_PARAMETER_SYNC_EXECUTE";
const TARGET_MESSAGE_PRICE = parseEther("104");
const factoryAbi = parseAbi([
  "function owner() view returns (address)",
  "function msgPriceEnabled() view returns (bool)",
  "function msgPriceToken() view returns (address)",
  "function msgPriceAmountInToken() view returns (uint256)",
  "function setMessagePriceRule(bool,address,uint256)",
]);

type Deployment = {
  chainId: number;
  deployer: Address;
  addresses: { dealFactory: Address; dlToken: Address };
};

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

function assertThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function same(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function privateKey(): Hex {
  const raw = process.env.BASE_MAINNET_PRIVATE_KEY || process.env.AGIKING_PRIVATE_KEY;
  if (!raw) throw new Error("Missing BASE_MAINNET_PRIVATE_KEY or AGIKING_PRIVATE_KEY");
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

async function main() {
  loadEnv();
  const mode = process.argv[2] || "preflight";
  assertThat(mode === "preflight" || mode === "execute", `Unsupported mode: ${mode}`);
  if (mode === "execute") assertThat(process.env[WRITE_GATE] === "1", `Set ${WRITE_GATE}=1 for execution`);
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Deployment;
  assertThat(deployment.chainId === 8453, "Deployment is not Base mainnet");
  const factory = getAddress(deployment.addresses.dealFactory);
  const dc = getAddress(deployment.addresses.dlToken);
  const deployer = getAddress(deployment.deployer);
  const rpc = process.env.BASE_MAINNET_RPC_URL?.trim() || "https://base-rpc.publicnode.com";
  const publicClient: any = createPublicClient({
    chain: base,
    transport: fallback([
      http(rpc, { timeout: 30_000 }),
      http("https://mainnet.base.org", { timeout: 30_000 }),
    ], { rank: false }),
  });
  const [owner, enabled, token, current] = await Promise.all([
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "owner" }),
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "msgPriceEnabled" }),
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "msgPriceToken" }),
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "msgPriceAmountInToken" }),
  ]);
  assertThat(same(owner, deployer), `Factory owner mismatch: ${owner}`);
  assertThat(enabled, "Base message pricing is unexpectedly disabled");
  assertThat(same(token, dc), `Base message pricing token mismatch: ${token}`);
  assertThat(current === parseEther("100") || current === TARGET_MESSAGE_PRICE,
    `Unexpected Base message price: ${current}`);
  console.log(JSON.stringify({
    status: "PASS",
    mode,
    factory,
    owner,
    enabled,
    pricingToken: token,
    currentAmountWei: current.toString(),
    targetAmountWei: TARGET_MESSAGE_PRICE.toString(),
    onlyPlannedChange: "msgPriceAmountInToken: 100 DC -> 104 DC",
  }, null, 2));
  if (mode === "preflight" || current === TARGET_MESSAGE_PRICE) return;

  const account = privateKeyToAccount(privateKey());
  assertThat(same(account.address, deployer), `Signer mismatch: ${account.address}`);
  await publicClient.simulateContract({
    account,
    address: factory,
    abi: factoryAbi,
    functionName: "setMessagePriceRule",
    args: [true, dc, TARGET_MESSAGE_PRICE],
  });
  const wallet: any = createWalletClient({ account, chain: base, transport: http(rpc, { timeout: 30_000 }) });
  const hash = await wallet.writeContract({
    account,
    address: factory,
    abi: factoryAbi,
    functionName: "setMessagePriceRule",
    args: [true, dc, TARGET_MESSAGE_PRICE],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assertThat(receipt.status === "success", `Parameter sync failed: ${hash}`);
  let observed = 0n;
  for (let attempt = 0; attempt < 30; ++attempt) {
    observed = await publicClient.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "msgPriceAmountInToken",
    });
    if (observed === TARGET_MESSAGE_PRICE) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assertThat(observed === TARGET_MESSAGE_PRICE, `Synced price not visible: ${observed}`);
  const [enabledAfter, tokenAfter] = await Promise.all([
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "msgPriceEnabled" }),
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "msgPriceToken" }),
  ]);
  assertThat(enabledAfter && same(tokenAfter, dc), "Message rule side fields changed unexpectedly");
  console.log(JSON.stringify({
    status: "PASS",
    transaction: hash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    messagePriceDc: "104",
    otherParametersChanged: false,
  }, null, 2));
}

await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
