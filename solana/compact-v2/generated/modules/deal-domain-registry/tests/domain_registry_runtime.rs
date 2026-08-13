use anchor_lang::{
    prelude::{AccountDeserialize, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use anchor_spl::associated_token::get_associated_token_address;
use deal_domain_registry::{
    DomainConfig, DomainRecord, CONFIG_SEED, DOMAIN_ID_SEED, DOMAIN_MINT_SEED, DOMAIN_SEED,
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

fn token_state(svm: &LiteSVM, address: Pubkey) -> TokenAccount {
    let account = svm.get_account(&address).expect("token account must exist");
    TokenAccount::unpack(&account.data).unwrap()
}

fn deserialize<T: AccountDeserialize>(svm: &LiteSVM, address: Pubkey) -> T {
    let account = svm.get_account(&address).expect("account must exist");
    T::try_deserialize(&mut account.data.as_slice()).unwrap()
}

#[test]
fn registers_paid_frozen_domain_nft_and_transfers_with_resolve_sync() {
    let mut svm = LiteSVM::new();
    svm.add_program(
        deal_domain_registry::id(),
        include_bytes!("../../../target/deploy/deal_compact_domain_assets.so"),
    )
    .unwrap();

    let authority = Keypair::new();
    let owner = Keypair::new();
    let new_owner = Keypair::new();
    let treasury = Keypair::new();
    for wallet in [&authority, &owner, &new_owner, &treasury] {
        svm.airdrop(&wallet.pubkey(), 20_000_000_000).unwrap();
    }

    let dc_mint = Pubkey::new_unique();
    let owner_dc = Pubkey::new_unique();
    let treasury_dc = Pubkey::new_unique();
    set_mint(&mut svm, dc_mint, authority.pubkey(), 10_000_000);
    set_token_account(&mut svm, owner_dc, dc_mint, owner.pubkey(), 1_000_000);
    set_token_account(&mut svm, treasury_dc, dc_mint, treasury.pubkey(), 0);

    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_domain_registry::id());
    let initialize = Instruction::new_with_bytes(
        deal_domain_registry::id(),
        &deal_domain_registry::instruction::Initialize {
            dc_mint,
            treasury: treasury.pubkey(),
            base_price: 500_000,
        }
        .data(),
        deal_domain_registry::accounts::Initialize {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let unpause = Instruction::new_with_bytes(
        deal_domain_registry::id(),
        &deal_domain_registry::instruction::SetPaused { paused: false }.data(),
        deal_domain_registry::accounts::AdminConfig {
            authority: authority.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[initialize, unpause], &[]));

    let label = "Ab12z9".to_string();
    let (domain, _) = Pubkey::find_program_address(
        &[DOMAIN_SEED, label.as_bytes()],
        &deal_domain_registry::id(),
    );
    let (domain_mint, _) = Pubkey::find_program_address(
        &[DOMAIN_MINT_SEED, label.as_bytes()],
        &deal_domain_registry::id(),
    );
    let (id_map, _) = Pubkey::find_program_address(
        &[DOMAIN_ID_SEED, &1u64.to_le_bytes()],
        &deal_domain_registry::id(),
    );
    let owner_domain = get_associated_token_address(&owner.pubkey(), &domain_mint);
    let register = Instruction::new_with_bytes(
        deal_domain_registry::id(),
        &deal_domain_registry::instruction::Register {
            label: label.clone(),
            expected_id: 1,
        }
        .data(),
        deal_domain_registry::accounts::Register {
            config,
            owner: owner.pubkey(),
            owner_dc,
            treasury_dc,
            dc_mint,
            dc_token_program: spl_token_interface::ID,
            domain_mint,
            owner_domain,
            domain,
            id_map,
            domain_token_program: spl_token_interface::ID,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &owner, std::slice::from_ref(&register), &[]));
    let config_state: DomainConfig = deserialize(&svm, config);
    let domain_state: DomainRecord = deserialize(&svm, domain);
    assert_eq!(config_state.next_id, 2);
    assert_eq!(domain_state.owner, owner.pubkey());
    assert_eq!(domain_state.creator, owner.pubkey());
    assert_eq!(domain_state.resolve, owner.pubkey());
    assert_eq!(domain_state.label, label);
    assert_eq!(token_state(&svm, owner_dc).amount, 500_000);
    assert_eq!(token_state(&svm, treasury_dc).amount, 500_000);
    assert_eq!(token_state(&svm, owner_domain).amount, 1);
    assert_eq!(token_state(&svm, owner_domain).state, AccountState::Frozen);
    assert!(!send(&mut svm, &owner, &[register], &[]));

    let new_owner_domain = get_associated_token_address(&new_owner.pubkey(), &domain_mint);
    let transfer = Instruction::new_with_bytes(
        deal_domain_registry::id(),
        &deal_domain_registry::instruction::TransferDomain {}.data(),
        deal_domain_registry::accounts::TransferDomain {
            config,
            owner: owner.pubkey(),
            new_owner: new_owner.pubkey(),
            domain,
            domain_mint,
            owner_domain,
            new_owner_domain,
            domain_token_program: spl_token_interface::ID,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &owner, &[transfer], &[]));
    let domain_state: DomainRecord = deserialize(&svm, domain);
    assert_eq!(domain_state.owner, new_owner.pubkey());
    assert_eq!(domain_state.resolve, new_owner.pubkey());
    assert_eq!(domain_state.creator, owner.pubkey());
    assert_eq!(token_state(&svm, owner_domain).amount, 0);
    assert_eq!(token_state(&svm, new_owner_domain).amount, 1);
    assert_eq!(
        token_state(&svm, new_owner_domain).state,
        AccountState::Frozen
    );
}
