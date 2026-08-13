use anchor_lang::{
    prelude::{AccountDeserialize, AccountSerialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_credit_graph::{
    CreditConfig, CreditPeerInput, CreditScore, CONFIG_SEED, SCORE_SEED, TOP_K,
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
use spl_token_interface::state::{Account as TokenAccount, AccountState};

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
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &signers).unwrap();
    let result = svm.send_transaction(tx).is_ok();
    svm.expire_blockhash();
    result
}

fn deserialize<T: AccountDeserialize>(svm: &LiteSVM, address: &Pubkey) -> T {
    let account = svm.get_account(address).expect("account must exist");
    T::try_deserialize(&mut account.data.as_slice()).expect("account must deserialize")
}

fn set_identity(svm: &mut LiteSVM, mint: Pubkey, id: u64) -> Pubkey {
    let (identity, bump) =
        Pubkey::find_program_address(&[IDENTITY_SEED, mint.as_ref()], &deal_identity::id());
    let state = IdentityRecord {
        id,
        mint,
        season: 1,
        date_code: 20_231_114,
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

fn set_token_account(svm: &mut LiteSVM, address: Pubkey, mint: Pubkey, owner: Pubkey) {
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

fn import_instruction(
    payer: Pubkey,
    authority: Pubkey,
    config: Pubkey,
    identity: Pubkey,
    identity_mint: Pubkey,
    score: u128,
) -> Instruction {
    let (credit, _) = Pubkey::find_program_address(
        &[SCORE_SEED, identity_mint.as_ref()],
        &deal_credit_graph::id(),
    );
    Instruction::new_with_bytes(
        deal_credit_graph::id(),
        &deal_credit_graph::instruction::ImportCredit {
            score,
            peers: [CreditPeerInput::default(); TOP_K],
        }
        .data(),
        deal_credit_graph::accounts::ImportCredit {
            config,
            payer,
            import_authority: authority,
            identity,
            credit,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    )
}

#[test]
fn pair_credit_matches_evm_formula_and_blocks_same_owner() {
    let mut svm = LiteSVM::new();
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: 1_700_000_000,
        epoch: 1,
        leader_schedule_epoch: 1,
        unix_timestamp: 1_700_000_000,
    });
    svm.add_program(
        deal_credit_graph::id(),
        include_bytes!("../../../target/deploy/deal_credit_graph.so"),
    )
    .unwrap();

    let authority = Keypair::new();
    let recorder = Keypair::new();
    let outsider = Keypair::new();
    let party_a = Keypair::new();
    let party_b = Keypair::new();
    for wallet in [&authority, &recorder, &outsider, &party_a, &party_b] {
        svm.airdrop(&wallet.pubkey(), 3_000_000_000).unwrap();
    }

    let a_mint = Pubkey::new_unique();
    let b_mint = Pubkey::new_unique();
    let a_identity = set_identity(&mut svm, a_mint, 1);
    let b_identity = set_identity(&mut svm, b_mint, 2);
    let a_owner_token = Pubkey::new_unique();
    let b_owner_token = Pubkey::new_unique();
    set_token_account(&mut svm, a_owner_token, a_mint, party_a.pubkey());
    set_token_account(&mut svm, b_owner_token, b_mint, party_b.pubkey());

    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_credit_graph::id());
    let initialize = Instruction::new_with_bytes(
        deal_credit_graph::id(),
        &deal_credit_graph::instruction::Initialize {
            recorder: recorder.pubkey(),
        }
        .data(),
        deal_credit_graph::accounts::Initialize {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[initialize], &[]));
    assert!(deserialize::<CreditConfig>(&svm, &config).paused);

    let import_a = import_instruction(
        authority.pubkey(),
        authority.pubkey(),
        config,
        a_identity,
        a_mint,
        10_000,
    );
    let import_b = import_instruction(
        authority.pubkey(),
        authority.pubkey(),
        config,
        b_identity,
        b_mint,
        200,
    );
    assert!(send(&mut svm, &authority, &[import_a, import_b], &[]));

    let unpause = Instruction::new_with_bytes(
        deal_credit_graph::id(),
        &deal_credit_graph::instruction::SetPaused { paused: false }.data(),
        deal_credit_graph::accounts::AdminConfig {
            authority: authority.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[unpause], &[]));

    let (a_credit, _) =
        Pubkey::find_program_address(&[SCORE_SEED, a_mint.as_ref()], &deal_credit_graph::id());
    let (b_credit, _) =
        Pubkey::find_program_address(&[SCORE_SEED, b_mint.as_ref()], &deal_credit_graph::id());
    let pair_accounts = deal_credit_graph::accounts::RecordPair {
        config,
        payer: recorder.pubkey(),
        recorder: recorder.pubkey(),
        party_a: party_a.pubkey(),
        party_b: party_b.pubkey(),
        a_identity,
        b_identity,
        a_owner_token,
        b_owner_token,
        a_credit,
        b_credit,
        system_program: anchor_lang::system_program::ID,
    };
    let outsider_record = Instruction::new_with_bytes(
        deal_credit_graph::id(),
        &deal_credit_graph::instruction::RecordPair { base_credit: 3_000 }.data(),
        deal_credit_graph::accounts::RecordPair {
            payer: outsider.pubkey(),
            recorder: outsider.pubkey(),
            ..pair_accounts
        }
        .to_account_metas(None),
    );
    assert!(!send(&mut svm, &outsider, &[outsider_record], &[]));

    let record = Instruction::new_with_bytes(
        deal_credit_graph::id(),
        &deal_credit_graph::instruction::RecordPair { base_credit: 3_000 }.data(),
        pair_accounts.to_account_metas(None),
    );
    assert!(send(&mut svm, &recorder, &[record], &[]));
    let a_state = deserialize::<CreditScore>(&svm, &a_credit);
    let b_state = deserialize::<CreditScore>(&svm, &b_credit);
    assert_eq!(a_state.score, 13_060);
    assert_eq!(b_state.score, 9_200);
    assert_eq!(a_state.top_peers[0].identity_mint, b_mint);
    assert_eq!(a_state.top_peers[0].credit_snapshot, 9_200);
    assert_eq!(b_state.top_peers[0].identity_mint, a_mint);
    assert_eq!(b_state.top_peers[0].credit_snapshot, 13_060);

    set_token_account(&mut svm, b_owner_token, b_mint, party_a.pubkey());
    let same_owner_record = Instruction::new_with_bytes(
        deal_credit_graph::id(),
        &deal_credit_graph::instruction::RecordPair { base_credit: 5_000 }.data(),
        deal_credit_graph::accounts::RecordPair {
            config,
            payer: recorder.pubkey(),
            recorder: recorder.pubkey(),
            party_a: party_a.pubkey(),
            party_b: party_a.pubkey(),
            a_identity,
            b_identity,
            a_owner_token,
            b_owner_token,
            a_credit,
            b_credit,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &recorder, &[same_owner_record], &[]));
    assert_eq!(deserialize::<CreditScore>(&svm, &a_credit).score, 13_060);
    assert_eq!(deserialize::<CreditScore>(&svm, &b_credit).score, 9_200);
}
