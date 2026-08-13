use anchor_lang::{prelude::Pubkey, AccountSerialize, InstructionData};
use deal_compact_monetary_policy as compact;
use deal_dc_controller as legacy_dc;
use deal_parameter_registry as legacy_parameters;

fn account_bytes<T: AccountSerialize>(value: &T) -> Vec<u8> {
    let mut bytes = Vec::new();
    value.try_serialize(&mut bytes).unwrap();
    bytes
}

#[test]
fn dc_instruction_data_and_account_layout_are_unchanged() {
    let authority = Pubkey::new_unique();
    assert_eq!(
        legacy_dc::instruction::Initialize {}.data(),
        compact::instruction::Initialize {}.data(),
    );
    assert_eq!(
        legacy_dc::instruction::SetPaused { paused: false }.data(),
        compact::instruction::SetPaused { paused: false }.data(),
    );
    assert_eq!(
        legacy_dc::instruction::SetMinter { enabled: true }.data(),
        compact::instruction::SetMinter { enabled: true }.data(),
    );
    assert_eq!(
        legacy_dc::instruction::Mint { amount: 42 }.data(),
        compact::instruction::Mint { amount: 42 }.data(),
    );
    assert_eq!(
        legacy_dc::instruction::ProposeAuthority {
            pending_authority: authority,
        }
        .data(),
        compact::instruction::ProposeAuthority {
            pending_authority: authority,
        }
        .data(),
    );
    assert_eq!(
        legacy_dc::instruction::AcceptAuthority {}.data(),
        compact::instruction::AcceptAuthority {}.data(),
    );

    let legacy_config = legacy_dc::DcControllerConfig {
        authority,
        pending_authority: Pubkey::new_unique(),
        dc_mint: Pubkey::new_unique(),
        dc_token_program: Pubkey::new_unique(),
        total_minted: 123_456,
        paused: true,
        bump: 254,
    };
    let compact_config = compact::DcControllerConfig {
        authority: legacy_config.authority,
        pending_authority: legacy_config.pending_authority,
        dc_mint: legacy_config.dc_mint,
        dc_token_program: legacy_config.dc_token_program,
        total_minted: legacy_config.total_minted,
        paused: legacy_config.paused,
        bump: legacy_config.bump,
    };
    assert_eq!(
        account_bytes(&legacy_config),
        account_bytes(&compact_config)
    );

    let legacy_grant = legacy_dc::MinterGrant {
        minter: Pubkey::new_unique(),
        enabled: true,
        bump: 200,
    };
    let compact_grant = compact::MinterGrant {
        minter: legacy_grant.minter,
        enabled: legacy_grant.enabled,
        bump: legacy_grant.bump,
    };
    assert_eq!(account_bytes(&legacy_grant), account_bytes(&compact_grant));
}

#[test]
fn parameter_payload_and_account_layout_are_unchanged() {
    let governance_authority = Pubkey::new_unique();
    let legacy_initialize = legacy_parameters::instruction::Initialize {
        governance_authority,
        message_price: 987,
        min_window_sec: 3_600,
    }
    .data();
    let compact_initialize = compact::instruction::InitializeParameters {
        governance_authority,
        message_price: 987,
        min_window_sec: 3_600,
    }
    .data();
    assert_ne!(&legacy_initialize[..8], &compact_initialize[..8]);
    assert_eq!(&legacy_initialize[8..], &compact_initialize[8..]);
    assert_eq!(
        legacy_parameters::instruction::SetMessagePrice { message_price: 8 }.data(),
        compact::instruction::SetMessagePrice { message_price: 8 }.data(),
    );
    assert_eq!(
        legacy_parameters::instruction::SetMinWindowSec { min_window_sec: 60 }.data(),
        compact::instruction::SetMinWindowSec { min_window_sec: 60 }.data(),
    );

    let legacy = legacy_parameters::ParameterRegistry {
        governance_authority,
        message_price: 111,
        min_window_sec: 86_400,
        bump: 199,
    };
    let compact = compact::ParameterRegistry {
        governance_authority: legacy.governance_authority,
        message_price: legacy.message_price,
        min_window_sec: legacy.min_window_sec,
        bump: legacy.bump,
    };
    assert_eq!(account_bytes(&legacy), account_bytes(&compact));
}

#[test]
fn compact_error_namespaces_do_not_overlap() {
    let dc_first: u32 = compact::DcControllerError::ZeroAddress.into();
    let dc_last: u32 = compact::DcControllerError::ArithmeticOverflow.into();
    let parameter_first: u32 = compact::ParameterRegistryError::ZeroAuthority.into();
    let parameter_last: u32 = compact::ParameterRegistryError::InvalidWindow.into();
    assert_eq!(dc_first, 6_000);
    assert!(dc_last < 6_100);
    assert_eq!(parameter_first, 6_100);
    assert!(parameter_last < 6_200);
}
