import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, parseEther, type Address, type Hex } from "viem";

const RUN = process.env.DEAL_FACTORY_AMOUNT_UPGRADE_FORK === "1";
const forkDescribe = RUN ? describe : describe.skip;
const ONE = 10n ** 18n;
const CURRENT_MESSAGE_PRICE = 104n * ONE;
const CANARY_MESSAGE_PRICE = 105n * ONE;
const CANARY_CREATE_BURN = 11n * ONE;
const PRODUCTION_GOVERNANCE_IMPLEMENTATION = getAddress(
  "0x7fC9145A2539F0eD52Cf6E7E34Ce485635A9887E",
);
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

type ForkName = "eth" | "bsc" | "base";

const FORKS: Record<ForkName, {
  networkName: "hardhatEthFork" | "hardhatBscFork" | "hardhatBaseFork";
  chainType: "l1" | "op";
  chainId: number;
  factory: Address;
}> = {
  eth: {
    networkName: "hardhatEthFork",
    chainType: "l1",
    chainId: 1,
    factory: "0x02330431f96b21776274f3147bd4c233caf7d752",
  },
  bsc: {
    networkName: "hardhatBscFork",
    chainType: "l1",
    chainId: 56,
    factory: "0x1Ca748Feb347d0d177E844E7D4CDCA908957c256",
  },
  base: {
    networkName: "hardhatBaseFork",
    chainType: "op",
    chainId: 8453,
    factory: "0x591625Be924B98ACcAb7e2c8aF698c858Aa2608D",
  },
};

async function waitFor(publicClient: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
  return receipt;
}

function implementationAddress(word: Hex): Address {
  return getAddress(`0x${word.slice(-40)}`);
}

async function snapshot(factory: any) {
  const [
    owner,
    admin,
    crossChainGovernance,
    dealImplementation,
    pairImplementation,
    minTimeoutSeconds,
    dlToken,
    infoNft,
    treasury,
    wrappedNative,
    swapOrderBook,
    dealMessageHub,
    creditGraph,
    dealActivityIndex,
    dealResultIndex,
    dealPairManager,
    dealNftGovernanceActivity,
    dealImplementationRegistry,
    dcDomainRank,
    recognizedToken0,
    recognizedToken1,
    defaultFeeNonDL,
    defaultMintOnFees,
    specialNoFeeToken,
    createBurnEnabled,
    createBurnPricingToken,
    createBurnAmountInToken,
    msgPriceEnabled,
    msgPriceToken,
    msgPriceAmountInToken,
    minWindowSec,
  ] = await Promise.all([
    factory.read.owner(),
    factory.read.admin(),
    factory.read.crossChainGovernance(),
    factory.read.dealImplementation(),
    factory.read.pairImplementation(),
    factory.read.minTimeoutSeconds(),
    factory.read.dlToken(),
    factory.read.infoNft(),
    factory.read.treasury(),
    factory.read.wrappedNative(),
    factory.read.swapOrderBook(),
    factory.read.dealMessageHub(),
    factory.read.creditGraph(),
    factory.read.dealActivityIndex(),
    factory.read.dealResultIndex(),
    factory.read.dealPairManager(),
    factory.read.dealNftGovernanceActivity(),
    factory.read.dealImplementationRegistry(),
    factory.read.dcDomainRank(),
    factory.read.recognizedToken0(),
    factory.read.recognizedToken1(),
    factory.read.defaultFeeNonDL(),
    factory.read.defaultMintOnFees(),
    factory.read.specialNoFeeToken(),
    factory.read.createBurnEnabled(),
    factory.read.createBurnPricingToken(),
    factory.read.createBurnAmountInToken(),
    factory.read.msgPriceEnabled(),
    factory.read.msgPriceToken(),
    factory.read.msgPriceAmountInToken(),
    factory.read.minWindowSec(),
  ]);
  return {
    owner: getAddress(owner),
    admin: getAddress(admin),
    crossChainGovernance: getAddress(crossChainGovernance),
    dealImplementation: getAddress(dealImplementation),
    pairImplementation: getAddress(pairImplementation),
    minTimeoutSeconds,
    dlToken: getAddress(dlToken),
    infoNft: getAddress(infoNft),
    treasury: getAddress(treasury),
    wrappedNative: getAddress(wrappedNative),
    swapOrderBook: getAddress(swapOrderBook),
    dealMessageHub: getAddress(dealMessageHub),
    creditGraph: getAddress(creditGraph),
    dealActivityIndex: getAddress(dealActivityIndex),
    dealResultIndex: getAddress(dealResultIndex),
    dealPairManager: getAddress(dealPairManager),
    dealNftGovernanceActivity: getAddress(dealNftGovernanceActivity),
    dealImplementationRegistry: getAddress(dealImplementationRegistry),
    dcDomainRank: getAddress(dcDomainRank),
    recognizedToken0: getAddress(recognizedToken0),
    recognizedToken1: getAddress(recognizedToken1),
    defaultFeeNonDL: [...defaultFeeNonDL],
    defaultMintOnFees: [...defaultMintOnFees],
    specialNoFeeToken: getAddress(specialNoFeeToken),
    createBurnEnabled,
    createBurnPricingToken: getAddress(createBurnPricingToken),
    createBurnAmountInToken,
    msgPriceEnabled,
    msgPriceToken: getAddress(msgPriceToken),
    msgPriceAmountInToken,
    minWindowSec,
  };
}

forkDescribe("DealFactory governance amount-setter UUPS upgrade", function () {
  it("preserves production storage and rehearses 104 -> 105 -> 104 plus 0 -> 11 -> 0", async function () {
    const forkName = (process.env.DEAL_FACTORY_AMOUNT_UPGRADE_CHAIN || "") as ForkName;
    assert.ok(FORKS[forkName], "DEAL_FACTORY_AMOUNT_UPGRADE_CHAIN must be eth, bsc or base");
    const config = FORKS[forkName];
    console.log(`[${forkName}] connecting fork`);
    let connection: Awaited<ReturnType<typeof network.connect>>;
    try {
      connection = await network.connect({
        network: config.networkName,
        chainType: config.chainType,
      });
    } catch (error) {
      console.error(`[${forkName}] fork connection failed`, error);
      throw new Error(`${forkName} fork connection failed`);
    }
    const { viem, networkHelpers } = connection;
    const publicClient = await viem.getPublicClient();
    assert.equal(await publicClient.getChainId(), config.chainId);
    console.log(`[${forkName}] fork connected`);
    const [deployer, outsider] = await viem.getWalletClients();
    assert.ok(deployer && outsider, "fork local wallets unavailable");

    const factoryBeforeUpgrade = await viem.getContractAt("DealFactory", config.factory);
    const before = await snapshot(factoryBeforeUpgrade);
    console.log(`[${forkName}] production storage snapshot captured`);
    assert.equal(before.msgPriceEnabled, true);
    assert.equal(before.msgPriceAmountInToken, CURRENT_MESSAGE_PRICE);
    assert.equal(before.createBurnEnabled, false);
    assert.equal(before.createBurnAmountInToken, 0n);

    const productionImplementationWord = await publicClient.getStorageAt({
      address: config.factory,
      slot: IMPLEMENTATION_SLOT,
    });
    assert.ok(productionImplementationWord);
    const productionImplementation = implementationAddress(productionImplementationWord);

    const factoryAsOutsiderBefore = await viem.getContractAt("DealFactory", config.factory, {
      client: { public: publicClient, wallet: outsider },
    });
    if (productionImplementation !== PRODUCTION_GOVERNANCE_IMPLEMENTATION) {
      await assert.rejects(
        factoryAsOutsiderBefore.write.setMessagePriceAmount([CURRENT_MESSAGE_PRICE]),
      );
      console.log(`[${forkName}] legacy implementation baseline verified`);
    } else {
      console.log(`[${forkName}] production governance implementation baseline verified`);
    }

    const newImplementation = await viem.deployContract("DealFactory", [], {
      client: { public: publicClient, wallet: deployer },
    });
    console.log(`[${forkName}] new implementation deployed at ${newImplementation.address}`);
    await networkHelpers.impersonateAccount(before.owner);
    await networkHelpers.setBalance(before.owner, parseEther("2"));
    const ownerWallet = await viem.getWalletClient(before.owner);
    const factoryAsOwner = await viem.getContractAt("DealFactory", config.factory, {
      client: { public: publicClient, wallet: ownerWallet },
    });
    await waitFor(
      publicClient,
      await factoryAsOwner.write.upgradeToAndCall([newImplementation.address, "0x"]),
    );
    console.log(`[${forkName}] proxy upgraded on fork`);

    const implementationWord = await publicClient.getStorageAt({
      address: config.factory,
      slot: IMPLEMENTATION_SLOT,
    });
    assert.ok(implementationWord);
    assert.equal(implementationAddress(implementationWord), getAddress(newImplementation.address));

    const factory = await viem.getContractAt("DealFactory", config.factory);
    assert.deepEqual(await snapshot(factory), before, "storage changed during implementation upgrade");
    console.log(`[${forkName}] post-upgrade storage parity verified`);

    await networkHelpers.impersonateAccount(before.crossChainGovernance);
    await networkHelpers.setBalance(before.crossChainGovernance, parseEther("2"));
    const governanceWallet = await viem.getWalletClient(before.crossChainGovernance);
    const factoryAsGovernance = await viem.getContractAt("DealFactory", config.factory, {
      client: { public: publicClient, wallet: governanceWallet },
    });
    const factoryAsOutsider = await viem.getContractAt("DealFactory", config.factory, {
      client: { public: publicClient, wallet: outsider },
    });

    // The production broadcaster sends one identical payload to every active
    // destination. A destination that already runs this implementation must
    // therefore accept the replay without changing protocol state.
    await waitFor(
      publicClient,
      await factoryAsGovernance.write.upgradeToAndCall([newImplementation.address, "0x"]),
    );
    assert.deepEqual(
      await snapshot(factory),
      before,
      "same-implementation replay changed production state",
    );

    await assert.rejects(factoryAsOutsider.write.setMessagePriceAmount([CANARY_MESSAGE_PRICE]));
    await assert.rejects(factoryAsOutsider.write.setCreateBurnAmount([CANARY_CREATE_BURN]));
    await assert.rejects(factoryAsOutsider.write.setTreasury([outsider.account.address]));
    await assert.rejects(factoryAsOutsider.write.setSpecialNoFeeToken([outsider.account.address]));
    await assert.rejects(factoryAsOutsider.write.setAdmin([outsider.account.address]));

    await waitFor(
      publicClient,
      await factoryAsGovernance.write.setMessagePriceAmount([CANARY_MESSAGE_PRICE]),
    );
    assert.equal(await factory.read.msgPriceAmountInToken(), CANARY_MESSAGE_PRICE);
    assert.equal(await factory.read.msgPriceEnabled(), before.msgPriceEnabled);
    assert.equal(getAddress(await factory.read.msgPriceToken()), before.msgPriceToken);

    await waitFor(
      publicClient,
      await factoryAsGovernance.write.setMessagePriceAmount([CURRENT_MESSAGE_PRICE]),
    );
    await waitFor(
      publicClient,
      await factoryAsGovernance.write.setCreateBurnAmount([CANARY_CREATE_BURN]),
    );
    assert.equal(await factory.read.createBurnAmountInToken(), CANARY_CREATE_BURN);
    assert.equal(await factory.read.createBurnEnabled(), before.createBurnEnabled);
    assert.equal(getAddress(await factory.read.createBurnPricingToken()), before.createBurnPricingToken);

    await waitFor(
      publicClient,
      await factoryAsGovernance.write.setCreateBurnAmount([0n]),
    );
    await waitFor(
      publicClient,
      await factoryAsGovernance.write.setTreasury([outsider.account.address]),
    );
    await waitFor(
      publicClient,
      await factoryAsGovernance.write.setSpecialNoFeeToken([outsider.account.address]),
    );
    await waitFor(
      publicClient,
      await factoryAsGovernance.write.setAdmin([outsider.account.address]),
    );
    assert.equal(getAddress(await factory.read.treasury()), getAddress(outsider.account.address));
    assert.equal(getAddress(await factory.read.specialNoFeeToken()), getAddress(outsider.account.address));
    assert.equal(getAddress(await factory.read.admin()), getAddress(outsider.account.address));

    await waitFor(
      publicClient,
      await factoryAsGovernance.write.setTreasury([before.treasury]),
    );
    await waitFor(
      publicClient,
      await factoryAsGovernance.write.setSpecialNoFeeToken([before.specialNoFeeToken]),
    );
    await waitFor(
      publicClient,
      await factoryAsGovernance.write.setAdmin([before.admin]),
    );
    assert.deepEqual(await snapshot(factory), before, "restoration did not reproduce production state");

    // Once this implementation is active, the DAO/executor — not only the
    // legacy local owner — must be able to authorize future UUPS upgrades.
    const governanceUpgrade = await viem.deployContract("DealFactory", [], {
      client: { public: publicClient, wallet: deployer },
    });
    await assert.rejects(
      factoryAsOutsider.write.upgradeToAndCall([governanceUpgrade.address, "0x"]),
    );
    await waitFor(
      publicClient,
      await factoryAsGovernance.write.upgradeToAndCall([governanceUpgrade.address, "0x"]),
    );
    const governanceImplementationWord = await publicClient.getStorageAt({
      address: config.factory,
      slot: IMPLEMENTATION_SLOT,
    });
    assert.ok(governanceImplementationWord);
    assert.equal(
      implementationAddress(governanceImplementationWord),
      getAddress(governanceUpgrade.address),
    );
    assert.deepEqual(await snapshot(factory), before, "governance upgrade changed production state");
    console.log(`[${forkName}] amount canaries restored exactly`);
  });
});
