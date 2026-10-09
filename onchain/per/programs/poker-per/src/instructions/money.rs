//! Inside the TEE rollup: opening a table's private accounts, buy-in (and rebuy), cash-out, rake
//! collection, committing the public table to L1, and closing. Tokens move between ordinary SPL
//! token accounts that MagicBlock's Ephemeral SPL Token program projects into the rollup.
//!
//! Privacy (M3): seats, stacks and money live in the rollup-only `Ledger`, readable only by seated
//! players. Each seat's `Hand` is readable only by its owner; the `Deck` by nobody. The public
//! `Table` (committed to L1) carries settings, a seat-occupancy mask, the ledger's hash and the
//! last finished hand's public record (M6).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::constants::{CONFIG_SEED, CONFIG_VERSION, TEE_VALIDATOR};
use crate::instructions::table::DELEGATION_PROGRAM_ID;

pub(crate) const MAGIC_FEE_VAULT_SEED: &[u8] = b"magic-fee-vault";
use crate::errors::PokerError;
use crate::private::{write, Sponsor};
use crate::state::Config;
use crate::dealing::NO_CARD;
use crate::table::{
    rake_for, Deck, Hand, HandLog, HandRecord, Invites, Ledger, Seat, Table, DECK_SEED, HAND_IDLE, HAND_SEED, INVITES_SEED,
    COMMIT_EVERY_SECS, LEDGER_SEED, LOG_SEED, RECORD_SEED, STATUS_CLOSED, STATUS_OPEN, TABLE_SEED,
};

/// MagicBlock programs every private-account operation needs.
#[derive(Accounts)]
pub struct RollupPrograms<'info> {
    /// CHECK: MagicBlock's Magic program only exists inside the rollup; requiring it executable
    /// keeps these instructions off L1.
    #[account(address = MAGIC_PROGRAM_ID, constraint = magic_program.executable @ PokerError::NotInRollup)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: MagicBlock's rent vault for rollup-only accounts.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: MagicBlock's permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
}

/// Signer seeds of a table PDA. The caller keeps `id` and `bump` alive for as long as the seeds.
pub(crate) fn table_seeds<'a>(table: &'a Table, id: &'a [u8; 8], bump: &'a [u8; 1]) -> [&'a [u8]; 4] {
    [TABLE_SEED, table.creator.as_ref(), &id[..], &bump[..]]
}

// ---------------------------------------------------------------------------------------- open

#[derive(Accounts)]
pub struct OpenTable<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    /// CHECK: rollup-only ledger PDA, created here.
    #[account(mut, seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the ledger.
    #[account(mut, seeds = [PERMISSION_SEED, ledger.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub ledger_permission: UncheckedAccount<'info>,
    /// CHECK: rollup-only deck PDA, created here.
    #[account(mut, seeds = [DECK_SEED, table.key().as_ref()], bump)]
    pub deck: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the deck.
    #[account(mut, seeds = [PERMISSION_SEED, deck.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub deck_permission: UncheckedAccount<'info>,
    /// CHECK: rollup-only public hand record PDA, created here (no permission: anyone may read it).
    #[account(mut, seeds = [RECORD_SEED, table.key().as_ref()], bump)]
    pub record: UncheckedAccount<'info>,
    /// CHECK: rollup-only hand log PDA, created here (readers: set per hand by begin_hand).
    #[account(mut, seeds = [LOG_SEED, table.key().as_ref()], bump)]
    pub log: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the hand log.
    #[account(mut, seeds = [PERMISSION_SEED, log.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub log_permission: UncheckedAccount<'info>,
    pub rollup: RollupPrograms<'info>,
}

/// Permissionless and idempotent: creates the table's private ledger (readers: none yet), its
/// deck (readers: nobody, ever) and its public hand record. Runs once after delegation, before
/// anyone can buy in.
pub fn open_table(ctx: Context<OpenTable>) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.table.status == STATUS_OPEN, PokerError::TableNotOpen);
    let (id, bump) = (a.table.table_id.to_le_bytes(), [a.table.bump]);
    let ts = table_seeds(&a.table, &id, &bump);
    let (table_info, magic, vault, perm) = (a.table.to_account_info(), a.rollup.magic_program.to_account_info(), a.rollup.vault.to_account_info(), a.rollup.permission_program.to_account_info());
    let sp = Sponsor { table: &table_info, table_seeds: &ts, vault: &vault, magic_program: &magic, permission_program: &perm };
    let table_key = a.table.key();

    let ledger_bump = [ctx.bumps.ledger];
    let ledger_seeds: &[&[u8]] = &[LEDGER_SEED, table_key.as_ref(), &ledger_bump];
    let ledger_info = a.ledger.to_account_info();
    let first_open = ledger_info.data_is_empty();
    if first_open {
        sp.create_account(&ledger_info, ledger_seeds, 8 + Ledger::INIT_SPACE)?;
        // A new ledger is all zeros except its discriminator and table (building the ~3 KB value
        // on the stack would overflow it), and a fresh rollup-only account is already zeroed.
        let mut data = ledger_info.try_borrow_mut_data()?;
        data[..8].copy_from_slice(Ledger::DISCRIMINATOR);
        data[8..40].copy_from_slice(table_key.as_ref());
    }
    sp.create_permission(&ledger_info, ledger_seeds, &a.ledger_permission.to_account_info(), &[])?;

    let deck_bump = [ctx.bumps.deck];
    let deck_seeds: &[&[u8]] = &[DECK_SEED, table_key.as_ref(), &deck_bump];
    let deck_info = a.deck.to_account_info();
    if deck_info.data_is_empty() {
        sp.create_account(&deck_info, deck_seeds, 8 + Deck::INIT_SPACE)?;
        write(&deck_info, &Deck {
            table: table_key, hand_no: 0, seed_mask: 0, seeds: Default::default(), seed_owners: Default::default(), entropy: [0; 32], shuffle_seed: [0; 32],
            cards: [NO_CARD; 52], log_secret: [0; 32],
        })?;
    }
    sp.create_permission(&deck_info, deck_seeds, &a.deck_permission.to_account_info(), &[])?;

    let record_bump = [ctx.bumps.record];
    let record_seeds: &[&[u8]] = &[RECORD_SEED, table_key.as_ref(), &record_bump];
    let record_info = a.record.to_account_info();
    if record_info.data_is_empty() {
        sp.create_account(&record_info, record_seeds, 8 + HandRecord::INIT_SPACE)?;
        write(&record_info, &HandRecord {
            table: table_key, hand_no: 0, button: 0, dealt_mask: 0, seed_mask: 0, seeds: Default::default(),
            entropy: [0; 32], shuffle_seed: [0; 32], cards: [NO_CARD; 52], board_len: 0, log_hash: [0; 32], log_len: 0,
        })?;
    }

    let log_bump = [ctx.bumps.log];
    let log_seeds: &[&[u8]] = &[LOG_SEED, table_key.as_ref(), &log_bump];
    let log_info = a.log.to_account_info();
    if log_info.data_is_empty() {
        sp.create_account(&log_info, log_seeds, 8 + std::mem::size_of::<HandLog>())?;
        let mut data = log_info.try_borrow_mut_data()?;
        data[..8].copy_from_slice(HandLog::DISCRIMINATOR);
        data[8..40].copy_from_slice(table_key.as_ref());
    }
    sp.create_permission(&log_info, log_seeds, &a.log_permission.to_account_info(), &[])?;

    let fp = {
        let data = ledger_info.try_borrow_data()?;
        Ledger::try_deserialize(&mut &data[..])?.fingerprint()?
    };
    ctx.accounts.table.ledger_hash = fp;
    // The seed window counts from the first open only: calling open_table again (it's idempotent and
    // permissionless) must not restart it.
    if first_open {
        ctx.accounts.table.idle_since = Clock::get()?.unix_timestamp;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------- buy-in

#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct BuyIn<'info> {
    pub player: Signer<'info>,
    /// Read-only copy of the L1 config inside the rollup.
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.version == CONFIG_VERSION @ PokerError::ConfigOutdated)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    /// CHECK: permission PDA of the ledger.
    #[account(mut, seeds = [PERMISSION_SEED, ledger.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub ledger_permission: UncheckedAccount<'info>,
    /// CHECK: this seat's rollup-only hand PDA; created when the player first sits.
    #[account(mut, seeds = [HAND_SEED, table.key().as_ref(), &[seat]], bump)]
    pub hand: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the hand.
    #[account(mut, seeds = [PERMISSION_SEED, hand.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub hand_permission: UncheckedAccount<'info>,
    /// Read-only copy of the L1 invite list; required only for invite-only tables.
    #[account(seeds = [INVITES_SEED, table.key().as_ref()], bump)]
    pub invites: Option<Box<Account<'info, Invites>>>,
    #[account(mut, token::mint = table.mint, token::authority = player)]
    pub player_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = get_associated_token_address(&table.key(), &table.mint))]
    pub escrow: Box<Account<'info, TokenAccount>>,
    pub rollup: RollupPrograms<'info>,
    pub token_program: Program<'info, Token>,
}

/// Buy-in shared by `buy_in` (the wallet signs and pays) and `vault_buy_in` (a play key signs and the
/// wallet's game vault pays): everything but who pays. `$transfer` moves `amount` into the escrow.
macro_rules! buy_in_flow {
    ($ctx:ident, $seat:expr, $amount:expr, $reader:expr, $player:expr, $transfer:expr) => {{
    let (seat, amount, reader): (u8, u64, Pubkey) = ($seat, $amount, $reader);
    let config = &$ctx.accounts.config;
    require!(!config.paused, PokerError::Paused);
    let table = &$ctx.accounts.table;
    require!(table.status == STATUS_OPEN, PokerError::TableNotOpen);
    require!(amount > 0, PokerError::BuyInTooSmall);
    require!(seat < table.max_seats, PokerError::InvalidSeat);
    let player: Pubkey = $player;
    let idx = seat as usize;

    let rake = rake_for(amount, table.rake_bps)?;
    let chips = amount.checked_sub(rake).ok_or(PokerError::MathOverflow)?;
    let cap = table.max_buy_in.min(config.max_buy_in);
    let (min_buy_in, big_blind, invite_only, taken) = (table.min_buy_in, table.big_blind, table.invite_only, table.seat_taken(idx));
    let table_key = table.key();

    let (hand_idle, dealt_mask) = (table.hand_state == HAND_IDLE, table.dealt_mask);
    let auditor = $ctx.accounts.config.auditor;
    let ledger = &mut $ctx.accounts.ledger;
    let sitting_down = match ledger.seat_of(&player) {
        Some(i) => {
            require!(i == idx, PokerError::InvalidSeat);
            require!(amount >= big_blind, PokerError::RebuyTooSmall);
            // A seat dealt into the running hand has its live stack in the engine; its rebuy waits
            // until the hand ends. Seats not dealt in may rebuy any time.
            require!(hand_idle || dealt_mask & (1 << idx) == 0, PokerError::HandInProgress);
            false
        }
        None => {
            require!(!taken && ledger.seats[idx].is_empty(), PokerError::SeatTaken);
            require!(amount >= min_buy_in, PokerError::BuyInTooSmall);
            if invite_only {
                let inv = $ctx.accounts.invites.as_ref().ok_or(PokerError::NotInvited)?;
                require!(inv.contains(&table_key, &player), PokerError::NotInvited);
            }
            require!(reader != Pubkey::default() && reader != player && reader != auditor, PokerError::InvalidReader);
            // A reader key belongs to one seat: never another seat's reader or anyone seated's wallet.
            require!(!ledger.seats.iter().any(|s| !s.is_empty() && (s.reader == reader || s.player == reader)), PokerError::InvalidReader);
            ledger.seats[idx] = Seat { player, reader, stack: 0, deposited: 0, sitting_out: false };
            true
        }
    };
    let s = &mut ledger.seats[idx];
    s.stack = s.stack.checked_add(chips).ok_or(PokerError::MathOverflow)?;
    s.deposited = s.deposited.checked_add(amount).ok_or(PokerError::MathOverflow)?;
    require!(s.stack <= cap, PokerError::BuyInTooLarge);
    let stack = s.stack;
    ledger.rake_accrued = ledger.rake_accrued.checked_add(rake).ok_or(PokerError::MathOverflow)?;
    ledger.escrow_owed = ledger.escrow_owed.checked_add(amount).ok_or(PokerError::MathOverflow)?;
    ledger.total_deposited = ledger.total_deposited.checked_add(amount).ok_or(PokerError::MathOverflow)?;

    $transfer;

    if sitting_down {
        let a = &$ctx.accounts;
        let (id, bump) = (a.table.table_id.to_le_bytes(), [a.table.bump]);
        let ts = table_seeds(&a.table, &id, &bump);
        let (table_info, magic, vault, perm) = (a.table.to_account_info(), a.rollup.magic_program.to_account_info(), a.rollup.vault.to_account_info(), a.rollup.permission_program.to_account_info());
        let sp = Sponsor { table: &table_info, table_seeds: &ts, vault: &vault, magic_program: &magic, permission_program: &perm };
        let ledger_bump = [$ctx.bumps.ledger];
        let ledger_seeds: &[&[u8]] = &[LEDGER_SEED, table_key.as_ref(), &ledger_bump];
        sp.set_readers(&a.ledger.to_account_info(), ledger_seeds, &a.ledger_permission.to_account_info(), &a.ledger.readers())?;

        let seat_byte = [seat];
        let hand_bump = [$ctx.bumps.hand];
        let hand_seeds: &[&[u8]] = &[HAND_SEED, table_key.as_ref(), &seat_byte, &hand_bump];
        let hand_info = a.hand.to_account_info();
        if hand_info.data_is_empty() {
            sp.create_account(&hand_info, hand_seeds, 8 + Hand::INIT_SPACE)?;
        }
        write(&hand_info, &Hand { table: table_key, seat, owner: player, hand_no: 0, cards: [u8::MAX; 2], reader })?;
        if !a.hand_permission.data_is_empty() {
            sp.set_readers(&hand_info, hand_seeds, &a.hand_permission.to_account_info(), &[reader])?;
        } else {
            sp.create_permission(&hand_info, hand_seeds, &a.hand_permission.to_account_info(), &[reader])?;
        }
    }

    let fp = settle_check(&mut $ctx.accounts.escrow, &mut $ctx.accounts.ledger)?;
    let table = &mut $ctx.accounts.table;
    if sitting_down {
        table.seat_mask |= 1 << idx;
    }
    stamp(table, fp)?;
    emit!(BoughtIn { table: table_key, seat, amount, rake, stack });
    Ok(())
    }};
}
pub(crate) use buy_in_flow;

/// Sit down in `seat` with `amount`, or add `amount` to your existing seat (rebuy). Rake is taken on
/// every buy-in. Sitting down adds `reader` (a key from your client, not your wallet) to the
/// ledger's readers and creates your private hand, readable by `reader` only. A rebuy keeps the
/// reader chosen at sit-down and ignores `reader`.
pub fn buy_in(ctx: Context<BuyIn>, seat: u8, amount: u64, reader: Pubkey) -> Result<()> {
    let player = ctx.accounts.player.key();
    buy_in_flow!(ctx, seat, amount, reader, player, token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer { from: ctx.accounts.player_token.to_account_info(), to: ctx.accounts.escrow.to_account_info(), authority: ctx.accounts.player.to_account_info() },
        ),
        amount,
    )?)
}


// ---------------------------------------------------------------------------------------- cash-out

#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct CashOut<'info> {
    pub player: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    /// CHECK: permission PDA of the ledger.
    #[account(mut, seeds = [PERMISSION_SEED, ledger.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub ledger_permission: UncheckedAccount<'info>,
    /// CHECK: this seat's hand PDA; closed here.
    #[account(mut, seeds = [HAND_SEED, table.key().as_ref(), &[seat]], bump)]
    pub hand: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the hand; closed here.
    #[account(mut, seeds = [PERMISSION_SEED, hand.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub hand_permission: UncheckedAccount<'info>,
    #[account(mut, token::mint = table.mint, token::authority = player)]
    pub player_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = get_associated_token_address(&table.key(), &table.mint))]
    pub escrow: Box<Account<'info, TokenAccount>>,
    pub rollup: RollupPrograms<'info>,
    pub token_program: Program<'info, Token>,
}

/// Cash-out shared by `cash_out` (the wallet signs; paid to the wallet) and `vault_cash_out` (the seat's
/// table key or the wallet's play key signs; paid to the wallet's game vault). `$authorize` gets the
/// seat's wallet and reader and errors if the signer may not cash that seat out; `$to` names the
/// account that receives the stack.
macro_rules! cash_out_flow {
    ($ctx:ident, $seat:expr, $authorize:expr, $to:ident) => {{
    let seat: u8 = $seat;
    require!($ctx.accounts.table.hand_state == HAND_IDLE, PokerError::HandInProgress);
    let idx = seat as usize;
    require!(idx < $ctx.accounts.ledger.seats.len(), PokerError::InvalidSeat);
    let ledger = &mut $ctx.accounts.ledger;
    require!(!ledger.seats[idx].is_empty(), PokerError::NotSeated);
    let (seat_player, seat_reader): (Pubkey, Pubkey) = (ledger.seats[idx].player, ledger.seats[idx].reader);
    ($authorize)(seat_player, seat_reader)?;
    let amount = ledger.seats[idx].stack;
    ledger.seats[idx] = Seat::default();
    ledger.escrow_owed = ledger.escrow_owed.checked_sub(amount).ok_or(PokerError::MathOverflow)?;
    ledger.total_paid_out = ledger.total_paid_out.checked_add(amount).ok_or(PokerError::MathOverflow)?;

    if amount > 0 {
        pay_from_escrow(&$ctx.accounts.escrow, &$ctx.accounts.$to, &$ctx.accounts.table, &$ctx.accounts.token_program, amount)?;
    }

    {
        let a = &$ctx.accounts;
        let (id, bump) = (a.table.table_id.to_le_bytes(), [a.table.bump]);
        let ts = table_seeds(&a.table, &id, &bump);
        let (table_info, magic, vault, perm) = (a.table.to_account_info(), a.rollup.magic_program.to_account_info(), a.rollup.vault.to_account_info(), a.rollup.permission_program.to_account_info());
        let sp = Sponsor { table: &table_info, table_seeds: &ts, vault: &vault, magic_program: &magic, permission_program: &perm };
        let table_key = a.table.key();
        let ledger_bump = [$ctx.bumps.ledger];
        let ledger_seeds: &[&[u8]] = &[LEDGER_SEED, table_key.as_ref(), &ledger_bump];
        sp.set_readers(&a.ledger.to_account_info(), ledger_seeds, &a.ledger_permission.to_account_info(), &a.ledger.readers())?;
        let seat_byte = [seat];
        let hand_bump = [$ctx.bumps.hand];
        let hand_seeds: &[&[u8]] = &[HAND_SEED, table_key.as_ref(), &seat_byte, &hand_bump];
        let hand_info = a.hand.to_account_info();
        if !a.hand_permission.data_is_empty() {
            sp.close_permission(&hand_info, hand_seeds, &a.hand_permission.to_account_info())?;
        }
        if !hand_info.data_is_empty() {
            sp.close_account(&hand_info)?;
        }
    }

    let fp = settle_check(&mut $ctx.accounts.escrow, &mut $ctx.accounts.ledger)?;
    let table = &mut $ctx.accounts.table;
    table.seat_mask &= !(1u16 << idx);
    stamp(table, fp)?;
    emit!(CashedOut { table: table.key(), seat, amount });
    Ok(())
    }};
}
pub(crate) use cash_out_flow;

/// Leave with the whole stack. Works while paused, but not while a hand is running. Removes you from
/// the ledger's readers and closes your hand.
pub fn cash_out(ctx: Context<CashOut>, seat: u8) -> Result<()> {
    let player = ctx.accounts.player.key();
    cash_out_flow!(ctx, seat, |p: Pubkey, _reader: Pubkey| -> Result<()> { require!(p == player, PokerError::NotSeated); Ok(()) }, player_token)
}


// ---------------------------------------------------------------------------------------- rake

#[derive(Accounts)]
pub struct CollectRake<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.version == CONFIG_VERSION @ PokerError::ConfigOutdated)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(mut, address = get_associated_token_address(&table.key(), &table.mint))]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = table.mint, token::authority = config.dev_wallet)]
    pub dev_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: Magic program, executable only inside the rollup.
    #[account(address = MAGIC_PROGRAM_ID, constraint = magic_program.executable @ PokerError::NotInRollup)]
    pub magic_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Permissionless: sends accrued rake to the dev wallet's token account.
pub fn collect_rake(ctx: Context<CollectRake>) -> Result<()> {
    let ledger = &mut ctx.accounts.ledger;
    let amount = ledger.rake_accrued;
    require!(amount > 0, PokerError::NothingToCollect);
    ledger.rake_accrued = 0;
    ledger.escrow_owed = ledger.escrow_owed.checked_sub(amount).ok_or(PokerError::MathOverflow)?;
    ledger.total_rake_collected = ledger.total_rake_collected.checked_add(amount).ok_or(PokerError::MathOverflow)?;
    pay_from_escrow(&ctx.accounts.escrow, &ctx.accounts.dev_token, &ctx.accounts.table, &ctx.accounts.token_program, amount)?;
    let fp = settle_check(&mut ctx.accounts.escrow, &mut ctx.accounts.ledger)?;
    stamp(&mut ctx.accounts.table, fp)?;
    emit!(RakeCollected { table: ctx.accounts.table.key(), amount, dev_wallet: ctx.accounts.config.dev_wallet });
    Ok(())
}

// ---------------------------------------------------------------------------------------- commit / close

#[commit]
#[derive(Accounts)]
pub struct CommitTable<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    /// CHECK: the TEE validator's magic fee vault (delegation program PDA), which collects commit
    /// fees from a delegated fee payer.
    #[account(mut, seeds = [MAGIC_FEE_VAULT_SEED, TEE_VALIDATOR.as_ref()], bump, seeds::program = DELEGATION_PROGRAM_ID)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

/// Copy the public table (settings, occupancy, ledger hash) to L1. The ledger itself is
/// rollup-only and never committed. The table pays the commit fee itself, as a delegated fee payer
/// (MagicBlock allows only 10 commits for an account with none). Because the table pays, anyone but
/// the creator may commit at most once per `COMMIT_EVERY_SECS`; that keeps the L1 copy fresh for
/// the escape hatch (the backend's keeper calls it) without letting strangers run up its fees.
pub fn commit_table(ctx: Context<CommitTable>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    {
        let t = &mut ctx.accounts.table;
        require!(ctx.accounts.payer.key() == t.creator || now.saturating_sub(t.last_commit_ts) >= COMMIT_EVERY_SECS, PokerError::CommitTooSoon);
        t.last_commit_ts = now;
        t.exit(&crate::ID)?;
    }
    let t = &ctx.accounts.table;
    let (id, bump) = (t.table_id.to_le_bytes(), [t.bump]);
    let ts = table_seeds(t, &id, &bump);
    MagicIntentBundleBuilder::new(
        ctx.accounts.table.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
    .commit(&[ctx.accounts.table.to_account_info()])
    .build_and_invoke_signed(&[&ts])?;
    Ok(())
}

#[commit]
#[derive(Accounts)]
pub struct CloseTable<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, has_one = creator @ PokerError::NotCreator, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    /// CHECK: permission PDA of the ledger; its readers are removed here.
    #[account(mut, seeds = [PERMISSION_SEED, ledger.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub ledger_permission: UncheckedAccount<'info>,
    /// CHECK: deck PDA; kept, its contents erased (see `close_table`).
    #[account(mut, seeds = [DECK_SEED, table.key().as_ref()], bump)]
    pub deck: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&table.key(), &table.mint))]
    pub escrow: Box<Account<'info, TokenAccount>>,
    /// The creator's token account (delegated to the rollup). Receives whatever is left in the
    /// escrow, which with every seat empty and the rake collected can only be tokens sent to it
    /// directly. Optional: without it the leftover stays in the escrow, so nobody can block a close
    /// by sending dust.
    #[account(mut, token::mint = table.mint, token::authority = creator)]
    pub creator_token: Option<Box<Account<'info, TokenAccount>>>,
    /// CHECK: public hand record PDA; closed here.
    #[account(mut, seeds = [RECORD_SEED, table.key().as_ref()], bump)]
    pub record: UncheckedAccount<'info>,
    /// CHECK: hand log PDA; kept (see `close_table`).
    #[account(mut, seeds = [LOG_SEED, table.key().as_ref()], bump)]
    pub log: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the hand log; its readers are removed here.
    #[account(mut, seeds = [PERMISSION_SEED, log.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub log_permission: UncheckedAccount<'info>,
    /// CHECK: MagicBlock's rent vault for rollup-only accounts.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: MagicBlock's permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// The normal way out: the creator closes an empty table. Anything left in the escrow goes to the
/// creator. Its private accounts stay, private and readable by nobody (so its transaction history
/// stays private), its public record is deleted, then it's committed to L1 as closed and handed
/// back to this program, where `reclaim_table` returns its rent.
pub fn close_table(ctx: Context<CloseTable>) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.table.status == STATUS_OPEN, PokerError::TableNotOpen);
    require!(a.table.seat_mask == 0 && a.ledger.escrow_owed == 0, PokerError::TableNotEmpty);
    let leftover = a.escrow.amount;
    if let (true, Some(to)) = (leftover > 0, a.creator_token.as_ref()) {
        pay_from_escrow(&a.escrow, to, &a.table, &a.token_program, leftover)?;
    }
    {
        let (id, bump) = (a.table.table_id.to_le_bytes(), [a.table.bump]);
        let ts = table_seeds(&a.table, &id, &bump);
        let (table_info, magic, vault, perm) = (a.table.to_account_info(), a.magic_program.to_account_info(), a.vault.to_account_info(), a.permission_program.to_account_info());
        let sp = Sponsor { table: &table_info, table_seeds: &ts, vault: &vault, magic_program: &magic, permission_program: &perm };
        let table_key = a.table.key();
        let ledger_bump = [ctx.bumps.ledger];
        let ledger_seeds: &[&[u8]] = &[LEDGER_SEED, table_key.as_ref(), &ledger_bump];
        // The ledger, deck and log are kept, private, with no readers at all: while an account's
        // permission exists the TEE withholds the contents of every transaction that touched it, so
        // the table's bets, seeds and VRF outputs stay hidden after close. Deleting them (as before
        // M6) made that history public. Their contents are erased below: only the permission is
        // needed, and MagicBlock's simulateTransaction leak can still read private accounts.
        let ledger_info = a.ledger.to_account_info();
        sp.set_readers(&ledger_info, ledger_seeds, &a.ledger_permission.to_account_info(), &[])?;
        // The deck never had readers.
        let log_bump = [ctx.bumps.log];
        let log_seeds: &[&[u8]] = &[LOG_SEED, table_key.as_ref(), &log_bump];
        if !a.log_permission.data_is_empty() {
            sp.set_readers(&a.log.to_account_info(), log_seeds, &a.log_permission.to_account_info(), &[])?;
        }
        // The public hand record can go.
        let record_info = a.record.to_account_info();
        if !record_info.data_is_empty() {
            sp.close_account(&record_info)?;
        }
    }
    // Erase what the kept accounts hold: the deck (last seeds, their committers' wallets, cards,
    // log secret), the hand log (last hand's actions, readers, secret) and the ledger's game,
    // salt and seats. Only each account's discriminator stays.
    for info in [ctx.accounts.deck.to_account_info(), ctx.accounts.log.to_account_info()] {
        let mut data = info.try_borrow_mut_data()?;
        if data.len() > 8 {
            data[8..].fill(0);
        }
    }
    {
        let ledger = &mut ctx.accounts.ledger;
        ledger.game = Default::default();
        ledger.salt = [0; 32];
        ledger.seats = Default::default();
    }
    let table = &mut ctx.accounts.table;
    table.status = STATUS_CLOSED;
    table.last_activity_ts = Clock::get()?.unix_timestamp;
    table.exit(&crate::ID)?;
    MagicIntentBundleBuilder::new(
        ctx.accounts.creator.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.table.to_account_info()])
    .build_and_invoke()?;
    emit!(TableClosed { table: ctx.accounts.table.key() });
    Ok(())
}

// ---------------------------------------------------------------------------------------- helpers

pub(crate) fn pay_from_escrow<'info>(
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

/// After any money move: the ledger must add up, and the real escrow balance must cover it
/// (`>=`, because anyone can send tokens to the escrow address). Returns the new fingerprint.
pub(crate) fn settle_check<'info>(escrow: &mut Box<Account<'info, TokenAccount>>, ledger: &mut Box<Account<'info, Ledger>>) -> Result<[u8; 32]> {
    escrow.reload()?;
    require!(ledger.computed_owed() == Some(ledger.escrow_owed), PokerError::LedgerMismatch);
    require!(escrow.amount >= ledger.escrow_owed, PokerError::EscrowShortfall);
    ledger.escrow_balance = escrow.amount;
    ledger.fingerprint()
}

/// Records the new ledger fingerprint and activity time on the public table.
pub(crate) fn stamp(table: &mut Box<Account<Table>>, fingerprint: [u8; 32]) -> Result<()> {
    table.ledger_hash = fingerprint;
    table.ledger_seq = table.ledger_seq.checked_add(1).ok_or(PokerError::MathOverflow)?;
    table.last_activity_ts = Clock::get()?.unix_timestamp;
    Ok(())
}

// Event data lands in transaction logs, which the TEE shows only to readers holding the logs flag
// (seated players). No wallets are included.
#[event]
pub struct BoughtIn {
    pub table: Pubkey,
    pub seat: u8,
    pub amount: u64,
    pub rake: u64,
    pub stack: u64,
}

#[event]
pub struct CashedOut {
    pub table: Pubkey,
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
