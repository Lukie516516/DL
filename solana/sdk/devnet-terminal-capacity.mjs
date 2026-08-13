import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  buildCompletedPostIndexFlow,
  buildCompletedTerminalFlow,
  TERMINAL_DISCRIMINATORS as DISC,
  TERMINAL_PROGRAMS as PROGRAMS,
} from "./terminal-flow.mjs";

export const PACKET_DATA_SIZE = 1232;
export const MAXIMUM_DC_TO_DC_CORE_INSTRUCTION_COUNT = 7;
export const MAXIMUM_REWARD_CORE_INSTRUCTION_COUNT = 6;
export const MAXIMUM_POST_INDEX_INSTRUCTION_COUNT = 11;
export const COMPUTE_BUDGET_INSTRUCTION_COUNT = 2;

const PROGRAM_KEYS = Object.freeze(
  Object.fromEntries(
    Object.entries(PROGRAMS).map(([name, value]) => [name, new PublicKey(value)]),
  ),
);

const hashPublicKey = (label) =>
  new PublicKey(createHash("sha256").update(`deal:${label}`).digest());

const payer = Keypair.fromSeed(
  createHash("sha256").update("deal:devnet-capacity-payer").digest(),
);
const terminalCaller = Keypair.fromSeed(
  createHash("sha256").update("deal:devnet-capacity-caller").digest(),
);

const shared = Object.freeze({
  payer: payer.publicKey,
  caller: terminalCaller.publicKey,
  actor: payer.publicKey,
  config: hashPublicKey("asset-config"),
  terms: hashPublicKey("asset-terms"),
  deal: hashPublicKey("deal"),
  creator: hashPublicKey("party-a"),
  participant: terminalCaller.publicKey,
  dcMint: hashPublicKey("dc-mint"),
  aSwapVault: hashPublicKey("a-swap-vault"),
  bSwapVault: hashPublicKey("b-swap-vault"),
  aSwapDestination: hashPublicKey("a-swap-destination"),
  bSwapDestination: hashPublicKey("b-swap-destination"),
  aRewardDestination: hashPublicKey("a-reward-destination"),
  bRewardDestination: hashPublicKey("b-reward-destination"),
  aIdentityMint: hashPublicKey("a-identity-mint"),
  bIdentityMint: hashPublicKey("b-identity-mint"),
  cIdentityMint: hashPublicKey("c-identity-mint"),
  aIdentity: hashPublicKey("a-identity"),
  bIdentity: hashPublicKey("b-identity"),
  cIdentity: hashPublicKey("c-identity"),
  aIdentityToken: hashPublicKey("a-identity-token"),
  bIdentityToken: hashPublicKey("b-identity-token"),
  cIdentityToken: hashPublicKey("c-identity-token"),
  aBinding: hashPublicKey("a-binding"),
  bBinding: hashPublicKey("b-binding"),
  aCredit: hashPublicKey("a-credit"),
  bCredit: hashPublicKey("b-credit"),
  cDcDestination: hashPublicKey("c-dc-destination"),
  terminalReceipt: hashPublicKey("terminal-receipt"),
  valuationReceipt: hashPublicKey("valuation-receipt"),
  rewardQuote: hashPublicKey("reward-quote"),
  rewardReceipt: hashPublicKey("reward-receipt"),
  creditReceipt: hashPublicKey("credit-receipt"),
  systemProgram: new PublicKey("11111111111111111111111111111111"),
  tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  instructionsSysvar: new PublicKey(
    "Sysvar1nstructions1111111111111111111111111",
  ),
});

function meta(pubkey, isWritable = false, isSigner = false) {
  return { pubkey, isWritable, isSigner };
}

function instruction(programId, discriminator, accounts, suffix = []) {
  return new TransactionInstruction({
    programId,
    keys: accounts,
    data: Buffer.concat([Buffer.from(discriminator, "hex"), Buffer.from(suffix)]),
  });
}

function resolutionInstruction(dcToDc) {
  const fallback = (label) => hashPublicKey(`resolution:${label}`);
  const aSwapMint = dcToDc ? shared.dcMint : hashPublicKey("stable-0-mint");
  const bSwapMint = dcToDc ? shared.dcMint : hashPublicKey("stable-1-mint");
  return instruction(PROGRAM_KEYS.assetController, DISC.castVoteAndResolve, [
    meta(shared.caller, true, true),
    meta(shared.config),
    meta(shared.terms, true),
    meta(hashPublicKey("core-registry")),
    meta(shared.deal, true),
    meta(shared.creator, true),
    meta(shared.participant, true),
    meta(shared.aSwapVault, true),
    meta(aSwapMint, true),
    meta(shared.aSwapDestination, true),
    meta(fallback("a-fee"), true),
    meta(shared.creator, true),
    meta(shared.creator),
    meta(shared.creator, true),
    meta(shared.bSwapVault, true),
    meta(bSwapMint, true),
    meta(shared.bSwapDestination, true),
    meta(fallback("b-fee"), true),
    meta(shared.participant, true),
    meta(shared.participant),
    meta(shared.participant, true),
    meta(shared.creator, true),
    meta(shared.creator),
    meta(shared.creator, true),
    meta(shared.participant, true),
    meta(shared.participant),
    meta(shared.participant, true),
    meta(shared.tokenProgram),
    meta(hashPublicKey("deal-core-program")),
    meta(shared.instructionsSysvar),
  ], [1]);
}

function dcFeeRouteInstruction() {
  return instruction(PROGRAM_KEYS.assetController, DISC.routeDcFees, [
    meta(shared.payer, true, true),
    meta(shared.config),
    meta(shared.terms, true),
    meta(shared.deal),
    meta(shared.aSwapVault, true),
    meta(shared.bSwapVault, true),
    meta(shared.dcMint, true),
    meta(shared.aIdentity),
    meta(shared.aIdentityToken),
    meta(shared.aBinding),
    meta(shared.aCredit),
    meta(shared.bIdentity),
    meta(shared.bIdentityToken),
    meta(shared.bBinding),
    meta(shared.bCredit),
    meta(shared.cIdentity),
    meta(shared.cIdentityToken),
    meta(shared.cDcDestination, true),
    meta(shared.tokenProgram),
    meta(shared.instructionsSysvar),
  ]);
}

function finalizationInstruction() {
  return instruction(PROGRAM_KEYS.finalizer, DISC.finalizeCompleted, [
    meta(hashPublicKey("finalizer-config")),
    meta(shared.payer, true, true),
    meta(shared.deal),
    meta(shared.creator),
    meta(shared.participant),
    meta(shared.terminalReceipt, true),
    meta(shared.systemProgram),
    meta(shared.config),
    meta(shared.instructionsSysvar),
    meta(shared.terms),
  ]);
}

function historyIndexInstruction() {
  return instruction(PROGRAM_KEYS.finalizer, DISC.indexCompletedHistory, [
    meta(hashPublicKey("finalizer-config")),
    meta(shared.payer, true, true),
    meta(hashPublicKey("finalizer-writer")),
    meta(shared.deal),
    meta(shared.terminalReceipt),
    meta(shared.creator),
    meta(shared.participant),
    meta(hashPublicKey("history-index-receipt"), true),
    meta(hashPublicKey("history-config")),
    meta(hashPublicKey("creator-history-header"), true),
    meta(hashPublicKey("participant-history-header"), true),
    meta(hashPublicKey("history-program")),
    meta(shared.systemProgram),
  ]);
}

function valuationInstruction() {
  return instruction(PROGRAM_KEYS.valuator, DISC.valueCompletedDeal, [
    meta(shared.payer, true, true),
    meta(shared.deal),
    meta(shared.terms),
    meta(hashPublicKey("valuator-registry")),
    meta(hashPublicKey("stable-0-mint")),
    meta(hashPublicKey("stable-1-mint")),
    meta(hashPublicKey("wrapped-native-pair")),
    meta(hashPublicKey("stable-0-pair")),
    meta(hashPublicKey("stable-1-pair")),
    meta(shared.valuationReceipt, true),
    meta(shared.systemProgram),
    meta(shared.config),
    meta(shared.instructionsSysvar),
  ]);
}

function rewardQuoteInstruction() {
  return instruction(PROGRAM_KEYS.rewardEngine, DISC.prepareCompletedRewards, [
    meta(hashPublicKey("reward-config")),
    meta(shared.payer, true, true),
    meta(shared.deal),
    meta(shared.terms),
    meta(shared.config),
    meta(hashPublicKey("valuator-registry")),
    meta(hashPublicKey("wrapped-native-pair")),
    meta(hashPublicKey("stable-0-pair")),
    meta(hashPublicKey("stable-1-pair")),
    meta(hashPublicKey("wrapped-native-observation"), true),
    meta(hashPublicKey("stable-0-observation"), true),
    meta(hashPublicKey("stable-1-observation"), true),
    meta(shared.rewardQuote, true),
    meta(shared.systemProgram),
    meta(shared.instructionsSysvar),
  ]);
}

function rewardMintInstruction(includeRewardC) {
  const absentOptional = PROGRAM_KEYS.rewardEngine;
  return instruction(PROGRAM_KEYS.rewardEngine, DISC.mintCompletedRewards, [
    meta(hashPublicKey("reward-config")),
    meta(shared.payer, true, true),
    meta(hashPublicKey("reward-minter")),
    meta(shared.deal),
    meta(shared.rewardQuote),
    meta(shared.aIdentity),
    meta(shared.aIdentityToken),
    meta(shared.aBinding),
    meta(shared.aCredit),
    meta(shared.bIdentity),
    meta(shared.bIdentityToken),
    meta(shared.bBinding),
    meta(shared.bCredit),
    meta(includeRewardC ? shared.cIdentity : absentOptional),
    meta(includeRewardC ? shared.cIdentityToken : absentOptional),
    meta(shared.aRewardDestination, true),
    meta(shared.bRewardDestination, true),
    meta(includeRewardC ? shared.cDcDestination : absentOptional, includeRewardC),
    meta(shared.dcMint, true),
    meta(hashPublicKey("dc-controller-config"), true),
    meta(hashPublicKey("dc-minter-grant")),
    meta(shared.tokenProgram),
    meta(hashPublicKey("dc-controller-program")),
    meta(shared.rewardReceipt, true),
    meta(shared.systemProgram),
    meta(shared.terms),
    meta(shared.config),
    meta(shared.instructionsSysvar),
  ]);
}

function identityRewardInstruction(role, identity) {
  return instruction(
    PROGRAM_KEYS.rewardEngine,
    DISC.recordIdentityReward,
    [
      meta(hashPublicKey("reward-config")),
      meta(shared.payer, true, true),
      meta(hashPublicKey("reward-minter")),
      meta(shared.deal),
      meta(shared.rewardReceipt),
      meta(hashPublicKey("identity-config")),
      meta(identity, true),
      meta(hashPublicKey(`identity-reward-receipt:${role}`), true),
      meta(PROGRAM_KEYS.identity),
      meta(shared.systemProgram),
    ],
    [role],
  );
}

function rewardIndexInstruction(role, subject) {
  const args = Buffer.alloc(5);
  args[0] = role;
  args.writeUInt32LE(0, 1);
  return instruction(
    PROGRAM_KEYS.resultIndex,
    DISC.indexReward,
    [
      meta(hashPublicKey("result-index-config")),
      meta(shared.payer, true, true),
      meta(shared.deal),
      meta(shared.rewardReceipt),
      meta(subject),
      meta(hashPublicKey(`reward-header:${role}`), true),
      meta(hashPublicKey(`reward-page:${role}`), true),
      meta(hashPublicKey(`reward-marker:${role}`), true),
      meta(shared.systemProgram),
    ],
    args,
  );
}

function creditInstruction() {
  return instruction(PROGRAM_KEYS.finalizer, DISC.recordCompletedCredit, [
    meta(hashPublicKey("finalizer-config")),
    meta(shared.payer, true, true),
    meta(hashPublicKey("finalizer-writer")),
    meta(shared.deal),
    meta(shared.terminalReceipt),
    meta(shared.valuationReceipt),
    meta(hashPublicKey("credit-config")),
    meta(shared.creator),
    meta(shared.participant),
    meta(shared.aBinding),
    meta(shared.bBinding),
    meta(shared.aIdentity),
    meta(shared.bIdentity),
    meta(shared.aIdentityToken),
    meta(shared.bIdentityToken),
    meta(shared.aCredit, true),
    meta(shared.bCredit, true),
    meta(shared.creditReceipt, true),
    meta(hashPublicKey("credit-program")),
    meta(shared.systemProgram),
    meta(shared.terms),
    meta(shared.config),
    meta(shared.instructionsSysvar),
  ]);
}

function creditIndexInstruction(side, subject) {
  const args = Buffer.alloc(5);
  args[0] = side;
  args.writeUInt32LE(0, 1);
  return instruction(
    PROGRAM_KEYS.resultIndex,
    DISC.indexCredit,
    [
      meta(hashPublicKey("result-index-config")),
      meta(shared.payer, true, true),
      meta(shared.deal),
      meta(shared.creditReceipt),
      meta(subject),
      meta(hashPublicKey(`credit-header:${side}`), true),
      meta(hashPublicKey(`credit-page:${side}`), true),
      meta(hashPublicKey(`credit-marker:${side}`), true),
      meta(shared.systemProgram),
    ],
    args,
  );
}

function identityUnlockInstruction(side, identityMint, identity, binding, ownerIdentity) {
  return instruction(PROGRAM_KEYS.assetController, DISC.unlockIdentity, [
    meta(shared.actor, true, true),
    meta(shared.config),
    meta(hashPublicKey("identity-config")),
    meta(shared.deal),
    meta(identityMint, true),
    meta(ownerIdentity, true),
    meta(identity, true),
    meta(binding, true),
    meta(hashPublicKey(`identity-lock:${side}`), true),
    meta(PROGRAM_KEYS.identity),
    meta(shared.tokenProgram),
    meta(shared.systemProgram),
    meta(shared.terms, true),
  ]);
}

export function buildMaximumDcToDcCompletedFlow() {
  return buildCompletedTerminalFlow({
    requirements: {
      dcToDc: true,
      creditMode: "pair",
    },
    resolution: resolutionInstruction(true),
    dcFeeRoute: dcFeeRouteInstruction(),
    finalization: finalizationInstruction(),
    valuation: valuationInstruction(),
    rewardQuote: rewardQuoteInstruction(),
    rewardMint: rewardMintInstruction(false),
    credit: creditInstruction(),
  });
}

export function buildMaximumRewardCompletedFlow() {
  return buildCompletedTerminalFlow({
    requirements: {
      dcToDc: false,
      creditMode: "pair",
    },
    resolution: resolutionInstruction(false),
    finalization: finalizationInstruction(),
    valuation: valuationInstruction(),
    rewardQuote: rewardQuoteInstruction(),
    rewardMint: rewardMintInstruction(true),
    credit: creditInstruction(),
  });
}

export function buildMaximumCompletedPostIndexFlow() {
  return buildCompletedPostIndexFlow({
    requirements: {
      deal: shared.deal,
      historyPending: true,
      identityRewardRoles: [0, 1, 2],
      rewardIndexRoles: [0, 1, 2],
      creditIndexSides: [0, 1],
      identityUnlockMints: [
        shared.aIdentityMint,
        shared.bIdentityMint,
      ],
    },
    historyIndex: historyIndexInstruction(),
    identityRewardRecords: [
      identityRewardInstruction(0, shared.aIdentity),
      identityRewardInstruction(1, shared.bIdentity),
      identityRewardInstruction(2, shared.cIdentity),
    ],
    rewardIndexes: [
      rewardIndexInstruction(0, shared.creator),
      rewardIndexInstruction(1, shared.participant),
      rewardIndexInstruction(2, shared.cIdentityMint),
    ],
    creditIndexes: [
      creditIndexInstruction(0, shared.creator),
      creditIndexInstruction(1, shared.participant),
    ],
    identityUnlocks: [
      identityUnlockInstruction(
        "a",
        shared.aIdentityMint,
        shared.aIdentity,
        shared.aBinding,
        shared.aIdentityToken,
      ),
      identityUnlockInstruction(
        "b",
        shared.bIdentityMint,
        shared.bIdentity,
        shared.bBinding,
        shared.bIdentityToken,
      ),
    ],
  });
}

function uniqueMetas(instructions) {
  const metas = new Map();
  for (const ix of instructions) {
    const program = ix.programId.toBase58();
    if (!metas.has(program)) {
      metas.set(program, {
        pubkey: ix.programId,
        isSigner: false,
        isWritable: false,
        isProgram: true,
      });
    }
    for (const account of ix.keys) {
      const key = account.pubkey.toBase58();
      const existing = metas.get(key);
      metas.set(key, {
        pubkey: account.pubkey,
        isSigner: Boolean(existing?.isSigner || account.isSigner),
        isWritable: Boolean(existing?.isWritable || account.isWritable),
        isProgram: Boolean(existing?.isProgram),
      });
    }
  }
  return [...metas.values()];
}

function measureFlow(terminalInstructions) {
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ...terminalInstructions,
  ];
  const metas = uniqueMetas(instructions);
  const lookupAddresses = metas
    .filter(({ isSigner }) => !isSigner)
    .map(({ pubkey }) => pubkey);
  const lookupTable = new AddressLookupTableAccount({
    key: hashPublicKey("devnet-capacity-alt"),
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 1,
      lastExtendedSlotStartIndex: 0,
      authority: payer.publicKey,
      addresses: lookupAddresses,
    },
  });
  const blockhash = hashPublicKey("recent-blockhash").toBase58();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message([lookupTable]);
  const transaction = new VersionedTransaction(message);
  const signers = metas.some(
    ({ pubkey, isSigner }) =>
      isSigner && pubkey.equals(terminalCaller.publicKey),
  )
    ? [payer, terminalCaller]
    : [payer];
  transaction.sign(signers);
  const serializedBytes = transaction.serialize().length;

  let legacyError = null;
  let legacyBytes = null;
  try {
    const legacyMessage = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToLegacyMessage();
    const legacyTransaction = new VersionedTransaction(legacyMessage);
    legacyTransaction.sign(signers);
    legacyBytes = legacyTransaction.serialize({
      requireAllSignatures: true,
      verifySignatures: true,
    }).length;
  } catch (error) {
    legacyError = error instanceof Error ? error.message : String(error);
  }

  const writableLookups = message.addressTableLookups.reduce(
    (sum, item) => sum + item.writableIndexes.length,
    0,
  );
  const readonlyLookups = message.addressTableLookups.reduce(
    (sum, item) => sum + item.readonlyIndexes.length,
    0,
  );
  return {
    terminalInstructionCount: terminalInstructions.length,
    transactionInstructionCount: instructions.length,
    uniqueAccountCount: metas.length,
    signerCount: metas.filter(({ isSigner }) => isSigner).length,
    staticAccountCount: message.staticAccountKeys.length,
    lookupTableCount: message.addressTableLookups.length,
    lookupWritableCount: writableLookups,
    lookupReadonlyCount: readonlyLookups,
    serializedBytes,
    packetLimitBytes: PACKET_DATA_SIZE,
    remainingBytes: PACKET_DATA_SIZE - serializedBytes,
    fitsPacket: serializedBytes <= PACKET_DATA_SIZE,
    legacyBytes,
    legacyError,
  };
}

export function measureTerminalCapacity() {
  return {
    dcToDcCore: measureFlow(buildMaximumDcToDcCompletedFlow()),
    maximumRewardCore: measureFlow(buildMaximumRewardCompletedFlow()),
    maximumPostIndex: measureFlow(buildMaximumCompletedPostIndexFlow()),
  };
}

function main() {
  const report = measureTerminalCapacity();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (
    report.dcToDcCore.terminalInstructionCount !==
      MAXIMUM_DC_TO_DC_CORE_INSTRUCTION_COUNT ||
    report.maximumRewardCore.terminalInstructionCount !==
      MAXIMUM_REWARD_CORE_INSTRUCTION_COUNT ||
    report.maximumPostIndex.terminalInstructionCount !==
      MAXIMUM_POST_INDEX_INSTRUCTION_COUNT ||
    !report.dcToDcCore.fitsPacket ||
    !report.maximumRewardCore.fitsPacket ||
    !report.maximumPostIndex.fitsPacket
  ) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
