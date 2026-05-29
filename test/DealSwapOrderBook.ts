import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress } from "viem";

const ONE = 10n ** 18n;
type Address = `0x${string}`;

async function waitFor(
  publicClient: Awaited<
    ReturnType<
      Awaited<ReturnType<typeof network.connect<{ network: "hardhatMainnet" }>>>["viem"]["getPublicClient"]
    >
  >,
  hash: Address,
) {
  return publicClient.waitForTransactionReceipt({ hash });
}

async function deployDexFixture() {
  const { viem } = await network.connect({ network: "hardhatMainnet" });
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();
  const [owner, alice, bob, treasury] = await viem.getWalletClients();

  const dl = await viem.deployContract("DCToken", [
    "DealCoin",
      "DC",
    0n,
    owner.account.address,
    owner.account.address,
  ]);
  const other = await viem.deployContract("DCToken", [
    "Other Token",
    "OT",
    0n,
    owner.account.address,
    owner.account.address,
  ]);
  const wrappedNative = await viem.deployContract("TestWNative");

  const dealLib = await viem.deployContract("DealLib");
  const dealAssetNftLib = await viem.deployContract("DealAssetNftLib");
  const dealImpl = await viem.deployContract("Deal");
  const pairImpl = await viem.deployContract("DealSwapTemplate");
  const factory = await viem.deployContract("DealFactory", [
    dealImpl.address,
    pairImpl.address,
    3600,
  ]);
  const dealPairManager = await viem.deployContract("DealPairManager", [factory.address]);
  const orderBook = await viem.deployContract("DealSwapOrderBook", [treasury.account.address]);
  const router = await viem.deployContract("DealRouter", [wrappedNative.address, orderBook.address]);
  const routerQuoter = await viem.deployContract("DealRouterQuoter", [orderBook.address]);

  const mintAmount = 10_000_000n * ONE;
  for (const token of [dl, other, wrappedNative]) {
    await waitFor(publicClient, await token.write.mint([owner.account.address, mintAmount]));
    await waitFor(publicClient, await token.write.mint([alice.account.address, mintAmount]));
    await waitFor(publicClient, await token.write.mint([bob.account.address, mintAmount]));
  }

  await waitFor(publicClient, await factory.write.setCoreGlobals([
    dl.address,
    owner.account.address,
    wrappedNative.address,
    dealPairManager.address,
  ]));
  await waitFor(publicClient, await orderBook.write.setRouter([router.address]));

  async function createPairWithReserves(dlAmount: bigint, otherAmount: bigint) {
    await waitFor(publicClient, await dealPairManager.write.createPair([other.address, 3, 1000]));
    const pairAddress = await dealPairManager.read.pairForToken([other.address]);
    const pair = await viem.getContractAt("DealSwapTemplate", pairAddress);

    await waitFor(publicClient, await dl.write.transfer([pairAddress, dlAmount]));
    await waitFor(publicClient, await other.write.transfer([pairAddress, otherAmount]));
    await waitFor(publicClient, await dealPairManager.write.initPair([pairAddress, 0n]));

    return { pairAddress, pair };
  }

  async function createPairWithVirtualDepth(
    dlAmount: bigint,
    otherReal: bigint,
    virtualOther: bigint,
  ) {
    await waitFor(publicClient, await dealPairManager.write.createPair([other.address, 3, 1000]));
    const pairAddress = await dealPairManager.read.pairForToken([other.address]);
    const pair = await viem.getContractAt("DealSwapTemplate", pairAddress);

    await waitFor(publicClient, await dl.write.transfer([pairAddress, dlAmount]));
    await waitFor(publicClient, await other.write.transfer([pairAddress, otherReal]));
    await waitFor(publicClient, await dealPairManager.write.initPair([pairAddress, 0n]));
    if (virtualOther > 0n) {
      await waitFor(
        publicClient,
        await dealPairManager.write.setPairVirtualReserves([pairAddress, 0n, false, virtualOther, true]),
      );
    }

    return { pairAddress, pair };
  }

  return {
    viem,
    publicClient,
    testClient,
    owner,
    alice,
    bob,
    treasury,
    dl,
    other,
    wrappedNative,
    factory,
    dealPairManager,
    orderBook,
    router,
    routerQuoter,
    createPairWithReserves,
    createPairWithVirtualDepth,
  };
}

describe("DealSwapOrderBook", async function () {
  it("partially fills a large DC sell order and queues the remainder", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, dl, other, orderBook, createPairWithVirtualDepth } = fixture;
    const { pairAddress } = await createPairWithVirtualDepth(1_000n * ONE, 10n * ONE, 90n * ONE);

    const orderBookAlice = await viem.getContractAt("DealSwapOrderBook", orderBook.address, {
      client: { wallet: alice },
    });
    const dlAlice = await viem.getContractAt("DCToken", dl.address, { client: { wallet: alice } });

    const sellAmount = 200n * ONE;
    const orderId = await orderBook.read.nextOrderId();
    const aliceOtherBefore = await other.read.balanceOf([alice.account.address]);

    await waitFor(publicClient, await dlAlice.write.approve([orderBook.address, sellAmount]));
    await waitFor(publicClient, await orderBookAlice.write.placeSellDL([pairAddress, sellAmount]));

    const order = await orderBook.read.orders([orderId]);
    const aliceOtherAfter = await other.read.balanceOf([alice.account.address]);

    assert.equal(order[0], getAddress(alice.account.address));
    assert.equal(order[2], true);
    assert.equal(order[3], true);
    assert.ok(order[4] > 0n);
    assert.ok(order[4] < sellAmount);
    assert.ok(aliceOtherAfter > aliceOtherBefore);
  });

  it("cancels queued sell orders and sends 0.1% of the input token to treasury", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, treasury, dl, orderBook, createPairWithReserves } = fixture;
    const { pairAddress } = await createPairWithReserves(1_000n * ONE, 1n);

    const orderBookAlice = await viem.getContractAt("DealSwapOrderBook", orderBook.address, {
      client: { wallet: alice },
    });
    const dlAlice = await viem.getContractAt("DCToken", dl.address, { client: { wallet: alice } });

    const amountIn = 100n * ONE;
    const fee = amountIn / 1000n;
    const orderId = await orderBook.read.nextOrderId();
    const aliceDlBefore = await dl.read.balanceOf([alice.account.address]);
    const treasuryDlBefore = await dl.read.balanceOf([treasury.account.address]);

    await waitFor(publicClient, await dlAlice.write.approve([orderBook.address, amountIn]));
    await waitFor(publicClient, await orderBookAlice.write.placeSellDL([pairAddress, amountIn]));
    await waitFor(publicClient, await orderBookAlice.write.cancelOrder([orderId]));

    const order = await orderBook.read.orders([orderId]);
    assert.equal(order[3], false);
    assert.equal(order[4], 0n);
    assert.equal(await dl.read.balanceOf([treasury.account.address]), treasuryDlBefore + fee);
    assert.equal(await dl.read.balanceOf([alice.account.address]), aliceDlBefore - fee);
  });

  it("settles queued sell orders in FIFO order", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, bob, dl, other, orderBook, createPairWithReserves } = fixture;
    const { pairAddress, pair } = await createPairWithReserves(1_000n * ONE, 1n);

    const orderBookAlice = await viem.getContractAt("DealSwapOrderBook", orderBook.address, {
      client: { wallet: alice },
    });
    const orderBookBob = await viem.getContractAt("DealSwapOrderBook", orderBook.address, {
      client: { wallet: bob },
    });
    const dlAlice = await viem.getContractAt("DCToken", dl.address, { client: { wallet: alice } });
    const dlBob = await viem.getContractAt("DCToken", dl.address, { client: { wallet: bob } });

    const aliceOrderId = await orderBook.read.nextOrderId();
    await waitFor(publicClient, await dlAlice.write.approve([orderBook.address, 100n * ONE]));
    await waitFor(publicClient, await orderBookAlice.write.placeSellDL([pairAddress, 100n * ONE]));

    const bobOrderId = await orderBook.read.nextOrderId();
    await waitFor(publicClient, await dlBob.write.approve([orderBook.address, 50n * ONE]));
    await waitFor(publicClient, await orderBookBob.write.placeSellDL([pairAddress, 50n * ONE]));

    const [firstQueuedIds, queueHead, queueTotal] = await orderBook.read.getQueuePage([pairAddress, true, 0n, 1n]);
    assert.deepEqual(firstQueuedIds, [aliceOrderId]);
    assert.equal(queueHead, 0n);
    assert.equal(queueTotal, 2n);
    const [remainingQueuedIds] = await orderBook.read.getQueuePage([pairAddress, true, 1n, 1000n]);
    assert.deepEqual(remainingQueuedIds, [bobOrderId]);

    await waitFor(publicClient, await other.write.transfer([pairAddress, 20n * ONE]));
    await waitFor(publicClient, await pair.write.mintOtherOnly());
    await waitFor(publicClient, await orderBook.write.settlePair([pairAddress, 0n, 1n]));

    const aliceOrder = await orderBook.read.orders([aliceOrderId]);
    const bobOrder = await orderBook.read.orders([bobOrderId]);
    assert.equal(aliceOrder[3], false);
    assert.equal(aliceOrder[4], 0n);
    assert.equal(bobOrder[3], true);
    assert.equal(bobOrder[4], 50n * ONE);
  });

  it("supports OTHER -> DC queued orders and charges cancel fees in OTHER", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, treasury, dl, other, orderBook, createPairWithReserves } = fixture;
    const { pairAddress } = await createPairWithReserves(1n, 1_000n * ONE);

    const orderBookAlice = await viem.getContractAt("DealSwapOrderBook", orderBook.address, {
      client: { wallet: alice },
    });
    const otherAlice = await viem.getContractAt("DCToken", other.address, { client: { wallet: alice } });

    const amountIn = 100n * ONE;
    const fee = amountIn / 1000n;
    const orderId = await orderBook.read.nextOrderId();
    const aliceOtherBefore = await other.read.balanceOf([alice.account.address]);
    const treasuryOtherBefore = await other.read.balanceOf([treasury.account.address]);
    const aliceDlBefore = await dl.read.balanceOf([alice.account.address]);

    await waitFor(publicClient, await otherAlice.write.approve([orderBook.address, amountIn]));
    await waitFor(publicClient, await orderBookAlice.write.placeBuyDL([pairAddress, amountIn]));

    const order = await orderBook.read.orders([orderId]);
    assert.equal(order[2], false);
    assert.equal(order[4], amountIn);
    assert.equal(await dl.read.balanceOf([alice.account.address]), aliceDlBefore);

    await waitFor(publicClient, await orderBookAlice.write.cancelOrder([orderId]));
    assert.equal(await other.read.balanceOf([treasury.account.address]), treasuryOtherBefore + fee);
    assert.equal(await other.read.balanceOf([alice.account.address]), aliceOtherBefore - fee);
  });

  it("router default exact-in DC sells auto-queue the remainder", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, dl, other, orderBook, router, createPairWithVirtualDepth } = fixture;
    const { pairAddress } = await createPairWithVirtualDepth(1_000n * ONE, 10n * ONE, 90n * ONE);

    const routerAlice = await viem.getContractAt("DealRouter", router.address, {
      client: { wallet: alice },
    });
    const dlAlice = await viem.getContractAt("DCToken", dl.address, { client: { wallet: alice } });

    const sellAmount = 200n * ONE;
    const orderId = await orderBook.read.nextOrderId();
    const aliceOtherBefore = await other.read.balanceOf([alice.account.address]);

    await waitFor(publicClient, await dlAlice.write.approve([router.address, sellAmount]));
    await waitFor(publicClient, await routerAlice.write.swapExact0For1([pairAddress, sellAmount, 0n, 2n ** 63n]));

    const order = await orderBook.read.orders([orderId]);
    const aliceOtherAfter = await other.read.balanceOf([alice.account.address]);
    assert.equal(order[0], getAddress(alice.account.address));
    assert.equal(order[2], true);
    assert.equal(order[3], true);
    assert.ok(order[4] > 0n);
    assert.ok(aliceOtherAfter > aliceOtherBefore);
  });

  it("router default exact-in ETH buys of DC auto-queue the remainder", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, dl, orderBook, router, dealPairManager, wrappedNative } = fixture;

    await waitFor(publicClient, await dealPairManager.write.createPair([wrappedNative.address, 3, 1000]));
    const pairAddress = await dealPairManager.read.pairForToken([wrappedNative.address]);
    await waitFor(publicClient, await dl.write.transfer([pairAddress, 1_000n * ONE]));
    await waitFor(publicClient, await wrappedNative.write.deposit({ value: 10n * ONE }));
    await waitFor(publicClient, await wrappedNative.write.transfer([pairAddress, 10n * ONE]));
    await waitFor(publicClient, await dealPairManager.write.initPair([pairAddress, 0n]));
    await waitFor(
      publicClient,
      await dealPairManager.write.setPairVirtualReserves([pairAddress, 900n * ONE, true, 0n, false]),
    );

    const routerAlice = await viem.getContractAt("DealRouter", router.address, {
      client: { wallet: alice },
    });
    const orderId = await orderBook.read.nextOrderId();
    const aliceDlBefore = await dl.read.balanceOf([alice.account.address]);

    await waitFor(publicClient, await routerAlice.write.swapExactETHFor0([pairAddress, 0n, 2n ** 63n], { value: 200n * ONE }));

    const order = await orderBook.read.orders([orderId]);
    const aliceDlAfter = await dl.read.balanceOf([alice.account.address]);
    assert.equal(order[0], getAddress(alice.account.address));
    assert.equal(order[2], false);
    assert.equal(order[3], true);
    assert.ok(order[4] > 0n);
    assert.equal(order[7], true);
    assert.ok(aliceDlAfter > aliceDlBefore);
  });

  it("cancels ETH-origin queued buy orders back to native and charges 0.1% to treasury", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, treasury, dl, orderBook, router, factory, dealPairManager, wrappedNative } = fixture;

    await waitFor(publicClient, await dealPairManager.write.createPair([wrappedNative.address, 3, 1000]));
    const pairAddress = await dealPairManager.read.pairForToken([wrappedNative.address]);
    await waitFor(publicClient, await dl.write.transfer([pairAddress, 1_000n * ONE]));
    await waitFor(publicClient, await wrappedNative.write.deposit({ value: 10n * ONE }));
    await waitFor(publicClient, await wrappedNative.write.transfer([pairAddress, 10n * ONE]));
    await waitFor(publicClient, await dealPairManager.write.initPair([pairAddress, 0n]));
    await waitFor(
      publicClient,
      await dealPairManager.write.setPairVirtualReserves([pairAddress, 900n * ONE, true, 0n, false]),
    );

    const routerAlice = await viem.getContractAt("DealRouter", router.address, {
      client: { wallet: alice },
    });
    const orderBookAlice = await viem.getContractAt("DealSwapOrderBook", orderBook.address, {
      client: { wallet: alice },
    });

    const orderId = await orderBook.read.nextOrderId();
    const treasuryBefore = await publicClient.getBalance({ address: treasury.account.address });
    const aliceBefore = await publicClient.getBalance({ address: alice.account.address });

    const placeHash = await routerAlice.write.swapExactETHFor0([pairAddress, 0n, 2n ** 63n], { value: 200n * ONE });
    const placeReceipt = await waitFor(publicClient, placeHash);
    const placeGas = placeReceipt.gasUsed * placeReceipt.effectiveGasPrice;

    const order = await orderBook.read.orders([orderId]);
    const queuedIn = order[4] as bigint;
    const fee = queuedIn / 1000n;
    const refund = queuedIn - fee;

    const cancelHash = await orderBookAlice.write.cancelOrder([orderId]);
    const cancelReceipt = await waitFor(publicClient, cancelHash);
    const cancelGas = cancelReceipt.gasUsed * cancelReceipt.effectiveGasPrice;

    const treasuryAfter = await publicClient.getBalance({ address: treasury.account.address });
    const aliceAfter = await publicClient.getBalance({ address: alice.account.address });
    const orderAfter = await orderBook.read.orders([orderId]);

    assert.equal(orderAfter[3], false);
    assert.equal(orderAfter[4], 0n);
    assert.equal(treasuryAfter, treasuryBefore + fee);
    assert.equal(aliceAfter, aliceBefore - (200n * ONE) - placeGas - cancelGas + refund);
  });

  it("router default exact-in DC sells to ETH auto-queue the remainder and unwrap on settlement", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, dl, orderBook, router, dealPairManager, wrappedNative } = fixture;

    await waitFor(publicClient, await dealPairManager.write.createPair([wrappedNative.address, 3, 1000]));
    const pairAddress = await dealPairManager.read.pairForToken([wrappedNative.address]);
    const pair = await viem.getContractAt("DealSwapTemplate", pairAddress);

    await waitFor(publicClient, await dl.write.transfer([pairAddress, 1_000n * ONE]));
    await waitFor(publicClient, await wrappedNative.write.deposit({ value: 10n * ONE }));
    await waitFor(publicClient, await wrappedNative.write.transfer([pairAddress, 10n * ONE]));
    await waitFor(publicClient, await dealPairManager.write.initPair([pairAddress, 0n]));
    await waitFor(
      publicClient,
      await dealPairManager.write.setPairVirtualReserves([pairAddress, 0n, false, 90n * ONE, true]),
    );

    const routerAlice = await viem.getContractAt("DealRouter", router.address, {
      client: { wallet: alice },
    });
    const dlAlice = await viem.getContractAt("DCToken", dl.address, { client: { wallet: alice } });

    const sellAmount = 200n * ONE;
    await waitFor(publicClient, await dlAlice.write.approve([router.address, sellAmount]));

    const balanceBefore = await publicClient.getBalance({ address: alice.account.address });
    const sellTxHash = await routerAlice.write.swapExact0ForETH([pairAddress, sellAmount, 0n, 2n ** 63n]);
    const sellReceipt = await waitFor(publicClient, sellTxHash);
    const sellGas = sellReceipt.gasUsed * sellReceipt.effectiveGasPrice;
    const balanceAfterFirst = await publicClient.getBalance({ address: alice.account.address });
    assert.ok(balanceAfterFirst + sellGas > balanceBefore);

    const orderId = (await orderBook.read.nextOrderId()) - 1n;
    let order = await orderBook.read.orders([orderId]);
    assert.equal(order[0], getAddress(alice.account.address));
    assert.equal(order[2], true);
    assert.equal(order[3], true);
    assert.ok(order[4] > 0n);
    assert.equal(order[6], true);

    await waitFor(publicClient, await wrappedNative.write.deposit({ value: 20n * ONE }));
    await waitFor(publicClient, await wrappedNative.write.transfer([pairAddress, 20n * ONE]));
    await waitFor(publicClient, await pair.write.mintOtherOnly());

    const settleTxHash = await orderBook.write.settlePair([pairAddress, 0n, 8n]);
    const settleReceipt = await waitFor(publicClient, settleTxHash);
    const settleGas = settleReceipt.gasUsed * settleReceipt.effectiveGasPrice;
    const balanceAfterSettle = await publicClient.getBalance({ address: alice.account.address });
    order = await orderBook.read.orders([orderId]);

    assert.ok(balanceAfterSettle + settleGas > balanceAfterFirst);
    assert.equal(order[3], false);
    assert.equal(order[4], 0n);
  });

  it("keeps real reserves separate from virtual depth and queues the remainder instead of smashing through backing", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, dl, other, orderBook, createPairWithVirtualDepth } = fixture;
    const { pairAddress, pair } = await createPairWithVirtualDepth(1_000n * ONE, 10n * ONE, 90n * ONE);

    const realOnPair = await other.read.balanceOf([pairAddress]);
    assert.equal(realOnPair, 10n * ONE);

    const [, r1] = await pair.read.getReserves();
    const [, v1] = await pair.read.getVirtualReserves();
    const [, effective1] = await pair.read.getEffectiveReserves();
    assert.equal(r1, 10n * ONE);
    assert.equal(v1, 90n * ONE);
    assert.equal(effective1, 100n * ONE);

    const probeIn = 200n * ONE;
    const [, quotedOut1] = await pair.read.quoteSell([probeIn]);
    assert.ok(quotedOut1 > realOnPair);

    const orderBookAlice = await viem.getContractAt("DealSwapOrderBook", orderBook.address, {
      client: { wallet: alice },
    });
    const dlAlice = await viem.getContractAt("DCToken", dl.address, { client: { wallet: alice } });

    const orderId = await orderBook.read.nextOrderId();
    await waitFor(publicClient, await dlAlice.write.approve([orderBook.address, probeIn]));
    await waitFor(publicClient, await orderBookAlice.write.placeSellDL([pairAddress, probeIn]));

    const queued = await orderBook.read.orders([orderId]);
    assert.equal(queued[3], true);
    assert.ok(queued[4] > 0n);
    assert.ok(queued[4] < probeIn);
  });

  it("router preview matches default hybrid exact-in behavior and queues the remainder", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, dl, orderBook, router, routerQuoter, createPairWithVirtualDepth } = fixture;
    const { pairAddress } = await createPairWithVirtualDepth(1_000n * ONE, 10n * ONE, 90n * ONE);

    const routerAlice = await viem.getContractAt("DealRouter", router.address, {
      client: { wallet: alice },
    });
    const dlAlice = await viem.getContractAt("DCToken", dl.address, { client: { wallet: alice } });

    const sellAmount = 200n * ONE;
    const preview = await routerQuoter.read.previewExact0For1([pairAddress, sellAmount]);
    assert.ok(preview.immediateIn > 0n);
    assert.ok(preview.queuedIn > 0n);
    assert.equal(preview.immediateIn + preview.queuedIn, sellAmount);
    assert.equal(preview.fullyImmediate, false);

    await waitFor(publicClient, await dlAlice.write.approve([router.address, sellAmount]));
    const orderId = await orderBook.read.nextOrderId();
    await waitFor(publicClient, await routerAlice.write.swapExact0For1([pairAddress, sellAmount, 0n, 2n ** 63n]));

    const order = await orderBook.read.orders([orderId]);
    assert.equal(order[3], true);
    assert.equal(order[4], preview.queuedIn);
  });

  it("router preview reports exact-out immediate cap for buying DC", async function () {
    const fixture = await deployDexFixture();
    const { routerQuoter, createPairWithVirtualDepth } = fixture;
    const { pairAddress } = await createPairWithVirtualDepth(1_000n * ONE, 10n * ONE, 90n * ONE);

    const preview = await routerQuoter.read.preview1ForExact0Net([pairAddress, 998n * ONE]);
    assert.equal(preview.fullyImmediate, false);
    assert.ok(preview.immediateOutCap > 0n);
    assert.ok(preview.queuedOut > 0n);
    assert.equal(preview.requiredInForTarget, 0n);
    assert.ok(preview.requiredInForImmediateCap > 0n);
  });

  it("factory TWAP quote uses effective reserves when virtual depth is enabled", async function () {
    const fixture = await deployDexFixture();
    const { publicClient, owner, factory, createPairWithVirtualDepth } = fixture;
    const { pairAddress } = await createPairWithVirtualDepth(1_000n * ONE, 100n * ONE, 900n * ONE);

    const simulated = await publicClient.simulateContract({
      address: factory.address,
      abi: factory.abi,
      functionName: "updateAndQuoteToDL",
      args: [pairAddress, ONE],
      account: owner.account.address,
    });

    assert.equal(simulated.result, ONE);
  });

  it("rolls TWAP cumulatives before virtual reserve changes", async function () {
    const fixture = await deployDexFixture();
    const { publicClient, testClient, dealPairManager, createPairWithReserves } = fixture;
    const { pairAddress, pair } = await createPairWithReserves(1_000n * ONE, 100n * ONE);

    const [, , tsBefore] = await pair.read.getReserves();
    await testClient.setNextBlockTimestamp({ timestamp: BigInt(tsBefore) + 3600n });
    await testClient.mine({ blocks: 1 });

    const setHash = await dealPairManager.write.setPairVirtualReserves([pairAddress, 0n, false, 900n * ONE, true]);
    const setReceipt = await waitFor(publicClient, setHash);
    const setBlock = await publicClient.getBlock({ blockHash: setReceipt.blockHash });

    const [, p1Cum] = await pair.read.getPriceCumulatives();
    const elapsed = setBlock.timestamp - BigInt(tsBefore);
    const expectedSpotQ112 = ((1_000n * ONE) << 112n) / (100n * ONE);
    assert.equal(p1Cum, expectedSpotQ112 * elapsed);
  });

  it("handles fee-on-transfer OTHER buy orders without overstating queued balances", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, owner, dl, orderBook, factory, dealPairManager } = fixture;

    const taxed = await viem.deployContract("TestFeeOnTransferToken", [
      "Taxed Other",
      "TOT",
      1000n,
      owner.account.address,
    ]);
    await waitFor(publicClient, await taxed.write.mint([owner.account.address, 1_000_000n * ONE]));
    await waitFor(publicClient, await taxed.write.mint([alice.account.address, 1_000_000n * ONE]));

    await waitFor(publicClient, await dealPairManager.write.createPair([taxed.address, 3, 1000]));
    const pairAddress = await dealPairManager.read.pairForToken([taxed.address]);

    await waitFor(publicClient, await dl.write.transfer([pairAddress, 10n * ONE]));
    await waitFor(publicClient, await taxed.write.transfer([pairAddress, 1_000n * ONE]));
    await waitFor(publicClient, await dealPairManager.write.initPair([pairAddress, 0n]));

    const orderBookAlice = await viem.getContractAt("DealSwapOrderBook", orderBook.address, {
      client: { wallet: alice },
    });
    const taxedAlice = await viem.getContractAt("TestFeeOnTransferToken", taxed.address, {
      client: { wallet: alice },
    });

    const amountIn = 20_000n * ONE;
    const orderId = await orderBook.read.nextOrderId();
    const aliceDlBefore = await dl.read.balanceOf([alice.account.address]);
    await waitFor(publicClient, await taxedAlice.write.approve([orderBook.address, amountIn]));
    await waitFor(publicClient, await orderBookAlice.write.placeBuyDL([pairAddress, amountIn]));

    const order = await orderBook.read.orders([orderId]);
    const orderBookBalance = await taxed.read.balanceOf([orderBook.address]);
    const aliceDlAfter = await dl.read.balanceOf([alice.account.address]);

    assert.equal(order[4], orderBookBalance);
    assert.ok(aliceDlAfter > aliceDlBefore);
  });

  it("when reserve1 is 1 wei, queued sells never settle (filledIn=0 breaks queue scan)", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, bob, dl, orderBook, createPairWithVirtualDepth } = fixture;
    const { pairAddress } = await createPairWithVirtualDepth(1_000n * ONE, 1n, 0n);

    const orderBookAlice = await viem.getContractAt("DealSwapOrderBook", orderBook.address, {
      client: { wallet: alice },
    });
    const orderBookBob = await viem.getContractAt("DealSwapOrderBook", orderBook.address, {
      client: { wallet: bob },
    });
    const dlAlice = await viem.getContractAt("DCToken", dl.address, { client: { wallet: alice } });
    const dlBob = await viem.getContractAt("DCToken", dl.address, { client: { wallet: bob } });

    const aliceOrderId = await orderBook.read.nextOrderId();
    await waitFor(publicClient, await dlAlice.write.approve([orderBook.address, 10n * ONE]));
    await waitFor(publicClient, await orderBookAlice.write.placeSellDL([pairAddress, 10n * ONE]));

    const bobOrderId = await orderBook.read.nextOrderId();
    await waitFor(publicClient, await dlBob.write.approve([orderBook.address, 5n * ONE]));
    await waitFor(publicClient, await orderBookBob.write.placeSellDL([pairAddress, 5n * ONE]));

    const maxSell = await orderBook.read.maxImmediateSellIn([pairAddress]);
    assert.equal(maxSell, 0n);

    await waitFor(publicClient, await orderBook.write.settlePair([pairAddress, 0n, 10n]));

    const aliceOrder = await orderBook.read.orders([aliceOrderId]);
    const bobOrder = await orderBook.read.orders([bobOrderId]);
    assert.equal(aliceOrder[3], true);
    assert.equal(aliceOrder[4], 10n * ONE);
    assert.equal(bobOrder[3], true);
    assert.equal(bobOrder[4], 5n * ONE);
  });

  it("factory initPair auto-settles queued orders when swapOrderBook is configured", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, dl, other, factory, dealPairManager, orderBook } = fixture;

    await waitFor(publicClient, await factory.write.setOpsGlobals([orderBook.address, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"]));
    await waitFor(publicClient, await dealPairManager.write.createPair([other.address, 3, 1000]));
    const pairAddress = await dealPairManager.read.pairForToken([other.address]);

    const orderBookAlice = await viem.getContractAt("DealSwapOrderBook", orderBook.address, {
      client: { wallet: alice },
    });
    const dlAlice = await viem.getContractAt("DCToken", dl.address, { client: { wallet: alice } });

    const orderId = await orderBook.read.nextOrderId();
    await waitFor(publicClient, await dlAlice.write.approve([orderBook.address, 100n * ONE]));
    await waitFor(publicClient, await orderBookAlice.write.placeSellDL([pairAddress, 100n * ONE]));

    await waitFor(publicClient, await dl.write.transfer([pairAddress, 1_000n * ONE]));
    await waitFor(publicClient, await other.write.transfer([pairAddress, 20n * ONE]));
    await waitFor(publicClient, await dealPairManager.write.initPair([pairAddress, 0n]));

    const order = await orderBook.read.orders([orderId]);
    assert.equal(order[3], false);
    assert.equal(order[4], 0n);
  });

  it("factory mintPairOtherAndSettle adds OTHER liquidity and settles queued sell orders", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, dl, other, factory, dealPairManager, orderBook, createPairWithReserves } = fixture;
    const { pairAddress } = await createPairWithReserves(1_000n * ONE, 1n);

    await waitFor(publicClient, await factory.write.setOpsGlobals([orderBook.address, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"]));

    const orderBookAlice = await viem.getContractAt("DealSwapOrderBook", orderBook.address, {
      client: { wallet: alice },
    });
    const dlAlice = await viem.getContractAt("DCToken", dl.address, { client: { wallet: alice } });

    const orderId = await orderBook.read.nextOrderId();
    await waitFor(publicClient, await dlAlice.write.approve([orderBook.address, 100n * ONE]));
    await waitFor(publicClient, await orderBookAlice.write.placeSellDL([pairAddress, 100n * ONE]));

    await waitFor(publicClient, await other.write.transfer([pairAddress, 1_000n * ONE]));
    await waitFor(publicClient, await dealPairManager.write.mintPairOtherAndSettle([pairAddress]));

    const order = await orderBook.read.orders([orderId]);
    assert.equal(order[3], false);
    assert.equal(order[4], 0n);
  });

  it("factory mintPairOtherAndSettle still updates reserves when no queued orders exist", async function () {
    const fixture = await deployDexFixture();
    const { publicClient, other, dealPairManager, createPairWithReserves } = fixture;
    const { pairAddress, pair } = await createPairWithReserves(1_000n * ONE, 10n * ONE);

    await waitFor(publicClient, await other.write.transfer([pairAddress, 5n * ONE]));
    const [, reserveBefore] = await pair.read.getReserves();
    await waitFor(publicClient, await dealPairManager.write.mintPairOtherAndSettle([pairAddress]));
    const [, reserveAfter] = await pair.read.getReserves();
    assert.equal(reserveAfter, reserveBefore + 5n * ONE);
  });

  it("pair manager mintPairOtherAndSettle reverts when configured settlement fails", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, other, factory, dealPairManager, createPairWithReserves } = fixture;
    const { pairAddress, pair } = await createPairWithReserves(1_000n * ONE, 10n * ONE);

    const revertingOrderBook = await viem.deployContract("TestRevertingOrderBook");
    await waitFor(publicClient, await factory.write.setOpsGlobals([revertingOrderBook.address, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"]));

    await waitFor(publicClient, await other.write.transfer([pairAddress, 7n * ONE]));
    const [, reserveBefore] = await pair.read.getReserves();
    await assert.rejects(dealPairManager.write.mintPairOtherAndSettle([pairAddress]));
    const [, reserveAfter] = await pair.read.getReserves();
    assert.equal(reserveAfter, reserveBefore);
  });
});
