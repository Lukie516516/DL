#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    entrypoint, entrypoint::ProgramResult, program_error::ProgramError,
};

declare_id!("yMNjETfB7r8J6FqjsDH9ZR11ZfCLLgoeQHp4nbXg3jp");

pub const ROUTE_MAGIC: [u8; 4] = [68, 76, 86, 50];
pub const DEAL_GOVERNANCE_EXECUTOR_MODULE: u8 = 0;

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
            0 => deal_governance_executor::entry(program_id, accounts, legacy_data),
            _ => Err(ProgramError::InvalidInstructionData),
        };
    }

    let discriminator: [u8; 8] = data
        .get(..8)
        .and_then(|value| value.try_into().ok())
        .ok_or(ProgramError::InvalidInstructionData)?;
    if discriminator == [107, 86, 198, 91, 33, 12, 107, 160] && accounts.len() == 2 {
        return deal_governance_executor::entry(program_id, accounts, data);
    }
    if discriminator == [149, 141, 85, 212, 124, 226, 208, 94] && accounts.len() == 3 {
        return deal_governance_executor::entry(program_id, accounts, data);
    }
    if discriminator == [215, 137, 81, 162, 147, 50, 198, 231] && accounts.len() == 5 {
        return deal_governance_executor::entry(program_id, accounts, data);
    }
    if discriminator == [252, 138, 50, 12, 225, 130, 152, 6] && accounts.len() >= 5 {
        return deal_governance_executor::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237] && accounts.len() == 5 {
        return deal_governance_executor::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142] && accounts.len() == 2 {
        return deal_governance_executor::entry(program_id, accounts, data);
    }
    if discriminator == [17, 183, 229, 60, 190, 244, 82, 49] && accounts.len() == 4 {
        return deal_governance_executor::entry(program_id, accounts, data);
    }
    if discriminator == [60, 40, 214, 147, 21, 49, 130, 179] && accounts.len() == 2 {
        return deal_governance_executor::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218] && accounts.len() == 2 {
        return deal_governance_executor::entry(program_id, accounts, data);
    }
    if discriminator == [136, 61, 231, 10, 214, 70, 18, 31] && accounts.len() == 2 {
        return deal_governance_executor::entry(program_id, accounts, data);
    }
    if discriminator == [155, 53, 245, 104, 116, 169, 239, 167] && accounts.len() == 2 {
        return deal_governance_executor::entry(program_id, accounts, data);
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
}
