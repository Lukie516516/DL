import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

import { programAddressFor } from "./compact-v2-program-map.mjs";

const sdkDir = dirname(fileURLToPath(import.meta.url));
const solanaDir = resolve(sdkDir, "..");
const localDir = resolve(
  process.env.SOLANA_LOCAL_STATE_DIR ?? resolve(solanaDir, ".local"),
);
const walletPath = resolve(
  process.env.SOLANA_WALLET_PATH ?? resolve(localDir, "test-wallet.json"),
);
const rpcUrl = process.env.SOLANA_LOCAL_RPC_URL ?? "http://127.0.0.1:8899";
const idl = JSON.parse(
  readFileSync(resolve(solanaDir, "target/idl/deal_core.json"), "utf8"),
);
const programId = new PublicKey(
  programAddressFor("deal_core", idl.address),
);

function assertLocalRpc(value) {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`core smoke refuses non-loopback RPC ${url.origin}`);
  }
}

function loadKeypair(path) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
  );
}

function integer(value, bytes, signed = false) {
  const output = Buffer.alloc(bytes);
  const big = BigInt(value);
  if (signed) output.writeBigInt64LE(big);
  else if (bytes === 8) output.writeBigUInt64LE(big);
  else if (bytes === 4) output.writeUInt32LE(Number(value));
  else if (bytes === 2) output.writeUInt16LE(Number(value));
  else if (bytes === 1) output.writeUInt8(Number(value));
  else throw new Error(`unsupported integer width ${bytes}`);
  return output;
}

function encodeType(type, value) {
  if (type === "pubkey") return new PublicKey(value).toBuffer();
  if (type === "u8") return integer(value, 1);
  if (type === "u16") return integer(value, 2);
  if (type === "u32") return integer(value, 4);
  if (type === "u64") return integer(value, 8);
  if (type === "i64") return integer(value, 8, true);
  if (type === "bool") return Buffer.from([value ? 1 : 0]);
  if (type === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([integer(bytes.length, 4), bytes]);
  }
  if (type?.defined) {
    const name =
      typeof type.defined === "string" ? type.defined : type.defined.name;
    const definition = idl.types.find((candidate) => candidate.name === name);
    if (!definition) throw new Error(`missing IDL type ${name}`);
    if (definition.type.kind === "struct") {
      return Buffer.concat(
        definition.type.fields.map((field) =>
          encodeType(field.type, value[field.name]),
        ),
      );
    }
    if (definition.type.kind === "enum") {
      const index = definition.type.variants.findIndex(
        (variant) => variant.name === value,
      );
      if (index < 0) throw new Error(`invalid ${name} variant ${value}`);
      if (definition.type.variants[index].fields) {
        throw new Error(`enum fields are not supported for ${name}`);
      }
      return Buffer.from([index]);
    }
  }
  throw new Error(`unsupported IDL type ${JSON.stringify(type)}`);
}

function instruction(name, args, accounts) {
  const definition = idl.instructions.find(
    (candidate) => candidate.name === name,
  );
  if (!definition) throw new Error(`missing instruction ${name}`);
  return new TransactionInstruction({
    programId,
    keys: definition.accounts.map((account) => ({
      pubkey: new PublicKey(accounts[account.name]),
      isSigner: Boolean(account.signer),
      isWritable: Boolean(account.writable),
    })),
    data: Buffer.concat([
      Buffer.from(definition.discriminator),
      ...definition.args.map((arg) => encodeType(arg.type, args[arg.name])),
    ]),
  });
}

async function send(connection, payer, ix, extraSigners = []) {
  const signers = [payer, ...extraSigners].filter(
    (signer, index, all) =>
      all.findIndex((candidate) =>
        candidate.publicKey.equals(signer.publicKey),
      ) === index,
  );
  return sendAndConfirmTransaction(
    connection,
    new Transaction().add(ix),
    signers,
    { commitment: "confirmed", preflightCommitment: "confirmed" },
  );
}

async function expectFailure(action, label) {
  try {
    await action();
  } catch (error) {
    return {
      rejected: true,
      reason:
        error instanceof Error
          ? error.message.split("\n")[0].slice(0, 320)
          : String(error).slice(0, 320),
    };
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

function dealPda(id) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("deal"), integer(id, 8)],
    programId,
  )[0];
}

function decodeRegistry(data) {
  return {
    nextDealId: data.readBigUInt64LE(168),
    minTimeoutSeconds: data.readBigUInt64LE(176),
    paused: data[184] !== 0,
  };
}

function decodeDeal(data) {
  return {
    id: data.readBigUInt64LE(8),
    creator: new PublicKey(data.subarray(16, 48)),
    participant: new PublicKey(data.subarray(48, 80)),
    expectedParticipant: new PublicKey(data.subarray(80, 112)),
    templateType: data[144],
    openTokenTokenFast: data[145] !== 0,
    joinMode: data[146],
    status: data[147],
    aVote: data[148],
    bVote: data[149],
    aHasPreAccepted: data[157] !== 0,
  };
}

function createParams({
  fast = false,
  joinMode = "Open",
  expectedParticipant = PublicKey.default,
  timeout = 3_600n,
  title,
}) {
  return {
    template_type: "TokenToToken",
    open_token_token_fast: fast,
    join_mode: joinMode,
    expected_participant: expectedParticipant,
    a_swap_amount: 1_000n,
    a_margin_amount: 100n,
    b_swap_amount: 2_000n,
    b_margin_amount: 200n,
    a_has_asset_nft: false,
    b_has_asset_nft: false,
    title,
    description: "Persistent Localnet production-topology lifecycle smoke",
    timeout_seconds: timeout,
    replace_timeout_seconds: 3_600n,
    is_domain_deal: false,
    domain_name: "",
  };
}

async function main() {
  assertLocalRpc(rpcUrl);
  if (
    process.env.SOLANA_LOCAL_CORE_CONFIRM !== "LOCALNET_CORE_LIFECYCLE"
  ) {
    throw new Error(
      "core smoke requires SOLANA_LOCAL_CORE_CONFIRM=LOCALNET_CORE_LIFECYCLE",
    );
  }
  const connection = new Connection(rpcUrl, "confirmed");
  const creator = loadKeypair(walletPath);
  const participant = Keypair.generate();
  const expected = Keypair.generate();
  const outsider = Keypair.generate();
  for (const signer of [participant, expected, outsider]) {
    const signature = await connection.requestAirdrop(
      signer.publicKey,
      LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(signature, "confirmed");
  }

  const registry = PublicKey.findProgramAddressSync(
    [Buffer.from("deal-registry")],
    programId,
  )[0];
  const initialRegistryInfo = await connection.getAccountInfo(
    registry,
    "confirmed",
  );
  if (!initialRegistryInfo) throw new Error("deal registry is missing");
  const initialRegistry = decodeRegistry(initialRegistryInfo.data);
  if (initialRegistry.paused) throw new Error("deal registry is paused");
  const firstId = initialRegistry.nextDealId;
  const firstDeal = dealPda(firstId);

  const create = (id, params) =>
    instruction(
      "create_deal",
      { deal_id: id, params },
      {
        creator: creator.publicKey,
        registry,
        deal: dealPda(id),
        system_program: SystemProgram.programId,
      },
    );
  const branches = {};
  branches.wrongSequence = await expectFailure(
    () =>
      send(
        connection,
        creator,
        create(
          firstId + 1n,
          createParams({ title: "wrong sequence must fail" }),
        ),
      ),
    "out-of-sequence deal id",
  );
  branches.timeoutBelowMainnetBoundary = await expectFailure(
    () =>
      send(
        connection,
        creator,
        create(
          firstId,
          createParams({
            timeout: initialRegistry.minTimeoutSeconds - 1n,
            title: "short timeout must fail",
          }),
        ),
      ),
    "timeout below registry boundary",
  );

  const signatures = {};
  signatures.createOpen = await send(
    connection,
    creator,
    create(
      firstId,
      createParams({ title: "Localnet ordinary open Deal" }),
    ),
  );
  branches.duplicateCreate = await expectFailure(
    () =>
      send(
        connection,
        creator,
        create(
          firstId,
          createParams({ title: "duplicate account must fail" }),
        ),
      ),
    "duplicate Deal creation",
  );
  branches.creatorCannotSelfJoin = await expectFailure(
    () =>
      send(
        connection,
        creator,
        instruction(
          "join_deal",
          {},
          { participant: creator.publicKey, deal: firstDeal },
        ),
      ),
    "creator self join",
  );
  signatures.updateBeforeJoin = await send(
    connection,
    creator,
    instruction(
      "update_amounts",
      {
        a_swap_amount: 1_500n,
        a_margin_amount: 150n,
        b_swap_amount: 2_500n,
        b_margin_amount: 250n,
      },
      { actor: creator.publicKey, deal: firstDeal },
    ),
  );
  branches.ordinaryPreAcceptRejected = await expectFailure(
    () =>
      send(
        connection,
        creator,
        instruction(
          "pre_accept",
          {},
          { actor: creator.publicKey, deal: firstDeal },
        ),
      ),
    "ordinary Deal pre-accept",
  );
  signatures.joinOpen = await send(
    connection,
    participant,
    instruction(
      "join_deal",
      {},
      { participant: participant.publicKey, deal: firstDeal },
    ),
  );
  branches.secondJoinRejected = await expectFailure(
    () =>
      send(
        connection,
        outsider,
        instruction(
          "join_deal",
          {},
          { participant: outsider.publicKey, deal: firstDeal },
        ),
      ),
    "second participant join",
  );
  branches.updateAfterJoinRejected = await expectFailure(
    () =>
      send(
        connection,
        creator,
        instruction(
          "update_amounts",
          {
            a_swap_amount: 9_999n,
            a_margin_amount: 0n,
            b_swap_amount: 9_999n,
            b_margin_amount: 0n,
          },
          { actor: creator.publicKey, deal: firstDeal },
        ),
      ),
    "amount update after join",
  );
  branches.voteBeforeLockedRejected = await expectFailure(
    () =>
      send(
        connection,
        participant,
        instruction(
          "cast_vote",
          { vote: "Accept" },
          { actor: participant.publicKey, deal: firstDeal },
        ),
      ),
    "vote before deposits lock Deal",
  );

  const secondId = firstId + 1n;
  const secondDeal = dealPda(secondId);
  signatures.createExact = await send(
    connection,
    creator,
    create(
      secondId,
      createParams({
        joinMode: "ExactAddress",
        expectedParticipant: expected.publicKey,
        title: "Localnet exact participant Deal",
      }),
    ),
  );
  branches.outsiderExactJoinRejected = await expectFailure(
    () =>
      send(
        connection,
        outsider,
        instruction(
          "join_deal",
          {},
          { participant: outsider.publicKey, deal: secondDeal },
        ),
      ),
    "outsider exact-address join",
  );
  signatures.expectedExactJoin = await send(
    connection,
    expected,
    instruction(
      "join_deal",
      {},
      { participant: expected.publicKey, deal: secondDeal },
    ),
  );

  const thirdId = firstId + 2n;
  const thirdDeal = dealPda(thirdId);
  signatures.createFast = await send(
    connection,
    creator,
    create(
      thirdId,
      createParams({
        fast: true,
        title: "Localnet OpenTokenToken Fast Deal",
      }),
    ),
  );
  signatures.fastPreAccept = await send(
    connection,
    creator,
    instruction(
      "pre_accept",
      {},
      { actor: creator.publicKey, deal: thirdDeal },
    ),
  );
  branches.nonCreatorFastPreAcceptRejected = await expectFailure(
    () =>
      send(
        connection,
        outsider,
        instruction(
          "pre_accept",
          {},
          { actor: outsider.publicKey, deal: thirdDeal },
        ),
      ),
    "non-creator Fast pre-accept",
  );

  const [finalRegistryInfo, firstInfo, secondInfo, thirdInfo] =
    await Promise.all([
      connection.getAccountInfo(registry, "confirmed"),
      connection.getAccountInfo(firstDeal, "confirmed"),
      connection.getAccountInfo(secondDeal, "confirmed"),
      connection.getAccountInfo(thirdDeal, "confirmed"),
    ]);
  const finalRegistry = decodeRegistry(finalRegistryInfo.data);
  const deals = [firstInfo, secondInfo, thirdInfo].map((info) =>
    decodeDeal(info.data),
  );
  if (
    finalRegistry.nextDealId !== firstId + 3n ||
    deals[0].status !== 1 ||
    !deals[0].participant.equals(participant.publicKey) ||
    deals[1].status !== 1 ||
    !deals[1].participant.equals(expected.publicKey) ||
    deals[2].status !== 0 ||
    !deals[2].openTokenTokenFast ||
    !deals[2].aHasPreAccepted
  ) {
    throw new Error("final Deal lifecycle states do not match expectations");
  }

  const report = {
    generatedAt: new Date().toISOString(),
    cluster: "localnet",
    rpcUrl,
    genesisHash: await connection.getGenesisHash(),
    programId: programId.toBase58(),
    registry: registry.toBase58(),
    minTimeoutSeconds: initialRegistry.minTimeoutSeconds.toString(),
    nextDealIdBefore: firstId.toString(),
    nextDealIdAfter: finalRegistry.nextDealId.toString(),
    actors: {
      creator: creator.publicKey.toBase58(),
      participant: participant.publicKey.toBase58(),
      expectedParticipant: expected.publicKey.toBase58(),
      outsider: outsider.publicKey.toBase58(),
    },
    deals: [
      {
        kind: "ordinary-open",
        address: firstDeal.toBase58(),
        id: deals[0].id.toString(),
        status: deals[0].status,
        participant: deals[0].participant.toBase58(),
      },
      {
        kind: "exact-address",
        address: secondDeal.toBase58(),
        id: deals[1].id.toString(),
        status: deals[1].status,
        participant: deals[1].participant.toBase58(),
      },
      {
        kind: "open-token-token-fast",
        address: thirdDeal.toBase58(),
        id: deals[2].id.toString(),
        status: deals[2].status,
        preAccepted: deals[2].aHasPreAccepted,
      },
    ],
    signatures,
    rejectedBranches: branches,
  };
  const runId = report.generatedAt.replaceAll(":", "").replaceAll(".", "");
  const reportPath = resolve(
    localDir,
    `localnet-core-lifecycle-${runId}.json`,
  );
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })}\n`,
  );
  process.exitCode = 1;
});
