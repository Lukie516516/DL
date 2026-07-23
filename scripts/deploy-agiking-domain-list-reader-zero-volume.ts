/**
 * Deploy only DCDomainListReader on Agiking after restoring zero-volume domains
 * to getDomainsByVolume().
 *
 * Read-only preflight:
 *   node --import tsx/esm scripts/deploy-agiking-domain-list-reader-zero-volume.ts --preflight
 *
 * Explicit write gate:
 *   AGIKING_DOMAIN_LIST_ZERO_VOLUME_DEPLOY=1 \
 *     node --import tsx/esm scripts/deploy-agiking-domain-list-reader-zero-volume.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { network } from "hardhat";
import {
  defineChain,
  formatEther,
  getAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";

const CHAIN_ID = 31_415_926;
const DEPLOYMENT_FILE = "agiking-31415926.json";
const WRITE_GATE = "AGIKING_DOMAIN_LIST_ZERO_VOLUME_DEPLOY";

type Artifact = {
  abi: readonly unknown[];
  bytecode: Hex;
};

type DeploymentJson = {
  chainId: number;
  rpcUrl: string;
  deployedAt: string;
  deployer: Address;
  previousDeployment?: string;
  upgrade?: string;
  addresses: Record<string, Address>;
  abi: Record<string, unknown[]>;
  notes?: string[];
};

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function artifact(): Artifact {
  return JSON.parse(
    readFileSync(
      join(
        process.cwd(),
        "artifacts",
        "contracts",
        "DCDomainListReader.sol",
        "DCDomainListReader.json"
      ),
      "utf8"
    )
  ) as Artifact;
}

function chain(rpcUrl: string) {
  return defineChain({
    id: CHAIN_ID,
    name: "Agiking",
    nativeCurrency: { decimals: 18, name: "AGI", symbol: "AGI" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function timestamp(value: string): string {
  return value.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function handoff(params: {
  deployedAt: string;
  deployer: Address;
  txHash: Hex;
  blockNumber: bigint;
  oldReader: Address;
  newReader: Address;
  dcDomain: Address;
  rank: Address;
  totalDomains: bigint;
  oldVisible: number;
  newVisible: number;
}): string {
  return `# Agiking 域名列表 Reader 前端接线

部署时间：${params.deployedAt}

链：Agiking \`${CHAIN_ID}\`

部署钱包：\`${params.deployer}\`

## 前端必须更新

| 项目 | 地址 |
| --- | --- |
| 新 DCDomainListReader | \`${params.newReader}\` |
| 旧 DCDomainListReader（停止使用） | \`${params.oldReader}\` |
| DCDomain（未变） | \`${params.dcDomain}\` |
| DCDomainRank proxy（未变） | \`${params.rank}\` |

部署交易：\`${params.txHash}\`

部署区块：\`${params.blockNumber}\`

## 调用方法

\`\`\`solidity
getDomainsByVolume(uint256 offset, uint256 limit)
\`\`\`

- \`limit\` 为 \`1..50\`。
- 返回全部已注册域名，而不是只返回有成交额的 Top-50。
- 有已完成成交的域名按 \`tradeVolume\` 从高到低排列。
- 没有成交的域名也返回，\`tradeVolume = 0\`，排在有成交域名之后。
- 相同成交额按较新的 \`tokenId\` 优先。
- ABI 没变，前端只需要替换 Reader 地址。
- 这是 \`eth_call\` 只读调用，不消耗用户钱包 Gas；RPC 节点仍会限制单次调用的计算量，因此继续分页读取。

Viem 示例：

\`\`\`ts
const page = await publicClient.readContract({
  address: "${params.newReader}",
  abi: DCDomainListReaderAbi,
  functionName: "getDomainsByVolume",
  args: [0n, 20n],
});
\`\`\`

## 链上验证

- \`dcDomain()\` 精确指向现有 DCDomain。
- \`rank()\` 精确指向现有 DCDomainRank proxy。
- 当前 \`totalDomains = ${params.totalDomains}\`。
- 旧 Reader 默认列表返回 ${params.oldVisible} 条。
- 新 Reader 默认列表返回 ${params.newVisible} 条，零成交域名已可见。
- 未升级或修改 DCDomain、DCDomainRank、Factory、DAO 或任何资产合约。

完整地址与 ABI：\`deployments/${DEPLOYMENT_FILE}\`
`;
}

async function main() {
  const preflightOnly = process.argv.includes("--preflight");
  if (!preflightOnly && process.env[WRITE_GATE] !== "1") {
    throw new Error(
      `Write gate closed: set ${WRITE_GATE}=1 only after explicit deployment authorization`
    );
  }

  const root = process.cwd();
  const deploymentPath = join(root, "deployments", DEPLOYMENT_FILE);
  const current = JSON.parse(
    readFileSync(deploymentPath, "utf8")
  ) as DeploymentJson;
  if (current.chainId !== CHAIN_ID) {
    throw new Error(`Deployment chain mismatch: ${current.chainId}`);
  }

  const rpcUrl =
    process.env.AGIKING_RPC_URL?.trim() ||
    current.rpcUrl ||
    "https://rpc.agikingrpc.shop";
  const agiking = chain(rpcUrl);
  const { viem } = await network.connect({
    network: "agiking",
    chainType: "l1",
  });
  const publicClient = await viem.getPublicClient({ chain: agiking });
  const [wallet] = await viem.getWalletClients({ chain: agiking });
  const deployer = getAddress(wallet.account.address);
  const expectedDeployer = getAddress(current.deployer);
  if (!sameAddress(deployer, expectedDeployer)) {
    throw new Error(
      `Signer mismatch: expected ${expectedDeployer}, got ${deployer}`
    );
  }
  if ((await publicClient.getChainId()) !== CHAIN_ID) {
    throw new Error("RPC is not Agiking mainnet");
  }

  const dcDomain = getAddress(current.addresses.dcDomain);
  const rank = getAddress(current.addresses.dcDomainRank);
  const oldReaderAddress = getAddress(current.addresses.dcDomainListReader);
  for (const [label, address] of [
    ["DCDomain", dcDomain],
    ["DCDomainRank", rank],
    ["old DCDomainListReader", oldReaderAddress],
  ] as const) {
    const code = await publicClient.getCode({ address });
    if (!code || code === "0x") throw new Error(`${label} has no runtime code`);
  }

  const oldReader = await viem.getContractAt(
    "DCDomainListReader",
    oldReaderAddress,
    { client: { public: publicClient, wallet } }
  );
  const domain = await viem.getContractAt("DCDomain", dcDomain, {
    client: { public: publicClient, wallet },
  });
  const [oldDomainPointer, oldRankPointer, totalDomains, balance, latest, pending] =
    await Promise.all([
      oldReader.read.dcDomain(),
      oldReader.read.rank(),
      domain.read.totalDomains(),
      publicClient.getBalance({ address: deployer }),
      publicClient.getTransactionCount({
        address: deployer,
        blockTag: "latest",
      }),
      publicClient.getTransactionCount({
        address: deployer,
        blockTag: "pending",
      }),
    ]);
  if (
    !sameAddress(getAddress(oldDomainPointer), dcDomain) ||
    !sameAddress(getAddress(oldRankPointer), rank)
  ) {
    throw new Error("Old Reader pointer mismatch");
  }
  if (balance === 0n) throw new Error("Deployer has zero native balance");
  if (latest !== pending) {
    throw new Error(`Signer has pending transactions: ${latest}/${pending}`);
  }

  const oldPage = await oldReader.read.getDomainsByVolume([0n, 50n]);
  const summary = {
    chainId: CHAIN_ID,
    blockNumber: (await publicClient.getBlockNumber()).toString(),
    deployer,
    nonce: pending,
    nativeBalance: formatEther(balance),
    dcDomain,
    rank,
    oldReader: oldReaderAddress,
    totalDomains: totalDomains.toString(),
    oldVisible: oldPage.length,
  };
  if (preflightOnly) {
    console.log(JSON.stringify(summary, null, 2));
    console.log("Agiking DCDomainListReader read-only preflight passed.");
    console.log("No transaction was signed or sent.");
    return;
  }

  const build = artifact();
  const txHash = await wallet.deployContract({
    abi: build.abi,
    bytecode: build.bytecode,
    args: [dcDomain, rank],
  });
  console.log(`DCDomainListReader deployment submitted: ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 2,
    timeout: 180_000,
  });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error("DCDomainListReader deployment failed");
  }

  const newReaderAddress = getAddress(receipt.contractAddress);
  const newReader = await viem.getContractAt(
    "DCDomainListReader",
    newReaderAddress,
    { client: { public: publicClient, wallet } }
  );
  const [newDomainPointer, newRankPointer, newPage, runtime] = await Promise.all([
    newReader.read.dcDomain(),
    newReader.read.rank(),
    newReader.read.getDomainsByVolume([0n, 50n]),
    publicClient.getCode({ address: newReaderAddress }),
  ]);
  if (
    !sameAddress(getAddress(newDomainPointer), dcDomain) ||
    !sameAddress(getAddress(newRankPointer), rank)
  ) {
    throw new Error("New Reader pointer mismatch");
  }
  if (!runtime || runtime === "0x") throw new Error("New Reader has no code");
  const expectedVisible =
    totalDomains < 50n ? Number(totalDomains) : 50;
  if (newPage.length !== expectedVisible) {
    throw new Error(
      `New Reader page length mismatch: ${newPage.length}/${expectedVisible}`
    );
  }
  for (let i = 1; i < newPage.length; ++i) {
    if (newPage[i - 1].tradeVolume < newPage[i].tradeVolume) {
      throw new Error("New Reader trade-volume order mismatch");
    }
  }

  const deployedAt = new Date().toISOString();
  const stamp = timestamp(deployedAt);
  const note =
    `[${deployedAt}] DCDomainListReader ${newReaderAddress}: ` +
    "getDomainsByVolume now includes zero-completed-trade domains after non-zero domains.";
  const updated: DeploymentJson = {
    ...current,
    deployedAt,
    deployer,
    previousDeployment: `DCDomainListReader ${oldReaderAddress}`,
    upgrade: "domain-list-reader-zero-volume-visible",
    addresses: {
      ...current.addresses,
      dcDomainListReader: newReaderAddress,
    },
    abi: {
      ...current.abi,
      DCDomainListReader: [...build.abi] as unknown[],
    },
    notes: [...(current.notes ?? []), note],
  };

  const record = {
    schemaVersion: 1,
    scope:
      "deploy one read-only DCDomainListReader on Agiking; reuse DCDomain and DCDomainRank; no core upgrade or asset write",
    deployedAt,
    chainId: CHAIN_ID,
    deployer,
    oldReader: oldReaderAddress,
    newReader: newReaderAddress,
    dcDomain,
    rank,
    txHash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    runtimeBytes: (runtime.length - 2) / 2,
    runtimeCodeHash: keccak256(runtime),
    verification: {
      totalDomains: totalDomains.toString(),
      oldVisible: oldPage.length,
      newVisible: newPage.length,
      pointersMatch: true,
      sortedDescending: true,
      coreContractsChanged: false,
    },
  };

  const recordPath = join(
    root,
    "deployments",
    `agiking-domain-list-reader-zero-volume-${stamp}.json`
  );
  const handoffPath = join(
    root,
    "deployments",
    `frontend-handoff-domain-list-reader-zero-volume-${stamp}.md`
  );
  writeFileSync(deploymentPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n", "utf8");
  writeFileSync(
    handoffPath,
    handoff({
      deployedAt,
      deployer,
      txHash,
      blockNumber: receipt.blockNumber,
      oldReader: oldReaderAddress,
      newReader: newReaderAddress,
      dcDomain,
      rank,
      totalDomains,
      oldVisible: oldPage.length,
      newVisible: newPage.length,
    }),
    "utf8"
  );

  console.log(JSON.stringify(record, null, 2));
  console.log(`Updated: ${deploymentPath}`);
  console.log(`Wrote: ${recordPath}`);
  console.log(`Wrote: ${handoffPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
