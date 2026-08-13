use anchor_lang::{
    prelude::{AccountSerialize, AnchorDeserialize, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_dex_pair::{PairState, PAIR_SEED};
use deal_dex_quoter::{DoubleHopQuote, SingleHopQuote};
use litesvm::{types::TransactionMetadata, LiteSVM};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    instruction: Instruction,
) -> Result<TransactionMetadata, String> {
    let blockhash = svm.latest_blockhash();
    let message = Message::new_with_blockhash(&[instruction], Some(&payer.pubkey()), &blockhash);
    let transaction =
        VersionedTransaction::try_new(VersionedMessage::Legacy(message), &[payer]).unwrap();
    let result = svm
        .send_transaction(transaction)
        .map_err(|error| format!("{error:?}"));
    svm.expire_blockhash();
    result
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
            lamports: 5_000_000,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn pair_state(dc_mint: Pubkey, other_mint: Pubkey, bump: u8) -> PairState {
    PairState {
        dc_mint,
        other_mint,
        dc_token_program: Pubkey::new_unique(),
        other_token_program: Pubkey::new_unique(),
        vault0: Pubkey::new_unique(),
        vault1: Pubkey::new_unique(),
        reserve0: 500_000,
        reserve1: 50_000,
        virtual_reserve0: 500_000,
        virtual_reserve1: 50_000,
        price0_cumulative: 0,
        price1_cumulative: 0,
        last_timestamp: 0,
        fee_numerator: 3,
        fee_denominator: 1_000,
        virtual0_enabled: true,
        virtual1_enabled: true,
        liquidity_initialized: true,
        bump,
    }
}

#[test]
fn returns_single_and_double_hop_quotes_from_canonical_pair_accounts() {
    let mut svm = LiteSVM::new();
    svm.add_program(
        deal_dex_quoter::ID,
        include_bytes!("../../../target/deploy/deal_dex_quoter.so"),
    )
    .unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();

    let dc_mint = Pubkey::new_unique();
    let other_a = Pubkey::new_unique();
    let other_b = Pubkey::new_unique();
    let (pair_a, bump_a) =
        Pubkey::find_program_address(&[PAIR_SEED, other_a.as_ref()], &deal_dex_pair::ID);
    let (pair_b, bump_b) =
        Pubkey::find_program_address(&[PAIR_SEED, other_b.as_ref()], &deal_dex_pair::ID);
    set_anchor_account(
        &mut svm,
        pair_a,
        deal_dex_pair::ID,
        &pair_state(dc_mint, other_a, bump_a),
    );
    set_anchor_account(
        &mut svm,
        pair_b,
        deal_dex_pair::ID,
        &pair_state(dc_mint, other_b, bump_b),
    );

    let single = Instruction::new_with_bytes(
        deal_dex_quoter::ID,
        &deal_dex_quoter::instruction::QuoteExactOtherForDc {
            amount_other_in: 1_000,
        }
        .data(),
        deal_dex_quoter::accounts::QuoteSinglePair { pair: pair_a }.to_account_metas(None),
    );
    let metadata = send(&mut svm, &payer, single).expect("single-hop quote must execute");
    assert_eq!(metadata.return_data.program_id, deal_dex_quoter::ID);
    let quote = SingleHopQuote::deserialize(&mut metadata.return_data.data.as_slice()).unwrap();
    assert_eq!(quote.amount_in, 1_000);
    assert_eq!(quote.amount_out, 9_871);
    assert_eq!(quote.dc_gross, 9_900);
    assert_eq!(quote.dc_fee, 29);

    let double = Instruction::new_with_bytes(
        deal_dex_quoter::ID,
        &deal_dex_quoter::instruction::QuoteExactOtherForOtherViaDc { amount_a_in: 1_000 }.data(),
        deal_dex_quoter::accounts::QuoteTwoPairs { pair_a, pair_b }.to_account_metas(None),
    );
    let metadata = send(&mut svm, &payer, double).expect("double-hop quote must execute");
    let quote = DoubleHopQuote::deserialize(&mut metadata.return_data.data.as_slice()).unwrap();
    assert_eq!(quote.amount_a_in, 1_000);
    assert_eq!(quote.dc_gross, 9_900);
    assert_eq!(quote.dc_used, 9_871);
    assert_eq!(quote.fee_buy_dc, 29);
    assert_eq!(quote.fee_sell_dc, 29);
    assert!(quote.amount_b_out > 0);
    assert_eq!(quote.dc_refund, 0);

    let fake_pair = Pubkey::new_unique();
    set_anchor_account(
        &mut svm,
        fake_pair,
        deal_dex_pair::ID,
        &pair_state(dc_mint, other_a, 0),
    );
    let forged = Instruction::new_with_bytes(
        deal_dex_quoter::ID,
        &deal_dex_quoter::instruction::QuoteExactOtherForDc {
            amount_other_in: 1_000,
        }
        .data(),
        deal_dex_quoter::accounts::QuoteSinglePair { pair: fake_pair }.to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, forged).is_err());
}
