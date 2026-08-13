#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    entrypoint, entrypoint::ProgramResult, program_error::ProgramError,
};

declare_id!("7XAP5nhk6tsEkwHRuXDvKEobRVw9YLstALs2ZCJZmv5T");

pub const ROUTE_MAGIC: [u8; 4] = [68, 76, 86, 50];
pub const DEAL_CORE_MODULE: u8 = 0;
pub const DEAL_ASSET_CONTROLLER_MODULE: u8 = 1;

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(entry);

pub fn entry<'info>(
    program_id: &'info Pubkey,
    accounts: &'info [AccountInfo<'info>],
    data: &'info [u8],
) -> ProgramResult {
    if data.starts_with(&ROUTE_MAGIC) {
        let (&module, legacy_data) = data
            .get(ROUTE_MAGIC.len()..)
            .and_then(|tail| tail.split_first())
            .ok_or(ProgramError::InvalidInstructionData)?;
        return match module {
            0 => deal_core::entry(program_id, accounts, legacy_data),
            1 => deal_asset_controller::entry(program_id, accounts, legacy_data),
            _ => Err(ProgramError::InvalidInstructionData),
        };
    }

    let discriminator: [u8; 8] = data
        .get(..8)
        .and_then(|value| value.try_into().ok())
        .ok_or(ProgramError::InvalidInstructionData)?;
    if discriminator == [178, 197, 165, 227, 2, 78, 181, 194] && accounts.len() == 4 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [178, 197, 165, 227, 2, 78, 181, 194] && accounts.len() == 30 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [107, 86, 198, 91, 33, 12, 107, 160]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    100, 101, 97, 108, 45, 114, 101, 103, 105, 115, 116, 114, 121,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [107, 86, 198, 91, 33, 12, 107, 160]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    97, 115, 115, 101, 116, 45, 99, 111, 110, 116, 114, 111, 108, 108, 101, 114,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [20, 212, 15, 189, 69, 180, 69, 151] && accounts.len() == 2 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [198, 212, 144, 151, 97, 56, 149, 113] && accounts.len() == 4 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [180, 114, 27, 54, 231, 97, 168, 230] && accounts.len() == 5 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [92, 131, 136, 253, 76, 22, 57, 59] && accounts.len() == 4 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [92, 131, 136, 253, 76, 22, 57, 59] && accounts.len() == 30 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [85, 116, 22, 86, 239, 168, 105, 102] && accounts.len() == 4 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [85, 116, 22, 86, 239, 168, 105, 102] && accounts.len() == 30 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [189, 181, 20, 17, 174, 57, 249, 59] && accounts.len() == 3 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [162, 240, 11, 93, 150, 56, 103, 255] && accounts.len() == 2 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [225, 182, 5, 29, 195, 209, 196, 34] && accounts.len() == 4 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [225, 182, 5, 29, 195, 209, 196, 34] && accounts.len() == 7 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [197, 193, 210, 52, 210, 169, 108, 165] && accounts.len() == 4 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [197, 193, 210, 52, 210, 169, 108, 165] && accounts.len() == 30 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [146, 241, 33, 55, 215, 91, 10, 179] && accounts.len() == 2 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [163, 226, 69, 188, 29, 219, 192, 112] && accounts.len() == 2 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    100, 101, 97, 108, 45, 114, 101, 103, 105, 115, 116, 114, 121,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    97, 115, 115, 101, 116, 45, 99, 111, 110, 116, 114, 111, 108, 108, 101, 114,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [98, 130, 249, 185, 16, 42, 16, 162] && accounts.len() == 4 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [171, 163, 42, 100, 42, 10, 78, 94] && accounts.len() == 4 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [133, 74, 49, 134, 14, 36, 75, 62] && accounts.len() == 4 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [133, 74, 49, 134, 14, 36, 75, 62] && accounts.len() == 30 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [140, 205, 44, 37, 4, 15, 243, 129] && accounts.len() == 4 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [140, 205, 44, 37, 4, 15, 243, 129] && accounts.len() == 30 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [185, 81, 82, 56, 237, 180, 145, 40] && accounts.len() == 2 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [86, 76, 17, 115, 134, 57, 182, 21] && accounts.len() == 2 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [146, 167, 94, 103, 106, 54, 128, 133] && accounts.len() == 2 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [49, 1, 222, 39, 127, 105, 68, 28] && accounts.len() == 2 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    100, 101, 97, 108, 45, 114, 101, 103, 105, 115, 116, 114, 121,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    97, 115, 115, 101, 116, 45, 99, 111, 110, 116, 114, 111, 108, 108, 101, 114,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [49, 111, 173, 178, 13, 135, 242, 105] && accounts.len() == 3 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [161, 95, 175, 149, 189, 19, 211, 182] && accounts.len() == 2 {
        return deal_core::entry(program_id, accounts, data);
    }
    if discriminator == [230, 121, 83, 8, 249, 23, 90, 45] && accounts.len() == 30 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [181, 243, 179, 149, 123, 20, 88, 199] && accounts.len() == 5 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [20, 25, 121, 49, 160, 38, 176, 168] && accounts.len() == 10 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [202, 39, 52, 211, 53, 20, 250, 88] && accounts.len() == 14 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [137, 255, 100, 190, 201, 247, 241, 81] && accounts.len() == 3 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [7, 174, 10, 65, 104, 173, 239, 64] && accounts.len() == 13 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [223, 253, 181, 176, 84, 151, 238, 234] && accounts.len() == 30 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [119, 209, 3, 231, 114, 215, 125, 74] && accounts.len() == 20 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [18, 154, 24, 18, 237, 214, 19, 80] && accounts.len() == 2 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [15, 14, 131, 61, 183, 174, 23, 172] && accounts.len() == 2 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [57, 97, 196, 95, 195, 206, 106, 136] && accounts.len() == 2 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [206, 11, 128, 171, 255, 151, 105, 193] && accounts.len() == 13 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    if discriminator == [99, 17, 143, 77, 252, 64, 151, 105] && accounts.len() == 30 {
        return deal_asset_controller::entry(program_id, accounts, data);
    }
    Err(ProgramError::InvalidInstructionData)
}

pub fn route(module: u8, legacy_data: Vec<u8>) -> Vec<u8> {
    let mut data = Vec::with_capacity(ROUTE_MAGIC.len() + 1 + legacy_data.len());
    data.extend_from_slice(&ROUTE_MAGIC);
    data.push(module);
    data.extend_from_slice(&legacy_data);
    data
}

#[cfg(test)]
mod router_tests {
    use super::*;

    #[test]
    fn explicit_route_envelope_is_stable() {
        assert_eq!(route(7, vec![1, 2, 3]), vec![68, 76, 86, 50, 7, 1, 2, 3]);
    }

    #[test]
    fn malformed_and_unknown_routes_are_rejected() {
        assert_eq!(
            entry(&crate::ID, &[], &[]),
            Err(ProgramError::InvalidInstructionData)
        );
        assert_eq!(
            entry(&crate::ID, &[], &ROUTE_MAGIC),
            Err(ProgramError::InvalidInstructionData)
        );
        assert_eq!(
            entry(&crate::ID, &[], &route(u8::MAX, Vec::new())),
            Err(ProgramError::InvalidInstructionData)
        );
        assert_eq!(
            entry(&crate::ID, &[], &[0_u8; 8]),
            Err(ProgramError::InvalidInstructionData)
        );
    }

    fn test_account(key: Pubkey) -> AccountInfo<'static> {
        let key = Box::leak(Box::new(key));
        let owner = Box::leak(Box::new(anchor_lang::solana_program::system_program::ID));
        let lamports = Box::leak(Box::new(0_u64));
        let data = Box::leak(Vec::<u8>::new().into_boxed_slice());
        AccountInfo::new(key, false, true, lamports, data, owner, false)
    }

    #[test]
    fn raw_collision_rejects_noncanonical_pdas() {
        let accounts: Vec<_> = (0..2).map(|_| test_account(Pubkey::new_unique())).collect();
        let accounts = Box::leak(accounts.into_boxed_slice());
        let data = Box::leak(Box::new([107, 86, 198, 91, 33, 12, 107, 160]));
        let program_id = Box::leak(Box::new(crate::ID));
        assert_eq!(
            entry(program_id, accounts, data),
            Err(ProgramError::InvalidInstructionData)
        );
    }
}
