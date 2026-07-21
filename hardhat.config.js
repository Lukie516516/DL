import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { readFileSync } from "node:fs";
// load .env manually (dotenv not installed)
try {
  readFileSync(".env", "utf8").split("\n").forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] ||= m[2].trim();
  });
} catch {}

/** Default pipeline for the rest of the repo (avoids stack-too-deep on large files). */
const solcDefault = {
  version: "0.8.28",
  settings: {
    viaIR: true,
    optimizer: { enabled: true, runs: 1 },
    metadata: { bytecodeHash: "none" },
  },
};

/** Deal.sol only: legacy pipeline yields smaller creation bytecode (under EIP-170). */
const solcDealOnly = {
  version: "0.8.28",
  settings: {
    viaIR: false,
    optimizer: { enabled: true, runs: 1 },
    metadata: { bytecodeHash: "none" },
  },
};

function envAccount(...keys) {
  let raw;
  for (const key of keys) {
    raw = process.env[key];
    if (raw) break;
  }
  if (!raw) return [];
  return [raw.startsWith("0x") ? raw : `0x${raw}`];
}

function envUrl(key) {
  return process.env[key] || "http://127.0.0.1:8545";
}

const config = {
  plugins: [hardhatToolboxViemPlugin],
  chainDescriptors: {
    31415926: { name: "Agiking", chainType: "l1" },
  },
  solidity: {
    profiles: {
      default: {
        compilers: [solcDefault],
        overrides: {
          "contracts/Deal.sol": solcDealOnly,
          "contracts/DealNoAsset.sol": solcDealOnly,
          "contracts/DealAAssetNft.sol": solcDealOnly,
          "contracts/DealBAssetNft.sol": solcDealOnly,
          "contracts/DealAAssetNftOnly.sol": solcDealOnly,
          "contracts/DealBAssetNftOnly.sol": solcDealOnly,
          "contracts/DealOpenTokenToken.sol": solcDealOnly,
        },
      },
      production: {
        compilers: [solcDefault],
        overrides: {
          "contracts/Deal.sol": solcDealOnly,
          "contracts/DealNoAsset.sol": solcDealOnly,
          "contracts/DealAAssetNft.sol": solcDealOnly,
          "contracts/DealBAssetNft.sol": solcDealOnly,
          "contracts/DealAAssetNftOnly.sol": solcDealOnly,
          "contracts/DealBAssetNftOnly.sol": solcDealOnly,
          "contracts/DealOpenTokenToken.sol": solcDealOnly,
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
      allowUnlimitedContractSize: true,
    },
    hardhatEthFork: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 1,
      allowUnlimitedContractSize: true,
      forking: {
        enabled: Boolean(process.env.ETH_MAINNET_RPC_URL),
        url: process.env.ETH_MAINNET_RPC_URL || "http://127.0.0.1:8545",
      },
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
      allowUnlimitedContractSize: true,
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: envUrl("SEPOLIA_RPC_URL"),
      accounts: envAccount("SEPOLIA_PRIVATE_KEY"),
    },
    bscTestnet: {
      type: "http",
      chainType: "l1",
      chainId: 97,
      url: envUrl("BSC_TESTNET_RPC_URL"),
      accounts: envAccount("BSC_TESTNET_PRIVATE_KEY"),
    },
    ethMainnet: {
      type: "http",
      chainType: "l1",
      chainId: 1,
      url: envUrl("ETH_MAINNET_RPC_URL"),
      accounts: envAccount("ETH_MAINNET_PRIVATE_KEY", "AGIKING_PRIVATE_KEY"),
    },
    bscMainnet: {
      type: "http",
      chainType: "l1",
      chainId: 56,
      url: process.env.BSC_MAINNET_RPC_URL || "https://bsc-dataseed.binance.org",
      accounts: envAccount("BSC_MAINNET_PRIVATE_KEY", "AGIKING_PRIVATE_KEY"),
    },
    agiking: {
      type: "http",
      chainType: "l1",
      chainId: 31415926,
      url: envUrl("AGIKING_RPC_URL"),
      accounts: envAccount("AGIKING_PRIVATE_KEY"),
    },
  },
};

export default config;
