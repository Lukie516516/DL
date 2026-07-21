import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const EIP170_RUNTIME_LIMIT = 24_576;
const EIP3860_INITCODE_LIMIT = 49_152;

type SizeRow = {
  contractName: string;
  artifact: string;
  creationBytes: number;
  runtimeBytes: number;
};

export type ContractSizeCheck = {
  checked: number;
  largestRuntime: SizeRow;
  rows: SizeRow[];
};

function byteLength(hex: string): number {
  return hex === "0x" ? 0 : (hex.length - 2) / 2;
}

export function assertContractSizes(cwd = process.cwd()): ContractSizeCheck {
  const artifactsRoot = join(cwd, "artifacts", "contracts");
  const rows: SizeRow[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!name.endsWith(".json") || name.endsWith(".dbg.json")) continue;
      const artifact = JSON.parse(readFileSync(path, "utf8")) as {
        contractName?: string;
        bytecode?: string;
        deployedBytecode?: string;
      };
      if (!artifact.contractName || !artifact.bytecode || !artifact.deployedBytecode) continue;
      rows.push({
        contractName: artifact.contractName,
        artifact: relative(cwd, path),
        creationBytes: byteLength(artifact.bytecode),
        runtimeBytes: byteLength(artifact.deployedBytecode),
      });
    }
  };
  walk(artifactsRoot);
  rows.sort((a, b) => b.runtimeBytes - a.runtimeBytes);
  const violations = rows.filter(
    (row) => row.runtimeBytes > EIP170_RUNTIME_LIMIT || row.creationBytes > EIP3860_INITCODE_LIMIT,
  );
  if (violations.length > 0) {
    throw new Error(
      `Contract size limit exceeded:\n${violations
        .map(
          (row) =>
            `${row.contractName}: runtime=${row.runtimeBytes}/${EIP170_RUNTIME_LIMIT}, ` +
            `creation=${row.creationBytes}/${EIP3860_INITCODE_LIMIT}`,
        )
        .join("\n")}`,
    );
  }
  if (rows.length === 0) throw new Error("No compiled contract artifacts found for size check");
  return { checked: rows.length, largestRuntime: rows[0], rows };
}

if (process.argv[1]?.endsWith("check-contract-sizes.ts")) {
  const result = assertContractSizes();
  for (const row of result.rows.slice(0, 20)) {
    console.log(
      `${row.contractName}: runtime=${row.runtimeBytes} bytes, creation=${row.creationBytes} bytes`,
    );
  }
  console.log(
    `Contract sizes OK: ${result.checked} artifacts; EIP-170 runtime and EIP-3860 initcode limits respected.`,
  );
}
