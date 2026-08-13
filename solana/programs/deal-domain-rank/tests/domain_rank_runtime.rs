use anchor_lang::{
    prelude::{AccountDeserialize, AccountSerialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use anchor_spl::associated_token::get_associated_token_address;
use deal_core::state::{CompletionReason, DealAccount, DealStatus, JoinMode, TemplateType, Vote};
use deal_domain_rank::{
    BlacklistEntry, DealAdEntry, DomainStats, RankConfig, BLACKLIST_SEED, CONFIG_SEED, ENTRY_SEED,
    REPORTER_SEED, STATS_SEED,
};
use deal_domain_registry::DomainRecord;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use spl_token_interface::state::{Account as TokenAccount, AccountState, Mint};

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

fn set_mint(svm: &mut LiteSVM, mint: Pubkey, authority: Pubkey, amount: u64) {
    let state = Mint {
        mint_authority: COption::Some(authority),
        supply: amount,
        decimals: 6,
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
            lamports: 10_000_000,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn token_state(svm: &LiteSVM, address: Pubkey) -> TokenAccount {
    let account = svm.get_account(&address).expect("token account must exist");
    TokenAccount::unpack(&account.data).unwrap()
}

fn deserialize<T: AccountDeserialize>(svm: &LiteSVM, address: Pubkey) -> T {
    let account = svm.get_account(&address).expect("account must exist");
    T::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn domain_record(owner: Pubkey, label: &str) -> DomainRecord {
    DomainRecord {
        id: 1,
        label: label.to_string(),
        mint: Pubkey::new_unique(),
        owner,
        creator: owner,
        resolve: owner,
        description: String::new(),
        background_uri: String::new(),
        escrow_market: Pubkey::default(),
        bump: 1,
        mint_bump: 2,
    }
}

fn deal_account(creator: Pubkey, label: &str, status: DealStatus, ended_at: i64) -> DealAccount {
    DealAccount {
        id: 1,
        creator,
        participant: Pubkey::new_unique(),
        expected_participant: Pubkey::default(),
        last_removed_participant: Pubkey::default(),
        template_type: TemplateType::TokenToToken,
        open_token_token_fast: false,
        join_mode: JoinMode::Open,
        status,
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
        is_domain_deal: true,
        a_swap_amount: 1_000,
        a_margin_amount: 0,
        b_swap_amount: 2_000,
        b_margin_amount: 0,
        timeout_seconds: 60,
        replace_timeout_seconds: 120,
        created_at: 900_000,
        ended_at,
        b_joined_at: 900_100,
        locked_at: 900_200,
        a_vote_at: 0,
        b_vote_at: 0,
        a_pre_accept_at: 0,
        title: "domain deal".to_string(),
        description: String::new(),
        domain_name: label.to_string(),
        bump: 1,
    }
}

#[test]
fn settles_completed_ads_refunds_canceled_ads_and_tracks_top_volume() {
    let mut svm = LiteSVM::new();
    svm.add_program(
        deal_domain_rank::id(),
        include_bytes!("../../../target/deploy/deal_domain_rank.so"),
    )
    .unwrap();

    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: 1_000_000,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 1_000_000,
    });

    let authority = Keypair::new();
    let merchant = Keypair::new();
    let reporter = Keypair::new();
    let caller = Keypair::new();
    let treasury = Keypair::new();
    for wallet in [&authority, &merchant, &reporter, &caller, &treasury] {
        svm.airdrop(&wallet.pubkey(), 30_000_000_000).unwrap();
    }

    let dc_mint = Pubkey::new_unique();
    let merchant_dc = Pubkey::new_unique();
    let treasury_dc = Pubkey::new_unique();
    set_mint(&mut svm, dc_mint, authority.pubkey(), 20_000);
    set_token_account(&mut svm, merchant_dc, dc_mint, merchant.pubkey(), 10_000);
    set_token_account(&mut svm, treasury_dc, dc_mint, treasury.pubkey(), 0);

    let domain = Pubkey::new_unique();
    let label = "Rank01";
    set_anchor_account(
        &mut svm,
        domain,
        deal_domain_registry::id(),
        &domain_record(merchant.pubkey(), label),
    );

    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_domain_rank::id());
    let vault = get_associated_token_address(&config, &dc_mint);
    let registry_config = Pubkey::new_unique();
    let initialize = Instruction::new_with_bytes(
        deal_domain_rank::id(),
        &deal_domain_rank::instruction::Initialize {
            domain_registry_program: deal_domain_registry::id(),
            domain_registry_config: registry_config,
            treasury: treasury.pubkey(),
            min_deposit: 100,
            protocol_fee_bps: 1_000,
        }
        .data(),
        deal_domain_rank::accounts::Initialize {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            config,
            dc_mint,
            vault,
            dc_token_program: spl_token_interface::ID,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[initialize], &[]));

    let unpause = Instruction::new_with_bytes(
        deal_domain_rank::id(),
        &deal_domain_rank::instruction::SetPaused { paused: false }.data(),
        deal_domain_rank::accounts::AdminConfig {
            authority: authority.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    let (reporter_grant, _) = Pubkey::find_program_address(
        &[REPORTER_SEED, reporter.pubkey().as_ref()],
        &deal_domain_rank::id(),
    );
    let set_reporter = Instruction::new_with_bytes(
        deal_domain_rank::id(),
        &deal_domain_rank::instruction::SetReporter { allowed: true }.data(),
        deal_domain_rank::accounts::SetReporter {
            authority: authority.pubkey(),
            config,
            reporter: reporter.pubkey(),
            reporter_grant,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[unpause, set_reporter], &[]));

    let (stats, _) =
        Pubkey::find_program_address(&[STATS_SEED, domain.as_ref()], &deal_domain_rank::id());
    let policy = Instruction::new_with_bytes(
        deal_domain_rank::id(),
        &deal_domain_rank::instruction::SetDomainPolicy {
            fixed_hourly_rate: 100,
            domain_min_deposit: 200,
        }
        .data(),
        deal_domain_rank::accounts::SetDomainPolicy {
            config,
            owner: merchant.pubkey(),
            domain,
            stats,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &merchant, &[policy], &[]));

    let completed_deal = Pubkey::new_unique();
    set_anchor_account(
        &mut svm,
        completed_deal,
        deal_core::id(),
        &deal_account(merchant.pubkey(), label, DealStatus::Active, 0),
    );
    let (completed_entry, _) = Pubkey::find_program_address(
        &[ENTRY_SEED, domain.as_ref(), completed_deal.as_ref()],
        &deal_domain_rank::id(),
    );
    let report = Instruction::new_with_bytes(
        deal_domain_rank::id(),
        &deal_domain_rank::instruction::ReportDeal {
            merchant: merchant.pubkey(),
            reported_volume: 5_000,
        }
        .data(),
        deal_domain_rank::accounts::ReportDeal {
            config,
            payer: authority.pubkey(),
            reporter: reporter.pubkey(),
            reporter_grant,
            domain,
            deal: completed_deal,
            stats,
            entry: completed_entry,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[report], &[&reporter]));

    let (merchant_blacklist, _) = Pubkey::find_program_address(
        &[BLACKLIST_SEED, domain.as_ref(), merchant.pubkey().as_ref()],
        &deal_domain_rank::id(),
    );
    let deposit = Instruction::new_with_bytes(
        deal_domain_rank::id(),
        &deal_domain_rank::instruction::Deposit { amount: 1_000 }.data(),
        deal_domain_rank::accounts::Deposit {
            config,
            merchant: merchant.pubkey(),
            domain,
            deal: completed_deal,
            stats,
            entry: completed_entry,
            blacklist: merchant_blacklist,
            merchant_dc,
            vault,
            dc_mint,
            dc_token_program: spl_token_interface::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &merchant, &[deposit], &[]));
    assert_eq!(token_state(&svm, merchant_dc).amount, 9_000);
    assert_eq!(token_state(&svm, vault).amount, 1_000);
    let blacklist: BlacklistEntry = deserialize(&svm, merchant_blacklist);
    assert!(!blacklist.banned);

    svm.set_sysvar(&Clock {
        slot: 2,
        epoch_start_timestamp: 1_000_000,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 1_007_200,
    });
    set_anchor_account(
        &mut svm,
        completed_deal,
        deal_core::id(),
        &deal_account(merchant.pubkey(), label, DealStatus::Completed, 1_007_200),
    );
    let close = Instruction::new_with_bytes(
        deal_domain_rank::id(),
        &deal_domain_rank::instruction::CloseDeal {}.data(),
        deal_domain_rank::accounts::CloseDeal {
            config,
            caller: caller.pubkey(),
            deal: completed_deal,
            stats,
            entry: completed_entry,
            merchant_dc,
            vault,
            dc_mint,
            dc_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &caller, &[close], &[]));

    let entry_state: DealAdEntry = deserialize(&svm, completed_entry);
    let stats_state: DomainStats = deserialize(&svm, stats);
    let config_state: RankConfig = deserialize(&svm, config);
    assert!(entry_state.closed);
    assert_eq!(entry_state.total_consumed, 200);
    assert_eq!(entry_state.deposited_dc, 0);
    assert_eq!(stats_state.holder_rewards_pending, 200);
    assert_eq!(stats_state.trade_volume, 5_000);
    assert_eq!(config_state.top_domains, vec![domain]);
    assert_eq!(config_state.top_volumes, vec![5_000]);
    assert_eq!(token_state(&svm, merchant_dc).amount, 9_800);
    assert_eq!(token_state(&svm, vault).amount, 200);

    let withdraw_rewards = Instruction::new_with_bytes(
        deal_domain_rank::id(),
        &deal_domain_rank::instruction::WithdrawHolderRewards {}.data(),
        deal_domain_rank::accounts::WithdrawHolderRewards {
            config,
            holder: merchant.pubkey(),
            domain,
            stats,
            holder_dc: merchant_dc,
            treasury_dc,
            vault,
            dc_mint,
            dc_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &merchant, &[withdraw_rewards], &[]));
    assert_eq!(token_state(&svm, merchant_dc).amount, 9_980);
    assert_eq!(token_state(&svm, treasury_dc).amount, 20);
    assert_eq!(token_state(&svm, vault).amount, 0);

    let canceled_deal = Pubkey::new_unique();
    set_anchor_account(
        &mut svm,
        canceled_deal,
        deal_core::id(),
        &deal_account(merchant.pubkey(), label, DealStatus::Active, 0),
    );
    let (canceled_entry, _) = Pubkey::find_program_address(
        &[ENTRY_SEED, domain.as_ref(), canceled_deal.as_ref()],
        &deal_domain_rank::id(),
    );
    let report_canceled = Instruction::new_with_bytes(
        deal_domain_rank::id(),
        &deal_domain_rank::instruction::ReportDeal {
            merchant: merchant.pubkey(),
            reported_volume: 9_000,
        }
        .data(),
        deal_domain_rank::accounts::ReportDeal {
            config,
            payer: authority.pubkey(),
            reporter: reporter.pubkey(),
            reporter_grant,
            domain,
            deal: canceled_deal,
            stats,
            entry: canceled_entry,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[report_canceled], &[&reporter]));
    let deposit_canceled = Instruction::new_with_bytes(
        deal_domain_rank::id(),
        &deal_domain_rank::instruction::Deposit { amount: 500 }.data(),
        deal_domain_rank::accounts::Deposit {
            config,
            merchant: merchant.pubkey(),
            domain,
            deal: canceled_deal,
            stats,
            entry: canceled_entry,
            blacklist: merchant_blacklist,
            merchant_dc,
            vault,
            dc_mint,
            dc_token_program: spl_token_interface::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &merchant, &[deposit_canceled], &[]));
    set_anchor_account(
        &mut svm,
        canceled_deal,
        deal_core::id(),
        &deal_account(merchant.pubkey(), label, DealStatus::Canceled, 1_007_300),
    );
    let close_canceled = Instruction::new_with_bytes(
        deal_domain_rank::id(),
        &deal_domain_rank::instruction::CloseDeal {}.data(),
        deal_domain_rank::accounts::CloseDeal {
            config,
            caller: caller.pubkey(),
            deal: canceled_deal,
            stats,
            entry: canceled_entry,
            merchant_dc,
            vault,
            dc_mint,
            dc_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &caller, &[close_canceled], &[]));
    let canceled_state: DealAdEntry = deserialize(&svm, canceled_entry);
    let stats_state: DomainStats = deserialize(&svm, stats);
    assert_eq!(canceled_state.total_consumed, 0);
    assert_eq!(stats_state.trade_volume, 5_000);
    assert_eq!(token_state(&svm, merchant_dc).amount, 9_980);
    assert_eq!(token_state(&svm, vault).amount, 0);
}
