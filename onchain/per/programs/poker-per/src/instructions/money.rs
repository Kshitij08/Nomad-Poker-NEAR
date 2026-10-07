//! Money inside the TEE rollup: buy-in (and rebuy), cash-out, rake collection, and committing the
//! table ledger to L1. Tokens move between ordinary SPL token accounts that MagicBlock's Ephemeral
//! SPL Token program projects into the rollup (the sealed-auction pattern verified in M0).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::constants::{CONFIG_SEED, CONFIG_VERSION};
use crate::errors::PokerError;
use crate::state::Config;
use crate::table::{rake_for, Seat, Table, STATUS_CLOSED, STATUS_OPEN, TABLE_SEED};

#[derive(Accounts)]
pub struct BuyIn<'info> {
    pub player: Signer<'info>,
    /// Read-only clone of the L1 config inside the rollup.
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.version == CONFIG_VERSION @ PokerError::ConfigOutdated)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Account<'info, Table>,
    #[account(mut, token::mint = table.mint, token::authority = player)]
    pub player_token: Account<'info, TokenAccount>,
    #[account(mut, address = get_associated_token_address(&table.key(), &table.mint))]
    pub escrow: Account<'info, TokenAccount>,
    /// CHECK: MagicBlock's Magic program only exists inside the rollup; requiring it executable
    /// keeps money moves off L1.
    #[account(address = MAGIC_PROGRAM_ID, constraint = in_rollup.executable @ PokerError::NotInRollup)]
    pub in_rollup: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Sit down with `amount`, or add `amount` to an existing seat (rebuy). Rake is taken on every
/// buy-in. The resulting stack must stay within the table's min/max and the program stake cap.
pub fn buy_in(ctx: Context<BuyIn>, amount: u64) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, PokerError::Paused);
    let table = &mut ctx.accounts.table;
    require!(table.status == STATUS_OPEN, PokerError::TableNotOpen);
    require!(amount > 0, PokerError::BuyInTooSmall);

    let player = ctx.accounts.player.key();
    let rake = rake_for(amount, table.rake_bps)?;
    let chips = amount.checked_sub(rake).ok_or(PokerError::MathOverflow)?;
    let cap = table.max_buy_in.min(config.max_buy_in);

    let idx = match table.seat_of(&player) {
        Some(i) => i,
        None => {
            require!(amount >= table.min_buy_in, PokerError::BuyInTooSmall);
            let i = table.first_empty_seat().ok_or(PokerError::TableFull)?;
            table.seats[i] = Seat { player, stack: 0, deposited: 0 };
            table.seated = table.seated.checked_add(1).ok_or(PokerError::MathOverflow)?;
            i
        }
    };
    if table.seats[idx].deposited > 0 {
        require!(amount >= table.big_blind, PokerError::RebuyTooSmall);
    }
    let seat = &mut table.seats[idx];
    seat.stack = seat.stack.checked_add(chips).ok_or(PokerError::MathOverflow)?;
    seat.deposited = seat.deposited.checked_add(amount).ok_or(PokerError::MathOverflow)?;
    require!(seat.stack <= cap, PokerError::BuyInTooLarge);
    let stack = seat.stack;

    table.rake_accrued = table.rake_accrued.checked_add(rake).ok_or(PokerError::MathOverflow)?;
    table.escrow_owed = table.escrow_owed.checked_add(amount).ok_or(PokerError::MathOverflow)?;
    table.total_deposited = table.total_deposited.checked_add(amount).ok_or(PokerError::MathOverflow)?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.player_token.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.player.to_account_info(),
            },
        ),
        amount,
    )?;
    settle_check(&mut ctx.accounts.escrow, table)?;
    emit!(BoughtIn { table: table.key(), player, seat: idx as u8, amount, rake, stack });
    Ok(())
}

#[derive(Accounts)]
pub struct CashOut<'info> {
    pub player: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Account<'info, Table>,
    #[account(mut, token::mint = table.mint, token::authority = player)]
    pub player_token: Account<'info, TokenAccount>,
    #[account(mut, address = get_associated_token_address(&table.key(), &table.mint))]
    pub escrow: Account<'info, TokenAccount>,
    /// CHECK: MagicBlock's Magic program only exists inside the rollup; requiring it executable
    /// keeps money moves off L1.
    #[account(address = MAGIC_PROGRAM_ID, constraint = in_rollup.executable @ PokerError::NotInRollup)]
    pub in_rollup: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Leave the table with the whole stack. Works even when the program is paused. (From M5 on this
/// will also require that the player is not in a hand.)
pub fn cash_out(ctx: Context<CashOut>) -> Result<()> {
    let player = ctx.accounts.player.key();
    let table = &mut ctx.accounts.table;
    let idx = table.seat_of(&player).ok_or(PokerError::NotSeated)?;
    let amount = table.seats[idx].stack;
    table.seats[idx] = Seat::default();
    table.seated = table.seated.checked_sub(1).ok_or(PokerError::MathOverflow)?;
    table.escrow_owed = table.escrow_owed.checked_sub(amount).ok_or(PokerError::MathOverflow)?;
    table.total_paid_out = table.total_paid_out.checked_add(amount).ok_or(PokerError::MathOverflow)?;

    if amount > 0 {
        pay_from_escrow(&ctx.accounts.escrow, &ctx.accounts.player_token, table, &ctx.accounts.token_program, amount)?;
    }
    settle_check(&mut ctx.accounts.escrow, table)?;
    emit!(CashedOut { table: table.key(), player, seat: idx as u8, amount });
    Ok(())
}

#[derive(Accounts)]
pub struct CollectRake<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.version == CONFIG_VERSION @ PokerError::ConfigOutdated)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Account<'info, Table>,
    #[account(mut, address = get_associated_token_address(&table.key(), &table.mint))]
    pub escrow: Account<'info, TokenAccount>,
    #[account(mut, token::mint = table.mint, token::authority = config.dev_wallet)]
    pub dev_token: Account<'info, TokenAccount>,
    /// CHECK: MagicBlock's Magic program only exists inside the rollup; requiring it executable
    /// keeps money moves off L1.
    #[account(address = MAGIC_PROGRAM_ID, constraint = in_rollup.executable @ PokerError::NotInRollup)]
    pub in_rollup: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Permissionless: sends accrued rake to the dev wallet's token account.
pub fn collect_rake(ctx: Context<CollectRake>) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let amount = table.rake_accrued;
    require!(amount > 0, PokerError::NothingToCollect);
    table.rake_accrued = 0;
    table.escrow_owed = table.escrow_owed.checked_sub(amount).ok_or(PokerError::MathOverflow)?;
    table.total_rake_collected = table.total_rake_collected.checked_add(amount).ok_or(PokerError::MathOverflow)?;
    pay_from_escrow(&ctx.accounts.escrow, &ctx.accounts.dev_token, table, &ctx.accounts.token_program, amount)?;
    settle_check(&mut ctx.accounts.escrow, table)?;
    emit!(RakeCollected { table: table.key(), amount, dev_wallet: ctx.accounts.config.dev_wallet });
    Ok(())
}

#[commit]
#[derive(Accounts)]
pub struct CommitTable<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Account<'info, Table>,
}

/// Permissionless: copy the table ledger to L1, so a timeout rollback loses as little as possible.
pub fn commit_table(ctx: Context<CommitTable>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit(&[ctx.accounts.table.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}

#[commit]
#[derive(Accounts)]
pub struct CloseTable<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, has_one = creator @ PokerError::NotCreator, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Account<'info, Table>,
}

/// The normal way out: the creator closes an empty table, which commits it to L1 as closed and
/// hands it back to this program. (The escrow token account stays with MagicBlock's token program;
/// returning any leftover there is M6 work.)
pub fn close_table(ctx: Context<CloseTable>) -> Result<()> {
    let table = &mut ctx.accounts.table;
    require!(table.status == STATUS_OPEN, PokerError::TableNotOpen);
    require!(table.seated == 0 && table.escrow_owed == 0, PokerError::TableNotEmpty);
    table.status = STATUS_CLOSED;
    table.last_activity_ts = Clock::get()?.unix_timestamp;
    table.exit(&crate::ID)?;
    MagicIntentBundleBuilder::new(
        ctx.accounts.creator.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[table.to_account_info()])
    .build_and_invoke()?;
    emit!(TableClosed { table: table.key() });
    Ok(())
}

fn pay_from_escrow<'info>(
    escrow: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    table: &Account<'info, Table>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    let id = table.table_id.to_le_bytes();
    let bump = [table.bump];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer { from: escrow.to_account_info(), to: to.to_account_info(), authority: table.to_account_info() },
            &[&[TABLE_SEED, table.creator.as_ref(), &id, &bump]],
        ),
        amount,
    )
}

/// After any money move: the ledger must add up, and the real escrow balance must cover it.
/// (`>=` rather than `==`, because anyone can send tokens to the escrow address.)
fn settle_check<'info>(escrow: &mut Account<'info, TokenAccount>, table: &mut Account<'info, Table>) -> Result<()> {
    escrow.reload()?;
    require!(table.computed_owed() == Some(table.escrow_owed), PokerError::LedgerMismatch);
    require!(escrow.amount >= table.escrow_owed, PokerError::EscrowShortfall);
    table.escrow_balance = escrow.amount;
    table.last_activity_ts = Clock::get()?.unix_timestamp;
    Ok(())
}

#[event]
pub struct BoughtIn {
    pub table: Pubkey,
    pub player: Pubkey,
    pub seat: u8,
    pub amount: u64,
    pub rake: u64,
    pub stack: u64,
}

#[event]
pub struct CashedOut {
    pub table: Pubkey,
    pub player: Pubkey,
    pub seat: u8,
    pub amount: u64,
}

#[event]
pub struct TableClosed {
    pub table: Pubkey,
}

#[event]
pub struct RakeCollected {
    pub table: Pubkey,
    pub amount: u64,
    pub dev_wallet: Pubkey,
}
