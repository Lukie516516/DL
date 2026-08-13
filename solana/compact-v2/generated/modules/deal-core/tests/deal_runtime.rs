use anchor_lang::{
    prelude::{AccountDeserialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_core::{
    constants::{DEAL_SEED, REGISTRY_SEED},
    state::{
        CompletionReason, CreateDealParams, DealAccount, DealRegistry, DealStatus, DepositKind,
        JoinMode, TemplateType, Vote,
    },
};
use litesvm::LiteSVM;
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

#[test]
fn creates_locks_votes_and_settles_through_controller_boundary() {
    let mut svm = LiteSVM::new();
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: 1_700_000_000,
        epoch: 1,
        leader_schedule_epoch: 1,
        unix_timestamp: 1_700_000_000,
    });
    svm.add_program(
        deal_core::id(),
        include_bytes!("../../../target/deploy/deal_compact_lifecycle.so"),
    )
    .unwrap();

    let creator = Keypair::new();
    let participant = Keypair::new();
    let asset_controller = Keypair::new();
    let identity_controller = Keypair::new();
    let fake_controller = Keypair::new();
    svm.airdrop(&creator.pubkey(), 20_000_000_000).unwrap();
    svm.airdrop(&participant.pubkey(), 1_000_000_000).unwrap();

    let (registry, _) = Pubkey::find_program_address(&[REGISTRY_SEED], &deal_core::id());
    let deal_id = 1u64;
    let (deal, _) = Pubkey::find_program_address(
        &[DEAL_SEED, deal_id.to_le_bytes().as_ref()],
        &deal_core::id(),
    );

    let initialize = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::InitializeRegistry {
            asset_controller: asset_controller.pubkey(),
            identity_controller: identity_controller.pubkey(),
        }
        .data(),
        deal_core::accounts::InitializeRegistry {
            authority: creator.pubkey(),
            registry,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[initialize], &[]));

    let unpause = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::SetPaused { paused: false }.data(),
        deal_core::accounts::AdminConfig {
            authority: creator.pubkey(),
            registry,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[unpause], &[]));
    assert_eq!(
        deserialize::<DealRegistry>(&svm, &registry).min_timeout_seconds,
        3_600
    );

    let params = CreateDealParams {
        template_type: TemplateType::TokenToToken,
        open_token_token_fast: false,
        join_mode: JoinMode::Open,
        expected_participant: Pubkey::default(),
        a_swap_amount: 100,
        a_margin_amount: 0,
        b_swap_amount: 200,
        b_margin_amount: 0,
        a_has_asset_nft: false,
        b_has_asset_nft: false,
        title: "runtime deal".into(),
        description: "PDA and controller test".into(),
        timeout_seconds: 3_600,
        replace_timeout_seconds: 120,
        is_domain_deal: false,
        domain_name: String::new(),
    };
    let mut too_short_params = params.clone();
    too_short_params.timeout_seconds = 3_599;
    let create_too_short = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::CreateDeal {
            deal_id,
            params: too_short_params,
        }
        .data(),
        deal_core::accounts::CreateDeal {
            creator: creator.pubkey(),
            registry,
            deal,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(!send(&mut svm, &creator, &[create_too_short], &[]));
    assert_eq!(
        deserialize::<DealRegistry>(&svm, &registry).next_deal_id,
        deal_id
    );

    let mut forged_domain_params = params.clone();
    forged_domain_params.is_domain_deal = true;
    forged_domain_params.domain_name = "forged.sol".into();
    let create_forged_domain = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::CreateDeal {
            deal_id,
            params: forged_domain_params,
        }
        .data(),
        deal_core::accounts::CreateDeal {
            creator: creator.pubkey(),
            registry,
            deal,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(!send(&mut svm, &creator, &[create_forged_domain], &[]));
    assert_eq!(
        deserialize::<DealRegistry>(&svm, &registry).next_deal_id,
        deal_id
    );

    let create = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::CreateDeal { deal_id, params }.data(),
        deal_core::accounts::CreateDeal {
            creator: creator.pubkey(),
            registry,
            deal,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[create], &[]));
    assert_eq!(
        deserialize::<DealAccount>(&svm, &deal).status,
        DealStatus::Ready
    );

    let invalid_floor = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::SetMinTimeoutSeconds {
            min_timeout_seconds: 1_799,
        }
        .data(),
        deal_core::accounts::AdminConfig {
            authority: creator.pubkey(),
            registry,
        }
        .to_account_metas(None),
    );
    assert!(!send(&mut svm, &creator, &[invalid_floor], &[]));
    let lower_floor = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::SetMinTimeoutSeconds {
            min_timeout_seconds: 1_800,
        }
        .data(),
        deal_core::accounts::AdminConfig {
            authority: creator.pubkey(),
            registry,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[lower_floor], &[]));
    assert_eq!(
        deserialize::<DealRegistry>(&svm, &registry).min_timeout_seconds,
        1_800
    );

    let join = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::JoinDeal {}.data(),
        deal_core::accounts::JoinDeal {
            participant: participant.pubkey(),
            deal,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[join], &[&participant]));

    let fake_deposit = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::RecordDeposit {
            is_party_a: true,
            kind: DepositKind::Funds,
        }
        .data(),
        deal_core::accounts::AssetAction {
            actor: creator.pubkey(),
            asset_controller: fake_controller.pubkey(),
            registry,
            deal,
        }
        .to_account_metas(None),
    );
    assert!(!send(
        &mut svm,
        &creator,
        &[fake_deposit],
        &[&fake_controller],
    ));
    assert!(!deserialize::<DealAccount>(&svm, &deal).a_funds_deposited);

    let deposit_a = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::RecordDeposit {
            is_party_a: true,
            kind: DepositKind::Funds,
        }
        .data(),
        deal_core::accounts::AssetAction {
            actor: creator.pubkey(),
            asset_controller: asset_controller.pubkey(),
            registry,
            deal,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[deposit_a], &[&asset_controller],));

    let deposit_b = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::RecordDeposit {
            is_party_a: false,
            kind: DepositKind::Funds,
        }
        .data(),
        deal_core::accounts::AssetAction {
            actor: participant.pubkey(),
            asset_controller: asset_controller.pubkey(),
            registry,
            deal,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &creator,
        &[deposit_b],
        &[&participant, &asset_controller],
    ));
    assert_eq!(
        deserialize::<DealAccount>(&svm, &deal).status,
        DealStatus::Locked
    );

    let vote_a = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::CastVote { vote: Vote::Accept }.data(),
        deal_core::accounts::PartyAction {
            actor: creator.pubkey(),
            deal,
        }
        .to_account_metas(None),
    );
    let vote_b = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::CastVote { vote: Vote::Accept }.data(),
        deal_core::accounts::PartyAction {
            actor: participant.pubkey(),
            deal,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[vote_a], &[]));
    assert!(send(&mut svm, &creator, &[vote_b], &[&participant]));

    let settle = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::SettleVotes {}.data(),
        deal_core::accounts::Settlement {
            asset_controller: asset_controller.pubkey(),
            registry,
            deal,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[settle], &[&asset_controller],));
    let completed = deserialize::<DealAccount>(&svm, &deal);
    assert_eq!(completed.status, DealStatus::Completed);
    assert_eq!(completed.completion_reason, CompletionReason::BothAccepted);
    assert!(completed.ended_at > 0);
}
