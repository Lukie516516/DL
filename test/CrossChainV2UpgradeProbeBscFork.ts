import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseEther,
  type Address,
  type Hex,
} from "viem";

const ETH_LZ_EID = 30101;
const runFork = process.env.CROSS_CHAIN_V2_UPGRADE_PROBE_BSC_FORK === "1";
const forkDescribe = runFork ? describe : describe.skip;

type Stage1 = {
  stage: string;
  eth: { address: Address; verified: boolean };
  bsc: { address: Address; verified: boolean };
};

async function waitFor(publicClient: any, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
  return receipt;
}

forkDescribe("asset-free upgrade probe BSC mainnet fork", function () {
  it("lets the live V2 executor upgrade only after two authentic-path confirmations", async function () {
    const stage1 = JSON.parse(
      readFileSync("deployments/ccip-v2-mainnet-stage1.json", "utf8"),
    ) as Stage1;
    assert.equal(stage1.stage, "both_deployed");
    assert.equal(stage1.eth.verified, true);
    assert.equal(stage1.bsc.verified, true);
    const broadcasterAddress = getAddress(stage1.eth.address);
    const executorAddress = getAddress(stage1.bsc.address);

    const { viem, networkHelpers } = await network.connect({
      network: "hardhatBscFork",
      chainType: "l1",
    });
    const publicClient = await viem.getPublicClient();
    const [deployer] = await viem.getWalletClients();
    assert.equal(await publicClient.getChainId(), 56);
    console.log(
      `CrossChain V2 upgrade probe BSC fork block: ${await publicClient.getBlockNumber()}`,
    );

    const executorCode = await publicClient.getCode({ address: executorAddress });
    assert.ok(executorCode && executorCode !== "0x");
    const executor = await viem.getContractAt("DualBridgeExecutorV2", executorAddress);
    assert.equal(await executor.read.threshold(), 2n);
    const endpoint = getAddress(await executor.read.endpoint());
    const ccipRouter = getAddress(await executor.read.ccipRouter());
    const executorOwner = getAddress(await executor.read.owner());
    const ccipSrcChainSelector = await executor.read.ccipSrcChainSelector();
    const ccipSrcSender = getAddress(await executor.read.ccipSrcSender());
    const lzPeer = await executor.read.peers([ETH_LZ_EID]);
    assert.equal(ccipSrcSender, broadcasterAddress);
    assert.equal(
      lzPeer.toLowerCase(),
      `0x${"0".repeat(24)}${broadcasterAddress.slice(2)}`.toLowerCase(),
    );

    const deployClient = { public: publicClient, wallet: deployer } as const;
    const v1Implementation = await viem.deployContract("GovernanceProbe", [], {
      client: deployClient,
    });
    const proxy = await viem.deployContract(
      "ERC1967Proxy",
      [
        v1Implementation.address,
        encodeFunctionData({
          abi: v1Implementation.abi,
          functionName: "initialize",
          args: [executorAddress],
        }),
      ],
      { client: deployClient },
    );
    const v2Implementation = await viem.deployContract(
      "GovernanceProbeUpgradeMock",
      [],
      { client: deployClient },
    );
    const probe = await viem.getContractAt("GovernanceProbe", proxy.address);
    assert.equal(getAddress(await probe.read.controller()), executorAddress);
    assert.equal(await probe.read.version(), 1n);

    await networkHelpers.impersonateAccount(executorOwner);
    await networkHelpers.setBalance(executorOwner, parseEther("10"));
    const ownerWallet = await viem.getWalletClient(executorOwner);
    const executorAsOwner = await viem.getContractAt(
      "DualBridgeExecutorV2",
      executorAddress,
      { client: { public: publicClient, wallet: ownerWallet } },
    );
    await waitFor(
      publicClient,
      await executorAsOwner.write.setAllowedTarget([proxy.address, true]),
    );
    assert.equal(await executor.read.allowedTargets([proxy.address]), true);

    const upgradeData = encodeFunctionData({
      abi: probe.abi,
      functionName: "upgradeToAndCall",
      args: [v2Implementation.address, "0x"],
    });
    const payload = encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
      [9_000_000_000n, proxy.address, upgradeData],
    );
    const messageHash = keccak256(payload);
    assert.deepEqual(await executor.read.confirmStatus([messageHash]), [
      false,
      false,
      false,
      0n,
      false,
    ]);

    await networkHelpers.impersonateAccount(endpoint);
    await networkHelpers.setBalance(endpoint, parseEther("10"));
    const endpointWallet = await viem.getWalletClient(endpoint);
    const executorAsEndpoint = await viem.getContractAt(
      "DualBridgeExecutorV2",
      executorAddress,
      { client: { public: publicClient, wallet: endpointWallet } },
    );
    await waitFor(
      publicClient,
      await executorAsEndpoint.write.lzReceive([
        { srcEid: ETH_LZ_EID, sender: lzPeer, nonce: 1n },
        keccak256("0x01"),
        payload,
        executorOwner,
        "0x",
      ]),
    );
    assert.deepEqual(await executor.read.confirmStatus([messageHash]), [
      true,
      false,
      false,
      1n,
      false,
    ]);
    assert.equal(await probe.read.version(), 1n);

    await networkHelpers.impersonateAccount(ccipRouter);
    await networkHelpers.setBalance(ccipRouter, parseEther("10"));
    const ccipWallet = await viem.getWalletClient(ccipRouter);
    const executorAsCcip = await viem.getContractAt(
      "DualBridgeExecutorV2",
      executorAddress,
      { client: { public: publicClient, wallet: ccipWallet } },
    );
    await waitFor(
      publicClient,
      await executorAsCcip.write.ccipReceive([
        {
          messageId: keccak256("0x02"),
          sourceChainSelector: ccipSrcChainSelector,
          sender: encodeAbiParameters(
            [{ type: "address" }],
            [broadcasterAddress],
          ),
          data: payload,
          destTokenAmounts: [],
        },
      ]),
    );
    assert.deepEqual(await executor.read.confirmStatus([messageHash]), [
      true,
      true,
      false,
      2n,
      true,
    ]);
    assert.equal(await executor.read.executionAttempts([messageHash]), 1n);

    const upgraded = await viem.getContractAt(
      "GovernanceProbeUpgradeMock",
      proxy.address,
    );
    assert.equal(await upgraded.read.version(), 2n);
    assert.equal(await upgraded.read.upgradedFeatureAvailable(), true);
    assert.equal(getAddress(await upgraded.read.controller()), executorAddress);
    assert.equal(await upgraded.read.marker(), `0x${"00".repeat(32)}`);
    assert.equal(await upgraded.read.updateCount(), 0n);
  });
});
