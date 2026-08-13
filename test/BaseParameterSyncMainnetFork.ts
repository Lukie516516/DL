import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const RUN = process.env.BASE_PARAMETER_SYNC_MAINNET_FORK === "1";
const forkDescribe = RUN ? describe : describe.skip;
const DEPLOYER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const FACTORY = getAddress("0x591625Be924B98ACcAb7e2c8aF698c858Aa2608D");
const DC = getAddress("0xBB88a5b4aCDD18Fca66C2eb14cBdB791b9e8Df23");
const TREASURY = getAddress("0xb8f27EEb0c21e69CdE1F7c4C27b81f5c71c21dCb");
const EXECUTOR = getAddress("0xf92cE4DBA86eDbfAdEA32880a04FF1123a188218");
const PROBE = getAddress("0x61921eCb954FFaAf8cd3Fd2e71EeCB14B3eD529f");
const MESSAGE_HASH = "0x87b861508858236eed41e1c5aaeb0a7925253c9f5cb0ea1f76eb77b5983962b2";
const MARKER = "0xe735d9f79dc7413699af00ad995b58e853e30e3881bc5e72aff1ae13cab8ef3b";

forkDescribe("Base production parameter sync mainnet fork", function () {
  it("changes only message price from 100 DC to 104 DC", async function () {
    const { viem, networkHelpers } = await network.connect({ network: "hardhatBaseFork", chainType: "op" });
    const publicClient = await viem.getPublicClient();
    const factory = await viem.getContractAt("DealFactory", FACTORY);
    const dc = await viem.getContractAt("DCToken", DC);
    const executor = await viem.getContractAt("DualBridgeExecutorV2", EXECUTOR);
    const probe = await viem.getContractAt("GovernanceProbe", PROBE);
    const invariantBefore = {
      owner: await factory.read.owner(),
      admin: await factory.read.admin(),
      governance: await factory.read.crossChainGovernance(),
      treasury: await factory.read.treasury(),
      timeout: await factory.read.minTimeoutSeconds(),
      window: await factory.read.minWindowSec(),
      fee: await factory.read.defaultFeeNonDL(),
      reward: await factory.read.defaultMintOnFees(),
      supply: await dc.read.totalSupply(),
      confirmation: await executor.read.confirmStatus([MESSAGE_HASH]),
      attempts: await executor.read.executionAttempts([MESSAGE_HASH]),
      marker: await probe.read.marker(),
      updateCount: await probe.read.updateCount(),
    };
    assert.equal(invariantBefore.owner, DEPLOYER);
    assert.equal(invariantBefore.treasury, TREASURY);
    assert.equal(await factory.read.msgPriceEnabled(), true);
    assert.equal(await factory.read.msgPriceToken(), DC);
    assert.equal(await factory.read.msgPriceAmountInToken(), parseEther("100"));
    assert.deepEqual(invariantBefore.confirmation, [true, true, true, 3n, true]);
    assert.equal(invariantBefore.attempts, 1n);
    assert.equal(invariantBefore.marker, MARKER);
    assert.equal(invariantBefore.updateCount, 1n);

    await networkHelpers.impersonateAccount(DEPLOYER);
    await networkHelpers.setBalance(DEPLOYER, parseEther("1"));
    const wallet = await viem.getWalletClient(DEPLOYER);
    const factoryAsOwner = await viem.getContractAt("DealFactory", FACTORY, {
      client: { public: publicClient, wallet },
    });
    const hash = await factoryAsOwner.write.setMessagePriceRule([true, DC, parseEther("104")]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    assert.equal(await factory.read.msgPriceAmountInToken(), parseEther("104"));
    assert.equal(await factory.read.msgPriceEnabled(), true);
    assert.equal(await factory.read.msgPriceToken(), DC);

    assert.deepEqual({
      owner: await factory.read.owner(),
      admin: await factory.read.admin(),
      governance: await factory.read.crossChainGovernance(),
      treasury: await factory.read.treasury(),
      timeout: await factory.read.minTimeoutSeconds(),
      window: await factory.read.minWindowSec(),
      fee: await factory.read.defaultFeeNonDL(),
      reward: await factory.read.defaultMintOnFees(),
      supply: await dc.read.totalSupply(),
      confirmation: await executor.read.confirmStatus([MESSAGE_HASH]),
      attempts: await executor.read.executionAttempts([MESSAGE_HASH]),
      marker: await probe.read.marker(),
      updateCount: await probe.read.updateCount(),
    }, invariantBefore);
  });
});
