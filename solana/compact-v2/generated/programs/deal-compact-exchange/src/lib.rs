#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    entrypoint, entrypoint::ProgramResult, program_error::ProgramError,
};

declare_id!("3gsSk16h3xrxDHg5u8SZQek11WcTCLw9Zs6HUeaNBf5S");

pub const ROUTE_MAGIC: [u8; 4] = [68, 76, 86, 50];
pub const DEAL_DEX_PAIR_MODULE: u8 = 0;
pub const DEAL_DEX_ROUTER_MODULE: u8 = 1;
pub const DEAL_DEX_QUOTER_MODULE: u8 = 2;
pub const DEAL_SWAP_ASSET_REGISTRY_MODULE: u8 = 3;
pub const DEAL_SWAP_ORDERBOOK_MODULE: u8 = 4;

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
            0 => deal_dex_pair::entry(program_id, accounts, legacy_data),
            1 => deal_dex_router::entry(program_id, accounts, legacy_data),
            2 => deal_dex_quoter::entry(program_id, accounts, legacy_data),
            3 => deal_swap_asset_registry::entry(program_id, accounts, legacy_data),
            4 => deal_swap_orderbook::entry(program_id, accounts, legacy_data),
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
                &[&[100, 101, 120, 45, 99, 111, 110, 102, 105, 103][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_dex_pair::entry(program_id, accounts, data);
    }
    if discriminator == [107, 86, 198, 91, 33, 12, 107, 160]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    114, 111, 117, 116, 101, 114, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_dex_router::entry(program_id, accounts, data);
    }
    if discriminator == [107, 86, 198, 91, 33, 12, 107, 160]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    115, 119, 97, 112, 45, 97, 115, 115, 101, 116, 45, 114, 101, 103, 105, 115,
                    116, 114, 121,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_swap_asset_registry::entry(program_id, accounts, data);
    }
    if discriminator == [107, 86, 198, 91, 33, 12, 107, 160]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    111, 114, 100, 101, 114, 98, 111, 111, 107, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_swap_orderbook::entry(program_id, accounts, data);
    }
    if discriminator == [196, 72, 235, 189, 8, 45, 157, 170] && accounts.len() == 10 {
        return deal_dex_pair::entry(program_id, accounts, data);
    }
    if discriminator == [156, 190, 126, 151, 163, 62, 192, 220] && accounts.len() == 11 {
        return deal_dex_pair::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237] && accounts.len() == 6 {
        return deal_dex_pair::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237] && accounts.len() == 5 {
        return deal_dex_router::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237]
        && accounts.len() == 4
        && accounts.get(2).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    115, 119, 97, 112, 45, 97, 115, 115, 101, 116, 45, 114, 101, 103, 105, 115,
                    116, 114, 121,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_swap_asset_registry::entry(program_id, accounts, data);
    }
    if discriminator == [175, 175, 109, 31, 13, 152, 155, 237]
        && accounts.len() == 4
        && accounts.get(2).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    111, 114, 100, 101, 114, 98, 111, 111, 107, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_swap_orderbook::entry(program_id, accounts, data);
    }
    if discriminator == [27, 159, 247, 95, 173, 143, 67, 250] && accounts.len() == 11 {
        return deal_dex_pair::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[100, 101, 120, 45, 99, 111, 110, 102, 105, 103][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_dex_pair::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    114, 111, 117, 116, 101, 114, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_dex_router::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    115, 119, 97, 112, 45, 97, 115, 115, 101, 116, 45, 114, 101, 103, 105, 115,
                    116, 114, 121,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_swap_asset_registry::entry(program_id, accounts, data);
    }
    if discriminator == [20, 148, 236, 198, 76, 119, 99, 142]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    111, 114, 100, 101, 114, 98, 111, 111, 107, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_swap_orderbook::entry(program_id, accounts, data);
    }
    if discriminator == [18, 154, 24, 18, 237, 214, 19, 80] && accounts.len() == 3 {
        return deal_dex_pair::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[100, 101, 120, 45, 99, 111, 110, 102, 105, 103][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_dex_pair::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    114, 111, 117, 116, 101, 114, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_dex_router::entry(program_id, accounts, data);
    }
    if discriminator == [91, 60, 125, 192, 176, 225, 166, 218]
        && accounts.len() == 2
        && accounts.get(1).is_some_and(|account| {
            Pubkey::find_program_address(
                &[&[
                    111, 114, 100, 101, 114, 98, 111, 111, 107, 45, 99, 111, 110, 102, 105, 103,
                ][..]],
                program_id,
            )
            .0 == *account.key
        })
    {
        return deal_swap_orderbook::entry(program_id, accounts, data);
    }
    if discriminator == [66, 37, 157, 77, 250, 67, 141, 89] && accounts.len() == 3 {
        return deal_dex_pair::entry(program_id, accounts, data);
    }
    if discriminator == [201, 200, 230, 30, 98, 211, 49, 168] && accounts.len() == 11 {
        return deal_dex_pair::entry(program_id, accounts, data);
    }
    if discriminator == [27, 252, 242, 8, 116, 233, 137, 98] && accounts.len() == 11 {
        return deal_dex_pair::entry(program_id, accounts, data);
    }
    if discriminator == [27, 252, 242, 8, 116, 233, 137, 98] && accounts.len() == 13 {
        return deal_dex_router::entry(program_id, accounts, data);
    }
    if discriminator == [37, 149, 106, 208, 66, 163, 105, 198] && accounts.len() == 11 {
        return deal_dex_pair::entry(program_id, accounts, data);
    }
    if discriminator == [37, 149, 106, 208, 66, 163, 105, 198] && accounts.len() == 13 {
        return deal_dex_router::entry(program_id, accounts, data);
    }
    if discriminator == [134, 236, 177, 106, 56, 172, 56, 87] && accounts.len() == 11 {
        return deal_dex_pair::entry(program_id, accounts, data);
    }
    if discriminator == [133, 82, 116, 188, 151, 240, 100, 151] && accounts.len() == 8 {
        return deal_dex_pair::entry(program_id, accounts, data);
    }
    if discriminator == [189, 205, 51, 140, 198, 97, 17, 181] && accounts.len() == 13 {
        return deal_dex_router::entry(program_id, accounts, data);
    }
    if discriminator == [213, 105, 101, 114, 183, 190, 109, 23] && accounts.len() == 13 {
        return deal_dex_router::entry(program_id, accounts, data);
    }
    if discriminator == [121, 56, 183, 136, 29, 100, 114, 177] && accounts.len() == 19 {
        return deal_dex_router::entry(program_id, accounts, data);
    }
    if discriminator == [100, 12, 9, 65, 95, 224, 212, 38] && accounts.len() == 19 {
        return deal_dex_router::entry(program_id, accounts, data);
    }
    if discriminator == [3, 123, 177, 177, 102, 17, 219, 111] && accounts.len() == 1 {
        return deal_dex_quoter::entry(program_id, accounts, data);
    }
    if discriminator == [213, 104, 190, 12, 3, 103, 157, 178] && accounts.len() == 1 {
        return deal_dex_quoter::entry(program_id, accounts, data);
    }
    if discriminator == [110, 220, 173, 154, 101, 58, 82, 227] && accounts.len() == 1 {
        return deal_dex_quoter::entry(program_id, accounts, data);
    }
    if discriminator == [6, 112, 75, 141, 0, 105, 121, 198] && accounts.len() == 1 {
        return deal_dex_quoter::entry(program_id, accounts, data);
    }
    if discriminator == [203, 43, 181, 27, 227, 124, 112, 23] && accounts.len() == 2 {
        return deal_dex_quoter::entry(program_id, accounts, data);
    }
    if discriminator == [114, 148, 181, 115, 182, 52, 9, 92] && accounts.len() == 1 {
        return deal_dex_quoter::entry(program_id, accounts, data);
    }
    if discriminator == [14, 45, 27, 116, 164, 210, 205, 184] && accounts.len() == 2 {
        return deal_dex_quoter::entry(program_id, accounts, data);
    }
    if discriminator == [206, 80, 154, 183, 156, 82, 93, 2] && accounts.len() == 2 {
        return deal_swap_asset_registry::entry(program_id, accounts, data);
    }
    if discriminator == [202, 197, 42, 130, 28, 154, 203, 50] && accounts.len() == 10 {
        return deal_swap_orderbook::entry(program_id, accounts, data);
    }
    if discriminator == [185, 151, 81, 135, 137, 242, 177, 228] && accounts.len() == 10 {
        return deal_swap_orderbook::entry(program_id, accounts, data);
    }
    if discriminator == [47, 157, 222, 126, 97, 163, 99, 95] && accounts.len() == 16 {
        return deal_swap_orderbook::entry(program_id, accounts, data);
    }
    if discriminator == [224, 207, 227, 207, 40, 249, 170, 200] && accounts.len() == 16 {
        return deal_swap_orderbook::entry(program_id, accounts, data);
    }
    if discriminator == [195, 120, 204, 193, 88, 92, 75, 198] && accounts.len() == 15 {
        return deal_swap_orderbook::entry(program_id, accounts, data);
    }
    if discriminator == [80, 103, 237, 147, 212, 250, 181, 127] && accounts.len() == 15 {
        return deal_swap_orderbook::entry(program_id, accounts, data);
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
