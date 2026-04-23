import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

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

async function deployRouterFixture() {
  const { viem } = await network.connect({ network: "hardhatMainnet" });
  const publicClient = await viem.getPublicClient();
  const [owner, alice, treasury] = await viem.getWalletClients();

  const dl = await viem.deployContract("DCToken", [
    "Deal DL",
    "DL",
    0n,
    owner.account.address,
    owner.account.address,
  ]);
  const tokenA = await viem.deployContract("DCToken", [
    "Token A",
    "TKA",
    0n,
    owner.account.address,
    owner.account.address,
  ]);
  const tokenB = await viem.deployContract("DCToken", [
    "Token B",
    "TKB",
    0n,
    owner.account.address,
    owner.account.address,
  ]);
  const wrappedNative = await viem.deployContract("TestWNative");

  const dealLib = await viem.deployContract("DealLib");
  const dealAssetNftLib = await viem.deployContract("DealAssetNftLib");
  const dealImpl = await viem.deployContract("Deal", [], {
    libraries: {
      DealLib: dealLib.address,
      DealAssetNftLib: dealAssetNftLib.address,
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
  for (const token of [dl, tokenA, tokenB]) {
    await waitFor(publicClient, await token.write.mint([owner.account.address, mintAmount]));
    await waitFor(publicClient, await token.write.mint([alice.account.address, mintAmount]));
  }

  await waitFor(publicClient, await factory.write.setGlobal(["dlToken", dl.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["wrappedNative", wrappedNative.address]));
  await waitFor(publicClient, await orderBook.write.setRouter([router.address]));

  async function createTokenPair(
    token: Address,
    dlAmount: bigint,
    tokenAmount: bigint,
  ) {
    await waitFor(publicClient, await factory.write.createPair([token, 3, 1000]));
    const pairAddress = await factory.read.pairForToken([token]);
    const pair = await viem.getContractAt("DealSwapTemplate", pairAddress);
    const tokenContract = await viem.getContractAt("DCToken", token);

    await waitFor(publicClient, await dl.write.transfer([pairAddress, dlAmount]));
    await waitFor(publicClient, await tokenContract.write.transfer([pairAddress, tokenAmount]));
    await waitFor(publicClient, await factory.write.initPair([pairAddress, 0n]));
    return { pairAddress, pair };
  }

  async function createWNativePair(dlAmount: bigint, nativeAmount: bigint) {
    await waitFor(publicClient, await factory.write.createPair([wrappedNative.address, 3, 1000]));
    const pairAddress = await factory.read.pairForToken([wrappedNative.address]);
    const pair = await viem.getContractAt("DealSwapTemplate", pairAddress);

    await waitFor(publicClient, await dl.write.transfer([pairAddress, dlAmount]));
    await waitFor(publicClient, await wrappedNative.write.deposit({ value: nativeAmount }));
    await waitFor(publicClient, await wrappedNative.write.transfer([pairAddress, nativeAmount]));
    await waitFor(publicClient, await factory.write.initPair([pairAddress, 0n]));
    return { pairAddress, pair };
  }

  return {
    viem,
    publicClient,
    owner,
    alice,
    dl,
    tokenA,
    tokenB,
    wrappedNative,
    router,
    createTokenPair,
    createWNativePair,
  };
}

describe("DealRouter regression", async function () {
  it("swaps exact-in across two DL pairs and leaves no router dust", async function () {
    const fixture = await deployRouterFixture();
    const { viem, publicClient, alice, dl, tokenA, tokenB, router, createTokenPair } = fixture;
    const { pairAddress: pairA, pair: pairAContract } = await createTokenPair(
      tokenA.address,
      1_000_000n * ONE,
      1_000_000n * ONE,
    );
    const { pairAddress: pairB, pair: pairBContract } = await createTokenPair(
      tokenB.address,
      1_000_000n * ONE,
      1_000_000n * ONE,
    );

    const routerAlice = await viem.getContractAt("DealRouter", router.address, {
      client: { wallet: alice },
    });
    const tokenAAlice = await viem.getContractAt("DCToken", tokenA.address, {
      client: { wallet: alice },
    });

    const amountIn = 100n * ONE;
    const [, , dlNet] = await pairAContract.read.quoteBuyGivenIn1([amountIn]);
    const [, expectedOut] = await pairBContract.read.quoteSell([dlNet]);
    const aliceABefore = await tokenA.read.balanceOf([alice.account.address]);
    const aliceBBefore = await tokenB.read.balanceOf([alice.account.address]);

    await waitFor(publicClient, await tokenAAlice.write.approve([router.address, amountIn]));
    await waitFor(
      publicClient,
      await routerAlice.write.swapExact1For1ViaDL([pairA, pairB, amountIn, expectedOut, 2n ** 63n]),
    );

    assert.equal(await tokenA.read.balanceOf([alice.account.address]), aliceABefore - amountIn);
    assert.equal(await tokenB.read.balanceOf([alice.account.address]), aliceBBefore + expectedOut);
    assert.equal(await dl.read.balanceOf([router.address]), 0n);
  });

  it("refunds unused ETH on exact-out via DL and leaves no router dust", async function () {
    const fixture = await deployRouterFixture();
    const { viem, publicClient, alice, dl, tokenB, wrappedNative, router, createTokenPair, createWNativePair } =
      fixture;
    const { pairAddress: pairWNATIVE, pair: pairWNATIVEContract } = await createWNativePair(
      1_000n * ONE,
      1_000n * ONE,
    );
    const { pairAddress: pairB, pair: pairBContract } = await createTokenPair(
      tokenB.address,
      1_000_000n * ONE,
      1_000_000n * ONE,
    );

    const routerAlice = await viem.getContractAt("DealRouter", router.address, {
      client: { wallet: alice },
    });

    const outTarget = 25n * ONE;
    const [dlRequired] = await pairBContract.read.quoteSellGivenOut1([outTarget]);
    const [, , ethNeeded] = await pairWNATIVEContract.read.quoteBuyGivenNet([dlRequired]);
    const ethMax = ethNeeded + (5n * ONE);

    const tokenBBefore = await tokenB.read.balanceOf([alice.account.address]);
    const ethBefore = await publicClient.getBalance({ address: alice.account.address });

    const hash = await routerAlice.write.swapETHForExact1ViaDL(
      [pairWNATIVE, pairB, outTarget, 2n ** 63n],
      { value: ethMax },
    );
    const receipt = await waitFor(publicClient, hash);
    const gasPaid = receipt.gasUsed * receipt.effectiveGasPrice;
    const ethAfter = await publicClient.getBalance({ address: alice.account.address });

    assert.equal(await tokenB.read.balanceOf([alice.account.address]), tokenBBefore + outTarget);
    assert.equal(ethBefore - ethAfter - gasPaid, ethNeeded);
    assert.equal(await dl.read.balanceOf([router.address]), 0n);
    assert.equal(await wrappedNative.read.balanceOf([router.address]), 0n);
  });
});
