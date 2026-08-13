import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
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

function loadKeypair(path) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
  );
}

function latestNamed(prefix) {
  const names = readdirSync(localDir)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse();
  if (names.length === 0) throw new Error(`${prefix} artifact is missing`);
  return resolve(localDir, names[0]);
}

function u64(value) {
  const output = Buffer.alloc(8);
  output.writeBigUInt64LE(BigInt(value));
  return output;
}

function decodeTokenAccount(info) {
  if (!info) throw new Error("token account is missing");
  return {
    mint: new PublicKey(info.data.subarray(0, 32)),
    owner: new PublicKey(info.data.subarray(32, 64)),
    amount: info.data.readBigUInt64LE(64),
  };
}

function decodeCoreRegistry(info) {
  if (!info) throw new Error("core registry is missing");
  return {
    domainEntryController: new PublicKey(info.data.subarray(136, 168)),
    nextDealId: info.data.readBigUInt64LE(168),
    paused: info.data[184] !== 0,
  };
}

function decodeDeal(info) {
  if (!info) throw new Error("Deal is missing");
  return {
    id: info.data.readBigUInt64LE(8),
    creator: new PublicKey(info.data.subarray(16, 48)),
    participant: new PublicKey(info.data.subarray(48, 80)),
    expectedParticipant: new PublicKey(info.data.subarray(80, 112)),
    templateType: info.data[144],
    joinMode: info.data[146],
    status: info.data[147],
    isDomainDeal: info.data[158] !== 0,
  };
}

function decodeBinding(info) {
  if (!info) throw new Error("domain binding is missing");
  return {
    domain: new PublicKey(info.data.subarray(8, 40)),
    deal: new PublicKey(info.data.subarray(40, 72)),
    creator: new PublicKey(info.data.subarray(72, 104)),
    pickedCounterparty: new PublicKey(info.data.subarray(104, 136)),
    deferredHall: info.data[136] !== 0,
    requireIdentity: info.data[137] !== 0,
  };
}

function decodeStats(info) {
  if (!info) throw new Error("domain stats are missing");
  return {
    domain: new PublicKey(info.data.subarray(8, 40)),
    dealCount: info.data.readBigUInt64LE(40),
    tradeVolume: info.data.readBigUInt64LE(48),
    holderRewardsPending: info.data.readBigUInt64LE(56),
    fixedHourlyRate: info.data.readBigUInt64LE(64),
    domainMinDeposit: info.data.readBigUInt64LE(72),
  };
}

function decodeRankEntry(info) {
  if (!info) throw new Error("rank entry is missing");
  return {
    domain: new PublicKey(info.data.subarray(8, 40)),
    deal: new PublicKey(info.data.subarray(40, 72)),
    merchant: new PublicKey(info.data.subarray(72, 104)),
    reportedVolume: info.data.readBigUInt64LE(104),
    depositedDc: info.data.readBigUInt64LE(112),
    totalConsumed: info.data.readBigUInt64LE(120),
    joinedAt: info.data.readBigInt64LE(128),
    hourlyRate: info.data.readBigUInt64LE(136),
    lastDepositAt: info.data.readBigInt64LE(144),
    lastDepositAmount: info.data.readBigUInt64LE(152),
    lastDepositBase: info.data.readBigUInt64LE(160),
    active: info.data[168] !== 0,
    closed: info.data[169] !== 0,
    volumeCounted: info.data[170] !== 0,
    initialized: info.data[171] !== 0,
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

async function createLookupTable(client, authority, addresses) {
  const recentSlot = await client.connection.getSlot("finalized");
  const [createInstruction, lookupTable] =
    AddressLookupTableProgram.createLookupTable({
      authority: authority.publicKey,
      payer: authority.publicKey,
      recentSlot,
    });
  const createSignature = await client.send(createInstruction, authority);
  const extendSignature = await client.send(
    AddressLookupTableProgram.extendLookupTable({
      payer: authority.publicKey,
      authority: authority.publicKey,
      lookupTable,
      addresses: addresses.filter(
        (address, index, all) =>
          all.findIndex((candidate) => candidate.equals(address)) === index,
      ),
    }),
    authority,
  );
  let account;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await client.connection.getAddressLookupTable(
      lookupTable,
      { commitment: "confirmed" },
    );
    const currentSlot = await client.connection.getSlot("confirmed");
    if (
      result.value &&
      currentSlot > Number(result.value.state.lastExtendedSlot)
    ) {
      account = result.value;
      break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  if (!account) {
    throw new Error("address lookup table did not become active");
  }
  return {
    address: lookupTable,
    account,
    createSignature,
    extendSignature,
  };
}

async function sendV0(connection, payer, instruction, lookupTable) {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [instruction],
  }).compileToV0Message([lookupTable]);
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);
  const serialized = transaction.serialize();
  if (serialized.length > 1_232) {
    throw new Error(
      `v0 transaction remains too large: ${serialized.length} > 1232`,
    );
  }
  const simulation = await connection.simulateTransaction(transaction, {
    commitment: "confirmed",
    sigVerify: true,
  });
  if (simulation.value.err) {
    throw new Error(
      `v0 simulation failed (${serialized.length} bytes): ${JSON.stringify(
        simulation.value.err,
      )}; ${(simulation.value.logs ?? []).slice(-12).join(" | ")}`,
    );
  }
  const signature = await connection.sendRawTransaction(serialized, {
    skipPreflight: true,
    maxRetries: 150,
  });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = (
      await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (status?.err) {
      throw new Error(
        `v0 transaction ${signature} failed: ${JSON.stringify(status.err)}`,
      );
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return signature;
    }
    if ((await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      break;
    }
    if (attempt > 0 && attempt % 8 === 0) {
      await connection.sendRawTransaction(serialized, {
        skipPreflight: true,
        maxRetries: 150,
      });
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `v0 transaction ${signature} (${serialized.length} bytes) was not confirmed before blockheight expiry`,
  );
}

async function main() {
  if (
    process.env.SOLANA_LOCAL_ENTRY_CONFIRM !==
    "LOCALNET_DOMAIN_ENTRY_RANK_REAL_ASSETS"
  ) {
    throw new Error(
      "entry smoke requires SOLANA_LOCAL_ENTRY_CONFIRM=LOCALNET_DOMAIN_ENTRY_RANK_REAL_ASSETS",
    );
  }

  const client = await createLocalGovernanceClient();
  const { connection, state } = client;
  const domainReportPath = latestNamed("localnet-domain-market-");
  const domainReport = JSON.parse(readFileSync(domainReportPath, "utf8"));
  const runDirectory = latestNamed("domain-market-smoke-");
  for (const name of ["seller", "buyer", "outsider", "sellerDc"]) {
    if (!existsSync(resolve(runDirectory, `${name}.json`))) {
      throw new Error(`domain smoke key ${name} is missing`);
    }
  }
  const seller = loadKeypair(resolve(runDirectory, "seller.json"));
  const buyer = loadKeypair(resolve(runDirectory, "buyer.json"));
  const outsider = loadKeypair(resolve(runDirectory, "outsider.json"));
  const sellerDc = loadKeypair(resolve(runDirectory, "sellerDc.json"));
  if (
    domainReport.genesisHash !== (await connection.getGenesisHash()) ||
    seller.publicKey.toBase58() !== domainReport.participants.seller ||
    buyer.publicKey.toBase58() !== domainReport.participants.buyer ||
    outsider.publicKey.toBase58() !== domainReport.participants.outsider
  ) {
    throw new Error("domain report, keys, and running Localnet do not match");
  }

  const domain = new PublicKey(domainReport.domain.address);
  const dcMint = new PublicKey(state.mints.dc);
  const stableMint = new PublicKey(state.mints.stable0);
  const entryConfig = new PublicKey(state.addresses.domainEntryConfig);
  const coreRegistry = new PublicKey(state.addresses.coreRegistry);
  const assetConfig = new PublicKey(state.addresses.assetConfig);
  const rankConfig = new PublicKey(state.addresses.domainRankConfig);
  const rankVault = new PublicKey(state.addresses.domainRankVault);
  const coreProgram = client.programId("deal_core");
  const assetProgram = client.programId("deal_asset_controller");
  const rankProgram = client.programId("deal_domain_rank");
  const entryProgram = client.programId("deal_domain_entry");
  const registryBefore = decodeCoreRegistry(
    await connection.getAccountInfo(coreRegistry, "confirmed"),
  );
  if (
    registryBefore.paused ||
    !registryBefore.domainEntryController.equals(entryConfig)
  ) {
    throw new Error("core/domain-entry production topology is inconsistent");
  }

  const dealId = registryBefore.nextDealId;
  const deal = PublicKey.findProgramAddressSync(
    [Buffer.from("deal"), u64(dealId)],
    coreProgram,
  )[0];
  const assetTerms = PublicKey.findProgramAddressSync(
    [Buffer.from("asset-terms"), deal.toBuffer()],
    assetProgram,
  )[0];
  const binding = PublicKey.findProgramAddressSync(
    [Buffer.from("domain-deal-binding"), deal.toBuffer()],
    entryProgram,
  )[0];
  const rankStats = PublicKey.findProgramAddressSync(
    [Buffer.from("domain-rank-stats"), domain.toBuffer()],
    rankProgram,
  )[0];
  const rankEntry = PublicKey.findProgramAddressSync(
    [
      Buffer.from("domain-rank-entry"),
      domain.toBuffer(),
      deal.toBuffer(),
    ],
    rankProgram,
  )[0];
  const sellerBlacklist = PublicKey.findProgramAddressSync(
    [
      Buffer.from("domain-rank-blacklist"),
      domain.toBuffer(),
      seller.publicKey.toBuffer(),
    ],
    rankProgram,
  )[0];
  const outsiderBlacklist = PublicKey.findProgramAddressSync(
    [
      Buffer.from("domain-rank-blacklist"),
      domain.toBuffer(),
      outsider.publicKey.toBuffer(),
    ],
    rankProgram,
  )[0];
  const reporterGrant = PublicKey.findProgramAddressSync(
    [Buffer.from("domain-rank-reporter"), entryConfig.toBuffer()],
    rankProgram,
  )[0];

  const none = {
    kind: "None",
    mint: PublicKey.default,
    vault: PublicKey.default,
  };
  const params = {
    deal_id: dealId,
    template_type: "TokenToEmpty",
    expected_participant: PublicKey.default,
    require_identity: true,
    deferred_hall: true,
    a_swap_amount: 750n,
    a_margin_amount: 0n,
    b_swap_amount: 0n,
    b_margin_amount: 0n,
    title: "Localnet deferred domain Deal",
    description: "Mainnet-parity domain entry and rank smoke",
    timeout_seconds: 0n,
    replace_timeout_seconds: 0n,
    asset_terms: {
      a_swap: {
        kind: "Spl",
        mint: stableMint,
        vault: Keypair.generate().publicKey,
      },
      a_margin: none,
      b_swap: none,
      b_margin: none,
      a_asset_nft: none,
      b_asset_nft: none,
    },
  };
  const createInstruction = (input) =>
    client.buildInstruction(
      "deal_domain_entry",
      "create_domain_deal",
      { params: input },
      {
        config: entryConfig,
        creator: seller.publicKey,
        domain,
        blacklist: sellerBlacklist,
        core_program: coreProgram,
        core_registry: coreRegistry,
        deal,
        asset_program: assetProgram,
        asset_config: assetConfig,
        asset_terms: assetTerms,
        rank_program: rankProgram,
        rank_config: rankConfig,
        rank_reporter_grant: reporterGrant,
        rank_stats: rankStats,
        rank_entry: rankEntry,
        binding,
        system_program: SystemProgram.programId,
      },
    );
  const lookupTable = await createLookupTable(client, seller, [
    entryConfig,
    domain,
    sellerBlacklist,
    coreProgram,
    coreRegistry,
    deal,
    assetProgram,
    assetConfig,
    assetTerms,
    rankProgram,
    rankConfig,
    reporterGrant,
    rankStats,
    rankEntry,
    binding,
    SystemProgram.programId,
  ]);

  const invalidDirectTemplateRejected = await expectFailure(
    () =>
      sendV0(
        connection,
        seller,
        createInstruction({ ...params, deferred_hall: false }),
        lookupTable.account,
      ),
    "non-token-to-token direct domain Deal",
  );
  const createSignature = await sendV0(
    connection,
    seller,
    createInstruction(params),
    lookupTable.account,
  );
  const createdInfos = await connection.getMultipleAccountsInfo(
    [coreRegistry, deal, assetTerms, binding, rankStats, rankEntry],
    "confirmed",
  );
  const registryAfterCreate = decodeCoreRegistry(createdInfos[0]);
  const createdDeal = decodeDeal(createdInfos[1]);
  const createdBinding = decodeBinding(createdInfos[3]);
  const createdStats = decodeStats(createdInfos[4]);
  const createdEntry = decodeRankEntry(createdInfos[5]);
  if (
    registryAfterCreate.nextDealId !== dealId + 1n ||
    !createdInfos[2] ||
    createdDeal.id !== dealId ||
    createdDeal.templateType !== 2 ||
    createdDeal.joinMode !== 2 ||
    createdDeal.status !== 0 ||
    !createdDeal.isDomainDeal ||
    !createdBinding.deferredHall ||
    !createdBinding.requireIdentity ||
    createdStats.dealCount < 1n ||
    createdEntry.reportedVolume !== 750n ||
    !createdEntry.initialized ||
    createdEntry.active
  ) {
    throw new Error("domain Deal creation, binding, terms, or rank report failed");
  }

  const confirmInstruction = (creator, pickedCounterparty) =>
    client.buildInstruction(
      "deal_domain_entry",
      "confirm_hall_counterparty",
      { picked_counterparty: pickedCounterparty },
      {
        config: entryConfig,
        creator: creator.publicKey,
        domain,
        picked_blacklist: outsiderBlacklist,
        core_program: coreProgram,
        deal,
        binding,
      },
    );
  const nonCreatorConfirmRejected = await expectFailure(
    () =>
      client.send(
        confirmInstruction(buyer, outsider.publicKey),
        buyer,
      ),
    "non-creator hall confirmation",
  );
  const selfPickRejected = await expectFailure(
    () =>
      client.send(
        confirmInstruction(seller, seller.publicKey),
        seller,
      ),
    "creator self pick",
  );

  const blacklistInstruction = (banned) =>
    client.buildInstruction(
      "deal_domain_rank",
      "set_blacklisted",
      { banned },
      {
        config: rankConfig,
        owner: seller.publicKey,
        domain,
        user: outsider.publicKey,
        blacklist: outsiderBlacklist,
        system_program: SystemProgram.programId,
      },
    );
  const blacklistSignature = await client.send(
    blacklistInstruction(true),
    seller,
  );
  const blacklistedPickRejected = await expectFailure(
    () =>
      client.send(
        confirmInstruction(seller, outsider.publicKey),
        seller,
      ),
    "blacklisted hall counterparty",
  );
  const unblacklistSignature = await client.send(
    blacklistInstruction(false),
    seller,
  );
  const confirmSignature = await client.send(
    confirmInstruction(seller, outsider.publicKey),
    seller,
  );
  const repeatedConfirmRejected = await expectFailure(
    () =>
      client.send(
        confirmInstruction(seller, outsider.publicKey),
        seller,
      ),
    "repeated hall confirmation",
  );
  const confirmedInfos = await connection.getMultipleAccountsInfo(
    [deal, binding],
    "confirmed",
  );
  const confirmedDeal = decodeDeal(confirmedInfos[0]);
  const confirmedBinding = decodeBinding(confirmedInfos[1]);
  if (
    confirmedDeal.joinMode !== 3 ||
    !confirmedDeal.expectedParticipant.equals(outsider.publicKey) ||
    confirmedBinding.deferredHall ||
    !confirmedBinding.pickedCounterparty.equals(outsider.publicKey)
  ) {
    throw new Error("hall counterparty confirmation did not update Deal/binding");
  }

  const nonOwnerPolicyRejected = await expectFailure(
    () =>
      client.send(
        client.buildInstruction(
          "deal_domain_rank",
          "set_domain_policy",
          { fixed_hourly_rate: 0n, domain_min_deposit: 500n },
          {
            config: rankConfig,
            owner: buyer.publicKey,
            domain,
            stats: rankStats,
            system_program: SystemProgram.programId,
          },
        ),
        buyer,
      ),
    "non-owner domain rank policy",
  );
  const policySignature = await client.send(
    client.buildInstruction(
      "deal_domain_rank",
      "set_domain_policy",
      { fixed_hourly_rate: 0n, domain_min_deposit: 500n },
      {
        config: rankConfig,
        owner: seller.publicKey,
        domain,
        stats: rankStats,
        system_program: SystemProgram.programId,
      },
    ),
    seller,
  );

  const depositInstruction = (amount) =>
    client.buildInstruction(
      "deal_domain_rank",
      "deposit",
      { amount },
      {
        config: rankConfig,
        merchant: seller.publicKey,
        domain,
        deal,
        stats: rankStats,
        entry: rankEntry,
        blacklist: sellerBlacklist,
        merchant_dc: sellerDc.publicKey,
        vault: rankVault,
        dc_mint: dcMint,
        dc_token_program: TOKEN_PROGRAM,
        system_program: SystemProgram.programId,
      },
    );
  const belowMinimumRejected = await expectFailure(
    () => client.send(depositInstruction(499n), seller),
    "below-minimum rank deposit",
  );
  const balancesBeforeDeposit = await connection.getMultipleAccountsInfo(
    [sellerDc.publicKey, rankVault],
    "confirmed",
  );
  const sellerBeforeDeposit = decodeTokenAccount(
    balancesBeforeDeposit[0],
  ).amount;
  const vaultBeforeDeposit = decodeTokenAccount(
    balancesBeforeDeposit[1],
  ).amount;
  const depositSignature = await client.send(
    depositInstruction(1_000n),
    seller,
  );
  const balancesAfterDeposit = await connection.getMultipleAccountsInfo(
    [sellerDc.publicKey, rankVault, rankEntry, rankStats],
    "confirmed",
  );
  const sellerAfterDeposit = decodeTokenAccount(
    balancesAfterDeposit[0],
  ).amount;
  const vaultAfterDeposit = decodeTokenAccount(
    balancesAfterDeposit[1],
  ).amount;
  const depositedEntry = decodeRankEntry(balancesAfterDeposit[2]);
  const policyStats = decodeStats(balancesAfterDeposit[3]);
  if (
    sellerBeforeDeposit - sellerAfterDeposit !== 1_000n ||
    vaultAfterDeposit - vaultBeforeDeposit !== 1_000n ||
    depositedEntry.depositedDc !== 1_000n ||
    !depositedEntry.active ||
    depositedEntry.lastDepositAmount !== 1_000n ||
    policyStats.domainMinDeposit !== 500n ||
    policyStats.fixedHourlyRate !== 0n
  ) {
    throw new Error("rank deposit or policy invariant failed");
  }

  const withdrawSignature = await client.send(
    client.buildInstruction(
      "deal_domain_rank",
      "withdraw_deposit",
      {},
      {
        config: rankConfig,
        merchant: seller.publicKey,
        domain,
        deal,
        stats: rankStats,
        entry: rankEntry,
        merchant_dc: sellerDc.publicKey,
        vault: rankVault,
        dc_mint: dcMint,
        dc_token_program: TOKEN_PROGRAM,
      },
    ),
    seller,
  );
  const finalInfos = await connection.getMultipleAccountsInfo(
    [sellerDc.publicKey, rankVault, rankEntry, rankStats],
    "confirmed",
  );
  const sellerFinal = decodeTokenAccount(finalInfos[0]).amount;
  const vaultFinal = decodeTokenAccount(finalInfos[1]).amount;
  const finalEntry = decodeRankEntry(finalInfos[2]);
  const finalStats = decodeStats(finalInfos[3]);
  if (
    sellerFinal !== sellerBeforeDeposit ||
    vaultFinal !== vaultBeforeDeposit ||
    finalEntry.depositedDc !== 0n ||
    finalEntry.active ||
    finalEntry.totalConsumed !== 0n ||
    finalStats.tradeVolume !== 0n
  ) {
    throw new Error("rank withdrawal did not return the full active deposit");
  }
  const secondWithdrawRejected = await expectFailure(
    () =>
      client.send(
        client.buildInstruction(
          "deal_domain_rank",
          "withdraw_deposit",
          {},
          {
            config: rankConfig,
            merchant: seller.publicKey,
            domain,
            deal,
            stats: rankStats,
            entry: rankEntry,
            merchant_dc: sellerDc.publicKey,
            vault: rankVault,
            dc_mint: dcMint,
            dc_token_program: TOKEN_PROGRAM,
          },
        ),
        seller,
      ),
    "second rank withdrawal",
  );

  const report = {
    generatedAt: new Date().toISOString(),
    cluster: "localnet",
    rpcUrl,
    genesisHash: await connection.getGenesisHash(),
    sourceDomainReport: domainReportPath,
    topology: {
      coreProgram: coreProgram.toBase58(),
      coreRegistry: coreRegistry.toBase58(),
      assetProgram: assetProgram.toBase58(),
      assetConfig: assetConfig.toBase58(),
      entryProgram: entryProgram.toBase58(),
      entryConfig: entryConfig.toBase58(),
      rankProgram: rankProgram.toBase58(),
      rankConfig: rankConfig.toBase58(),
      rankVault: rankVault.toBase58(),
      addressLookupTable: lookupTable.address.toBase58(),
    },
    domainDeal: {
      id: dealId.toString(),
      deal: deal.toBase58(),
      binding: binding.toBase58(),
      assetTerms: assetTerms.toBase58(),
      rankStats: rankStats.toBase58(),
      rankEntry: rankEntry.toBase58(),
      templateType: "TokenToEmpty",
      initialJoinMode: "NftGated",
      finalJoinMode: "ExactAddressAndNftGated",
      pickedCounterparty: confirmedBinding.pickedCounterparty.toBase58(),
      reportedVolume: createdEntry.reportedVolume.toString(),
      totalDomainDeals: finalStats.dealCount.toString(),
    },
    rankDeposit: {
      domainMinimum: policyStats.domainMinDeposit.toString(),
      deposited: "1000",
      withdrawn: "1000",
      consumed: finalEntry.totalConsumed.toString(),
      sellerBalanceRestored: sellerFinal === sellerBeforeDeposit,
      vaultBalanceRestored: vaultFinal === vaultBeforeDeposit,
    },
    signatures: {
      create: createSignature,
      createLookupTable: lookupTable.createSignature,
      extendLookupTable: lookupTable.extendSignature,
      blacklistPickedUser: blacklistSignature,
      unblacklistPickedUser: unblacklistSignature,
      confirmPickedUser: confirmSignature,
      setDomainPolicy: policySignature,
      deposit: depositSignature,
      withdraw: withdrawSignature,
    },
    rejectedBranches: {
      invalidDirectTemplate: invalidDirectTemplateRejected,
      nonCreatorConfirm: nonCreatorConfirmRejected,
      selfPick: selfPickRejected,
      blacklistedPick: blacklistedPickRejected,
      repeatedConfirm: repeatedConfirmRejected,
      nonOwnerPolicy: nonOwnerPolicyRejected,
      belowMinimumDeposit: belowMinimumRejected,
      secondWithdrawal: secondWithdrawRejected,
    },
  };
  const runId = report.generatedAt.replaceAll(":", "").replaceAll(".", "");
  const reportPath = resolve(
    localDir,
    `localnet-domain-entry-rank-${runId}.json`,
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
