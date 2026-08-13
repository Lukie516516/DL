import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair } from "@solana/web3.js";

import {
  loadWallet,
  parseDevnetPrograms,
} from "./devnet-preflight.mjs";
import { runMainnetPreflight } from "./mainnet-preflight.mjs";

const sdkDir = dirname(fileURLToPath(import.meta.url));
const solanaDir = resolve(sdkDir, "..");

function runSolana(args) {
  const result = spawnSync("solana", args, {
    cwd: solanaDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `solana ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

function parseJson(output, label) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function programArtifact(program) {
  const binaryPath = resolve(
    solanaDir,
    `target/deploy/${program.name}.so`,
  );
  const keypairPath = resolve(
    solanaDir,
    `target/deploy/${program.name}-keypair.json`,
  );
  const programKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))),
  );
  if (programKeypair.publicKey.toBase58() !== program.address) {
    throw new Error(
      `${program.name}: keypair ${programKeypair.publicKey.toBase58()} != ${program.address}`,
    );
  }
  return {
    ...program,
    binaryPath,
    keypairPath,
    bytes: statSync(binaryPath).size,
    sha256: sha256(readFileSync(binaryPath)),
  };
}

function showProgram(rpcUrl, walletPath, address) {
  return parseJson(
    runSolana([
      "program",
      "show",
      address,
      "--keypair",
      walletPath,
      "--url",
      rpcUrl,
      "--commitment",
      "confirmed",
      "--output",
      "json",
    ]),
    `program show ${address}`,
  );
}

async function main() {
  const dryRun = process.env.SOLANA_MAINNET_DEPLOY_DRY_RUN === "1";
  if (!dryRun) {
    const requiredConfirmations = {
      SOLANA_MAINNET_DEPLOY_CONFIRM: "MAINNET_24_PROGRAMS",
      SOLANA_MAINNET_ALLOW_WRITES: "I_UNDERSTAND_SOL_IS_REAL",
    };
    for (const [name, expected] of Object.entries(requiredConfirmations)) {
      if (process.env[name] !== expected) {
        throw new Error(`actual deployment requires ${name}=${expected}`);
      }
    }
    if (!process.env.SOLANA_MAINNET_BACKUP_RPC_URL) {
      throw new Error(
        "actual deployment requires SOLANA_MAINNET_BACKUP_RPC_URL",
      );
    }
    if (process.env.SOLANA_MAINNET_RPC_RESOLVE_IP) {
      throw new Error(
        "actual deployment refuses pinned-IP fallback; use a trusted RPC with working DNS",
      );
    }
  }

  const rpcUrl = process.env.SOLANA_MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("SOLANA_MAINNET_RPC_URL is required");
  const preflight = await runMainnetPreflight();
  if (!dryRun) {
    if (!preflight.sufficientBalance) {
      throw new Error(
        `wallet has ${preflight.walletBalanceSol} SOL; recommended ${preflight.recommendedSol} SOL`,
      );
    }
    const expectedManifest =
      process.env.SOLANA_MAINNET_MANIFEST_SHA256;
    if (!expectedManifest) {
      throw new Error(
        "actual deployment requires SOLANA_MAINNET_MANIFEST_SHA256",
      );
    }
    if (expectedManifest !== preflight.manifestSha256) {
      throw new Error(
        `manifest ${preflight.manifestSha256} != approved ${expectedManifest}`,
      );
    }
  }
  if (
    preflight.programs.some(
      ({ exists, executable }) => exists && !executable,
    )
  ) {
    throw new Error("a configured Program address exists but is not executable");
  }

  const { walletPath, keypair } = loadWallet();
  const wallet = keypair.publicKey.toBase58();
  const expectedExistingAuthority =
    process.env.SOLANA_MAINNET_EXPECTED_UPGRADE_AUTHORITY;
  const artifacts = parseDevnetPrograms().map(programArtifact);
  const existingByAddress = new Map(
    preflight.programs.map((program) => [program.address, program]),
  );
  const actions = [];
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const verifyDirectory = resolve(
    solanaDir,
    `.local/mainnet-program-verify-${stamp}`,
  );

  for (const artifact of artifacts) {
    const existing = existingByAddress.get(artifact.address);
    if (existing?.executable) {
      const current = showProgram(
        rpcUrl,
        walletPath,
        artifact.address,
      );
      if (
        current.authority !== wallet &&
        current.authority !== expectedExistingAuthority
      ) {
        throw new Error(
          `${artifact.name}: unexpected upgrade authority ${current.authority ?? "none"}`,
        );
      }
      actions.push({
        name: artifact.name,
        address: artifact.address,
        action: "skip-existing",
        authority: current.authority,
        localSha256: artifact.sha256,
      });
      continue;
    }

    if (dryRun) {
      actions.push({
        name: artifact.name,
        address: artifact.address,
        action: "would-deploy",
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      });
      continue;
    }

    const deployed = parseJson(
      runSolana([
        "program",
        "deploy",
        artifact.binaryPath,
        "--program-id",
        artifact.keypairPath,
        "--upgrade-authority",
        walletPath,
        "--fee-payer",
        walletPath,
        "--keypair",
        walletPath,
        "--url",
        rpcUrl,
        "--commitment",
        "confirmed",
        "--use-rpc",
        "--output",
        "json",
      ]),
      `program deploy ${artifact.name}`,
    );
    if (deployed.programId !== artifact.address) {
      throw new Error(
        `${artifact.name}: deployed ${deployed.programId} instead of ${artifact.address}`,
      );
    }
    const verified = showProgram(rpcUrl, walletPath, artifact.address);
    if (verified.authority !== wallet) {
      throw new Error(
        `${artifact.name}: post-deploy authority ${verified.authority ?? "none"} != ${wallet}`,
      );
    }
    mkdirSync(verifyDirectory, { recursive: true });
    const dumpPath = resolve(verifyDirectory, `${artifact.name}.so`);
    runSolana([
      "program",
      "dump",
      artifact.address,
      dumpPath,
      "--keypair",
      walletPath,
      "--url",
      rpcUrl,
    ]);
    const deployedHash = sha256(readFileSync(dumpPath));
    if (deployedHash !== artifact.sha256) {
      throw new Error(
        `${artifact.name}: deployed hash ${deployedHash} != local ${artifact.sha256}`,
      );
    }
    actions.push({
      name: artifact.name,
      address: artifact.address,
      action: "deployed",
      authority: verified.authority,
      signature: deployed.signature ?? null,
      bytes: artifact.bytes,
      localSha256: artifact.sha256,
      deployedSha256: deployedHash,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    cluster: "solana-mainnet",
    dryRun,
    programLayerOnly: true,
    initializationPerformed: false,
    authorityHandoffPerformed: false,
    clusterGenesisHash: preflight.genesisHash,
    rpcOrigin: preflight.rpcOrigin,
    backupRpc: preflight.backupRpc,
    wallet,
    approvedManifestSha256: preflight.manifestSha256,
    productionProgramCount: artifacts.length,
    actions,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (!dryRun) {
    const deploymentsDirectory = resolve(solanaDir, "deployments");
    mkdirSync(deploymentsDirectory, { recursive: true });
    const reportPath = resolve(
      deploymentsDirectory,
      `mainnet-program-deploy-${stamp}.json`,
    );
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    });
    process.stderr.write(`deployment report: ${reportPath}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
