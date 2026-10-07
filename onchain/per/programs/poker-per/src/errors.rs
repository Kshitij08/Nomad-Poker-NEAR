use anchor_lang::prelude::*;

#[error_code]
pub enum PokerError {
    #[msg("Only the program's upgrade authority can initialize the config")]
    NotUpgradeAuthority,
    #[msg("Only the config admin can do this")]
    NotAdmin,
    #[msg("Rake is above the 10% ceiling")]
    RakeTooHigh,
    #[msg("Stake cap must be greater than zero")]
    InvalidStakeCap,
    #[msg("Only the proposed admin can accept")]
    NotPendingAdmin,
    #[msg("There is no pending admin to accept")]
    NoPendingAdmin,
    #[msg("Dev wallet cannot be the default (all zeros) address")]
    InvalidDevWallet,
    #[msg("Config is on an older layout; run migrate_config first")]
    ConfigOutdated,
    #[msg("Config is already on the current layout")]
    AlreadyMigrated,
}
