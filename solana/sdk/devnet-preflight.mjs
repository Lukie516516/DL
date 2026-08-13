import { readFileSync, statSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";

const DEVNET_GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const EXCLUDED_REFERENCE_PROGRAMS = new Set([
  "deal_d_token",
  "deal_dividend",
  "deal_governance",
  "deal_governance_activity",
]);
const PROGRAM_ACCOUNT_BYTES = 36;
const PROGRAM_DATA_METADATA_BYTES = 45;
const BUFFER_METADATA_BYTES = 37;
const FEE_HEADROOM_LAMPORTS = LAMPORTS_PER_SOL;

const sdkDir = dirname(fileURLToPath(import.meta.url));
const solanaDir = resolve(sdkDir, "..");

export function parseDevnetPrograms() {
  const anchor = readFileSync(resolve(solanaDir, "Anchor.toml"), "utf8");
  const section = anchor.match(/\[programs\.devnet\]([\s\S]*?)(?=\n\[)/);
  if (!section) throw new Error("Anchor.toml is missing [programs.devnet]");
  return section[1]
    .trim()
    .split("\n")
    .map((line) => line.match(/^([a-z0-9_]+)\s*=\s*"([^"]+)"$/))
    .filter(Boolean)
    .map((match) => ({ name: match[1], address: match[2] }))
    .filter(({ name }) => !EXCLUDED_REFERENCE_PROGRAMS.has(name));
}

export function loadWallet() {
  const walletPath = resolve(
    process.env.SOLANA_WALLET_PATH ?? resolve(solanaDir, ".local/test-wallet.json"),
  );
  const secret = Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8")));
  return { walletPath, keypair: Keypair.fromSecretKey(secret) };
}

export function pinnedTlsFetch(ip) {
  if (!isIP(ip)) throw new Error("SOLANA_RPC_RESOLVE_IP must be an IP address");
  return (input, init = {}) =>
    new Promise((resolveRequest, rejectRequest) => {
      const target = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      const request = httpsRequest(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method: init.method ?? "GET",
          headers: init.headers,
          servername: target.hostname,
          lookup: (_hostname, options, callback) => {
            const family = isIP(ip);
            if (options?.all) {
              callback(null, [{ address: ip, family }]);
            } else {
              callback(null, ip, family);
            }
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            resolveRequest(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode,
                statusText: response.statusMessage,
                headers: response.headers,
              }),
            );
          });
        },
      );
      request.on("error", rejectRequest);
      if (init.signal) {
        init.signal.addEventListener(
          "abort",
          () => request.destroy(new Error("request aborted")),
          { once: true },
        );
      }
      if (init.body) request.write(init.body);
      request.end();
    });
}

export async function runDevnetPreflight() {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    throw new Error(
      "SOLANA_RPC_URL is required; use a trusted TLS Devnet RPC endpoint",
    );
  }
  const url = new URL(rpcUrl);
  if (url.protocol !== "https:") {
    throw new Error("SOLANA_RPC_URL must use https");
  }

  const programs = parseDevnetPrograms();
  if (programs.length !== 24) {
    throw new Error(`expected 24 production programs, got ${programs.length}`);
  }
  const binaries = programs.map((program) => {
    const path = resolve(solanaDir, `target/deploy/${program.name}.so`);
    return { ...program, path, bytes: statSync(path).size };
  });
  const { walletPath, keypair } = loadWallet();
  const pinnedIp = process.env.SOLANA_RPC_RESOLVE_IP;
  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    fetch: pinnedIp ? pinnedTlsFetch(pinnedIp) : undefined,
  });

  const [genesisHash, version, balance, programAccounts, zeroByteRent, oneByteRent] =
    await Promise.all([
      connection.getGenesisHash(),
      connection.getVersion(),
      connection.getBalance(keypair.publicKey, "confirmed"),
      connection.getMultipleAccountsInfo(
        programs.map(({ address }) => new PublicKey(address)),
        "confirmed",
      ),
      connection.getMinimumBalanceForRentExemption(0),
      connection.getMinimumBalanceForRentExemption(1),
    ]);
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error(
      `RPC genesis ${genesisHash} is not Solana Devnet ${DEVNET_GENESIS_HASH}`,
    );
  }

  const rentPerByte = oneByteRent - zeroByteRent;
  if (rentPerByte <= 0) {
    throw new Error("RPC returned an invalid rent schedule");
  }
  const rentForBytes = (bytes) => zeroByteRent + rentPerByte * bytes;
  const programRent = rentForBytes(PROGRAM_ACCOUNT_BYTES);
  const programDataRents = binaries.map(({ bytes }) =>
    rentForBytes(PROGRAM_DATA_METADATA_BYTES + bytes),
  );
  const bufferRents = binaries.map(({ bytes }) =>
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
  }));

  const report = {
    checkedAt: new Date().toISOString(),
    rpcOrigin: url.origin,
    rpcPinnedIp: pinnedIp ?? null,
    genesisHash,
    solanaCore: version["solana-core"],
    walletPath,
    wallet: keypair.publicKey.toBase58(),
    walletBalanceLamports: balance,
    walletBalanceSol: balance / LAMPORTS_PER_SOL,
    productionProgramCount: programs.length,
    localBinaryBytes: binaries.reduce((sum, item) => sum + item.bytes, 0),
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
    programs: deployed,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDevnetPreflight()
    .then((report) => {
      if (
        report.programs.some(
          ({ exists, executable }) => exists && !executable,
        ) ||
        !report.sufficientBalance
      ) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
      );
      process.exitCode = 1;
    });
}
