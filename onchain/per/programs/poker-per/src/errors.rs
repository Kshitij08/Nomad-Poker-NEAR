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
    #[msg("This table is invite-only and this wallet isn't invited")]
    NotInvited,
    #[msg("That seat is taken")]
    SeatTaken,
    #[msg("Invalid seat")]
    InvalidSeat,
    #[msg("Too many invites")]
    TooManyInvites,
    #[msg("Table's private accounts aren't set up yet; call open_table")]
    TableNotOpened,
    #[msg("Reader must be a fresh key: not the wallet, the default key, or a key already used at this table")]
    InvalidReader,
    #[msg("A hand is in progress")]
    HandInProgress,
    #[msg("At least two seated players are needed to start a hand")]
    NotEnoughPlayers,
    #[msg("Randomness was requested recently; wait before requesting again")]
    VrfPending,
    #[msg("Randomness isn't expected now (replayed or late callback)")]
    StaleRandomness,
    #[msg("No dealt hand to end")]
    HandNotDealt,
    #[msg("Every seated player must commit a seed before the hand starts")]
    MissingSeeds,
    #[msg("Randomness is still expected; too early to abandon the hand")]
    TooEarlyToAbort,
    #[msg("No hand is waiting for randomness")]
    NotShuffling,
    #[msg("It isn't this seat's turn")]
    NotYourTurn,
    #[msg("That action isn't allowed now")]
    IllegalAction,
    #[msg("The player still has time to act")]
    TurnNotOver,
    #[msg("No hand is being played")]
    HandNotPlaying,
    #[msg("The table was committed recently; only the creator may commit again this soon")]
    CommitTooSoon,
    #[msg("The table isn't closed and back on Solana (or was already reclaimed)")]
    TableNotClosed,
    #[msg("No auditor is set in the config")]
    NoAuditor,
    #[msg("This table hasn't finished a hand yet")]
    NoFinishedHand,
    #[msg("Missing or invalid wallet signature for this play key (expected an Ed25519 check right before this instruction)")]
    BadPlayKeyProof,
    #[msg("The play key's authorization has expired or runs too far ahead")]
    PlayKeyExpired,
    #[msg("Only the seat's table key or the wallet's play key can do this")]
    NotSeatKey,
    #[msg("This game balance can't be used safely: someone else set up its rollup account first (it isn't public, or isn't handed to the TEE validator)")]
    VaultBlocked,
    #[msg("Create the private invite list first (a call with no list and no link), then set it: the first call's data wouldn't be withheld")]
    InvitesNotReady,
    #[msg("This table still has its Solana invite list; close it first (close_invites)")]
    OldInviteList,
    #[msg("This game balance isn't blocked; a fresh one is only for a blocked balance")]
    VaultNotBlocked,
    #[msg("The wallet's state account can't be read")]
    BadWalletState,
    #[msg("The old game balance still holds money; withdraw it first")]
    VaultNotEmpty,
    #[msg("The host hasn't started the table yet (Start round)")]
    StartNotRequested,
    #[msg("Only the host may start the round")]
    NotHost,
    #[msg("A tournament table holds chips, not money: no buy-in, cash-out or rake there")]
    TourneyTable,
    #[msg("The tournament isn't taking registrations")]
    TourneyClosed,
    #[msg("The tournament is full")]
    TourneyFull,
    #[msg("Already registered")]
    AlreadyRegistered,
    #[msg("Not registered in this tournament")]
    NotRegistered,
    #[msg("The tournament hasn't reached its start time")]
    TourneyTooEarly,
    #[msg("Bad tournament settings")]
    BadTourneySettings,
    #[msg("Wrong private code")]
    BadTourneyCode,
    #[msg("The tournament's tables aren't ready")]
    TourneyTablesNotReady,
    #[msg("Not a table of this tournament")]
    NotTourneyTable,
    #[msg("The tournament isn't in that stage")]
    TourneyWrongStage,
    #[msg("Nothing to pay this wallet")]
    NothingOwed,
}
