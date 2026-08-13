import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BASE_MAINNET,
  BASE_SEPOLIA,
  deploymentChain,
} from "../scripts/lib/evm-chain-config.js";

describe("Base deployment configuration", function () {
  it("uses the production Base chain and canonical three-pool assets", function () {
    const config = deploymentChain(BASE_MAINNET.chainId);
    assert.equal(config.networkName, "base-mainnet");
    assert.equal(config.chainType, "op");
    assert.equal(config.production, true);
    assert.equal(config.deployDaoByDefault, false);
    assert.equal(config.defaultStable0?.address, BASE_MAINNET.usdc);
    assert.equal(config.defaultStable1?.address, BASE_MAINNET.usdt);
    assert.equal(config.defaultWrappedNative?.address, BASE_MAINNET.weth);
    assert.equal(config.defaultStable0?.decimals, 6);
    assert.equal(config.defaultStable1?.decimals, 6);
    assert.equal(config.defaultWrappedNative?.decimals, 18);
    assert.notEqual(BASE_MAINNET.usdc.toLowerCase(), BASE_MAINNET.usdt.toLowerCase());
    assert.notEqual(BASE_MAINNET.usdt.toLowerCase(), BASE_MAINNET.weth.toLowerCase());
  });

  it("keeps Base governance on Ethereum and treats Base Sepolia as non-production", function () {
    const mainnet = deploymentChain(BASE_MAINNET.chainId);
    const sepolia = deploymentChain(BASE_SEPOLIA.chainId);
    assert.equal(mainnet.deployDaoByDefault, false);
    assert.equal(sepolia.deployDaoByDefault, false);
    assert.equal(sepolia.production, false);
    assert.equal(sepolia.defaultStable0?.address, BASE_SEPOLIA.usdc);
    assert.equal(sepolia.defaultStable1, undefined);
  });

  it("does not inherit generic Ethereum/BSC asset or Treasury env keys on Base", function () {
    const config = deploymentChain(BASE_MAINNET.chainId);
    for (const key of [
      ...config.treasuryEnvKeys,
      ...config.stable0EnvKeys,
      ...config.stable1EnvKeys,
      ...config.wrappedNativeEnvKeys,
    ]) {
      assert.match(key, /^BASE_MAINNET_/);
    }
    assert.ok(!config.treasuryEnvKeys.includes("MAINNET_TREASURY_ADDRESS"));
    assert.ok(!config.stable0EnvKeys.includes("MAINNET_STABLE0_ADDRESS"));
    assert.ok(!config.stable1EnvKeys.includes("MAINNET_STABLE1_ADDRESS"));
    assert.ok(!config.wrappedNativeEnvKeys.includes("MAINNET_WRAPPED_NATIVE_ADDRESS"));
  });

  it("keeps the three cross-chain identifiers in separate namespaces", function () {
    assert.equal(BASE_MAINNET.chainId, 8453);
    assert.equal(BASE_MAINNET.lzEid, 30184);
    assert.equal(BASE_MAINNET.ccipChainSelector, 15_971_525_489_660_198_786n);
    assert.notEqual(BigInt(BASE_MAINNET.chainId), BigInt(BASE_MAINNET.lzEid));
    assert.notEqual(BigInt(BASE_MAINNET.lzEid), BASE_MAINNET.ccipChainSelector);
  });
});
