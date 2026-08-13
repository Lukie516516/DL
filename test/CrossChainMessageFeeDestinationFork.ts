import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseEther,
  toHex,
  type Address,
  type Hex,
} from "viem";

import {
  BASE_DC,
  BASE_EXECUTOR,
  BASE_FACTORY,
  BROADCASTER,
  BSC_DC,
  BSC_EXECUTOR,
  BSC_FACTORY,
  BSC_PROBE,
  CANARY_MESSAGE_FEE,
  CURRENT_MESSAGE_FEE,
  OWNER,
  buildFactoryFeeCalldata,
} from "../scripts/lib/cross-chain-message-fee-canary.js";

const RUN = process.env.CROSS_CHAIN_MESSAGE_FEE_DESTINATION_FORK === "1";
const forkDescribe = RUN ? describe : describe.skip;
const ETH_LZ_EID = 30_101;
const PRODUCTION_IMPLEMENTATION = getAddress("0x7fC9145A2539F0eD52Cf6E7E34Ce485635A9887E");
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

function implementationAddress(word: Hex): Address {
  return getAddress(`0x${word.slice(-40)}`);
}

async function waitFor(publicClient: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
}

type RehearsalInput = {
  viem: any;
  networkHelpers: any;
  chainId: 56 | 8453;
  factoryAddress: Address;
  executorAddress: Address;
  dcAddress: Address;
};

async function rehearseDestination({
  viem,
  networkHelpers,
  chainId,
  factoryAddress,
  executorAddress,
  dcAddress,
}: RehearsalInput) {
  const publicClient = await viem.getPublicClient();
  assert.equal(await publicClient.getChainId(), chainId);
  const factory = await viem.getContractAt("DealFactory", factoryAddress);
  const executor = await viem.getContractAt("DualBridgeExecutorV2", executorAddress);

  const protectedBefore = {
    owner: getAddress(await factory.read.owner()),
    admin: getAddress(await factory.read.admin()),
    governance: getAddress(await factory.read.crossChainGovernance()),
    enabled: await factory.read.msgPriceEnabled(),
    token: getAddress(await factory.read.msgPriceToken()),
  };
  assert.equal(protectedBefore.governance, executorAddress);
  assert.equal(protectedBefore.enabled, true);
  assert.equal(protectedBefore.token, dcAddress);
  assert.equal(await factory.read.msgPriceAmountInToken(), CURRENT_MESSAGE_FEE);
  assert.equal(await executor.read.threshold(), 2n);
  assert.equal(await executor.read.allowedTargets([factoryAddress]), true);
  assert.equal(getAddress(await executor.read.ccipSrcSender()), BROADCASTER);
  const implementationWord = await publicClient.getStorageAt({
    address: factoryAddress,
    slot: IMPLEMENTATION_SLOT,
  });
  assert.ok(implementationWord, "Factory implementation slot unavailable");
  assert.equal(implementationAddress(implementationWord), PRODUCTION_IMPLEMENTATION);

  const endpoint = getAddress(await executor.read.endpoint());
  const lzPeer = await executor.read.peers([ETH_LZ_EID]);
  const ccipRouter = getAddress(await executor.read.ccipRouter());
  const ccipSelector = await executor.read.ccipSrcChainSelector();
  const executorOwner = getAddress(await executor.read.owner());
  assert.equal(
    lzPeer.toLowerCase(),
    `0x${"0".repeat(24)}${BROADCASTER.slice(2)}`.toLowerCase(),
  );

  await networkHelpers.impersonateAccount(endpoint);
  await networkHelpers.setBalance(endpoint, parseEther("2"));
  await networkHelpers.impersonateAccount(ccipRouter);
  await networkHelpers.setBalance(ccipRouter, parseEther("2"));
  const endpointWallet = await viem.getWalletClient(endpoint);
  const ccipWallet = await viem.getWalletClient(ccipRouter);
  const executorAsEndpoint = await viem.getContractAt("DualBridgeExecutorV2", executorAddress, {
    client: { public: publicClient, wallet: endpointWallet },
  });
  const executorAsCcip = await viem.getContractAt("DualBridgeExecutorV2", executorAddress, {
    client: { public: publicClient, wallet: ccipWallet },
  });

  const deliverTwoOfThree = async (nonce: bigint, price: bigint) => {
    const data = buildFactoryFeeCalldata(price);
    const payload = encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
      [nonce, factoryAddress, data],
    );
    const messageHash = keccak256(payload);
    assert.deepEqual(await executor.read.confirmStatus([messageHash]), [false, false, false, 0n, false]);

    await waitFor(publicClient, await executorAsEndpoint.write.lzReceive([
      { srcEid: ETH_LZ_EID, sender: lzPeer, nonce },
      keccak256(toHex(nonce)),
      payload,
      executorOwner,
      "0x",
    ]));
    assert.deepEqual(await executor.read.confirmStatus([messageHash]), [true, false, false, 1n, false]);
    assert.notEqual(await factory.read.msgPriceAmountInToken(), price);

    await waitFor(publicClient, await executorAsCcip.write.ccipReceive([{
      messageId: keccak256(toHex(nonce + 10_000n)),
      sourceChainSelector: ccipSelector,
      sender: encodeAbiParameters([{ type: "address" }], [BROADCASTER]),
      data: payload,
      destTokenAmounts: [],
    }]));
    assert.deepEqual(await executor.read.confirmStatus([messageHash]), [true, true, false, 2n, true]);
    assert.equal(await executor.read.executionAttempts([messageHash]), 1n);
    assert.equal(await factory.read.msgPriceAmountInToken(), price);
  };

  const nonceBase = 77_000_000_000n + BigInt(chainId) * 1_000_000n;
  await deliverTwoOfThree(nonceBase, CANARY_MESSAGE_FEE);
  await deliverTwoOfThree(nonceBase + 1n, CURRENT_MESSAGE_FEE);

  assert.equal(getAddress(await factory.read.owner()), protectedBefore.owner);
  assert.equal(getAddress(await factory.read.admin()), protectedBefore.admin);
  assert.equal(getAddress(await factory.read.crossChainGovernance()), protectedBefore.governance);
  assert.equal(await factory.read.msgPriceEnabled(), protectedBefore.enabled);
  assert.equal(getAddress(await factory.read.msgPriceToken()), protectedBefore.token);
  assert.equal(await factory.read.msgPriceAmountInToken(), CURRENT_MESSAGE_FEE);
}

forkDescribe("BSC + Base message-fee destination forks", function () {
  it("closes the BSC Probe and rehearses 104 -> 105 -> 104 through LZ + CCIP", async function () {
    try {
      const { viem, networkHelpers } = await network.connect({ network: "hardhatBscFork", chainType: "l1" });
      const publicClient = await viem.getPublicClient();
      const executor = await viem.getContractAt("DualBridgeExecutorV2", BSC_EXECUTOR);
      assert.equal(getAddress(await executor.read.owner()), OWNER);
      assert.equal(await executor.read.allowedTargets([BSC_PROBE]), true);
      await networkHelpers.impersonateAccount(OWNER);
      await networkHelpers.setBalance(OWNER, parseEther("2"));
      const ownerWallet = await viem.getWalletClient(OWNER);
      const executorAsOwner = await viem.getContractAt("DualBridgeExecutorV2", BSC_EXECUTOR, {
        client: { public: publicClient, wallet: ownerWallet },
      });
      await waitFor(publicClient, await executorAsOwner.write.setAllowedTarget([BSC_PROBE, false]));
      assert.equal(await executor.read.allowedTargets([BSC_PROBE]), false);
      assert.equal(await executor.read.allowedTargets([BSC_FACTORY]), true);
      await rehearseDestination({
        viem,
        networkHelpers,
        chainId: 56,
        factoryAddress: BSC_FACTORY,
        executorAddress: BSC_EXECUTOR,
        dcAddress: BSC_DC,
      });
    } catch (error) {
      console.error("BSC message-fee destination fork error:", error);
      throw error;
    }
  });

  it("rehearses Base 104 -> 105 -> 104 through LZ + CCIP", async function () {
    try {
      const { viem, networkHelpers } = await network.connect({ network: "hardhatBaseFork", chainType: "op" });
      await rehearseDestination({
        viem,
        networkHelpers,
        chainId: 8453,
        factoryAddress: BASE_FACTORY,
        executorAddress: BASE_EXECUTOR,
        dcAddress: BASE_DC,
      });
    } catch (error) {
      console.error("Base message-fee destination fork error:", error);
      throw error;
    }
  });
});
