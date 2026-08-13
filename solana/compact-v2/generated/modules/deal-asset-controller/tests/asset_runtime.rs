use anchor_lang::{
    prelude::{AccountDeserialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_asset_controller::{
    state::{AssetKind, AssetSpec, AssetTerms, ConfigureTermsParams},
    CONTROLLER_SEED, TERMS_SEED,
};
use deal_core::{
    constants::{DEAL_SEED, REGISTRY_SEED},
    state::{CreateDealParams, DealAccount, DealStatus, JoinMode, TemplateType, Vote},
};
use litesvm::LiteSVM;
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
    let account = svm.get_account(&address).expect("token account must exist");
    TokenAccount::unpack(&account.data).unwrap().amount
}

fn spl(mint: Pubkey, vault: Pubkey) -> AssetSpec {
    AssetSpec {
        kind: AssetKind::Spl,
        mint,
        vault,
    }
}

fn native() -> AssetSpec {
    AssetSpec {
        kind: AssetKind::Native,
        mint: Pubkey::default(),
        vault: Pubkey::default(),
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
    a_vault: Pubkey,
    a_mint: Pubkey,
    a_user: Pubkey,
    a_fee: Pubkey,
    b_vault: Pubkey,
    b_mint: Pubkey,
    b_user: Pubkey,
    b_fee: Pubkey,
    b_nft_vault: Pubkey,
    b_nft_mint: Pubkey,
    b_nft_user: Pubkey,
) -> deal_asset_controller::accounts::ResolveAssets {
    deal_asset_controller::accounts::ResolveAssets {
        caller,
        config,
        terms,
        core_registry: registry,
        deal,
        creator,
        participant,
        a_swap_vault: a_vault,
        a_swap_mint: a_mint,
        a_swap_user: a_user,
        a_swap_fee: a_fee,
        a_margin_vault: creator,
        a_margin_mint: creator,
        a_margin_user: creator,
        b_swap_vault: b_vault,
        b_swap_mint: b_mint,
        b_swap_user: b_user,
        b_swap_fee: b_fee,
        b_margin_vault: creator,
        b_margin_mint: creator,
        b_margin_user: participant,
        a_nft_vault: creator,
        a_nft_mint: creator,
        a_nft_user: participant,
        b_nft_vault,
        b_nft_mint,
        b_nft_user,
        token_program: spl_token_interface::ID,
        core_program: deal_core::id(),
        instructions_sysvar: deal_terminal_guard::instructions_sysvar_id(),
    }
}

#[test]
fn spl_deposits_settle_atomically_and_charge_evm_compatible_fees() {
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
    svm.add_program(
        deal_asset_controller::id(),
        include_bytes!("../../../target/deploy/deal_compact_lifecycle.so"),
    )
    .unwrap();

    let creator = Keypair::new();
    let participant = Keypair::new();
    let treasury = Keypair::new();
    for wallet in [&creator, &participant, &treasury] {
        svm.airdrop(&wallet.pubkey(), 20_000_000_000).unwrap();
    }

    let (config, _) =
        Pubkey::find_program_address(&[CONTROLLER_SEED], &deal_asset_controller::id());
    let (registry, _) = Pubkey::find_program_address(&[REGISTRY_SEED], &deal_core::id());
    let deal_id = 1u64;
    let (deal, _) = Pubkey::find_program_address(
        &[DEAL_SEED, deal_id.to_le_bytes().as_ref()],
        &deal_core::id(),
    );
    let (terms, _) =
        Pubkey::find_program_address(&[TERMS_SEED, deal.as_ref()], &deal_asset_controller::id());

    let dc_mint = Pubkey::new_unique();
    let a_mint = Pubkey::new_unique();
    let b_mint = Pubkey::new_unique();
    set_mint(&mut svm, dc_mint, creator.pubkey(), 0, 6);
    set_mint(&mut svm, a_mint, creator.pubkey(), A_AMOUNT, 6);
    set_mint(&mut svm, b_mint, creator.pubkey(), B_AMOUNT, 6);

    let a_source = Pubkey::new_unique();
    let a_vault = Pubkey::new_unique();
    let a_user = Pubkey::new_unique();
    let a_fee = Pubkey::new_unique();
    let b_source = Pubkey::new_unique();
    let b_vault = Pubkey::new_unique();
    let b_user = Pubkey::new_unique();
    let b_fee = Pubkey::new_unique();
    set_token_account(&mut svm, a_source, a_mint, creator.pubkey(), A_AMOUNT);
    set_token_account(&mut svm, a_vault, a_mint, config, 0);
    set_token_account(&mut svm, a_user, a_mint, participant.pubkey(), 0);
    set_token_account(&mut svm, a_fee, a_mint, treasury.pubkey(), 0);
    set_token_account(&mut svm, b_source, b_mint, participant.pubkey(), B_AMOUNT);
    set_token_account(&mut svm, b_vault, b_mint, config, 0);
    set_token_account(&mut svm, b_user, b_mint, creator.pubkey(), 0);
    set_token_account(&mut svm, b_fee, b_mint, treasury.pubkey(), 0);

    let initialize_controller = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::InitializeController {
            treasury: treasury.pubkey(),
            dc_mint,
            fee_numerator: 3,
            fee_denominator: 1_000,
        }
        .data(),
        deal_asset_controller::accounts::InitializeController {
            authority: creator.pubkey(),
            config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[initialize_controller], &[]));

    let initialize_registry = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::InitializeRegistry {
            asset_controller: config,
            identity_controller: Pubkey::new_unique(),
        }
        .data(),
        deal_core::accounts::InitializeRegistry {
            authority: creator.pubkey(),
            registry,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[initialize_registry], &[]));

    let unpause_controller = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::SetPaused { paused: false }.data(),
        deal_asset_controller::accounts::AdminConfig {
            authority: creator.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    let unpause_core = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::SetPaused { paused: false }.data(),
        deal_core::accounts::AdminConfig {
            authority: creator.pubkey(),
            registry,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &creator,
        &[unpause_controller, unpause_core],
        &[],
    ));

    let create = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::CreateDeal {
            deal_id,
            params: CreateDealParams {
                template_type: TemplateType::TokenToToken,
                open_token_token_fast: false,
                join_mode: JoinMode::Open,
                expected_participant: Pubkey::default(),
                a_swap_amount: A_AMOUNT,
                a_margin_amount: 0,
                b_swap_amount: B_AMOUNT,
                b_margin_amount: 0,
                a_has_asset_nft: false,
                b_has_asset_nft: false,
                title: "SPL settlement".into(),
                description: "runtime custody and exact fee check".into(),
                timeout_seconds: 3600,
                replace_timeout_seconds: 120,
                is_domain_deal: false,
                domain_name: String::new(),
            },
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
    let join = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::JoinDeal {}.data(),
        deal_core::accounts::JoinDeal {
            participant: participant.pubkey(),
            deal,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[create], &[]));
    assert!(send(&mut svm, &creator, &[join], &[&participant]));

    let configure = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::ConfigureTerms {
            params: ConfigureTermsParams {
                a_swap: spl(a_mint, a_vault),
                a_margin: AssetSpec::none(),
                b_swap: spl(b_mint, b_vault),
                b_margin: AssetSpec::none(),
                a_asset_nft: AssetSpec::none(),
                b_asset_nft: AssetSpec::none(),
            },
        }
        .data(),
        deal_asset_controller::accounts::ConfigureTerms {
            creator: creator.pubkey(),
            config,
            deal,
            terms,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[configure], &[]));

    let deposit_a = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::DepositFunds { is_party_a: true }.data(),
        deal_asset_controller::accounts::DepositFunds {
            actor: creator.pubkey(),
            config,
            terms,
            core_registry: registry,
            deal,
            swap_source: a_source,
            swap_vault: a_vault,
            swap_mint: a_mint,
            margin_source: creator.pubkey(),
            margin_vault: creator.pubkey(),
            margin_mint: creator.pubkey(),
            token_program: spl_token_interface::ID,
            core_program: deal_core::id(),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let deposit_b = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::DepositFunds { is_party_a: false }.data(),
        deal_asset_controller::accounts::DepositFunds {
            actor: participant.pubkey(),
            config,
            terms,
            core_registry: registry,
            deal,
            swap_source: b_source,
            swap_vault: b_vault,
            swap_mint: b_mint,
            margin_source: participant.pubkey(),
            margin_vault: participant.pubkey(),
            margin_mint: participant.pubkey(),
            token_program: spl_token_interface::ID,
            core_program: deal_core::id(),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[deposit_a], &[]));
    assert!(send(&mut svm, &creator, &[deposit_b], &[&participant]));
    assert_eq!(token_balance(&svm, a_vault), A_AMOUNT);
    assert_eq!(token_balance(&svm, b_vault), B_AMOUNT);
    assert_eq!(
        deserialize::<DealAccount>(&svm, &deal).status,
        DealStatus::Locked
    );

    let vote_a = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::CastVoteAndResolve { vote: Vote::Accept }.data(),
        resolve_accounts(
            creator.pubkey(),
            config,
            terms,
            registry,
            deal,
            creator.pubkey(),
            participant.pubkey(),
            a_vault,
            a_mint,
            a_user,
            a_fee,
            b_vault,
            b_mint,
            b_user,
            b_fee,
            participant.pubkey(),
            participant.pubkey(),
            creator.pubkey(),
        )
        .to_account_metas(None),
    );
    let vote_b = Instruction::new_with_bytes(
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
            a_vault,
            a_mint,
            a_user,
            a_fee,
            b_vault,
            b_mint,
            b_user,
            b_fee,
            participant.pubkey(),
            participant.pubkey(),
            creator.pubkey(),
        )
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[vote_a], &[]));
    let enable_guard = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::SetTerminalGuard { enabled: true }.data(),
        deal_asset_controller::accounts::AdminConfig {
            authority: creator.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[enable_guard], &[]));
    assert!(!send(
        &mut svm,
        &creator,
        std::slice::from_ref(&vote_b),
        &[&participant],
    ));
    assert_eq!(
        deserialize::<DealAccount>(&svm, &deal).status,
        DealStatus::Locked
    );
    assert!(!deserialize::<AssetTerms>(&svm, &terms).resolved);
    assert_eq!(token_balance(&svm, a_vault), A_AMOUNT);
    assert_eq!(token_balance(&svm, b_vault), B_AMOUNT);
    let disable_guard = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::SetTerminalGuard { enabled: false }.data(),
        deal_asset_controller::accounts::AdminConfig {
            authority: creator.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[disable_guard], &[]));
    assert!(send(&mut svm, &creator, &[vote_b], &[&participant]));

    assert_eq!(
        deserialize::<DealAccount>(&svm, &deal).status,
        DealStatus::Completed
    );
    let settled_terms = deserialize::<AssetTerms>(&svm, &terms);
    assert!(settled_terms.resolved);
    assert_eq!(settled_terms.a_fee_paid, 30);
    assert_eq!(settled_terms.b_fee_paid, 60);
    assert_eq!(token_balance(&svm, a_vault), 0);
    assert_eq!(token_balance(&svm, b_vault), 0);
    assert_eq!(token_balance(&svm, a_user), 9_970);
    assert_eq!(token_balance(&svm, a_fee), 30);
    assert_eq!(token_balance(&svm, b_user), 19_940);
    assert_eq!(token_balance(&svm, b_fee), 60);

    let native_a_amount = 1_000_000;
    let native_b_amount = 2_000_000;
    let deal_id = 2u64;
    let (native_deal, _) = Pubkey::find_program_address(
        &[DEAL_SEED, deal_id.to_le_bytes().as_ref()],
        &deal_core::id(),
    );
    let (native_terms, _) = Pubkey::find_program_address(
        &[TERMS_SEED, native_deal.as_ref()],
        &deal_asset_controller::id(),
    );
    let create_native = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::CreateDeal {
            deal_id,
            params: CreateDealParams {
                template_type: TemplateType::TokenToToken,
                open_token_token_fast: true,
                join_mode: JoinMode::Open,
                expected_participant: Pubkey::default(),
                a_swap_amount: native_a_amount,
                a_margin_amount: 0,
                b_swap_amount: native_b_amount,
                b_margin_amount: 0,
                a_has_asset_nft: false,
                b_has_asset_nft: false,
                title: "native rejection".into(),
                description: "B refund keeps A escrowed".into(),
                timeout_seconds: 3600,
                replace_timeout_seconds: 120,
                is_domain_deal: false,
                domain_name: String::new(),
            },
        }
        .data(),
        deal_core::accounts::CreateDeal {
            creator: creator.pubkey(),
            registry,
            deal: native_deal,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let join_native = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::JoinDeal {}.data(),
        deal_core::accounts::JoinDeal {
            participant: participant.pubkey(),
            deal: native_deal,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[create_native], &[]));
    assert!(send(&mut svm, &creator, &[join_native], &[&participant],));

    let configure_native = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::ConfigureTerms {
            params: ConfigureTermsParams {
                a_swap: native(),
                a_margin: AssetSpec::none(),
                b_swap: native(),
                b_margin: AssetSpec::none(),
                a_asset_nft: AssetSpec::none(),
                b_asset_nft: AssetSpec::none(),
            },
        }
        .data(),
        deal_asset_controller::accounts::ConfigureTerms {
            creator: creator.pubkey(),
            config,
            deal: native_deal,
            terms: native_terms,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[configure_native], &[]));
    let native_terms_rent = svm.get_balance(&native_terms).unwrap();

    let native_deposit_a = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::DepositFunds { is_party_a: true }.data(),
        deal_asset_controller::accounts::DepositFunds {
            actor: creator.pubkey(),
            config,
            terms: native_terms,
            core_registry: registry,
            deal: native_deal,
            swap_source: creator.pubkey(),
            swap_vault: creator.pubkey(),
            swap_mint: creator.pubkey(),
            margin_source: creator.pubkey(),
            margin_vault: creator.pubkey(),
            margin_mint: creator.pubkey(),
            token_program: spl_token_interface::ID,
            core_program: deal_core::id(),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let native_deposit_b = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::DepositFunds { is_party_a: false }.data(),
        deal_asset_controller::accounts::DepositFunds {
            actor: participant.pubkey(),
            config,
            terms: native_terms,
            core_registry: registry,
            deal: native_deal,
            swap_source: participant.pubkey(),
            swap_vault: participant.pubkey(),
            swap_mint: participant.pubkey(),
            margin_source: participant.pubkey(),
            margin_vault: participant.pubkey(),
            margin_mint: participant.pubkey(),
            token_program: spl_token_interface::ID,
            core_program: deal_core::id(),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let participant_before_native = svm.get_balance(&participant.pubkey()).unwrap();
    assert!(send(&mut svm, &creator, &[native_deposit_a], &[]));
    assert!(send(
        &mut svm,
        &creator,
        &[native_deposit_b],
        &[&participant],
    ));
    assert_eq!(
        svm.get_balance(&native_terms).unwrap(),
        native_terms_rent + native_a_amount + native_b_amount
    );
    assert_eq!(
        svm.get_balance(&participant.pubkey()).unwrap(),
        participant_before_native - native_b_amount
    );

    let reject_b = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::CastVoteAndResolve { vote: Vote::Reject }.data(),
        resolve_accounts(
            participant.pubkey(),
            config,
            native_terms,
            registry,
            native_deal,
            creator.pubkey(),
            participant.pubkey(),
            creator.pubkey(),
            creator.pubkey(),
            participant.pubkey(),
            treasury.pubkey(),
            participant.pubkey(),
            participant.pubkey(),
            participant.pubkey(),
            treasury.pubkey(),
            participant.pubkey(),
            participant.pubkey(),
            creator.pubkey(),
        )
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[reject_b], &[&participant],));

    let reopened = deserialize::<DealAccount>(&svm, &native_deal);
    let native_state = deserialize::<AssetTerms>(&svm, &native_terms);
    assert_eq!(reopened.status, DealStatus::Ready);
    assert_eq!(reopened.participant, Pubkey::default());
    assert!(reopened.a_funds_deposited);
    assert!(!reopened.b_funds_deposited);
    assert!(native_state.a_funds_escrowed);
    assert!(!native_state.b_funds_escrowed);
    assert!(!native_state.resolved);
    assert_eq!(
        svm.get_balance(&native_terms).unwrap(),
        native_terms_rent + native_a_amount
    );
    assert_eq!(
        svm.get_balance(&participant.pubkey()).unwrap(),
        participant_before_native
    );

    let nft_trade_amount = 1_000;
    let deal_id = 3u64;
    let (nft_deal, _) = Pubkey::find_program_address(
        &[DEAL_SEED, deal_id.to_le_bytes().as_ref()],
        &deal_core::id(),
    );
    let (nft_terms, _) = Pubkey::find_program_address(
        &[TERMS_SEED, nft_deal.as_ref()],
        &deal_asset_controller::id(),
    );
    let payment_mint = Pubkey::new_unique();
    let nft_mint = Pubkey::new_unique();
    let payment_source = Pubkey::new_unique();
    let payment_vault = Pubkey::new_unique();
    let payment_user = Pubkey::new_unique();
    let payment_fee = Pubkey::new_unique();
    let nft_source = Pubkey::new_unique();
    let nft_vault = Pubkey::new_unique();
    let nft_user = Pubkey::new_unique();
    set_mint(
        &mut svm,
        payment_mint,
        creator.pubkey(),
        nft_trade_amount,
        6,
    );
    set_mint(&mut svm, nft_mint, participant.pubkey(), 2, 0);
    set_token_account(
        &mut svm,
        payment_source,
        payment_mint,
        creator.pubkey(),
        nft_trade_amount,
    );
    set_token_account(&mut svm, payment_vault, payment_mint, config, 0);
    set_token_account(
        &mut svm,
        payment_user,
        payment_mint,
        participant.pubkey(),
        0,
    );
    set_token_account(&mut svm, payment_fee, payment_mint, treasury.pubkey(), 0);
    set_token_account(&mut svm, nft_source, nft_mint, participant.pubkey(), 1);
    set_token_account(&mut svm, nft_vault, nft_mint, config, 0);
    set_token_account(&mut svm, nft_user, nft_mint, creator.pubkey(), 0);

    let create_nft = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::CreateDeal {
            deal_id,
            params: CreateDealParams {
                template_type: TemplateType::TokenToNft,
                open_token_token_fast: false,
                join_mode: JoinMode::Open,
                expected_participant: Pubkey::default(),
                a_swap_amount: nft_trade_amount,
                a_margin_amount: 0,
                b_swap_amount: 0,
                b_margin_amount: 0,
                a_has_asset_nft: false,
                b_has_asset_nft: true,
                title: "token for NFT".into(),
                description: "supply-one validation and atomic exchange".into(),
                timeout_seconds: 3600,
                replace_timeout_seconds: 120,
                is_domain_deal: false,
                domain_name: String::new(),
            },
        }
        .data(),
        deal_core::accounts::CreateDeal {
            creator: creator.pubkey(),
            registry,
            deal: nft_deal,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let join_nft = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::JoinDeal {}.data(),
        deal_core::accounts::JoinDeal {
            participant: participant.pubkey(),
            deal: nft_deal,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[create_nft], &[]));
    assert!(send(&mut svm, &creator, &[join_nft], &[&participant]));

    let configure_nft = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::ConfigureTerms {
            params: ConfigureTermsParams {
                a_swap: spl(payment_mint, payment_vault),
                a_margin: AssetSpec::none(),
                b_swap: AssetSpec::none(),
                b_margin: AssetSpec::none(),
                a_asset_nft: AssetSpec::none(),
                b_asset_nft: spl(nft_mint, nft_vault),
            },
        }
        .data(),
        deal_asset_controller::accounts::ConfigureTerms {
            creator: creator.pubkey(),
            config,
            deal: nft_deal,
            terms: nft_terms,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[configure_nft], &[]));

    let deposit_payment = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::DepositFunds { is_party_a: true }.data(),
        deal_asset_controller::accounts::DepositFunds {
            actor: creator.pubkey(),
            config,
            terms: nft_terms,
            core_registry: registry,
            deal: nft_deal,
            swap_source: payment_source,
            swap_vault: payment_vault,
            swap_mint: payment_mint,
            margin_source: creator.pubkey(),
            margin_vault: creator.pubkey(),
            margin_mint: creator.pubkey(),
            token_program: spl_token_interface::ID,
            core_program: deal_core::id(),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let deposit_nft = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::DepositAssetNft { is_party_a: false }.data(),
        deal_asset_controller::accounts::DepositNft {
            actor: participant.pubkey(),
            config,
            terms: nft_terms,
            core_registry: registry,
            deal: nft_deal,
            source: nft_source,
            vault: nft_vault,
            mint: nft_mint,
            token_program: spl_token_interface::ID,
            core_program: deal_core::id(),
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[deposit_payment], &[]));
    assert!(!send(
        &mut svm,
        &creator,
        std::slice::from_ref(&deposit_nft),
        &[&participant],
    ));
    assert_eq!(token_balance(&svm, nft_source), 1);
    assert!(!deserialize::<DealAccount>(&svm, &nft_deal).b_asset_deposited);
    set_mint(&mut svm, nft_mint, participant.pubkey(), 1, 0);
    assert!(send(&mut svm, &creator, &[deposit_nft], &[&participant],));
    assert_eq!(
        deserialize::<DealAccount>(&svm, &nft_deal).status,
        DealStatus::Locked
    );

    let vote_nft_a = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::CastVoteAndResolve { vote: Vote::Accept }.data(),
        resolve_accounts(
            creator.pubkey(),
            config,
            nft_terms,
            registry,
            nft_deal,
            creator.pubkey(),
            participant.pubkey(),
            payment_vault,
            payment_mint,
            payment_user,
            payment_fee,
            participant.pubkey(),
            participant.pubkey(),
            creator.pubkey(),
            treasury.pubkey(),
            nft_vault,
            nft_mint,
            nft_user,
        )
        .to_account_metas(None),
    );
    let vote_nft_b = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::CastVoteAndResolve { vote: Vote::Accept }.data(),
        resolve_accounts(
            participant.pubkey(),
            config,
            nft_terms,
            registry,
            nft_deal,
            creator.pubkey(),
            participant.pubkey(),
            payment_vault,
            payment_mint,
            payment_user,
            payment_fee,
            participant.pubkey(),
            participant.pubkey(),
            creator.pubkey(),
            treasury.pubkey(),
            nft_vault,
            nft_mint,
            nft_user,
        )
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[vote_nft_a], &[]));
    assert!(send(&mut svm, &creator, &[vote_nft_b], &[&participant],));
    assert_eq!(
        deserialize::<DealAccount>(&svm, &nft_deal).status,
        DealStatus::Completed
    );
    assert_eq!(token_balance(&svm, payment_user), 997);
    assert_eq!(token_balance(&svm, payment_fee), 3);
    assert_eq!(token_balance(&svm, nft_source), 0);
    assert_eq!(token_balance(&svm, nft_vault), 0);
    assert_eq!(token_balance(&svm, nft_user), 1);
}
