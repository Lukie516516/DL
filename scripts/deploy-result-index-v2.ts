/**
 * deploy-result-index-v2.ts
 *
 * 部署 DealResultIndexV2 并将 DealFactory 切换到新合约。
 *
 * 节省 gas：每笔完整 deal 节省约 777,000 gas（≈ $40 on ETH, ≈ $0.9 on BSC）。
 *
 * 运行：
 *   npx hardhat run scripts/deploy-result-index-v2.ts --network agiking
 *
 * 步骤：
 *   1. 部署 DealResultIndexV2（factory = dealFactory 地址）
 *   2. 调用 DealFactory.setServiceGlobals(0, 0, 0, v2Address, 0)
 *
 * 历史数据：
 *   旧 DealResultIndex 合约保留在链上，历史 deal 仍可查询。
 *   前端用区块高度区分新旧：<cutoffBlock 查 V1，>=cutoffBlock 查 V2 事件。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import { zeroAddress, type Address } from "viem";

const DEPLOYMENT_FILE = "deployments/agiking-31415926.json";
const DEPLOYER        = "0xe88c63d29ece76e3336b0db747e10876c3bf9893" as Address;

async function main() {
  const { viem } = await network.connect({ network: "agiking" });
  const publicClient = await viem.getPublicClient();

  // ── 读取当前部署状态 ──────────────────────────────────────────────────────────
  let doc: Record<string, any> = {};
  try { doc = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")); } catch {}
  const state: Record<string, string> = doc.addresses ?? {};

  const dealFactory = state.dealFactory as Address | undefined;
  if (!dealFactory) {
    throw new Error(`dealFactory not found in ${DEPLOYMENT_FILE}`);
  }

  console.log("DealFactory:", dealFactory);
  console.log("Deployer:", DEPLOYER);
  console.log("Network: Agiking (31415926)");
  console.log();

  // ── Step 1: 部署 DealResultIndexV2 ──────────────────────────────────────────
  console.log("Step 1: Deploying DealResultIndexV2...");
  const v2 = await viem.deployContract("DealResultIndexV2", [dealFactory]);
  console.log("  DealResultIndexV2:", v2.address);

  // deployContract 已等待部署完成，直接获取当前区块
  const deployBlock = await publicClient.getBlockNumber();
  console.log("  Deployed at block:", deployBlock);
  console.log();

  // ── Step 2: 调用 setServiceGlobals ──────────────────────────────────────────
  console.log("Step 2: Updating DealFactory.dealResultIndex...");

  const factory = await viem.getContractAt("DealFactory", dealFactory);
  const setTx = await factory.write.setServiceGlobals(
    [zeroAddress, zeroAddress, zeroAddress, v2.address, zeroAddress]
  );
  const setReceipt = await publicClient.waitForTransactionReceipt({ hash: setTx });
  console.log("  setServiceGlobals tx:", setTx);
  console.log("  Block:", setReceipt.blockNumber);
  console.log();

  // 验证切换成功
  const newResultIndex = await factory.read.dealResultIndex();
  if (newResultIndex.toLowerCase() !== v2.address.toLowerCase()) {
    throw new Error(`Verification failed: DealFactory.dealResultIndex = ${newResultIndex}, expected ${v2.address}`);
  }
  console.log("  Verified: DealFactory.dealResultIndex =", newResultIndex);
  console.log();

  // ── 更新部署状态文件 ──────────────────────────────────────────────────────────
  state.dealResultIndexV1 = state.dealResultIndex ?? "";
  state.dealResultIndex   = v2.address;
  state.dealResultIndexV2 = v2.address;
  state.dealResultIndexV2CutoffBlock = String(setReceipt.blockNumber);

  doc.addresses = state;
  writeFileSync(DEPLOYMENT_FILE, JSON.stringify(doc, null, 2));
  console.log(`Updated ${DEPLOYMENT_FILE}`);
  console.log();

  console.log("=== 部署完成 ===");
  console.log("DealResultIndexV2:", v2.address);
  console.log("V1 (历史, 只读):", state.dealResultIndexV1);
  console.log("切换区块高度:", state.dealResultIndexV2CutoffBlock);
  console.log();
  console.log("前端切换说明：");
  console.log("  - 查询用户 deal 列表：resultIndexV2.getDealsByUser(user, 0, 100, true)");
  console.log("  - 查询 timeline：getLogs({ address: deal, event: '...' })");
  console.log("  - 查询奖励：getLogs({ address: resultIndexV2, event: 'DealReward', ... })");
  console.log("  - 查询信用：getLogs({ address: resultIndexV2, event: 'DealCredit', ... })");
  console.log("  - 历史 deal (<= 切换区块)：仍查旧 V1 合约", state.dealResultIndexV1);
}

main().catch((err) => { console.error(err); process.exit(1); });
