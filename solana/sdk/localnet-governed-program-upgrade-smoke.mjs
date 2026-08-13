import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import { createLocalGovernanceClient } from "./localnet-governance-client.mjs";

const sdkDir = dirname(fileURLToPath(import.meta.url));
const solanaDir = resolve(sdkDir, "..");
const localDir = resolve(
  process.env.SOLANA_LOCAL_STATE_DIR ?? resolve(solanaDir, ".local"),
);
const walletPath = resolve(
  process.env.SOLANA_WALLET_PATH ?? resolve(localDir, "test-wallet.json"),
);
const rpcUrl = process.env.SOLANA_LOCAL_RPC_URL ?? "http://127.0.0.1:8899";
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

const programNames = [
  "deal_asset_controller",
  "deal_core",
  "deal_credit_graph",
  "deal_credit_valuator",
  "deal_dc_controller",
  "deal_dex_pair",
  "deal_dex_quoter",
  "deal_dex_router",
  "deal_domain_registry",
  "deal_domain_market",
  "deal_domain_rank",
  "deal_domain_entry",
  "deal_domain_hall",
  "deal_swap_asset_registry",
  "deal_swap_orderbook",
  "deal_finalizer",
  "deal_governance_executor",
  "deal_history_index",
  "deal_identity",
  "deal_message_hub",
  "deal_parameter_registry",
  "deal_protocol_treasury",
  "deal_result_index",
  "deal_reward_engine",
];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: solanaDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

function programShow(program) {
  return JSON.parse(
    run("solana", [
      "program",
      "show",
      program.toBase58(),
      "--keypair",
      relative(solanaDir, walletPath),
      "--url",
      rpcUrl,
      "--output",
      "json",
    ]),
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeKeypair(path, keypair) {
  writeFileSync(path, `${JSON.stringify(Array.from(keypair.secretKey))}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

async function main() {
  if (
    process.env.SOLANA_LOCAL_UPGRADE_CONFIRM !==
    "LOCALNET_GOVERNED_PROGRAM_UPGRADE"
  ) {
    throw new Error(
      "upgrade smoke requires SOLANA_LOCAL_UPGRADE_CONFIRM=LOCALNET_GOVERNED_PROGRAM_UPGRADE",
    );
  }

  const client = await createLocalGovernanceClient();
  const {
    connection,
    wallet,
    walletPath,
    governanceProgram,
    governanceConfig,
    executorAuthority,
    state,
  } = client;
  let orphanBufferCleanup = null;
  if (process.env.SOLANA_LOCAL_UPGRADE_ORPHAN_BUFFER) {
    const orphanBuffer = new PublicKey(
      process.env.SOLANA_LOCAL_UPGRADE_ORPHAN_BUFFER,
    );
    const closeData = Buffer.alloc(4);
    closeData.writeUInt32LE(5);
    const cleanupExecution = await client.executeGovernanceInstruction({
      label: "bpf_loader_upgradeable.close_orphan_buffer",
      instruction: new TransactionInstruction({
        programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
        keys: [
          { pubkey: orphanBuffer, isSigner: false, isWritable: true },
          { pubkey: wallet.publicKey, isSigner: false, isWritable: true },
          { pubkey: executorAuthority, isSigner: true, isWritable: false },
        ],
        data: closeData,
      }),
    });
    if ((await connection.getAccountInfo(orphanBuffer, "confirmed")) !== null) {
      throw new Error("governance failed to close the orphan upgrade buffer");
    }
    orphanBufferCleanup = {
      buffer: orphanBuffer.toBase58(),
      cleanupExecution,
      closed: true,
    };
  }
  const runId = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const runDirectory = resolve(localDir, `governed-upgrade-smoke-${runId}`);
  mkdirSync(runDirectory, { recursive: false });

  const loaderTargetRecord = client.pda(
    governanceProgram,
    "allowed-target",
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  );
  const existingLoaderTarget = await connection.getAccountInfo(
    loaderTargetRecord,
    "confirmed",
  );
  let allowLoader;
  if (!existingLoaderTarget || existingLoaderTarget.data[40] === 0) {
    allowLoader = await client.executeGovernance({
      programName: "deal_governance_executor",
      instructionName: "set_allowed_target",
      args: {
        target: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
        allowed: true,
      },
      accounts: {
        authority: executorAuthority,
        config: governanceConfig,
        target_record: loaderTargetRecord,
        system_program: SystemProgram.programId,
      },
    });
  }
  const loaderTarget = await connection.getAccountInfo(
    loaderTargetRecord,
    "confirmed",
  );
  if (
    !loaderTarget ||
    !new PublicKey(loaderTarget.data.subarray(8, 40)).equals(
      BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    ) ||
    loaderTarget.data[40] === 0
  ) {
    throw new Error("upgradeable loader is not governance-allowlisted");
  }

  const canaryName =
    process.env.SOLANA_LOCAL_UPGRADE_CANARY_NAME ?? "deal_parameter_registry";
  const canaryProgram = client.programId(canaryName);
  const canaryBinary = resolve(
    process.env.SOLANA_LOCAL_UPGRADE_BINARY ??
      resolve(solanaDir, `target/deploy/${canaryName}.so`),
  );
  const sourceBinary = readFileSync(canaryBinary);
  const sourceHash = sha256(sourceBinary);
  const registryAccount = new PublicKey(state.addresses.parameterRegistry);
  const registryBefore = await connection.getAccountInfo(
    registryAccount,
    "confirmed",
  );
  if (!registryBefore) throw new Error("parameter registry state is missing");
  const registryStateHashBefore = sha256(registryBefore.data);
  const showBefore = programShow(canaryProgram);
  if (
    showBefore.authority !== wallet.publicKey.toBase58() &&
    showBefore.authority !== executorAuthority.toBase58()
  ) {
    throw new Error(
      `canary program has unexpected upgrade authority ${showBefore.authority}`,
    );
  }

  const buffer = Keypair.generate();
  const bufferPath = resolve(runDirectory, "buffer.json");
  writeKeypair(bufferPath, buffer);
  const writeBuffer = JSON.parse(
    run("solana", [
      "program",
      "write-buffer",
      relative(solanaDir, canaryBinary),
      "--buffer",
      relative(solanaDir, bufferPath),
      "--buffer-authority",
      relative(solanaDir, walletPath),
      "--fee-payer",
      relative(solanaDir, walletPath),
      "--keypair",
      relative(solanaDir, walletPath),
      "--url",
      rpcUrl,
      "--use-rpc",
      "--output",
      "json",
    ]),
  );
  if (writeBuffer.buffer !== buffer.publicKey.toBase58()) {
    throw new Error("written buffer address does not match generated key");
  }
  const setBufferAuthority = JSON.parse(
    run("solana", [
      "program",
      "set-buffer-authority",
      buffer.publicKey.toBase58(),
      "--new-buffer-authority",
      executorAuthority.toBase58(),
      "--buffer-authority",
      relative(solanaDir, walletPath),
      "--keypair",
      relative(solanaDir, walletPath),
      "--url",
      rpcUrl,
      "--output",
      "json",
    ]),
  );
  const setCanaryAuthority =
    showBefore.authority === wallet.publicKey.toBase58()
      ? JSON.parse(
          run("solana", [
            "program",
            "set-upgrade-authority",
            canaryProgram.toBase58(),
            "--new-upgrade-authority",
            executorAuthority.toBase58(),
            "--skip-new-upgrade-authority-signer-check",
            "--upgrade-authority",
            relative(solanaDir, walletPath),
            "--keypair",
            relative(solanaDir, walletPath),
            "--url",
            rpcUrl,
            "--output",
            "json",
          ]),
        )
      : null;
  const showTransferred = programShow(canaryProgram);
  if (showTransferred.authority !== executorAuthority.toBase58()) {
    throw new Error("canary upgrade authority handoff failed");
  }

  const upgradeData = Buffer.alloc(4);
  upgradeData.writeUInt32LE(3);
  const unauthorizedUpgradeInstruction = new TransactionInstruction({
    programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    keys: [
      {
        pubkey: new PublicKey(showTransferred.programdataAddress),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: canaryProgram, isSigner: false, isWritable: true },
      { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
    ],
    data: upgradeData,
  });
  const unauthorizedTransaction = new Transaction().add(
    unauthorizedUpgradeInstruction,
  );
  unauthorizedTransaction.feePayer = wallet.publicKey;
  unauthorizedTransaction.recentBlockhash = (
    await connection.getLatestBlockhash("confirmed")
  ).blockhash;
  unauthorizedTransaction.sign(wallet);
  const unauthorizedSimulation = await connection.simulateTransaction(
    unauthorizedTransaction,
  );
  if (!unauthorizedSimulation.value.err) {
    throw new Error("bootstrap wallet unexpectedly retained direct upgrade power");
  }
  const governedUpgrade = await client.executeGovernanceInstruction({
    label: "bpf_loader_upgradeable.upgrade",
    instruction: new TransactionInstruction({
      programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
      keys: [
        {
          pubkey: new PublicKey(showTransferred.programdataAddress),
          isSigner: false,
          isWritable: true,
        },
        { pubkey: canaryProgram, isSigner: false, isWritable: true },
        { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: executorAuthority, isSigner: true, isWritable: false },
      ],
      data: upgradeData,
    }),
  });

  const showAfter = programShow(canaryProgram);
  const dumpPath = resolve(runDirectory, `${canaryName}-dump.so`);
  run("solana", [
    "program",
    "dump",
    canaryProgram.toBase58(),
    relative(solanaDir, dumpPath),
    "--keypair",
    relative(solanaDir, walletPath),
    "--url",
    rpcUrl,
  ]);
  const dumpedHash = sha256(readFileSync(dumpPath));
  const registryAfter = await connection.getAccountInfo(
    registryAccount,
    "confirmed",
  );
  const registryStateHashAfter = sha256(registryAfter.data);
  if (
    showAfter.authority !== executorAuthority.toBase58() ||
    Number(showAfter.lastDeploySlot) <= Number(showBefore.lastDeploySlot) ||
    dumpedHash !== sourceHash ||
    registryStateHashAfter !== registryStateHashBefore ||
    (await connection.getAccountInfo(buffer.publicKey, "confirmed")) !== null
  ) {
    throw new Error(
      "governed program upgrade code, state, authority, or buffer invariant failed",
    );
  }

  const authorityHandoffs = [];
  for (const programName of programNames) {
    const program = client.programId(programName);
    const before = programShow(program);
    if (before.authority === executorAuthority.toBase58()) {
      authorityHandoffs.push({
        programName,
        program: program.toBase58(),
        previousAuthority: before.authority,
        authority: before.authority,
        signature: null,
      });
      continue;
    }
    if (before.authority !== wallet.publicKey.toBase58()) {
      throw new Error(
        `${programName} has unexpected upgrade authority ${before.authority}`,
      );
    }
    const result = JSON.parse(
      run("solana", [
        "program",
        "set-upgrade-authority",
        program.toBase58(),
        "--new-upgrade-authority",
        executorAuthority.toBase58(),
        "--skip-new-upgrade-authority-signer-check",
        "--upgrade-authority",
        relative(solanaDir, walletPath),
        "--keypair",
        relative(solanaDir, walletPath),
        "--url",
        rpcUrl,
        "--output",
        "json",
      ]),
    );
    const after = programShow(program);
    if (after.authority !== executorAuthority.toBase58()) {
      throw new Error(`${programName} upgrade authority handoff failed`);
    }
    authorityHandoffs.push({
      programName,
      program: program.toBase58(),
      previousAuthority: before.authority,
      authority: after.authority,
      signature: result.signature ?? result.transactionSignature ?? null,
    });
  }

  const finalAuthorities = programNames.map((programName) => {
    const program = client.programId(programName);
    const value = programShow(program);
    return {
      programName,
      program: program.toBase58(),
      authority: value.authority,
    };
  });
  if (
    finalAuthorities.some(
      (entry) => entry.authority !== executorAuthority.toBase58(),
    )
  ) {
    throw new Error("not all program upgrade authorities belong to governance");
  }

  const report = {
    generatedAt: new Date().toISOString(),
    cluster: "localnet",
    rpcUrl,
    genesisHash: await connection.getGenesisHash(),
    governance: {
      program: governanceProgram.toBase58(),
      config: governanceConfig.toBase58(),
      executorAuthority: executorAuthority.toBase58(),
      loaderProgram: BPF_LOADER_UPGRADEABLE_PROGRAM_ID.toBase58(),
      loaderTargetRecord: loaderTargetRecord.toBase58(),
      allowLoader,
      orphanBufferCleanup,
    },
    canary: {
      programName: canaryName,
      program: canaryProgram.toBase58(),
      programData: showAfter.programdataAddress,
      sourceHash,
      dumpedHash,
      stateAccount: registryAccount.toBase58(),
      stateHashBefore: registryStateHashBefore,
      stateHashAfter: registryStateHashAfter,
      deploySlotBefore: String(showBefore.lastDeploySlot),
      deploySlotAfter: String(showAfter.lastDeploySlot),
      authorityBefore: showBefore.authority,
      authorityAfter: showAfter.authority,
      writeBuffer,
      setBufferAuthority,
      setCanaryAuthority,
      unauthorizedDirectUpgrade: {
        rejected: true,
        error: unauthorizedSimulation.value.err,
        logTail: (unauthorizedSimulation.value.logs ?? []).slice(-4),
      },
      governedUpgrade,
      bufferClosed: true,
    },
    authorityHandoffs,
    finalAuthorities,
  };
  const reportPath = resolve(
    localDir,
    `localnet-governed-program-upgrade-${runId}.json`,
  );
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  process.stdout.write(
    `${JSON.stringify({ ...report, reportPath }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })}\n`,
  );
  process.exitCode = 1;
});
