import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import {
  loadWallet,
  parseDevnetPrograms,
} from "./devnet-preflight.mjs";

const sdkDir = dirname(fileURLToPath(import.meta.url));
const solanaDir = resolve(sdkDir, "..");
const localDir = resolve(
  process.env.SOLANA_LOCAL_STATE_DIR ?? resolve(solanaDir, ".local"),
);
const rpcUrl = process.env.SOLANA_LOCAL_RPC_URL ?? "http://127.0.0.1:8899";

function assertLocalRpc(value) {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`local deployment refuses non-loopback RPC ${url.origin}`);
  }
}

function runSolana(args) {
  const result = spawnSync("solana", args, {
    cwd: solanaDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `solana ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

function parseJson(output, label) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
}

function programArtifact(program) {
  const binaryPath = resolve(solanaDir, `target/deploy/${program.name}.so`);
  const keypairPath = resolve(
    solanaDir,
    `target/deploy/${program.name}-keypair.json`,
  );
  const programKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))),
  );
  if (programKeypair.publicKey.toBase58() !== program.address) {
    throw new Error(
      `${program.name}: keypair ${programKeypair.publicKey.toBase58()} != ${program.address}`,
    );
  }
  return {
    ...program,
    binaryPath,
    keypairPath,
    binaryCliPath: relative(solanaDir, binaryPath),
    keypairCliPath: relative(solanaDir, keypairPath),
    bytes: statSync(binaryPath).size,
    sha256: createHash("sha256")
      .update(readFileSync(binaryPath))
      .digest("hex"),
  };
}

function showProgram(address, walletCliPath) {
  return parseJson(
    runSolana([
      "--keypair",
      walletCliPath,
      "program",
      "show",
      address,
      "--url",
      rpcUrl,
      "--commitment",
      "confirmed",
      "--output",
      "json",
    ]),
    `program show ${address}`,
  );
}

async function main() {
  assertLocalRpc(rpcUrl);
  if (
    process.env.SOLANA_LOCAL_DEPLOY_CONFIRM !== "LOCALNET_24_PROGRAMS"
  ) {
    throw new Error(
      "deployment requires SOLANA_LOCAL_DEPLOY_CONFIRM=LOCALNET_24_PROGRAMS",
    );
  }

  const programs = parseDevnetPrograms();
  if (programs.length !== 24) {
    throw new Error(`expected 24 production programs, got ${programs.length}`);
  }
  const artifacts = programs.map(programArtifact);
  const { walletPath, keypair } = loadWallet();
  const walletCliPath = relative(solanaDir, walletPath);
  if (walletCliPath.startsWith("..")) {
    throw new Error("local deployment wallet must be inside the Solana workspace");
  }
  const wallet = keypair.publicKey.toBase58();
  const connection = new Connection(rpcUrl, "confirmed");
  const [genesisHash, balance, accountInfos] = await Promise.all([
    connection.getGenesisHash(),
    connection.getBalance(keypair.publicKey, "confirmed"),
    connection.getMultipleAccountsInfo(
      artifacts.map(({ address }) => new PublicKey(address)),
      "confirmed",
    ),
  ]);
  if (balance === 0) {
    throw new Error("local deployment wallet has zero SOL");
  }

  const actions = [];
  for (const [index, artifact] of artifacts.entries()) {
    const existing = accountInfos[index];
    if (existing?.executable) {
      const current = showProgram(artifact.address, walletCliPath);
      if (current.authority !== wallet) {
        throw new Error(
          `${artifact.name}: upgrade authority ${current.authority ?? "none"} != ${wallet}`,
        );
      }
      actions.push({
        name: artifact.name,
        address: artifact.address,
        action: "skip-existing",
        authority: current.authority,
        sha256: artifact.sha256,
      });
      process.stderr.write(
        `[${index + 1}/${artifacts.length}] ${artifact.name}: already deployed\n`,
      );
      continue;
    }
    if (existing) {
      throw new Error(
        `${artifact.name}: configured address exists but is not executable`,
      );
    }

    process.stderr.write(
      `[${index + 1}/${artifacts.length}] ${artifact.name}: deploying\n`,
    );
    const deployed = parseJson(
      runSolana([
        "program",
        "deploy",
        artifact.binaryCliPath,
        "--program-id",
        artifact.keypairCliPath,
        "--upgrade-authority",
        walletCliPath,
        "--fee-payer",
        walletCliPath,
        "--keypair",
        walletCliPath,
        "--url",
        rpcUrl,
        "--commitment",
        "confirmed",
        "--use-rpc",
        "--output",
        "json",
      ]),
      `program deploy ${artifact.name}`,
    );
    if (deployed.programId !== artifact.address) {
      throw new Error(
        `${artifact.name}: deployed ${deployed.programId} instead of ${artifact.address}`,
      );
    }
    const verified = showProgram(artifact.address, walletCliPath);
    if (verified.authority !== wallet) {
      throw new Error(
        `${artifact.name}: post-deploy authority ${verified.authority ?? "none"} != ${wallet}`,
      );
    }
    actions.push({
      name: artifact.name,
      address: artifact.address,
      action: "deployed",
      authority: verified.authority,
      signature: deployed.signature ?? null,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    });
  }

  const finalBalance = await connection.getBalance(keypair.publicKey, "confirmed");
  const report = {
    generatedAt: new Date().toISOString(),
    cluster: "localnet",
    rpcUrl,
    genesisHash,
    wallet,
    walletBalanceBeforeLamports: balance,
    walletBalanceAfterLamports: finalBalance,
    productionProgramCount: artifacts.length,
    actions,
  };

  const reportsDir = localDir;
  mkdirSync(reportsDir, { recursive: true });
  const stamp = report.generatedAt.replaceAll(":", "").replaceAll(".", "");
  const reportPath = resolve(
    reportsDir,
    `localnet-production-deploy-${stamp}.json`,
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
    })}\n`,
  );
  process.exitCode = 1;
});
