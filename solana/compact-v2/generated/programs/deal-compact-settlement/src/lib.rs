#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    entrypoint, entrypoint::ProgramResult, program_error::ProgramError,
};

declare_id!("7m8WXGUfwnuyxi2GmzNepfkrXgsCAurTKvANSdPqZXzG");

pub const ROUTE_MAGIC: [u8; 4] = [68, 76, 86, 50];
pub const DEAL_FINALIZER_MODULE: u8 = 0;
pub const DEAL_CREDIT_VALUATOR_MODULE: u8 = 1;
pub const DEAL_REWARD_ENGINE_MODULE: u8 = 2;

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
            0 => deal_finalizer::entry(program_id, accounts, legacy_data),
            1 => deal_credit_valuator::entry(program_id, accounts, legacy_data),
            2 => deal_reward_engine::entry(program_id, accounts, legacy_data),
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
                    102, 105, 110, 97, 108, 105, 122, 101, 114, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_finalizer::entry(program_id, accounts, data);
    }
    if discriminator == [107, 86, 198, 91, 33, 12, 107, 160]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[114, 101, 119, 97, 114, 100, 45, 99, 111, 110, 102, 105, 103][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_reward_engine::entry(program_id, accounts, data);
    }
    if discriminator == [133, 254, 92, 140, 209, 202, 44, 233] && accounts.len() == 10 {
        return deal_finalizer::entry(program_id, accounts, data);
    }
    if discriminator == [66, 84, 248, 38, 216, 249, 27, 73] && accounts.len() == 8 {
        return deal_finalizer::entry(program_id, accounts, data);
    }
    if discriminator == [198, 19, 122, 23, 4, 187, 91, 254] && accounts.len() == 13 {
        return deal_finalizer::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237] && accounts.len() == 5 {
        return deal_finalizer::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237] && accounts.len() == 8 {
        return deal_reward_engine::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    102, 105, 110, 97, 108, 105, 122, 101, 114, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_finalizer::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[114, 101, 119, 97, 114, 100, 45, 99, 111, 110, 102, 105, 103][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_reward_engine::entry(program_id, accounts, data);
    }
    if discriminator == [42, 140, 173, 224, 128, 128, 32, 196] && accounts.len() == 23 {
        return deal_finalizer::entry(program_id, accounts, data);
    }
    if discriminator == [70, 0, 202, 119, 72, 53, 128, 20] && accounts.len() == 10 {
        return deal_finalizer::entry(program_id, accounts, data);
    }
    if discriminator == [213, 8, 103, 45, 223, 254, 169, 198] && accounts.len() == 18 {
        return deal_finalizer::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    102, 105, 110, 97, 108, 105, 122, 101, 114, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_finalizer::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[114, 101, 119, 97, 114, 100, 45, 99, 111, 110, 102, 105, 103][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_reward_engine::entry(program_id, accounts, data);
    }
    if discriminator == [111, 163, 160, 231, 205, 8, 189, 74] && accounts.len() == 13 {
        return deal_credit_valuator::entry(program_id, accounts, data);
    }
    if discriminator == [40, 11, 209, 98, 47, 139, 95, 222] && accounts.len() == 28 {
        return deal_reward_engine::entry(program_id, accounts, data);
    }
    if discriminator == [155, 13, 113, 30, 136, 249, 169, 191] && accounts.len() == 15 {
        return deal_reward_engine::entry(program_id, accounts, data);
    }
    if discriminator == [118, 114, 123, 137, 233, 55, 148, 32] && accounts.len() == 10 {
        return deal_reward_engine::entry(program_id, accounts, data);
    }
    if discriminator == [150, 82, 173, 253, 110, 225, 10, 155] && accounts.len() == 2 {
        return deal_reward_engine::entry(program_id, accounts, data);
    }
    if discriminator == [253, 201, 190, 20, 48, 38, 120, 34] && accounts.len() == 3 {
        return deal_reward_engine::entry(program_id, accounts, data);
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
