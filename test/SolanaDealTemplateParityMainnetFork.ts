import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  getAddress,
  parseEther,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";

const RUN_FORK = process.env.SOLANA_DEAL_TEMPLATE_PARITY_FORK === "1";
const describeFork = RUN_FORK ? describe : describe.skip;

type Deployment = {
  chainId: number;
  deployer: Address;
  addresses: Record<string, Address>;
  abi: Record<string, Abi>;
};

type TemplateVector = {
  name: string;
  template_type: number;
  open_fast: boolean;
  a_swap: number;
  b_swap: number;
  a_asset: boolean;
  b_asset: boolean;
  valid: boolean;
  implementation_key?: string;
};

async function waitFor(publicClient: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `fork transaction failed: ${hash}`);
  return receipt;
}

describeFork("Solana template parity against ETH mainnet Factory", function () {
  it("uses the same shape vectors and production implementation routes", async function () {
    const deployment = JSON.parse(
      readFileSync("deployments/eth-mainnet-1.json", "utf8"),
    ) as Deployment;
    const vectors = JSON.parse(
      readFileSync("solana/fixtures/deal-template-shapes.json", "utf8"),
    ) as TemplateVector[];
    assert.equal(deployment.chainId, 1);
    assert.equal(vectors.filter((vector) => vector.valid).length, 9);
    assert.equal(vectors.filter((vector) => !vector.valid).length, 6);

    const { viem } = await network.connect({
      network: "hardhatEthFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    const [alice, bob] = await viem.getWalletClients();
    assert.ok(alice && bob);

    const factoryAddress = getAddress(deployment.addresses.dealFactory);
    const registryAddress = getAddress(
      deployment.addresses.dealImplementationRegistry,
    );
    const dcAddress = getAddress(deployment.addresses.dlToken);
    const factory = await viem.getContractAt("DealFactory", factoryAddress, {
      client: { public: publicClient, wallet: alice },
    });
    const registry = await viem.getContractAt(
      "DealImplementationRegistry",
      registryAddress,
    );
    assert.equal(
      getAddress(await factory.read.dealImplementationRegistry()),
      registryAddress,
    );

    const implementationGetters: ReadonlyArray<
      readonly [string, keyof typeof registry.read]
    > = [
      ["dealImplementation", "fallbackImplementation"],
      ["dealNoAssetImplementation", "noAssetImplementation"],
      ["dealAAssetNftImplementation", "aAssetNftImplementation"],
      ["dealBAssetNftImplementation", "bAssetNftImplementation"],
      ["dealAAssetNftOnlyImplementation", "aAssetNftOnlyImplementation"],
      ["dealBAssetNftOnlyImplementation", "bAssetNftOnlyImplementation"],
      ["dealOpenTokenTokenImplementation", "openTokenTokenImplementation"],
    ];
    for (const [deploymentKey, getter] of implementationGetters) {
      const actual = await (registry.read[getter] as () => Promise<Address>)();
      assert.equal(
        getAddress(actual),
        getAddress(deployment.addresses[deploymentKey]),
        `${deploymentKey} registry slot drift`,
      );
    }

    const assetNft = await viem.deployContract("TestERC721");
    await waitFor(
      publicClient,
      await assetNft.write.mint([alice.account.address]),
    );
    await waitFor(
      publicClient,
      await assetNft.write.mint([bob.account.address]),
    );
    const aAssetId = 1n;
    const bAssetId = 2n;

    const initFor = (vector: TemplateVector) => ({
      aSwapToken: vector.a_swap > 0 ? dcAddress : zeroAddress,
      aSwapAmount: BigInt(vector.a_swap),
      aMarginToken: zeroAddress,
      aMarginAmount: 0n,
      bSwapToken: vector.b_swap > 0 ? dcAddress : zeroAddress,
      bSwapAmount: BigInt(vector.b_swap),
      bMarginToken: zeroAddress,
      bMarginAmount: 0n,
      aAssetNft: vector.a_asset ? assetNft.address : zeroAddress,
      aAssetNftId: vector.a_asset ? aAssetId : 0n,
      bAssetNft: vector.b_asset ? assetNft.address : zeroAddress,
      bAssetNftId: vector.b_asset ? bAssetId : 0n,
      templateType: vector.template_type,
      joinMode: 0,
      expectedB: zeroAddress,
      gateNftId: 0n,
      aNftId: 0n,
      title: `Template parity: ${vector.name}`,
      description: "ETH mainnet fork oracle; no real-chain transaction",
      timeoutSeconds: 3_600n,
      replaceTimeoutSeconds: vector.open_fast ? 60n : 0n,
      isDomainDeal: false,
      domainName: "",
      openTokenTokenFast: vector.open_fast,
    });

    for (const vector of vectors) {
      const init = initFor(vector);
      const simulation = () =>
        publicClient.simulateContract({
          account: alice.account,
          address: factoryAddress,
          abi: factory.abi,
          functionName: "createDeal",
          args: [{ init, trackCreator: false }],
        } as any);

      if (!vector.valid) {
        await assert.rejects(simulation(), undefined, vector.name);
        continue;
      }

      assert.ok(vector.implementation_key, `${vector.name}: route missing`);
      const expectedImplementation = getAddress(
        deployment.addresses[vector.implementation_key],
      );
      const resolvedImplementation = await registry.read.resolveImplementation([
        vector.template_type,
        vector.open_fast,
        vector.a_asset ? aAssetId : 0n,
        vector.b_asset ? bAssetId : 0n,
      ]);
      assert.equal(
        getAddress(resolvedImplementation),
        expectedImplementation,
        `${vector.name}: registry route drift`,
      );

      const receipt = await waitFor(
        publicClient,
        await factory.write.createDeal(
          [{ init, trackCreator: false }],
          { gas: 3_000_000n },
        ),
      );
      const events = await publicClient.getContractEvents({
        address: factoryAddress,
        abi: factory.abi,
        eventName: "DealCreated",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
        strict: true,
      });
      assert.equal(events.length, 1, `${vector.name}: DealCreated count`);
      const deal = getAddress(events[0].args.deal);
      const code = await publicClient.getBytecode({ address: deal });
      assert.ok(
        code
          ?.toLowerCase()
          .includes(expectedImplementation.slice(2).toLowerCase()),
        `${vector.name}: clone does not target ${expectedImplementation}`,
      );
    }

    console.log(
      "ETH fork template oracle passed: 9 valid routes, 6 invalid shapes",
    );
  });

  it("settles every valid template with exact DC and NFT final-state invariants", async function () {
    const deployment = JSON.parse(
      readFileSync("deployments/eth-mainnet-1.json", "utf8"),
    ) as Deployment;
    const vectors = (
      JSON.parse(
        readFileSync("solana/fixtures/deal-template-shapes.json", "utf8"),
      ) as TemplateVector[]
    ).filter((vector) => vector.valid);
    assert.equal(vectors.length, 9);

    const { viem, networkHelpers } = await network.connect({
      network: "hardhatEthFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    const [alice, bob] = await viem.getWalletClients();
    assert.ok(alice && bob);

    const factoryAddress = getAddress(deployment.addresses.dealFactory);
    const dcAddress = getAddress(deployment.addresses.dlToken);
    const factory = await viem.getContractAt("DealFactory", factoryAddress, {
      client: { public: publicClient, wallet: alice },
    });
    const dcAlice = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: alice },
    });
    const dcBob = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: bob },
    });
    const treasury = getAddress(await factory.read.treasury());

    const mainnetDeployer = getAddress(deployment.deployer);
    await networkHelpers.impersonateAccount(mainnetDeployer);
    await networkHelpers.setBalance(mainnetDeployer, parseEther("10"));
    const minter = await viem.getWalletClient(mainnetDeployer);
    const dcMinter = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: minter },
    });
    await waitFor(
      publicClient,
      await dcMinter.write.mint([
        alice.account.address,
        parseEther("1000000"),
      ]),
    );
    await waitFor(
      publicClient,
      await dcMinter.write.mint([
        bob.account.address,
        parseEther("1000000"),
      ]),
    );

    const assetNft = await viem.deployContract("TestERC721");
    const assetNftAlice = await viem.getContractAt(
      "TestERC721",
      assetNft.address,
      { client: { public: publicClient, wallet: alice } },
    );
    const assetNftBob = await viem.getContractAt(
      "TestERC721",
      assetNft.address,
      { client: { public: publicClient, wallet: bob } },
    );
    const aAmount = parseEther("10000");
    const bAmount = parseEther("20000");

    for (const [index, vector] of vectors.entries()) {
      const aAssetId = BigInt(index * 2 + 1);
      const bAssetId = BigInt(index * 2 + 2);
      await waitFor(
        publicClient,
        await assetNft.write.mint([alice.account.address]),
      );
      await waitFor(
        publicClient,
        await assetNft.write.mint([bob.account.address]),
      );

      const init = {
        aSwapToken: vector.a_swap > 0 ? dcAddress : zeroAddress,
        aSwapAmount: vector.a_swap > 0 ? aAmount : 0n,
        aMarginToken: zeroAddress,
        aMarginAmount: 0n,
        bSwapToken: vector.b_swap > 0 ? dcAddress : zeroAddress,
        bSwapAmount: vector.b_swap > 0 ? bAmount : 0n,
        bMarginToken: zeroAddress,
        bMarginAmount: 0n,
        aAssetNft: vector.a_asset ? assetNft.address : zeroAddress,
        aAssetNftId: vector.a_asset ? aAssetId : 0n,
        bAssetNft: vector.b_asset ? assetNft.address : zeroAddress,
        bAssetNftId: vector.b_asset ? bAssetId : 0n,
        templateType: vector.template_type,
        joinMode: 0,
        expectedB: zeroAddress,
        gateNftId: 0n,
        aNftId: 0n,
        title: `Final-state parity: ${vector.name}`,
        description: "ETH mainnet fork settlement oracle",
        timeoutSeconds: 3_600n,
        replaceTimeoutSeconds: vector.open_fast ? 120n : 0n,
        isDomainDeal: false,
        domainName: "",
        openTokenTokenFast: vector.open_fast,
      };
      const createReceipt = await waitFor(
        publicClient,
        await factory.write.createDeal(
          [{ init, trackCreator: false }],
          { gas: 3_000_000n },
        ),
      );
      const created = await publicClient.getContractEvents({
        address: factoryAddress,
        abi: factory.abi,
        eventName: "DealCreated",
        fromBlock: createReceipt.blockNumber,
        toBlock: createReceipt.blockNumber,
        strict: true,
      });
      assert.equal(created.length, 1, `${vector.name}: DealCreated count`);
      const dealAddress = getAddress(created[0].args.deal);
      const dealAlice = await viem.getContractAt("Deal", dealAddress, {
        client: { public: publicClient, wallet: alice },
      });
      const dealBob = await viem.getContractAt("Deal", dealAddress, {
        client: { public: publicClient, wallet: bob },
      });

      if (vector.a_swap > 0) {
        await waitFor(
          publicClient,
          await dcAlice.write.approve([dealAddress, aAmount]),
        );
      }
      if (vector.b_swap > 0) {
        await waitFor(
          publicClient,
          await dcBob.write.approve([dealAddress, bAmount]),
        );
      }
      if (vector.a_asset) {
        await waitFor(
          publicClient,
          await assetNftAlice.write.approve([dealAddress, aAssetId]),
        );
      }
      if (vector.b_asset) {
        await waitFor(
          publicClient,
          await assetNftBob.write.approve([dealAddress, bAssetId]),
        );
      }

      const aliceBefore = await dcAlice.read.balanceOf([
        alice.account.address,
      ]);
      const bobBefore = await dcAlice.read.balanceOf([bob.account.address]);
      const treasuryBefore = await dcAlice.read.balanceOf([treasury]);
      const supplyBefore = await dcAlice.read.totalSupply();

      if (vector.open_fast) {
        const fastAlice = await viem.getContractAt(
          "DealOpenTokenToken",
          dealAddress,
          { client: { public: publicClient, wallet: alice } },
        );
        await waitFor(
          publicClient,
          await dealAlice.write.pay({ gas: 700_000n }),
        );
        await waitFor(
          publicClient,
          await fastAlice.write.preAccept({ gas: 400_000n }),
        );
        await waitFor(
          publicClient,
          await dealBob.write.join([0n, false], { gas: 700_000n }),
        );
        await waitFor(
          publicClient,
          await dealBob.write.pay({ gas: 700_000n }),
        );
      } else {
        await waitFor(
          publicClient,
          await dealBob.write.join([0n, false], { gas: 700_000n }),
        );
        if (vector.a_swap > 0 || vector.a_asset) {
          await waitFor(
            publicClient,
            await dealAlice.write.pay({ gas: 700_000n }),
          );
        }
        if (vector.b_swap > 0 || vector.b_asset) {
          await waitFor(
            publicClient,
            await dealBob.write.pay({ gas: 700_000n }),
          );
        }
      }
      assert.equal(
        Number(await dealAlice.read.status()),
        2,
        `${vector.name}: must lock`,
      );
      await waitFor(
        publicClient,
        await dealAlice.write.setMyVote([1], { gas: 700_000n }),
      );
      await waitFor(
        publicClient,
        await dealBob.write.setMyVote([1], { gas: 2_000_000n }),
      );

      const bothDc = vector.a_swap > 0 && vector.b_swap > 0;
      const aFee = bothDc ? aAmount / 1_000n : 0n;
      const bFee = bothDc ? bAmount / 1_000n : 0n;
      const aliceAfter = await dcAlice.read.balanceOf([alice.account.address]);
      const bobAfter = await dcAlice.read.balanceOf([bob.account.address]);
      const treasuryAfter = await dcAlice.read.balanceOf([treasury]);

      assert.equal(
        Number(await dealAlice.read.status()),
        3,
        `${vector.name}: status`,
      );
      assert.equal(await dealAlice.read.aPaid(), false, `${vector.name}: aPaid`);
      assert.equal(await dealAlice.read.bPaid(), false, `${vector.name}: bPaid`);
      if (!vector.open_fast) {
        assert.equal(
          await dealAlice.read.aClaimed(),
          true,
          `${vector.name}: aClaimed`,
        );
        assert.equal(
          await dealAlice.read.bClaimed(),
          true,
          `${vector.name}: bClaimed`,
        );
      }
      assert.equal(
        await dcAlice.read.balanceOf([dealAddress]),
        0n,
        `${vector.name}: residual DC`,
      );
      if (!vector.open_fast) {
        assert.equal(
          await dealAlice.read.aSwapNetForB(),
          vector.a_swap > 0 ? aAmount - aFee : 0n,
          `${vector.name}: A net`,
        );
        assert.equal(
          await dealAlice.read.bSwapNetForA(),
          vector.b_swap > 0 ? bAmount - bFee : 0n,
          `${vector.name}: B net`,
        );
      }
      assert.equal(
        aliceAfter - aliceBefore,
        (vector.b_swap > 0 ? bAmount - bFee : 0n) -
          (vector.a_swap > 0 ? aAmount : 0n),
        `${vector.name}: Alice DC delta`,
      );
      assert.equal(
        bobAfter - bobBefore,
        (vector.a_swap > 0 ? aAmount - aFee : 0n) -
          (vector.b_swap > 0 ? bAmount : 0n),
        `${vector.name}: Bob DC delta`,
      );
      assert.equal(
        treasuryAfter - treasuryBefore,
        0n,
        `${vector.name}: treasury DC delta`,
      );
      assert.equal(
        await dcAlice.read.totalSupply(),
        supplyBefore - aFee - bFee,
        `${vector.name}: DC/DC burn or reward inflation`,
      );
      if (vector.a_asset) {
        assert.equal(
          getAddress(await assetNft.read.ownerOf([aAssetId])),
          getAddress(bob.account.address),
          `${vector.name}: A NFT owner`,
        );
      }
      if (vector.b_asset) {
        assert.equal(
          getAddress(await assetNft.read.ownerOf([bAssetId])),
          getAddress(alice.account.address),
          `${vector.name}: B NFT owner`,
        );
      }
    }

    console.log(
      "ETH fork final-state oracle passed: 9/9 templates settled with exact DC/NFT invariants",
    );
  });

  it("proves production DC/DC fees burn without C and aggregate to the strict CreditGraph winner", async function () {
    const deployment = JSON.parse(
      readFileSync("deployments/eth-mainnet-1.json", "utf8"),
    ) as Deployment;
    const { viem, networkHelpers } = await network.connect({
      network: "hardhatEthFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    const [alice, bob] = await viem.getWalletClients();
    assert.ok(alice && bob);

    const factoryAddress = getAddress(deployment.addresses.dealFactory);
    const dcAddress = getAddress(deployment.addresses.dlToken);
    const infoAddress = getAddress(deployment.addresses.dealInfoNFT);
    const graphAddress = getAddress(deployment.addresses.dealCreditGraph);
    const factory = await viem.getContractAt("DealFactory", factoryAddress, {
      client: { public: publicClient, wallet: alice },
    });
    const dcAlice = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: alice },
    });
    const dcBob = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: bob },
    });
    const info = await viem.getContractAt("DealInfoNFT", infoAddress);
    const infoAlice = await viem.getContractAt("DealInfoNFT", infoAddress, {
      client: { public: publicClient, wallet: alice },
    });
    const infoBob = await viem.getContractAt("DealInfoNFT", infoAddress, {
      client: { public: publicClient, wallet: bob },
    });
    const graph = await viem.getContractAt("DealCreditGraph", graphAddress);
    assert.equal(getAddress(await factory.read.creditGraph()), graphAddress);
    assert.equal(getAddress(await graph.read.infoNft()), infoAddress);

    const mainnetDeployer = getAddress(deployment.deployer);
    await networkHelpers.impersonateAccount(mainnetDeployer);
    await networkHelpers.setBalance(mainnetDeployer, parseEther("10"));
    const minter = await viem.getWalletClient(mainnetDeployer);
    const dcMinter = await viem.getContractAt("DCToken", dcAddress, {
      client: { public: publicClient, wallet: minter },
    });
    for (const wallet of [alice, bob]) {
      await waitFor(
        publicClient,
        await dcMinter.write.mint([
          wallet.account.address,
          parseEther("2000000"),
        ]),
      );
    }

    const mintPrice = await info.read.mintPriceDL();
    assert.ok(mintPrice > 0n);
    await waitFor(
      publicClient,
      await dcAlice.write.approve([infoAddress, mintPrice]),
    );
    const aliceInfoId = await info.read.nextId();
    await waitFor(publicClient, await infoAlice.write.mintByBurn());
    await waitFor(
      publicClient,
      await dcBob.write.approve([infoAddress, mintPrice]),
    );
    const bobInfoId = await info.read.nextId();
    await waitFor(publicClient, await infoBob.write.mintByBurn());
    assert.equal(
      getAddress(await info.read.ownerOf([aliceInfoId])),
      getAddress(alice.account.address),
    );
    assert.equal(
      getAddress(await info.read.ownerOf([bobInfoId])),
      getAddress(bob.account.address),
    );

    const aAmount = parseEther("10000");
    const bAmount = parseEther("20000");
    const aFee = aAmount / 1_000n;
    const bFee = bAmount / 1_000n;
    const createDcDeal = async (title: string) => {
      const init = {
        aSwapToken: dcAddress,
        aSwapAmount: aAmount,
        aMarginToken: zeroAddress,
        aMarginAmount: 0n,
        bSwapToken: dcAddress,
        bSwapAmount: bAmount,
        bMarginToken: zeroAddress,
        bMarginAmount: 0n,
        aAssetNft: zeroAddress,
        aAssetNftId: 0n,
        bAssetNft: zeroAddress,
        bAssetNftId: 0n,
        templateType: 0,
        joinMode: 0,
        expectedB: zeroAddress,
        gateNftId: 0n,
        aNftId: aliceInfoId,
        title,
        description: "ETH mainnet fork C-fee oracle",
        timeoutSeconds: 3_600n,
        replaceTimeoutSeconds: 0n,
        isDomainDeal: false,
        domainName: "",
        openTokenTokenFast: false,
      };
      const receipt = await waitFor(
        publicClient,
        await factory.write.createDeal(
          [{ init, trackCreator: false }],
          { gas: 3_000_000n },
        ),
      );
      const created = await publicClient.getContractEvents({
        address: factoryAddress,
        abi: factory.abi,
        eventName: "DealCreated",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
        strict: true,
      });
      assert.equal(created.length, 1);
      const address = getAddress(created[0].args.deal);
      return {
        address,
        alice: await viem.getContractAt("Deal", address, {
          client: { public: publicClient, wallet: alice },
        }),
        bob: await viem.getContractAt("Deal", address, {
          client: { public: publicClient, wallet: bob },
        }),
      };
    };
    const settle = async (
      deal: Awaited<ReturnType<typeof createDcDeal>>,
      bInfoId: bigint,
    ) => {
      await waitFor(
        publicClient,
        await dcAlice.write.approve([deal.address, aAmount]),
      );
      await waitFor(
        publicClient,
        await dcBob.write.approve([deal.address, bAmount]),
      );
      await waitFor(
        publicClient,
        await deal.bob.write.join([bInfoId, false], { gas: 700_000n }),
      );
      await waitFor(publicClient, await deal.alice.write.pay({ gas: 700_000n }));
      await waitFor(publicClient, await deal.bob.write.pay({ gas: 700_000n }));
      await waitFor(
        publicClient,
        await deal.alice.write.setMyVote([1], { gas: 700_000n }),
      );
      await waitFor(
        publicClient,
        await deal.bob.write.setMyVote([1], { gas: 2_000_000n }),
      );
    };

    const noCDeal = await createDcDeal("DC/DC no-C burn oracle");
    const noCSupplyBefore = await dcAlice.read.totalSupply();
    await settle(noCDeal, 0n);
    assert.equal(
      await dcAlice.read.totalSupply(),
      noCSupplyBefore - aFee - bFee,
      "first deal must burn both fees because C is unresolved before credit recording",
    );
    const aliceScore = await graph.read.creditScore([aliceInfoId]);
    assert.ok(aliceScore > 0n, "first deal must seed Alice credit");
    assert.equal(await graph.read.creditScore([bobInfoId]), 0n);

    const cDeal = await createDcDeal("DC/DC strict-C transfer oracle");
    await waitFor(
      publicClient,
      await dcAlice.write.approve([cDeal.address, aAmount]),
    );
    await waitFor(
      publicClient,
      await dcBob.write.approve([cDeal.address, bAmount]),
    );
    await waitFor(
      publicClient,
      await cDeal.bob.write.join([bobInfoId, false], { gas: 700_000n }),
    );
    await waitFor(publicClient, await cDeal.alice.write.pay({ gas: 700_000n }));
    await waitFor(publicClient, await cDeal.bob.write.pay({ gas: 700_000n }));
    assert.equal(await cDeal.alice.read.aNftLocked(), true);
    assert.equal(await cDeal.alice.read.bNftLocked(), true);
    const [cToken, cOwner] = await graph.read.resolveCRewardTarget([
      alice.account.address,
      bob.account.address,
      aliceInfoId,
      true,
      bobInfoId,
      true,
    ]);
    assert.equal(cToken, aliceInfoId);
    assert.equal(getAddress(cOwner), getAddress(alice.account.address));

    const aliceBefore = await dcAlice.read.balanceOf([alice.account.address]);
    const bobBefore = await dcAlice.read.balanceOf([bob.account.address]);
    const supplyBefore = await dcAlice.read.totalSupply();
    await waitFor(
      publicClient,
      await cDeal.alice.write.setMyVote([1], { gas: 700_000n }),
    );
    await waitFor(
      publicClient,
      await cDeal.bob.write.setMyVote([1], { gas: 2_000_000n }),
    );
    assert.equal(
      (await dcAlice.read.balanceOf([alice.account.address])) - aliceBefore,
      bAmount - bFee + aFee + bFee,
      "Alice receives B net plus both DC fees as C",
    );
    assert.equal(
      (await dcAlice.read.balanceOf([bob.account.address])) - bobBefore,
      aAmount - aFee,
      "Bob receives only A net after his earlier escrow deposit",
    );
    assert.equal(
      await dcAlice.read.totalSupply(),
      supplyBefore,
      "C transfer must not burn or mint DC",
    );
    assert.equal(await dcAlice.read.balanceOf([cDeal.address]), 0n);

    console.log(
      "ETH fork C-fee oracle passed: no-C burns; strict CreditGraph winner receives aggregate A+B fees",
    );
  });
});
