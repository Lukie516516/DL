#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{entrypoint, entrypoint::ProgramResult, program_error::ProgramError};

declare_id!("BMHErQjGPrA5dCURDqk9fDRwz4xx7ZVVpxWfXdGLy51j");

/// The first byte selects a legacy module; the remaining bytes are the exact
/// legacy Anchor instruction payload. No handler or account validation is
/// reimplemented by this router.
pub const PAIR_MODULE: u8 = 0;
pub const QUOTER_MODULE: u8 = 1;

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(entry);

pub fn entry<'info>(
    program_id: &'info Pubkey,
    accounts: &'info [AccountInfo<'info>],
    data: &'info [u8],
) -> ProgramResult {
    let (&module, legacy_data) = data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;
    match module {
        PAIR_MODULE => deal_dex_pair::entry(program_id, accounts, legacy_data),
        QUOTER_MODULE => deal_dex_quoter::entry(program_id, accounts, legacy_data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
pub fn route(module: u8, legacy_data: Vec<u8>) -> Vec<u8> {
    let mut data = Vec::with_capacity(legacy_data.len() + 1);
    data.push(module);
    data.extend_from_slice(&legacy_data);
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_envelope_preserves_legacy_payload_byte_for_byte() {
        let legacy = vec![1, 2, 3, 4, 5, 6, 7, 8, 9];
        let routed = route(QUOTER_MODULE, legacy.clone());
        assert_eq!(routed[0], QUOTER_MODULE);
        assert_eq!(&routed[1..], legacy);
    }
}
