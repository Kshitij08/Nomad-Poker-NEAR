use anchor_lang::prelude::*;
use anchor_lang::{AccountDeserialize, AccountSerialize};

use crate::constants::*;
use crate::error::PokerError;
use crate::state::{apply_chip_delta, ChipDelta, Seat, Table, Vault};

pub const MAX_DELTAS: usize = 9;

#[derive(Accounts)]
#[instruction(table_id: [u8; 32])]
pub struct BeginRound<'info> {
    pub settlement_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table_id.as_ref()],
        bump = table.bump,
        has_one = settlement_authority @ PokerError::Unauthorized
    )]
    pub table: Account<'info, Table>,
}

pub fn begin_round_handler(ctx: Context<BeginRound>, _table_id: [u8; 32]) -> Result<()> {
    let table = &mut ctx.accounts.table;
    require!(!table.round_active, PokerError::RoundInProgress);
    table.round_active = true;
    table.last_settlement_ts = Clock::get()?.unix_timestamp;
    Ok(())
}

/// Remaining accounts: one Seat account per delta, in the same order as `deltas`.
#[derive(Accounts)]
#[instruction(table_id: [u8; 32], nonce: u64)]
pub struct SettleRound<'info> {
    pub settlement_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table_id.as_ref()],
        bump = table.bump,
        has_one = settlement_authority @ PokerError::Unauthorized
    )]
    pub table: Account<'info, Table>,

    #[account(
        seeds = [VAULT_SEED, table_id.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
}

pub fn settle_round_handler(
    ctx: Context<SettleRound>,
    _table_id: [u8; 32],
    nonce: u64,
    deltas: Vec<ChipDelta>,
) -> Result<()> {
    require!(deltas.len() <= MAX_DELTAS, PokerError::TooManyDeltas);

    require!(
        nonce == ctx.accounts.table.round_nonce,
        PokerError::StaleSettlement
    );

    let sum: i64 = deltas.iter().map(|d| d.chip_delta).sum();
    require!(sum == 0, PokerError::SettlementNotZeroSum);

    require!(
        ctx.remaining_accounts.len() == deltas.len(),
        PokerError::SeatNotInSettlement
    );

    let now = Clock::get()?.unix_timestamp;
    let table_key = ctx.accounts.table.key();

    for (i, delta) in deltas.iter().enumerate() {
        let seat_info = &ctx.remaining_accounts[i];
        let mut data = seat_info.try_borrow_mut_data()?;
        let mut seat = Seat::try_deserialize(&mut &data[..])?;
        require!(seat.player == delta.player, PokerError::SeatNotInSettlement);
        require!(seat.table == table_key, PokerError::SeatNotInSettlement);

        seat.chips = apply_chip_delta(seat.chips, delta.chip_delta)?;
        seat.last_active_ts = now;
        seat.try_serialize(&mut &mut data[..])?;
    }

    let table = &mut ctx.accounts.table;
    table.round_nonce = table
        .round_nonce
        .checked_add(1)
        .ok_or(PokerError::MathOverflow)?;
    table.round_active = false;
    table.last_settlement_ts = now;

    crate::instructions::deposit::verify_vault_balance(&ctx.accounts.vault, table)?;

    Ok(())
}
