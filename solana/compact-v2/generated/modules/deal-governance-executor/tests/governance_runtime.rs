use anchor_lang::{
    prelude::{AccountDeserialize, Clock, Pubkey},
    solana_program::instruction::{AccountMeta, Instruction},
    InstructionData, ToAccountMetas,
};
use deal_governance_executor::{
    constants::{
        CONFIG_SEED, ENVELOPE_VERSION, EXECUTOR_AUTHORITY_SEED, MESSAGE_SEED, TARGET_SEED,
    },
    state::{
        AllowedTarget, GovernanceAccountMeta, GovernanceConfig, GovernanceEnvelope, MessageRecord,
    },
};
use deal_parameter_registry::ParameterRegistry;
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

const SOURCE_CHAIN: u64 = 1;
const SOURCE_BROADCASTER: [u8; 32] = [7; 32];

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

fn confirm_instruction(
    payer: Pubkey,
    bridge_signer: Pubkey,
    config: Pubkey,
    envelope: GovernanceEnvelope,
) -> (Instruction, Pubkey) {
    let message_hash = envelope.canonical_hash();
    let (message, _) = Pubkey::find_program_address(
        &[MESSAGE_SEED, message_hash.as_ref()],
        &deal_governance_executor::id(),
    );
    let instruction = Instruction::new_with_bytes(
        deal_governance_executor::id(),
        &deal_governance_executor::instruction::ConfirmMessage {
            message_hash,
            envelope,
        }
        .data(),
        deal_governance_executor::accounts::ConfirmMessage {
            payer,
            bridge_signer,
            config,
            message,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    (instruction, message)
}

fn set_allowed_target_instruction(
    authority: Pubkey,
    config: Pubkey,
    target: Pubkey,
    allowed: bool,
) -> Instruction {
    let (target_record, _) = Pubkey::find_program_address(
        &[TARGET_SEED, target.as_ref()],
        &deal_governance_executor::id(),
    );
    Instruction::new_with_bytes(
        deal_governance_executor::id(),
        &deal_governance_executor::instruction::SetAllowedTarget { target, allowed }.data(),
        deal_governance_executor::accounts::SetAllowedTarget {
            authority,
            config,
            target_record,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn execute_instruction(
    config: Pubkey,
    message: Pubkey,
    executor_authority: Pubkey,
    registry: Pubkey,
) -> Instruction {
    let target = deal_parameter_registry::id();
    let (target_record, _) = Pubkey::find_program_address(
        &[TARGET_SEED, target.as_ref()],
        &deal_governance_executor::id(),
    );
    let mut accounts = deal_governance_executor::accounts::ExecuteMessage {
        config,
        message,
        target_record,
        executor_authority,
        target_program: target,
    }
    .to_account_metas(None);
    accounts.push(AccountMeta::new(registry, false));
    Instruction::new_with_bytes(
        deal_governance_executor::id(),
        &deal_governance_executor::instruction::ExecuteMessage {}.data(),
        accounts,
    )
}

fn envelope(
    nonce: u64,
    now: i64,
    executor_authority: Pubkey,
    registry: Pubkey,
    message_price: u64,
) -> GovernanceEnvelope {
    GovernanceEnvelope {
        version: ENVELOPE_VERSION,
        source_chain: SOURCE_CHAIN,
        source_broadcaster: SOURCE_BROADCASTER,
        bridge_set_version: 1,
        nonce,
        action_type: 1,
        target_program: deal_parameter_registry::id(),
        valid_after: now - 1,
        expires_at: now + 3_600,
        accounts: vec![
            GovernanceAccountMeta {
                pubkey: executor_authority,
                is_writable: false,
                is_signer: true,
            },
            GovernanceAccountMeta {
                pubkey: registry,
                is_writable: true,
                is_signer: false,
            },
        ],
        payload: deal_parameter_registry::instruction::SetMessagePrice { message_price }.data(),
    }
}

#[test]
fn executes_after_two_bridges_and_retries_after_target_is_reenabled() {
    let mut svm = LiteSVM::new();
    svm.add_program(
        deal_governance_executor::id(),
        include_bytes!("../../../target/deploy/deal_compact_governance_ingress.so"),
    )
    .unwrap();
    svm.add_program(
        deal_parameter_registry::id(),
        include_bytes!("../../../target/deploy/deal_compact_monetary_policy.so"),
    )
    .unwrap();

    let payer = Keypair::new();
    let bridge_0 = Keypair::new();
    let bridge_1 = Keypair::new();
    let bridge_2 = Keypair::new();
    let bridge_3 = Keypair::new();
    svm.airdrop(&payer.pubkey(), 20_000_000_000).unwrap();

    let executor_program = deal_governance_executor::id();
    let registry_program = deal_parameter_registry::id();
    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &executor_program);
    let (executor_authority, _) =
        Pubkey::find_program_address(&[EXECUTOR_AUTHORITY_SEED], &executor_program);
    let (registry, _) = Pubkey::find_program_address(&[b"parameter-registry"], &registry_program);

    let initialize_executor = Instruction::new_with_bytes(
        executor_program,
        &deal_governance_executor::instruction::Initialize {
            source_chain: SOURCE_CHAIN,
            source_broadcaster: SOURCE_BROADCASTER,
            bridge_signers: [bridge_0.pubkey(), bridge_1.pubkey(), bridge_2.pubkey()],
            threshold: 2,
        }
        .data(),
        deal_governance_executor::accounts::Initialize {
            payer: payer.pubkey(),
            authority: payer.pubkey(),
            config,
            executor_authority,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[initialize_executor], &[]));

    let initialize_registry = Instruction::new_with_bytes(
        registry_program,
        &deal_parameter_registry::instruction::Initialize {
            governance_authority: executor_authority,
            message_price: 100,
            min_window_sec: 60,
        }
        .data(),
        deal_parameter_registry::accounts::Initialize {
            payer: payer.pubkey(),
            registry,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[initialize_registry], &[]));

    assert!(send(
        &mut svm,
        &payer,
        &[set_allowed_target_instruction(
            payer.pubkey(),
            config,
            registry_program,
            true,
        )],
        &[],
    ));

    let unpause = Instruction::new_with_bytes(
        executor_program,
        &deal_governance_executor::instruction::SetPaused { paused: false }.data(),
        deal_governance_executor::accounts::AdminConfig {
            authority: payer.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[unpause], &[]));

    let now = svm.get_sysvar::<Clock>().unix_timestamp;
    let first_envelope = envelope(1, now, executor_authority, registry, 102);
    let (first_confirmation, first_message) = confirm_instruction(
        payer.pubkey(),
        bridge_0.pubkey(),
        config,
        first_envelope.clone(),
    );
    assert!(send(&mut svm, &payer, &[first_confirmation], &[&bridge_0],));
    assert!(!send(
        &mut svm,
        &payer,
        &[execute_instruction(
            config,
            first_message,
            executor_authority,
            registry,
        )],
        &[],
    ));

    let (second_confirmation, _) = confirm_instruction(
        payer.pubkey(),
        bridge_1.pubkey(),
        config,
        first_envelope.clone(),
    );
    assert!(send(&mut svm, &payer, &[second_confirmation], &[&bridge_1],));
    let require_all_bridges = Instruction::new_with_bytes(
        executor_program,
        &deal_governance_executor::instruction::SetThreshold { threshold: 3 }.data(),
        deal_governance_executor::accounts::AdminConfig {
            authority: payer.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[require_all_bridges], &[]));
    assert!(!send(
        &mut svm,
        &payer,
        &[execute_instruction(
            config,
            first_message,
            executor_authority,
            registry,
        )],
        &[],
    ));
    let (third_confirmation, _) =
        confirm_instruction(payer.pubkey(), bridge_2.pubkey(), config, first_envelope);
    assert!(send(&mut svm, &payer, &[third_confirmation], &[&bridge_2],));
    assert!(send(
        &mut svm,
        &payer,
        &[execute_instruction(
            config,
            first_message,
            executor_authority,
            registry,
        )],
        &[],
    ));
    assert_eq!(
        deserialize::<ParameterRegistry>(&svm, &registry).message_price,
        102
    );

    let restore_two_of_three = Instruction::new_with_bytes(
        executor_program,
        &deal_governance_executor::instruction::SetThreshold { threshold: 2 }.data(),
        deal_governance_executor::accounts::AdminConfig {
            authority: payer.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[restore_two_of_three], &[]));

    assert!(send(
        &mut svm,
        &payer,
        &[set_allowed_target_instruction(
            payer.pubkey(),
            config,
            registry_program,
            false,
        )],
        &[],
    ));

    let retry_envelope = envelope(2, now, executor_authority, registry, 103);
    let (retry_confirmation_0, retry_message) = confirm_instruction(
        payer.pubkey(),
        bridge_0.pubkey(),
        config,
        retry_envelope.clone(),
    );
    let (retry_confirmation_1, _) =
        confirm_instruction(payer.pubkey(), bridge_2.pubkey(), config, retry_envelope);
    assert!(send(
        &mut svm,
        &payer,
        &[retry_confirmation_0],
        &[&bridge_0],
    ));
    assert!(send(
        &mut svm,
        &payer,
        &[retry_confirmation_1],
        &[&bridge_2],
    ));
    assert!(!send(
        &mut svm,
        &payer,
        &[execute_instruction(
            config,
            retry_message,
            executor_authority,
            registry,
        )],
        &[],
    ));
    assert!(!deserialize::<MessageRecord>(&svm, &retry_message).executed);
    assert_eq!(
        deserialize::<GovernanceConfig>(&svm, &config).last_executed_nonce,
        1
    );

    assert!(send(
        &mut svm,
        &payer,
        &[set_allowed_target_instruction(
            payer.pubkey(),
            config,
            registry_program,
            true,
        )],
        &[],
    ));
    assert!(send(
        &mut svm,
        &payer,
        &[execute_instruction(
            config,
            retry_message,
            executor_authority,
            registry,
        )],
        &[],
    ));
    assert_eq!(
        deserialize::<ParameterRegistry>(&svm, &registry).message_price,
        103
    );
    assert!(deserialize::<MessageRecord>(&svm, &retry_message).executed);
    assert_eq!(
        deserialize::<GovernanceConfig>(&svm, &config).last_executed_nonce,
        2
    );
    assert!(!send(
        &mut svm,
        &payer,
        &[execute_instruction(
            config,
            retry_message,
            executor_authority,
            registry,
        )],
        &[],
    ));

    let stale_envelope = envelope(1, now, executor_authority, registry, 104);
    let (stale_confirmation_0, stale_message) = confirm_instruction(
        payer.pubkey(),
        bridge_0.pubkey(),
        config,
        stale_envelope.clone(),
    );
    let (stale_confirmation_1, _) =
        confirm_instruction(payer.pubkey(), bridge_1.pubkey(), config, stale_envelope);
    assert!(send(
        &mut svm,
        &payer,
        &[stale_confirmation_0],
        &[&bridge_0],
    ));
    assert!(send(
        &mut svm,
        &payer,
        &[stale_confirmation_1],
        &[&bridge_1],
    ));
    assert!(!send(
        &mut svm,
        &payer,
        &[execute_instruction(
            config,
            stale_message,
            executor_authority,
            registry,
        )],
        &[],
    ));

    let mut expired_envelope = envelope(3, now, executor_authority, registry, 105);
    expired_envelope.valid_after = now - 2;
    expired_envelope.expires_at = now - 1;
    let (expired_confirmation_0, expired_message) = confirm_instruction(
        payer.pubkey(),
        bridge_0.pubkey(),
        config,
        expired_envelope.clone(),
    );
    let (expired_confirmation_1, _) =
        confirm_instruction(payer.pubkey(), bridge_2.pubkey(), config, expired_envelope);
    assert!(send(
        &mut svm,
        &payer,
        &[expired_confirmation_0],
        &[&bridge_0],
    ));
    assert!(send(
        &mut svm,
        &payer,
        &[expired_confirmation_1],
        &[&bridge_2],
    ));
    assert!(!send(
        &mut svm,
        &payer,
        &[execute_instruction(
            config,
            expired_message,
            executor_authority,
            registry,
        )],
        &[],
    ));
    assert_eq!(
        deserialize::<ParameterRegistry>(&svm, &registry).message_price,
        103
    );

    let pending_old_set = envelope(3, now, executor_authority, registry, 106);
    let (pending_old_confirmation, pending_old_message) = confirm_instruction(
        payer.pubkey(),
        bridge_0.pubkey(),
        config,
        pending_old_set.clone(),
    );
    assert!(send(
        &mut svm,
        &payer,
        &[pending_old_confirmation],
        &[&bridge_0],
    ));
    assert_eq!(
        deserialize::<MessageRecord>(&svm, &pending_old_message)
            .confirmations
            .count_ones(),
        1
    );

    let rotate_bridge = Instruction::new_with_bytes(
        executor_program,
        &deal_governance_executor::instruction::SetBridgeSigner {
            bridge_index: 1,
            bridge_signer: bridge_3.pubkey(),
        }
        .data(),
        deal_governance_executor::accounts::AdminConfig {
            authority: payer.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[rotate_bridge], &[]));
    assert_eq!(
        deserialize::<GovernanceConfig>(&svm, &config).bridge_set_version,
        2
    );

    let (old_set_second_confirmation, _) =
        confirm_instruction(payer.pubkey(), bridge_2.pubkey(), config, pending_old_set);
    assert!(!send(
        &mut svm,
        &payer,
        &[old_set_second_confirmation],
        &[&bridge_2],
    ));
    assert!(!send(
        &mut svm,
        &payer,
        &[execute_instruction(
            config,
            pending_old_message,
            executor_authority,
            registry,
        )],
        &[],
    ));

    let mut rotated_envelope = envelope(3, now, executor_authority, registry, 107);
    rotated_envelope.bridge_set_version = 2;
    let (rotated_confirmation_0, rotated_message) = confirm_instruction(
        payer.pubkey(),
        bridge_0.pubkey(),
        config,
        rotated_envelope.clone(),
    );
    assert!(send(
        &mut svm,
        &payer,
        &[rotated_confirmation_0],
        &[&bridge_0],
    ));
    let (removed_bridge_confirmation, _) = confirm_instruction(
        payer.pubkey(),
        bridge_1.pubkey(),
        config,
        rotated_envelope.clone(),
    );
    assert!(!send(
        &mut svm,
        &payer,
        &[removed_bridge_confirmation],
        &[&bridge_1],
    ));
    let (rotated_confirmation_1, _) =
        confirm_instruction(payer.pubkey(), bridge_3.pubkey(), config, rotated_envelope);
    assert!(send(
        &mut svm,
        &payer,
        &[rotated_confirmation_1],
        &[&bridge_3],
    ));
    assert!(send(
        &mut svm,
        &payer,
        &[execute_instruction(
            config,
            rotated_message,
            executor_authority,
            registry,
        )],
        &[],
    ));
    assert_eq!(
        deserialize::<ParameterRegistry>(&svm, &registry).message_price,
        107
    );
    assert_eq!(
        deserialize::<GovernanceConfig>(&svm, &config).last_executed_nonce,
        3
    );

    let mut cancelled_envelope = envelope(4, now, executor_authority, registry, 108);
    cancelled_envelope.bridge_set_version = 2;
    let (cancelled_confirmation_0, cancelled_message) = confirm_instruction(
        payer.pubkey(),
        bridge_0.pubkey(),
        config,
        cancelled_envelope.clone(),
    );
    let (cancelled_confirmation_1, _) = confirm_instruction(
        payer.pubkey(),
        bridge_3.pubkey(),
        config,
        cancelled_envelope,
    );
    assert!(send(
        &mut svm,
        &payer,
        &[cancelled_confirmation_0],
        &[&bridge_0],
    ));
    assert!(send(
        &mut svm,
        &payer,
        &[cancelled_confirmation_1],
        &[&bridge_3],
    ));
    let cancel = Instruction::new_with_bytes(
        executor_program,
        &deal_governance_executor::instruction::CancelMessage {}.data(),
        deal_governance_executor::accounts::CancelMessage {
            authority: payer.pubkey(),
            config,
            message: cancelled_message,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[cancel], &[]));
    assert!(deserialize::<MessageRecord>(&svm, &cancelled_message).cancelled);
    assert!(!send(
        &mut svm,
        &payer,
        &[execute_instruction(
            config,
            cancelled_message,
            executor_authority,
            registry,
        )],
        &[],
    ));

    let mut after_cancel_envelope = envelope(5, now, executor_authority, registry, 109);
    after_cancel_envelope.bridge_set_version = 2;
    let (after_cancel_confirmation_0, after_cancel_message) = confirm_instruction(
        payer.pubkey(),
        bridge_0.pubkey(),
        config,
        after_cancel_envelope.clone(),
    );
    let (after_cancel_confirmation_1, _) = confirm_instruction(
        payer.pubkey(),
        bridge_3.pubkey(),
        config,
        after_cancel_envelope,
    );
    assert!(send(
        &mut svm,
        &payer,
        &[after_cancel_confirmation_0],
        &[&bridge_0],
    ));
    assert!(send(
        &mut svm,
        &payer,
        &[after_cancel_confirmation_1],
        &[&bridge_3],
    ));
    assert!(send(
        &mut svm,
        &payer,
        &[execute_instruction(
            config,
            after_cancel_message,
            executor_authority,
            registry,
        )],
        &[],
    ));
    assert_eq!(
        deserialize::<ParameterRegistry>(&svm, &registry).message_price,
        109
    );
    assert_eq!(
        deserialize::<GovernanceConfig>(&svm, &config).last_executed_nonce,
        5
    );
}

#[test]
fn self_governed_authority_handoff_persists_after_outer_execution() {
    let mut svm = LiteSVM::new();
    svm.add_program(
        deal_governance_executor::id(),
        include_bytes!("../../../target/deploy/deal_compact_governance_ingress.so"),
    )
    .unwrap();

    let payer = Keypair::new();
    let bridge_0 = Keypair::new();
    let bridge_1 = Keypair::new();
    let bridge_2 = Keypair::new();
    svm.airdrop(&payer.pubkey(), 20_000_000_000).unwrap();

    let program = deal_governance_executor::id();
    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &program);
    let (executor_authority, _) =
        Pubkey::find_program_address(&[EXECUTOR_AUTHORITY_SEED], &program);

    let initialize = Instruction::new_with_bytes(
        program,
        &deal_governance_executor::instruction::Initialize {
            source_chain: SOURCE_CHAIN,
            source_broadcaster: SOURCE_BROADCASTER,
            bridge_signers: [bridge_0.pubkey(), bridge_1.pubkey(), bridge_2.pubkey()],
            threshold: 2,
        }
        .data(),
        deal_governance_executor::accounts::Initialize {
            payer: payer.pubkey(),
            authority: payer.pubkey(),
            config,
            executor_authority,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[initialize], &[]));
    assert!(send(
        &mut svm,
        &payer,
        &[set_allowed_target_instruction(
            payer.pubkey(),
            config,
            program,
            true,
        )],
        &[],
    ));

    let unpause = Instruction::new_with_bytes(
        program,
        &deal_governance_executor::instruction::SetPaused { paused: false }.data(),
        deal_governance_executor::accounts::AdminConfig {
            authority: payer.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[unpause], &[]));

    let propose = Instruction::new_with_bytes(
        program,
        &deal_governance_executor::instruction::ProposeAuthority {
            pending_authority: executor_authority,
        }
        .data(),
        deal_governance_executor::accounts::AdminConfig {
            authority: payer.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[propose], &[]));

    let now = svm.get_sysvar::<Clock>().unix_timestamp;
    let envelope = GovernanceEnvelope {
        version: ENVELOPE_VERSION,
        source_chain: SOURCE_CHAIN,
        source_broadcaster: SOURCE_BROADCASTER,
        bridge_set_version: 1,
        nonce: 1,
        action_type: 1,
        target_program: program,
        valid_after: now - 1,
        expires_at: now + 3_600,
        accounts: vec![
            GovernanceAccountMeta {
                pubkey: executor_authority,
                is_writable: false,
                is_signer: true,
            },
            GovernanceAccountMeta {
                pubkey: config,
                is_writable: true,
                is_signer: false,
            },
        ],
        payload: deal_governance_executor::instruction::AcceptAuthority {}.data(),
    };
    let (confirmation_0, message) =
        confirm_instruction(payer.pubkey(), bridge_0.pubkey(), config, envelope.clone());
    let (confirmation_1, _) =
        confirm_instruction(payer.pubkey(), bridge_1.pubkey(), config, envelope);
    assert!(send(&mut svm, &payer, &[confirmation_0], &[&bridge_0],));
    assert!(send(&mut svm, &payer, &[confirmation_1], &[&bridge_1],));

    let (target_record, _) =
        Pubkey::find_program_address(&[TARGET_SEED, program.as_ref()], &program);
    let mut execute_accounts = deal_governance_executor::accounts::ExecuteMessage {
        config,
        message,
        target_record,
        executor_authority,
        target_program: program,
    }
    .to_account_metas(None);
    execute_accounts.push(AccountMeta::new(config, false));
    let execute = Instruction::new_with_bytes(
        program,
        &deal_governance_executor::instruction::ExecuteMessage {}.data(),
        execute_accounts,
    );
    assert!(send(&mut svm, &payer, &[execute], &[]));

    let state = deserialize::<GovernanceConfig>(&svm, &config);
    assert_eq!(state.authority, executor_authority);
    assert_eq!(state.pending_authority, Pubkey::default());
    assert_eq!(state.last_executed_nonce, 1);
    assert!(deserialize::<MessageRecord>(&svm, &message).executed);

    svm.airdrop(&executor_authority, 2_000_000_000).unwrap();
    let newly_allowed = Pubkey::new_unique();
    let (new_target_record, _) =
        Pubkey::find_program_address(&[TARGET_SEED, newly_allowed.as_ref()], &program);
    let now = svm.get_sysvar::<Clock>().unix_timestamp;
    let add_target_envelope = GovernanceEnvelope {
        version: ENVELOPE_VERSION,
        source_chain: SOURCE_CHAIN,
        source_broadcaster: SOURCE_BROADCASTER,
        bridge_set_version: 1,
        nonce: 2,
        action_type: 1,
        target_program: program,
        valid_after: now - 1,
        expires_at: now + 3_600,
        accounts: vec![
            GovernanceAccountMeta {
                pubkey: executor_authority,
                is_writable: true,
                is_signer: true,
            },
            GovernanceAccountMeta {
                pubkey: config,
                is_writable: false,
                is_signer: false,
            },
            GovernanceAccountMeta {
                pubkey: new_target_record,
                is_writable: true,
                is_signer: false,
            },
            GovernanceAccountMeta {
                pubkey: anchor_lang::system_program::ID,
                is_writable: false,
                is_signer: false,
            },
        ],
        payload: deal_governance_executor::instruction::SetAllowedTarget {
            target: newly_allowed,
            allowed: true,
        }
        .data(),
    };
    let (add_target_confirmation_0, add_target_message) = confirm_instruction(
        payer.pubkey(),
        bridge_0.pubkey(),
        config,
        add_target_envelope.clone(),
    );
    let (add_target_confirmation_1, _) = confirm_instruction(
        payer.pubkey(),
        bridge_1.pubkey(),
        config,
        add_target_envelope,
    );
    assert!(send(
        &mut svm,
        &payer,
        &[add_target_confirmation_0],
        &[&bridge_0],
    ));
    assert!(send(
        &mut svm,
        &payer,
        &[add_target_confirmation_1],
        &[&bridge_1],
    ));
    let self_target_record =
        Pubkey::find_program_address(&[TARGET_SEED, program.as_ref()], &program).0;
    let mut add_target_accounts = deal_governance_executor::accounts::ExecuteMessage {
        config,
        message: add_target_message,
        target_record: self_target_record,
        executor_authority,
        target_program: program,
    }
    .to_account_metas(None);
    add_target_accounts.extend([
        AccountMeta::new_readonly(config, false),
        AccountMeta::new(new_target_record, false),
        AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
    ]);
    let add_target = Instruction::new_with_bytes(
        program,
        &deal_governance_executor::instruction::ExecuteMessage {}.data(),
        add_target_accounts,
    );
    assert!(send(&mut svm, &payer, &[add_target], &[]));
    let allowed = deserialize::<AllowedTarget>(&svm, &new_target_record);
    assert_eq!(allowed.target, newly_allowed);
    assert!(allowed.allowed);
    assert_eq!(
        deserialize::<GovernanceConfig>(&svm, &config).last_executed_nonce,
        2
    );

    let former_admin = Instruction::new_with_bytes(
        program,
        &deal_governance_executor::instruction::SetPaused { paused: true }.data(),
        deal_governance_executor::accounts::AdminConfig {
            authority: payer.pubkey(),
            config,
        }
        .to_account_metas(None),
    );
    assert!(!send(&mut svm, &payer, &[former_admin], &[]));
}
