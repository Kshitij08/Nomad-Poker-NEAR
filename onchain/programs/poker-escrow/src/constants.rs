//! Poker escrow program constants.

/// 0.1 SOL = 1,000 chips => 100_000 lamports per chip.
pub const LAMPORTS_PER_CHIP: u64 = 100_000;

/// Maximum rake in basis points (10%).
pub const MAX_RAKE_BPS: u16 = 1_000;

/// Seconds after last settlement before cash-out is allowed during an active round.
pub const STALE_ROUND_SECS: i64 = 600;

/// Seven days before an abandoned seat may be swept.
pub const ABANDONED_SEAT_SECS: i64 = 7 * 24 * 60 * 60;

pub const CONFIG_SEED: &[u8] = b"config";
pub const TABLE_SEED: &[u8] = b"table";
pub const VAULT_SEED: &[u8] = b"vault";
pub const SEAT_SEED: &[u8] = b"seat";
