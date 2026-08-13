import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeFunctionData, getAddress } from "viem";

import {
  ACTION_FEE_BUDGET,
  BASE_CHAIN_KEY,
  BASE_EXECUTOR,
  BASE_FACTORY,
  BASE_PROBE,
  BROADCASTER,
  BSC_CHAIN_KEY,
  BSC_EXECUTOR,
  BSC_FACTORY,
  BSC_PROBE,
  CANARY_DESCRIPTION,
  CANARY_MESSAGE_FEE,
  CHAIN_FEE_CONFIGS,
  CURRENT_MESSAGE_FEE,
  EXECUTOR_ALLOWLIST_SELECTOR,
  GOVERNANCE,
  LZ_GAS,
  MAJOR,
  MESSAGE_FEE_SETTER_SELECTOR,
  POLICY_DESCRIPTION,
  POLICY_RULES,
  PROBE_MARKER_SELECTOR,
  REGISTRY,
  RESTORE_DESCRIPTION,
  broadcasterAbi,
  buildMessageFeeActions,
  buildMessageFeeProposalCalldata,
  buildPolicyProposalCalldata,
  buildSetRulesCalldata,
  factoryAbi,
  governanceAbi,
  registryAbi,
} from "../scripts/lib/cross-chain-message-fee-canary.js";

describe("BSC + Base message-fee canary plan", function () {
  it("closes Probe markers and grants only the two exact DAO management selectors", function () {
    assert.equal(POLICY_RULES.length, 5);
    assert.deepEqual(POLICY_RULES.map((rule) => rule.target), [
      BSC_PROBE,
      BASE_PROBE,
      BSC_FACTORY,
      BASE_FACTORY,
      BASE_EXECUTOR,
    ]);
    for (const rule of POLICY_RULES.slice(0, 2)) {
      assert.equal(rule.kind, MAJOR);
      assert.equal(rule.selector, PROBE_MARKER_SELECTOR);
      assert.equal(rule.allowed, false);
      assert.equal(rule.validateNestedBroadcast, false);
      assert.equal(rule.nestedOnly, false);
      assert.equal(rule.maxValue, 0n);
    }
    for (const rule of POLICY_RULES.slice(2, 4)) {
      assert.equal(rule.kind, MAJOR);
      assert.equal(rule.selector, MESSAGE_FEE_SETTER_SELECTOR);
      assert.equal(rule.allowed, true);
      assert.equal(rule.validateNestedBroadcast, false);
      assert.equal(rule.nestedOnly, true);
      assert.equal(rule.maxValue, 0n);
    }
    for (const rule of POLICY_RULES.slice(4)) {
      assert.equal(rule.kind, MAJOR);
      assert.equal(rule.selector, EXECUTOR_ALLOWLIST_SELECTOR);
      assert.equal(rule.allowed, true);
      assert.equal(rule.validateNestedBroadcast, false);
      assert.equal(rule.nestedOnly, true);
      assert.equal(rule.maxValue, 0n);
    }

    const decodedRules = decodeFunctionData({ abi: registryAbi, data: buildSetRulesCalldata() });
    assert.equal(decodedRules.functionName, "setRules");
    assert.equal(decodedRules.args[0].length, 5);

    const proposal = decodeFunctionData({ abi: governanceAbi, data: buildPolicyProposalCalldata() });
    assert.equal(proposal.functionName, "createProposal");
    assert.deepEqual(proposal.args[0].map((address) => getAddress(address)), [REGISTRY]);
    assert.deepEqual(proposal.args[1], [0n]);
    assert.deepEqual(proposal.args[2], [buildSetRulesCalldata()]);
    assert.equal(proposal.args[3], POLICY_DESCRIPTION);
    assert.equal(proposal.args[4], MAJOR);
  });

  it("builds one all-active-chain 104 -> 105 broadcast with common calldata", function () {
    const actions = buildMessageFeeActions(CANARY_MESSAGE_FEE);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].chain, "BSC+Base");
    assert.equal(actions[0].target, BROADCASTER);
    assert.equal(actions[0].value, ACTION_FEE_BUDGET);

    const outer = decodeFunctionData({ abi: broadcasterAbi, data: actions[0].calldata });
    assert.equal(outer.functionName, "broadcast");
    assert.deepEqual(outer.args[0], [BSC_CHAIN_KEY, BASE_CHAIN_KEY]);
    assert.deepEqual(
      outer.args[1].map((address) => getAddress(address)),
      [BSC_FACTORY, BASE_FACTORY],
    );
    assert.equal(outer.args[2], actions[0].innerCalldata);
    assert.equal(outer.args[3], LZ_GAS);

    const inner = decodeFunctionData({ abi: factoryAbi, data: actions[0].innerCalldata });
    assert.equal(inner.functionName, "setMessagePriceAmount");
    assert.equal(inner.args[0], CANARY_MESSAGE_FEE);

    const proposal = decodeFunctionData({
      abi: governanceAbi,
      data: buildMessageFeeProposalCalldata(CANARY_MESSAGE_FEE, CANARY_DESCRIPTION),
    });
    assert.equal(proposal.functionName, "createProposal");
    assert.deepEqual(proposal.args[0].map((address) => getAddress(address)), [BROADCASTER]);
    assert.deepEqual(proposal.args[1], [ACTION_FEE_BUDGET]);
    assert.deepEqual(proposal.args[2], actions.map((action) => action.calldata));
    assert.equal(proposal.args[3], CANARY_DESCRIPTION);
    assert.equal(proposal.args[4], MAJOR);
  });

  it("restores both chains to 104 without relying on cross-chain message order", function () {
    const actions = buildMessageFeeActions(CURRENT_MESSAGE_FEE);
    assert.equal(actions.length, 1);
    for (const action of actions) {
      const inner = decodeFunctionData({ abi: factoryAbi, data: action.innerCalldata });
      assert.equal(inner.args[0], CURRENT_MESSAGE_FEE);
    }
    const restore = decodeFunctionData({
      abi: governanceAbi,
      data: buildMessageFeeProposalCalldata(CURRENT_MESSAGE_FEE, RESTORE_DESCRIPTION),
    });
    assert.equal(restore.args[3], RESTORE_DESCRIPTION);
    assert.deepEqual(restore.args[0].map((address) => getAddress(address)), [BROADCASTER]);
  });

  it("does not put +1 and -1 into one proposal", function () {
    const canary = buildMessageFeeActions(CANARY_MESSAGE_FEE);
    const restore = buildMessageFeeActions(CURRENT_MESSAGE_FEE);
    assert.ok(canary.every((action) => !restore.some((item) => item.calldata === action.calldata)));
    assert.notEqual(CANARY_DESCRIPTION, RESTORE_DESCRIPTION);
    assert.notEqual(GOVERNANCE, REGISTRY);
  });
});
