use anchor_lang::{
    prelude::{AccountDeserialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use anchor_spl::associated_token::get_associated_token_address;
use deal_dex_pair::{CONFIG_SEED as PAIR_CONFIG_SEED, PAIR_SEED};
use deal_swap_orderbook::{
    Order, QueueHeader, CONFIG_SEED, ORDER_SEED, QUEUE_HEADER_SEED, QUEUE_PAGE_SEED, SIDE_BUY_DC,
    SIDE_SELL_DC,
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
    let result = match svm.send_transaction(transaction) {
        Ok(_) => true,
        Err(error) => {
            eprintln!("transaction failed: {error:?}");
            false
        }
    };
    svm.expire_blockhash();
    result
}

fn deserialize<T: AccountDeserialize>(svm: &LiteSVM, address: Pubkey) -> T {
    let account = svm.get_account(&address).expect("account must exist");
    T::try_deserialize(&mut account.data.as_slice()).expect("account must deserialize")
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
fn escrowed_orders_settle_permissionlessly_and_cancel_with_treasury_fee() {
    let mut svm = LiteSVM::new();
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: NOW,
        epoch: 1,
        leader_schedule_epoch: 1,
        unix_timestamp: NOW,
    });
    svm.add_program(
        deal_dex_pair::ID,
        include_bytes!("../../../target/deploy/deal_dex_pair.so"),
    )
    .unwrap();
    svm.add_program(
        deal_swap_orderbook::ID,
        include_bytes!("../../../target/deploy/deal_swap_orderbook.so"),
    )
    .unwrap();

    let authority = Keypair::new();
    let user = Keypair::new();
    let keeper = Keypair::new();
    let treasury = Keypair::new();
    for wallet in [&authority, &user, &keeper, &treasury] {
        svm.airdrop(&wallet.pubkey(), 10_000_000_000).unwrap();
    }

    let dc_mint = Pubkey::new_unique();
    let other_mint = Pubkey::new_unique();
    let authority_dc = Pubkey::new_unique();
    let authority_other = Pubkey::new_unique();
    let user_dc = Pubkey::new_unique();
    let user_other = Pubkey::new_unique();
    let treasury_dc = Pubkey::new_unique();
    let treasury_other = Pubkey::new_unique();
    set_mint(&mut svm, dc_mint, authority.pubkey(), 520_000);
    set_mint(&mut svm, other_mint, authority.pubkey(), 70_000);
    set_token_account(&mut svm, authority_dc, dc_mint, authority.pubkey(), 500_000);
    set_token_account(
        &mut svm,
        authority_other,
        other_mint,
        authority.pubkey(),
        50_000,
    );
    set_token_account(&mut svm, user_dc, dc_mint, user.pubkey(), 20_000);
    set_token_account(&mut svm, user_other, other_mint, user.pubkey(), 20_000);
    set_token_account(&mut svm, treasury_dc, dc_mint, treasury.pubkey(), 0);
    set_token_account(&mut svm, treasury_other, other_mint, treasury.pubkey(), 0);

    let (pair_config, _) = Pubkey::find_program_address(&[PAIR_CONFIG_SEED], &deal_dex_pair::ID);
    let (pair, _) =
        Pubkey::find_program_address(&[PAIR_SEED, other_mint.as_ref()], &deal_dex_pair::ID);
    let vault0 = get_associated_token_address(&pair, &dc_mint);
    let vault1 = get_associated_token_address(&pair, &other_mint);
    let initialize_pair = Instruction::new_with_bytes(
        deal_dex_pair::ID,
        &deal_dex_pair::instruction::Initialize {}.data(),
        deal_dex_pair::accounts::Initialize {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            dc_mint,
            dc_token_program: spl_token_interface::ID,
            config: pair_config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let unpause_pair = Instruction::new_with_bytes(
        deal_dex_pair::ID,
        &deal_dex_pair::instruction::SetPaused { paused: false }.data(),
        deal_dex_pair::accounts::AdminConfig {
            authority: authority.pubkey(),
            config: pair_config,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &authority,
        &[initialize_pair, unpause_pair],
        &[],
    ));
    let create_pair = Instruction::new_with_bytes(
        deal_dex_pair::ID,
        &deal_dex_pair::instruction::CreatePair {
            fee_numerator: 3,
            fee_denominator: 1_000,
        }
        .data(),
        deal_dex_pair::accounts::CreatePair {
            authority: authority.pubkey(),
            config: pair_config,
            dc_mint,
            other_mint,
            dc_token_program: spl_token_interface::ID,
            other_token_program: spl_token_interface::ID,
            pair,
            vault0,
            vault1,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[create_pair], &[]));
    let initialize_liquidity = Instruction::new_with_bytes(
        deal_dex_pair::ID,
        &deal_dex_pair::instruction::InitializeLiquidity {
            amount0: 500_000,
            amount1: 50_000,
        }
        .data(),
        deal_dex_pair::accounts::InitializeLiquidity {
            authority: authority.pubkey(),
            config: pair_config,
            pair,
            source0: authority_dc,
            source1: authority_other,
            dc_mint,
            other_mint,
            vault0,
            vault1,
            dc_token_program: spl_token_interface::ID,
            other_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    let set_virtual = Instruction::new_with_bytes(
        deal_dex_pair::ID,
        &deal_dex_pair::instruction::SetVirtualReserves {
            virtual_reserve0: 500_000,
            virtual_reserve1: 50_000,
            enable0: true,
            enable1: true,
        }
        .data(),
        deal_dex_pair::accounts::AdminPair {
            authority: authority.pubkey(),
            config: pair_config,
            pair,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &authority,
        &[initialize_liquidity, set_virtual],
        &[],
    ));

    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_swap_orderbook::ID);
    let initialize_orderbook = Instruction::new_with_bytes(
        deal_swap_orderbook::ID,
        &deal_swap_orderbook::instruction::Initialize {
            treasury: treasury.pubkey(),
        }
        .data(),
        deal_swap_orderbook::accounts::Initialize {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let unpause_orderbook = Instruction::new_with_bytes(
        deal_swap_orderbook::ID,
        &deal_swap_orderbook::instruction::SetPaused { paused: false }.data(),
        deal_swap_orderbook::accounts::AdminConfig {
            authority: authority.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &authority,
        &[initialize_orderbook, unpause_orderbook],
        &[],
    ));

    let escrow_dc = get_associated_token_address(&config, &dc_mint);
    let escrow_other = get_associated_token_address(&config, &other_mint);
    let (sell_header, _) = Pubkey::find_program_address(
        &[QUEUE_HEADER_SEED, pair.as_ref(), &[SIDE_SELL_DC]],
        &deal_swap_orderbook::ID,
    );
    let (sell_page, _) = Pubkey::find_program_address(
        &[
            QUEUE_PAGE_SEED,
            pair.as_ref(),
            &[SIDE_SELL_DC],
            &0u32.to_le_bytes(),
        ],
        &deal_swap_orderbook::ID,
    );
    let (sell_order, _) = Pubkey::find_program_address(
        &[
            ORDER_SEED,
            pair.as_ref(),
            &[SIDE_SELL_DC],
            &0u64.to_le_bytes(),
        ],
        &deal_swap_orderbook::ID,
    );
    let place_sell = Instruction::new_with_bytes(
        deal_swap_orderbook::ID,
        &deal_swap_orderbook::instruction::PlaceSellDc {
            sequence: 0,
            page_no: 0,
            amount_dc_in: 10_000,
        }
        .data(),
        deal_swap_orderbook::accounts::PlaceSellDc {
            user: user.pubkey(),
            config,
            pair_config,
            pair,
            header: sell_header,
            page: sell_page,
            order: sell_order,
            source_dc: user_dc,
            destination_other: user_other,
            escrow_dc,
            dc_mint,
            other_mint,
            dc_token_program: spl_token_interface::ID,
            other_token_program: spl_token_interface::ID,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &user, &[place_sell], &[]));
    assert_eq!(token_balance(&svm, user_dc), 10_000);
    assert_eq!(token_balance(&svm, escrow_dc), 10_000);

    let settle_sell = Instruction::new_with_bytes(
        deal_swap_orderbook::ID,
        &deal_swap_orderbook::instruction::SettleSellDc {}.data(),
        deal_swap_orderbook::accounts::SettleSellDc {
            keeper: keeper.pubkey(),
            config,
            pair_program: deal_dex_pair::ID,
            pair_config,
            pair,
            order: sell_order,
            header: sell_header,
            escrow_dc,
            destination_other: user_other,
            dc_mint,
            other_mint,
            vault0,
            vault1,
            dc_token_program: spl_token_interface::ID,
            other_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &keeper, &[settle_sell], &[]));
    let settled: Order = deserialize(&svm, sell_order);
    assert!(!settled.active);
    assert_eq!(settled.remaining_in, 0);
    assert_eq!(token_balance(&svm, escrow_dc), 0);
    assert!(token_balance(&svm, user_other) > 20_000);
    let sell_header_state: QueueHeader = deserialize(&svm, sell_header);
    assert_eq!(sell_header_state.open_orders, 0);

    let (buy_header, _) = Pubkey::find_program_address(
        &[QUEUE_HEADER_SEED, pair.as_ref(), &[SIDE_BUY_DC]],
        &deal_swap_orderbook::ID,
    );
    let (buy_page, _) = Pubkey::find_program_address(
        &[
            QUEUE_PAGE_SEED,
            pair.as_ref(),
            &[SIDE_BUY_DC],
            &0u32.to_le_bytes(),
        ],
        &deal_swap_orderbook::ID,
    );
    let (buy_order, _) = Pubkey::find_program_address(
        &[
            ORDER_SEED,
            pair.as_ref(),
            &[SIDE_BUY_DC],
            &0u64.to_le_bytes(),
        ],
        &deal_swap_orderbook::ID,
    );
    let other_before = token_balance(&svm, user_other);
    let place_buy = Instruction::new_with_bytes(
        deal_swap_orderbook::ID,
        &deal_swap_orderbook::instruction::PlaceBuyDc {
            sequence: 0,
            page_no: 0,
            amount_other_in: 2_000,
        }
        .data(),
        deal_swap_orderbook::accounts::PlaceBuyDc {
            user: user.pubkey(),
            config,
            pair_config,
            pair,
            header: buy_header,
            page: buy_page,
            order: buy_order,
            source_other: user_other,
            destination_dc: user_dc,
            escrow_other,
            dc_mint,
            other_mint,
            dc_token_program: spl_token_interface::ID,
            other_token_program: spl_token_interface::ID,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &user, &[place_buy], &[]));
    assert_eq!(token_balance(&svm, user_other), other_before - 2_000);
    assert_eq!(token_balance(&svm, escrow_other), 2_000);

    let cancel_buy = Instruction::new_with_bytes(
        deal_swap_orderbook::ID,
        &deal_swap_orderbook::instruction::CancelBuyDc {}.data(),
        deal_swap_orderbook::accounts::CancelBuyDc {
            owner: user.pubkey(),
            config,
            pair,
            order: buy_order,
            header: buy_header,
            escrow_other,
            refund_other: user_other,
            treasury_other,
            other_mint,
            other_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &user, &[cancel_buy], &[]));
    let canceled: Order = deserialize(&svm, buy_order);
    assert!(!canceled.active);
    assert_eq!(canceled.remaining_in, 0);
    assert_eq!(token_balance(&svm, escrow_other), 0);
    assert_eq!(token_balance(&svm, user_other), other_before - 2);
    assert_eq!(token_balance(&svm, treasury_other), 2);
}
