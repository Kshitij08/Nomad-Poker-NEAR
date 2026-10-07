use anchor_lang::prelude::*;

use crate::constants::MAX_SEATS;
use crate::errors::PokerError;

pub const TABLE_SEED: &[u8] = b"table";
pub const TABLE_VERSION: u8 = 1;
pub const TABLE_RESERVED: usize = 120;

/// Created on L1, not yet live in the rollup.
pub const STATUS_CREATED: u8 = 0;
/// Live (or returned to L1 by the escape hatch with players still owed money).
pub const STATUS_OPEN: u8 = 1;
/// Closed empty by the creator.
pub const STATUS_CLOSED: u8 = 2;

/// The only token tables accept for now: wrapped SOL. The stake cap is denominated in it.
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// One seat. An empty seat has `player == Pubkey::default()`. Fixed size on purpose: no `Option`,
/// so every field sits at a fixed byte offset for indexers (lesson from M1).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Debug)]
pub struct Seat {
    pub player: Pubkey,
    /// Chips the player has at the table, in the table token's base units.
    pub stack: u64,
    /// Everything this player has put in at this seat (before rake), for the audit trail.
    pub deposited: u64,
}

impl Seat {
    pub fn is_empty(&self) -> bool {
        self.player == Pubkey::default()
    }
}

/// A cash-game table. Created on L1, then delegated to the TEE rollup where all money moves.
///
/// Money model: the table's escrow is the associated token account of this PDA for `mint`.
/// `escrow_owed` is what the table owes (sum of stacks + unpaid rake). Every money instruction
/// checks the real escrow balance still covers it.
#[account]
#[derive(InitSpace)]
pub struct Table {
    pub version: u8,
    pub bump: u8,
    pub status: u8,
    pub max_seats: u8,
    pub seated: u8,
    pub table_id: u64,
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub small_blind: u64,
    pub big_blind: u64,
    pub min_buy_in: u64,
    pub max_buy_in: u64,
    /// Copied from config at creation, so later rake changes don't affect open tables.
    pub rake_bps: u16,
    pub escrow_owed: u64,
    pub rake_accrued: u64,
    /// Escrow token balance seen right after the last money instruction.
    pub escrow_balance: u64,
    pub total_deposited: u64,
    pub total_paid_out: u64,
    pub total_rake_collected: u64,
    /// Rollup clock at the last money move; part of every commit, used by the escape-hatch rule.
    pub last_activity_ts: i64,
    pub seats: [Seat; MAX_SEATS as usize],
    pub reserved: [u8; TABLE_RESERVED],
}

impl Table {
    pub fn seat_of(&self, player: &Pubkey) -> Option<usize> {
        self.seats.iter().position(|s| !s.is_empty() && s.player == *player)
    }

    pub fn first_empty_seat(&self) -> Option<usize> {
        self.seats[..self.max_seats as usize].iter().position(|s| s.is_empty())
    }

    /// Sum of stacks + unpaid rake. Must always equal `escrow_owed`.
    pub fn computed_owed(&self) -> Option<u64> {
        self.seats.iter().try_fold(self.rake_accrued, |acc, s| acc.checked_add(s.stack))
    }
}

/// Rake on a buy-in, rounded up so small or split buy-ins can't avoid it.
pub fn rake_for(amount: u64, rake_bps: u16) -> Result<u64> {
    let r = (amount as u128)
        .checked_mul(rake_bps as u128)
        .ok_or(PokerError::MathOverflow)?
        .div_ceil(10_000u128);
    Ok(r as u64)
}

/// Who may hand a table to the TEE: the creator for a new table; anyone for a table that came
/// back to L1 still open (so a creator can't strand players by pulling the table out); nobody
/// for a closed table.
pub fn may_delegate(status: u8, signer_is_creator: bool) -> Result<()> {
    match status {
        STATUS_CREATED => require!(signer_is_creator, PokerError::NotCreator),
        STATUS_OPEN => {}
        _ => return err!(PokerError::TableNotOpen),
    }
    Ok(())
}

/// The emergency undelegation rule, applied to the table's L1 copy (its last commit). Only "idle
/// long enough" counts: the copy can't prove a table is empty, because nothing is committed
/// between delegation and the next commit. Delegation stamps `last_activity_ts`, and M5 must commit
/// live tables more often than `idle_secs`.
/// A timestamp from the future can only come from a misbehaving validator, so it counts as idle
/// rather than letting that validator block the escape hatch forever.
pub fn may_request_escape(last_activity_ts: i64, now: i64, idle_secs: i64) -> Result<()> {
    let from_future = last_activity_ts > now;
    require!(from_future || now.saturating_sub(last_activity_ts) >= idle_secs, PokerError::TableActive);
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct TableParams {
    pub small_blind: u64,
    pub big_blind: u64,
    pub min_buy_in: u64,
    pub max_buy_in: u64,
    pub max_seats: u8,
}

/// Table settings must be sane and inside the program-wide stake cap.
pub fn check_table_params(p: &TableParams, config_max_buy_in: u64) -> Result<()> {
    require!(p.small_blind > 0 && p.small_blind <= p.big_blind, PokerError::InvalidBlinds);
    let ten_bb = p.big_blind.checked_mul(10).ok_or(PokerError::MathOverflow)?;
    require!(p.min_buy_in >= ten_bb && p.min_buy_in <= p.max_buy_in, PokerError::InvalidBuyInRange);
    require!(p.max_buy_in <= config_max_buy_in, PokerError::AboveStakeCap);
    require!(p.max_seats >= crate::constants::MIN_SEATS && p.max_seats <= MAX_SEATS, PokerError::InvalidSeatCount);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> TableParams {
        TableParams { small_blind: 1, big_blind: 2, min_buy_in: 20, max_buy_in: 200, max_seats: 6 }
    }

    #[test]
    fn table_params() {
        assert!(check_table_params(&params(), 1_000).is_ok());
        assert!(check_table_params(&TableParams { small_blind: 0, ..params() }, 1_000).is_err());
        assert!(check_table_params(&TableParams { small_blind: 3, ..params() }, 1_000).is_err());
        assert!(check_table_params(&TableParams { min_buy_in: 19, ..params() }, 1_000).is_err());
        assert!(check_table_params(&TableParams { min_buy_in: 201, ..params() }, 1_000).is_err());
        assert!(check_table_params(&params(), 199).is_err());
        assert!(check_table_params(&TableParams { max_seats: 1, ..params() }, 1_000).is_err());
        assert!(check_table_params(&TableParams { max_seats: 10, ..params() }, 1_000).is_err());
    }

    #[test]
    fn rake_rounds_up_and_handles_large_amounts() {
        assert_eq!(rake_for(10_000, 500).unwrap(), 500);
        assert_eq!(rake_for(19, 500).unwrap(), 1);
        assert_eq!(rake_for(10_001, 500).unwrap(), 501);
        assert_eq!(rake_for(u64::MAX, 1_000).unwrap(), u64::MAX / 10 + 1);
        assert_eq!(rake_for(123, 0).unwrap(), 0);
    }

    #[test]
    fn delegation_and_escape_rules() {
        assert!(may_delegate(STATUS_CREATED, true).is_ok());
        assert!(may_delegate(STATUS_CREATED, false).is_err());
        assert!(may_delegate(STATUS_OPEN, false).is_ok());
        assert!(may_delegate(STATUS_CLOSED, true).is_err());
        assert!(may_request_escape(1_000, 1_000 + 3_599, 3_600).is_err());
        assert!(may_request_escape(1_000, 1_000 + 3_600, 3_600).is_ok());
        assert!(may_request_escape(1_000, 1_000 + 60, 60).is_ok());
        assert!(may_request_escape(1_000, 999, 60).is_ok(), "a stamp from the future can't block the hatch");
        assert!(may_request_escape(i64::MAX, 1_000, 60).is_ok());
        assert!(may_request_escape(i64::MIN, 1_000, 60).is_ok());
    }

    #[test]
    fn seats() {
        let mut t = Table {
            version: 1, bump: 0, status: STATUS_OPEN, max_seats: 2, seated: 0, table_id: 1,
            creator: Pubkey::default(), mint: Pubkey::default(), small_blind: 1, big_blind: 2,
            min_buy_in: 20, max_buy_in: 200, rake_bps: 0, escrow_owed: 0, rake_accrued: 5,
            escrow_balance: 0, total_deposited: 0, total_paid_out: 0, total_rake_collected: 0, last_activity_ts: 0,
            seats: [Seat::default(); MAX_SEATS as usize], reserved: [0; TABLE_RESERVED],
        };
        let a = Pubkey::new_unique();
        assert_eq!(t.first_empty_seat(), Some(0));
        t.seats[0] = Seat { player: a, stack: 10, deposited: 10 };
        assert_eq!(t.seat_of(&a), Some(0));
        assert_eq!(t.first_empty_seat(), Some(1));
        t.seats[1] = Seat { player: Pubkey::new_unique(), stack: 7, deposited: 7 };
        assert_eq!(t.first_empty_seat(), None, "max_seats=2 caps the search even with 9 slots");
        assert_eq!(t.computed_owed(), Some(22));
    }
}
