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
  BASE_EXECUTOR,
  BASE_FACTORY,
  BROADCASTER,
  BSC_EXECUTOR,
  BSC_FACTORY,
  CANARY_MIN_TIMEOUT,
  CURRENT_MIN_TIMEOUT,
  ETH_LZ_EID,
  buildMinTimeoutCalldata,
} from "../scripts/lib/cross-chain-min-timeout-canary.js";

const RUN = process.env.CROSS_CHAIN_MIN_TIMEOUT_DESTINATION_FORK === "1";
const forkDescribe = RUN ? describe : describe.skip;
const forkChain = process.env.CROSS_CHAIN_MIN_TIMEOUT_FORK_CHAIN?.toLowerCase();
const bscIt = forkChain === "base" ? it.skip : it;
const baseIt = forkChain === "bsc" ? it.skip : it;

async function waitFor(publicClient: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
}

async function rehearseDestination(input: {
  viem: any;
  networkHelpers: any;
  chainId: 56 | 8453;
  factoryAddress: Address;
  executorAddress: Address;
}) {
  const { viem, networkHelpers, chainId, factoryAddress, executorAddress } = input;
  const publicClient = await viem.getPublicClient();
  assert.equal(await publicClient.getChainId(), chainId);
  await networkHelpers.impersonateAccount(BROADCASTER);
  const readWallet = await viem.getWalletClient(BROADCASTER);
  const explicitClient = { public: publicClient, wallet: readWallet } as const;
  const factory = await viem.getContractAt("DealFactory", factoryAddress, { client: explicitClient });
  const executor = await viem.getContractAt("DualBridgeExecutorV2", executorAddress, { client: explicitClient });
  const protectedBefore = {
    owner: getAddress(await factory.read.owner()),
    governance: getAddress(await factory.read.crossChainGovernance()),
  };
  assert.equal(protectedBefore.governance, executorAddress);
  assert.equal(await factory.read.minTimeoutSeconds(), CURRENT_MIN_TIMEOUT);
  assert.equal(await executor.read.threshold(), 2n);
  assert.equal(await executor.read.allowedTargets([factoryAddress]), true);
  assert.equal(getAddress(await executor.read.ccipSrcSender()), BROADCASTER);

  const endpoint = getAddress(await executor.read.endpoint());
  const lzPeer = await executor.read.peers([ETH_LZ_EID]);
  const ccipRouter = getAddress(await executor.read.ccipRouter());
  const ccipSelector = await executor.read.ccipSrcChainSelector();
  const executorOwner = getAddress(await executor.read.owner());
  assert.equal(lzPeer.toLowerCase(), `0x${"0".repeat(24)}${BROADCASTER.slice(2)}`.toLowerCase());

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

  const deliverTwoOfThree = async (nonce: bigint, seconds: bigint) => {
    const payload = encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
      [nonce, factoryAddress, buildMinTimeoutCalldata(seconds)],
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
    assert.notEqual(await factory.read.minTimeoutSeconds(), seconds);
    await waitFor(publicClient, await executorAsCcip.write.ccipReceive([{
      messageId: keccak256(toHex(nonce + 10_000n)),
      sourceChainSelector: ccipSelector,
      sender: encodeAbiParameters([{ type: "address" }], [BROADCASTER]),
      data: payload,
      destTokenAmounts: [],
    }]));
    assert.deepEqual(await executor.read.confirmStatus([messageHash]), [true, true, false, 2n, true]);
    assert.equal(await executor.read.executionAttempts([messageHash]), 1n);
    assert.equal(await factory.read.minTimeoutSeconds(), seconds);
  };

  const nonceBase = 88_000_000_000n + BigInt(chainId) * 1_000_000n;
  await deliverTwoOfThree(nonceBase, CANARY_MIN_TIMEOUT);
  await deliverTwoOfThree(nonceBase + 1n, CURRENT_MIN_TIMEOUT);
  assert.equal(getAddress(await factory.read.owner()), protectedBefore.owner);
  assert.equal(getAddress(await factory.read.crossChainGovernance()), protectedBefore.governance);
  assert.equal(await factory.read.minTimeoutSeconds(), CURRENT_MIN_TIMEOUT);
}

forkDescribe("BSC + Base minimum-timeout destination forks", function () {
  bscIt("rehearses BSC 3600 -> 3601 -> 3600 through LZ + CCIP", async function () {
    try {
      const { viem, networkHelpers } = await network.connect({ network: "hardhatBscFork", chainType: "l1" });
      await rehearseDestination({ viem, networkHelpers, chainId: 56, factoryAddress: BSC_FACTORY, executorAddress: BSC_EXECUTOR });
    } catch (error) {
      console.error("BSC minimum-timeout fork error:", error);
      throw error;
    }
  });

  baseIt("rehearses Base 3600 -> 3601 -> 3600 through LZ + CCIP", async function () {
    try {
      const { viem, networkHelpers } = await network.connect({ network: "hardhatBaseFork", chainType: "op" });
      await rehearseDestination({ viem, networkHelpers, chainId: 8453, factoryAddress: BASE_FACTORY, executorAddress: BASE_EXECUTOR });
    } catch (error) {
      console.error("Base minimum-timeout fork error:", error);
      throw error;
    }
  });
});
