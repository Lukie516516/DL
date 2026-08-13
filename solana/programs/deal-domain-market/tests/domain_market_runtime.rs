use anchor_lang::{
    prelude::{AccountDeserialize, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use anchor_spl::associated_token::get_associated_token_address;
use deal_domain_market::{
    DomainListing, MarketConfig, CONFIG_SEED as MARKET_CONFIG_SEED, LISTING_SEED,
};
use deal_domain_registry::{
    DomainConfig, DomainRecord, CONFIG_SEED as REGISTRY_CONFIG_SEED, DOMAIN_ID_SEED,
    DOMAIN_MINT_SEED, DOMAIN_SEED,
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

fn set_mint(svm: &mut LiteSVM, mint: Pubkey, authority: Pubkey, decimals: u8, supply: u64) {
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

fn deserialize<T: AccountDeserialize>(svm: &LiteSVM, address: Pubkey) -> T {
    let account = svm.get_account(&address).expect("account must exist");
    T::try_deserialize(&mut account.data.as_slice()).unwrap()
}

struct DomainAddresses {
    domain: Pubkey,
    mint: Pubkey,
    owner_token: Pubkey,
}

#[allow(clippy::too_many_arguments)]
fn register_domain(
    svm: &mut LiteSVM,
    owner: &Keypair,
    registry_config: Pubkey,
    dc_mint: Pubkey,
    owner_dc: Pubkey,
    treasury_dc: Pubkey,
    label: &str,
    id: u64,
) -> DomainAddresses {
    let (domain, _) = Pubkey::find_program_address(
        &[DOMAIN_SEED, label.as_bytes()],
        &deal_domain_registry::id(),
    );
    let (mint, _) = Pubkey::find_program_address(
        &[DOMAIN_MINT_SEED, label.as_bytes()],
        &deal_domain_registry::id(),
    );
    let (id_map, _) = Pubkey::find_program_address(
        &[DOMAIN_ID_SEED, &id.to_le_bytes()],
        &deal_domain_registry::id(),
    );
    let owner_token = get_associated_token_address(&owner.pubkey(), &mint);
    let register = Instruction::new_with_bytes(
        deal_domain_registry::id(),
        &deal_domain_registry::instruction::Register {
            label: label.to_string(),
            expected_id: id,
        }
        .data(),
        deal_domain_registry::accounts::Register {
            config: registry_config,
            owner: owner.pubkey(),
            owner_dc,
            treasury_dc,
            dc_mint,
            dc_token_program: spl_token_interface::ID,
            domain_mint: mint,
            owner_domain: owner_token,
            domain,
            id_map,
            domain_token_program: spl_token_interface::ID,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(svm, owner, &[register], &[]));
    DomainAddresses {
        domain,
        mint,
        owner_token,
    }
}

#[test]
fn escrows_sells_and_delists_domains_with_real_token_movements() {
    let mut svm = LiteSVM::new();
    svm.add_program(
        deal_domain_registry::id(),
        include_bytes!("../../../target/deploy/deal_domain_registry.so"),
    )
    .unwrap();
    svm.add_program(
        deal_domain_market::id(),
        include_bytes!("../../../target/deploy/deal_domain_market.so"),
    )
    .unwrap();

    let authority = Keypair::new();
    let seller = Keypair::new();
    let buyer = Keypair::new();
    let wrong_buyer = Keypair::new();
    let treasury = Keypair::new();
    let fee_recipient = Keypair::new();
    for wallet in [
        &authority,
        &seller,
        &buyer,
        &wrong_buyer,
        &treasury,
        &fee_recipient,
    ] {
        svm.airdrop(&wallet.pubkey(), 30_000_000_000).unwrap();
    }

    let dc_mint = Pubkey::new_unique();
    let payment_mint = Pubkey::new_unique();
    let seller_dc = Pubkey::new_unique();
    let treasury_dc = Pubkey::new_unique();
    let buyer_payment = Pubkey::new_unique();
    let wrong_buyer_payment = Pubkey::new_unique();
    let seller_payment = Pubkey::new_unique();
    let fee_payment = Pubkey::new_unique();
    set_mint(&mut svm, dc_mint, authority.pubkey(), 6, 10_000_000);
    set_mint(&mut svm, payment_mint, authority.pubkey(), 6, 20_000_000);
    set_token_account(&mut svm, seller_dc, dc_mint, seller.pubkey(), 2_000_000);
    set_token_account(&mut svm, treasury_dc, dc_mint, treasury.pubkey(), 0);
    set_token_account(
        &mut svm,
        buyer_payment,
        payment_mint,
        buyer.pubkey(),
        10_000_000,
    );
    set_token_account(
        &mut svm,
        wrong_buyer_payment,
        payment_mint,
        wrong_buyer.pubkey(),
        10_000_000,
    );
    set_token_account(&mut svm, seller_payment, payment_mint, seller.pubkey(), 0);
    set_token_account(
        &mut svm,
        fee_payment,
        payment_mint,
        fee_recipient.pubkey(),
        0,
    );

    let (registry_config, _) =
        Pubkey::find_program_address(&[REGISTRY_CONFIG_SEED], &deal_domain_registry::id());
    let (market_config, _) =
        Pubkey::find_program_address(&[MARKET_CONFIG_SEED], &deal_domain_market::id());
    let initialize_registry = Instruction::new_with_bytes(
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
            config: registry_config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    let initialize_market = Instruction::new_with_bytes(
        deal_domain_market::id(),
        &deal_domain_market::instruction::Initialize {
            domain_registry_program: deal_domain_registry::id(),
            domain_registry_config: registry_config,
            payment_mint,
            fee_recipient: fee_recipient.pubkey(),
            fee_bps: 250,
        }
        .data(),
        deal_domain_market::accounts::Initialize {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            config: market_config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &authority,
        &[initialize_registry, initialize_market],
        &[],
    ));

    let set_market = Instruction::new_with_bytes(
        deal_domain_registry::id(),
        &deal_domain_registry::instruction::SetDomainMarket {
            domain_market: market_config,
        }
        .data(),
        deal_domain_registry::accounts::AdminConfig {
            authority: authority.pubkey(),
            config: registry_config,
        }
        .to_account_metas(None),
    );
    let unpause_registry = Instruction::new_with_bytes(
        deal_domain_registry::id(),
        &deal_domain_registry::instruction::SetPaused { paused: false }.data(),
        deal_domain_registry::accounts::AdminConfig {
            authority: authority.pubkey(),
            config: registry_config,
        }
        .to_account_metas(None),
    );
    let unpause_market = Instruction::new_with_bytes(
        deal_domain_market::id(),
        &deal_domain_market::instruction::SetPaused { paused: false }.data(),
        deal_domain_market::accounts::AdminConfig {
            authority: authority.pubkey(),
            config: market_config,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &authority,
        &[set_market, unpause_registry, unpause_market],
        &[],
    ));

    let registry_state: DomainConfig = deserialize(&svm, registry_config);
    let market_state: MarketConfig = deserialize(&svm, market_config);
    assert_eq!(registry_state.domain_market, market_config);
    assert_eq!(market_state.fee_bps, 250);
    assert!(!market_state.paused);

    let first = register_domain(
        &mut svm,
        &seller,
        registry_config,
        dc_mint,
        seller_dc,
        treasury_dc,
        "Sale01",
        1,
    );
    let market_domain = get_associated_token_address(&market_config, &first.mint);
    let (listing, _) = Pubkey::find_program_address(
        &[LISTING_SEED, first.domain.as_ref()],
        &deal_domain_market::id(),
    );
    let list = Instruction::new_with_bytes(
        deal_domain_market::id(),
        &deal_domain_market::instruction::List {
            price: 4_000_000,
            designated_buyer: buyer.pubkey(),
        }
        .data(),
        deal_domain_market::accounts::ListDomain {
            config: market_config,
            seller: seller.pubkey(),
            registry_program: deal_domain_registry::id(),
            registry_config,
            domain: first.domain,
            domain_mint: first.mint,
            seller_domain: first.owner_token,
            market_domain,
            listing,
            domain_token_program: spl_token_interface::ID,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &seller, &[list], &[]));
    let domain_state: DomainRecord = deserialize(&svm, first.domain);
    let listing_state: DomainListing = deserialize(&svm, listing);
    assert_eq!(domain_state.owner, seller.pubkey());
    assert_eq!(domain_state.escrow_market, market_config);
    assert_eq!(listing_state.designated_buyer, buyer.pubkey());
    assert_eq!(token_state(&svm, first.owner_token).amount, 0);
    assert_eq!(token_state(&svm, market_domain).amount, 1);
    assert_eq!(token_state(&svm, market_domain).state, AccountState::Frozen);

    let wrong_buyer_domain = get_associated_token_address(&wrong_buyer.pubkey(), &first.mint);
    let wrong_buy = Instruction::new_with_bytes(
        deal_domain_market::id(),
        &deal_domain_market::instruction::Buy {
            maximum_price: 4_000_000,
        }
        .data(),
        deal_domain_market::accounts::BuyDomain {
            config: market_config,
            buyer: wrong_buyer.pubkey(),
            seller: seller.pubkey(),
            registry_program: deal_domain_registry::id(),
            registry_config,
            domain: first.domain,
            domain_mint: first.mint,
            market_domain,
            buyer_domain: wrong_buyer_domain,
            listing,
            buyer_payment: wrong_buyer_payment,
            seller_payment,
            fee_payment,
            payment_mint,
            payment_token_program: spl_token_interface::ID,
            domain_token_program: spl_token_interface::ID,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(!send(&mut svm, &wrong_buyer, &[wrong_buy], &[]));
    assert_eq!(token_state(&svm, wrong_buyer_payment).amount, 10_000_000);

    let buyer_domain = get_associated_token_address(&buyer.pubkey(), &first.mint);
    let buy = Instruction::new_with_bytes(
        deal_domain_market::id(),
        &deal_domain_market::instruction::Buy {
            maximum_price: 4_000_000,
        }
        .data(),
        deal_domain_market::accounts::BuyDomain {
            config: market_config,
            buyer: buyer.pubkey(),
            seller: seller.pubkey(),
            registry_program: deal_domain_registry::id(),
            registry_config,
            domain: first.domain,
            domain_mint: first.mint,
            market_domain,
            buyer_domain,
            listing,
            buyer_payment,
            seller_payment,
            fee_payment,
            payment_mint,
            payment_token_program: spl_token_interface::ID,
            domain_token_program: spl_token_interface::ID,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &buyer, &[buy], &[]));
    let domain_state: DomainRecord = deserialize(&svm, first.domain);
    assert_eq!(domain_state.owner, buyer.pubkey());
    assert_eq!(domain_state.resolve, buyer.pubkey());
    assert_eq!(domain_state.escrow_market, Pubkey::default());
    assert_eq!(token_state(&svm, buyer_domain).amount, 1);
    assert_eq!(token_state(&svm, buyer_domain).state, AccountState::Frozen);
    assert_eq!(token_state(&svm, buyer_payment).amount, 6_000_000);
    assert_eq!(token_state(&svm, seller_payment).amount, 3_900_000);
    assert_eq!(token_state(&svm, fee_payment).amount, 100_000);
    assert!(svm.get_account(&listing).is_none());

    let second = register_domain(
        &mut svm,
        &seller,
        registry_config,
        dc_mint,
        seller_dc,
        treasury_dc,
        "Back02",
        2,
    );
    let second_market_domain = get_associated_token_address(&market_config, &second.mint);
    let second_seller_domain = get_associated_token_address(&seller.pubkey(), &second.mint);
    let (second_listing, _) = Pubkey::find_program_address(
        &[LISTING_SEED, second.domain.as_ref()],
        &deal_domain_market::id(),
    );
    let second_list = Instruction::new_with_bytes(
        deal_domain_market::id(),
        &deal_domain_market::instruction::List {
            price: 1_000_000,
            designated_buyer: Pubkey::default(),
        }
        .data(),
        deal_domain_market::accounts::ListDomain {
            config: market_config,
            seller: seller.pubkey(),
            registry_program: deal_domain_registry::id(),
            registry_config,
            domain: second.domain,
            domain_mint: second.mint,
            seller_domain: second.owner_token,
            market_domain: second_market_domain,
            listing: second_listing,
            domain_token_program: spl_token_interface::ID,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &seller, &[second_list], &[]));
    let delist = Instruction::new_with_bytes(
        deal_domain_market::id(),
        &deal_domain_market::instruction::Delist {}.data(),
        deal_domain_market::accounts::DelistDomain {
            config: market_config,
            seller: seller.pubkey(),
            registry_program: deal_domain_registry::id(),
            registry_config,
            domain: second.domain,
            domain_mint: second.mint,
            market_domain: second_market_domain,
            seller_domain: second_seller_domain,
            listing: second_listing,
            domain_token_program: spl_token_interface::ID,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &seller, &[delist], &[]));
    let second_state: DomainRecord = deserialize(&svm, second.domain);
    assert_eq!(second_state.owner, seller.pubkey());
    assert_eq!(second_state.escrow_market, Pubkey::default());
    assert_eq!(token_state(&svm, second_seller_domain).amount, 1);
    assert!(svm.get_account(&second_listing).is_none());
}
