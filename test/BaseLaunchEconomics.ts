import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatUnits, parseUnits } from "viem";

import {
  BASE_POOL_INITIAL_DC,
  BASE_TOTAL_INITIAL_DC,
  BASE_TREASURY_INITIAL_DC,
  baseLegacyPoolAmounts,
} from "../scripts/lib/base-launch-economics.js";

describe("Base legacy launch economics", function () {
  it("matches the Ethereum/BSC DC allocations and Ethereum asset precision exactly", function () {
    const pools = baseLegacyPoolAmounts();
    assert.deepEqual(pools.map((pool) => pool.realDc), [
      parseUnits("5000000", 18),
      parseUnits("500000000", 18),
      parseUnits("500000000", 18),
    ]);
    assert.deepEqual(pools.map((pool) => pool.realOther), [1n, 1n, 1n]);
    assert.deepEqual(pools.map((pool) => pool.virtualOther), [
      499_999_999n,
      49_999_999_999n,
      31_999_999_999_999_999_999n,
    ]);
    assert.equal(formatUnits(BASE_TREASURY_INITIAL_DC, 18), "5000000000");
    assert.equal(formatUnits(BASE_POOL_INITIAL_DC, 18), "1005000000");
    assert.equal(formatUnits(BASE_TOTAL_INITIAL_DC, 18), "6005000000");
  });

  it("keeps effective reserves at 500 USDC, 50,000 USDT and 32 WETH", function () {
    const pools = baseLegacyPoolAmounts();
    assert.deepEqual(
      pools.map((pool) => formatUnits(pool.realOther + pool.virtualOther, pool.tokenDecimals)),
      ["500", "50000", "32"],
    );
  });
});
