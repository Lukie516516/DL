use anchor_lang::{
    prelude::{AccountDeserialize, AccountSerialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_asset_controller::{
    state::{AssetKind, AssetSpec, AssetTerms, ConfigureTermsParams, ControllerConfig},
    CONTROLLER_SEED, TERMS_SEED,
};
use deal_core::{
    constants::{DEAL_SEED, REGISTRY_SEED},
    state::{DealAccount, DealRegistry, DealStatus, JoinMode, TemplateType},
};
use deal_domain_entry::{
    DomainCreateParams, DomainDealBinding, DomainEntryConfig, BINDING_SEED, CONFIG_SEED,
};
use deal_domain_rank::{
    DealAdEntry, DomainStats, RankConfig, ReporterGrant, ENTRY_SEED as RANK_ENTRY_SEED,
    REPORTER_SEED, STATS_SEED,
};
use deal_domain_registry::DomainRecord;
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
) {
    let blockhash = svm.latest_blockhash();
    let message = Message::new_with_blockhash(instructions, Some(&payer.pubkey()), &blockhash);
    let mut signers = vec![payer];
    signers.extend_from_slice(additional_signers);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &signers).unwrap();
    if let Err(error) = svm.send_transaction(tx) {
        panic!("transaction failed: {error:?}");
    }
    svm.expire_blockhash();
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

fn deserialize<T: AccountDeserialize>(svm: &LiteSVM, address: Pubkey) -> T {
    let account = svm.get_account(&address).expect("account must exist");
    T::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn spl(mint: Pubkey, vault: Pubkey) -> AssetSpec {
    AssetSpec {
        kind: AssetKind::Spl,
        mint,
        vault,
    }
}

fn token_terms(
    a_mint: Pubkey,
    a_vault: Pubkey,
    b_mint: Option<Pubkey>,
    b_vault: Option<Pubkey>,
) -> ConfigureTermsParams {
    ConfigureTermsParams {
        a_swap: spl(a_mint, a_vault),
        a_margin: AssetSpec::none(),
        b_swap: match (b_mint, b_vault) {
            (Some(mint), Some(vault)) => spl(mint, vault),
            _ => AssetSpec::none(),
        },
        b_margin: AssetSpec::none(),
        a_asset_nft: AssetSpec::none(),
        b_asset_nft: AssetSpec::none(),
    }
}

#[allow(clippy::too_many_arguments)]
fn create_accounts(
    creator: Pubkey,
    domain: Pubkey,
    blacklist: Pubkey,
    config: Pubkey,
    core_registry: Pubkey,
    deal: Pubkey,
    asset_config: Pubkey,
    asset_terms: Pubkey,
    rank_config: Pubkey,
    reporter_grant: Pubkey,
    rank_stats: Pubkey,
    rank_entry: Pubkey,
    binding: Pubkey,
) -> deal_domain_entry::accounts::CreateDomainDeal {
    deal_domain_entry::accounts::CreateDomainDeal {
        config,
        creator,
        domain,
        blacklist,
        core_program: deal_core::id(),
        core_registry,
        deal,
        asset_program: deal_asset_controller::id(),
        asset_config,
        asset_terms,
        rank_program: deal_domain_rank::id(),
        rank_config,
        rank_reporter_grant: reporter_grant,
        rank_stats,
        rank_entry,
        binding,
        system_program: anchor_lang::system_program::ID,
    }
}

#[test]
fn creates_direct_and_deferred_domain_deals_atomically() {
    let mut svm = LiteSVM::new();
    for (program, binary) in [
        (
            deal_core::id(),
            include_bytes!("../../../target/deploy/deal_compact_lifecycle.so").as_slice(),
        ),
        (
            deal_asset_controller::id(),
            include_bytes!("../../../target/deploy/deal_compact_lifecycle.so").as_slice(),
        ),
        (
            deal_domain_rank::id(),
            include_bytes!("../../../target/deploy/deal_compact_domain_network.so").as_slice(),
        ),
        (
            deal_domain_entry::id(),
            include_bytes!("../../../target/deploy/deal_compact_domain_network.so").as_slice(),
        ),
    ] {
        svm.add_program(program, binary).unwrap();
    }
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: 1_000_000,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 1_000_000,
    });

    let authority = Keypair::new();
    let creator = Keypair::new();
    let direct_counterparty = Keypair::new();
    let picked_counterparty = Keypair::new();
    for wallet in [
        &authority,
        &creator,
        &direct_counterparty,
        &picked_counterparty,
    ] {
        svm.airdrop(&wallet.pubkey(), 50_000_000_000).unwrap();
    }

    let (core_registry, core_bump) =
        Pubkey::find_program_address(&[REGISTRY_SEED], &deal_core::id());
    let (asset_config, asset_bump) =
        Pubkey::find_program_address(&[CONTROLLER_SEED], &deal_asset_controller::id());
    let (rank_config, rank_bump) =
        Pubkey::find_program_address(&[deal_domain_rank::CONFIG_SEED], &deal_domain_rank::id());
    let (entry_config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_domain_entry::id());

    let dc_mint = Pubkey::new_unique();
    set_anchor_account(
        &mut svm,
        core_registry,
        deal_core::id(),
        &DealRegistry {
            authority: authority.pubkey(),
            pending_authority: Pubkey::default(),
            asset_controller: asset_config,
            identity_controller: Pubkey::new_unique(),
            domain_entry_controller: entry_config,
            next_deal_id: 1,
            min_timeout_seconds: 3_600,
            paused: false,
            bump: core_bump,
        },
    );
    set_anchor_account(
        &mut svm,
        asset_config,
        deal_asset_controller::id(),
        &ControllerConfig {
            authority: authority.pubkey(),
            pending_authority: Pubkey::default(),
            treasury: Pubkey::new_unique(),
            dc_mint,
            fee_numerator: 3,
            fee_denominator: 1_000,
            terminal_guard_enabled: false,
            paused: false,
            bump: asset_bump,
        },
    );
    set_anchor_account(
        &mut svm,
        rank_config,
        deal_domain_rank::id(),
        &RankConfig {
            authority: authority.pubkey(),
            pending_authority: Pubkey::default(),
            domain_registry_program: deal_domain_registry::id(),
            domain_registry_config: Pubkey::new_unique(),
            dc_mint,
            treasury: Pubkey::new_unique(),
            auto_closer: Pubkey::default(),
            min_deposit: 1,
            kick_inactivity_seconds: 0,
            protocol_fee_bps: 1_000,
            paused: false,
            bump: rank_bump,
            top_domains: Vec::new(),
            top_volumes: Vec::new(),
        },
    );
    let (reporter_grant, reporter_bump) = Pubkey::find_program_address(
        &[REPORTER_SEED, entry_config.as_ref()],
        &deal_domain_rank::id(),
    );
    set_anchor_account(
        &mut svm,
        reporter_grant,
        deal_domain_rank::id(),
        &ReporterGrant {
            reporter: entry_config,
            allowed: true,
            bump: reporter_bump,
        },
    );

    let domain = Pubkey::new_unique();
    let domain_label = "Domain01";
    set_anchor_account(
        &mut svm,
        domain,
        deal_domain_registry::id(),
        &DomainRecord {
            id: 1,
            label: domain_label.to_string(),
            mint: Pubkey::new_unique(),
            owner: creator.pubkey(),
            creator: creator.pubkey(),
            resolve: creator.pubkey(),
            description: String::new(),
            background_uri: String::new(),
            escrow_market: Pubkey::default(),
            bump: 1,
            mint_bump: 2,
        },
    );

    let initialize = Instruction::new_with_bytes(
        deal_domain_entry::id(),
        &deal_domain_entry::instruction::Initialize {
            core_program: deal_core::id(),
            core_registry,
            asset_program: deal_asset_controller::id(),
            asset_config,
            rank_program: deal_domain_rank::id(),
            rank_config,
            default_timeout_seconds: 3_600,
            default_replace_timeout_seconds: 120,
        }
        .data(),
        deal_domain_entry::accounts::Initialize {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            config: entry_config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let unpause = Instruction::new_with_bytes(
        deal_domain_entry::id(),
        &deal_domain_entry::instruction::SetPaused { paused: false }.data(),
        deal_domain_entry::accounts::AdminConfig {
            authority: authority.pubkey(),
            config: entry_config,
        }
        .to_account_metas(None),
    );
    send(&mut svm, &authority, &[initialize, unpause], &[]);

    let deal_one_id = 1u64;
    let (deal_one, _) =
        Pubkey::find_program_address(&[DEAL_SEED, &deal_one_id.to_le_bytes()], &deal_core::id());
    let (terms_one, _) = Pubkey::find_program_address(
        &[TERMS_SEED, deal_one.as_ref()],
        &deal_asset_controller::id(),
    );
    let (rank_stats, _) =
        Pubkey::find_program_address(&[STATS_SEED, domain.as_ref()], &deal_domain_rank::id());
    let (creator_blacklist, _) = Pubkey::find_program_address(
        &[
            deal_domain_rank::BLACKLIST_SEED,
            domain.as_ref(),
            creator.pubkey().as_ref(),
        ],
        &deal_domain_rank::id(),
    );
    let (rank_entry_one, _) = Pubkey::find_program_address(
        &[RANK_ENTRY_SEED, domain.as_ref(), deal_one.as_ref()],
        &deal_domain_rank::id(),
    );
    let (binding_one, _) =
        Pubkey::find_program_address(&[BINDING_SEED, deal_one.as_ref()], &deal_domain_entry::id());
    let a_mint = Pubkey::new_unique();
    let b_mint = Pubkey::new_unique();
    let a_vault = Pubkey::new_unique();
    let b_vault = Pubkey::new_unique();
    let direct_params = DomainCreateParams {
        deal_id: deal_one_id,
        template_type: TemplateType::TokenToToken,
        expected_participant: direct_counterparty.pubkey(),
        require_identity: false,
        deferred_hall: false,
        a_swap_amount: 1_000,
        a_margin_amount: 0,
        b_swap_amount: 2_000,
        b_margin_amount: 0,
        title: "direct domain deal".to_string(),
        description: "atomic direct entry".to_string(),
        timeout_seconds: 0,
        replace_timeout_seconds: 0,
        asset_terms: token_terms(a_mint, a_vault, Some(b_mint), Some(b_vault)),
    };
    let create_direct = Instruction::new_with_bytes(
        deal_domain_entry::id(),
        &deal_domain_entry::instruction::CreateDomainDeal {
            params: direct_params,
        }
        .data(),
        create_accounts(
            creator.pubkey(),
            domain,
            creator_blacklist,
            entry_config,
            core_registry,
            deal_one,
            asset_config,
            terms_one,
            rank_config,
            reporter_grant,
            rank_stats,
            rank_entry_one,
            binding_one,
        )
        .to_account_metas(None),
    );
    send(&mut svm, &creator, &[create_direct], &[]);

    let deal: DealAccount = deserialize(&svm, deal_one);
    assert_eq!(deal.id, 1);
    assert_eq!(deal.status, DealStatus::Ready);
    assert_eq!(deal.join_mode, JoinMode::ExactAddress);
    assert_eq!(deal.expected_participant, direct_counterparty.pubkey());
    assert_eq!(deal.domain_name, domain_label);
    assert_eq!(deal.timeout_seconds, 3_600);
    assert_eq!(deal.replace_timeout_seconds, 120);
    let terms: AssetTerms = deserialize(&svm, terms_one);
    assert_eq!(terms.a_swap, spl(a_mint, a_vault));
    assert_eq!(terms.b_swap, spl(b_mint, b_vault));
    let stats: DomainStats = deserialize(&svm, rank_stats);
    assert_eq!(stats.deal_count, 1);
    assert_eq!(stats.trade_volume, 0);
    let entry: DealAdEntry = deserialize(&svm, rank_entry_one);
    assert!(entry.initialized);
    assert_eq!(entry.reported_volume, 3_000);
    let binding: DomainDealBinding = deserialize(&svm, binding_one);
    assert!(!binding.deferred_hall);
    assert_eq!(binding.deal, deal_one);

    let deal_two_id = 2u64;
    let (deal_two, _) =
        Pubkey::find_program_address(&[DEAL_SEED, &deal_two_id.to_le_bytes()], &deal_core::id());
    let (terms_two, _) = Pubkey::find_program_address(
        &[TERMS_SEED, deal_two.as_ref()],
        &deal_asset_controller::id(),
    );
    let (rank_entry_two, _) = Pubkey::find_program_address(
        &[RANK_ENTRY_SEED, domain.as_ref(), deal_two.as_ref()],
        &deal_domain_rank::id(),
    );
    let (binding_two, _) =
        Pubkey::find_program_address(&[BINDING_SEED, deal_two.as_ref()], &deal_domain_entry::id());
    let deferred_params = DomainCreateParams {
        deal_id: deal_two_id,
        template_type: TemplateType::TokenToEmpty,
        expected_participant: Pubkey::default(),
        require_identity: true,
        deferred_hall: true,
        a_swap_amount: 750,
        a_margin_amount: 0,
        b_swap_amount: 0,
        b_margin_amount: 0,
        title: "hall deal".to_string(),
        description: "pick counterparty later".to_string(),
        timeout_seconds: 3_600,
        replace_timeout_seconds: 180,
        asset_terms: token_terms(a_mint, Pubkey::new_unique(), None, None),
    };
    let create_deferred = Instruction::new_with_bytes(
        deal_domain_entry::id(),
        &deal_domain_entry::instruction::CreateDomainDeal {
            params: deferred_params,
        }
        .data(),
        create_accounts(
            creator.pubkey(),
            domain,
            creator_blacklist,
            entry_config,
            core_registry,
            deal_two,
            asset_config,
            terms_two,
            rank_config,
            reporter_grant,
            rank_stats,
            rank_entry_two,
            binding_two,
        )
        .to_account_metas(None),
    );
    send(&mut svm, &creator, &[create_deferred], &[]);

    let deferred: DealAccount = deserialize(&svm, deal_two);
    assert_eq!(deferred.join_mode, JoinMode::NftGated);
    assert_eq!(deferred.expected_participant, Pubkey::default());
    let deferred_binding: DomainDealBinding = deserialize(&svm, binding_two);
    assert!(deferred_binding.deferred_hall);
    assert!(deferred_binding.require_identity);

    let confirm = Instruction::new_with_bytes(
        deal_domain_entry::id(),
        &deal_domain_entry::instruction::ConfirmHallCounterparty {
            picked_counterparty: picked_counterparty.pubkey(),
        }
        .data(),
        deal_domain_entry::accounts::ConfirmHallCounterparty {
            config: entry_config,
            creator: creator.pubkey(),
            domain,
            picked_blacklist: Pubkey::find_program_address(
                &[
                    deal_domain_rank::BLACKLIST_SEED,
                    domain.as_ref(),
                    picked_counterparty.pubkey().as_ref(),
                ],
                &deal_domain_rank::id(),
            )
            .0,
            core_program: deal_core::id(),
            deal: deal_two,
            binding: binding_two,
        }
        .to_account_metas(None),
    );
    send(&mut svm, &creator, &[confirm], &[]);

    let selected: DealAccount = deserialize(&svm, deal_two);
    assert_eq!(selected.join_mode, JoinMode::ExactAddressAndNftGated);
    assert_eq!(selected.expected_participant, picked_counterparty.pubkey());
    let selected_binding: DomainDealBinding = deserialize(&svm, binding_two);
    assert!(!selected_binding.deferred_hall);
    assert_eq!(
        selected_binding.picked_counterparty,
        picked_counterparty.pubkey()
    );
    let final_stats: DomainStats = deserialize(&svm, rank_stats);
    assert_eq!(final_stats.deal_count, 2);
    assert_eq!(final_stats.trade_volume, 0);
    let registry: DealRegistry = deserialize(&svm, core_registry);
    assert_eq!(registry.next_deal_id, 3);
    let config: DomainEntryConfig = deserialize(&svm, entry_config);
    assert!(!config.paused);
}
