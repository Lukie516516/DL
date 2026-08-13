import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  getAddress,
  parseEther,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

const RUN_FORK = process.env.SOLANA_DEAL_MODE_PARITY_FORK === "1";
const describeFork = RUN_FORK ? describe : describe.skip;
const READY = 0;
const LOCKED = 2;
const CANCELED = 4;
const ACCEPT = 1;
const REJECT = 2;

type Deployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
};

async function waitFor(publicClient: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `fork transaction failed: ${hash}`);
  return receipt;
}

describeFork("Solana Deal mode parity against ETH mainnet implementations", function () {
  it("matches ordinary reject and OpenTokenToken reject/replacement branches", async function () {
    const deployment = JSON.parse(
      readFileSync("deployments/eth-mainnet-1.json", "utf8"),
    ) as Deployment;
    assert.equal(deployment.chainId, 1);

    const { viem, networkHelpers } = await network.connect({
      network: "hardhatEthFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    const [alice, bob, carol, dave] = await viem.getWalletClients();
    assert.ok(alice && bob && carol && dave, "fork development wallets are missing");
    const testClient = await viem.getTestClient();

    const factoryAddress = getAddress(deployment.addresses.dealFactory);
    const dcAddress = getAddress(deployment.addresses.dlToken);
    const factoryAsAlice = await viem.getContractAt("DealFactory", factoryAddress, {
      client: { public: publicClient, wallet: alice },
    });

    const createDeal = async (openTokenTokenFast: boolean) => {
      const amount = openTokenTokenFast ? 100n * 10n ** 18n : 0n;
      const hash = await factoryAsAlice.write.createDeal([
        {
          init: {
            aSwapToken: openTokenTokenFast ? dcAddress : zeroAddress,
            aSwapAmount: amount,
            aMarginToken: zeroAddress,
            aMarginAmount: 0n,
            bSwapToken: openTokenTokenFast ? dcAddress : zeroAddress,
            bSwapAmount: amount,
            bMarginToken: zeroAddress,
            bMarginAmount: 0n,
            aAssetNft: zeroAddress,
            aAssetNftId: 0n,
            bAssetNft: zeroAddress,
            bAssetNftId: 0n,
            templateType: openTokenTokenFast ? 0 : 3,
            joinMode: 0,
            expectedB: zeroAddress,
            gateNftId: 0n,
            aNftId: 0n,
            title: openTokenTokenFast
              ? "Solana parity fast mode"
              : "Solana parity ordinary mode",
            description: "ETH mainnet fork oracle; no real-chain transaction",
            timeoutSeconds: 3_600n,
            replaceTimeoutSeconds: openTokenTokenFast ? 120n : 0n,
            isDomainDeal: false,
            domainName: "",
            openTokenTokenFast,
          },
          trackCreator: false,
        },
      ], { gas: 3_000_000n });
      const receipt = await waitFor(publicClient, hash);
      const events = await publicClient.getContractEvents({
        address: factoryAddress,
        abi: factoryAsAlice.abi,
        eventName: "DealCreated",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
        strict: true,
      });
      assert.equal(events.length, 1);
      return getAddress(events[0].args.deal);
    };

    const ordinaryAddress = await createDeal(false);
    const ordinaryA = await viem.getContractAt("DealNoAsset", ordinaryAddress, {
      client: { public: publicClient, wallet: alice },
    });
    const ordinaryB = await viem.getContractAt("DealNoAsset", ordinaryAddress, {
      client: { public: publicClient, wallet: bob },
    });
    await waitFor(publicClient, await ordinaryB.write.join([0n, false]));
    assert.equal(Number(await ordinaryA.read.status()), LOCKED);
    await waitFor(publicClient, await ordinaryB.write.setMyVote([REJECT]));
    assert.equal(Number(await ordinaryA.read.status()), LOCKED);
    assert.equal(getAddress(await ordinaryA.read.b()), getAddress(bob.account.address));
    assert.equal(Number(await ordinaryA.read.bVote()), REJECT);
    await waitFor(publicClient, await ordinaryA.write.setMyVote([REJECT]));
    assert.equal(Number(await ordinaryA.read.status()), CANCELED);

    const mainnetDeployer = getAddress(deployment.deployer);
    await networkHelpers.impersonateAccount(mainnetDeployer);
    await networkHelpers.setBalance(mainnetDeployer, parseEther("10"));
    const minterWallet = await viem.getWalletClient(mainnetDeployer);
    const dcAsMinter = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: minterWallet },
    });
    await waitFor(
      publicClient,
      await dcAsMinter.write.mint([alice.account.address, 1_000n * 10n ** 18n]),
    );
    await waitFor(
      publicClient,
      await dcAsMinter.write.mint([bob.account.address, 1_000n * 10n ** 18n]),
    );
    await waitFor(
      publicClient,
      await dcAsMinter.write.mint([dave.account.address, 200n * 10n ** 18n]),
    );

    const fastAddress = await createDeal(true);
    const fastA = await viem.getContractAt("DealOpenTokenToken", fastAddress, {
      client: { public: publicClient, wallet: alice },
    });
    const fastB = await viem.getContractAt("DealOpenTokenToken", fastAddress, {
      client: { public: publicClient, wallet: bob },
    });
    const dcAsAlice = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: alice },
    });
    const dcAsBob = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: bob },
    });
    await waitFor(publicClient, await dcAsAlice.write.approve([fastAddress, 100n * 10n ** 18n]));
    await waitFor(publicClient, await dcAsBob.write.approve([fastAddress, 100n * 10n ** 18n]));
    await waitFor(publicClient, await fastA.write.pay());
    await waitFor(publicClient, await fastA.write.preAccept());
    await waitFor(publicClient, await fastB.write.join([0n, false]));
    await waitFor(publicClient, await fastB.write.pay());
    assert.equal(Number(await fastA.read.status()), LOCKED);
    assert.equal(Number(await fastA.read.aVote()), ACCEPT);

    await waitFor(publicClient, await fastB.write.setMyVote([REJECT]));
    assert.equal(Number(await fastA.read.status()), READY);
    assert.equal(await fastA.read.b(), zeroAddress);
    assert.equal(await fastA.read.aPaid(), true);
    assert.equal(await fastA.read.aHasPreAccepted(), true);

    const activeReplacementAddress = await createDeal(true);
    const activeA = await viem.getContractAt(
      "DealOpenTokenToken",
      activeReplacementAddress,
      { client: { public: publicClient, wallet: alice } },
    );
    const activeB = await viem.getContractAt(
      "DealOpenTokenToken",
      activeReplacementAddress,
      { client: { public: publicClient, wallet: bob } },
    );
    const activeC = await viem.getContractAt(
      "DealOpenTokenToken",
      activeReplacementAddress,
      { client: { public: publicClient, wallet: carol } },
    );
    await waitFor(
      publicClient,
      await dcAsAlice.write.approve([
        activeReplacementAddress,
        100n * 10n ** 18n,
      ]),
    );
    await waitFor(publicClient, await activeA.write.pay());
    await waitFor(publicClient, await activeA.write.preAccept());
    await waitFor(publicClient, await activeB.write.join([0n, false]));
    assert.equal(Number(await activeA.read.status()), 1);
    await assert.rejects(
      activeC.simulate.replaceInactiveBAndJoin([0n, false]),
    );
    const inactiveBoundary =
      (await activeA.read.bJoinedAt()) +
      (await activeA.read.replaceTimeoutSeconds());
    await testClient.setNextBlockTimestamp({ timestamp: inactiveBoundary });
    await waitFor(
      publicClient,
      await activeC.write.replaceInactiveBAndJoin([0n, false]),
    );
    assert.equal(
      getAddress(await activeA.read.b()),
      getAddress(carol.account.address),
    );
    assert.equal(
      getAddress(await activeA.read.lastRemovedB()),
      getAddress(bob.account.address),
    );
    assert.equal(Number(await activeA.read.status()), 1);
    assert.equal(await activeA.read.aPaid(), true);
    assert.equal(await activeA.read.bPaid(), false);

    const lockedReplacementAddress = await createDeal(true);
    const lockedA = await viem.getContractAt(
      "DealOpenTokenToken",
      lockedReplacementAddress,
      { client: { public: publicClient, wallet: alice } },
    );
    const lockedB = await viem.getContractAt(
      "DealOpenTokenToken",
      lockedReplacementAddress,
      { client: { public: publicClient, wallet: bob } },
    );
    const lockedD = await viem.getContractAt(
      "DealOpenTokenToken",
      lockedReplacementAddress,
      { client: { public: publicClient, wallet: dave } },
    );
    const dcAsDave = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: dave },
    });
    await waitFor(
      publicClient,
      await dcAsAlice.write.approve([
        lockedReplacementAddress,
        100n * 10n ** 18n,
      ]),
    );
    await waitFor(
      publicClient,
      await dcAsBob.write.approve([
        lockedReplacementAddress,
        100n * 10n ** 18n,
      ]),
    );
    await waitFor(publicClient, await lockedA.write.pay());
    await waitFor(publicClient, await lockedA.write.preAccept());
    await waitFor(publicClient, await lockedB.write.join([0n, false]));
    await waitFor(publicClient, await lockedB.write.pay());
    await waitFor(publicClient, await lockedA.write.setMyVote([ACCEPT]));
    assert.equal(Number(await lockedA.read.status()), LOCKED);
    assert.equal(Number(await lockedA.read.aVote()), ACCEPT);
    assert.equal(Number(await lockedA.read.bVote()), 0);
    await assert.rejects(
      lockedD.simulate.replaceNonVotingBAndJoin([0n, false]),
    );
    const lockedAt = await lockedA.read.lockedAt();
    const aAt = await lockedA.read.aAt();
    const nonVotingBoundary =
      (lockedAt > aAt ? lockedAt : aAt) +
      (await lockedA.read.replaceTimeoutSeconds());
    const bobAfterDeposit = await dcAsBob.read.balanceOf([
      bob.account.address,
    ]);
    await testClient.setNextBlockTimestamp({ timestamp: nonVotingBoundary });
    await waitFor(
      publicClient,
      await lockedD.write.replaceNonVotingBAndJoin([0n, false]),
    );
    assert.equal(
      await dcAsBob.read.balanceOf([bob.account.address]),
      bobAfterDeposit + 100n * 10n ** 18n,
    );
    assert.equal(
      getAddress(await lockedA.read.b()),
      getAddress(dave.account.address),
    );
    assert.equal(Number(await lockedA.read.status()), 1);
    assert.equal(await lockedA.read.aPaid(), true);
    assert.equal(await lockedA.read.bPaid(), false);
    assert.equal(await lockedA.read.aHasPreAccepted(), true);
    assert.equal(Number(await lockedA.read.aVote()), 0);
    await waitFor(
      publicClient,
      await dcAsDave.write.approve([
        lockedReplacementAddress,
        100n * 10n ** 18n,
      ]),
    );
    await waitFor(publicClient, await lockedD.write.pay());
    assert.equal(Number(await lockedA.read.status()), LOCKED);
    assert.equal(Number(await lockedA.read.aVote()), ACCEPT);

    console.log(
      "ETH fork Deal mode oracle passed: ordinary reject, fast reject, " +
        "inactive replacement and non-voting replacement",
    );
  });
});
