//! Rollup: playing a dealt hand with the Hold'em engine (engine.rs, ported from the game's C#).
//! `begin_hand` posts the blinds, `act` takes the awaited player's action, `timeout` acts for a
//! player whose turn ran out (check if possible, otherwise fold). When the hand ends the stacks
//! are written back to the ledger, and the hand's cards, shuffle inputs and action-log hash go into
//! the public hand record. Bets and stacks stay in the ledger (readable by the seated players) and
//! the action log in its own account (readable by the players dealt into the hand).
//!
//! `tick` is the one "move this table along" call: it times out an awaited player whose 15 s are up
//! and begins a dealt hand, needs no signer, and succeeds when there's nothing to do. The backend's
//! keeper calls it on a schedule; anyone else may too.
//!
//! Clients should give `act`, `timeout` and `tick` a compute budget for a possible showdown (every
//! remaining hand is evaluated then).

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED;
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;

use crate::constants::{CONFIG_SEED, CONFIG_VERSION, MAX_SEATS};
use crate::dealing;
use crate::engine::{Awards, Cards, EngineError, Game, DONE, PREFLOP};
use crate::errors::PokerError;
use crate::instructions::money::*;
use crate::private::Sponsor;
use crate::state::Config;
use crate::table::{
    Deck, HandLog, HandRecord, Ledger, Table, DECK_SEED, HAND_DEALT, HAND_IDLE, HAND_PLAYING, LEDGER_SEED, LOG_BIG_BLIND, STATUS_OPEN,
    LOG_SEED, LOG_SMALL_BLIND, LOG_TIMEOUT, RECORD_SEED, TABLE_SEED, TURN_SECS,
};

/// The table's hand accounts, shared by every instruction that plays a hand.
#[derive(Accounts)]
pub struct HandAccounts<'info> {
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    /// The private deck: hole cards and the board come from it when the engine needs them.
    #[account(mut, seeds = [DECK_SEED, table.key().as_ref()], bump, has_one = table)]
    pub deck: Box<Account<'info, Deck>>,
    #[account(mut, seeds = [RECORD_SEED, table.key().as_ref()], bump, has_one = table)]
    pub record: Box<Account<'info, HandRecord>>,
    #[account(mut, seeds = [LOG_SEED, table.key().as_ref()], bump)]
    pub log: AccountLoader<'info, HandLog>,
}

/// `act` and `timeout`: someone acting.
#[derive(Accounts)]
pub struct Play<'info> {
    pub signer: Signer<'info>,
    pub hand: HandAccounts<'info>,
}

/// `begin_hand` and `tick`: may begin a dealt hand, which sets the hand log's readers.
#[derive(Accounts)]
pub struct BeginHand<'info> {
    pub hand: HandAccounts<'info>,
    /// CHECK: permission PDA of the hand log; its readers become the players dealt in.
    #[account(mut, seeds = [PERMISSION_SEED, hand.log.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub log_permission: UncheckedAccount<'info>,
    pub rollup: RollupPrograms<'info>,
}

/// Anyone may start the betting once the cards are dealt: makes the hand's action log readable by
/// the players dealt in, posts the blinds and starts the first player's turn timer.
pub fn begin_hand(ctx: Context<BeginHand>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let log_bump = ctx.bumps.hand.log;
    require!(ctx.accounts.hand.table.hand_state == HAND_DEALT, PokerError::HandNotDealt);
    begin(ctx.accounts, log_bump, now)
}

/// For the keeper (or anyone): no signer, and nothing to do is not an error. Times out the awaited
/// player once their turn is up (check if possible, otherwise fold), and begins a dealt hand.
pub fn tick(ctx: Context<BeginHand>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let log_bump = ctx.bumps.hand.log;
    let b = &mut *ctx.accounts;
    match b.hand.table.hand_state {
        HAND_DEALT => begin(b, log_bump, now),
        HAND_PLAYING if now > b.hand.table.turn_deadline => {
            let seat = b.hand.ledger.game.to_act;
            let kind = b.hand.ledger.game.timeout_action();
            apply(&mut b.hand, seat, kind, 0, true, now)
        }
        _ => Ok(()),
    }
}

fn begin(b: &mut BeginHand, log_bump: u8, now: i64) -> Result<()> {
    let (table_key, dealt_mask) = (b.hand.table.key(), b.hand.table.dealt_mask);
    let mut stacks = [None; MAX_SEATS as usize];
    let mut readers = Vec::new();
    for seat in dealing::seats_in(dealt_mask) {
        let s = &b.hand.ledger.seats[seat as usize];
        stacks[seat as usize] = Some(s.stack);
        readers.push(s.reader);
    }
    {
        let t = &b.hand.table;
        let (id, bump) = (t.table_id.to_le_bytes(), [t.bump]);
        let ts = table_seeds(t, &id, &bump);
        let (table_info, magic, vault, perm) = (t.to_account_info(), b.rollup.magic_program.to_account_info(), b.rollup.vault.to_account_info(), b.rollup.permission_program.to_account_info());
        let sp = Sponsor { table: &table_info, table_seeds: &ts, vault: &vault, magic_program: &magic, permission_program: &perm };
        let log_bump = [log_bump];
        let log_seeds: &[&[u8]] = &[LOG_SEED, table_key.as_ref(), &log_bump];
        sp.set_readers(&b.hand.log.to_account_info(), log_seeds, &b.log_permission.to_account_info(), &readers)?;
    }

    let a = &mut b.hand;
    let cards = cards_of(&a.deck, a.table.button, dealt_mask);
    let (game, awards) = Game::start(a.table.max_seats, a.table.small_blind, a.table.big_blind, stacks, a.table.button, &cards)
        .map_err(engine_error)?;
    {
        let mut log = a.log.load_mut()?;
        log.reset(&table_key, a.table.hand_no, &a.deck.log_secret);
        log.readers = [Pubkey::default(); MAX_SEATS as usize];
        log.readers[..readers.len()].copy_from_slice(&readers);
        log.readers_len = readers.len() as u8;
        log.push(PREFLOP, game.sb_seat, LOG_SMALL_BLIND, game.seats[game.sb_seat as usize].total);
        log.push(PREFLOP, game.bb_seat, LOG_BIG_BLIND, game.seats[game.bb_seat as usize].total);
    }
    a.ledger.game = game;
    a.table.hand_state = HAND_PLAYING;
    after_move(a, awards, now)
}

/// `open_log`: shows a finished hand's action log to the auditor.
#[derive(Accounts)]
pub struct OpenLog<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.version == CONFIG_VERSION @ PokerError::ConfigOutdated)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [LOG_SEED, table.key().as_ref()], bump)]
    pub log: AccountLoader<'info, HandLog>,
    /// CHECK: permission PDA of the hand log; the auditor is added to its readers.
    #[account(mut, seeds = [PERMISSION_SEED, log.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub log_permission: UncheckedAccount<'info>,
    pub rollup: RollupPrograms<'info>,
}

/// Anyone (the keeper, normally) may add the config's auditor to the readers of the last finished
/// hand's log. Never while a hand is being played: the log then holds the live hand. The hand's
/// players stay readers; the next `begin_hand` replaces them all (the backend archives in between).
pub fn open_log(ctx: Context<OpenLog>) -> Result<()> {
    let a = &ctx.accounts;
    let auditor = a.config.auditor;
    require!(auditor != Pubkey::default(), PokerError::NoAuditor);
    require!(a.table.status == STATUS_OPEN, PokerError::TableNotOpen);
    require!(a.table.hand_state != HAND_PLAYING, PokerError::HandInProgress);
    let mut readers = {
        let log = a.log.load()?;
        // The log must hold the table's last finished hand. After an escape-hatch rollback the
        // table may say idle while the log still holds a hand that never finished.
        require!(log.hand_no > 0 && log.hand_no == a.table.last_record.hand_no, PokerError::NoFinishedHand);
        if log.audited_by == auditor {
            return Ok(()); // already open to this auditor: nothing to pay for again
        }
        log.readers[..log.readers_len as usize].to_vec()
    };
    if !readers.contains(&auditor) {
        readers.push(auditor);
    }
    let t = &a.table;
    let (id, bump) = (t.table_id.to_le_bytes(), [t.bump]);
    let ts = table_seeds(t, &id, &bump);
    let (table_info, magic, vault, perm) = (t.to_account_info(), a.rollup.magic_program.to_account_info(), a.rollup.vault.to_account_info(), a.rollup.permission_program.to_account_info());
    let sp = Sponsor { table: &table_info, table_seeds: &ts, vault: &vault, magic_program: &magic, permission_program: &perm };
    let table_key = t.key();
    let log_bump = [ctx.bumps.log];
    let log_seeds: &[&[u8]] = &[LOG_SEED, table_key.as_ref(), &log_bump];
    sp.set_readers(&a.log.to_account_info(), log_seeds, &a.log_permission.to_account_info(), &readers)?;
    a.log.load_mut()?.audited_by = auditor;
    Ok(())
}

/// The awaited seat's action (engine kinds FOLD..ALL_IN; for BET and RAISE `amount` is the total
/// the seat's bet becomes this street). The seat's wallet may act, or its reader key: the key the
/// player's client already holds for reading the table, so play needs no wallet prompt per action.
pub fn act(ctx: Context<Play>, seat: u8, kind: u8, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let signer = ctx.accounts.signer.key();
    let a = &mut ctx.accounts.hand;
    require!(a.table.hand_state == HAND_PLAYING, PokerError::HandNotPlaying);
    let i = seat as usize;
    require!(i < a.ledger.seats.len() && !a.ledger.seats[i].is_empty() && (a.ledger.seats[i].player == signer || a.ledger.seats[i].reader == signer), PokerError::NotSeated);
    apply(a, seat, kind, amount, false, now)
}

/// Anyone may act for the awaited player once their time is up: check if they can, otherwise fold.
pub fn timeout(ctx: Context<Play>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut ctx.accounts.hand;
    require!(a.table.hand_state == HAND_PLAYING, PokerError::HandNotPlaying);
    require!(now > a.table.turn_deadline, PokerError::TurnNotOver);
    let seat = a.ledger.game.to_act;
    let kind = a.ledger.game.timeout_action();
    apply(a, seat, kind, 0, true, now)
}

fn apply(a: &mut HandAccounts, seat: u8, kind: u8, amount: u64, timed_out: bool, now: i64) -> Result<()> {
    let cards = cards_of(&a.deck, a.table.button, a.table.dealt_mask);
    let mut game = a.ledger.game;
    let street = game.street;
    let awards = game.act(seat, kind, amount, &cards).map_err(engine_error)?;
    let flag = if timed_out { LOG_TIMEOUT } else { 0 };
    a.log.load_mut()?.push(street, seat, kind | flag, game.seats[seat as usize].total);
    a.ledger.game = game;
    after_move(a, awards, now)
}

/// After the engine moved: either the next turn starts, or the hand is over and gets settled.
fn after_move(a: &mut HandAccounts, _awards: Awards, now: i64) -> Result<()> {
    if a.ledger.game.street != DONE {
        // M11: at a tournament table a seat that sent no seed this hand is absent: short turns, so it's
        // blinded away without holding everyone up.
        let to_act = a.ledger.game.to_act;
        let absent = a.table.kind == crate::tourney::KIND_TOURNEY && (to_act as usize) < 16 && a.deck.seed_mask & (1u16 << to_act) == 0;
        a.table.turn_deadline = now.saturating_add(if absent { crate::tourney::ABSENT_TURN_SECS } else { TURN_SECS });
        return stamp(&mut a.table, &a.ledger, now);
    }
    finish_hand(a, now)
}

/// The hand is over: stacks go back to the ledger (chips must be conserved exactly), the public
/// record gets the hand's cards and log hash, and the table is ready for the next hand.
fn finish_hand(a: &mut HandAccounts, now: i64) -> Result<()> {
    let table = &mut a.table;
    let ledger = &mut a.ledger;
    let (mut before, mut after) = (0u64, 0u64);
    for seat in dealing::seats_in(table.dealt_mask) {
        let i = seat as usize;
        before = before.checked_add(ledger.seats[i].stack).ok_or(PokerError::MathOverflow)?;
        after = after.checked_add(ledger.game.seats[i].stack).ok_or(PokerError::MathOverflow)?;
        ledger.seats[i].stack = ledger.game.seats[i].stack;
    }
    require!(before == after && ledger.computed_owed() == Some(ledger.escrow_owed), PokerError::LedgerMismatch);

    let (log_hash, log_len) = {
        let log = a.log.load()?;
        (log.hash, log.len)
    };
    let deck = &mut a.deck;
    let record = &mut a.record;
    record.hand_no = table.hand_no;
    record.button = table.button;
    record.dealt_mask = table.dealt_mask;
    record.seed_mask = deck.seed_mask;
    record.seeds = deck.seeds;
    record.entropy = deck.entropy;
    record.shuffle_seed = deck.shuffle_seed;
    record.cards = deck.cards;
    record.board_len = ledger.game.board_len;
    record.log_hash = log_hash;
    record.log_len = log_len;
    let published: &HandRecord = record;
    table.last_record = published.clone();
    deck.seed_mask = 0;
    deck.seeds = Default::default();
    deck.seed_owners = Default::default();
    deck.entropy = [0; 32];
    deck.shuffle_seed = [0; 32];
    deck.cards = [dealing::NO_CARD; 52];
    table.hand_state = HAND_IDLE;
    table.idle_since = now;
    table.turn_deadline = 0;
    if table.kind == crate::tourney::KIND_TOURNEY {
        table.needs_sync = 1;
    }
    emit!(HandEnded { table: table.key(), hand_no: table.hand_no });
    // No commit here: settlement must never depend on a commit succeeding. The table is committed
    // by `commit_table` (rate-limited, table-paid), which clients or a keeper call.
    stamp(table, ledger, now)
}

/// Hole cards and board of the current hand, from the private deck (M4's dealing order).
fn cards_of(deck: &Deck, button: u8, dealt_mask: u16) -> Cards {
    let order = dealing::deal_order(button, dealt_mask);
    Cards { holes: dealing::hole_cards(&deck.cards, &order), board: dealing::board(&deck.cards, order.len()) }
}

fn stamp(table: &mut Account<Table>, ledger: &Account<Ledger>, now: i64) -> Result<()> {
    table.ledger_hash = ledger.fingerprint()?;
    table.ledger_seq = table.ledger_seq.checked_add(1).ok_or(PokerError::MathOverflow)?;
    table.last_activity_ts = now;
    Ok(())
}

fn engine_error(e: EngineError) -> Error {
    match e {
        EngineError::NotYourTurn => PokerError::NotYourTurn.into(),
        EngineError::Illegal => PokerError::IllegalAction.into(),
        EngineError::HandOver => PokerError::HandNotPlaying.into(),
        EngineError::NeedTwoPlayers => PokerError::NotEnoughPlayers.into(),
    }
}

#[event]
pub struct HandEnded {
    pub table: Pubkey,
    pub hand_no: u64,
}
