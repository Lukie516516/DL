use anchor_lang::{
    prelude::{AccountDeserialize, AccountSerialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_core::state::{CompletionReason, DealAccount, DealStatus, JoinMode, TemplateType, Vote};
use deal_message_hub::{
    MessageConfig, MessageThread, StoredMessage, CONFIG_SEED, MESSAGE_SEED, THREAD_SEED,
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

fn mock_deal(creator: Pubkey, participant: Pubkey) -> DealAccount {
    DealAccount {
        id: 1,
        creator,
        participant,
        expected_participant: Pubkey::default(),
        last_removed_participant: Pubkey::default(),
        template_type: TemplateType::TokenToToken,
        open_token_token_fast: false,
        join_mode: JoinMode::Open,
        status: DealStatus::Active,
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
        is_domain_deal: false,
        a_swap_amount: 100,
        a_margin_amount: 0,
        b_swap_amount: 200,
        b_margin_amount: 0,
        timeout_seconds: 300,
        replace_timeout_seconds: 120,
        created_at: 1_700_000_000,
        ended_at: 0,
        b_joined_at: 1_700_000_000,
        locked_at: 0,
        a_vote_at: 0,
        b_vote_at: 0,
        a_pre_accept_at: 0,
        title: "message runtime".into(),
        description: "participant authorization and burn".into(),
        domain_name: String::new(),
        bump: 1,
    }
}

fn set_deal(svm: &mut LiteSVM, address: Pubkey, deal: &DealAccount) {
    let mut data = Vec::new();
    deal.try_serialize(&mut data).unwrap();
    svm.set_account(
        address,
        Account {
            lamports: 5_000_000,
            data,
            owner: deal_core::id(),
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
        decimals: 0,
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

#[test]
fn only_participants_can_post_and_paid_messages_burn_dc() {
    let mut svm = LiteSVM::new();
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: 1_700_000_000,
        epoch: 1,
        leader_schedule_epoch: 1,
        unix_timestamp: 1_700_000_000,
    });
    svm.add_program(
        deal_message_hub::id(),
        include_bytes!("../../../target/deploy/deal_compact_data_services.so"),
    )
    .unwrap();

    let authority = Keypair::new();
    let creator = Keypair::new();
    let participant = Keypair::new();
    let outsider = Keypair::new();
    let writer = Keypair::new();
    for key in [&authority, &creator, &participant, &outsider, &writer] {
        svm.airdrop(&key.pubkey(), 2_000_000_000).unwrap();
    }

    let deal = Pubkey::new_unique();
    set_deal(
        &mut svm,
        deal,
        &mock_deal(creator.pubkey(), participant.pubkey()),
    );
    let dc_mint = Pubkey::new_unique();
    let creator_dc = Pubkey::new_unique();
    let outsider_dc = Pubkey::new_unique();
    set_mint(&mut svm, dc_mint, authority.pubkey(), 2_000);
    set_token_account(&mut svm, creator_dc, dc_mint, creator.pubkey(), 1_000);
    set_token_account(&mut svm, outsider_dc, dc_mint, outsider.pubkey(), 1_000);

    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_message_hub::id());
    let initialize = Instruction::new_with_bytes(
        deal_message_hub::id(),
        &deal_message_hub::instruction::Initialize {
            trusted_writer: writer.pubkey(),
            dc_mint,
            message_price: 100,
            fee_enabled: true,
        }
        .data(),
        deal_message_hub::accounts::Initialize {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[initialize], &[]));
    assert!(deserialize::<MessageConfig>(&svm, &config).paused);

    let unpause = Instruction::new_with_bytes(
        deal_message_hub::id(),
        &deal_message_hub::instruction::SetPaused { paused: false }.data(),
        deal_message_hub::accounts::AdminConfig {
            authority: authority.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[unpause], &[]));

    let (thread, _) =
        Pubkey::find_program_address(&[THREAD_SEED, deal.as_ref()], &deal_message_hub::id());
    let (message_zero, _) = Pubkey::find_program_address(
        &[MESSAGE_SEED, deal.as_ref(), &0u64.to_le_bytes()],
        &deal_message_hub::id(),
    );
    let outsider_post = Instruction::new_with_bytes(
        deal_message_hub::id(),
        &deal_message_hub::instruction::PostMessage {
            index: 0,
            content: "not allowed".into(),
        }
        .data(),
        deal_message_hub::accounts::PostMessage {
            config,
            sender: outsider.pubkey(),
            deal,
            thread,
            message: message_zero,
            sender_dc: outsider_dc,
            dc_mint,
            token_program: spl_token_interface::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(!send(&mut svm, &outsider, &[outsider_post], &[]));
    assert_eq!(token_balance(&svm, outsider_dc), 1_000);
    assert!(svm.get_account(&message_zero).is_none());

    let valid_post = Instruction::new_with_bytes(
        deal_message_hub::id(),
        &deal_message_hub::instruction::PostMessage {
            index: 0,
            content: "hello deal".into(),
        }
        .data(),
        deal_message_hub::accounts::PostMessage {
            config,
            sender: creator.pubkey(),
            deal,
            thread,
            message: message_zero,
            sender_dc: creator_dc,
            dc_mint,
            token_program: spl_token_interface::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[valid_post], &[]));
    assert_eq!(token_balance(&svm, creator_dc), 900);
    assert_eq!(deserialize::<MessageThread>(&svm, &thread).count, 1);
    let stored = deserialize::<StoredMessage>(&svm, &message_zero);
    assert_eq!(stored.sender, creator.pubkey());
    assert_eq!(stored.content, "hello deal");

    let (message_one, _) = Pubkey::find_program_address(
        &[MESSAGE_SEED, deal.as_ref(), &1u64.to_le_bytes()],
        &deal_message_hub::id(),
    );
    let oversized = Instruction::new_with_bytes(
        deal_message_hub::id(),
        &deal_message_hub::instruction::PostMessage {
            index: 1,
            content: "x".repeat(1_501),
        }
        .data(),
        deal_message_hub::accounts::PostMessage {
            config,
            sender: creator.pubkey(),
            deal,
            thread,
            message: message_one,
            sender_dc: creator_dc,
            dc_mint,
            token_program: spl_token_interface::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(!send(&mut svm, &creator, &[oversized], &[]));
    assert_eq!(token_balance(&svm, creator_dc), 900);
    assert_eq!(deserialize::<MessageThread>(&svm, &thread).count, 1);
}
