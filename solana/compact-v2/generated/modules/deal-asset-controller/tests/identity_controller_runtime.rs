use anchor_lang::{
    prelude::{AccountDeserialize, AccountSerialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_asset_controller::{
    state::{AssetSpec, ConfigureTermsParams},
    CONTROLLER_SEED, TERMS_SEED,
};
use deal_core::{
    constants::{DEAL_SEED, REGISTRY_SEED},
    state::{CompletionReason, CreateDealParams, DealAccount, DealStatus, JoinMode, TemplateType},
};
use deal_identity::{
    DealIdentityBinding, IdentityConfig, IdentityLock, IdentityRecord, BINDING_SEED, CONFIG_SEED,
    IDENTITY_SEED, LOCK_SEED,
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
    let transaction =
        VersionedTransaction::try_new(VersionedMessage::Legacy(message), &signers).unwrap();
    let succeeded = svm.send_transaction(transaction).is_ok();
    svm.expire_blockhash();
    succeeded
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
    T::try_deserialize(&mut account.data.as_slice()).expect("account must deserialize")
}

fn set_mint(svm: &mut LiteSVM, address: Pubkey, authority: Pubkey) {
    let state = Mint {
        mint_authority: COption::Some(authority),
        supply: 1,
        decimals: 0,
        is_initialized: true,
        freeze_authority: COption::Some(authority),
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

fn set_token_account(svm: &mut LiteSVM, address: Pubkey, mint: Pubkey, owner: Pubkey) {
    let state = TokenAccount {
        mint,
        owner,
        amount: 1,
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

fn complete_deal(svm: &mut LiteSVM, address: Pubkey) {
    let mut deal = deserialize::<DealAccount>(svm, address);
    deal.status = DealStatus::Completed;
    deal.completion_reason = CompletionReason::BothAccepted;
    deal.ended_at = 1_700_000_100;
    let existing = svm.get_account(&address).unwrap();
    let mut data = Vec::new();
    deal.try_serialize(&mut data).unwrap();
    svm.set_account(address, Account { data, ..existing })
        .unwrap();
}

#[test]
fn asset_controller_pda_joins_locks_and_only_unlocks_terminal_deals() {
    let mut svm = LiteSVM::new();
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: 1_700_000_000,
        epoch: 1,
        leader_schedule_epoch: 1,
        unix_timestamp: 1_700_000_000,
    });
    for (program, bytes) in [
        (
            deal_core::id(),
            include_bytes!("../../../target/deploy/deal_compact_lifecycle.so").as_slice(),
        ),
        (
            deal_identity::id(),
            include_bytes!("../../../target/deploy/deal_compact_identity_credit.so").as_slice(),
        ),
        (
            deal_asset_controller::id(),
            include_bytes!("../../../target/deploy/deal_compact_lifecycle.so").as_slice(),
        ),
    ] {
        svm.add_program(program, bytes).unwrap();
    }

    let authority = Keypair::new();
    let creator = Keypair::new();
    let participant = Keypair::new();
    for wallet in [&authority, &creator, &participant] {
        svm.airdrop(&wallet.pubkey(), 20_000_000_000).unwrap();
    }

    let (controller, _) =
        Pubkey::find_program_address(&[CONTROLLER_SEED], &deal_asset_controller::id());
    let (registry, _) = Pubkey::find_program_address(&[REGISTRY_SEED], &deal_core::id());
    let initialize_controller = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::InitializeController {
            treasury: authority.pubkey(),
            dc_mint: Pubkey::new_unique(),
            fee_numerator: 3,
            fee_denominator: 1_000,
        }
        .data(),
        deal_asset_controller::accounts::InitializeController {
            authority: authority.pubkey(),
            config: controller,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let initialize_core = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::InitializeRegistry {
            asset_controller: controller,
            identity_controller: controller,
        }
        .data(),
        deal_core::accounts::InitializeRegistry {
            authority: authority.pubkey(),
            registry,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &authority,
        &[initialize_controller, initialize_core],
        &[]
    ));

    let unpause_controller = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::SetPaused { paused: false }.data(),
        deal_asset_controller::accounts::AdminConfig {
            authority: authority.pubkey(),
            config: controller,
        }
        .to_account_metas(None),
    );
    let unpause_core = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::SetPaused { paused: false }.data(),
        deal_core::accounts::AdminConfig {
            authority: authority.pubkey(),
            registry,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &authority,
        &[unpause_controller, unpause_core],
        &[]
    ));

    let (identity_config, identity_config_bump) =
        Pubkey::find_program_address(&[CONFIG_SEED], &deal_identity::id());
    set_anchor_account(
        &mut svm,
        identity_config,
        deal_identity::id(),
        &IdentityConfig {
            authority: authority.pubkey(),
            pending_authority: Pubkey::default(),
            dc_mint: Pubkey::new_unique(),
            trusted_controller: controller,
            reward_controller: Pubkey::new_unique(),
            next_id: 2,
            current_season: 1,
            mint_price: 1,
            min_mint_price: 1,
            max_mint_price: 1_000,
            paused: false,
            bump: identity_config_bump,
        },
    );
    let identity_mint = Pubkey::new_unique();
    let owner_identity = Pubkey::new_unique();
    let (identity, identity_bump) = Pubkey::find_program_address(
        &[IDENTITY_SEED, identity_mint.as_ref()],
        &deal_identity::id(),
    );
    set_mint(&mut svm, identity_mint, identity_config);
    set_token_account(
        &mut svm,
        owner_identity,
        identity_mint,
        participant.pubkey(),
    );
    set_anchor_account(
        &mut svm,
        identity,
        deal_identity::id(),
        &IdentityRecord {
            id: 1,
            mint: identity_mint,
            season: 1,
            date_code: 20_260_724,
            daily_serial: 1,
            total_dc_minted: 0,
            max_partner: identity_mint,
            lock_count: 0,
            bump: identity_bump,
        },
    );

    let deal_id = 1u64;
    let (deal, _) = Pubkey::find_program_address(
        &[DEAL_SEED, deal_id.to_le_bytes().as_ref()],
        &deal_core::id(),
    );
    let create = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::CreateDeal {
            deal_id,
            params: CreateDealParams {
                template_type: TemplateType::EmptyToEmpty,
                open_token_token_fast: false,
                join_mode: JoinMode::NftGated,
                expected_participant: Pubkey::default(),
                a_swap_amount: 0,
                a_margin_amount: 0,
                b_swap_amount: 0,
                b_margin_amount: 0,
                a_has_asset_nft: false,
                b_has_asset_nft: false,
                title: "PDA identity flow".into(),
                description: "no controller hot key".into(),
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
    assert!(send(&mut svm, &creator, &[create], &[]));
    let (terms, _) =
        Pubkey::find_program_address(&[TERMS_SEED, deal.as_ref()], &deal_asset_controller::id());
    let configure_terms = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::ConfigureTerms {
            params: ConfigureTermsParams {
                a_swap: AssetSpec::none(),
                a_margin: AssetSpec::none(),
                b_swap: AssetSpec::none(),
                b_margin: AssetSpec::none(),
                a_asset_nft: AssetSpec::none(),
                b_asset_nft: AssetSpec::none(),
            },
        }
        .data(),
        deal_asset_controller::accounts::ConfigureTerms {
            creator: creator.pubkey(),
            config: controller,
            deal,
            terms,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &creator, &[configure_terms], &[]));

    let direct_join = Instruction::new_with_bytes(
        deal_core::id(),
        &deal_core::instruction::JoinDeal {}.data(),
        deal_core::accounts::JoinDeal {
            participant: participant.pubkey(),
            deal,
        }
        .to_account_metas(None),
    );
    assert!(!send(
        &mut svm,
        &participant,
        std::slice::from_ref(&direct_join),
        &[]
    ));
    let gated_join = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::JoinGatedDeal {}.data(),
        deal_asset_controller::accounts::JoinGatedDeal {
            participant: participant.pubkey(),
            config: controller,
            core_registry: registry,
            deal,
            identity,
            owner_identity,
            core_program: deal_core::id(),
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &participant, &[gated_join], &[]));
    assert_eq!(
        deserialize::<DealAccount>(&svm, deal).participant,
        participant.pubkey()
    );

    let (binding, _) = Pubkey::find_program_address(
        &[BINDING_SEED, deal.as_ref(), participant.pubkey().as_ref()],
        &deal_identity::id(),
    );
    let (lock, _) = Pubkey::find_program_address(
        &[LOCK_SEED, identity_mint.as_ref(), deal.as_ref()],
        &deal_identity::id(),
    );
    let manage_accounts = deal_asset_controller::accounts::ManageIdentity {
        actor: participant.pubkey(),
        config: controller,
        identity_config,
        deal,
        identity_mint,
        owner_identity,
        identity,
        binding,
        lock,
        identity_program: deal_identity::id(),
        token_program: spl_token_interface::ID,
        system_program: anchor_lang::system_program::ID,
        terms,
    };
    let lock_identity = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::LockIdentity {}.data(),
        manage_accounts.to_account_metas(None),
    );
    assert!(send(&mut svm, &participant, &[lock_identity], &[]));
    assert_eq!(
        token_state(&svm, owner_identity).state,
        AccountState::Frozen
    );
    assert_eq!(
        deserialize::<DealIdentityBinding>(&svm, binding).lock_count,
        1
    );
    assert_eq!(deserialize::<IdentityLock>(&svm, lock).count, 1);
    assert_eq!(
        deserialize::<deal_asset_controller::state::AssetTerms>(&svm, terms).b_identity_mint,
        identity_mint
    );

    let unlock_accounts = deal_asset_controller::accounts::ManageIdentity {
        actor: creator.pubkey(),
        config: controller,
        identity_config,
        deal,
        identity_mint,
        owner_identity,
        identity,
        binding,
        lock,
        identity_program: deal_identity::id(),
        token_program: spl_token_interface::ID,
        system_program: anchor_lang::system_program::ID,
        terms,
    };
    let unlock_identity = Instruction::new_with_bytes(
        deal_asset_controller::id(),
        &deal_asset_controller::instruction::UnlockIdentity {}.data(),
        unlock_accounts.to_account_metas(None),
    );
    assert!(!send(
        &mut svm,
        &creator,
        std::slice::from_ref(&unlock_identity),
        &[]
    ));
    complete_deal(&mut svm, deal);
    assert!(send(&mut svm, &creator, &[unlock_identity], &[]));
    assert_eq!(
        token_state(&svm, owner_identity).state,
        AccountState::Initialized
    );
    assert_eq!(
        deserialize::<DealIdentityBinding>(&svm, binding).lock_count,
        0
    );
    assert_eq!(
        deserialize::<deal_asset_controller::state::AssetTerms>(&svm, terms).b_identity_mint,
        Pubkey::default()
    );
}
