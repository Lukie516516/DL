use anchor_lang::{
    prelude::{AccountDeserialize, AccountSerialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use anchor_spl::associated_token::get_associated_token_address;
use deal_d_token::{
    BalanceCheckpoint, DTokenConfig, HolderState, CHECKPOINT_SEED as D_CHECKPOINT_SEED,
    CONFIG_SEED as D_CONFIG_SEED, D_UNIT, HOLDER_SEED, MAX_SUPPLY, SEAT_THRESHOLD,
};
use deal_dividend::{
    ClaimReceipt, DividendConfig, DividendRound, CLAIM_SEED, CONFIG_SEED, ROUND_SEED,
    VAULT_AUTHORITY_SEED,
};
use deal_governance_activity::{
    ActivityBucket, ActivityCheckpoint, ActivityConfig, IdentityActivity, RecorderGrant,
    ACTIVITY_SEED, BUCKET_COUNT, CHECKPOINT_SEED as ACTIVITY_CHECKPOINT_SEED,
    CONFIG_SEED as ACTIVITY_CONFIG_SEED, DEFAULT_ACTIVE_WINDOW_SECONDS, RECORDER_SEED,
};
use deal_identity::{IdentityRecord, IDENTITY_SEED};
use deal_protocol_treasury::{
    CONFIG_SEED as TREASURY_CONFIG_SEED, VAULT_AUTHORITY_SEED as TREASURY_VAULT_SEED,
};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use spl_token_interface::state::{Account as TokenAccount, AccountState, Mint};

const NOW: i64 = 1_700_000_000;

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    instructions: &[Instruction],
    additional_signers: &[&Keypair],
) -> bool {
    let blockhash = svm.latest_blockhash();
    let message = Message::new_with_blockhash(instructions, Some(&payer.pubkey()), &blockhash);
    let mut signers = vec![payer];
    signers.extend_from_slice(additional_signers);
    let transaction =
        VersionedTransaction::try_new(VersionedMessage::Legacy(message), &signers).unwrap();
    let result = match svm.send_transaction(transaction) {
        Ok(_) => true,
        Err(error) => {
            eprintln!("transaction failed: {error:#?}");
            false
        }
    };
    svm.expire_blockhash();
    result
}

fn set_clock(svm: &mut LiteSVM, slot: u64, timestamp: i64) {
    svm.set_sysvar(&Clock {
        slot,
        epoch_start_timestamp: timestamp,
        epoch: slot / 100,
        leader_schedule_epoch: slot / 100,
        unix_timestamp: timestamp,
    });
}

fn set_anchor_account<T: AccountSerialize>(
    svm: &mut LiteSVM,
    address: Pubkey,
    owner: Pubkey,
    value: &T,
) {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    svm.set_account(
        address,
        Account {
            lamports: 20_000_000,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn anchor_state<T: AccountDeserialize>(svm: &LiteSVM, address: Pubkey) -> T {
    let account = svm.get_account(&address).expect("account must exist");
    T::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn set_mint(svm: &mut LiteSVM, mint: Pubkey, authority: Pubkey, supply: u64) {
    let state = Mint {
        mint_authority: COption::Some(authority),
        supply,
        decimals: 0,
        is_initialized: true,
        freeze_authority: COption::None,
    };
    let mut data = vec![0u8; Mint::LEN];
    Mint::pack(state, &mut data).unwrap();
    svm.set_account(
        mint,
        Account {
            lamports: 10_000_000,
            data,
            owner: spl_token_interface::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn set_token_account(svm: &mut LiteSVM, address: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
    let state = TokenAccount {
        mint,
        owner,
        amount,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let mut data = vec![0u8; TokenAccount::LEN];
    TokenAccount::pack(state, &mut data).unwrap();
    svm.set_account(
        address,
        Account {
            lamports: 10_000_000,
            data,
            owner: spl_token_interface::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn token_balance(svm: &LiteSVM, address: Pubkey) -> u64 {
    let account = svm.get_account(&address).expect("token account must exist");
    TokenAccount::unpack(&account.data).unwrap().amount
}

fn holder_pda(owner: Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[HOLDER_SEED, owner.as_ref()], &deal_d_token::id())
}

fn checkpoint_pda(owner: Pubkey, index: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[D_CHECKPOINT_SEED, owner.as_ref(), &index.to_le_bytes()],
        &deal_d_token::id(),
    )
}

fn set_holder(
    svm: &mut LiteSVM,
    owner: Pubkey,
    balance: u64,
    checkpoint_count: u64,
    last_checkpoint_slot: u64,
) -> Pubkey {
    let (holder, bump) = holder_pda(owner);
    set_anchor_account(
        svm,
        holder,
        deal_d_token::id(),
        &HolderState {
            owner,
            balance,
            checkpoint_count,
            last_checkpoint_slot,
            bump,
        },
    );
    holder
}

fn set_checkpoint(svm: &mut LiteSVM, owner: Pubkey, index: u64, slot: u64, balance: u64) -> Pubkey {
    let (checkpoint, bump) = checkpoint_pda(owner, index);
    set_anchor_account(
        svm,
        checkpoint,
        deal_d_token::id(),
        &BalanceCheckpoint {
            owner,
            index,
            slot,
            balance,
            bump,
        },
    );
    checkpoint
}

#[test]
fn treasury_round_uses_immutable_d_snapshot_and_cannot_be_double_claimed() {
    let mut svm = LiteSVM::new();
    for (program, binary) in [
        (
            deal_protocol_treasury::id(),
            include_bytes!("../../../target/deploy/deal_protocol_treasury.so").as_slice(),
        ),
        (
            deal_dividend::id(),
            include_bytes!("../../../target/deploy/deal_dividend.so").as_slice(),
        ),
        (
            deal_governance_activity::id(),
            include_bytes!("../../../target/deploy/deal_governance_activity.so").as_slice(),
        ),
    ] {
        svm.add_program(program, binary).unwrap();
    }
    set_clock(&mut svm, 100, NOW);

    let payer = Keypair::new();
    let bootstrap = Keypair::new();
    let controller = Keypair::new();
    let alice = Keypair::new();
    let bob = Keypair::new();
    let attacker = Keypair::new();
    for wallet in [&payer, &bootstrap, &controller, &alice, &bob, &attacker] {
        svm.airdrop(&wallet.pubkey(), 40_000_000_000).unwrap();
    }

    let d_mint = Pubkey::new_unique();
    let (d_config, d_config_bump) =
        Pubkey::find_program_address(&[D_CONFIG_SEED], &deal_d_token::id());
    set_anchor_account(
        &mut svm,
        d_config,
        deal_d_token::id(),
        &DTokenConfig {
            mint: d_mint,
            total_supply: MAX_SUPPLY,
            seat_threshold: SEAT_THRESHOLD,
            holder_count: 2,
            bump: d_config_bump,
            freeze_bump: 1,
        },
    );
    let alice_holder = set_holder(&mut svm, alice.pubkey(), 70 * D_UNIT, 1, 1);
    let alice_checkpoint0 = set_checkpoint(&mut svm, alice.pubkey(), 0, 1, 70 * D_UNIT);
    let bob_holder = set_holder(&mut svm, bob.pubkey(), 30 * D_UNIT, 1, 1);
    let bob_checkpoint0 = set_checkpoint(&mut svm, bob.pubkey(), 0, 1, 30 * D_UNIT);

    let (activity_config, activity_bump) =
        Pubkey::find_program_address(&[ACTIVITY_CONFIG_SEED], &deal_governance_activity::id());
    set_anchor_account(
        &mut svm,
        activity_config,
        deal_governance_activity::id(),
        &ActivityConfig {
            authority: controller.pubkey(),
            pending_authority: Pubkey::default(),
            identity_program: deal_identity::id(),
            active_window_seconds: DEFAULT_ACTIVE_WINDOW_SECONDS,
            active_total: 0,
            last_synced_day: NOW / 86_400,
            buckets: [ActivityBucket::default(); BUCKET_COUNT],
            bump: activity_bump,
        },
    );

    let (treasury_config, _) =
        Pubkey::find_program_address(&[TREASURY_CONFIG_SEED], &deal_protocol_treasury::id());
    let (treasury_vault_authority, _) =
        Pubkey::find_program_address(&[TREASURY_VAULT_SEED], &deal_protocol_treasury::id());
    let initialize_treasury = Instruction::new_with_bytes(
        deal_protocol_treasury::id(),
        &deal_protocol_treasury::instruction::Initialize {
            controller: controller.pubkey(),
            bootstrap_admin: bootstrap.pubkey(),
        }
        .data(),
        deal_protocol_treasury::accounts::Initialize {
            payer: payer.pubkey(),
            config: treasury_config,
            vault_authority: treasury_vault_authority,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[initialize_treasury], &[]));

    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_dividend::id());
    let (vault_authority, _) =
        Pubkey::find_program_address(&[VAULT_AUTHORITY_SEED], &deal_dividend::id());
    let initialize_dividend = Instruction::new_with_bytes(
        deal_dividend::id(),
        &deal_dividend::instruction::Initialize {
            controller: controller.pubkey(),
            bootstrap_admin: bootstrap.pubkey(),
        }
        .data(),
        deal_dividend::accounts::Initialize {
            payer: payer.pubkey(),
            config,
            d_config,
            activity_config,
            treasury_config,
            treasury_vault_authority,
            vault_authority,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[initialize_dividend], &[]));
    let config_state: DividendConfig = anchor_state(&svm, config);
    assert_eq!(config_state.controller, controller.pubkey());
    assert_eq!(config_state.next_round_id, 0);

    let dividend_mint = Pubkey::new_unique();
    let treasury_source = Pubkey::new_unique();
    let dividend_vault = get_associated_token_address(&vault_authority, &dividend_mint);
    let alice_destination = Pubkey::new_unique();
    let bob_destination = Pubkey::new_unique();
    let attacker_destination = Pubkey::new_unique();
    set_mint(&mut svm, dividend_mint, controller.pubkey(), 1_000);
    set_token_account(
        &mut svm,
        treasury_source,
        dividend_mint,
        treasury_vault_authority,
        1_000,
    );
    set_token_account(&mut svm, dividend_vault, dividend_mint, vault_authority, 0);
    set_token_account(
        &mut svm,
        alice_destination,
        dividend_mint,
        alice.pubkey(),
        0,
    );
    set_token_account(&mut svm, bob_destination, dividend_mint, bob.pubkey(), 0);
    set_token_account(
        &mut svm,
        attacker_destination,
        dividend_mint,
        attacker.pubkey(),
        0,
    );

    let round_id = 0u64;
    let (round, _) =
        Pubkey::find_program_address(&[ROUND_SEED, &round_id.to_le_bytes()], &deal_dividend::id());
    let create_round_accounts = deal_dividend::accounts::CreateRound {
        payer: payer.pubkey(),
        controller: controller.pubkey(),
        config,
        d_config,
        round,
        mint: dividend_mint,
        treasury_config,
        treasury_vault_authority,
        treasury_source,
        vault_authority,
        dividend_vault,
        treasury_program: deal_protocol_treasury::id(),
        token_program: spl_token_interface::ID,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    };
    let unauthorized_round = Instruction::new_with_bytes(
        deal_dividend::id(),
        &deal_dividend::instruction::CreateRound {
            round_id,
            total: 1_000,
        }
        .data(),
        deal_dividend::accounts::CreateRound {
            controller: attacker.pubkey(),
            ..create_round_accounts
        }
        .to_account_metas(None),
    );
    assert!(!send(&mut svm, &payer, &[unauthorized_round], &[&attacker]));
    assert!(svm.get_account(&round).is_none());

    let create_round = Instruction::new_with_bytes(
        deal_dividend::id(),
        &deal_dividend::instruction::CreateRound {
            round_id,
            total: 1_000,
        }
        .data(),
        create_round_accounts.to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[create_round], &[&controller]));
    assert_eq!(token_balance(&svm, treasury_source), 0);
    assert_eq!(token_balance(&svm, dividend_vault), 1_000);
    let round_state: DividendRound = anchor_state(&svm, round);
    assert_eq!(round_state.snapshot_slot, 99);
    assert_eq!(round_state.total, 1_000);
    assert_eq!(round_state.claimed, 0);

    // A later D transfer changes Alice's current balance, not her round-0 snapshot.
    set_holder(&mut svm, alice.pubkey(), 60 * D_UNIT, 2, 100);
    let alice_checkpoint1 = set_checkpoint(&mut svm, alice.pubkey(), 1, 100, 60 * D_UNIT);

    let (alice_receipt, alice_receipt_bump) = Pubkey::find_program_address(
        &[CLAIM_SEED, round.as_ref(), alice.pubkey().as_ref()],
        &deal_dividend::id(),
    );
    let alice_claim_accounts = deal_dividend::accounts::ClaimDividend {
        claimer: alice.pubkey(),
        config,
        d_config,
        holder_state: alice_holder,
        balance_checkpoint: alice_checkpoint0,
        successor_checkpoint: Some(alice_checkpoint1),
        round,
        claim_receipt: alice_receipt,
        vault_authority,
        dividend_vault,
        destination: alice_destination,
        mint: dividend_mint,
        token_program: spl_token_interface::ID,
        system_program: anchor_lang::system_program::ID,
    };
    let alice_claim = Instruction::new_with_bytes(
        deal_dividend::id(),
        &deal_dividend::instruction::Claim {}.data(),
        alice_claim_accounts.to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &alice,
        std::slice::from_ref(&alice_claim),
        &[]
    ));
    assert_eq!(token_balance(&svm, alice_destination), 700);
    assert_eq!(token_balance(&svm, dividend_vault), 300);
    let alice_receipt_state: ClaimReceipt = anchor_state(&svm, alice_receipt);
    assert_eq!(alice_receipt_state.d_balance, 70 * D_UNIT);
    assert_eq!(alice_receipt_state.amount, 700);
    assert_eq!(alice_receipt_state.bump, alice_receipt_bump);
    assert!(!send(&mut svm, &alice, &[alice_claim], &[]));
    assert_eq!(token_balance(&svm, alice_destination), 700);

    let (attacker_receipt, _) = Pubkey::find_program_address(
        &[CLAIM_SEED, round.as_ref(), attacker.pubkey().as_ref()],
        &deal_dividend::id(),
    );
    let steal_alice_share = Instruction::new_with_bytes(
        deal_dividend::id(),
        &deal_dividend::instruction::Claim {}.data(),
        deal_dividend::accounts::ClaimDividend {
            claimer: attacker.pubkey(),
            config,
            d_config,
            holder_state: alice_holder,
            balance_checkpoint: alice_checkpoint0,
            successor_checkpoint: Some(alice_checkpoint1),
            round,
            claim_receipt: attacker_receipt,
            vault_authority,
            dividend_vault,
            destination: attacker_destination,
            mint: dividend_mint,
            token_program: spl_token_interface::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(!send(&mut svm, &attacker, &[steal_alice_share], &[]));
    assert_eq!(token_balance(&svm, attacker_destination), 0);

    let (recorder_grant, recorder_grant_bump) = Pubkey::find_program_address(
        &[RECORDER_SEED, vault_authority.as_ref()],
        &deal_governance_activity::id(),
    );
    set_anchor_account(
        &mut svm,
        recorder_grant,
        deal_governance_activity::id(),
        &RecorderGrant {
            recorder: vault_authority,
            allowed: true,
            bump: recorder_grant_bump,
        },
    );
    let identity_mint = Pubkey::new_unique();
    set_mint(&mut svm, identity_mint, controller.pubkey(), 1);
    let (identity, identity_bump) = Pubkey::find_program_address(
        &[IDENTITY_SEED, identity_mint.as_ref()],
        &deal_identity::id(),
    );
    set_anchor_account(
        &mut svm,
        identity,
        deal_identity::id(),
        &IdentityRecord {
            id: 1,
            mint: identity_mint,
            season: 1,
            date_code: 20_260_719,
            daily_serial: 1,
            total_dc_minted: 0,
            max_partner: identity_mint,
            lock_count: 0,
            bump: identity_bump,
        },
    );
    let owner_identity = Pubkey::new_unique();
    set_token_account(&mut svm, owner_identity, identity_mint, bob.pubkey(), 1);
    let (activity, _) = Pubkey::find_program_address(
        &[ACTIVITY_SEED, identity_mint.as_ref()],
        &deal_governance_activity::id(),
    );
    let (activity_checkpoint, _) = Pubkey::find_program_address(
        &[
            ACTIVITY_CHECKPOINT_SEED,
            identity_mint.as_ref(),
            &0u64.to_le_bytes(),
        ],
        &deal_governance_activity::id(),
    );

    let (bob_receipt, _) = Pubkey::find_program_address(
        &[CLAIM_SEED, round.as_ref(), bob.pubkey().as_ref()],
        &deal_dividend::id(),
    );
    let bob_claim = Instruction::new_with_bytes(
        deal_dividend::id(),
        &deal_dividend::instruction::ClaimForIdentity {
            new_checkpoint_index: 0,
        }
        .data(),
        deal_dividend::accounts::ClaimForIdentity {
            claimer: bob.pubkey(),
            config,
            d_config,
            holder_state: bob_holder,
            balance_checkpoint: bob_checkpoint0,
            successor_checkpoint: None,
            round,
            claim_receipt: bob_receipt,
            vault_authority,
            dividend_vault,
            destination: bob_destination,
            mint: dividend_mint,
            token_program: spl_token_interface::ID,
            activity_config,
            activity_recorder_grant: recorder_grant,
            identity_mint,
            identity,
            owner_identity,
            activity,
            new_activity_checkpoint: activity_checkpoint,
            activity_program: deal_governance_activity::id(),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &bob, &[bob_claim], &[]));
    assert_eq!(token_balance(&svm, bob_destination), 300);
    assert_eq!(token_balance(&svm, dividend_vault), 0);
    assert_eq!(anchor_state::<DividendRound>(&svm, round).claimed, 1_000);
    let activity_state: IdentityActivity = anchor_state(&svm, activity);
    assert_eq!(activity_state.identity_mint, identity_mint);
    assert_eq!(activity_state.checkpoint_count, 1);
    assert_eq!(activity_state.last_active_slot, 100);
    let checkpoint_state: ActivityCheckpoint = anchor_state(&svm, activity_checkpoint);
    assert_eq!(checkpoint_state.identity_mint, identity_mint);
    assert_eq!(checkpoint_state.index, 0);
    assert_eq!(
        anchor_state::<ActivityConfig>(&svm, activity_config).active_total,
        1
    );
}
