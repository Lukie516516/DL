import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable } from "hardhat/config";

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
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
      allowUnlimitedContractSize: true,
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
    bscTestnet: {
      type: "http",
      chainType: "l1",
      chainId: 97,
      url: configVariable("BSC_TESTNET_RPC_URL"),
      accounts: [configVariable("BSC_TESTNET_PRIVATE_KEY")],
    },
    agiking: {
      type: "http",
      chainType: "l1",
      chainId: 31415926,
      url: process.env.AGIKING_RPC_URL,
      accounts: [process.env.AGIKING_PRIVATE_KEY],
    },
  },
};

export default config;
