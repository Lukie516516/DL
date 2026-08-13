#!/usr/bin/env node

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

const toolDir = dirname(fileURLToPath(import.meta.url));
const compactRoot = resolve(toolDir, "..");
const solanaRoot = resolve(compactRoot, "..");
const stateRoot = resolve(
  process.env.COMPACT_V2_LOCAL_STATE_DIR ?? resolve(solanaRoot, ".local/compact-v2"),
);
const keysDir = resolve(stateRoot, "program-keys");
const generatedRoot = resolve(stateRoot, "generated");
const deployDir = resolve(generatedRoot, "target/deploy");
const layoutPath = resolve(stateRoot, "layout.localnet.json");
const statePath = resolve(stateRoot, "state.json");
const canonicalLayoutPath = resolve(compactRoot, "layout.json");
const generatorPath = resolve(toolDir, "generate-composed-programs.mjs");

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: solanaRoot,
    env,
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

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ensureKeypair(path) {
  const cliPath = relative(solanaRoot, path);
  if (!existsSync(path)) {
    run("solana-keygen", [
      "new",
      "--no-bip39-passphrase",
      "--silent",
      "--outfile",
      cliPath,
    ]);
  }
  return run("solana-keygen", ["pubkey", cliPath]);
}

mkdirSync(keysDir, { recursive: true });
mkdirSync(deployDir, { recursive: true });

const canonical = JSON.parse(readFileSync(canonicalLayoutPath, "utf8"));
if (!Array.isArray(canonical.clusters) || canonical.clusters.length !== 10) {
  throw new Error("canonical Compact V2 layout must contain 10 roots");
}

const local = structuredClone(canonical);
local.status = "isolated-localnet-only";
const programs = [];
for (const cluster of local.clusters) {
  const keypairPath = resolve(keysDir, `${cluster.targetName}-keypair.json`);
  const address = ensureKeypair(keypairPath);
  cluster.testProgramId = address;
  cluster.implementationStatus = "localnet-key-generated-not-deployed";
  programs.push({
    id: cluster.id,
    targetName: cluster.targetName,
    address,
    keypairPath,
    legacyPrograms: cluster.legacyPrograms,
  });
}

writeFileSync(layoutPath, `${JSON.stringify(local, null, 2)}\n`, { mode: 0o600 });
run("node", [generatorPath], {
  ...process.env,
  COMPACT_V2_LAYOUT_PATH: layoutPath,
  COMPACT_V2_GENERATED_ROOT: generatedRoot,
});

const state = {
  schemaVersion: 1,
  preparedAt: new Date().toISOString(),
  scope: "loopback-localnet-only",
  canonicalLayoutPath,
  canonicalLayoutSha256: sha256(canonicalLayoutPath),
  localLayoutPath: layoutPath,
  generatedRoot,
  deployDir,
  walletPath: resolve(stateRoot, "wallet.json"),
  ledgerDir: resolve(stateRoot, "ledger"),
  programs,
};
writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ...state, statePath }, null, 2)}\n`);
