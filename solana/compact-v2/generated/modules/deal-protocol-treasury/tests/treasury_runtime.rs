use anchor_lang::{
    prelude::{AccountDeserialize, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_protocol_treasury::{TreasuryConfig, CONFIG_SEED, VAULT_AUTHORITY_SEED};
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
    let result = svm.send_transaction(transaction).is_ok();
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

fn treasury_config(svm: &LiteSVM, address: Pubkey) -> TreasuryConfig {
    let account = svm
        .get_account(&address)
        .expect("treasury config must exist");
    TreasuryConfig::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn token_state(svm: &LiteSVM, address: Pubkey) -> TokenAccount {
    let account = svm.get_account(&address).expect("token account must exist");
    TokenAccount::unpack(&account.data).unwrap()
}

#[test]
fn governance_controls_native_and_token_funds_and_bootstrap_locks_permanently() {
    let mut svm = LiteSVM::new();
    svm.add_program(
        deal_protocol_treasury::id(),
        include_bytes!("../../../target/deploy/deal_compact_treasury.so"),
    )
    .unwrap();

    let payer = Keypair::new();
    let bootstrap = Keypair::new();
    let controller = Keypair::new();
    let next_controller = Keypair::new();
    let attacker = Keypair::new();
    let recipient = Keypair::new();
    for wallet in [
        &payer,
        &bootstrap,
        &controller,
        &next_controller,
        &attacker,
        &recipient,
    ] {
        svm.airdrop(&wallet.pubkey(), 20_000_000_000).unwrap();
    }

    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_protocol_treasury::id());
    let (vault_authority, _) =
        Pubkey::find_program_address(&[VAULT_AUTHORITY_SEED], &deal_protocol_treasury::id());

    let initialize = Instruction::new_with_bytes(
        deal_protocol_treasury::id(),
        &deal_protocol_treasury::instruction::Initialize {
            controller: controller.pubkey(),
            bootstrap_admin: bootstrap.pubkey(),
        }
        .data(),
        deal_protocol_treasury::accounts::Initialize {
            payer: payer.pubkey(),
            config,
            vault_authority,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[initialize], &[]));
    let state = treasury_config(&svm, config);
    assert_eq!(state.controller, controller.pubkey());
    assert_eq!(state.bootstrap_admin, bootstrap.pubkey());
    assert!(!state.bootstrap_locked);

    let fund_amount = 1_000_000_000;
    let fund_native = Instruction::new_with_bytes(
        deal_protocol_treasury::id(),
        &deal_protocol_treasury::instruction::FundNative {
            amount: fund_amount,
        }
        .data(),
        deal_protocol_treasury::accounts::FundNative {
            funder: payer.pubkey(),
            vault_authority,
            config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[fund_native], &[]));
    assert_eq!(svm.get_balance(&vault_authority).unwrap(), fund_amount);

    let unauthorized_payment = Instruction::new_with_bytes(
        deal_protocol_treasury::id(),
        &deal_protocol_treasury::instruction::PayNative {
            amount: 100_000_000,
        }
        .data(),
        deal_protocol_treasury::accounts::PayNative {
            controller: attacker.pubkey(),
            config,
            vault_authority,
            recipient: recipient.pubkey(),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(!send(&mut svm, &attacker, &[unauthorized_payment], &[]));
    assert_eq!(svm.get_balance(&vault_authority).unwrap(), fund_amount);

    let recipient_before = svm.get_balance(&recipient.pubkey()).unwrap();
    let pay_native = Instruction::new_with_bytes(
        deal_protocol_treasury::id(),
        &deal_protocol_treasury::instruction::PayNative {
            amount: 250_000_000,
        }
        .data(),
        deal_protocol_treasury::accounts::PayNative {
            controller: controller.pubkey(),
            config,
            vault_authority,
            recipient: recipient.pubkey(),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &controller, &[pay_native], &[]));
    assert_eq!(
        svm.get_balance(&recipient.pubkey()).unwrap(),
        recipient_before + 250_000_000
    );
    assert_eq!(svm.get_balance(&vault_authority).unwrap(), 750_000_000);

    let token_mint = Pubkey::new_unique();
    let source = Pubkey::new_unique();
    let destination = Pubkey::new_unique();
    set_mint(&mut svm, token_mint, payer.pubkey(), 1_000_000);
    set_token_account(&mut svm, source, token_mint, vault_authority, 1_000_000);
    set_token_account(&mut svm, destination, token_mint, recipient.pubkey(), 0);
    let pay_token = Instruction::new_with_bytes(
        deal_protocol_treasury::id(),
        &deal_protocol_treasury::instruction::PayToken { amount: 400_000 }.data(),
        deal_protocol_treasury::accounts::PayToken {
            controller: controller.pubkey(),
            config,
            vault_authority,
            source,
            destination,
            mint: token_mint,
            token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &controller, &[pay_token], &[]));
    assert_eq!(token_state(&svm, source).amount, 600_000);
    assert_eq!(token_state(&svm, destination).amount, 400_000);

    let bootstrap_set = Instruction::new_with_bytes(
        deal_protocol_treasury::id(),
        &deal_protocol_treasury::instruction::BootstrapSetController {
            new_controller: next_controller.pubkey(),
        }
        .data(),
        deal_protocol_treasury::accounts::BootstrapAdmin {
            bootstrap_admin: bootstrap.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &bootstrap, &[bootstrap_set], &[]));
    assert_eq!(
        treasury_config(&svm, config).controller,
        next_controller.pubkey()
    );

    let old_controller_payment = Instruction::new_with_bytes(
        deal_protocol_treasury::id(),
        &deal_protocol_treasury::instruction::PayNative { amount: 1 }.data(),
        deal_protocol_treasury::accounts::PayNative {
            controller: controller.pubkey(),
            config,
            vault_authority,
            recipient: recipient.pubkey(),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(!send(&mut svm, &controller, &[old_controller_payment], &[]));

    let lock_bootstrap = Instruction::new_with_bytes(
        deal_protocol_treasury::id(),
        &deal_protocol_treasury::instruction::LockBootstrap {}.data(),
        deal_protocol_treasury::accounts::BootstrapAdmin {
            bootstrap_admin: bootstrap.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &bootstrap, &[lock_bootstrap], &[]));
    assert!(treasury_config(&svm, config).bootstrap_locked);

    let forbidden_bootstrap_change = Instruction::new_with_bytes(
        deal_protocol_treasury::id(),
        &deal_protocol_treasury::instruction::BootstrapSetController {
            new_controller: attacker.pubkey(),
        }
        .data(),
        deal_protocol_treasury::accounts::BootstrapAdmin {
            bootstrap_admin: bootstrap.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(!send(
        &mut svm,
        &bootstrap,
        &[forbidden_bootstrap_change],
        &[]
    ));
    assert_eq!(
        treasury_config(&svm, config).controller,
        next_controller.pubkey()
    );

    let final_payment = Instruction::new_with_bytes(
        deal_protocol_treasury::id(),
        &deal_protocol_treasury::instruction::PayNative { amount: 50_000_000 }.data(),
        deal_protocol_treasury::accounts::PayNative {
            controller: next_controller.pubkey(),
            config,
            vault_authority,
            recipient: recipient.pubkey(),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &next_controller, &[final_payment], &[]));
    assert_eq!(svm.get_balance(&vault_authority).unwrap(), 700_000_000);
}
