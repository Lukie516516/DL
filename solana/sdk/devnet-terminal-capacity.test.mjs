import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMaximumCompletedPostIndexFlow,
  buildMaximumDcToDcCompletedFlow,
  buildMaximumRewardCompletedFlow,
  COMPUTE_BUDGET_INSTRUCTION_COUNT,
  MAXIMUM_DC_TO_DC_CORE_INSTRUCTION_COUNT,
  MAXIMUM_POST_INDEX_INSTRUCTION_COUNT,
  MAXIMUM_REWARD_CORE_INSTRUCTION_COUNT,
  measureTerminalCapacity,
  PACKET_DATA_SIZE,
} from "./devnet-terminal-capacity.mjs";

test("maximum DC/DC identity and fee-C flow contains its exact terminal suffix", () => {
  assert.equal(
    buildMaximumDcToDcCompletedFlow().length,
    MAXIMUM_DC_TO_DC_CORE_INSTRUCTION_COUNT,
  );
});

test("maximum non-DC reward flow contains A, B and C reward records", () => {
  assert.equal(
    buildMaximumRewardCompletedFlow().length,
    MAXIMUM_REWARD_CORE_INSTRUCTION_COUNT,
  );
});

test("maximum permissionless post-index flow contains all derived writes", () => {
  assert.equal(
    buildMaximumCompletedPostIndexFlow().length,
    MAXIMUM_POST_INDEX_INSTRUCTION_COUNT,
  );
});

test("all production-valid maximum flows fit v0 plus one ALT", () => {
  const reports = measureTerminalCapacity();
  for (const report of Object.values(reports)) {
    assert.equal(
      report.transactionInstructionCount,
      report.terminalInstructionCount + COMPUTE_BUDGET_INSTRUCTION_COUNT,
    );
    assert.equal(report.lookupTableCount, 1);
    assert.ok(report.signerCount >= 1 && report.signerCount <= 2);
    assert.ok(report.uniqueAccountCount > 32);
    assert.ok(report.serializedBytes <= PACKET_DATA_SIZE, JSON.stringify(report));
    assert.equal(report.fitsPacket, true);
  }
  assert.equal(reports.dcToDcCore.signerCount, 2);
  assert.equal(reports.maximumRewardCore.signerCount, 2);
  assert.equal(reports.maximumPostIndex.signerCount, 1);
});
