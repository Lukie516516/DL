use anchor_lang::{
    prelude::{AccountDeserialize, AccountSerialize, Clock, Pubkey},
    solana_program::instruction::{AccountMeta, Instruction},
    InstructionData, ToAccountMetas,
};
use deal_d_token::{
    BalanceCheckpoint, DTokenConfig, HolderState, CHECKPOINT_SEED as D_CHECKPOINT_SEED,
    CONFIG_SEED as D_CONFIG_SEED, D_UNIT, HOLDER_SEED, MAX_SUPPLY, SEAT_THRESHOLD,
};
use deal_governance::{
    ActionAccountMeta, AllowedTarget, GovernanceConfig, Proposal, ProposalKind, CONFIG_SEED,
    D_VOTE_SEED, EXECUTOR_SEED, NFT_VOTE_SEED, PROPOSAL_SEED, TARGET_SEED,
};
use deal_governance_activity::{
    ActivityBucket, ActivityCheckpoint, ActivityConfig, IdentityActivity, ACTIVITY_SEED,
    BUCKET_COUNT, CHECKPOINT_SEED as ACTIVITY_CHECKPOINT_SEED, CONFIG_SEED as ACTIVITY_CONFIG_SEED,
    DEFAULT_ACTIVE_WINDOW_SECONDS, RECORDER_SEED,
};
use deal_identity::{IdentityRecord, IDENTITY_SEED};
use deal_parameter_registry::ParameterRegistry;
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
            eprintln!("transaction failed: {error:#?}");
            false
        }
    };
    svm.expire_blockhash();
    result
}

fn set_clock(svm: &mut LiteSVM, slot: u64, timestamp: i64) {
    svm.set_sysvar(&Clock {
        slot,
        epoch_start_timestamp: timestamp,
        epoch: slot / 100,
        leader_schedule_epoch: slot / 100,
        unix_timestamp: timestamp,
    });
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
            lamports: 20_000_000,
            data,
            owner,
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

fn proposal_pda(id: u64) -> Pubkey {
    Pubkey::find_program_address(&[PROPOSAL_SEED, &id.to_le_bytes()], &deal_governance::id()).0
}

fn set_identity(svm: &mut LiteSVM, mint: Pubkey, id: u64) -> Pubkey {
    let (identity, bump) =
        Pubkey::find_program_address(&[IDENTITY_SEED, mint.as_ref()], &deal_identity::id());
    set_anchor_account(
        svm,
        identity,
        deal_identity::id(),
        &IdentityRecord {
            id,
            mint,
            season: 1,
            date_code: 20_260_719,
            daily_serial: id as u32,
            total_dc_minted: 0,
            max_partner: mint,
            lock_count: 0,
            bump,
        },
    );
    identity
}

fn set_identity_mint(svm: &mut LiteSVM, mint: Pubkey, authority: Pubkey) {
    let state = Mint {
        mint_authority: COption::Some(authority),
        supply: 1,
        decimals: 0,
        is_initialized: true,
        freeze_authority: COption::Some(authority),
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

fn set_identity_token(svm: &mut LiteSVM, address: Pubkey, mint: Pubkey, owner: Pubkey) {
    let state = TokenAccount {
        mint,
        owner,
        amount: 1,
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

fn activity_pda(mint: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[ACTIVITY_SEED, mint.as_ref()],
        &deal_governance_activity::id(),
    )
    .0
}

fn activity_checkpoint_pda(mint: Pubkey, index: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[
            ACTIVITY_CHECKPOINT_SEED,
            mint.as_ref(),
            &index.to_le_bytes(),
        ],
        &deal_governance_activity::id(),
    )
    .0
}

#[test]
fn seventy_d_executes_after_window_and_snapshot_seat_can_veto() {
    let mut svm = LiteSVM::new();
    for (program, binary) in [
        (
            deal_governance::id(),
            include_bytes!("../../../target/deploy/deal_governance.so").as_slice(),
        ),
        (
            deal_parameter_registry::id(),
            include_bytes!("../../../target/deploy/deal_parameter_registry.so").as_slice(),
        ),
    ] {
        svm.add_program(program, binary).unwrap();
    }
    set_clock(&mut svm, 10, NOW);

    let payer = Keypair::new();
    let authority = Keypair::new();
    let voter = Keypair::new();
    let outsider = Keypair::new();
    for wallet in [&payer, &authority, &voter, &outsider] {
        svm.airdrop(&wallet.pubkey(), 40_000_000_000).unwrap();
    }

    let d_mint = Pubkey::new_unique();
    let (d_config, d_config_bump) =
        Pubkey::find_program_address(&[D_CONFIG_SEED], &deal_d_token::id());
    set_anchor_account(
        &mut svm,
        d_config,
        deal_d_token::id(),
        &DTokenConfig {
            mint: d_mint,
            total_supply: MAX_SUPPLY,
            seat_threshold: SEAT_THRESHOLD,
            holder_count: 1,
            bump: d_config_bump,
            freeze_bump: 1,
        },
    );
    let (holder_state, holder_bump) =
        Pubkey::find_program_address(&[HOLDER_SEED, voter.pubkey().as_ref()], &deal_d_token::id());
    set_anchor_account(
        &mut svm,
        holder_state,
        deal_d_token::id(),
        &HolderState {
            owner: voter.pubkey(),
            balance: 70 * D_UNIT,
            checkpoint_count: 1,
            last_checkpoint_slot: 1,
            bump: holder_bump,
        },
    );
    let (balance_checkpoint, checkpoint_bump) = Pubkey::find_program_address(
        &[
            D_CHECKPOINT_SEED,
            voter.pubkey().as_ref(),
            &0u64.to_le_bytes(),
        ],
        &deal_d_token::id(),
    );
    set_anchor_account(
        &mut svm,
        balance_checkpoint,
        deal_d_token::id(),
        &BalanceCheckpoint {
            owner: voter.pubkey(),
            index: 0,
            slot: 1,
            balance: 70 * D_UNIT,
            bump: checkpoint_bump,
        },
    );

    let (activity_config, activity_bump) =
        Pubkey::find_program_address(&[ACTIVITY_CONFIG_SEED], &deal_governance_activity::id());
    set_anchor_account(
        &mut svm,
        activity_config,
        deal_governance_activity::id(),
        &ActivityConfig {
            authority: authority.pubkey(),
            pending_authority: Pubkey::default(),
            identity_program: deal_identity::id(),
            active_window_seconds: DEFAULT_ACTIVE_WINDOW_SECONDS,
            active_total: 0,
            last_synced_day: NOW / 86_400,
            buckets: [ActivityBucket::default(); BUCKET_COUNT],
            bump: activity_bump,
        },
    );

    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_governance::id());
    let (executor_authority, _) =
        Pubkey::find_program_address(&[EXECUTOR_SEED], &deal_governance::id());
    let initialize = Instruction::new_with_bytes(
        deal_governance::id(),
        &deal_governance::instruction::Initialize {}.data(),
        deal_governance::accounts::Initialize {
            payer: payer.pubkey(),
            authority: authority.pubkey(),
            config,
            d_config,
            activity_config,
            executor_authority,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[initialize], &[&authority]));

    let target = deal_parameter_registry::id();
    let (target_record, _) =
        Pubkey::find_program_address(&[TARGET_SEED, target.as_ref()], &deal_governance::id());
    let allow_target = Instruction::new_with_bytes(
        deal_governance::id(),
        &deal_governance::instruction::SetAllowedTarget {
            target,
            allowed: true,
        }
        .data(),
        deal_governance::accounts::SetAllowedTarget {
            payer: payer.pubkey(),
            authority: authority.pubkey(),
            config,
            target_record,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[allow_target], &[&authority]));
    assert!(anchor_state::<AllowedTarget>(&svm, target_record).allowed);

    let (registry, _) =
        Pubkey::find_program_address(&[b"parameter-registry"], &deal_parameter_registry::id());
    let initialize_registry = Instruction::new_with_bytes(
        deal_parameter_registry::id(),
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

    let payload =
        deal_parameter_registry::instruction::SetMessagePrice { message_price: 102 }.data();
    let action_accounts = vec![
        ActionAccountMeta {
            pubkey: executor_authority,
            is_signer: true,
            is_writable: false,
        },
        ActionAccountMeta {
            pubkey: registry,
            is_signer: false,
            is_writable: true,
        },
    ];
    let proposal0 = proposal_pda(0);
    let create0 = Instruction::new_with_bytes(
        deal_governance::id(),
        &deal_governance::instruction::CreateProposal {
            proposal_id: 0,
            kind: ProposalKind::Parameter,
            target_program: target,
            payload: payload.clone(),
            action_accounts: action_accounts.clone(),
            description_hash: [1; 32],
        }
        .data(),
        deal_governance::accounts::CreateProposal {
            payer: payer.pubkey(),
            proposer: voter.pubkey(),
            config,
            d_config,
            d_mint,
            proposer_state: holder_state,
            activity_config,
            target_record,
            proposal: proposal0,
            executor_authority,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[create0], &[&voter]));
    assert_eq!(anchor_state::<Proposal>(&svm, proposal0).snapshot_slot, 9);

    let (vote_receipt0, _) = Pubkey::find_program_address(
        &[D_VOTE_SEED, proposal0.as_ref(), voter.pubkey().as_ref()],
        &deal_governance::id(),
    );
    let vote0 = Instruction::new_with_bytes(
        deal_governance::id(),
        &deal_governance::instruction::CastDVote {}.data(),
        deal_governance::accounts::CastDVote {
            payer: payer.pubkey(),
            voter: voter.pubkey(),
            config,
            d_config,
            voter_state: holder_state,
            balance_checkpoint,
            successor_checkpoint: None,
            proposal: proposal0,
            vote_receipt: vote_receipt0,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &payer,
        std::slice::from_ref(&vote0),
        &[&voter]
    ));
    assert!(!send(&mut svm, &payer, &[vote0], &[&voter]));
    assert_eq!(
        anchor_state::<Proposal>(&svm, proposal0).d_support,
        70 * D_UNIT
    );

    let mut early_execute = Instruction::new_with_bytes(
        deal_governance::id(),
        &deal_governance::instruction::Execute {}.data(),
        deal_governance::accounts::ExecuteProposal {
            config,
            proposal: proposal0,
            target_record,
            executor_authority,
            target_program: target,
        }
        .to_account_metas(None),
    );
    early_execute
        .accounts
        .push(AccountMeta::new(registry, false));
    assert!(!send(&mut svm, &payer, &[early_execute.clone()], &[]));
    assert_eq!(
        anchor_state::<ParameterRegistry>(&svm, registry).message_price,
        100
    );

    set_clock(&mut svm, 20, NOW + (48 * 60 * 60) + 1);
    assert!(send(&mut svm, &payer, &[early_execute], &[]));
    assert_eq!(
        anchor_state::<ParameterRegistry>(&svm, registry).message_price,
        102
    );
    assert!(anchor_state::<Proposal>(&svm, proposal0).executed);

    let proposal1 = proposal_pda(1);
    let create1 = Instruction::new_with_bytes(
        deal_governance::id(),
        &deal_governance::instruction::CreateProposal {
            proposal_id: 1,
            kind: ProposalKind::Parameter,
            target_program: target,
            payload,
            action_accounts,
            description_hash: [2; 32],
        }
        .data(),
        deal_governance::accounts::CreateProposal {
            payer: payer.pubkey(),
            proposer: voter.pubkey(),
            config,
            d_config,
            d_mint,
            proposer_state: holder_state,
            activity_config,
            target_record,
            proposal: proposal1,
            executor_authority,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[create1], &[&voter]));
    let veto = Instruction::new_with_bytes(
        deal_governance::id(),
        &deal_governance::instruction::Veto {}.data(),
        deal_governance::accounts::VetoProposal {
            vetoer: voter.pubkey(),
            config,
            d_config,
            vetoer_state: holder_state,
            balance_checkpoint,
            successor_checkpoint: None,
            proposal: proposal1,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &voter, &[veto], &[]));
    let vetoed = anchor_state::<Proposal>(&svm, proposal1);
    assert!(vetoed.vetoed);
    assert_eq!(vetoed.vetoer, voter.pubkey());
    assert_eq!(
        anchor_state::<GovernanceConfig>(&svm, config).next_proposal_id,
        2
    );
}

#[test]
fn major_proposal_requires_both_d_and_active_identity_chambers() {
    let mut svm = LiteSVM::new();
    for (program, binary) in [
        (
            deal_governance::id(),
            include_bytes!("../../../target/deploy/deal_governance.so").as_slice(),
        ),
        (
            deal_governance_activity::id(),
            include_bytes!("../../../target/deploy/deal_governance_activity.so").as_slice(),
        ),
        (
            deal_parameter_registry::id(),
            include_bytes!("../../../target/deploy/deal_parameter_registry.so").as_slice(),
        ),
    ] {
        svm.add_program(program, binary).unwrap();
    }
    set_clock(&mut svm, 10, NOW);

    let payer = Keypair::new();
    let authority = Keypair::new();
    let voter = Keypair::new();
    for wallet in [&payer, &authority, &voter] {
        svm.airdrop(&wallet.pubkey(), 60_000_000_000).unwrap();
    }

    let d_mint = Pubkey::new_unique();
    let (d_config, d_config_bump) =
        Pubkey::find_program_address(&[D_CONFIG_SEED], &deal_d_token::id());
    set_anchor_account(
        &mut svm,
        d_config,
        deal_d_token::id(),
        &DTokenConfig {
            mint: d_mint,
            total_supply: MAX_SUPPLY,
            seat_threshold: SEAT_THRESHOLD,
            holder_count: 1,
            bump: d_config_bump,
            freeze_bump: 1,
        },
    );
    let (holder_state, holder_bump) =
        Pubkey::find_program_address(&[HOLDER_SEED, voter.pubkey().as_ref()], &deal_d_token::id());
    set_anchor_account(
        &mut svm,
        holder_state,
        deal_d_token::id(),
        &HolderState {
            owner: voter.pubkey(),
            balance: 70 * D_UNIT,
            checkpoint_count: 1,
            last_checkpoint_slot: 1,
            bump: holder_bump,
        },
    );
    let (balance_checkpoint, checkpoint_bump) = Pubkey::find_program_address(
        &[
            D_CHECKPOINT_SEED,
            voter.pubkey().as_ref(),
            &0u64.to_le_bytes(),
        ],
        &deal_d_token::id(),
    );
    set_anchor_account(
        &mut svm,
        balance_checkpoint,
        deal_d_token::id(),
        &BalanceCheckpoint {
            owner: voter.pubkey(),
            index: 0,
            slot: 1,
            balance: 70 * D_UNIT,
            bump: checkpoint_bump,
        },
    );

    let (activity_config, _) =
        Pubkey::find_program_address(&[ACTIVITY_CONFIG_SEED], &deal_governance_activity::id());
    let initialize_activity = Instruction::new_with_bytes(
        deal_governance_activity::id(),
        &deal_governance_activity::instruction::Initialize {
            active_window_seconds: DEFAULT_ACTIVE_WINDOW_SECONDS,
        }
        .data(),
        deal_governance_activity::accounts::Initialize {
            payer: payer.pubkey(),
            authority: authority.pubkey(),
            config: activity_config,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &payer,
        &[initialize_activity],
        &[&authority]
    ));

    let mint = Pubkey::new_unique();
    let identity = set_identity(&mut svm, mint, 1);
    set_identity_mint(&mut svm, mint, authority.pubkey());
    let owner_identity = Pubkey::new_unique();
    set_identity_token(&mut svm, owner_identity, mint, voter.pubkey());
    let activity = activity_pda(mint);
    let activity_checkpoint0 = activity_checkpoint_pda(mint, 0);
    let (authority_recorder_grant, _) = Pubkey::find_program_address(
        &[RECORDER_SEED, authority.pubkey().as_ref()],
        &deal_governance_activity::id(),
    );
    let allow_authority_recorder = Instruction::new_with_bytes(
        deal_governance_activity::id(),
        &deal_governance_activity::instruction::SetRecorder { allowed: true }.data(),
        deal_governance_activity::accounts::SetRecorder {
            payer: payer.pubkey(),
            authority: authority.pubkey(),
            recorder: authority.pubkey(),
            config: activity_config,
            recorder_grant: authority_recorder_grant,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &payer,
        &[allow_authority_recorder],
        &[&authority]
    ));
    let mark_active = Instruction::new_with_bytes(
        deal_governance_activity::id(),
        &deal_governance_activity::instruction::MarkActive {
            checkpoint_index: 0,
        }
        .data(),
        deal_governance_activity::accounts::MarkActive {
            payer: payer.pubkey(),
            recorder: authority.pubkey(),
            owner: voter.pubkey(),
            config: activity_config,
            recorder_grant: authority_recorder_grant,
            identity_mint: mint,
            identity,
            owner_identity,
            activity,
            checkpoint: activity_checkpoint0,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &payer,
        &[mark_active],
        &[&authority, &voter]
    ));
    assert_eq!(
        anchor_state::<ActivityConfig>(&svm, activity_config).active_total,
        1
    );

    let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &deal_governance::id());
    let (executor_authority, _) =
        Pubkey::find_program_address(&[EXECUTOR_SEED], &deal_governance::id());
    let initialize_governance = Instruction::new_with_bytes(
        deal_governance::id(),
        &deal_governance::instruction::Initialize {}.data(),
        deal_governance::accounts::Initialize {
            payer: payer.pubkey(),
            authority: authority.pubkey(),
            config,
            d_config,
            activity_config,
            executor_authority,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &payer,
        &[initialize_governance],
        &[&authority]
    ));

    let (executor_recorder_grant, _) = Pubkey::find_program_address(
        &[RECORDER_SEED, executor_authority.as_ref()],
        &deal_governance_activity::id(),
    );
    let allow_executor_recorder = Instruction::new_with_bytes(
        deal_governance_activity::id(),
        &deal_governance_activity::instruction::SetRecorder { allowed: true }.data(),
        deal_governance_activity::accounts::SetRecorder {
            payer: payer.pubkey(),
            authority: authority.pubkey(),
            recorder: executor_authority,
            config: activity_config,
            recorder_grant: executor_recorder_grant,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(
        &mut svm,
        &payer,
        &[allow_executor_recorder],
        &[&authority]
    ));

    let target = deal_parameter_registry::id();
    let (target_record, _) =
        Pubkey::find_program_address(&[TARGET_SEED, target.as_ref()], &deal_governance::id());
    let allow_target = Instruction::new_with_bytes(
        deal_governance::id(),
        &deal_governance::instruction::SetAllowedTarget {
            target,
            allowed: true,
        }
        .data(),
        deal_governance::accounts::SetAllowedTarget {
            payer: payer.pubkey(),
            authority: authority.pubkey(),
            config,
            target_record,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &payer, &[allow_target], &[&authority]));

    let (registry, _) =
        Pubkey::find_program_address(&[b"parameter-registry"], &deal_parameter_registry::id());
    let initialize_registry = Instruction::new_with_bytes(
        deal_parameter_registry::id(),
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

    set_clock(&mut svm, 20, NOW + 60);
    let payload =
        deal_parameter_registry::instruction::SetMessagePrice { message_price: 103 }.data();
    let action_accounts = vec![
        ActionAccountMeta {
            pubkey: executor_authority,
            is_signer: true,
            is_writable: false,
        },
        ActionAccountMeta {
            pubkey: registry,
            is_signer: false,
            is_writable: true,
        },
    ];
    for proposal_id in 0..=1u64 {
        let create = Instruction::new_with_bytes(
            deal_governance::id(),
            &deal_governance::instruction::CreateProposal {
                proposal_id,
                kind: ProposalKind::Major,
                target_program: target,
                payload: payload.clone(),
                action_accounts: action_accounts.clone(),
                description_hash: [u8::try_from(proposal_id + 1).unwrap(); 32],
            }
            .data(),
            deal_governance::accounts::CreateProposal {
                payer: payer.pubkey(),
                proposer: voter.pubkey(),
                config,
                d_config,
                d_mint,
                proposer_state: holder_state,
                activity_config,
                target_record,
                proposal: proposal_pda(proposal_id),
                executor_authority,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
        );
        assert!(send(&mut svm, &payer, &[create], &[&voter]));
        assert_eq!(
            anchor_state::<Proposal>(&svm, proposal_pda(proposal_id)).active_nft_supply,
            1
        );

        let proposal = proposal_pda(proposal_id);
        let (vote_receipt, _) = Pubkey::find_program_address(
            &[D_VOTE_SEED, proposal.as_ref(), voter.pubkey().as_ref()],
            &deal_governance::id(),
        );
        let d_vote = Instruction::new_with_bytes(
            deal_governance::id(),
            &deal_governance::instruction::CastDVote {}.data(),
            deal_governance::accounts::CastDVote {
                payer: payer.pubkey(),
                voter: voter.pubkey(),
                config,
                d_config,
                voter_state: holder_state,
                balance_checkpoint,
                successor_checkpoint: None,
                proposal,
                vote_receipt,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
        );
        assert!(send(&mut svm, &payer, &[d_vote], &[&voter]));
    }

    let passing_proposal = proposal_pda(1);
    let (nft_vote_receipt, _) = Pubkey::find_program_address(
        &[NFT_VOTE_SEED, passing_proposal.as_ref(), mint.as_ref()],
        &deal_governance::id(),
    );
    let new_activity_checkpoint = activity_checkpoint_pda(mint, 1);
    let nft_vote = Instruction::new_with_bytes(
        deal_governance::id(),
        &deal_governance::instruction::CastNftVote {
            new_checkpoint_index: 1,
        }
        .data(),
        deal_governance::accounts::CastNftVote {
            voter: voter.pubkey(),
            config,
            proposal: passing_proposal,
            identity_mint: mint,
            identity,
            owner_identity,
            activity_config,
            activity,
            activity_checkpoint: activity_checkpoint0,
            successor_activity_checkpoint: None,
            activity_recorder_grant: executor_recorder_grant,
            executor_authority,
            new_activity_checkpoint,
            vote_receipt: nft_vote_receipt,
            activity_program: deal_governance_activity::id(),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut svm, &voter, std::slice::from_ref(&nft_vote), &[]));
    assert!(!send(&mut svm, &voter, &[nft_vote], &[]));
    assert_eq!(
        anchor_state::<Proposal>(&svm, passing_proposal).nft_support,
        1
    );
    assert_eq!(
        anchor_state::<IdentityActivity>(&svm, activity).checkpoint_count,
        2
    );
    assert_eq!(
        anchor_state::<ActivityCheckpoint>(&svm, new_activity_checkpoint).index,
        1
    );

    set_clock(&mut svm, 30, NOW + 60 + (120 * 60 * 60) + 1);
    let execute = |proposal: Pubkey| {
        let mut instruction = Instruction::new_with_bytes(
            deal_governance::id(),
            &deal_governance::instruction::Execute {}.data(),
            deal_governance::accounts::ExecuteProposal {
                config,
                proposal,
                target_record,
                executor_authority,
                target_program: target,
            }
            .to_account_metas(None),
        );
        instruction.accounts.push(AccountMeta::new(registry, false));
        instruction
    };
    assert!(!send(&mut svm, &payer, &[execute(proposal_pda(0))], &[]));
    assert_eq!(
        anchor_state::<ParameterRegistry>(&svm, registry).message_price,
        100
    );
    assert!(send(&mut svm, &payer, &[execute(passing_proposal)], &[]));
    assert_eq!(
        anchor_state::<ParameterRegistry>(&svm, registry).message_price,
        103
    );
}
