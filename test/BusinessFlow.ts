import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress } from "viem";

const ONE = 10n ** 18n;
const DEADLINE = 2n ** 63n;

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

async function deployBusinessFixture() {
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
  const ausd = await viem.deployContract("DCToken", [
    "Test AUSD",
    "AUSD",
    0n,
    owner.account.address,
    owner.account.address,
  ]);
  const usdt = await viem.deployContract("DCToken", [
    "Test USDT",
    "USDT",
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
  const infoNft = await viem.deployContract("DealInfoNFT", [
    factory.address,
    "0x0000000000000000000000000000000000000000",
    0n,
  ]);
  const orderBook = await viem.deployContract("DealSwapOrderBook", [treasury.account.address]);
  const router = await viem.deployContract("DealRouter", [wrappedNative.address, orderBook.address]);
  const dcDomain = await viem.deployContract("DCDomain", [dl.address, treasury.account.address]);
  const dcDomainMarket = await viem.deployContract("DCDomainMarket", [
    dcDomain.address,
    dl.address,
    treasury.account.address,
    100n,
  ]);

  const minterRole = await dl.read.MINTER_ROLE();
  await waitFor(publicClient, await factory.write.setGlobal(["dlToken", dl.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["infoNft", infoNft.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["wrappedNative", wrappedNative.address]));
  await waitFor(publicClient, await factory.write.setRecognizedTokens([ausd.address, usdt.address]));
  await waitFor(publicClient, await factory.write.setTreasuryByAdmin([treasury.account.address]));
  await waitFor(publicClient, await dl.write.grantRole([minterRole, factory.address]));
  await waitFor(publicClient, await orderBook.write.setRouter([router.address]));
  await waitFor(publicClient, await dcDomain.write.setDomainMarket([dcDomainMarket.address]));

  const mintAmount = 10_000_000n * ONE;
  for (const token of [dl, ausd, usdt, wrappedNative]) {
    await waitFor(publicClient, await token.write.mint([owner.account.address, mintAmount]));
    await waitFor(publicClient, await token.write.mint([alice.account.address, mintAmount]));
    await waitFor(publicClient, await token.write.mint([bob.account.address, mintAmount]));
  }

  await waitFor(publicClient, await factory.write.createPair([ausd.address, 3, 1000]));
  const ausdPairAddress = await factory.read.pairForToken([ausd.address]);
  await waitFor(publicClient, await dl.write.transfer([ausdPairAddress, 1_000_000n * ONE]));
  await waitFor(publicClient, await ausd.write.transfer([ausdPairAddress, 1_000_000n * ONE]));
  await waitFor(publicClient, await factory.write.initPair([ausdPairAddress, 0n]));

  await waitFor(publicClient, await infoNft.write.setMintPriceU([ausdPairAddress, ONE]));

  return {
    viem,
    publicClient,
    owner,
    alice,
    bob,
    treasury,
    dl,
    ausd,
    factory,
    infoNft,
    router,
    orderBook,
    dcDomain,
    dcDomainMarket,
    ausdPairAddress,
  };
}

describe("Business Flow", async function () {
  it("runs swap to nft purchase to profit realization and swap-back end to end", async function () {
    const fixture = await deployBusinessFixture();
    const {
      viem,
      publicClient,
      alice,
      bob,
      treasury,
      dl,
      ausd,
      infoNft,
      router,
      dcDomain,
      dcDomainMarket,
      ausdPairAddress,
    } = fixture;

    const routerAsAlice = await viem.getContractAt("DealRouter", router.address, {
      client: { wallet: alice },
    });
    const routerAsBob = await viem.getContractAt("DealRouter", router.address, {
      client: { wallet: bob },
    });
    const ausdAsAlice = await viem.getContractAt("DCToken", ausd.address, {
      client: { wallet: alice },
    });
    const ausdAsBob = await viem.getContractAt("DCToken", ausd.address, {
      client: { wallet: bob },
    });
    const dlAsAlice = await viem.getContractAt("DCToken", dl.address, {
      client: { wallet: alice },
    });
    const dlAsBob = await viem.getContractAt("DCToken", dl.address, {
      client: { wallet: bob },
    });
    const infoNftAsAlice = await viem.getContractAt("DealInfoNFT", infoNft.address, {
      client: { wallet: alice },
    });
    const dcDomainAsAlice = await viem.getContractAt("DCDomain", dcDomain.address, {
      client: { wallet: alice },
    });
    const marketAsAlice = await viem.getContractAt("DCDomainMarket", dcDomainMarket.address, {
      client: { wallet: alice },
    });
    const marketAsBob = await viem.getContractAt("DCDomainMarket", dcDomainMarket.address, {
      client: { wallet: bob },
    });

    const aliceDlBeforeSwap = await dl.read.balanceOf([alice.account.address]);
    const aliceAusdBeforeSwap = await ausd.read.balanceOf([alice.account.address]);
    await waitFor(publicClient, await ausdAsAlice.write.approve([router.address, 2_000n * ONE]));
    await waitFor(
      publicClient,
      await routerAsAlice.write.swapExact1For0OrQueue([ausdPairAddress, 2_000n * ONE, DEADLINE]),
    );
    const aliceDlAfterSwap = await dl.read.balanceOf([alice.account.address]);
    const aliceAusdAfterSwap = await ausd.read.balanceOf([alice.account.address]);

    assert.ok(aliceDlAfterSwap > aliceDlBeforeSwap);
    assert.ok(aliceAusdAfterSwap < aliceAusdBeforeSwap);

    const infoNftId = await infoNft.read.nextId();
    await waitFor(publicClient, await dlAsAlice.write.approve([infoNft.address, 1_000_000n * ONE]));
    await waitFor(publicClient, await infoNftAsAlice.write.mintByBurn());
    assert.equal(await infoNft.read.ownerOf([infoNftId]), getAddress(alice.account.address));

    const domainPrice = await dcDomain.read.getPrice(["sale01"]);
    assert.equal(domainPrice, 500n * ONE);
    await waitFor(publicClient, await dlAsAlice.write.approve([dcDomain.address, domainPrice]));
    await waitFor(publicClient, await dcDomainAsAlice.write.register(["sale01"]));
    const domainTokenId = await dcDomain.read.tokenIdOf(["sale01"]);
    assert.equal(await dcDomain.read.ownerOf([domainTokenId]), getAddress(alice.account.address));

    await waitFor(publicClient, await ausdAsBob.write.approve([router.address, 2_000n * ONE]));
    await waitFor(
      publicClient,
      await routerAsBob.write.swapExact1For0OrQueue([ausdPairAddress, 2_000n * ONE, DEADLINE]),
    );

    const salePrice = 600n * ONE;
    const fee = salePrice / 100n;
    const aliceDlBeforeSale = await dl.read.balanceOf([alice.account.address]);
    const treasuryDlBeforeSale = await dl.read.balanceOf([treasury.account.address]);

    await waitFor(publicClient, await dcDomainAsAlice.write.approve([dcDomainMarket.address, domainTokenId]));
    await waitFor(publicClient, await marketAsAlice.write.list([domainTokenId, salePrice]));
    await waitFor(publicClient, await dlAsBob.write.approve([dcDomainMarket.address, salePrice]));
    await waitFor(publicClient, await marketAsBob.write.buy([domainTokenId]));

    assert.equal(await dcDomain.read.ownerOf([domainTokenId]), getAddress(bob.account.address));
    assert.equal(await dcDomain.read.resolve(["sale01"]), getAddress(bob.account.address));
    assert.equal(await dl.read.balanceOf([alice.account.address]), aliceDlBeforeSale + salePrice - fee);
    assert.equal(await dl.read.balanceOf([treasury.account.address]), treasuryDlBeforeSale + fee);

    const aliceAusdBeforeSwapBack = await ausd.read.balanceOf([alice.account.address]);
    const aliceDlBeforeSwapBack = await dl.read.balanceOf([alice.account.address]);
    await waitFor(publicClient, await dlAsAlice.write.approve([router.address, 300n * ONE]));
    await waitFor(
      publicClient,
      await routerAsAlice.write.swapExact0For1OrQueue([ausdPairAddress, 300n * ONE, DEADLINE]),
    );
    const aliceAusdAfterSwapBack = await ausd.read.balanceOf([alice.account.address]);
    const aliceDlAfterSwapBack = await dl.read.balanceOf([alice.account.address]);

    assert.ok(aliceAusdAfterSwapBack > aliceAusdBeforeSwapBack);
    assert.ok(aliceDlAfterSwapBack < aliceDlBeforeSwapBack);
    assert.equal(await infoNft.read.ownerOf([infoNftId]), getAddress(alice.account.address));
  });
});
