import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeFunctionData,
  keccak256,
  stringToHex,
  toFunctionSelector,
  zeroAddress,
} from "viem";

async function waitFor(publicClient: any, hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction failed: ${hash}`);
  return receipt;
}

function revertsWithSelector(action: () => Promise<unknown>, signature: string) {
  const selector = toFunctionSelector(signature);
  return assert.rejects(action, (error: unknown) => String(error).includes(selector));
}

describe("GovernanceProbe", function () {
  it("only lets its controller record markers and upgrade while preserving state", async function () {
    const { viem } = await network.connect({ network: "hardhatMainnet" });
    const publicClient = await viem.getPublicClient();
    const [controller, outsider] = await viem.getWalletClients();

    const implementation = await viem.deployContract("GovernanceProbe", []);
    const initData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: [controller.account.address],
    });
    const proxy = await viem.deployContract("ERC1967Proxy", [implementation.address, initData]);
    const probe = await viem.getContractAt("GovernanceProbe", proxy.address);
    const probeAsOutsider = await viem.getContractAt("GovernanceProbe", proxy.address, {
      client: { wallet: outsider },
    });

    assert.equal((await probe.read.controller()).toLowerCase(), controller.account.address.toLowerCase());
    assert.equal(await probe.read.marker(), `0x${"00".repeat(32)}`);
    assert.equal(await probe.read.updateCount(), 0n);
    assert.equal(await probe.read.version(), 1n);

    const marker = keccak256(stringToHex("DEAL_CROSS_CHAIN_GOVERNANCE_PROBE_V1"));
    await assert.rejects(probeAsOutsider.write.recordMarker([marker]), /NotController/);
    await assert.rejects(probe.write.recordMarker([`0x${"00".repeat(32)}`]), /ZeroMarker/);
    await waitFor(publicClient, await probe.write.recordMarker([marker]));
    assert.equal(await probe.read.marker(), marker);
    assert.equal(await probe.read.updateCount(), 1n);

    await revertsWithSelector(
      () => probe.write.initialize([zeroAddress]),
      "InvalidInitialization()",
    );
    await revertsWithSelector(
      () => implementation.write.initialize([controller.account.address]),
      "InvalidInitialization()",
    );

    const v2Implementation = await viem.deployContract("GovernanceProbeUpgradeMock", []);
    await revertsWithSelector(
      () => probeAsOutsider.write.upgradeToAndCall([v2Implementation.address, "0x"]),
      "NotController()",
    );
    await waitFor(
      publicClient,
      await probe.write.upgradeToAndCall([v2Implementation.address, "0x"]),
    );

    const upgraded = await viem.getContractAt("GovernanceProbeUpgradeMock", proxy.address);
    assert.equal(await upgraded.read.version(), 2n);
    assert.equal(await upgraded.read.upgradedFeatureAvailable(), true);
    assert.equal((await upgraded.read.controller()).toLowerCase(), controller.account.address.toLowerCase());
    assert.equal(await upgraded.read.marker(), marker);
    assert.equal(await upgraded.read.updateCount(), 1n);
  });
});
