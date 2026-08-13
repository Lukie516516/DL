#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    entrypoint, entrypoint::ProgramResult, program_error::ProgramError,
};

declare_id!("4uhbTXV4SnMgFje7EiJFE6hKjWPfQUDYYkg9AytrZUxW");

pub const ROUTE_MAGIC: [u8; 4] = [68, 76, 86, 50];
pub const DEAL_IDENTITY_MODULE: u8 = 0;
pub const DEAL_CREDIT_GRAPH_MODULE: u8 = 1;

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
            0 => deal_identity::entry(program_id, accounts, legacy_data),
            1 => deal_credit_graph::entry(program_id, accounts, legacy_data),
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
                    105, 100, 101, 110, 116, 105, 116, 121, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_identity::entry(program_id, accounts, data);
    }
    if discriminator == [107, 86, 198, 91, 33, 12, 107, 160]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[99, 114, 101, 100, 105, 116, 45, 99, 111, 110, 102, 105, 103][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_credit_graph::entry(program_id, accounts, data);
    }
    if discriminator == [227, 228, 68, 132, 22, 40, 174, 47] && accounts.len() == 3 {
        return deal_identity::entry(program_id, accounts, data);
    }
    if discriminator == [201, 136, 150, 184, 222, 42, 20, 47] && accounts.len() == 3 {
        return deal_identity::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237]
        && accounts.len() == 4
        && accounts.get(2).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    105, 100, 101, 110, 116, 105, 116, 121, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_identity::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237]
        && accounts.len() == 4
        && accounts.get(2).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[99, 114, 101, 100, 105, 116, 45, 99, 111, 110, 102, 105, 103][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_credit_graph::entry(program_id, accounts, data);
    }
    if discriminator == [7, 174, 10, 65, 104, 173, 239, 64] && accounts.len() == 12 {
        return deal_identity::entry(program_id, accounts, data);
    }
    if discriminator == [52, 13, 109, 146, 207, 249, 188, 220] && accounts.len() == 13 {
        return deal_identity::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    105, 100, 101, 110, 116, 105, 116, 121, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_identity::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[99, 114, 101, 100, 105, 116, 45, 99, 111, 110, 102, 105, 103][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_credit_graph::entry(program_id, accounts, data);
    }
    if discriminator == [208, 198, 88, 49, 176, 255, 121, 52] && accounts.len() == 2 {
        return deal_identity::entry(program_id, accounts, data);
    }
    if discriminator == [193, 125, 246, 73, 107, 15, 254, 101] && accounts.len() == 4 {
        return deal_identity::entry(program_id, accounts, data);
    }
    if discriminator == [105, 146, 251, 12, 72, 223, 220, 66] && accounts.len() == 2 {
        return deal_identity::entry(program_id, accounts, data);
    }
    if discriminator == [81, 77, 224, 37, 44, 202, 10, 175] && accounts.len() == 2 {
        return deal_identity::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    105, 100, 101, 110, 116, 105, 116, 121, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_identity::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[99, 114, 101, 100, 105, 116, 45, 99, 111, 110, 102, 105, 103][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_credit_graph::entry(program_id, accounts, data);
    }
    if discriminator == [221, 221, 195, 121, 133, 71, 113, 170] && accounts.len() == 5 {
        return deal_identity::entry(program_id, accounts, data);
    }
    if discriminator == [241, 47, 38, 83, 107, 10, 141, 53] && accounts.len() == 2 {
        return deal_identity::entry(program_id, accounts, data);
    }
    if discriminator == [201, 136, 214, 252, 137, 179, 59, 7] && accounts.len() == 2 {
        return deal_identity::entry(program_id, accounts, data);
    }
    if discriminator == [206, 11, 128, 171, 255, 151, 105, 193] && accounts.len() == 9 {
        return deal_identity::entry(program_id, accounts, data);
    }
    if discriminator == [84, 84, 77, 159, 90, 174, 153, 111] && accounts.len() == 6 {
        return deal_credit_graph::entry(program_id, accounts, data);
    }
    if discriminator == [243, 130, 242, 232, 217, 236, 27, 147] && accounts.len() == 2 {
        return deal_credit_graph::entry(program_id, accounts, data);
    }
    if discriminator == [220, 254, 113, 153, 228, 62, 105, 75] && accounts.len() == 12 {
        return deal_credit_graph::entry(program_id, accounts, data);
    }
    if discriminator == [163, 158, 15, 208, 66, 190, 87, 21] && accounts.len() == 8 {
        return deal_credit_graph::entry(program_id, accounts, data);
    }
    if discriminator == [212, 158, 4, 172, 25, 87, 43, 207] && accounts.len() == 2 {
        return deal_credit_graph::entry(program_id, accounts, data);
    }
    if discriminator == [213, 241, 95, 130, 50, 251, 54, 146] && accounts.len() == 2 {
        return deal_credit_graph::entry(program_id, accounts, data);
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
