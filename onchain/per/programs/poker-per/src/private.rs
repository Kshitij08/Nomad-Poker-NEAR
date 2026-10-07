//! Rollup-only private accounts and their read permissions.
//!
//! Every private account (ledger, deck, hands) is created inside the TEE rollup with MagicBlock's
//! ephemeral-account API, so it never exists on L1, and gets a MagicBlock permission that says who
//! may read it. The table PDA sponsors the rent and signs; the private account signs for its own
//! permission (it is the permission's authority). Players are added as plain readers, never with
//! the permission program's AUTHORITY flag, so they can't change who else can read.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::{
    CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
};
use ephemeral_rollups_sdk::access_control::structs::{
    EphemeralMembersArgs, Member, TX_BALANCES_FLAG,
};
use ephemeral_rollups_sdk::ephemeral_accounts::EphemeralAccount;

/// Read access to the account's data, plus balance changes of transactions touching it. No
/// transaction messages or logs (M4 review): the VRF oracle's fulfillment transaction touches the
/// ledger and hands, and its message carries the VRF output.
pub const READER_FLAGS: u8 = TX_BALANCES_FLAG;

pub fn readers(keys: &[Pubkey]) -> Vec<Member> {
    keys.iter().map(|k| Member { flags: READER_FLAGS, pubkey: *k }).collect()
}

/// Accounts and signer seeds shared by every private-account operation on one table.
pub struct Sponsor<'a, 'info> {
    pub table: &'a AccountInfo<'info>,
    pub table_seeds: &'a [&'a [u8]],
    pub vault: &'a AccountInfo<'info>,
    pub magic_program: &'a AccountInfo<'info>,
    pub permission_program: &'a AccountInfo<'info>,
}

impl<'a, 'info> Sponsor<'a, 'info> {
    /// Creates a rollup-only account of `len` bytes, paid for by the table.
    pub fn create_account(&self, account: &AccountInfo<'info>, account_seeds: &[&[u8]], len: usize) -> Result<()> {
        let seeds: [&[&[u8]]; 2] = [self.table_seeds, account_seeds];
        EphemeralAccount::new(self.table, account, self.vault).with_signer_seeds(&seeds).create(len as u32)?;
        Ok(())
    }

    /// Closes a rollup-only account; its rent goes back to the table.
    pub fn close_account(&self, account: &AccountInfo<'info>) -> Result<()> {
        let seeds: [&[&[u8]]; 1] = [self.table_seeds];
        EphemeralAccount::new(self.table, account, self.vault).with_signer_seeds(&seeds).close()?;
        Ok(())
    }

    /// Creates a private permission (only `members` may read). Idempotent.
    pub fn create_permission(&self, account: &AccountInfo<'info>, account_seeds: &[&[u8]], permission: &AccountInfo<'info>, members: &[Pubkey]) -> Result<()> {
        // Rollup-only accounts (permissions included) hold no lamports, so test for data instead.
        if !permission.data_is_empty() {
            return Ok(());
        }
        CreateEphemeralPermissionCpi {
            permissioned_account: account.clone(),
            permission: permission.clone(),
            payer: self.table.clone(),
            vault: self.vault.clone(),
            magic_program: self.magic_program.clone(),
            permission_program: self.permission_program.clone(),
            args: EphemeralMembersArgs { is_private: true, members: readers(members) },
        }
        .invoke_signed(&[self.table_seeds, account_seeds])?;
        Ok(())
    }

    /// Replaces the reader list, keeping the account private. An empty list means nobody.
    pub fn set_readers(&self, account: &AccountInfo<'info>, account_seeds: &[&[u8]], permission: &AccountInfo<'info>, members: &[Pubkey]) -> Result<()> {
        UpdateEphemeralPermissionCpi {
            permissioned_account: account.clone(),
            permission: permission.clone(),
            payer: self.table.clone(),
            vault: self.vault.clone(),
            magic_program: self.magic_program.clone(),
            permission_program: self.permission_program.clone(),
            authority: account.clone(),
            authority_is_signer: false,
            args: EphemeralMembersArgs { is_private: true, members: readers(members) },
        }
        .invoke_signed(&[self.table_seeds, account_seeds])?;
        Ok(())
    }

    /// Deletes a permission; its rent goes back to the table.
    pub fn close_permission(&self, account: &AccountInfo<'info>, account_seeds: &[&[u8]], permission: &AccountInfo<'info>) -> Result<()> {
        CloseEphemeralPermissionCpi {
            payer: self.table.clone(),
            authority: account.clone(),
            permissioned_account: account.clone(),
            permission: permission.clone(),
            vault: self.vault.clone(),
            magic_program: self.magic_program.clone(),
            permission_program: self.permission_program.clone(),
            authority_is_signer: false,
        }
        .invoke_signed(&[self.table_seeds, account_seeds])?;
        Ok(())
    }
}

/// Writes an Anchor account (discriminator + data) into a freshly created raw account.
pub fn write<T: AccountSerialize>(account: &AccountInfo, value: &T) -> Result<()> {
    let mut data = account.try_borrow_mut_data()?;
    let mut cursor: &mut [u8] = &mut data[..];
    value.try_serialize(&mut cursor)?;
    Ok(())
}
