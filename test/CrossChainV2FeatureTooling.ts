import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decodeFunctionData,
  getAddress,
  keccak256,
  padHex,
  toHex,
  type Hex,
} from "viem";

import {
  broadcasterAbi,
  buildProposalPlan,
  governanceAbi,
  messageHash,
  normalizeFeatureManifest,
  sameNumberSet,
} from "../scripts/lib/cross-chain-v2-feature.js";

const BROADCASTER = getAddress("0x1111111111111111111111111111111111111111");
const ETH_TARGET = getAddress("0x2222222222222222222222222222222222222222");
const BSC_TARGET = getAddress("0x3333333333333333333333333333333333333333");
const LOCAL_DATA = "0x12345678" as Hex;
const REMOTE_DATA = "0x90abcdef" as Hex;

function manifest() {
  return {
    schemaVersion: 1,
    featureId: "sample-feature",
    proposalKind: 2,
    title: "跨链功能测试",
    body: "只验证规划器生成的 action、nonce 和消息哈希。",
    localActions: [
      {
        label: "ETH 开启功能",
        target: ETH_TARGET,
        valueWei: "0",
        calldata: LOCAL_DATA,
      },
    ],
    broadcasts: [
      {
        label: "BSC 开启功能",
        targets: [{ chainKey: 30102, target: BSC_TARGET }],
        calldata: REMOTE_DATA,
        lzGas: "500000",
        feeBudgetWei: "2000000000000000",
      },
    ],
  };
}

describe("CrossChain V2 feature tooling", function () {
  it("builds the exact DAO actions and predicted remote message", function () {
    const normalized = normalizeFeatureManifest(manifest());
    const plan = buildProposalPlan(normalized, BROADCASTER, 7n);

    assert.equal(plan.actions.length, 2);
    assert.equal(plan.actions[0].target, ETH_TARGET);
    assert.equal(plan.actions[0].calldata, LOCAL_DATA);
    assert.equal(plan.actions[1].target, BROADCASTER);
    assert.equal(plan.actions[1].valueWei, 2_000_000_000_000_000n);

    const decodedBroadcast = decodeFunctionData({
      abi: broadcasterAbi,
      data: plan.actions[1].calldata,
    });
    assert.equal(decodedBroadcast.functionName, "broadcast");
    assert.deepEqual(decodedBroadcast.args[0], [30102]);
    assert.deepEqual(decodedBroadcast.args[1], [BSC_TARGET]);
    assert.equal(decodedBroadcast.args[2], REMOTE_DATA);
    assert.equal(decodedBroadcast.args[3], 500_000n);

    const decodedProposal = decodeFunctionData({
      abi: governanceAbi,
      data: plan.createProposalCalldata,
    });
    assert.equal(decodedProposal.functionName, "createProposal");
    assert.deepEqual(decodedProposal.args[0], [ETH_TARGET, BROADCASTER]);
    assert.deepEqual(decodedProposal.args[1], [0n, 2_000_000_000_000_000n]);
    assert.equal(decodedProposal.args[3], plan.description);
    assert.equal(decodedProposal.args[4], 2);

    assert.equal(plan.predictedMessages.length, 1);
    assert.equal(plan.predictedMessages[0].nonce, 8n);
    assert.equal(
      plan.predictedMessages[0].messageHash,
      messageHash(8n, BSC_TARGET, REMOTE_DATA),
    );
  });

  it("increments the predicted nonce once per broadcast action", function () {
    const input = manifest();
    input.broadcasts.push({
      ...input.broadcasts[0],
      label: "BSC 第二次调用",
      calldata: `0x90abcdef${toHex(1n, { size: 32 }).slice(2)}` as Hex,
    });
    const plan = buildProposalPlan(
      normalizeFeatureManifest(input),
      BROADCASTER,
      12n,
    );
    assert.deepEqual(
      plan.predictedMessages.map((entry) => entry.nonce),
      [13n, 14n],
    );
    assert.notEqual(
      plan.predictedMessages[0].messageHash,
      plan.predictedMessages[1].messageHash,
    );
  });

  it("rejects malformed manifests and duplicate chain targets", function () {
    assert.throws(
      () =>
        normalizeFeatureManifest({
          ...manifest(),
          title: "x".repeat(33),
        }),
      /title/,
    );
    const duplicate = manifest();
    duplicate.broadcasts[0].targets.push({
      chainKey: 30102,
      target: ETH_TARGET,
    });
    assert.throws(
      () => normalizeFeatureManifest(duplicate),
      /duplicate chain keys/,
    );
    assert.throws(
      () =>
        normalizeFeatureManifest({
          ...manifest(),
          proposalKind: 1,
        }),
      /proposalKind/,
    );
  });

  it("compares active chain sets without depending on order", function () {
    assert.equal(sameNumberSet([30102, 30110], [30110, 30102]), true);
    assert.equal(sameNumberSet([30102], [30102, 30110]), false);
    assert.equal(
      messageHash(1n, BSC_TARGET, REMOTE_DATA),
      keccak256(
        `0x${toHex(1n, { size: 32 }).slice(2)}${padHex(BSC_TARGET, {
          size: 32,
        }).slice(2)}${toHex(96n, { size: 32 }).slice(2)}${toHex(
          4n,
          { size: 32 },
        ).slice(2)}${REMOTE_DATA.slice(2)}${"0".repeat(56)}` as Hex,
      ),
    );
  });
});
