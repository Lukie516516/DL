import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
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
const keysDir = resolve(localDir, "production-bootstrap-keys");
const statePath = resolve(localDir, "localnet-production-bootstrap-state.json");
const walletPath = resolve(
  process.env.SOLANA_WALLET_PATH ?? resolve(localDir, "test-wallet.json"),
);
const rpcUrl = process.env.SOLANA_LOCAL_RPC_URL ?? "http://127.0.0.1:8899";

const TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const ETH_V2_BROADCASTER = "CF4D1b59c43F0e19f7e0e0416067e999f12cd1e6";
const SOURCE_BROADCASTER = Buffer.concat([
  Buffer.alloc(12),
  Buffer.from(ETH_V2_BROADCASTER, "hex"),
]);

const programNames = [
  "deal_asset_controller",
  "deal_core",
  "deal_credit_graph",
  "deal_credit_valuator",
  "deal_dc_controller",
  "deal_dex_pair",
  "deal_dex_quoter",
  "deal_dex_router",
  "deal_domain_registry",
  "deal_domain_market",
  "deal_domain_rank",
  "deal_domain_entry",
  "deal_domain_hall",
  "deal_swap_asset_registry",
  "deal_swap_orderbook",
  "deal_finalizer",
  "deal_governance_executor",
  "deal_history_index",
  "deal_identity",
  "deal_message_hub",
  "deal_parameter_registry",
  "deal_protocol_treasury",
  "deal_result_index",
  "deal_reward_engine",
];

function assertLocalRpc(value) {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`bootstrap refuses non-loopback RPC ${url.origin}`);
  }
}

function loadKeypair(path) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
  );
}

function ensureKeypair(name) {
  const path = resolve(keysDir, `${name}.json`);
  if (!existsSync(path)) {
    const keypair = Keypair.generate();
    writeFileSync(path, `${JSON.stringify(Array.from(keypair.secretKey))}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  }
  return { path, keypair: loadKeypair(path) };
}

function loadIdl(name) {
  return JSON.parse(
    readFileSync(resolve(solanaDir, `target/idl/${name}.json`), "utf8"),
  );
}

const idls = new Map(programNames.map((name) => [name, loadIdl(name)]));
const programs = new Map(
  programNames.map((name) => [
    name,
    new PublicKey(programAddressFor(name, idls.get(name).address)),
  ]),
);

function pid(name) {
  const value = programs.get(name);
  if (!value) throw new Error(`unknown program ${name}`);
  return value;
}

function pda(programName, ...seeds) {
  return PublicKey.findProgramAddressSync(
    seeds.map((seed) =>
      seed instanceof PublicKey ? seed.toBuffer() : Buffer.from(seed),
    ),
    pid(programName),
  )[0];
}

function associatedToken(owner, mint, tokenProgram = TOKEN_PROGRAM) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0];
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
      throw new Error(`array expected ${length} values, got ${value.length}`);
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
    if (!definition || definition.type.kind !== "struct") {
      throw new Error(`unsupported defined type ${name}`);
    }
    return Buffer.concat(
      definition.type.fields.map((field) =>
        encodeType(idl, field.type, value[field.name]),
      ),
    );
  }
  throw new Error(`unsupported IDL type ${JSON.stringify(type)}`);
}

function instruction(programName, instructionName, args, accounts, remaining = []) {
  const idl = idls.get(programName);
  const definition = idl.instructions.find(
    (candidate) => candidate.name === instructionName,
  );
  if (!definition) {
    throw new Error(`${programName}.${instructionName} is missing from IDL`);
  }
  const data = Buffer.concat([
    Buffer.from(definition.discriminator),
    ...definition.args.map((arg) => {
      if (!(arg.name in args)) {
        throw new Error(`${programName}.${instructionName}: missing ${arg.name}`);
      }
      return encodeType(idl, arg.type, args[arg.name]);
    }),
  ]);
  const keys = definition.accounts.map((account) => {
    const pubkey = accounts[account.name];
    if (!pubkey) {
      throw new Error(
        `${programName}.${instructionName}: missing account ${account.name}`,
      );
    }
    return {
      pubkey: new PublicKey(pubkey),
      isSigner: Boolean(account.signer),
      isWritable: Boolean(account.writable),
    };
  });
  keys.push(
    ...remaining.map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: Boolean(account.isSigner),
      isWritable: Boolean(account.isWritable),
    })),
  );
  return new TransactionInstruction({
    programId: pid(programName),
    keys,
    data,
  });
}

function uniqueSigners(signers) {
  const seen = new Set();
  return signers.filter((signer) => {
    const key = signer.publicKey.toBase58();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function send(connection, wallet, ix, extraSigners = []) {
  return sendAndConfirmTransaction(
    connection,
    new Transaction().add(ix),
    uniqueSigners([wallet, ...extraSigners]),
    {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    },
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

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: solanaDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

async function ensureMint(connection, wallet, walletCliPath, name, decimals) {
  const { path, keypair } = ensureKeypair(name);
  const existing = await connection.getAccountInfo(keypair.publicKey, "confirmed");
  if (!existing) {
    run("spl-token", [
      "--url",
      rpcUrl,
      "--fee-payer",
      walletCliPath,
      "create-token",
      "--decimals",
      String(decimals),
      "--mint-authority",
      wallet.publicKey.toBase58(),
      relative(solanaDir, path),
      "--output",
      "json",
    ]);
  } else if (!existing.owner.equals(TOKEN_PROGRAM)) {
    throw new Error(`${name} exists but is not owned by the token program`);
  }
  return keypair.publicKey;
}

function decodeAuthority(data) {
  if (data.length < 72) throw new Error("config account is too short");
  return {
    authority: new PublicKey(data.subarray(8, 40)),
    pendingAuthority: new PublicKey(data.subarray(40, 72)),
  };
}

function decodeGovernance(data) {
  if (data.length < 228) throw new Error("governance config is too short");
  return {
    ...decodeAuthority(data),
    bridgeSetVersion: data.readBigUInt64LE(208),
    threshold: data[216],
    paused: data[217] !== 0,
    lastExecutedNonce: data.readBigUInt64LE(218),
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

async function main() {
  assertLocalRpc(rpcUrl);
  if (
    process.env.SOLANA_LOCAL_BOOTSTRAP_CONFIRM !==
    "LOCALNET_PRODUCTION_TOPOLOGY"
  ) {
    throw new Error(
      "bootstrap requires SOLANA_LOCAL_BOOTSTRAP_CONFIRM=LOCALNET_PRODUCTION_TOPOLOGY",
    );
  }

  mkdirSync(keysDir, { recursive: true });
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = loadKeypair(walletPath);
  const walletCliPath = relative(solanaDir, walletPath);
  const genesisHash = await connection.getGenesisHash();
  const existingState = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : null;
  if (existingState && existingState.genesisHash !== genesisHash) {
    throw new Error(
      `bootstrap state belongs to genesis ${existingState.genesisHash}, current ${genesisHash}`,
    );
  }

  const bridgeSigners = [0, 1, 2].map(
    (index) => ensureKeypair(`bridge-${index}`).keypair,
  );
  const mints = {
    dc: await ensureMint(connection, wallet, walletCliPath, "dc-mint", 9),
    wrappedNative: await ensureMint(
      connection,
      wallet,
      walletCliPath,
      "wrapped-native-mint",
      9,
    ),
    stable0: await ensureMint(
      connection,
      wallet,
      walletCliPath,
      "stable0-mint",
      6,
    ),
    stable1: await ensureMint(
      connection,
      wallet,
      walletCliPath,
      "stable1-mint",
      6,
    ),
  };

  const addresses = {
    governanceConfig: pda("deal_governance_executor", "governance-config"),
    executorAuthority: pda(
      "deal_governance_executor",
      "executor-authority",
    ),
    treasuryConfig: pda(
      "deal_protocol_treasury",
      "protocol-treasury-config",
    ),
    treasuryVault: pda(
      "deal_protocol_treasury",
      "protocol-treasury-vault",
    ),
    dcConfig: pda("deal_dc_controller", "dc-controller"),
    assetConfig: pda("deal_asset_controller", "asset-controller"),
    coreRegistry: pda("deal_core", "deal-registry"),
    creditConfig: pda("deal_credit_graph", "credit-config"),
    dexConfig: pda("deal_dex_pair", "dex-config"),
    routerConfig: pda("deal_dex_router", "router-config"),
    domainRegistryConfig: pda("deal_domain_registry", "domain-config"),
    domainMarketConfig: pda(
      "deal_domain_market",
      "domain-market-config",
    ),
    domainRankConfig: pda("deal_domain_rank", "domain-rank-config"),
    domainEntryConfig: pda(
      "deal_domain_entry",
      "domain-entry-config",
    ),
    domainHallConfig: pda("deal_domain_hall", "domain-hall-config"),
    swapRegistry: pda(
      "deal_swap_asset_registry",
      "swap-asset-registry",
    ),
    orderbookConfig: pda("deal_swap_orderbook", "orderbook-config"),
    finalizerConfig: pda("deal_finalizer", "finalizer-config"),
    finalizerWriter: pda("deal_finalizer", "finalizer-writer"),
    historyConfig: pda("deal_history_index", "history-config"),
    identityConfig: pda("deal_identity", "identity-config"),
    messageConfig: pda("deal_message_hub", "message-config"),
    parameterRegistry: pda(
      "deal_parameter_registry",
      "parameter-registry",
    ),
    resultConfig: pda("deal_result_index", "result-config"),
    rewardConfig: pda("deal_reward_engine", "reward-config"),
    rewardMinter: pda("deal_reward_engine", "reward-minter"),
  };
  addresses.domainRankVault = associatedToken(
    addresses.domainRankConfig,
    mints.dc,
  );

  const signatures = {};
  const initialized = [];
  const ensureInitialized = async (
    label,
    programName,
    config,
    instructionName,
    args,
    accounts,
    signers = [],
  ) => {
    if (await connection.getAccountInfo(config, "confirmed")) {
      initialized.push({ label, action: "skip-existing" });
      return;
    }
    const signature = await send(
      connection,
      wallet,
      instruction(programName, instructionName, args, accounts),
      signers,
    );
    if (!(await connection.getAccountInfo(config, "confirmed"))) {
      throw new Error(`${label} config was not created`);
    }
    signatures[`initialize:${label}`] = signature;
    initialized.push({ label, action: "initialized", signature });
  };

  await ensureInitialized(
    "governance-executor",
    "deal_governance_executor",
    addresses.governanceConfig,
    "initialize",
    {
      source_chain: 1n,
      source_broadcaster: [...SOURCE_BROADCASTER],
      bridge_signers: bridgeSigners.map((signer) => signer.publicKey),
      threshold: 2,
    },
    {
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      config: addresses.governanceConfig,
      executor_authority: addresses.executorAuthority,
      system_program: SystemProgram.programId,
    },
  );

  await ensureInitialized(
    "dc-controller",
    "deal_dc_controller",
    addresses.dcConfig,
    "initialize",
    {},
    {
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      current_mint_authority: wallet.publicKey,
      dc_mint: mints.dc,
      config: addresses.dcConfig,
      dc_token_program: TOKEN_PROGRAM,
      system_program: SystemProgram.programId,
    },
  );

  const treasuryInfo = await connection.getAccountInfo(
    addresses.treasuryConfig,
    "confirmed",
  );
  if (!treasuryInfo) {
    await ensureInitialized(
      "protocol-treasury",
      "deal_protocol_treasury",
      addresses.treasuryConfig,
      "initialize",
      {
        controller: wallet.publicKey,
        bootstrap_admin: wallet.publicKey,
      },
      {
        payer: wallet.publicKey,
        config: addresses.treasuryConfig,
        vault_authority: addresses.treasuryVault,
        system_program: SystemProgram.programId,
      },
    );
    signatures["treasury:lock-bootstrap"] = await send(
      connection,
      wallet,
      instruction(
        "deal_protocol_treasury",
        "lock_bootstrap",
        {},
        {
          bootstrap_admin: wallet.publicKey,
          config: addresses.treasuryConfig,
        },
      ),
    );
  } else {
    initialized.push({ label: "protocol-treasury", action: "skip-existing" });
  }

  await ensureInitialized(
    "asset-controller",
    "deal_asset_controller",
    addresses.assetConfig,
    "initialize_controller",
    {
      treasury: addresses.treasuryVault,
      dc_mint: mints.dc,
      fee_numerator: 3,
      fee_denominator: 1_000,
    },
    {
      authority: wallet.publicKey,
      config: addresses.assetConfig,
      system_program: SystemProgram.programId,
    },
  );
  await ensureInitialized(
    "deal-core",
    "deal_core",
    addresses.coreRegistry,
    "initialize_registry",
    {
      asset_controller: addresses.assetConfig,
      identity_controller: addresses.identityConfig,
    },
    {
      authority: wallet.publicKey,
      registry: addresses.coreRegistry,
      system_program: SystemProgram.programId,
    },
  );
  await ensureInitialized(
    "finalizer",
    "deal_finalizer",
    addresses.finalizerConfig,
    "initialize",
    {},
    {
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      config: addresses.finalizerConfig,
      writer: addresses.finalizerWriter,
      system_program: SystemProgram.programId,
    },
  );
  await ensureInitialized(
    "credit-graph",
    "deal_credit_graph",
    addresses.creditConfig,
    "initialize",
    { recorder: addresses.finalizerWriter },
    {
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      config: addresses.creditConfig,
      system_program: SystemProgram.programId,
    },
  );
  await ensureInitialized(
    "history-index",
    "deal_history_index",
    addresses.historyConfig,
    "initialize",
    { trusted_writer: addresses.finalizerWriter },
    {
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      config: addresses.historyConfig,
      system_program: SystemProgram.programId,
    },
  );
  await ensureInitialized(
    "identity",
    "deal_identity",
    addresses.identityConfig,
    "initialize",
    {
      dc_mint: mints.dc,
      trusted_controller: addresses.assetConfig,
      mint_price: 500_000n,
      min_mint_price: 1n,
      max_mint_price: 1_000_000_000_000n,
    },
    {
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      config: addresses.identityConfig,
      system_program: SystemProgram.programId,
    },
  );
  await ensureInitialized(
    "message-hub",
    "deal_message_hub",
    addresses.messageConfig,
    "initialize",
    {
      trusted_writer: addresses.assetConfig,
      dc_mint: mints.dc,
      message_price: 100n,
      fee_enabled: true,
    },
    {
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      config: addresses.messageConfig,
      system_program: SystemProgram.programId,
    },
  );
  await ensureInitialized(
    "dex-pair",
    "deal_dex_pair",
    addresses.dexConfig,
    "initialize",
    {},
    {
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      dc_mint: mints.dc,
      dc_token_program: TOKEN_PROGRAM,
      config: addresses.dexConfig,
      system_program: SystemProgram.programId,
    },
  );
  await ensureInitialized(
    "dex-router",
    "deal_dex_router",
    addresses.routerConfig,
    "initialize",
    {},
    {
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      dc_mint: mints.dc,
      config: addresses.routerConfig,
      system_program: SystemProgram.programId,
    },
  );
  await ensureInitialized(
    "swap-asset-registry",
    "deal_swap_asset_registry",
    addresses.swapRegistry,
    "initialize",
    {
      pair_program: pid("deal_dex_pair"),
      router_program: pid("deal_dex_router"),
      dc_mint: mints.dc,
      wrapped_native_mint: mints.wrappedNative,
      stable0_mint: mints.stable0,
      stable1_mint: mints.stable1,
    },
    {
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      registry: addresses.swapRegistry,
      system_program: SystemProgram.programId,
    },
  );
  await ensureInitialized(
    "reward-engine",
    "deal_reward_engine",
    addresses.rewardConfig,
    "initialize",
    {
      reward_numerator: 1,
      reward_denominator: 1_000,
      min_window_seconds: 1_800,
    },
    {
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      config: addresses.rewardConfig,
      reward_minter: addresses.rewardMinter,
      asset_config: addresses.assetConfig,
      registry: addresses.swapRegistry,
      dc_controller_config: addresses.dcConfig,
      system_program: SystemProgram.programId,
    },
  );
  await ensureInitialized(
    "result-index",
    "deal_result_index",
    addresses.resultConfig,
    "initialize",
    {},
    {
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      config: addresses.resultConfig,
      system_program: SystemProgram.programId,
    },
  );
  await ensureInitialized(
    "domain-registry",
    "deal_domain_registry",
    addresses.domainRegistryConfig,
    "initialize",
    {
      dc_mint: mints.dc,
      treasury: addresses.treasuryVault,
      base_price: 500_000n,
    },
    {
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      config: addresses.domainRegistryConfig,
      system_program: SystemProgram.programId,
    },
  );
  await ensureInitialized(
    "domain-market",
    "deal_domain_market",
    addresses.domainMarketConfig,
    "initialize",
    {
      domain_registry_program: pid("deal_domain_registry"),
      domain_registry_config: addresses.domainRegistryConfig,
      payment_mint: mints.dc,
      fee_recipient: addresses.treasuryVault,
      fee_bps: 250,
    },
    {
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      config: addresses.domainMarketConfig,
      system_program: SystemProgram.programId,
    },
  );
  await ensureInitialized(
    "domain-rank",
    "deal_domain_rank",
    addresses.domainRankConfig,
    "initialize",
    {
      domain_registry_program: pid("deal_domain_registry"),
      domain_registry_config: addresses.domainRegistryConfig,
      treasury: addresses.treasuryVault,
      min_deposit: 100n,
      protocol_fee_bps: 1_000,
    },
    {
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      config: addresses.domainRankConfig,
      dc_mint: mints.dc,
      vault: addresses.domainRankVault,
      dc_token_program: TOKEN_PROGRAM,
      associated_token_program: ASSOCIATED_TOKEN_PROGRAM,
      system_program: SystemProgram.programId,
    },
  );
  await ensureInitialized(
    "domain-entry",
    "deal_domain_entry",
    addresses.domainEntryConfig,
    "initialize",
    {
      core_program: pid("deal_core"),
      core_registry: addresses.coreRegistry,
      asset_program: pid("deal_asset_controller"),
      asset_config: addresses.assetConfig,
      rank_program: pid("deal_domain_rank"),
      rank_config: addresses.domainRankConfig,
      default_timeout_seconds: 3_600n,
      default_replace_timeout_seconds: 3_600n,
    },
    {
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      config: addresses.domainEntryConfig,
      system_program: SystemProgram.programId,
    },
  );
  await ensureInitialized(
    "domain-hall",
    "deal_domain_hall",
    addresses.domainHallConfig,
    "initialize",
    {
      dc_mint: mints.dc,
      message_price: 100n,
      fee_enabled: true,
    },
    {
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      config: addresses.domainHallConfig,
      system_program: SystemProgram.programId,
    },
  );
  await ensureInitialized(
    "swap-orderbook",
    "deal_swap_orderbook",
    addresses.orderbookConfig,
    "initialize",
    { treasury: addresses.treasuryVault },
    {
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      config: addresses.orderbookConfig,
      system_program: SystemProgram.programId,
    },
  );
  await ensureInitialized(
    "parameter-registry",
    "deal_parameter_registry",
    addresses.parameterRegistry,
    "initialize",
    {
      governance_authority: addresses.executorAuthority,
      message_price: 100n,
      min_window_sec: 1_800,
    },
    {
      payer: wallet.publicKey,
      registry: addresses.parameterRegistry,
      system_program: SystemProgram.programId,
    },
  );

  const pairRecords = [];
  for (const [label, mint] of Object.entries({
    wrappedNative: mints.wrappedNative,
    stable0: mints.stable0,
    stable1: mints.stable1,
  })) {
    const pair = pda("deal_dex_pair", "dex-pair", mint);
    const vault0 = associatedToken(pair, mints.dc);
    const vault1 = associatedToken(pair, mint);
    const exists = await connection.getAccountInfo(pair, "confirmed");
    if (!exists) {
      const signature = await send(
        connection,
        wallet,
        instruction(
          "deal_dex_pair",
          "create_pair",
          { fee_numerator: 3, fee_denominator: 1_000 },
          {
            authority: wallet.publicKey,
            config: addresses.dexConfig,
            dc_mint: mints.dc,
            other_mint: mint,
            dc_token_program: TOKEN_PROGRAM,
            other_token_program: TOKEN_PROGRAM,
            pair,
            vault0,
            vault1,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM,
            system_program: SystemProgram.programId,
          },
        ),
      );
      signatures[`pair:${label}`] = signature;
    }
    pairRecords.push({ label, mint, pair, vault0, vault1 });
  }

  const admin = async (programName, instructionName, args, accounts) => {
    const signature = await send(
      connection,
      wallet,
      instruction(programName, instructionName, args, accounts),
    );
    signatures[`admin:${programName}:${instructionName}`] = signature;
    return signature;
  };
  const bootstrapAdmin = async (
    config,
    programName,
    instructionName,
    args,
    accounts,
  ) => {
    const state = decodeAuthority(
      (await connection.getAccountInfo(config, "confirmed")).data,
    );
    if (state.authority.equals(addresses.executorAuthority)) {
      return null;
    }
    if (!state.authority.equals(wallet.publicKey)) {
      throw new Error(
        `${programName}: unexpected bootstrap authority ${state.authority.toBase58()}`,
      );
    }
    return admin(programName, instructionName, args, accounts);
  };

  await bootstrapAdmin(
    addresses.coreRegistry,
    "deal_core",
    "set_domain_entry_controller",
    { domain_entry_controller: addresses.domainEntryConfig },
    { authority: wallet.publicKey, registry: addresses.coreRegistry },
  );
  await bootstrapAdmin(
    addresses.identityConfig,
    "deal_identity",
    "set_reward_controller",
    { reward_controller: addresses.rewardMinter },
    { authority: wallet.publicKey, config: addresses.identityConfig },
  );
  const rewardGrant = pda(
    "deal_dc_controller",
    "dc-minter",
    addresses.rewardMinter,
  );
  await bootstrapAdmin(
    addresses.dcConfig,
    "deal_dc_controller",
    "set_minter",
    { enabled: true },
    {
      authority: wallet.publicKey,
      config: addresses.dcConfig,
      minter: addresses.rewardMinter,
      grant: rewardGrant,
      system_program: SystemProgram.programId,
    },
  );
  await bootstrapAdmin(
    addresses.domainRegistryConfig,
    "deal_domain_registry",
    "set_domain_market",
    { domain_market: addresses.domainMarketConfig },
    {
      authority: wallet.publicKey,
      config: addresses.domainRegistryConfig,
    },
  );
  const domainReporterGrant = pda(
    "deal_domain_rank",
    "domain-rank-reporter",
    addresses.domainEntryConfig,
  );
  await bootstrapAdmin(
    addresses.domainRankConfig,
    "deal_domain_rank",
    "set_reporter",
    { allowed: true },
    {
      authority: wallet.publicKey,
      config: addresses.domainRankConfig,
      reporter: addresses.domainEntryConfig,
      reporter_grant: domainReporterGrant,
      system_program: SystemProgram.programId,
    },
  );
  await bootstrapAdmin(
    addresses.assetConfig,
    "deal_asset_controller",
    "set_terminal_guard",
    { enabled: true },
    { authority: wallet.publicKey, config: addresses.assetConfig },
  );

  const pauseTargets = [
    ["deal_governance_executor", addresses.governanceConfig, "config"],
    ["deal_dc_controller", addresses.dcConfig, "config"],
    ["deal_asset_controller", addresses.assetConfig, "config"],
    ["deal_core", addresses.coreRegistry, "registry"],
    ["deal_credit_graph", addresses.creditConfig, "config"],
    ["deal_dex_pair", addresses.dexConfig, "config"],
    ["deal_dex_router", addresses.routerConfig, "config"],
    ["deal_domain_registry", addresses.domainRegistryConfig, "config"],
    ["deal_domain_market", addresses.domainMarketConfig, "config"],
    ["deal_domain_rank", addresses.domainRankConfig, "config"],
    ["deal_domain_entry", addresses.domainEntryConfig, "config"],
    ["deal_domain_hall", addresses.domainHallConfig, "config"],
    ["deal_swap_orderbook", addresses.orderbookConfig, "config"],
    ["deal_finalizer", addresses.finalizerConfig, "config"],
    ["deal_history_index", addresses.historyConfig, "config"],
    ["deal_identity", addresses.identityConfig, "config"],
    ["deal_message_hub", addresses.messageConfig, "config"],
    ["deal_result_index", addresses.resultConfig, "config"],
    ["deal_reward_engine", addresses.rewardConfig, "config"],
  ];
  for (const [programName, config, configName] of pauseTargets) {
    await bootstrapAdmin(
      config,
      programName,
      "set_paused",
      { paused: false },
      { authority: wallet.publicKey, [configName]: config },
    );
  }

  const authorityTargets = [
    ["deal_asset_controller", addresses.assetConfig, "config"],
    ["deal_core", addresses.coreRegistry, "registry"],
    ["deal_credit_graph", addresses.creditConfig, "config"],
    ["deal_dc_controller", addresses.dcConfig, "config"],
    ["deal_dex_pair", addresses.dexConfig, "config"],
    ["deal_dex_router", addresses.routerConfig, "config"],
    ["deal_domain_registry", addresses.domainRegistryConfig, "config"],
    ["deal_domain_market", addresses.domainMarketConfig, "config"],
    ["deal_domain_rank", addresses.domainRankConfig, "config"],
    ["deal_domain_entry", addresses.domainEntryConfig, "config"],
    ["deal_domain_hall", addresses.domainHallConfig, "config"],
    ["deal_swap_asset_registry", addresses.swapRegistry, "registry"],
    ["deal_swap_orderbook", addresses.orderbookConfig, "config"],
    ["deal_finalizer", addresses.finalizerConfig, "config"],
    ["deal_history_index", addresses.historyConfig, "config"],
    ["deal_identity", addresses.identityConfig, "config"],
    ["deal_message_hub", addresses.messageConfig, "config"],
    ["deal_result_index", addresses.resultConfig, "config"],
    ["deal_reward_engine", addresses.rewardConfig, "config"],
    ["deal_governance_executor", addresses.governanceConfig, "config"],
  ];
  const governedPrograms = new Set([
    ...authorityTargets.map(([programName]) => programName),
    "deal_parameter_registry",
    "deal_protocol_treasury",
  ]);
  const governanceAdmin = decodeAuthority(
    (
      await connection.getAccountInfo(
        addresses.governanceConfig,
        "confirmed",
      )
    ).data,
  );
  if (!governanceAdmin.authority.equals(addresses.executorAuthority)) {
    for (const programName of governedPrograms) {
      const target = pid(programName);
      const targetRecord = pda(
        "deal_governance_executor",
        "allowed-target",
        target,
      );
      await admin(
        "deal_governance_executor",
        "set_allowed_target",
        { target, allowed: true },
        {
          authority: wallet.publicKey,
          config: addresses.governanceConfig,
          target_record: targetRecord,
          system_program: SystemProgram.programId,
        },
      );
    }
  }

  for (const [programName, config, configName] of authorityTargets.slice(0, -1)) {
    const info = await connection.getAccountInfo(config, "confirmed");
    const state = decodeAuthority(info.data);
    if (!state.authority.equals(addresses.executorAuthority)) {
      await admin(
        programName,
        "propose_authority",
        { pending_authority: addresses.executorAuthority },
        { authority: wallet.publicKey, [configName]: config },
      );
    }
  }

  async function governanceExecute({
    nonce,
    targetProgram,
    payload,
    targetAccounts,
    beforeSecondConfirmation,
  }) {
    const blockTime = BigInt(Math.floor(Date.now() / 1_000));
    const envelope = {
      version: 1,
      source_chain: 1n,
      source_broadcaster: [...SOURCE_BROADCASTER],
      bridge_set_version: 1n,
      nonce: BigInt(nonce),
      action_type: 1,
      target_program: targetProgram,
      valid_after: blockTime - 30n,
      expires_at: blockTime + 3_600n,
      accounts: targetAccounts.map((account) => ({
        pubkey: account.pubkey,
        is_writable: account.isWritable,
        is_signer: account.isSigner,
      })),
      payload: [...payload],
    };
    const hash = canonicalHash(envelope);
    const message = pda(
      "deal_governance_executor",
      "governance-message",
      hash,
    );
    const confirm = async (bridgeSigner) =>
      send(
        connection,
        wallet,
        instruction(
          "deal_governance_executor",
          "confirm_message",
          { message_hash: [...hash], envelope },
          {
            payer: wallet.publicKey,
            bridge_signer: bridgeSigner.publicKey,
            config: addresses.governanceConfig,
            message,
            system_program: SystemProgram.programId,
          },
        ),
        [bridgeSigner],
      );
    const execute = () =>
      send(
        connection,
        wallet,
        instruction(
          "deal_governance_executor",
          "execute_message",
          {},
          {
            config: addresses.governanceConfig,
            message,
            target_record: pda(
              "deal_governance_executor",
              "allowed-target",
              targetProgram,
            ),
            executor_authority: addresses.executorAuthority,
            target_program: targetProgram,
          },
          targetAccounts.filter(
            (account) =>
              !new PublicKey(account.pubkey).equals(addresses.executorAuthority),
          ),
        ),
      );

    const first = await confirm(bridgeSigners[0]);
    if (beforeSecondConfirmation) {
      await beforeSecondConfirmation({ confirm, execute, message, hash });
    }
    const second = await confirm(bridgeSigners[1]);
    const execution = await execute();
    return {
      hash: `0x${hash.toString("hex")}`,
      message: message.toBase58(),
      confirmations: [first, second],
      execution,
    };
  }

  const govInfoBefore = await connection.getAccountInfo(
    addresses.governanceConfig,
    "confirmed",
  );
  let nextNonce = decodeGovernance(govInfoBefore.data).lastExecutedNonce + 1n;
  const branchEvidence = {};
  if (nextNonce === 1n) {
    const setMessagePrice = instruction(
      "deal_parameter_registry",
      "set_message_price",
      { message_price: 100n },
      {
        governance_authority: addresses.executorAuthority,
        registry: addresses.parameterRegistry,
      },
    ).data;
    const unknownBridge = ensureKeypair("unknown-bridge").keypair;
    const parameterTest = await governanceExecute({
      nonce: nextNonce,
      targetProgram: pid("deal_parameter_registry"),
      payload: setMessagePrice,
      targetAccounts: [
        {
          pubkey: addresses.executorAuthority,
          isSigner: true,
          isWritable: false,
        },
        {
          pubkey: addresses.parameterRegistry,
          isSigner: false,
          isWritable: true,
        },
      ],
      beforeSecondConfirmation: async ({ confirm, execute }) => {
        branchEvidence.executeBeforeThreshold = await expectFailure(
          execute,
          "governance execution before threshold",
        );
        branchEvidence.duplicateBridge = await expectFailure(
          () => confirm(bridgeSigners[0]),
          "duplicate bridge confirmation",
        );
        branchEvidence.unknownBridge = await expectFailure(
          () => confirm(unknownBridge),
          "unknown bridge confirmation",
        );
      },
    });
    branchEvidence.replay = await expectFailure(
      () =>
        send(
          connection,
          wallet,
          instruction(
            "deal_governance_executor",
            "execute_message",
            {},
            {
              config: addresses.governanceConfig,
              message: new PublicKey(parameterTest.message),
              target_record: pda(
                "deal_governance_executor",
                "allowed-target",
                pid("deal_parameter_registry"),
              ),
              executor_authority: addresses.executorAuthority,
              target_program: pid("deal_parameter_registry"),
            },
            [
              {
                pubkey: addresses.parameterRegistry,
                isSigner: false,
                isWritable: true,
              },
            ],
          ),
        ),
      "governance message replay",
    );
    signatures["governance:parameter-smoke"] = parameterTest.execution;
    nextNonce += 1n;
  }

  const handoffs = [];
  for (const [programName, config, configName] of authorityTargets.slice(0, -1)) {
    const before = decodeAuthority(
      (await connection.getAccountInfo(config, "confirmed")).data,
    );
    if (before.authority.equals(addresses.executorAuthority)) {
      handoffs.push({ programName, action: "skip-governed" });
      continue;
    }
    if (!before.pendingAuthority.equals(addresses.executorAuthority)) {
      throw new Error(`${programName}: pending authority was not proposed`);
    }
    const acceptPayload = instruction(
      programName,
      "accept_authority",
      {},
      {
        pending_authority: addresses.executorAuthority,
        [configName]: config,
      },
    ).data;
    const result = await governanceExecute({
      nonce: nextNonce,
      targetProgram: pid(programName),
      payload: acceptPayload,
      targetAccounts: [
        {
          pubkey: addresses.executorAuthority,
          isSigner: true,
          isWritable: false,
        },
        { pubkey: config, isSigner: false, isWritable: true },
      ],
    });
    const after = decodeAuthority(
      (await connection.getAccountInfo(config, "confirmed")).data,
    );
    if (!after.authority.equals(addresses.executorAuthority)) {
      throw new Error(`${programName}: authority handoff failed`);
    }
    handoffs.push({
      programName,
      nonce: nextNonce.toString(),
      messageHash: result.hash,
      execution: result.execution,
    });
    nextNonce += 1n;
  }

  const treasuryState = await connection.getAccountInfo(
    addresses.treasuryConfig,
    "confirmed",
  );
  const treasuryController = new PublicKey(
    treasuryState.data.subarray(8, 40),
  );
  if (!treasuryController.equals(addresses.executorAuthority)) {
    if (!treasuryController.equals(wallet.publicKey)) {
      throw new Error(
        `treasury controller is unexpected: ${treasuryController.toBase58()}`,
      );
    }
    signatures["treasury:update-controller"] = await send(
      connection,
      wallet,
      instruction(
        "deal_protocol_treasury",
        "update_controller",
        { new_controller: addresses.executorAuthority },
        {
          controller: wallet.publicKey,
          config: addresses.treasuryConfig,
        },
      ),
    );
  }

  const governanceBeforeSelf = decodeAuthority(
    (
      await connection.getAccountInfo(
        addresses.governanceConfig,
        "confirmed",
      )
    ).data,
  );
  if (!governanceBeforeSelf.authority.equals(addresses.executorAuthority)) {
    if (!governanceBeforeSelf.pendingAuthority.equals(addresses.executorAuthority)) {
      await admin(
        "deal_governance_executor",
        "propose_authority",
        { pending_authority: addresses.executorAuthority },
        {
          authority: wallet.publicKey,
          config: addresses.governanceConfig,
        },
      );
    }
    const selfAccept = instruction(
      "deal_governance_executor",
      "accept_authority",
      {},
      {
        pending_authority: addresses.executorAuthority,
        config: addresses.governanceConfig,
      },
    ).data;
    const selfResult = await governanceExecute({
      nonce: nextNonce,
      targetProgram: pid("deal_governance_executor"),
      payload: selfAccept,
      targetAccounts: [
        {
          pubkey: addresses.executorAuthority,
          isSigner: true,
          isWritable: false,
        },
        {
          pubkey: addresses.governanceConfig,
          isSigner: false,
          isWritable: true,
        },
      ],
    });
    handoffs.push({
      programName: "deal_governance_executor",
      nonce: nextNonce.toString(),
      messageHash: selfResult.hash,
      execution: selfResult.execution,
    });
  }

  const unauthorizedDirectAdmin = await expectFailure(
    () =>
      send(
        connection,
        wallet,
        instruction(
          "deal_asset_controller",
          "set_paused",
          { paused: true },
          {
            authority: wallet.publicKey,
            config: addresses.assetConfig,
          },
        ),
      ),
    "former bootstrap wallet direct administration",
  );

  const verifiedAuthorities = [];
  for (const [programName, config] of authorityTargets) {
    const state = decodeAuthority(
      (await connection.getAccountInfo(config, "confirmed")).data,
    );
    if (!state.authority.equals(addresses.executorAuthority)) {
      throw new Error(`${programName}: final authority is not executor PDA`);
    }
    verifiedAuthorities.push({
      programName,
      config: config.toBase58(),
      authority: state.authority.toBase58(),
      pendingAuthority: state.pendingAuthority.toBase58(),
    });
  }
  const finalTreasury = await connection.getAccountInfo(
    addresses.treasuryConfig,
    "confirmed",
  );
  const finalTreasuryController = new PublicKey(
    finalTreasury.data.subarray(8, 40),
  );
  if (!finalTreasuryController.equals(addresses.executorAuthority)) {
    throw new Error("treasury controller handoff failed");
  }
  const parameterInfo = await connection.getAccountInfo(
    addresses.parameterRegistry,
    "confirmed",
  );
  const parameterAuthority = new PublicKey(parameterInfo.data.subarray(8, 40));
  if (!parameterAuthority.equals(addresses.executorAuthority)) {
    throw new Error("parameter registry authority is not executor PDA");
  }

  const finalGovernance = decodeGovernance(
    (
      await connection.getAccountInfo(
        addresses.governanceConfig,
        "confirmed",
      )
    ).data,
  );
  const report = {
    generatedAt: new Date().toISOString(),
    cluster: "localnet",
    rpcUrl,
    genesisHash,
    wallet: wallet.publicKey.toBase58(),
    productionProgramCount: programNames.length,
    source: {
      chainId: "1",
      broadcaster: `0x${ETH_V2_BROADCASTER}`,
      canonicalBroadcasterBytes32: `0x${SOURCE_BROADCASTER.toString("hex")}`,
    },
    governance: {
      config: addresses.governanceConfig.toBase58(),
      executorAuthority: addresses.executorAuthority.toBase58(),
      bridgeSigners: bridgeSigners.map((signer) =>
        signer.publicKey.toBase58(),
      ),
      threshold: finalGovernance.threshold,
      paused: finalGovernance.paused,
      lastExecutedNonce: finalGovernance.lastExecutedNonce.toString(),
      finalAuthority: finalGovernance.authority.toBase58(),
      branchEvidence,
    },
    mints: Object.fromEntries(
      Object.entries(mints).map(([name, mint]) => [name, mint.toBase58()]),
    ),
    addresses: Object.fromEntries(
      Object.entries(addresses).map(([name, address]) => [
        name,
        address.toBase58(),
      ]),
    ),
    initialized,
    officialPairs: pairRecords.map((entry) => ({
      ...entry,
      mint: entry.mint.toBase58(),
      pair: entry.pair.toBase58(),
      vault0: entry.vault0.toBase58(),
      vault1: entry.vault1.toBase58(),
    })),
    handoffs,
    verifiedAuthorities,
    treasuryController: finalTreasuryController.toBase58(),
    parameterAuthority: parameterAuthority.toBase58(),
    terminalGuardEnabled: true,
    unauthorizedFormerAdminRejected: unauthorizedDirectAdmin,
    signatures,
  };
  const runId = report.generatedAt.replaceAll(":", "").replaceAll(".", "");
  const reportPath = resolve(
    localDir,
    `localnet-production-bootstrap-${runId}.json`,
  );
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        genesisHash,
        reportPath,
        governanceConfig: report.governance.config,
        executorAuthority: report.governance.executorAuthority,
        mints: report.mints,
        addresses: report.addresses,
      },
      null,
      2,
    )}\n`,
  );
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
