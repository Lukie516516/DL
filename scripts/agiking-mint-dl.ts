/**
 * 向指定地址增发 DL（链上符号一般为 Deal DL / DC 测试币）——仅 `MINTER_ROLE` 可调 `mint`。
 *
 * 用法（需配置具有铸币权的钱包私钥，通常为部署时 initialAdmin/minter）：
 *   set AGIKING_PRIVATE_KEY=0x...
 *   npx tsx scripts/agiking-mint-dl.ts
 *
 * 可选环境变量：
 *   AGIKING_RPC_URL        默认 deployments/agiking-31415926.json
 *   MINT_TO                接收地址，默认 0x624881c7e868Dbb87372147F5F86C8e903BFeF0a
 *   MINT_DL_AMOUNT_WEI     十进制字符串，默认 1000000000000000000000000000 (= 1e9 * 1e18，十亿枚)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ONE = 10n ** 18n;
/** 默认：10 亿枚 DL（18 位），足以相对当前 Agiking 池储备做极大卖压测试；可按需改 MINT_DL_AMOUNT_WEI */
const DEFAULT_MINT = 1_000_000_000n * ONE;

const DEFAULT_TO = "0x624881c7e868Dbb87372147F5F86C8e903BFeF0a" as Address;

const abi = parseAbi(["function mint(address to,uint256 amount) external"]);

type Deployment = { rpcUrl: string; addresses: { dlToken: Address } };

function loadDeployment(): Deployment {
  const p = join(process.cwd(), "deployments", "agiking-31415926.json");
  return JSON.parse(readFileSync(p, "utf8")) as Deployment;
}

async function main() {
  const pk = process.env.AGIKING_PRIVATE_KEY?.trim();
  if (!pk?.startsWith("0x")) {
    console.error("请设置 AGIKING_PRIVATE_KEY（0x 开头）");
    process.exit(1);
  }

  const dep = loadDeployment();
  const rpcUrl = process.env.AGIKING_RPC_URL?.trim() || dep.rpcUrl;
  const dl = dep.addresses.dlToken;
  const to = (process.env.MINT_TO?.trim() || DEFAULT_TO) as Address;

  let amount: bigint;
  const raw = process.env.MINT_DL_AMOUNT_WEI?.trim();
  if (raw) {
    try {
      amount = BigInt(raw);
    } catch {
      console.error("MINT_DL_AMOUNT_WEI 必须是十进制整数字符串");
      process.exit(1);
    }
  } else {
    amount = DEFAULT_MINT;
  }

  const chain = defineChain({
    id: 31415926,
    name: "Agiking",
    nativeCurrency: { name: "N", symbol: "N", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const account = privateKeyToAccount(pk as Hex);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const balBefore = await publicClient.readContract({
    address: dl,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [to],
  });

  console.log("RPC:", rpcUrl);
  console.log("DL token:", dl);
  console.log("Minter:", account.address);
  console.log("Mint to:", to);
  console.log("Amount (wei):", amount.toString());
  console.log("Recipient balance before:", balBefore.toString());

  const hash = await walletClient.writeContract({
    address: dl,
    abi,
    functionName: "mint",
    args: [to, amount],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("Tx:", hash, "status:", receipt.status);

  const balAfter = await publicClient.readContract({
    address: dl,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [to],
  });
  console.log("Recipient balance after:", balAfter.toString());
}

await main();
