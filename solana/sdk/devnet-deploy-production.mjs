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
  runDevnetPreflight,
} from "./devnet-preflight.mjs";

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
    sha256: createHash("sha256")
      .update(readFileSync(binaryPath))
      .digest("hex"),
  };
}

function showProgram(rpcUrl, address) {
  return parseJson(
    runSolana([
      "program",
      "show",
      address,
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
  const dryRun = process.env.SOLANA_DEPLOY_DRY_RUN === "1";
  if (!dryRun && process.env.SOLANA_DEPLOY_CONFIRM !== "DEVNET_24_PROGRAMS") {
    throw new Error(
      "actual deployment requires SOLANA_DEPLOY_CONFIRM=DEVNET_24_PROGRAMS",
    );
  }
  if (!dryRun && process.env.SOLANA_RPC_RESOLVE_IP) {
    throw new Error(
      "actual deployment cannot use pinned-IP fallback; provide a trusted RPC URL with correct DNS",
    );
  }

  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error("SOLANA_RPC_URL is required");
  const preflight = await runDevnetPreflight();
  if (!dryRun && !preflight.sufficientBalance) {
    throw new Error(
      `wallet has ${preflight.walletBalanceSol} SOL; recommended ${preflight.recommendedSol} SOL`,
    );
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
  const artifacts = parseDevnetPrograms().map(programArtifact);
  const existingByAddress = new Map(
    preflight.programs.map((program) => [program.address, program]),
  );
  const actions = [];

  for (const artifact of artifacts) {
    const existing = existingByAddress.get(artifact.address);
    if (existing?.executable) {
      const current = showProgram(rpcUrl, artifact.address);
      if (current.authority !== wallet) {
        throw new Error(
          `${artifact.name}: upgrade authority ${current.authority ?? "none"} != ${wallet}`,
        );
      }
      actions.push({
        name: artifact.name,
        address: artifact.address,
        action: "skip-existing",
        authority: current.authority,
        sha256: artifact.sha256,
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
    const verified = showProgram(rpcUrl, artifact.address);
    if (verified.authority !== wallet) {
      throw new Error(
        `${artifact.name}: post-deploy authority ${verified.authority ?? "none"} != ${wallet}`,
      );
    }
    actions.push({
      name: artifact.name,
      address: artifact.address,
      action: "deployed",
      authority: verified.authority,
      signature: deployed.signature ?? null,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dryRun,
    clusterGenesisHash: preflight.genesisHash,
    rpcOrigin: preflight.rpcOrigin,
    wallet,
    productionProgramCount: artifacts.length,
    actions,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (!dryRun) {
    const deploymentsDir = resolve(solanaDir, "deployments");
    mkdirSync(deploymentsDir, { recursive: true });
    const stamp = report.generatedAt.replaceAll(":", "").replaceAll(".", "");
    const reportPath = resolve(
      deploymentsDir,
      `devnet-production-deploy-${stamp}.json`,
    );
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    });
    process.stderr.write(`deployment report: ${reportPath}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
});
