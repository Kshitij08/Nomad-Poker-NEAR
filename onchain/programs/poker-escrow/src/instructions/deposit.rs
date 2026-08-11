use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::constants::*;
use crate::error::PokerError;
use crate::state::{
    chips_from_lamports, compute_rake, lamports_from_chips, Seat, SeatStatus, Table, Vault,
    Config,
};

#[derive(Accounts)]
#[instruction(table_id: [u8; 32])]
pub struct CreateTable<'info> {
    #[account(mut)]
    pub settlement_authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = settlement_authority,
        space = 8 + Table::INIT_SPACE,
        seeds = [TABLE_SEED, table_id.as_ref()],
        bump
    )]
    pub table: Account<'info, Table>,

    #[account(
        init,
        payer = settlement_authority,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, table_id.as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub system_program: Program<'info, System>,
}

pub fn create_table_handler(
    ctx: Context<CreateTable>,
    table_id: [u8; 32],
    host: Pubkey,
    buy_in_lamports: u64,
    small_blind_chips: u64,
    big_blind_chips: u64,
    max_seats: u8,
) -> Result<()> {
    let _ = chips_from_lamports(buy_in_lamports)?;
    let rake_bps = ctx.accounts.config.rake_bps;
    let now = Clock::get()?.unix_timestamp;
    let vault_rent = Rent::get()?.minimum_balance(8 + Vault::INIT_SPACE);

    let vault = &mut ctx.accounts.vault;
    vault.rent_reserve_lamports = vault_rent;
    vault.bump = ctx.bumps.vault;

    let table = &mut ctx.accounts.table;
    table.host = host;
    table.settlement_authority = ctx.accounts.settlement_authority.key();
    table.table_id = table_id;
    table.buy_in_lamports = buy_in_lamports;
    table.rake_bps = rake_bps;
    table.small_blind_chips = small_blind_chips;
    table.big_blind_chips = big_blind_chips;
    table.max_seats = max_seats;
    table.seated_count = 0;
    table.chips_in_play = 0;
    table.pending_chips_in_play = 0;
    table.round_nonce = 0;
    table.round_active = false;
    table.last_settlement_ts = now;
    table.bump = ctx.bumps.table;

    // Anchor `init` on the vault PDA already transfers the rent-exempt minimum from the payer.
    // Do not transfer vault_rent again — that leaves extra lamports in the vault and breaks
    // close_table (which requires vault_lamports == rent_reserve_lamports).

    Ok(())
}

#[derive(Accounts)]
#[instruction(table_id: [u8; 32])]
pub struct InitializeTable<'info> {
    #[account(mut)]
    pub host: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = host,
        space = 8 + Table::INIT_SPACE,
        seeds = [TABLE_SEED, table_id.as_ref()],
        bump
    )]
    pub table: Account<'info, Table>,

    #[account(
        init,
        payer = host,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, table_id.as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = host,
        space = 8 + Seat::INIT_SPACE,
        seeds = [SEAT_SEED, table_id.as_ref(), host.key().as_ref()],
        bump
    )]
    pub host_seat: Account<'info, Seat>,

    /// CHECK: dev wallet from config
    #[account(mut, address = config.dev_wallet)]
    pub dev_wallet: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_table_handler(
    ctx: Context<InitializeTable>,
    table_id: [u8; 32],
    settlement_authority: Pubkey,
    buy_in_lamports: u64,
    small_blind_chips: u64,
    big_blind_chips: u64,
    max_seats: u8,
) -> Result<()> {
    let chips = chips_from_lamports(buy_in_lamports)?;
    let rake_bps = ctx.accounts.config.rake_bps;
    let rake = compute_rake(buy_in_lamports, rake_bps)?;
    let now = Clock::get()?.unix_timestamp;

    let vault_rent = Rent::get()?.minimum_balance(8 + Vault::INIT_SPACE);
    let total_debit = buy_in_lamports
        .checked_add(rake)
        .ok_or(PokerError::MathOverflow)?;

    let table_key = ctx.accounts.table.key();
    let vault = &mut ctx.accounts.vault;
    vault.rent_reserve_lamports = vault_rent;
    vault.bump = ctx.bumps.vault;

    let table = &mut ctx.accounts.table;
    table.host = ctx.accounts.host.key();
    table.settlement_authority = settlement_authority;
    table.table_id = table_id;
    table.buy_in_lamports = buy_in_lamports;
    table.rake_bps = rake_bps;
    table.small_blind_chips = small_blind_chips;
    table.big_blind_chips = big_blind_chips;
    table.max_seats = max_seats;
    table.seated_count = 1;
    table.chips_in_play = chips;
    table.pending_chips_in_play = 0;
    table.round_nonce = 0;
    table.round_active = false;
    table.last_settlement_ts = now;
    table.bump = ctx.bumps.table;

    let host_seat = &mut ctx.accounts.host_seat;
    host_seat.table = table_key;
    host_seat.player = ctx.accounts.host.key();
    host_seat.chips = chips;
    host_seat.deposited_lamports = buy_in_lamports;
    host_seat.rake_paid_lamports = rake;
    host_seat.status = SeatStatus::Active;
    host_seat.last_active_ts = now;
    host_seat.pending_chips = 0;
    host_seat.bump = ctx.bumps.host_seat;

    // Fund vault with the buy-in principal only. Anchor `init` on the vault PDA already paid its rent.
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.host.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        buy_in_lamports,
    )?;

    if rake > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.host.to_account_info(),
                    to: ctx.accounts.dev_wallet.to_account_info(),
                },
            ),
            rake,
        )?;
    }

    let _ = total_debit;
    Ok(())
}

#[derive(Accounts)]
#[instruction(table_id: [u8; 32])]
pub struct BuyIn<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table_id.as_ref()],
        bump = table.bump
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [VAULT_SEED, table_id.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = player,
        space = 8 + Seat::INIT_SPACE,
        seeds = [SEAT_SEED, table_id.as_ref(), player.key().as_ref()],
        bump
    )]
    pub seat: Account<'info, Seat>,

    /// CHECK: dev wallet from config
    #[account(mut, address = config.dev_wallet)]
    pub dev_wallet: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn buy_in_handler(ctx: Context<BuyIn>, _table_id: [u8; 32]) -> Result<()> {
    let table = &ctx.accounts.table;
    require!(
        table.seated_count < table.max_seats,
        PokerError::TableFull
    );

    let buy_in_lamports = table.buy_in_lamports;
    let rake_bps = table.rake_bps;
    let chips = chips_from_lamports(buy_in_lamports)?;
    let rake = compute_rake(buy_in_lamports, rake_bps)?;
    let now = Clock::get()?.unix_timestamp;
    let table_key = ctx.accounts.table.key();

    deposit_to_seat(
        &ctx.accounts.player,
        &ctx.accounts.dev_wallet,
        &ctx.accounts.vault,
        &mut ctx.accounts.seat,
        &mut ctx.accounts.table,
        table_key,
        buy_in_lamports,
        rake,
        chips,
        now,
        ctx.accounts.system_program.to_account_info(),
    )?;
    ctx.accounts.seat.bump = ctx.bumps.seat;

    ctx.accounts.table.seated_count = ctx
        .accounts
        .table
        .seated_count
        .checked_add(1)
        .ok_or(PokerError::MathOverflow)?;

    Ok(())
}

#[derive(Accounts)]
#[instruction(table_id: [u8; 32])]
pub struct Rebuy<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table_id.as_ref()],
        bump = table.bump
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [VAULT_SEED, table_id.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [SEAT_SEED, table_id.as_ref(), player.key().as_ref()],
        bump = seat.bump,
        has_one = player @ PokerError::Unauthorized
    )]
    pub seat: Account<'info, Seat>,

    /// CHECK: dev wallet from config
    #[account(mut, address = config.dev_wallet)]
    pub dev_wallet: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn rebuy_handler(ctx: Context<Rebuy>, table_id: [u8; 32], buy_in_lamports: u64) -> Result<()> {
    let rake_bps = ctx.accounts.table.rake_bps;
    let chips = chips_from_lamports(buy_in_lamports)?;
    let rake = compute_rake(buy_in_lamports, rake_bps)?;
    let now = Clock::get()?.unix_timestamp;
    let table_key = ctx.accounts.table.key();

    deposit_to_seat(
        &ctx.accounts.player,
        &ctx.accounts.dev_wallet,
        &ctx.accounts.vault,
        &mut ctx.accounts.seat,
        &mut ctx.accounts.table,
        table_key,
        buy_in_lamports,
        rake,
        chips,
        now,
        ctx.accounts.system_program.to_account_info(),
    )?;

    let _ = table_id;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn deposit_to_seat<'info>(
    player: &Signer<'info>,
    dev_wallet: &UncheckedAccount<'info>,
    vault: &Account<'info, Vault>,
    seat: &mut Account<'info, Seat>,
    table: &mut Account<'info, Table>,
    table_key: Pubkey,
    buy_in_lamports: u64,
    rake: u64,
    chips: u64,
    now: i64,
    system_program: AccountInfo<'info>,
) -> Result<()> {
    if seat.player == Pubkey::default() {
        seat.table = table_key;
        seat.player = player.key();
        seat.status = SeatStatus::Active;
    }

    system_program::transfer(
        CpiContext::new(
            system_program.clone(),
            Transfer {
                from: player.to_account_info(),
                to: vault.to_account_info(),
            },
        ),
        buy_in_lamports,
    )?;

    if rake > 0 {
        system_program::transfer(
            CpiContext::new(
                system_program,
                Transfer {
                    from: player.to_account_info(),
                    to: dev_wallet.to_account_info(),
                },
            ),
            rake,
        )?;
    }

    seat.chips = seat
        .chips
        .checked_add(chips)
        .ok_or(PokerError::ChipOverflow)?;
    seat.deposited_lamports = seat
        .deposited_lamports
        .checked_add(buy_in_lamports)
        .ok_or(PokerError::MathOverflow)?;
    seat.rake_paid_lamports = seat
        .rake_paid_lamports
        .checked_add(rake)
        .ok_or(PokerError::MathOverflow)?;
    seat.last_active_ts = now;

    if table.round_active {
        seat.pending_chips = seat
            .pending_chips
            .checked_add(chips)
            .ok_or(PokerError::ChipOverflow)?;
        table.pending_chips_in_play = table
            .pending_chips_in_play
            .checked_add(chips)
            .ok_or(PokerError::ChipOverflow)?;
    } else {
        seat.chips = seat
            .chips
            .checked_add(chips)
            .ok_or(PokerError::ChipOverflow)?;
        table.chips_in_play = table
            .chips_in_play
            .checked_add(chips)
            .ok_or(PokerError::ChipOverflow)?;
    }

    verify_vault_balance(vault, table)?;
    Ok(())
}

pub fn verify_vault_balance(vault: &Account<'_, Vault>, table: &Table) -> Result<()> {
    let chips_backed = table
        .chips_in_play
        .checked_add(table.pending_chips_in_play)
        .ok_or(PokerError::MathOverflow)?;
    let expected_player_lamports = lamports_from_chips(chips_backed)?;
    let total = vault.to_account_info().lamports();
    let required = expected_player_lamports
        .checked_add(vault.rent_reserve_lamports)
        .ok_or(PokerError::MathOverflow)?;
    require!(total >= required, PokerError::VaultInvariant);
    Ok(())
}
