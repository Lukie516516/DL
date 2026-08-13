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
  ASSOCIATED_TOKEN_PROGRAM,
  TOKEN_PROGRAM,
  associatedToken,
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

function splToken(args, walletPath) {
  return run("spl-token", [
    "--url",
    rpcUrl,
    "--fee-payer",
    relative(solanaDir, walletPath),
    ...args,
  ]);
}

function decodeTokenAccount(data) {
  return {
    mint: new PublicKey(data.subarray(0, 32)),
    owner: new PublicKey(data.subarray(32, 64)),
    amount: data.readBigUInt64LE(64),
  };
}

function decodePair(data) {
  return {
    reserve0: data.readBigUInt64LE(200),
    reserve1: data.readBigUInt64LE(208),
    virtualReserve0: data.readBigUInt64LE(216),
    virtualReserve1: data.readBigUInt64LE(224),
    feeNumerator: data.readUInt32LE(272),
    feeDenominator: data.readUInt32LE(276),
    virtual0Enabled: data[280] !== 0,
    virtual1Enabled: data[281] !== 0,
    liquidityInitialized: data[282] !== 0,
  };
}

async function expectFailure(action, label) {
  try {
    await action();
  } catch (error) {
    return {
      rejected: true,
      reason:
        error instanceof Error
          ? error.message.split("\n")[0].slice(0, 320)
          : String(error).slice(0, 320),
    };
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function main() {
  if (process.env.SOLANA_LOCAL_DEX_CONFIRM !== "LOCALNET_DEX_REAL_ASSETS") {
    throw new Error(
      "DEX smoke requires SOLANA_LOCAL_DEX_CONFIRM=LOCALNET_DEX_REAL_ASSETS",
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
  const runId = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const runDir = resolve(localDir, `dex-smoke-${runId}`);
  mkdirSync(runDir, { recursive: false });
  const user = Keypair.generate();
  const executorDc = Keypair.generate();
  const executorStable = Keypair.generate();
  const userDc = Keypair.generate();
  const userStable = Keypair.generate();
  const keypairs = {
    user,
    executorDc,
    executorStable,
    userDc,
    userStable,
  };
  const paths = {};
  for (const [name, keypair] of Object.entries(keypairs)) {
    const path = resolve(runDir, `${name}.json`);
    writeKeypair(path, keypair);
    paths[name] = path;
  }

  const dcMint = new PublicKey(state.mints.dc);
  const stableMint = new PublicKey(state.mints.stable0);
  const dcConfig = new PublicKey(state.addresses.dcConfig);
  const dexConfig = new PublicKey(state.addresses.dexConfig);
  const pair = PublicKey.findProgramAddressSync(
    [Buffer.from("dex-pair"), stableMint.toBuffer()],
    client.programId("deal_dex_pair"),
  )[0];
  const vault0 = associatedToken(pair, dcMint);
  const vault1 = associatedToken(pair, stableMint);
  const grant = PublicKey.findProgramAddressSync(
    [Buffer.from("dc-minter"), wallet.publicKey.toBuffer()],
    client.programId("deal_dc_controller"),
  )[0];

  const airdrop = await connection.requestAirdrop(
    user.publicKey,
    LAMPORTS_PER_SOL,
  );
  await connection.confirmTransaction(airdrop, "confirmed");
  const executorBalance = await connection.getBalance(
    executorAuthority,
    "confirmed",
  );
  if (executorBalance < 500_000_000) {
    await client.send(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: executorAuthority,
        lamports: 500_000_000 - executorBalance,
      }),
    );
  }

  const createTokenAccount = (mint, accountPath, owner) =>
    splToken(
      [
        "create-account",
        mint.toBase58(),
        relative(solanaDir, accountPath),
        "--owner",
        owner.toBase58(),
        "--output",
        "json",
      ],
      walletPath,
    );
  createTokenAccount(dcMint, paths.executorDc, executorAuthority);
  createTokenAccount(stableMint, paths.executorStable, executorAuthority);
  createTokenAccount(dcMint, paths.userDc, user.publicKey);
  createTokenAccount(stableMint, paths.userStable, user.publicKey);

  splToken(
    [
      "mint",
      stableMint.toBase58(),
      "1000000",
      executorStable.publicKey.toBase58(),
      "--mint-authority",
      relative(solanaDir, walletPath),
      "--output",
      "json",
    ],
    walletPath,
  );
  splToken(
    [
      "mint",
      stableMint.toBase58(),
      "1000",
      userStable.publicKey.toBase58(),
      "--mint-authority",
      relative(solanaDir, walletPath),
      "--output",
      "json",
    ],
    walletPath,
  );

  const governance = {};
  let temporaryMinterGranted = false;
  let primaryError;
  try {
    governance.grantTemporaryMinter = await client.executeGovernance({
      programName: "deal_dc_controller",
      instructionName: "set_minter",
      args: { enabled: true },
      accounts: {
        authority: executorAuthority,
        config: dcConfig,
        minter: wallet.publicKey,
        grant,
        system_program: SystemProgram.programId,
      },
    });
    temporaryMinterGranted = true;

    const mintDc = (amount) =>
      client.send(
        client.buildInstruction(
          "deal_dc_controller",
          "mint",
          { amount },
          {
            config: dcConfig,
            minter: wallet.publicKey,
            grant,
            dc_mint: dcMint,
            destination: executorDc.publicKey,
            dc_token_program: TOKEN_PROGRAM,
          },
        ),
      );
    const mintSignature = await mintDc(1_000_000_000_000n);

    const pairBeforeInfo = await connection.getAccountInfo(pair, "confirmed");
    const pairBefore = decodePair(pairBeforeInfo.data);
    if (pairBefore.liquidityInitialized) {
      throw new Error("stable0 pair was unexpectedly already initialized");
    }
    governance.initializeLiquidity = await client.executeGovernance({
      programName: "deal_dex_pair",
      instructionName: "initialize_liquidity",
      args: {
        amount0: 1_000_000_000_000n,
        amount1: 1_000_000_000_000n,
      },
      accounts: {
        authority: executorAuthority,
        config: dexConfig,
        pair,
        source0: executorDc.publicKey,
        source1: executorStable.publicKey,
        dc_mint: dcMint,
        other_mint: stableMint,
        vault0,
        vault1,
        dc_token_program: TOKEN_PROGRAM,
        other_token_program: TOKEN_PROGRAM,
      },
    });

    const beforeInfos = await connection.getMultipleAccountsInfo(
      [userDc.publicKey, userStable.publicKey, vault0, vault1],
      "confirmed",
    );
    const before = beforeInfos.map((info) => decodeTokenAccount(info.data));
    const slippageRejected = await expectFailure(
      () =>
        client.send(
          client.buildInstruction(
            "deal_dex_pair",
            "swap_buy_dc",
            {
              amount1_in: 10_000_000n,
              minimum0_out: 1_000_000_000_000n,
            },
            {
              user: user.publicKey,
              config: dexConfig,
              pair,
              user_other: userStable.publicKey,
              user_dc: userDc.publicKey,
              dc_mint: dcMint,
              other_mint: stableMint,
              vault0,
              vault1,
              dc_token_program: TOKEN_PROGRAM,
              other_token_program: TOKEN_PROGRAM,
            },
          ),
          user,
        ),
      "DEX impossible minimum output",
    );
    const swapSignature = await client.send(
      client.buildInstruction(
        "deal_dex_pair",
        "swap_buy_dc",
        { amount1_in: 10_000_000n, minimum0_out: 1n },
        {
          user: user.publicKey,
          config: dexConfig,
          pair,
          user_other: userStable.publicKey,
          user_dc: userDc.publicKey,
          dc_mint: dcMint,
          other_mint: stableMint,
          vault0,
          vault1,
          dc_token_program: TOKEN_PROGRAM,
          other_token_program: TOKEN_PROGRAM,
        },
      ),
      user,
    );
    const afterInfos = await connection.getMultipleAccountsInfo(
      [userDc.publicKey, userStable.publicKey, vault0, vault1],
      "confirmed",
    );
    const after = afterInfos.map((info) => decodeTokenAccount(info.data));
    const pairAfter = decodePair(
      (await connection.getAccountInfo(pair, "confirmed")).data,
    );
    if (
      after[0].amount <= before[0].amount ||
      before[1].amount - after[1].amount !== 10_000_000n ||
      after[2].amount >= before[2].amount ||
      after[3].amount - before[3].amount !== 10_000_000n ||
      !pairAfter.liquidityInitialized ||
      pairAfter.reserve0 !== after[2].amount ||
      pairAfter.reserve1 !== after[3].amount
    ) {
      throw new Error("real DEX swap balances or reserves are inconsistent");
    }

    governance.revokeTemporaryMinter = await client.executeGovernance({
      programName: "deal_dc_controller",
      instructionName: "set_minter",
      args: { enabled: false },
      accounts: {
        authority: executorAuthority,
        config: dcConfig,
        minter: wallet.publicKey,
        grant,
        system_program: SystemProgram.programId,
      },
    });
    temporaryMinterGranted = false;
    const revokedMinterRejected = await expectFailure(
      () => mintDc(1n),
      "revoked temporary DC minter",
    );

    const report = {
      generatedAt: new Date().toISOString(),
      cluster: "localnet",
      rpcUrl,
      genesisHash: await connection.getGenesisHash(),
      executorAuthority: executorAuthority.toBase58(),
      pair: pair.toBase58(),
      dcMint: dcMint.toBase58(),
      stableMint: stableMint.toBase58(),
      vault0: vault0.toBase58(),
      vault1: vault1.toBase58(),
      pairBefore: {
        reserve0: pairBefore.reserve0.toString(),
        reserve1: pairBefore.reserve1.toString(),
        liquidityInitialized: pairBefore.liquidityInitialized,
      },
      pairAfter: {
        reserve0: pairAfter.reserve0.toString(),
        reserve1: pairAfter.reserve1.toString(),
        feeNumerator: pairAfter.feeNumerator,
        feeDenominator: pairAfter.feeDenominator,
        liquidityInitialized: pairAfter.liquidityInitialized,
      },
      user: {
        address: user.publicKey.toBase58(),
        dcBefore: before[0].amount.toString(),
        dcAfter: after[0].amount.toString(),
        stableBefore: before[1].amount.toString(),
        stableAfter: after[1].amount.toString(),
      },
      governance,
      signatures: {
        mintDc: mintSignature,
        swap: swapSignature,
      },
      rejectedBranches: {
        impossibleMinimumOutput: slippageRejected,
        revokedMinter: revokedMinterRejected,
      },
    };
    const reportPath = resolve(localDir, `localnet-dex-${runId}.json`);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    });
    process.stdout.write(
      `${JSON.stringify({ ...report, reportPath }, null, 2)}\n`,
    );
  } catch (error) {
    primaryError = error;
  } finally {
    if (temporaryMinterGranted) {
      try {
        governance.emergencyRevokeTemporaryMinter =
          await client.executeGovernance({
            programName: "deal_dc_controller",
            instructionName: "set_minter",
            args: { enabled: false },
            accounts: {
              authority: executorAuthority,
              config: dcConfig,
              minter: wallet.publicKey,
              grant,
              system_program: SystemProgram.programId,
            },
          });
      } catch (revokeError) {
        throw new AggregateError(
          [primaryError, revokeError].filter(Boolean),
          "DEX smoke failed and temporary minter revocation also failed",
        );
      }
    }
  }
  if (primaryError) throw primaryError;
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
