/**
 * Targeted Agiking redeploy:
 * - DealInfoNFT: mintByBurn now burns a direct DealCoin/DC amount.
 * - DealCreditGraph: immutable official InfoNFT pointer must follow the new InfoNFT.
 * - D + governance/dividend contracts: D now uses 18 decimals.
 *
 * Reuses existing DealFactory, DealCoin/DC, swap/domain stack, pair manager, indexes, and templates.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import { defineChain, formatEther, getAddress, zeroAddress, type Address } from "viem";

const AGIKING_CHAIN_ID = 31415926;
const DEPLOYMENT_FILE = "agiking-31415926.json";
const ONE = 10n ** 18n;

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

type AnyContract = {
  address: Address;
  read: Record<string, (...args: any[]) => Promise<any>>;
  write: Record<string, (...args: any[]) => Promise<`0x${string}`>>;
};

function agikingChain(rpcUrl: string) {
  return defineChain({
    id: AGIKING_CHAIN_ID,
    name: "Agiking",
    nativeCurrency: { decimals: 18, name: "AGI", symbol: "AGI" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function loadAbi(relativeArtifactJson: string): unknown[] {
  const p = join(process.cwd(), "artifacts", "contracts", relativeArtifactJson);
  return (JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[] }).abi;
}

async function waitFor(publicClient: any, hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
  return receipt;
}

async function tx(label: string, publicClient: any, hashPromise: Promise<`0x${string}`>) {
  const hash = await hashPromise;
  await waitFor(publicClient, hash);
  console.log(`  OK ${label}: ${hash}`);
}

function deploymentAbi(currentAbi: Record<string, unknown[]>) {
  return {
    ...currentAbi,
    D: loadAbi("D.sol/D.json"),
    DealFactory: loadAbi("DealFactory.sol/DealFactory.json"),
    DealInfoNFT: loadAbi("DealInfoNft.sol/DealInfoNFT.json"),
    DealCreditGraph: loadAbi("DealCreditGraph.sol/DealCreditGraph.json"),
    DealNftGovernanceActivity: loadAbi("DealNftGovernanceActivity.sol/DealNftGovernanceActivity.json"),
    NftVetoRegistry: loadAbi("NftVetoRegistry.sol/NftVetoRegistry.json"),
    DealSeatVetoGovernor: loadAbi("DealSeatVetoGovernor.sol/DealSeatVetoGovernor.json"),
    VoteDividendClaimer: loadAbi("VoteDividendClaimer.sol/VoteDividendClaimer.json"),
  };
}

function writeHandoff(file: string, deployedAt: string, deployer: Address, addresses: Record<string, Address>) {
  const md = `# InfoNFT DC 本位 burn 与 D 18 位精度部署交接

部署时间：${deployedAt}

部署钱包：\`${deployer}\`

链：Agiking \`${AGIKING_CHAIN_ID}\`

## 本次新部署地址

| 模块 | 地址 | 说明 |
| --- | --- | --- |
| DealInfoNFT | \`${addresses.dealInfoNFT}\` | 官方身份 NFT；\`mintByBurn()\` 直接 burn \`mintPriceDL\` 个 DealCoin（DC） |
| DealCreditGraph | \`${addresses.dealCreditGraph}\` | 绑定新版 DealInfoNFT 的信用图 |
| D | \`${addresses.dToken}\` | 100 D 总量，18 位精度，2.5 D 席位门槛 |
| DealNftGovernanceActivity | \`${addresses.dealNftGovernanceActivity}\` | 绑定新版 DealInfoNFT 的治理活跃记录 |
| NftVetoRegistry | \`${addresses.nftVetoRegistry}\` | 绑定新版 DealInfoNFT / 活跃记录 |
| DealSeatVetoGovernor | \`${addresses.dealSeatVetoGovernor}\` | 绑定新版 D |
| VoteDividendClaimer | \`${addresses.voteDividendClaimer}\` | 绑定新版 D，用 DealCoin（DC）分红 |

## 复用地址

| 模块 | 地址 |
| --- | --- |
| DealFactory | \`${addresses.dealFactory}\` |
| DealCoin/DC | \`${addresses.dlToken}\` |
| DealPairManager | \`${addresses.dealPairManager}\` |
| DCDomain | \`${addresses.dcDomain}\` |
| DCDomainRank | \`${addresses.dcDomainRank}\` |
| DCDomainSwap | \`${addresses.dcDomainSwap}\` |
| DCDomainHall | \`${addresses.dcDomainHall}\` |

## 前端接线

1. 官方身份 NFT 地址切到新版 \`DealInfoNFT\`。
2. 身份 NFT 铸造价格读 \`DealInfoNFT.mintPriceDL()\`，当前是 \`88e18\`，表示直接 burn 88 DC。
3. \`pair()\` 仅为旧 ABI 兼容字段，身份 NFT 铸造不再用 pair 报价。
4. D 代币地址切到新版 \`D\`，\`decimals() = 18\`，\`MAX_SUPPLY() = 100e18\`，\`SEAT_THRESHOLD() = 2.5e18\`。
5. 信用读取切到新版 \`DealCreditGraph\`。
6. DAO / 分红读取切到新版 \`DealSeatVetoGovernor\`、\`NftVetoRegistry\`、\`DealNftGovernanceActivity\`、\`VoteDividendClaimer\`。

## 重部署范围

只重部署身份 NFT、信用图、D 与 D 依赖的治理/分红合约。

\`DealFactory\` 未重部署，但已重新接线到新版 \`DealInfoNFT\`、\`DealCreditGraph\`、\`DealNftGovernanceActivity\`。

域名、Swap、Pair、已有 deal 模板和 DealCoin（DC）均未重部署。

完整地址和 ABI 已写入：

\`\`\`text
deployments/${DEPLOYMENT_FILE}
\`\`\`
`;
  writeFileSync(file, md, "utf8");
}

async function main() {
  const rpcUrl = (process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop").trim();
  const chain = agikingChain(rpcUrl);

  const dir = join(process.cwd(), "deployments");
  const currentFile = join(dir, DEPLOYMENT_FILE);
  const current = JSON.parse(readFileSync(currentFile, "utf8")) as DeploymentJson;
  const old = current.addresses;

  const { viem } = await network.connect({ network: "agiking", chainType: "l1" }) as unknown as { viem: any };
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer] = await viem.getWalletClients({ chain });
  const client = { public: publicClient, wallet: deployer } as const;
  const dep = getAddress(deployer.account.address) as Address;
  const nativeBalance = await publicClient.getBalance({ address: dep });

  console.log("Chain:", AGIKING_CHAIN_ID);
  console.log("Deployer:", dep);
  console.log("Native balance:", formatEther(nativeBalance));
  if (nativeBalance === 0n) throw new Error("Deployer has zero native balance; cannot pay deployment gas.");

  const factory = await viem.getContractAt("DealFactory", old.dealFactory, { client }) as AnyContract;
  const factoryOwner = getAddress(await factory.read.owner());
  if (factoryOwner !== dep) {
    throw new Error(`Deployer ${dep} is not DealFactory owner ${factoryOwner}; aborting before deployment.`);
  }

  const wrappedNative = getAddress(await factory.read.wrappedNative()) as Address;
  const pairManager = getAddress(await factory.read.dealPairManager()) as Address;
  const messageHub = getAddress(await factory.read.dealMessageHub()) as Address;
  const activityIndex = getAddress(await factory.read.dealActivityIndex()) as Address;
  const resultIndex = getAddress(await factory.read.dealResultIndex()) as Address;
  const implRegistry = getAddress(await factory.read.dealImplementationRegistry()) as Address;
  const orderBook = getAddress(await factory.read.swapOrderBook()) as Address;
  const domainRank = getAddress(await factory.read.dcDomainRank()) as Address;

  const dInitialHolder = getAddress((process.env.D_INITIAL_HOLDER?.trim() || dep) as Address) as Address;
  const dividendExecutor = getAddress((process.env.DIVIDEND_EXECUTOR?.trim() || dep) as Address) as Address;
  const dividendSource = getAddress((process.env.DIVIDEND_SOURCE?.trim() || dep) as Address) as Address;

  console.log("\n--- Deploy InfoNFT + CreditGraph ---");
  const infoNft = await viem.deployContract("DealInfoNFT", [old.dealFactory, zeroAddress, 88n * ONE], { client }) as AnyContract;
  console.log("DealInfoNFT:", infoNft.address);
  const creditGraph = await viem.deployContract("DealCreditGraph", [infoNft.address], { client }) as AnyContract;
  console.log("DealCreditGraph:", creditGraph.address);
  await tx("DealCreditGraph.setRecorder(Factory)", publicClient, creditGraph.write.setRecorder([old.dealFactory, true]));

  console.log("\n--- Deploy D + Governance ---");
  const dToken = await viem.deployContract("D", [dInitialHolder], { client }) as AnyContract;
  console.log("D:", dToken.address);
  console.log("D initial holder:", dInitialHolder);

  const nftActivity = await viem.deployContract("DealNftGovernanceActivity", [infoNft.address], { client }) as AnyContract;
  console.log("DealNftGovernanceActivity:", nftActivity.address);
  const nftVetoRegistry = await viem.deployContract("NftVetoRegistry", [infoNft.address, nftActivity.address], { client }) as AnyContract;
  console.log("NftVetoRegistry:", nftVetoRegistry.address);
  const seatVetoGovernor = await viem.deployContract("DealSeatVetoGovernor", [dToken.address, nftVetoRegistry.address], { client }) as AnyContract;
  console.log("DealSeatVetoGovernor:", seatVetoGovernor.address);
  await tx("NftVetoRegistry.setGovernor", publicClient, nftVetoRegistry.write.setGovernor([seatVetoGovernor.address, true]));
  await tx("NftActivity.setRecorder(Factory)", publicClient, nftActivity.write.setRecorder([old.dealFactory, true]));
  await tx("NftActivity.setRecorder(NftVetoRegistry)", publicClient, nftActivity.write.setRecorder([nftVetoRegistry.address, true]));

  const voteClaimer = await viem.deployContract(
    "VoteDividendClaimer",
    [dToken.address, old.dlToken, dividendExecutor, dividendSource],
    { client },
  ) as AnyContract;
  console.log("VoteDividendClaimer:", voteClaimer.address);
  console.log("Dividend executor:", dividendExecutor);
  console.log("Dividend source:", dividendSource);
  await tx("NftActivity.setRecorder(VoteDividendClaimer)", publicClient, nftActivity.write.setRecorder([voteClaimer.address, true]));
  await tx("VoteDividendClaimer.setGovernanceActivity", publicClient, voteClaimer.write.setGovernanceActivity([infoNft.address, nftActivity.address]));

  console.log("\n--- Rewire existing Factory ---");
  await tx("Factory.setCoreGlobals(new InfoNFT)", publicClient, factory.write.setCoreGlobals([
    old.dlToken,
    infoNft.address,
    wrappedNative,
    pairManager,
  ]));
  await tx("Factory.setServiceGlobals(new CreditGraph)", publicClient, factory.write.setServiceGlobals([
    messageHub,
    creditGraph.address,
    activityIndex,
    resultIndex,
    implRegistry,
  ]));
  await tx("Factory.setOpsGlobals(new GovernanceActivity)", publicClient, factory.write.setOpsGlobals([
    orderBook,
    nftActivity.address,
    domainRank,
  ]));

  console.log("\n--- Verify ---");
  const [factoryInfoNft, factoryCreditGraph, factoryGovActivity, dDecimals, dMaxSupply, dThreshold, nftPrice] = await Promise.all([
    factory.read.infoNft(),
    factory.read.creditGraph(),
    factory.read.dealNftGovernanceActivity(),
    dToken.read.decimals(),
    dToken.read.MAX_SUPPLY(),
    dToken.read.SEAT_THRESHOLD(),
    infoNft.read.mintPriceDL(),
  ]);
  if (getAddress(factoryInfoNft) !== getAddress(infoNft.address)) throw new Error("Factory infoNft mismatch");
  if (getAddress(factoryCreditGraph) !== getAddress(creditGraph.address)) throw new Error("Factory creditGraph mismatch");
  if (getAddress(factoryGovActivity) !== getAddress(nftActivity.address)) throw new Error("Factory governance activity mismatch");
  if (dDecimals !== 18) throw new Error("D decimals mismatch");
  if (dMaxSupply !== 100n * ONE) throw new Error("D max supply mismatch");
  if (dThreshold !== (25n * ONE) / 10n) throw new Error("D seat threshold mismatch");
  if (nftPrice !== 88n * ONE) throw new Error("InfoNFT mint price mismatch");
  console.log("  OK Factory + D + InfoNFT pointers");

  const deployedAt = new Date().toISOString();
  const stamp = deployedAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const backupDir = join(dir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const backupFileName = `agiking-31415926.before-info-nft-d18-${stamp}.json`;
  const backupFile = join(backupDir, backupFileName);
  const backupFileRef = `deployments/backups/${backupFileName}`;
  copyFileSync(currentFile, backupFile);

  const addresses: Record<string, Address> = {
    ...old,
    dealInfoNFT: getAddress(infoNft.address) as Address,
    dealCreditGraph: getAddress(creditGraph.address) as Address,
    dToken: getAddress(dToken.address) as Address,
    dealNftGovernanceActivity: getAddress(nftActivity.address) as Address,
    nftVetoRegistry: getAddress(nftVetoRegistry.address) as Address,
    dealSeatVetoGovernor: getAddress(seatVetoGovernor.address) as Address,
    voteDividendClaimer: getAddress(voteClaimer.address) as Address,
  };

  const updated: DeploymentJson = {
    ...current,
    deployedAt,
    deployer: dep,
    previousDeployment: backupFileRef,
    upgrade: "info-nft-direct-dc-burn-and-d-18-decimals",
    addresses,
    abi: deploymentAbi(current.abi),
    notes: [
      ...(current.notes ?? []),
      "DealInfoNFT redeployed so mintByBurn burns mintPriceDL directly in DealCoin/DC, without U/pair conversion.",
      "D redeployed with 18 decimals, 100 D total supply, and 2.5 D seat threshold.",
      "DealCreditGraph and D governance/dividend contracts redeployed because they bind InfoNFT/D immutably.",
      "Existing DealFactory was rewired to the new DealInfoNFT, DealCreditGraph, and DealNftGovernanceActivity.",
    ],
  };

  const snapshotFile = join(dir, `agiking-31415926-${stamp}.json`);
  const handoffFile = join(dir, `frontend-handoff-info-nft-d18-${stamp}.md`);
  writeFileSync(currentFile, JSON.stringify(updated, null, 2), "utf8");
  writeFileSync(snapshotFile, JSON.stringify(updated, null, 2), "utf8");
  writeHandoff(handoffFile, deployedAt, dep, addresses);

  console.log("\n========== UPDATED ==========");
  console.log("DealInfoNFT:", addresses.dealInfoNFT);
  console.log("DealCreditGraph:", addresses.dealCreditGraph);
  console.log("D:", addresses.dToken);
  console.log("VoteDividendClaimer:", addresses.voteDividendClaimer);
  console.log("\nWrote:");
  console.log(" ", currentFile);
  console.log(" ", snapshotFile);
  console.log(" ", backupFile);
  console.log(" ", handoffFile);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
