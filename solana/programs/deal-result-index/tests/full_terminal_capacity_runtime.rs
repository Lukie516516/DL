use anchor_lang::{
    prelude::{AccountDeserialize, AccountSerialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_asset_controller::{
    state::{AssetKind, AssetSpec, AssetTerms, ControllerConfig},
    CONTROLLER_SEED, TERMS_SEED,
};
use deal_core::{
    constants::{DEAL_SEED, REGISTRY_SEED as CORE_REGISTRY_SEED},
    state::{
        CompletionReason, DealAccount, DealRegistry, DealStatus, JoinMode, TemplateType, Vote,
    },
};
use deal_credit_graph::{
    CreditConfig, CreditPeer, CreditScore, CONFIG_SEED as CREDIT_CONFIG_SEED, SCORE_SEED, TOP_K,
};
use deal_dc_controller::{
    DcControllerConfig, MinterGrant, CONFIG_SEED as DC_CONFIG_SEED, MINTER_SEED as DC_MINTER_SEED,
};
use deal_dex_pair::{PairState, PAIR_SEED};
use deal_finalizer::{
    CreditRecordingReceipt, FinalizerConfig, HistoryIndexReceipt,
    CONFIG_SEED as FINALIZER_CONFIG_SEED, CREDIT_RECEIPT_SEED, HISTORY_RECEIPT_SEED,
    RECEIPT_SEED as TERMINAL_RECEIPT_SEED, WRITER_SEED,
};
use deal_history_index::{
    HistoryConfig, UserActivity, CONFIG_SEED as HISTORY_CONFIG_SEED, USER_ACTIVITY_SEED,
};
use deal_identity::{
    DealIdentityBinding, IdentityConfig, IdentityLock, IdentityRecord, BINDING_SEED,
    CONFIG_SEED as IDENTITY_CONFIG_SEED, IDENTITY_SEED, LOCK_SEED,
};
use deal_result_index::{
    ResultHeader, ResultIndexConfig, CONFIG_SEED as RESULT_CONFIG_SEED, CREDIT_HEADER_SEED,
    CREDIT_MARKER_SEED, CREDIT_PAGE_SEED,
};
use deal_reward_engine::{
    RewardConfig, CONFIG_SEED as REWARD_CONFIG_SEED, MINTER_SEED as REWARD_MINTER_SEED,
    OBSERVATION_SEED, QUOTE_SEED, RECEIPT_SEED as REWARD_RECEIPT_SEED,
};
use deal_swap_asset_registry::{SwapAssetRegistry, REGISTRY_SEED as SWAP_REGISTRY_SEED};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address_lookup_table_interface::instruction::{
    create_lookup_table, extend_lookup_table,
};
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_keypair::Keypair;
use solana_message::{
    v0::Message as MessageV0, AddressLookupTableAccount, Message, VersionedMessage,
};
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use spl_token_interface::state::{Account as TokenAccount, AccountState, Mint};
use std::collections::BTreeSet;

const NOW: i64 = 1_700_001_000;
const A_AMOUNT: u64 = 10_000;
const B_AMOUNT: u64 = 20_000;
const PACKET_DATA_SIZE: usize = 1_232;
const MAX_COMPUTE_UNITS: u32 = 1_400_000;

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

fn anchor_account<T: AccountDeserialize>(svm: &LiteSVM, address: Pubkey) -> T {
    let account = svm.get_account(&address).expect("account must exist");
    T::try_deserialize(&mut account.data.as_slice()).expect("account must deserialize")
}

fn set_mint(
    svm: &mut LiteSVM,
    address: Pubkey,
    mint_authority: Pubkey,
    freeze_authority: Option<Pubkey>,
    supply: u64,
    decimals: u8,
) {
    let state = Mint {
        mint_authority: COption::Some(mint_authority),
        supply,
        decimals,
        is_initialized: true,
        freeze_authority: freeze_authority.map(COption::Some).unwrap_or(COption::None),
    };
    let mut data = vec![0u8; Mint::LEN];
    Mint::pack(state, &mut data).unwrap();
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

fn set_token_account(
    svm: &mut LiteSVM,
    address: Pubkey,
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
    state: AccountState,
) {
    let token = TokenAccount {
        mint,
        owner,
        amount,
        delegate: COption::None,
        state,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let mut data = vec![0u8; TokenAccount::LEN];
    TokenAccount::pack(token, &mut data).unwrap();
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

fn token_balance(svm: &LiteSVM, address: Pubkey) -> u64 {
    TokenAccount::unpack(&svm.get_account(&address).unwrap().data)
        .unwrap()
        .amount
}

fn pair(dc_mint: Pubkey, other_mint: Pubkey, bump: u8) -> PairState {
    PairState {
        dc_mint,
        other_mint,
        dc_token_program: spl_token_interface::ID,
        other_token_program: spl_token_interface::ID,
        vault0: Pubkey::new_unique(),
        vault1: Pubkey::new_unique(),
        reserve0: 1_000_000,
        reserve1: 1_000_000,
        virtual_reserve0: 1_000_000,
        virtual_reserve1: 1_000_000,
        price0_cumulative: 0,
        price1_cumulative: 0,
        last_timestamp: NOW - 100,
        fee_numerator: 3,
        fee_denominator: 1_000,
        virtual0_enabled: true,
        virtual1_enabled: true,
        liquidity_initialized: true,
        bump,
    }
}

#[allow(clippy::too_many_arguments)]
fn identity_side(
    svm: &mut LiteSVM,
    identity_config: Pubkey,
    deal: Pubkey,
    owner: Pubkey,
    identity_mint: Pubkey,
    score: u128,
    top_peer: Option<(Pubkey, u128)>,
    locked: bool,
) -> (Pubkey, Pubkey, Pubkey, Pubkey, Pubkey) {
    set_mint(
        svm,
        identity_mint,
        identity_config,
        Some(identity_config),
        1,
        0,
    );
    let (identity, identity_bump) = Pubkey::find_program_address(
        &[IDENTITY_SEED, identity_mint.as_ref()],
        &deal_identity::id(),
    );
    set_anchor_account(
        svm,
        identity,
        deal_identity::id(),
        &IdentityRecord {
            id: 1,
            mint: identity_mint,
            season: 1,
            date_code: 20260726,
            daily_serial: 1,
            total_dc_minted: 0,
            max_partner: Pubkey::default(),
            lock_count: u32::from(locked),
            bump: identity_bump,
        },
    );
    let owner_token = Pubkey::new_unique();
    set_token_account(
        svm,
        owner_token,
        identity_mint,
        owner,
        1,
        if locked {
            AccountState::Frozen
        } else {
            AccountState::Initialized
        },
    );
    let (binding, binding_bump) = Pubkey::find_program_address(
        &[BINDING_SEED, deal.as_ref(), owner.as_ref()],
        &deal_identity::id(),
    );
    set_anchor_account(
        svm,
        binding,
        deal_identity::id(),
        &DealIdentityBinding {
            deal,
            party: owner,
            identity_mint,
            lock_count: u32::from(locked),
            bump: binding_bump,
        },
    );
    let (lock, lock_bump) = Pubkey::find_program_address(
        &[LOCK_SEED, identity_mint.as_ref(), deal.as_ref()],
        &deal_identity::id(),
    );
    set_anchor_account(
        svm,
        lock,
        deal_identity::id(),
        &IdentityLock {
            identity_mint,
            deal,
            count: u32::from(locked),
            bump: lock_bump,
        },
    );
    let (credit, credit_bump) = Pubkey::find_program_address(
        &[SCORE_SEED, identity_mint.as_ref()],
        &deal_credit_graph::id(),
    );
    let mut top_peers = [CreditPeer::default(); TOP_K];
    if let Some((peer_mint, peer_score)) = top_peer {
        top_peers[0] = CreditPeer {
            identity_mint: peer_mint,
            credit_snapshot: peer_score,
            updated_at: NOW - 10,
        };
    }
    set_anchor_account(
        svm,
        credit,
        deal_credit_graph::id(),
        &CreditScore {
            identity_mint,
            score,
            top_peers,
            bump: credit_bump,
        },
    );
    (identity, owner_token, binding, lock, credit)
}

fn send_legacy(svm: &mut LiteSVM, payer: &Keypair, instructions: &[Instruction]) {
    let blockhash = svm.latest_blockhash();
    let message = Message::new_with_blockhash(instructions, Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &[payer]).unwrap();
    svm.send_transaction(tx).unwrap();
    svm.expire_blockhash();
}

fn install_lookup_table(
    svm: &mut LiteSVM,
    payer: &Keypair,
    addresses: &[Pubkey],
) -> AddressLookupTableAccount {
    let (create, lookup_table) = create_lookup_table(payer.pubkey(), payer.pubkey(), 0);
    send_legacy(svm, payer, &[create]);
    for chunk in addresses.chunks(20) {
        let extend = extend_lookup_table(
            lookup_table,
            payer.pubkey(),
            Some(payer.pubkey()),
            chunk.to_vec(),
        );
        send_legacy(svm, payer, &[extend]);
    }
    svm.warp_to_slot(1);
    AddressLookupTableAccount {
        key: lookup_table,
        addresses: addresses.to_vec(),
    }
}

#[test]
fn maximum_dc_to_dc_terminal_flow_executes_as_bounded_v0_core_and_post_index() {
    let mut svm = LiteSVM::new();
    for (program, bytes) in [
        (
            deal_core::id(),
            include_bytes!("../../../target/deploy/deal_core.so").as_slice(),
        ),
        (
            deal_asset_controller::id(),
            include_bytes!("../../../target/deploy/deal_asset_controller.so").as_slice(),
        ),
        (
            deal_finalizer::id(),
            include_bytes!("../../../target/deploy/deal_finalizer.so").as_slice(),
        ),
        (
            deal_history_index::id(),
            include_bytes!("../../../target/deploy/deal_history_index.so").as_slice(),
        ),
        (
            deal_credit_valuator::id(),
            include_bytes!("../../../target/deploy/deal_credit_valuator.so").as_slice(),
        ),
        (
            deal_reward_engine::id(),
            include_bytes!("../../../target/deploy/deal_reward_engine.so").as_slice(),
        ),
        (
            deal_dc_controller::id(),
            include_bytes!("../../../target/deploy/deal_dc_controller.so").as_slice(),
        ),
        (
            deal_credit_graph::id(),
            include_bytes!("../../../target/deploy/deal_credit_graph.so").as_slice(),
        ),
        (
            deal_identity::id(),
            include_bytes!("../../../target/deploy/deal_identity.so").as_slice(),
        ),
        (
            deal_result_index::id(),
            include_bytes!("../../../target/deploy/deal_result_index.so").as_slice(),
        ),
    ] {
        svm.add_program(program, bytes).unwrap();
    }

    let payer = Keypair::new();
    let creator = Pubkey::new_unique();
    let participant = payer.pubkey();
    let c_owner = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

    let (asset_config, asset_config_bump) =
        Pubkey::find_program_address(&[CONTROLLER_SEED], &deal_asset_controller::id());
    let (core_registry, core_registry_bump) =
        Pubkey::find_program_address(&[CORE_REGISTRY_SEED], &deal_core::id());
    let deal_id = 1u64;
    let (deal, deal_bump) = Pubkey::find_program_address(
        &[DEAL_SEED, deal_id.to_le_bytes().as_ref()],
        &deal_core::id(),
    );
    let (terms, terms_bump) =
        Pubkey::find_program_address(&[TERMS_SEED, deal.as_ref()], &deal_asset_controller::id());
    let (identity_config, identity_config_bump) =
        Pubkey::find_program_address(&[IDENTITY_CONFIG_SEED], &deal_identity::id());
    let (reward_minter, _) =
        Pubkey::find_program_address(&[REWARD_MINTER_SEED], &deal_reward_engine::id());
    let (dc_config, dc_config_bump) =
        Pubkey::find_program_address(&[DC_CONFIG_SEED], &deal_dc_controller::id());

    let dc_mint = Pubkey::new_unique();
    set_mint(&mut svm, dc_mint, dc_config, None, A_AMOUNT + B_AMOUNT, 6);
    set_anchor_account(
        &mut svm,
        asset_config,
        deal_asset_controller::id(),
        &ControllerConfig {
            authority: payer.pubkey(),
            pending_authority: Pubkey::default(),
            treasury,
            dc_mint,
            fee_numerator: 3,
            fee_denominator: 1_000,
            terminal_guard_enabled: true,
            paused: false,
            bump: asset_config_bump,
        },
    );
    set_anchor_account(
        &mut svm,
        core_registry,
        deal_core::id(),
        &DealRegistry {
            authority: payer.pubkey(),
            pending_authority: Pubkey::default(),
            asset_controller: asset_config,
            identity_controller: asset_config,
            domain_entry_controller: Pubkey::new_unique(),
            next_deal_id: 2,
            min_timeout_seconds: 1,
            paused: false,
            bump: core_registry_bump,
        },
    );
    set_anchor_account(
        &mut svm,
        deal,
        deal_core::id(),
        &DealAccount {
            id: deal_id,
            creator,
            participant,
            expected_participant: Pubkey::default(),
            last_removed_participant: Pubkey::default(),
            template_type: TemplateType::TokenToToken,
            open_token_token_fast: false,
            join_mode: JoinMode::Open,
            status: DealStatus::Locked,
            a_vote: Vote::Accept,
            b_vote: Vote::Unset,
            completion_reason: CompletionReason::None,
            a_funds_deposited: true,
            b_funds_deposited: true,
            a_asset_deposited: false,
            b_asset_deposited: false,
            a_asset_required: false,
            b_asset_required: false,
            a_has_pre_accepted: false,
            is_domain_deal: false,
            a_swap_amount: A_AMOUNT,
            a_margin_amount: 0,
            b_swap_amount: B_AMOUNT,
            b_margin_amount: 0,
            timeout_seconds: 3_600,
            replace_timeout_seconds: 0,
            created_at: NOW - 300,
            ended_at: 0,
            b_joined_at: NOW - 250,
            locked_at: NOW - 200,
            a_vote_at: NOW - 100,
            b_vote_at: 0,
            a_pre_accept_at: 0,
            title: "maximum DC/DC Devnet rehearsal".into(),
            description: "full pair identities, fee C, credit indexes and unlocks".into(),
            domain_name: String::new(),
            bump: deal_bump,
        },
    );

    let a_vault = Pubkey::new_unique();
    let b_vault = Pubkey::new_unique();
    let a_destination = Pubkey::new_unique();
    let b_destination = Pubkey::new_unique();
    let a_reward_destination = Pubkey::new_unique();
    let b_reward_destination = Pubkey::new_unique();
    let a_fee = Pubkey::new_unique();
    let b_fee = Pubkey::new_unique();
    set_token_account(
        &mut svm,
        a_vault,
        dc_mint,
        asset_config,
        A_AMOUNT,
        AccountState::Initialized,
    );
    set_token_account(
        &mut svm,
        b_vault,
        dc_mint,
        asset_config,
        B_AMOUNT,
        AccountState::Initialized,
    );
    set_token_account(
        &mut svm,
        a_destination,
        dc_mint,
        participant,
        0,
        AccountState::Initialized,
    );
    set_token_account(
        &mut svm,
        b_destination,
        dc_mint,
        creator,
        0,
        AccountState::Initialized,
    );
    set_token_account(
        &mut svm,
        a_reward_destination,
        dc_mint,
        creator,
        0,
        AccountState::Initialized,
    );
    set_token_account(
        &mut svm,
        b_reward_destination,
        dc_mint,
        participant,
        0,
        AccountState::Initialized,
    );
    set_token_account(
        &mut svm,
        a_fee,
        dc_mint,
        treasury,
        0,
        AccountState::Initialized,
    );
    set_token_account(
        &mut svm,
        b_fee,
        dc_mint,
        treasury,
        0,
        AccountState::Initialized,
    );

    let a_identity_mint = Pubkey::new_unique();
    let b_identity_mint = Pubkey::new_unique();
    let c_identity_mint = Pubkey::new_unique();
    set_anchor_account(
        &mut svm,
        identity_config,
        deal_identity::id(),
        &IdentityConfig {
            authority: payer.pubkey(),
            pending_authority: Pubkey::default(),
            dc_mint,
            trusted_controller: asset_config,
            reward_controller: reward_minter,
            next_id: 4,
            current_season: 1,
            mint_price: 1,
            min_mint_price: 1,
            max_mint_price: 1_000_000,
            paused: false,
            bump: identity_config_bump,
        },
    );
    let (a_identity, a_identity_token, a_binding, a_lock, a_credit) = identity_side(
        &mut svm,
        identity_config,
        deal,
        creator,
        a_identity_mint,
        100,
        Some((c_identity_mint, 200)),
        true,
    );
    let (b_identity, b_identity_token, b_binding, b_lock, b_credit) = identity_side(
        &mut svm,
        identity_config,
        deal,
        participant,
        b_identity_mint,
        150,
        None,
        true,
    );
    let (c_identity, c_identity_token, _, _, _) = identity_side(
        &mut svm,
        identity_config,
        Pubkey::new_unique(),
        c_owner,
        c_identity_mint,
        0,
        None,
        false,
    );
    let c_dc_destination = Pubkey::new_unique();
    set_token_account(
        &mut svm,
        c_dc_destination,
        dc_mint,
        c_owner,
        0,
        AccountState::Initialized,
    );

    let none = AssetSpec::none();
    set_anchor_account(
        &mut svm,
        terms,
        deal_asset_controller::id(),
        &AssetTerms {
            deal,
            creator,
            a_swap: AssetSpec {
                kind: AssetKind::Spl,
                mint: dc_mint,
                vault: a_vault,
            },
            a_margin: none,
            b_swap: AssetSpec {
                kind: AssetKind::Spl,
                mint: dc_mint,
                vault: b_vault,
            },
            b_margin: none,
            a_asset_nft: none,
            b_asset_nft: none,
            b_depositor: participant,
            a_identity_mint,
            b_identity_mint,
            a_funds_escrowed: true,
            b_funds_escrowed: true,
            a_nft_escrowed: false,
            b_nft_escrowed: false,
            resolved: false,
            dc_fees_routed: false,
            a_fee_paid: 0,
            b_fee_paid: 0,
            bump: terms_bump,
        },
    );

    let (finalizer_config, finalizer_config_bump) =
        Pubkey::find_program_address(&[FINALIZER_CONFIG_SEED], &deal_finalizer::id());
    let (finalizer_writer, _) = Pubkey::find_program_address(&[WRITER_SEED], &deal_finalizer::id());
    set_anchor_account(
        &mut svm,
        finalizer_config,
        deal_finalizer::id(),
        &FinalizerConfig {
            authority: payer.pubkey(),
            pending_authority: Pubkey::default(),
            history_index: deal_history_index::id(),
            paused: false,
            bump: finalizer_config_bump,
        },
    );
    let (history_config, history_config_bump) =
        Pubkey::find_program_address(&[HISTORY_CONFIG_SEED], &deal_history_index::id());
    set_anchor_account(
        &mut svm,
        history_config,
        deal_history_index::id(),
        &HistoryConfig {
            authority: payer.pubkey(),
            pending_authority: Pubkey::default(),
            trusted_writer: finalizer_writer,
            core_program: deal_core::id(),
            paused: false,
            bump: history_config_bump,
        },
    );
    let (creator_header, _) = Pubkey::find_program_address(
        &[USER_ACTIVITY_SEED, creator.as_ref()],
        &deal_history_index::id(),
    );
    let (participant_header, _) = Pubkey::find_program_address(
        &[USER_ACTIVITY_SEED, participant.as_ref()],
        &deal_history_index::id(),
    );
    let (terminal_receipt, _) = Pubkey::find_program_address(
        &[TERMINAL_RECEIPT_SEED, deal.as_ref()],
        &deal_finalizer::id(),
    );
    let (history_receipt, _) = Pubkey::find_program_address(
        &[HISTORY_RECEIPT_SEED, deal.as_ref()],
        &deal_finalizer::id(),
    );

    let stable0_mint = Pubkey::new_unique();
    let stable1_mint = Pubkey::new_unique();
    let wrapped_native_mint = Pubkey::new_unique();
    set_mint(&mut svm, stable0_mint, payer.pubkey(), None, 0, 6);
    set_mint(&mut svm, stable1_mint, payer.pubkey(), None, 0, 6);
    let (wrapped_native_pair, wrapped_native_pair_bump) = Pubkey::find_program_address(
        &[PAIR_SEED, wrapped_native_mint.as_ref()],
        &deal_dex_pair::id(),
    );
    let (stable0_pair, stable0_pair_bump) =
        Pubkey::find_program_address(&[PAIR_SEED, stable0_mint.as_ref()], &deal_dex_pair::id());
    let (stable1_pair, stable1_pair_bump) =
        Pubkey::find_program_address(&[PAIR_SEED, stable1_mint.as_ref()], &deal_dex_pair::id());
    set_anchor_account(
        &mut svm,
        wrapped_native_pair,
        deal_dex_pair::id(),
        &pair(dc_mint, wrapped_native_mint, wrapped_native_pair_bump),
    );
    set_anchor_account(
        &mut svm,
        stable0_pair,
        deal_dex_pair::id(),
        &pair(dc_mint, stable0_mint, stable0_pair_bump),
    );
    set_anchor_account(
        &mut svm,
        stable1_pair,
        deal_dex_pair::id(),
        &pair(dc_mint, stable1_mint, stable1_pair_bump),
    );
    let (swap_registry, swap_registry_bump) =
        Pubkey::find_program_address(&[SWAP_REGISTRY_SEED], &deal_swap_asset_registry::id());
    set_anchor_account(
        &mut svm,
        swap_registry,
        deal_swap_asset_registry::id(),
        &SwapAssetRegistry {
            authority: payer.pubkey(),
            pending_authority: Pubkey::default(),
            pair_program: deal_dex_pair::id(),
            router_program: Pubkey::new_unique(),
            dc_mint,
            wrapped_native_mint,
            stable0_mint,
            stable1_mint,
            wrapped_native_pair,
            stable0_pair,
            stable1_pair,
            revision: 1,
            bump: swap_registry_bump,
        },
    );
    let (valuation_receipt, _) = Pubkey::find_program_address(
        &[deal_credit_valuator::VALUATION_SEED, deal.as_ref()],
        &deal_credit_valuator::id(),
    );

    let (reward_config, reward_config_bump) =
        Pubkey::find_program_address(&[REWARD_CONFIG_SEED], &deal_reward_engine::id());
    set_anchor_account(
        &mut svm,
        reward_config,
        deal_reward_engine::id(),
        &RewardConfig {
            authority: payer.pubkey(),
            pending_authority: Pubkey::default(),
            dc_mint,
            dc_controller: dc_config,
            reward_numerator: 1,
            reward_denominator: 1_000,
            min_window_seconds: 1_800,
            paused: false,
            bump: reward_config_bump,
        },
    );
    let (wrapped_native_observation, _) = Pubkey::find_program_address(
        &[OBSERVATION_SEED, wrapped_native_pair.as_ref()],
        &deal_reward_engine::id(),
    );
    let (stable0_observation, _) = Pubkey::find_program_address(
        &[OBSERVATION_SEED, stable0_pair.as_ref()],
        &deal_reward_engine::id(),
    );
    let (stable1_observation, _) = Pubkey::find_program_address(
        &[OBSERVATION_SEED, stable1_pair.as_ref()],
        &deal_reward_engine::id(),
    );
    let (reward_quote, _) =
        Pubkey::find_program_address(&[QUOTE_SEED, deal.as_ref()], &deal_reward_engine::id());
    let (reward_receipt, _) = Pubkey::find_program_address(
        &[REWARD_RECEIPT_SEED, deal.as_ref()],
        &deal_reward_engine::id(),
    );
    set_anchor_account(
        &mut svm,
        dc_config,
        deal_dc_controller::id(),
        &DcControllerConfig {
            authority: payer.pubkey(),
            pending_authority: Pubkey::default(),
            dc_mint,
            dc_token_program: spl_token_interface::ID,
            total_minted: 0,
            paused: false,
            bump: dc_config_bump,
        },
    );
    let (dc_minter_grant, dc_minter_grant_bump) = Pubkey::find_program_address(
        &[DC_MINTER_SEED, reward_minter.as_ref()],
        &deal_dc_controller::id(),
    );
    set_anchor_account(
        &mut svm,
        dc_minter_grant,
        deal_dc_controller::id(),
        &MinterGrant {
            minter: reward_minter,
            enabled: true,
            bump: dc_minter_grant_bump,
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
            recorder: finalizer_writer,
            import_authority: payer.pubkey(),
            migration_locked: true,
            paused: false,
            bump: credit_config_bump,
        },
    );
    let (credit_receipt, _) =
        Pubkey::find_program_address(&[CREDIT_RECEIPT_SEED, deal.as_ref()], &deal_finalizer::id());
    let (result_config, result_config_bump) =
        Pubkey::find_program_address(&[RESULT_CONFIG_SEED], &deal_result_index::id());
    set_anchor_account(
        &mut svm,
        result_config,
        deal_result_index::id(),
        &ResultIndexConfig {
            authority: payer.pubkey(),
            pending_authority: Pubkey::default(),
            reward_program: deal_reward_engine::id(),
            finalizer_program: deal_finalizer::id(),
            paused: false,
            bump: result_config_bump,
        },
    );
    let page_no = 0u32;
    let (a_credit_header, _) = Pubkey::find_program_address(
        &[CREDIT_HEADER_SEED, a_identity_mint.as_ref()],
        &deal_result_index::id(),
    );
    let (a_credit_page, _) = Pubkey::find_program_address(
        &[
            CREDIT_PAGE_SEED,
            a_identity_mint.as_ref(),
            &page_no.to_le_bytes(),
        ],
        &deal_result_index::id(),
    );
    let (a_credit_marker, _) = Pubkey::find_program_address(
        &[CREDIT_MARKER_SEED, a_identity_mint.as_ref(), deal.as_ref()],
        &deal_result_index::id(),
    );
    let (b_credit_header, _) = Pubkey::find_program_address(
        &[CREDIT_HEADER_SEED, b_identity_mint.as_ref()],
        &deal_result_index::id(),
    );
    let (b_credit_page, _) = Pubkey::find_program_address(
        &[
            CREDIT_PAGE_SEED,
            b_identity_mint.as_ref(),
            &page_no.to_le_bytes(),
        ],
        &deal_result_index::id(),
    );
    let (b_credit_marker, _) = Pubkey::find_program_address(
        &[CREDIT_MARKER_SEED, b_identity_mint.as_ref(), deal.as_ref()],
        &deal_result_index::id(),
    );

    let resolve = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::CastVoteAndResolve { vote: Vote::Accept }.data(),
        deal_asset_controller::accounts::ResolveAssets {
            caller: payer.pubkey(),
            config: asset_config,
            terms,
            core_registry,
            deal,
            creator,
            participant,
            a_swap_vault: a_vault,
            a_swap_mint: dc_mint,
            a_swap_user: a_destination,
            a_swap_fee: a_fee,
            a_margin_vault: creator,
            a_margin_mint: creator,
            a_margin_user: creator,
            b_swap_vault: b_vault,
            b_swap_mint: dc_mint,
            b_swap_user: b_destination,
            b_swap_fee: b_fee,
            b_margin_vault: participant,
            b_margin_mint: participant,
            b_margin_user: participant,
            a_nft_vault: creator,
            a_nft_mint: creator,
            a_nft_user: creator,
            b_nft_vault: participant,
            b_nft_mint: participant,
            b_nft_user: participant,
            token_program: spl_token_interface::ID,
            core_program: deal_core::id(),
            instructions_sysvar: deal_terminal_guard::instructions_sysvar_id(),
        }
        .to_account_metas(None),
    );
    let route = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::RouteDcFees {}.data(),
        deal_asset_controller::accounts::RouteDcFees {
            payer: payer.pubkey(),
            config: asset_config,
            terms,
            deal,
            a_swap_vault: a_vault,
            b_swap_vault: b_vault,
            dc_mint,
            a_identity: Some(a_identity),
            a_identity_token: Some(a_identity_token),
            a_binding: Some(a_binding),
            a_credit: Some(a_credit),
            b_identity: Some(b_identity),
            b_identity_token: Some(b_identity_token),
            b_binding: Some(b_binding),
            b_credit: Some(b_credit),
            c_identity: Some(c_identity),
            c_identity_token: Some(c_identity_token),
            c_dc_destination: Some(c_dc_destination),
            token_program: spl_token_interface::ID,
            instructions_sysvar: deal_terminal_guard::instructions_sysvar_id(),
        }
        .to_account_metas(None),
    );
    let finalize = Instruction::new_with_bytes(
        deal_finalizer::id(),
        &deal_finalizer::instruction::FinalizeCompleted {}.data(),
        deal_finalizer::accounts::FinalizeCompleted {
            config: finalizer_config,
            payer: payer.pubkey(),
            deal,
            creator,
            participant,
            receipt: terminal_receipt,
            system_program: anchor_lang::system_program::ID,
            asset_config,
            instructions_sysvar: deal_terminal_guard::instructions_sysvar_id(),
            terms,
        }
        .to_account_metas(None),
    );
    let value = Instruction::new_with_bytes(
        deal_credit_valuator::id(),
        &deal_credit_valuator::instruction::ValueCompletedDeal {}.data(),
        deal_credit_valuator::accounts::ValueCompletedDeal {
            payer: payer.pubkey(),
            deal,
            terms,
            registry: swap_registry,
            stable0_mint,
            stable1_mint,
            wrapped_native_pair,
            stable0_pair,
            stable1_pair,
            receipt: valuation_receipt,
            system_program: anchor_lang::system_program::ID,
            asset_config,
            instructions_sysvar: deal_terminal_guard::instructions_sysvar_id(),
        }
        .to_account_metas(None),
    );
    let prepare_rewards = Instruction::new_with_bytes(
        deal_reward_engine::id(),
        &deal_reward_engine::instruction::PrepareCompletedRewards {}.data(),
        deal_reward_engine::accounts::PrepareCompletedRewards {
            config: reward_config,
            payer: payer.pubkey(),
            deal,
            terms,
            asset_config,
            registry: swap_registry,
            wrapped_native_pair,
            stable0_pair,
            stable1_pair,
            wrapped_native_observation,
            stable0_observation,
            stable1_observation,
            quote: reward_quote,
            system_program: anchor_lang::system_program::ID,
            instructions_sysvar: deal_terminal_guard::instructions_sysvar_id(),
        }
        .to_account_metas(None),
    );
    let mint_rewards = Instruction::new_with_bytes(
        deal_reward_engine::id(),
        &deal_reward_engine::instruction::MintCompletedRewards {}.data(),
        deal_reward_engine::accounts::MintCompletedRewards {
            config: reward_config,
            payer: payer.pubkey(),
            reward_minter,
            deal,
            quote: reward_quote,
            a_identity: Some(a_identity),
            a_identity_token: Some(a_identity_token),
            a_binding: Some(a_binding),
            a_credit: Some(a_credit),
            b_identity: Some(b_identity),
            b_identity_token: Some(b_identity_token),
            b_binding: Some(b_binding),
            b_credit: Some(b_credit),
            c_identity: None,
            c_identity_token: None,
            a_dc_destination: a_reward_destination,
            b_dc_destination: b_reward_destination,
            c_dc_destination: None,
            dc_mint,
            dc_controller_config: dc_config,
            dc_minter_grant,
            dc_token_program: spl_token_interface::ID,
            dc_controller_program: deal_dc_controller::id(),
            receipt: reward_receipt,
            system_program: anchor_lang::system_program::ID,
            terms,
            asset_config,
            instructions_sysvar: deal_terminal_guard::instructions_sysvar_id(),
        }
        .to_account_metas(None),
    );
    let record_credit = Instruction::new_with_bytes(
        deal_finalizer::id(),
        &deal_finalizer::instruction::RecordCompletedCredit {}.data(),
        deal_finalizer::accounts::RecordCompletedCredit {
            config: finalizer_config,
            payer: payer.pubkey(),
            writer: finalizer_writer,
            deal,
            terminal_receipt,
            valuation_receipt,
            credit_config,
            party_a: creator,
            party_b: participant,
            a_binding,
            b_binding,
            a_identity,
            b_identity,
            a_owner_token: a_identity_token,
            b_owner_token: b_identity_token,
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
    let index_history = Instruction::new_with_bytes(
        deal_finalizer::id(),
        &deal_finalizer::instruction::IndexCompletedHistory {}.data(),
        deal_finalizer::accounts::IndexCompletedHistory {
            config: finalizer_config,
            payer: payer.pubkey(),
            writer: finalizer_writer,
            deal,
            terminal_receipt,
            creator,
            participant,
            history_receipt,
            history_config,
            creator_header,
            participant_header,
            history_program: deal_history_index::id(),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let index_a_credit = Instruction::new_with_bytes(
        deal_result_index::id(),
        &deal_result_index::instruction::IndexCredit { side: 0, page_no }.data(),
        deal_result_index::accounts::IndexCredit {
            config: result_config,
            payer: payer.pubkey(),
            deal,
            credit_receipt,
            subject: a_identity_mint,
            header: a_credit_header,
            page: a_credit_page,
            marker: a_credit_marker,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let index_b_credit = Instruction::new_with_bytes(
        deal_result_index::id(),
        &deal_result_index::instruction::IndexCredit { side: 1, page_no }.data(),
        deal_result_index::accounts::IndexCredit {
            config: result_config,
            payer: payer.pubkey(),
            deal,
            credit_receipt,
            subject: b_identity_mint,
            header: b_credit_header,
            page: b_credit_page,
            marker: b_credit_marker,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let unlock_a = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::UnlockIdentity {}.data(),
        deal_asset_controller::accounts::ManageIdentity {
            actor: payer.pubkey(),
            config: asset_config,
            identity_config,
            deal,
            identity_mint: a_identity_mint,
            owner_identity: a_identity_token,
            identity: a_identity,
            binding: a_binding,
            lock: a_lock,
            identity_program: deal_identity::id(),
            token_program: spl_token_interface::ID,
            system_program: anchor_lang::system_program::ID,
            terms,
        }
        .to_account_metas(None),
    );
    let unlock_b = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::UnlockIdentity {}.data(),
        deal_asset_controller::accounts::ManageIdentity {
            actor: payer.pubkey(),
            config: asset_config,
            identity_config,
            deal,
            identity_mint: b_identity_mint,
            owner_identity: b_identity_token,
            identity: b_identity,
            binding: b_binding,
            lock: b_lock,
            identity_program: deal_identity::id(),
            token_program: spl_token_interface::ID,
            system_program: anchor_lang::system_program::ID,
            terms,
        }
        .to_account_metas(None),
    );

    let mut terminal_instructions = vec![
        resolve,
        route,
        finalize,
        value,
        prepare_rewards,
        mint_rewards,
        record_credit,
    ];
    assert_eq!(terminal_instructions.len(), 7);
    let mut instructions = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(MAX_COMPUTE_UNITS),
        ComputeBudgetInstruction::set_compute_unit_price(1),
    ];
    instructions.append(&mut terminal_instructions);

    let labels = [
        "compute-limit",
        "compute-price",
        "resolve",
        "route-fees",
        "finalize",
        "value",
        "prepare-rewards",
        "mint-rewards",
        "record-credit",
    ];
    let mut seen = BTreeSet::from([payer.pubkey()]);
    for (label, instruction) in labels.iter().zip(&instructions) {
        let before = seen.len();
        seen.insert(instruction.program_id);
        seen.extend(instruction.accounts.iter().map(|account| account.pubkey));
        eprintln!(
            "account growth {label}: +{} => {}",
            seen.len() - before,
            seen.len()
        );
    }
    assert!(
        seen.len() <= 64,
        "atomic economic core locks {} accounts",
        seen.len()
    );

    let post_index_instructions = vec![
        index_history,
        index_a_credit,
        index_b_credit,
        unlock_a,
        unlock_b,
    ];
    let mut lookup_keys = BTreeSet::new();
    for instruction in instructions.iter().chain(&post_index_instructions) {
        lookup_keys.insert(instruction.program_id);
        for account in &instruction.accounts {
            if !account.is_signer {
                lookup_keys.insert(account.pubkey);
            }
        }
    }
    lookup_keys.remove(&payer.pubkey());
    let lookup_addresses: Vec<_> = lookup_keys.into_iter().collect();
    assert!(lookup_addresses.len() < 256);
    let lookup_table = install_lookup_table(&mut svm, &payer, &lookup_addresses);

    svm.set_sysvar(&Clock {
        slot: 2,
        epoch_start_timestamp: NOW - 1_000,
        epoch: 1,
        leader_schedule_epoch: 1,
        unix_timestamp: NOW,
    });
    let blockhash = svm.latest_blockhash();
    let message = MessageV0::try_compile(
        &payer.pubkey(),
        &instructions,
        std::slice::from_ref(&lookup_table),
        blockhash,
    )
    .unwrap();
    let tx = VersionedTransaction::try_new(VersionedMessage::V0(message), &[&payer]).unwrap();
    let serialized_bytes = bincode::serialize(&tx).unwrap().len();
    assert!(
        serialized_bytes <= PACKET_DATA_SIZE,
        "v0 transaction is {serialized_bytes} bytes"
    );
    eprintln!(
        "pre-execution maximum DC/DC terminal v0: accounts={}, instructions={}, bytes={}",
        seen.len(),
        instructions.len(),
        serialized_bytes
    );
    let metadata = svm.send_transaction(tx).unwrap();
    assert!(metadata.compute_units_consumed <= u64::from(MAX_COMPUTE_UNITS));

    let final_deal: DealAccount = anchor_account(&svm, deal);
    let final_terms: AssetTerms = anchor_account(&svm, terms);
    let credit_result: CreditRecordingReceipt = anchor_account(&svm, credit_receipt);
    assert_eq!(final_deal.status, DealStatus::Completed);
    assert!(final_terms.resolved);
    assert!(final_terms.dc_fees_routed);
    assert_eq!(final_terms.a_identity_mint, a_identity_mint);
    assert_eq!(final_terms.b_identity_mint, b_identity_mint);
    assert!(credit_result.a_delta > 0);
    assert!(credit_result.b_delta > 0);
    assert_eq!(token_balance(&svm, c_dc_destination), 30);
    assert_eq!(token_balance(&svm, a_vault), 0);
    assert_eq!(token_balance(&svm, b_vault), 0);
    assert!(svm.get_account(&creator_header).is_none());
    assert!(svm.get_account(&participant_header).is_none());
    assert!(svm.get_account(&a_credit_marker).is_none());
    assert!(svm.get_account(&b_credit_marker).is_none());

    eprintln!(
        "maximum DC/DC terminal v0: accounts={}, instructions={}, bytes={}, CU={}",
        seen.len(),
        instructions.len(),
        serialized_bytes,
        metadata.compute_units_consumed
    );

    svm.expire_blockhash();
    let mut post_instructions = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(MAX_COMPUTE_UNITS),
        ComputeBudgetInstruction::set_compute_unit_price(1),
    ];
    post_instructions.extend(post_index_instructions);
    let mut post_accounts = BTreeSet::from([payer.pubkey()]);
    for instruction in &post_instructions {
        post_accounts.insert(instruction.program_id);
        post_accounts.extend(instruction.accounts.iter().map(|account| account.pubkey));
    }
    assert!(
        post_accounts.len() <= 64,
        "post-index transaction locks {} accounts",
        post_accounts.len()
    );

    let post_blockhash = svm.latest_blockhash();
    let post_message = MessageV0::try_compile(
        &payer.pubkey(),
        &post_instructions,
        &[AddressLookupTableAccount {
            key: lookup_table.key,
            addresses: lookup_table.addresses.clone(),
        }],
        post_blockhash,
    )
    .unwrap();
    let post_tx =
        VersionedTransaction::try_new(VersionedMessage::V0(post_message), &[&payer]).unwrap();
    let post_bytes = bincode::serialize(&post_tx).unwrap().len();
    assert!(
        post_bytes <= PACKET_DATA_SIZE,
        "post-index v0 transaction is {post_bytes} bytes"
    );
    let post_metadata = svm.send_transaction(post_tx).unwrap();
    assert!(post_metadata.compute_units_consumed <= u64::from(MAX_COMPUTE_UNITS));

    let history_result: HistoryIndexReceipt = anchor_account(&svm, history_receipt);
    let creator_history: UserActivity = anchor_account(&svm, creator_header);
    let participant_history: UserActivity = anchor_account(&svm, participant_header);
    let a_credit_results: ResultHeader = anchor_account(&svm, a_credit_header);
    let b_credit_results: ResultHeader = anchor_account(&svm, b_credit_header);
    assert_eq!(history_result.deal, deal);
    assert_eq!(creator_history.completed_size, 1);
    assert_eq!(participant_history.completed_size, 1);
    assert_eq!(creator_history.completed[0], deal);
    assert_eq!(participant_history.completed[0], deal);
    assert_eq!(a_credit_results.count, 1);
    assert_eq!(b_credit_results.count, 1);
    let post_terms: AssetTerms = anchor_account(&svm, terms);
    assert_eq!(post_terms.a_identity_mint, Pubkey::default());
    assert_eq!(post_terms.b_identity_mint, Pubkey::default());
    assert!(svm.get_account(&a_credit_marker).is_some());
    assert!(svm.get_account(&b_credit_marker).is_some());

    svm.expire_blockhash();
    let replay_blockhash = svm.latest_blockhash();
    let replay_message = MessageV0::try_compile(
        &payer.pubkey(),
        &post_instructions,
        &[lookup_table],
        replay_blockhash,
    )
    .unwrap();
    let replay_tx =
        VersionedTransaction::try_new(VersionedMessage::V0(replay_message), &[&payer]).unwrap();
    assert!(svm.send_transaction(replay_tx).is_err());
    assert_eq!(
        anchor_account::<UserActivity>(&svm, creator_header).completed_size,
        1
    );
    assert_eq!(
        anchor_account::<UserActivity>(&svm, participant_header).completed_size,
        1
    );
    assert_eq!(
        anchor_account::<ResultHeader>(&svm, a_credit_header).count,
        1
    );
    assert_eq!(
        anchor_account::<ResultHeader>(&svm, b_credit_header).count,
        1
    );

    eprintln!(
        "post-index v0: accounts={}, instructions={}, bytes={}, CU={}",
        post_accounts.len(),
        post_instructions.len(),
        post_bytes,
        post_metadata.compute_units_consumed
    );
}
