use anchor_lang::{
    prelude::{AccountDeserialize, AccountSerialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_core::state::{CompletionReason, DealAccount, DealStatus, JoinMode, TemplateType, Vote};
use deal_history_index::{
    ActiveDealPage, CreditData, CreditRecord, RewardData, RewardRecord, TimelineData,
    TimelineHeader, TimelinePage, UserActivity, ACTIVE_MARKER_SEED, ACTIVE_PAGE_SEED, CONFIG_SEED,
    CREDIT_SEED, REWARD_SEED, TIMELINE_HEADER_SEED, TIMELINE_PAGE_SEED, USER_ACTIVITY_SEED,
};
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

fn mock_deal(creator: Pubkey, participant: Pubkey, status: DealStatus) -> DealAccount {
    DealAccount {
        id: 1,
        creator,
        participant,
        expected_participant: Pubkey::default(),
        last_removed_participant: Pubkey::default(),
        template_type: TemplateType::TokenToToken,
        open_token_token_fast: false,
        join_mode: JoinMode::Open,
        status,
        a_vote: Vote::Accept,
        b_vote: Vote::Accept,
        completion_reason: if status == DealStatus::Completed {
            CompletionReason::BothAccepted
        } else {
            CompletionReason::None
        },
        a_funds_deposited: true,
        b_funds_deposited: true,
        a_asset_deposited: false,
        b_asset_deposited: false,
        a_asset_required: false,
        b_asset_required: false,
        a_has_pre_accepted: true,
        is_domain_deal: false,
        a_swap_amount: 100,
        a_margin_amount: 0,
        b_swap_amount: 200,
        b_margin_amount: 0,
        timeout_seconds: 300,
        replace_timeout_seconds: 120,
        created_at: 1_700_000_000,
        ended_at: if status == DealStatus::Completed {
            1_700_000_100
        } else {
            0
        },
        b_joined_at: 1_700_000_010,
        locked_at: 1_700_000_020,
        a_vote_at: 1_700_000_030,
        b_vote_at: 1_700_000_040,
        a_pre_accept_at: 1_700_000_015,
        title: "history runtime".into(),
        description: "paged account index".into(),
        domain_name: String::new(),
        bump: 1,
    }
}

fn set_deal(svm: &mut LiteSVM, address: Pubkey, deal: &DealAccount) {
    let mut data = Vec::new();
    deal.try_serialize(&mut data).unwrap();
    svm.set_account(
        address,
        Account {
            lamports: 5_000_000,
            data,
            owner: deal_core::id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

#[test]
fn indexes_activity_results_and_timeline_without_log_scans() {
    let mut svm = LiteSVM::new();
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: 1_700_000_000,
        epoch: 1,
        leader_schedule_epoch: 1,
        unix_timestamp: 1_700_000_000,
    });
    svm.add_program(
        deal_history_index::id(),
        include_bytes!("../../../target/deploy/deal_history_index.so"),
    )
    .unwrap();

    let authority = Keypair::new();
    let writer = Keypair::new();
    let unauthorized = Keypair::new();
    let creator = Keypair::new();
    let participant = Keypair::new();
    for key in [&authority, &writer, &unauthorized, &creator, &participant] {
        svm.airdrop(&key.pubkey(), 3_000_000_000).unwrap();
    }

    let deal = Pubkey::new_unique();
    set_deal(
        &mut svm,
        deal,
        &mock_deal(creator.pubkey(), participant.pubkey(), DealStatus::Active),
    );
    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_history_index::id());
    let initialize = Instruction::new_with_bytes(
        deal_history_index::id(),
        &deal_history_index::instruction::Initialize {
            trusted_writer: writer.pubkey(),
        }
        .data(),
        deal_history_index::accounts::Initialize {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let unpause = Instruction::new_with_bytes(
        deal_history_index::id(),
        &deal_history_index::instruction::SetPaused { paused: false }.data(),
        deal_history_index::accounts::AdminConfig {
            authority: authority.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[initialize, unpause], &[]));

    let (header, _) = Pubkey::find_program_address(
        &[USER_ACTIVITY_SEED, creator.pubkey().as_ref()],
        &deal_history_index::id(),
    );
    let (page, _) = Pubkey::find_program_address(
        &[
            ACTIVE_PAGE_SEED,
            creator.pubkey().as_ref(),
            &0u32.to_le_bytes(),
        ],
        &deal_history_index::id(),
    );
    let (marker, _) = Pubkey::find_program_address(
        &[ACTIVE_MARKER_SEED, creator.pubkey().as_ref(), deal.as_ref()],
        &deal_history_index::id(),
    );
    let add_tracked = Instruction::new_with_bytes(
        deal_history_index::id(),
        &deal_history_index::instruction::AddTracked { page_no: 0 }.data(),
        deal_history_index::accounts::AddTracked {
            config,
            payer: writer.pubkey(),
            user: creator.pubkey(),
            deal,
            header,
            page,
            marker,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &writer, &[add_tracked], &[]));
    assert_eq!(deserialize::<UserActivity>(&svm, &header).tracked_count, 1);
    let active_page = deserialize::<ActiveDealPage>(&svm, &page);
    assert_eq!(active_page.entries.len(), 1);
    assert!(active_page.entries[0].active);

    set_deal(
        &mut svm,
        deal,
        &mock_deal(creator.pubkey(), participant.pubkey(), DealStatus::Canceled),
    );
    let remove = Instruction::new_with_bytes(
        deal_history_index::id(),
        &deal_history_index::instruction::RemoveTracked {}.data(),
        deal_history_index::accounts::RemoveTracked {
            config,
            payer: writer.pubkey(),
            user: creator.pubkey(),
            deal,
            header,
            page,
            marker,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &writer, &[remove], &[]));
    assert_eq!(deserialize::<UserActivity>(&svm, &header).tracked_count, 0);
    assert!(!deserialize::<ActiveDealPage>(&svm, &page).entries[0].active);
    assert!(svm.get_account(&marker).is_none());

    let replacement = Keypair::new();
    svm.airdrop(&replacement.pubkey(), 3_000_000_000).unwrap();
    let replaced_deal = Pubkey::new_unique();
    set_deal(
        &mut svm,
        replaced_deal,
        &mock_deal(creator.pubkey(), participant.pubkey(), DealStatus::Active),
    );
    let (old_b_header, _) = Pubkey::find_program_address(
        &[USER_ACTIVITY_SEED, participant.pubkey().as_ref()],
        &deal_history_index::id(),
    );
    let (old_b_page, _) = Pubkey::find_program_address(
        &[
            ACTIVE_PAGE_SEED,
            participant.pubkey().as_ref(),
            &0u32.to_le_bytes(),
        ],
        &deal_history_index::id(),
    );
    let (old_b_marker, _) = Pubkey::find_program_address(
        &[
            ACTIVE_MARKER_SEED,
            participant.pubkey().as_ref(),
            replaced_deal.as_ref(),
        ],
        &deal_history_index::id(),
    );
    let track_old_b = Instruction::new_with_bytes(
        deal_history_index::id(),
        &deal_history_index::instruction::AddTracked { page_no: 0 }.data(),
        deal_history_index::accounts::AddTracked {
            config,
            payer: unauthorized.pubkey(),
            user: participant.pubkey(),
            deal: replaced_deal,
            header: old_b_header,
            page: old_b_page,
            marker: old_b_marker,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &unauthorized, &[track_old_b], &[]));

    let mut replaced = mock_deal(creator.pubkey(), replacement.pubkey(), DealStatus::Active);
    replaced.last_removed_participant = participant.pubkey();
    set_deal(&mut svm, replaced_deal, &replaced);
    let untrack_old_b = Instruction::new_with_bytes(
        deal_history_index::id(),
        &deal_history_index::instruction::RemoveTracked {}.data(),
        deal_history_index::accounts::RemoveTracked {
            config,
            payer: unauthorized.pubkey(),
            user: participant.pubkey(),
            deal: replaced_deal,
            header: old_b_header,
            page: old_b_page,
            marker: old_b_marker,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &unauthorized, &[untrack_old_b], &[]));
    assert_eq!(
        deserialize::<UserActivity>(&svm, &old_b_header).tracked_count,
        0
    );

    set_deal(
        &mut svm,
        deal,
        &mock_deal(
            creator.pubkey(),
            participant.pubkey(),
            DealStatus::Completed,
        ),
    );
    let add_completed = Instruction::new_with_bytes(
        deal_history_index::id(),
        &deal_history_index::instruction::AddCompleted {}.data(),
        deal_history_index::accounts::AddCompleted {
            config,
            payer: writer.pubkey(),
            writer: writer.pubkey(),
            user: creator.pubkey(),
            deal,
            header,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &writer, &[add_completed], &[]));
    let completed = deserialize::<UserActivity>(&svm, &header);
    assert_eq!(completed.completed_size, 1);
    assert_eq!(completed.completed[0], deal);

    let reward_data = RewardData {
        deal,
        party_a: creator.pubkey(),
        to_a: 10,
        party_b: participant.pubkey(),
        to_b: 20,
        c_addr: Pubkey::default(),
        to_c: 0,
    };
    let (reward, _) =
        Pubkey::find_program_address(&[REWARD_SEED, deal.as_ref()], &deal_history_index::id());
    let unauthorized_reward = Instruction::new_with_bytes(
        deal_history_index::id(),
        &deal_history_index::instruction::RecordReward {
            data: reward_data.clone(),
        }
        .data(),
        deal_history_index::accounts::RecordReward {
            config,
            payer: unauthorized.pubkey(),
            writer: unauthorized.pubkey(),
            deal,
            reward,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(!send(&mut svm, &unauthorized, &[unauthorized_reward], &[]));
    assert!(svm.get_account(&reward).is_none());

    let record_reward = Instruction::new_with_bytes(
        deal_history_index::id(),
        &deal_history_index::instruction::RecordReward { data: reward_data }.data(),
        deal_history_index::accounts::RecordReward {
            config,
            payer: writer.pubkey(),
            writer: writer.pubkey(),
            deal,
            reward,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &writer, &[record_reward], &[]));
    assert_eq!(deserialize::<RewardRecord>(&svm, &reward).to_b, 20);

    let credit_data = CreditData {
        deal,
        a_identity: Pubkey::new_unique(),
        b_identity: Pubkey::new_unique(),
        base_credit: 30,
        a_delta: 31,
        b_delta: 90,
    };
    let (credit, _) =
        Pubkey::find_program_address(&[CREDIT_SEED, deal.as_ref()], &deal_history_index::id());
    let record_credit = Instruction::new_with_bytes(
        deal_history_index::id(),
        &deal_history_index::instruction::RecordCredit { data: credit_data }.data(),
        deal_history_index::accounts::RecordCredit {
            config,
            payer: writer.pubkey(),
            writer: writer.pubkey(),
            deal,
            credit,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &writer, &[record_credit], &[]));
    assert_eq!(deserialize::<CreditRecord>(&svm, &credit).b_delta, 90);

    let (timeline_header, _) = Pubkey::find_program_address(
        &[TIMELINE_HEADER_SEED, deal.as_ref()],
        &deal_history_index::id(),
    );
    let (timeline_page, _) = Pubkey::find_program_address(
        &[TIMELINE_PAGE_SEED, deal.as_ref(), &0u32.to_le_bytes()],
        &deal_history_index::id(),
    );
    let record_timeline = Instruction::new_with_bytes(
        deal_history_index::id(),
        &deal_history_index::instruction::RecordTimeline {
            index: 0,
            page_no: 0,
            data: TimelineData {
                deal,
                action: 8,
                actor: creator.pubkey(),
                is_party_a: true,
                value: 0,
            },
        }
        .data(),
        deal_history_index::accounts::RecordTimeline {
            config,
            payer: writer.pubkey(),
            writer: writer.pubkey(),
            deal,
            timeline_header,
            timeline_page,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &writer, &[record_timeline], &[]));
    assert_eq!(
        deserialize::<TimelineHeader>(&svm, &timeline_header).count,
        1
    );
    let timeline = deserialize::<TimelinePage>(&svm, &timeline_page);
    assert_eq!(timeline.entries.len(), 1);
    assert_eq!(timeline.entries[0].action, 8);
}
