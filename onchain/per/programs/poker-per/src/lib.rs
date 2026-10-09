//! Private poker tables on a MagicBlock Private Ephemeral Rollup (TEE), dealt with MagicBlock VRF.
//! M1: program config. M2: tables and money (L1 create/delegate/escape hatch, rollup buy-in,
//! cash-out, rake, commit). M3: private ledger, hands and deck. M4: VRF shuffle and deal.
//! M5: the Hold'em engine (betting, timers, side pots, showdown). M6: hand records. M9: game vault
//! and play keys.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod constants;
pub mod dealing;
pub mod engine;
pub mod errors;
pub mod instructions;
pub mod private;
pub mod state;
pub mod table;

use instructions::*;

declare_id!("7q2vxh2rNioeY5wsTpfvVGDR2yg3xhkqRYC5Urq4gwpv");

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

    // ---- L1: tables

    pub fn create_table(ctx: Context<CreateTable>, table_id: u64, params: table::TableParams) -> Result<()> {
        instructions::table::create_table(ctx, table_id, params)
    }

    pub fn delegate_table(ctx: Context<DelegateTable>, table_id: u64, creator: Pubkey) -> Result<()> {
        instructions::table::delegate_table(ctx, table_id, creator)
    }

    pub fn request_table_undelegation(ctx: Context<RequestTableUndelegation>, table_id: u64, creator: Pubkey) -> Result<()> {
        instructions::table::request_table_undelegation(ctx, table_id, creator)
    }

    pub fn rollback_table(ctx: Context<RollbackTable>, table_id: u64, creator: Pubkey) -> Result<()> {
        instructions::table::rollback_table(ctx, table_id, creator)
    }

    pub fn reclaim_table(ctx: Context<ReclaimTable>, table_id: u64) -> Result<()> {
        instructions::table::reclaim_table(ctx, table_id)
    }

    pub fn set_auditor(ctx: Context<AdminOnly>, auditor: Pubkey) -> Result<()> {
        instructions::config::set_auditor(ctx, auditor)
    }

    pub fn open_log(ctx: Context<OpenLog>) -> Result<()> {
        instructions::play::open_log(ctx)
    }

    pub fn set_invites(ctx: Context<SetInvites>, table_id: u64, hashes: Vec<[u8; 32]>) -> Result<()> {
        instructions::table::set_invites(ctx, table_id, hashes)
    }

    pub fn close_invites(ctx: Context<CloseInvites>, table_id: u64) -> Result<()> {
        instructions::table::close_invites(ctx, table_id)
    }

    // ---- Rollup: private accounts and money

    pub fn open_table(ctx: Context<OpenTable>) -> Result<()> {
        instructions::money::open_table(ctx)
    }

    pub fn buy_in(ctx: Context<BuyIn>, seat: u8, amount: u64, reader: Pubkey) -> Result<()> {
        instructions::money::buy_in(ctx, seat, amount, reader)
    }

    pub fn cash_out(ctx: Context<CashOut>, seat: u8) -> Result<()> {
        instructions::money::cash_out(ctx, seat)
    }

    // ---- M9: game vault and play keys (the wallet signs only what it can preview)

    pub fn open_vault(ctx: Context<OpenVault>) -> Result<()> {
        instructions::vault::open_vault(ctx)
    }

    pub fn vault_buy_in(ctx: Context<VaultBuyIn>, seat: u8, amount: u64, reader: Pubkey, expires: i64) -> Result<()> {
        instructions::vault::vault_buy_in(ctx, seat, amount, reader, expires)
    }

    pub fn vault_buy_in_code(ctx: Context<VaultBuyIn>, seat: u8, amount: u64, reader: Pubkey, expires: i64, code: [u8; 16]) -> Result<()> {
        instructions::vault::vault_buy_in_code(ctx, seat, amount, reader, expires, code)
    }

    pub fn set_invites_keyed(ctx: Context<SetInvitesKeyed>, expires: i64, hashes: Option<Vec<[u8; 16]>>, code_hash: Option<[u8; 32]>) -> Result<()> {
        instructions::vault::set_invites_keyed(ctx, expires, hashes, code_hash)
    }

    pub fn vault_cash_out(ctx: Context<VaultCashOut>, seat: u8, expires: i64) -> Result<()> {
        instructions::vault::vault_cash_out(ctx, seat, expires)
    }

    pub fn vault_withdraw(ctx: Context<VaultWithdraw>, amount: u64, expires: i64) -> Result<()> {
        instructions::vault::vault_withdraw(ctx, amount, expires)
    }

    pub fn vault_balance(ctx: Context<VaultBalance>, expires: i64) -> Result<()> {
        instructions::vault::vault_balance(ctx, expires)
    }

    pub fn close_table_keyed(ctx: Context<CloseTableKeyed>, expires: i64) -> Result<()> {
        instructions::vault::close_table_keyed(ctx, expires)
    }

    pub fn collect_rake(ctx: Context<CollectRake>) -> Result<()> {
        instructions::money::collect_rake(ctx)
    }

    pub fn commit_table(ctx: Context<CommitTable>) -> Result<()> {
        instructions::money::commit_table(ctx)
    }

    pub fn close_table(ctx: Context<CloseTable>) -> Result<()> {
        instructions::money::close_table(ctx)
    }

    // ---- Rollup: hands (M4: randomness, shuffle and deal)

    pub fn commit_seed(ctx: Context<CommitSeed>, seat: u8, seed: [u8; 32]) -> Result<()> {
        instructions::hand::commit_seed(ctx, seat, seed)
    }

    pub fn start_hand(ctx: Context<StartHand>) -> Result<()> {
        instructions::hand::start_hand(ctx)
    }

    pub fn deal<'info>(ctx: Context<'info, Deal<'info>>, randomness: [u8; 32], nonce: u64) -> Result<()> {
        instructions::hand::deal(ctx, randomness, nonce)
    }

    pub fn abort_hand(ctx: Context<AbortHand>) -> Result<()> {
        instructions::hand::abort_hand(ctx)
    }

    // ---- Rollup: playing a hand (M5)

    pub fn begin_hand(ctx: Context<BeginHand>) -> Result<()> {
        instructions::play::begin_hand(ctx)
    }

    pub fn act(ctx: Context<Play>, seat: u8, kind: u8, amount: u64) -> Result<()> {
        instructions::play::act(ctx, seat, kind, amount)
    }

    pub fn timeout(ctx: Context<Play>) -> Result<()> {
        instructions::play::timeout(ctx)
    }

    pub fn tick(ctx: Context<BeginHand>) -> Result<()> {
        instructions::play::tick(ctx)
    }
}
