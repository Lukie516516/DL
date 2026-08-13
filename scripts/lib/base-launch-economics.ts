import { parseUnits, type Address } from "viem";

import { BASE_MAINNET } from "./evm-chain-config.js";

export const BASE_TREASURY_INITIAL_DC = parseUnits("5000000000", 18);
export const BASE_REAL_OTHER_SMALLEST_UNIT = 1n;

export const BASE_LEGACY_POOL_PLANS = [
  {
    key: "pairStable0",
    label: "DC/USDC",
    token: BASE_MAINNET.usdc,
    tokenDecimals: 6,
    realDc: parseUnits("5000000", 18),
    effectiveOther: parseUnits("500", 6),
  },
  {
    key: "pairStable1",
    label: "DC/bridged USDT",
    token: BASE_MAINNET.usdt,
    tokenDecimals: 6,
    realDc: parseUnits("500000000", 18),
    effectiveOther: parseUnits("50000", 6),
  },
  {
    key: "pairWrappedNative",
    label: "DC/WETH",
    token: BASE_MAINNET.weth,
    tokenDecimals: 18,
    realDc: parseUnits("500000000", 18),
    effectiveOther: parseUnits("32", 18),
  },
] as const satisfies ReadonlyArray<{
  key: string;
  label: string;
  token: Address;
  tokenDecimals: number;
  realDc: bigint;
  effectiveOther: bigint;
}>;

export const BASE_POOL_INITIAL_DC = BASE_LEGACY_POOL_PLANS.reduce(
  (total, pool) => total + pool.realDc,
  0n,
);
export const BASE_TOTAL_INITIAL_DC = BASE_TREASURY_INITIAL_DC + BASE_POOL_INITIAL_DC;

export function baseLegacyPoolAmounts() {
  return BASE_LEGACY_POOL_PLANS.map((pool) => ({
    ...pool,
    realOther: BASE_REAL_OTHER_SMALLEST_UNIT,
    virtualOther: pool.effectiveOther - BASE_REAL_OTHER_SMALLEST_UNIT,
  }));
}
