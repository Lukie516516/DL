import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let cachedPath;
let cachedMap;

export function compactProgramMap() {
  const configured = process.env.SOLANA_COMPACT_LAYOUT_PATH;
  if (!configured) return null;
  const layoutPath = resolve(configured);
  if (cachedPath === layoutPath && cachedMap) return cachedMap;

  const layout = JSON.parse(readFileSync(layoutPath, "utf8"));
  if (!Array.isArray(layout.clusters) || layout.clusters.length !== 10) {
    throw new Error(`compact layout must contain 10 roots: ${layoutPath}`);
  }
  const mapping = new Map();
  const roots = new Set();
  for (const cluster of layout.clusters) {
    if (!cluster.testProgramId || !Array.isArray(cluster.legacyPrograms)) {
      throw new Error(`invalid compact cluster ${cluster.id ?? "<unknown>"}`);
    }
    roots.add(cluster.testProgramId);
    for (const moduleName of cluster.legacyPrograms) {
      if (mapping.has(moduleName)) {
        throw new Error(`duplicate compact module ${moduleName}`);
      }
      mapping.set(moduleName, cluster.testProgramId);
    }
  }
  if (mapping.size !== 24 || roots.size !== 10) {
    throw new Error(
      `compact layout expected 24 modules/10 roots, got ${mapping.size}/${roots.size}`,
    );
  }
  cachedPath = layoutPath;
  cachedMap = mapping;
  return mapping;
}

export function programAddressFor(moduleName, fallbackAddress) {
  return compactProgramMap()?.get(moduleName) ?? fallbackAddress;
}
