import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDevnetPrograms } from "../../sdk/devnet-preflight.mjs";

const toolDir = dirname(fileURLToPath(import.meta.url));
const compactDir = resolve(toolDir, "..");
const solanaDir = resolve(compactDir, "..");
const layout = JSON.parse(readFileSync(resolve(compactDir, "layout.json"), "utf8"));

function fail(message) {
  throw new Error(message);
}

function rentForDataLength(dataLength, model) {
  return BigInt(dataLength + model.accountStorageOverheadBytes) *
    BigInt(model.lamportsPerByte);
}

function persistentProgramRent(binaryBytes, model) {
  return (
    rentForDataLength(model.programAccountBytes, model) +
    rentForDataLength(binaryBytes + model.programDataMetadataBytes, model)
  );
}

function bufferRent(binaryBytes, model) {
  return rentForDataLength(binaryBytes + model.bufferMetadataBytes, model);
}

function toSol(lamports) {
  return Number(lamports) / 1_000_000_000;
}

const production = parseDevnetPrograms().map((program) => ({
  ...program,
  bytes: statSync(resolve(solanaDir, "target", "deploy", `${program.name}.so`)).size,
}));
if (production.length !== layout.legacyProductionProgramCount) {
  fail(
    `layout expects ${layout.legacyProductionProgramCount} legacy programs, found ${production.length}`,
  );
}

const productionByName = new Map(production.map((program) => [program.name, program]));
const assignments = new Map();
for (const cluster of layout.clusters) {
  if (cluster.estimatedMinBytes > cluster.estimatedMaxBytes) {
    fail(`${cluster.id}: min estimate exceeds max estimate`);
  }
  for (const name of cluster.legacyPrograms) {
    if (!productionByName.has(name)) fail(`${cluster.id}: unknown production program ${name}`);
    if (assignments.has(name)) {
      fail(`${name} is assigned to both ${assignments.get(name)} and ${cluster.id}`);
    }
    assignments.set(name, cluster.id);
  }
}
for (const { name } of production) {
  if (!assignments.has(name)) fail(`${name} is not assigned to a compact cluster`);
}
if (layout.clusters.length !== layout.targetProgramCount) {
  fail(`target count ${layout.targetProgramCount} does not match ${layout.clusters.length} clusters`);
}

const model = layout.rentModel;
const currentBytes = production.reduce((sum, program) => sum + program.bytes, 0);
const currentPersistent = production.reduce(
  (sum, program) => sum + persistentProgramRent(program.bytes, model),
  0n,
);
const currentLargest = Math.max(...production.map(({ bytes }) => bytes));
const currentRecommended =
  currentPersistent +
  bufferRent(currentLargest, model) +
  BigInt(model.feeAndRetryHeadroomLamports);

const measuredReplacedPrograms = new Set();
const measuredCompactPrograms = [];
for (const cluster of layout.clusters) {
  const measured = cluster.measuredPrototype;
  if (!measured) continue;
  const measuredLegacyBytes = measured.legacyPrograms.reduce((sum, name) => {
    if (!productionByName.has(name)) fail(`${cluster.id}: measured unknown program ${name}`);
    if (!cluster.legacyPrograms.includes(name)) {
      fail(`${cluster.id}: measured program ${name} is outside its cluster`);
    }
    if (measuredReplacedPrograms.has(name)) fail(`${name} has multiple measured replacements`);
    measuredReplacedPrograms.add(name);
    return sum + productionByName.get(name).bytes;
  }, 0);
  if (measuredLegacyBytes !== measured.legacyBytes) {
    fail(
      `${cluster.id}: measured legacy bytes ${measured.legacyBytes} do not match current ${measuredLegacyBytes}`,
    );
  }
  if (measured.legacyBytes - measured.compactBytes !== measured.savedBytes) {
    fail(`${cluster.id}: measured savedBytes is inconsistent`);
  }
  measuredCompactPrograms.push({ cluster: cluster.id, bytes: measured.compactBytes });
}
const measuredRemainingPrograms = production.filter(
  ({ name }) => !measuredReplacedPrograms.has(name),
);
const measuredSizes = [
  ...measuredRemainingPrograms.map(({ bytes }) => bytes),
  ...measuredCompactPrograms.map(({ bytes }) => bytes),
];
const measuredBytes = measuredSizes.reduce((sum, bytes) => sum + bytes, 0);
const measuredPersistent = measuredSizes.reduce(
  (sum, bytes) => sum + persistentProgramRent(bytes, model),
  0n,
);
const measuredLargest = Math.max(...measuredSizes);
const measuredRecommended =
  measuredPersistent +
  bufferRent(measuredLargest, model) +
  BigInt(model.feeAndRetryHeadroomLamports);

function targetScenario(field) {
  const sizes = layout.clusters.map((cluster) => cluster[field]);
  const bytes = sizes.reduce((sum, size) => sum + size, 0);
  const persistent = sizes.reduce(
    (sum, size) => sum + persistentProgramRent(size, model),
    0n,
  );
  const largest = Math.max(...sizes);
  const recommended =
    persistent + bufferRent(largest, model) + BigInt(model.feeAndRetryHeadroomLamports);
  return { bytes, persistent, largest, recommended };
}

const best = targetScenario("estimatedMinBytes");
const conservative = targetScenario("estimatedMaxBytes");
const rows = layout.clusters.map((cluster) => ({
  id: cluster.id,
  legacyPrograms: cluster.legacyPrograms.length,
  currentBytes: cluster.legacyPrograms.reduce(
    (sum, name) => sum + productionByName.get(name).bytes,
    0,
  ),
  estimatedMinBytes: cluster.estimatedMinBytes,
  estimatedMaxBytes: cluster.estimatedMaxBytes,
  implementationStatus: cluster.implementationStatus,
}));

const generatedDeployDir = resolve(compactDir, "generated", "target", "deploy");
const generatedSizes = [];
for (const cluster of layout.clusters) {
  const binary = resolve(generatedDeployDir, `${cluster.targetName}.so`);
  if (!existsSync(binary)) continue;
  const bytes = statSync(binary).size;
  if (cluster.measuredBytes !== undefined && cluster.measuredBytes !== bytes) {
    fail(
      `${cluster.id}: measuredBytes ${cluster.measuredBytes} does not match built binary ${bytes}`,
    );
  }
  generatedSizes.push({ cluster: cluster.id, targetName: cluster.targetName, bytes });
}

let completedImplementation = null;
if (generatedSizes.length === layout.targetProgramCount) {
  const sizes = generatedSizes.map(({ bytes }) => bytes);
  const bytes = sizes.reduce((sum, value) => sum + value, 0);
  const persistent = sizes.reduce(
    (sum, value) => sum + persistentProgramRent(value, model),
    0n,
  );
  const largest = Math.max(...sizes);
  const recommended =
    persistent + bufferRent(largest, model) + BigInt(model.feeAndRetryHeadroomLamports);
  completedImplementation = {
    note: "local generated SBF only; no Devnet/Mainnet deployment and not a production release approval",
    programs: generatedSizes,
    bytes,
    savedBytes: currentBytes - bytes,
    savedBytesPercent: ((currentBytes - bytes) / currentBytes) * 100,
    persistentRentSol: toSol(persistent),
    persistentRentSavingsSol: toSol(currentPersistent - persistent),
    largestProgramBytes: largest,
    recommendedWalletSol: toSol(recommended),
    recommendedWalletSavingsSol: toSol(currentRecommended - recommended),
  };
}

const report = {
  valid: true,
  layout: layout.name,
  legacyProgramCount: production.length,
  targetProgramCount: layout.clusters.length,
  allLegacyProgramsAssignedExactlyOnce: assignments.size === production.length,
  current: {
    bytes: currentBytes,
    persistentRentSol: toSol(currentPersistent),
    largestProgramBytes: currentLargest,
    recommendedWalletSol: toSol(currentRecommended),
  },
  measuredProgress: {
    note: "measured compact components only; not a deployment candidate",
    replacedLegacyPrograms: measuredReplacedPrograms.size,
    compactPrograms: measuredCompactPrograms.length,
    resultingProgramCount: measuredSizes.length,
    bytes: measuredBytes,
    savedBytes: currentBytes - measuredBytes,
    persistentRentSol: toSol(measuredPersistent),
    persistentRentSavingsSol: toSol(currentPersistent - measuredPersistent),
    largestProgramBytes: measuredLargest,
    recommendedWalletSol: toSol(measuredRecommended),
    recommendedWalletSavingsSol: toSol(currentRecommended - measuredRecommended),
  },
  completedImplementation,
  targetRange: {
    bytes: [best.bytes, conservative.bytes],
    persistentRentSol: [toSol(best.persistent), toSol(conservative.persistent)],
    largestProgramBytes: [best.largest, conservative.largest],
    recommendedWalletSol: [toSol(best.recommended), toSol(conservative.recommended)],
    recommendedWalletSavingsSol: [
      toSol(currentRecommended - conservative.recommended),
      toSol(currentRecommended - best.recommended),
    ],
  },
  clusters: rows,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
