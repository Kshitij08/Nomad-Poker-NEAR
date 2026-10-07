//! Private poker tables on a MagicBlock Private Ephemeral Rollup (TEE), dealt with MagicBlock VRF.
//! M1 is the skeleton: program-wide config only. Tables, money, privacy and the game engine land
//! in M2 to M6 (see docs/proofs).

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("6Pzbm2QQorrazztVNrXWh2kmCEeukTcsnGDmtPpRjvVR");

#[ephemeral]
#[program]
pub mod poker_per {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, args: ConfigArgs) -> Result<()> {
        instructions::config::initialize_config(ctx, args)
    }

    pub fn update_config(ctx: Context<AdminOnly>, args: ConfigArgs) -> Result<()> {
        instructions::config::update_config(ctx, args)
    }

    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Option<Pubkey>) -> Result<()> {
        instructions::config::propose_admin(ctx, new_admin)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::config::accept_admin(ctx)
    }

    pub fn migrate_config(ctx: Context<MigrateConfig>) -> Result<()> {
        instructions::config::migrate_config(ctx)
    }
}
