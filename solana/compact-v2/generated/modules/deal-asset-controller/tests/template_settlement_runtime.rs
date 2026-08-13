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
    constants::REGISTRY_SEED,
    state::{
        CompletionReason, DealAccount, DealRegistry, DealStatus, JoinMode, TemplateType, Vote,
    },
};
use deal_credit_graph::{CreditPeer, CreditScore, SCORE_SEED, TOP_K};
use deal_identity::{DealIdentityBinding, IdentityRecord, BINDING_SEED, IDENTITY_SEED};
use litesvm::LiteSVM;
use serde::Deserialize;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use spl_token_interface::state::{Account as TokenAccount, AccountState, Mint};

const A_AMOUNT: u64 = 10_000;
const B_AMOUNT: u64 = 20_000;
const NOW: i64 = 1_700_000_000;

#[derive(Debug, Deserialize)]
struct TemplateVector {
    name: String,
    template_type: u8,
    open_fast: bool,
    a_swap: u64,
    b_swap: u64,
    a_asset: bool,
    b_asset: bool,
    valid: bool,
}

#[derive(Clone, Copy)]
struct Component {
    spec: AssetSpec,
    vault: Pubkey,
    mint: Pubkey,
    destination: Pubkey,
    fee: Pubkey,
}

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

fn set_mint(svm: &mut LiteSVM, mint: Pubkey, authority: Pubkey, supply: u64, decimals: u8) {
    let state = Mint {
        mint_authority: COption::Some(authority),
        supply,
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

fn token_balance(svm: &LiteSVM, address: Pubkey) -> u64 {
    TokenAccount::unpack(&svm.get_account(&address).unwrap().data)
        .unwrap()
        .amount
}

fn mint_supply(svm: &LiteSVM, address: Pubkey) -> u64 {
    Mint::unpack(&svm.get_account(&address).unwrap().data)
        .unwrap()
        .supply
}

fn template_type(value: u8) -> TemplateType {
    match value {
        0 => TemplateType::TokenToToken,
        1 => TemplateType::TokenToNft,
        2 => TemplateType::TokenToEmpty,
        3 => TemplateType::EmptyToEmpty,
        4 => TemplateType::NftToEmpty,
        _ => panic!("unknown template type {value}"),
    }
}

fn none_component(fallback: Pubkey) -> Component {
    Component {
        spec: AssetSpec::none(),
        vault: fallback,
        mint: fallback,
        destination: fallback,
        fee: fallback,
    }
}

fn spl_component(
    svm: &mut LiteSVM,
    config: Pubkey,
    mint: Pubkey,
    amount: u64,
    recipient: Pubkey,
    treasury: Pubkey,
) -> Component {
    let vault = Pubkey::new_unique();
    let destination = Pubkey::new_unique();
    let fee = Pubkey::new_unique();
    set_token_account(svm, vault, mint, config, amount);
    set_token_account(svm, destination, mint, recipient, 0);
    set_token_account(svm, fee, mint, treasury, 0);
    Component {
        spec: AssetSpec {
            kind: AssetKind::Spl,
            mint,
            vault,
        },
        vault,
        mint,
        destination,
        fee,
    }
}

fn nft_component(
    svm: &mut LiteSVM,
    config: Pubkey,
    mint_authority: Pubkey,
    recipient: Pubkey,
) -> Component {
    let mint = Pubkey::new_unique();
    set_mint(svm, mint, mint_authority, 1, 0);
    let vault = Pubkey::new_unique();
    let destination = Pubkey::new_unique();
    set_token_account(svm, vault, mint, config, 1);
    set_token_account(svm, destination, mint, recipient, 0);
    Component {
        spec: AssetSpec {
            kind: AssetKind::Spl,
            mint,
            vault,
        },
        vault,
        mint,
        destination,
        fee: recipient,
    }
}

#[allow(clippy::too_many_arguments)]
fn resolve_accounts(
    caller: Pubkey,
    config: Pubkey,
    terms: Pubkey,
    registry: Pubkey,
    deal: Pubkey,
    creator: Pubkey,
    participant: Pubkey,
    a_swap: Component,
    b_swap: Component,
    a_nft: Component,
    b_nft: Component,
) -> deal_asset_controller::accounts::ResolveAssets {
    deal_asset_controller::accounts::ResolveAssets {
        caller,
        config,
        terms,
        core_registry: registry,
        deal,
        creator,
        participant,
        a_swap_vault: a_swap.vault,
        a_swap_mint: a_swap.mint,
        a_swap_user: a_swap.destination,
        a_swap_fee: a_swap.fee,
        a_margin_vault: creator,
        a_margin_mint: creator,
        a_margin_user: creator,
        b_swap_vault: b_swap.vault,
        b_swap_mint: b_swap.mint,
        b_swap_user: b_swap.destination,
        b_swap_fee: b_swap.fee,
        b_margin_vault: participant,
        b_margin_mint: participant,
        b_margin_user: participant,
        a_nft_vault: a_nft.vault,
        a_nft_mint: a_nft.mint,
        a_nft_user: a_nft.destination,
        b_nft_vault: b_nft.vault,
        b_nft_mint: b_nft.mint,
        b_nft_user: b_nft.destination,
        token_program: spl_token_interface::ID,
        core_program: deal_core::id(),
        instructions_sysvar: deal_terminal_guard::instructions_sysvar_id(),
    }
}

#[test]
fn every_eth_template_shape_settles_to_the_same_asset_invariants() {
    let vectors: Vec<TemplateVector> =
        serde_json::from_str(include_str!("../../../fixtures/deal-template-shapes.json")).unwrap();
    let valid: Vec<_> = vectors.into_iter().filter(|vector| vector.valid).collect();
    assert_eq!(valid.len(), 9);

    for (index, vector) in valid.iter().enumerate() {
        let mut svm = LiteSVM::new();
        svm.set_sysvar(&Clock {
            slot: 1,
            epoch_start_timestamp: NOW,
            epoch: 1,
            leader_schedule_epoch: 1,
            unix_timestamp: NOW,
        });
        svm.add_program(
            deal_core::id(),
            include_bytes!("../../../target/deploy/deal_compact_lifecycle.so"),
        )
        .unwrap();
        svm.add_program(
            deal_asset_controller::id(),
            include_bytes!("../../../target/deploy/deal_compact_lifecycle.so"),
        )
        .unwrap();

        let creator = Keypair::new();
        let participant = Keypair::new();
        let treasury = Keypair::new();
        for wallet in [&creator, &participant, &treasury] {
            svm.airdrop(&wallet.pubkey(), 5_000_000_000).unwrap();
        }

        let (config, config_bump) =
            Pubkey::find_program_address(&[CONTROLLER_SEED], &deal_asset_controller::id());
        let (registry, registry_bump) =
            Pubkey::find_program_address(&[REGISTRY_SEED], &deal_core::id());
        let deal = Pubkey::new_unique();
        let (terms, terms_bump) = Pubkey::find_program_address(
            &[TERMS_SEED, deal.as_ref()],
            &deal_asset_controller::id(),
        );
        let dc_mint = Pubkey::new_unique();
        set_mint(&mut svm, dc_mint, creator.pubkey(), A_AMOUNT + B_AMOUNT, 6);

        let a_amount = if vector.a_swap > 0 { A_AMOUNT } else { 0 };
        let b_amount = if vector.b_swap > 0 { B_AMOUNT } else { 0 };
        let a_swap = if a_amount > 0 {
            spl_component(
                &mut svm,
                config,
                dc_mint,
                a_amount,
                participant.pubkey(),
                treasury.pubkey(),
            )
        } else {
            none_component(creator.pubkey())
        };
        let b_swap = if b_amount > 0 {
            spl_component(
                &mut svm,
                config,
                dc_mint,
                b_amount,
                creator.pubkey(),
                treasury.pubkey(),
            )
        } else {
            none_component(participant.pubkey())
        };
        let a_nft = if vector.a_asset {
            nft_component(&mut svm, config, creator.pubkey(), participant.pubkey())
        } else {
            none_component(participant.pubkey())
        };
        let b_nft = if vector.b_asset {
            nft_component(&mut svm, config, participant.pubkey(), creator.pubkey())
        } else {
            none_component(creator.pubkey())
        };

        set_anchor_account(
            &mut svm,
            config,
            deal_asset_controller::id(),
            &ControllerConfig {
                authority: creator.pubkey(),
                pending_authority: Pubkey::default(),
                treasury: treasury.pubkey(),
                dc_mint,
                fee_numerator: 3,
                fee_denominator: 1_000,
                terminal_guard_enabled: false,
                paused: false,
                bump: config_bump,
            },
        );
        set_anchor_account(
            &mut svm,
            registry,
            deal_core::id(),
            &DealRegistry {
                authority: creator.pubkey(),
                pending_authority: Pubkey::default(),
                asset_controller: config,
                identity_controller: Pubkey::new_unique(),
                domain_entry_controller: Pubkey::new_unique(),
                next_deal_id: index as u64 + 2,
                min_timeout_seconds: 1,
                paused: false,
                bump: registry_bump,
            },
        );
        set_anchor_account(
            &mut svm,
            deal,
            deal_core::id(),
            &DealAccount {
                id: index as u64 + 1,
                creator: creator.pubkey(),
                participant: participant.pubkey(),
                expected_participant: Pubkey::default(),
                last_removed_participant: Pubkey::default(),
                template_type: template_type(vector.template_type),
                open_token_token_fast: vector.open_fast,
                join_mode: JoinMode::Open,
                status: DealStatus::Locked,
                a_vote: Vote::Accept,
                b_vote: Vote::Unset,
                completion_reason: CompletionReason::None,
                a_funds_deposited: a_amount > 0,
                b_funds_deposited: b_amount > 0,
                a_asset_deposited: vector.a_asset,
                b_asset_deposited: vector.b_asset,
                a_asset_required: vector.a_asset,
                b_asset_required: vector.b_asset,
                a_has_pre_accepted: vector.open_fast,
                is_domain_deal: false,
                a_swap_amount: a_amount,
                a_margin_amount: 0,
                b_swap_amount: b_amount,
                b_margin_amount: 0,
                timeout_seconds: 3_600,
                replace_timeout_seconds: if vector.open_fast { 120 } else { 0 },
                created_at: NOW - 100,
                ended_at: 0,
                b_joined_at: NOW - 90,
                locked_at: NOW - 80,
                a_vote_at: NOW - 10,
                b_vote_at: 0,
                a_pre_accept_at: if vector.open_fast { NOW - 95 } else { 0 },
                title: vector.name.clone(),
                description: "shared ETH/Solana final-state oracle".into(),
                domain_name: String::new(),
                bump: 1,
            },
        );
        set_anchor_account(
            &mut svm,
            terms,
            deal_asset_controller::id(),
            &AssetTerms {
                deal,
                creator: creator.pubkey(),
                a_swap: a_swap.spec,
                a_margin: AssetSpec::none(),
                b_swap: b_swap.spec,
                b_margin: AssetSpec::none(),
                a_asset_nft: a_nft.spec,
                b_asset_nft: b_nft.spec,
                b_depositor: participant.pubkey(),
                a_identity_mint: Pubkey::default(),
                b_identity_mint: Pubkey::default(),
                a_funds_escrowed: a_amount > 0,
                b_funds_escrowed: b_amount > 0,
                a_nft_escrowed: vector.a_asset,
                b_nft_escrowed: vector.b_asset,
                resolved: false,
                dc_fees_routed: false,
                a_fee_paid: 0,
                b_fee_paid: 0,
                bump: terms_bump,
            },
        );

        let settle = Instruction::new_with_bytes(
            deal_asset_controller::id(),
            &deal_asset_controller::instruction::CastVoteAndResolve { vote: Vote::Accept }.data(),
            resolve_accounts(
                participant.pubkey(),
                config,
                terms,
                registry,
                deal,
                creator.pubkey(),
                participant.pubkey(),
                a_swap,
                b_swap,
                a_nft,
                b_nft,
            )
            .to_account_metas(None),
        );
        if index == 0 {
            let mut guarded_config: ControllerConfig = anchor_account(&svm, config);
            guarded_config.terminal_guard_enabled = true;
            set_anchor_account(
                &mut svm,
                config,
                deal_asset_controller::id(),
                &guarded_config,
            );
            assert!(
                !send(
                    &mut svm,
                    &creator,
                    std::slice::from_ref(&settle),
                    &[&participant]
                ),
                "DC/DC resolution without the mandatory fee route must roll back"
            );
            assert_eq!(
                anchor_account::<DealAccount>(&svm, deal).status,
                DealStatus::Locked
            );
            assert_eq!(token_balance(&svm, a_swap.vault), A_AMOUNT);
            assert_eq!(token_balance(&svm, b_swap.vault), B_AMOUNT);
            assert!(!anchor_account::<AssetTerms>(&svm, terms).resolved);
            guarded_config.terminal_guard_enabled = false;
            set_anchor_account(
                &mut svm,
                config,
                deal_asset_controller::id(),
                &guarded_config,
            );
        }
        assert!(
            send(&mut svm, &creator, &[settle], &[&participant]),
            "{} failed to settle",
            vector.name
        );

        let final_deal: DealAccount = anchor_account(&svm, deal);
        let mut final_terms: AssetTerms = anchor_account(&svm, terms);
        assert_eq!(final_deal.status, DealStatus::Completed, "{}", vector.name);
        assert_eq!(
            final_deal.completion_reason,
            CompletionReason::BothAccepted,
            "{}",
            vector.name
        );
        assert!(final_terms.resolved, "{}", vector.name);
        assert!(!final_terms.a_funds_escrowed, "{}", vector.name);
        assert!(!final_terms.b_funds_escrowed, "{}", vector.name);
        assert!(!final_terms.a_nft_escrowed, "{}", vector.name);
        assert!(!final_terms.b_nft_escrowed, "{}", vector.name);
        assert_eq!(
            final_terms.b_depositor,
            Pubkey::default(),
            "{}",
            vector.name
        );

        let both_dc = a_amount > 0 && b_amount > 0;
        let expected_a_fee = if both_dc { A_AMOUNT / 1_000 } else { 0 };
        let expected_b_fee = if both_dc { B_AMOUNT / 1_000 } else { 0 };
        assert_eq!(final_terms.a_fee_paid, expected_a_fee, "{}", vector.name);
        assert_eq!(final_terms.b_fee_paid, expected_b_fee, "{}", vector.name);

        if both_dc {
            assert!(!final_terms.dc_fees_routed, "{}", vector.name);
            assert_eq!(
                token_balance(&svm, a_swap.vault),
                expected_a_fee,
                "{}",
                vector.name
            );
            assert_eq!(
                token_balance(&svm, b_swap.vault),
                expected_b_fee,
                "{}",
                vector.name
            );
            assert_eq!(
                mint_supply(&svm, dc_mint),
                A_AMOUNT + B_AMOUNT,
                "{}",
                vector.name
            );
            let route = Instruction::new_with_bytes(
                deal_asset_controller::id(),
                &deal_asset_controller::instruction::RouteDcFees {}.data(),
                deal_asset_controller::accounts::RouteDcFees {
                    payer: creator.pubkey(),
                    config,
                    terms,
                    deal,
                    a_swap_vault: a_swap.vault,
                    b_swap_vault: b_swap.vault,
                    dc_mint,
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
                    c_dc_destination: None,
                    token_program: spl_token_interface::ID,
                    instructions_sysvar: deal_terminal_guard::instructions_sysvar_id(),
                }
                .to_account_metas(None),
            );
            assert!(
                send(&mut svm, &creator, std::slice::from_ref(&route), &[]),
                "{} failed to burn no-C DC fees",
                vector.name
            );
            final_terms = anchor_account(&svm, terms);
            assert!(final_terms.dc_fees_routed, "{}", vector.name);
            if index == 0 {
                let supply_after_route = mint_supply(&svm, dc_mint);
                assert!(
                    !send(&mut svm, &creator, std::slice::from_ref(&route), &[]),
                    "DC fee route must be single-use"
                );
                assert_eq!(mint_supply(&svm, dc_mint), supply_after_route);
            }
        } else {
            assert!(final_terms.dc_fees_routed, "{}", vector.name);
        }

        if a_amount > 0 {
            assert_eq!(token_balance(&svm, a_swap.vault), 0, "{}", vector.name);
            assert_eq!(
                token_balance(&svm, a_swap.destination),
                A_AMOUNT - expected_a_fee,
                "{}",
                vector.name
            );
            assert_eq!(token_balance(&svm, a_swap.fee), 0, "{}", vector.name);
        }
        if b_amount > 0 {
            assert_eq!(token_balance(&svm, b_swap.vault), 0, "{}", vector.name);
            assert_eq!(
                token_balance(&svm, b_swap.destination),
                B_AMOUNT - expected_b_fee,
                "{}",
                vector.name
            );
            assert_eq!(token_balance(&svm, b_swap.fee), 0, "{}", vector.name);
        }
        assert_eq!(
            mint_supply(&svm, dc_mint),
            A_AMOUNT + B_AMOUNT - expected_a_fee - expected_b_fee,
            "{}",
            vector.name
        );
        if vector.a_asset {
            assert_eq!(token_balance(&svm, a_nft.vault), 0, "{}", vector.name);
            assert_eq!(token_balance(&svm, a_nft.destination), 1, "{}", vector.name);
        }
        if vector.b_asset {
            assert_eq!(token_balance(&svm, b_nft.vault), 0, "{}", vector.name);
            assert_eq!(token_balance(&svm, b_nft.destination), 1, "{}", vector.name);
        }
    }
}

fn identity_side(
    svm: &mut LiteSVM,
    deal: Pubkey,
    party: Pubkey,
    identity_mint: Pubkey,
    score: u128,
    top_peer: Option<(Pubkey, u128)>,
) -> (Pubkey, Pubkey, Pubkey, Pubkey) {
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
            date_code: 20260724,
            daily_serial: 1,
            total_dc_minted: 0,
            max_partner: Pubkey::default(),
            lock_count: 1,
            bump: identity_bump,
        },
    );
    let owner_token = Pubkey::new_unique();
    set_token_account(svm, owner_token, identity_mint, party, 1);
    let (binding, binding_bump) = Pubkey::find_program_address(
        &[BINDING_SEED, deal.as_ref(), party.as_ref()],
        &deal_identity::id(),
    );
    set_anchor_account(
        svm,
        binding,
        deal_identity::id(),
        &DealIdentityBinding {
            deal,
            party,
            identity_mint,
            lock_count: 1,
            bump: binding_bump,
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
            updated_at: NOW,
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
    (identity, owner_token, binding, credit)
}

#[test]
fn dc_fee_route_uses_verified_best_c_and_rolls_back_invalid_accounts() {
    let mut svm = LiteSVM::new();
    svm.add_program(
        deal_asset_controller::id(),
        include_bytes!("../../../target/deploy/deal_compact_lifecycle.so"),
    )
    .unwrap();
    let payer = Keypair::new();
    let creator = Keypair::new();
    let participant = Keypair::new();
    let peer_owner = Keypair::new();
    svm.airdrop(&payer.pubkey(), 5_000_000_000).unwrap();

    let (config, config_bump) =
        Pubkey::find_program_address(&[CONTROLLER_SEED], &deal_asset_controller::id());
    let deal = Pubkey::new_unique();
    let (terms, terms_bump) =
        Pubkey::find_program_address(&[TERMS_SEED, deal.as_ref()], &deal_asset_controller::id());
    let dc_mint = Pubkey::new_unique();
    let a_identity_mint = Pubkey::new_unique();
    let b_identity_mint = Pubkey::new_unique();
    let c_identity_mint = Pubkey::new_unique();
    let a_vault = Pubkey::new_unique();
    let b_vault = Pubkey::new_unique();
    set_mint(&mut svm, dc_mint, payer.pubkey(), 30, 6);
    set_token_account(&mut svm, a_vault, dc_mint, config, 10);
    set_token_account(&mut svm, b_vault, dc_mint, config, 20);
    set_anchor_account(
        &mut svm,
        config,
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
            bump: config_bump,
        },
    );
    set_anchor_account(
        &mut svm,
        deal,
        deal_core::id(),
        &DealAccount {
            id: 1,
            creator: creator.pubkey(),
            participant: participant.pubkey(),
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
            a_swap_amount: A_AMOUNT,
            a_margin_amount: 0,
            b_swap_amount: B_AMOUNT,
            b_margin_amount: 0,
            timeout_seconds: 3_600,
            replace_timeout_seconds: 0,
            created_at: NOW - 100,
            ended_at: NOW,
            b_joined_at: NOW - 90,
            locked_at: NOW - 80,
            a_vote_at: NOW - 10,
            b_vote_at: NOW,
            a_pre_accept_at: 0,
            title: "C fee route".into(),
            description: String::new(),
            domain_name: String::new(),
            bump: 1,
        },
    );
    set_anchor_account(
        &mut svm,
        terms,
        deal_asset_controller::id(),
        &AssetTerms {
            deal,
            creator: creator.pubkey(),
            a_swap: AssetSpec {
                kind: AssetKind::Spl,
                mint: dc_mint,
                vault: a_vault,
            },
            a_margin: AssetSpec::none(),
            b_swap: AssetSpec {
                kind: AssetKind::Spl,
                mint: dc_mint,
                vault: b_vault,
            },
            b_margin: AssetSpec::none(),
            a_asset_nft: AssetSpec::none(),
            b_asset_nft: AssetSpec::none(),
            b_depositor: Pubkey::default(),
            a_identity_mint,
            b_identity_mint,
            a_funds_escrowed: false,
            b_funds_escrowed: false,
            a_nft_escrowed: false,
            b_nft_escrowed: false,
            resolved: true,
            dc_fees_routed: false,
            a_fee_paid: 10,
            b_fee_paid: 20,
            bump: terms_bump,
        },
    );

    let (a_identity, a_token, a_binding, a_credit) = identity_side(
        &mut svm,
        deal,
        creator.pubkey(),
        a_identity_mint,
        100,
        Some((c_identity_mint, 200)),
    );
    let (b_identity, b_token, b_binding, b_credit) = identity_side(
        &mut svm,
        deal,
        participant.pubkey(),
        b_identity_mint,
        150,
        None,
    );
    let (c_identity, c_token, _, _) = identity_side(
        &mut svm,
        Pubkey::new_unique(),
        peer_owner.pubkey(),
        c_identity_mint,
        0,
        None,
    );
    let c_destination = Pubkey::new_unique();
    let wrong_destination = Pubkey::new_unique();
    set_token_account(&mut svm, c_destination, dc_mint, peer_owner.pubkey(), 0);
    set_token_account(
        &mut svm,
        wrong_destination,
        dc_mint,
        participant.pubkey(),
        0,
    );

    let route = |destination: Pubkey, a_credit_account: Option<Pubkey>| {
        Instruction::new_with_bytes(
            deal_asset_controller::id(),
            &deal_asset_controller::instruction::RouteDcFees {}.data(),
            deal_asset_controller::accounts::RouteDcFees {
                payer: payer.pubkey(),
                config,
                terms,
                deal,
                a_swap_vault: a_vault,
                b_swap_vault: b_vault,
                dc_mint,
                a_identity: Some(a_identity),
                a_identity_token: Some(a_token),
                a_binding: Some(a_binding),
                a_credit: a_credit_account,
                b_identity: Some(b_identity),
                b_identity_token: Some(b_token),
                b_binding: Some(b_binding),
                b_credit: Some(b_credit),
                c_identity: Some(c_identity),
                c_identity_token: Some(c_token),
                c_dc_destination: Some(destination),
                token_program: spl_token_interface::ID,
                instructions_sysvar: deal_terminal_guard::instructions_sysvar_id(),
            }
            .to_account_metas(None),
        )
    };

    assert!(!send(
        &mut svm,
        &payer,
        &[route(wrong_destination, Some(a_credit))],
        &[]
    ));
    assert_eq!(token_balance(&svm, a_vault), 10);
    assert_eq!(token_balance(&svm, b_vault), 20);
    assert_eq!(token_balance(&svm, wrong_destination), 0);
    assert_eq!(mint_supply(&svm, dc_mint), 30);
    assert!(!anchor_account::<AssetTerms>(&svm, terms).dc_fees_routed);

    let mut invalid_binding: DealIdentityBinding = anchor_account(&svm, b_binding);
    invalid_binding.party = creator.pubkey();
    set_anchor_account(&mut svm, b_binding, deal_identity::id(), &invalid_binding);
    assert!(!send(
        &mut svm,
        &payer,
        &[route(c_destination, Some(a_credit))],
        &[]
    ));
    assert_eq!(token_balance(&svm, a_vault), 10);
    assert_eq!(token_balance(&svm, b_vault), 20);
    invalid_binding.party = participant.pubkey();
    set_anchor_account(&mut svm, b_binding, deal_identity::id(), &invalid_binding);

    assert!(!send(&mut svm, &payer, &[route(c_destination, None)], &[]));
    assert_eq!(token_balance(&svm, a_vault), 10);
    assert_eq!(token_balance(&svm, b_vault), 20);
    assert!(!anchor_account::<AssetTerms>(&svm, terms).dc_fees_routed);

    let mut zero_credit_svm = svm.clone();
    for credit in [a_credit, b_credit] {
        zero_credit_svm
            .set_account(
                credit,
                Account {
                    lamports: 0,
                    data: Vec::new(),
                    owner: anchor_lang::system_program::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }
    let zero_credit_route = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::RouteDcFees {}.data(),
        deal_asset_controller::accounts::RouteDcFees {
            payer: payer.pubkey(),
            config,
            terms,
            deal,
            a_swap_vault: a_vault,
            b_swap_vault: b_vault,
            dc_mint,
            a_identity: Some(a_identity),
            a_identity_token: Some(a_token),
            a_binding: Some(a_binding),
            a_credit: Some(a_credit),
            b_identity: Some(b_identity),
            b_identity_token: Some(b_token),
            b_binding: Some(b_binding),
            b_credit: Some(b_credit),
            c_identity: None,
            c_identity_token: None,
            c_dc_destination: None,
            token_program: spl_token_interface::ID,
            instructions_sysvar: deal_terminal_guard::instructions_sysvar_id(),
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut zero_credit_svm,
        &payer,
        &[zero_credit_route],
        &[]
    ));
    assert_eq!(token_balance(&zero_credit_svm, a_vault), 0);
    assert_eq!(token_balance(&zero_credit_svm, b_vault), 0);
    assert_eq!(mint_supply(&zero_credit_svm, dc_mint), 0);
    assert!(anchor_account::<AssetTerms>(&zero_credit_svm, terms).dc_fees_routed);

    let valid_route = route(c_destination, Some(a_credit));
    let mut guarded_config: ControllerConfig = anchor_account(&svm, config);
    guarded_config.terminal_guard_enabled = true;
    set_anchor_account(
        &mut svm,
        config,
        deal_asset_controller::id(),
        &guarded_config,
    );
    assert!(!send(
        &mut svm,
        &payer,
        std::slice::from_ref(&valid_route),
        &[]
    ));
    assert_eq!(token_balance(&svm, a_vault), 10);
    assert_eq!(token_balance(&svm, b_vault), 20);
    assert_eq!(token_balance(&svm, c_destination), 0);
    assert!(!anchor_account::<AssetTerms>(&svm, terms).dc_fees_routed);
    guarded_config.terminal_guard_enabled = false;
    set_anchor_account(
        &mut svm,
        config,
        deal_asset_controller::id(),
        &guarded_config,
    );
    assert!(send(
        &mut svm,
        &payer,
        std::slice::from_ref(&valid_route),
        &[]
    ));
    assert_eq!(token_balance(&svm, a_vault), 0);
    assert_eq!(token_balance(&svm, b_vault), 0);
    assert_eq!(token_balance(&svm, c_destination), 30);
    assert_eq!(mint_supply(&svm, dc_mint), 30);
    assert!(anchor_account::<AssetTerms>(&svm, terms).dc_fees_routed);
    assert!(!send(&mut svm, &payer, &[valid_route], &[]));
    assert_eq!(token_balance(&svm, c_destination), 30);
}
