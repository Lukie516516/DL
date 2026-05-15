import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, zeroAddress } from "viem";

const ONE = 10n ** 18n;
const ACCEPT = 1;
const OPEN_JOIN = 0;
const EXACT_JOIN = 1;
const TEMPLATE_TOKEN_TO_TOKEN = 0;
const TEMPLATE_TOKEN_TO_NFT = 1;
const TEMPLATE_TOKEN_TO_EMPTY = 2;

const DEFAULT_TIME_START = 1_700_000_000n;
const DEFAULT_TIME_END = 1_800_000_000n;

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

function decodeJsonDataUri(dataUri: string) {
  const encoded = dataUri.split(",")[1];
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

async function deployDomainFixture() {
  const { viem } = await network.connect({ network: "hardhatMainnet" });
  const publicClient = await viem.getPublicClient();
  const [owner, alice, bob, carol, treasury] = await viem.getWalletClients();

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
  const wrappedNative = await viem.deployContract("DCToken", [
    "Wrapped Native",
    "WNATIVE",
    0n,
    owner.account.address,
    owner.account.address,
  ]);

  const dealLib = await viem.deployContract("DealLib");
  const dealAssetNftLib = await viem.deployContract("DealAssetNftLib");
  const dealImpl = await viem.deployContract("Deal");
  const dealNoAssetImpl = await viem.deployContract("DealNoAsset", [], {
    libraries: {
      DealLib: dealLib.address,
    },
  });
  const dealAAssetNftImpl = await viem.deployContract("DealAAssetNft", [], {
    libraries: {
      DealLib: dealLib.address,
      DealAssetNftLib: dealAssetNftLib.address,
    },
  });
  const dealBAssetNftImpl = await viem.deployContract("DealBAssetNft", [], {
    libraries: {
      DealLib: dealLib.address,
      DealAssetNftLib: dealAssetNftLib.address,
    },
  });
  const dealAAssetNftOnlyImpl = await viem.deployContract("DealAAssetNftOnly", [], {
    libraries: {
      DealAssetNftLib: dealAssetNftLib.address,
    },
  });
  const dealBAssetNftOnlyImpl = await viem.deployContract("DealBAssetNftOnly", [], {
    libraries: {
      DealAssetNftLib: dealAssetNftLib.address,
    },
  });
  const dealOpenTTImpl = await viem.deployContract("DealOpenTokenToken", [], {
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
  const dealActivityIndex = await viem.deployContract("DealActivityIndex", [factory.address]);
  const dealImplementationRegistry = await viem.deployContract("DealImplementationRegistry");
  await waitFor(
    publicClient,
    await dealImplementationRegistry.write.setDealImplementations([
      dealImpl.address,
      dealNoAssetImpl.address,
      dealAAssetNftImpl.address,
      dealBAssetNftImpl.address,
      dealAAssetNftOnlyImpl.address,
      dealBAssetNftOnlyImpl.address,
      dealOpenTTImpl.address,
    ]),
  );
  const dealMessageHub = await viem.deployContract("DealMessageHub", [factory.address]);
  const infoNft = await viem.deployContract("DealInfoNFT", [
    factory.address,
    zeroAddress,
    0n,
  ]);

  const dcDomain = await viem.deployContract("DCDomain", [
    dl.address,
    treasury.account.address,
  ]);
  const dcDomainMarket = await viem.deployContract("DCDomainMarket", [
    dcDomain.address,
    dl.address,
    treasury.account.address,
    100n,
  ]);
  const dcDomainRank = await viem.deployContract("DCDomainRank", [
    dl.address,
    dcDomain.address,
    treasury.account.address,
  ]);
  const dcDomainHall = await viem.deployContract("DCDomainHall", [
    dcDomainRank.address,
    dcDomain.address,
    factory.address,
  ]);
  const dcDomainSwap = await viem.deployContract("DCDomainSwap", [
    dcDomain.address,
    dcDomainRank.address,
    factory.address,
  ]);

  const mintAmount = 10_000_000n * ONE;
  const minterRole = await dl.read.MINTER_ROLE();

  await waitFor(publicClient, await factory.write.setGlobal(["dlToken", dl.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["infoNft", infoNft.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["wrappedNative", wrappedNative.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["dealMessageHub", dealMessageHub.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["dealActivityIndex", dealActivityIndex.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["dealImplementationRegistry", dealImplementationRegistry.address]));
  await waitFor(publicClient, await factory.write.setRecognizedTokens([ausd.address, usdt.address]));
  await waitFor(
    publicClient,
    await factory.write.setTreasuryByAdmin([treasury.account.address]),
  );
  await waitFor(publicClient, await dl.write.grantRole([minterRole, factory.address]));
  await waitFor(publicClient, await dcDomain.write.setDomainMarket([dcDomainMarket.address]));
  await waitFor(
    publicClient,
    await factory.write.setAllowedCreateFor([dcDomainSwap.address, true]),
  );
  await waitFor(
    publicClient,
    await factory.write.setAllowedCreateFor([dcDomainHall.address, true]),
  );
  await waitFor(
    publicClient,
    await dcDomainRank.write.setDealReporter([dcDomainSwap.address, true]),
  );
  await waitFor(
    publicClient,
    await dcDomainRank.write.setDealReporter([dcDomainHall.address, true]),
  );

  for (const token of [dl, ausd, usdt, wrappedNative]) {
    await waitFor(publicClient, await token.write.mint([owner.account.address, mintAmount]));
    await waitFor(publicClient, await token.write.mint([alice.account.address, mintAmount]));
    await waitFor(publicClient, await token.write.mint([bob.account.address, mintAmount]));
    await waitFor(publicClient, await token.write.mint([carol.account.address, mintAmount]));
  }

  async function createAndInitPair(tokenAddress: Address) {
    await waitFor(publicClient, await factory.write.createPair([tokenAddress, 3, 1000]));
    const pairAddress = await factory.read.pairForToken([tokenAddress]);
    const pair = await viem.getContractAt("DealSwapTemplate", pairAddress);
    const token = await viem.getContractAt("DCToken", tokenAddress);

    await waitFor(publicClient, await dl.write.transfer([pairAddress, 1_000_000n * ONE]));
    await waitFor(publicClient, await token.write.transfer([pairAddress, 1_000_000n * ONE]));
    await waitFor(publicClient, await factory.write.initPair([pairAddress, 0n]));

    return { pairAddress, pair };
  }

  await createAndInitPair(ausd.address);
  await createAndInitPair(usdt.address);

  async function registerDomain(wallet: typeof owner, domainName: string) {
    const paymentAsUser = await viem.getContractAt("DCToken", dl.address, {
      client: { wallet },
    });
    const dcDomainAsUser = await viem.getContractAt("DCDomain", dcDomain.address, {
      client: { wallet },
    });

    const price = await dcDomain.read.getPrice([domainName]);
    await waitFor(publicClient, await paymentAsUser.write.approve([dcDomain.address, price]));
    await waitFor(publicClient, await dcDomainAsUser.write.register([domainName]));
    return dcDomain.read.tokenIdOf([domainName]);
  }

  return {
    viem,
    publicClient,
    owner,
    alice,
    bob,
    carol,
    treasury,
    dl,
    ausd,
    usdt,
    factory,
    dcDomain,
    dcDomainMarket,
    dcDomainRank,
    dcDomainHall,
    dcDomainSwap,
    registerDomain,
  };
}

async function createDealAndGetAddress(
  fixture: Awaited<ReturnType<typeof deployDomainFixture>>,
  wallet: Awaited<ReturnType<typeof network.connect<{ network: "hardhatMainnet" }>>>["viem"]["getWalletClients"] extends Promise<
    infer T
  >
    ? T extends Array<infer U>
      ? U
      : never
    : never,
  init: {
    aSwapToken: Address;
    aSwapAmount: bigint;
    bSwapToken: Address;
    bSwapAmount: bigint;
    aAssetNft?: Address;
    aAssetNftId?: bigint;
    joinMode?: number;
    expectedB?: Address;
    templateType?: number;
    isDomainDeal?: boolean;
    domainName?: string;
    title?: string;
    description?: string;
  },
) {
  const { viem, publicClient, factory } = fixture;
  const factoryAsUser = await viem.getContractAt("DealFactory", factory.address, {
    client: { wallet },
  });
  const hash = await factoryAsUser.write.createDeal([
    {
      init: {
        aSwapToken: init.aSwapToken,
        aSwapAmount: init.aSwapAmount,
        aMarginToken: zeroAddress,
        aMarginAmount: 0n,
        bSwapToken: init.bSwapToken,
        bSwapAmount: init.bSwapAmount,
        bMarginToken: zeroAddress,
        bMarginAmount: 0n,
        aAssetNft: init.aAssetNft ?? zeroAddress,
        aAssetNftId: init.aAssetNftId ?? 0n,
        bAssetNft: zeroAddress,
        bAssetNftId: 0n,
        templateType: init.templateType ?? TEMPLATE_TOKEN_TO_NFT,
        joinMode: init.joinMode ?? OPEN_JOIN,
        expectedB: init.expectedB ?? zeroAddress,
        gateNftId: 0n,
        aNftId: 0n,
        title: init.title ?? "domain sale",
        description: init.description ?? "",
        timeoutSeconds: 3600n,
        replaceTimeoutSeconds: 0n,
        timeStart: DEFAULT_TIME_START,
        timeEnd: DEFAULT_TIME_END,
        isDomainDeal: init.isDomainDeal ?? false,
        domainName: init.domainName ?? "",
        openTokenTokenFast: false,
      },
      trackCreator: false,
    },
  ]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const events = await publicClient.getContractEvents({
    address: factory.address,
    abi: factory.abi,
    eventName: "DealCreated",
    fromBlock: receipt.blockNumber,
    toBlock: receipt.blockNumber,
    strict: true,
  });

  assert.equal(events.length, 1);
  return events[0].args.deal;
}

describe("Domain Flows", async function () {
  it("stores editable domain metadata on-chain and tracks total domain count", async function () {
    const fixture = await deployDomainFixture();
    const { viem, publicClient, alice, dcDomain } = fixture;

    assert.equal(await dcDomain.read.getPrice(["abc123"]), 500n * ONE);
    assert.equal(await dcDomain.read.getPrice(["999999"]), 500n * ONE);

    const tokenId = await fixture.registerDomain(alice, "abc123");
    const dcDomainAsAlice = await viem.getContractAt("DCDomain", dcDomain.address, {
      client: { wallet: alice },
    });

    await waitFor(
      publicClient,
      await dcDomainAsAlice.write.setDomainDescriptionFor(["abc123", "domain profile text"]),
    );
    await waitFor(
      publicClient,
      await dcDomainAsAlice.write.setDomainBackgroundUriFor(["abc123", "ipfs://domain-bg"]),
    );

    assert.equal(await dcDomain.read.totalDomains(), 1n);
    assert.equal(getAddress(await dcDomain.read.resolve(["abc123"])), getAddress(alice.account.address));
    assert.equal(await dcDomain.read.domainDescription([tokenId]), "domain profile text");
    assert.equal(await dcDomain.read.domainBackgroundUri([tokenId]), "ipfs://domain-bg");

    const tokenUri = await dcDomain.read.tokenURI([tokenId]);
    const metadata = decodeJsonDataUri(tokenUri);
    assert.equal(metadata.name, "abc123@DC");
    assert.equal(metadata.description, "domain profile text");
    assert.equal(metadata.image, "ipfs://domain-bg");

    await assert.rejects(dcDomain.write.setTreasury([zeroAddress]), /zero treasury/);
    await assert.rejects(dcDomain.write.setPaymentToken([zeroAddress]), /zero token/);
    await assert.rejects(
      dcDomainAsAlice.write.setDomainDescriptionFor(["abc123", 'bad " quote']),
      /unsafe char/,
    );
  });

  it("supports public listings, pagination, fee charging, and resolve sync on buy", async function () {
    const fixture = await deployDomainFixture();
    const { viem, publicClient, alice, bob, treasury, dl, dcDomain, dcDomainMarket } = fixture;

    const tokenId = await fixture.registerDomain(alice, "pub123");
    const price = 100n * ONE;

    const marketAsAlice = await viem.getContractAt("DCDomainMarket", dcDomainMarket.address, {
      client: { wallet: alice },
    });
    const marketAsBob = await viem.getContractAt("DCDomainMarket", dcDomainMarket.address, {
      client: { wallet: bob },
    });
    const dcDomainAsAlice = await viem.getContractAt("DCDomain", dcDomain.address, {
      client: { wallet: alice },
    });
    const dlAsBob = await viem.getContractAt("DCToken", dl.address, {
      client: { wallet: bob },
    });

    const sellerBefore = await dl.read.balanceOf([alice.account.address]);
    const treasuryBefore = await dl.read.balanceOf([treasury.account.address]);

    await waitFor(publicClient, await dcDomainAsAlice.write.approve([dcDomainMarket.address, tokenId]));
    await waitFor(publicClient, await marketAsAlice.write.list([tokenId, price]));

    assert.equal(await dcDomainMarket.read.activeListingCount(), 1n);
    const publicListings = await dcDomainMarket.read.getPublicListings([0n, 10n]);
    assert.equal(publicListings.length, 1);
    assert.equal(publicListings[0].tokenId, tokenId);
    assert.equal(publicListings[0].buyer, zeroAddress);

    await waitFor(publicClient, await dlAsBob.write.approve([dcDomainMarket.address, price]));
    await waitFor(publicClient, await marketAsBob.write.buy([tokenId]));

    const fee = price / 100n;
    assert.equal(getAddress(await dcDomain.read.ownerOf([tokenId])), getAddress(bob.account.address));
    assert.equal(getAddress(await dcDomain.read.resolve(["pub123"])), getAddress(bob.account.address));
    assert.equal(await dcDomainMarket.read.activeListingCount(), 0n);
    assert.equal(
      await dl.read.balanceOf([alice.account.address]),
      sellerBefore + price - fee,
    );
    assert.equal(
      await dl.read.balanceOf([treasury.account.address]),
      treasuryBefore + fee,
    );
  });

  it("supports p2p listings and blocks non-designated buyers", async function () {
    const fixture = await deployDomainFixture();
    const { viem, publicClient, alice, bob, carol, dl, dcDomain, dcDomainMarket } = fixture;

    const tokenId = await fixture.registerDomain(alice, "p2p123");
    const price = 77n * ONE;

    const dcDomainAsAlice = await viem.getContractAt("DCDomain", dcDomain.address, {
      client: { wallet: alice },
    });
    const marketAsAlice = await viem.getContractAt("DCDomainMarket", dcDomainMarket.address, {
      client: { wallet: alice },
    });
    const marketAsBob = await viem.getContractAt("DCDomainMarket", dcDomainMarket.address, {
      client: { wallet: bob },
    });
    const marketAsCarol = await viem.getContractAt("DCDomainMarket", dcDomainMarket.address, {
      client: { wallet: carol },
    });
    const dlAsBob = await viem.getContractAt("DCToken", dl.address, {
      client: { wallet: bob },
    });

    await waitFor(publicClient, await dcDomainAsAlice.write.approve([dcDomainMarket.address, tokenId]));
    await waitFor(
      publicClient,
      await marketAsAlice.write.listP2P([tokenId, price, bob.account.address]),
    );

    const p2pListings = await dcDomainMarket.read.getP2PListingsForBuyer([bob.account.address]);
    assert.equal(p2pListings.length, 1);
    assert.equal(p2pListings[0].tokenId, tokenId);

    await assert.rejects(
      marketAsCarol.write.buy([tokenId]),
      /not designated buyer/,
    );

    await waitFor(publicClient, await dlAsBob.write.approve([dcDomainMarket.address, price]));
    await waitFor(publicClient, await marketAsBob.write.buy([tokenId]));

    assert.equal(getAddress(await dcDomain.read.ownerOf([tokenId])), getAddress(bob.account.address));
    assert.equal(getAddress(await dcDomain.read.resolve(["p2p123"])), getAddress(bob.account.address));
  });

  it("supports listing pagination, update, and delist flows in DCDomainMarket", async function () {
    const fixture = await deployDomainFixture();
    const { viem, publicClient, alice, bob, dcDomain, dcDomainMarket } = fixture;

    const token1 = await fixture.registerDomain(alice, "mkta11");
    const token2 = await fixture.registerDomain(alice, "mkta22");
    const token3 = await fixture.registerDomain(alice, "mkta33");

    const dcDomainAsAlice = await viem.getContractAt("DCDomain", dcDomain.address, {
      client: { wallet: alice },
    });
    const marketAsAlice = await viem.getContractAt("DCDomainMarket", dcDomainMarket.address, {
      client: { wallet: alice },
    });

    for (const tokenId of [token1, token2, token3]) {
      await waitFor(publicClient, await dcDomainAsAlice.write.approve([dcDomainMarket.address, tokenId]));
    }

    await waitFor(publicClient, await marketAsAlice.write.list([token1, 10n * ONE]));
    await waitFor(publicClient, await marketAsAlice.write.list([token2, 20n * ONE]));
    await waitFor(publicClient, await marketAsAlice.write.listP2P([token3, 30n * ONE, bob.account.address]));

    assert.equal(await dcDomainMarket.read.activeListingCount(), 3n);
    assert.equal(await dcDomainMarket.read.activeTokenIdAt([0n]), token1);

    const pagedIds = await dcDomainMarket.read.activeTokenIds([1n, 2n]);
    assert.deepEqual(pagedIds, [token2, token3]);

    const activeListings = await dcDomainMarket.read.getActiveListings([0n, 10n]);
    assert.equal(activeListings.length, 3);
    assert.equal(getAddress(activeListings[2].buyer), getAddress(bob.account.address));

    await waitFor(publicClient, await marketAsAlice.write.updateListing([token2, 25n * ONE]));
    const updatedListing = await dcDomainMarket.read.listings([token2]);
    assert.equal(updatedListing[1], 25n * ONE);

    const publicListings = await dcDomainMarket.read.getPublicListings([0n, 10n]);
    assert.equal(publicListings.length, 2);
    const [publicPage, publicNextCursor, publicHasMore] = await dcDomainMarket.read.getPublicListingsPage([0n, 1n]);
    assert.equal(publicPage.length, 1);
    assert.equal(publicPage[0].tokenId, token1);
    assert.equal(publicNextCursor, 1n);
    assert.equal(publicHasMore, true);

    const [p2pPage, p2pNextCursor, p2pHasMore] = await dcDomainMarket.read.getP2PListingsForBuyerPage([
      bob.account.address,
      0n,
      1000n,
    ]);
    assert.equal(p2pPage.length, 1);
    assert.equal(p2pPage[0].tokenId, token3);
    assert.equal(p2pNextCursor, 3n);
    assert.equal(p2pHasMore, false);

    await waitFor(publicClient, await marketAsAlice.write.delist([token1]));
    assert.equal(await dcDomainMarket.read.activeListingCount(), 2n);
    const remainingIds = await dcDomainMarket.read.activeTokenIds([0n, 10n]);
    assert.deepEqual(remainingIds, [token3, token2]);
  });

  it("rejects oversized or unsafe domain metadata fields", async function () {
    const fixture = await deployDomainFixture();
    const { viem, alice, dcDomain } = fixture;

    const tokenId = await fixture.registerDomain(alice, "meta11");
    const dcDomainAsAlice = await viem.getContractAt("DCDomain", dcDomain.address, {
      client: { wallet: alice },
    });

    await assert.rejects(
      dcDomainAsAlice.write.setDomainDescription([tokenId, "a".repeat(501)]),
      /too long/,
    );
    await assert.rejects(
      dcDomainAsAlice.write.setDomainBackgroundUri([tokenId, "ipfs://bad\\slash"]),
      /unsafe char/,
    );
  });

  it("creates domain-tagged deals through DCDomainSwap and reports leaderboard entries", async function () {
    const fixture = await deployDomainFixture();
    const { viem, publicClient, bob, ausd, usdt, dcDomainRank, dcDomainSwap } = fixture;

    await fixture.registerDomain(fixture.alice, "swp123");

    const swapAsBob = await viem.getContractAt("DCDomainSwap", dcDomainSwap.address, {
      client: { wallet: bob },
    });

    const hash = await swapAsBob.write.createDeal([
      "swp123",
      ausd.address,
      10n * ONE,
      usdt.address,
      20n * ONE,
      "",
      "",
      zeroAddress,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const events = await publicClient.getContractEvents({
      address: dcDomainSwap.address,
      abi: dcDomainSwap.abi,
      eventName: "DealCreated",
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
      strict: true,
    });

    assert.equal(events.length, 1);
    const dealAddress = events[0].args.deal;
    const deal = await viem.getContractAt("Deal", dealAddress);

    assert.equal(getAddress(await deal.read.a()), getAddress(bob.account.address));
    assert.equal(await deal.read.isDomainDeal(), true);
    assert.equal(await deal.read.domainName(), "swp123");
    assert.equal(await dcDomainRank.read.domainDealCount(["swp123"]), 1n);
    assert.equal(await dcDomainRank.read.globalDomainCount(), 1n);
  });

  it("tracks domain leaderboard scores, settlement, and global leaderboard ordering", async function () {
    const fixture = await deployDomainFixture();
    const { viem, publicClient, alice, bob, dl, dcDomainRank, dcDomainSwap, ausd, usdt } = fixture;
    const testClient = await viem.getTestClient();

    await fixture.registerDomain(alice, "rank11");
    await fixture.registerDomain(alice, "rank22");

    const rankAsAlicePolicy = await viem.getContractAt("DCDomainRank", dcDomainRank.address, {
      client: { wallet: alice },
    });
    const AD_FEE_FIXED = 2;
    const fixedHourly = 600n * ONE;
    await waitFor(
      publicClient,
      await rankAsAlicePolicy.write.setDomainAdFeePolicy(["rank11", AD_FEE_FIXED, 0n, fixedHourly]),
    );
    await waitFor(
      publicClient,
      await rankAsAlicePolicy.write.setDomainAdFeePolicy(["rank22", AD_FEE_FIXED, 0n, fixedHourly]),
    );

    const swapAsBob = await viem.getContractAt("DCDomainSwap", dcDomainSwap.address, {
      client: { wallet: bob },
    });
    const rankAsBob = await viem.getContractAt("DCDomainRank", dcDomainRank.address, {
      client: { wallet: bob },
    });
    const dlAsBob = await viem.getContractAt("DCToken", dl.address, {
      client: { wallet: bob },
    });

    const createDeal = async (domainName: string, aAmt: bigint, bAmt: bigint) => {
      const hash = await swapAsBob.write.createDeal([
        domainName,
        ausd.address,
        aAmt,
        usdt.address,
        bAmt,
        "",
        "",
        zeroAddress,
      ]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const events = await publicClient.getContractEvents({
        address: dcDomainSwap.address,
        abi: dcDomainSwap.abi,
        eventName: "DealCreated",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
        strict: true,
      });
      return events[0].args.deal;
    };

    const deal1 = await createDeal("rank11", 11n * ONE, 22n * ONE);
    const deal2 = await createDeal("rank11", 12n * ONE, 24n * ONE);
    await createDeal("rank22", 13n * ONE, 26n * ONE);

    assert.equal(await dcDomainRank.read.domainDealCount(["rank11"]), 2n);
    assert.equal(await dcDomainRank.read.domainDealCount(["rank22"]), 1n);

    const [globalDomains, globalCounts] = await dcDomainRank.read.getGlobalLeaderboard([10n]);
    assert.deepEqual(globalDomains, ["rank11", "rank22"]);
    assert.deepEqual(globalCounts, [2n, 1n]);

    const depositAmount = 1000n * ONE;
    await waitFor(publicClient, await dlAsBob.write.approve([dcDomainRank.address, depositAmount]));
    await assert.rejects(
      rankAsBob.write.deposit(["rank11", alice.account.address, depositAmount]),
      /deal not reported/,
    );
    await waitFor(publicClient, await rankAsBob.write.deposit(["rank11", deal1, depositAmount]));

    const initialLeaderboard = await dcDomainRank.read.getLeaderboard(["rank11", 10n]);
    assert.equal(initialLeaderboard.length, 2);
    assert.equal(getAddress(initialLeaderboard[0].deal), getAddress(deal1));
    assert.equal(getAddress(initialLeaderboard[1].deal), getAddress(deal2));
    assert.equal(initialLeaderboard[1].score, 0n);

    const blockBefore = await publicClient.getBlock();
    await testClient.setNextBlockTimestamp({ timestamp: blockBefore.timestamp + 3600n });
    await testClient.mine({ blocks: 1 });

    const settled = await rankAsBob.write.settle(["rank11", deal1, bob.account.address]);
    await waitFor(publicClient, settled);

    const statusAfter = await rankAsBob.read.myDealStatusOf([
      "rank11",
      deal1,
      bob.account.address,
    ]);
    assert.ok(statusAfter[0] < depositAmount);
    assert.ok(await dcDomainRank.read.depositPercent(["rank11", deal1, bob.account.address]) < 100n);
    assert.equal(await dcDomainRank.read.lastDepositAmount(["rank11", deal1, bob.account.address]), depositAmount);

    const rankedAfter = await dcDomainRank.read.getLeaderboard(["rank11", 10n]);
    assert.equal(getAddress(rankedAfter[0].deal), getAddress(deal1));
    assert.ok(rankedAfter[0].score > 0n);

    await waitFor(publicClient, await rankAsBob.write.withdraw(["rank11", deal1]));
    const withdrawnStatus = await rankAsBob.read.myDealStatusOf([
      "rank11",
      deal1,
      bob.account.address,
    ]);
    assert.equal(withdrawnStatus[0], 0n);
    assert.equal(await dcDomainRank.read.depositPercent(["rank11", deal1, bob.account.address]), 0n);
  });

  it("rejects rank deposit until domain holder enables an ad fee policy", async function () {
    const fixture = await deployDomainFixture();
    const { viem, publicClient, alice, bob, dl, dcDomainRank, dcDomainSwap, ausd, usdt } = fixture;

    await fixture.registerDomain(alice, "pol000");

    const swapAsBob = await viem.getContractAt("DCDomainSwap", dcDomainSwap.address, {
      client: { wallet: bob },
    });
    const createHash = await swapAsBob.write.createDeal([
      "pol000",
      ausd.address,
      1n * ONE,
      usdt.address,
      2n * ONE,
      "",
      "",
      zeroAddress,
    ]);
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
    const createEvents = await publicClient.getContractEvents({
      address: dcDomainSwap.address,
      abi: dcDomainSwap.abi,
      eventName: "DealCreated",
      fromBlock: createReceipt.blockNumber,
      toBlock: createReceipt.blockNumber,
      strict: true,
    });
    const dealAddr = createEvents[0].args.deal as Address;

    const rankAsBob = await viem.getContractAt("DCDomainRank", dcDomainRank.address, {
      client: { wallet: bob },
    });
    const dlAsBob = await viem.getContractAt("DCToken", dl.address, { client: { wallet: bob } });
    await waitFor(publicClient, await dlAsBob.write.approve([dcDomainRank.address, 2000n * ONE]));
    await assert.rejects(
      rankAsBob.write.deposit(["pol000", dealAddr, 1000n * ONE]),
      /ad fees disabled/,
    );

    const rankAsAlice = await viem.getContractAt("DCDomainRank", dcDomainRank.address, {
      client: { wallet: alice },
    });
    await waitFor(
      publicClient,
      await rankAsAlice.write.setDomainAdFeePolicy(["pol000", 2, 0n, 500n * ONE]),
    );
    await waitFor(publicClient, await rankAsBob.write.deposit(["pol000", dealAddr, 1000n * ONE]));
  });

  it("applies proportional ad fee as a fraction of balance per hour", async function () {
    const fixture = await deployDomainFixture();
    const { viem, publicClient, alice, bob, dl, dcDomainRank, dcDomainSwap, ausd, usdt } = fixture;
    const testClient = await viem.getTestClient();

    await fixture.registerDomain(alice, "prop01");

    const rankAsAlice = await viem.getContractAt("DCDomainRank", dcDomainRank.address, {
      client: { wallet: alice },
    });
    await waitFor(
      publicClient,
      await rankAsAlice.write.setDomainAdFeePolicy(["prop01", 1, 100n, 0n]),
    );
    const policy = await dcDomainRank.read.getDomainAdFeePolicy(["prop01"]);
    assert.equal(Number(policy[0]), 1, "mode proportional");
    assert.equal(policy[1], 100n);
    assert.equal(policy[2], 0n);

    const swapAsBob = await viem.getContractAt("DCDomainSwap", dcDomainSwap.address, {
      client: { wallet: bob },
    });
    const createHash = await swapAsBob.write.createDeal([
      "prop01",
      ausd.address,
      1n * ONE,
      usdt.address,
      2n * ONE,
      "",
      "",
      zeroAddress,
    ]);
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
    const createEvents = await publicClient.getContractEvents({
      address: dcDomainSwap.address,
      abi: dcDomainSwap.abi,
      eventName: "DealCreated",
      fromBlock: createReceipt.blockNumber,
      toBlock: createReceipt.blockNumber,
      strict: true,
    });
    const dealAddr = createEvents[0].args.deal as Address;

    const rankAsBob = await viem.getContractAt("DCDomainRank", dcDomainRank.address, {
      client: { wallet: bob },
    });
    const dlAsBob = await viem.getContractAt("DCToken", dl.address, { client: { wallet: bob } });
    const depositAmount = 10_000n * ONE;
    await waitFor(publicClient, await dlAsBob.write.approve([dcDomainRank.address, depositAmount]));
    await waitFor(publicClient, await rankAsBob.write.deposit(["prop01", dealAddr, depositAmount]));

    const stRightAfter = await rankAsBob.read.myDealStatusOf([
      "prop01",
      dealAddr,
      bob.account.address,
    ]);
    assert.equal(stRightAfter[0], depositAmount, "deposit should be credited for this deal");

    const blockBefore = await publicClient.getBlock();
    // One billing hour for proportional: H = floor((elapsed + 3599) / 3600) must be 1 → elapsed <= 3600
    await testClient.setNextBlockTimestamp({ timestamp: blockBefore.timestamp + 3599n });
    await testClient.mine({ blocks: 1 });

    await waitFor(publicClient, await rankAsBob.write.settle(["prop01", dealAddr, bob.account.address]));
    const after = await rankAsBob.read.myDealStatusOf([
      "prop01",
      dealAddr,
      bob.account.address,
    ]);
    assert.equal(after[0], 9900n * ONE);
  });

  it("matches a visitor in DCDomainHall for token-to-token deals and settles end-to-end", async function () {
    const fixture = await deployDomainFixture();
    const {
      viem,
      publicClient,
      owner,
      alice,
      bob,
      carol,
      ausd,
      usdt,
      dcDomainRank,
      dcDomainHall,
      factory,
    } = fixture;

    await fixture.registerDomain(alice, "hall11");

    const rankAsCarol = await viem.getContractAt("DCDomainRank", dcDomainRank.address, {
      client: { wallet: carol },
    });
    const hallAsBob = await viem.getContractAt("DCDomainHall", dcDomainHall.address, {
      client: { wallet: bob },
    });
    const hallAsCarol = await viem.getContractAt("DCDomainHall", dcDomainHall.address, {
      client: { wallet: carol },
    });

    await waitFor(publicClient, await rankAsCarol.write.enterDomain(["hall11"]));

    const createHash = await hallAsBob.write.createTteHallDeal([
      "hall11",
      ausd.address,
      10n * ONE,
      usdt.address,
      20n * ONE,
      "",
      "",
      false,
    ]);
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
    const createEvents = await publicClient.getContractEvents({
      address: dcDomainHall.address,
      abi: dcDomainHall.abi,
      eventName: "HallDealCreatedDeferred",
      fromBlock: createReceipt.blockNumber,
      toBlock: createReceipt.blockNumber,
      strict: true,
    });

    assert.equal(createEvents.length, 1);
    const dealAddress = createEvents[0].args.deal;
    const dealAsCarolBeforePick = await viem.getContractAt("Deal", dealAddress, {
      client: { wallet: carol },
    });

    await assert.rejects(dealAsCarolBeforePick.write.join([0n, false]), /reverted/);

    await waitFor(
      publicClient,
      await hallAsCarol.write.postMessageOnDeal(["hall11", dealAddress, "pick me"]),
    );
    await waitFor(
      publicClient,
      await hallAsBob.write.postMessageOnDeal(["hall11", dealAddress, "ok"]),
    );

    assert.equal(await dcDomainHall.read.messagesCountOnDeal(["hall11", dealAddress]), 2n);
    const [contents, , senders] = await dcDomainHall.read.getMessagesOnDeal([
      "hall11",
      dealAddress,
      0n,
      10n,
    ]);
    assert.deepEqual(contents, ["pick me", "ok"]);
    assert.equal(getAddress(senders[0]), getAddress(carol.account.address));
    assert.equal(getAddress(senders[1]), getAddress(bob.account.address));

    await waitFor(
      publicClient,
      await hallAsBob.write.confirmHallDealCounterparty(["hall11", dealAddress, carol.account.address]),
    );

    const deal = await viem.getContractAt("Deal", dealAddress);
    assert.equal(await deal.read.isDomainDeal(), true);
    assert.equal(await deal.read.domainName(), "hall11");
    assert.equal(await deal.read.title(), "");
    assert.equal(getAddress(await deal.read.expectedB()), getAddress(carol.account.address));

    const dealAsOwner = await viem.getContractAt("Deal", dealAddress, {
      client: { wallet: owner },
    });
    await assert.rejects(dealAsOwner.write.join([0n, false]), /reverted/);

    const dealAsBob = await viem.getContractAt("Deal", dealAddress, {
      client: { wallet: bob },
    });
    const dealAsCarol = await viem.getContractAt("Deal", dealAddress, {
      client: { wallet: carol },
    });
    const ausdAsBob = await viem.getContractAt("DCToken", ausd.address, {
      client: { wallet: bob },
    });
    const usdtAsCarol = await viem.getContractAt("DCToken", usdt.address, {
      client: { wallet: carol },
    });

    await waitFor(publicClient, await ausdAsBob.write.approve([dealAddress, 10n * ONE]));
    await waitFor(publicClient, await usdtAsCarol.write.approve([dealAddress, 20n * ONE]));
    await waitFor(publicClient, await dealAsCarol.write.join([0n, false]));
    await waitFor(publicClient, await dealAsBob.write.pay());
    await waitFor(publicClient, await dealAsCarol.write.pay());
    await waitFor(publicClient, await dealAsBob.write.setMyVote([ACCEPT]));
    await waitFor(publicClient, await dealAsCarol.write.setMyVote([ACCEPT]));

    assert.equal(await deal.read.status(), 3);

    const factoryEvents = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "DealTemplateTagged",
      fromBlock: createReceipt.blockNumber,
      toBlock: await publicClient.getBlockNumber(),
      strict: true,
    });
    assert.ok(factoryEvents.some((event: (typeof factoryEvents)[number]) => getAddress(event.args.deal) === getAddress(dealAddress)));
  });

  it("supports template23 deferred selection and merchant-visitor message threads in DCDomainHall", async function () {
    const fixture = await deployDomainFixture();
    const {
      viem,
      publicClient,
      alice,
      bob,
      carol,
      ausd,
      dcDomainRank,
      dcDomainHall,
    } = fixture;

    await fixture.registerDomain(alice, "hall23");

    const rankAsCarol = await viem.getContractAt("DCDomainRank", dcDomainRank.address, {
      client: { wallet: carol },
    });
    const hallAsBob = await viem.getContractAt("DCDomainHall", dcDomainHall.address, {
      client: { wallet: bob },
    });
    const hallAsCarol = await viem.getContractAt("DCDomainHall", dcDomainHall.address, {
      client: { wallet: carol },
    });

    await waitFor(publicClient, await rankAsCarol.write.enterDomain(["hall23"]));

    const createHash = await hallAsBob.write.createHallDealTemplate23([
      "hall23",
      2,
      ausd.address,
      5n * ONE,
      zeroAddress,
      0n,
      zeroAddress,
      0n,
      zeroAddress,
      1n * ONE,
      0n,
      3600n,
      DEFAULT_TIME_START,
      "",
      "",
      false,
    ]);
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
    const createEvents = await publicClient.getContractEvents({
      address: dcDomainHall.address,
      abi: dcDomainHall.abi,
      eventName: "HallDealCreatedDeferred",
      fromBlock: createReceipt.blockNumber,
      toBlock: createReceipt.blockNumber,
      strict: true,
    });

    assert.equal(createEvents.length, 1);
    const dealAddress = createEvents[0].args.deal;
    const dealAsCarolBeforePick = await viem.getContractAt("Deal", dealAddress, {
      client: { wallet: carol },
    });

    await assert.rejects(dealAsCarolBeforePick.write.join([0n, false]), /reverted/);

    await waitFor(
      publicClient,
      await hallAsCarol.write.postMessage(["hall23", bob.account.address, carol.account.address, "hello merchant"]),
    );
    await waitFor(
      publicClient,
      await hallAsBob.write.postMessage(["hall23", bob.account.address, carol.account.address, "ack"]),
    );
    await waitFor(
      publicClient,
      await hallAsBob.write.postMessage(["hall23", bob.account.address, carol.account.address, "a".repeat(1500)]),
    );
    await assert.rejects(
      hallAsCarol.write.postMessage(["hall23", bob.account.address, carol.account.address, "a".repeat(1501)]),
      /too long/,
    );
    await assert.rejects(
      hallAsBob.write.signalPickUser(["hall23", carol.account.address, "a".repeat(1501)]),
      /note too long/,
    );

    assert.equal(
      await dcDomainHall.read.messagesCount(["hall23", bob.account.address, carol.account.address]),
      3n,
    );
    const [contents, , senders] = await dcDomainHall.read.getMessages([
      "hall23",
      bob.account.address,
      carol.account.address,
      0n,
      10n,
    ]);
    assert.deepEqual(contents, ["hello merchant", "ack", "a".repeat(1500)]);
    assert.equal(getAddress(senders[0]), getAddress(carol.account.address));
    assert.equal(getAddress(senders[1]), getAddress(bob.account.address));
    assert.equal(getAddress(senders[2]), getAddress(bob.account.address));

    await waitFor(
      publicClient,
      await hallAsBob.write.signalPickUser(["hall23", carol.account.address, "you are selected"]),
    );
    await waitFor(
      publicClient,
      await hallAsBob.write.confirmHallDealCounterparty(["hall23", dealAddress, carol.account.address]),
    );

    const deal = await viem.getContractAt("Deal", dealAddress);
    assert.equal(getAddress(await deal.read.expectedB()), getAddress(carol.account.address));
    assert.equal(await deal.read.title(), "");

    await assert.rejects(
      hallAsCarol.write.confirmHallDealCounterparty(["hall23", dealAddress, carol.account.address]),
      /not merchant/,
    );
  });

  it("rejects non-visitors and blacklisted users in DCDomainHall flows", async function () {
    const fixture = await deployDomainFixture();
    const {
      viem,
      publicClient,
      owner,
      alice,
      bob,
      carol,
      ausd,
      usdt,
      dcDomain,
      dcDomainRank,
      dcDomainHall,
    } = fixture;

    await fixture.registerDomain(alice, "hallbl");

    const rankAsCarol = await viem.getContractAt("DCDomainRank", dcDomainRank.address, {
      client: { wallet: carol },
    });
    const rankAsAlice = await viem.getContractAt("DCDomainRank", dcDomainRank.address, {
      client: { wallet: alice },
    });
    const hallAsBob = await viem.getContractAt("DCDomainHall", dcDomainHall.address, {
      client: { wallet: bob },
    });
    const hallAsCarol = await viem.getContractAt("DCDomainHall", dcDomainHall.address, {
      client: { wallet: carol },
    });
    const hallAsOwner = await viem.getContractAt("DCDomainHall", dcDomainHall.address, {
      client: { wallet: owner },
    });

    await waitFor(publicClient, await rankAsCarol.write.enterDomain(["hallbl"]));

    const createHash = await hallAsBob.write.createTteHallDeal([
      "hallbl",
      ausd.address,
      10n * ONE,
      usdt.address,
      20n * ONE,
      "blocked title",
      "",
      false,
    ]);
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
    const createEvents = await publicClient.getContractEvents({
      address: dcDomainHall.address,
      abi: dcDomainHall.abi,
      eventName: "HallDealCreatedDeferred",
      fromBlock: createReceipt.blockNumber,
      toBlock: createReceipt.blockNumber,
      strict: true,
    });
    const dealAddress = createEvents[0].args.deal;

    await assert.rejects(
      hallAsOwner.write.postMessageOnDeal(["hallbl", dealAddress, "not allowed"]),
      /not visitor/,
    );

    await waitFor(publicClient, await rankAsAlice.write.setBlacklisted(["hallbl", carol.account.address, true]));

    assert.equal(await rankAsAlice.read.blacklistedCount(["hallbl"]), 1n);
    const blAfterAdd = await rankAsAlice.read.blacklistedAddresses(["hallbl"]);
    assert.equal(blAfterAdd.length, 1);
    assert.equal(getAddress(blAfterAdd[0]!), getAddress(carol.account.address));

    await assert.rejects(
      hallAsCarol.write.postMessageOnDeal(["hallbl", dealAddress, "blocked"]),
      /blacklisted/,
    );
    await assert.rejects(
      hallAsBob.write.confirmHallDealCounterparty(["hallbl", dealAddress, carol.account.address]),
      /picked bl/,
    );

    await waitFor(publicClient, await rankAsAlice.write.setBlacklisted(["hallbl", carol.account.address, false]));
    assert.equal(await rankAsAlice.read.blacklistedCount(["hallbl"]), 0n);
    assert.deepEqual(await rankAsAlice.read.blacklistedAddresses(["hallbl"]), []);

    assert.equal(getAddress(await dcDomain.read.resolve(["hallbl"])), getAddress(alice.account.address));
  });

  it("blacklistedAddresses stays in sync when multiple addresses are banned and one is removed", async function () {
    const fixture = await deployDomainFixture();
    const { viem, publicClient, alice, bob, carol, dcDomainRank } = fixture;

    await fixture.registerDomain(alice, "blist2");

    const rankAsAlice = await viem.getContractAt("DCDomainRank", dcDomainRank.address, {
      client: { wallet: alice },
    });

    await waitFor(
      publicClient,
      await rankAsAlice.write.setBlacklisted(["blist2", bob.account.address, true]),
    );
    await waitFor(
      publicClient,
      await rankAsAlice.write.setBlacklisted(["blist2", carol.account.address, true]),
    );
    assert.equal(await rankAsAlice.read.blacklistedCount(["blist2"]), 2n);
    const two = (await rankAsAlice.read.blacklistedAddresses(["blist2"])) as `0x${string}`[];
    assert.equal(two.length, 2);
    const set2 = new Set(two.map((a) => getAddress(a)));
    assert.ok(set2.has(getAddress(bob.account.address)));
    assert.ok(set2.has(getAddress(carol.account.address)));

    await waitFor(
      publicClient,
      await rankAsAlice.write.setBlacklisted(["blist2", bob.account.address, false]),
    );
    assert.equal(await rankAsAlice.read.blacklistedCount(["blist2"]), 1n);
    const one = await rankAsAlice.read.blacklistedAddresses(["blist2"]);
    assert.equal(one.length, 1);
    assert.equal(getAddress(one[0]!), getAddress(carol.account.address));
    assert.equal(await rankAsAlice.read.isBlacklisted(["blist2", bob.account.address]), false);
    assert.equal(await rankAsAlice.read.isBlacklisted(["blist2", carol.account.address]), true);
  });

  it("rejects domain owner blacklisting their own address", async function () {
    const fixture = await deployDomainFixture();
    const { viem, alice, dcDomainRank } = fixture;
    await fixture.registerDomain(alice, "noself");
    const rankAsAlice = await viem.getContractAt("DCDomainRank", dcDomainRank.address, {
      client: { wallet: alice },
    });
    await assert.rejects(
      rankAsAlice.write.setBlacklisted(["noself", alice.account.address, true]),
      /cannot blacklist self/,
    );
  });

  it("creates exact-address hall deals with pickUserAndCreateDeal and blocks other joiners", async function () {
    const fixture = await deployDomainFixture();
    const {
      viem,
      publicClient,
      owner,
      alice,
      bob,
      carol,
      ausd,
      usdt,
      dcDomainRank,
      dcDomainHall,
    } = fixture;

    await fixture.registerDomain(alice, "pick11");

    const rankAsCarol = await viem.getContractAt("DCDomainRank", dcDomainRank.address, {
      client: { wallet: carol },
    });
    const hallAsBob = await viem.getContractAt("DCDomainHall", dcDomainHall.address, {
      client: { wallet: bob },
    });

    await waitFor(publicClient, await rankAsCarol.write.enterDomain(["pick11"]));

    const createHash = await hallAsBob.write.pickUserAndCreateDeal([
      "pick11",
      carol.account.address,
      ausd.address,
      3n * ONE,
      usdt.address,
      6n * ONE,
      "picked user title",
      "",
      false,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
    const events = await publicClient.getContractEvents({
      address: dcDomainHall.address,
      abi: dcDomainHall.abi,
      eventName: "HallDealWithPickedUser",
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
      strict: true,
    });

    assert.equal(events.length, 1);
    const dealAddress = events[0].args.deal;
    const deal = await viem.getContractAt("Deal", dealAddress);
    assert.equal(getAddress(await deal.read.expectedB()), getAddress(carol.account.address));
    assert.equal(await deal.read.isDomainDeal(), true);
    assert.equal(await deal.read.title(), "picked user title");
    assert.equal(await dcDomainRank.read.domainDealCount(["pick11"]), 1n);

    const dealAsOwner = await viem.getContractAt("Deal", dealAddress, {
      client: { wallet: owner },
    });
    await assert.rejects(dealAsOwner.write.join([0n, false]), /reverted/);
  });

  it("rejects bad TTE swap params and allows zero-margin ETE in DCDomainHall", async function () {
    const fixture = await deployDomainFixture();
    const { viem, publicClient, alice, bob, ausd, usdt, dcDomainHall } = fixture;

    await fixture.registerDomain(alice, "bad123");

    const hallAsBob = await viem.getContractAt("DCDomainHall", dcDomainHall.address, {
      client: { wallet: bob },
    });

    await assert.rejects(
      hallAsBob.write.createHallDealTemplate23([
        "bad123",
        2,
        ausd.address,
        1n * ONE,
        zeroAddress,
        0n,
        usdt.address,
        2n * ONE,
        zeroAddress,
        0n,
        0n,
        3600n,
        DEFAULT_TIME_START,
        "bad tte",
        "",
        false,
      ]),
      /TTE swap/,
    );

    const createHash = await hallAsBob.write.createHallDealTemplate23([
      "bad123",
      3,
      zeroAddress,
      0n,
      zeroAddress,
      0n,
      zeroAddress,
      0n,
      zeroAddress,
      0n,
      0n,
      3600n,
      DEFAULT_TIME_START,
      "zero margin ete",
      "",
      false,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
    const events = await publicClient.getContractEvents({
      address: dcDomainHall.address,
      abi: dcDomainHall.abi,
      eventName: "HallDealCreatedDeferred",
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
      strict: true,
    });
    assert.equal(events.length, 1);
  });

  it("sells a domain nft through DealFactory.createDeal and settles ownership to the buyer", async function () {
    const fixture = await deployDomainFixture();
    const { viem, publicClient, alice, bob, ausd, dcDomain } = fixture;

    const tokenId = await fixture.registerDomain(alice, "nft123");
    const dealAddress = await createDealAndGetAddress(fixture, alice, {
      aSwapToken: zeroAddress,
      aSwapAmount: 0n,
      bSwapToken: ausd.address,
      bSwapAmount: 50n * ONE,
      aAssetNft: dcDomain.address,
      aAssetNftId: tokenId,
      joinMode: EXACT_JOIN,
      expectedB: bob.account.address,
      templateType: TEMPLATE_TOKEN_TO_NFT,
      title: "sell domain nft",
    });

    const dealAsAlice = await viem.getContractAt("Deal", dealAddress, {
      client: { wallet: alice },
    });
    const dealAsBob = await viem.getContractAt("Deal", dealAddress, {
      client: { wallet: bob },
    });
    const dcDomainAsAlice = await viem.getContractAt("DCDomain", dcDomain.address, {
      client: { wallet: alice },
    });
    const ausdAsBob = await viem.getContractAt("DCToken", ausd.address, {
      client: { wallet: bob },
    });

    await waitFor(publicClient, await dcDomainAsAlice.write.approve([dealAddress, tokenId]));
    await waitFor(publicClient, await ausdAsBob.write.approve([dealAddress, 50n * ONE]));

    await waitFor(publicClient, await dealAsBob.write.join([0n, false]));
    await waitFor(publicClient, await dealAsAlice.write.pay());
    await waitFor(publicClient, await dealAsBob.write.pay());
    await waitFor(publicClient, await dealAsAlice.write.setMyVote([ACCEPT]));
    await waitFor(publicClient, await dealAsBob.write.setMyVote([ACCEPT]));

    const deal = await viem.getContractAt("Deal", dealAddress);
    assert.equal(getAddress(await deal.read.aAssetNft()), getAddress(dcDomain.address));
    assert.equal(await deal.read.aAssetNftId(), tokenId);
    assert.equal(getAddress(await deal.read.expectedB()), getAddress(bob.account.address));
    assert.equal(await deal.read.isDomainDeal(), false);
    assert.equal(await deal.read.domainName(), "");
    assert.equal(await deal.read.status(), 3);
    assert.equal(getAddress(await dcDomain.read.ownerOf([tokenId])), getAddress(bob.account.address));
  });

  it("blocks direct factory calls from forging domain deals", async function () {
    const fixture = await deployDomainFixture();
    const { viem, alice, factory, ausd } = fixture;

    const factoryAsAlice = await viem.getContractAt("DealFactory", factory.address, {
      client: { wallet: alice },
    });

    await assert.rejects(
      factoryAsAlice.write.createDeal([
        {
          init: {
            aSwapToken: ausd.address,
            aSwapAmount: 1n * ONE,
            aMarginToken: zeroAddress,
            aMarginAmount: 0n,
            bSwapToken: zeroAddress,
            bSwapAmount: 0n,
            bMarginToken: zeroAddress,
            bMarginAmount: 1n,
            aAssetNft: zeroAddress,
            aAssetNftId: 0n,
            bAssetNft: zeroAddress,
            bAssetNftId: 0n,
            templateType: TEMPLATE_TOKEN_TO_EMPTY,
            joinMode: OPEN_JOIN,
            expectedB: zeroAddress,
            gateNftId: 0n,
            aNftId: 0n,
            title: "fake domain deal",
            description: "",
            timeoutSeconds: 3600n,
            replaceTimeoutSeconds: 0n,
            timeStart: DEFAULT_TIME_START,
            timeEnd: DEFAULT_TIME_END,
            isDomainDeal: true,
            domainName: "fake12",
            openTokenTokenFast: false,
          },
          trackCreator: false,
        },
      ]),
      /UseDomainEntry/,
    );
  });
});
