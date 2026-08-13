use anchor_lang::{
    prelude::{AccountDeserialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use anchor_spl::associated_token::get_associated_token_address;
use deal_dex_pair::{quote_buy_given_net, quote_sell_given_out, PairState, CONFIG_SEED, PAIR_SEED};
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
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &signers).unwrap();
    let result = match svm.send_transaction(tx) {
        Ok(_) => true,
        Err(error) => {
            eprintln!("transaction failed: {error:?}");
            false
        }
    };
    svm.expire_blockhash();
    result
}

fn deserialize<T: AccountDeserialize>(svm: &LiteSVM, address: &Pubkey) -> T {
    let account = svm.get_account(address).expect("account must exist");
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

fn mint_supply(svm: &LiteSVM, address: Pubkey) -> u64 {
    let account = svm.get_account(&address).expect("mint must exist");
    Mint::unpack(&account.data).unwrap().supply
}

fn sell_quote(pair: &PairState, amount0_in: u64) -> (u64, u64) {
    let fee = amount0_in * u64::from(pair.fee_numerator) / u64::from(pair.fee_denominator);
    let effective_in = amount0_in - fee;
    let effective0 = pair.reserve0
        + if pair.virtual0_enabled {
            pair.virtual_reserve0
        } else {
            0
        };
    let effective1 = pair.reserve1
        + if pair.virtual1_enabled {
            pair.virtual_reserve1
        } else {
            0
        };
    let out = (u128::from(effective1) * u128::from(effective_in)
        / u128::from(effective0 + effective_in)) as u64;
    (fee, out)
}

#[test]
fn real_swaps_burn_dc_and_respect_slippage_with_virtual_reserves() {
    let mut svm = LiteSVM::new();
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: NOW,
        epoch: 1,
        leader_schedule_epoch: 1,
        unix_timestamp: NOW,
    });
    svm.add_program(
        deal_dex_pair::id(),
        include_bytes!("../../../target/deploy/deal_compact_exchange.so"),
    )
    .unwrap();

    let authority = Keypair::new();
    let user = Keypair::new();
    for wallet in [&authority, &user] {
        svm.airdrop(&wallet.pubkey(), 10_000_000_000).unwrap();
    }

    let dc_mint = Pubkey::new_unique();
    let other_mint = Pubkey::new_unique();
    let authority_dc = Pubkey::new_unique();
    let authority_other = Pubkey::new_unique();
    let user_dc = Pubkey::new_unique();
    let user_other = Pubkey::new_unique();
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

    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_dex_pair::id());
    let (pair, _) =
        Pubkey::find_program_address(&[PAIR_SEED, other_mint.as_ref()], &deal_dex_pair::id());
    let vault0 = get_associated_token_address(&pair, &dc_mint);
    let vault1 = get_associated_token_address(&pair, &other_mint);

    let initialize = Instruction::new_with_bytes(
        deal_dex_pair::id(),
        &deal_dex_pair::instruction::Initialize {}.data(),
        deal_dex_pair::accounts::Initialize {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            dc_mint,
            dc_token_program: spl_token_interface::ID,
            config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let unpause = Instruction::new_with_bytes(
        deal_dex_pair::id(),
        &deal_dex_pair::instruction::SetPaused { paused: false }.data(),
        deal_dex_pair::accounts::AdminConfig {
            authority: authority.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[initialize, unpause], &[]));

    let create_pair = Instruction::new_with_bytes(
        deal_dex_pair::id(),
        &deal_dex_pair::instruction::CreatePair {
            fee_numerator: 3,
            fee_denominator: 1_000,
        }
        .data(),
        deal_dex_pair::accounts::CreatePair {
            authority: authority.pubkey(),
            config,
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
        deal_dex_pair::id(),
        &deal_dex_pair::instruction::InitializeLiquidity {
            amount0: 500_000,
            amount1: 50_000,
        }
        .data(),
        deal_dex_pair::accounts::InitializeLiquidity {
            authority: authority.pubkey(),
            config,
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
        deal_dex_pair::id(),
        &deal_dex_pair::instruction::SetVirtualReserves {
            virtual_reserve0: 500_000,
            virtual_reserve1: 50_000,
            enable0: true,
            enable1: true,
        }
        .data(),
        deal_dex_pair::accounts::AdminPair {
            authority: authority.pubkey(),
            config,
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

    let pair_state = deserialize::<PairState>(&svm, &pair);
    assert_eq!(pair_state.reserve0, 500_000);
    assert_eq!(pair_state.reserve1, 50_000);
    assert_eq!(token_balance(&svm, vault0), 500_000);
    assert_eq!(token_balance(&svm, vault1), 50_000);

    let buy = Instruction::new_with_bytes(
        deal_dex_pair::id(),
        &deal_dex_pair::instruction::SwapBuyDc {
            amount1_in: 1_000,
            minimum0_out: 9_871,
        }
        .data(),
        deal_dex_pair::accounts::SwapBuyDc {
            user: user.pubkey(),
            config,
            pair,
            user_other,
            user_dc,
            dc_mint,
            other_mint,
            vault0,
            vault1,
            dc_token_program: spl_token_interface::ID,
            other_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &user, &[buy], &[]));
    assert_eq!(token_balance(&svm, user_other), 19_000);
    assert_eq!(token_balance(&svm, user_dc), 29_871);
    assert_eq!(token_balance(&svm, vault0), 490_100);
    assert_eq!(token_balance(&svm, vault1), 51_000);
    assert_eq!(mint_supply(&svm, dc_mint), 519_971);

    let pair_after_buy = deserialize::<PairState>(&svm, &pair);
    assert_eq!(pair_after_buy.reserve0, 490_100);
    assert_eq!(pair_after_buy.reserve1, 51_000);
    let (sell_fee, sell_out) = sell_quote(&pair_after_buy, 10_000);
    let sell = Instruction::new_with_bytes(
        deal_dex_pair::id(),
        &deal_dex_pair::instruction::SwapSellDc {
            amount0_in: 10_000,
            minimum1_out: sell_out,
        }
        .data(),
        deal_dex_pair::accounts::SwapSellDc {
            user: user.pubkey(),
            config,
            pair,
            user_dc,
            user_other,
            dc_mint,
            other_mint,
            vault0,
            vault1,
            dc_token_program: spl_token_interface::ID,
            other_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &user, &[sell], &[]));
    assert_eq!(sell_fee, 30);
    assert_eq!(token_balance(&svm, user_dc), 19_871);
    assert_eq!(token_balance(&svm, user_other), 19_000 + sell_out);
    assert_eq!(token_balance(&svm, vault0), 500_070);
    assert_eq!(token_balance(&svm, vault1), 51_000 - sell_out);
    assert_eq!(mint_supply(&svm, dc_mint), 519_941);

    let balances_before = (
        token_balance(&svm, user_dc),
        token_balance(&svm, user_other),
        token_balance(&svm, vault0),
        token_balance(&svm, vault1),
        mint_supply(&svm, dc_mint),
    );
    let rejected = Instruction::new_with_bytes(
        deal_dex_pair::id(),
        &deal_dex_pair::instruction::SwapBuyDc {
            amount1_in: 100,
            minimum0_out: u64::MAX,
        }
        .data(),
        deal_dex_pair::accounts::SwapBuyDc {
            user: user.pubkey(),
            config,
            pair,
            user_other,
            user_dc,
            dc_mint,
            other_mint,
            vault0,
            vault1,
            dc_token_program: spl_token_interface::ID,
            other_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    assert!(!send(&mut svm, &user, &[rejected], &[]));
    assert_eq!(
        balances_before,
        (
            token_balance(&svm, user_dc),
            token_balance(&svm, user_other),
            token_balance(&svm, vault0),
            token_balance(&svm, vault1),
            mint_supply(&svm, dc_mint),
        )
    );

    let donate = spl_token_interface::instruction::transfer_checked(
        &spl_token_interface::ID,
        &user_dc,
        &dc_mint,
        &vault0,
        &user.pubkey(),
        &[],
        100,
        0,
    )
    .unwrap();
    assert!(send(&mut svm, &user, &[donate], &[]));
    assert_eq!(token_balance(&svm, vault0), 500_170);

    let blocked_by_unsynced_donation = Instruction::new_with_bytes(
        deal_dex_pair::id(),
        &deal_dex_pair::instruction::SwapBuyDc {
            amount1_in: 100,
            minimum0_out: 0,
        }
        .data(),
        deal_dex_pair::accounts::SwapBuyDc {
            user: user.pubkey(),
            config,
            pair,
            user_other,
            user_dc,
            dc_mint,
            other_mint,
            vault0,
            vault1,
            dc_token_program: spl_token_interface::ID,
            other_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    assert!(!send(
        &mut svm,
        &user,
        std::slice::from_ref(&blocked_by_unsynced_donation),
        &[],
    ));

    let sync = Instruction::new_with_bytes(
        deal_dex_pair::id(),
        &deal_dex_pair::instruction::SyncDonations {}.data(),
        deal_dex_pair::accounts::SyncDonations {
            config,
            pair,
            dc_mint,
            other_mint,
            vault0,
            vault1,
            dc_token_program: spl_token_interface::ID,
            other_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &user, &[sync], &[]));
    assert_eq!(token_balance(&svm, vault0), 500_070);
    assert_eq!(mint_supply(&svm, dc_mint), 519_841);
    assert_eq!(
        deserialize::<PairState>(&svm, &pair).reserve0,
        token_balance(&svm, vault0)
    );
    assert!(send(
        &mut svm,
        &user,
        std::slice::from_ref(&blocked_by_unsynced_donation),
        &[],
    ));

    let pair_before_exact_buy = deserialize::<PairState>(&svm, &pair);
    let (_, exact_buy_fee, exact_buy_net, exact_other_in) =
        quote_buy_given_net(&pair_before_exact_buy, 500).unwrap();
    let exact_buy = Instruction::new_with_bytes(
        deal_dex_pair::id(),
        &deal_dex_pair::instruction::SwapOtherForExactDc {
            net0_target: 500,
            maximum1_in: exact_other_in,
        }
        .data(),
        deal_dex_pair::accounts::SwapBuyDc {
            user: user.pubkey(),
            config,
            pair,
            user_other,
            user_dc,
            dc_mint,
            other_mint,
            vault0,
            vault1,
            dc_token_program: spl_token_interface::ID,
            other_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    let user_dc_before = token_balance(&svm, user_dc);
    let user_other_before = token_balance(&svm, user_other);
    let supply_before = mint_supply(&svm, dc_mint);
    assert!(send(&mut svm, &user, &[exact_buy], &[]));
    assert_eq!(
        token_balance(&svm, user_other),
        user_other_before - exact_other_in
    );
    assert_eq!(token_balance(&svm, user_dc), user_dc_before + exact_buy_net);
    assert_eq!(mint_supply(&svm, dc_mint), supply_before - exact_buy_fee);

    let pair_before_exact_sell = deserialize::<PairState>(&svm, &pair);
    let (exact_dc_in, exact_sell_fee, _) =
        quote_sell_given_out(&pair_before_exact_sell, 50).unwrap();
    let exact_sell = |maximum0_in| {
        Instruction::new_with_bytes(
            deal_dex_pair::id(),
            &deal_dex_pair::instruction::SwapDcForExactOther {
                amount1_target: 50,
                maximum0_in,
            }
            .data(),
            deal_dex_pair::accounts::SwapSellDc {
                user: user.pubkey(),
                config,
                pair,
                user_dc,
                user_other,
                dc_mint,
                other_mint,
                vault0,
                vault1,
                dc_token_program: spl_token_interface::ID,
                other_token_program: spl_token_interface::ID,
            }
            .to_account_metas(None),
        )
    };
    let balances_before_exact_sell = (
        token_balance(&svm, user_dc),
        token_balance(&svm, user_other),
        mint_supply(&svm, dc_mint),
    );
    assert!(!send(&mut svm, &user, &[exact_sell(exact_dc_in - 1)], &[],));
    assert_eq!(
        balances_before_exact_sell,
        (
            token_balance(&svm, user_dc),
            token_balance(&svm, user_other),
            mint_supply(&svm, dc_mint),
        )
    );
    assert!(send(&mut svm, &user, &[exact_sell(exact_dc_in)], &[],));
    assert_eq!(
        token_balance(&svm, user_dc),
        balances_before_exact_sell.0 - exact_dc_in
    );
    assert_eq!(
        token_balance(&svm, user_other),
        balances_before_exact_sell.1 + 50
    );
    assert_eq!(
        mint_supply(&svm, dc_mint),
        balances_before_exact_sell.2 - exact_sell_fee
    );
}
