import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

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

function latestDomainReport() {
  const reports = readdirSync(localDir)
    .filter(
      (name) =>
        name.startsWith("localnet-domain-market-") && name.endsWith(".json"),
    )
    .sort()
    .reverse();
  if (reports.length === 0) {
    throw new Error("domain market report is missing");
  }
  return {
    path: resolve(localDir, reports[0]),
    value: JSON.parse(readFileSync(resolve(localDir, reports[0]), "utf8")),
  };
}

function latestDomainRunDirectory() {
  const directories = readdirSync(localDir)
    .filter((name) => name.startsWith("domain-market-smoke-"))
    .sort()
    .reverse();
  if (directories.length === 0) {
    throw new Error("domain market run directory is missing");
  }
  return resolve(localDir, directories[0]);
}

function u64(value) {
  const output = Buffer.alloc(8);
  output.writeBigUInt64LE(BigInt(value));
  return output;
}

function decodeTokenAccount(info) {
  if (!info) throw new Error("token account is missing");
  return {
    owner: new PublicKey(info.data.subarray(32, 64)),
    amount: info.data.readBigUInt64LE(64),
  };
}

function decodeMint(info) {
  if (!info) throw new Error("mint is missing");
  return {
    supply: info.data.readBigUInt64LE(36),
    decimals: info.data[44],
  };
}

function readString(data, cursor) {
  const length = data.readUInt32LE(cursor.offset);
  cursor.offset += 4;
  const value = data
    .subarray(cursor.offset, cursor.offset + length)
    .toString("utf8");
  cursor.offset += length;
  return value;
}

function decodeDirectThread(info) {
  if (!info) throw new Error("direct thread is missing");
  return {
    domain: new PublicKey(info.data.subarray(8, 40)),
    merchant: new PublicKey(info.data.subarray(40, 72)),
    user: new PublicKey(info.data.subarray(72, 104)),
    count: info.data.readBigUInt64LE(104),
  };
}

function decodeMessage(info) {
  if (!info) throw new Error("hall message is missing");
  const cursor = { offset: 8 };
  const readKey = () => {
    const value = new PublicKey(
      info.data.subarray(cursor.offset, cursor.offset + 32),
    );
    cursor.offset += 32;
    return value;
  };
  const thread = readKey();
  const domain = readKey();
  const deal = readKey();
  const index = info.data.readBigUInt64LE(cursor.offset);
  cursor.offset += 8;
  const sender = readKey();
  const timestamp = info.data.readBigInt64LE(cursor.offset);
  cursor.offset += 8;
  const content = readString(info.data, cursor);
  return { thread, domain, deal, index, sender, timestamp, content };
}

function decodeSignalThread(info) {
  if (!info) throw new Error("signal thread is missing");
  return {
    domain: new PublicKey(info.data.subarray(8, 40)),
    merchant: new PublicKey(info.data.subarray(40, 72)),
    count: info.data.readBigUInt64LE(72),
  };
}

function decodeSignal(info) {
  if (!info) throw new Error("pick signal is missing");
  const cursor = { offset: 8 };
  const readKey = () => {
    const value = new PublicKey(
      info.data.subarray(cursor.offset, cursor.offset + 32),
    );
    cursor.offset += 32;
    return value;
  };
  const domain = readKey();
  const merchant = readKey();
  const pickedUser = readKey();
  const index = info.data.readBigUInt64LE(cursor.offset);
  cursor.offset += 8;
  const timestamp = info.data.readBigInt64LE(cursor.offset);
  cursor.offset += 8;
  const note = readString(info.data, cursor);
  return { domain, merchant, pickedUser, index, timestamp, note };
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
  if (
    process.env.SOLANA_LOCAL_HALL_CONFIRM !==
    "LOCALNET_DOMAIN_HALL_REAL_BURN"
  ) {
    throw new Error(
      "hall smoke requires SOLANA_LOCAL_HALL_CONFIRM=LOCALNET_DOMAIN_HALL_REAL_BURN",
    );
  }

  const client = await createLocalGovernanceClient();
  const { connection, state } = client;
  const reportSource = latestDomainReport();
  const domainReport = reportSource.value;
  if (
    domainReport.genesisHash !== (await connection.getGenesisHash()) ||
    domainReport.cluster !== "localnet"
  ) {
    throw new Error("domain report does not belong to the running Localnet");
  }
  const runDirectory = latestDomainRunDirectory();
  const requiredKeys = ["seller", "buyer", "outsider", "sellerDc", "buyerDc"];
  for (const name of requiredKeys) {
    if (!existsSync(resolve(runDirectory, `${name}.json`))) {
      throw new Error(`domain smoke key ${name} is missing`);
    }
  }
  const seller = loadKeypair(resolve(runDirectory, "seller.json"));
  const buyer = loadKeypair(resolve(runDirectory, "buyer.json"));
  const outsider = loadKeypair(resolve(runDirectory, "outsider.json"));
  const sellerDc = loadKeypair(resolve(runDirectory, "sellerDc.json"));
  const buyerDc = loadKeypair(resolve(runDirectory, "buyerDc.json"));
  if (
    seller.publicKey.toBase58() !== domainReport.participants.seller ||
    buyer.publicKey.toBase58() !== domainReport.participants.buyer ||
    outsider.publicKey.toBase58() !== domainReport.participants.outsider
  ) {
    throw new Error("domain report and key directory do not match");
  }

  const domain = new PublicKey(domainReport.domain.address);
  const dcMint = new PublicKey(state.mints.dc);
  const rankConfig = new PublicKey(state.addresses.domainRankConfig);
  const hallConfig = new PublicKey(state.addresses.domainHallConfig);
  const rankProgram = client.programId("deal_domain_rank");
  const hallProgram = client.programId("deal_domain_hall");
  const blacklist = (user) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("domain-rank-blacklist"),
        domain.toBuffer(),
        user.toBuffer(),
      ],
      rankProgram,
    )[0];
  const sellerBlacklist = blacklist(seller.publicKey);
  const outsiderBlacklist = blacklist(outsider.publicKey);
  const thread = PublicKey.findProgramAddressSync(
    [
      Buffer.from("domain-direct-thread"),
      domain.toBuffer(),
      seller.publicKey.toBuffer(),
      outsider.publicKey.toBuffer(),
    ],
    hallProgram,
  )[0];
  const messageAt = (index) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("domain-hall-message"), thread.toBuffer(), u64(index)],
      hallProgram,
    )[0];
  const signalThread = PublicKey.findProgramAddressSync(
    [
      Buffer.from("domain-signal-thread"),
      domain.toBuffer(),
      seller.publicKey.toBuffer(),
    ],
    hallProgram,
  )[0];
  const signalAt = (index) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("domain-pick-signal"), signalThread.toBuffer(), u64(index)],
      hallProgram,
    )[0];

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
  const setBlacklistSignature = await client.send(
    blacklistInstruction(true),
    seller,
  );

  const directMessageInstruction = (sender, senderDcAccount, index, content) =>
    client.buildInstruction(
      "deal_domain_hall",
      "post_direct_message",
      { index, content },
      {
        config: hallConfig,
        sender: sender.publicKey,
        domain,
        merchant: seller.publicKey,
        user: outsider.publicKey,
        merchant_blacklist: sellerBlacklist,
        user_blacklist: outsiderBlacklist,
        thread,
        message: messageAt(index),
        sender_dc: senderDcAccount.publicKey,
        dc_mint: dcMint,
        token_program: TOKEN_PROGRAM,
        system_program: SystemProgram.programId,
      },
    );
  const blacklistedMessageRejected = await expectFailure(
    () =>
      client.send(
        directMessageInstruction(
          seller,
          sellerDc,
          0n,
          "blocked by domain blacklist",
        ),
        seller,
      ),
    "blacklisted hall participant",
  );

  const setUnblacklistSignature = await client.send(
    blacklistInstruction(false),
    seller,
  );
  const nonParticipantRejected = await expectFailure(
    () =>
      client.send(
        directMessageInstruction(
          buyer,
          buyerDc,
          0n,
          "non participant should fail",
        ),
        buyer,
      ),
    "non-participant hall sender",
  );
  const emptyMessageRejected = await expectFailure(
    () =>
      client.send(
        directMessageInstruction(seller, sellerDc, 0n, ""),
        seller,
      ),
    "empty hall message",
  );

  const beforeMessageInfos = await connection.getMultipleAccountsInfo(
    [sellerDc.publicKey, dcMint],
    "confirmed",
  );
  const sellerDcBefore = decodeTokenAccount(beforeMessageInfos[0]).amount;
  const supplyBefore = decodeMint(beforeMessageInfos[1]).supply;
  const messageSignature = await client.send(
    directMessageInstruction(
      seller,
      sellerDc,
      0n,
      "Localnet domain hall mainnet-parity smoke",
    ),
    seller,
  );
  const afterMessageInfos = await connection.getMultipleAccountsInfo(
    [sellerDc.publicKey, dcMint, thread, messageAt(0n)],
    "confirmed",
  );
  const sellerDcAfter = decodeTokenAccount(afterMessageInfos[0]).amount;
  const mintAfter = decodeMint(afterMessageInfos[1]);
  const threadState = decodeDirectThread(afterMessageInfos[2]);
  const messageState = decodeMessage(afterMessageInfos[3]);
  const messagePrice = 100n;
  if (
    sellerDcBefore - sellerDcAfter !== messagePrice ||
    supplyBefore - mintAfter.supply !== messagePrice ||
    threadState.count !== 1n ||
    !threadState.domain.equals(domain) ||
    !threadState.merchant.equals(seller.publicKey) ||
    !threadState.user.equals(outsider.publicKey) ||
    messageState.index !== 0n ||
    !messageState.sender.equals(seller.publicKey) ||
    messageState.content !== "Localnet domain hall mainnet-parity smoke" ||
    messageState.timestamp <= 0n
  ) {
    throw new Error("hall message, thread, or DC burn invariant failed");
  }

  const staleIndexRejected = await expectFailure(
    () =>
      client.send(
        directMessageInstruction(
          seller,
          sellerDc,
          2n,
          "invalid index should fail",
        ),
        seller,
      ),
    "stale hall message index",
  );
  const replayRejected = await expectFailure(
    () =>
      client.send(
        directMessageInstruction(
          seller,
          sellerDc,
          0n,
          "replay should fail",
        ),
        seller,
      ),
    "replayed hall message index",
  );

  const signalInstruction = (index, note) =>
    client.buildInstruction(
      "deal_domain_hall",
      "signal_pick_user",
      { index, note },
      {
        config: hallConfig,
        merchant: seller.publicKey,
        domain,
        picked_user: outsider.publicKey,
        merchant_blacklist: sellerBlacklist,
        picked_blacklist: outsiderBlacklist,
        thread: signalThread,
        signal: signalAt(index),
        system_program: SystemProgram.programId,
      },
    );
  const signalSignature = await client.send(
    signalInstruction(0n, "pick outsider for deferred domain deal"),
    seller,
  );
  const signalInfos = await connection.getMultipleAccountsInfo(
    [signalThread, signalAt(0n)],
    "confirmed",
  );
  const signalThreadState = decodeSignalThread(signalInfos[0]);
  const signalState = decodeSignal(signalInfos[1]);
  if (
    signalThreadState.count !== 1n ||
    !signalThreadState.domain.equals(domain) ||
    !signalThreadState.merchant.equals(seller.publicKey) ||
    signalState.index !== 0n ||
    !signalState.pickedUser.equals(outsider.publicKey) ||
    signalState.note !== "pick outsider for deferred domain deal" ||
    signalState.timestamp <= 0n
  ) {
    throw new Error("hall pick signal invariant failed");
  }
  const replaySignalRejected = await expectFailure(
    () => client.send(signalInstruction(0n, "replay"), seller),
    "replayed hall pick signal",
  );

  const runId = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const report = {
    generatedAt: new Date().toISOString(),
    cluster: "localnet",
    rpcUrl,
    genesisHash: await connection.getGenesisHash(),
    sourceDomainReport: reportSource.path,
    topology: {
      rankProgram: rankProgram.toBase58(),
      rankConfig: rankConfig.toBase58(),
      hallProgram: hallProgram.toBase58(),
      hallConfig: hallConfig.toBase58(),
      domain: domain.toBase58(),
      dcMint: dcMint.toBase58(),
    },
    message: {
      thread: thread.toBase58(),
      address: messageAt(0n).toBase58(),
      sender: messageState.sender.toBase58(),
      index: messageState.index.toString(),
      timestamp: messageState.timestamp.toString(),
      content: messageState.content,
      burnedDc: (supplyBefore - mintAfter.supply).toString(),
      senderDcDelta: (sellerDcBefore - sellerDcAfter).toString(),
    },
    pickSignal: {
      thread: signalThread.toBase58(),
      address: signalAt(0n).toBase58(),
      pickedUser: signalState.pickedUser.toBase58(),
      timestamp: signalState.timestamp.toString(),
      note: signalState.note,
    },
    signatures: {
      blacklist: setBlacklistSignature,
      unblacklist: setUnblacklistSignature,
      message: messageSignature,
      signal: signalSignature,
    },
    rejectedBranches: {
      blacklistedParticipant: blacklistedMessageRejected,
      nonParticipant: nonParticipantRejected,
      emptyMessage: emptyMessageRejected,
      staleIndex: staleIndexRejected,
      replayedMessage: replayRejected,
      replayedSignal: replaySignalRejected,
    },
  };
  const reportPath = resolve(
    localDir,
    `localnet-domain-hall-${runId}.json`,
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
