import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  getAddress,
  maxUint64,
  zeroAddress,
  type Abi,
  type Address,
} from "viem";

const RUN_FORK = process.env.SOLANA_DEAL_CREATION_PARITY_FORK === "1";
const describeFork = RUN_FORK ? describe : describe.skip;

type Deployment = {
  chainId: number;
  addresses: Record<string, Address>;
  abi: Record<string, Abi>;
};

describeFork("Solana Deal creation parity against ETH mainnet Factory", function () {
  it("pins timeout, domain-entry and OpenTokenToken Fast validation boundaries", async function () {
    const deployment = JSON.parse(
      readFileSync("deployments/eth-mainnet-1.json", "utf8"),
    ) as Deployment;
    assert.equal(deployment.chainId, 1);

    const { viem } = await network.connect({
      network: "hardhatEthFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    const [alice, bob] = await viem.getWalletClients();
    assert.ok(alice && bob);

    const factory = getAddress(deployment.addresses.dealFactory);
    const dc = getAddress(deployment.addresses.dlToken);
    const abi = deployment.abi.DealFactory;
    assert.ok(abi);

    const base = {
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
      templateType: 3,
      joinMode: 0,
      expectedB: zeroAddress,
      gateNftId: 0n,
      aNftId: 0n,
      title: "Solana creation parity",
      description: "ETH mainnet fork oracle; no real-chain transaction",
      timeoutSeconds: 3_600n,
      replaceTimeoutSeconds: 0n,
      isDomainDeal: false,
      domainName: "",
      openTokenTokenFast: false,
    };

    const simulate = (init: typeof base) =>
      publicClient.simulateContract({
        account: alice.account,
        address: factory,
        abi,
        functionName: "createDeal",
        args: [{ init, trackCreator: false }],
      } as any);

    await simulate({ ...base, replaceTimeoutSeconds: maxUint64 });
    await assert.rejects(simulate({ ...base, timeoutSeconds: 3_599n }));
    await assert.rejects(
      simulate({
        ...base,
        isDomainDeal: true,
        domainName: "forged.eth",
      }),
    );

    // The production Factory accepts this configuration even though party A
    // can never join as B. Solana keeps the same creation boundary; the join
    // instruction independently rejects creator == participant.
    await simulate({
      ...base,
      joinMode: 1,
      expectedB: getAddress(alice.account.address),
    });

    const fast = {
      ...base,
      aSwapToken: dc,
      aSwapAmount: 1n,
      bSwapToken: dc,
      bSwapAmount: 1n,
      templateType: 0,
      replaceTimeoutSeconds: 60n,
      openTokenTokenFast: true,
    };
    await simulate({ ...fast, joinMode: 2 });
    await assert.rejects(
      simulate({
        ...fast,
        joinMode: 3,
        expectedB: getAddress(bob.account.address),
      }),
    );
    await assert.rejects(
      simulate({
        ...fast,
        templateType: 3,
        aSwapToken: zeroAddress,
        aSwapAmount: 0n,
        bSwapToken: zeroAddress,
        bSwapAmount: 0n,
      }),
    );

    console.log(
      "ETH fork creation oracle passed: minTimeout=3600, directDomain=blocked, " +
        "ordinaryReplace=unbounded, fastJoinMode<=2",
    );
  });
});
