use anchor_lang::prelude::*;

use crate::constants::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub dev_wallet: Pubkey,
    pub rake_bps: u16,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Table {
    pub host: Pubkey,
    pub settlement_authority: Pubkey,
    pub table_id: [u8; 32],
    pub buy_in_lamports: u64,
    pub rake_bps: u16,
    pub small_blind_chips: u64,
    pub big_blind_chips: u64,
    pub max_seats: u8,
    pub seated_count: u8,
    pub chips_in_play: u64,
    pub round_nonce: u64,
    pub round_active: bool,
    pub last_settlement_ts: i64,
    /// Sum of all seat `pending_chips` — escrowed during an active round, applied at settle.
    pub pending_chips_in_play: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// Lamports reserved for this PDA's rent-exempt minimum; never paid to players.
    pub rent_reserve_lamports: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum SeatStatus {
    Active,
    Leaving,
}

#[account]
#[derive(InitSpace)]
pub struct Seat {
    pub table: Pubkey,
    pub player: Pubkey,
    pub chips: u64,
    pub deposited_lamports: u64,
    pub rake_paid_lamports: u64,
    pub status: SeatStatus,
    pub last_active_ts: i64,
    /// Buy-in/rebuy lamports received mid-round; moved to `chips` at settle_round.
    pub pending_chips: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct ChipDelta {
    pub player: Pubkey,
    pub chip_delta: i64,
}

pub fn compute_rake(buy_in_lamports: u64, rake_bps: u16) -> Result<u64> {
    let rake = (buy_in_lamports as u128)
        .checked_mul(rake_bps as u128)
        .ok_or(error!(crate::error::PokerError::MathOverflow))?
        .checked_div(10_000)
        .ok_or(error!(crate::error::PokerError::MathOverflow))?;
    u64::try_from(rake).map_err(|_| error!(crate::error::PokerError::MathOverflow))
}

pub fn chips_from_lamports(lamports: u64) -> Result<u64> {
    require!(
        lamports % LAMPORTS_PER_CHIP == 0,
        crate::error::PokerError::BuyInNotDivisible
    );
    Ok(lamports / LAMPORTS_PER_CHIP)
}

pub fn lamports_from_chips(chips: u64) -> Result<u64> {
    chips
        .checked_mul(LAMPORTS_PER_CHIP)
        .ok_or(error!(crate::error::PokerError::MathOverflow))
}

pub fn apply_chip_delta(chips: u64, delta: i64) -> Result<u64> {
    if delta >= 0 {
        chips
            .checked_add(delta as u64)
            .ok_or(error!(crate::error::PokerError::ChipOverflow))
    } else {
        let abs = (-delta) as u64;
        chips
            .checked_sub(abs)
            .ok_or(error!(crate::error::PokerError::ChipUnderflow))
    }
}

pub fn assert_cash_out_allowed(table: &Table, now: i64) -> Result<()> {
    if !table.round_active {
        return Ok(());
    }
    require!(
        now.saturating_sub(table.last_settlement_ts) > STALE_ROUND_SECS,
        crate::error::PokerError::RoundInProgress
    );
    Ok(())
}

pub fn assert_between_rounds(table: &Table) -> Result<()> {
    require!(!table.round_active, crate::error::PokerError::RoundInProgress);
    Ok(())
}

/// Move a seat's pending deposit into active chips (called at settle_round).
pub fn apply_pending_chips(seat: &mut Seat, table: &mut Table) -> Result<()> {
    let pending = seat.pending_chips;
    if pending == 0 {
        return Ok(());
    }

    seat.chips = seat
        .chips
        .checked_add(pending)
        .ok_or(error!(crate::error::PokerError::ChipOverflow))?;
    seat.pending_chips = 0;

    table.chips_in_play = table
        .chips_in_play
        .checked_add(pending)
        .ok_or(error!(crate::error::PokerError::ChipOverflow))?;
    table.pending_chips_in_play = table
        .pending_chips_in_play
        .checked_sub(pending)
        .ok_or(error!(crate::error::PokerError::ChipUnderflow))?;

    Ok(())
}
