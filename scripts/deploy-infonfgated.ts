/**
 * deploy-infonfgated.ts
 * 部署 InfoNftGated 功能：
 *   1. 新 DealOpenTokenToken impl
 *   2. 新 DealFactory impl + proxy 升级
 *   3. DealImplementationRegistry 更新 openTokenToken impl
 *   4. 新 DCdomainswap + 新 DCDomainHall
 *   5. 接线
 */

import { network } from "hardhat";
import { defineChain, getAddress, type Address } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CHAIN_ID = 31415926;
const DEPLOY_JSON = join(process.cwd(), "deployments/agiking-31415926.json");

const ADDRS = {
  factory:           "0xd0Fc2685945790df25bDdeaA69426a348D05775B" as Address,
  implRegistry:      "0x8bB59bb5269EE46F56fddD7BDbCC498c17B84DE3" as Address,
  dealInfoNFT:       "0x7E4eD273FAc90A87Ea4C2205B7c37d4A31B08844" as Address,
  dcDomainRank:      "0x64939D6Badff45eE73B936fd4F5cEAE6cbCb4a3B" as Address,
  dcDomain:          "0x481Fc5092485df2eDc549e69C9F1aC4F99239009" as Address,
  oldDcSwap:         "0x3BddfeC5bAcAC7cfF2dbB7Ae896CBEEdc7374250" as Address,
  oldDcHall:         "0x1849e96CAB80B672357bAeab165A670a1638F0bf" as Address,
  fallbackImpl:      "0xD198726d2033542b26259245a03F441FaC707305" as Address,
  noAssetImpl:       "0x2d88250530690c7CaCA08e2ea1dd9C29Eee59391" as Address,
  aAssetNftImpl:     "0x5e9bdb4eC4643D51FBf7f8fa9248DE884f8e27Df" as Address,
  bAssetNftImpl:     "0xD8d59d9E8CB8d7972003e3Ed6AA99F37Da4401d3" as Address,
  aAssetNftOnlyImpl: "0xAd0Dc2C46C0D02ab456A05F4f03C11c22980b79a" as Address,
  bAssetNftOnlyImpl: "0xaAACda6CFF9B91306aB0D31DD607D7237851dE45" as Address,
};

const gasOpts = { gas: 6_000_000n } as const;

async function main() {
  const rpcUrl = (process.env.AGIKING_RPC_URL ?? "https://rpc.agikingrpc.shop").trim();
  const chain = defineChain({
    id: CHAIN_ID, name: "Agiking",
    nativeCurrency: { decimals: 18, name: "AGI", symbol: "AGI" },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const { viem } = await (network as any).connect({ network: "agiking", chainType: "l1" });
  const pub = await viem.getPublicClient({ chain });
  const [deployer] = await viem.getWalletClients({ chain });
  const client = { public: pub, wallet: deployer } as const;

  const confirm = async (label: string, hash: `0x${string}`) => {
    console.log(`  tx: ${hash}`);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} reverted`);
    console.log(`  ✓ ${label}`);
    return r;
  };

  // ── 1. 新 DealOpenTokenToken impl ────────────────────────────────────
  console.log("\n[1] Deploy DealOpenTokenToken impl");
  const ottContract = await viem.deployContract("DealOpenTokenToken", [], {
    client, ...gasOpts,
    libraries: { "project/contracts/utils/DealLib.sol:DealLib": "0x1257D38db0213cCDf1A44ED7A2267c416A0d1feE" as Address },
  });
  const newOttImpl = getAddress(ottContract.address) as Address;
  console.log("  →", newOttImpl);

  // ── 2. 新 DealFactory impl ────────────────────────────────────────────
  console.log("\n[2] Deploy DealFactory impl");
  const dfImplContract = await viem.deployContract("DealFactory", [], { client, ...gasOpts });
  const newDfImpl = getAddress(dfImplContract.address) as Address;
  console.log("  →", newDfImpl);

  // ── 3. 升级 DealFactory proxy ─────────────────────────────────────────
  console.log("\n[3] Upgrade DealFactory proxy");
  const factory = await viem.getContractAt("DealFactory", ADDRS.factory, { client });
  await confirm("upgradeToAndCall",
    await factory.write.upgradeToAndCall([newDfImpl, "0x"]));

  // ── 4. 更新 DealImplementationRegistry ───────────────────────────────
  console.log("\n[4] DealImplementationRegistry.setDealImplementations");
  const reg = await viem.getContractAt("DealImplementationRegistry", ADDRS.implRegistry, { client });
  await confirm("setDealImplementations",
    await reg.write.setDealImplementations([
      ADDRS.fallbackImpl,
      ADDRS.noAssetImpl,
      ADDRS.aAssetNftImpl,
      ADDRS.bAssetNftImpl,
      ADDRS.aAssetNftOnlyImpl,
      ADDRS.bAssetNftOnlyImpl,
      newOttImpl,
    ]));

  // ── 5. 新 DCdomainswap ────────────────────────────────────────────────
  console.log("\n[5] Deploy DCdomainswap");
  const swapContract = await viem.deployContract(
    "DCDomainSwap",
    [ADDRS.factory, ADDRS.dcDomain, ADDRS.dcDomainRank],
    { client, ...gasOpts }
  );
  const newSwap = getAddress(swapContract.address) as Address;
  console.log("  →", newSwap);

  // ── 6. 新 DCDomainHall ────────────────────────────────────────────────
  console.log("\n[6] Deploy DCDomainHall");
  const hallContract = await viem.deployContract(
    "DCDomainHall",
    [ADDRS.dcDomainRank, ADDRS.dcDomain, ADDRS.factory, ADDRS.dealInfoNFT],
    { client, ...gasOpts }
  );
  const newHall = getAddress(hallContract.address) as Address;
  console.log("  →", newHall);

  // ── 7. 接线 ──────────────────────────────────────────────────────────
  console.log("\n[7] Wiring");
  await confirm("setAllowedCreateFor(newSwap, true)",
    await factory.write.setAllowedCreateFor([newSwap, true]));
  await confirm("setAllowedCreateFor(newHall, true)",
    await factory.write.setAllowedCreateFor([newHall, true]));
  await confirm("setAllowedCreateFor(oldSwap, false)",
    await factory.write.setAllowedCreateFor([ADDRS.oldDcSwap, false]));
  await confirm("setAllowedCreateFor(oldHall, false)",
    await factory.write.setAllowedCreateFor([ADDRS.oldDcHall, false]));

  // ── 8. 更新 deployments JSON ─────────────────────────────────────────
  console.log("\n[8] Update deployments JSON");
  const dep = JSON.parse(readFileSync(DEPLOY_JSON, "utf8"));
  dep.addresses.oldDcDomainSwap2               = ADDRS.oldDcSwap;
  dep.addresses.oldDcDomainHall2               = ADDRS.oldDcHall;
  dep.addresses.oldDealFactoryImpl2            = dep.addresses.dealFactoryImpl;
  dep.addresses.oldDealOpenTokenTokenImpl      = dep.addresses.dealOpenTokenTokenImplementation;
  dep.addresses.dcDomainSwap                   = newSwap;
  dep.addresses.dcDomainHall                   = newHall;
  dep.addresses.dealFactoryImpl                = newDfImpl;
  dep.addresses.dealOpenTokenTokenImplementation = newOttImpl;
  writeFileSync(DEPLOY_JSON, JSON.stringify(dep, null, 2));
  console.log("  ✓ deployments/agiking-31415926.json updated");

  console.log("\n═══════════════════════════════════════════════");
  console.log("✓ InfoNftGated 部署完成");
  console.log("  新 DealOpenTokenToken impl :", newOttImpl);
  console.log("  新 DealFactory impl        :", newDfImpl);
  console.log("  新 DCdomainswap            :", newSwap);
  console.log("  新 DCDomainHall            :", newHall);
  console.log("═══════════════════════════════════════════════");
}

await main().catch(err => { console.error(err); process.exitCode = 1; });
