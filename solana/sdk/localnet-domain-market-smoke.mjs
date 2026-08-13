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
const ZERO = new PublicKey("11111111111111111111111111111111");

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

function decodeTokenAccount(info) {
  if (!info) throw new Error("token account is missing");
  return {
    mint: new PublicKey(info.data.subarray(0, 32)),
    owner: new PublicKey(info.data.subarray(32, 64)),
    amount: info.data.readBigUInt64LE(64),
    state: info.data[108],
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

function decodeDomainConfig(info) {
  if (!info) throw new Error("domain config is missing");
  return {
    authority: new PublicKey(info.data.subarray(8, 40)),
    pendingAuthority: new PublicKey(info.data.subarray(40, 72)),
    dcMint: new PublicKey(info.data.subarray(72, 104)),
    treasury: new PublicKey(info.data.subarray(104, 136)),
    domainMarket: new PublicKey(info.data.subarray(136, 168)),
    basePrice: info.data.readBigUInt64LE(168),
    nextId: info.data.readBigUInt64LE(176),
    paused: info.data[184] !== 0,
  };
}

function decodeDomain(info) {
  if (!info) throw new Error("domain record is missing");
  const cursor = { offset: 8 };
  const id = info.data.readBigUInt64LE(cursor.offset);
  cursor.offset += 8;
  const label = readString(info.data, cursor);
  const readKey = () => {
    const key = new PublicKey(info.data.subarray(cursor.offset, cursor.offset + 32));
    cursor.offset += 32;
    return key;
  };
  const mint = readKey();
  const owner = readKey();
  const creator = readKey();
  const resolveAddress = readKey();
  const description = readString(info.data, cursor);
  const backgroundUri = readString(info.data, cursor);
  const escrowMarket = readKey();
  return {
    id,
    label,
    mint,
    owner,
    creator,
    resolve: resolveAddress,
    description,
    backgroundUri,
    escrowMarket,
  };
}

function decodeListing(info) {
  if (!info) throw new Error("domain listing is missing");
  return {
    domain: new PublicKey(info.data.subarray(8, 40)),
    domainMint: new PublicKey(info.data.subarray(40, 72)),
    seller: new PublicKey(info.data.subarray(72, 104)),
    designatedBuyer: new PublicKey(info.data.subarray(104, 136)),
    price: info.data.readBigUInt64LE(136),
    createdAt: info.data.readBigInt64LE(144),
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

function labelFor(nextId) {
  const suffix = nextId.toString(36).padStart(5, "0").slice(-5);
  return `D${suffix}`;
}

async function main() {
  if (
    process.env.SOLANA_LOCAL_DOMAIN_CONFIRM !==
    "LOCALNET_DOMAIN_MARKET_REAL_ASSETS"
  ) {
    throw new Error(
      "domain smoke requires SOLANA_LOCAL_DOMAIN_CONFIRM=LOCALNET_DOMAIN_MARKET_REAL_ASSETS",
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
  const runDir = resolve(localDir, `domain-market-smoke-${runId}`);
  mkdirSync(runDir, { recursive: false });

  const keypairs = {
    seller: Keypair.generate(),
    buyer: Keypair.generate(),
    outsider: Keypair.generate(),
    sellerDc: Keypair.generate(),
    sellerStable: Keypair.generate(),
    buyerDc: Keypair.generate(),
    buyerStable: Keypair.generate(),
    treasuryDc: Keypair.generate(),
  };
  const paths = {};
  for (const [name, keypair] of Object.entries(keypairs)) {
    const path = resolve(runDir, `${name}.json`);
    writeKeypair(path, keypair);
    paths[name] = path;
  }

  for (const participant of [
    keypairs.seller,
    keypairs.buyer,
    keypairs.outsider,
  ]) {
    const signature = await connection.requestAirdrop(
      participant.publicKey,
      2 * LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(signature, "confirmed");
  }

  const dcMint = new PublicKey(state.mints.dc);
  const stableMint = new PublicKey(state.mints.stable0);
  const dexConfig = new PublicKey(state.addresses.dexConfig);
  const registryConfig = new PublicKey(state.addresses.domainRegistryConfig);
  const marketConfig = new PublicKey(state.addresses.domainMarketConfig);
  const treasuryVault = new PublicKey(state.addresses.treasuryVault);
  const registryProgram = client.programId("deal_domain_registry");
  const marketProgram = client.programId("deal_domain_market");
  const dexProgram = client.programId("deal_dex_pair");
  const pair = PublicKey.findProgramAddressSync(
    [Buffer.from("dex-pair"), stableMint.toBuffer()],
    dexProgram,
  )[0];
  const vault0 = associatedToken(pair, dcMint);
  const vault1 = associatedToken(pair, stableMint);

  const createTokenAccount = (mint, accountName, owner) =>
    splToken(
      [
        "create-account",
        mint.toBase58(),
        relative(solanaDir, paths[accountName]),
        "--owner",
        owner.toBase58(),
        "--output",
        "json",
      ],
      walletPath,
    );
  createTokenAccount(dcMint, "sellerDc", keypairs.seller.publicKey);
  createTokenAccount(stableMint, "sellerStable", keypairs.seller.publicKey);
  createTokenAccount(dcMint, "buyerDc", keypairs.buyer.publicKey);
  createTokenAccount(stableMint, "buyerStable", keypairs.buyer.publicKey);
  createTokenAccount(dcMint, "treasuryDc", treasuryVault);

  for (const stableAccount of [
    keypairs.sellerStable.publicKey,
    keypairs.buyerStable.publicKey,
  ]) {
    splToken(
      [
        "mint",
        stableMint.toBase58(),
        "100",
        stableAccount.toBase58(),
        "--mint-authority",
        relative(solanaDir, walletPath),
        "--output",
        "json",
      ],
      walletPath,
    );
  }

  const swap = async (participant, stableAccount, dcAccount) =>
    client.send(
      client.buildInstruction(
        "deal_dex_pair",
        "swap_buy_dc",
        { amount1_in: 20_000_000n, minimum0_out: 1n },
        {
          user: participant.publicKey,
          config: dexConfig,
          pair,
          user_other: stableAccount.publicKey,
          user_dc: dcAccount.publicKey,
          dc_mint: dcMint,
          other_mint: stableMint,
          vault0,
          vault1,
          dc_token_program: TOKEN_PROGRAM,
          other_token_program: TOKEN_PROGRAM,
        },
      ),
      participant,
    );
  const swaps = {
    seller: await swap(
      keypairs.seller,
      keypairs.sellerStable,
      keypairs.sellerDc,
    ),
    buyer: await swap(
      keypairs.buyer,
      keypairs.buyerStable,
      keypairs.buyerDc,
    ),
  };

  const configBefore = decodeDomainConfig(
    await connection.getAccountInfo(registryConfig, "confirmed"),
  );
  if (
    configBefore.paused ||
    !configBefore.authority.equals(executorAuthority) ||
    !configBefore.dcMint.equals(dcMint) ||
    !configBefore.treasury.equals(treasuryVault) ||
    !configBefore.domainMarket.equals(marketConfig)
  ) {
    throw new Error("domain production topology is inconsistent before smoke");
  }

  const label = labelFor(configBefore.nextId);
  const expectedId = configBefore.nextId;
  const idBytes = Buffer.alloc(8);
  idBytes.writeBigUInt64LE(expectedId);
  const domain = PublicKey.findProgramAddressSync(
    [Buffer.from("domain"), Buffer.from(label)],
    registryProgram,
  )[0];
  const domainMint = PublicKey.findProgramAddressSync(
    [Buffer.from("domain-mint"), Buffer.from(label)],
    registryProgram,
  )[0];
  const idMap = PublicKey.findProgramAddressSync(
    [Buffer.from("domain-id"), idBytes],
    registryProgram,
  )[0];
  const sellerDomain = associatedToken(keypairs.seller.publicKey, domainMint);
  const buyerDomain = associatedToken(keypairs.buyer.publicKey, domainMint);
  const marketDomain = associatedToken(marketConfig, domainMint);
  const listing = PublicKey.findProgramAddressSync(
    [Buffer.from("domain-listing"), domain.toBuffer()],
    marketProgram,
  )[0];
  const primary = PublicKey.findProgramAddressSync(
    [Buffer.from("primary-domain"), keypairs.seller.publicKey.toBuffer()],
    registryProgram,
  )[0];

  const balancesBeforeRegister = await connection.getMultipleAccountsInfo(
    [keypairs.sellerDc.publicKey, keypairs.treasuryDc.publicKey],
    "confirmed",
  );
  const sellerDcBeforeRegister = decodeTokenAccount(
    balancesBeforeRegister[0],
  ).amount;
  const treasuryBeforeRegister = decodeTokenAccount(
    balancesBeforeRegister[1],
  ).amount;
  const registerSignature = await client.send(
    client.buildInstruction(
      "deal_domain_registry",
      "register",
      { label, expected_id: expectedId },
      {
        config: registryConfig,
        owner: keypairs.seller.publicKey,
        owner_dc: keypairs.sellerDc.publicKey,
        treasury_dc: keypairs.treasuryDc.publicKey,
        dc_mint: dcMint,
        dc_token_program: TOKEN_PROGRAM,
        domain_mint: domainMint,
        owner_domain: sellerDomain,
        domain,
        id_map: idMap,
        domain_token_program: TOKEN_PROGRAM,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM,
        system_program: SystemProgram.programId,
      },
    ),
    keypairs.seller,
  );

  const postRegisterInfos = await connection.getMultipleAccountsInfo(
    [
      registryConfig,
      domain,
      sellerDomain,
      keypairs.sellerDc.publicKey,
      keypairs.treasuryDc.publicKey,
    ],
    "confirmed",
  );
  const configAfterRegister = decodeDomainConfig(postRegisterInfos[0]);
  const registered = decodeDomain(postRegisterInfos[1]);
  const sellerDomainAfterRegister = decodeTokenAccount(postRegisterInfos[2]);
  const sellerDcAfterRegister = decodeTokenAccount(postRegisterInfos[3]).amount;
  const treasuryAfterRegister = decodeTokenAccount(postRegisterInfos[4]).amount;
  if (
    configAfterRegister.nextId !== expectedId + 1n ||
    registered.id !== expectedId ||
    registered.label !== label ||
    !registered.owner.equals(keypairs.seller.publicKey) ||
    !registered.creator.equals(keypairs.seller.publicKey) ||
    !registered.resolve.equals(keypairs.seller.publicKey) ||
    sellerDomainAfterRegister.amount !== 1n ||
    sellerDomainAfterRegister.state !== 2 ||
    sellerDcBeforeRegister - sellerDcAfterRegister !== configBefore.basePrice ||
    treasuryAfterRegister - treasuryBeforeRegister !== configBefore.basePrice
  ) {
    throw new Error("domain registration state or payment invariant failed");
  }

  const duplicateLabelRejected = await expectFailure(
    () =>
      client.send(
        client.buildInstruction(
          "deal_domain_registry",
          "register",
          { label, expected_id: expectedId + 1n },
          {
            config: registryConfig,
            owner: keypairs.buyer.publicKey,
            owner_dc: keypairs.buyerDc.publicKey,
            treasury_dc: keypairs.treasuryDc.publicKey,
            dc_mint: dcMint,
            dc_token_program: TOKEN_PROGRAM,
            domain_mint: domainMint,
            owner_domain: buyerDomain,
            domain,
            id_map: PublicKey.findProgramAddressSync(
              [
                Buffer.from("domain-id"),
                (() => {
                  const bytes = Buffer.alloc(8);
                  bytes.writeBigUInt64LE(expectedId + 1n);
                  return bytes;
                })(),
              ],
              registryProgram,
            )[0],
            domain_token_program: TOKEN_PROGRAM,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM,
            system_program: SystemProgram.programId,
          },
        ),
        keypairs.buyer,
      ),
    "duplicate domain label",
  );

  const metadataSignature = await client.send(
    client.buildInstruction(
      "deal_domain_registry",
      "set_metadata",
      {
        description: "Localnet mainnet-parity domain smoke",
        background_uri: "ipfs://deal-localnet-domain-smoke",
      },
      {
        owner: keypairs.seller.publicKey,
        domain,
      },
    ),
    keypairs.seller,
  );
  const resolveSignature = await client.send(
    client.buildInstruction(
      "deal_domain_registry",
      "set_resolve",
      { resolve: keypairs.outsider.publicKey },
      {
        owner: keypairs.seller.publicKey,
        domain,
      },
    ),
    keypairs.seller,
  );
  const unauthorizedMetadataRejected = await expectFailure(
    () =>
      client.send(
        client.buildInstruction(
          "deal_domain_registry",
          "set_metadata",
          { description: "unauthorized", background_uri: "" },
          { owner: keypairs.buyer.publicKey, domain },
        ),
        keypairs.buyer,
      ),
    "non-owner metadata update",
  );
  const selfTransferRejected = await expectFailure(
    () =>
      client.send(
        client.buildInstruction(
          "deal_domain_registry",
          "transfer_domain",
          {},
          {
            config: registryConfig,
            owner: keypairs.seller.publicKey,
            new_owner: keypairs.seller.publicKey,
            domain,
            domain_mint: domainMint,
            owner_domain: sellerDomain,
            new_owner_domain: sellerDomain,
            domain_token_program: TOKEN_PROGRAM,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM,
            system_program: SystemProgram.programId,
          },
        ),
        keypairs.seller,
      ),
    "self domain transfer",
  );
  const directTransferSignature = await client.send(
    client.buildInstruction(
      "deal_domain_registry",
      "transfer_domain",
      {},
      {
        config: registryConfig,
        owner: keypairs.seller.publicKey,
        new_owner: keypairs.buyer.publicKey,
        domain,
        domain_mint: domainMint,
        owner_domain: sellerDomain,
        new_owner_domain: buyerDomain,
        domain_token_program: TOKEN_PROGRAM,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM,
        system_program: SystemProgram.programId,
      },
    ),
    keypairs.seller,
  );
  const afterDirectTransfer = decodeDomain(
    await connection.getAccountInfo(domain, "confirmed"),
  );
  if (
    !afterDirectTransfer.owner.equals(keypairs.buyer.publicKey) ||
    !afterDirectTransfer.resolve.equals(keypairs.buyer.publicKey) ||
    !afterDirectTransfer.creator.equals(keypairs.seller.publicKey) ||
    afterDirectTransfer.description !==
      "Localnet mainnet-parity domain smoke"
  ) {
    throw new Error("direct domain transfer did not preserve/reset fields");
  }

  const listingPrice = 2_000_000n;
  const listSignature = await client.send(
    client.buildInstruction(
      "deal_domain_market",
      "list",
      { price: listingPrice, designated_buyer: PublicKey.default },
      {
        config: marketConfig,
        seller: keypairs.buyer.publicKey,
        registry_program: registryProgram,
        registry_config: registryConfig,
        domain,
        domain_mint: domainMint,
        seller_domain: buyerDomain,
        market_domain: marketDomain,
        listing,
        domain_token_program: TOKEN_PROGRAM,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM,
        system_program: SystemProgram.programId,
      },
    ),
    keypairs.buyer,
  );
  const listed = decodeListing(
    await connection.getAccountInfo(listing, "confirmed"),
  );
  if (
    !listed.domain.equals(domain) ||
    !listed.seller.equals(keypairs.buyer.publicKey) ||
    listed.price !== listingPrice ||
    listed.createdAt <= 0n
  ) {
    throw new Error("domain listing state is inconsistent");
  }

  const transferWhileEscrowedRejected = await expectFailure(
    () =>
      client.send(
        client.buildInstruction(
          "deal_domain_registry",
          "transfer_domain",
          {},
          {
            config: registryConfig,
            owner: keypairs.buyer.publicKey,
            new_owner: keypairs.seller.publicKey,
            domain,
            domain_mint: domainMint,
            owner_domain: buyerDomain,
            new_owner_domain: sellerDomain,
            domain_token_program: TOKEN_PROGRAM,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM,
            system_program: SystemProgram.programId,
          },
        ),
        keypairs.buyer,
      ),
    "domain transfer while escrowed",
  );
  const nonSellerDelistRejected = await expectFailure(
    () =>
      client.send(
        client.buildInstruction(
          "deal_domain_market",
          "delist",
          {},
          {
            config: marketConfig,
            seller: keypairs.seller.publicKey,
            registry_program: registryProgram,
            registry_config: registryConfig,
            domain,
            domain_mint: domainMint,
            market_domain: marketDomain,
            seller_domain: sellerDomain,
            listing,
            domain_token_program: TOKEN_PROGRAM,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM,
            system_program: SystemProgram.programId,
          },
        ),
        keypairs.seller,
      ),
    "non-seller delist",
  );
  const delistSignature = await client.send(
    client.buildInstruction(
      "deal_domain_market",
      "delist",
      {},
      {
        config: marketConfig,
        seller: keypairs.buyer.publicKey,
        registry_program: registryProgram,
        registry_config: registryConfig,
        domain,
        domain_mint: domainMint,
        market_domain: marketDomain,
        seller_domain: buyerDomain,
        listing,
        domain_token_program: TOKEN_PROGRAM,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM,
        system_program: SystemProgram.programId,
      },
    ),
    keypairs.buyer,
  );
  if (await connection.getAccountInfo(listing, "confirmed")) {
    throw new Error("delist did not close listing account");
  }

  const relistSignature = await client.send(
    client.buildInstruction(
      "deal_domain_market",
      "list",
      {
        price: listingPrice,
        designated_buyer: keypairs.seller.publicKey,
      },
      {
        config: marketConfig,
        seller: keypairs.buyer.publicKey,
        registry_program: registryProgram,
        registry_config: registryConfig,
        domain,
        domain_mint: domainMint,
        seller_domain: buyerDomain,
        market_domain: marketDomain,
        listing,
        domain_token_program: TOKEN_PROGRAM,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM,
        system_program: SystemProgram.programId,
      },
    ),
    keypairs.buyer,
  );

  const maximumPriceRejected = await expectFailure(
    () =>
      client.send(
        client.buildInstruction(
          "deal_domain_market",
          "buy",
          { maximum_price: listingPrice - 1n },
          {
            config: marketConfig,
            buyer: keypairs.seller.publicKey,
            seller: keypairs.buyer.publicKey,
            registry_program: registryProgram,
            registry_config: registryConfig,
            domain,
            domain_mint: domainMint,
            market_domain: marketDomain,
            buyer_domain: sellerDomain,
            listing,
            buyer_payment: keypairs.sellerDc.publicKey,
            seller_payment: keypairs.buyerDc.publicKey,
            fee_payment: keypairs.treasuryDc.publicKey,
            payment_mint: dcMint,
            payment_token_program: TOKEN_PROGRAM,
            domain_token_program: TOKEN_PROGRAM,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM,
            system_program: SystemProgram.programId,
          },
        ),
        keypairs.seller,
      ),
    "maximum marketplace price",
  );

  const beforeBuyInfos = await connection.getMultipleAccountsInfo(
    [
      keypairs.sellerDc.publicKey,
      keypairs.buyerDc.publicKey,
      keypairs.treasuryDc.publicKey,
    ],
    "confirmed",
  );
  const beforeBuy = beforeBuyInfos.map(
    (info) => decodeTokenAccount(info).amount,
  );
  const buySignature = await client.send(
    client.buildInstruction(
      "deal_domain_market",
      "buy",
      { maximum_price: listingPrice },
      {
        config: marketConfig,
        buyer: keypairs.seller.publicKey,
        seller: keypairs.buyer.publicKey,
        registry_program: registryProgram,
        registry_config: registryConfig,
        domain,
        domain_mint: domainMint,
        market_domain: marketDomain,
        buyer_domain: sellerDomain,
        listing,
        buyer_payment: keypairs.sellerDc.publicKey,
        seller_payment: keypairs.buyerDc.publicKey,
        fee_payment: keypairs.treasuryDc.publicKey,
        payment_mint: dcMint,
        payment_token_program: TOKEN_PROGRAM,
        domain_token_program: TOKEN_PROGRAM,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM,
        system_program: SystemProgram.programId,
      },
    ),
    keypairs.seller,
  );
  const afterBuyInfos = await connection.getMultipleAccountsInfo(
    [
      keypairs.sellerDc.publicKey,
      keypairs.buyerDc.publicKey,
      keypairs.treasuryDc.publicKey,
      sellerDomain,
      buyerDomain,
      marketDomain,
      domain,
      listing,
    ],
    "confirmed",
  );
  const afterBuy = afterBuyInfos
    .slice(0, 3)
    .map((info) => decodeTokenAccount(info).amount);
  const sellerDomainFinal = decodeTokenAccount(afterBuyInfos[3]);
  const buyerDomainFinal = decodeTokenAccount(afterBuyInfos[4]);
  const marketDomainFinal = decodeTokenAccount(afterBuyInfos[5]);
  const domainFinal = decodeDomain(afterBuyInfos[6]);
  const fee = (listingPrice * 250n) / 10_000n;
  if (
    beforeBuy[0] - afterBuy[0] !== listingPrice ||
    afterBuy[1] - beforeBuy[1] !== listingPrice - fee ||
    afterBuy[2] - beforeBuy[2] !== fee ||
    sellerDomainFinal.amount !== 1n ||
    sellerDomainFinal.state !== 2 ||
    buyerDomainFinal.amount !== 0n ||
    marketDomainFinal.amount !== 0n ||
    !domainFinal.owner.equals(keypairs.seller.publicKey) ||
    !domainFinal.resolve.equals(keypairs.seller.publicKey) ||
    !domainFinal.escrowMarket.equals(PublicKey.default) ||
    afterBuyInfos[7] !== null
  ) {
    throw new Error("market sale payment, NFT, or ownership invariant failed");
  }

  const primarySignature = await client.send(
    client.buildInstruction(
      "deal_domain_registry",
      "set_primary_domain",
      {},
      {
        owner: keypairs.seller.publicKey,
        domain,
        primary,
        system_program: SystemProgram.programId,
      },
    ),
    keypairs.seller,
  );

  const report = {
    generatedAt: new Date().toISOString(),
    cluster: "localnet",
    rpcUrl,
    genesisHash: await connection.getGenesisHash(),
    productionTopology: {
      executorAuthority: executorAuthority.toBase58(),
      registryProgram: registryProgram.toBase58(),
      registryConfig: registryConfig.toBase58(),
      marketProgram: marketProgram.toBase58(),
      marketConfig: marketConfig.toBase58(),
      treasuryVault: treasuryVault.toBase58(),
      dcMint: dcMint.toBase58(),
      stableMint: stableMint.toBase58(),
    },
    domain: {
      id: expectedId.toString(),
      label,
      address: domain.toBase58(),
      mint: domainMint.toBase58(),
      creator: domainFinal.creator.toBase58(),
      finalOwner: domainFinal.owner.toBase58(),
      finalResolve: domainFinal.resolve.toBase58(),
      description: domainFinal.description,
      backgroundUri: domainFinal.backgroundUri,
      finalTokenState: "frozen",
      primary: primary.toBase58(),
    },
    participants: {
      seller: keypairs.seller.publicKey.toBase58(),
      buyer: keypairs.buyer.publicKey.toBase58(),
      outsider: keypairs.outsider.publicKey.toBase58(),
    },
    economics: {
      registrationPrice: configBefore.basePrice.toString(),
      listingPrice: listingPrice.toString(),
      marketFee: fee.toString(),
      sellerPayment: (listingPrice - fee).toString(),
      treasuryRegistrationDelta: (
        treasuryAfterRegister - treasuryBeforeRegister
      ).toString(),
      treasurySaleFeeDelta: (afterBuy[2] - beforeBuy[2]).toString(),
    },
    signatures: {
      swaps,
      register: registerSignature,
      setMetadata: metadataSignature,
      setResolve: resolveSignature,
      directTransfer: directTransferSignature,
      list: listSignature,
      delist: delistSignature,
      relist: relistSignature,
      buy: buySignature,
      setPrimary: primarySignature,
    },
    rejectedBranches: {
      duplicateLabel: duplicateLabelRejected,
      unauthorizedMetadata: unauthorizedMetadataRejected,
      selfTransfer: selfTransferRejected,
      transferWhileEscrowed: transferWhileEscrowedRejected,
      nonSellerDelist: nonSellerDelistRejected,
      maximumPrice: maximumPriceRejected,
    },
  };
  const reportPath = resolve(
    localDir,
    `localnet-domain-market-${runId}.json`,
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
