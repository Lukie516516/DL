import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BASE_LEGACY_POOL_PLANS,
  BASE_REAL_OTHER_SMALLEST_UNIT,
  BASE_TOTAL_INITIAL_DC,
  BASE_TREASURY_INITIAL_DC,
} from "../scripts/lib/base-launch-economics.js";
import { planBaseInitialization } from "../scripts/lib/base-initialization-plan.js";

function emptyPools() {
  return BASE_LEGACY_POOL_PLANS.map((pool) => ({
    key: pool.key,
    initialized: false,
    dcBalance: 0n,
    otherBalance: 0n,
    virtualDc: 0n,
    virtualOther: 0n,
  }));
}

describe("Base initialization plan", function () {
  it("plans the exact Treasury and legacy three-pool allocation", function () {
    const plan = planBaseInitialization({
      initializationRecorded: false,
      totalSupply: 0n,
      treasuryDcBalance: 0n,
      pools: emptyPools(),
    });

    assert.equal(plan.auditOnly, false);
    assert.equal(plan.treasuryDcMint, BASE_TREASURY_INITIAL_DC);
    assert.equal(plan.totalDcMint, BASE_TOTAL_INITIAL_DC);
    assert.deepEqual(plan.pools.map((pool) => pool.dcMint), BASE_LEGACY_POOL_PLANS.map((pool) => pool.realDc));
    assert.ok(plan.pools.every((pool) => pool.otherTransfer === BASE_REAL_OTHER_SMALLEST_UNIT));
    assert.ok(plan.pools.every((pool) => pool.initialize));
  });

  it("resumes a partially completed initialization without double minting", function () {
    const first = BASE_LEGACY_POOL_PLANS[0];
    const pools = emptyPools();
    pools[0] = {
      key: first.key,
      initialized: true,
      dcBalance: first.realDc,
      otherBalance: BASE_REAL_OTHER_SMALLEST_UNIT,
      virtualDc: 0n,
      virtualOther: first.effectiveOther - BASE_REAL_OTHER_SMALLEST_UNIT,
    };
    const partialTreasury = BASE_TREASURY_INITIAL_DC / 2n;
    const partialSupply = partialTreasury + first.realDc;

    const plan = planBaseInitialization({
      initializationRecorded: false,
      totalSupply: partialSupply,
      treasuryDcBalance: partialTreasury,
      pools,
    });

    assert.equal(plan.treasuryDcMint, BASE_TREASURY_INITIAL_DC - partialTreasury);
    assert.equal(plan.pools[0].dcMint, 0n);
    assert.equal(plan.pools[0].otherTransfer, 0n);
    assert.equal(plan.pools[0].initialize, false);
    assert.equal(partialSupply + plan.totalDcMint, BASE_TOTAL_INITIAL_DC);
  });

  it("refuses untracked supply and contaminated balances", function () {
    assert.throws(
      () => planBaseInitialization({
        initializationRecorded: false,
        totalSupply: 1n,
        treasuryDcBalance: 0n,
        pools: emptyPools(),
      }),
      /Untracked DC supply/,
    );

    const contaminated = emptyPools();
    contaminated[1].otherBalance = 2n;
    assert.throws(
      () => planBaseInitialization({
        initializationRecorded: false,
        totalSupply: 0n,
        treasuryDcBalance: 0n,
        pools: contaminated,
      }),
      /counterasset balance exceeds initialization target/,
    );
  });

  it("turns a recorded deployment into audit-only mode", function () {
    const pools = BASE_LEGACY_POOL_PLANS.map((pool) => ({
      key: pool.key,
      initialized: true,
      dcBalance: pool.realDc,
      otherBalance: BASE_REAL_OTHER_SMALLEST_UNIT,
      virtualDc: 0n,
      virtualOther: pool.effectiveOther - BASE_REAL_OTHER_SMALLEST_UNIT,
    }));
    const plan = planBaseInitialization({
      initializationRecorded: true,
      totalSupply: BASE_TOTAL_INITIAL_DC,
      treasuryDcBalance: BASE_TREASURY_INITIAL_DC,
      pools,
    });
    assert.equal(plan.auditOnly, true);
    assert.equal(plan.totalDcMint, 0n);
    assert.ok(plan.pools.every((pool) => !pool.initialize));
  });

  it("rejects drift after initialization has been recorded", function () {
    const exactPools = BASE_LEGACY_POOL_PLANS.map((pool) => ({
      key: pool.key,
      initialized: true,
      dcBalance: pool.realDc,
      otherBalance: BASE_REAL_OTHER_SMALLEST_UNIT,
      virtualDc: 0n,
      virtualOther: pool.effectiveOther - BASE_REAL_OTHER_SMALLEST_UNIT,
    }));

    assert.throws(
      () => planBaseInitialization({
        initializationRecorded: true,
        totalSupply: BASE_TOTAL_INITIAL_DC + 1n,
        treasuryDcBalance: BASE_TREASURY_INITIAL_DC,
        pools: exactPools,
      }),
      /total supply mismatch/,
    );

    const driftedPools = exactPools.map((pool) => ({ ...pool }));
    driftedPools[2].otherBalance += 1n;
    assert.throws(
      () => planBaseInitialization({
        initializationRecorded: true,
        totalSupply: BASE_TOTAL_INITIAL_DC,
        treasuryDcBalance: BASE_TREASURY_INITIAL_DC,
        pools: driftedPools,
      }),
      /DC\/WETH recorded initialization state mismatch/,
    );
  });
});
