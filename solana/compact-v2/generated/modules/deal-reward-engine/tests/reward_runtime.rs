use anchor_lang::{
    prelude::{AccountDeserialize, AccountSerialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_asset_controller::state::{AssetKind, AssetSpec, AssetTerms, ControllerConfig};
use deal_asset_controller::{CONTROLLER_SEED, TERMS_SEED};
use deal_core::state::{CompletionReason, DealAccount, DealStatus, JoinMode, TemplateType, Vote};
use deal_dc_controller::{DcControllerConfig, MinterGrant};
use deal_dex_pair::PairState;
use deal_reward_engine::{
    RewardConfig, RewardQuote, RewardReceipt, CONFIG_SEED, MINTER_SEED, OBSERVATION_SEED,
    QUOTE_SEED, RECEIPT_SEED,
};
use deal_swap_asset_registry::{SwapAssetRegistry, REGISTRY_SEED};
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

fn send(svm: &mut LiteSVM, payer: &Keypair, instructions: &[Instruction]) -> bool {
    let blockhash = svm.latest_blockhash();
    let message = Message::new_with_blockhash(instructions, Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &[payer]).unwrap();
    let result = svm.send_transaction(tx).is_ok();
    svm.expire_blockhash();
    result
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

fn get_anchor_account<T: AccountDeserialize>(svm: &LiteSVM, address: Pubkey) -> T {
    let account = svm.get_account(&address).unwrap();
    T::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn set_mint(svm: &mut LiteSVM, mint: Pubkey, authority: Pubkey, decimals: u8) {
    let state = Mint {
        mint_authority: COption::Some(authority),
        supply: 0,
        decimals,
        is_initialized: true,
        freeze_authority: COption::None,
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

fn set_token_account(svm: &mut LiteSVM, address: Pubkey, mint: Pubkey, owner: Pubkey) {
    let state = TokenAccount {
        mint,
        owner,
        amount: 0,
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

fn token_amount(svm: &LiteSVM, address: Pubkey) -> u64 {
    TokenAccount::unpack(&svm.get_account(&address).unwrap().data)
        .unwrap()
        .amount
}

fn spl(mint: Pubkey) -> AssetSpec {
    AssetSpec {
        kind: AssetKind::Spl,
        mint,
        vault: Pubkey::new_unique(),
    }
}

fn completed_deal(id: u64, creator: Pubkey, participant: Pubkey, a: u64, b: u64) -> DealAccount {
    DealAccount {
        id,
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
        a_funds_deposited: false,
        b_funds_deposited: false,
        a_asset_deposited: false,
        b_asset_deposited: false,
        a_asset_required: false,
        b_asset_required: false,
        a_has_pre_accepted: false,
        is_domain_deal: false,
        a_swap_amount: a,
        a_margin_amount: 0,
        b_swap_amount: b,
        b_margin_amount: 0,
        timeout_seconds: 300,
        replace_timeout_seconds: 120,
        created_at: NOW - 30,
        ended_at: NOW,
        b_joined_at: NOW - 20,
        locked_at: NOW - 10,
        a_vote_at: NOW - 5,
        b_vote_at: NOW - 4,
        a_pre_accept_at: 0,
        title: "reward runtime".into(),
        description: String::new(),
        domain_name: String::new(),
        bump: 1,
    }
}

fn terms_for(deal: Pubkey, creator: Pubkey, a: AssetSpec, b: AssetSpec, bump: u8) -> AssetTerms {
    AssetTerms {
        deal,
        creator,
        a_swap: a,
        a_margin: AssetSpec::none(),
        b_swap: b,
        b_margin: AssetSpec::none(),
        a_asset_nft: AssetSpec::none(),
        b_asset_nft: AssetSpec::none(),
        b_depositor: Pubkey::default(),
        a_identity_mint: Pubkey::default(),
        b_identity_mint: Pubkey::default(),
        a_funds_escrowed: false,
        b_funds_escrowed: false,
        a_nft_escrowed: false,
        b_nft_escrowed: false,
        resolved: true,
        dc_fees_routed: true,
        a_fee_paid: 30,
        b_fee_paid: 30,
        bump,
    }
}

fn pair(dc_mint: Pubkey, other_mint: Pubkey) -> PairState {
    PairState {
        dc_mint,
        other_mint,
        dc_token_program: spl_token_interface::ID,
        other_token_program: spl_token_interface::ID,
        vault0: Pubkey::new_unique(),
        vault1: Pubkey::new_unique(),
        reserve0: 1_000_000,
        reserve1: 10_000,
        virtual_reserve0: 0,
        virtual_reserve1: 0,
        price0_cumulative: 0,
        price1_cumulative: 0,
        last_timestamp: NOW,
        fee_numerator: 3,
        fee_denominator: 1_000,
        virtual0_enabled: false,
        virtual1_enabled: false,
        liquidity_initialized: true,
        bump: 1,
    }
}

struct Fixture {
    payer: Keypair,
    creator: Pubkey,
    participant: Pubkey,
    dc_mint: Pubkey,
    stable0_mint: Pubkey,
    stable1_mint: Pubkey,
    registry: Pubkey,
    asset_config: Pubkey,
    reward_config: Pubkey,
    reward_minter: Pubkey,
    dc_controller_config: Pubkey,
    dc_minter_grant: Pubkey,
    wrapped_pair: Pubkey,
    stable0_pair: Pubkey,
    stable1_pair: Pubkey,
    a_destination: Pubkey,
    b_destination: Pubkey,
}

fn setup() -> (LiteSVM, Fixture) {
    let mut svm = LiteSVM::new();
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: NOW,
        epoch: 1,
        leader_schedule_epoch: 1,
        unix_timestamp: NOW,
    });
    svm.add_program(
        deal_dc_controller::id(),
        include_bytes!("../../../target/deploy/deal_compact_monetary_policy.so"),
    )
    .unwrap();
    svm.add_program(
        deal_reward_engine::id(),
        include_bytes!("../../../target/deploy/deal_compact_settlement.so"),
    )
    .unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    let creator = Pubkey::new_unique();
    let participant = Pubkey::new_unique();
    let dc_mint = Pubkey::new_unique();
    let wrapped_mint = Pubkey::new_unique();
    let stable0_mint = Pubkey::new_unique();
    let stable1_mint = Pubkey::new_unique();
    let wrapped_pair = Pubkey::new_unique();
    let stable0_pair = Pubkey::new_unique();
    let stable1_pair = Pubkey::new_unique();

    let (reward_config, reward_config_bump) =
        Pubkey::find_program_address(&[CONFIG_SEED], &deal_reward_engine::id());
    let (reward_minter, _) =
        Pubkey::find_program_address(&[MINTER_SEED], &deal_reward_engine::id());
    let (registry, registry_bump) =
        Pubkey::find_program_address(&[REGISTRY_SEED], &deal_swap_asset_registry::id());
    let (asset_config, asset_config_bump) =
        Pubkey::find_program_address(&[CONTROLLER_SEED], &deal_asset_controller::id());
    let (dc_controller_config, dc_controller_bump) = Pubkey::find_program_address(
        &[deal_dc_controller::CONFIG_SEED],
        &deal_dc_controller::id(),
    );
    let (dc_minter_grant, dc_grant_bump) = Pubkey::find_program_address(
        &[deal_dc_controller::MINTER_SEED, reward_minter.as_ref()],
        &deal_dc_controller::id(),
    );

    set_anchor_account(
        &mut svm,
        reward_config,
        deal_reward_engine::id(),
        &RewardConfig {
            authority: payer.pubkey(),
            pending_authority: Pubkey::default(),
            dc_mint,
            dc_controller: dc_controller_config,
            reward_numerator: 1,
            reward_denominator: 1_000,
            min_window_seconds: 1_800,
            paused: false,
            bump: reward_config_bump,
        },
    );
    set_anchor_account(
        &mut svm,
        registry,
        deal_swap_asset_registry::id(),
        &SwapAssetRegistry {
            authority: payer.pubkey(),
            pending_authority: Pubkey::default(),
            pair_program: deal_dex_pair::id(),
            router_program: Pubkey::new_unique(),
            dc_mint,
            wrapped_native_mint: wrapped_mint,
            stable0_mint,
            stable1_mint,
            wrapped_native_pair: wrapped_pair,
            stable0_pair,
            stable1_pair,
            revision: 7,
            bump: registry_bump,
        },
    );
    set_anchor_account(
        &mut svm,
        asset_config,
        deal_asset_controller::id(),
        &ControllerConfig {
            authority: payer.pubkey(),
            pending_authority: Pubkey::default(),
            treasury: Pubkey::new_unique(),
            dc_mint,
            fee_numerator: 3,
            fee_denominator: 1_000,
            terminal_guard_enabled: false,
            paused: false,
            bump: asset_config_bump,
        },
    );
    set_anchor_account(
        &mut svm,
        dc_controller_config,
        deal_dc_controller::id(),
        &DcControllerConfig {
            authority: payer.pubkey(),
            pending_authority: Pubkey::default(),
            dc_mint,
            dc_token_program: spl_token_interface::ID,
            total_minted: 0,
            paused: false,
            bump: dc_controller_bump,
        },
    );
    set_anchor_account(
        &mut svm,
        dc_minter_grant,
        deal_dc_controller::id(),
        &MinterGrant {
            minter: reward_minter,
            enabled: true,
            bump: dc_grant_bump,
        },
    );
    set_anchor_account(
        &mut svm,
        wrapped_pair,
        deal_dex_pair::id(),
        &pair(dc_mint, wrapped_mint),
    );
    set_anchor_account(
        &mut svm,
        stable0_pair,
        deal_dex_pair::id(),
        &pair(dc_mint, stable0_mint),
    );
    set_anchor_account(
        &mut svm,
        stable1_pair,
        deal_dex_pair::id(),
        &pair(dc_mint, stable1_mint),
    );

    set_mint(&mut svm, dc_mint, dc_controller_config, 6);
    let a_destination = Pubkey::new_unique();
    let b_destination = Pubkey::new_unique();
    set_token_account(&mut svm, a_destination, dc_mint, creator);
    set_token_account(&mut svm, b_destination, dc_mint, participant);

    (
        svm,
        Fixture {
            payer,
            creator,
            participant,
            dc_mint,
            stable0_mint,
            stable1_mint,
            registry,
            asset_config,
            reward_config,
            reward_minter,
            dc_controller_config,
            dc_minter_grant,
            wrapped_pair,
            stable0_pair,
            stable1_pair,
            a_destination,
            b_destination,
        },
    )
}

fn set_deal_and_terms(
    svm: &mut LiteSVM,
    fixture: &Fixture,
    deal: Pubkey,
    id: u64,
    a_spec: AssetSpec,
    b_spec: AssetSpec,
) -> Pubkey {
    set_anchor_account(
        svm,
        deal,
        deal_core::id(),
        &completed_deal(id, fixture.creator, fixture.participant, 10_000, 10_000),
    );
    let (terms, bump) =
        Pubkey::find_program_address(&[TERMS_SEED, deal.as_ref()], &deal_asset_controller::id());
    set_anchor_account(
        svm,
        terms,
        deal_asset_controller::id(),
        &terms_for(deal, fixture.creator, a_spec, b_spec, bump),
    );
    terms
}

fn prepare_instruction(fixture: &Fixture, deal: Pubkey, terms: Pubkey) -> (Instruction, Pubkey) {
    let (wrapped_observation, _) = Pubkey::find_program_address(
        &[OBSERVATION_SEED, fixture.wrapped_pair.as_ref()],
        &deal_reward_engine::id(),
    );
    let (stable0_observation, _) = Pubkey::find_program_address(
        &[OBSERVATION_SEED, fixture.stable0_pair.as_ref()],
        &deal_reward_engine::id(),
    );
    let (stable1_observation, _) = Pubkey::find_program_address(
        &[OBSERVATION_SEED, fixture.stable1_pair.as_ref()],
        &deal_reward_engine::id(),
    );
    let (quote, _) =
        Pubkey::find_program_address(&[QUOTE_SEED, deal.as_ref()], &deal_reward_engine::id());
    let instruction = Instruction::new_with_bytes(
        deal_reward_engine::id(),
        &deal_reward_engine::instruction::PrepareCompletedRewards {}.data(),
        deal_reward_engine::accounts::PrepareCompletedRewards {
            config: fixture.reward_config,
            payer: fixture.payer.pubkey(),
            deal,
            terms,
            asset_config: fixture.asset_config,
            registry: fixture.registry,
            wrapped_native_pair: fixture.wrapped_pair,
            stable0_pair: fixture.stable0_pair,
            stable1_pair: fixture.stable1_pair,
            wrapped_native_observation: wrapped_observation,
            stable0_observation,
            stable1_observation,
            quote,
            system_program: anchor_lang::system_program::ID,
            instructions_sysvar: deal_terminal_guard::instructions_sysvar_id(),
        }
        .to_account_metas(None),
    );
    (instruction, quote)
}

fn mint_instruction(
    fixture: &Fixture,
    deal: Pubkey,
    terms: Pubkey,
    quote: Pubkey,
) -> (Instruction, Pubkey) {
    let (receipt, _) =
        Pubkey::find_program_address(&[RECEIPT_SEED, deal.as_ref()], &deal_reward_engine::id());
    let instruction = Instruction::new_with_bytes(
        deal_reward_engine::id(),
        &deal_reward_engine::instruction::MintCompletedRewards {}.data(),
        deal_reward_engine::accounts::MintCompletedRewards {
            config: fixture.reward_config,
            payer: fixture.payer.pubkey(),
            reward_minter: fixture.reward_minter,
            deal,
            quote,
            a_identity: None,
            a_identity_token: None,
            a_binding: None,
            a_credit: None,
            b_identity: None,
            b_identity_token: None,
            b_binding: None,
            b_credit: None,
            c_identity: None,
            c_identity_token: None,
            a_dc_destination: fixture.a_destination,
            b_dc_destination: fixture.b_destination,
            c_dc_destination: None,
            dc_mint: fixture.dc_mint,
            dc_controller_config: fixture.dc_controller_config,
            dc_minter_grant: fixture.dc_minter_grant,
            dc_token_program: spl_token_interface::ID,
            dc_controller_program: deal_dc_controller::id(),
            receipt,
            system_program: anchor_lang::system_program::ID,
            terms,
            asset_config: fixture.asset_config,
            instructions_sysvar: deal_terminal_guard::instructions_sysvar_id(),
        }
        .to_account_metas(None),
    );
    (instruction, receipt)
}

#[test]
fn recognized_rewards_mint_once_and_unknown_or_both_dc_pairs_quote_zero() {
    let (mut svm, fixture) = setup();

    let recognized_deal = Pubkey::new_unique();
    let recognized_terms = set_deal_and_terms(
        &mut svm,
        &fixture,
        recognized_deal,
        1,
        spl(fixture.stable0_mint),
        spl(fixture.stable1_mint),
    );
    let (prepare, quote) = prepare_instruction(&fixture, recognized_deal, recognized_terms);
    let mut asset_config_state: ControllerConfig = get_anchor_account(&svm, fixture.asset_config);
    asset_config_state.terminal_guard_enabled = true;
    set_anchor_account(
        &mut svm,
        fixture.asset_config,
        deal_asset_controller::id(),
        &asset_config_state,
    );
    assert!(!send(
        &mut svm,
        &fixture.payer,
        std::slice::from_ref(&prepare)
    ));
    assert!(svm.get_account(&quote).is_none());
    asset_config_state.terminal_guard_enabled = false;
    set_anchor_account(
        &mut svm,
        fixture.asset_config,
        deal_asset_controller::id(),
        &asset_config_state,
    );
    assert!(send(
        &mut svm,
        &fixture.payer,
        std::slice::from_ref(&prepare)
    ));
    let quote_state: RewardQuote = get_anchor_account(&svm, quote);
    assert_eq!(quote_state.a_reward, 1_000);
    assert_eq!(quote_state.b_reward, 1_000);
    assert!(!send(&mut svm, &fixture.payer, &[prepare]));

    let (mint, receipt) = mint_instruction(&fixture, recognized_deal, recognized_terms, quote);
    asset_config_state.terminal_guard_enabled = true;
    set_anchor_account(
        &mut svm,
        fixture.asset_config,
        deal_asset_controller::id(),
        &asset_config_state,
    );
    assert!(!send(&mut svm, &fixture.payer, std::slice::from_ref(&mint)));
    assert!(svm.get_account(&receipt).is_none());
    assert_eq!(token_amount(&svm, fixture.a_destination), 0);
    assert_eq!(token_amount(&svm, fixture.b_destination), 0);
    asset_config_state.terminal_guard_enabled = false;
    set_anchor_account(
        &mut svm,
        fixture.asset_config,
        deal_asset_controller::id(),
        &asset_config_state,
    );
    assert!(send(&mut svm, &fixture.payer, std::slice::from_ref(&mint)));
    let receipt_state: RewardReceipt = get_anchor_account(&svm, receipt);
    assert_eq!(receipt_state.a_reward, 1_000);
    assert_eq!(receipt_state.b_reward, 1_000);
    assert_eq!(receipt_state.c_reward, 0);
    assert_eq!(token_amount(&svm, fixture.a_destination), 1_000);
    assert_eq!(token_amount(&svm, fixture.b_destination), 1_000);
    assert!(!send(&mut svm, &fixture.payer, &[mint]));
    assert_eq!(token_amount(&svm, fixture.a_destination), 1_000);
    assert_eq!(token_amount(&svm, fixture.b_destination), 1_000);

    let dc_deal = Pubkey::new_unique();
    let dc_terms = set_deal_and_terms(
        &mut svm,
        &fixture,
        dc_deal,
        2,
        spl(fixture.dc_mint),
        spl(fixture.dc_mint),
    );
    let (prepare_dc, dc_quote) = prepare_instruction(&fixture, dc_deal, dc_terms);
    assert!(send(&mut svm, &fixture.payer, &[prepare_dc]));
    let dc_quote_state: RewardQuote = get_anchor_account(&svm, dc_quote);
    assert_eq!((dc_quote_state.a_reward, dc_quote_state.b_reward), (0, 0));

    let mixed_dc_deal = Pubkey::new_unique();
    let mixed_dc_terms = set_deal_and_terms(
        &mut svm,
        &fixture,
        mixed_dc_deal,
        3,
        spl(fixture.dc_mint),
        spl(fixture.stable0_mint),
    );
    let (prepare_mixed_dc, mixed_dc_quote) =
        prepare_instruction(&fixture, mixed_dc_deal, mixed_dc_terms);
    assert!(send(&mut svm, &fixture.payer, &[prepare_mixed_dc]));
    let mixed_dc_quote_state: RewardQuote = get_anchor_account(&svm, mixed_dc_quote);
    assert_eq!(
        (mixed_dc_quote_state.a_reward, mixed_dc_quote_state.b_reward),
        (0, 1_000)
    );

    let unknown_deal = Pubkey::new_unique();
    let unknown_terms = set_deal_and_terms(
        &mut svm,
        &fixture,
        unknown_deal,
        4,
        spl(Pubkey::new_unique()),
        spl(fixture.stable0_mint),
    );
    let (prepare_unknown, unknown_quote) =
        prepare_instruction(&fixture, unknown_deal, unknown_terms);
    assert!(send(&mut svm, &fixture.payer, &[prepare_unknown]));
    let unknown_quote_state: RewardQuote = get_anchor_account(&svm, unknown_quote);
    assert_eq!(
        (unknown_quote_state.a_reward, unknown_quote_state.b_reward),
        (0, 0)
    );

    let atomic_deal = Pubkey::new_unique();
    let atomic_terms = set_deal_and_terms(
        &mut svm,
        &fixture,
        atomic_deal,
        5,
        spl(fixture.stable0_mint),
        spl(fixture.stable1_mint),
    );
    let (prepare_atomic, atomic_quote) = prepare_instruction(&fixture, atomic_deal, atomic_terms);
    let (mint_atomic, _) = mint_instruction(&fixture, atomic_deal, atomic_terms, atomic_quote);
    assert!(send(
        &mut svm,
        &fixture.payer,
        &[prepare_atomic, mint_atomic]
    ));
    assert_eq!(token_amount(&svm, fixture.a_destination), 2_000);
    assert_eq!(token_amount(&svm, fixture.b_destination), 2_000);
}
