use anchor_lang::{
    prelude::{AccountDeserialize, AccountSerialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_asset_controller::{
    state::{AssetSpec, AssetTerms, ControllerConfig},
    CONTROLLER_SEED, TERMS_SEED,
};
use deal_core::state::{CompletionReason, DealAccount, DealStatus, JoinMode, TemplateType, Vote};
use deal_credit_graph::{CreditConfig, CreditScore, CONFIG_SEED as CREDIT_CONFIG_SEED, SCORE_SEED};
use deal_credit_valuator::CreditValuationReceipt;
use deal_finalizer::{
    CreditRecordingReceipt, FinalizerConfig, TerminalReceipt, CONFIG_SEED, CREDIT_RECEIPT_SEED,
    HISTORY_RECEIPT_SEED, RECEIPT_SEED, WRITER_SEED,
};
use deal_history_index::{UserActivity, CONFIG_SEED as HISTORY_CONFIG_SEED, USER_ACTIVITY_SEED};
use deal_identity::{DealIdentityBinding, IdentityRecord, BINDING_SEED, IDENTITY_SEED};
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

fn set_deal(svm: &mut LiteSVM, address: Pubkey, deal: DealAccount) {
    let mut data = Vec::new();
    deal.try_serialize(&mut data).unwrap();
    svm.set_account(
        address,
        Account {
            lamports: 20_000_000,
            data,
            owner: deal_core::id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
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
            lamports: 2_000_000,
            data,
            owner: spl_token_interface::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn set_asset_guard_accounts(
    svm: &mut LiteSVM,
    authority: Pubkey,
    deal: Pubkey,
    a_identity_mint: Pubkey,
    b_identity_mint: Pubkey,
    terminal_guard_enabled: bool,
) -> (Pubkey, Pubkey) {
    let deal_state = deserialize::<DealAccount>(svm, &deal);
    let (asset_config, config_bump) =
        Pubkey::find_program_address(&[CONTROLLER_SEED], &deal_asset_controller::id());
    set_anchor_account(
        svm,
        asset_config,
        deal_asset_controller::id(),
        &ControllerConfig {
            authority,
            pending_authority: Pubkey::default(),
            treasury: Pubkey::new_unique(),
            dc_mint: Pubkey::new_unique(),
            fee_numerator: 3,
            fee_denominator: 1_000,
            terminal_guard_enabled,
            paused: false,
            bump: config_bump,
        },
    );
    let (terms, terms_bump) =
        Pubkey::find_program_address(&[TERMS_SEED, deal.as_ref()], &deal_asset_controller::id());
    set_anchor_account(
        svm,
        terms,
        deal_asset_controller::id(),
        &AssetTerms {
            deal,
            creator: deal_state.creator,
            a_swap: AssetSpec::none(),
            a_margin: AssetSpec::none(),
            b_swap: AssetSpec::none(),
            b_margin: AssetSpec::none(),
            a_asset_nft: AssetSpec::none(),
            b_asset_nft: AssetSpec::none(),
            b_depositor: deal_state.participant,
            a_identity_mint,
            b_identity_mint,
            a_funds_escrowed: false,
            b_funds_escrowed: false,
            a_nft_escrowed: false,
            b_nft_escrowed: false,
            resolved: true,
            dc_fees_routed: true,
            a_fee_paid: 0,
            b_fee_paid: 0,
            bump: terms_bump,
        },
    );
    (asset_config, terms)
}

fn completed_deal(creator: Pubkey, participant: Pubkey) -> DealAccount {
    DealAccount {
        id: 1,
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
        a_has_pre_accepted: false,
        is_domain_deal: false,
        a_swap_amount: 10_000,
        a_margin_amount: 0,
        b_swap_amount: 20_000,
        b_margin_amount: 0,
        timeout_seconds: 300,
        replace_timeout_seconds: 120,
        created_at: 1_700_000_000,
        ended_at: 1_700_000_100,
        b_joined_at: 1_700_000_010,
        locked_at: 1_700_000_020,
        a_vote_at: 1_700_000_090,
        b_vote_at: 1_700_000_100,
        a_pre_accept_at: 0,
        title: "completed".into(),
        description: "terminal indexing runtime test".into(),
        domain_name: String::new(),
        bump: 1,
    }
}

struct CreditBase {
    deal: Pubkey,
    config: Pubkey,
    writer: Pubkey,
    terminal_receipt: Pubkey,
    valuation_receipt: Pubkey,
    credit_config: Pubkey,
    credit_receipt: Pubkey,
    asset_config: Pubkey,
    terms: Pubkey,
    base_credit_u: u128,
}

fn setup_credit_base(
    svm: &mut LiteSVM,
    payer: &Keypair,
    party_a: Pubkey,
    party_b: Pubkey,
) -> CreditBase {
    let deal = Pubkey::new_unique();
    let deal_state = completed_deal(party_a, party_b);
    set_deal(svm, deal, deal_state.clone());

    let (config, config_bump) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_finalizer::id());
    let (writer, _) = Pubkey::find_program_address(&[WRITER_SEED], &deal_finalizer::id());
    set_anchor_account(
        svm,
        config,
        deal_finalizer::id(),
        &FinalizerConfig {
            authority: payer.pubkey(),
            pending_authority: Pubkey::default(),
            history_index: deal_history_index::id(),
            paused: false,
            bump: config_bump,
        },
    );

    let (terminal_receipt, terminal_bump) =
        Pubkey::find_program_address(&[RECEIPT_SEED, deal.as_ref()], &deal_finalizer::id());
    set_anchor_account(
        svm,
        terminal_receipt,
        deal_finalizer::id(),
        &TerminalReceipt {
            deal,
            creator: party_a,
            participant: party_b,
            status: DealStatus::Completed,
            completion_reason: CompletionReason::BothAccepted,
            ended_at: deal_state.ended_at,
            finalized_at: 1_700_000_150,
            finalized_by: payer.pubkey(),
            bump: terminal_bump,
        },
    );

    let (valuation_receipt, valuation_bump) = Pubkey::find_program_address(
        &[deal_credit_valuator::VALUATION_SEED, deal.as_ref()],
        &deal_credit_valuator::id(),
    );
    let base_credit_u = 30_000_000_000_000u128;
    set_anchor_account(
        svm,
        valuation_receipt,
        deal_credit_valuator::id(),
        &CreditValuationReceipt {
            deal,
            registry_revision: 1,
            a_fee_paid: 30,
            b_fee_paid: 0,
            a_credit_u: base_credit_u,
            b_credit_u: 0,
            base_credit_u,
            ended_at: deal_state.ended_at,
            valued_at: 1_700_000_160,
            bump: valuation_bump,
        },
    );

    let (credit_config, credit_config_bump) =
        Pubkey::find_program_address(&[CREDIT_CONFIG_SEED], &deal_credit_graph::id());
    set_anchor_account(
        svm,
        credit_config,
        deal_credit_graph::id(),
        &CreditConfig {
            authority: payer.pubkey(),
            pending_authority: Pubkey::default(),
            recorder: writer,
            import_authority: payer.pubkey(),
            migration_locked: false,
            paused: false,
            bump: credit_config_bump,
        },
    );

    let (credit_receipt, _) =
        Pubkey::find_program_address(&[CREDIT_RECEIPT_SEED, deal.as_ref()], &deal_finalizer::id());
    let (asset_config, terms) = set_asset_guard_accounts(
        svm,
        payer.pubkey(),
        deal,
        Pubkey::default(),
        Pubkey::default(),
        false,
    );
    CreditBase {
        deal,
        config,
        writer,
        terminal_receipt,
        valuation_receipt,
        credit_config,
        credit_receipt,
        asset_config,
        terms,
        base_credit_u,
    }
}

fn assert_single_credit_path(is_party_a: bool) {
    let mut svm = LiteSVM::new();
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: 1_700_000_000,
        epoch: 1,
        leader_schedule_epoch: 1,
        unix_timestamp: 1_700_000_200,
    });
    svm.add_program(
        deal_credit_graph::id(),
        include_bytes!("../../../target/deploy/deal_compact_identity_credit.so"),
    )
    .unwrap();
    svm.add_program(
        deal_finalizer::id(),
        include_bytes!("../../../target/deploy/deal_compact_settlement.so"),
    )
    .unwrap();

    let payer = Keypair::new();
    let party_a = Keypair::new();
    let party_b = Keypair::new();
    for wallet in [&payer, &party_a, &party_b] {
        svm.airdrop(&wallet.pubkey(), 20_000_000_000).unwrap();
    }
    let base = setup_credit_base(&mut svm, &payer, party_a.pubkey(), party_b.pubkey());
    let party = if is_party_a {
        party_a.pubkey()
    } else {
        party_b.pubkey()
    };
    let identity_mint = Pubkey::new_unique();
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
            date_code: 20_260_715,
            daily_serial: 1,
            total_dc_minted: 0,
            max_partner: Pubkey::default(),
            lock_count: 1,
            bump: identity_bump,
        },
    );
    let owner_token = Pubkey::new_unique();
    set_token_account(&mut svm, owner_token, identity_mint, party, 1);
    let (binding, binding_bump) = Pubkey::find_program_address(
        &[BINDING_SEED, base.deal.as_ref(), party.as_ref()],
        &deal_identity::id(),
    );
    set_anchor_account(
        &mut svm,
        binding,
        deal_identity::id(),
        &DealIdentityBinding {
            deal: base.deal,
            party,
            identity_mint,
            lock_count: 0,
            bump: binding_bump,
        },
    );
    let (credit, _) = Pubkey::find_program_address(
        &[SCORE_SEED, identity_mint.as_ref()],
        &deal_credit_graph::id(),
    );
    let (a_identity_mint, b_identity_mint) = if is_party_a {
        (identity_mint, Pubkey::default())
    } else {
        (Pubkey::default(), identity_mint)
    };
    set_asset_guard_accounts(
        &mut svm,
        payer.pubkey(),
        base.deal,
        a_identity_mint,
        b_identity_mint,
        false,
    );
    let record = Instruction::new_with_bytes(
        deal_finalizer::id(),
        &deal_finalizer::instruction::RecordCompletedCreditSingle { is_party_a }.data(),
        deal_finalizer::accounts::RecordCompletedCreditSingle {
            config: base.config,
            payer: payer.pubkey(),
            writer: base.writer,
            deal: base.deal,
            terminal_receipt: base.terminal_receipt,
            valuation_receipt: base.valuation_receipt,
            credit_config: base.credit_config,
            party,
            binding,
            identity,
            owner_token,
            credit,
            credit_receipt: base.credit_receipt,
            credit_program: deal_credit_graph::id(),
            system_program: anchor_lang::system_program::ID,
            terms: base.terms,
            asset_config: base.asset_config,
            instructions_sysvar: deal_terminal_guard::instructions_sysvar_id(),
        }
        .to_account_metas(None),
    );
    assert!(!send(&mut svm, &payer, std::slice::from_ref(&record), &[]));
    set_anchor_account(
        &mut svm,
        binding,
        deal_identity::id(),
        &DealIdentityBinding {
            deal: base.deal,
            party,
            identity_mint,
            lock_count: 1,
            bump: binding_bump,
        },
    );
    set_asset_guard_accounts(
        &mut svm,
        payer.pubkey(),
        base.deal,
        a_identity_mint,
        b_identity_mint,
        true,
    );
    assert!(send(&mut svm, &payer, std::slice::from_ref(&record), &[]));
    assert!(!send(&mut svm, &payer, std::slice::from_ref(&record), &[]));
    assert_eq!(
        deserialize::<CreditScore>(&svm, &credit).score,
        base.base_credit_u
    );
    let receipt = deserialize::<CreditRecordingReceipt>(&svm, &base.credit_receipt);
    assert_eq!(receipt.deal, base.deal);
    assert_eq!(receipt.base_credit_u, base.base_credit_u);
    if is_party_a {
        assert_eq!(receipt.a_identity_mint, identity_mint);
        assert_eq!(receipt.b_identity_mint, Pubkey::default());
        assert_eq!(receipt.a_delta, base.base_credit_u);
        assert_eq!(receipt.b_delta, 0);
    } else {
        assert_eq!(receipt.a_identity_mint, Pubkey::default());
        assert_eq!(receipt.b_identity_mint, identity_mint);
        assert_eq!(receipt.a_delta, 0);
        assert_eq!(receipt.b_delta, base.base_credit_u);
    }
    assert!(!send(&mut svm, &payer, &[record], &[]));
}

#[test]
fn completed_deal_is_indexed_once_for_both_parties() {
    let mut svm = LiteSVM::new();
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: 1_700_000_000,
        epoch: 1,
        leader_schedule_epoch: 1,
        unix_timestamp: 1_700_000_200,
    });
    svm.add_program(
        deal_history_index::id(),
        include_bytes!("../../../target/deploy/deal_compact_data_services.so"),
    )
    .unwrap();
    svm.add_program(
        deal_finalizer::id(),
        include_bytes!("../../../target/deploy/deal_compact_settlement.so"),
    )
    .unwrap();

    let authority = Keypair::new();
    let creator = Keypair::new();
    let participant = Keypair::new();
    svm.airdrop(&authority.pubkey(), 20_000_000_000).unwrap();

    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_finalizer::id());
    let (writer, _) = Pubkey::find_program_address(&[WRITER_SEED], &deal_finalizer::id());
    let (history_config, _) =
        Pubkey::find_program_address(&[HISTORY_CONFIG_SEED], &deal_history_index::id());
    let deal = Pubkey::new_unique();
    let (receipt, _) =
        Pubkey::find_program_address(&[RECEIPT_SEED, deal.as_ref()], &deal_finalizer::id());
    let (history_receipt, _) = Pubkey::find_program_address(
        &[HISTORY_RECEIPT_SEED, deal.as_ref()],
        &deal_finalizer::id(),
    );
    let (creator_header, _) = Pubkey::find_program_address(
        &[USER_ACTIVITY_SEED, creator.pubkey().as_ref()],
        &deal_history_index::id(),
    );
    let (participant_header, _) = Pubkey::find_program_address(
        &[USER_ACTIVITY_SEED, participant.pubkey().as_ref()],
        &deal_history_index::id(),
    );
    set_deal(
        &mut svm,
        deal,
        completed_deal(creator.pubkey(), participant.pubkey()),
    );
    let (asset_config, terms) = set_asset_guard_accounts(
        &mut svm,
        authority.pubkey(),
        deal,
        Pubkey::default(),
        Pubkey::default(),
        false,
    );

    let initialize_history = Instruction::new_with_bytes(
        deal_history_index::id(),
        &deal_history_index::instruction::Initialize {
            trusted_writer: writer,
        }
        .data(),
        deal_history_index::accounts::Initialize {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            config: history_config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let initialize_finalizer = Instruction::new_with_bytes(
        deal_finalizer::id(),
        &deal_finalizer::instruction::Initialize {}.data(),
        deal_finalizer::accounts::Initialize {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            config,
            writer,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &authority,
        &[initialize_history, initialize_finalizer],
        &[],
    ));

    let unpause_history = Instruction::new_with_bytes(
        deal_history_index::id(),
        &deal_history_index::instruction::SetPaused { paused: false }.data(),
        deal_history_index::accounts::AdminConfig {
            authority: authority.pubkey(),
            config: history_config,
        }
        .to_account_metas(None),
    );
    let unpause_finalizer = Instruction::new_with_bytes(
        deal_finalizer::id(),
        &deal_finalizer::instruction::SetPaused { paused: false }.data(),
        deal_finalizer::accounts::AdminConfig {
            authority: authority.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &authority,
        &[unpause_history, unpause_finalizer],
        &[],
    ));

    let finalize = Instruction::new_with_bytes(
        deal_finalizer::id(),
        &deal_finalizer::instruction::FinalizeCompleted {}.data(),
        deal_finalizer::accounts::FinalizeCompleted {
            config,
            payer: authority.pubkey(),
            deal,
            creator: creator.pubkey(),
            participant: participant.pubkey(),
            receipt,
            system_program: anchor_lang::system_program::ID,
            asset_config,
            instructions_sysvar: deal_terminal_guard::instructions_sysvar_id(),
            terms,
        }
        .to_account_metas(None),
    );
    let mut unrouted_terms: AssetTerms = deserialize(&svm, &terms);
    unrouted_terms.dc_fees_routed = false;
    set_anchor_account(
        &mut svm,
        terms,
        deal_asset_controller::id(),
        &unrouted_terms,
    );
    assert!(!send(
        &mut svm,
        &authority,
        std::slice::from_ref(&finalize),
        &[],
    ));
    assert!(svm.get_account(&receipt).is_none());
    unrouted_terms.dc_fees_routed = true;
    set_anchor_account(
        &mut svm,
        terms,
        deal_asset_controller::id(),
        &unrouted_terms,
    );
    set_asset_guard_accounts(
        &mut svm,
        authority.pubkey(),
        deal,
        Pubkey::default(),
        Pubkey::default(),
        true,
    );
    assert!(!send(
        &mut svm,
        &authority,
        std::slice::from_ref(&finalize),
        &[],
    ));
    assert!(svm.get_account(&receipt).is_none());
    set_asset_guard_accounts(
        &mut svm,
        authority.pubkey(),
        deal,
        Pubkey::default(),
        Pubkey::default(),
        false,
    );
    assert!(send(
        &mut svm,
        &authority,
        std::slice::from_ref(&finalize),
        &[],
    ));

    let receipt_state = deserialize::<deal_finalizer::TerminalReceipt>(&svm, &receipt);
    assert_eq!(receipt_state.deal, deal);
    assert_eq!(receipt_state.status, DealStatus::Completed);
    assert_eq!(
        receipt_state.completion_reason,
        CompletionReason::BothAccepted
    );
    assert_eq!(receipt_state.ended_at, 1_700_000_100);
    assert_eq!(receipt_state.finalized_by, authority.pubkey());

    assert!(svm.get_account(&creator_header).is_none());
    assert!(svm.get_account(&participant_header).is_none());
    let index_history = Instruction::new_with_bytes(
        deal_finalizer::id(),
        &deal_finalizer::instruction::IndexCompletedHistory {}.data(),
        deal_finalizer::accounts::IndexCompletedHistory {
            config,
            payer: authority.pubkey(),
            writer,
            deal,
            terminal_receipt: receipt,
            creator: creator.pubkey(),
            participant: participant.pubkey(),
            history_receipt,
            history_config,
            creator_header,
            participant_header,
            history_program: deal_history_index::id(),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &authority,
        std::slice::from_ref(&index_history),
        &[],
    ));

    let creator_state = deserialize::<UserActivity>(&svm, &creator_header);
    let participant_state = deserialize::<UserActivity>(&svm, &participant_header);
    assert_eq!(creator_state.completed_size, 1);
    assert_eq!(participant_state.completed_size, 1);
    assert_eq!(creator_state.completed[0], deal);
    assert_eq!(participant_state.completed[0], deal);

    assert!(!send(&mut svm, &authority, &[finalize], &[]));
    assert!(!send(&mut svm, &authority, &[index_history], &[]));
    assert_eq!(
        deserialize::<UserActivity>(&svm, &creator_header).completed_size,
        1
    );
    assert_eq!(
        deserialize::<UserActivity>(&svm, &participant_header).completed_size,
        1
    );
}

#[test]
fn completed_credit_receipt_is_consumed_once_by_the_credit_graph() {
    let mut svm = LiteSVM::new();
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: 1_700_000_000,
        epoch: 1,
        leader_schedule_epoch: 1,
        unix_timestamp: 1_700_000_200,
    });
    svm.add_program(
        deal_credit_graph::id(),
        include_bytes!("../../../target/deploy/deal_compact_identity_credit.so"),
    )
    .unwrap();
    svm.add_program(
        deal_finalizer::id(),
        include_bytes!("../../../target/deploy/deal_compact_settlement.so"),
    )
    .unwrap();

    let payer = Keypair::new();
    let party_a = Keypair::new();
    let party_b = Keypair::new();
    for wallet in [&payer, &party_a, &party_b] {
        svm.airdrop(&wallet.pubkey(), 20_000_000_000).unwrap();
    }

    let deal = Pubkey::new_unique();
    let deal_state = completed_deal(party_a.pubkey(), party_b.pubkey());
    set_deal(&mut svm, deal, deal_state.clone());
    let (config, config_bump) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_finalizer::id());
    let (writer, _) = Pubkey::find_program_address(&[WRITER_SEED], &deal_finalizer::id());
    set_anchor_account(
        &mut svm,
        config,
        deal_finalizer::id(),
        &FinalizerConfig {
            authority: payer.pubkey(),
            pending_authority: Pubkey::default(),
            history_index: deal_history_index::id(),
            paused: false,
            bump: config_bump,
        },
    );

    let (terminal_receipt, terminal_bump) =
        Pubkey::find_program_address(&[RECEIPT_SEED, deal.as_ref()], &deal_finalizer::id());
    set_anchor_account(
        &mut svm,
        terminal_receipt,
        deal_finalizer::id(),
        &TerminalReceipt {
            deal,
            creator: party_a.pubkey(),
            participant: party_b.pubkey(),
            status: DealStatus::Completed,
            completion_reason: CompletionReason::BothAccepted,
            ended_at: deal_state.ended_at,
            finalized_at: 1_700_000_150,
            finalized_by: payer.pubkey(),
            bump: terminal_bump,
        },
    );

    let (valuation_receipt, valuation_bump) = Pubkey::find_program_address(
        &[deal_credit_valuator::VALUATION_SEED, deal.as_ref()],
        &deal_credit_valuator::id(),
    );
    let base_credit_u = 30_000_000_000_000u128;
    set_anchor_account(
        &mut svm,
        valuation_receipt,
        deal_credit_valuator::id(),
        &CreditValuationReceipt {
            deal,
            registry_revision: 1,
            a_fee_paid: 30,
            b_fee_paid: 0,
            a_credit_u: base_credit_u,
            b_credit_u: 0,
            base_credit_u,
            ended_at: deal_state.ended_at,
            valued_at: 1_700_000_160,
            bump: valuation_bump,
        },
    );

    let (credit_config, credit_config_bump) =
        Pubkey::find_program_address(&[CREDIT_CONFIG_SEED], &deal_credit_graph::id());
    set_anchor_account(
        &mut svm,
        credit_config,
        deal_credit_graph::id(),
        &CreditConfig {
            authority: payer.pubkey(),
            pending_authority: Pubkey::default(),
            recorder: writer,
            import_authority: payer.pubkey(),
            migration_locked: false,
            paused: false,
            bump: credit_config_bump,
        },
    );

    let a_mint = Pubkey::new_unique();
    let b_mint = Pubkey::new_unique();
    let (a_identity, a_identity_bump) =
        Pubkey::find_program_address(&[IDENTITY_SEED, a_mint.as_ref()], &deal_identity::id());
    let (b_identity, b_identity_bump) =
        Pubkey::find_program_address(&[IDENTITY_SEED, b_mint.as_ref()], &deal_identity::id());
    for (address, mint, bump) in [
        (a_identity, a_mint, a_identity_bump),
        (b_identity, b_mint, b_identity_bump),
    ] {
        set_anchor_account(
            &mut svm,
            address,
            deal_identity::id(),
            &IdentityRecord {
                id: 1,
                mint,
                season: 1,
                date_code: 20_260_715,
                daily_serial: 1,
                total_dc_minted: 0,
                max_partner: Pubkey::default(),
                lock_count: 1,
                bump,
            },
        );
    }
    let a_owner_token = Pubkey::new_unique();
    let b_owner_token = Pubkey::new_unique();
    set_token_account(&mut svm, a_owner_token, a_mint, party_a.pubkey(), 1);
    set_token_account(&mut svm, b_owner_token, b_mint, party_b.pubkey(), 1);
    let (asset_config, terms) =
        set_asset_guard_accounts(&mut svm, payer.pubkey(), deal, a_mint, b_mint, false);

    let (a_binding, a_binding_bump) = Pubkey::find_program_address(
        &[BINDING_SEED, deal.as_ref(), party_a.pubkey().as_ref()],
        &deal_identity::id(),
    );
    let (b_binding, b_binding_bump) = Pubkey::find_program_address(
        &[BINDING_SEED, deal.as_ref(), party_b.pubkey().as_ref()],
        &deal_identity::id(),
    );
    for (address, party, mint, bump) in [
        (a_binding, party_a.pubkey(), a_mint, a_binding_bump),
        (b_binding, party_b.pubkey(), b_mint, b_binding_bump),
    ] {
        set_anchor_account(
            &mut svm,
            address,
            deal_identity::id(),
            &DealIdentityBinding {
                deal,
                party,
                identity_mint: mint,
                lock_count: 1,
                bump,
            },
        );
    }

    let (a_credit, _) =
        Pubkey::find_program_address(&[SCORE_SEED, a_mint.as_ref()], &deal_credit_graph::id());
    let (b_credit, _) =
        Pubkey::find_program_address(&[SCORE_SEED, b_mint.as_ref()], &deal_credit_graph::id());
    let (credit_receipt, _) =
        Pubkey::find_program_address(&[CREDIT_RECEIPT_SEED, deal.as_ref()], &deal_finalizer::id());
    let record = Instruction::new_with_bytes(
        deal_finalizer::id(),
        &deal_finalizer::instruction::RecordCompletedCredit {}.data(),
        deal_finalizer::accounts::RecordCompletedCredit {
            config,
            payer: payer.pubkey(),
            writer,
            deal,
            terminal_receipt,
            valuation_receipt,
            credit_config,
            party_a: party_a.pubkey(),
            party_b: party_b.pubkey(),
            a_binding,
            b_binding,
            a_identity,
            b_identity,
            a_owner_token,
            b_owner_token,
            a_credit,
            b_credit,
            credit_receipt,
            credit_program: deal_credit_graph::id(),
            system_program: anchor_lang::system_program::ID,
            terms,
            asset_config,
            instructions_sysvar: deal_terminal_guard::instructions_sysvar_id(),
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, std::slice::from_ref(&record), &[],));

    assert_eq!(
        deserialize::<CreditScore>(&svm, &a_credit).score,
        base_credit_u
    );
    assert_eq!(
        deserialize::<CreditScore>(&svm, &b_credit).score,
        base_credit_u
    );
    let recorded = deserialize::<CreditRecordingReceipt>(&svm, &credit_receipt);
    assert_eq!(recorded.deal, deal);
    assert_eq!(recorded.valuation_receipt, valuation_receipt);
    assert_eq!(recorded.a_identity_mint, a_mint);
    assert_eq!(recorded.b_identity_mint, b_mint);
    assert_eq!(recorded.base_credit_u, base_credit_u);
    assert_eq!(recorded.a_delta, base_credit_u);
    assert_eq!(recorded.b_delta, base_credit_u);
    assert!(!send(&mut svm, &payer, &[record], &[]));
}

#[test]
fn completed_credit_supports_only_party_a_having_an_identity() {
    assert_single_credit_path(true);
}

#[test]
fn completed_credit_supports_only_party_b_having_an_identity() {
    assert_single_credit_path(false);
}

#[test]
fn completed_credit_supports_neither_party_having_an_identity() {
    let mut svm = LiteSVM::new();
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: 1_700_000_000,
        epoch: 1,
        leader_schedule_epoch: 1,
        unix_timestamp: 1_700_000_200,
    });
    svm.add_program(
        deal_finalizer::id(),
        include_bytes!("../../../target/deploy/deal_compact_settlement.so"),
    )
    .unwrap();

    let payer = Keypair::new();
    let party_a = Keypair::new();
    let party_b = Keypair::new();
    for wallet in [&payer, &party_a, &party_b] {
        svm.airdrop(&wallet.pubkey(), 20_000_000_000).unwrap();
    }
    let base = setup_credit_base(&mut svm, &payer, party_a.pubkey(), party_b.pubkey());
    let record = Instruction::new_with_bytes(
        deal_finalizer::id(),
        &deal_finalizer::instruction::RecordCompletedCreditNone {}.data(),
        deal_finalizer::accounts::RecordCompletedCreditNone {
            config: base.config,
            payer: payer.pubkey(),
            deal: base.deal,
            terminal_receipt: base.terminal_receipt,
            valuation_receipt: base.valuation_receipt,
            credit_receipt: base.credit_receipt,
            system_program: anchor_lang::system_program::ID,
            terms: base.terms,
            asset_config: base.asset_config,
            instructions_sysvar: deal_terminal_guard::instructions_sysvar_id(),
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, std::slice::from_ref(&record), &[]));
    let receipt = deserialize::<CreditRecordingReceipt>(&svm, &base.credit_receipt);
    assert_eq!(receipt.deal, base.deal);
    assert_eq!(receipt.base_credit_u, base.base_credit_u);
    assert_eq!(receipt.a_identity_mint, Pubkey::default());
    assert_eq!(receipt.b_identity_mint, Pubkey::default());
    assert_eq!(receipt.a_delta, 0);
    assert_eq!(receipt.b_delta, 0);
    assert!(!send(&mut svm, &payer, &[record], &[]));
}
