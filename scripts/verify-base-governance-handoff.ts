/**
 * Read-only post-handoff audit for Base. This file creates no wallet client and cannot send transactions.
 *
 * Required:
 *   BASE_DEPLOYMENT_FILE=deployments/...json
 *   BASE_EXECUTOR_ADDRESS=0x...
 * Optional:
 *   BASE_MAINNET_RPC_URL=...
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  padHex,
  parseAbi,
  type Address,
} from "viem";
import { base } from "viem/chains";

import { BASE_MAINNET } from "./lib/evm-chain-config.js";
import {
  DC_DEFAULT_ADMIN_ROLE,
  DC_MINTER_ROLE,
  DC_PAUSER_ROLE,
  ETH_LAYERZERO_EID,
  baseGovernanceTargets,
} from "./lib/base-governance-plan.js";

const CURRENT_ETH_BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const RPCS = [
  process.env.BASE_MAINNET_RPC_URL,
  "https://mainnet.base.org",
  "https://base.drpc.org",
].filter((url, index, values): url is string => Boolean(url) && values.indexOf(url) === index);

const ownerAbi = parseAbi(["function owner() view returns (address)"]);
const executorAbi = parseAbi([
  "function owner() view returns (address)",
  "function endpoint() view returns (address)",
  "function peers(uint32) view returns (bytes32)",
  "function allowedTargets(address) view returns (bool)",
  "function ccipRouter() view returns (address)",
  "function ccipSrcChainSelector() view returns (uint64)",
  "function ccipSrcSender() view returns (address)",
  "function axelarGateway() view returns (address)",
  "function axSrcChain() view returns (string)",
  "function axSrcAddress() view returns (string)",
  "function threshold() view returns (uint256)",
]);
const factoryAbi = parseAbi([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function crossChainGovernance() view returns (address)",
]);
const treasuryAbi = parseAbi([
  "function controller() view returns (address)",
  "function bootstrapLocked() view returns (bool)",
]);
const tokenAbi = parseAbi(["function hasRole(bytes32,address) view returns (bool)"]);
const infoNftAbi = parseAbi([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
]);
const endpointAbi = parseAbi(["function delegates(address) view returns (address)"]);

type DeploymentJson = { chainId: number; deployer: Address; addresses: Record<string, Address> };
type Check = { name: string; ok: boolean; actual: string; expected: string };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}
function addressCheck(name: string, actual: Address, expected: Address): Check {
  return {
    name,
    ok: getAddress(actual) === getAddress(expected),
    actual: getAddress(actual),
    expected: getAddress(expected),
  };
}
function boolCheck(name: string, actual: boolean, expected = true): Check {
  return { name, ok: actual === expected, actual: String(actual), expected: String(expected) };
}

async function main() {
  const requestedFile = required("BASE_DEPLOYMENT_FILE");
  const file = isAbsolute(requestedFile) ? requestedFile : join(process.cwd(), requestedFile);
  const deployment = JSON.parse(readFileSync(file, "utf8")) as DeploymentJson;
  if (deployment.chainId !== BASE_MAINNET.chainId) {
    throw new Error(`Expected Base chainId ${BASE_MAINNET.chainId}, got ${deployment.chainId}`);
  }
  const executor = getAddress(required("BASE_EXECUTOR_ADDRESS"));
  const broadcaster = getAddress(
    process.env.ETH_CROSS_CHAIN_V2_BROADCASTER?.trim() || CURRENT_ETH_BROADCASTER,
  );
  const client = createPublicClient({
    chain: base,
    transport: fallback(RPCS.map((url) => http(url)), { rank: false }),
  });
  const checks: Check[] = [];
  const targets = baseGovernanceTargets(deployment.addresses, executor);

  for (const target of targets) {
    const code = await client.getCode({ address: target.address });
    checks.push(boolCheck(`${target.key}.runtime`, Boolean(code && code !== "0x")));
    checks.push(boolCheck(`${target.key}.allowedTarget`, await client.readContract({
      address: executor,
      abi: executorAbi,
      functionName: "allowedTargets",
      args: [target.address],
    })));
  }

  checks.push(addressCheck("executor.owner", await client.readContract({
    address: executor, abi: executorAbi, functionName: "owner",
  }), executor));
  checks.push(addressCheck("executor.endpoint", await client.readContract({
    address: executor, abi: executorAbi, functionName: "endpoint",
  }), BASE_MAINNET.lzEndpoint));
  checks.push(addressCheck("executor.ccipRouter", await client.readContract({
    address: executor, abi: executorAbi, functionName: "ccipRouter",
  }), BASE_MAINNET.ccipRouter));
  checks.push(addressCheck("executor.ccipSrcSender", await client.readContract({
    address: executor, abi: executorAbi, functionName: "ccipSrcSender",
  }), broadcaster));
  checks.push(addressCheck("executor.axelarGateway", await client.readContract({
    address: executor, abi: executorAbi, functionName: "axelarGateway",
  }), BASE_MAINNET.axelarGateway));
  checks.push(addressCheck("layerZero.delegate", await client.readContract({
    address: BASE_MAINNET.lzEndpoint, abi: endpointAbi, functionName: "delegates", args: [executor],
  }), executor));
  checks.push(boolCheck("executor.peer.ethereum", (await client.readContract({
    address: executor, abi: executorAbi, functionName: "peers", args: [ETH_LAYERZERO_EID],
  })).toLowerCase() === padHex(broadcaster, { size: 32 }).toLowerCase()));
  checks.push(boolCheck("executor.ccipSelector.ethereum", (await client.readContract({
    address: executor, abi: executorAbi, functionName: "ccipSrcChainSelector",
  })) === 5_009_297_550_715_157_269n));
  checks.push(boolCheck("executor.threshold", (await client.readContract({
    address: executor, abi: executorAbi, functionName: "threshold",
  })) === 2n));
  checks.push(boolCheck("executor.axelarSourceChain", (await client.readContract({
    address: executor, abi: executorAbi, functionName: "axSrcChain",
  })) === "Ethereum"));
  checks.push(boolCheck("executor.axelarSourceAddress", (await client.readContract({
    address: executor, abi: executorAbi, functionName: "axSrcAddress",
  })) === broadcaster));

  const factory = getAddress(deployment.addresses.dealFactory);
  checks.push(addressCheck("factory.owner", await client.readContract({
    address: factory, abi: factoryAbi, functionName: "owner",
  }), executor));
  checks.push(addressCheck("factory.admin", await client.readContract({
    address: factory, abi: factoryAbi, functionName: "admin",
  }), executor));
  checks.push(addressCheck("factory.crossChainGovernance", await client.readContract({
    address: factory, abi: factoryAbi, functionName: "crossChainGovernance",
  }), executor));

  const treasury = getAddress(deployment.addresses.protocolTreasury);
  checks.push(addressCheck("treasury.controller", await client.readContract({
    address: treasury, abi: treasuryAbi, functionName: "controller",
  }), executor));
  checks.push(boolCheck("treasury.bootstrapLocked", await client.readContract({
    address: treasury, abi: treasuryAbi, functionName: "bootstrapLocked",
  })));

  const dc = getAddress(deployment.addresses.dlToken);
  for (const [name, role, account, expected] of [
    ["dc.executorAdmin", DC_DEFAULT_ADMIN_ROLE, executor, true],
    ["dc.executorMinter", DC_MINTER_ROLE, executor, true],
    ["dc.executorPauser", DC_PAUSER_ROLE, executor, true],
    ["dc.factoryMinter", DC_MINTER_ROLE, factory, true],
    ["dc.deployerAdminRemoved", DC_DEFAULT_ADMIN_ROLE, deployment.deployer, false],
    ["dc.deployerMinterRemoved", DC_MINTER_ROLE, deployment.deployer, false],
  ] as const) {
    checks.push(boolCheck(name, await client.readContract({
      address: dc, abi: tokenAbi, functionName: "hasRole", args: [role, getAddress(account)],
    }), expected));
  }

  const infoNft = getAddress(deployment.addresses.dealInfoNFT);
  checks.push(addressCheck("infoNft.owner", await client.readContract({
    address: infoNft, abi: infoNftAbi, functionName: "owner",
  }), executor));
  checks.push(addressCheck("infoNft.admin", await client.readContract({
    address: infoNft, abi: infoNftAbi, functionName: "admin",
  }), executor));

  for (const key of [
    "dealPairManager",
    "dealImplementationRegistry",
    "dealCreditGraph",
    "dealSwapOrderBook",
    "dealSwapAssetRegistry",
    "dcDomain",
    "dcDomainRank",
    "dcDomainMarket",
    "dcDomainSwap",
  ]) {
    const target = getAddress(deployment.addresses[key]);
    checks.push(addressCheck(`${key}.owner`, await client.readContract({
      address: target, abi: ownerAbi, functionName: "owner",
    }), executor));
  }

  const blockers = checks.filter((check) => !check.ok).map((check) => check.name);
  console.log(JSON.stringify({
    scope: "read-only Base post-handoff audit; no wallet or transaction path",
    checkedAt: new Date().toISOString(),
    blockNumber: (await client.getBlockNumber()).toString(),
    deploymentFile: file,
    executor,
    checks,
    blockers,
    readyForCanary: blockers.length === 0,
    readyForMainnetWrites: false,
    mainnetReason: "Canary and all later writes require separate explicit authorization.",
  }, null, 2));
  if (blockers.length !== 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
