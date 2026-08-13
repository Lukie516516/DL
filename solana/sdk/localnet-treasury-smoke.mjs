import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
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

const sdkDir = dirname(fileURLToPath(import.meta.url));
const solanaDir = resolve(sdkDir, "..");
const localDir = resolve(
  process.env.SOLANA_LOCAL_STATE_DIR ?? resolve(solanaDir, ".local"),
);
const rpcUrl = process.env.SOLANA_LOCAL_RPC_URL ?? "http://127.0.0.1:8899";
const treasuryProgram = new PublicKey(
  "2PoaC93xnLCD4zUTQVG91MMURnuaajkBuqLhZEPvP9j8",
);
const tokenProgram = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const walletPath = resolve(
  process.env.SOLANA_WALLET_PATH ?? resolve(localDir, "test-wallet.json"),
);

function assertLocalRpc(value) {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`treasury smoke refuses non-loopback RPC ${url.origin}`);
  }
}

function discriminator(name) {
  return createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

function u64(value) {
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(BigInt(value));
  return data;
}

function instruction(name, args, keys) {
  return new TransactionInstruction({
    programId: treasuryProgram,
    keys,
    data: Buffer.concat([discriminator(name), ...args]),
  });
}

function loadKeypair(path) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
  );
}

function writeKeypair(path, keypair) {
  writeFileSync(path, `${JSON.stringify(Array.from(keypair.secretKey))}\n`, {
    flag: "wx",
    mode: 0o600,
  });
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

function splToken(args, walletCliPath) {
  return run("spl-token", [
    "--url",
    rpcUrl,
    "--fee-payer",
    walletCliPath,
    ...args,
  ]);
}

function decodeConfig(data) {
  if (data.length < 75) throw new Error("treasury config data is too short");
  return {
    controller: new PublicKey(data.subarray(8, 40)),
    bootstrapAdmin: new PublicKey(data.subarray(40, 72)),
    bootstrapLocked: data[72] !== 0,
    bump: data[73],
    vaultBump: data[74],
  };
}

function decodeTokenAccount(data) {
  if (data.length < 72) throw new Error("token account data is too short");
  return {
    mint: new PublicKey(data.subarray(0, 32)),
    owner: new PublicKey(data.subarray(32, 64)),
    amount: data.readBigUInt64LE(64),
  };
}

async function send(connection, payer, instructions, extraSigners = []) {
  return sendAndConfirmTransaction(
    connection,
    new Transaction().add(...instructions),
    [payer, ...extraSigners],
    { commitment: "confirmed" },
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
          ? error.message.split("\n")[0].slice(0, 240)
          : String(error).slice(0, 240),
    };
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function main() {
  assertLocalRpc(rpcUrl);
  if (
    process.env.SOLANA_LOCAL_TREASURY_CONFIRM !==
    "LOCALNET_TREASURY_SMOKE"
  ) {
    throw new Error(
      "treasury smoke requires SOLANA_LOCAL_TREASURY_CONFIRM=LOCALNET_TREASURY_SMOKE",
    );
  }

  mkdirSync(localDir, { recursive: true });
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = loadKeypair(walletPath);
  const walletCliPath = relative(solanaDir, walletPath);
  const attacker = Keypair.generate();
  const recipient = Keypair.generate();
  const mint = Keypair.generate();
  const vaultTokenAccount = Keypair.generate();
  const recipientTokenAccount = Keypair.generate();
  const runId = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const keyDir = resolve(localDir, `treasury-smoke-${runId}`);
  mkdirSync(keyDir, { recursive: false });
  const mintPath = resolve(keyDir, "mint.json");
  const vaultTokenPath = resolve(keyDir, "vault-token.json");
  const recipientTokenPath = resolve(keyDir, "recipient-token.json");
  writeKeypair(mintPath, mint);
  writeKeypair(vaultTokenPath, vaultTokenAccount);
  writeKeypair(recipientTokenPath, recipientTokenAccount);

  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol-treasury-config")],
    treasuryProgram,
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol-treasury-vault")],
    treasuryProgram,
  );

  const programInfo = await connection.getAccountInfo(treasuryProgram, "confirmed");
  if (!programInfo?.executable) {
    throw new Error("deployed treasury program is missing or not executable");
  }

  const signatures = {};
  let configInfo = await connection.getAccountInfo(config, "confirmed");
  if (!configInfo) {
    const initialize = instruction(
      "initialize",
      [wallet.publicKey.toBuffer(), wallet.publicKey.toBuffer()],
      [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: true },
        { pubkey: vaultAuthority, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    );
    signatures.initialize = await send(connection, wallet, [initialize]);
    configInfo = await connection.getAccountInfo(config, "confirmed");
  }
  if (!configInfo) throw new Error("treasury config was not initialized");
  let configState = decodeConfig(configInfo.data);
  if (!configState.controller.equals(wallet.publicKey)) {
    throw new Error("local treasury controller is not the smoke wallet");
  }
  if (!configState.bootstrapAdmin.equals(wallet.publicKey)) {
    throw new Error("local treasury bootstrap admin is not the smoke wallet");
  }

  const nativeVaultBefore = await connection.getBalance(
    vaultAuthority,
    "confirmed",
  );
  const fundAmount = BigInt(LAMPORTS_PER_SOL);
  const fundNative = instruction(
    "fund_native",
    [u64(fundAmount)],
    [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  );
  signatures.fundNative = await send(connection, wallet, [fundNative]);

  const attackerAirdrop = await connection.requestAirdrop(
    attacker.publicKey,
    LAMPORTS_PER_SOL,
  );
  await connection.confirmTransaction(attackerAirdrop, "confirmed");
  const unauthorizedPay = instruction(
    "pay_native",
    [u64(100_000_000n)],
    [
      { pubkey: attacker.publicKey, isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: vaultAuthority, isSigner: false, isWritable: true },
      { pubkey: recipient.publicKey, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  );
  const unauthorizedNative = await expectFailure(
    () => send(connection, attacker, [unauthorizedPay]),
    "unauthorized native payment",
  );

  const recipientNativeBefore = await connection.getBalance(
    recipient.publicKey,
    "confirmed",
  );
  const nativePayAmount = 250_000_000n;
  const payNative = instruction(
    "pay_native",
    [u64(nativePayAmount)],
    [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: vaultAuthority, isSigner: false, isWritable: true },
      { pubkey: recipient.publicKey, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  );
  signatures.payNative = await send(connection, wallet, [payNative]);
  const [nativeVaultAfter, recipientNativeAfter] = await Promise.all([
    connection.getBalance(vaultAuthority, "confirmed"),
    connection.getBalance(recipient.publicKey, "confirmed"),
  ]);
  if (
    BigInt(nativeVaultAfter - nativeVaultBefore) !==
    fundAmount - nativePayAmount
  ) {
    throw new Error("native vault balance delta is incorrect");
  }
  if (
    BigInt(recipientNativeAfter - recipientNativeBefore) !== nativePayAmount
  ) {
    throw new Error("native recipient balance delta is incorrect");
  }

  const mintCliPath = relative(solanaDir, mintPath);
  const vaultTokenCliPath = relative(solanaDir, vaultTokenPath);
  const recipientTokenCliPath = relative(solanaDir, recipientTokenPath);
  splToken(
    [
      "create-token",
      "--decimals",
      "6",
      "--mint-authority",
      wallet.publicKey.toBase58(),
      mintCliPath,
      "--output",
      "json",
    ],
    walletCliPath,
  );
  splToken(
    [
      "create-account",
      mint.publicKey.toBase58(),
      vaultTokenCliPath,
      "--owner",
      vaultAuthority.toBase58(),
      "--output",
      "json",
    ],
    walletCliPath,
  );
  splToken(
    [
      "create-account",
      mint.publicKey.toBase58(),
      recipientTokenCliPath,
      "--owner",
      recipient.publicKey.toBase58(),
      "--output",
      "json",
    ],
    walletCliPath,
  );
  splToken(
    [
      "mint",
      mint.publicKey.toBase58(),
      "1000",
      vaultTokenAccount.publicKey.toBase58(),
      "--mint-authority",
      walletCliPath,
      "--output",
      "json",
    ],
    walletCliPath,
  );

  const tokenPayAmount = 250_000_000n;
  const payToken = instruction(
    "pay_token",
    [u64(tokenPayAmount)],
    [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      {
        pubkey: vaultTokenAccount.publicKey,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: recipientTokenAccount.publicKey,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: mint.publicKey, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
  );
  signatures.payToken = await send(connection, wallet, [payToken]);

  const [vaultTokenInfo, recipientTokenInfo] = await Promise.all([
    connection.getAccountInfo(vaultTokenAccount.publicKey, "confirmed"),
    connection.getAccountInfo(recipientTokenAccount.publicKey, "confirmed"),
  ]);
  if (!vaultTokenInfo || !recipientTokenInfo) {
    throw new Error("token accounts disappeared");
  }
  const vaultTokenState = decodeTokenAccount(vaultTokenInfo.data);
  const recipientTokenState = decodeTokenAccount(recipientTokenInfo.data);
  if (
    !vaultTokenInfo.owner.equals(tokenProgram) ||
    !recipientTokenInfo.owner.equals(tokenProgram) ||
    !vaultTokenState.owner.equals(vaultAuthority) ||
    !vaultTokenState.mint.equals(mint.publicKey) ||
    !recipientTokenState.owner.equals(recipient.publicKey) ||
    !recipientTokenState.mint.equals(mint.publicKey) ||
    vaultTokenState.amount !== 750_000_000n ||
    recipientTokenState.amount !== tokenPayAmount
  ) {
    throw new Error("token vault ownership, mint or balance verification failed");
  }

  if (!configState.bootstrapLocked) {
    const lockBootstrap = instruction("lock_bootstrap", [], [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: true },
    ]);
    signatures.lockBootstrap = await send(connection, wallet, [lockBootstrap]);
  }
  configInfo = await connection.getAccountInfo(config, "confirmed");
  if (!configInfo) throw new Error("treasury config disappeared");
  configState = decodeConfig(configInfo.data);
  if (!configState.bootstrapLocked) {
    throw new Error("bootstrap did not lock");
  }

  const forbiddenBootstrapChange = instruction(
    "bootstrap_set_controller",
    [attacker.publicKey.toBuffer()],
    [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: true },
    ],
  );
  const lockedBootstrap = await expectFailure(
    () => send(connection, wallet, [forbiddenBootstrapChange]),
    "locked bootstrap controller change",
  );

  const report = {
    generatedAt: new Date().toISOString(),
    cluster: "localnet",
    rpcUrl,
    treasuryProgram: treasuryProgram.toBase58(),
    controller: wallet.publicKey.toBase58(),
    config: config.toBase58(),
    vaultAuthority: vaultAuthority.toBase58(),
    bootstrapLocked: configState.bootstrapLocked,
    signatures,
    native: {
      fundAmountLamports: fundAmount.toString(),
      paidAmountLamports: nativePayAmount.toString(),
      vaultBalanceBeforeLamports: nativeVaultBefore.toString(),
      vaultBalanceAfterLamports: nativeVaultAfter.toString(),
      recipientDeltaLamports: (
        recipientNativeAfter - recipientNativeBefore
      ).toString(),
      unauthorizedControllerRejected: unauthorizedNative,
    },
    token: {
      mint: mint.publicKey.toBase58(),
      decimals: 6,
      vaultTokenAccount: vaultTokenAccount.publicKey.toBase58(),
      vaultOwner: vaultTokenState.owner.toBase58(),
      vaultBalanceBaseUnits: vaultTokenState.amount.toString(),
      recipientTokenAccount: recipientTokenAccount.publicKey.toBase58(),
      recipientBalanceBaseUnits: recipientTokenState.amount.toString(),
    },
    bootstrap: {
      lockedControllerChangeRejected: lockedBootstrap,
    },
  };
  const reportPath = resolve(
    localDir,
    `localnet-treasury-smoke-${runId}.json`,
  );
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  process.stdout.write(
    `${JSON.stringify({ ...report, reportPath }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
