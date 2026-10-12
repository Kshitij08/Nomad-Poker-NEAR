//! M11: on-chain tournaments. Player-hosted, scheduled freezeouts for 2 to 30 players (the GDD's Coins
//! format on 8-seat tables). The tournament account holds the money (an escrow, like a table's); its
//! tables are ordinary tables whose creator is the tournament and which hold chips, never money.
//! This file: the account, its constants, and the pure rules (blinds, seat plans, payouts), unit-tested.

use anchor_lang::prelude::*;

use crate::errors::PokerError;

pub const TOURNEY_SEED: &[u8] = b"tourney";
pub const TOURNEY_VERSION: u8 = 1;
pub const MAX_ENTRANTS: usize = 30;
/// Seats per tournament table: 8, as at every table in the game (your call, 12 Oct).
pub const TOURNEY_SEATS: u8 = 8;
/// Table slots in the account: a round needs at most 4 (30 players / 8); 5 keeps the layout the first
/// tournaments were made with.
pub const MAX_TOURNEY_TABLES: usize = 5;
pub const START_STACK: u64 = 5_000;
/// Platform fee on entry fees only (GDD: 5%), to the config's dev wallet.
pub const TOURNEY_FEE_BPS: u64 = 500;
/// Pause between rounds, so players see the next round coming.
pub const ROUND_PAUSE_SECS: i64 = 60;
/// Earliest start after creation. The GDD asks 10 minutes; the game enforces that, the program allows
/// 2 minutes so devnet tests don't wait (an earlier start only costs the host registrations).
pub const MIN_LEAD_SECS: i64 = 120;
pub const MAX_LEAD_SECS: i64 = 14 * 86_400;
/// A tournament that hasn't moved for this long (no draw, no seating, no hand at any table) may be
/// cancelled by anyone, refunding every entry fee and the host prize (review M1; the GDD's Coins rule
/// refunds when the server goes silent).
pub const ABANDON_SECS: i64 = 2 * 3_600;
/// A seat whose player sent no seed for the hand is absent: its turns time out this fast.
pub const ABSENT_TURN_SECS: i64 = 3;
pub const NAME_LEN: usize = 40;

pub const T_REGISTERING: u8 = 0;
/// Randomness for the seat draw requested.
pub const T_DRAWING: u8 = 1;
pub const T_RUNNING: u8 = 2;
/// Down to its champion; `tourney_payout` pays.
pub const T_FINISHED: u8 = 3;
pub const T_PAID: u8 = 4;
/// Cancelled by the host or for too few players; `tourney_refund` pays everyone back.
pub const T_CANCELLED: u8 = 5;

pub const SPEED_TURBO: u8 = 0;
pub const SPEED_REGULAR: u8 = 1;
pub const SPEED_SLOW: u8 = 2;

/// An entrant's state.
pub const E_REGISTERED: u8 = 0;
pub const E_PLAYING: u8 = 1;
pub const E_OUT: u8 = 2;
/// Refunded after a cancellation (nothing more is owed to them).
pub const E_REFUNDED: u8 = 3;
pub const NO_TABLE: u8 = u8::MAX;

/// Table kinds (in the table's reserved bytes; 0 for every table made before M11).
pub const KIND_CASH: u8 = 0;
pub const KIND_TOURNEY: u8 = 1;

/// One registered player (72 bytes, zero-copy).
#[zero_copy]
#[derive(Default, PartialEq, Debug)]
pub struct Entrant {
    pub wallet: Pubkey,
    /// The player's table key for this tournament: signs their seeds and actions, reads their cards.
    pub reader: Pubkey,
    pub state: u8,
    /// Index into `Tournament::tables` this round, and the seat there (NO_TABLE when not seated).
    pub table: u8,
    pub seat: u8,
    /// Finishing place once out (1 = champion); 0 while still in.
    pub place: u8,
    pub pad: [u8; 4],
}

/// The tournament. Zero-copy (about 2.7 KB, too big to deserialize on the program's 4 KB stack); fields
/// are ordered so there's no padding.
#[account(zero_copy)]
pub struct Tournament {
    pub tourney_id: u64,
    pub entry_fee: u64,
    /// Funded by the host from their game balance; can be raised before the start, never lowered.
    pub host_prize: u64,
    pub start_ts: i64,
    /// When the first round began (the blind clock), and when the current round's tables may be seated.
    pub running_since: i64,
    pub round_starts_ts: i64,
    pub vrf_nonce: u64,
    pub vrf_requested_ts: i64,
    /// What the escrow owes: host prize + entry fees, less refunds and payouts. Always <= its balance.
    pub owed: u64,
    pub host: Pubkey,
    pub mint: Pubkey,
    pub champion: Pubkey,
    pub runner_up: Pubkey,
    pub tables: [Pubkey; MAX_TOURNEY_TABLES],
    pub name: [u8; NAME_LEN],
    /// sha256(tournament address, code) for a private tournament (all zero = listed publicly).
    pub code_hash: [u8; 32],
    pub entrants: [Entrant; MAX_ENTRANTS],
    pub version: u8,
    pub bump: u8,
    pub status: u8,
    pub speed: u8,
    pub max_players: u8,
    pub count: u8,
    /// 0 before the start, then 1, 2, ...
    pub round: u8,
    /// Tables used by the current round, and which of them have finished it (bit i = tables[i]).
    pub round_tables: u8,
    pub done_mask: u8,
    /// Tables linked (created, opened and checked) so far.
    pub linked: u8,
    /// Review H1: tables seated this round (bit i = tables[i]); a table is synced only once seated.
    pub seated_mask: u8,
    /// Review M3: tables closed after the end (bit i); the tournament closes only after all of them.
    pub closed_mask: u8,
    pub pad: [u8; 4],
    /// Review M1: when the tournament last moved (a draw, a seating, a hand played at any table). After
    /// ABANDON_SECS without that, anyone may cancel it and everyone is refunded.
    pub last_progress_ts: i64,
    /// Each table's hand number at its last sync (progress is a table playing hands).
    pub synced_hand: [u64; MAX_TOURNEY_TABLES],
    pub reserved: [u8; 8],
}

pub const TOURNEY_SPACE: usize = 8 + core::mem::size_of::<Tournament>();

impl Tournament {
    pub fn entrant_of(&self, wallet: &Pubkey) -> Option<usize> {
        self.entrants[..self.count as usize].iter().position(|e| e.wallet == *wallet)
    }
    /// Players still in (seated or waiting for the next round).
    pub fn alive(&self) -> usize {
        self.entrants[..self.count as usize].iter().filter(|e| e.state == E_PLAYING).count()
    }
    pub fn level_secs(&self) -> i64 {
        match self.speed {
            SPEED_TURBO => 300,
            SPEED_SLOW => 720,
            _ => 480,
        }
    }
    /// Blinds in force at `now` (the clock runs from the first round's start, pauses included).
    pub fn blinds_at(&self, now: i64) -> (u64, u64) {
        let level = if self.running_since == 0 { 0 } else { (now.saturating_sub(self.running_since) / self.level_secs()).max(0) as u32 };
        let sb = small_blind(level);
        (sb, sb.saturating_mul(2))
    }
}

/// Small blind at `level` (0-based): 25, 50, 100, 150, 200, 300, 500, 800, 1,000, 1,500, then doubling.
pub fn small_blind(level: u32) -> u64 {
    const LEVELS: [u64; 10] = [25, 50, 100, 150, 200, 300, 500, 800, 1_000, 1_500];
    if (level as usize) < LEVELS.len() {
        return LEVELS[level as usize];
    }
    let extra = (level as usize - LEVELS.len() + 1).min(40) as u32;
    1_500u64.saturating_mul(1u64 << extra)
}

/// Tables for a round of `n` players: one when 8 or fewer (the final table), else enough 8-seat tables.
pub fn tables_for(n: usize) -> usize {
    if n <= TOURNEY_SEATS as usize { 1 } else { (n + TOURNEY_SEATS as usize - 1) / TOURNEY_SEATS as usize }
}

/// Seats `order` (entrant indices, in draw order) round-robin over the round's tables: player k goes to
/// table k % t, seat k / t. Spread evenly, and consecutive players land at different tables (survivors
/// are ordered by their old table, so former tablemates are spread apart).
pub fn seat_plan(order: &[u8]) -> Vec<(u8, u8, u8)> {
    let t = tables_for(order.len());
    order.iter().enumerate().map(|(k, &e)| (e, (k % t) as u8, (k / t) as u8)).collect()
}

/// Fisher-Yates shuffle of `0..n` driven by `seed` (the VRF's randomness).
pub fn draw_order(n: usize, seed: &[u8; 32]) -> Vec<u8> {
    let mut order: Vec<u8> = (0..n as u8).collect();
    let mut state = *seed;
    for i in (1..n).rev() {
        state = solana_sha256_hasher::hashv(&[&state, &(i as u64).to_le_bytes()]).to_bytes();
        let r = u64::from_le_bytes(state[..8].try_into().unwrap());
        order.swap(i, (r % (i as u64 + 1)) as usize);
    }
    order
}

/// Prizes from the pool: the platform fee is 5% of the entry fees; 2nd gets 40% of the rest rounded
/// down, 1st the remainder, so the three always add up to what's owed.
pub fn payouts(entry_fee: u64, entrants: u64, host_prize: u64) -> Result<(u64, u64, u64)> {
    let fees = entry_fee.checked_mul(entrants).ok_or(PokerError::MathOverflow)?;
    let fee = fees.checked_mul(TOURNEY_FEE_BPS).ok_or(PokerError::MathOverflow)? / 10_000;
    let pool = fees.checked_add(host_prize).ok_or(PokerError::MathOverflow)?.checked_sub(fee).ok_or(PokerError::MathOverflow)?;
    let second = pool.checked_mul(40).ok_or(PokerError::MathOverflow)? / 100;
    Ok((pool - second, second, fee))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blinds_follow_the_gdd_schedule() {
        let got: Vec<u64> = (0..13).map(small_blind).collect();
        assert_eq!(got, vec![25, 50, 100, 150, 200, 300, 500, 800, 1_000, 1_500, 3_000, 6_000, 12_000]);
        assert!(small_blind(1_000) > 0);
    }

    #[test]
    fn rounds_shrink_to_a_final_table() {
        let mut rounds = vec![];
        for n in [2usize, 6, 7, 12, 13, 18, 19, 24, 25, 30] {
            let mut left = n;
            let mut tables = vec![];
            loop {
                let t = tables_for(left);
                tables.push(t);
                if t == 1 { break; }
                left = t * 2;
            }
            rounds.push((n, tables));
        }
        assert_eq!(rounds, vec![
            (2, vec![1]), (6, vec![1]), (7, vec![1]), (12, vec![2, 1]), (13, vec![2, 1]), (18, vec![3, 1]),
            (19, vec![3, 1]), (24, vec![3, 1]), (25, vec![4, 1]), (30, vec![4, 1]),
        ]);
    }

    #[test]
    fn seat_plans_are_even_and_never_overfill() {
        for n in 2..=30usize {
            let order: Vec<u8> = (0..n as u8).collect();
            let plan = seat_plan(&order);
            let t = tables_for(n);
            let mut per = vec![0usize; t];
            for &(_, table, seat) in &plan {
                assert!((seat as usize) < TOURNEY_SEATS as usize);
                per[table as usize] += 1;
            }
            assert!(per.iter().max().unwrap() - per.iter().min().unwrap() <= 1, "n={n} {per:?}");
            if t > 1 { assert!(*per.iter().min().unwrap() >= 3, "n={n}: a table would start at its stopping point"); }
        }
    }

    #[test]
    fn draw_is_a_permutation_and_depends_on_the_seed() {
        let a = draw_order(30, &[1; 32]);
        let b = draw_order(30, &[2; 32]);
        let mut s = a.clone();
        s.sort();
        assert_eq!(s, (0..30).collect::<Vec<u8>>());
        assert_ne!(a, b);
    }

    #[test]
    fn payouts_add_up() {
        let (first, second, fee) = payouts(1_000_000, 7, 3_000_000).unwrap();
        assert_eq!(fee, 350_000);
        assert_eq!(first + second + fee, 7_000_000 + 3_000_000);
        assert_eq!(second, (10_000_000 - 350_000) * 40 / 100);
        let (f2, s2, fee2) = payouts(0, 2, 5).unwrap();
        assert_eq!((f2, s2, fee2), (3, 2, 0));
    }
}
