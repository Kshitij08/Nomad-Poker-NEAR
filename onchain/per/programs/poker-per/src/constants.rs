use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";

/// Rake is taken on buy-in, in basis points. 10% is the hard ceiling the admin can never exceed.
pub const MAX_RAKE_BPS: u16 = 1_000;

/// Hold'em tables seat 2 to 9 players.
pub const MIN_SEATS: u8 = 2;
pub const MAX_SEATS: u8 = 9;

/// MagicBlock devnet Private ER (TEE) validator identity, verified in M0.
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

/// Layout version of the Config account. v2 added the reserved tail (see state.rs).
pub const CONFIG_VERSION: u8 = 2;
