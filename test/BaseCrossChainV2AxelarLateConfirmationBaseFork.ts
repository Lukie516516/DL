import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeAbiParameters, getAddress, parseEther, type Hex } from "viem";

const RUN = process.env.BASE_CROSS_CHAIN_V2_AXELAR_LATE_CONFIRMATION_FORK === "1";
const forkDescribe = RUN ? describe : describe.skip;
const OWNER = getAddress("0xE88c63D29ECE76E3336B0Db747E10876c3bf9893");
const BROADCASTER = getAddress("0xCF4D1b59c43F0e19f7e0e0416067e999f12cd1e6");
const EXECUTOR = getAddress("0xf92cE4DBA86eDbfAdEA32880a04FF1123a188218");
const PROBE = getAddress("0x61921eCb954FFaAf8cd3Fd2e71EeCB14B3eD529f");
const MESSAGE_HASH = "0x87b861508858236eed41e1c5aaeb0a7925253c9f5cb0ea1f76eb77b5983962b2" as Hex;
const COMMAND_ID = "0x92e7913379d92650164b51c0b872e877c40d48b39ebc5f5926670e25f7da819d" as Hex;
const MARKER = "0xe735d9f79dc7413699af00ad995b58e853e30e3881bc5e72aff1ae13cab8ef3b" as Hex;
const MARKER_CALLDATA = "0x608b82a5e735d9f79dc7413699af00ad995b58e853e30e3881bc5e72aff1ae13cab8ef3b" as Hex;
const SOURCE_CHAIN = "Ethereum";
const WRONG_SOURCE_ADDRESS = BROADCASTER.toLowerCase();
const CORRECT_SOURCE_ADDRESS = BROADCASTER;

async function waitFor(publicClient: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
}

forkDescribe("Base CrossChain V2 Axelar late confirmation Base fork", function () {
  it("fixes only source-address casing and accepts Axelar without executing the marker twice", async function () {
    try {
      const { viem, networkHelpers } = await network.connect({
        network: "hardhatBaseFork",
        chainType: "op",
      });
      const publicClient = await viem.getPublicClient();
      assert.equal(await publicClient.getChainId(), 8453);
      const executor = await viem.getContractAt("DualBridgeExecutorV2", EXECUTOR);
      const probe = await viem.getContractAt("GovernanceProbe", PROBE);
      const statusBefore = await executor.read.confirmStatus([MESSAGE_HASH]);
      const attemptsBefore = await executor.read.executionAttempts([MESSAGE_HASH]);
      const markerBefore = await probe.read.marker();
      const updateCountBefore = await probe.read.updateCount();
      assert.equal(statusBefore[0], true, "LayerZero must already be confirmed");
      assert.equal(statusBefore[2], false, "Axelar must still be unconfirmed");
      assert.ok(statusBefore[3] === 1n || statusBefore[3] === 2n);
      assert.equal(statusBefore[4], statusBefore[3] >= 2n);
      assert.equal(attemptsBefore, statusBefore[4] ? 1n : 0n);
      assert.equal(markerBefore, statusBefore[4] ? MARKER : `0x${"00".repeat(32)}`);
      assert.equal(updateCountBefore, statusBefore[4] ? 1n : 0n);
      assert.equal(await executor.read.axSrcChain(), SOURCE_CHAIN);
      assert.equal(await executor.read.axSrcAddress(), WRONG_SOURCE_ADDRESS);

      const payload = encodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
        [3n, PROBE, MARKER_CALLDATA],
      );
      await assert.rejects(
        publicClient.simulateContract({
          account: OWNER,
          address: EXECUTOR,
          abi: executor.abi,
          functionName: "execute",
          args: [COMMAND_ID, SOURCE_CHAIN, CORRECT_SOURCE_ADDRESS, payload],
        }),
        /WrongAxSrcAddress|0x7977c504/,
      );

      await networkHelpers.impersonateAccount(OWNER);
      await networkHelpers.setBalance(OWNER, parseEther("2"));
      const ownerWallet = await viem.getWalletClient(OWNER);
      const executorAsOwner = await viem.getContractAt("DualBridgeExecutorV2", EXECUTOR, {
        client: { public: publicClient, wallet: ownerWallet },
      });
      await waitFor(
        publicClient,
        await executorAsOwner.write.setAxSrc([SOURCE_CHAIN, CORRECT_SOURCE_ADDRESS]),
      );
      assert.equal(await executor.read.axSrcAddress(), CORRECT_SOURCE_ADDRESS);
      await waitFor(
        publicClient,
        await executorAsOwner.write.execute([
          COMMAND_ID,
          SOURCE_CHAIN,
          CORRECT_SOURCE_ADDRESS,
          payload,
        ]),
      );

      const statusAfter = await executor.read.confirmStatus([MESSAGE_HASH]);
      assert.equal(statusAfter[0], true);
      assert.equal(statusAfter[1], statusBefore[1]);
      assert.equal(statusAfter[2], true);
      assert.equal(statusAfter[3], statusBefore[3] + 1n);
      assert.equal(statusAfter[4], true);
      assert.equal(
        await executor.read.executionAttempts([MESSAGE_HASH]),
        statusBefore[4] ? attemptsBefore : attemptsBefore + 1n,
      );
      assert.equal(await probe.read.marker(), MARKER);
      assert.equal(await probe.read.updateCount(), 1n);
    } catch (error) {
      console.error("Base Axelar late-confirmation fork error:", error);
      throw error;
    }
  });
});
