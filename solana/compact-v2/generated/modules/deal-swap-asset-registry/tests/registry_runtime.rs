use anchor_lang::{
    prelude::{AccountDeserialize, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use deal_swap_asset_registry::{SwapAssetRegistry, REGISTRY_SEED};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

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

fn deserialize_registry(svm: &LiteSVM, address: &Pubkey) -> SwapAssetRegistry {
    let account = svm.get_account(address).expect("registry must exist");
    SwapAssetRegistry::try_deserialize(&mut account.data.as_slice())
        .expect("registry must deserialize")
}

#[test]
fn governs_official_assets_and_derives_canonical_pairs() {
    let mut svm = LiteSVM::new();
    svm.add_program(
        deal_swap_asset_registry::id(),
        include_bytes!("../../../target/deploy/deal_compact_exchange.so"),
    )
    .unwrap();

    let payer = Keypair::new();
    let authority = Keypair::new();
    let pending = Keypair::new();
    let outsider = Keypair::new();
    for key in [&payer, &authority, &pending, &outsider] {
        svm.airdrop(&key.pubkey(), 3_000_000_000).unwrap();
    }

    let pair_program = Pubkey::new_unique();
    let router_program = Pubkey::new_unique();
    let dc_mint = Pubkey::new_unique();
    let wrapped_native_mint = Pubkey::new_unique();
    let stable0_mint = Pubkey::new_unique();
    let stable1_mint = Pubkey::new_unique();
    let (registry, _) =
        Pubkey::find_program_address(&[REGISTRY_SEED], &deal_swap_asset_registry::id());

    let initialize = Instruction::new_with_bytes(
        deal_swap_asset_registry::id(),
        &deal_swap_asset_registry::instruction::Initialize {
            pair_program,
            router_program,
            dc_mint,
            wrapped_native_mint,
            stable0_mint,
            stable1_mint,
        }
        .data(),
        deal_swap_asset_registry::accounts::Initialize {
            payer: payer.pubkey(),
            authority: authority.pubkey(),
            registry,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[initialize], &[&authority]));

    let state = deserialize_registry(&svm, &registry);
    assert_eq!(state.authority, authority.pubkey());
    assert_eq!(state.revision, 1);
    assert_eq!(
        state.wrapped_native_pair,
        Pubkey::find_program_address(
            &[deal_dex_pair::PAIR_SEED, wrapped_native_mint.as_ref()],
            &pair_program,
        )
        .0
    );
    assert_eq!(
        state.pair_for_official_mint(stable0_mint),
        Some(state.stable0_pair)
    );
    assert!(state.is_recognized_or_dc(dc_mint));
    assert!(!state.is_recognized_or_dc(Pubkey::new_unique()));

    let replacement_router = Pubkey::new_unique();
    let unauthorized_update = Instruction::new_with_bytes(
        deal_swap_asset_registry::id(),
        &deal_swap_asset_registry::instruction::SetSwapAssets {
            pair_program,
            router_program: replacement_router,
            dc_mint,
            wrapped_native_mint,
            stable0_mint,
            stable1_mint,
        }
        .data(),
        deal_swap_asset_registry::accounts::AdminRegistry {
            authority: outsider.pubkey(),
            registry,
        }
        .to_account_metas(None),
    );
    assert!(!send(&mut svm, &outsider, &[unauthorized_update], &[]));

    let propose = Instruction::new_with_bytes(
        deal_swap_asset_registry::id(),
        &deal_swap_asset_registry::instruction::ProposeAuthority {
            pending_authority: pending.pubkey(),
        }
        .data(),
        deal_swap_asset_registry::accounts::AdminRegistry {
            authority: authority.pubkey(),
            registry,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &authority, &[propose], &[]));

    let accept = Instruction::new_with_bytes(
        deal_swap_asset_registry::id(),
        &deal_swap_asset_registry::instruction::AcceptAuthority {}.data(),
        deal_swap_asset_registry::accounts::AcceptAuthority {
            pending_authority: pending.pubkey(),
            registry,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &pending, &[accept], &[]));

    let update = Instruction::new_with_bytes(
        deal_swap_asset_registry::id(),
        &deal_swap_asset_registry::instruction::SetSwapAssets {
            pair_program,
            router_program: replacement_router,
            dc_mint,
            wrapped_native_mint,
            stable0_mint,
            stable1_mint,
        }
        .data(),
        deal_swap_asset_registry::accounts::AdminRegistry {
            authority: pending.pubkey(),
            registry,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &pending, &[update], &[]));

    let state = deserialize_registry(&svm, &registry);
    assert_eq!(state.authority, pending.pubkey());
    assert_eq!(state.pending_authority, Pubkey::default());
    assert_eq!(state.router_program, replacement_router);
    assert_eq!(state.revision, 2);
}
