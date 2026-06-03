/**
 * Replace the official DC/AGI pair with a real-liquidity pair.
 *
 * Current DealPairManager does not allow overwriting pairForToken once AGI is
 * mapped, so this script deploys a new DealPairManager, maps the existing
 * AUSD/USDT pairs, creates a fresh AGI pair, funds it with real reserves, and
 * points Factory/SwapAssetRegistry to the new manager.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";
import {
  defineChain,
  formatEther,
  formatUnits,
  getAddress,
  keccak256,
  parseEther,
  toBytes,
  type Address,
} from "viem";
import { loadAgikingDeploymentAddresses } from "./load-agiking-deployment.js";

const AGIKING_CHAIN_ID = 31415926;
const DEPLOYMENT_FILE = "agiking-31415926.json";
const ZERO = "0x0000000000000000000000000000000000000000" as const;

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

function loadDeploymentJson() {
  const file = join(process.cwd(), "deployments", DEPLOYMENT_FILE);
  return JSON.parse(readFileSync(file, "utf8")) as any;
}

function loadAbi(relativeArtifactJson: string): unknown[] {
  const p = join(process.cwd(), "artifacts", "contracts", relativeArtifactJson);
  return (JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[] }).abi;
}

function refreshAbi(existingAbi: Record<string, unknown[]> = {}) {
  return {
    ...existingAbi,
    DealFactory: loadAbi("DealFactory.sol/DealFactory.json"),
    DealPairManager: loadAbi("DealPairManager.sol/DealPairManager.json"),
    DealSwapTemplate: loadAbi("DealSwapTemplate.sol/DealSwapTemplate.json"),
    DealSwapAssetRegistry: loadAbi("DealSwapAssetRegistry.sol/DealSwapAssetRegistry.json"),
    WrappedAGI: loadAbi("WrappedAGI.sol/WrappedAGI.json"),
    DCToken: loadAbi("DL.sol/DCToken.json"),
  };
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

async function main() {
  const rpcUrl = (process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop").trim();
  const chain = agikingChain(rpcUrl);
  const deploymentJson = loadDeploymentJson();
  const base = loadAgikingDeploymentAddresses(DEPLOYMENT_FILE);

  const { viem } = await network.connect({ network: "agiking", chainType: "l1" }) as unknown as { viem: any };
  const publicClient = await viem.getPublicClient({ chain });
  const [deployer] = await viem.getWalletClients({ chain });
  const client = { public: publicClient, wallet: deployer } as const;
  const dep = getAddress(deployer.account.address) as Address;

  const dcAmount = parseEther(process.env.AGI_PAIR_DC ?? "500000");
  const agiAmount = parseEther(process.env.AGI_PAIR_AGI ?? "50");
  const feeNum = Number(process.env.PAIR_FEE_NUM ?? "3");
  const feeDen = Number(process.env.PAIR_FEE_DEN ?? "1000");

  const factory = await viem.getContractAt("DealFactory", base.dealFactory, { client }) as AnyContract;
  const dl = await viem.getContractAt("DCToken", base.dlToken, { client }) as AnyContract;
  const wagi = await viem.getContractAt("WrappedAGI", base.wrappedNative, { client }) as AnyContract;
  const registry = base.dealSwapAssetRegistry
    ? await viem.getContractAt("DealSwapAssetRegistry", base.dealSwapAssetRegistry, { client }) as AnyContract
    : undefined;

  const factoryOwner = getAddress(await factory.read.owner()) as Address;
  if (dep !== factoryOwner) {
    throw new Error(`deployer ${dep} is not Factory owner ${factoryOwner}`);
  }

  const minterRole = keccak256(toBytes("MINTER_ROLE"));
  const isMinter = await dl.read.hasRole([minterRole, dep]);
  if (!isMinter) throw new Error(`deployer ${dep} is not DC minter`);

  const nativeBalance = await publicClient.getBalance({ address: dep });
  if (nativeBalance < agiAmount) {
    throw new Error(`native AGI balance ${formatEther(nativeBalance)} < required ${formatEther(agiAmount)}`);
  }

  console.log("Chain", AGIKING_CHAIN_ID);
  console.log("Deployer", dep);
  console.log("Factory", base.dealFactory);
  console.log("Old PairManager", base.dealPairManager);
  console.log("Old AGI pair", base.pairDlAgi);
  console.log("New AGI pair target reserves", {
    dc: formatUnits(dcAmount, 18),
    agi: formatUnits(agiAmount, 18),
  });

  console.log("Deploying new DealPairManager...");
  const newPairManager = await viem.deployContract("DealPairManager", [base.dealFactory], { client }) as AnyContract;
  console.log("New PairManager", newPairManager.address);
  const pairManager = await viem.getContractAt("DealPairManager", newPairManager.address, { client }) as AnyContract;

  await tx("PairManager.mapExistingPair AUSD", publicClient, pairManager.write.mapExistingPair([base.ausd, base.pairDlAusd]));
  await tx("PairManager.mapExistingPair USDT", publicClient, pairManager.write.mapExistingPair([base.usdt, base.pairDlUsdt]));

  await tx("PairManager.createPair AGI", publicClient, pairManager.write.createPair([base.wrappedNative, feeNum, feeDen]));
  const pairDlAgi = getAddress(await pairManager.read.pairForToken([base.wrappedNative])) as Address;
  if (pairDlAgi === ZERO) throw new Error("new AGI pair creation failed");
  console.log("New AGI pair", pairDlAgi);

  await tx("DC.mint(new AGI pair)", publicClient, dl.write.mint([pairDlAgi, dcAmount]));
  await tx("WAGI.deposit(50 AGI)", publicClient, wagi.write.deposit({ value: agiAmount }));
  await tx("WAGI.transfer(new AGI pair)", publicClient, wagi.write.transfer([pairDlAgi, agiAmount]));
  await tx("PairManager.initPair AGI", publicClient, pairManager.write.initPair([pairDlAgi, 0n]));

  await tx(
    "Factory.setCoreGlobals(new PairManager)",
    publicClient,
    factory.write.setCoreGlobals([base.dlToken, base.dealInfoNFT, base.wrappedNative, newPairManager.address]),
  );

  if (registry) {
    await tx(
      "SwapAssetRegistry.setSwapAssets(new PairManager)",
      publicClient,
      registry.write.setSwapAssets([
        newPairManager.address,
        base.dealRouter,
        base.dlToken,
        base.wrappedNative,
        base.usdt,
        base.ausd,
      ]),
    );
  }

  const pair = await viem.getContractAt("DealSwapTemplate", pairDlAgi, { client }) as AnyContract;
  const realReserves = await pair.read.getReserves();
  const virtualReserves = await pair.read.getVirtualReserves();
  const factoryPairManager = getAddress(await factory.read.dealPairManager()) as Address;
  const mappedAgi = getAddress(await pairManager.read.pairForToken([base.wrappedNative])) as Address;

  const now = new Date();
  mkdirSync(join(process.cwd(), "deployments", "backups"), { recursive: true });
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  const mainFile = join(process.cwd(), "deployments", DEPLOYMENT_FILE);
  copyFileSync(mainFile, join(process.cwd(), "deployments", "backups", `agiking-31415926.before-real-agi-pair-${stamp}.json`));

  const updated = {
    ...deploymentJson,
    updatedAt: now.toISOString(),
    note: "AGI pair replaced with real reserves: 500,000 DC + 50 AGI, no virtual AGI reserve.",
    addresses: {
      ...deploymentJson.addresses,
      dealPairManager: getAddress(newPairManager.address),
      pairDlAgi,
    },
    abi: refreshAbi(deploymentJson.abi ?? {}),
  };
  writeFileSync(mainFile, JSON.stringify(updated, null, 2), "utf8");
  writeFileSync(join(process.cwd(), "deployments", `agiking-31415926-${stamp}.json`), JSON.stringify(updated, null, 2), "utf8");

  const handoffFile = join(process.cwd(), "deployments", `frontend-handoff-real-agi-pair-${stamp}.md`);
  writeFileSync(
    handoffFile,
    `# Real AGI Pair Handoff

ChainId: ${AGIKING_CHAIN_ID}
UpdatedAt: ${now.toISOString()}

## Changed Addresses

| Name | Address |
| --- | --- |
| DealPairManager | ${getAddress(newPairManager.address)} |
| DC/AGI Pair | ${pairDlAgi} |

## Unchanged Entry Points

| Name | Address |
| --- | --- |
| DealFactory | ${base.dealFactory} |
| DealRouter | ${base.dealRouter} |
| DealRouterQuoter | ${base.dealRouterQuoter ?? ""} |
| DealSwapAssetRegistry | ${base.dealSwapAssetRegistry ?? ""} |
| DC | ${base.dlToken} |
| WAGI / AGI | ${base.wrappedNative} |

## New AGI Pair Reserves

- Real DC: ${formatUnits(realReserves[0], 18)}
- Real AGI/WAGI: ${formatUnits(realReserves[1], 18)}
- Virtual reserve0: ${formatUnits(virtualReserves[0], 18)}
- Virtual reserve1: ${formatUnits(virtualReserves[1], 18)}

## Frontend Notes

- Use the updated deployments/agiking-31415926.json.
- AGI pair no longer relies on virtual AGI reserve.
- DC -> AGI can now pay out real AGI/WAGI from the pair reserve.
`,
    "utf8",
  );

  const frontDoc = join(process.cwd(), "docs", "前端部署地址交接文档.md");
  const updateBlock = `\n\n## 2026-06-03 AGI 真实流动性池更新\n\n- 本次 AGI 池更新交接文档：\`${handoffFile.replace(process.cwd() + "/", "")}\`\n- 新 \`DealPairManager\`：\`${getAddress(newPairManager.address)}\`\n- 新 \`DC/AGI Pair\`：\`${pairDlAgi}\`\n- \`DealFactory.dealPairManager()\` 已切到新 \`DealPairManager\`\n- \`DealSwapAssetRegistry\` 已切到新 \`DealPairManager\`\n- 新 AGI 池真实储备：\`500,000 DC + 50 AGI\`\n- 新 AGI 池不使用虚拟 AGI 流动性\n`;
  let frontDocBody = "";
  try {
    frontDocBody = readFileSync(frontDoc, "utf8");
    frontDocBody = frontDocBody.replace(/\n\n## 2026-06-03 AGI 真实流动性池更新[\s\S]*$/u, "");
  } catch {
    frontDocBody = `# 前端部署地址交接文档\n\n完整 ABI 和地址在：\n\n\`deployments/agiking-31415926.json\`\n`;
  }
  writeFileSync(
    frontDoc,
    `${frontDocBody.trimEnd()}${updateBlock}\n`,
    "utf8",
  );

  console.log("Verification", {
    factoryPairManager,
    mappedAgi,
    realReserves: realReserves.map((x: bigint) => x.toString()),
    virtualReserves: virtualReserves.map((x: bigint) => x.toString()),
  });
  console.log("Wrote", mainFile);
  console.log("Wrote", handoffFile);
  console.log("Wrote", frontDoc);
}

await main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
