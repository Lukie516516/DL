use anchor_lang::{
    prelude::{AccountDeserialize, AccountSerialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use anchor_spl::associated_token::get_associated_token_address;
use deal_core::state::{CompletionReason, DealAccount, DealStatus, JoinMode, TemplateType, Vote};
use deal_identity::{
    DateCounter, DealIdentityBinding, IdentityLock, IdentityProfile, IdentityRecord, BINDING_SEED,
    CONFIG_SEED, DATE_COUNTER_SEED, IDENTITY_MINT_SEED, IDENTITY_SEED, LOCK_SEED, PROFILE_SEED,
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

const NOW: i64 = 1_700_000_000;
const DATE_CODE: u32 = 20_231_114;

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

fn token_state(svm: &LiteSVM, address: Pubkey) -> TokenAccount {
    let account = svm.get_account(&address).expect("token account must exist");
    TokenAccount::unpack(&account.data).unwrap()
}

fn set_deal(svm: &mut LiteSVM, address: Pubkey, creator: Pubkey) {
    let deal = DealAccount {
        id: 1,
        creator,
        participant: Pubkey::default(),
        expected_participant: Pubkey::default(),
        last_removed_participant: Pubkey::default(),
        template_type: TemplateType::EmptyToEmpty,
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
        is_domain_deal: false,
        a_swap_amount: 0,
        a_margin_amount: 0,
        b_swap_amount: 0,
        b_margin_amount: 0,
        timeout_seconds: 300,
        replace_timeout_seconds: 120,
        created_at: NOW,
        ended_at: 0,
        b_joined_at: 0,
        locked_at: 0,
        a_vote_at: 0,
        b_vote_at: 0,
        a_pre_accept_at: 0,
        title: "identity binding".into(),
        description: String::new(),
        domain_name: String::new(),
        bump: 1,
    };
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

fn complete_deal(svm: &mut LiteSVM, address: Pubkey) {
    let mut deal = deserialize::<DealAccount>(svm, &address);
    deal.status = DealStatus::Completed;
    deal.completion_reason = CompletionReason::BothAccepted;
    deal.ended_at = NOW;
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

#[test]
fn mint_profile_and_nested_lock_are_enforced_at_runtime() {
    let mut svm = LiteSVM::new();
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: NOW,
        epoch: 1,
        leader_schedule_epoch: 1,
        unix_timestamp: NOW,
    });
    svm.add_program(
        deal_identity::id(),
        include_bytes!("../../../target/deploy/deal_compact_identity_credit.so"),
    )
    .unwrap();

    let authority = Keypair::new();
    let owner = Keypair::new();
    let controller = Keypair::new();
    for wallet in [&authority, &owner, &controller] {
        svm.airdrop(&wallet.pubkey(), 5_000_000_000).unwrap();
    }

    let dc_mint = Pubkey::new_unique();
    let owner_dc = Pubkey::new_unique();
    set_mint(&mut svm, dc_mint, authority.pubkey(), 1_000, 6);
    set_token_account(&mut svm, owner_dc, dc_mint, owner.pubkey(), 1_000);

    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_identity::id());
    let initialize = Instruction::new_with_bytes(
        deal_identity::id(),
        &deal_identity::instruction::Initialize {
            dc_mint,
            trusted_controller: controller.pubkey(),
            mint_price: 100,
            min_mint_price: 1,
            max_mint_price: 1_000,
        }
        .data(),
        deal_identity::accounts::Initialize {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[initialize], &[]));

    let unpause = Instruction::new_with_bytes(
        deal_identity::id(),
        &deal_identity::instruction::SetPaused { paused: false }.data(),
        deal_identity::accounts::AdminConfig {
            authority: authority.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[unpause], &[]));

    let identity_id = 1u64;
    let (identity_mint, _) = Pubkey::find_program_address(
        &[IDENTITY_MINT_SEED, &identity_id.to_le_bytes()],
        &deal_identity::id(),
    );
    let owner_identity = get_associated_token_address(&owner.pubkey(), &identity_mint);
    let (identity, _) = Pubkey::find_program_address(
        &[IDENTITY_SEED, identity_mint.as_ref()],
        &deal_identity::id(),
    );
    let (profile, _) = Pubkey::find_program_address(
        &[PROFILE_SEED, identity_mint.as_ref()],
        &deal_identity::id(),
    );
    let (date_counter, _) = Pubkey::find_program_address(
        &[
            DATE_COUNTER_SEED,
            &1u16.to_le_bytes(),
            &DATE_CODE.to_le_bytes(),
        ],
        &deal_identity::id(),
    );
    let mint_identity = Instruction::new_with_bytes(
        deal_identity::id(),
        &deal_identity::instruction::MintIdentity {
            identity_id,
            expected_date_code: DATE_CODE,
        }
        .data(),
        deal_identity::accounts::MintIdentity {
            config,
            owner: owner.pubkey(),
            owner_dc,
            dc_mint,
            dc_token_program: spl_token_interface::ID,
            identity_mint,
            owner_identity,
            identity,
            profile,
            date_counter,
            identity_token_program: spl_token_interface::ID,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &owner, &[mint_identity], &[]));
    assert_eq!(token_state(&svm, owner_dc).amount, 900);
    assert_eq!(token_state(&svm, owner_identity).amount, 1);
    let identity_state = deserialize::<IdentityRecord>(&svm, &identity);
    assert_eq!(identity_state.id, identity_id);
    assert_eq!(identity_state.date_code, DATE_CODE);
    assert_eq!(deserialize::<DateCounter>(&svm, &date_counter).count, 1);

    let update_profile = Instruction::new_with_bytes(
        deal_identity::id(),
        &deal_identity::instruction::SetProfile {
            image_uri: "https://example.invalid/avatar.png".into(),
            username: "alice".into(),
            user_detail: "official Deal identity".into(),
        }
        .data(),
        deal_identity::accounts::SetProfile {
            owner: owner.pubkey(),
            identity_mint,
            owner_identity,
            identity,
            profile,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &owner, &[update_profile], &[]));
    assert_eq!(
        deserialize::<IdentityProfile>(&svm, &profile).username,
        "alice"
    );

    let deal = Pubkey::new_unique();
    set_deal(&mut svm, deal, owner.pubkey());
    let (lock, _) = Pubkey::find_program_address(
        &[LOCK_SEED, identity_mint.as_ref(), deal.as_ref()],
        &deal_identity::id(),
    );
    let (binding, _) = Pubkey::find_program_address(
        &[BINDING_SEED, deal.as_ref(), owner.pubkey().as_ref()],
        &deal_identity::id(),
    );
    let lock_accounts = deal_identity::accounts::LockIdentity {
        config,
        payer: controller.pubkey(),
        controller: controller.pubkey(),
        deal,
        owner: owner.pubkey(),
        identity_mint,
        owner_identity,
        identity,
        binding,
        lock,
        token_program: spl_token_interface::ID,
        system_program: anchor_lang::system_program::ID,
    };
    let lock_identity = Instruction::new_with_bytes(
        deal_identity::id(),
        &deal_identity::instruction::LockIdentity {}.data(),
        lock_accounts.to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &controller,
        std::slice::from_ref(&lock_identity),
        &[]
    ));
    assert!(!send(
        &mut svm,
        &controller,
        std::slice::from_ref(&lock_identity),
        &[]
    ));
    let second_deal = Pubkey::new_unique();
    set_deal(&mut svm, second_deal, owner.pubkey());
    let (second_lock, _) = Pubkey::find_program_address(
        &[LOCK_SEED, identity_mint.as_ref(), second_deal.as_ref()],
        &deal_identity::id(),
    );
    let (second_binding, _) = Pubkey::find_program_address(
        &[BINDING_SEED, second_deal.as_ref(), owner.pubkey().as_ref()],
        &deal_identity::id(),
    );
    let second_lock_identity = Instruction::new_with_bytes(
        deal_identity::id(),
        &deal_identity::instruction::LockIdentity {}.data(),
        deal_identity::accounts::LockIdentity {
            config,
            payer: controller.pubkey(),
            controller: controller.pubkey(),
            deal: second_deal,
            owner: owner.pubkey(),
            identity_mint,
            owner_identity,
            identity,
            binding: second_binding,
            lock: second_lock,
            token_program: spl_token_interface::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &controller, &[second_lock_identity], &[]));
    assert_eq!(
        token_state(&svm, owner_identity).state,
        AccountState::Frozen
    );
    assert_eq!(deserialize::<IdentityLock>(&svm, &lock).count, 1);
    assert_eq!(deserialize::<IdentityLock>(&svm, &second_lock).count, 1);
    let binding_state = deserialize::<DealIdentityBinding>(&svm, &binding);
    assert_eq!(binding_state.deal, deal);
    assert_eq!(binding_state.party, owner.pubkey());
    assert_eq!(binding_state.identity_mint, identity_mint);
    assert_eq!(binding_state.lock_count, 1);
    assert_eq!(deserialize::<IdentityRecord>(&svm, &identity).lock_count, 2);

    let unlock = Instruction::new_with_bytes(
        deal_identity::id(),
        &deal_identity::instruction::UnlockIdentity {}.data(),
        deal_identity::accounts::UnlockIdentity {
            config,
            controller: controller.pubkey(),
            deal,
            identity_mint,
            owner_identity,
            identity,
            binding,
            lock,
            token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    assert!(!send(
        &mut svm,
        &controller,
        std::slice::from_ref(&unlock),
        &[]
    ));
    complete_deal(&mut svm, deal);
    assert!(send(
        &mut svm,
        &controller,
        std::slice::from_ref(&unlock),
        &[]
    ));
    assert_eq!(
        token_state(&svm, owner_identity).state,
        AccountState::Frozen
    );
    let second_unlock = Instruction::new_with_bytes(
        deal_identity::id(),
        &deal_identity::instruction::UnlockIdentity {}.data(),
        deal_identity::accounts::UnlockIdentity {
            config,
            controller: controller.pubkey(),
            deal: second_deal,
            identity_mint,
            owner_identity,
            identity,
            binding: second_binding,
            lock: second_lock,
            token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    assert!(!send(
        &mut svm,
        &controller,
        std::slice::from_ref(&second_unlock),
        &[]
    ));
    complete_deal(&mut svm, second_deal);
    assert!(send(&mut svm, &controller, &[second_unlock], &[]));
    assert_eq!(
        token_state(&svm, owner_identity).state,
        AccountState::Initialized
    );
    assert_eq!(deserialize::<IdentityRecord>(&svm, &identity).lock_count, 0);
    assert_eq!(
        deserialize::<DealIdentityBinding>(&svm, &binding).lock_count,
        0
    );
    assert_eq!(
        deserialize::<DealIdentityBinding>(&svm, &second_binding).lock_count,
        0
    );
}
