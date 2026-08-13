import { getAddress, type Address } from "viem";

export type HardhatChainType = "l1" | "op";

export type DeploymentAsset = {
  address: Address;
  symbol: string;
  decimals: number;
  description: string;
  l1Token?: Address;
  bridge?: Address;
};

export type EvmDeploymentChain = {
  chainId: number;
  networkName: string;
  chainType: HardhatChainType;
  production: boolean;
  deployDaoByDefault: boolean;
  rpcEnvKeys: string[];
  treasuryEnvKeys: string[];
  stable0EnvKeys: string[];
  stable1EnvKeys: string[];
  wrappedNativeEnvKeys: string[];
  defaultStable0?: DeploymentAsset;
  defaultStable1?: DeploymentAsset;
  defaultWrappedNative?: DeploymentAsset;
};

export const BASE_MAINNET = {
  chainId: 8453,
  lzEid: 30184,
  ccipChainSelector: 15_971_525_489_660_198_786n,
  usdc: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  // Canonical Base Standard Bridge representation of Ethereum mainnet USDT.
  // It is not a Tether-native issuance on Base, so UIs must label it as bridged USDT.
  usdt: getAddress("0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"),
  ethereumUsdt: getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7"),
  standardBridge: getAddress("0x4200000000000000000000000000000000000010"),
  weth: getAddress("0x4200000000000000000000000000000000000006"),
  lzEndpoint: getAddress("0x1a44076050125825900e736c501f859c50fE728c"),
  ccipRouter: getAddress("0x881e3A65B4d4a04dD529061dd0071cf975F58bCD"),
  axelarGateway: getAddress("0xe432150cce91c13a887f7D836923d5597adD8E31"),
  axelarChainName: "base",
} as const;

export const BASE_SEPOLIA = {
  chainId: 84532,
  usdc: getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  weth: getAddress("0x4200000000000000000000000000000000000006"),
} as const;

const CHAINS: Record<number, EvmDeploymentChain> = {
  1: {
    chainId: 1,
    networkName: "eth-mainnet",
    chainType: "l1",
    production: true,
    deployDaoByDefault: true,
    rpcEnvKeys: ["ETH_MAINNET_RPC_URL"],
    treasuryEnvKeys: ["ETH_MAINNET_TREASURY_ADDRESS", "MAINNET_TREASURY_ADDRESS"],
    stable0EnvKeys: ["ETH_MAINNET_STABLE0_ADDRESS", "MAINNET_STABLE0_ADDRESS"],
    stable1EnvKeys: ["ETH_MAINNET_STABLE1_ADDRESS", "MAINNET_STABLE1_ADDRESS"],
    wrappedNativeEnvKeys: ["ETH_MAINNET_WRAPPED_NATIVE_ADDRESS", "MAINNET_WRAPPED_NATIVE_ADDRESS"],
  },
  56: {
    chainId: 56,
    networkName: "bsc-mainnet",
    chainType: "l1",
    production: true,
    deployDaoByDefault: false,
    rpcEnvKeys: ["BSC_MAINNET_RPC_URL"],
    treasuryEnvKeys: ["BSC_MAINNET_TREASURY_ADDRESS", "MAINNET_TREASURY_ADDRESS"],
    stable0EnvKeys: ["BSC_MAINNET_STABLE0_ADDRESS", "MAINNET_STABLE0_ADDRESS"],
    stable1EnvKeys: ["BSC_MAINNET_STABLE1_ADDRESS", "MAINNET_STABLE1_ADDRESS"],
    wrappedNativeEnvKeys: ["BSC_MAINNET_WRAPPED_NATIVE_ADDRESS", "MAINNET_WRAPPED_NATIVE_ADDRESS"],
  },
  [BASE_MAINNET.chainId]: {
    chainId: BASE_MAINNET.chainId,
    networkName: "base-mainnet",
    chainType: "op",
    production: true,
    deployDaoByDefault: false,
    rpcEnvKeys: ["BASE_MAINNET_RPC_URL"],
    // Production Base values must never inherit generic MAINNET_* asset or
    // treasury variables, which may contain Ethereum/BSC addresses in .env.
    treasuryEnvKeys: ["BASE_MAINNET_TREASURY_ADDRESS"],
    stable0EnvKeys: ["BASE_MAINNET_USDC_ADDRESS", "BASE_MAINNET_STABLE0_ADDRESS"],
    stable1EnvKeys: ["BASE_MAINNET_USDT_ADDRESS", "BASE_MAINNET_STABLE1_ADDRESS"],
    wrappedNativeEnvKeys: ["BASE_MAINNET_WETH_ADDRESS", "BASE_MAINNET_WRAPPED_NATIVE_ADDRESS"],
    defaultStable0: {
      address: BASE_MAINNET.usdc,
      symbol: "USDC",
      decimals: 6,
      description: "Circle-native USDC on Base",
    },
    defaultStable1: {
      address: BASE_MAINNET.usdt,
      symbol: "USDT",
      decimals: 6,
      description: "Base Standard Bridge USDT backed by Ethereum mainnet USDT",
      l1Token: BASE_MAINNET.ethereumUsdt,
      bridge: BASE_MAINNET.standardBridge,
    },
    defaultWrappedNative: {
      address: BASE_MAINNET.weth,
      symbol: "WETH",
      decimals: 18,
      description: "Base canonical WETH9",
    },
  },
  [BASE_SEPOLIA.chainId]: {
    chainId: BASE_SEPOLIA.chainId,
    networkName: "base-sepolia",
    chainType: "op",
    production: false,
    deployDaoByDefault: false,
    rpcEnvKeys: ["BASE_SEPOLIA_RPC_URL"],
    treasuryEnvKeys: ["BASE_SEPOLIA_TREASURY_ADDRESS"],
    stable0EnvKeys: ["BASE_SEPOLIA_USDC_ADDRESS"],
    stable1EnvKeys: ["BASE_SEPOLIA_STABLE1_ADDRESS"],
    wrappedNativeEnvKeys: ["BASE_SEPOLIA_WETH_ADDRESS"],
    defaultStable0: {
      address: BASE_SEPOLIA.usdc,
      symbol: "USDC",
      decimals: 6,
      description: "Circle test USDC on Base Sepolia",
    },
    defaultWrappedNative: {
      address: BASE_SEPOLIA.weth,
      symbol: "WETH",
      decimals: 18,
      description: "Base Sepolia canonical WETH9",
    },
  },
};

export function deploymentChain(chainId: number): EvmDeploymentChain {
  return CHAINS[chainId] ?? {
    chainId,
    networkName: `chain-${chainId}`,
    chainType: "l1",
    production: false,
    deployDaoByDefault: false,
    rpcEnvKeys: ["MAINNET_RPC_URL", "ETH_MAINNET_RPC_URL", "BSC_MAINNET_RPC_URL"],
    treasuryEnvKeys: ["MAINNET_TREASURY_ADDRESS"],
    stable0EnvKeys: ["MAINNET_STABLE0_ADDRESS"],
    stable1EnvKeys: ["MAINNET_STABLE1_ADDRESS"],
    wrappedNativeEnvKeys: ["MAINNET_WRAPPED_NATIVE_ADDRESS"],
  };
}

export function firstEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}
