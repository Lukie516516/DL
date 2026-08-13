import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  padHex,
  parseEther,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";

import { BASE_MAINNET } from "../scripts/lib/evm-chain-config.js";

const RUN_FORK = process.env.BASE_CROSS_CHAIN_V2_MAINNET_FORK === "1";
const forkDescribe = RUN_FORK ? describe : describe.skip;
const ETH_LZ_EID = 30101;
const ETH_CCIP_SELECTOR = 5_009_297_550_715_157_269n;
const ETH_BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");

type GasRow = { label: string; gasUsed: bigint; l1Fee: bigint; nativeCost: bigint };

forkDescribe("Base CrossChain V2 mainnet fork", function () {
  it("hands Base protocol authority to the 2-of-3 executor and exercises DAO-only paths", async function () {
    const { viem, networkHelpers } = await network.connect({
      network: "hardhatBaseFork",
      chainType: "op",
    });
    const publicClient = await viem.getPublicClient();
    const [deployer, outsider] = await viem.getWalletClients();
    const client = { public: publicClient, wallet: deployer } as const;
    assert.equal(await publicClient.getChainId(), BASE_MAINNET.chainId);

    const gasRows: GasRow[] = [];
    async function waitFor(hash: Hex, label: string, countGas = false) {
      const receipt: any = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success", `${label} failed: ${hash}`);
      if (countGas) {
        const gasUsed = BigInt(receipt.gasUsed ?? 0n);
        const gasPrice = BigInt(receipt.effectiveGasPrice ?? 0n);
        const l1Fee = receipt.l1Fee === undefined ? 0n : BigInt(receipt.l1Fee);
        gasRows.push({ label, gasUsed, l1Fee, nativeCost: gasUsed * gasPrice + l1Fee });
      }
      return receipt;
    }

    const dealImplementation = await viem.deployContract("Deal", [], { client });
    const pairImplementation = await viem.deployContract("DealSwapTemplate", [], { client });
    const factoryImplementation = await viem.deployContract("DealFactory", [], { client });
    const factoryProxy = await viem.deployContract(
      "ERC1967Proxy",
      [
        factoryImplementation.address,
        encodeFunctionData({
          abi: factoryImplementation.abi,
          functionName: "initialize",
          args: [dealImplementation.address, pairImplementation.address, 3600n],
        }),
      ],
      { client },
    );
    const factory = await viem.getContractAt("DealFactory", factoryProxy.address, { client });
    const dc = await viem.deployContract(
      "DCToken",
      ["DealCoin", "DC", 0n, deployer.account.address, deployer.account.address],
      { client },
    );
    const treasury = await viem.deployContract(
      "ProtocolTreasury",
      [deployer.account.address, deployer.account.address],
      { client },
    );
    const sent = await viem.sendDeploymentTransaction(
      "DualBridgeExecutorV2",
      [
        BASE_MAINNET.lzEndpoint,
        deployer.account.address,
        BASE_MAINNET.ccipRouter,
        ETH_CCIP_SELECTOR,
        ETH_BROADCASTER,
        BASE_MAINNET.axelarGateway,
        "Ethereum",
        ETH_BROADCASTER,
        2n,
      ],
      { client },
    );
    await waitFor(sent.deploymentTransaction.hash, "executor deployment", true);
    const executor = sent.contract;
    const broadcasterBytes32 = padHex(ETH_BROADCASTER, { size: 32 });

    const pairManager = await viem.deployContract("DealPairManager", [factory.address], { client });
    const implementationRegistry = await viem.deployContract("DealImplementationRegistry", [], { client });
    const infoNft = await viem.deployContract(
      "DealInfoNFT",
      [factory.address, zeroAddress, 100n * 10n ** 18n],
      { client },
    );
    const creditGraph = await viem.deployContract("DealCreditGraph", [infoNft.address], { client });
    const orderBook = await viem.deployContract("DealSwapOrderBook", [treasury.address], { client });
    const assetRegistry = await viem.deployContract(
      "DealSwapAssetRegistry",
      [
        deployer.account.address,
        pairManager.address,
        outsider.account.address,
        dc.address,
        BASE_MAINNET.weth,
        BASE_MAINNET.usdt,
        BASE_MAINNET.usdc,
      ],
      { client },
    );
    const dcDomain = await viem.deployContract("DCDomain", [dc.address, treasury.address], { client });
    const rankImplementation = await viem.deployContract("DCDomainRank", [], { client });
    const rankProxy = await viem.deployContract(
      "ERC1967Proxy",
      [
        rankImplementation.address,
        encodeFunctionData({
          abi: rankImplementation.abi,
          functionName: "initialize",
          args: [dc.address, dcDomain.address, treasury.address],
        }),
      ],
      { client },
    );
    const dcRank = await viem.getContractAt("DCDomainRank", rankProxy.address, { client });
    const dcMarket = await viem.deployContract(
      "DCDomainMarket",
      [dcDomain.address, dc.address, treasury.address, 100n],
      { client },
    );
    const dcSwap = await viem.deployContract(
      "DCDomainSwap",
      [dcDomain.address, dcRank.address, factory.address],
      { client },
    );

    const governanceTargets: Array<[string, Address]> = [
      ["Self", executor.address],
      ["Factory", factory.address],
      ["DC", dc.address],
      ["Treasury", treasury.address],
      ["PairManager", pairManager.address],
      ["ImplementationRegistry", implementationRegistry.address],
      ["InfoNFT", infoNft.address],
      ["CreditGraph", creditGraph.address],
      ["OrderBook", orderBook.address],
      ["AssetRegistry", assetRegistry.address],
      ["DCDomain", dcDomain.address],
      ["DCDomainRank", dcRank.address],
      ["DCDomainMarket", dcMarket.address],
      ["DCDomainSwap", dcSwap.address],
    ];
    const executorSetupWrites: Array<[string, () => Promise<Hex>]> = [
      ["executor.setPeer", () => executor.write.setPeer([ETH_LZ_EID, broadcasterBytes32])],
      ...governanceTargets.map(([label, target]) => [
        `executor.allow${label}`,
        () => executor.write.setAllowedTarget([target, true]),
      ] as [string, () => Promise<Hex>]),
      ["executor.setDelegate", () => executor.write.setDelegate([executor.address])],
    ];
    for (const [label, write] of executorSetupWrites) {
      await waitFor(await write(), label, true);
    }

    await waitFor(
      await factory.write.setCrossChainGovernance([executor.address]),
      "factory.setCrossChainGovernance",
      true,
    );
    await waitFor(await factory.write.setAdmin([executor.address]), "factory.setAdmin", true);
    await waitFor(
      await factory.write.transferOwnership([executor.address]),
      "factory.transferOwnership",
      true,
    );
    await waitFor(
      await treasury.write.bootstrapSetController([executor.address]),
      "treasury.setController",
      true,
    );
    await waitFor(await treasury.write.lockBootstrap(), "treasury.lockBootstrap", true);

    const minterRole = await dc.read.MINTER_ROLE();
    const pauserRole = await dc.read.PAUSER_ROLE();
    const adminRole = await dc.read.DEFAULT_ADMIN_ROLE();
    await waitFor(await dc.write.grantRole([minterRole, factory.address]), "dc.grantFactoryMinter", true);
    await waitFor(await dc.write.grantRole([minterRole, executor.address]), "dc.grantExecutorMinter", true);
    await waitFor(await dc.write.grantRole([pauserRole, executor.address]), "dc.grantExecutorPauser", true);
    await waitFor(await dc.write.grantRole([adminRole, executor.address]), "dc.grantExecutorAdmin", true);
    await waitFor(
      await dc.write.renounceRole([minterRole, deployer.account.address]),
      "dc.renounceDeployerMinter",
      true,
    );
    await waitFor(
      await dc.write.renounceRole([adminRole, deployer.account.address]),
      "dc.renounceDeployerAdmin",
      true,
    );

    const auxiliaryHandoffs: Array<[string, () => Promise<Hex>]> = [
      ["pairManager.transferOwner", () => pairManager.write.transferOwner([executor.address])],
      ["implementationRegistry.transferOwnership", () => implementationRegistry.write.transferOwnership([executor.address])],
      ["infoNft.setAdmin", () => infoNft.write.setAdmin([executor.address])],
      ["infoNft.transferOwnership", () => infoNft.write.transferOwnership([executor.address])],
      ["creditGraph.transferOwnership", () => creditGraph.write.transferOwnership([executor.address])],
      ["orderBook.transferOwner", () => orderBook.write.transferOwner([executor.address])],
      ["assetRegistry.transferOwner", () => assetRegistry.write.transferOwner([executor.address])],
      ["dcDomain.transferOwnership", () => dcDomain.write.transferOwnership([executor.address])],
      ["dcRank.transferOwnership", () => dcRank.write.transferOwnership([executor.address])],
      ["dcMarket.transferOwnership", () => dcMarket.write.transferOwnership([executor.address])],
      ["dcSwap.transferOwner", () => dcSwap.write.transferOwner([executor.address])],
    ];
    for (const [label, write] of auxiliaryHandoffs) {
      await waitFor(await write(), label, true);
    }
    await waitFor(
      await executor.write.transferOwnership([executor.address]),
      "executor.transferOwnership",
      true,
    );

    assert.equal(getAddress(await executor.read.owner()), getAddress(executor.address));
    assert.equal(getAddress(await factory.read.owner()), getAddress(executor.address));
    assert.equal(getAddress(await factory.read.admin()), getAddress(executor.address));
    assert.equal(getAddress(await factory.read.crossChainGovernance()), getAddress(executor.address));
    assert.equal(getAddress(await treasury.read.controller()), getAddress(executor.address));
    assert.equal(await treasury.read.bootstrapLocked(), true);
    assert.equal(await dc.read.hasRole([adminRole, deployer.account.address]), false);
    assert.equal(await dc.read.hasRole([minterRole, deployer.account.address]), false);
    assert.equal(await dc.read.hasRole([adminRole, executor.address]), true);
    assert.equal(await dc.read.hasRole([minterRole, executor.address]), true);
    assert.equal(await dc.read.hasRole([pauserRole, executor.address]), true);
    assert.equal(await dc.read.hasRole([minterRole, factory.address]), true);
    assert.equal(getAddress(await pairManager.read.owner()), getAddress(executor.address));
    assert.equal(getAddress(await implementationRegistry.read.owner()), getAddress(executor.address));
    assert.equal(getAddress(await infoNft.read.owner()), getAddress(executor.address));
    assert.equal(getAddress(await infoNft.read.admin()), getAddress(executor.address));
    assert.equal(getAddress(await creditGraph.read.owner()), getAddress(executor.address));
    assert.equal(getAddress(await orderBook.read.owner()), getAddress(executor.address));
    assert.equal(getAddress(await assetRegistry.read.owner()), getAddress(executor.address));
    assert.equal(getAddress(await dcDomain.read.owner()), getAddress(executor.address));
    assert.equal(getAddress(await dcRank.read.owner()), getAddress(executor.address));
    assert.equal(getAddress(await dcMarket.read.owner()), getAddress(executor.address));
    assert.equal(getAddress(await dcSwap.read.owner()), getAddress(executor.address));
    for (const [, target] of governanceTargets) {
      assert.equal(await executor.read.allowedTargets([target]), true);
    }

    await assert.rejects(executor.write.setThreshold([3n]));
    await assert.rejects(factory.write.setMinTimeoutSeconds([7200n]));
    await assert.rejects(factory.write.setMinTimeoutSecondsByAdmin([7200n]));
    await assert.rejects(dc.write.mint([outsider.account.address, 1n]));
    await assert.rejects(treasury.write.payNative([outsider.account.address, 1n]));
    await assert.rejects(dcSwap.write.setReplaceTimeoutSeconds([180n]));

    await networkHelpers.impersonateAccount(BASE_MAINNET.lzEndpoint);
    await networkHelpers.setBalance(BASE_MAINNET.lzEndpoint, parseEther("1"));
    const endpointWallet = await viem.getWalletClient(BASE_MAINNET.lzEndpoint);
    const executorAsEndpoint = await viem.getContractAt(
      "DualBridgeExecutorV2",
      executor.address,
      { client: { public: publicClient, wallet: endpointWallet } },
    );
    await networkHelpers.impersonateAccount(BASE_MAINNET.ccipRouter);
    await networkHelpers.setBalance(BASE_MAINNET.ccipRouter, parseEther("1"));
    const ccipWallet = await viem.getWalletClient(BASE_MAINNET.ccipRouter);
    const executorAsCcip = await viem.getContractAt(
      "DualBridgeExecutorV2",
      executor.address,
      { client: { public: publicClient, wallet: ccipWallet } },
    );

    let deliveryNonce = 0n;
    async function deliver(target: Address, data: Hex, label: string) {
      deliveryNonce += 1n;
      const payload = encodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
        [deliveryNonce, target, data],
      );
      const messageHash = keccak256(payload);
      await waitFor(
        await executorAsEndpoint.write.lzReceive([
          { srcEid: ETH_LZ_EID, sender: broadcasterBytes32, nonce: deliveryNonce },
          keccak256(encodeAbiParameters([{ type: "uint256" }], [deliveryNonce])),
          payload,
          deployer.account.address,
          "0x",
        ]),
        `${label}.layerZero`,
      );
      assert.deepEqual(await executor.read.confirmStatus([messageHash]), [
        true, false, false, 1n, false,
      ]);
      await waitFor(
        await executorAsCcip.write.ccipReceive([{
          messageId: keccak256(encodeAbiParameters([{ type: "uint256" }], [deliveryNonce + 10_000n])),
          sourceChainSelector: ETH_CCIP_SELECTOR,
          sender: encodeAbiParameters([{ type: "address" }], [ETH_BROADCASTER]),
          data: payload,
          destTokenAmounts: [],
        }]),
        `${label}.ccip`,
      );
      assert.deepEqual(await executor.read.confirmStatus([messageHash]), [
        true, true, false, 2n, true,
      ]);
      assert.equal(await executor.read.executionAttempts([messageHash]), 1n);
    }

    await deliver(
      executor.address,
      encodeFunctionData({
        abi: executor.abi,
        functionName: "setAllowedTarget",
        args: [outsider.account.address, true],
      }),
      "selfGovernance",
    );
    assert.equal(await executor.read.allowedTargets([outsider.account.address]), true);

    await deliver(
      factory.address,
      encodeFunctionData({
        abi: factory.abi,
        functionName: "setMinTimeoutSeconds",
        args: [7200n],
      }),
      "factoryParameter",
    );
    assert.equal(await factory.read.minTimeoutSeconds(), 7200n);

    await deliver(
      dcSwap.address,
      encodeFunctionData({
        abi: dcSwap.abi,
        functionName: "setReplaceTimeoutSeconds",
        args: [180n],
      }),
      "domainSwapParameter",
    );
    assert.equal(await dcSwap.read.replaceTimeoutSeconds(), 180n);

    const upgradedFactoryImplementation = await viem.deployContract("DealFactory", [], { client });
    await deliver(
      factory.address,
      encodeFunctionData({
        abi: factory.abi,
        functionName: "upgradeToAndCall",
        args: [upgradedFactoryImplementation.address, "0x"],
      }),
      "factoryUpgrade",
    );
    assert.equal(getAddress(await factory.read.owner()), getAddress(executor.address));
    assert.equal(await factory.read.minTimeoutSeconds(), 7200n);

    const mintAmount = 1_000_000n * 10n ** 18n;
    await deliver(
      dc.address,
      encodeFunctionData({
        abi: dc.abi,
        functionName: "mint",
        args: [treasury.address, mintAmount],
      }),
      "daoMint",
    );
    assert.equal(await dc.read.balanceOf([treasury.address]), mintAmount);

    await waitFor(
      await deployer.sendTransaction({ to: treasury.address, value: parseEther("0.01") }),
      "fundTreasury",
    );
    const outsiderBefore = await publicClient.getBalance({ address: outsider.account.address });
    await deliver(
      treasury.address,
      encodeFunctionData({
        abi: treasury.abi,
        functionName: "payNative",
        args: [outsider.account.address, parseEther("0.001")],
      }),
      "treasuryPayout",
    );
    assert.equal(
      await publicClient.getBalance({ address: outsider.account.address }),
      outsiderBefore + parseEther("0.001"),
    );

    assert.equal(
      (await executor.read.peers([ETH_LZ_EID])).toLowerCase(),
      broadcasterBytes32.toLowerCase(),
    );
    assert.equal(getAddress(await executor.read.ccipSrcSender()), ETH_BROADCASTER);
    assert.equal(await executor.read.ccipSrcChainSelector(), ETH_CCIP_SELECTOR);
    assert.equal(await executor.read.axSrcChain(), "Ethereum");
    assert.equal(await executor.read.axSrcAddress(), ETH_BROADCASTER);
    assert.equal(await executor.read.threshold(), 2n);
    assert.deepEqual(await executor.read.confirmStatus([zeroHash]), [false, false, false, 0n, false]);

    const totals = gasRows.reduce(
      (sum, row) => ({
        gasUsed: sum.gasUsed + row.gasUsed,
        l1Fee: sum.l1Fee + row.l1Fee,
        nativeCost: sum.nativeCost + row.nativeCost,
      }),
      { gasUsed: 0n, l1Fee: 0n, nativeCost: 0n },
    );
    console.log(JSON.stringify({
      baseCrossChainSetupGas: {
        transactionCount: gasRows.length,
        totalGasUsed: totals.gasUsed.toString(),
        totalL1FeeWei: totals.l1Fee.toString(),
        totalNativeCostWei: totals.nativeCost.toString(),
      },
    }));
  });
});
