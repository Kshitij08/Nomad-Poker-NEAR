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
    #[msg("New tables and buy-ins are paused")]
    Paused,
    #[msg("Blinds must be positive and small blind <= big blind")]
    InvalidBlinds,
    #[msg("Buy-in range must be at least 10 big blinds and min <= max")]
    InvalidBuyInRange,
    #[msg("Above the program-wide stake cap")]
    AboveStakeCap,
    #[msg("Seats must be between 2 and 9")]
    InvalidSeatCount,
    #[msg("Table is not open")]
    TableNotOpen,
    #[msg("Buy-in is below the table minimum")]
    BuyInTooSmall,
    #[msg("Buy-in would take the stack above the table maximum")]
    BuyInTooLarge,
    #[msg("Table is full")]
    TableFull,
    #[msg("This wallet has no seat at the table")]
    NotSeated,
    #[msg("Escrow balance does not cover what the table owes")]
    EscrowShortfall,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Only the table creator can do this")]
    NotCreator,
    #[msg("Table must be empty")]
    TableNotEmpty,
    #[msg("Nothing to collect")]
    NothingToCollect,
    #[msg("Money moves only run inside the MagicBlock rollup")]
    NotInRollup,
    #[msg("Table ledger does not add up")]
    LedgerMismatch,
    #[msg("Rollback did not return the table to this program")]
    RollbackFailed,
    #[msg("Only wrapped SOL tables are supported for now")]
    UnsupportedMint,
    #[msg("A rebuy must be at least one big blind")]
    RebuyTooSmall,
    #[msg("Table is active: emergency undelegation needs its last commit to be idle for the escape delay")]
    TableActive,
    #[msg("Escape delay must be 0 (default) or between 60 seconds and 7 days")]
    InvalidEscapeDelay,
}
