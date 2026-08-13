#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    entrypoint, entrypoint::ProgramResult, program_error::ProgramError,
};

declare_id!("AiTezfTJ3DxeFr7oRiBhnz3wRZTJzCsrexhmRJd3u7rF");

pub const ROUTE_MAGIC: [u8; 4] = [68, 76, 86, 50];
pub const DEAL_PROTOCOL_TREASURY_MODULE: u8 = 0;

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
            0 => deal_protocol_treasury::entry(program_id, accounts, legacy_data),
            _ => Err(ProgramError::InvalidInstructionData),
        };
    }

    let discriminator: [u8; 8] = data
        .get(..8)
        .and_then(|value| value.try_into().ok())
        .ok_or(ProgramError::InvalidInstructionData)?;
    if discriminator == [105, 248, 48, 3, 255, 41, 183, 220] && accounts.len() == 2 {
        return deal_protocol_treasury::entry(program_id, accounts, data);
    }
    if discriminator == [236, 240, 111, 234, 11, 230, 101, 43] && accounts.len() == 4 {
        return deal_protocol_treasury::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237] && accounts.len() == 4 {
        return deal_protocol_treasury::entry(program_id, accounts, data);
    }
    if discriminator == [224, 106, 213, 217, 207, 24, 60, 25] && accounts.len() == 2 {
        return deal_protocol_treasury::entry(program_id, accounts, data);
    }
    if discriminator == [116, 31, 164, 230, 244, 244, 218, 204] && accounts.len() == 5 {
        return deal_protocol_treasury::entry(program_id, accounts, data);
    }
    if discriminator == [165, 233, 248, 250, 110, 155, 215, 142] && accounts.len() == 7 {
        return deal_protocol_treasury::entry(program_id, accounts, data);
    }
    if discriminator == [191, 87, 150, 143, 62, 190, 96, 72] && accounts.len() == 2 {
        return deal_protocol_treasury::entry(program_id, accounts, data);
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
