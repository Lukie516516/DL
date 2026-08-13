import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";

import {
  loadWallet,
  parseDevnetPrograms,
  pinnedTlsFetch,
} from "./devnet-preflight.mjs";

export const MAINNET_GENESIS_HASH =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const PROGRAM_ACCOUNT_BYTES = 36;
const PROGRAM_DATA_METADATA_BYTES = 45;
const BUFFER_METADATA_BYTES = 37;
const FEE_HEADROOM_LAMPORTS = 2 * LAMPORTS_PER_SOL;
const RETRYABLE_RPC_ERROR =
  /fetch failed|ETIMEDOUT|ECONNRESET|429|502|503|504/i;

const sdkDir = dirname(fileURLToPath(import.meta.url));
const solanaDir = resolve(sdkDir, "..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertHttpsRpc(value, label) {
  if (!value) throw new Error(`${label} is required`);
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${label} must use https`);
  }
  return url;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function readRpc(label, operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === attempts || !RETRYABLE_RPC_ERROR.test(message)) {
        throw new Error(`${label} failed: ${message}`, { cause: error });
      }
      await delay(250 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

export async function runMainnetPreflight() {
  const rpcUrl = process.env.SOLANA_MAINNET_RPC_URL;
  const rpc = assertHttpsRpc(rpcUrl, "SOLANA_MAINNET_RPC_URL");
  const backupRpcUrl = process.env.SOLANA_MAINNET_BACKUP_RPC_URL;
  const backupRpc = backupRpcUrl
    ? assertHttpsRpc(
        backupRpcUrl,
        "SOLANA_MAINNET_BACKUP_RPC_URL",
      )
    : null;
  if (!process.env.SOLANA_WALLET_PATH) {
    throw new Error(
      "SOLANA_WALLET_PATH must explicitly select the Mainnet operator keypair",
    );
  }
  const expectedWallet = process.env.SOLANA_MAINNET_EXPECTED_WALLET;
  if (!expectedWallet) {
    throw new Error("SOLANA_MAINNET_EXPECTED_WALLET is required");
  }

  const programs = parseDevnetPrograms();
  if (programs.length !== 24) {
    throw new Error(`expected 24 production programs, got ${programs.length}`);
  }
  const artifacts = programs.map((program) => {
    const binaryPath = resolve(
      solanaDir,
      `target/deploy/${program.name}.so`,
    );
    const programKeypairPath = resolve(
      solanaDir,
      `target/deploy/${program.name}-keypair.json`,
    );
    const binary = readFileSync(binaryPath);
    const programSecret = JSON.parse(
      readFileSync(programKeypairPath, "utf8"),
    );
    const publicKey = new PublicKey(
      // A Solana keypair stores the public key in the final 32 bytes.
      Uint8Array.from(programSecret.slice(32, 64)),
    );
    if (publicKey.toBase58() !== program.address) {
      throw new Error(
        `${program.name}: program keypair does not match ${program.address}`,
      );
    }
    if ((statSync(programKeypairPath).mode & 0o077) !== 0) {
      throw new Error(
        `${program.name}: program keypair permissions are not private`,
      );
    }
    return {
      ...program,
      binaryPath,
      programKeypairPath,
      bytes: binary.length,
      sha256: sha256(binary),
    };
  });

  const { walletPath, keypair } = loadWallet();
  if (keypair.publicKey.toBase58() !== expectedWallet) {
    throw new Error(
      `selected wallet ${keypair.publicKey.toBase58()} != expected ${expectedWallet}`,
    );
  }
  if ((statSync(walletPath).mode & 0o077) !== 0) {
    throw new Error("Mainnet operator keypair permissions are not private");
  }

  const pinnedIp = process.env.SOLANA_MAINNET_RPC_RESOLVE_IP;
  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    fetch: pinnedIp ? pinnedTlsFetch(pinnedIp) : undefined,
  });
  // Public endpoints may disconnect when several preflight requests arrive at
  // once. Keep safety checks sequential and identify the exact failed step.
  const genesisHash = await readRpc("primary genesis", () =>
    connection.getGenesisHash(),
  );
  const version = await readRpc("primary version", () =>
    connection.getVersion(),
  );
  const balance = await readRpc("primary wallet balance", () =>
    connection.getBalance(keypair.publicKey, "confirmed"),
  );
  const programAccounts = await readRpc("primary program accounts", () =>
    connection.getMultipleAccountsInfo(
      programs.map(({ address }) => new PublicKey(address)),
      "confirmed",
    ),
  );
  const zeroByteRent = await readRpc("primary zero-byte rent", () =>
    connection.getMinimumBalanceForRentExemption(0),
  );
  const oneByteRent = await readRpc("primary one-byte rent", () =>
    connection.getMinimumBalanceForRentExemption(1),
  );
  const slot = await readRpc("primary slot", () =>
    connection.getSlot("confirmed"),
  );
  if (genesisHash !== MAINNET_GENESIS_HASH) {
    throw new Error(
      `RPC genesis ${genesisHash} is not Solana Mainnet ${MAINNET_GENESIS_HASH}`,
    );
  }

  let backup = null;
  if (backupRpc) {
    const backupConnection = new Connection(backupRpcUrl, "confirmed");
    const backupGenesis = await readRpc("backup genesis", () =>
      backupConnection.getGenesisHash(),
    );
    const backupSlot = await readRpc("backup slot", () =>
      backupConnection.getSlot("confirmed"),
    );
    const backupBalance = await readRpc("backup wallet balance", () =>
      backupConnection.getBalance(keypair.publicKey, "confirmed"),
    );
    if (backupGenesis !== MAINNET_GENESIS_HASH) {
      throw new Error(
        `backup RPC genesis ${backupGenesis} is not Solana Mainnet`,
      );
    }
    backup = {
      rpcOrigin: backupRpc.origin,
      genesisHash: backupGenesis,
      slot: backupSlot,
      walletBalanceLamports: backupBalance,
      walletBalanceSol: backupBalance / LAMPORTS_PER_SOL,
    };
  }

  const rentPerByte = oneByteRent - zeroByteRent;
  if (rentPerByte <= 0) {
    throw new Error("RPC returned an invalid rent schedule");
  }
  const rentForBytes = (bytes) => zeroByteRent + rentPerByte * bytes;
  const programRent = rentForBytes(PROGRAM_ACCOUNT_BYTES);
  const programDataRents = artifacts.map(({ bytes }) =>
    rentForBytes(PROGRAM_DATA_METADATA_BYTES + bytes),
  );
  const bufferRents = artifacts.map(({ bytes }) =>
    rentForBytes(BUFFER_METADATA_BYTES + bytes),
  );
  const persistentRentLamports = programDataRents.reduce(
    (sum, rent) => sum + rent + programRent,
    0,
  );
  const largestTransientBufferLamports = Math.max(...bufferRents);
  const recommendedLamports =
    persistentRentLamports +
    largestTransientBufferLamports +
    FEE_HEADROOM_LAMPORTS;
  const deployed = programs.map((program, index) => ({
    ...program,
    exists: programAccounts[index] != null,
    executable: programAccounts[index]?.executable ?? false,
    owner: programAccounts[index]?.owner.toBase58() ?? null,
  }));
  const manifest = {
    version: 1,
    clusterGenesisHash: MAINNET_GENESIS_HASH,
    wallet: keypair.publicKey.toBase58(),
    programs: artifacts.map(({ name, address, bytes, sha256: hash }) => ({
      name,
      address,
      bytes,
      sha256: hash,
    })),
  };
  const manifestJson = JSON.stringify(manifest);
  const manifestSha256 = sha256(manifestJson);

  const report = {
    checkedAt: new Date().toISOString(),
    readOnly: true,
    rpcOrigin: rpc.origin,
    rpcPinnedIp: pinnedIp ?? null,
    backupRpc: backup,
    genesisHash,
    slot,
    solanaCore: version["solana-core"],
    walletPath,
    wallet: keypair.publicKey.toBase58(),
    walletBalanceLamports: balance,
    walletBalanceSol: balance / LAMPORTS_PER_SOL,
    productionProgramCount: programs.length,
    localBinaryBytes: artifacts.reduce((sum, item) => sum + item.bytes, 0),
    deployedProgramCount: deployed.filter(({ executable }) => executable).length,
    persistentRentLamports,
    persistentRentSol: persistentRentLamports / LAMPORTS_PER_SOL,
    largestTransientBufferLamports,
    largestTransientBufferSol:
      largestTransientBufferLamports / LAMPORTS_PER_SOL,
    feeHeadroomSol: FEE_HEADROOM_LAMPORTS / LAMPORTS_PER_SOL,
    recommendedLamports,
    recommendedSol: recommendedLamports / LAMPORTS_PER_SOL,
    sufficientBalance: balance >= recommendedLamports,
    manifestSha256,
    manifest,
    programs: deployed,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMainnetPreflight()
    .then((report) => {
      if (
        !report.sufficientBalance ||
        report.programs.some(
          ({ exists, executable }) => exists && !executable,
        )
      ) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
      process.exitCode = 1;
    });
}
