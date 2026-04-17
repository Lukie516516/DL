import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, zeroAddress } from "viem";

const ONE = 10n ** 18n;
const ACCEPT = 1;
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
  await waitFor(publicClient, await factory.write.setGlobal(["dealMessageHub", dealMessageHub.address]));
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
    dealMessageHub,
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
    timeoutSeconds?: bigint;
    timeStart?: bigint;
    timeEnd?: bigint;
    isDomainDeal?: boolean;
    domainName?: string;
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
        timeoutSeconds: init.timeoutSeconds ?? 3600n,
        timeStart: init.timeStart ?? 0n,
        timeEnd: init.timeEnd ?? 0n,
        isDomainDeal: init.isDomainDeal ?? false,
        domainName: init.domainName ?? "",
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
            timeoutSeconds: 3600n,
            timeStart: 0n,
            timeEnd: 0n,
            isDomainDeal: false,
            domainName: "",
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

  it("stores the time range as metadata without affecting the normal deal flow", async function () {
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
      timeStart: 1_700_000_000n,
      timeEnd: 1_800_000_000n,
    });

    await completeOpenDeal(fixture, dealAddress, {
      alice: [{ token: ausd, amount: aSwapAmount + 50n * ONE }],
    });

    const deal = await viem.getContractAt("Deal", dealAddress);
    assert.equal(await deal.read.timeStart(), 1_700_000_000n);
    assert.equal(await deal.read.timeEnd(), 1_800_000_000n);
    assert.equal(await ausd.read.balanceOf([ausdPair]), pairBalanceBefore + ((aSwapAmount * 3n) / 1000n));
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

    const dealAsAlice = await viem.getContractAt("Deal", dealAddress, { client: { wallet: alice } });
    const dealAsBob = await viem.getContractAt("Deal", dealAddress, { client: { wallet: bob } });

    await waitFor(publicClient, await dealAsAlice.write.postMessage(["hello from a"]));
    await waitFor(publicClient, await dealAsBob.write.join([0n, false]));
    await waitFor(publicClient, await dealAsBob.write.postMessage(["hello from b"]));

    const count = await dealMessageHub.read.messagesCount([dealAddress]);
    const [contents, , senders] = await dealMessageHub.read.getMessages([dealAddress, 0n, 10n]);

    assert.equal(count, 2n);
    assert.deepEqual(contents, ["hello from a", "hello from b"]);
    assert.equal(getAddress(senders[0]), getAddress(alice.account.address));
    assert.equal(getAddress(senders[1]), getAddress(bob.account.address));
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
          timeoutSeconds: 3600n,
          timeStart: 0n,
          timeEnd: 0n,
          isDomainDeal: false,
          domainName: "",
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
            timeoutSeconds: 3600n,
            timeStart: 0n,
            timeEnd: 0n,
            isDomainDeal: false,
            domainName: "",
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
          timeoutSeconds: 3600n,
          timeStart: 0n,
          timeEnd: 0n,
          isDomainDeal: false,
          domainName: "",
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
            timeoutSeconds: 3600n,
            timeStart: 0n,
            timeEnd: 0n,
            isDomainDeal: false,
            domainName: "",
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
            timeoutSeconds: 3600n,
            timeStart: 0n,
            timeEnd: 0n,
            isDomainDeal: false,
            domainName: "",
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
            timeoutSeconds: 3600n,
            timeStart: 0n,
            timeEnd: 0n,
            isDomainDeal: false,
            domainName: "",
          },
          trackCreator: false,
        },
      ]),
      /DealError\(42\)/,
    );
  });
});
