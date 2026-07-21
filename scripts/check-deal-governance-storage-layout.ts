import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type BaselineEntry = {
  label: string;
  slot: string;
  offset: number;
  typeLabel: string;
};

type Baseline = {
  contract: string;
  storage: BaselineEntry[];
  proposal: BaselineEntry[];
};

type ForgeType = {
  label: string;
  members?: Array<{ label: string; slot: string; offset: number; type: string }>;
};

type ForgeLayout = {
  storage: Array<{ label: string; slot: string; offset: number; type: string }>;
  types: Record<string, ForgeType>;
};

export type StorageLayoutCheck = {
  v1FieldCount: number;
  v2FieldCount: number;
  appendedField: BaselineEntry;
};

function semanticEntry(
  entry: { label: string; slot: string; offset: number; type: string },
  types: ForgeLayout["types"],
): BaselineEntry {
  const type = types[entry.type];
  if (!type) throw new Error(`Missing compiler type metadata for ${entry.label}: ${entry.type}`);
  return { label: entry.label, slot: entry.slot, offset: entry.offset, typeLabel: type.label };
}

function assertEntry(actual: BaselineEntry, expected: BaselineEntry, context: string): void {
  for (const key of ["label", "slot", "offset", "typeLabel"] as const) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `${context} changed at ${expected.label}.${key}: expected ${expected[key]}, got ${actual[key]}`,
      );
    }
  }
}

export function assertDealGovernanceStorageLayout(cwd = process.cwd()): StorageLayoutCheck {
  const baselinePath = join(cwd, "storage-layout", "DealGovernance.v1.json");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
  const stdout = execFileSync("forge", ["inspect", "DealGovernance", "storage-layout", "--json"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const layout = JSON.parse(stdout) as ForgeLayout;
  const actualStorage = layout.storage.map((entry) => semanticEntry(entry, layout.types));

  if (actualStorage.length !== baseline.storage.length + 1) {
    throw new Error(
      `DealGovernance V2 must append exactly one field: expected ${baseline.storage.length + 1}, got ${actualStorage.length}`,
    );
  }
  baseline.storage.forEach((expected, index) => {
    assertEntry(actualStorage[index], expected, `DealGovernance storage slot ${index}`);
  });

  const appended = actualStorage.at(-1)!;
  const expectedAppend: BaselineEntry = {
    label: "policyRegistry",
    slot: "29",
    offset: 0,
    typeLabel: "contract IGovernancePolicyRegistryGov",
  };
  assertEntry(appended, expectedAppend, "DealGovernance V2 append");

  const proposalType = Object.values(layout.types).find(
    (type) => type.label === "struct DealGovernance.Proposal",
  );
  if (!proposalType?.members) throw new Error("DealGovernance.Proposal storage metadata missing");
  if (proposalType.members.length !== baseline.proposal.length) {
    throw new Error("DealGovernance.Proposal field count changed");
  }
  const actualProposal = proposalType.members.map((entry) => semanticEntry(entry, layout.types));
  baseline.proposal.forEach((expected, index) => {
    assertEntry(actualProposal[index], expected, `DealGovernance.Proposal field ${index}`);
  });

  return {
    v1FieldCount: baseline.storage.length,
    v2FieldCount: actualStorage.length,
    appendedField: appended,
  };
}

if (process.argv[1]?.endsWith("check-deal-governance-storage-layout.ts")) {
  const result = assertDealGovernanceStorageLayout();
  console.log(
    `DealGovernance storage layout OK: ${result.v1FieldCount} preserved fields; ${result.appendedField.label} appended at slot ${result.appendedField.slot}.`,
  );
}
