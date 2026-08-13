#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    entrypoint, entrypoint::ProgramResult, program_error::ProgramError,
};

declare_id!("254WzKpJ7RXvpS1UHeZJqhRUMcsHN5U868eqjviMgihg");

pub const ROUTE_MAGIC: [u8; 4] = [68, 76, 86, 50];
pub const DEAL_DOMAIN_RANK_MODULE: u8 = 0;
pub const DEAL_DOMAIN_ENTRY_MODULE: u8 = 1;
pub const DEAL_DOMAIN_HALL_MODULE: u8 = 2;

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
            0 => deal_domain_rank::entry(program_id, accounts, legacy_data),
            1 => deal_domain_entry::entry(program_id, accounts, legacy_data),
            2 => deal_domain_hall::entry(program_id, accounts, legacy_data),
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
                    100, 111, 109, 97, 105, 110, 45, 114, 97, 110, 107, 45, 99, 111, 110, 102, 105,
                    103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [107, 86, 198, 91, 33, 12, 107, 160]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    100, 111, 109, 97, 105, 110, 45, 101, 110, 116, 114, 121, 45, 99, 111, 110,
                    102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_entry::entry(program_id, accounts, data);
    }
    if discriminator == [107, 86, 198, 91, 33, 12, 107, 160]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    100, 111, 109, 97, 105, 110, 45, 104, 97, 108, 108, 45, 99, 111, 110, 102, 105,
                    103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_hall::entry(program_id, accounts, data);
    }
    if discriminator == [157, 173, 33, 216, 146, 16, 65, 82] && accounts.len() == 9 {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [216, 21, 150, 202, 80, 231, 52, 56] && accounts.len() == 9 {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [242, 35, 198, 137, 82, 225, 242, 182] && accounts.len() == 12 {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237] && accounts.len() == 8 {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237]
        && accounts.len() == 4
        && accounts.get(2).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    100, 111, 109, 97, 105, 110, 45, 101, 110, 116, 114, 121, 45, 99, 111, 110,
                    102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_entry::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237]
        && accounts.len() == 4
        && accounts.get(2).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    100, 111, 109, 97, 105, 110, 45, 104, 97, 108, 108, 45, 99, 111, 110, 102, 105,
                    103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_hall::entry(program_id, accounts, data);
    }
    if discriminator == [222, 92, 79, 212, 122, 181, 153, 122] && accounts.len() == 10 {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    100, 111, 109, 97, 105, 110, 45, 114, 97, 110, 107, 45, 99, 111, 110, 102, 105,
                    103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    100, 111, 109, 97, 105, 110, 45, 101, 110, 116, 114, 121, 45, 99, 111, 110,
                    102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_entry::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    100, 111, 109, 97, 105, 110, 45, 104, 97, 108, 108, 45, 99, 111, 110, 102, 105,
                    103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_hall::entry(program_id, accounts, data);
    }
    if discriminator == [142, 229, 136, 117, 132, 10, 101, 236] && accounts.len() == 9 {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [132, 111, 168, 111, 147, 75, 126, 138] && accounts.len() == 2 {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [245, 159, 206, 112, 102, 60, 236, 123] && accounts.len() == 6 {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [180, 56, 72, 92, 200, 70, 99, 4] && accounts.len() == 5 {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [18, 100, 161, 9, 204, 252, 141, 27] && accounts.len() == 2 {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [15, 182, 74, 248, 251, 148, 186, 171] && accounts.len() == 2 {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    100, 111, 109, 97, 105, 110, 45, 114, 97, 110, 107, 45, 99, 111, 110, 102, 105,
                    103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    100, 111, 109, 97, 105, 110, 45, 101, 110, 116, 114, 121, 45, 99, 111, 110,
                    102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_entry::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    100, 111, 109, 97, 105, 110, 45, 104, 97, 108, 108, 45, 99, 111, 110, 102, 105,
                    103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_hall::entry(program_id, accounts, data);
    }
    if discriminator == [110, 125, 138, 144, 71, 228, 139, 51] && accounts.len() == 2 {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [85, 106, 154, 18, 252, 50, 144, 189] && accounts.len() == 5 {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [57, 97, 196, 95, 195, 206, 106, 136] && accounts.len() == 2 {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [197, 59, 182, 208, 73, 187, 119, 25] && accounts.len() == 10 {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [32, 160, 146, 72, 24, 73, 3, 65] && accounts.len() == 9 {
        return deal_domain_rank::entry(program_id, accounts, data);
    }
    if discriminator == [88, 51, 86, 168, 119, 53, 89, 187] && accounts.len() == 7 {
        return deal_domain_entry::entry(program_id, accounts, data);
    }
    if discriminator == [180, 114, 27, 54, 231, 97, 168, 230] && accounts.len() == 17 {
        return deal_domain_entry::entry(program_id, accounts, data);
    }
    if discriminator == [15, 73, 32, 9, 9, 211, 34, 181] && accounts.len() == 2 {
        return deal_domain_entry::entry(program_id, accounts, data);
    }
    if discriminator == [53, 197, 170, 60, 121, 183, 143, 51] && accounts.len() == 13 {
        return deal_domain_hall::entry(program_id, accounts, data);
    }
    if discriminator == [99, 208, 155, 105, 32, 153, 50, 175] && accounts.len() == 13 {
        return deal_domain_hall::entry(program_id, accounts, data);
    }
    if discriminator == [214, 251, 143, 82, 101, 124, 133, 235] && accounts.len() == 2 {
        return deal_domain_hall::entry(program_id, accounts, data);
    }
    if discriminator == [42, 220, 171, 143, 191, 193, 250, 6] && accounts.len() == 9 {
        return deal_domain_hall::entry(program_id, accounts, data);
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
