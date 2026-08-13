const PROGRAMS = Object.freeze({
  assetController: "5ezPaVi6sh3QUaNLyipjPQXQQ5diaF8MYv8QpFQpaYWo",
  finalizer: "5VGLevrU3z3P9Epr6E1nTuMuxTdqqZiusbz21NugTgG9",
  valuator: "5mXPbnW19tZ3M4CLz59riBfF8u6sEq2LJxDjBB434v4m",
  rewardEngine: "EVq7dnxAft4VVAXp3gZvt93DnJyUA3uwBRSS86yxZwo5",
  resultIndex: "CwCq9ZzGg1SLhxgZohcqWDzyorzw9ro6iA7EFov8Fvom",
  identity: "GTVqt2Zky42gqpxoLC7Zc2xUWKDAdkzkw26MUogpRk7e",
});

const DISC = Object.freeze({
  castVoteAndResolve: "e6795308f9175a2d",
  resolveVotes: "dffdb5b05497eeea",
  forceComplete: "55741656efa86966",
  abandon: "b2c5a5e3024eb5c2",
  routeDcFees: "77d103e772d77d4a",
  finalizeCompleted: "85fe5c8cd1ca2ce9",
  indexCompletedHistory: "c6137a1704bb5bfe",
  finalizeNonCompleted: "4254f826d8f91b49",
  valueCompletedDeal: "6fa3a0e7cd08bd4a",
  prepareCompletedRewards: "9b0d711e88f9a9bf",
  mintCompletedRewards: "280bd1622f8b5fde",
  recordIdentityReward: "76727b89e9379420",
  recordCompletedCredit: "2a8cade0808020c4",
  recordCompletedCreditNone: "4600ca7748358014",
  recordCompletedCreditSingle: "d508672ddffea9c6",
  indexReward: "f4da5cfec86bc6b2",
  indexCredit: "5712c162541595d6",
  unlockIdentity: "ce0b80abff9769c1",
});

function publicKey(value, label) {
  if (value == null) throw new Error(`${label}: missing public key`);
  if (typeof value === "string") return value;
  if (typeof value.toBase58 === "function") return value.toBase58();
  const rendered = value.toString?.();
  if (!rendered || rendered === "[object Object]") {
    throw new Error(`${label}: unsupported public key value`);
  }
  return rendered;
}

function keyAt(ix, index, label) {
  if (!ix || !Array.isArray(ix.keys) || !ix.keys[index]) {
    throw new Error(`${label}: missing account at index ${index}`);
  }
  return publicKey(ix.keys[index].pubkey, `${label}.keys[${index}]`);
}

function discriminator(ix, label) {
  if (!ix?.data || ix.data.length < 8) {
    throw new Error(`${label}: instruction data is shorter than 8 bytes`);
  }
  return Array.from(ix.data.slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function assertInstruction(ix, label, program, allowedDiscriminators) {
  const actualProgram = publicKey(ix?.programId, `${label}.programId`);
  if (actualProgram !== program) {
    throw new Error(`${label}: expected program ${program}, got ${actualProgram}`);
  }
  const actualDisc = discriminator(ix, label);
  if (!allowedDiscriminators.includes(actualDisc)) {
    throw new Error(`${label}: unexpected discriminator ${actualDisc}`);
  }
}

function assertSame(label, left, right) {
  if (left !== right) throw new Error(`${label}: ${left} != ${right}`);
}

function assertSameDeal(expected, ix, index, label) {
  assertSame(`${label}.deal`, expected, keyAt(ix, index, label));
}

function byteArg(ix, label) {
  if (!ix?.data || ix.data.length < 9) {
    throw new Error(`${label}: missing role/side byte`);
  }
  return ix.data[8];
}

function expectedByteSet(value, label, maxValue) {
  if (!Array.isArray(value)) throw new Error(`${label}: expected an array`);
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (!Number.isInteger(item) || item < 0 || item > maxValue) {
      throw new Error(`${label}: invalid role/side ${item}`);
    }
    if (seen.has(item)) throw new Error(`${label}: duplicate role/side ${item}`);
    seen.add(item);
    result.push(item);
  }
  return result.sort((left, right) => left - right);
}

function expectedKeySet(value, label, maxLength) {
  if (!Array.isArray(value)) throw new Error(`${label}: expected an array`);
  if (value.length > maxLength) {
    throw new Error(`${label}: expected at most ${maxLength} public keys`);
  }
  const result = value.map((item, index) =>
    publicKey(item, `${label}[${index}]`),
  );
  const unique = new Set(result);
  if (unique.size !== result.length) {
    throw new Error(`${label}: duplicate public key`);
  }
  return result;
}

function exactByteInstructions(instructions, expected, label) {
  const decorated = instructions.map((ix, index) => ({
    ix,
    value: byteArg(ix, `${label}[${index}]`),
  }));
  const actual = decorated.map(({ value }) => value);
  if (new Set(actual).size !== actual.length) {
    throw new Error(`${label}: duplicate role/side`);
  }
  actual.sort((left, right) => left - right);
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(
      `${label}: expected roles/sides [${expected.join(",")}], got [${actual.join(",")}]`,
    );
  }
  decorated.sort((left, right) => left.value - right.value);
  return decorated;
}

function exactIdentityUnlocks(
  instructions,
  expectedMints,
  deal,
  label,
) {
  const byMint = new Map();
  for (const [index, ix] of instructions.entries()) {
    const itemLabel = `${label}[${index}]`;
    assertSameDeal(deal, ix, 3, itemLabel);
    const mint = keyAt(ix, 4, itemLabel);
    if (byMint.has(mint)) {
      throw new Error(`${label}: duplicate public key`);
    }
    byMint.set(mint, ix);
  }
  if (
    byMint.size !== expectedMints.length ||
    expectedMints.some((mint) => !byMint.has(mint))
  ) {
    throw new Error(
      `${label}: expected public keys [${expectedMints.join(",")}], got [${[...byMint.keys()].join(",")}]`,
    );
  }
  return expectedMints.map((mint) => byMint.get(mint));
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: required object is missing`);
  }
  return value;
}

function requiredBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new Error(`${label}: expected a boolean`);
  }
  return value;
}

function creditLayout(credit, mode) {
  switch (mode) {
    case "pair":
      assertInstruction(credit, "credit", PROGRAMS.finalizer, [
        DISC.recordCompletedCredit,
      ]);
      return {
        dealIndex: 3,
        terminalReceiptIndex: 4,
        valuationReceiptIndex: 5,
        creditReceiptIndex: 17,
        allowedSides: new Set([0, 1]),
      };
    case "single-a":
    case "single-b": {
      assertInstruction(credit, "credit", PROGRAMS.finalizer, [
        DISC.recordCompletedCreditSingle,
      ]);
      const expectedPartyA = mode === "single-a" ? 1 : 0;
      if (byteArg(credit, "credit") !== expectedPartyA) {
        throw new Error(
          `credit: ${mode} requires is_party_a=${expectedPartyA}`,
        );
      }
      return {
        dealIndex: 3,
        terminalReceiptIndex: 4,
        valuationReceiptIndex: 5,
        creditReceiptIndex: 12,
        allowedSides: new Set([mode === "single-a" ? 0 : 1]),
      };
    }
    case "none":
      assertInstruction(credit, "credit", PROGRAMS.finalizer, [
        DISC.recordCompletedCreditNone,
      ]);
      return {
        dealIndex: 2,
        terminalReceiptIndex: 3,
        valuationReceiptIndex: 4,
        creditReceiptIndex: 5,
        allowedSides: new Set(),
      };
    default:
      throw new Error(
        "requirements.creditMode: expected pair, single-a, single-b, or none",
      );
  }
}

function asArray(value, label, maxLength) {
  const result = value ?? [];
  if (!Array.isArray(result)) throw new Error(`${label}: expected an array`);
  if (result.length > maxLength) {
    throw new Error(`${label}: expected at most ${maxLength} instructions`);
  }
  return result;
}

export function buildCompletedTerminalFlow(input) {
  if (!input) throw new Error("completed flow input is required");
  const requirements = requiredObject(
    input.requirements,
    "completed requirements",
  );
  const dcToDc = requiredBoolean(
    requirements.dcToDc,
    "requirements.dcToDc",
  );
  const selectedCreditLayout = creditLayout(
    input.credit,
    requirements.creditMode,
  );

  assertInstruction(input.resolution, "resolution", PROGRAMS.assetController, [
    DISC.castVoteAndResolve,
    DISC.resolveVotes,
    DISC.forceComplete,
  ]);
  if (dcToDc) {
    assertInstruction(input.dcFeeRoute, "dcFeeRoute", PROGRAMS.assetController, [
      DISC.routeDcFees,
    ]);
  } else if (input.dcFeeRoute != null) {
    throw new Error("dcFeeRoute: unexpected for a non-DC/DC settlement");
  }
  assertInstruction(input.finalization, "finalization", PROGRAMS.finalizer, [
    DISC.finalizeCompleted,
  ]);
  assertInstruction(input.valuation, "valuation", PROGRAMS.valuator, [
    DISC.valueCompletedDeal,
  ]);
  assertInstruction(input.rewardQuote, "rewardQuote", PROGRAMS.rewardEngine, [
    DISC.prepareCompletedRewards,
  ]);
  assertInstruction(input.rewardMint, "rewardMint", PROGRAMS.rewardEngine, [
    DISC.mintCompletedRewards,
  ]);
  const deal = keyAt(input.resolution, 4, "resolution");
  if (dcToDc) {
    assertSameDeal(deal, input.dcFeeRoute, 3, "dcFeeRoute");
  }
  assertSameDeal(deal, input.finalization, 2, "finalization");
  assertSameDeal(deal, input.valuation, 1, "valuation");
  assertSameDeal(deal, input.rewardQuote, 2, "rewardQuote");
  assertSameDeal(deal, input.rewardMint, 3, "rewardMint");
  assertSameDeal(
    deal,
    input.credit,
    selectedCreditLayout.dealIndex,
    "credit",
  );

  assertSame(
    "terminal receipt",
    keyAt(input.finalization, 5, "finalization"),
    keyAt(
      input.credit,
      selectedCreditLayout.terminalReceiptIndex,
      "credit",
    ),
  );
  assertSame(
    "valuation receipt",
    keyAt(input.valuation, 9, "valuation"),
    keyAt(
      input.credit,
      selectedCreditLayout.valuationReceiptIndex,
      "credit",
    ),
  );
  assertSame(
    "reward quote",
    keyAt(input.rewardQuote, 12, "rewardQuote"),
    keyAt(input.rewardMint, 4, "rewardMint"),
  );

  return [
    input.resolution,
    ...(dcToDc ? [input.dcFeeRoute] : []),
    input.finalization,
    input.valuation,
    input.rewardQuote,
    input.rewardMint,
    input.credit,
  ];
}

export function buildCompletedPostIndexFlow(input) {
  if (!input) throw new Error("completed post-index input is required");
  const requirements = requiredObject(
    input.requirements,
    "post-index requirements",
  );
  const deal = publicKey(requirements.deal, "requirements.deal");
  const historyPending = requiredBoolean(
    requirements.historyPending,
    "requirements.historyPending",
  );
  const expectedIdentityRewardRoles = expectedByteSet(
    requirements.identityRewardRoles,
    "requirements.identityRewardRoles",
    2,
  );
  const expectedRewardIndexRoles = expectedByteSet(
    requirements.rewardIndexRoles,
    "requirements.rewardIndexRoles",
    2,
  );
  const expectedCreditIndexSides = expectedByteSet(
    requirements.creditIndexSides,
    "requirements.creditIndexSides",
    1,
  );
  const expectedIdentityUnlockMints = expectedKeySet(
    requirements.identityUnlockMints,
    "requirements.identityUnlockMints",
    2,
  );
  const identityRewardRecords = asArray(
    input.identityRewardRecords,
    "identityRewardRecords",
    3,
  );
  const rewardIndexes = asArray(input.rewardIndexes, "rewardIndexes", 3);
  const creditIndexes = asArray(input.creditIndexes, "creditIndexes", 2);
  const identityUnlocks = asArray(input.identityUnlocks, "identityUnlocks", 2);

  if (historyPending) {
    assertInstruction(input.historyIndex, "historyIndex", PROGRAMS.finalizer, [
      DISC.indexCompletedHistory,
    ]);
    assertSameDeal(deal, input.historyIndex, 3, "historyIndex");
  } else if (input.historyIndex != null) {
    throw new Error("historyIndex: unexpected when historyPending is false");
  }
  const orderedIdentityUnlocks = exactIdentityUnlocks(
    identityUnlocks,
    expectedIdentityUnlockMints,
    deal,
    "identityUnlocks",
  );
  for (const [index, ix] of orderedIdentityUnlocks.entries()) {
    const label = `identityUnlocks[${index}]`;
    assertInstruction(ix, label, PROGRAMS.assetController, [DISC.unlockIdentity]);
  }

  const orderedIdentityRewardRecords = exactByteInstructions(
    identityRewardRecords,
    expectedIdentityRewardRoles,
    "identityRewardRecords",
  );
  let rewardReceipt;
  for (const [index, { ix }] of orderedIdentityRewardRecords.entries()) {
    const label = `identityRewardRecords[${index}]`;
    assertInstruction(ix, label, PROGRAMS.rewardEngine, [
      DISC.recordIdentityReward,
    ]);
    assertSameDeal(deal, ix, 3, label);
    const candidate = keyAt(ix, 4, label);
    if (rewardReceipt != null) {
      assertSame(`${label}.rewardReceipt`, rewardReceipt, candidate);
    }
    rewardReceipt = candidate;
  }

  const orderedRewardIndexes = exactByteInstructions(
    rewardIndexes,
    expectedRewardIndexRoles,
    "rewardIndexes",
  );
  for (const [index, { ix }] of orderedRewardIndexes.entries()) {
    const label = `rewardIndexes[${index}]`;
    assertInstruction(ix, label, PROGRAMS.resultIndex, [DISC.indexReward]);
    assertSameDeal(deal, ix, 2, label);
    const candidate = keyAt(ix, 3, label);
    if (rewardReceipt != null) {
      assertSame(`${label}.rewardReceipt`, rewardReceipt, candidate);
    }
    rewardReceipt = candidate;
  }

  let creditReceipt;
  const orderedCreditIndexes = exactByteInstructions(
    creditIndexes,
    expectedCreditIndexSides,
    "creditIndexes",
  );
  for (const [index, { ix }] of orderedCreditIndexes.entries()) {
    const label = `creditIndexes[${index}]`;
    assertInstruction(ix, label, PROGRAMS.resultIndex, [DISC.indexCredit]);
    assertSameDeal(deal, ix, 2, label);
    const candidate = keyAt(ix, 3, label);
    if (creditReceipt != null) {
      assertSame(`${label}.creditReceipt`, creditReceipt, candidate);
    }
    creditReceipt = candidate;
  }

  return [
    ...(historyPending ? [input.historyIndex] : []),
    ...orderedIdentityRewardRecords.map(({ ix }) => ix),
    ...orderedRewardIndexes.map(({ ix }) => ix),
    ...orderedCreditIndexes.map(({ ix }) => ix),
    ...orderedIdentityUnlocks,
  ];
}

export function buildNonCompletedTerminalFlow(input) {
  if (!input) throw new Error("non-completed flow input is required");
  const requirements = requiredObject(
    input.requirements,
    "non-completed requirements",
  );
  const expectedIdentityUnlockMints = expectedKeySet(
    requirements.identityUnlockMints,
    "requirements.identityUnlockMints",
    2,
  );
  const identityUnlocks = asArray(input.identityUnlocks, "identityUnlocks", 2);
  assertInstruction(input.resolution, "resolution", PROGRAMS.assetController, [
    DISC.castVoteAndResolve,
    DISC.resolveVotes,
    DISC.abandon,
  ]);
  assertInstruction(input.finalization, "finalization", PROGRAMS.finalizer, [
    DISC.finalizeNonCompleted,
  ]);
  const deal = keyAt(input.resolution, 4, "resolution");
  assertSameDeal(deal, input.finalization, 2, "finalization");
  const orderedIdentityUnlocks = exactIdentityUnlocks(
    identityUnlocks,
    expectedIdentityUnlockMints,
    deal,
    "identityUnlocks",
  );
  for (const [index, ix] of orderedIdentityUnlocks.entries()) {
    const label = `identityUnlocks[${index}]`;
    assertInstruction(ix, label, PROGRAMS.assetController, [DISC.unlockIdentity]);
  }
  return [input.resolution, input.finalization, ...orderedIdentityUnlocks];
}

export { DISC as TERMINAL_DISCRIMINATORS, PROGRAMS as TERMINAL_PROGRAMS };
