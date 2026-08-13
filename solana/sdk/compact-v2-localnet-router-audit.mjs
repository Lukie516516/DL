import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

const sdkDir = dirname(fileURLToPath(import.meta.url));
const solanaRoot = resolve(sdkDir, "..");
const stateRoot = resolve(
  process.env.COMPACT_V2_LOCAL_STATE_DIR ?? resolve(solanaRoot, ".local/compact-v2"),
);
const state = JSON.parse(readFileSync(resolve(stateRoot, "state.json"), "utf8"));
const layout = JSON.parse(readFileSync(state.localLayoutPath, "utf8"));
const router = JSON.parse(
  readFileSync(resolve(state.generatedRoot, "router-manifest.json"), "utf8"),
);
const rpcUrl = process.env.SOLANA_LOCAL_RPC_URL ?? "http://127.0.0.1:8899";
const MAGIC = Buffer.from("DLV2");
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

function assertLoopback(value) {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`router audit refuses non-loopback RPC ${url.origin}`);
  }
}

function loadKeypair(path) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
  );
}

async function simulate(connection, wallet, instruction) {
  const transaction = new Transaction().add(instruction);
  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = (
    await connection.getLatestBlockhash("confirmed")
  ).blockhash;
  transaction.sign(wallet);
  return connection.simulateTransaction(transaction, undefined, true);
}

function errorText(result) {
  return JSON.stringify(result.value.err);
}

assertLoopback(rpcUrl);
const connection = new Connection(rpcUrl, "confirmed");
const wallet = loadKeypair(state.walletPath);
const genesisHash = await connection.getGenesisHash();
const deployment = JSON.parse(
  readFileSync(resolve(stateRoot, "deployment-report.json"), "utf8"),
);
if (deployment.genesisHash !== genesisHash) {
  throw new Error("deployment report belongs to another local validator genesis");
}

const rootAddresses = layout.clusters.map((cluster) => new PublicKey(cluster.testProgramId));
const rootAccounts = await connection.getMultipleAccountsInfo(rootAddresses, "confirmed");
for (const [index, account] of rootAccounts.entries()) {
  if (!account?.executable) {
    throw new Error(`${layout.clusters[index].id}: root is not executable`);
  }
  if (!account.owner.equals(BPF_LOADER_UPGRADEABLE_PROGRAM_ID)) {
    throw new Error(`${layout.clusters[index].id}: root is not upgradeable-loader owned`);
  }
}

const explicitRoutes = [];
for (const group of router.groups) {
  const programId = new PublicKey(group.testProgramId);
  for (const module of group.modules) {
    const candidate = group.rawRoutes.find(
      (route) => route.moduleName === module.moduleName,
    );
    if (!candidate) throw new Error(`${module.moduleName}: no raw route candidate`);
    const result = await simulate(
      connection,
      wallet,
      new TransactionInstruction({
        programId,
        keys: [],
        data: Buffer.concat([
          MAGIC,
          Buffer.from([module.moduleTag]),
          Buffer.from(candidate.discriminator),
        ]),
      }),
    );
    const rejected = errorText(result);
    if (!result.value.err || rejected.includes("InvalidInstructionData")) {
      throw new Error(`${module.moduleName}: explicit route did not reach module entry`);
    }
    explicitRoutes.push({
      root: group.id,
      module: module.moduleName,
      moduleTag: module.moduleTag,
      rejected,
      logTail: (result.value.logs ?? []).slice(-3),
    });
  }
}

const firstGroup = router.groups[0];
const malformed = await simulate(
  connection,
  wallet,
  new TransactionInstruction({
    programId: new PublicKey(firstGroup.testProgramId),
    keys: [],
    data: MAGIC,
  }),
);
const unknownModule = await simulate(
  connection,
  wallet,
  new TransactionInstruction({
    programId: new PublicKey(firstGroup.testProgramId),
    keys: [],
    data: Buffer.concat([MAGIC, Buffer.from([255]), Buffer.alloc(8)]),
  }),
);
for (const [label, result] of [
  ["malformed envelope", malformed],
  ["unknown module", unknownModule],
]) {
  if (!errorText(result).includes("InvalidInstructionData")) {
    throw new Error(`${label} was not rejected as InvalidInstructionData`);
  }
}

const rawRoutes = router.groups.reduce((sum, group) => sum + group.rawRoutes.length, 0);
const prefixedOnly = router.groups.reduce(
  (sum, group) => sum + group.prefixedOnly.length,
  0,
);
const pdaSelected = router.groups.reduce(
  (sum, group) =>
    sum + group.rawRoutes.filter((route) => route.pdaSelector).length,
  0,
);
if (
  rootAccounts.length !== 10 ||
  explicitRoutes.length !== 24 ||
  rawRoutes !== 249 ||
  prefixedOnly !== 0 ||
  pdaSelected !== 66
) {
  throw new Error("Compact router coverage invariants changed");
}

const report = {
  auditedAt: new Date().toISOString(),
  scope: "loopback-localnet-only",
  rpcUrl,
  genesisHash,
  executableUpgradeableRoots: rootAccounts.length,
  explicitModuleRoutesReached: explicitRoutes.length,
  rawRoutes,
  prefixedOnly,
  pdaSelected,
  malformedEnvelopeRejected: errorText(malformed),
  unknownModuleRejected: errorText(unknownModule),
  explicitRoutes,
};
const reportPath = resolve(stateRoot, "router-audit-report.json");
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
