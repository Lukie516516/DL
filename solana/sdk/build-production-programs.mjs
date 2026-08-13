import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair } from "@solana/web3.js";

import { parseDevnetPrograms } from "./devnet-preflight.mjs";

const sdkDir = dirname(fileURLToPath(import.meta.url));
const solanaDir = resolve(sdkDir, "..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: solanaDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    throw new Error(
      `${command} ${args[0] ?? ""} failed (${result.status}):\n${output.slice(-8_000)}`,
    );
  }
  return result.stdout.trim();
}

function validateSbf(path, name) {
  const binary = readFileSync(path);
  if (binary.length < 10_000) {
    throw new Error(`${name}: suspicious ${binary.length}-byte artifact`);
  }
  if (
    binary[0] !== 0x7f ||
    binary[1] !== 0x45 ||
    binary[2] !== 0x4c ||
    binary[3] !== 0x46
  ) {
    throw new Error(`${name}: artifact is not ELF`);
  }
  if (binary.readUInt16LE(18) !== 0x107) {
    throw new Error(`${name}: artifact is not Solana SBF`);
  }
  if (binary.readBigUInt64LE(24) === 0n) {
    throw new Error(`${name}: artifact has no executable entrypoint`);
  }
  return {
    bytes: binary.length,
    sha256: sha256(binary),
  };
}

function buildVariant(program, outputDirectory, optimizeSize) {
  const manifest = resolve(
    solanaDir,
    "programs",
    program.name.replaceAll("_", "-"),
    "Cargo.toml",
  );
  const args = [
    "build-sbf",
    "--manifest-path",
    manifest,
    "--sbf-out-dir",
    outputDirectory,
    "--offline",
  ];
  if (optimizeSize) args.push("--optimize-size");
  run("cargo", args);
  const artifact = resolve(outputDirectory, `${program.name}.so`);
  return { artifact, ...validateSbf(artifact, program.name) };
}

function validateIdentity(program) {
  const keypairPath = resolve(
    solanaDir,
    "target",
    "deploy",
    `${program.name}-keypair.json`,
  );
  if ((statSync(keypairPath).mode & 0o077) !== 0) {
    throw new Error(`${program.name}: Program ID keypair is not private`);
  }
  const keypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))),
  );
  if (keypair.publicKey.toBase58() !== program.address) {
    throw new Error(`${program.name}: Program ID keypair mismatch`);
  }
  const idlPath = resolve(
    solanaDir,
    "target",
    "idl",
    `${program.name}.json`,
  );
  const idlBytes = readFileSync(idlPath);
  const idl = JSON.parse(idlBytes);
  if (idl.address !== program.address) {
    throw new Error(`${program.name}: IDL address mismatch`);
  }
  return { keypairPath, idlPath, idlSha256: sha256(idlBytes) };
}

function main() {
  const programs = parseDevnetPrograms();
  if (programs.length !== 24) {
    throw new Error(`expected 24 production programs, got ${programs.length}`);
  }
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "deal-production-sbf-"),
  );
  const defaultDirectory = resolve(temporaryDirectory, "default");
  const sizeDirectory = resolve(temporaryDirectory, "size");
  mkdirSync(defaultDirectory);
  mkdirSync(sizeDirectory);

  const results = [];
  for (const [index, program] of programs.entries()) {
    const identity = validateIdentity(program);
    const defaultBuild = buildVariant(program, defaultDirectory, false);
    const sizeBuild = buildVariant(program, sizeDirectory, true);
    const selected =
      sizeBuild.bytes < defaultBuild.bytes ? sizeBuild : defaultBuild;
    const mode = selected === sizeBuild ? "optimize-size" : "default";
    const destination = resolve(
      solanaDir,
      "target",
      "deploy",
      `${program.name}.so`,
    );
    copyFileSync(selected.artifact, destination);
    const verified = validateSbf(destination, program.name);
    if (verified.sha256 !== selected.sha256) {
      throw new Error(`${program.name}: copied artifact hash mismatch`);
    }
    const row = {
      ...program,
      mode,
      defaultBytes: defaultBuild.bytes,
      optimizeSizeBytes: sizeBuild.bytes,
      selectedBytes: selected.bytes,
      savedBytes: defaultBuild.bytes - selected.bytes,
      selectedSha256: selected.sha256,
      idlSha256: identity.idlSha256,
    };
    results.push(row);
    process.stdout.write(
      `${index + 1}/24 ${program.name}: ${row.defaultBytes} -> ${row.selectedBytes} (${mode})\n`,
    );
  }

  const defaultBytes = results.reduce(
    (total, item) => total + item.defaultBytes,
    0,
  );
  const selectedBytes = results.reduce(
    (total, item) => total + item.selectedBytes,
    0,
  );
  const report = {
    generatedAt: new Date().toISOString(),
    productionProgramCount: programs.length,
    buildStrategy:
      "each program built independently; select the smaller valid default/--optimize-size SBF artifact",
    workspaceBuildForbidden:
      "cargo build-sbf --workspace may emit no-entrypoint dependency stubs",
    sourceChanged: false,
    instructionAbiChanged: false,
    accountLayoutChanged: false,
    defaultBytes,
    selectedBytes,
    savedBytes: defaultBytes - selectedBytes,
    savedPercent: Number(
      (((defaultBytes - selectedBytes) * 100) / defaultBytes).toFixed(2),
    ),
    temporaryDirectory,
    cargoBuildSbfVersion: run("cargo", ["build-sbf", "--version"]),
    programs: results,
  };
  const stamp = report.generatedAt.replaceAll(":", "").replaceAll(".", "");
  const reportDirectory = resolve(solanaDir, ".local");
  mkdirSync(reportDirectory, { recursive: true });
  const reportPath = resolve(
    reportDirectory,
    `production-size-build-${stamp}.json`,
  );
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
}
