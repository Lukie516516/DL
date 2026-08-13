#!/usr/bin/env node

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const compactRoot = path.resolve(toolDir, "..");
const solanaRoot = path.resolve(compactRoot, "..");
const productionPrograms = path.join(solanaRoot, "programs");
const productionIdls = path.join(solanaRoot, "target", "idl");
const generatedRoot = path.resolve(
  process.env.COMPACT_V2_GENERATED_ROOT ?? path.join(compactRoot, "generated"),
);
const generatedModules = path.join(generatedRoot, "modules");
const generatedPrograms = path.join(generatedRoot, "programs");
const layoutPath = path.resolve(
  process.env.COMPACT_V2_LAYOUT_PATH ?? path.join(compactRoot, "layout.json"),
);
const layout = JSON.parse(fs.readFileSync(layoutPath, "utf8"));
const MAGIC = [68, 76, 86, 50];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function packageName(moduleName) {
  return moduleName.replaceAll("_", "-");
}

function copyTree(source, destination, transform) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to, transform);
    else {
      const value = fs.readFileSync(from, "utf8");
      fs.writeFileSync(to, transform ? transform(value, from) : value);
    }
  }
}

function normalizeBusinessSource(source) {
  return source
    .replace(/declare_id!\("[^"]+"\);/g, 'declare_id!("<PROGRAM_ID>");')
    .replace(/#\[error_code(?:\(offset\s*=\s*\d+\))?\]/g, "#[error_code(<MODULE_RANGE>)]");
}

function moduleSourceTransform(source, programId, errorOffset) {
  let transformed = source.replace(
    /declare_id!\("[^"]+"\);/g,
    'declare_id!("' + programId + '");',
  );
  transformed = transformed.replace(
    /#\[error_code(?:\(offset\s*=\s*\d+\))?\]/g,
    errorOffset === 6000 ? "#[error_code]" : "#[error_code(offset = " + errorOffset + ")]",
  );
  return transformed;
}

function replaceChecked(source, needle, replacement, expected, label, applied) {
  const count = source.split(needle).length - 1;
  if (count !== expected) {
    throw new Error(label + ": expected " + expected + " matches, found " + count);
  }
  applied.push({ label, count });
  return source.split(needle).join(replacement);
}

function applyCompactPlumbing(moduleName, source, legacyProgramIdMap) {
  const applied = [];
  let value = source;
  const patch = (needle, replacement, expected, label) => {
    value = replaceChecked(value, needle, replacement, expected, label, applied);
  };

  // Terminal sequence guards use explicit program IDs because they inspect
  // the top-level instruction sysvar. In the compact topology those legacy
  // programs execute behind their cluster root, so every known pubkey!
  // reference must follow the same deterministic legacy -> root mapping.
  for (const [legacyProgramId, compactProgramId] of legacyProgramIdMap) {
    const legacyLiteral = 'pubkey!("' + legacyProgramId + '")';
    const count = value.split(legacyLiteral).length - 1;
    if (count === 0) continue;
    value = value.split(legacyLiteral).join('pubkey!("' + compactProgramId + '")');
    applied.push({
      label:
        "retarget explicit program ID " + legacyProgramId + " -> " + compactProgramId,
      count,
    });
  }

  if (moduleName === "deal_asset_controller") {
    patch(
      "        ))\n    }\n\n    pub fn lock_identity",
      "        ))?;\n        ctx.accounts.deal.reload()?;\n        Ok(())\n    }\n\n    pub fn lock_identity",
      1,
      "reload DealAccount after compact Core join CPI",
    );
    patch(
      "        )?;\n        if is_party_a {",
      "        )?;\n        ctx.accounts.deal.reload()?;\n        if is_party_a {",
      2,
      "reload DealAccount after compact Core deposit CPI",
    );
    patch(
      "        )?;\n        refund_side(ctx.accounts, is_party_a)?;",
      "        )?;\n        ctx.accounts.deal.reload()?;\n        refund_side(ctx.accounts, is_party_a)?;",
      1,
      "reload DealAccount after compact Core withdrawal CPI",
    );
    for (const call of [
      "cpi_exit_by_b",
      "cpi_kick_b_by_a",
      "cpi_replace_inactive_b",
      "cpi_replace_non_voting_b",
      "cpi_abandon",
    ]) {
      patch(
        "        " + call + "(ctx.accounts)?;",
        "        " + call + "(ctx.accounts)?;\n        ctx.accounts.deal.reload()?;",
        1,
        "reload DealAccount after compact Core " + call + " CPI",
      );
    }
  }

  if (moduleName === "deal_dex_router") {
    for (const item of [
      ["minimum_dc_out", "pair"],
      ["required_other_in", "pair"],
      ["minimum_other_out", "pair"],
      ["required_dc_in", "pair"],
    ]) {
      patch(
        "            " + item[0] + ",\n        )?;\n        emit!",
        "            " + item[0] + ",\n        )?;\n        ctx.accounts." + item[1] + ".reload()?;\n        emit!",
        1,
        "reload PairState after compact Pair single-hop CPI " + item[0],
      );
    }
    patch(
      "            dc_net,\n        )?;\n        deal_dex_pair::cpi::swap_sell_dc",
      "            dc_net,\n        )?;\n        ctx.accounts.pair_a.reload()?;\n        deal_dex_pair::cpi::swap_sell_dc",
      1,
      "reload pair A after compact Pair exact-input CPI",
    );
    patch(
      "            minimum_b_out,\n        )?;\n        emit!",
      "            minimum_b_out,\n        )?;\n        ctx.accounts.pair_b.reload()?;\n        emit!",
      1,
      "reload pair B after compact Pair exact-input CPI",
    );
    patch(
      "            required_a_in,\n        )?;\n        deal_dex_pair::cpi::swap_dc_for_exact_other",
      "            required_a_in,\n        )?;\n        ctx.accounts.pair_a.reload()?;\n        deal_dex_pair::cpi::swap_dc_for_exact_other",
      1,
      "reload pair A after compact Pair exact-output CPI",
    );
    patch(
      "            required_dc,\n        )?;\n        let dc_refund",
      "            required_dc,\n        )?;\n        ctx.accounts.pair_b.reload()?;\n        let dc_refund",
      1,
      "reload pair B after compact Pair exact-output CPI",
    );
  }

  if (moduleName === "deal_swap_orderbook") {
    for (const amount of ["amount_other_out", "dc_out"]) {
      patch(
        "            " + amount + ",\n        )?;\n        finish_fill",
        "            " + amount + ",\n        )?;\n        ctx.accounts.pair.reload()?;\n        finish_fill",
        1,
        "reload PairState after compact order settlement " + amount,
      );
    }
  }

  if (moduleName === "deal_domain_market") {
    patch(
      "        ))?;\n\n        let listing",
      "        ))?;\n        ctx.accounts.domain.reload()?;\n\n        let listing",
      1,
      "reload DomainRecord after compact registry escrow CPI",
    );
    for (const eventName of ["DomainDelisted", "DomainSold"]) {
      patch(
        "        )?;\n        emit!(" + eventName,
        "        )?;\n        ctx.accounts.domain.reload()?;\n        emit!(" + eventName,
        1,
        "reload DomainRecord after compact registry release CPI " + eventName,
      );
    }
  }

  if (moduleName === "deal_swap_asset_registry") {
    patch(
      "    require!(pair_program != router_program, RegistryError::DuplicateCore);",
      [
        "    // Pair and Router are distinct programs in the legacy topology. In the",
        "    // audited compact topology both modules intentionally share this root ID.",
        "    // Equality is accepted only when both values equal their compiled module IDs;",
        "    // arbitrary duplicate addresses remain rejected.",
        "    require!(",
        "        pair_program != router_program",
        "            || (pair_program == deal_dex_pair::ID && router_program == crate::ID),",
        "        RegistryError::DuplicateCore",
        "    );",
      ].join("\n"),
      1,
      "allow only the composed Exchange root as Pair/Router shared identity",
    );
    patch(
      "    #[test]\n    fn pair_derivation_matches_pair_program_seed()",
      [
        "    #[test]",
        "    fn accepts_only_the_compiled_composed_exchange_identity() {",
        "        let [_, _, dc, native, stable0, stable1] = fixture_keys();",
        "        assert!(validate_assets(",
        "            deal_dex_pair::ID,",
        "            crate::ID,",
        "            dc,",
        "            native,",
        "            stable0,",
        "            stable1,",
        "        )",
        "        .is_ok());",
        "        let arbitrary = Pubkey::new_unique();",
        "        assert!(validate_assets(",
        "            arbitrary, arbitrary, dc, native, stable0, stable1,",
        "        )",
        "        .is_err());",
        "    }",
        "",
        "    #[test]",
        "    fn pair_derivation_matches_pair_program_seed()",
      ].join("\n"),
      1,
      "test the composed Exchange identity exception and arbitrary duplicate rejection",
    );
  }

  return { source: value, applied };
}

function instructionKey(discriminator) {
  return discriminator.join(",");
}

const groupByModule = new Map();
for (const cluster of layout.clusters) {
  if (!cluster.testProgramId) throw new Error("Missing testProgramId for " + cluster.id);
  cluster.legacyPrograms.forEach((moduleName, moduleIndex) => {
    if (groupByModule.has(moduleName)) throw new Error("Duplicate module " + moduleName);
    groupByModule.set(moduleName, { cluster, moduleIndex });
  });
}

const legacyProgramIdMap = new Map();
for (const [moduleName, assignment] of groupByModule) {
  const idlPath = path.join(productionIdls, moduleName + ".json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  if (!idl.address) throw new Error("Missing address in production IDL " + idlPath);
  legacyProgramIdMap.set(idl.address, assignment.cluster.testProgramId);
}

fs.mkdirSync(generatedModules, { recursive: true });
fs.mkdirSync(generatedPrograms, { recursive: true });

const equivalence = [];
for (const [moduleName, value] of groupByModule) {
  const cluster = value.cluster;
  const moduleIndex = value.moduleIndex;
  const packageDir = packageName(moduleName);
  const sourceDir = path.join(productionPrograms, packageDir);
  const destinationDir = path.join(generatedModules, packageDir);
  if (!fs.existsSync(sourceDir)) throw new Error("Missing source directory " + sourceDir);
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.copyFileSync(path.join(sourceDir, "Cargo.toml"), path.join(destinationDir, "Cargo.toml"));
  copyTree(path.join(sourceDir, "src"), path.join(destinationDir, "src"), (source, from) => {
    const baseTransformed = moduleSourceTransform(
      source,
      cluster.testProgramId,
      6000 + moduleIndex * 100,
    );
    const normalizedOriginal = normalizeBusinessSource(source);
    const normalizedGenerated = normalizeBusinessSource(baseTransformed);
    if (normalizedOriginal !== normalizedGenerated) {
      throw new Error("Business source changed unexpectedly: " + from);
    }
    const plumbing =
      path.basename(from) === "lib.rs"
        ? applyCompactPlumbing(moduleName, baseTransformed, legacyProgramIdMap)
        : { source: baseTransformed, applied: [] };
    const transformed = plumbing.source;
    equivalence.push({
      module: moduleName,
      file: path.relative(sourceDir, from),
      originalSha256: sha256(source),
      generatedSha256: sha256(transformed),
      normalizedBusinessSha256: sha256(normalizedOriginal),
      allowedChanges: ["declare_id", "error_code_offset"],
      compactPlumbingChanges: plumbing.applied,
    });
    return transformed;
  });
  const testsDir = path.join(sourceDir, "tests");
  if (fs.existsSync(testsDir)) {
    copyTree(testsDir, path.join(destinationDir, "tests"), (source) =>
      source.replace(
        /target\/deploy\/(deal_[a-z0-9_]+)\.so/g,
        (match, referencedModule) => {
          const assignment = groupByModule.get(referencedModule);
          if (!assignment) {
            throw new Error(
              moduleName + " runtime test references non-production module " + referencedModule,
            );
          }
          return "target/deploy/" + assignment.cluster.targetName + ".so";
        },
      ),
    );
  }
}

copyTree(
  path.join(solanaRoot, "crates", "deal-terminal-guard"),
  path.join(generatedRoot, "crates", "deal-terminal-guard"),
);
copyTree(path.join(solanaRoot, "fixtures"), path.join(generatedRoot, "fixtures"));

const routerManifest = { schemaVersion: 1, magic: "DLV2", groups: [] };
// Anchor IDLs describe the statically declared account struct, but an
// instruction may also intentionally consume Context::remaining_accounts.
// Keep this list explicit and audited: those legacy instructions accept at
// least the IDL account count instead of requiring an exact match.
const VARIABLE_ACCOUNT_INSTRUCTIONS = new Set([
  "deal_governance_executor:execute_message",
]);

function accountCountsOverlap(left, right) {
  if (left.acceptsRemainingAccounts && right.acceptsRemainingAccounts) return true;
  if (left.acceptsRemainingAccounts) return right.accountCount >= left.accountCount;
  if (right.acceptsRemainingAccounts) return left.accountCount >= right.accountCount;
  return left.accountCount === right.accountCount;
}

for (const cluster of layout.clusters) {
  const moduleRecords = cluster.legacyPrograms.map((moduleName, moduleTag) => {
    const idlPath = path.join(productionIdls, moduleName + ".json");
    if (!fs.existsSync(idlPath)) throw new Error("Missing production IDL " + idlPath);
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
    if ((idl.errors || []).length > 100) {
      throw new Error(moduleName + " exceeds its 100-code error range");
    }
    return { moduleName, moduleTag, idl };
  });

  const candidatesByDiscriminator = new Map();
  for (const record of moduleRecords) {
    for (const instruction of record.idl.instructions) {
      const key = instructionKey(instruction.discriminator);
      if (!candidatesByDiscriminator.has(key)) candidatesByDiscriminator.set(key, []);
      candidatesByDiscriminator.get(key).push({
        moduleName: record.moduleName,
        moduleTag: record.moduleTag,
        instruction: instruction.name,
        discriminator: instruction.discriminator,
        accountCount: instruction.accounts.length,
        acceptsRemainingAccounts: VARIABLE_ACCOUNT_INSTRUCTIONS.has(
          record.moduleName + ":" + instruction.name,
        ),
        constantPdas: instruction.accounts.flatMap((account, accountIndex) => {
          if (!account.pda || !account.pda.seeds.every((seed) => seed.kind === "const")) {
            return [];
          }
          return [{
            accountIndex,
            seeds: account.pda.seeds.map((seed) => seed.value),
          }];
        }),
      });
    }
  }

  const rawRoutes = [];
  const prefixedOnly = [];
  for (const candidates of candidatesByDiscriminator.values()) {
    for (const candidate of candidates) {
      const overlapping = candidates.filter(
        (other) => other !== candidate && accountCountsOverlap(candidate, other),
      );
      if (overlapping.length === 0) {
        rawRoutes.push(candidate);
        continue;
      }
      const selector = candidate.constantPdas.find((pda) => {
        const key = JSON.stringify(pda);
        return !overlapping.some(
          (other) =>
            other.constantPdas.some((otherPda) => JSON.stringify(otherPda) === key),
        );
      });
      if (selector) rawRoutes.push({ ...candidate, pdaSelector: selector });
      else prefixedOnly.push(candidate);
    }
  }

  const dependencies = moduleRecords
    .map((record) => {
      const packageDir = packageName(record.moduleName);
      return (
        packageDir +
        ' = { path = "../../modules/' +
        packageDir +
        '", features = ["no-entrypoint"] }'
      );
    })
    .join("\n");

  const cargo = [
    "[package]",
    'name = "' + cluster.targetName.replaceAll("_", "-") + '"',
    'version = "0.1.0"',
    'description = "Generated Deal Compact V2 ' + cluster.id + ' composition root"',
    "edition.workspace = true",
    "license.workspace = true",
    "rust-version.workspace = true",
    "publish = false",
    "",
    "[lib]",
    'crate-type = ["cdylib", "lib"]',
    'name = "' + cluster.targetName + '"',
    "",
    "[features]",
    "default = []",
    "no-entrypoint = []",
    "",
    "[dependencies]",
    "anchor-lang.workspace = true",
    dependencies,
    "",
  ].join("\n");

  const moduleConstants = moduleRecords
    .map(
      (record) =>
        "pub const " + record.moduleName.toUpperCase() + "_MODULE: u8 = " + record.moduleTag + ";",
    )
    .join("\n");
  const prefixedDispatch = moduleRecords
    .map(
      (record) =>
        "            " +
        record.moduleTag +
        " => " +
        record.moduleName +
        "::entry(program_id, accounts, legacy_data),",
    )
    .join("\n");

  const rawDispatch = [];
  for (const route of rawRoutes) {
    let condition =
      "accounts.len() " +
      (route.acceptsRemainingAccounts ? ">= " : "== ") +
      route.accountCount;
    if (route.pdaSelector) {
      const seeds = route.pdaSelector.seeds
        .map((seed) => "&[" + seed.join(", ") + "][..]")
        .join(", ");
      condition +=
        " && accounts.get(" +
        route.pdaSelector.accountIndex +
        ").is_some_and(|account| Pubkey::find_program_address(&[" +
        seeds +
        "], program_id).0 == *account.key)";
    }
    rawDispatch.push(
      "    if discriminator == [" +
        route.discriminator.join(", ") +
        "] && " +
        condition +
        " { return " +
        route.moduleName +
        "::entry(program_id, accounts, data); }",
    );
  }

  const collisionRoute = rawRoutes.find((route) => route.pdaSelector);
  const collisionTest = collisionRoute
    ? [
        "",
        "    fn test_account(key: Pubkey) -> AccountInfo<'static> {",
        "        let key = Box::leak(Box::new(key));",
        "        let owner = Box::leak(Box::new(anchor_lang::solana_program::system_program::ID));",
        "        let lamports = Box::leak(Box::new(0_u64));",
        "        let data = Box::leak(Vec::<u8>::new().into_boxed_slice());",
        "        AccountInfo::new(key, false, true, lamports, data, owner, false)",
        "    }",
        "",
        "    #[test]",
        "    fn raw_collision_rejects_noncanonical_pdas() {",
        "        let accounts: Vec<_> = (0.." +
          collisionRoute.accountCount +
          ").map(|_| test_account(Pubkey::new_unique())).collect();",
        "        let accounts = Box::leak(accounts.into_boxed_slice());",
        "        let data = Box::leak(Box::new([" + collisionRoute.discriminator.join(", ") + "]));",
        "        let program_id = Box::leak(Box::new(crate::ID));",
        "        assert_eq!(entry(program_id, accounts, data), Err(ProgramError::InvalidInstructionData));",
        "    }",
      ]
    : [];

  const routerTests = [
    "#[cfg(test)]",
    "mod router_tests {",
    "    use super::*;",
    "",
    "    #[test]",
    "    fn explicit_route_envelope_is_stable() {",
    "        assert_eq!(route(7, vec![1, 2, 3]), vec![68, 76, 86, 50, 7, 1, 2, 3]);",
    "    }",
    "",
    "    #[test]",
    "    fn malformed_and_unknown_routes_are_rejected() {",
    "        assert_eq!(entry(&crate::ID, &[], &[]), Err(ProgramError::InvalidInstructionData));",
    "        assert_eq!(entry(&crate::ID, &[], &ROUTE_MAGIC), Err(ProgramError::InvalidInstructionData));",
    "        assert_eq!(entry(&crate::ID, &[], &route(u8::MAX, Vec::new())), Err(ProgramError::InvalidInstructionData));",
    "        assert_eq!(entry(&crate::ID, &[], &[0_u8; 8]), Err(ProgramError::InvalidInstructionData));",
    "    }",
    ...collisionTest,
    "}",
    "",
  ];

  const source = [
    "#![allow(unexpected_cfgs)]",
    "",
    "use anchor_lang::prelude::*;",
    "use anchor_lang::solana_program::{entrypoint, entrypoint::ProgramResult, program_error::ProgramError};",
    "",
    'declare_id!("' + cluster.testProgramId + '");',
    "",
    "pub const ROUTE_MAGIC: [u8; 4] = [" + MAGIC.join(", ") + "];",
    moduleConstants,
    "",
    '#[cfg(not(feature = "no-entrypoint"))]',
    "entrypoint!(entry);",
    "",
    "pub fn entry<'info>(",
    "    program_id: &'info Pubkey,",
    "    accounts: &'info [AccountInfo<'info>],",
    "    data: &'info [u8],",
    ") -> ProgramResult {",
    "    if data.starts_with(&ROUTE_MAGIC) {",
    "        let (&module, legacy_data) = data",
    "            .get(ROUTE_MAGIC.len()..)",
    "            .and_then(|tail| tail.split_first())",
    "            .ok_or(ProgramError::InvalidInstructionData)?;",
    "        return match module {",
    prefixedDispatch,
    "            _ => Err(ProgramError::InvalidInstructionData),",
    "        };",
    "    }",
    "",
    "    let discriminator: [u8; 8] = data",
    "        .get(..8)",
    "        .and_then(|value| value.try_into().ok())",
    "        .ok_or(ProgramError::InvalidInstructionData)?;",
    ...rawDispatch,
    "    Err(ProgramError::InvalidInstructionData)",
    "}",
    "",
    "pub fn route(module: u8, legacy_data: Vec<u8>) -> Vec<u8> {",
    "    let mut data = Vec::with_capacity(ROUTE_MAGIC.len() + 1 + legacy_data.len());",
    "    data.extend_from_slice(&ROUTE_MAGIC);",
    "    data.push(module);",
    "    data.extend_from_slice(&legacy_data);",
    "    data",
    "}",
    "",
    ...routerTests,
  ].join("\n");

  const programDir = path.join(
    generatedPrograms,
    cluster.targetName.replaceAll("_", "-"),
  );
  fs.mkdirSync(path.join(programDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(programDir, "Cargo.toml"), cargo);
  fs.writeFileSync(path.join(programDir, "src", "lib.rs"), source);
  routerManifest.groups.push({
    id: cluster.id,
    targetName: cluster.targetName,
    testProgramId: cluster.testProgramId,
    modules: moduleRecords.map((record) => ({
      moduleName: record.moduleName,
      moduleTag: record.moduleTag,
    })),
    rawRoutes,
    prefixedOnly,
  });
}

const moduleMembers = [...groupByModule.keys()]
  .map((moduleName) => '    "modules/' + packageName(moduleName) + '",')
  .join("\n");
const programMembers = layout.clusters
  .map(
    (cluster) =>
      '    "programs/' + cluster.targetName.replaceAll("_", "-") + '",',
  )
  .join("\n");
const workspace = [
  "[workspace]",
  "members = [",
  '    "crates/deal-terminal-guard",',
  moduleMembers,
  programMembers,
  "]",
  'resolver = "2"',
  "",
  "[workspace.package]",
  'edition = "2021"',
  'license = "MIT"',
  'rust-version = "1.89"',
  "",
  "[workspace.dependencies]",
  'anchor-lang = { version = "=1.0.2", features = ["init-if-needed"] }',
  'anchor-spl = { version = "=1.0.2", default-features = false, features = ["associated_token", "mint", "token", "token_2022", "token_2022_extensions"] }',
  'solana-keccak-hasher = { version = "=3.1.0", features = ["sha3"] }',
  'solana-instructions-sysvar = "=3.0.1"',
  "",
  "[profile.release]",
  "overflow-checks = true",
  'lto = "fat"',
  "codegen-units = 1",
  "",
  "[profile.release.build-override]",
  "opt-level = 3",
  "incremental = false",
  "codegen-units = 1",
  "",
].join("\n");

fs.writeFileSync(path.join(generatedRoot, "Cargo.toml"), workspace);
if (!fs.existsSync(path.join(generatedRoot, "Cargo.lock"))) {
  fs.copyFileSync(path.join(solanaRoot, "Cargo.lock"), path.join(generatedRoot, "Cargo.lock"));
}
fs.writeFileSync(
  path.join(generatedRoot, "source-equivalence.json"),
  JSON.stringify({ schemaVersion: 1, files: equivalence }, null, 2) + "\n",
);
fs.writeFileSync(
  path.join(generatedRoot, "router-manifest.json"),
  JSON.stringify(routerManifest, null, 2) + "\n",
);
const format = spawnSync(
  "cargo",
  ["fmt", "--manifest-path", path.join(generatedRoot, "Cargo.toml"), "--all"],
  { encoding: "utf8" },
);
if (format.status !== 0) {
  throw new Error(
    "generated workspace formatting failed: " +
      (format.stderr || format.stdout || "unknown cargo fmt error").trim(),
  );
}

console.log(
  "Generated " +
    groupByModule.size +
    " unchanged modules behind " +
    layout.clusters.length +
    " roots.",
);
console.log(
  "Verified " +
    equivalence.length +
    " Rust files differ only by Program ID/error range.",
);
