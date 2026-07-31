use anchor_lang::prelude::*;

#[error_code]
pub enum PokerError {
    #[msg("Rake exceeds maximum allowed basis points")]
    RakeTooHigh,
    #[msg("Buy-in must be divisible by lamports per chip")]
    BuyInNotDivisible,
    #[msg("Table is full")]
    TableFull,
    #[msg("Round is in progress")]
    RoundInProgress,
    #[msg("Settlement deltas must sum to zero")]
    SettlementNotZeroSum,
    #[msg("Stale or replayed settlement nonce")]
    StaleSettlement,
    #[msg("Chip balance would underflow")]
    ChipUnderflow,
    #[msg("Chip balance would overflow")]
    ChipOverflow,
    #[msg("Vault invariant violated")]
    VaultInvariant,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Table is not empty")]
    TableNotEmpty,
    #[msg("Seat is not abandoned long enough")]
    SeatNotAbandoned,
    #[msg("Invalid seat status")]
    InvalidSeatStatus,
    #[msg("Settlement delta list too long")]
    TooManyDeltas,
    #[msg("Seat not found in settlement")]
    SeatNotInSettlement,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
