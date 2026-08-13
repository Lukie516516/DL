import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { keccak256 } from "viem";

import { programAddressFor } from "./compact-v2-program-map.mjs";

const sdkDir = dirname(fileURLToPath(import.meta.url));
const solanaDir = resolve(sdkDir, "..");
const localDir = resolve(
  process.env.SOLANA_LOCAL_STATE_DIR ?? resolve(solanaDir, ".local"),
);
const statePath = resolve(localDir, "localnet-production-bootstrap-state.json");
const walletPath = resolve(
  process.env.SOLANA_WALLET_PATH ?? resolve(localDir, "test-wallet.json"),
);
const keysDir = resolve(localDir, "production-bootstrap-keys");
const rpcUrl = process.env.SOLANA_LOCAL_RPC_URL ?? "http://127.0.0.1:8899";

export const TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

function assertLocalRpc(value) {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`governance client refuses non-loopback RPC ${url.origin}`);
  }
}

function loadKeypair(path) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
  );
}

function integer(value, bytes, signed = false, endian = "LE") {
  const output = Buffer.alloc(bytes);
  const big = BigInt(value);
  if (signed) {
    if (endian === "LE") output.writeBigInt64LE(big);
    else output.writeBigInt64BE(big);
  } else if (bytes === 8) {
    if (endian === "LE") output.writeBigUInt64LE(big);
    else output.writeBigUInt64BE(big);
  } else if (bytes === 4) {
    if (endian === "LE") output.writeUInt32LE(Number(value));
    else output.writeUInt32BE(Number(value));
  } else if (bytes === 2) {
    if (endian === "LE") output.writeUInt16LE(Number(value));
    else output.writeUInt16BE(Number(value));
  } else if (bytes === 1) {
    output.writeUInt8(Number(value));
  } else {
    throw new Error(`unsupported integer width ${bytes}`);
  }
  return output;
}

function encodeType(idl, type, value) {
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
  if (type === "bytes") {
    const bytes = Buffer.from(value);
    return Buffer.concat([integer(bytes.length, 4), bytes]);
  }
  if (type?.array) {
    const [inner, length] = type.array;
    if (value.length !== length) {
      throw new Error(`array expected ${length} values`);
    }
    return Buffer.concat(value.map((entry) => encodeType(idl, inner, entry)));
  }
  if (type?.vec) {
    return Buffer.concat([
      integer(value.length, 4),
      ...value.map((entry) => encodeType(idl, type.vec, entry)),
    ]);
  }
  if (type?.defined) {
    const name =
      typeof type.defined === "string" ? type.defined : type.defined.name;
    const definition = idl.types.find((candidate) => candidate.name === name);
    if (!definition) throw new Error(`missing IDL type ${name}`);
    if (definition.type.kind === "struct") {
      return Buffer.concat(
        definition.type.fields.map((field) =>
          encodeType(idl, field.type, value[field.name]),
        ),
      );
    }
    if (definition.type.kind === "enum") {
      const index = definition.type.variants.findIndex(
        (variant) => variant.name === value,
      );
      if (index < 0) throw new Error(`invalid ${name} variant ${value}`);
      return Buffer.from([index]);
    }
  }
  throw new Error(`unsupported IDL type ${JSON.stringify(type)}`);
}

function loadIdl(name) {
  return JSON.parse(
    readFileSync(resolve(solanaDir, `target/idl/${name}.json`), "utf8"),
  );
}

function buildInstruction(programName, instructionName, args, accounts) {
  const idl = loadIdl(programName);
  const definition = idl.instructions.find(
    (candidate) => candidate.name === instructionName,
  );
  if (!definition) {
    throw new Error(`${programName}.${instructionName} is missing`);
  }
  const keys = definition.accounts.map((account) => {
    const value = accounts[account.name];
    if (!value) {
      throw new Error(
        `${programName}.${instructionName}: missing ${account.name}`,
      );
    }
    return {
      pubkey: new PublicKey(value),
      isSigner: Boolean(account.signer),
      isWritable: Boolean(account.writable),
    };
  });
  return {
    definition,
    instruction: new TransactionInstruction({
      programId: new PublicKey(programAddressFor(programName, idl.address)),
      keys,
      data: Buffer.concat([
        Buffer.from(definition.discriminator),
        ...definition.args.map((arg) =>
          encodeType(idl, arg.type, args[arg.name]),
        ),
      ]),
    }),
  };
}

function canonicalHash(envelope) {
  const accountBytes = Buffer.concat(
    envelope.accounts.map((account) =>
      Buffer.concat([
        new PublicKey(account.pubkey).toBuffer(),
        Buffer.from([account.is_writable ? 1 : 0]),
        Buffer.from([account.is_signer ? 1 : 0]),
      ]),
    ),
  );
  const payloadHash = Buffer.from(
    keccak256(`0x${Buffer.from(envelope.payload).toString("hex")}`).slice(2),
    "hex",
  );
  const bytes = Buffer.concat([
    Buffer.from("DEAL_GOVERNANCE_V1"),
    integer(envelope.version, 1),
    integer(envelope.source_chain, 8, false, "BE"),
    Buffer.from(envelope.source_broadcaster),
    integer(envelope.bridge_set_version, 8, false, "BE"),
    integer(envelope.nonce, 8, false, "BE"),
    integer(envelope.action_type, 1),
    new PublicKey(envelope.target_program).toBuffer(),
    integer(envelope.valid_after, 8, true, "BE"),
    integer(envelope.expires_at, 8, true, "BE"),
    integer(envelope.accounts.length, 2, false, "BE"),
    accountBytes,
    payloadHash,
  ]);
  return Buffer.from(keccak256(`0x${bytes.toString("hex")}`).slice(2), "hex");
}

function pda(programId, ...seeds) {
  return PublicKey.findProgramAddressSync(
    seeds.map((seed) =>
      seed instanceof PublicKey ? seed.toBuffer() : Buffer.from(seed),
    ),
    new PublicKey(programId),
  )[0];
}

export function associatedToken(owner, mint, tokenProgram = TOKEN_PROGRAM) {
  return pda(
    ASSOCIATED_TOKEN_PROGRAM,
    new PublicKey(owner),
    new PublicKey(tokenProgram),
    new PublicKey(mint),
  );
}

export async function createLocalGovernanceClient() {
  assertLocalRpc(rpcUrl);
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = loadKeypair(walletPath);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if ((await connection.getGenesisHash()) !== state.genesisHash) {
    throw new Error("governance state and Localnet genesis do not match");
  }
  const bridgeSigners = [0, 1, 2].map((index) =>
    loadKeypair(resolve(keysDir, `bridge-${index}.json`)),
  );
  const governanceIdl = loadIdl("deal_governance_executor");
  const governanceProgram = new PublicKey(
    programAddressFor("deal_governance_executor", governanceIdl.address),
  );
  const governanceConfig = new PublicKey(state.governanceConfig);
  const executorAuthority = new PublicKey(state.executorAuthority);

  async function send(ix, payer = wallet, extraSigners = []) {
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

  async function executeGovernance({
    programName,
    instructionName,
    args,
    accounts,
    actionType = 1,
  }) {
    const target = buildInstruction(
      programName,
      instructionName,
      args,
      accounts,
    );
    return executeGovernanceInstruction({
      instruction: target.instruction,
      actionType,
      label: `${programName}.${instructionName}`,
    });
  }

  async function executeGovernanceInstruction({
    instruction,
    actionType = 1,
    label = instruction.programId.toBase58(),
  }) {
    const target = { instruction };
    for (const account of target.instruction.keys) {
      if (account.isSigner && !account.pubkey.equals(executorAuthority)) {
        throw new Error(
          `${label}: unsupported signer ${account.pubkey.toBase58()}`,
        );
      }
    }
    const configInfo = await connection.getAccountInfo(
      governanceConfig,
      "confirmed",
    );
    if (!configInfo) throw new Error("governance config is missing");
    const sourceChain = configInfo.data.readBigUInt64LE(72);
    const sourceBroadcaster = configInfo.data.subarray(80, 112);
    const bridgeSetVersion = configInfo.data.readBigUInt64LE(208);
    const nonce = configInfo.data.readBigUInt64LE(218) + 1n;
    const now = BigInt(Math.floor(Date.now() / 1_000));
    const envelope = {
      version: 1,
      source_chain: sourceChain,
      source_broadcaster: [...sourceBroadcaster],
      bridge_set_version: bridgeSetVersion,
      nonce,
      action_type: actionType,
      target_program: target.instruction.programId,
      valid_after: now - 30n,
      expires_at: now + 3_600n,
      accounts: target.instruction.keys.map((account) => ({
        pubkey: account.pubkey,
        is_writable: account.isWritable,
        is_signer: account.isSigner,
      })),
      payload: [...target.instruction.data],
    };
    const hash = canonicalHash(envelope);
    const message = pda(governanceProgram, "governance-message", hash);
    const confirmSignatures = [];
    for (const bridgeSigner of bridgeSigners.slice(0, 2)) {
      const confirm = buildInstruction(
        "deal_governance_executor",
        "confirm_message",
        { message_hash: [...hash], envelope },
        {
          payer: wallet.publicKey,
          bridge_signer: bridgeSigner.publicKey,
          config: governanceConfig,
          message,
          system_program: "11111111111111111111111111111111",
        },
      ).instruction;
      confirmSignatures.push(
        await send(confirm, wallet, [bridgeSigner]),
      );
    }
    const targetRecord = pda(
      governanceProgram,
      "allowed-target",
      target.instruction.programId,
    );
    const executeBase = buildInstruction(
      "deal_governance_executor",
      "execute_message",
      {},
      {
        config: governanceConfig,
        message,
        target_record: targetRecord,
        executor_authority: executorAuthority,
        target_program: target.instruction.programId,
      },
    ).instruction;
    const remaining = target.instruction.keys
      .filter((account) => !account.pubkey.equals(executorAuthority))
      .map((account) => ({
        pubkey: account.pubkey,
        isSigner: false,
        isWritable: account.isWritable,
      }));
    const execute = new TransactionInstruction({
      programId: governanceProgram,
      keys: [...executeBase.keys, ...remaining],
      data: executeBase.data,
    });
    const execution = await send(execute);
    return {
      nonce: nonce.toString(),
      messageHash: `0x${hash.toString("hex")}`,
      message: message.toBase58(),
      confirmations: confirmSignatures,
      execution,
    };
  }

  return {
    connection,
    wallet,
    walletPath,
    state,
    governanceProgram,
    governanceConfig,
    executorAuthority,
    bridgeSigners,
    send,
    executeGovernance,
    executeGovernanceInstruction,
    buildInstruction: (programName, instructionName, args, accounts) =>
      buildInstruction(programName, instructionName, args, accounts).instruction,
    programId: (programName) => {
      const idl = loadIdl(programName);
      return new PublicKey(programAddressFor(programName, idl.address));
    },
    pda,
  };
}
