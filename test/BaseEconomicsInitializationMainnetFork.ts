import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, parseAbi, parseEther, type Hex } from "viem";

import {
  BASE_LEGACY_POOL_PLANS,
  BASE_REAL_OTHER_SMALLEST_UNIT,
  BASE_TOTAL_INITIAL_DC,
  BASE_TREASURY_INITIAL_DC,
} from "../scripts/lib/base-launch-economics.js";
import { BASE_MAINNET } from "../scripts/lib/evm-chain-config.js";

const RUN = process.env.BASE_ECONOMICS_INITIALIZATION_MAINNET_FORK === "1";
const forkDescribe = RUN ? describe : describe.skip;
const DEPLOYER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const DC = getAddress("0xBB88a5b4aCDD18Fca66C2eb14cBdB791b9e8Df23");
const FACTORY = getAddress("0x591625Be924B98ACcAb7e2c8aF698c858Aa2608D");
const TREASURY = getAddress("0xb8f27EEb0c21e69CdE1F7c4C27b81f5c71c21dCb");
const PAIR_MANAGER = getAddress("0x20289f30C92e0bb36cA0B32741EccFF2C95595Ee");
const EXECUTOR = getAddress("0xf92cE4DBA86eDbfAdEA32880a04FF1123a188218");
const PROBE = getAddress("0x61921eCb954FFaAf8cd3Fd2e71EeCB14B3eD529f");
const MESSAGE_HASH = "0x87b861508858236eed41e1c5aaeb0a7925253c9f5cb0ea1f76eb77b5983962b2" as Hex;
const MARKER = "0xe735d9f79dc7413699af00ad995b58e853e30e3881bc5e72aff1ae13cab8ef3b" as Hex;
const PAIRS = {
  pairStable0: getAddress("0xee40Bbc8cC387aCa294fb9ECa429B10AbeBf1DBA"),
  pairStable1: getAddress("0x00e284922E5A727b4378768b5ED5D22fbF3297e8"),
  pairWrappedNative: getAddress("0xC99577B3027181F85b650651021bb7F804F50e61"),
} as const;

async function waitFor(publicClient: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
  return receipt.gasUsed;
}

forkDescribe("Base economics initialization live-contract fork", function () {
  it("funds Treasury and initializes all three pools without changing governance invariants", async function () {
    const { viem, networkHelpers } = await network.connect({ network: "hardhatBaseFork", chainType: "op" });
    const publicClient = await viem.getPublicClient();
    assert.equal(await publicClient.getChainId(), 8453);
    await networkHelpers.impersonateAccount(DEPLOYER);
    await networkHelpers.setBalance(DEPLOYER, parseEther("1"));
    const wallet = await viem.getWalletClient(DEPLOYER);
    const client = { public: publicClient, wallet } as const;
    const dc = await viem.getContractAt("DCToken", DC, { client });
    const pairManager = await viem.getContractAt("DealPairManager", PAIR_MANAGER, { client });
    const factory = await viem.getContractAt("DealFactory", FACTORY);
    const executor = await viem.getContractAt("DualBridgeExecutorV2", EXECUTOR);
    const probe = await viem.getContractAt("GovernanceProbe", PROBE);
    const erc20Artifact = "contracts/interfaces/IERC20.sol:IERC20";
    const usdc = await viem.getContractAt(erc20Artifact, BASE_MAINNET.usdc, { client });
    const usdt = await viem.getContractAt(erc20Artifact, BASE_MAINNET.usdt, { client });
    const weth = await viem.getContractAt(erc20Artifact, BASE_MAINNET.weth, { client });
    const wethDepositAbi = parseAbi(["function deposit() payable"]);
    assert.equal(await dc.read.totalSupply(), 0n);
    assert.equal(await dc.read.balanceOf([TREASURY]), 0n);
    assert.ok(await usdc.read.balanceOf([DEPLOYER]) >= 1n);
    assert.ok(await usdt.read.balanceOf([DEPLOYER]) >= 1n);
    const governanceBefore = {
      factoryOwner: await factory.read.owner(),
      factoryAdmin: await factory.read.admin(),
      factoryGovernance: await factory.read.crossChainGovernance(),
      messagePrice: await factory.read.msgPriceAmountInToken(),
      confirmation: await executor.read.confirmStatus([MESSAGE_HASH]),
      attempts: await executor.read.executionAttempts([MESSAGE_HASH]),
      marker: await probe.read.marker(),
      updateCount: await probe.read.updateCount(),
    };
    assert.deepEqual(governanceBefore.confirmation, [true, true, true, 3n, true]);
    assert.equal(governanceBefore.attempts, 1n);
    assert.equal(governanceBefore.marker, MARKER);
    assert.equal(governanceBefore.updateCount, 1n);

    let totalGas = 0n;
    totalGas += await waitFor(publicClient, await dc.write.mint([TREASURY, BASE_TREASURY_INITIAL_DC]));
    for (const plan of BASE_LEGACY_POOL_PLANS) {
      const pairAddress = PAIRS[plan.key];
      const pair = await viem.getContractAt("DealSwapTemplate", pairAddress);
      assert.equal(await pair.read.liquidityInited(), false);
      assert.deepEqual(await pair.read.getReserves(), [0n, 0n, 0]);
      totalGas += await waitFor(publicClient, await dc.write.mint([pairAddress, plan.realDc]));
      if (plan.token === BASE_MAINNET.usdc) {
        totalGas += await waitFor(publicClient, await usdc.write.transfer([pairAddress, BASE_REAL_OTHER_SMALLEST_UNIT]));
      } else if (plan.token === BASE_MAINNET.usdt) {
        totalGas += await waitFor(publicClient, await usdt.write.transfer([pairAddress, BASE_REAL_OTHER_SMALLEST_UNIT]));
      } else {
        totalGas += await waitFor(publicClient, await wallet.writeContract({
          address: BASE_MAINNET.weth,
          abi: wethDepositAbi,
          functionName: "deposit",
          value: BASE_REAL_OTHER_SMALLEST_UNIT,
        }));
        totalGas += await waitFor(publicClient, await weth.write.transfer([pairAddress, BASE_REAL_OTHER_SMALLEST_UNIT]));
      }
      totalGas += await waitFor(
        publicClient,
        await pairManager.write.initPair([pairAddress, plan.effectiveOther - BASE_REAL_OTHER_SMALLEST_UNIT]),
      );
    }

    assert.equal(await dc.read.totalSupply(), BASE_TOTAL_INITIAL_DC);
    assert.equal(await dc.read.balanceOf([TREASURY]), BASE_TREASURY_INITIAL_DC);
    for (const plan of BASE_LEGACY_POOL_PLANS) {
      const pair = await viem.getContractAt("DealSwapTemplate", PAIRS[plan.key]);
      assert.equal(await pair.read.liquidityInited(), true);
      const reserves = await pair.read.getReserves();
      const virtuals = await pair.read.getVirtualReserves();
      const effective = await pair.read.getEffectiveReserves();
      assert.equal(reserves[0], plan.realDc);
      assert.equal(reserves[1], BASE_REAL_OTHER_SMALLEST_UNIT);
      assert.equal(virtuals[0], 0n);
      assert.equal(virtuals[1], plan.effectiveOther - BASE_REAL_OTHER_SMALLEST_UNIT);
      assert.equal(effective[0], plan.realDc);
      assert.equal(effective[1], plan.effectiveOther);
    }
    assert.deepEqual({
      factoryOwner: await factory.read.owner(),
      factoryAdmin: await factory.read.admin(),
      factoryGovernance: await factory.read.crossChainGovernance(),
      messagePrice: await factory.read.msgPriceAmountInToken(),
      confirmation: await executor.read.confirmStatus([MESSAGE_HASH]),
      attempts: await executor.read.executionAttempts([MESSAGE_HASH]),
      marker: await probe.read.marker(),
      updateCount: await probe.read.updateCount(),
    }, governanceBefore);
    assert.ok(totalGas > 0n);
    console.log(`Base economics fork total gas units: ${totalGas}`);
  });
});
