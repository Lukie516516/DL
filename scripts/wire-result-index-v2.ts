/**
 * wire-result-index-v2.ts
 * 仅执行 DealFactory.setServiceGlobals 切换到已部署的 DealResultIndexV2。
 * 合约已部署：0x27acf92bcf76a40f55b134e5ab45f6c298907a59
 */

import { readFileSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import { zeroAddress, type Address } from "viem";

const DEPLOYMENT_FILE  = "deployments/agiking-31415926.json";
const V2_ADDRESS       = "0x27acf92bcf76a40f55b134e5ab45f6c298907a59" as Address;

async function main() {
  const { viem } = await network.connect({ network: "agiking" });
  const publicClient = await viem.getPublicClient();

  let doc: Record<string, any> = {};
  try { doc = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")); } catch {}
  const state: Record<string, string> = doc.addresses ?? {};

  const dealFactory = state.dealFactory as Address;
  console.log("DealFactory:", dealFactory);
  console.log("DealResultIndexV2:", V2_ADDRESS);
  console.log();

  const factory = await viem.getContractAt("DealFactory", dealFactory);

  // 确认 V2 factory 指向正确
  const v2 = await viem.getContractAt("DealResultIndexV2", V2_ADDRESS);
  const v2Factory = await v2.read.factory();
  if (v2Factory.toLowerCase() !== dealFactory.toLowerCase()) {
    throw new Error(`V2.factory = ${v2Factory}, expected ${dealFactory}`);
  }
  console.log("V2.factory verified:", v2Factory);
  console.log();

  console.log("Calling setServiceGlobals...");
  const setTx = await factory.write.setServiceGlobals(
    [zeroAddress, zeroAddress, zeroAddress, V2_ADDRESS, zeroAddress]
  );
  console.log("  tx:", setTx);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: setTx });
  console.log("  confirmed at block:", receipt.blockNumber);
  console.log();

  // 验证
  const newIndex = await factory.read.dealResultIndex();
  if (newIndex.toLowerCase() !== V2_ADDRESS.toLowerCase()) {
    throw new Error(`Verification failed: got ${newIndex}`);
  }
  console.log("Verified: DealFactory.dealResultIndex =", newIndex);
  console.log();

  // 更新 deployment 文件
  state.dealResultIndexV1            = state.dealResultIndex ?? "";
  state.dealResultIndex              = V2_ADDRESS;
  state.dealResultIndexV2            = V2_ADDRESS;
  state.dealResultIndexV2CutoffBlock = String(receipt.blockNumber);
  doc.addresses = state;
  writeFileSync(DEPLOYMENT_FILE, JSON.stringify(doc, null, 2));
  console.log("Updated", DEPLOYMENT_FILE);
  console.log();

  console.log("=== 接线完成 ===");
  console.log("V1 (历史只读):", state.dealResultIndexV1);
  console.log("V2 (当前)    :", V2_ADDRESS);
  console.log("切换区块      :", state.dealResultIndexV2CutoffBlock);
}

main().catch((err) => { console.error(err); process.exit(1); });
