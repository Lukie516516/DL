use anchor_lang::{
    prelude::{AccountDeserialize, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_compact_monetary_policy::{
    DcControllerConfig, ParameterRegistry, CONFIG_SEED, MINTER_SEED, PARAMETER_REGISTRY_SEED,
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

fn set_mint(svm: &mut LiteSVM, mint: Pubkey, authority: Pubkey, decimals: u8) {
    let state = Mint {
        mint_authority: COption::Some(authority),
        supply: 0,
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

fn set_token_account(svm: &mut LiteSVM, address: Pubkey, mint: Pubkey, owner: Pubkey) {
    let state = TokenAccount {
        mint,
        owner,
        amount: 0,
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

fn mint_state(svm: &LiteSVM, address: Pubkey) -> Mint {
    Mint::unpack(&svm.get_account(&address).unwrap().data).unwrap()
}

fn token_state(svm: &LiteSVM, address: Pubkey) -> TokenAccount {
    TokenAccount::unpack(&svm.get_account(&address).unwrap().data).unwrap()
}

fn config_state(svm: &LiteSVM, address: Pubkey) -> DcControllerConfig {
    let account = svm.get_account(&address).unwrap();
    DcControllerConfig::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn parameter_state(svm: &LiteSVM, address: Pubkey) -> ParameterRegistry {
    let account = svm.get_account(&address).unwrap();
    ParameterRegistry::try_deserialize(&mut account.data.as_slice()).unwrap()
}

#[test]
fn mint_authority_is_custodied_and_revoked_minters_cannot_mint() {
    let mut svm = LiteSVM::new();
    svm.add_program(
        deal_compact_monetary_policy::id(),
        include_bytes!(env!("DEAL_COMPACT_MONETARY_POLICY_SBF")),
    )
    .unwrap();

    let authority = Keypair::new();
    let minter = Keypair::new();
    let recipient = Keypair::new();
    for wallet in [&authority, &minter, &recipient] {
        svm.airdrop(&wallet.pubkey(), 5_000_000_000).unwrap();
    }

    let dc_mint = Pubkey::new_unique();
    let destination = Pubkey::new_unique();
    set_mint(&mut svm, dc_mint, authority.pubkey(), 6);
    set_token_account(&mut svm, destination, dc_mint, recipient.pubkey());

    let (config, _) =
        Pubkey::find_program_address(&[CONFIG_SEED], &deal_compact_monetary_policy::id());
    let initialize = Instruction::new_with_bytes(
        deal_compact_monetary_policy::id(),
        &deal_compact_monetary_policy::instruction::Initialize {}.data(),
        deal_compact_monetary_policy::accounts::Initialize {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            current_mint_authority: authority.pubkey(),
            dc_mint,
            config,
            dc_token_program: spl_token_interface::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[initialize], &[]));
    assert_eq!(
        mint_state(&svm, dc_mint).mint_authority,
        COption::Some(config)
    );
    assert!(config_state(&svm, config).paused);

    let (grant, _) = Pubkey::find_program_address(
        &[MINTER_SEED, minter.pubkey().as_ref()],
        &deal_compact_monetary_policy::id(),
    );
    let authorize = Instruction::new_with_bytes(
        deal_compact_monetary_policy::id(),
        &deal_compact_monetary_policy::instruction::SetMinter { enabled: true }.data(),
        deal_compact_monetary_policy::accounts::SetMinter {
            authority: authority.pubkey(),
            config,
            minter: minter.pubkey(),
            grant,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let unpause = Instruction::new_with_bytes(
        deal_compact_monetary_policy::id(),
        &deal_compact_monetary_policy::instruction::SetPaused { paused: false }.data(),
        deal_compact_monetary_policy::accounts::AdminConfig {
            authority: authority.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[authorize, unpause], &[]));

    let mint = Instruction::new_with_bytes(
        deal_compact_monetary_policy::id(),
        &deal_compact_monetary_policy::instruction::Mint { amount: 25_000 }.data(),
        deal_compact_monetary_policy::accounts::MintDc {
            config,
            minter: minter.pubkey(),
            grant,
            dc_mint,
            destination,
            dc_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &minter, std::slice::from_ref(&mint), &[]));
    assert_eq!(token_state(&svm, destination).amount, 25_000);
    assert_eq!(mint_state(&svm, dc_mint).supply, 25_000);
    assert_eq!(config_state(&svm, config).total_minted, 25_000);

    let revoke = Instruction::new_with_bytes(
        deal_compact_monetary_policy::id(),
        &deal_compact_monetary_policy::instruction::SetMinter { enabled: false }.data(),
        deal_compact_monetary_policy::accounts::SetMinter {
            authority: authority.pubkey(),
            config,
            minter: minter.pubkey(),
            grant,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[revoke], &[]));
    assert!(!send(&mut svm, &minter, &[mint], &[]));
    assert_eq!(token_state(&svm, destination).amount, 25_000);
}

#[test]
fn governed_parameters_keep_an_independent_authority_and_bounds() {
    let mut svm = LiteSVM::new();
    svm.add_program(
        deal_compact_monetary_policy::id(),
        include_bytes!(env!("DEAL_COMPACT_MONETARY_POLICY_SBF")),
    )
    .unwrap();

    let governance = Keypair::new();
    let attacker = Keypair::new();
    for wallet in [&governance, &attacker] {
        svm.airdrop(&wallet.pubkey(), 5_000_000_000).unwrap();
    }
    let (parameter_registry, _) = Pubkey::find_program_address(
        &[PARAMETER_REGISTRY_SEED],
        &deal_compact_monetary_policy::id(),
    );
    let initialize = Instruction::new_with_bytes(
        deal_compact_monetary_policy::id(),
        &deal_compact_monetary_policy::instruction::InitializeParameters {
            governance_authority: governance.pubkey(),
            message_price: 100,
            min_window_sec: 60,
        }
        .data(),
        deal_compact_monetary_policy::accounts::InitializeParameters {
            payer: governance.pubkey(),
            parameter_registry,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &governance, &[initialize], &[]));
    let initial = parameter_state(&svm, parameter_registry);
    assert_eq!(initial.governance_authority, governance.pubkey());
    assert_eq!(initial.message_price, 100);
    assert_eq!(initial.min_window_sec, 60);

    let set_price = |signer: Pubkey, value: u64| {
        Instruction::new_with_bytes(
            deal_compact_monetary_policy::id(),
            &deal_compact_monetary_policy::instruction::SetMessagePrice {
                message_price: value,
            }
            .data(),
            deal_compact_monetary_policy::accounts::GovernedParameterUpdate {
                governance_authority: signer,
                parameter_registry,
            }
            .to_account_metas(None),
        )
    };
    assert!(!send(
        &mut svm,
        &attacker,
        &[set_price(attacker.pubkey(), 999)],
        &[],
    ));
    assert_eq!(parameter_state(&svm, parameter_registry).message_price, 100);
    assert!(send(
        &mut svm,
        &governance,
        &[set_price(governance.pubkey(), 250)],
        &[],
    ));

    let set_window = |value: u32| {
        Instruction::new_with_bytes(
            deal_compact_monetary_policy::id(),
            &deal_compact_monetary_policy::instruction::SetMinWindowSec {
                min_window_sec: value,
            }
            .data(),
            deal_compact_monetary_policy::accounts::GovernedParameterUpdate {
                governance_authority: governance.pubkey(),
                parameter_registry,
            }
            .to_account_metas(None),
        )
    };
    assert!(!send(&mut svm, &governance, &[set_window(59)], &[]));
    assert!(send(&mut svm, &governance, &[set_window(86_400)], &[]));
    let updated = parameter_state(&svm, parameter_registry);
    assert_eq!(updated.message_price, 250);
    assert_eq!(updated.min_window_sec, 86_400);
}
