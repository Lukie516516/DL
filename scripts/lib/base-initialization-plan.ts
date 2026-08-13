import {
  BASE_LEGACY_POOL_PLANS,
  BASE_REAL_OTHER_SMALLEST_UNIT,
  BASE_TOTAL_INITIAL_DC,
  BASE_TREASURY_INITIAL_DC,
} from "./base-launch-economics.js";

export type BasePoolInitializationState = {
  key: (typeof BASE_LEGACY_POOL_PLANS)[number]["key"];
  initialized: boolean;
  dcBalance: bigint;
  otherBalance: bigint;
  virtualDc: bigint;
  virtualOther: bigint;
};

export type BaseInitializationState = {
  initializationRecorded: boolean;
  totalSupply: bigint;
  treasuryDcBalance: bigint;
  pools: readonly BasePoolInitializationState[];
};

export type BasePoolInitializationAction = {
  key: BasePoolInitializationState["key"];
  label: string;
  dcMint: bigint;
  otherTransfer: bigint;
  virtualOther: bigint;
  initialize: boolean;
};

export type BaseInitializationPlan = {
  auditOnly: boolean;
  treasuryDcMint: bigint;
  pools: readonly BasePoolInitializationAction[];
  totalDcMint: bigint;
};

function assertNonNegative(label: string, value: bigint) {
  if (value < 0n) throw new Error(`${label} cannot be negative`);
}

function topUpDelta(label: string, current: bigint, target: bigint): bigint {
  assertNonNegative(label, current);
  if (current > target) {
    throw new Error(`${label} exceeds initialization target: ${current} > ${target}`);
  }
  return target - current;
}

export function planBaseInitialization(state: BaseInitializationState): BaseInitializationPlan {
  if (state.pools.length !== BASE_LEGACY_POOL_PLANS.length) {
    throw new Error(`Expected ${BASE_LEGACY_POOL_PLANS.length} pool states, got ${state.pools.length}`);
  }

  const stateByKey = new Map(state.pools.map((pool) => [pool.key, pool] as const));
  for (const expected of BASE_LEGACY_POOL_PLANS) {
    if (!stateByKey.has(expected.key)) throw new Error(`Missing pool state: ${expected.key}`);
  }

  if (state.initializationRecorded) {
    if (state.totalSupply !== BASE_TOTAL_INITIAL_DC) {
      throw new Error(
        `Recorded initialization total supply mismatch: ${state.totalSupply} != ${BASE_TOTAL_INITIAL_DC}`,
      );
    }
    if (state.treasuryDcBalance !== BASE_TREASURY_INITIAL_DC) {
      throw new Error(
        `Recorded initialization Treasury balance mismatch: `
        + `${state.treasuryDcBalance} != ${BASE_TREASURY_INITIAL_DC}`,
      );
    }
    for (const expected of BASE_LEGACY_POOL_PLANS) {
      const current = stateByKey.get(expected.key)!;
      if (!current.initialized) throw new Error(`${expected.label} is not initialized despite deployment record`);
      const expectedVirtualOther = expected.effectiveOther - BASE_REAL_OTHER_SMALLEST_UNIT;
      if (current.dcBalance !== expected.realDc
        || current.otherBalance !== BASE_REAL_OTHER_SMALLEST_UNIT
        || current.virtualDc !== 0n
        || current.virtualOther !== expectedVirtualOther) {
        throw new Error(
          `${expected.label} recorded initialization state mismatch: `
          + `balances=${current.dcBalance}/${current.otherBalance}, `
          + `virtual=${current.virtualDc}/${current.virtualOther}`,
        );
      }
    }
    return {
      auditOnly: true,
      treasuryDcMint: 0n,
      pools: BASE_LEGACY_POOL_PLANS.map((pool) => ({
        key: pool.key,
        label: pool.label,
        dcMint: 0n,
        otherTransfer: 0n,
        virtualOther: pool.effectiveOther - BASE_REAL_OTHER_SMALLEST_UNIT,
        initialize: false,
      })),
      totalDcMint: 0n,
    };
  }

  assertNonNegative("DC total supply", state.totalSupply);
  const knownDc = state.treasuryDcBalance
    + state.pools.reduce((sum, pool) => sum + pool.dcBalance, 0n);
  if (knownDc !== state.totalSupply) {
    throw new Error(
      `Untracked DC supply before initialization: known=${knownDc}, totalSupply=${state.totalSupply}`,
    );
  }

  const treasuryDcMint = topUpDelta(
    "Treasury DC balance",
    state.treasuryDcBalance,
    BASE_TREASURY_INITIAL_DC,
  );

  const pools = BASE_LEGACY_POOL_PLANS.map((expected) => {
    const current = stateByKey.get(expected.key)!;
    const virtualOther = expected.effectiveOther - BASE_REAL_OTHER_SMALLEST_UNIT;

    if (current.initialized) {
      if (current.virtualDc !== 0n || current.virtualOther !== virtualOther) {
        throw new Error(
          `${expected.label} initialized with unexpected virtual reserves: `
          + `${current.virtualDc}/${current.virtualOther}`,
        );
      }
      return {
        key: expected.key,
        label: expected.label,
        dcMint: 0n,
        otherTransfer: 0n,
        virtualOther,
        initialize: false,
      };
    }

    if (current.virtualDc !== 0n || current.virtualOther !== 0n) {
      throw new Error(`${expected.label} has virtual reserves before initialization`);
    }
    return {
      key: expected.key,
      label: expected.label,
      dcMint: topUpDelta(`${expected.label} DC balance`, current.dcBalance, expected.realDc),
      otherTransfer: topUpDelta(
        `${expected.label} counterasset balance`,
        current.otherBalance,
        BASE_REAL_OTHER_SMALLEST_UNIT,
      ),
      virtualOther,
      initialize: true,
    };
  });

  const totalDcMint = treasuryDcMint + pools.reduce((sum, pool) => sum + pool.dcMint, 0n);
  if (state.totalSupply + totalDcMint !== BASE_TOTAL_INITIAL_DC) {
    throw new Error(
      `Planned DC supply mismatch: ${state.totalSupply + totalDcMint} != ${BASE_TOTAL_INITIAL_DC}`,
    );
  }

  return { auditOnly: false, treasuryDcMint, pools, totalDcMint };
}
