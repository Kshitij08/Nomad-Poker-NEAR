//! Rollup: a MagicBlock crank (Hydra, ephemeral-rollup variant) that keeps a table's hands moving
//! when every player's client is offline: it calls `tick` on a schedule, which times out an awaited
//! player whose turn is up and begins a dealt hand. `tick` needs no signer and does nothing (but
//! succeeds) when there's nothing to do; Hydra only advances a schedule on a successful call.
//!
//! The table sponsors the crank's rent (as it does for its private accounts) and is its cancel
//! authority. Hydra on the rollup charges no fee; crankers may be paid a tip per trigger.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::Discriminator;
use ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};

use crate::errors::PokerError;
use crate::instructions::money::table_seeds;
use crate::table::{Table, DECK_SEED, LEDGER_SEED, LOG_SEED, RECORD_SEED, STATUS_OPEN, TABLE_SEED};

/// Hydra's ephemeral-rollup program.
pub const HYDRA_EPHEMERAL_ID: Pubkey = pubkey!("eHyd5BU8QffvHi4GnXwxrK4WpS7pM2x9UGKHBWii7mf");
const HYDRA_CREATE: u8 = 0;
const HYDRA_CANCEL: u8 = 2;
pub(crate) const CRANK_SEED: &[u8] = b"crank";
const WRITABLE: u8 = 0b10;
/// Compute limit the cranker sets for each tick (covers a showdown).
pub const KEEPER_CU_LIMIT: u32 = 400_000;
/// Most lamports `schedule_keeper` may move from the table to the crank for tips.
pub const MAX_KEEPER_FUND: u64 = 1_000_000;
/// Lamports the table keeps above its rent after funding the keeper (sponsoring seats).
pub const KEEPER_RESERVE: u64 = 1_000_000;

#[derive(Accounts)]
pub struct ScheduleKeeper<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, has_one = creator @ PokerError::NotCreator, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    /// CHECK: the table's crank: Hydra's payer-bound PDA [b"crank", payer, seed], with the table as
    /// both payer and seed, so nobody else can create a crank at this address first.
    #[account(mut, seeds = [CRANK_SEED, table.key().as_ref(), table.key().as_ref()], bump, seeds::program = HYDRA_EPHEMERAL_ID)]
    pub crank: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = HYDRA_EPHEMERAL_ID)]
    pub hydra_program: UncheckedAccount<'info>,
    /// CHECK: MagicBlock's rent vault for rollup-only accounts.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: MagicBlock's Magic program (rollup only).
    #[account(address = MAGIC_PROGRAM_ID, constraint = magic_program.executable @ PokerError::NotInRollup)]
    pub magic_program: UncheckedAccount<'info>,
}

/// The creator schedules the table's keeper: `tick` every `interval_slots` rollup slots (about
/// 50 ms each), with `tip` lamports per trigger for the cranker (0 = none), and moves `fund`
/// lamports from the table's balance to the crank to pay those tips.
pub fn schedule_keeper(ctx: Context<ScheduleKeeper>, interval_slots: u64, tip: u64, fund: u64) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.table.status == STATUS_OPEN, PokerError::TableNotOpen);
    let table_key = a.table.key();
    let pda = |seeds: &[&[u8]], program: &Pubkey| Pubkey::find_program_address(seeds, program).0;
    let ledger = pda(&[LEDGER_SEED, table_key.as_ref()], &crate::ID);
    let log = pda(&[LOG_SEED, table_key.as_ref()], &crate::ID);
    // `tick`'s accounts, in its order (BeginHand: hand accounts, log permission, rollup programs).
    let metas: [(Pubkey, bool); 9] = [
        (table_key, true),
        (ledger, true),
        (pda(&[DECK_SEED, table_key.as_ref()], &crate::ID), true),
        (pda(&[RECORD_SEED, table_key.as_ref()], &crate::ID), true),
        (log, true),
        (pda(&[PERMISSION_SEED, log.as_ref()], &PERMISSION_PROGRAM_ID), true),
        (MAGIC_PROGRAM_ID, false),
        (EPHEMERAL_VAULT_ID, true),
        (PERMISSION_PROGRAM_ID, false),
    ];
    let tick_data = crate::instruction::Tick::DISCRIMINATOR;

    // Hydra Create: seed, authority, start_slot, interval_slots, remaining (0 = forever),
    // priority_tip, cu_limit, then the scheduled ix: num_accounts, data_len, program, metas, data.
    let mut data = Vec::with_capacity(1 + 100 + 35 + 33 * metas.len() + tick_data.len());
    data.push(HYDRA_CREATE);
    data.extend_from_slice(table_key.as_ref()); // seed
    data.extend_from_slice(table_key.as_ref()); // authority: the table, so it can cancel
    data.extend_from_slice(&0u64.to_le_bytes()); // start now
    data.extend_from_slice(&interval_slots.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes()); // run until cancelled
    data.extend_from_slice(&tip.to_le_bytes());
    data.extend_from_slice(&KEEPER_CU_LIMIT.to_le_bytes());
    data.push(metas.len() as u8);
    data.extend_from_slice(&(tick_data.len() as u16).to_le_bytes());
    data.extend_from_slice(crate::ID.as_ref());
    for (key, writable) in metas.iter() {
        data.push(if *writable { WRITABLE } else { 0 });
        data.extend_from_slice(key.as_ref());
    }
    data.extend_from_slice(tick_data);

    let (id, bump) = (a.table.table_id.to_le_bytes(), [a.table.bump]);
    let ts = table_seeds(&a.table, &id, &bump);
    invoke_signed(
        &Instruction {
            program_id: HYDRA_EPHEMERAL_ID,
            accounts: vec![
                AccountMeta::new(table_key, true),
                AccountMeta::new(a.crank.key(), false),
                AccountMeta::new(EPHEMERAL_VAULT_ID, false),
                AccountMeta::new_readonly(MAGIC_PROGRAM_ID, false),
            ],
            data,
        },
        &[a.table.to_account_info(), a.crank.to_account_info(), a.vault.to_account_info(), a.magic_program.to_account_info(), a.hydra_program.to_account_info()],
        &[&ts],
    )?;
    if fund > 0 {
        // The table's lamports also sponsor new seats' private accounts: keep a reserve for them.
        let table_info = ctx.accounts.table.to_account_info();
        let keep = Rent::get()?.minimum_balance(table_info.data_len()).saturating_add(KEEPER_RESERVE);
        require!(fund <= MAX_KEEPER_FUND && table_info.lamports().saturating_sub(fund) >= keep, PokerError::InsufficientTableBalance);
        **table_info.try_borrow_mut_lamports()? -= fund;
        **ctx.accounts.crank.to_account_info().try_borrow_mut_lamports()? += fund;
    }
    Ok(())
}

/// The creator cancels the table's keeper (its rent goes back to the table).
pub fn cancel_keeper(ctx: Context<ScheduleKeeper>) -> Result<()> {
    let a = &ctx.accounts;
    cancel_crank(&a.table, &a.crank, &a.vault, &a.magic_program, &a.hydra_program)
}

/// Hydra Cancel, signed by the table as the crank's authority; the crank's balance and rent go back
/// to the table.
pub(crate) fn cancel_crank<'info>(table: &Account<'info, Table>, crank: &AccountInfo<'info>, vault: &AccountInfo<'info>, magic_program: &AccountInfo<'info>, hydra: &AccountInfo<'info>) -> Result<()> {
    let (id, bump) = (table.table_id.to_le_bytes(), [table.bump]);
    let ts = table_seeds(table, &id, &bump);
    invoke_signed(
        &Instruction {
            program_id: HYDRA_EPHEMERAL_ID,
            accounts: vec![
                AccountMeta::new(table.key(), true),
                AccountMeta::new(crank.key(), false),
                AccountMeta::new(table.key(), false),
                AccountMeta::new(EPHEMERAL_VAULT_ID, false),
                AccountMeta::new_readonly(MAGIC_PROGRAM_ID, false),
            ],
            data: vec![HYDRA_CANCEL],
        },
        &[table.to_account_info(), crank.clone(), vault.clone(), magic_program.clone(), hydra.clone()],
        &[&ts],
    )?;
    Ok(())
}
