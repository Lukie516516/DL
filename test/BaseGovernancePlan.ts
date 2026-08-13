import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, type Address } from "viem";

import {
  BASE_FIXED_OR_READ_ONLY_MODULES,
  BASE_GOVERNANCE_ADDRESS_KEYS,
  baseGovernanceTargets,
  buildBaseGovernanceHandoffPlan,
} from "../scripts/lib/base-governance-plan.js";

function address(index: number): Address {
  return getAddress(`0x${index.toString(16).padStart(40, "0")}`);
}

describe("Base governance handoff plan", function () {
  it("covers every mutable module once and makes Executor self-ownership the final action", function () {
    const addresses = Object.fromEntries(
      BASE_GOVERNANCE_ADDRESS_KEYS.map((key, index) => [key, address(index + 10)]),
    ) as Record<string, Address>;
    const executor = address(1);
    const deployer = address(2);
    const broadcaster = address(3);

    const targets = baseGovernanceTargets(addresses, executor);
    assert.equal(targets.length, 14);
    assert.equal(new Set(targets.map((target) => target.address.toLowerCase())).size, targets.length);

    const actions = buildBaseGovernanceHandoffPlan({
      addresses,
      executor,
      deployer,
      ethBroadcaster: broadcaster,
    });
    assert.equal(actions.length, 39);
    assert.equal(actions.filter((action) => action.label.startsWith("Executor.allow(")).length, 14);
    assert.equal(actions.at(-1)?.phase, "finalize");
    assert.match(actions.at(-1)?.label ?? "", /MUST BE LAST/);

    const labels = new Set(actions.map((action) => action.label));
    for (const required of [
      "Factory.setAdmin",
      "Treasury.lockBootstrap",
      "DC.grant Executor PAUSER_ROLE",
      "InfoNFT.setAdmin",
      "DCDomainSwap.transferOwner",
    ]) {
      assert.equal(labels.has(required), true, `missing ${required}`);
    }
    assert.equal(BASE_FIXED_OR_READ_ONLY_MODULES.includes("dcDomainHall"), true);
  });

  it("rejects an incomplete deployment manifest before producing calldata", function () {
    assert.throws(
      () => buildBaseGovernanceHandoffPlan({
        addresses: { dealFactory: address(10) },
        executor: address(1),
        deployer: address(2),
        ethBroadcaster: address(3),
      }),
      /Missing Base deployment address/,
    );
  });
});
