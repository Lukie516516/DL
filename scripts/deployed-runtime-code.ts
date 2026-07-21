import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAddress, keccak256, padHex, type Address, type Hex } from "viem";

type ImmutableReference = { length: number; start: number };
type RuntimeArtifact = {
  deployedBytecode: Hex;
  immutableReferences?: Record<string, ImmutableReference[]>;
};

function loadArtifact(cwd: string, artifactPath: string): RuntimeArtifact {
  return JSON.parse(readFileSync(join(cwd, artifactPath), "utf8")) as RuntimeArtifact;
}

/**
 * Materializes the exact runtime bytecode expected from one Hardhat artifact.
 *
 * OpenZeppelin UUPSUpgradeable embeds one immutable `__self` address in the
 * implementation runtime. The module artifacts therefore have one immutable
 * key with one or more 32-byte references. ERC1967Proxy has no immutables.
 */
export function materializeArtifactRuntime(
  cwd: string,
  artifactPath: string,
  deployedAddress?: Address,
): Hex {
  const artifact = loadArtifact(cwd, artifactPath);
  let body = artifact.deployedBytecode.slice(2);
  const immutableGroups = Object.values(artifact.immutableReferences ?? {});
  if (immutableGroups.length > 1) {
    throw new Error(`${artifactPath} has more than one immutable value; refusing an ambiguous patch`);
  }
  if (immutableGroups.length === 1) {
    if (!deployedAddress) throw new Error(`${artifactPath} requires its deployed address`);
    for (const reference of immutableGroups[0]) {
      if (reference.length !== 32) {
        throw new Error(`${artifactPath} has a non-32-byte immutable reference`);
      }
      const replacement = padHex(getAddress(deployedAddress), { size: reference.length }).slice(2);
      const start = reference.start * 2;
      const end = start + reference.length * 2;
      body = `${body.slice(0, start)}${replacement}${body.slice(end)}`;
    }
  }
  return `0x${body}` as Hex;
}

export async function assertArtifactRuntime(
  client: { getCode(args: { address: Address }): Promise<Hex | undefined> },
  label: string,
  address: Address,
  cwd: string,
  artifactPath: string,
): Promise<Hex> {
  const actual = await client.getCode({ address });
  if (!actual || actual === "0x") throw new Error(`${label} has no runtime code at ${address}`);
  const expected = materializeArtifactRuntime(cwd, artifactPath, address);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `${label} runtime mismatch at ${address}: expected ${keccak256(expected)}, got ${keccak256(actual)}`,
    );
  }
  return keccak256(actual);
}
