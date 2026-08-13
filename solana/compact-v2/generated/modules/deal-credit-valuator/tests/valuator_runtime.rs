use anchor_lang::{
    prelude::{AccountDeserialize, AccountSerialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_asset_controller::state::{AssetKind, AssetSpec, AssetTerms, ControllerConfig};
use deal_core::state::{CompletionReason, DealAccount, DealStatus, JoinMode, TemplateType, Vote};
use deal_credit_valuator::{CreditValuationReceipt, VALUATION_SEED};
use deal_dex_pair::PairState;
use deal_swap_asset_registry::{SwapAssetRegistry, REGISTRY_SEED};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use spl_token_interface::state::Mint;

const NOW: i64 = 1_700_000_200;

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
            lamports: 5_000_000,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn set_mint(svm: &mut LiteSVM, mint: Pubkey, authority: Pubkey, decimals: u8) {
    let state = Mint {
        mint_authority: COption::Some(authority),
        supply: 1_000_000_000,
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

fn pair(dc_mint: Pubkey, other_mint: Pubkey, bump: u8) -> PairState {
    PairState {
        dc_mint,
        other_mint,
        dc_token_program: spl_token_interface::ID,
        other_token_program: spl_token_interface::ID,
        vault0: Pubkey::new_unique(),
        vault1: Pubkey::new_unique(),
        reserve0: 1_000_000,
        reserve1: 2_000_000,
        virtual_reserve0: 1_000_000,
        virtual_reserve1: 2_000_000,
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

#[test]
fn records_immutable_u18_credit_from_settled_fees_and_official_pairs() {
    let mut svm = LiteSVM::new();
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: NOW,
        epoch: 1,
        leader_schedule_epoch: 1,
        unix_timestamp: NOW,
    });
    svm.add_program(
        deal_credit_valuator::id(),
        include_bytes!("../../../target/deploy/deal_compact_settlement.so"),
    )
    .unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 3_000_000_000).unwrap();

    let creator = Pubkey::new_unique();
    let participant = Pubkey::new_unique();
    let dc_mint = Pubkey::new_unique();
    let native_mint = Pubkey::new_unique();
    let stable0_mint = Pubkey::new_unique();
    let stable1_mint = Pubkey::new_unique();
    set_mint(&mut svm, stable0_mint, payer.pubkey(), 6);
    set_mint(&mut svm, stable1_mint, payer.pubkey(), 6);

    let (native_pair, native_bump) = Pubkey::find_program_address(
        &[deal_dex_pair::PAIR_SEED, native_mint.as_ref()],
        &deal_dex_pair::id(),
    );
    let (stable0_pair, stable0_bump) = Pubkey::find_program_address(
        &[deal_dex_pair::PAIR_SEED, stable0_mint.as_ref()],
        &deal_dex_pair::id(),
    );
    let (stable1_pair, stable1_bump) = Pubkey::find_program_address(
        &[deal_dex_pair::PAIR_SEED, stable1_mint.as_ref()],
        &deal_dex_pair::id(),
    );
    set_anchor_account(
        &mut svm,
        native_pair,
        deal_dex_pair::id(),
        &pair(dc_mint, native_mint, native_bump),
    );
    set_anchor_account(
        &mut svm,
        stable0_pair,
        deal_dex_pair::id(),
        &pair(dc_mint, stable0_mint, stable0_bump),
    );
    set_anchor_account(
        &mut svm,
        stable1_pair,
        deal_dex_pair::id(),
        &pair(dc_mint, stable1_mint, stable1_bump),
    );

    let (registry, registry_bump) =
        Pubkey::find_program_address(&[REGISTRY_SEED], &deal_swap_asset_registry::id());
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
            wrapped_native_mint: native_mint,
            stable0_mint,
            stable1_mint,
            wrapped_native_pair: native_pair,
            stable0_pair,
            stable1_pair,
            revision: 7,
            bump: registry_bump,
        },
    );

    let deal = Pubkey::new_unique();
    set_anchor_account(
        &mut svm,
        deal,
        deal_core::id(),
        &DealAccount {
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
            a_has_pre_accepted: true,
            is_domain_deal: false,
            a_swap_amount: 10_000,
            a_margin_amount: 0,
            b_swap_amount: 100_000,
            b_margin_amount: 0,
            timeout_seconds: 300,
            replace_timeout_seconds: 120,
            created_at: NOW - 200,
            ended_at: NOW - 100,
            b_joined_at: NOW - 190,
            locked_at: NOW - 180,
            a_vote_at: NOW - 120,
            b_vote_at: NOW - 100,
            a_pre_accept_at: NOW - 195,
            title: "credit valuation".into(),
            description: "settled fee receipt".into(),
            domain_name: String::new(),
            bump: 1,
        },
    );
    let (terms, terms_bump) = Pubkey::find_program_address(
        &[deal_asset_controller::TERMS_SEED, deal.as_ref()],
        &deal_asset_controller::id(),
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
                mint: stable0_mint,
                vault: Pubkey::new_unique(),
            },
            a_margin: none,
            b_swap: AssetSpec {
                kind: AssetKind::Spl,
                mint: dc_mint,
                vault: Pubkey::new_unique(),
            },
            b_margin: none,
            a_asset_nft: none,
            b_asset_nft: none,
            b_depositor: participant,
            a_identity_mint: Pubkey::default(),
            b_identity_mint: Pubkey::default(),
            a_funds_escrowed: false,
            b_funds_escrowed: false,
            a_nft_escrowed: false,
            b_nft_escrowed: false,
            resolved: true,
            dc_fees_routed: true,
            a_fee_paid: 30,
            b_fee_paid: 100,
            bump: terms_bump,
        },
    );
    let (asset_config, asset_config_bump) = Pubkey::find_program_address(
        &[deal_asset_controller::CONTROLLER_SEED],
        &deal_asset_controller::id(),
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

    let (receipt, _) = Pubkey::find_program_address(
        &[VALUATION_SEED, deal.as_ref()],
        &deal_credit_valuator::id(),
    );
    let value = Instruction::new_with_bytes(
        deal_credit_valuator::id(),
        &deal_credit_valuator::instruction::ValueCompletedDeal {}.data(),
        deal_credit_valuator::accounts::ValueCompletedDeal {
            payer: payer.pubkey(),
            deal,
            terms,
            registry,
            stable0_mint,
            stable1_mint,
            wrapped_native_pair: native_pair,
            stable0_pair,
            stable1_pair,
            receipt,
            system_program: anchor_lang::system_program::ID,
            asset_config,
            instructions_sysvar: deal_terminal_guard::instructions_sysvar_id(),
        }
        .to_account_metas(None),
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
            terminal_guard_enabled: true,
            paused: false,
            bump: asset_config_bump,
        },
    );
    assert!(!send(&mut svm, &payer, std::slice::from_ref(&value)));
    assert!(svm.get_account(&receipt).is_none());
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
    assert!(send(&mut svm, &payer, std::slice::from_ref(&value)));

    let account = svm.get_account(&receipt).expect("receipt must exist");
    let receipt = CreditValuationReceipt::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(receipt.registry_revision, 7);
    assert_eq!(receipt.a_credit_u, 30_000_000_000_000);
    assert_eq!(receipt.b_credit_u, 200_000_000_000_000);
    assert_eq!(receipt.base_credit_u, 230_000_000_000_000);
    assert_eq!(receipt.ended_at, NOW - 100);
    assert_eq!(receipt.valued_at, NOW);

    // A valuation receipt is immutable and cannot be recreated for the same deal.
    assert!(!send(&mut svm, &payer, &[value]));
}
