import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeFunctionData, getAddress } from "viem";

import {
  ACTION_FEE_BUDGET,
  BASE_CHAIN_KEY,
  BASE_FACTORY,
  BROADCASTER,
  BSC_CHAIN_KEY,
  BSC_FACTORY,
  CANARY_DESCRIPTION,
  CANARY_MIN_TIMEOUT,
  CURRENT_MIN_TIMEOUT,
  LZ_GAS,
  MAJOR,
  MIN_TIMEOUT_SETTER_SELECTOR,
  POLICY_DESCRIPTION,
  POLICY_RULES,
  REGISTRY,
  RESTORE_DESCRIPTION,
  broadcasterAbi,
  buildBroadcastCalldata,
  buildCanaryProposalCalldata,
  buildMinTimeoutCalldata,
  buildPolicyProposalCalldata,
  buildSetRulesCalldata,
  factoryAbi,
  governanceAbi,
  registryAbi,
} from "../scripts/lib/cross-chain-min-timeout-canary.js";

describe("BSC + Base minimum-timeout canary plan", function () {
  it("grants only the exact nested Major setter on both factories", function () {
    assert.equal(POLICY_RULES.length, 2);
    assert.deepEqual(POLICY_RULES.map((rule) => rule.target), [BSC_FACTORY, BASE_FACTORY]);
    for (const rule of POLICY_RULES) {
      assert.equal(rule.kind, MAJOR);
      assert.equal(rule.selector, MIN_TIMEOUT_SETTER_SELECTOR);
      assert.equal(rule.allowed, true);
      assert.equal(rule.validateNestedBroadcast, false);
      assert.equal(rule.nestedOnly, true);
      assert.equal(rule.maxValue, 0n);
    }
    const rules = decodeFunctionData({ abi: registryAbi, data: buildSetRulesCalldata() });
    assert.equal(rules.functionName, "setRules");
    assert.equal(rules.args[0].length, 2);
    const proposal = decodeFunctionData({ abi: governanceAbi, data: buildPolicyProposalCalldata() });
    assert.deepEqual(proposal.args[0].map((value) => getAddress(value)), [REGISTRY]);
    assert.deepEqual(proposal.args[1], [0n]);
    assert.deepEqual(proposal.args[2], [buildSetRulesCalldata()]);
    assert.equal(proposal.args[3], POLICY_DESCRIPTION);
    assert.equal(proposal.args[4], MAJOR);
  });

  it("broadcasts one common 3601-second calldata to every active destination", function () {
    const inner = buildMinTimeoutCalldata(CANARY_MIN_TIMEOUT);
    const decodedInner = decodeFunctionData({ abi: factoryAbi, data: inner });
    assert.equal(decodedInner.functionName, "setMinTimeoutSeconds");
    assert.equal(decodedInner.args[0], CANARY_MIN_TIMEOUT);

    const broadcast = decodeFunctionData({ abi: broadcasterAbi, data: buildBroadcastCalldata(CANARY_MIN_TIMEOUT) });
    assert.equal(broadcast.functionName, "broadcast");
    assert.deepEqual(broadcast.args[0], [BSC_CHAIN_KEY, BASE_CHAIN_KEY]);
    assert.deepEqual(broadcast.args[1].map((value) => getAddress(value)), [BSC_FACTORY, BASE_FACTORY]);
    assert.equal(broadcast.args[2], inner);
    assert.equal(broadcast.args[3], LZ_GAS);

    const proposal = decodeFunctionData({
      abi: governanceAbi,
      data: buildCanaryProposalCalldata(CANARY_MIN_TIMEOUT, CANARY_DESCRIPTION),
    });
    assert.deepEqual(proposal.args[0].map((value) => getAddress(value)), [BROADCASTER]);
    assert.deepEqual(proposal.args[1], [ACTION_FEE_BUDGET]);
    assert.deepEqual(proposal.args[2], [buildBroadcastCalldata(CANARY_MIN_TIMEOUT)]);
    assert.equal(proposal.args[3], CANARY_DESCRIPTION);
    assert.equal(proposal.args[4], MAJOR);
  });

  it("keeps restoration in a separate order-independent proposal", function () {
    const canary = buildCanaryProposalCalldata(CANARY_MIN_TIMEOUT, CANARY_DESCRIPTION);
    const restore = buildCanaryProposalCalldata(CURRENT_MIN_TIMEOUT, RESTORE_DESCRIPTION);
    assert.notEqual(canary, restore);
    const decoded = decodeFunctionData({ abi: governanceAbi, data: restore });
    const broadcast = decodeFunctionData({ abi: broadcasterAbi, data: decoded.args[2][0] });
    const inner = decodeFunctionData({ abi: factoryAbi, data: broadcast.args[2] });
    assert.equal(inner.args[0], CURRENT_MIN_TIMEOUT);
    assert.equal(decoded.args[3], RESTORE_DESCRIPTION);
  });
});
