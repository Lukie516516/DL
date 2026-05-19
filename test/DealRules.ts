import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, zeroAddress } from "viem";

const ONE = 10n ** 18n;
const ACCEPT = 1;
const REJECT = 2;
const OPEN_JOIN = 0;
const EXACT_AND_NFT_JOIN = 3;
const TEMPLATE_TOKEN_TO_TOKEN = 0;
const TEMPLATE_TOKEN_TO_NFT = 1;
const TEMPLATE_TOKEN_TO_EMPTY = 2;
const TEMPLATE_EMPTY_TO_EMPTY = 3;
const TEMPLATE_NFT_TO_EMPTY = 4;

type Address = `0x${string}`;

async function deployFixture() {
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
  const bad = await viem.deployContract("DCToken", [
    "Bad Token",
    "BAD",
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
  const dealResultIndex = await viem.deployContract("DealResultIndex", [factory.address]);
  const dealPairManager = await viem.deployContract("DealPairManager", [factory.address]);
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

  const mintAmount = 10_000_000n * ONE;
  const minterRole = await dl.read.MINTER_ROLE();

  await waitFor(publicClient, await factory.write.setGlobal(["dlToken", dl.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["infoNft", infoNft.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["wrappedNative", wrappedNative.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["dealPairManager", dealPairManager.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["dealMessageHub", dealMessageHub.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["dealActivityIndex", dealActivityIndex.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["dealResultIndex", dealResultIndex.address]));
  await waitFor(publicClient, await factory.write.setGlobal(["dealImplementationRegistry", dealImplementationRegistry.address]));
  await waitFor(
    publicClient,
    await factory.write.setRecognizedTokens([ausd.address, usdt.address]),
  );
  await waitFor(
    publicClient,
    await factory.write.setTreasuryByAdmin([treasury.account.address]),
  );
  await waitFor(publicClient, await dl.write.grantRole([minterRole, factory.address]));

  for (const token of [dl, ausd, usdt, bad, wrappedNative]) {
    await waitFor(publicClient, await token.write.mint([owner.account.address, mintAmount]));
    await waitFor(publicClient, await token.write.mint([alice.account.address, mintAmount]));
    await waitFor(publicClient, await token.write.mint([bob.account.address, mintAmount]));
  }

  async function createAndInitPair(tokenAddress: Address, tokenContractName = "DCToken") {
    await waitFor(publicClient, await factory.write.createPair([tokenAddress, 3, 1000]));
    const pairAddress = await factory.read.pairForToken([tokenAddress]);
    const pair = await viem.getContractAt("DealSwapTemplate", pairAddress);
    const token = await viem.getContractAt(tokenContractName, tokenAddress);

    await waitFor(publicClient, await dl.write.transfer([pairAddress, 1_000_000n * ONE]));
    await waitFor(publicClient, await token.write.transfer([pairAddress, 1_000_000n * ONE]));
    await waitFor(publicClient, await factory.write.initPair([pairAddress, 0n]));

    return { pairAddress, pair };
  }

  async function mintInfoNft(wallet: typeof owner | typeof alice | typeof bob) {
    let pairAddress = await factory.read.pairForToken([ausd.address]);
    if (pairAddress === zeroAddress) {
      ({ pairAddress } = await createAndInitPair(ausd.address));
    }

    await waitFor(publicClient, await infoNft.write.setMintPriceU([pairAddress, ONE]));

    const dlAsUser = await viem.getContractAt("DCToken", dl.address, {
      client: { wallet },
    });
    const infoNftAsUser = await viem.getContractAt("DealInfoNFT", infoNft.address, {
      client: { wallet },
    });

    await waitFor(publicClient, await dlAsUser.write.approve([infoNft.address, 1_000_000n * ONE]));
    const nextIdBefore = await infoNft.read.nextId();
    await waitFor(publicClient, await infoNftAsUser.write.mintByBurn());
    return nextIdBefore;
  }

  return {
    viem,
    publicClient,
    owner,
    alice,
    bob,
    treasury,
    dl,
    ausd,
    usdt,
    bad,
    wrappedNative,
    factory,
    dealImpl,
    dealNoAssetImpl,
    dealAAssetNftImpl,
    dealBAssetNftImpl,
    dealAAssetNftOnlyImpl,
    dealBAssetNftOnlyImpl,
    dealOpenTTImpl,
    dealMessageHub,
    dealActivityIndex,
    dealResultIndex,
    infoNft,
    createAndInitPair,
    mintInfoNft,
  };
}

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

async function assertCloneUsesImplementation(
  publicClient: Awaited<
    ReturnType<
      Awaited<ReturnType<typeof network.connect<{ network: "hardhatMainnet" }>>>["viem"]["getPublicClient"]
    >
  >,
  cloneAddress: Address,
  implementation: Address,
) {
  const code = await publicClient.getCode({ address: cloneAddress });
  assert.ok(code?.toLowerCase().includes(implementation.slice(2).toLowerCase()));
}

async function enableCreditGraph(fixture: Awaited<ReturnType<typeof deployFixture>>) {
  const { viem, publicClient, owner, factory, infoNft } = fixture;
  const creditGraph = await viem.deployContract("DealCreditGraph", [infoNft.address]);
  await waitFor(publicClient, await factory.write.setGlobal(["creditGraph", creditGraph.address]));
  await waitFor(publicClient, await creditGraph.write.setRecorder([factory.address, true]));
  // Test-only seeding helper; production recorders should be constrained to Factory/authorized modules.
  await waitFor(publicClient, await creditGraph.write.setRecorder([owner.account.address, true]));
  return creditGraph;
}

async function createDealAndGetAddress(
  fixture: Awaited<ReturnType<typeof deployFixture>>,
  init: {
    aSwapToken: Address;
    aSwapAmount: bigint;
    aMarginToken?: Address;
    aMarginAmount?: bigint;
    bSwapToken: Address;
    bSwapAmount: bigint;
    bMarginToken?: Address;
    bMarginAmount?: bigint;
    aAssetNft?: Address;
    aAssetNftId?: bigint;
    bAssetNft?: Address;
    bAssetNftId?: bigint;
    templateType?: number;
    joinMode?: number;
    expectedB?: Address;
    gateNftId?: bigint;
    aNftId?: bigint;
    title?: string;
    description?: string;
    timeoutSeconds?: bigint;
    replaceTimeoutSeconds?: bigint;
    isDomainDeal?: boolean;
    domainName?: string;
    /** @default false */
    openTokenTokenFast?: boolean;
  },
) {
  const { viem, factory, publicClient, alice, infoNft } = fixture;
  const factoryAsAlice = await viem.getContractAt("DealFactory", factory.address, {
    client: { wallet: alice },
  });
  const hash = await factoryAsAlice.write.createDeal([
    {
      init: {
        aSwapToken: init.aSwapToken,
        aSwapAmount: init.aSwapAmount,
        aMarginToken: init.aMarginToken ?? zeroAddress,
        aMarginAmount: init.aMarginAmount ?? 0n,
        bSwapToken: init.bSwapToken,
        bSwapAmount: init.bSwapAmount,
        bMarginToken: init.bMarginToken ?? zeroAddress,
        bMarginAmount: init.bMarginAmount ?? 0n,
        aAssetNft:
          init.aAssetNft ??
          ((init.aAssetNftId ?? 0n) > 0n ? infoNft.address : zeroAddress),
        aAssetNftId: init.aAssetNftId ?? 0n,
        bAssetNft:
          init.bAssetNft ??
          ((init.bAssetNftId ?? 0n) > 0n ? infoNft.address : zeroAddress),
        bAssetNftId: init.bAssetNftId ?? 0n,
        templateType:
          init.templateType ??
          inferTemplateType(
            init.aSwapAmount,
            init.bSwapAmount,
            init.aAssetNftId ?? 0n,
            init.bAssetNftId ?? 0n,
          ),
        joinMode: init.joinMode ?? OPEN_JOIN,
        expectedB: init.expectedB ?? zeroAddress,
        gateNftId: init.gateNftId ?? 0n,
        aNftId: init.aNftId ?? 0n,
        title: init.title ?? "test",
        description: init.description ?? "",
        timeoutSeconds: init.timeoutSeconds ?? 3600n,
        replaceTimeoutSeconds: init.replaceTimeoutSeconds ?? (init.openTokenTokenFast ? 120n : 0n),
        isDomainDeal: init.isDomainDeal ?? false,
        domainName: init.domainName ?? "",
        openTokenTokenFast: init.openTokenTokenFast ?? false,
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

async function createOpenTTDealAndSettle(
  fixture: Awaited<ReturnType<typeof deployFixture>>,
  init: {
    aSwapToken: Address;
    aSwapAmount: bigint;
    bSwapToken: Address;
    bSwapAmount: bigint;
    joinMode?: number;
    expectedB?: Address;
  },
) {
  const { viem, publicClient, alice, bob, factory } = fixture;
  const dealAddress = await createDealAndGetAddress(fixture, {
    ...init,
    templateType: TEMPLATE_TOKEN_TO_TOKEN,
    openTokenTokenFast: true,
  });
  assert.equal(await factory.read.isDeal([dealAddress]), true);

  const dealAlice = await viem.getContractAt("DealOpenTokenToken", dealAddress, { client: { wallet: alice } });
  const dealBob = await viem.getContractAt("DealOpenTokenToken", dealAddress, { client: { wallet: bob } });

  if (init.aSwapToken !== zeroAddress) {
    const t = await viem.getContractAt("DCToken", init.aSwapToken, { client: { wallet: alice } });
    await waitFor(publicClient, await t.write.approve([dealAddress, init.aSwapAmount]));
  }
  if (init.bSwapToken !== zeroAddress) {
    const t = await viem.getContractAt("DCToken", init.bSwapToken, { client: { wallet: bob } });
    await waitFor(publicClient, await t.write.approve([dealAddress, init.bSwapAmount]));
  }

  const bobInfoId = await fixture.mintInfoNft(bob);

  await waitFor(publicClient, await dealAlice.write.pay([]));
  await waitFor(publicClient, await dealAlice.write.preAccept([]));
  await waitFor(publicClient, await dealBob.write.join([bobInfoId, false]));
  assert.equal(await dealAlice.read.bNftId(), bobInfoId);
  assert.equal(await dealAlice.read.bNftLocked(), true);
  await waitFor(publicClient, await dealBob.write.pay([]));

  assert.equal(Number(await dealAlice.read.status()), 2);
  await waitFor(publicClient, await dealBob.write.setMyVote([ACCEPT]));
  assert.equal(Number(await dealAlice.read.status()), 3);
}

async function completeOpenDeal(
  fixture: Awaited<ReturnType<typeof deployFixture>>,
  dealAddress: Address,
  approve: {
    alice?: Array<{
      token: Awaited<
        ReturnType<
          Awaited<ReturnType<typeof network.connect<{ network: "hardhatMainnet" }>>>["viem"]["getContractAt"]
        >
      >;
      amount: bigint;
    }>;
    aliceNftIds?: bigint[];
    bob?: Array<{
      token: Awaited<
        ReturnType<
          Awaited<ReturnType<typeof network.connect<{ network: "hardhatMainnet" }>>>["viem"]["getContractAt"]
        >
      >;
      amount: bigint;
    }>;
    bobNftIds?: bigint[];
  } = {},
) {
  const { viem, publicClient, alice, bob, infoNft } = fixture;
  const dealAlice = await viem.getContractAt("Deal", dealAddress, { client: { wallet: alice } });
  const dealBob = await viem.getContractAt("Deal", dealAddress, { client: { wallet: bob } });
  const infoNftAlice = await viem.getContractAt("DealInfoNFT", infoNft.address, {
    client: { wallet: alice },
  });
  const infoNftBob = await viem.getContractAt("DealInfoNFT", infoNft.address, {
    client: { wallet: bob },
  });

  for (const item of approve.alice ?? []) {
    const token = await viem.getContractAt("DCToken", item.token.address, {
      client: { wallet: alice },
    });
    await waitFor(publicClient, await token.write.approve([dealAddress, item.amount]));
  }
  for (const item of approve.bob ?? []) {
    const token = await viem.getContractAt("DCToken", item.token.address, {
      client: { wallet: bob },
    });
    await waitFor(publicClient, await token.write.approve([dealAddress, item.amount]));
  }
  for (const tokenId of approve.aliceNftIds ?? []) {
    await waitFor(publicClient, await infoNftAlice.write.approve([dealAddress, tokenId]));
  }
  for (const tokenId of approve.bobNftIds ?? []) {
    await waitFor(publicClient, await infoNftBob.write.approve([dealAddress, tokenId]));
  }

  await waitFor(publicClient, await dealBob.write.join([0n, false]));
  await waitFor(publicClient, await dealAlice.write.pay());
  try {
    await waitFor(publicClient, await dealBob.write.pay());
  } catch {
    // zero-amount side doesn't need to pay
  }
  await waitFor(publicClient, await dealAlice.write.setMyVote([ACCEPT]));
  await waitFor(publicClient, await dealBob.write.setMyVote([ACCEPT]));
}

function inferTemplateType(
  aSwapAmount: bigint,
  bSwapAmount: bigint,
  aAssetNftId: bigint,
  bAssetNftId: bigint,
) {
  if (aSwapAmount > 0n && bSwapAmount > 0n && aAssetNftId === 0n && bAssetNftId === 0n) {
    return TEMPLATE_TOKEN_TO_TOKEN;
  }
  if (aSwapAmount === 0n && bSwapAmount === 0n && aAssetNftId === 0n && bAssetNftId === 0n) {
    return TEMPLATE_EMPTY_TO_EMPTY;
  }
  if ((aSwapAmount > 0n || bSwapAmount > 0n) && (aAssetNftId > 0n || bAssetNftId > 0n)) {
    return TEMPLATE_TOKEN_TO_NFT;
  }
  if (aAssetNftId > 0n || bAssetNftId > 0n) {
    return TEMPLATE_NFT_TO_EMPTY;
  }
  return TEMPLATE_TOKEN_TO_EMPTY;
}

describe("Deal Rules", async function () {
  it("routes ordinary templates to split implementations", async function () {
    const fixture = await deployFixture();
    const {
      publicClient,
      ausd,
      dealNoAssetImpl,
      dealAAssetNftImpl,
      dealBAssetNftImpl,
      dealAAssetNftOnlyImpl,
      dealBAssetNftOnlyImpl,
      dealOpenTTImpl,
    } = fixture;
    await fixture.createAndInitPair(ausd.address);

    const tokenToToken = await createDealAndGetAddress(fixture, {
      aSwapToken: ausd.address,
      aSwapAmount: 10n * ONE,
      bSwapToken: ausd.address,
      bSwapAmount: 11n * ONE,
      templateType: TEMPLATE_TOKEN_TO_TOKEN,
    });
    await assertCloneUsesImplementation(publicClient, tokenToToken, dealNoAssetImpl.address);

    const tokenToEmpty = await createDealAndGetAddress(fixture, {
      aSwapToken: ausd.address,
      aSwapAmount: 10n * ONE,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
      templateType: TEMPLATE_TOKEN_TO_EMPTY,
    });
    await assertCloneUsesImplementation(publicClient, tokenToEmpty, dealNoAssetImpl.address);

    const emptyToEmpty = await createDealAndGetAddress(fixture, {
      aSwapToken: zeroAddress,
      aSwapAmount: 0n,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
      templateType: TEMPLATE_EMPTY_TO_EMPTY,
    });
    await assertCloneUsesImplementation(publicClient, emptyToEmpty, dealNoAssetImpl.address);

    const openFast = await createDealAndGetAddress(fixture, {
      aSwapToken: ausd.address,
      aSwapAmount: 10n * ONE,
      bSwapToken: ausd.address,
      bSwapAmount: 11n * ONE,
      templateType: TEMPLATE_TOKEN_TO_TOKEN,
      openTokenTokenFast: true,
    });
    await assertCloneUsesImplementation(publicClient, openFast, dealOpenTTImpl.address);

    const nftId = await fixture.mintInfoNft(fixture.bob);
    const tokenToNft = await createDealAndGetAddress(fixture, {
      aSwapToken: ausd.address,
      aSwapAmount: 10n * ONE,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
      bAssetNftId: nftId,
      templateType: TEMPLATE_TOKEN_TO_NFT,
    });
    await assertCloneUsesImplementation(publicClient, tokenToNft, dealBAssetNftImpl.address);

    const nftToEmptyId = await fixture.mintInfoNft(fixture.alice);
    const nftToEmpty = await createDealAndGetAddress(fixture, {
      aSwapToken: zeroAddress,
      aSwapAmount: 0n,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
      aAssetNftId: nftToEmptyId,
      templateType: TEMPLATE_NFT_TO_EMPTY,
    });
    await assertCloneUsesImplementation(publicClient, nftToEmpty, dealAAssetNftOnlyImpl.address);

    const aAssetTokenToNftId = await fixture.mintInfoNft(fixture.alice);
    const aAssetTokenToNft = await createDealAndGetAddress(fixture, {
      aSwapToken: zeroAddress,
      aSwapAmount: 0n,
      bSwapToken: ausd.address,
      bSwapAmount: 10n * ONE,
      aAssetNftId: aAssetTokenToNftId,
      templateType: TEMPLATE_TOKEN_TO_NFT,
    });
    await assertCloneUsesImplementation(publicClient, aAssetTokenToNft, dealAAssetNftImpl.address);

    const bAssetNftToEmptyId = await fixture.mintInfoNft(fixture.bob);
    const bAssetNftToEmpty = await createDealAndGetAddress(fixture, {
      aSwapToken: zeroAddress,
      aSwapAmount: 0n,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
      bAssetNftId: bAssetNftToEmptyId,
      templateType: TEMPLATE_NFT_TO_EMPTY,
    });
    await assertCloneUsesImplementation(publicClient, bAssetNftToEmpty, dealBAssetNftOnlyImpl.address);
  });

  it("records completed deal credit from U-denominated fees and refreshes top5 snapshots", async function () {
    const fixture = await deployFixture();
    const { viem, publicClient, alice, bob, ausd, usdt } = fixture;
    const creditGraph = await enableCreditGraph(fixture);
    await fixture.createAndInitPair(ausd.address);
    await fixture.createAndInitPair(usdt.address);

    const aliceInfoId = await fixture.mintInfoNft(alice);
    const bobInfoId = await fixture.mintInfoNft(bob);

    const amount = 10_000n * ONE;
    const expectedBaseCredit = ((amount * 3n) / 1000n) * 2n;

    const dealAddress = await createDealAndGetAddress(fixture, {
      aSwapToken: ausd.address,
      aSwapAmount: amount,
      bSwapToken: usdt.address,
      bSwapAmount: amount,
      aNftId: aliceInfoId,
    });

    const dealAlice = await viem.getContractAt("Deal", dealAddress, { client: { wallet: alice } });
    const dealBob = await viem.getContractAt("Deal", dealAddress, { client: { wallet: bob } });
    const ausdAlice = await viem.getContractAt("DCToken", ausd.address, { client: { wallet: alice } });
    const usdtBob = await viem.getContractAt("DCToken", usdt.address, { client: { wallet: bob } });

    await waitFor(publicClient, await ausdAlice.write.approve([dealAddress, amount]));
    await waitFor(publicClient, await usdtBob.write.approve([dealAddress, amount]));
    await waitFor(publicClient, await dealBob.write.join([bobInfoId, false]));
    await waitFor(publicClient, await dealAlice.write.pay());
    await waitFor(publicClient, await dealBob.write.pay());
    await waitFor(publicClient, await dealAlice.write.setMyVote([ACCEPT]));
    await waitFor(publicClient, await dealBob.write.setMyVote([ACCEPT]));

    assert.equal(await creditGraph.read.creditScore([aliceInfoId]), expectedBaseCredit);
    assert.equal(await creditGraph.read.creditScore([bobInfoId]), expectedBaseCredit);

    const reward = await fixture.dealResultIndex.read.rewardOfDeal([dealAddress]);
    assert.equal(reward.exists, true);
    assert.equal(reward.deal, getAddress(dealAddress));
    assert.equal(reward.partyA, getAddress(alice.account.address));
    assert.equal(reward.partyB, getAddress(bob.account.address));
    assert.ok(reward.toA > 0n);
    assert.equal(reward.toA, reward.toB);
    assert.equal(await fixture.dealResultIndex.read.rewardDealCount([alice.account.address]), 1n);
    assert.equal(await fixture.dealResultIndex.read.rewardDealCount([bob.account.address]), 1n);
    assert.deepEqual(await fixture.dealResultIndex.read.getRewardDeals([alice.account.address, 0n, 10n, true]), [
      getAddress(dealAddress),
    ]);
    const rewards = await fixture.dealResultIndex.read.getRewards([alice.account.address, 0n, 10n, true]);
    assert.equal(rewards.length, 1);
    assert.equal(rewards[0].deal, getAddress(dealAddress));

    const credit = await fixture.dealResultIndex.read.creditOfDeal([dealAddress]);
    assert.equal(credit.exists, true);
    assert.equal(credit.deal, getAddress(dealAddress));
    assert.equal(credit.aTokenId, aliceInfoId);
    assert.equal(credit.bTokenId, bobInfoId);
    assert.equal(credit.baseCredit, expectedBaseCredit);
    assert.equal(credit.aDelta, expectedBaseCredit);
    assert.equal(credit.bDelta, expectedBaseCredit);
    assert.equal(await fixture.dealResultIndex.read.creditDealCount([aliceInfoId]), 1n);
    assert.equal(await fixture.dealResultIndex.read.creditDealCount([bobInfoId]), 1n);
    assert.deepEqual(await fixture.dealResultIndex.read.getCreditDeals([aliceInfoId, 0n, 10n, true]), [
      getAddress(dealAddress),
    ]);
    const creditRecords = await fixture.dealResultIndex.read.getCreditRecords([aliceInfoId, 0n, 10n, true]);
    assert.equal(creditRecords.length, 1);
    assert.equal(creditRecords[0].deal, getAddress(dealAddress));

    const alicePeers = await creditGraph.read.topCreditPeers([aliceInfoId]);
    const bobPeers = await creditGraph.read.topCreditPeers([bobInfoId]);
    assert.equal(alicePeers[0].tokenId, bobInfoId);
    assert.equal(alicePeers[0].creditSnapshot, expectedBaseCredit);
    assert.equal(bobPeers[0].tokenId, aliceInfoId);
    assert.equal(bobPeers[0].creditSnapshot, expectedBaseCredit);
  });

  it("applies base credit plus inverse-score extra reward with zero-score boundaries", async function () {
    const fixture = await deployFixture();
    const { alice, bob } = fixture;
    const creditGraph = await enableCreditGraph(fixture);
    const aliceInfoId = await fixture.mintInfoNft(alice);
    const bobInfoId = await fixture.mintInfoNft(bob);

    await waitFor(
      fixture.publicClient,
      await creditGraph.write.recordDeal([
        alice.account.address,
        bob.account.address,
        aliceInfoId,
        true,
        0n,
        false,
        9_970n * ONE,
      ]),
    );
    assert.equal(await creditGraph.read.creditScore([aliceInfoId]), 9_970n * ONE);
    assert.equal(await creditGraph.read.creditScore([bobInfoId]), 0n);

    await waitFor(
      fixture.publicClient,
      await creditGraph.write.recordDeal([
        alice.account.address,
        bob.account.address,
        aliceInfoId,
        true,
        bobInfoId,
        true,
        30n * ONE,
      ]),
    );

    assert.equal(await creditGraph.read.creditScore([aliceInfoId]), 10_000n * ONE);
    assert.equal(await creditGraph.read.creditScore([bobInfoId]), 90n * ONE);
  });

  it("can migrate credit scores and top5 snapshots to a replacement credit graph", async function () {
    const fixture = await deployFixture();
    const { viem, publicClient, alice, bob, factory, infoNft } = fixture;
    const creditGraph = await enableCreditGraph(fixture);
    const aliceInfoId = await fixture.mintInfoNft(alice);
    const bobInfoId = await fixture.mintInfoNft(bob);

    await waitFor(
      publicClient,
      await creditGraph.write.recordDeal([
        alice.account.address,
        bob.account.address,
        aliceInfoId,
        true,
        bobInfoId,
        true,
        100n * ONE,
      ]),
    );

    const aliceScore = await creditGraph.read.creditScore([aliceInfoId]);
    const bobScore = await creditGraph.read.creditScore([bobInfoId]);
    const alicePeers = await creditGraph.read.topCreditPeers([aliceInfoId]);
    const bobPeers = await creditGraph.read.topCreditPeers([bobInfoId]);

    const replacementGraph = await viem.deployContract("DealCreditGraph", [infoNft.address]);
    await waitFor(publicClient, await replacementGraph.write.importCredit([aliceInfoId, aliceScore, alicePeers]));
    await waitFor(publicClient, await replacementGraph.write.importCredit([bobInfoId, bobScore, bobPeers]));
    await waitFor(publicClient, await replacementGraph.write.setRecorder([factory.address, true]));
    await waitFor(publicClient, await factory.write.setGlobal(["creditGraph", replacementGraph.address]));
    await waitFor(publicClient, await replacementGraph.write.lockMigration());

    assert.equal(await replacementGraph.read.creditScore([aliceInfoId]), aliceScore);
    assert.equal(await replacementGraph.read.creditScore([bobInfoId]), bobScore);

    const migratedAlicePeers = await replacementGraph.read.topCreditPeers([aliceInfoId]);
    assert.equal(migratedAlicePeers[0].tokenId, bobInfoId);
    assert.equal(migratedAlicePeers[0].creditSnapshot, bobScore);

    await assert.rejects(
      replacementGraph.write.importCredit([aliceInfoId, aliceScore, alicePeers]),
      /MigrationAlreadyLocked/,
    );
  });

  it("charges 0.3% on both recognized swap sides and routes fees into their pairs", async function () {
    const fixture = await deployFixture();
    const { ausd, usdt, factory } = fixture;
    const { pairAddress: ausdPair } = await fixture.createAndInitPair(ausd.address);
    const { pairAddress: usdtPair } = await fixture.createAndInitPair(usdt.address);

    const aSwapAmount = 1_000n * ONE;
    const bSwapAmount = 2_000n * ONE;
    const aFee = (aSwapAmount * 3n) / 1000n;
    const bFee = (bSwapAmount * 3n) / 1000n;

    const ausdPairBalanceBefore = await ausd.read.balanceOf([ausdPair]);
    const usdtPairBalanceBefore = await usdt.read.balanceOf([usdtPair]);
    const dealAddress = await createDealAndGetAddress(fixture, {
      aSwapToken: ausd.address,
      aSwapAmount,
      bSwapToken: usdt.address,
      bSwapAmount,
    });

    await completeOpenDeal(fixture, dealAddress, {
      alice: [{ token: ausd, amount: aSwapAmount }],
      bob: [{ token: usdt, amount: bSwapAmount }],
    });

    assert.equal(
      await ausd.read.balanceOf([ausdPair]),
      ausdPairBalanceBefore + aFee,
    );
    assert.equal(
      await usdt.read.balanceOf([usdtPair]),
      usdtPairBalanceBefore + bFee,
    );
    assert.equal(await factory.read.trackedCount([getAddress(fixture.alice.account.address)]), 0n);

    const { viem } = fixture;
    const deal = await viem.getContractAt("Deal", dealAddress);
    assert.equal(await deal.read.templateType(), TEMPLATE_TOKEN_TO_TOKEN);
  });

  it("allows unrecognized tokens to trade, sends 0.3% fees to treasury, and mints no rebate", async function () {
    const fixture = await deployFixture();
    const { bad, ausd, treasury, dl } = fixture;
    const aSwapAmount = 1_000n * ONE;
    const fee = (aSwapAmount * 3n) / 1000n;

    const dlSupplyBefore = await dl.read.totalSupply();
    const treasuryBadBefore = await bad.read.balanceOf([treasury.account.address]);

    const dealAddress = await createDealAndGetAddress(fixture, {
      aSwapToken: bad.address,
      aSwapAmount,
      aMarginToken: ausd.address,
      aMarginAmount: ONE,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
    });

    await completeOpenDeal(fixture, dealAddress, {
      alice: [
        { token: bad, amount: aSwapAmount },
        { token: ausd, amount: ONE },
      ],
    });

    assert.equal(await bad.read.balanceOf([treasury.account.address]), treasuryBadBefore + fee);
    assert.equal(await dl.read.totalSupply(), dlSupplyBefore);
  });

  it("charges 0.1% on DL-DL trades and burns the fee when no C exists", async function () {
    const fixture = await deployFixture();
    const { dl } = fixture;
    const aSwapAmount = 1_000n * ONE;
    const bSwapAmount = 2_000n * ONE;
    const totalFee = ((aSwapAmount * 1n) / 1000n) + ((bSwapAmount * 1n) / 1000n);

    const supplyBefore = await dl.read.totalSupply();
    const dealAddress = await createDealAndGetAddress(fixture, {
      aSwapToken: dl.address,
      aSwapAmount,
      bSwapToken: dl.address,
      bSwapAmount,
    });

    await completeOpenDeal(fixture, dealAddress, {
      alice: [{ token: dl, amount: aSwapAmount }],
      bob: [{ token: dl, amount: bSwapAmount }],
    });

    assert.equal(await dl.read.totalSupply(), supplyBefore - totalFee);
  });

  it("does not count margin toward fees or DL rebates", async function () {
    const aSwapAmount = 1_000n * ONE;
    const aMarginAmount = 500n * ONE;

    const withMargin = await deployFixture();
    const withoutMargin = await deployFixture();

    const { ausd: ausdWithMargin, dl: dlWithMargin } = withMargin;
    const { ausd: ausdWithoutMargin, dl: dlWithoutMargin } = withoutMargin;

    const { pairAddress: pairWithMargin } = await withMargin.createAndInitPair(ausdWithMargin.address);
    const { pairAddress: pairWithoutMargin } = await withoutMargin.createAndInitPair(ausdWithoutMargin.address);

    const withMarginPairBefore = await ausdWithMargin.read.balanceOf([pairWithMargin]);
    const withMarginAliceDlBefore = await dlWithMargin.read.balanceOf([withMargin.alice.account.address]);
    const withMarginBobDlBefore = await dlWithMargin.read.balanceOf([withMargin.bob.account.address]);
    const withMarginAliceAusdBefore = await ausdWithMargin.read.balanceOf([withMargin.alice.account.address]);

    const withoutMarginPairBefore = await ausdWithoutMargin.read.balanceOf([pairWithoutMargin]);
    const withoutMarginAliceDlBefore = await dlWithoutMargin.read.balanceOf([withoutMargin.alice.account.address]);
    const withoutMarginBobDlBefore = await dlWithoutMargin.read.balanceOf([withoutMargin.bob.account.address]);

    const dealWithMargin = await createDealAndGetAddress(withMargin, {
      aSwapToken: ausdWithMargin.address,
      aSwapAmount,
      aMarginToken: ausdWithMargin.address,
      aMarginAmount,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
    });
    const dealWithoutMargin = await createDealAndGetAddress(withoutMargin, {
      aSwapToken: ausdWithoutMargin.address,
      aMarginToken: ausdWithoutMargin.address,
      aMarginAmount: 1n,
      aSwapAmount,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
    });

    await completeOpenDeal(withMargin, dealWithMargin, {
      alice: [{ token: ausdWithMargin, amount: aSwapAmount + aMarginAmount }],
    });
    await completeOpenDeal(withoutMargin, dealWithoutMargin, {
      alice: [{ token: ausdWithoutMargin, amount: aSwapAmount + 1n }],
    });

    const feeWithMargin = (await ausdWithMargin.read.balanceOf([pairWithMargin])) - withMarginPairBefore;
    const feeWithoutMargin = (await ausdWithoutMargin.read.balanceOf([pairWithoutMargin])) - withoutMarginPairBefore;
    const aliceRebateWithMargin =
      (await dlWithMargin.read.balanceOf([withMargin.alice.account.address])) - withMarginAliceDlBefore;
    const aliceRebateWithoutMargin =
      (await dlWithoutMargin.read.balanceOf([withoutMargin.alice.account.address])) - withoutMarginAliceDlBefore;
    const bobRebateWithMargin =
      (await dlWithMargin.read.balanceOf([withMargin.bob.account.address])) - withMarginBobDlBefore;
    const bobRebateWithoutMargin =
      (await dlWithoutMargin.read.balanceOf([withoutMargin.bob.account.address])) - withoutMarginBobDlBefore;

    assert.equal(feeWithMargin, feeWithoutMargin);
    assert.equal(aliceRebateWithMargin, aliceRebateWithoutMargin);
    assert.equal(bobRebateWithMargin, bobRebateWithoutMargin);
    assert.equal(
      await ausdWithMargin.read.balanceOf([withMargin.alice.account.address]),
      withMarginAliceAusdBefore - aSwapAmount,
    );
  });

  it("rejects recognized-token deals when the DL pair is missing", async function () {
    const fixture = await deployFixture();
    const { ausd, factory } = fixture;

    await assert.rejects(
      factory.write.createDeal([
        {
          init: {
            aSwapToken: ausd.address,
            aSwapAmount: 100n * ONE,
            aMarginToken: zeroAddress,
            aMarginAmount: 1n,
            bSwapToken: zeroAddress,
            bSwapAmount: 0n,
            bMarginToken: zeroAddress,
            bMarginAmount: 0n,
            aAssetNft: zeroAddress,
            aAssetNftId: 0n,
            bAssetNft: zeroAddress,
            bAssetNftId: 0n,
            templateType: TEMPLATE_TOKEN_TO_EMPTY,
            joinMode: OPEN_JOIN,
            expectedB: zeroAddress,
            gateNftId: 0n,
            aNftId: 0n,
            title: "missing pair",
            description: "",
            timeoutSeconds: 3600n,
            replaceTimeoutSeconds: 0n,
            isDomainDeal: false,
            domainName: "",
            openTokenTokenFast: false,
          },
          trackCreator: false,
        },
      ]),
      /RewardPairMissing/,
    );
  });

  it("stores empty-to-empty deals as the empty template under the same deal state machine", async function () {
    const fixture = await deployFixture();
    const { viem, ausd } = fixture;

    const dealAddress = await createDealAndGetAddress(fixture, {
      aSwapToken: zeroAddress,
      aSwapAmount: 0n,
      aMarginToken: ausd.address,
      aMarginAmount: ONE,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
      templateType: TEMPLATE_EMPTY_TO_EMPTY,
    });

    const deal = await viem.getContractAt("Deal", dealAddress);
    assert.equal(await deal.read.templateType(), TEMPLATE_EMPTY_TO_EMPTY);
    assert.equal(await deal.read.status(), 0);
  });

  it("records creation and terminal timestamps without frontend time inputs", async function () {
    const fixture = await deployFixture();
    const { ausd, viem } = fixture;
    const { pairAddress: ausdPair } = await fixture.createAndInitPair(ausd.address);
    const aSwapAmount = 500n * ONE;
    const pairBalanceBefore = await ausd.read.balanceOf([ausdPair]);

    const dealAddress = await createDealAndGetAddress(fixture, {
      aSwapToken: ausd.address,
      aSwapAmount,
      aMarginToken: ausd.address,
      aMarginAmount: 50n * ONE,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
      templateType: TEMPLATE_TOKEN_TO_EMPTY,
    });

    const activeDeal = await viem.getContractAt("Deal", dealAddress);
    const createdAt = await activeDeal.read.createdAt();
    assert.ok(createdAt > 0n);
    assert.equal(await activeDeal.read.timeStart(), createdAt);
    assert.equal(await activeDeal.read.endedAt(), 0n);
    assert.equal(await activeDeal.read.timeEnd(), 0n);

    await completeOpenDeal(fixture, dealAddress, {
      alice: [{ token: ausd, amount: aSwapAmount + 50n * ONE }],
    });

    const deal = await viem.getContractAt("Deal", dealAddress);
    const endedAt = await deal.read.endedAt();
    assert.ok(endedAt >= createdAt);
    assert.equal(await deal.read.timeEnd(), endedAt);
    assert.equal(await ausd.read.balanceOf([ausdPair]), pairBalanceBefore + ((aSwapAmount * 3n) / 1000n));
  });

  it("rejects oversized deal titles before storing them in clone state", async function () {
    const fixture = await deployFixture();
    const { bad } = fixture;

    await assert.rejects(
      createDealAndGetAddress(fixture, {
        aSwapToken: bad.address,
        aSwapAmount: 10n * ONE,
        bSwapToken: zeroAddress,
        bSwapAmount: 0n,
        templateType: TEMPLATE_TOKEN_TO_EMPTY,
        title: "a".repeat(97),
      }),
      /TitleTooLong/,
    );
  });

  it("stores optional deal descriptions and exposes them through DealReader", async function () {
    const fixture = await deployFixture();
    const { viem, bad } = fixture;
    const description = "交付内容：测试账号在验收后释放保证金。";

    const dealAddress = await createDealAndGetAddress(fixture, {
      aSwapToken: bad.address,
      aSwapAmount: 10n * ONE,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
      templateType: TEMPLATE_TOKEN_TO_EMPTY,
      title: "desc deal",
      description,
    });

    const deal = await viem.getContractAt("Deal", dealAddress);
    assert.equal(await deal.read.description(), description);

    const reader = await viem.deployContract("DealReader");
    const info = await reader.read.getDeal([dealAddress]);
    assert.equal(info.description, description);
  });

  it("rejects oversized deal descriptions before cloning", async function () {
    const fixture = await deployFixture();
    const { bad } = fixture;

    await assert.rejects(
      createDealAndGetAddress(fixture, {
        aSwapToken: bad.address,
        aSwapAmount: 10n * ONE,
        bSwapToken: zeroAddress,
        bSwapAmount: 0n,
        templateType: TEMPLATE_TOKEN_TO_EMPTY,
        description: "a".repeat(1501),
      }),
      /DescriptionTooLong/,
    );
  });

  it("allows force-timeout windows up to 100 years and rejects longer values", async function () {
    const fixture = await deployFixture();
    const hundredYears = 3_153_600_000n;

    const okDeal = await createDealAndGetAddress(fixture, {
      aSwapToken: zeroAddress,
      aSwapAmount: 0n,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
      templateType: TEMPLATE_EMPTY_TO_EMPTY,
      timeoutSeconds: hundredYears,
    });
    assert.notEqual(okDeal, zeroAddress);

    await assert.rejects(
      createDealAndGetAddress(fixture, {
        aSwapToken: zeroAddress,
        aSwapAmount: 0n,
        bSwapToken: zeroAddress,
        bSwapAmount: 0n,
        templateType: TEMPLATE_EMPTY_TO_EMPTY,
        timeoutSeconds: hundredYears + 1n,
      }),
      /TimeoutTooLong/,
    );
  });

  it("does not let A force-cancel after A rejects and B stays silent", async function () {
    const fixture = await deployFixture();
    const { viem, publicClient, alice, bob, ausd, usdt } = fixture;
    const testClient = await viem.getTestClient();
    await fixture.createAndInitPair(ausd.address);
    await fixture.createAndInitPair(usdt.address);

    const dealAddress = await createDealAndGetAddress(fixture, {
      aSwapToken: ausd.address,
      aSwapAmount: 10n * ONE,
      bSwapToken: usdt.address,
      bSwapAmount: 10n * ONE,
      templateType: TEMPLATE_TOKEN_TO_TOKEN,
    });

    const dealAlice = await viem.getContractAt("DealNoAsset", dealAddress, { client: { wallet: alice } });
    const dealBob = await viem.getContractAt("DealNoAsset", dealAddress, { client: { wallet: bob } });
    const ausdAlice = await viem.getContractAt("DCToken", ausd.address, { client: { wallet: alice } });
    const usdtBob = await viem.getContractAt("DCToken", usdt.address, { client: { wallet: bob } });

    await waitFor(publicClient, await ausdAlice.write.approve([dealAddress, 10n * ONE]));
    await waitFor(publicClient, await usdtBob.write.approve([dealAddress, 10n * ONE]));
    await waitFor(publicClient, await dealBob.write.join([0n, false]));
    await waitFor(publicClient, await dealAlice.write.pay());
    await waitFor(publicClient, await dealBob.write.pay());
    assert.equal(Number(await dealAlice.read.status()), 2);

    await waitFor(publicClient, await dealAlice.write.setMyVote([REJECT]));
    const block = await publicClient.getBlock();
    await testClient.setNextBlockTimestamp({ timestamp: block.timestamp + 3601n });
    await testClient.mine({ blocks: 1 });

    await assert.rejects(dealAlice.write.forceComplete());
    assert.equal(Number(await dealAlice.read.status()), 2);
  });

  it("caps DealReader batch calls at 100 deals", async function () {
    const fixture = await deployFixture();
    const reader = await fixture.viem.deployContract("DealReader");
    const tooMany = Array.from({ length: 101 }, () => zeroAddress);

    await assert.rejects(reader.read.getDeals([tooMany]), /BatchTooLarge/);
    await assert.rejects(reader.read.getDealsSlim([tooMany]), /BatchTooLarge/);
    await assert.rejects(reader.read.getDealsPlus([tooMany, zeroAddress]), /BatchTooLarge/);
  });

  it("preserves deal chat through the external message hub", async function () {
    const fixture = await deployFixture();
    const { viem, publicClient, bad, alice, bob, dealMessageHub } = fixture;

    const dealAddress = await createDealAndGetAddress(fixture, {
      aSwapToken: bad.address,
      aSwapAmount: 10n * ONE,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
      templateType: TEMPLATE_TOKEN_TO_EMPTY,
      title: "chat deal",
    });

    const hubAsAlice = await viem.getContractAt("DealMessageHub", dealMessageHub.address, { client: { wallet: alice } });
    const hubAsBob = await viem.getContractAt("DealMessageHub", dealMessageHub.address, { client: { wallet: bob } });
    const dealAsBob = await viem.getContractAt("Deal", dealAddress, { client: { wallet: bob } });

    await waitFor(publicClient, await hubAsAlice.write.postMessage([dealAddress, "hello from a"]));
    await waitFor(publicClient, await dealAsBob.write.join([0n, false]));
    await waitFor(publicClient, await hubAsBob.write.postMessage([dealAddress, "hello from b"]));
    await waitFor(publicClient, await hubAsAlice.write.postMessage([dealAddress, "a".repeat(1500)]));

    await assert.rejects(hubAsAlice.write.postMessage([dealAddress, ""]), /EmptyMessage/);
    await assert.rejects(hubAsAlice.write.postMessage([dealAddress, "a".repeat(1501)]), /MessageTooLong/);

    const count = await dealMessageHub.read.messagesCount([dealAddress]);
    const [contents, , senders] = await dealMessageHub.read.getMessages([dealAddress, 0n, 10n]);

    assert.equal(count, 3n);
    assert.deepEqual(contents, ["hello from a", "hello from b", "a".repeat(1500)]);
    assert.equal(getAddress(senders[0]), getAddress(alice.account.address));
    assert.equal(getAddress(senders[1]), getAddress(bob.account.address));
    assert.equal(getAddress(senders[2]), getAddress(alice.account.address));
  });

  it("allows deal chat after Completed via DealMessageHub", async function () {
    const fixture = await deployFixture();
    const { viem, publicClient, ausd, usdt, dealMessageHub, alice, bob } = fixture;
    await fixture.createAndInitPair(ausd.address);
    await fixture.createAndInitPair(usdt.address);

    const aSwapAmount = 100n * ONE;
    const bSwapAmount = 100n * ONE;
    const dealAddress = await createDealAndGetAddress(fixture, {
      aSwapToken: ausd.address,
      aSwapAmount,
      bSwapToken: usdt.address,
      bSwapAmount,
      templateType: TEMPLATE_TOKEN_TO_TOKEN,
    });

    await completeOpenDeal(fixture, dealAddress, {
      alice: [{ token: ausd, amount: aSwapAmount }],
      bob: [{ token: usdt, amount: bSwapAmount }],
    });

    const deal = await viem.getContractAt("Deal", dealAddress);
    assert.equal(Number(await deal.read.status()), 3);

    const hubAsAlice = await viem.getContractAt("DealMessageHub", dealMessageHub.address, { client: { wallet: alice } });
    const hubAsBob = await viem.getContractAt("DealMessageHub", dealMessageHub.address, { client: { wallet: bob } });
    await waitFor(publicClient, await hubAsAlice.write.postMessage([dealAddress, "post-complete a"]));
    await waitFor(publicClient, await hubAsBob.write.postMessage([dealAddress, "post-complete b"]));

    const count = await dealMessageHub.read.messagesCount([dealAddress]);
    assert.equal(count, 2n);
    const [contents] = await dealMessageHub.read.getMessages([dealAddress, 0n, 10n]);
    assert.deepEqual(contents, ["post-complete a", "post-complete b"]);
  });

  it("allows approved createDealFor callers to create and track deals for the initiator", async function () {
    const fixture = await deployFixture();
    const { viem, publicClient, factory, alice } = fixture;
    const helper = await viem.deployContract("TestFactoryCaller");

    await waitFor(publicClient, await factory.write.setAllowedCreateFor([helper.address, true]));

    const createHash = await helper.write.createDealFor([
      factory.address,
      alice.account.address,
      {
        init: {
          aSwapToken: zeroAddress,
          aSwapAmount: 0n,
          aMarginToken: zeroAddress,
          aMarginAmount: 0n,
          bSwapToken: zeroAddress,
          bSwapAmount: 0n,
          bMarginToken: zeroAddress,
          bMarginAmount: 0n,
          aAssetNft: zeroAddress,
          aAssetNftId: 0n,
          bAssetNft: zeroAddress,
          bAssetNftId: 0n,
          templateType: TEMPLATE_EMPTY_TO_EMPTY,
          joinMode: OPEN_JOIN,
          expectedB: zeroAddress,
          gateNftId: 0n,
          aNftId: 0n,
          title: "create for",
          description: "",
          timeoutSeconds: 3600n,
          replaceTimeoutSeconds: 0n,
          isDomainDeal: false,
          domainName: "",
          openTokenTokenFast: false,
        },
        trackCreator: true,
      },
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
    const events = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "DealCreated",
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
      strict: true,
    });

    assert.equal(events.length, 1);
    const dealAddress = events[0].args.deal;
    assert.equal(await factory.read.isDeal([dealAddress]), true);
    assert.equal(await factory.read.trackedCount([getAddress(alice.account.address)]), 1n);
    assert.equal(await factory.read.isTracked([getAddress(alice.account.address), dealAddress]), true);
  });

  it("charges message fees through allowed external callers using the configured pricing pair", async function () {
    const fixture = await deployFixture();
    const { viem, publicClient, factory, dl, ausd, alice } = fixture;
    const helper = await viem.deployContract("TestFactoryCaller");

    await fixture.createAndInitPair(ausd.address);
    await waitFor(publicClient, await factory.write.setAllowedCreateFor([helper.address, true]));
    await waitFor(publicClient, await factory.write.setMessagePriceRule([true, ausd.address, ONE]));

    const dlAlice = await viem.getContractAt("DCToken", dl.address, { client: { wallet: alice } });
    const aliceBefore = await dl.read.balanceOf([alice.account.address]);
    const supplyBefore = await dl.read.totalSupply();

    await waitFor(publicClient, await dlAlice.write.approve([factory.address, ONE]));
    await waitFor(publicClient, await helper.write.chargeMessageFeeFrom([factory.address, alice.account.address]));

    assert.equal(await dl.read.balanceOf([alice.account.address]), aliceBefore - ONE);
    assert.equal(await dl.read.totalSupply(), supplyBefore - ONE);
  });

  it("supports dual designation by requiring both the expected address and the specified identity nft", async function () {
    const fixture = await deployFixture();
    const { bad, ausd, viem, bob, publicClient } = fixture;
    const nftId = await fixture.mintInfoNft(bob);

    const dealAddress = await createDealAndGetAddress(fixture, {
      aSwapToken: bad.address,
      aSwapAmount: 100n * ONE,
      aMarginToken: ausd.address,
      aMarginAmount: 10n * ONE,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
      templateType: TEMPLATE_TOKEN_TO_EMPTY,
      joinMode: EXACT_AND_NFT_JOIN,
      expectedB: bob.account.address,
      gateNftId: nftId,
    });

    const dealBob = await viem.getContractAt("Deal", dealAddress, { client: { wallet: bob } });
    await waitFor(publicClient, await dealBob.write.join([0n, false]));

    assert.equal(await dealBob.read.b(), getAddress(bob.account.address));
    assert.equal(await dealBob.read.bNftId(), nftId);
  });

  it("allows zero margin for token-to-empty and empty-to-empty templates", async function () {
    const fixture = await deployFixture();
    const { bad } = fixture;

    const tokenToEmpty = await createDealAndGetAddress(fixture, {
      aSwapToken: bad.address,
      aSwapAmount: 10n * ONE,
      aMarginToken: zeroAddress,
      aMarginAmount: 0n,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
      bMarginToken: zeroAddress,
      bMarginAmount: 0n,
      templateType: TEMPLATE_TOKEN_TO_EMPTY,
      title: "gift no margin",
    });
    assert.notEqual(tokenToEmpty, zeroAddress);

    const emptyToEmpty = await createDealAndGetAddress(fixture, {
      aSwapToken: zeroAddress,
      aSwapAmount: 0n,
      aMarginToken: zeroAddress,
      aMarginAmount: 0n,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
      bMarginToken: zeroAddress,
      bMarginAmount: 0n,
      templateType: TEMPLATE_EMPTY_TO_EMPTY,
      title: "empty no margin",
    });
    assert.notEqual(emptyToEmpty, zeroAddress);
  });

  it("rejects margin tokens outside the allowed whitelist", async function () {
    const fixture = await deployFixture();
    const { factory, viem, alice, bad } = fixture;
    const factoryAsAlice = await viem.getContractAt("DealFactory", factory.address, {
      client: { wallet: alice },
    });

    await assert.rejects(
      factoryAsAlice.write.createDeal([
        {
          init: {
            aSwapToken: bad.address,
            aSwapAmount: 10n * ONE,
            aMarginToken: bad.address,
            aMarginAmount: ONE,
            bSwapToken: zeroAddress,
            bSwapAmount: 0n,
            bMarginToken: zeroAddress,
            bMarginAmount: 0n,
            aAssetNft: zeroAddress,
            aAssetNftId: 0n,
            bAssetNft: zeroAddress,
            bAssetNftId: 0n,
            templateType: TEMPLATE_TOKEN_TO_EMPTY,
            joinMode: OPEN_JOIN,
            expectedB: zeroAddress,
            gateNftId: 0n,
            aNftId: 0n,
            title: "bad margin token",
            description: "",
            timeoutSeconds: 3600n,
            replaceTimeoutSeconds: 0n,
            isDomainDeal: false,
            domainName: "",
            openTokenTokenFast: false,
          },
          trackCreator: false,
        },
      ]),
      /MarginTokenNotAllowed/,
    );
  });

  it("allows owner to extend the margin whitelist for additional tokens", async function () {
    const fixture = await deployFixture();
    const { factory, viem, publicClient, alice, bad } = fixture;
    const factoryAsAlice = await viem.getContractAt("DealFactory", factory.address, {
      client: { wallet: alice },
    });

    await waitFor(publicClient, await factory.write.setAllowedMarginToken([bad.address, true]));

    const hash = await factoryAsAlice.write.createDeal([
      {
        init: {
          aSwapToken: bad.address,
          aSwapAmount: 10n * ONE,
          aMarginToken: bad.address,
          aMarginAmount: ONE,
          bSwapToken: zeroAddress,
          bSwapAmount: 0n,
          bMarginToken: zeroAddress,
          bMarginAmount: 0n,
          aAssetNft: zeroAddress,
          aAssetNftId: 0n,
          bAssetNft: zeroAddress,
          bAssetNftId: 0n,
          templateType: TEMPLATE_TOKEN_TO_EMPTY,
          joinMode: OPEN_JOIN,
          expectedB: zeroAddress,
          gateNftId: 0n,
          aNftId: 0n,
            title: "extended margin whitelist",
            description: "",
            timeoutSeconds: 3600n,
            replaceTimeoutSeconds: 0n,
            isDomainDeal: false,
            domainName: "",
            openTokenTokenFast: false,
          },
          trackCreator: false,
      },
    ]);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
  });

  it("assigns nft display numbers on mint as S-season-date-serial", async function () {
    const fixture = await deployFixture();
    const { infoNft, alice, bob, publicClient } = fixture;

    const firstId = await fixture.mintInfoNft(alice);
    const secondId = await fixture.mintInfoNft(bob);

    const firstDateCode = await infoNft.read.dateCodeOf([firstId]);
    const secondDateCode = await infoNft.read.dateCodeOf([secondId]);
    assert.equal(firstDateCode, secondDateCode);

    assert.equal(await infoNft.read.seasonOf([firstId]), 1);
    assert.equal(await infoNft.read.dailySerialOf([firstId]), 1);
    assert.equal(await infoNft.read.dailySerialOf([secondId]), 2);
    assert.equal(await infoNft.read.displayNoOf([firstId]), `S1-${firstDateCode}-1`);
    assert.equal(await infoNft.read.displayNoOf([secondId]), `S1-${secondDateCode}-2`);

    const tokenUri = await infoNft.read.tokenURI([firstId]);
    assert.match(tokenUri, /^data:application\/json;base64,/);

    const infoNftAsAlice = await fixture.viem.getContractAt("DealInfoNFT", infoNft.address, {
      client: { wallet: alice },
    });
    await waitFor(publicClient, await infoNftAsAlice.write.setTokenImageURI([firstId, "ipfs://avatar"]));
    await waitFor(publicClient, await infoNftAsAlice.write.setTokenUserName([firstId, "alice"]));
    await waitFor(publicClient, await infoNftAsAlice.write.setTokenUserDetail([firstId, "maker profile"]));
    await assert.rejects(infoNftAsAlice.write.setTokenImageURI([firstId, "a".repeat(513)]), /TOO_LONG/);
    await assert.rejects(infoNftAsAlice.write.setTokenImageURI([firstId, 'bad"uri']), /UNSAFE_CHAR/);
    await assert.rejects(infoNftAsAlice.write.setTokenUserName([firstId, "a".repeat(65)]), /TOO_LONG/);
    await assert.rejects(infoNftAsAlice.write.setTokenUserDetail([firstId, "a".repeat(1001)]), /TOO_LONG/);
    await assert.rejects(infoNft.write.setAdmin([zeroAddress]), /ZERO_ADMIN/);

    await waitFor(publicClient, await infoNft.write.setCurrentSeason([2]));
    const thirdId = await fixture.mintInfoNft(alice);
    const thirdDateCode = await infoNft.read.dateCodeOf([thirdId]);
    assert.equal(await infoNft.read.seasonOf([thirdId]), 2);
    assert.equal(await infoNft.read.dailySerialOf([thirdId]), 1);
    assert.equal(await infoNft.read.displayNoOf([thirdId]), `S2-${thirdDateCode}-1`);
  });

  it("settles token-to-nft deals by transferring the nft to the token payer", async function () {
    const fixture = await deployFixture();
    const { ausd, viem, bob } = fixture;
    const { pairAddress: ausdPair } = await fixture.createAndInitPair(ausd.address);
    const nftId = await fixture.mintInfoNft(bob);
    const aSwapAmount = 1_000n * ONE;
    const aFee = (aSwapAmount * 3n) / 1000n;
    const pairBalanceBefore = await ausd.read.balanceOf([ausdPair]);
    const bobAusdBefore = await ausd.read.balanceOf([fixture.bob.account.address]);

    const dealAddress = await createDealAndGetAddress(fixture, {
      aSwapToken: ausd.address,
      aSwapAmount,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
      bAssetNftId: nftId,
      templateType: TEMPLATE_TOKEN_TO_NFT,
    });

    await completeOpenDeal(fixture, dealAddress, {
      alice: [{ token: ausd, amount: aSwapAmount }],
      bobNftIds: [nftId],
    });

    const infoNft = await viem.getContractAt("DealInfoNFT", fixture.infoNft.address);
    assert.equal(await infoNft.read.ownerOf([nftId]), getAddress(fixture.alice.account.address));
    assert.equal(await ausd.read.balanceOf([ausdPair]), pairBalanceBefore + aFee);
    assert.equal(
      await ausd.read.balanceOf([fixture.bob.account.address]),
      bobAusdBefore + (aSwapAmount - aFee),
    );
  });

  it("settles nft-to-empty deals by transferring the nft to the counterparty", async function () {
    const fixture = await deployFixture();
    const { viem, alice, bob } = fixture;
    const nftId = await fixture.mintInfoNft(alice);

    const dealAddress = await createDealAndGetAddress(fixture, {
      aSwapToken: zeroAddress,
      aSwapAmount: 0n,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
      aAssetNftId: nftId,
      templateType: TEMPLATE_NFT_TO_EMPTY,
    });

    await completeOpenDeal(fixture, dealAddress, {
      aliceNftIds: [nftId],
    });

    const infoNft = await viem.getContractAt("DealInfoNFT", fixture.infoNft.address);
    assert.equal(await infoNft.read.ownerOf([nftId]), getAddress(bob.account.address));
  });

  it("rejects using the same nft as both A identity and A sale asset in one deal", async function () {
    const fixture = await deployFixture();
    const { bad, factory, viem, alice, infoNft } = fixture;
    const nftId = await fixture.mintInfoNft(alice);
    const factoryAsAlice = await viem.getContractAt("DealFactory", factory.address, {
      client: { wallet: alice },
    });

    await assert.rejects(
      factoryAsAlice.write.createDeal([
        {
          init: {
            aSwapToken: zeroAddress,
            aSwapAmount: 0n,
            aMarginToken: zeroAddress,
            aMarginAmount: 0n,
            bSwapToken: bad.address,
            bSwapAmount: 100n * ONE,
            bMarginToken: zeroAddress,
            bMarginAmount: 0n,
            aAssetNft: infoNft.address,
            aAssetNftId: nftId,
            bAssetNft: zeroAddress,
            bAssetNftId: 0n,
            templateType: TEMPLATE_TOKEN_TO_NFT,
            joinMode: OPEN_JOIN,
            expectedB: zeroAddress,
            gateNftId: 0n,
            aNftId: nftId,
            title: "conflict a",
            description: "",
            timeoutSeconds: 3600n,
            replaceTimeoutSeconds: 0n,
            isDomainDeal: false,
            domainName: "",
            openTokenTokenFast: false,
          },
          trackCreator: false,
        },
      ]),
      /DealError\(39\)/,
    );
  });

  it("rejects using the same nft as both B entry nft and B sale asset in one deal", async function () {
    const fixture = await deployFixture();
    const { bad, viem, bob } = fixture;
    const nftId = await fixture.mintInfoNft(bob);

    const dealAddress = await createDealAndGetAddress(fixture, {
      aSwapToken: bad.address,
      aSwapAmount: 100n * ONE,
      bSwapToken: zeroAddress,
      bSwapAmount: 0n,
      bAssetNftId: nftId,
      templateType: TEMPLATE_TOKEN_TO_NFT,
    });

    const dealBob = await viem.getContractAt("Deal", dealAddress, { client: { wallet: bob } });

    await assert.rejects(
      dealBob.write.join([nftId, false]),
      /DealError\(45\)/,
    );
  });

  it("rejects selling a locked nft that is already bound into another active deal", async function () {
    const fixture = await deployFixture();
    const { bad, ausd, factory, viem, alice, infoNft } = fixture;
    const nftId = await fixture.mintInfoNft(alice);
    const factoryAsAlice = await viem.getContractAt("DealFactory", factory.address, {
      client: { wallet: alice },
    });

    await waitFor(
      fixture.publicClient,
      await factoryAsAlice.write.createDeal([
        {
          init: {
            aSwapToken: zeroAddress,
            aSwapAmount: 0n,
            aMarginToken: ausd.address,
            aMarginAmount: ONE,
            bSwapToken: zeroAddress,
            bSwapAmount: 0n,
            bMarginToken: zeroAddress,
            bMarginAmount: 0n,
            aAssetNft: zeroAddress,
            aAssetNftId: 0n,
            bAssetNft: zeroAddress,
            bAssetNftId: 0n,
            templateType: TEMPLATE_EMPTY_TO_EMPTY,
            joinMode: OPEN_JOIN,
            expectedB: zeroAddress,
            gateNftId: 0n,
            aNftId: nftId,
            title: "lock source",
            description: "",
            timeoutSeconds: 3600n,
            replaceTimeoutSeconds: 0n,
            isDomainDeal: false,
            domainName: "",
            openTokenTokenFast: false,
          },
          trackCreator: false,
        },
      ]),
    );

    await assert.rejects(
      factoryAsAlice.write.createDeal([
        {
          init: {
            aSwapToken: zeroAddress,
            aSwapAmount: 0n,
            aMarginToken: zeroAddress,
            aMarginAmount: 0n,
            bSwapToken: bad.address,
            bSwapAmount: 100n * ONE,
            bMarginToken: zeroAddress,
            bMarginAmount: 0n,
            aAssetNft: infoNft.address,
            aAssetNftId: nftId,
            bAssetNft: zeroAddress,
            bAssetNftId: 0n,
            templateType: TEMPLATE_TOKEN_TO_NFT,
            joinMode: OPEN_JOIN,
            expectedB: zeroAddress,
            gateNftId: 0n,
            aNftId: 0n,
            title: "locked sell",
            description: "",
            timeoutSeconds: 3600n,
            replaceTimeoutSeconds: 0n,
            isDomainDeal: false,
            domainName: "",
            openTokenTokenFast: false,
          },
          trackCreator: false,
        },
      ]),
      /DealError\(42\)/,
    );
  });

  it("DealOpenTokenToken: A pays in Ready, preAccept, then B joins and both settle", async function () {
    const fixture = await deployFixture();
    const { bad, ausd } = fixture;
    await fixture.createAndInitPair(ausd.address);
    await fixture.createAndInitPair(bad.address);

    await createOpenTTDealAndSettle(fixture, {
      aSwapToken: bad.address,
      aSwapAmount: 10n * ONE,
      bSwapToken: ausd.address,
      bSwapAmount: 5n * ONE,
    });
  });
});
