#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    entrypoint, entrypoint::ProgramResult, program_error::ProgramError,
};

declare_id!("FGfBWHNDZCZJCMWT1yhw87sArj2NCs9yEeX3xMC7MjTn");

pub const ROUTE_MAGIC: [u8; 4] = [68, 76, 86, 50];
pub const DEAL_HISTORY_INDEX_MODULE: u8 = 0;
pub const DEAL_RESULT_INDEX_MODULE: u8 = 1;
pub const DEAL_MESSAGE_HUB_MODULE: u8 = 2;

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
            0 => deal_history_index::entry(program_id, accounts, legacy_data),
            1 => deal_result_index::entry(program_id, accounts, legacy_data),
            2 => deal_message_hub::entry(program_id, accounts, legacy_data),
            _ => Err(ProgramError::InvalidInstructionData),
        };
    }

    let discriminator: [u8; 8] = data
        .get(..8)
        .and_then(|value| value.try_into().ok())
        .ok_or(ProgramError::InvalidInstructionData)?;
    if discriminator == [107, 86, 198, 91, 33, 12, 107, 160]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    104, 105, 115, 116, 111, 114, 121, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_history_index::entry(program_id, accounts, data);
    }
    if discriminator == [107, 86, 198, 91, 33, 12, 107, 160]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    114, 101, 115, 117, 108, 116, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_result_index::entry(program_id, accounts, data);
    }
    if discriminator == [107, 86, 198, 91, 33, 12, 107, 160]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    109, 101, 115, 115, 97, 103, 101, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_message_hub::entry(program_id, accounts, data);
    }
    if discriminator == [117, 226, 185, 68, 181, 147, 164, 231] && accounts.len() == 7 {
        return deal_history_index::entry(program_id, accounts, data);
    }
    if discriminator == [60, 221, 230, 69, 8, 171, 168, 108] && accounts.len() == 8 {
        return deal_history_index::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237]
        && accounts.len() == 4
        && accounts.get(2).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    104, 105, 115, 116, 111, 114, 121, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_history_index::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237]
        && accounts.len() == 4
        && accounts.get(2).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    114, 101, 115, 117, 108, 116, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_result_index::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237]
        && accounts.len() == 4
        && accounts.get(2).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    109, 101, 115, 115, 97, 103, 101, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_message_hub::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    104, 105, 115, 116, 111, 114, 121, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_history_index::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    114, 101, 115, 117, 108, 116, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_result_index::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    109, 101, 115, 115, 97, 103, 101, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_message_hub::entry(program_id, accounts, data);
    }
    if discriminator == [206, 97, 199, 72, 22, 174, 68, 238] && accounts.len() == 6 {
        return deal_history_index::entry(program_id, accounts, data);
    }
    if discriminator == [9, 232, 18, 147, 210, 219, 148, 117] && accounts.len() == 6 {
        return deal_history_index::entry(program_id, accounts, data);
    }
    if discriminator == [36, 225, 129, 113, 57, 207, 166, 180] && accounts.len() == 7 {
        return deal_history_index::entry(program_id, accounts, data);
    }
    if discriminator == [32, 117, 168, 95, 26, 61, 246, 41] && accounts.len() == 7 {
        return deal_history_index::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    104, 105, 115, 116, 111, 114, 121, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_history_index::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    114, 101, 115, 117, 108, 116, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_result_index::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    109, 101, 115, 115, 97, 103, 101, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_message_hub::entry(program_id, accounts, data);
    }
    if discriminator == [172, 130, 203, 37, 205, 22, 226, 112]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    104, 105, 115, 116, 111, 114, 121, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_history_index::entry(program_id, accounts, data);
    }
    if discriminator == [172, 130, 203, 37, 205, 22, 226, 112]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    109, 101, 115, 115, 97, 103, 101, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_message_hub::entry(program_id, accounts, data);
    }
    if discriminator == [87, 18, 193, 98, 84, 21, 149, 214] && accounts.len() == 9 {
        return deal_result_index::entry(program_id, accounts, data);
    }
    if discriminator == [244, 218, 92, 254, 200, 107, 198, 178] && accounts.len() == 9 {
        return deal_result_index::entry(program_id, accounts, data);
    }
    if discriminator == [22, 217, 208, 51, 153, 7, 0, 211] && accounts.len() == 7 {
        return deal_message_hub::entry(program_id, accounts, data);
    }
    if discriminator == [214, 50, 100, 209, 38, 34, 7, 76] && accounts.len() == 9 {
        return deal_message_hub::entry(program_id, accounts, data);
    }
    if discriminator == [214, 251, 143, 82, 101, 124, 133, 235] && accounts.len() == 2 {
        return deal_message_hub::entry(program_id, accounts, data);
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
