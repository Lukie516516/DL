#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    entrypoint, entrypoint::ProgramResult, program_error::ProgramError,
};

declare_id!("CGgu8uUw5BzkQtCW4JqaXLmAhwsHAX8VNRkVC5vbp3Jr");

pub const ROUTE_MAGIC: [u8; 4] = [68, 76, 86, 50];
pub const DEAL_DC_CONTROLLER_MODULE: u8 = 0;
pub const DEAL_PARAMETER_REGISTRY_MODULE: u8 = 1;

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
            0 => deal_dc_controller::entry(program_id, accounts, legacy_data),
            1 => deal_parameter_registry::entry(program_id, accounts, legacy_data),
            _ => Err(ProgramError::InvalidInstructionData),
        };
    }

    let discriminator: [u8; 8] = data
        .get(..8)
        .and_then(|value| value.try_into().ok())
        .ok_or(ProgramError::InvalidInstructionData)?;
    if discriminator == [107, 86, 198, 91, 33, 12, 107, 160] && accounts.len() == 2 {
        return deal_dc_controller::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237] && accounts.len() == 7 {
        return deal_dc_controller::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237] && accounts.len() == 3 {
        return deal_parameter_registry::entry(program_id, accounts, data);
    }
    if discriminator == [51, 57, 225, 47, 182, 146, 137, 166] && accounts.len() == 6 {
        return deal_dc_controller::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142] && accounts.len() == 2 {
        return deal_dc_controller::entry(program_id, accounts, data);
    }
    if discriminator == [13, 170, 92, 172, 137, 194, 39, 2] && accounts.len() == 5 {
        return deal_dc_controller::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218] && accounts.len() == 2 {
        return deal_dc_controller::entry(program_id, accounts, data);
    }
    if discriminator == [247, 85, 29, 72, 156, 220, 122, 198] && accounts.len() == 2 {
        return deal_parameter_registry::entry(program_id, accounts, data);
    }
    if discriminator == [138, 172, 54, 68, 198, 122, 198, 179] && accounts.len() == 2 {
        return deal_parameter_registry::entry(program_id, accounts, data);
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
