#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolDir = dirname(fileURLToPath(import.meta.url));
const solanaRoot = resolve(toolDir, "../..");
const stateRoot = resolve(
  process.env.COMPACT_V2_LOCAL_STATE_DIR ?? resolve(solanaRoot, ".local/compact-v2"),
);
const rpcUrl = process.env.SOLANA_LOCAL_RPC_URL ?? "http://127.0.0.1:8899";
const statePath = resolve(stateRoot, "state.json");
const buildPath = resolve(stateRoot, "build-report.json");
const configPath = resolve(stateRoot, "solana-cli.yml");

function assertLoopback(value) {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`Compact deployment refuses non-loopback RPC ${url.origin}`);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: solanaRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ""} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

function json(command, args) {
  return JSON.parse(run(command, args));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function cliPath(path) {
  return relative(solanaRoot, path);
}

assertLoopback(rpcUrl);
if (process.env.COMPACT_V2_LOCAL_DEPLOY_CONFIRM !== "LOCALNET_COMPACT_V2_10") {
  throw new Error(
    "deployment requires COMPACT_V2_LOCAL_DEPLOY_CONFIRM=LOCALNET_COMPACT_V2_10",
  );
}
const state = JSON.parse(readFileSync(statePath, "utf8"));
const build = JSON.parse(readFileSync(buildPath, "utf8"));
if (build.programCount !== 10) throw new Error("expected 10 built programs");

if (!existsSync(state.walletPath)) {
  run("solana-keygen", [
    "new",
    "--no-bip39-passphrase",
    "--silent",
    "--outfile",
    cliPath(state.walletPath),
  ]);
}
const wallet = run("solana-keygen", ["pubkey", cliPath(state.walletPath)]);
run("solana", [
  "config",
  "set",
  "--config",
  cliPath(configPath),
  "--keypair",
  cliPath(state.walletPath),
  "--url",
  rpcUrl,
]);
const solana = (args) => run("solana", ["--config", cliPath(configPath), ...args]);
const solanaJson = (args) => JSON.parse(solana(args));
let balance = Number(
  solana(["balance", wallet, "--lamports"]).split(/\s+/)[0],
);
if (balance < 100_000_000_000) {
  solana([
    "airdrop",
    "100",
    wallet,
    "--commitment",
    "confirmed",
  ]);
  balance = Number(
    solana(["balance", wallet, "--lamports"]).split(/\s+/)[0],
  );
}

const dumpsDir = resolve(stateRoot, "onchain-dumps");
mkdirSync(dumpsDir, { recursive: true });
const actions = [];
for (const [index, artifact] of build.artifacts.entries()) {
  process.stderr.write(
    `[${index + 1}/${build.artifacts.length}] deploying ${artifact.targetName}\n`,
  );
  const result = solanaJson([
    "program",
    "deploy",
    cliPath(artifact.binaryPath),
    "--program-id",
    cliPath(artifact.keypairPath),
    "--upgrade-authority",
    cliPath(state.walletPath),
    "--fee-payer",
    cliPath(state.walletPath),
    "--keypair",
    cliPath(state.walletPath),
    "--commitment",
    "confirmed",
    "--use-rpc",
    "--output",
    "json",
  ]);
  if (result.programId !== artifact.address) {
    throw new Error(`${artifact.targetName}: deployed unexpected Program ID`);
  }
  const shown = solanaJson([
    "program",
    "show",
    artifact.address,
    "--output",
    "json",
  ]);
  if (shown.authority !== wallet) {
    throw new Error(`${artifact.targetName}: unexpected upgrade authority`);
  }
  const dumpPath = resolve(dumpsDir, `${artifact.targetName}.so`);
  solana([
    "program",
    "dump",
    artifact.address,
    cliPath(dumpPath),
  ]);
  const dumpHash = sha256(dumpPath);
  if (dumpHash !== artifact.sha256) {
    throw new Error(`${artifact.targetName}: on-chain dump hash mismatch`);
  }
  actions.push({
    targetName: artifact.targetName,
    address: artifact.address,
    signature: result.signature ?? null,
    programdataAddress: shown.programdataAddress,
    authority: shown.authority,
    lastDeploySlot: shown.lastDeploySlot,
    bytes: statSync(dumpPath).size,
    sha256: dumpHash,
  });
}

const finalBalance = Number(
  solana(["balance", wallet, "--lamports"]).split(/\s+/)[0],
);
const report = {
  deployedAt: new Date().toISOString(),
  scope: "loopback-localnet-only",
  rpcUrl,
  genesisHash: solana(["genesis-hash"]),
  wallet,
  walletBalanceBeforeLamports: balance,
  walletBalanceAfterLamports: finalBalance,
  spentLamports: balance - finalBalance,
  actions,
};
const reportPath = resolve(stateRoot, "deployment-report.json");
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
