use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::PokerError;
use crate::state::{
    assert_cash_out_allowed, assert_between_rounds, lamports_from_chips, Seat, SeatStatus, Table,
    Vault,
};

#[derive(Accounts)]
#[instruction(table_id: [u8; 32])]
pub struct RequestLeave<'info> {
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [SEAT_SEED, table_id.as_ref(), player.key().as_ref()],
        bump = seat.bump,
        has_one = player @ PokerError::Unauthorized
    )]
    pub seat: Account<'info, Seat>,
}

pub fn request_leave_handler(ctx: Context<RequestLeave>, _table_id: [u8; 32]) -> Result<()> {
    ctx.accounts.seat.status = SeatStatus::Leaving;
    Ok(())
}

#[derive(Accounts)]
#[instruction(table_id: [u8; 32])]
pub struct CashOut<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table_id.as_ref()],
        bump = table.bump
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [VAULT_SEED, table_id.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [SEAT_SEED, table_id.as_ref(), seat.player.as_ref()],
        bump,
        close = payer
    )]
    pub seat: Account<'info, Seat>,

    /// CHECK: seat owner always receives payout
    #[account(mut, address = seat.player)]
    pub player_wallet: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn cash_out_handler(ctx: Context<CashOut>, table_id: [u8; 32]) -> Result<()> {
    execute_cash_out(
        &ctx.accounts.payer,
        &mut ctx.accounts.table,
        &ctx.accounts.vault,
        &mut ctx.accounts.seat,
        &ctx.accounts.player_wallet,
        &ctx.accounts.system_program,
        table_id,
        false,
    )
}

#[derive(Accounts)]
#[instruction(table_id: [u8; 32])]
pub struct SweepAbandonedSeat<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table_id.as_ref()],
        bump = table.bump
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [VAULT_SEED, table_id.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [SEAT_SEED, table_id.as_ref(), seat.player.as_ref()],
        bump,
        close = payer
    )]
    pub seat: Account<'info, Seat>,

    /// CHECK: seat owner always receives payout
    #[account(mut, address = seat.player)]
    pub player_wallet: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn sweep_abandoned_seat_handler(
    ctx: Context<SweepAbandonedSeat>,
    table_id: [u8; 32],
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now.saturating_sub(ctx.accounts.seat.last_active_ts) >= ABANDONED_SEAT_SECS,
        PokerError::SeatNotAbandoned
    );

    execute_cash_out(
        &ctx.accounts.payer,
        &mut ctx.accounts.table,
        &ctx.accounts.vault,
        &mut ctx.accounts.seat,
        &ctx.accounts.player_wallet,
        &ctx.accounts.system_program,
        table_id,
        true,
    )
}

#[allow(clippy::too_many_arguments)]
fn execute_cash_out<'info>(
    payer: &Signer<'info>,
    table: &mut Account<'info, Table>,
    vault: &Account<'info, Vault>,
    seat: &mut Account<'info, Seat>,
    player_wallet: &UncheckedAccount<'info>,
    _system_program: &Program<'info, System>,
    _table_id: [u8; 32],
    skip_round_gate: bool,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    let is_player = payer.key() == seat.player;
    let is_settlement = payer.key() == table.settlement_authority;
    require!(is_player || is_settlement, PokerError::Unauthorized);

    if !skip_round_gate {
        assert_cash_out_allowed(table, now)?;
    }

    require!(seat.table == table.key(), PokerError::Unauthorized);

    let active_chips = seat.chips;
    let pending = seat.pending_chips;
    let total_chips = active_chips
        .checked_add(pending)
        .ok_or(PokerError::ChipOverflow)?;
    let payout = lamports_from_chips(total_chips)?;

    seat.chips = 0;
    seat.pending_chips = 0;
    table.chips_in_play = table
        .chips_in_play
        .checked_sub(active_chips)
        .ok_or(PokerError::ChipUnderflow)?;
    table.pending_chips_in_play = table
        .pending_chips_in_play
        .checked_sub(pending)
        .ok_or(PokerError::ChipUnderflow)?;
    table.seated_count = table.seated_count.saturating_sub(1);

    let vault_lamports = vault.to_account_info().lamports();
    let reserve = vault.rent_reserve_lamports;
    require!(
        vault_lamports >= payout.checked_add(reserve).ok_or(PokerError::MathOverflow)?,
        PokerError::VaultInvariant
    );

    // Vault is a program-owned PDA with account data; System Program transfer rejects
    // `from` accounts that carry data. Move lamports directly instead.
    let vault_info = vault.to_account_info();
    let player_info = player_wallet.to_account_info();
    **vault_info.try_borrow_mut_lamports()? = vault_info
        .lamports()
        .checked_sub(payout)
        .ok_or(PokerError::VaultInvariant)?;
    **player_info.try_borrow_mut_lamports()? = player_info
        .lamports()
        .checked_add(payout)
        .ok_or(PokerError::MathOverflow)?;

    Ok(())
}

#[derive(Accounts)]
#[instruction(table_id: [u8; 32])]
pub struct CloseTable<'info> {
    #[account(mut)]
    pub settlement_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table_id.as_ref()],
        bump = table.bump,
        has_one = settlement_authority @ PokerError::Unauthorized,
        close = settlement_authority
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [VAULT_SEED, table_id.as_ref()],
        bump = vault.bump,
        close = settlement_authority
    )]
    pub vault: Account<'info, Vault>,
}

pub fn close_table_handler(ctx: Context<CloseTable>, _table_id: [u8; 32]) -> Result<()> {
    let table = &ctx.accounts.table;
    require!(table.seated_count == 0, PokerError::TableNotEmpty);
    require!(table.pending_chips_in_play == 0, PokerError::VaultInvariant);
    assert_between_rounds(table)?;

    let vault = &ctx.accounts.vault;
    let vault_lamports = vault.to_account_info().lamports();
    require!(
        vault_lamports == vault.rent_reserve_lamports,
        PokerError::VaultInvariant
    );

    Ok(())
}
