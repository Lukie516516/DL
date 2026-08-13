use anchor_lang::{
    prelude::{AccountDeserialize, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_d_token::{
    BalanceCheckpoint, DTokenConfig, HolderState, CHECKPOINT_SEED, CONFIG_SEED, D_DECIMALS,
    FREEZE_AUTHORITY_SEED, HOLDER_SEED, MAX_SUPPLY,
};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use spl_token_2022_interface::{
    extension::{
        default_account_state::DefaultAccountState, BaseStateWithExtensionsMut, ExtensionType,
        StateWithExtensions, StateWithExtensionsMut,
    },
    state::{Account as TokenAccount, AccountState, Mint},
};

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

fn set_d_mint(svm: &mut LiteSVM, mint: Pubkey, freeze_authority: Pubkey) {
    let size =
        ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::DefaultAccountState])
            .unwrap();
    let mut data = vec![0u8; size];
    let mut state = StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut data).unwrap();
    state.base = Mint {
        mint_authority: COption::None,
        supply: MAX_SUPPLY,
        decimals: D_DECIMALS,
        is_initialized: true,
        freeze_authority: COption::Some(freeze_authority),
    };
    state.pack_base();
    state.init_account_type().unwrap();
    state
        .init_extension::<DefaultAccountState>(true)
        .unwrap()
        .state = AccountState::Frozen as u8;
    svm.set_account(
        mint,
        Account {
            lamports: 5_000_000,
            data,
            owner: spl_token_2022_interface::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn set_frozen_token_account(
    svm: &mut LiteSVM,
    address: Pubkey,
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
) {
    let state = TokenAccount {
        mint,
        owner,
        amount,
        delegate: COption::None,
        state: AccountState::Frozen,
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
            owner: spl_token_2022_interface::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn anchor_state<T: AccountDeserialize>(svm: &LiteSVM, address: Pubkey) -> T {
    let account = svm.get_account(&address).expect("account must exist");
    T::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn token_state(svm: &LiteSVM, address: Pubkey) -> TokenAccount {
    let account = svm.get_account(&address).expect("token account must exist");
    StateWithExtensions::<TokenAccount>::unpack(&account.data)
        .unwrap()
        .base
}

fn holder_pda(owner: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[HOLDER_SEED, owner.as_ref()], &deal_d_token::id()).0
}

fn checkpoint_pda(owner: Pubkey, index: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[CHECKPOINT_SEED, owner.as_ref(), &index.to_le_bytes()],
        &deal_d_token::id(),
    )
    .0
}

#[test]
fn direct_transfers_fail_and_program_transfers_write_both_balance_histories() {
    let mut svm = LiteSVM::new();
    svm.add_program(
        deal_d_token::id(),
        include_bytes!("../../../target/deploy/deal_d_token.so"),
    )
    .unwrap();

    let payer = Keypair::new();
    let initial_holder = Keypair::new();
    let recipient = Keypair::new();
    for wallet in [&payer, &initial_holder, &recipient] {
        svm.airdrop(&wallet.pubkey(), 20_000_000_000).unwrap();
    }

    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_d_token::id());
    let (freeze_authority, _) =
        Pubkey::find_program_address(&[FREEZE_AUTHORITY_SEED], &deal_d_token::id());
    let mint = Pubkey::new_unique();
    let source = Pubkey::new_unique();
    let destination = Pubkey::new_unique();
    set_d_mint(&mut svm, mint, freeze_authority);
    set_frozen_token_account(&mut svm, source, mint, initial_holder.pubkey(), MAX_SUPPLY);
    set_frozen_token_account(&mut svm, destination, mint, recipient.pubkey(), 0);

    let initial_holder_state = holder_pda(initial_holder.pubkey());
    let initial_checkpoint = checkpoint_pda(initial_holder.pubkey(), 0);
    let initialize = Instruction::new_with_bytes(
        deal_d_token::id(),
        &deal_d_token::instruction::Initialize {}.data(),
        deal_d_token::accounts::Initialize {
            payer: payer.pubkey(),
            initial_holder: initial_holder.pubkey(),
            config,
            freeze_authority,
            mint,
            initial_holder_token: source,
            initial_holder_state,
            initial_checkpoint,
            token_program: spl_token_2022_interface::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[initialize], &[]));
    let config_state: DTokenConfig = anchor_state(&svm, config);
    assert_eq!(config_state.total_supply, MAX_SUPPLY);
    assert_eq!(config_state.holder_count, 1);
    let initial_state: HolderState = anchor_state(&svm, initial_holder_state);
    assert_eq!(initial_state.balance, MAX_SUPPLY);
    assert_eq!(initial_state.checkpoint_count, 1);
    let genesis: BalanceCheckpoint = anchor_state(&svm, initial_checkpoint);
    assert_eq!(genesis.balance, MAX_SUPPLY);

    let direct_transfer = spl_token_2022_interface::instruction::transfer_checked(
        &spl_token_2022_interface::ID,
        &source,
        &mint,
        &destination,
        &initial_holder.pubkey(),
        &[],
        5_000_000_000,
        D_DECIMALS,
    )
    .unwrap();
    assert!(!send(&mut svm, &initial_holder, &[direct_transfer], &[]));
    assert_eq!(token_state(&svm, source).amount, MAX_SUPPLY);
    assert_eq!(token_state(&svm, destination).amount, 0);

    let recipient_state = holder_pda(recipient.pubkey());
    let sender_checkpoint = checkpoint_pda(initial_holder.pubkey(), 1);
    let recipient_checkpoint = checkpoint_pda(recipient.pubkey(), 0);
    let amount = 5_000_000_000;
    let transfer = Instruction::new_with_bytes(
        deal_d_token::id(),
        &deal_d_token::instruction::TransferD {
            amount,
            sender_checkpoint_index: 1,
            recipient_checkpoint_index: 0,
        }
        .data(),
        deal_d_token::accounts::TransferD {
            payer: payer.pubkey(),
            holder: initial_holder.pubkey(),
            recipient: recipient.pubkey(),
            config,
            freeze_authority,
            mint,
            source,
            destination,
            sender_state: initial_holder_state,
            recipient_state,
            sender_checkpoint,
            recipient_checkpoint,
            token_program: spl_token_2022_interface::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[transfer], &[&initial_holder]));

    assert_eq!(token_state(&svm, source).amount, MAX_SUPPLY - amount);
    assert_eq!(token_state(&svm, destination).amount, amount);
    assert_eq!(token_state(&svm, source).state, AccountState::Frozen);
    assert_eq!(token_state(&svm, destination).state, AccountState::Frozen);
    let sender: HolderState = anchor_state(&svm, initial_holder_state);
    let receiver: HolderState = anchor_state(&svm, recipient_state);
    assert_eq!(sender.balance, MAX_SUPPLY - amount);
    assert_eq!(receiver.balance, amount);
    assert_eq!(sender.checkpoint_count, 2);
    assert_eq!(receiver.checkpoint_count, 1);
    assert_eq!(
        anchor_state::<BalanceCheckpoint>(&svm, sender_checkpoint).balance,
        MAX_SUPPLY - amount
    );
    assert_eq!(
        anchor_state::<BalanceCheckpoint>(&svm, recipient_checkpoint).balance,
        amount
    );
    assert_eq!(anchor_state::<DTokenConfig>(&svm, config).holder_count, 2);
}
