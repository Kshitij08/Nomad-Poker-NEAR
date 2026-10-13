use anchor_lang::prelude::*;

use crate::constants::MAX_RAKE_BPS;
use crate::errors::PokerError;

/// Bytes kept free at the end of Config so later modules can add fields without a realloc.
pub const CONFIG_RESERVED: usize = 90;

/// Default and bounds for `escape_idle_secs` (0 in the account means the default).
pub const DEFAULT_ESCAPE_IDLE_SECS: u32 = 3_600;
pub const MIN_ESCAPE_IDLE_SECS: u32 = 60;
pub const MAX_ESCAPE_IDLE_SECS: u32 = 7 * 24 * 3_600;

/// Program-wide settings. One per program, at PDA ["config"]. Lives on L1 and is never delegated,
/// so rollup instructions read a cloned, read-only copy.
///
/// Layout history: v1 (M1 first deploy) had no `reserved` tail. v2 appends it. `migrate_config`
/// upgrades a v1 account in place.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub version: u8,
    pub bump: u8,
    pub admin: Pubkey,
    /// Two-step admin handover: set by `propose_admin`, cleared by `accept_admin`.
    pub pending_admin: Option<Pubkey>,
    /// Receives rake.
    pub dev_wallet: Pubkey,
    pub rake_bps: u16,
    /// Largest buy-in any table may accept, in the table token's base units. This is the per-table
    /// stake cap from the M0 custody decision.
    pub max_buy_in: u64,
    /// When true, no new tables or buy-ins. Existing players can still leave.
    pub paused: bool,
    /// How long a table's last L1 commit must be idle before an emergency undelegation request.
    /// Carved from the old reserved bytes, so existing v2 accounts read 0 = default.
    pub escape_idle_secs: u32,
    /// May read finished hands' action logs (`open_log`); default = no auditor. Carved from the
    /// reserved bytes, so existing accounts read "none".
    pub auditor: Pubkey,
    /// Copy strategies (Agents v2): Nomad's share of a copier's new profit, in basis points; 0 = the default
    /// (`DEFAULT_PLATFORM_FEE_BPS`). Carved from the reserved bytes, so existing accounts read the default.
    pub agent_fee_bps: u16,
    pub reserved: [u8; CONFIG_RESERVED],
}

/// Copy strategies: the platform's share of new profit (default 2%, never above 5%), and the most a creator may ask.
pub const DEFAULT_PLATFORM_FEE_BPS: u16 = 200;
pub const MAX_PLATFORM_FEE_BPS: u16 = 500;
pub const MAX_CREATOR_FEE_BPS: u16 = 2_000;

impl Config {
    pub fn agent_fee_bps(&self) -> u16 {
        if self.agent_fee_bps == 0 { DEFAULT_PLATFORM_FEE_BPS } else { self.agent_fee_bps }
    }

    pub fn escape_idle_secs(&self) -> i64 {
        if self.escape_idle_secs == 0 { DEFAULT_ESCAPE_IDLE_SECS as i64 } else { self.escape_idle_secs as i64 }
    }
}

/// The v1 layout, used only to read an old account during migration.
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ConfigV1 {
    pub version: u8,
    pub bump: u8,
    pub admin: Pubkey,
    pub pending_admin: Option<Pubkey>,
    pub dev_wallet: Pubkey,
    pub rake_bps: u16,
    pub max_buy_in: u64,
    pub paused: bool,
}

/// Validated settings shared by `initialize_config` and `update_config`.
pub fn check_settings(dev_wallet: &Pubkey, rake_bps: u16, max_buy_in: u64, escape_idle_secs: u32) -> Result<()> {
    require!(*dev_wallet != Pubkey::default(), PokerError::InvalidDevWallet);
    require!(
        escape_idle_secs == 0 || (MIN_ESCAPE_IDLE_SECS..=MAX_ESCAPE_IDLE_SECS).contains(&escape_idle_secs),
        PokerError::InvalidEscapeDelay
    );
    require!(rake_bps <= MAX_RAKE_BPS, PokerError::RakeTooHigh);
    require!(max_buy_in > 0, PokerError::InvalidStakeCap);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_bounds() {
        let w = Pubkey::new_unique();
        assert!(check_settings(&w, 0, 1, 0).is_ok());
        assert!(check_settings(&w, MAX_RAKE_BPS, u64::MAX, 0).is_ok());
        assert!(check_settings(&w, MAX_RAKE_BPS + 1, 1, 0).is_err());
        assert!(check_settings(&w, 500, 0, 0).is_err());
        assert!(check_settings(&Pubkey::default(), 500, 1, 0).is_err());
        assert!(check_settings(&w, 500, 1, 59).is_err());
        assert!(check_settings(&w, 500, 1, 60).is_ok());
        assert!(check_settings(&w, 500, 1, MAX_ESCAPE_IDLE_SECS + 1).is_err());
    }

    #[test]
    fn v2_extends_v1_without_moving_fields() {
        let v1 = ConfigV1 {
            version: 1,
            bump: 254,
            admin: Pubkey::new_unique(),
            pending_admin: Some(Pubkey::new_unique()),
            dev_wallet: Pubkey::new_unique(),
            rake_bps: 500,
            max_buy_in: 1_000_000_000,
            paused: true,
        };
        let mut v1_bytes = Vec::new();
        v1.serialize(&mut v1_bytes).unwrap();
        let v2 = Config {
            version: 2,
            bump: v1.bump,
            admin: v1.admin,
            pending_admin: v1.pending_admin,
            dev_wallet: v1.dev_wallet,
            rake_bps: v1.rake_bps,
            max_buy_in: v1.max_buy_in,
            paused: v1.paused,
            escape_idle_secs: 0,
            auditor: Pubkey::default(),
            agent_fee_bps: 0,
            reserved: [0; CONFIG_RESERVED],
        };
        let mut v2_bytes = Vec::new();
        AnchorSerialize::serialize(&v2, &mut v2_bytes).unwrap();
        // Same bytes after the version byte, then a zero tail: escape_idle_secs + auditor + agent_fee_bps +
        // reserved, the same length as before the auditor and the Agent fee were carved out of reserved.
        assert_eq!(&v2_bytes[1..v1_bytes.len()], &v1_bytes[1..]);
        assert_eq!(v2_bytes.len(), v1_bytes.len() + 4 + 32 + 2 + CONFIG_RESERVED);
        assert_eq!(32 + 2 + CONFIG_RESERVED, 124);
        assert!(v2_bytes[v1_bytes.len()..].iter().all(|b| *b == 0));
    }
}
