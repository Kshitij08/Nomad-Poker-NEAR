use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

pub use instructions::*;
use state::ChipDelta;

declare_id!("GdduGzsoiEamv285Z4DnBapmkMScnHLDdUAdWPywHozo");

#[program]
pub mod poker_escrow {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        dev_wallet: Pubkey,
        rake_bps: u16,
    ) -> Result<()> {
        config::handler(ctx, dev_wallet, rake_bps)
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        dev_wallet: Pubkey,
        rake_bps: u16,
    ) -> Result<()> {
        config::update_handler(ctx, dev_wallet, rake_bps)
    }

    pub fn update_settlement_authority(
        ctx: Context<UpdateSettlementAuthority>,
        table_id: [u8; 32],
        new_authority: Pubkey,
    ) -> Result<()> {
        config::update_settlement_authority_handler(ctx, table_id, new_authority)
    }

    pub fn create_table(
        ctx: Context<CreateTable>,
        table_id: [u8; 32],
        host: Pubkey,
        buy_in_lamports: u64,
        small_blind_chips: u64,
        big_blind_chips: u64,
        max_seats: u8,
    ) -> Result<()> {
        deposit::create_table_handler(
            ctx,
            table_id,
            host,
            buy_in_lamports,
            small_blind_chips,
            big_blind_chips,
            max_seats,
        )
    }

    pub fn initialize_table(
        ctx: Context<InitializeTable>,
        table_id: [u8; 32],
        settlement_authority: Pubkey,
        buy_in_lamports: u64,
        small_blind_chips: u64,
        big_blind_chips: u64,
        max_seats: u8,
    ) -> Result<()> {
        deposit::initialize_table_handler(
            ctx,
            table_id,
            settlement_authority,
            buy_in_lamports,
            small_blind_chips,
            big_blind_chips,
            max_seats,
        )
    }

    pub fn buy_in(ctx: Context<BuyIn>, table_id: [u8; 32]) -> Result<()> {
        deposit::buy_in_handler(ctx, table_id)
    }

    pub fn rebuy(ctx: Context<Rebuy>, table_id: [u8; 32], buy_in_lamports: u64) -> Result<()> {
        deposit::rebuy_handler(ctx, table_id, buy_in_lamports)
    }

    pub fn begin_round(ctx: Context<BeginRound>, table_id: [u8; 32]) -> Result<()> {
        round_settlement::begin_round_handler(ctx, table_id)
    }

    pub fn settle_round(
        ctx: Context<SettleRound>,
        table_id: [u8; 32],
        nonce: u64,
        deltas: Vec<ChipDelta>,
    ) -> Result<()> {
        round_settlement::settle_round_handler(ctx, table_id, nonce, deltas)
    }

    pub fn request_leave(ctx: Context<RequestLeave>, table_id: [u8; 32]) -> Result<()> {
        exit::request_leave_handler(ctx, table_id)
    }

    pub fn cash_out(ctx: Context<CashOut>, table_id: [u8; 32]) -> Result<()> {
        exit::cash_out_handler(ctx, table_id)
    }

    pub fn sweep_abandoned_seat(
        ctx: Context<SweepAbandonedSeat>,
        table_id: [u8; 32],
    ) -> Result<()> {
        exit::sweep_abandoned_seat_handler(ctx, table_id)
    }

    pub fn close_table(ctx: Context<CloseTable>, table_id: [u8; 32]) -> Result<()> {
        exit::close_table_handler(ctx, table_id)
    }
}
