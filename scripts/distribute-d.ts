import { network } from "hardhat";
import { defineChain, formatEther, parseEther, type Address } from "viem";

const chain = defineChain({
  id: 31415926, name: "Agiking",
  nativeCurrency: { decimals: 18, name: "AGI", symbol: "AGI" },
  rpcUrls: { default: { http: ["https://rpc.agikingrpc.shop"] } },
});

const D_TOKEN  = "0xa57b99e48f2fc24282e8f263d24468a51c5242db" as Address;
const TO       = "0x5CcB69B2Ba6dcC61C4be40a0B06D79Ddcb445aC5" as Address;
const AMOUNT   = parseEther("2.5");

const { viem } = await network.connect({ network: "agiking", chainType: "l1" }) as any;
const pub      = await viem.getPublicClient({ chain });
const [dep]    = await viem.getWalletClients({ chain });
const client   = { public: pub, wallet: dep };

const d = await viem.getContractAt("D", D_TOKEN, { client });

const before = await d.read.balanceOf([TO]);
console.log("转账前余额:", formatEther(before), "D");

const hash = await d.write.transfer([TO, AMOUNT], { gasPrice: 2000000000n });
const r    = await pub.waitForTransactionReceipt({ hash });
console.log(r.status === "success" ? "✓" : "✗", "transfer", hash);

const after = await d.read.balanceOf([TO]);
console.log("转账后余额:", formatEther(after), "D");
