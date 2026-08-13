use anchor_lang::{
    prelude::{AccountDeserialize, Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use anchor_spl::associated_token::get_associated_token_address;
use deal_dex_pair::{
    quote_buy_given_in, quote_buy_given_net, quote_sell, quote_sell_given_out, PairState,
    CONFIG_SEED as PAIR_CONFIG_SEED, PAIR_SEED,
};
use deal_dex_router::CONFIG_SEED as ROUTER_CONFIG_SEED;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction::versioned::VersionedTransaction;
use spl_token_interface::state::{Account as TokenAccount, AccountState, Mint};
use spl_token_interface::{instruction as token_instruction, native_mint};

const NOW: i64 = 1_700_000_000;

struct PairEnv {
    pair: Pubkey,
    vault_dc: Pubkey,
    vault_other: Pubkey,
}

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

fn set_mint(svm: &mut LiteSVM, mint: Pubkey, authority: Pubkey, supply: u64) {
    set_mint_with_decimals(svm, mint, authority, supply, 0);
}

fn set_mint_with_decimals(
    svm: &mut LiteSVM,
    mint: Pubkey,
    authority: Pubkey,
    supply: u64,
    decimals: u8,
) {
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

fn set_native_token_account(svm: &mut LiteSVM, address: Pubkey, owner: Pubkey, amount: u64) {
    let rent_reserve = svm.minimum_balance_for_rent_exemption(TokenAccount::LEN);
    let state = TokenAccount {
        mint: native_mint::ID,
        owner,
        amount,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::Some(rent_reserve),
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let mut data = vec![0u8; TokenAccount::LEN];
    TokenAccount::pack(state, &mut data).unwrap();
    svm.set_account(
        address,
        Account {
            lamports: rent_reserve + amount,
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

#[allow(clippy::too_many_arguments)]
fn create_and_initialize_pair(
    svm: &mut LiteSVM,
    authority: &Keypair,
    pair_config: Pubkey,
    dc_mint: Pubkey,
    other_mint: Pubkey,
    source_dc: Pubkey,
    source_other: Pubkey,
    amount_dc: u64,
    amount_other: u64,
) -> PairEnv {
    let (pair, _) =
        Pubkey::find_program_address(&[PAIR_SEED, other_mint.as_ref()], &deal_dex_pair::id());
    let vault_dc = get_associated_token_address(&pair, &dc_mint);
    let vault_other = get_associated_token_address(&pair, &other_mint);
    let create = Instruction::new_with_bytes(
        deal_dex_pair::id(),
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
            vault0: vault_dc,
            vault1: vault_other,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let initialize = Instruction::new_with_bytes(
        deal_dex_pair::id(),
        &deal_dex_pair::instruction::InitializeLiquidity {
            amount0: amount_dc,
            amount1: amount_other,
        }
        .data(),
        deal_dex_pair::accounts::InitializeLiquidity {
            authority: authority.pubkey(),
            config: pair_config,
            pair,
            source0: source_dc,
            source1: source_other,
            dc_mint,
            other_mint,
            vault0: vault_dc,
            vault1: vault_other,
            dc_token_program: spl_token_interface::ID,
            other_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(svm, authority, &[create, initialize], &[]));
    PairEnv {
        pair,
        vault_dc,
        vault_other,
    }
}

#[test]
fn router_executes_atomic_double_hop_and_rejects_expired_or_bad_slippage() {
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
    svm.add_program(
        deal_dex_router::id(),
        include_bytes!("../../../target/deploy/deal_compact_exchange.so"),
    )
    .unwrap();

    let authority = Keypair::new();
    let user = Keypair::new();
    for wallet in [&authority, &user] {
        svm.airdrop(&wallet.pubkey(), 20_000_000_000).unwrap();
    }

    let dc_mint = Pubkey::new_unique();
    let mint_a = Pubkey::new_unique();
    let mint_b = Pubkey::new_unique();
    let authority_dc_a = Pubkey::new_unique();
    let authority_dc_b = Pubkey::new_unique();
    let authority_a = Pubkey::new_unique();
    let authority_b = Pubkey::new_unique();
    let user_dc = Pubkey::new_unique();
    let user_a = Pubkey::new_unique();
    let user_b = Pubkey::new_unique();
    set_mint(&mut svm, dc_mint, authority.pubkey(), 920_000);
    set_mint(&mut svm, mint_a, authority.pubkey(), 70_000);
    set_mint(&mut svm, mint_b, authority.pubkey(), 80_000);
    set_token_account(
        &mut svm,
        authority_dc_a,
        dc_mint,
        authority.pubkey(),
        500_000,
    );
    set_token_account(
        &mut svm,
        authority_dc_b,
        dc_mint,
        authority.pubkey(),
        400_000,
    );
    set_token_account(&mut svm, authority_a, mint_a, authority.pubkey(), 50_000);
    set_token_account(&mut svm, authority_b, mint_b, authority.pubkey(), 80_000);
    set_token_account(&mut svm, user_dc, dc_mint, user.pubkey(), 20_000);
    set_token_account(&mut svm, user_a, mint_a, user.pubkey(), 20_000);
    set_token_account(&mut svm, user_b, mint_b, user.pubkey(), 0);

    let (pair_config, _) = Pubkey::find_program_address(&[PAIR_CONFIG_SEED], &deal_dex_pair::id());
    let pair_initialize = Instruction::new_with_bytes(
        deal_dex_pair::id(),
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
    let pair_unpause = Instruction::new_with_bytes(
        deal_dex_pair::id(),
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
        &[pair_initialize, pair_unpause],
        &[],
    ));

    let pair_a = create_and_initialize_pair(
        &mut svm,
        &authority,
        pair_config,
        dc_mint,
        mint_a,
        authority_dc_a,
        authority_a,
        500_000,
        50_000,
    );
    let pair_b = create_and_initialize_pair(
        &mut svm,
        &authority,
        pair_config,
        dc_mint,
        mint_b,
        authority_dc_b,
        authority_b,
        400_000,
        80_000,
    );

    let (router_config, _) =
        Pubkey::find_program_address(&[ROUTER_CONFIG_SEED], &deal_dex_router::id());
    let router_initialize = Instruction::new_with_bytes(
        deal_dex_router::id(),
        &deal_dex_router::instruction::Initialize {}.data(),
        deal_dex_router::accounts::Initialize {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            dc_mint,
            config: router_config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let router_unpause = Instruction::new_with_bytes(
        deal_dex_router::id(),
        &deal_dex_router::instruction::SetPaused { paused: false }.data(),
        deal_dex_router::accounts::AdminConfig {
            authority: authority.pubkey(),
            config: router_config,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &authority,
        &[router_initialize, router_unpause],
        &[],
    ));

    let pair_a_before = deserialize::<PairState>(&svm, &pair_a.pair);
    let pair_b_before = deserialize::<PairState>(&svm, &pair_b.pair);
    let (dc_gross, fee_buy, dc_net) = quote_buy_given_in(&pair_a_before, 1_000).unwrap();
    let (fee_sell, _, b_out) = quote_sell(&pair_b_before, dc_net).unwrap();
    let route = |minimum_b_out: u64, deadline: i64| {
        Instruction::new_with_bytes(
            deal_dex_router::id(),
            &deal_dex_router::instruction::SwapExactOtherForOtherViaDc {
                amount_a_in: 1_000,
                minimum_b_out,
                deadline,
            }
            .data(),
            deal_dex_router::accounts::SwapExactOtherForOtherViaDc {
                user: user.pubkey(),
                config: router_config,
                pair_program: deal_dex_pair::id(),
                pair_config,
                pair_a: pair_a.pair,
                pair_b: pair_b.pair,
                user_a,
                user_dc,
                user_b,
                dc_mint,
                mint_a,
                mint_b,
                vault_a_dc: pair_a.vault_dc,
                vault_a_other: pair_a.vault_other,
                vault_b_dc: pair_b.vault_dc,
                vault_b_other: pair_b.vault_other,
                dc_token_program: spl_token_interface::ID,
                token_program_a: spl_token_interface::ID,
                token_program_b: spl_token_interface::ID,
            }
            .to_account_metas(None),
        )
    };

    assert_eq!(dc_gross, 9_803);
    assert!(send(&mut svm, &user, &[route(b_out, NOW + 60)], &[]));
    assert_eq!(token_balance(&svm, user_a), 19_000);
    assert_eq!(token_balance(&svm, user_dc), 20_000);
    assert_eq!(token_balance(&svm, user_b), b_out);
    assert_eq!(mint_supply(&svm, dc_mint), 920_000 - fee_buy - fee_sell);

    let pair_a_after_route = deserialize::<PairState>(&svm, &pair_a.pair);
    let (_, single_buy_fee, single_buy_net) = quote_buy_given_in(&pair_a_after_route, 100).unwrap();
    let single_buy = Instruction::new_with_bytes(
        deal_dex_router::id(),
        &deal_dex_router::instruction::SwapExactOtherForDc {
            amount_other_in: 100,
            minimum_dc_out: single_buy_net,
            deadline: NOW + 60,
        }
        .data(),
        deal_dex_router::accounts::SwapExactOtherForDc {
            user: user.pubkey(),
            config: router_config,
            pair_program: deal_dex_pair::id(),
            pair_config,
            pair: pair_a.pair,
            user_other: user_a,
            user_dc,
            dc_mint,
            other_mint: mint_a,
            vault0: pair_a.vault_dc,
            vault1: pair_a.vault_other,
            dc_token_program: spl_token_interface::ID,
            other_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &user, &[single_buy], &[]));
    assert_eq!(token_balance(&svm, user_a), 18_900);
    assert_eq!(token_balance(&svm, user_dc), 20_000 + single_buy_net);

    let pair_b_after_route = deserialize::<PairState>(&svm, &pair_b.pair);
    let (single_sell_fee, _, single_b_out) =
        quote_sell(&pair_b_after_route, single_buy_net).unwrap();
    let single_sell = Instruction::new_with_bytes(
        deal_dex_router::id(),
        &deal_dex_router::instruction::SwapExactDcForOther {
            amount_dc_in: single_buy_net,
            minimum_other_out: single_b_out,
            deadline: NOW + 60,
        }
        .data(),
        deal_dex_router::accounts::SwapExactDcForOther {
            user: user.pubkey(),
            config: router_config,
            pair_program: deal_dex_pair::id(),
            pair_config,
            pair: pair_b.pair,
            user_dc,
            user_other: user_b,
            dc_mint,
            other_mint: mint_b,
            vault0: pair_b.vault_dc,
            vault1: pair_b.vault_other,
            dc_token_program: spl_token_interface::ID,
            other_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &user, &[single_sell], &[]));
    assert_eq!(token_balance(&svm, user_dc), 20_000);
    assert_eq!(token_balance(&svm, user_b), b_out + single_b_out);
    assert_eq!(
        mint_supply(&svm, dc_mint),
        920_000 - fee_buy - fee_sell - single_buy_fee - single_sell_fee
    );

    let exact_b_target = 123;
    let pair_b_before_exact = deserialize::<PairState>(&svm, &pair_b.pair);
    let (required_dc, exact_sell_fee, _) =
        quote_sell_given_out(&pair_b_before_exact, exact_b_target).unwrap();
    let pair_a_before_exact = deserialize::<PairState>(&svm, &pair_a.pair);
    let (_, exact_buy_fee, actual_dc_out, required_a) =
        quote_buy_given_net(&pair_a_before_exact, required_dc).unwrap();
    let exact_route = |maximum_a_in| {
        Instruction::new_with_bytes(
            deal_dex_router::id(),
            &deal_dex_router::instruction::SwapOtherForExactOtherViaDc {
                exact_b_out: exact_b_target,
                maximum_a_in,
                deadline: NOW + 60,
            }
            .data(),
            deal_dex_router::accounts::SwapExactOtherForOtherViaDc {
                user: user.pubkey(),
                config: router_config,
                pair_program: deal_dex_pair::id(),
                pair_config,
                pair_a: pair_a.pair,
                pair_b: pair_b.pair,
                user_a,
                user_dc,
                user_b,
                dc_mint,
                mint_a,
                mint_b,
                vault_a_dc: pair_a.vault_dc,
                vault_a_other: pair_a.vault_other,
                vault_b_dc: pair_b.vault_dc,
                vault_b_other: pair_b.vault_other,
                dc_token_program: spl_token_interface::ID,
                token_program_a: spl_token_interface::ID,
                token_program_b: spl_token_interface::ID,
            }
            .to_account_metas(None),
        )
    };
    let before_exact = (
        token_balance(&svm, user_a),
        token_balance(&svm, user_dc),
        token_balance(&svm, user_b),
        mint_supply(&svm, dc_mint),
    );
    assert!(!send(&mut svm, &user, &[exact_route(required_a - 1)], &[],));
    assert_eq!(
        before_exact,
        (
            token_balance(&svm, user_a),
            token_balance(&svm, user_dc),
            token_balance(&svm, user_b),
            mint_supply(&svm, dc_mint),
        )
    );
    assert!(send(&mut svm, &user, &[exact_route(required_a)], &[],));
    assert_eq!(token_balance(&svm, user_a), before_exact.0 - required_a);
    assert_eq!(
        token_balance(&svm, user_dc),
        before_exact.1 + actual_dc_out - required_dc
    );
    assert_eq!(token_balance(&svm, user_b), before_exact.2 + exact_b_target);
    assert_eq!(
        mint_supply(&svm, dc_mint),
        before_exact.3 - exact_buy_fee - exact_sell_fee
    );

    let pair_a_before_single_exact = deserialize::<PairState>(&svm, &pair_a.pair);
    let (_, single_exact_buy_fee, single_exact_dc_out, single_exact_a_in) =
        quote_buy_given_net(&pair_a_before_single_exact, 100).unwrap();
    let single_exact_buy = Instruction::new_with_bytes(
        deal_dex_router::id(),
        &deal_dex_router::instruction::SwapOtherForExactDc {
            exact_dc_out: 100,
            maximum_other_in: single_exact_a_in,
            deadline: NOW + 60,
        }
        .data(),
        deal_dex_router::accounts::SwapExactOtherForDc {
            user: user.pubkey(),
            config: router_config,
            pair_program: deal_dex_pair::id(),
            pair_config,
            pair: pair_a.pair,
            user_other: user_a,
            user_dc,
            dc_mint,
            other_mint: mint_a,
            vault0: pair_a.vault_dc,
            vault1: pair_a.vault_other,
            dc_token_program: spl_token_interface::ID,
            other_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    let before_single_exact_buy = (
        token_balance(&svm, user_a),
        token_balance(&svm, user_dc),
        mint_supply(&svm, dc_mint),
    );
    assert!(send(&mut svm, &user, &[single_exact_buy], &[],));
    assert_eq!(
        token_balance(&svm, user_a),
        before_single_exact_buy.0 - single_exact_a_in
    );
    assert_eq!(
        token_balance(&svm, user_dc),
        before_single_exact_buy.1 + single_exact_dc_out
    );
    assert_eq!(
        mint_supply(&svm, dc_mint),
        before_single_exact_buy.2 - single_exact_buy_fee
    );

    let pair_b_before_single_exact = deserialize::<PairState>(&svm, &pair_b.pair);
    let (single_exact_dc_in, single_exact_sell_fee, _) =
        quote_sell_given_out(&pair_b_before_single_exact, 20).unwrap();
    let single_exact_sell = Instruction::new_with_bytes(
        deal_dex_router::id(),
        &deal_dex_router::instruction::SwapDcForExactOther {
            exact_other_out: 20,
            maximum_dc_in: single_exact_dc_in,
            deadline: NOW + 60,
        }
        .data(),
        deal_dex_router::accounts::SwapExactDcForOther {
            user: user.pubkey(),
            config: router_config,
            pair_program: deal_dex_pair::id(),
            pair_config,
            pair: pair_b.pair,
            user_dc,
            user_other: user_b,
            dc_mint,
            other_mint: mint_b,
            vault0: pair_b.vault_dc,
            vault1: pair_b.vault_other,
            dc_token_program: spl_token_interface::ID,
            other_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    let before_single_exact_sell = (
        token_balance(&svm, user_dc),
        token_balance(&svm, user_b),
        mint_supply(&svm, dc_mint),
    );
    assert!(send(&mut svm, &user, &[single_exact_sell], &[],));
    assert_eq!(
        token_balance(&svm, user_dc),
        before_single_exact_sell.0 - single_exact_dc_in
    );
    assert_eq!(token_balance(&svm, user_b), before_single_exact_sell.1 + 20);
    assert_eq!(
        mint_supply(&svm, dc_mint),
        before_single_exact_sell.2 - single_exact_sell_fee
    );

    let balances = (
        token_balance(&svm, user_a),
        token_balance(&svm, user_dc),
        token_balance(&svm, user_b),
        mint_supply(&svm, dc_mint),
    );
    assert!(!send(&mut svm, &user, &[route(u64::MAX, NOW + 60)], &[]));
    assert!(!send(&mut svm, &user, &[route(0, NOW - 1)], &[]));
    assert_eq!(
        balances,
        (
            token_balance(&svm, user_a),
            token_balance(&svm, user_dc),
            token_balance(&svm, user_b),
            mint_supply(&svm, dc_mint),
        )
    );
}

#[test]
fn router_wraps_swaps_and_unwraps_native_sol_atomically() {
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
    svm.add_program(
        deal_dex_router::id(),
        include_bytes!("../../../target/deploy/deal_compact_exchange.so"),
    )
    .unwrap();

    let authority = Keypair::new();
    let user = Keypair::new();
    for wallet in [&authority, &user] {
        svm.airdrop(&wallet.pubkey(), 20_000_000_000).unwrap();
    }

    let dc_mint = Pubkey::new_unique();
    let authority_dc = Pubkey::new_unique();
    let authority_wsol = Pubkey::new_unique();
    let user_dc = Pubkey::new_unique();
    let user_wsol = Pubkey::new_unique();
    set_mint(&mut svm, dc_mint, authority.pubkey(), 520_000);
    set_mint_with_decimals(
        &mut svm,
        native_mint::ID,
        Pubkey::default(),
        0,
        native_mint::DECIMALS,
    );
    set_token_account(&mut svm, authority_dc, dc_mint, authority.pubkey(), 500_000);
    set_native_token_account(&mut svm, authority_wsol, authority.pubkey(), 50_000);
    set_token_account(&mut svm, user_dc, dc_mint, user.pubkey(), 20_000);
    set_native_token_account(&mut svm, user_wsol, user.pubkey(), 0);

    let (pair_config, _) = Pubkey::find_program_address(&[PAIR_CONFIG_SEED], &deal_dex_pair::id());
    let pair_initialize = Instruction::new_with_bytes(
        deal_dex_pair::id(),
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
    let pair_unpause = Instruction::new_with_bytes(
        deal_dex_pair::id(),
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
        &[pair_initialize, pair_unpause],
        &[],
    ));
    let pair = create_and_initialize_pair(
        &mut svm,
        &authority,
        pair_config,
        dc_mint,
        native_mint::ID,
        authority_dc,
        authority_wsol,
        500_000,
        50_000,
    );

    let (router_config, _) =
        Pubkey::find_program_address(&[ROUTER_CONFIG_SEED], &deal_dex_router::id());
    let router_initialize = Instruction::new_with_bytes(
        deal_dex_router::id(),
        &deal_dex_router::instruction::Initialize {}.data(),
        deal_dex_router::accounts::Initialize {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            dc_mint,
            config: router_config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let router_unpause = Instruction::new_with_bytes(
        deal_dex_router::id(),
        &deal_dex_router::instruction::SetPaused { paused: false }.data(),
        deal_dex_router::accounts::AdminConfig {
            authority: authority.pubkey(),
            config: router_config,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &authority,
        &[router_initialize, router_unpause],
        &[],
    ));

    let amount_sol_in = 1_000;
    let pair_before = deserialize::<PairState>(&svm, &pair.pair);
    let (_, _, expected_dc_out) = quote_buy_given_in(&pair_before, amount_sol_in).unwrap();
    let wrap = system_instruction::transfer(&user.pubkey(), &user_wsol, amount_sol_in);
    let sync = token_instruction::sync_native(&spl_token_interface::ID, &user_wsol).unwrap();
    let swap = Instruction::new_with_bytes(
        deal_dex_router::id(),
        &deal_dex_router::instruction::SwapExactOtherForDc {
            amount_other_in: amount_sol_in,
            minimum_dc_out: expected_dc_out,
            deadline: NOW + 60,
        }
        .data(),
        deal_dex_router::accounts::SwapExactOtherForDc {
            user: user.pubkey(),
            config: router_config,
            pair_program: deal_dex_pair::id(),
            pair_config,
            pair: pair.pair,
            user_other: user_wsol,
            user_dc,
            dc_mint,
            other_mint: native_mint::ID,
            vault0: pair.vault_dc,
            vault1: pair.vault_other,
            dc_token_program: spl_token_interface::ID,
            other_token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
    );
    let unwrap = token_instruction::close_account(
        &spl_token_interface::ID,
        &user_wsol,
        &user.pubkey(),
        &user.pubkey(),
        &[],
    )
    .unwrap();

    assert!(send(&mut svm, &user, &[wrap, sync, swap, unwrap], &[]));
    assert_eq!(token_balance(&svm, user_dc), 20_000 + expected_dc_out);
    assert!(svm.get_account(&user_wsol).is_none());
}
