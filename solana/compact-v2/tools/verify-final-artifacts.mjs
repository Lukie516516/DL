#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const compactDir = path.resolve(toolDir, "..");
const generatedDir = path.resolve(compactDir, "generated");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const manifest = readJson(path.resolve(compactDir, "final-sbf-manifest.json"));
const router = readJson(path.resolve(generatedDir, "router-manifest.json"));
const equivalence = readJson(path.resolve(generatedDir, "source-equivalence.json"));

const inputFiles = {
  cargoLockSha256: path.resolve(generatedDir, "Cargo.lock"),
  sourceEquivalenceSha256: path.resolve(generatedDir, "source-equivalence.json"),
  routerManifestSha256: path.resolve(generatedDir, "router-manifest.json"),
  generatorSha256: path.resolve(toolDir, "generate-composed-programs.mjs"),
  layoutSha256: path.resolve(compactDir, "layout.json"),
};
for (const [field, file] of Object.entries(inputFiles)) {
  assert(sha256(file) === manifest.inputs[field], `${field} hash mismatch`);
}

let totalBytes = 0;
for (const program of manifest.programs) {
  const binary = path.resolve(generatedDir, "target", "deploy", `${program.name}.so`);
  assert(fs.existsSync(binary), `missing ${program.name}.so`);
  const bytes = fs.statSync(binary).size;
  assert(bytes === program.bytes, `${program.name} byte size mismatch`);
  assert(sha256(binary) === program.sha256, `${program.name} SHA-256 mismatch`);
  totalBytes += bytes;
}
assert(manifest.programs.length === manifest.totals.programCount, "program count mismatch");
assert(totalBytes === manifest.totals.bytes, "total byte size mismatch");

const modules = new Set(router.groups.flatMap((group) => group.modules.map((item) => item.moduleName)));
const rawRoutes = router.groups.flatMap((group) => group.rawRoutes);
const prefixedOnly = router.groups.flatMap((group) => group.prefixedOnly);
const variableRoutes = rawRoutes.filter((route) => route.acceptsRemainingAccounts);
const pdaSelected = rawRoutes.filter((route) => route.pdaSelector);

assert(router.groups.length === 10, "router root count is not 10");
assert(modules.size === 24, "router module count is not 24");
assert(rawRoutes.length === 249, "legacy raw route count is not 249");
assert(prefixedOnly.length === 0, "some legacy routes require the DLV2 prefix");
assert(variableRoutes.length === 1, "unexpected variable-account route count");
assert(
  variableRoutes[0].moduleName === "deal_governance_executor" &&
    variableRoutes[0].instruction === "execute_message" &&
    variableRoutes[0].accountCount === 5,
  "unexpected variable-account route",
);

const plumbingEdits = equivalence.files.reduce(
  (sum, file) =>
    sum + file.compactPlumbingChanges.reduce((inner, change) => inner + change.count, 0),
  0,
);
assert(equivalence.files.length === 32, "source-equivalence file count is not 32");
assert(plumbingEdits === 28, "compact plumbing edit count is not 28");

process.stdout.write(
  `${JSON.stringify(
    {
      valid: true,
      programs: manifest.programs.length,
      bytes: totalBytes,
      roots: router.groups.length,
      modules: modules.size,
      rawRoutes: rawRoutes.length,
      prefixedOnly: prefixedOnly.length,
      pdaSelectedRoutes: pdaSelected.length,
      variableRoutes: variableRoutes.map(({ moduleName, instruction, accountCount }) => ({
        moduleName,
        instruction,
        accountCount,
      })),
      sourceFiles: equivalence.files.length,
      compactPlumbingEdits: plumbingEdits,
    },
    null,
    2,
  )}\n`,
);
