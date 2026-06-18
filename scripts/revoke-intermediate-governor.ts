import { network } from "hardhat";
import { defineChain, type Address } from "viem";

const chain = defineChain({
  id: 31415926, name: "Agiking",
  nativeCurrency: { decimals: 18, name: "AGI", symbol: "AGI" },
  rpcUrls: { default: { http: ["https://rpc.agikingrpc.shop"] } },
});

const { viem } = await network.connect({ network: "agiking", chainType: "l1" }) as any;
const pub = await viem.getPublicClient({ chain });
const [dep] = await viem.getWalletClients({ chain });
const client = { public: pub, wallet: dep };

const nftVeto = await viem.getContractAt(
  "NftVetoRegistry",
  "0xd8ed220604fbf0f861d64caee2cae88c1a7258a8" as Address,
  { client },
);

// 撤销上次部署的中间 proxy 地址
const hash = await nftVeto.write.setGovernor(
  ["0x8f4A698395D77aBd2eB71881E2AFb2C1cF539961" as Address, false],
  { gasPrice: 2000000000n },
);
const r = await pub.waitForTransactionReceipt({ hash });
console.log(r.status === "success" ? "✓ revoked 0x8f4A..." : "✗ failed", hash);
