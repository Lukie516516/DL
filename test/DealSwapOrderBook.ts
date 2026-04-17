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
  const [owner, alice, bob, treasury] = await viem.getWalletClients();

  const dl = await viem.deployContract("DCToken", [
    "Deal DL",
    "DL",
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
  const dealImpl = await viem.deployContract("Deal", [], {
    libraries: {
      DealLib: dealLib.address,
    },
  });
  const pairImpl = await viem.deployContract("DealSwapTemplate");
  const factory = await viem.deployContract("DealFactory", [
    dealImpl.address,
    pairImpl.address,
    3600,
  ]);
  const orderBook = await viem.deployContract("DealSwapOrderBook", [treasury.account.address]);
  const router = await viem.deployContract("DealRouter", [wrappedNative.address, orderBook.address]);

  const mintAmount = 10_000_000n * ONE;
  for (const token of [dl, other, wrappedNative]) {
    await waitFor(publicClient, await token.write.mint([owner.account.address, mintAmount]));
    await waitFor(publicClient, await token.write.mint([alice.account.address, mintAmount]));
    await waitFor(publicClient, await token.write.mint([bob.account.address, mintAmount]));
  }

  await waitFor(publicClient, await factory.write.setGlobal(["dlToken", dl.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["wrappedNative", wrappedNative.address]));
  await waitFor(publicClient, await orderBook.write.setRouter([router.address]));

  async function createPairWithReserves(dlAmount: bigint, otherAmount: bigint) {
    await waitFor(publicClient, await factory.write.createPair([other.address, 3, 1000]));
    const pairAddress = await factory.read.pairForToken([other.address]);
    const pair = await viem.getContractAt("DealSwapTemplate", pairAddress);

    await waitFor(publicClient, await dl.write.transfer([pairAddress, dlAmount]));
    await waitFor(publicClient, await other.write.transfer([pairAddress, otherAmount]));
    await waitFor(publicClient, await factory.write.initPair([pairAddress, 0n]));

    return { pairAddress, pair };
  }

  return {
    viem,
    publicClient,
    owner,
    alice,
    bob,
    treasury,
    dl,
    other,
    factory,
    orderBook,
    router,
    wrappedNative,
    createPairWithReserves,
  };
}

describe("DealSwapOrderBook", async function () {
  it("partially fills a large DL sell order and queues the remainder", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, dl, other, orderBook, createPairWithReserves } = fixture;
    const { pairAddress } = await createPairWithReserves(1_000n * ONE, 10n * ONE);

    const orderBookAlice = await viem.getContractAt("DealSwapOrderBook", orderBook.address, {
      client: { wallet: alice },
    });
    const dlAlice = await viem.getContractAt("DCToken", dl.address, { client: { wallet: alice } });

    const sellAmount = 20_000n * ONE;
    const aliceOtherBefore = await other.read.balanceOf([alice.account.address]);
    const nextOrderIdBefore = await orderBook.read.nextOrderId();

    await waitFor(publicClient, await dlAlice.write.approve([orderBook.address, sellAmount]));
    await waitFor(publicClient, await orderBookAlice.write.placeSellDL([pairAddress, sellAmount]));

    const order = await orderBook.read.orders([nextOrderIdBefore]);
    const aliceOtherAfter = await other.read.balanceOf([alice.account.address]);

    assert.equal(order[0], getAddress(alice.account.address));
    assert.equal(order[1], pairAddress);
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
    const refund = amountIn - fee;
    const nextOrderIdBefore = await orderBook.read.nextOrderId();
    const aliceDlBefore = await dl.read.balanceOf([alice.account.address]);
    const treasuryDlBefore = await dl.read.balanceOf([treasury.account.address]);

    await waitFor(publicClient, await dlAlice.write.approve([orderBook.address, amountIn]));
    await waitFor(publicClient, await orderBookAlice.write.placeSellDL([pairAddress, amountIn]));
    await waitFor(publicClient, await orderBookAlice.write.cancelOrder([nextOrderIdBefore]));

    const order = await orderBook.read.orders([nextOrderIdBefore]);
    assert.equal(order[3], false);
    assert.equal(order[4], 0n);
    assert.equal(await dl.read.balanceOf([treasury.account.address]), treasuryDlBefore + fee);
    assert.equal(await dl.read.balanceOf([alice.account.address]), aliceDlBefore - fee);
    assert.equal(await dl.read.balanceOf([orderBook.address]), 0n);
    assert.equal(refund + fee, amountIn);
  });

  it("settles queued sell orders in FIFO order", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, owner, alice, bob, dl, other, orderBook, createPairWithReserves } = fixture;
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

    await waitFor(publicClient, await other.write.transfer([pairAddress, 1_000n * ONE]));
    await waitFor(publicClient, await pair.write.mintOtherOnly());

    const aliceOtherBefore = await other.read.balanceOf([alice.account.address]);
    const bobOtherBefore = await other.read.balanceOf([bob.account.address]);

    await waitFor(publicClient, await orderBook.write.settlePair([pairAddress, 0n, 1n]));

    const aliceOrder = await orderBook.read.orders([aliceOrderId]);
    const bobOrder = await orderBook.read.orders([bobOrderId]);
    const aliceOtherAfter = await other.read.balanceOf([alice.account.address]);
    const bobOtherAfter = await other.read.balanceOf([bob.account.address]);

    assert.equal(aliceOrder[3], false);
    assert.equal(aliceOrder[4], 0n);
    assert.equal(bobOrder[3], true);
    assert.equal(bobOrder[4], 50n * ONE);
    assert.ok(aliceOtherAfter > aliceOtherBefore);
    assert.equal(bobOtherAfter, bobOtherBefore);

    await waitFor(publicClient, await other.write.transfer([pairAddress, 20n * ONE]));
    await waitFor(publicClient, await pair.write.mintOtherOnly());
    await waitFor(publicClient, await orderBook.write.settlePair([pairAddress, 0n, 1n]));

    const bobOrderAfter = await orderBook.read.orders([bobOrderId]);
    assert.equal(bobOrderAfter[3], false);
    assert.equal(bobOrderAfter[4], 0n);
  });

  it("supports OTHER -> DL queued orders and charges cancel fees in OTHER", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, treasury, dl, other, orderBook, createPairWithReserves } = fixture;
    const { pairAddress } = await createPairWithReserves(1n, 1_000n * ONE);

    const orderBookAlice = await viem.getContractAt("DealSwapOrderBook", orderBook.address, {
      client: { wallet: alice },
    });
    const otherAlice = await viem.getContractAt("DCToken", other.address, { client: { wallet: alice } });

    const amountIn = 100n * ONE;
    const fee = amountIn / 1000n;
    const nextOrderIdBefore = await orderBook.read.nextOrderId();
    const aliceOtherBefore = await other.read.balanceOf([alice.account.address]);
    const treasuryOtherBefore = await other.read.balanceOf([treasury.account.address]);
    const aliceDlBefore = await dl.read.balanceOf([alice.account.address]);

    await waitFor(publicClient, await otherAlice.write.approve([orderBook.address, amountIn]));
    await waitFor(publicClient, await orderBookAlice.write.placeBuyDL([pairAddress, amountIn]));

    const order = await orderBook.read.orders([nextOrderIdBefore]);
    assert.equal(order[2], false);
    assert.equal(order[4], amountIn);
    assert.equal(await dl.read.balanceOf([alice.account.address]), aliceDlBefore);

    await waitFor(publicClient, await orderBookAlice.write.cancelOrder([nextOrderIdBefore]));
    assert.equal(await other.read.balanceOf([treasury.account.address]), treasuryOtherBefore + fee);
    assert.equal(await other.read.balanceOf([alice.account.address]), aliceOtherBefore - fee);
  });

  it("router auto-queues the remainder for exact-in DL sells", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, dl, other, orderBook, router, createPairWithReserves } = fixture;
    const { pairAddress } = await createPairWithReserves(1_000n * ONE, 10n * ONE);

    const routerAlice = await viem.getContractAt("DealRouter", router.address, {
      client: { wallet: alice },
    });
    const dlAlice = await viem.getContractAt("DCToken", dl.address, { client: { wallet: alice } });
    const aliceOtherBefore = await other.read.balanceOf([alice.account.address]);
    const nextOrderIdBefore = await orderBook.read.nextOrderId();

    const sellAmount = 20_000n * ONE;
    await waitFor(publicClient, await dlAlice.write.approve([router.address, sellAmount]));
    await waitFor(publicClient, await routerAlice.write.swapExact0For1OrQueue([pairAddress, sellAmount, 2n ** 63n]));

    const order = await orderBook.read.orders([nextOrderIdBefore]);
    const aliceOtherAfter = await other.read.balanceOf([alice.account.address]);
    assert.equal(order[0], getAddress(alice.account.address));
    assert.equal(order[2], true);
    assert.equal(order[3], true);
    assert.ok(order[4] > 0n);
    assert.ok(aliceOtherAfter > aliceOtherBefore);
  });

  it("router auto-queues the remainder for exact-in ETH buys of DL", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, dl, orderBook, router, factory, wrappedNative } = fixture;

    await waitFor(publicClient, await factory.write.createPair([wrappedNative.address, 3, 1000]));
    const pairAddress = await factory.read.pairForToken([wrappedNative.address]);

    await waitFor(publicClient, await dl.write.transfer([pairAddress, 1_000n * ONE]));
    await waitFor(publicClient, await wrappedNative.write.deposit({ value: 10n * ONE }));
    await waitFor(publicClient, await wrappedNative.write.transfer([pairAddress, 10n * ONE]));
    await waitFor(publicClient, await factory.write.initPair([pairAddress, 0n]));

    const routerAlice = await viem.getContractAt("DealRouter", router.address, {
      client: { wallet: alice },
    });
    const nextOrderIdBefore = await orderBook.read.nextOrderId();
    const aliceDlBefore = await dl.read.balanceOf([alice.account.address]);

    await waitFor(publicClient, await routerAlice.write.swapExactETHFor0OrQueue([pairAddress, 2n ** 63n], { value: 200n * ONE }));

    const order = await orderBook.read.orders([nextOrderIdBefore]);
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
    const { viem, publicClient, alice, treasury, dl, orderBook, router, factory, wrappedNative } = fixture;

    await waitFor(publicClient, await factory.write.createPair([wrappedNative.address, 3, 1000]));
    const pairAddress = await factory.read.pairForToken([wrappedNative.address]);

    await waitFor(publicClient, await dl.write.transfer([pairAddress, 1_000n * ONE]));
    await waitFor(publicClient, await wrappedNative.write.deposit({ value: 10n * ONE }));
    await waitFor(publicClient, await wrappedNative.write.transfer([pairAddress, 10n * ONE]));
    await waitFor(publicClient, await factory.write.initPair([pairAddress, 0n]));

    const routerAlice = await viem.getContractAt("DealRouter", router.address, {
      client: { wallet: alice },
    });
    const orderBookAlice = await viem.getContractAt("DealSwapOrderBook", orderBook.address, {
      client: { wallet: alice },
    });

    const nextOrderIdBefore = await orderBook.read.nextOrderId();
    const treasuryBefore = await publicClient.getBalance({ address: treasury.account.address });
    const aliceBefore = await publicClient.getBalance({ address: alice.account.address });

    const placeHash = await routerAlice.write.swapExactETHFor0OrQueue([pairAddress, 2n ** 63n], { value: 200n * ONE });
    const placeReceipt = await waitFor(publicClient, placeHash);
    const placeGas = placeReceipt.gasUsed * placeReceipt.effectiveGasPrice;

    const order = await orderBook.read.orders([nextOrderIdBefore]);
    const queuedIn = order[4] as bigint;
    const fee = queuedIn / 1000n;
    const refund = queuedIn - fee;

    const cancelHash = await orderBookAlice.write.cancelOrder([nextOrderIdBefore]);
    const cancelReceipt = await waitFor(publicClient, cancelHash);
    const cancelGas = cancelReceipt.gasUsed * cancelReceipt.effectiveGasPrice;

    const treasuryAfter = await publicClient.getBalance({ address: treasury.account.address });
    const aliceAfter = await publicClient.getBalance({ address: alice.account.address });
    const orderAfter = await orderBook.read.orders([nextOrderIdBefore]);

    assert.equal(orderAfter[3], false);
    assert.equal(orderAfter[4], 0n);
    assert.equal(treasuryAfter, treasuryBefore + fee);
    assert.equal(aliceAfter, aliceBefore - (200n * ONE) - placeGas - cancelGas + refund);
  });

  it("router auto-queues the remainder for exact-in DL sells to ETH and unwraps on settlement", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, dl, orderBook, router, factory, wrappedNative } = fixture;

    await waitFor(publicClient, await factory.write.createPair([wrappedNative.address, 3, 1000]));
    const pairAddress = await factory.read.pairForToken([wrappedNative.address]);
    const pair = await viem.getContractAt("DealSwapTemplate", pairAddress);

    await waitFor(publicClient, await dl.write.transfer([pairAddress, 1_000n * ONE]));
    await waitFor(publicClient, await wrappedNative.write.deposit({ value: 10n * ONE }));
    await waitFor(publicClient, await wrappedNative.write.transfer([pairAddress, 10n * ONE]));
    await waitFor(publicClient, await factory.write.initPair([pairAddress, 0n]));

    const routerAlice = await viem.getContractAt("DealRouter", router.address, {
      client: { wallet: alice },
    });
    const dlAlice = await viem.getContractAt("DCToken", dl.address, { client: { wallet: alice } });

    const sellAmount = 20_000n * ONE;
    await waitFor(publicClient, await dlAlice.write.approve([router.address, sellAmount]));

    const balanceBefore = await publicClient.getBalance({ address: alice.account.address });
    const sellTxHash = await routerAlice.write.swapExact0ForETHOrQueue([pairAddress, sellAmount, 2n ** 63n]);
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

  it("factory initPair auto-settles queued orders when swapOrderBook is configured", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, owner, alice, dl, other, factory, orderBook } = fixture;

    await waitFor(publicClient, await factory.write.setGlobal(["swapOrderBook", orderBook.address]));
    await waitFor(publicClient, await factory.write.createPair([other.address, 3, 1000]));
    const pairAddress = await factory.read.pairForToken([other.address]);

    const orderBookAlice = await viem.getContractAt("DealSwapOrderBook", orderBook.address, {
      client: { wallet: alice },
    });
    const dlAlice = await viem.getContractAt("DCToken", dl.address, { client: { wallet: alice } });

    const orderId = await orderBook.read.nextOrderId();
    await waitFor(publicClient, await dlAlice.write.approve([orderBook.address, 100n * ONE]));
    await waitFor(publicClient, await orderBookAlice.write.placeSellDL([pairAddress, 100n * ONE]));

    await waitFor(publicClient, await dl.write.transfer([pairAddress, 1_000n * ONE]));
    await waitFor(publicClient, await other.write.transfer([pairAddress, 20n * ONE]));
    await waitFor(publicClient, await factory.write.initPair([pairAddress, 0n]));

    const order = await orderBook.read.orders([orderId]);
    assert.equal(order[3], false);
    assert.equal(order[4], 0n);
  });

  it("factory mintPairOtherAndSettle adds OTHER liquidity and settles queued sell orders", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, alice, dl, other, factory, orderBook, createPairWithReserves } = fixture;
    const { pairAddress } = await createPairWithReserves(1_000n * ONE, 1n);

    await waitFor(publicClient, await factory.write.setGlobal(["swapOrderBook", orderBook.address]));

    const orderBookAlice = await viem.getContractAt("DealSwapOrderBook", orderBook.address, {
      client: { wallet: alice },
    });
    const dlAlice = await viem.getContractAt("DCToken", dl.address, { client: { wallet: alice } });

    const orderId = await orderBook.read.nextOrderId();
    await waitFor(publicClient, await dlAlice.write.approve([orderBook.address, 100n * ONE]));
    await waitFor(publicClient, await orderBookAlice.write.placeSellDL([pairAddress, 100n * ONE]));

    await waitFor(publicClient, await other.write.transfer([pairAddress, 1_000n * ONE]));
    await waitFor(publicClient, await factory.write.mintPairOtherAndSettle([pairAddress]));

    const order = await orderBook.read.orders([orderId]);
    assert.equal(order[3], false);
    assert.equal(order[4], 0n);
  });

  it("factory mintPairOtherAndSettle still updates reserves when no queued orders exist", async function () {
    const fixture = await deployDexFixture();
    const { publicClient, other, factory, createPairWithReserves } = fixture;
    const { pairAddress, pair } = await createPairWithReserves(1_000n * ONE, 10n * ONE);

    await waitFor(publicClient, await other.write.transfer([pairAddress, 5n * ONE]));
    const [, reserveBefore] = await pair.read.getReserves();

    await waitFor(publicClient, await factory.write.mintPairOtherAndSettle([pairAddress]));

    const [, reserveAfter] = await pair.read.getReserves();
    assert.equal(reserveAfter, reserveBefore + 5n * ONE);
  });

  it("factory mintPairOtherAndSettle does not revert liquidity update when settlePair fails", async function () {
    const fixture = await deployDexFixture();
    const { viem, publicClient, other, factory, createPairWithReserves } = fixture;
    const { pairAddress, pair } = await createPairWithReserves(1_000n * ONE, 10n * ONE);

    const revertingOrderBook = await viem.deployContract("TestRevertingOrderBook");
    await waitFor(publicClient, await factory.write.setGlobal(["swapOrderBook", revertingOrderBook.address]));

    await waitFor(publicClient, await other.write.transfer([pairAddress, 7n * ONE]));
    const [, reserveBefore] = await pair.read.getReserves();

    await waitFor(publicClient, await factory.write.mintPairOtherAndSettle([pairAddress]));

    const [, reserveAfter] = await pair.read.getReserves();
    assert.equal(reserveAfter, reserveBefore + 7n * ONE);
  });
});
