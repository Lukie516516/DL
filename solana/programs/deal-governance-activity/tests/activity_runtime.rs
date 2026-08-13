use anchor_lang::{
    prelude::{AccountDeserialize, AccountSerialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_governance_activity::{
    ActivityCheckpoint, ActivityConfig, IdentityActivity, ACTIVITY_SEED, CHECKPOINT_SEED,
    CONFIG_SEED, DEFAULT_ACTIVE_WINDOW_SECONDS, RECORDER_SEED,
};
use deal_identity::{IdentityRecord, IDENTITY_SEED};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use spl_token_interface::state::{Account as TokenAccount, AccountState, Mint};

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
    let result = svm.send_transaction(transaction).is_ok();
    svm.expire_blockhash();
    result
}

fn anchor_state<T: AccountDeserialize>(svm: &LiteSVM, address: Pubkey) -> T {
    let account = svm.get_account(&address).expect("account must exist");
    T::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn set_identity(svm: &mut LiteSVM, mint: Pubkey, id: u64) -> Pubkey {
    let (identity, bump) =
        Pubkey::find_program_address(&[IDENTITY_SEED, mint.as_ref()], &deal_identity::id());
    let state = IdentityRecord {
        id,
        mint,
        season: 1,
        date_code: 20_260_719,
        daily_serial: id as u32,
        total_dc_minted: 0,
        max_partner: mint,
        lock_count: 0,
        bump,
    };
    let mut data = Vec::new();
    state.try_serialize(&mut data).unwrap();
    svm.set_account(
        identity,
        Account {
            lamports: 2_000_000,
            data,
            owner: deal_identity::id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    identity
}

fn set_identity_mint(svm: &mut LiteSVM, mint: Pubkey, authority: Pubkey) {
    let state = Mint {
        mint_authority: COption::Some(authority),
        supply: 1,
        decimals: 0,
        is_initialized: true,
        freeze_authority: COption::Some(authority),
    };
    let mut data = vec![0u8; Mint::LEN];
    Mint::pack(state, &mut data).unwrap();
    svm.set_account(
        mint,
        Account {
            lamports: 2_000_000,
            data,
            owner: spl_token_interface::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn set_identity_token(svm: &mut LiteSVM, address: Pubkey, mint: Pubkey, owner: Pubkey) {
    let state = TokenAccount {
        mint,
        owner,
        amount: 1,
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
            lamports: 2_000_000,
            data,
            owner: spl_token_interface::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn activity_pda(mint: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[ACTIVITY_SEED, mint.as_ref()],
        &deal_governance_activity::id(),
    )
    .0
}

fn checkpoint_pda(mint: Pubkey, index: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[CHECKPOINT_SEED, mint.as_ref(), &index.to_le_bytes()],
        &deal_governance_activity::id(),
    )
    .0
}

#[test]
fn only_recorders_can_create_exact_activity_history_and_expired_supply_is_drained() {
    let mut svm = LiteSVM::new();
    svm.add_program(
        deal_governance_activity::id(),
        include_bytes!("../../../target/deploy/deal_governance_activity.so"),
    )
    .unwrap();
    let initial_timestamp = 1_700_000_000;
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: initial_timestamp,
        epoch: 1,
        leader_schedule_epoch: 1,
        unix_timestamp: initial_timestamp,
    });

    let payer = Keypair::new();
    let authority = Keypair::new();
    let recorder = Keypair::new();
    let attacker = Keypair::new();
    let owner = Keypair::new();
    for wallet in [&payer, &authority, &recorder, &attacker, &owner] {
        svm.airdrop(&wallet.pubkey(), 20_000_000_000).unwrap();
    }

    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_governance_activity::id());
    let initialize = Instruction::new_with_bytes(
        deal_governance_activity::id(),
        &deal_governance_activity::instruction::Initialize {
            active_window_seconds: DEFAULT_ACTIVE_WINDOW_SECONDS,
        }
        .data(),
        deal_governance_activity::accounts::Initialize {
            payer: payer.pubkey(),
            authority: authority.pubkey(),
            config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[initialize], &[&authority]));

    let (recorder_grant, _) = Pubkey::find_program_address(
        &[RECORDER_SEED, recorder.pubkey().as_ref()],
        &deal_governance_activity::id(),
    );
    let allow_recorder = Instruction::new_with_bytes(
        deal_governance_activity::id(),
        &deal_governance_activity::instruction::SetRecorder { allowed: true }.data(),
        deal_governance_activity::accounts::SetRecorder {
            payer: payer.pubkey(),
            authority: authority.pubkey(),
            recorder: recorder.pubkey(),
            config,
            recorder_grant,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[allow_recorder], &[&authority]));

    let mint = Pubkey::new_unique();
    let identity = set_identity(&mut svm, mint, 1);
    set_identity_mint(&mut svm, mint, authority.pubkey());
    let owner_identity = Pubkey::new_unique();
    set_identity_token(&mut svm, owner_identity, mint, owner.pubkey());
    let activity = activity_pda(mint);
    let checkpoint0 = checkpoint_pda(mint, 0);

    let mark_accounts = deal_governance_activity::accounts::MarkActive {
        payer: payer.pubkey(),
        recorder: recorder.pubkey(),
        owner: owner.pubkey(),
        config,
        recorder_grant,
        identity_mint: mint,
        identity,
        owner_identity,
        activity,
        checkpoint: checkpoint0,
        system_program: anchor_lang::system_program::ID,
    };
    let unauthorized_mark = Instruction::new_with_bytes(
        deal_governance_activity::id(),
        &deal_governance_activity::instruction::MarkActive {
            checkpoint_index: 0,
        }
        .data(),
        deal_governance_activity::accounts::MarkActive {
            recorder: attacker.pubkey(),
            ..mark_accounts
        }
        .to_account_metas(None),
    );
    assert!(!send(
        &mut svm,
        &payer,
        &[unauthorized_mark],
        &[&attacker, &owner]
    ));

    let mark = Instruction::new_with_bytes(
        deal_governance_activity::id(),
        &deal_governance_activity::instruction::MarkActive {
            checkpoint_index: 0,
        }
        .data(),
        mark_accounts.to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[mark], &[&recorder, &owner]));
    let config_state: ActivityConfig = anchor_state(&svm, config);
    assert_eq!(config_state.active_total, 1);
    let activity_state: IdentityActivity = anchor_state(&svm, activity);
    assert_eq!(activity_state.identity_mint, mint);
    assert_eq!(activity_state.checkpoint_count, 1);
    assert_eq!(activity_state.last_active_at, initial_timestamp);
    let checkpoint_state: ActivityCheckpoint = anchor_state(&svm, checkpoint0);
    assert_eq!(checkpoint_state.timestamp, initial_timestamp);
    assert_eq!(checkpoint_state.index, 0);

    let checkpoint1 = checkpoint_pda(mint, 1);
    let mark_again = Instruction::new_with_bytes(
        deal_governance_activity::id(),
        &deal_governance_activity::instruction::MarkActive {
            checkpoint_index: 1,
        }
        .data(),
        deal_governance_activity::accounts::MarkActive {
            checkpoint: checkpoint1,
            ..mark_accounts
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[mark_again], &[&recorder, &owner]));
    assert_eq!(anchor_state::<ActivityConfig>(&svm, config).active_total, 1);
    assert_eq!(
        anchor_state::<IdentityActivity>(&svm, activity).checkpoint_count,
        2
    );

    let expired_timestamp = initial_timestamp + (91 * 86_400);
    svm.set_sysvar(&Clock {
        slot: 100,
        epoch_start_timestamp: expired_timestamp,
        epoch: 2,
        leader_schedule_epoch: 2,
        unix_timestamp: expired_timestamp,
    });
    let sync = Instruction::new_with_bytes(
        deal_governance_activity::id(),
        &deal_governance_activity::instruction::SyncActivity {}.data(),
        deal_governance_activity::accounts::SyncActivity { config }.to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[sync], &[]));
    assert_eq!(anchor_state::<ActivityConfig>(&svm, config).active_total, 0);
}
