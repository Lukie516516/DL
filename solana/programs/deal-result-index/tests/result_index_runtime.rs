use anchor_lang::{
    prelude::{AccountDeserialize, AccountSerialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_core::state::{CompletionReason, DealAccount, DealStatus, JoinMode, TemplateType, Vote};
use deal_finalizer::CreditRecordingReceipt;
use deal_result_index::{
    ResultHeader, ResultPage, CONFIG_SEED, CREDIT_HEADER_SEED, CREDIT_MARKER_SEED,
    CREDIT_PAGE_SEED, CREDIT_SIDE_A, REWARD_HEADER_SEED, REWARD_MARKER_SEED, REWARD_PAGE_SEED,
    REWARD_ROLE_A, REWARD_ROLE_B,
};
use deal_reward_engine::RewardReceipt;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

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
            lamports: 5_000_000,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn completed_deal(creator: Pubkey, participant: Pubkey) -> DealAccount {
    DealAccount {
        id: 9,
        creator,
        participant,
        expected_participant: Pubkey::default(),
        last_removed_participant: Pubkey::default(),
        template_type: TemplateType::TokenToToken,
        open_token_token_fast: false,
        join_mode: JoinMode::Open,
        status: DealStatus::Completed,
        a_vote: Vote::Accept,
        b_vote: Vote::Accept,
        completion_reason: CompletionReason::BothAccepted,
        a_funds_deposited: true,
        b_funds_deposited: true,
        a_asset_deposited: false,
        b_asset_deposited: false,
        a_asset_required: false,
        b_asset_required: false,
        a_has_pre_accepted: true,
        is_domain_deal: false,
        a_swap_amount: 10_000,
        a_margin_amount: 0,
        b_swap_amount: 10_000,
        b_margin_amount: 0,
        timeout_seconds: 300,
        replace_timeout_seconds: 120,
        created_at: 1_700_000_000,
        ended_at: 1_700_000_100,
        b_joined_at: 1_700_000_010,
        locked_at: 1_700_000_020,
        a_vote_at: 1_700_000_030,
        b_vote_at: 1_700_000_040,
        a_pre_accept_at: 1_700_000_015,
        title: "result index".into(),
        description: "paged discovery without log scans".into(),
        domain_name: String::new(),
        bump: 1,
    }
}

fn reward_index_instruction(
    payer: Pubkey,
    deal: Pubkey,
    reward_receipt: Pubkey,
    subject: Pubkey,
    role: u8,
) -> (Instruction, Pubkey, Pubkey, Pubkey) {
    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_result_index::ID);
    let (header, _) = Pubkey::find_program_address(
        &[REWARD_HEADER_SEED, subject.as_ref()],
        &deal_result_index::ID,
    );
    let (page, _) = Pubkey::find_program_address(
        &[REWARD_PAGE_SEED, subject.as_ref(), &0u32.to_le_bytes()],
        &deal_result_index::ID,
    );
    let (marker, _) = Pubkey::find_program_address(
        &[REWARD_MARKER_SEED, subject.as_ref(), deal.as_ref()],
        &deal_result_index::ID,
    );
    let instruction = Instruction::new_with_bytes(
        deal_result_index::ID,
        &deal_result_index::instruction::IndexReward { role, page_no: 0 }.data(),
        deal_result_index::accounts::IndexReward {
            config,
            payer,
            deal,
            reward_receipt,
            subject,
            header,
            page,
            marker,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    (instruction, header, page, marker)
}

#[test]
fn indexes_canonical_reward_and_credit_receipts_without_log_scans() {
    let mut svm = LiteSVM::new();
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: 1_700_000_000,
        epoch: 1,
        leader_schedule_epoch: 1,
        unix_timestamp: 1_700_000_200,
    });
    svm.add_program(
        deal_result_index::ID,
        include_bytes!("../../../target/deploy/deal_result_index.so"),
    )
    .unwrap();

    let authority = Keypair::new();
    let payer = Keypair::new();
    let creator = Keypair::new();
    let participant = Keypair::new();
    for key in [&authority, &payer, &creator, &participant] {
        svm.airdrop(&key.pubkey(), 3_000_000_000).unwrap();
    }

    let deal = Pubkey::new_unique();
    let deal_state = completed_deal(creator.pubkey(), participant.pubkey());
    set_anchor_account(&mut svm, deal, deal_core::ID, &deal_state);

    let (reward_receipt, reward_bump) = Pubkey::find_program_address(
        &[deal_reward_engine::RECEIPT_SEED, deal.as_ref()],
        &deal_reward_engine::ID,
    );
    set_anchor_account(
        &mut svm,
        reward_receipt,
        deal_reward_engine::ID,
        &RewardReceipt {
            deal,
            registry_revision: 3,
            a_identity_mint: Pubkey::new_unique(),
            b_identity_mint: Pubkey::new_unique(),
            c_identity_mint: Pubkey::default(),
            c_recipient: Pubkey::default(),
            a_reward: 1_000,
            b_reward: 2_000,
            c_reward: 0,
            c_score_snapshot: 0,
            minted_at: 1_700_000_101,
            bump: reward_bump,
        },
    );

    let a_identity = Pubkey::new_unique();
    let b_identity = Pubkey::new_unique();
    let (credit_receipt, credit_bump) = Pubkey::find_program_address(
        &[deal_finalizer::CREDIT_RECEIPT_SEED, deal.as_ref()],
        &deal_finalizer::ID,
    );
    set_anchor_account(
        &mut svm,
        credit_receipt,
        deal_finalizer::ID,
        &CreditRecordingReceipt {
            deal,
            valuation_receipt: Pubkey::new_unique(),
            a_identity_mint: a_identity,
            b_identity_mint: b_identity,
            base_credit_u: 30,
            a_delta: 31,
            b_delta: 90,
            recorded_at: 1_700_000_102,
            bump: credit_bump,
        },
    );

    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_result_index::ID);
    let initialize = Instruction::new_with_bytes(
        deal_result_index::ID,
        &deal_result_index::instruction::Initialize {}.data(),
        deal_result_index::accounts::Initialize {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let unpause = Instruction::new_with_bytes(
        deal_result_index::ID,
        &deal_result_index::instruction::SetPaused { paused: false }.data(),
        deal_result_index::accounts::AdminConfig {
            authority: authority.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[initialize, unpause], &[]));

    let (index_a, a_header, a_page, a_marker) = reward_index_instruction(
        payer.pubkey(),
        deal,
        reward_receipt,
        creator.pubkey(),
        REWARD_ROLE_A,
    );
    assert!(send(&mut svm, &payer, std::slice::from_ref(&index_a), &[]));
    assert_eq!(deserialize::<ResultHeader>(&svm, &a_header).count, 1);
    let page = deserialize::<ResultPage>(&svm, &a_page);
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].deal, deal);
    assert_eq!(page.entries[0].recorded_at, 1_700_000_101);
    assert!(svm.get_account(&a_marker).is_some());

    assert!(!send(&mut svm, &payer, &[index_a], &[]));
    assert_eq!(deserialize::<ResultHeader>(&svm, &a_header).count, 1);

    let wrong_subject = Pubkey::new_unique();
    let (wrong_index, wrong_header, _, _) = reward_index_instruction(
        payer.pubkey(),
        deal,
        reward_receipt,
        wrong_subject,
        REWARD_ROLE_A,
    );
    assert!(!send(&mut svm, &payer, &[wrong_index], &[]));
    assert!(svm.get_account(&wrong_header).is_none());

    let (index_b, b_header, _, _) = reward_index_instruction(
        payer.pubkey(),
        deal,
        reward_receipt,
        participant.pubkey(),
        REWARD_ROLE_B,
    );
    assert!(send(&mut svm, &payer, &[index_b], &[]));
    assert_eq!(deserialize::<ResultHeader>(&svm, &b_header).count, 1);

    let (credit_header, _) = Pubkey::find_program_address(
        &[CREDIT_HEADER_SEED, a_identity.as_ref()],
        &deal_result_index::ID,
    );
    let (credit_page, _) = Pubkey::find_program_address(
        &[CREDIT_PAGE_SEED, a_identity.as_ref(), &0u32.to_le_bytes()],
        &deal_result_index::ID,
    );
    let (credit_marker, _) = Pubkey::find_program_address(
        &[CREDIT_MARKER_SEED, a_identity.as_ref(), deal.as_ref()],
        &deal_result_index::ID,
    );
    let index_credit = Instruction::new_with_bytes(
        deal_result_index::ID,
        &deal_result_index::instruction::IndexCredit {
            side: CREDIT_SIDE_A,
            page_no: 0,
        }
        .data(),
        deal_result_index::accounts::IndexCredit {
            config,
            payer: payer.pubkey(),
            deal,
            credit_receipt,
            subject: a_identity,
            header: credit_header,
            page: credit_page,
            marker: credit_marker,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[index_credit], &[]));
    assert_eq!(deserialize::<ResultHeader>(&svm, &credit_header).count, 1);
    let credit_results = deserialize::<ResultPage>(&svm, &credit_page);
    assert_eq!(credit_results.entries[0].recorded_at, 1_700_000_102);
}
