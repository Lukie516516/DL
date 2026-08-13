import {
  encodeFunctionData,
  getAddress,
  keccak256,
  padHex,
  toBytes,
  zeroHash,
  type Address,
  type Hex,
} from "viem";

export const ETH_LAYERZERO_EID = 30_101;
export const DC_DEFAULT_ADMIN_ROLE = zeroHash;
export const DC_MINTER_ROLE = keccak256(toBytes("MINTER_ROLE"));
export const DC_PAUSER_ROLE = keccak256(toBytes("PAUSER_ROLE"));

export const BASE_GOVERNANCE_ADDRESS_KEYS = [
  "dealFactory",
  "dlToken",
  "protocolTreasury",
  "dealPairManager",
  "dealImplementationRegistry",
  "dealInfoNFT",
  "dealCreditGraph",
  "dealSwapOrderBook",
  "dealSwapAssetRegistry",
  "dcDomain",
  "dcDomainRank",
  "dcDomainMarket",
  "dcDomainSwap",
] as const;

export const BASE_FIXED_OR_READ_ONLY_MODULES = [
  "dealMessageHub",
  "dealActivityIndex",
  "dealResultIndex",
  "dealInfoNFTRenderer",
  "dealRouter",
  "dealRouterQuoter",
  "dealReader",
  "dcDomainRankReader",
  "dcDomainListReader",
  "dcDomainHall",
] as const;

export type BaseGovernanceAddressKey = (typeof BASE_GOVERNANCE_ADDRESS_KEYS)[number];
export type BaseDeploymentAddresses = Record<string, Address> &
  Record<BaseGovernanceAddressKey, Address>;

export type BaseGovernanceAction = {
  phase: "executor-config" | "protocol-handoff" | "token-roles" | "auxiliary-handoff" | "finalize";
  label: string;
  target: Address;
  data: Hex;
};

const executorAbi = [
  {
    type: "function",
    name: "setPeer",
    stateMutability: "nonpayable",
    inputs: [{ name: "eid", type: "uint32" }, { name: "peer", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setAllowedTarget",
    stateMutability: "nonpayable",
    inputs: [{ name: "target", type: "address" }, { name: "allowed", type: "bool" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setDelegate",
    stateMutability: "nonpayable",
    inputs: [{ name: "delegate", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "transferOwnership",
    stateMutability: "nonpayable",
    inputs: [{ name: "newOwner", type: "address" }],
    outputs: [],
  },
] as const;

const factoryAbi = [
  {
    type: "function",
    name: "setCrossChainGovernance",
    stateMutability: "nonpayable",
    inputs: [{ name: "governance", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setAdmin",
    stateMutability: "nonpayable",
    inputs: [{ name: "admin", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "transferOwnership",
    stateMutability: "nonpayable",
    inputs: [{ name: "newOwner", type: "address" }],
    outputs: [],
  },
] as const;

const treasuryAbi = [
  {
    type: "function",
    name: "bootstrapSetController",
    stateMutability: "nonpayable",
    inputs: [{ name: "controller", type: "address" }],
    outputs: [],
  },
  { type: "function", name: "lockBootstrap", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

const accessControlAbi = [
  {
    type: "function",
    name: "grantRole",
    stateMutability: "nonpayable",
    inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "renounceRole",
    stateMutability: "nonpayable",
    inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }],
    outputs: [],
  },
] as const;

const ownableAbi = [{
  type: "function",
  name: "transferOwnership",
  stateMutability: "nonpayable",
  inputs: [{ name: "newOwner", type: "address" }],
  outputs: [],
}] as const;

const customOwnerAbi = [{
  type: "function",
  name: "transferOwner",
  stateMutability: "nonpayable",
  inputs: [{ name: "newOwner", type: "address" }],
  outputs: [],
}] as const;

const infoNftAdminAbi = [{
  type: "function",
  name: "setAdmin",
  stateMutability: "nonpayable",
  inputs: [{ name: "admin", type: "address" }],
  outputs: [],
}] as const;

function requireAddress(addresses: Record<string, Address>, key: BaseGovernanceAddressKey): Address {
  const value = addresses[key];
  if (!value) throw new Error(`Missing Base deployment address: ${key}`);
  return getAddress(value);
}

export function baseGovernanceTargets(
  addresses: Record<string, Address>,
  executor: Address,
): Array<{ key: "executor" | BaseGovernanceAddressKey; address: Address }> {
  return [
    { key: "executor", address: getAddress(executor) },
    ...BASE_GOVERNANCE_ADDRESS_KEYS.map((key) => ({ key, address: requireAddress(addresses, key) })),
  ];
}

export function buildBaseGovernanceHandoffPlan(input: {
  addresses: Record<string, Address>;
  executor: Address;
  deployer: Address;
  ethBroadcaster: Address;
}): BaseGovernanceAction[] {
  const executor = getAddress(input.executor);
  const deployer = getAddress(input.deployer);
  const ethBroadcaster = getAddress(input.ethBroadcaster);
  const a = Object.fromEntries(
    BASE_GOVERNANCE_ADDRESS_KEYS.map((key) => [key, requireAddress(input.addresses, key)]),
  ) as Record<BaseGovernanceAddressKey, Address>;
  const actions: BaseGovernanceAction[] = [];
  const add = (
    phase: BaseGovernanceAction["phase"],
    label: string,
    target: Address,
    data: Hex,
  ) => actions.push({ phase, label, target: getAddress(target), data });

  add("executor-config", "Executor.setPeer(Ethereum)", executor, encodeFunctionData({
    abi: executorAbi,
    functionName: "setPeer",
    args: [ETH_LAYERZERO_EID, padHex(ethBroadcaster, { size: 32 })],
  }));
  for (const target of baseGovernanceTargets(a, executor)) {
    add("executor-config", `Executor.allow(${target.key})`, executor, encodeFunctionData({
      abi: executorAbi,
      functionName: "setAllowedTarget",
      args: [target.address, true],
    }));
  }
  add("executor-config", "Executor.setDelegate(self)", executor, encodeFunctionData({
    abi: executorAbi,
    functionName: "setDelegate",
    args: [executor],
  }));

  add("protocol-handoff", "Factory.setCrossChainGovernance", a.dealFactory, encodeFunctionData({
    abi: factoryAbi,
    functionName: "setCrossChainGovernance",
    args: [executor],
  }));
  add("protocol-handoff", "Factory.setAdmin", a.dealFactory, encodeFunctionData({
    abi: factoryAbi,
    functionName: "setAdmin",
    args: [executor],
  }));
  add("protocol-handoff", "Factory.transferOwnership", a.dealFactory, encodeFunctionData({
    abi: factoryAbi,
    functionName: "transferOwnership",
    args: [executor],
  }));
  add("protocol-handoff", "Treasury.bootstrapSetController", a.protocolTreasury, encodeFunctionData({
    abi: treasuryAbi,
    functionName: "bootstrapSetController",
    args: [executor],
  }));
  add("protocol-handoff", "Treasury.lockBootstrap", a.protocolTreasury, encodeFunctionData({
    abi: treasuryAbi,
    functionName: "lockBootstrap",
  }));

  const grants: Array<[string, Hex, Address]> = [
    ["DC.grant Factory MINTER_ROLE", DC_MINTER_ROLE, a.dealFactory],
    ["DC.grant Executor MINTER_ROLE", DC_MINTER_ROLE, executor],
    ["DC.grant Executor PAUSER_ROLE", DC_PAUSER_ROLE, executor],
    ["DC.grant Executor DEFAULT_ADMIN_ROLE", DC_DEFAULT_ADMIN_ROLE, executor],
  ];
  for (const [label, role, account] of grants) {
    add("token-roles", label, a.dlToken, encodeFunctionData({
      abi: accessControlAbi,
      functionName: "grantRole",
      args: [role, account],
    }));
  }
  for (const [label, role] of [
    ["DC.renounce deployer MINTER_ROLE", DC_MINTER_ROLE],
    ["DC.renounce deployer DEFAULT_ADMIN_ROLE", DC_DEFAULT_ADMIN_ROLE],
  ] as const) {
    add("token-roles", label, a.dlToken, encodeFunctionData({
      abi: accessControlAbi,
      functionName: "renounceRole",
      args: [role, deployer],
    }));
  }

  const customOwnerTargets: Array<[string, Address]> = [
    ["PairManager", a.dealPairManager],
    ["OrderBook", a.dealSwapOrderBook],
    ["AssetRegistry", a.dealSwapAssetRegistry],
    ["DCDomainSwap", a.dcDomainSwap],
  ];
  const ownableTargets: Array<[string, Address]> = [
    ["ImplementationRegistry", a.dealImplementationRegistry],
    ["InfoNFT", a.dealInfoNFT],
    ["CreditGraph", a.dealCreditGraph],
    ["DCDomain", a.dcDomain],
    ["DCDomainRank", a.dcDomainRank],
    ["DCDomainMarket", a.dcDomainMarket],
  ];
  add("auxiliary-handoff", "InfoNFT.setAdmin", a.dealInfoNFT, encodeFunctionData({
    abi: infoNftAdminAbi,
    functionName: "setAdmin",
    args: [executor],
  }));
  for (const [label, target] of customOwnerTargets) {
    add("auxiliary-handoff", `${label}.transferOwner`, target, encodeFunctionData({
      abi: customOwnerAbi,
      functionName: "transferOwner",
      args: [executor],
    }));
  }
  for (const [label, target] of ownableTargets) {
    add("auxiliary-handoff", `${label}.transferOwnership`, target, encodeFunctionData({
      abi: ownableAbi,
      functionName: "transferOwnership",
      args: [executor],
    }));
  }

  add("finalize", "Executor.transferOwnership(self) — MUST BE LAST", executor, encodeFunctionData({
    abi: executorAbi,
    functionName: "transferOwnership",
    args: [executor],
  }));
  return actions;
}
