import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Entry = { label: string; slot: string; offset: number; typeLabel: string };
type Baseline = {
  SatoshiVault: { storage: Entry[] };
  DealDividendVault: { storage: Entry[]; round: Entry[] };
};
type ForgeType = {
  label: string;
  members?: Array<{ label: string; slot: string; offset: number; type: string }>;
};
type ForgeLayout = {
  storage: Array<{ label: string; slot: string; offset: number; type: string }>;
  types: Record<string, ForgeType>;
};

function inspect(cwd: string, contract: string): ForgeLayout {
  return JSON.parse(
    execFileSync("forge", ["inspect", contract, "storage-layout", "--json"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ) as ForgeLayout;
}

function semantic(
  entry: { label: string; slot: string; offset: number; type: string },
  types: ForgeLayout["types"],
): Entry {
  const type = types[entry.type];
  if (!type) throw new Error(`Missing storage type metadata for ${entry.label}`);
  return { label: entry.label, slot: entry.slot, offset: entry.offset, typeLabel: type.label };
}

function assertEntries(label: string, actual: Entry[], expected: Entry[]): void {
  if (actual.length !== expected.length) {
    throw new Error(`${label} field count changed: expected ${expected.length}, got ${actual.length}`);
  }
  expected.forEach((wanted, index) => {
    const got = actual[index];
    for (const key of ["label", "slot", "offset", "typeLabel"] as const) {
      if (got[key] !== wanted[key]) {
        throw new Error(
          `${label}[${index}].${key} changed: expected ${wanted[key]}, got ${got[key]}`,
        );
      }
    }
  });
}

export function assertDaoTreasuryModuleStorageLayout(cwd = process.cwd()) {
  const baseline = JSON.parse(
    readFileSync(join(cwd, "storage-layout", "DaoTreasuryModules.v1.json"), "utf8"),
  ) as Baseline;
  const satoshi = inspect(cwd, "SatoshiVault");
  const dividend = inspect(cwd, "DealDividendVault");
  assertEntries(
    "SatoshiVault storage",
    satoshi.storage.map((entry) => semantic(entry, satoshi.types)),
    baseline.SatoshiVault.storage,
  );
  assertEntries(
    "DealDividendVault storage",
    dividend.storage.map((entry) => semantic(entry, dividend.types)),
    baseline.DealDividendVault.storage,
  );
  const roundType = Object.values(dividend.types).find(
    (type) => type.label === "struct DealDividendVault.Round",
  );
  if (!roundType?.members) throw new Error("DealDividendVault.Round metadata missing");
  assertEntries(
    "DealDividendVault.Round",
    roundType.members.map((entry) => semantic(entry, dividend.types)),
    baseline.DealDividendVault.round,
  );

  for (const [mockName, baseLayout] of [
    ["SatoshiVaultUpgradeMock", satoshi],
    ["DealDividendVaultUpgradeMock", dividend],
  ] as const) {
    const mock = inspect(cwd, mockName);
    assertEntries(
      `${mockName} inherited storage`,
      mock.storage.map((entry) => semantic(entry, mock.types)),
      baseLayout.storage.map((entry) => semantic(entry, baseLayout.types)),
    );
  }
  return {
    satoshiFields: satoshi.storage.length,
    dividendFields: dividend.storage.length,
    roundFields: roundType.members.length,
  };
}

if (process.argv[1]?.endsWith("check-dao-treasury-module-storage-layout.ts")) {
  const result = assertDaoTreasuryModuleStorageLayout();
  console.log(
    `DAO treasury module storage layouts OK: SatoshiVault=${result.satoshiFields}, ` +
      `DealDividendVault=${result.dividendFields}, Round=${result.roundFields}.`,
  );
}
