import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, padHex, parseEther, stringToHex, type Address } from "viem";

const RUN = process.env.BASE_CROSS_CHAIN_V2_ROUTE_STAGE2_ETH_FORK === "1";
const forkDescribe = RUN ? describe : describe.skip;
const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const BSC_CHAIN_KEY = 30_102;
const BASE_CHAIN_KEY = 30_184;
const BASE_CCIP_SELECTOR = 15_971_525_489_660_198_786n;
const AX_MIN_FEE = 1_000_000_000_000_000n;

type Stage1 = { executor: Address };

forkDescribe("Base CrossChain V2 route stage 2 Ethereum fork", function () {
  it("adds Base inactive without changing the live BSC route or its fee quote", async function () {
    try {
    const stage1 = JSON.parse(
      readFileSync("deployments/base-cross-chain-v2-stage1.json", "utf8"),
    ) as Stage1;
    const executor = getAddress(stage1.executor);
    const { viem, networkHelpers } = await network.connect({
      network: "hardhatEthFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    await networkHelpers.impersonateAccount(OWNER);
    await networkHelpers.setBalance(OWNER, parseEther("1"));
    const ownerWallet = await viem.getWalletClient(OWNER);
    const broadcaster = await viem.getContractAt("CrossChainBroadcasterV2", BROADCASTER, {
      client: { public: publicClient, wallet: ownerWallet },
    });

    const chainIdsBefore = await broadcaster.read.getChainIds();
    assert.equal(chainIdsBefore.includes(BSC_CHAIN_KEY), true);
    const bscBefore = await broadcaster.read.chains([BSC_CHAIN_KEY]);
    const baseBefore = await broadcaster.read.chains([BASE_CHAIN_KEY]);
    assert.equal(baseBefore[6], false);
    if (chainIdsBefore.includes(BASE_CHAIN_KEY)) {
      assert.equal(baseBefore[0], BASE_CHAIN_KEY);
      assert.equal(baseBefore[1], BASE_CCIP_SELECTOR);
      assert.equal(getAddress(baseBefore[2]), executor);
      assert.equal(baseBefore[3], "base");
      assert.equal(baseBefore[4], executor.toLowerCase());
      assert.equal(baseBefore[5], AX_MIN_FEE);
    } else {
      assert.equal(baseBefore[0], 0);
    }
    const bscTarget = getAddress(bscBefore[2]);
    const data = stringToHex("base-inactive-route-does-not-affect-bsc");
    const quoteBefore = await broadcaster.read.quoteFees([
      [BSC_CHAIN_KEY],
      [bscTarget],
      data,
      500_000n,
    ]);

    if (!chainIdsBefore.includes(BASE_CHAIN_KEY)) {
      const hash = await broadcaster.write.addChain([BASE_CHAIN_KEY, {
        lzDstEid: BASE_CHAIN_KEY,
        ccipDstChainSelector: BASE_CCIP_SELECTOR,
        ccipReceiver: executor,
        axDstChain: "base",
        axDstAddress: executor.toLowerCase(),
        axMinFee: AX_MIN_FEE,
        active: false,
      }]);
      assert.equal((await publicClient.waitForTransactionReceipt({ hash })).status, "success");
    }
    const expectedPeer = padHex(executor, { size: 32 });
    if ((await broadcaster.read.peers([BASE_CHAIN_KEY])).toLowerCase() !== expectedPeer.toLowerCase()) {
      const hash = await broadcaster.write.setPeer([BASE_CHAIN_KEY, expectedPeer]);
      assert.equal((await publicClient.waitForTransactionReceipt({ hash })).status, "success");
    }

    assert.deepEqual(await broadcaster.read.getChainIds(), [BSC_CHAIN_KEY, BASE_CHAIN_KEY]);
    assert.deepEqual(await broadcaster.read.chains([BSC_CHAIN_KEY]), bscBefore);
    const baseAfter = await broadcaster.read.chains([BASE_CHAIN_KEY]);
    assert.equal(baseAfter[0], BASE_CHAIN_KEY);
    assert.equal(baseAfter[1], BASE_CCIP_SELECTOR);
    assert.equal(getAddress(baseAfter[2]), executor);
    assert.equal(baseAfter[3], "base");
    assert.equal(baseAfter[4], executor.toLowerCase());
    assert.equal(baseAfter[5], AX_MIN_FEE);
    assert.equal(baseAfter[6], false);
    assert.equal(
      (await broadcaster.read.peers([BASE_CHAIN_KEY])).toLowerCase(),
      expectedPeer.toLowerCase(),
    );
    const quoteAfter = await broadcaster.read.quoteFees([
      [BSC_CHAIN_KEY],
      [bscTarget],
      data,
      500_000n,
    ]);
    assert.equal(quoteAfter, quoteBefore);
    } catch (error) {
      console.error("Base route stage 2 underlying fork error:", error);
      throw error;
    }
  });
});
