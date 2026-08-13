import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";

import {
  TOKEN_PROGRAM,
  createLocalGovernanceClient,
} from "./localnet-governance-client.mjs";

const sdkDir = dirname(fileURLToPath(import.meta.url));
const solanaDir = resolve(sdkDir, "..");
const localDir = resolve(
  process.env.SOLANA_LOCAL_STATE_DIR ?? resolve(solanaDir, ".local"),
);
const rpcUrl = process.env.SOLANA_LOCAL_RPC_URL ?? "http://127.0.0.1:8899";

function writeKeypair(path, keypair) {
  writeFileSync(path, `${JSON.stringify(Array.from(keypair.secretKey))}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function runSplToken(args, walletPath) {
  const result = spawnSync(
    "spl-token",
    ["--url", rpcUrl, "--fee-payer", walletPath, ...args],
    {
      cwd: solanaDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `spl-token ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

function tokenAmount(data) {
  if (data.length < 72) throw new Error("token account data is too short");
  return data.readBigUInt64LE(64);
}

async function expectFailure(action, label) {
  try {
    await action();
  } catch (error) {
    return {
      rejected: true,
      reason:
        error instanceof Error
          ? error.message.split("\n")[0].slice(0, 240)
          : String(error).slice(0, 240),
    };
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function main() {
  if (
    process.env.SOLANA_LOCAL_GOVERNED_TREASURY_CONFIRM !==
    "LOCALNET_GOVERNED_TREASURY_REAL_ASSETS"
  ) {
    throw new Error(
      "governed treasury smoke requires SOLANA_LOCAL_GOVERNED_TREASURY_CONFIRM=LOCALNET_GOVERNED_TREASURY_REAL_ASSETS",
    );
  }

  const client = await createLocalGovernanceClient();
  const {
    connection,
    wallet,
    walletPath,
    executorAuthority,
    state,
  } = client;
  const treasuryConfig = new PublicKey(state.addresses.treasuryConfig);
  const treasuryVault = new PublicKey(state.addresses.treasuryVault);
  const tokenMint = new PublicKey(state.mints.dc);
  const treasuryTokenAccounts = await connection.getTokenAccountsByOwner(
    treasuryVault,
    { mint: tokenMint },
    "confirmed",
  );
  const fundedTreasuryTokenAccount = treasuryTokenAccounts.value.find(
    ({ account }) => tokenAmount(account.data) > 0n,
  );
  if (!fundedTreasuryTokenAccount) {
    throw new Error("production treasury has no funded DC-token account");
  }
  const treasuryToken = fundedTreasuryTokenAccount.pubkey;
  const recipient = Keypair.generate();
  const recipientToken = Keypair.generate();
  const runId = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const runDir = resolve(localDir, `governed-treasury-smoke-${runId}`);
  mkdirSync(runDir, { recursive: false });
  const recipientTokenPath = resolve(runDir, "recipient-token.json");
  writeKeypair(recipientTokenPath, recipientToken);
  runSplToken(
    [
      "create-account",
      tokenMint.toBase58(),
      relative(solanaDir, recipientTokenPath),
      "--owner",
      recipient.publicKey.toBase58(),
      "--output",
      "json",
    ],
    relative(solanaDir, walletPath),
  );

  const nativeFundAmount = BigInt(LAMPORTS_PER_SOL);
  const nativePayAmount = 250_000_000n;
  const vaultNativeBefore = await connection.getBalance(
    treasuryVault,
    "confirmed",
  );
  const recipientNativeBefore = await connection.getBalance(
    recipient.publicKey,
    "confirmed",
  );
  const fundNative = await client.send(
    client.buildInstruction(
      "deal_protocol_treasury",
      "fund_native",
      { amount: nativeFundAmount },
      {
        funder: wallet.publicKey,
        vault_authority: treasuryVault,
        config: treasuryConfig,
        system_program: SystemProgram.programId,
      },
    ),
  );

  const unauthorizedDirectPay = await expectFailure(
    () =>
      client.send(
        client.buildInstruction(
          "deal_protocol_treasury",
          "pay_native",
          { amount: 1n },
          {
            controller: wallet.publicKey,
            config: treasuryConfig,
            vault_authority: treasuryVault,
            recipient: recipient.publicKey,
            system_program: SystemProgram.programId,
          },
        ),
      ),
    "direct wallet treasury payment",
  );
  const governedNativePay = await client.executeGovernance({
    programName: "deal_protocol_treasury",
    instructionName: "pay_native",
    args: { amount: nativePayAmount },
    accounts: {
      controller: executorAuthority,
      config: treasuryConfig,
      vault_authority: treasuryVault,
      recipient: recipient.publicKey,
      system_program: SystemProgram.programId,
    },
  });

  const tokenPayAmount = 100n;
  const sourceBeforeInfo = await connection.getAccountInfo(
    treasuryToken,
    "confirmed",
  );
  if (!sourceBeforeInfo || !sourceBeforeInfo.owner.equals(TOKEN_PROGRAM)) {
    throw new Error("production treasury DC-token vault is missing");
  }
  const sourceBefore = tokenAmount(sourceBeforeInfo.data);
  if (sourceBefore < tokenPayAmount) {
    throw new Error("production treasury DC-token vault is underfunded");
  }
  const governedTokenPay = await client.executeGovernance({
    programName: "deal_protocol_treasury",
    instructionName: "pay_token",
    args: { amount: tokenPayAmount },
    accounts: {
      controller: executorAuthority,
      config: treasuryConfig,
      vault_authority: treasuryVault,
      source: treasuryToken,
      destination: recipientToken.publicKey,
      mint: tokenMint,
      token_program: TOKEN_PROGRAM,
    },
  });

  const [vaultNativeAfter, recipientNativeAfter, sourceAfterInfo, destinationInfo] =
    await Promise.all([
      connection.getBalance(treasuryVault, "confirmed"),
      connection.getBalance(recipient.publicKey, "confirmed"),
      connection.getAccountInfo(treasuryToken, "confirmed"),
      connection.getAccountInfo(recipientToken.publicKey, "confirmed"),
    ]);
  if (!sourceAfterInfo || !destinationInfo) {
    throw new Error("governed token payment accounts are missing");
  }
  const sourceAfter = tokenAmount(sourceAfterInfo.data);
  const destinationAfter = tokenAmount(destinationInfo.data);
  if (
    BigInt(vaultNativeAfter - vaultNativeBefore) !==
      nativeFundAmount - nativePayAmount ||
    BigInt(recipientNativeAfter - recipientNativeBefore) !== nativePayAmount ||
    sourceBefore - sourceAfter !== tokenPayAmount ||
    destinationAfter !== tokenPayAmount
  ) {
    throw new Error("governed treasury balance deltas are incorrect");
  }

  const report = {
    generatedAt: new Date().toISOString(),
    cluster: "localnet",
    rpcUrl,
    controller: executorAuthority.toBase58(),
    config: treasuryConfig.toBase58(),
    vault: treasuryVault.toBase58(),
    native: {
      fundNative,
      governedNativePay,
      fundedLamports: nativeFundAmount.toString(),
      paidLamports: nativePayAmount.toString(),
      recipientDeltaLamports: (recipientNativeAfter - recipientNativeBefore).toString(),
    },
    token: {
      mint: tokenMint.toBase58(),
      source: treasuryToken.toBase58(),
      destination: recipientToken.publicKey.toBase58(),
      governedTokenPay,
      paidBaseUnits: tokenPayAmount.toString(),
      sourceDeltaBaseUnits: (sourceBefore - sourceAfter).toString(),
      destinationBalanceBaseUnits: destinationAfter.toString(),
    },
    security: { unauthorizedDirectPay },
  };
  const reportPath = resolve(
    localDir,
    `localnet-governed-treasury-${runId}.json`,
  );
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
