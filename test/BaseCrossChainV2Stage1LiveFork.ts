import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  padHex,
  parseEther,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

import { BASE_MAINNET } from "../scripts/lib/evm-chain-config.js";

const RUN = process.env.BASE_CROSS_CHAIN_V2_STAGE1_LIVE_FORK === "1";
const forkDescribe = RUN ? describe : describe.skip;
const ETH_LZ_EID = 30_101;
const ETH_CCIP_SELECTOR = 5_009_297_550_715_157_269n;
const ETH_BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const MARKER = keccak256(stringToHex("DEAL_BASE_CROSS_CHAIN_V2_STAGE1_CANARY"));

type Deployment = {
  deployer: Address;
  addresses: Record<string, Address>;
};

forkDescribe("Base CrossChain V2 stage 1 live deployment fork", function () {
  it("deploys an isolated Executor/Probe canary while preserving every live business state", async function () {
    try {
    const deployment = JSON.parse(
      readFileSync("deployments/base-mainnet-8453.json", "utf8"),
    ) as Deployment;
    const { viem, networkHelpers } = await network.connect({
      network: "hardhatBaseFork",
      chainType: "op",
    });
    const publicClient = await viem.getPublicClient();
    assert.equal(await publicClient.getChainId(), BASE_MAINNET.chainId);

    const deployerAddress = getAddress(deployment.deployer);
    await networkHelpers.impersonateAccount(deployerAddress);
    await networkHelpers.setBalance(deployerAddress, parseEther("1"));
    const deployer = await viem.getWalletClient(deployerAddress);
    const client = { public: publicClient, wallet: deployer } as const;

    const factory = await viem.getContractAt("DealFactory", deployment.addresses.dealFactory, { client });
    const treasury = await viem.getContractAt("ProtocolTreasury", deployment.addresses.protocolTreasury, { client });
    const dc = await viem.getContractAt("DCToken", deployment.addresses.dlToken, { client });
    const pairManager = await viem.getContractAt("DealPairManager", deployment.addresses.dealPairManager, { client });
    const pairAddresses = [
      deployment.addresses.pairStable0,
      deployment.addresses.pairStable1,
      deployment.addresses.pairWrappedNative,
    ].map((address) => getAddress(address));

    const liveBefore = {
      factoryOwner: getAddress(await factory.read.owner()),
      factoryAdmin: getAddress(await factory.read.admin()),
      crossChainGovernance: getAddress(await factory.read.crossChainGovernance()),
      treasuryController: getAddress(await treasury.read.controller()),
      treasuryLocked: await treasury.read.bootstrapLocked(),
      dcTotalSupply: await dc.read.totalSupply(),
      pools: await Promise.all(pairAddresses.map(async (pairAddress) => {
        const pair = await viem.getContractAt("DealSwapTemplate", pairAddress, { client });
        return {
          pairAddress,
          initialized: await pair.read.liquidityInited(),
          reserves: await pair.read.getReserves(),
          virtuals: await pair.read.getVirtualReserves(),
        };
      })),
    };
    assert.equal(liveBefore.factoryOwner, deployerAddress);
    assert.equal(liveBefore.factoryAdmin, deployerAddress);
    assert.equal(liveBefore.crossChainGovernance, "0x0000000000000000000000000000000000000000");
    assert.equal(liveBefore.treasuryController, deployerAddress);
    assert.equal(liveBefore.treasuryLocked, false);
    assert.equal(liveBefore.dcTotalSupply, 0n);

    const executor = await viem.deployContract("DualBridgeExecutorV2", [
      BASE_MAINNET.lzEndpoint,
      deployerAddress,
      BASE_MAINNET.ccipRouter,
      ETH_CCIP_SELECTOR,
      ETH_BROADCASTER,
      BASE_MAINNET.axelarGateway,
      "Ethereum",
      ETH_BROADCASTER,
      2n,
    ], { client });
    const probeImplementation = await viem.deployContract("GovernanceProbe", [], { client });
    const probe = await viem.deployContract("ERC1967Proxy", [
      probeImplementation.address,
      encodeFunctionData({
        abi: probeImplementation.abi,
        functionName: "initialize",
        args: [executor.address],
      }),
    ], { client });
    const probeProxy = await viem.getContractAt("GovernanceProbe", probe.address, { client });

    async function waitFor(hash: Hex) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
    }
    await waitFor(await executor.write.setPeer([
      ETH_LZ_EID,
      padHex(ETH_BROADCASTER, { size: 32 }),
    ]));
    await waitFor(await executor.write.setAllowedTarget([executor.address, true]));
    await waitFor(await executor.write.setAllowedTarget([probe.address, true]));
    await waitFor(await executor.write.setDelegate([executor.address]));

    assert.equal(getAddress(await executor.read.owner()), deployerAddress);
    assert.equal(await executor.read.threshold(), 2n);
    assert.equal(getAddress(await executor.read.ccipSrcSender()), ETH_BROADCASTER);
    assert.equal(await executor.read.ccipSrcChainSelector(), ETH_CCIP_SELECTOR);
    assert.equal(await executor.read.axSrcChain(), "Ethereum");
    assert.equal(await executor.read.axSrcAddress(), ETH_BROADCASTER);
    assert.equal(await executor.read.allowedTargets([executor.address]), true);
    assert.equal(await executor.read.allowedTargets([probe.address]), true);
    assert.equal(getAddress(await probeProxy.read.controller()), getAddress(executor.address));
    await assert.rejects(probeProxy.write.recordMarker([MARKER]));

    const payload = encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
      [1n, probe.address, encodeFunctionData({
        abi: probeImplementation.abi,
        functionName: "recordMarker",
        args: [MARKER],
      })],
    );
    const messageHash = keccak256(payload);
    const broadcasterBytes32 = padHex(ETH_BROADCASTER, { size: 32 });

    await networkHelpers.impersonateAccount(BASE_MAINNET.lzEndpoint);
    await networkHelpers.setBalance(BASE_MAINNET.lzEndpoint, parseEther("1"));
    const endpointWallet = await viem.getWalletClient(BASE_MAINNET.lzEndpoint);
    const executorAsEndpoint = await viem.getContractAt("DualBridgeExecutorV2", executor.address, {
      client: { public: publicClient, wallet: endpointWallet },
    });
    await waitFor(await executorAsEndpoint.write.lzReceive([
      { srcEid: ETH_LZ_EID, sender: broadcasterBytes32, nonce: 1n },
      keccak256(stringToHex("base-stage1-lz-guid")),
      payload,
      deployerAddress,
      "0x",
    ]));
    assert.deepEqual(await executor.read.confirmStatus([messageHash]), [true, false, false, 1n, false]);
    assert.equal(await probeProxy.read.marker(), `0x${"00".repeat(32)}`);

    await networkHelpers.impersonateAccount(BASE_MAINNET.ccipRouter);
    await networkHelpers.setBalance(BASE_MAINNET.ccipRouter, parseEther("1"));
    const ccipWallet = await viem.getWalletClient(BASE_MAINNET.ccipRouter);
    const executorAsCcip = await viem.getContractAt("DualBridgeExecutorV2", executor.address, {
      client: { public: publicClient, wallet: ccipWallet },
    });
    await waitFor(await executorAsCcip.write.ccipReceive([{
      messageId: keccak256(stringToHex("base-stage1-ccip-message")),
      sourceChainSelector: ETH_CCIP_SELECTOR,
      sender: encodeAbiParameters([{ type: "address" }], [ETH_BROADCASTER]),
      data: payload,
      destTokenAmounts: [],
    }]));
    assert.deepEqual(await executor.read.confirmStatus([messageHash]), [true, true, false, 2n, true]);
    assert.equal(await probeProxy.read.marker(), MARKER);
    assert.equal(await probeProxy.read.updateCount(), 1n);

    const liveAfter = {
      factoryOwner: getAddress(await factory.read.owner()),
      factoryAdmin: getAddress(await factory.read.admin()),
      crossChainGovernance: getAddress(await factory.read.crossChainGovernance()),
      treasuryController: getAddress(await treasury.read.controller()),
      treasuryLocked: await treasury.read.bootstrapLocked(),
      dcTotalSupply: await dc.read.totalSupply(),
      pools: await Promise.all(pairAddresses.map(async (pairAddress) => {
        const pair = await viem.getContractAt("DealSwapTemplate", pairAddress, { client });
        return {
          pairAddress,
          initialized: await pair.read.liquidityInited(),
          reserves: await pair.read.getReserves(),
          virtuals: await pair.read.getVirtualReserves(),
        };
      })),
      pairManagerOwner: getAddress(await pairManager.read.owner()),
    };
    assert.deepEqual(liveAfter.pools, liveBefore.pools);
    assert.equal(liveAfter.factoryOwner, liveBefore.factoryOwner);
    assert.equal(liveAfter.factoryAdmin, liveBefore.factoryAdmin);
    assert.equal(liveAfter.crossChainGovernance, liveBefore.crossChainGovernance);
    assert.equal(liveAfter.treasuryController, liveBefore.treasuryController);
    assert.equal(liveAfter.treasuryLocked, liveBefore.treasuryLocked);
    assert.equal(liveAfter.dcTotalSupply, liveBefore.dcTotalSupply);
    assert.equal(liveAfter.pairManagerOwner, deployerAddress);
    } catch (error) {
      console.error("Base stage 1 underlying fork error:", error);
      throw error;
    }
  });
});
