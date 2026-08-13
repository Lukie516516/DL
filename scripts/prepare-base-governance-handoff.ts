/**
 * Builds the exact Base local authority-handoff calldata without a wallet or transaction path.
 *
 * Required:
 *   BASE_DEPLOYMENT_FILE=deployments/...json
 *   BASE_EXECUTOR_ADDRESS=0x...
 *   BASE_DEPLOYER_ADDRESS=0x...
 * Optional:
 *   ETH_CROSS_CHAIN_V2_BROADCASTER=0x... (defaults to the current production V2 broadcaster)
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { getAddress, type Address } from "viem";

import {
  BASE_FIXED_OR_READ_ONLY_MODULES,
  baseGovernanceTargets,
  buildBaseGovernanceHandoffPlan,
} from "./lib/base-governance-plan.js";

const CURRENT_ETH_BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");

type DeploymentJson = {
  chainId: number;
  network?: string;
  deployer?: Address;
  addresses: Record<string, Address>;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

const requestedFile = required("BASE_DEPLOYMENT_FILE");
const file = isAbsolute(requestedFile) ? requestedFile : join(process.cwd(), requestedFile);
const deployment = JSON.parse(readFileSync(file, "utf8")) as DeploymentJson;
if (deployment.chainId !== 8453) throw new Error(`Expected Base chainId 8453, got ${deployment.chainId}`);

const executor = getAddress(required("BASE_EXECUTOR_ADDRESS"));
const deployer = getAddress(required("BASE_DEPLOYER_ADDRESS"));
const ethBroadcaster = getAddress(
  process.env.ETH_CROSS_CHAIN_V2_BROADCASTER?.trim() || CURRENT_ETH_BROADCASTER,
);
const targets = baseGovernanceTargets(deployment.addresses, executor);
const actions = buildBaseGovernanceHandoffPlan({
  addresses: deployment.addresses,
  executor,
  deployer,
  ethBroadcaster,
});

console.log(JSON.stringify({
  scope: "offline Base governance handoff plan; no RPC, wallet, signing, or transaction path",
  chainId: deployment.chainId,
  network: deployment.network,
  deploymentFile: file,
  executor,
  deployer,
  ethBroadcaster,
  governanceTargets: targets,
  fixedOrReadOnlyModules: BASE_FIXED_OR_READ_ONLY_MODULES,
  actionCount: actions.length,
  requiredOrder: [
    "executor-config",
    "protocol-handoff",
    "token-roles",
    "auxiliary-handoff",
    "finalize",
  ],
  warning: "Executor.transferOwnership(self) is intentionally last. Do not submit any action before a fresh fork rehearsal and explicit mainnet authorization.",
  actions,
}, null, 2));
