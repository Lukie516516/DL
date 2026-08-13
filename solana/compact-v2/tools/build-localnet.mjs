#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolDir = dirname(fileURLToPath(import.meta.url));
const solanaRoot = resolve(toolDir, "../..");
const stateRoot = resolve(
  process.env.COMPACT_V2_LOCAL_STATE_DIR ?? resolve(solanaRoot, ".local/compact-v2"),
);
const statePath = resolve(stateRoot, "state.json");
const state = JSON.parse(readFileSync(statePath, "utf8"));

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: state.generatedRoot,
    env: process.env,
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

const artifacts = [];
for (const [index, program] of state.programs.entries()) {
  const manifest = resolve(
    state.generatedRoot,
    `programs/${program.targetName.replaceAll("_", "-")}/Cargo.toml`,
  );
  process.stderr.write(
    `[${index + 1}/${state.programs.length}] building ${program.targetName}\n`,
  );
  run("cargo", [
    "build-sbf",
    "--manifest-path",
    manifest,
    "--sbf-out-dir",
    state.deployDir,
  ]);
  const binaryPath = resolve(state.deployDir, `${program.targetName}.so`);
  artifacts.push({
    ...program,
    binaryPath,
    bytes: statSync(binaryPath).size,
    sha256: createHash("sha256").update(readFileSync(binaryPath)).digest("hex"),
  });
}

const report = {
  builtAt: new Date().toISOString(),
  programCount: artifacts.length,
  totalBytes: artifacts.reduce((sum, item) => sum + item.bytes, 0),
  artifacts,
};
const reportPath = resolve(stateRoot, "build-report.json");
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
