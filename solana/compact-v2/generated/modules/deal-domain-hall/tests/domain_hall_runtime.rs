use anchor_lang::{
    prelude::{AccountDeserialize, AccountSerialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_core::state::{CompletionReason, DealAccount, DealStatus, JoinMode, TemplateType, Vote};
use deal_domain_entry::DomainDealBinding;
use deal_domain_hall::{
    DealThread, DirectThread, HallMessage, PickSignal, SignalThread, CONFIG_SEED, DEAL_THREAD_SEED,
    DIRECT_THREAD_SEED, MESSAGE_SEED, SIGNAL_SEED, SIGNAL_THREAD_SEED,
};
use deal_domain_rank::{BlacklistEntry, BLACKLIST_SEED};
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

fn set_mint(svm: &mut LiteSVM, mint: Pubkey, authority: Pubkey, supply: u64) {
    let state = Mint {
        mint_authority: COption::Some(authority),
        supply,
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

fn deserialize<T: AccountDeserialize>(svm: &LiteSVM, address: Pubkey) -> T {
    let account = svm.get_account(&address).expect("account must exist");
    T::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn token_state(svm: &LiteSVM, address: Pubkey) -> TokenAccount {
    let account = svm.get_account(&address).expect("token account must exist");
    TokenAccount::unpack(&account.data).unwrap()
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

fn deal_account(creator: Pubkey, label: &str) -> DealAccount {
    DealAccount {
        id: 1,
        creator,
        participant: Pubkey::default(),
        expected_participant: Pubkey::default(),
        last_removed_participant: Pubkey::default(),
        template_type: TemplateType::TokenToToken,
        open_token_token_fast: false,
        join_mode: JoinMode::Open,
        status: DealStatus::Ready,
        a_vote: Vote::Unset,
        b_vote: Vote::Unset,
        completion_reason: CompletionReason::None,
        a_funds_deposited: false,
        b_funds_deposited: false,
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
        timeout_seconds: 3_600,
        replace_timeout_seconds: 120,
        created_at: 1_000_000,
        ended_at: 0,
        b_joined_at: 0,
        locked_at: 0,
        a_vote_at: 0,
        b_vote_at: 0,
        a_pre_accept_at: 0,
        title: "hall deal".to_string(),
        description: String::new(),
        domain_name: label.to_string(),
        bump: 1,
    }
}

fn blacklist_pda(domain: Pubkey, user: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[BLACKLIST_SEED, domain.as_ref(), user.as_ref()],
        &deal_domain_rank::id(),
    )
    .0
}

#[test]
fn stores_queryable_messages_burns_dc_and_blocks_blacklisted_users() {
    let mut svm = LiteSVM::new();
    svm.add_program(
        deal_domain_hall::id(),
        include_bytes!("../../../target/deploy/deal_compact_domain_network.so"),
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
    let user = Keypair::new();
    let picked = Keypair::new();
    for wallet in [&authority, &merchant, &user, &picked] {
        svm.airdrop(&wallet.pubkey(), 40_000_000_000).unwrap();
    }

    let dc_mint = Pubkey::new_unique();
    let merchant_dc = Pubkey::new_unique();
    let user_dc = Pubkey::new_unique();
    set_mint(&mut svm, dc_mint, authority.pubkey(), 2_000);
    set_token_account(&mut svm, merchant_dc, dc_mint, merchant.pubkey(), 1_000);
    set_token_account(&mut svm, user_dc, dc_mint, user.pubkey(), 1_000);

    let domain = Pubkey::new_unique();
    let label = "Hall01";
    set_anchor_account(
        &mut svm,
        domain,
        deal_domain_registry::id(),
        &domain_record(merchant.pubkey(), label),
    );
    let deal = Pubkey::new_unique();
    set_anchor_account(
        &mut svm,
        deal,
        deal_core::id(),
        &deal_account(merchant.pubkey(), label),
    );
    let binding = Pubkey::find_program_address(
        &[deal_domain_entry::BINDING_SEED, deal.as_ref()],
        &deal_domain_entry::id(),
    )
    .0;
    set_anchor_account(
        &mut svm,
        binding,
        deal_domain_entry::id(),
        &DomainDealBinding {
            domain,
            deal,
            creator: merchant.pubkey(),
            picked_counterparty: Pubkey::default(),
            deferred_hall: true,
            require_identity: false,
            bump: Pubkey::find_program_address(
                &[deal_domain_entry::BINDING_SEED, deal.as_ref()],
                &deal_domain_entry::id(),
            )
            .1,
        },
    );

    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_domain_hall::id());
    let initialize = Instruction::new_with_bytes(
        deal_domain_hall::id(),
        &deal_domain_hall::instruction::Initialize {
            dc_mint,
            message_price: 100,
            fee_enabled: true,
        }
        .data(),
        deal_domain_hall::accounts::Initialize {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let unpause = Instruction::new_with_bytes(
        deal_domain_hall::id(),
        &deal_domain_hall::instruction::SetPaused { paused: false }.data(),
        deal_domain_hall::accounts::AdminConfig {
            authority: authority.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[initialize, unpause], &[]));

    let merchant_blacklist = blacklist_pda(domain, merchant.pubkey());
    let user_blacklist = blacklist_pda(domain, user.pubkey());
    let (direct_thread, _) = Pubkey::find_program_address(
        &[
            DIRECT_THREAD_SEED,
            domain.as_ref(),
            merchant.pubkey().as_ref(),
            user.pubkey().as_ref(),
        ],
        &deal_domain_hall::id(),
    );
    let (direct_message, _) = Pubkey::find_program_address(
        &[MESSAGE_SEED, direct_thread.as_ref(), &0u64.to_le_bytes()],
        &deal_domain_hall::id(),
    );
    let direct = Instruction::new_with_bytes(
        deal_domain_hall::id(),
        &deal_domain_hall::instruction::PostDirectMessage {
            index: 0,
            content: "hello merchant".to_string(),
        }
        .data(),
        deal_domain_hall::accounts::PostDirectMessage {
            config,
            sender: user.pubkey(),
            domain,
            merchant: merchant.pubkey(),
            user: user.pubkey(),
            merchant_blacklist,
            user_blacklist,
            thread: direct_thread,
            message: direct_message,
            sender_dc: user_dc,
            dc_mint,
            token_program: spl_token_interface::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &user, &[direct], &[]));
    assert_eq!(token_state(&svm, user_dc).amount, 900);
    let thread: DirectThread = deserialize(&svm, direct_thread);
    assert_eq!(thread.count, 1);
    let message: HallMessage = deserialize(&svm, direct_message);
    assert_eq!(message.sender, user.pubkey());
    assert_eq!(message.content, "hello merchant");
    assert_eq!(message.deal, Pubkey::default());

    let (deal_thread, _) = Pubkey::find_program_address(
        &[DEAL_THREAD_SEED, domain.as_ref(), deal.as_ref()],
        &deal_domain_hall::id(),
    );
    let (deal_message, _) = Pubkey::find_program_address(
        &[MESSAGE_SEED, deal_thread.as_ref(), &0u64.to_le_bytes()],
        &deal_domain_hall::id(),
    );
    let on_deal = Instruction::new_with_bytes(
        deal_domain_hall::id(),
        &deal_domain_hall::instruction::PostDealMessage {
            index: 0,
            content: "I can take this deal".to_string(),
        }
        .data(),
        deal_domain_hall::accounts::PostDealMessage {
            config,
            sender: user.pubkey(),
            domain,
            binding,
            deal,
            creator_blacklist: merchant_blacklist,
            sender_blacklist: user_blacklist,
            thread: deal_thread,
            message: deal_message,
            sender_dc: user_dc,
            dc_mint,
            token_program: spl_token_interface::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &user, &[on_deal], &[]));
    assert_eq!(token_state(&svm, user_dc).amount, 800);
    let deal_thread_state: DealThread = deserialize(&svm, deal_thread);
    assert_eq!(deal_thread_state.count, 1);
    let deal_message_state: HallMessage = deserialize(&svm, deal_message);
    assert_eq!(deal_message_state.deal, deal);
    assert_eq!(deal_message_state.content, "I can take this deal");

    let picked_blacklist = blacklist_pda(domain, picked.pubkey());
    let (signal_thread, _) = Pubkey::find_program_address(
        &[
            SIGNAL_THREAD_SEED,
            domain.as_ref(),
            merchant.pubkey().as_ref(),
        ],
        &deal_domain_hall::id(),
    );
    let (signal, _) = Pubkey::find_program_address(
        &[SIGNAL_SEED, signal_thread.as_ref(), &0u64.to_le_bytes()],
        &deal_domain_hall::id(),
    );
    let signal_pick = Instruction::new_with_bytes(
        deal_domain_hall::id(),
        &deal_domain_hall::instruction::SignalPickUser {
            index: 0,
            note: "selected".to_string(),
        }
        .data(),
        deal_domain_hall::accounts::SignalPickUser {
            config,
            merchant: merchant.pubkey(),
            domain,
            picked_user: picked.pubkey(),
            merchant_blacklist,
            picked_blacklist,
            thread: signal_thread,
            signal,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &merchant, &[signal_pick], &[]));
    let signal_thread_state: SignalThread = deserialize(&svm, signal_thread);
    assert_eq!(signal_thread_state.count, 1);
    let signal_state: PickSignal = deserialize(&svm, signal);
    assert_eq!(signal_state.picked_user, picked.pubkey());
    assert_eq!(signal_state.note, "selected");

    let (_, user_blacklist_bump) = Pubkey::find_program_address(
        &[BLACKLIST_SEED, domain.as_ref(), user.pubkey().as_ref()],
        &deal_domain_rank::id(),
    );
    set_anchor_account(
        &mut svm,
        user_blacklist,
        deal_domain_rank::id(),
        &BlacklistEntry {
            domain,
            user: user.pubkey(),
            banned: true,
            bump: user_blacklist_bump,
        },
    );
    let blocked_message = Pubkey::find_program_address(
        &[MESSAGE_SEED, direct_thread.as_ref(), &1u64.to_le_bytes()],
        &deal_domain_hall::id(),
    )
    .0;
    let blocked = Instruction::new_with_bytes(
        deal_domain_hall::id(),
        &deal_domain_hall::instruction::PostDirectMessage {
            index: 1,
            content: "must fail".to_string(),
        }
        .data(),
        deal_domain_hall::accounts::PostDirectMessage {
            config,
            sender: user.pubkey(),
            domain,
            merchant: merchant.pubkey(),
            user: user.pubkey(),
            merchant_blacklist,
            user_blacklist,
            thread: direct_thread,
            message: blocked_message,
            sender_dc: user_dc,
            dc_mint,
            token_program: spl_token_interface::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(!send(&mut svm, &user, &[blocked], &[]));
    assert_eq!(token_state(&svm, user_dc).amount, 800);
    let final_thread: DirectThread = deserialize(&svm, direct_thread);
    assert_eq!(final_thread.count, 1);
}
