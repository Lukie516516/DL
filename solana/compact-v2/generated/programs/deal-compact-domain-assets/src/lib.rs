#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    entrypoint, entrypoint::ProgramResult, program_error::ProgramError,
};

declare_id!("21m75WjpLxPYnFYFgP4srJQmfBKgUfSMP9xmp6pLsXuw");

pub const ROUTE_MAGIC: [u8; 4] = [68, 76, 86, 50];
pub const DEAL_DOMAIN_REGISTRY_MODULE: u8 = 0;
pub const DEAL_DOMAIN_MARKET_MODULE: u8 = 1;

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
            0 => deal_domain_registry::entry(program_id, accounts, legacy_data),
            1 => deal_domain_market::entry(program_id, accounts, legacy_data),
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
                &[&[100, 111, 109, 97, 105, 110, 45, 99, 111, 110, 102, 105, 103][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_registry::entry(program_id, accounts, data);
    }
    if discriminator == [107, 86, 198, 91, 33, 12, 107, 160]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    100, 111, 109, 97, 105, 110, 45, 109, 97, 114, 107, 101, 116, 45, 99, 111, 110,
                    102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_market::entry(program_id, accounts, data);
    }
    if discriminator == [244, 102, 241, 168, 179, 51, 56, 40] && accounts.len() == 10 {
        return deal_domain_registry::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237]
        && accounts.len() == 4
        && accounts.get(2).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[100, 111, 109, 97, 105, 110, 45, 99, 111, 110, 102, 105, 103][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_registry::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237]
        && accounts.len() == 4
        && accounts.get(2).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    100, 111, 109, 97, 105, 110, 45, 109, 97, 114, 107, 101, 116, 45, 99, 111, 110,
                    102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_market::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[100, 111, 109, 97, 105, 110, 45, 99, 111, 110, 102, 105, 103][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_registry::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    100, 111, 109, 97, 105, 110, 45, 109, 97, 114, 107, 101, 116, 45, 99, 111, 110,
                    102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_market::entry(program_id, accounts, data);
    }
    if discriminator == [211, 124, 67, 15, 211, 194, 178, 240] && accounts.len() == 13 {
        return deal_domain_registry::entry(program_id, accounts, data);
    }
    if discriminator == [45, 82, 97, 91, 128, 60, 33, 12] && accounts.len() == 11 {
        return deal_domain_registry::entry(program_id, accounts, data);
    }
    if discriminator == [23, 18, 11, 250, 35, 105, 97, 7] && accounts.len() == 2 {
        return deal_domain_registry::entry(program_id, accounts, data);
    }
    if discriminator == [233, 20, 136, 239, 245, 185, 196, 216] && accounts.len() == 2 {
        return deal_domain_registry::entry(program_id, accounts, data);
    }
    if discriminator == [78, 157, 75, 242, 151, 20, 121, 144] && accounts.len() == 2 {
        return deal_domain_registry::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[100, 111, 109, 97, 105, 110, 45, 99, 111, 110, 102, 105, 103][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_registry::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    100, 111, 109, 97, 105, 110, 45, 109, 97, 114, 107, 101, 116, 45, 99, 111, 110,
                    102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_domain_market::entry(program_id, accounts, data);
    }
    if discriminator == [18, 2, 170, 172, 190, 140, 242, 27] && accounts.len() == 4 {
        return deal_domain_registry::entry(program_id, accounts, data);
    }
    if discriminator == [11, 120, 252, 241, 211, 32, 236, 188] && accounts.len() == 2 {
        return deal_domain_registry::entry(program_id, accounts, data);
    }
    if discriminator == [57, 97, 196, 95, 195, 206, 106, 136] && accounts.len() == 2 {
        return deal_domain_registry::entry(program_id, accounts, data);
    }
    if discriminator == [129, 115, 193, 43, 174, 5, 241, 52] && accounts.len() == 10 {
        return deal_domain_registry::entry(program_id, accounts, data);
    }
    if discriminator == [102, 6, 61, 18, 1, 218, 235, 234] && accounts.len() == 18 {
        return deal_domain_market::entry(program_id, accounts, data);
    }
    if discriminator == [55, 136, 205, 107, 107, 173, 4, 31] && accounts.len() == 12 {
        return deal_domain_market::entry(program_id, accounts, data);
    }
    if discriminator == [54, 174, 193, 67, 17, 41, 132, 38] && accounts.len() == 12 {
        return deal_domain_market::entry(program_id, accounts, data);
    }
    if discriminator == [2, 161, 245, 141, 111, 32, 39, 198] && accounts.len() == 2 {
        return deal_domain_market::entry(program_id, accounts, data);
    }
    if discriminator == [227, 18, 215, 42, 237, 246, 151, 66] && accounts.len() == 2 {
        return deal_domain_market::entry(program_id, accounts, data);
    }
    if discriminator == [192, 174, 210, 68, 116, 40, 242, 253] && accounts.len() == 2 {
        return deal_domain_market::entry(program_id, accounts, data);
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
