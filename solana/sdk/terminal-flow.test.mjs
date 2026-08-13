import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCompletedPostIndexFlow,
  buildCompletedTerminalFlow,
  buildNonCompletedTerminalFlow,
  TERMINAL_DISCRIMINATORS as DISC,
  TERMINAL_PROGRAMS as PROGRAMS,
} from "./terminal-flow.mjs";

const pk = (value) => ({ toBase58: () => value });
const keys = (...values) => values.map((value) => ({ pubkey: pk(value) }));
const data = (disc, byte) =>
  Buffer.concat([Buffer.from(disc, "hex"), byte == null ? Buffer.alloc(0) : Buffer.from([byte])]);
const ix = (programId, disc, accounts, byte) => ({
  programId: pk(programId),
  data: data(disc, byte),
  keys: keys(...accounts),
});

const sdkDir = dirname(fileURLToPath(import.meta.url));
const idlDir = resolve(sdkDir, "../target/idl");

function readIdl(name) {
  return JSON.parse(readFileSync(resolve(idlDir, `${name}.json`), "utf8"));
}

function idlInstructions(idl) {
  return new Map(
    idl.instructions.map((instruction) => [
      instruction.name,
      Buffer.from(instruction.discriminator).toString("hex"),
    ]),
  );
}

function completedFixture() {
  const deal = "deal";
  const terminalReceipt = "terminal";
  const valuationReceipt = "valuation";
  const quote = "quote";
  const rewardReceipt = "reward";
  const creditReceipt = "credit";
  return {
    requirements: {
      dcToDc: false,
      creditMode: "pair",
    },
    resolution: ix(PROGRAMS.assetController, DISC.forceComplete, [
      "caller", "config", "terms", "registry", deal, "a", "b",
    ]),
    finalization: ix(PROGRAMS.finalizer, DISC.finalizeCompleted, [
      "config", "payer", deal, "a", "b", terminalReceipt, "system",
      "asset-config", "instructions", "terms",
    ]),
    valuation: ix(PROGRAMS.valuator, DISC.valueCompletedDeal, [
      "payer", deal, "terms", "registry", "s0", "s1", "wp", "p0", "p1", valuationReceipt,
    ]),
    rewardQuote: ix(PROGRAMS.rewardEngine, DISC.prepareCompletedRewards, [
      "config", "payer", deal, "terms", "asset", "registry", "wp", "p0", "p1", "o0", "o1", "o2", quote,
    ]),
    rewardMint: ix(PROGRAMS.rewardEngine, DISC.mintCompletedRewards, [
      "config", "payer", "minter", deal, quote, "ai", "ait", "ab", "ac", "bi", "bit", "bb", "bc", "ci", "cit", "ad", "bd", "cd", "mint", "dcc", "grant", "token", "controller", rewardReceipt,
    ]),
    credit: ix(PROGRAMS.finalizer, DISC.recordCompletedCredit, [
      "config", "payer", "writer", deal, terminalReceipt, valuationReceipt, "cc", "a", "b", "ab", "bb", "ai", "bi", "at", "bt", "ac", "bc", creditReceipt,
    ]),
  };
}

function completedPostFixture() {
  const deal = "deal";
  const terminalReceipt = "terminal";
  const rewardReceipt = "reward";
  const creditReceipt = "credit";
  return {
    requirements: {
      deal,
      historyPending: true,
      identityRewardRoles: [0],
      rewardIndexRoles: [0, 1],
      creditIndexSides: [0, 1],
      identityUnlockMints: ["a-identity-mint"],
    },
    historyIndex: ix(PROGRAMS.finalizer, DISC.indexCompletedHistory, [
      "config", "payer", "writer", deal, terminalReceipt, "a", "b",
      "history-receipt", "history-config", "a-history", "b-history",
      "history-program", "system",
    ]),
    identityRewardRecords: [
      ix(PROGRAMS.rewardEngine, DISC.recordIdentityReward, [
        "config", "payer", "minter", deal, rewardReceipt, "identity-config", "ai",
      ], 0),
    ],
    rewardIndexes: [
      ix(PROGRAMS.resultIndex, DISC.indexReward, [
        "config", "payer", deal, rewardReceipt, "a",
      ], 0),
      ix(PROGRAMS.resultIndex, DISC.indexReward, [
        "config", "payer", deal, rewardReceipt, "b",
      ], 1),
    ],
    creditIndexes: [
      ix(PROGRAMS.resultIndex, DISC.indexCredit, [
        "config", "payer", deal, creditReceipt, "a",
      ], 0),
      ix(PROGRAMS.resultIndex, DISC.indexCredit, [
        "config", "payer", deal, creditReceipt, "b",
      ], 1),
    ],
    identityUnlocks: [
      ix(PROGRAMS.assetController, DISC.unlockIdentity, [
        "payer", "config", "identity-config", deal, "a-identity-mint",
        "a-owner-token", "ai", "a-binding", "a-lock", "identity-program",
        "token-program", "system-program",
      ]),
    ],
  };
}

test("completed flow returns the canonical atomic order", () => {
  const fixture = completedFixture();
  const flow = buildCompletedTerminalFlow(fixture);
  assert.equal(flow.length, 6);
  assert.equal(flow[0], fixture.resolution);
  assert.equal(flow[1], fixture.finalization);
  assert.equal(flow.at(-1), fixture.credit);
});

test("DC/DC completed flow requires fee routing immediately after resolution", () => {
  const fixture = completedFixture();
  fixture.requirements.dcToDc = true;
  fixture.dcFeeRoute = ix(PROGRAMS.assetController, DISC.routeDcFees, [
    "payer", "config", "terms", "deal", "a-vault", "b-vault", "dc-mint",
  ]);
  const flow = buildCompletedTerminalFlow(fixture);
  assert.equal(flow.length, 7);
  assert.equal(flow[0], fixture.resolution);
  assert.equal(flow[1], fixture.dcFeeRoute);
  assert.equal(flow[2], fixture.finalization);

  delete fixture.dcFeeRoute;
  assert.throws(
    () => buildCompletedTerminalFlow(fixture),
    /dcFeeRoute\.programId: missing public key/,
  );
});

test("completed flow rejects an unexpected or cross-deal DC fee route", () => {
  const fixture = completedFixture();
  fixture.dcFeeRoute = ix(PROGRAMS.assetController, DISC.routeDcFees, [
    "payer", "config", "terms", "deal", "a-vault", "b-vault", "dc-mint",
  ]);
  assert.throws(
    () => buildCompletedTerminalFlow(fixture),
    /unexpected for a non-DC\/DC settlement/,
  );
  fixture.requirements.dcToDc = true;
  fixture.dcFeeRoute.keys[3] = { pubkey: pk("other-deal") };
  assert.throws(
    () => buildCompletedTerminalFlow(fixture),
    /dcFeeRoute\.deal/,
  );
});

test("completed flow rejects a receipt that does not connect", () => {
  const fixture = completedFixture();
  fixture.credit.keys[4] = { pubkey: pk("wrong-terminal") };
  assert.throws(() => buildCompletedTerminalFlow(fixture), /terminal receipt/);
});

test("completed flow rejects a different deal or program", () => {
  const fixture = completedFixture();
  fixture.rewardMint.keys[3] = { pubkey: pk("other-deal") };
  assert.throws(() => buildCompletedTerminalFlow(fixture), /rewardMint\.deal/);
  fixture.rewardMint.keys[3] = { pubkey: pk("deal") };
  fixture.valuation.programId = pk(PROGRAMS.finalizer);
  assert.throws(() => buildCompletedTerminalFlow(fixture), /valuation: expected program/);
});

test("completed post-index flow rejects duplicate result roles", () => {
  const fixture = completedPostFixture();
  fixture.rewardIndexes[1].data[8] = 0;
  assert.throws(() => buildCompletedPostIndexFlow(fixture), /duplicate role\/side/);
});

test("completed post-index flow rejects an omitted required index", () => {
  const fixture = completedPostFixture();
  fixture.rewardIndexes.pop();
  assert.throws(
    () => buildCompletedPostIndexFlow(fixture),
    /rewardIndexes: expected roles\/sides \[0,1\], got \[0\]/,
  );
});

test("completed flow requires an explicit completeness manifest", () => {
  const fixture = completedFixture();
  delete fixture.requirements;
  assert.throws(
    () => buildCompletedTerminalFlow(fixture),
    /completed requirements: required object is missing/,
  );
});

test("completed flow supports a single-identity credit receipt", () => {
  const fixture = completedFixture();
  fixture.requirements.creditMode = "single-a";
  fixture.credit = ix(PROGRAMS.finalizer, DISC.recordCompletedCreditSingle, [
    "config", "payer", "writer", "deal", "terminal", "valuation", "cc",
    "a", "ab", "ai", "at", "ac", "credit", "credit-program", "system",
  ], 1);
  const flow = buildCompletedTerminalFlow(fixture);
  assert.equal(flow.at(-1), fixture.credit);
});

test("completed flow supports a no-identity credit receipt", () => {
  const fixture = completedFixture();
  fixture.requirements.creditMode = "none";
  fixture.credit = ix(PROGRAMS.finalizer, DISC.recordCompletedCreditNone, [
    "config", "payer", "deal", "terminal", "valuation", "credit", "system",
  ]);
  const flow = buildCompletedTerminalFlow(fixture);
  assert.equal(flow.at(-1), fixture.credit);
});

test("completed post-index flow canonicalizes role and side order", () => {
  const fixture = completedPostFixture();
  const identity0 = fixture.identityRewardRecords[0];
  const reward0 = fixture.rewardIndexes[0];
  const reward1 = fixture.rewardIndexes[1];
  const credit0 = fixture.creditIndexes[0];
  const credit1 = fixture.creditIndexes[1];
  fixture.rewardIndexes.reverse();
  fixture.creditIndexes.reverse();
  const flow = buildCompletedPostIndexFlow(fixture);
  assert.equal(flow[0], fixture.historyIndex);
  assert.equal(flow[1], identity0);
  assert.equal(flow[2], reward0);
  assert.equal(flow[3], reward1);
  assert.equal(flow[4], credit0);
  assert.equal(flow[5], credit1);
  assert.equal(flow[6], fixture.identityUnlocks[0]);
});

test("completed post-index flow orders identity unlocks by the AssetTerms A/B manifest", () => {
  const fixture = completedPostFixture();
  fixture.requirements.identityUnlockMints = [
    "a-identity-mint",
    "b-identity-mint",
  ];
  const bUnlock = ix(PROGRAMS.assetController, DISC.unlockIdentity, [
    "b", "config", "identity-config", "deal", "b-identity-mint",
  ]);
  const aUnlock = fixture.identityUnlocks[0];
  fixture.identityUnlocks = [bUnlock, aUnlock];
  const flow = buildCompletedPostIndexFlow(fixture);
  assert.equal(flow.at(-2), aUnlock);
  assert.equal(flow.at(-1), bUnlock);
});

test("completed post-index flow rejects cross-deal derived writes", () => {
  const fixture = completedPostFixture();
  fixture.identityRewardRecords[0].keys[3] = { pubkey: pk("other-deal") };
  assert.throws(
    () => buildCompletedPostIndexFlow(fixture),
    /identityRewardRecords\[0\]\.deal/,
  );
});

test("completed post-index flow resumes only the still-pending derived writes", () => {
  const fixture = completedPostFixture();
  fixture.requirements.historyPending = false;
  fixture.requirements.identityRewardRoles = [];
  fixture.requirements.rewardIndexRoles = [];
  fixture.requirements.creditIndexSides = [1];
  fixture.requirements.identityUnlockMints = ["b-identity-mint"];
  delete fixture.historyIndex;
  fixture.identityRewardRecords = [];
  fixture.rewardIndexes = [];
  fixture.creditIndexes = [fixture.creditIndexes[1]];
  fixture.identityUnlocks = [
    ix(PROGRAMS.assetController, DISC.unlockIdentity, [
      "payer", "config", "identity-config", "deal", "b-identity-mint",
    ]),
  ];
  assert.deepEqual(buildCompletedPostIndexFlow(fixture), [
    fixture.creditIndexes[0],
    fixture.identityUnlocks[0],
  ]);
});

test("completed post-index flow rejects an already-finished history write", () => {
  const fixture = completedPostFixture();
  fixture.requirements.historyPending = false;
  assert.throws(
    () => buildCompletedPostIndexFlow(fixture),
    /historyIndex: unexpected/,
  );
});

test("non-completed flow keeps refund resolution, receipt, then unlock", () => {
  const deal = "deal";
  const resolution = ix(PROGRAMS.assetController, DISC.abandon, [
    "caller", "config", "terms", "registry", deal, "a", "b",
  ]);
  const finalization = ix(PROGRAMS.finalizer, DISC.finalizeNonCompleted, [
    "config", "payer", deal, "receipt",
  ]);
  const unlock = ix(PROGRAMS.assetController, DISC.unlockIdentity, [
    "a", "config", "identity-config", deal, "a-identity-mint",
  ]);
  assert.deepEqual(
    buildNonCompletedTerminalFlow({
      requirements: { identityUnlockMints: ["a-identity-mint"] },
      resolution,
      finalization,
      identityUnlocks: [unlock],
    }),
    [resolution, finalization, unlock],
  );
});

test("SDK program IDs and discriminators match generated Anchor IDLs", () => {
  const specifications = [
    ["deal_asset_controller", PROGRAMS.assetController, {
      abandon: DISC.abandon,
      cast_vote_and_resolve: DISC.castVoteAndResolve,
      force_complete: DISC.forceComplete,
      resolve_votes: DISC.resolveVotes,
      route_dc_fees: DISC.routeDcFees,
      unlock_identity: DISC.unlockIdentity,
    }],
    ["deal_finalizer", PROGRAMS.finalizer, {
      finalize_completed: DISC.finalizeCompleted,
      index_completed_history: DISC.indexCompletedHistory,
      finalize_non_completed: DISC.finalizeNonCompleted,
      record_completed_credit: DISC.recordCompletedCredit,
      record_completed_credit_none: DISC.recordCompletedCreditNone,
      record_completed_credit_single: DISC.recordCompletedCreditSingle,
    }],
    ["deal_credit_valuator", PROGRAMS.valuator, {
      value_completed_deal: DISC.valueCompletedDeal,
    }],
    ["deal_reward_engine", PROGRAMS.rewardEngine, {
      mint_completed_rewards: DISC.mintCompletedRewards,
      prepare_completed_rewards: DISC.prepareCompletedRewards,
      record_identity_reward: DISC.recordIdentityReward,
    }],
    ["deal_result_index", PROGRAMS.resultIndex, {
      index_credit: DISC.indexCredit,
      index_reward: DISC.indexReward,
    }],
  ];

  for (const [idlName, expectedAddress, expectedInstructions] of specifications) {
    const idl = readIdl(idlName);
    assert.equal(idl.address, expectedAddress, `${idlName} program ID drifted`);
    const instructions = idlInstructions(idl);
    for (const [name, expectedDiscriminator] of Object.entries(expectedInstructions)) {
      assert.equal(
        instructions.get(name),
        expectedDiscriminator,
        `${idlName}.${name} discriminator drifted`,
      );
    }
  }

  const accountIndexSpecifications = [
    ["deal_asset_controller", "cast_vote_and_resolve", [[4, "deal"]]],
    ["deal_asset_controller", "resolve_votes", [[4, "deal"]]],
    ["deal_asset_controller", "force_complete", [[4, "deal"]]],
    ["deal_asset_controller", "abandon", [[4, "deal"]]],
    ["deal_asset_controller", "route_dc_fees", [
      [3, "deal"],
      [4, "a_swap_vault"],
      [5, "b_swap_vault"],
      [6, "dc_mint"],
    ]],
    ["deal_asset_controller", "unlock_identity", [[3, "deal"], [4, "identity_mint"]]],
    ["deal_finalizer", "finalize_completed", [
      [2, "deal"],
      [5, "receipt"],
      [9, "terms"],
    ]],
    ["deal_finalizer", "index_completed_history", [
      [3, "deal"],
      [4, "terminal_receipt"],
      [7, "history_receipt"],
    ]],
    ["deal_finalizer", "finalize_non_completed", [[2, "deal"]]],
    ["deal_finalizer", "record_completed_credit", [
      [3, "deal"],
      [4, "terminal_receipt"],
      [5, "valuation_receipt"],
      [17, "credit_receipt"],
    ]],
    ["deal_finalizer", "record_completed_credit_none", [
      [2, "deal"],
      [3, "terminal_receipt"],
      [4, "valuation_receipt"],
      [5, "credit_receipt"],
    ]],
    ["deal_finalizer", "record_completed_credit_single", [
      [3, "deal"],
      [4, "terminal_receipt"],
      [5, "valuation_receipt"],
      [12, "credit_receipt"],
    ]],
    ["deal_credit_valuator", "value_completed_deal", [[1, "deal"], [9, "receipt"]]],
    ["deal_reward_engine", "prepare_completed_rewards", [[2, "deal"], [12, "quote"]]],
    ["deal_reward_engine", "mint_completed_rewards", [
      [3, "deal"],
      [4, "quote"],
      [5, "a_identity"],
      [9, "b_identity"],
      [13, "c_identity"],
      [23, "receipt"],
    ]],
    ["deal_reward_engine", "record_identity_reward", [
      [3, "deal"],
      [4, "reward_receipt"],
      [6, "identity"],
    ]],
    ["deal_result_index", "index_reward", [[2, "deal"], [3, "reward_receipt"]]],
    ["deal_result_index", "index_credit", [[2, "deal"], [3, "credit_receipt"]]],
  ];
  for (const [idlName, instructionName, accounts] of accountIndexSpecifications) {
    const idl = readIdl(idlName);
    const instruction = idl.instructions.find(
      (candidate) => candidate.name === instructionName,
    );
    for (const [index, expectedName] of accounts) {
      assert.equal(
        instruction.accounts[index]?.name,
        expectedName,
        `${idlName}.${instructionName} account ${expectedName} index drifted`,
      );
    }
  }
});
