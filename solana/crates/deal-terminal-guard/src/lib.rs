#![forbid(unsafe_code)]

use anchor_lang::{
    prelude::{AccountInfo, ProgramError, Pubkey},
    solana_program::{instruction::Instruction, sysvar::SysvarId},
};
use solana_instructions_sysvar::{
    load_current_index_checked, load_instruction_at_checked, Instructions,
};

pub const ANCHOR_DISCRIMINATOR_LEN: usize = 8;

pub fn instructions_sysvar_id() -> Pubkey {
    Instructions::id()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExpectedAccount {
    pub index: usize,
    pub key: Pubkey,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExpectedInstruction {
    pub program_id: Pubkey,
    pub discriminator: [u8; ANCHOR_DISCRIMINATOR_LEN],
    pub accounts: Vec<ExpectedAccount>,
    pub byte_argument: Option<(usize, u8)>,
}

impl ExpectedInstruction {
    pub fn anchor(program_id: Pubkey, discriminator: [u8; ANCHOR_DISCRIMINATOR_LEN]) -> Self {
        Self {
            program_id,
            discriminator,
            accounts: Vec::new(),
            byte_argument: None,
        }
    }

    pub fn account(mut self, index: usize, key: Pubkey) -> Self {
        self.accounts.push(ExpectedAccount { index, key });
        self
    }

    pub fn byte_argument(mut self, offset: usize, value: u8) -> Self {
        self.byte_argument = Some((offset, value));
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum GuardError {
    InvalidInstructionsSysvar = 7_000,
    MissingInstruction = 7_001,
    WrongCurrentProgram = 7_002,
    WrongCurrentDiscriminator = 7_003,
    WrongProgram = 7_004,
    WrongDiscriminator = 7_005,
    MissingAccount = 7_006,
    WrongAccount = 7_007,
    MissingByteArgument = 7_008,
    WrongByteArgument = 7_009,
}

impl From<GuardError> for ProgramError {
    fn from(value: GuardError) -> Self {
        ProgramError::Custom(value as u32)
    }
}

pub fn validate_current_and_following(
    instructions_sysvar: &AccountInfo<'_>,
    current_program_id: Pubkey,
    current_discriminator: [u8; ANCHOR_DISCRIMINATOR_LEN],
    following: &[ExpectedInstruction],
) -> Result<(), ProgramError> {
    let current_index = load_current_index_checked(instructions_sysvar)
        .map_err(|_| ProgramError::from(GuardError::InvalidInstructionsSysvar))?
        as usize;
    let current = load_instruction_at_checked(current_index, instructions_sysvar)
        .map_err(|_| ProgramError::from(GuardError::MissingInstruction))?;
    validate_current(&current, current_program_id, current_discriminator)?;

    for (offset, expected) in following.iter().enumerate() {
        let instruction =
            load_instruction_at_checked(current_index + offset + 1, instructions_sysvar)
                .map_err(|_| ProgramError::from(GuardError::MissingInstruction))?;
        validate_instruction(&instruction, expected)?;
    }
    Ok(())
}

pub fn validate_current(
    instruction: &Instruction,
    expected_program_id: Pubkey,
    expected_discriminator: [u8; ANCHOR_DISCRIMINATOR_LEN],
) -> Result<(), ProgramError> {
    if instruction.program_id.to_bytes() != expected_program_id.to_bytes() {
        return Err(GuardError::WrongCurrentProgram.into());
    }
    let discriminator = instruction
        .data
        .get(..ANCHOR_DISCRIMINATOR_LEN)
        .ok_or(GuardError::WrongCurrentDiscriminator)?;
    if discriminator != expected_discriminator {
        return Err(GuardError::WrongCurrentDiscriminator.into());
    }
    Ok(())
}

pub fn validate_instruction(
    instruction: &Instruction,
    expected: &ExpectedInstruction,
) -> Result<(), ProgramError> {
    if instruction.program_id.to_bytes() != expected.program_id.to_bytes() {
        return Err(GuardError::WrongProgram.into());
    }
    let discriminator = instruction
        .data
        .get(..ANCHOR_DISCRIMINATOR_LEN)
        .ok_or(GuardError::WrongDiscriminator)?;
    if discriminator != expected.discriminator {
        return Err(GuardError::WrongDiscriminator.into());
    }
    for expected_account in &expected.accounts {
        let account = instruction
            .accounts
            .get(expected_account.index)
            .ok_or(GuardError::MissingAccount)?;
        if account.pubkey.to_bytes() != expected_account.key.to_bytes() {
            return Err(GuardError::WrongAccount.into());
        }
    }
    if let Some((offset, expected_value)) = expected.byte_argument {
        let actual = instruction
            .data
            .get(offset)
            .ok_or(GuardError::MissingByteArgument)?;
        if *actual != expected_value {
            return Err(GuardError::WrongByteArgument.into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::{
        prelude::Instructions,
        solana_program::{
            instruction::{AccountMeta, BorrowedAccountMeta, BorrowedInstruction},
            sysvar::SysvarId,
        },
    };
    use solana_instructions_sysvar::{construct_instructions_data, store_current_index_checked};

    const CURRENT_DISC: [u8; 8] = *b"CURRENT!";
    const NEXT_DISC: [u8; 8] = *b"NEXTSTEP";

    fn instruction(
        program_id: Pubkey,
        discriminator: [u8; 8],
        accounts: &[Pubkey],
        byte_argument: Option<u8>,
    ) -> Instruction {
        let mut data = discriminator.to_vec();
        if let Some(value) = byte_argument {
            data.push(value);
        }
        Instruction {
            program_id,
            accounts: accounts
                .iter()
                .copied()
                .map(|key| AccountMeta::new_readonly(key, false))
                .collect(),
            data,
        }
    }

    fn borrowed_instruction(instruction: &Instruction) -> BorrowedInstruction<'_> {
        BorrowedInstruction {
            program_id: &instruction.program_id,
            accounts: instruction
                .accounts
                .iter()
                .map(|account| BorrowedAccountMeta {
                    pubkey: &account.pubkey,
                    is_signer: account.is_signer,
                    is_writable: account.is_writable,
                })
                .collect(),
            data: &instruction.data,
        }
    }

    fn with_instructions_sysvar<T>(
        instructions: &[Instruction],
        current_index: u16,
        callback: impl FnOnce(&AccountInfo<'_>) -> T,
    ) -> T {
        let borrowed: Vec<_> = instructions.iter().map(borrowed_instruction).collect();
        let mut data = construct_instructions_data(&borrowed);
        store_current_index_checked(&mut data, current_index).unwrap();
        let key = Instructions::id();
        let owner = anchor_lang::solana_program::system_program::ID;
        let mut lamports = 0;
        let account = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false);
        callback(&account)
    }

    #[test]
    fn validates_program_discriminator_accounts_and_role() {
        let program = Pubkey::new_unique();
        let deal = Pubkey::new_unique();
        let receipt = Pubkey::new_unique();
        let ix = instruction(program, NEXT_DISC, &[deal, receipt], Some(2));
        let expected = ExpectedInstruction::anchor(program, NEXT_DISC)
            .account(0, deal)
            .account(1, receipt)
            .byte_argument(8, 2);

        assert_eq!(validate_instruction(&ix, &expected), Ok(()));
    }

    #[test]
    fn rejects_a_wrapper_as_the_current_top_level_program() {
        let official_program = Pubkey::new_unique();
        let wrapper = Pubkey::new_unique();
        let ix = instruction(wrapper, CURRENT_DISC, &[], None);

        assert_eq!(
            validate_current(&ix, official_program, CURRENT_DISC),
            Err(GuardError::WrongCurrentProgram.into())
        );
    }

    #[test]
    fn rejects_a_wrong_current_discriminator() {
        let program = Pubkey::new_unique();
        let ix = instruction(program, NEXT_DISC, &[], None);

        assert_eq!(
            validate_current(&ix, program, CURRENT_DISC),
            Err(GuardError::WrongCurrentDiscriminator.into())
        );
    }

    #[test]
    fn rejects_a_wrong_following_program() {
        let expected_program = Pubkey::new_unique();
        let ix = instruction(Pubkey::new_unique(), NEXT_DISC, &[], None);
        let expected = ExpectedInstruction::anchor(expected_program, NEXT_DISC);

        assert_eq!(
            validate_instruction(&ix, &expected),
            Err(GuardError::WrongProgram.into())
        );
    }

    #[test]
    fn rejects_a_wrong_following_discriminator() {
        let program = Pubkey::new_unique();
        let ix = instruction(program, CURRENT_DISC, &[], None);
        let expected = ExpectedInstruction::anchor(program, NEXT_DISC);

        assert_eq!(
            validate_instruction(&ix, &expected),
            Err(GuardError::WrongDiscriminator.into())
        );
    }

    #[test]
    fn rejects_a_missing_link_account() {
        let program = Pubkey::new_unique();
        let deal = Pubkey::new_unique();
        let ix = instruction(program, NEXT_DISC, &[], None);
        let expected = ExpectedInstruction::anchor(program, NEXT_DISC).account(0, deal);

        assert_eq!(
            validate_instruction(&ix, &expected),
            Err(GuardError::MissingAccount.into())
        );
    }

    #[test]
    fn rejects_a_different_deal_or_receipt() {
        let program = Pubkey::new_unique();
        let expected_deal = Pubkey::new_unique();
        let ix = instruction(program, NEXT_DISC, &[Pubkey::new_unique()], None);
        let expected = ExpectedInstruction::anchor(program, NEXT_DISC).account(0, expected_deal);

        assert_eq!(
            validate_instruction(&ix, &expected),
            Err(GuardError::WrongAccount.into())
        );
    }

    #[test]
    fn rejects_a_missing_or_wrong_role_byte() {
        let program = Pubkey::new_unique();
        let missing = instruction(program, NEXT_DISC, &[], None);
        let wrong = instruction(program, NEXT_DISC, &[], Some(1));
        let expected = ExpectedInstruction::anchor(program, NEXT_DISC).byte_argument(8, 2);

        assert_eq!(
            validate_instruction(&missing, &expected),
            Err(GuardError::MissingByteArgument.into())
        );
        assert_eq!(
            validate_instruction(&wrong, &expected),
            Err(GuardError::WrongByteArgument.into())
        );
    }

    #[test]
    fn validates_the_current_top_level_instruction_and_exact_following_sequence() {
        let current_program = Pubkey::new_unique();
        let next_program = Pubkey::new_unique();
        let deal = Pubkey::new_unique();
        let current = instruction(current_program, CURRENT_DISC, &[deal], None);
        let next = instruction(next_program, NEXT_DISC, &[deal], Some(1));
        let following = [ExpectedInstruction::anchor(next_program, NEXT_DISC)
            .account(0, deal)
            .byte_argument(8, 1)];

        let result = with_instructions_sysvar(&[current, next], 0, |sysvar| {
            validate_current_and_following(sysvar, current_program, CURRENT_DISC, &following)
        });
        assert_eq!(result, Ok(()));
    }

    #[test]
    fn rejects_an_inserted_or_missing_following_instruction() {
        let current_program = Pubkey::new_unique();
        let next_program = Pubkey::new_unique();
        let current = instruction(current_program, CURRENT_DISC, &[], None);
        let unrelated = instruction(Pubkey::new_unique(), NEXT_DISC, &[], None);
        let following = [ExpectedInstruction::anchor(next_program, NEXT_DISC)];

        let inserted = with_instructions_sysvar(&[current.clone(), unrelated], 0, |sysvar| {
            validate_current_and_following(sysvar, current_program, CURRENT_DISC, &following)
        });
        assert_eq!(inserted, Err(GuardError::WrongProgram.into()));

        let missing = with_instructions_sysvar(&[current], 0, |sysvar| {
            validate_current_and_following(sysvar, current_program, CURRENT_DISC, &following)
        });
        assert_eq!(missing, Err(GuardError::MissingInstruction.into()));
    }
}
