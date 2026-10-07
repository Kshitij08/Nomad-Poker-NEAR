//! Rollup: a hand's randomness. Every seated player commits a hidden seed, anyone starts the hand
//! (a VRF request), the VRF callback shuffles and deals into each player's private hand, and the
//! hand's shuffle inputs and deck are published in the table's public `HandRecord` when it ends.
//!
//! Why every seat must commit: the VRF oracle's fulfillment transaction carries the VRF output,
//! and the platform's transaction visibility can't be fully relied on (M3). With a seed from every
//! dealt player, nobody short of all players together plus the oracle can compute the deck.
//!
//! M4 has no betting yet: `end_hand` stands in for M5's showdown, so a seated player (or the
//! creator) ends the hand by hand. M5 replaces that with the engine, and adds timeouts for players
//! who don't commit a seed.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{vrf, vrf_callback};
use ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE;
use ephemeral_rollups_sdk::vrf::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;
use solana_sha256_hasher::hashv;

use crate::constants::{CONFIG_SEED, CONFIG_VERSION};
use crate::deal::{self, NO_CARD};
use crate::errors::PokerError;
use crate::private::write;
use crate::state::Config;
use crate::table::{
    Deck, Hand, HandRecord, Ledger, Table, DECK_SEED, HAND_DEALT, HAND_IDLE, HAND_SEED, HAND_SHUFFLING, LEDGER_SEED,
    RECORD_SEED, STATUS_OPEN, TABLE_SEED, VRF_ABORT_SECS, VRF_RETRY_SECS,
};

// ---------------------------------------------------------------------------------------- seeds

#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct CommitSeed<'info> {
    pub player: Signer<'info>,
    #[account(seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [DECK_SEED, table.key().as_ref()], bump, has_one = table)]
    pub deck: Box<Account<'info, Deck>>,
    /// The seat's private hand: proves the signer sits there without touching the ledger, so the
    /// transaction (and the seed in it) concerns no other player's readable accounts.
    #[account(seeds = [HAND_SEED, table.key().as_ref(), &[seat]], bump, constraint = hand.owner == player.key() @ PokerError::NotSeated)]
    pub hand: Box<Account<'info, Hand>>,
}

/// A seated player's hidden seed for the next hand, kept in the private deck. Allowed only while
/// no hand is running, so it's fixed before the VRF output exists. Committing again replaces it.
pub fn commit_seed(ctx: Context<CommitSeed>, seat: u8, seed: [u8; 32]) -> Result<()> {
    require!(ctx.accounts.table.hand_state == HAND_IDLE, PokerError::HandInProgress);
    let deck = &mut ctx.accounts.deck;
    deck.seeds[seat as usize] = seed;
    deck.seed_owners[seat as usize] = ctx.accounts.player.key();
    deck.seed_mask |= 1 << seat;
    Ok(())
}

// ---------------------------------------------------------------------------------------- start

#[vrf]
#[derive(Accounts)]
pub struct StartHand<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Read-only copy of the L1 config inside the rollup.
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.version == CONFIG_VERSION @ PokerError::ConfigOutdated)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [DECK_SEED, table.key().as_ref()], bump, has_one = table)]
    pub deck: Box<Account<'info, Deck>>,
    /// Who sits where, to check every seat's seed is its current occupant's.
    #[account(seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    /// CHECK: MagicBlock's ephemeral VRF queue (the one that serves the rollup).
    #[account(mut, address = DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
}

/// Anyone may start the next hand once two or more players are seated and every one of them has
/// committed a seed: it requests randomness, and the VRF program calls `deal` with it. If that
/// callback hasn't come after `VRF_RETRY_SECS`, anyone may call this again; the new request
/// replaces the old one, which can then no longer deal.
pub fn start_hand(ctx: Context<StartHand>) -> Result<()> {
    require!(!ctx.accounts.config.paused, PokerError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let table = &mut ctx.accounts.table;
    require!(table.status == STATUS_OPEN, PokerError::TableNotOpen);
    match table.hand_state {
        HAND_IDLE => {
            require!(table.seated() >= 2, PokerError::NotEnoughPlayers);
            let deck = &mut ctx.accounts.deck;
            let ledger = &ctx.accounts.ledger;
            for seat in deal::seats_in(table.seat_mask) {
                let i = seat as usize;
                require!(deck.seed_mask & (1 << seat) != 0 && deck.seed_owners[i] == ledger.seats[i].player, PokerError::MissingSeeds);
            }
            // Seeds of seats that emptied since they were committed don't count.
            for i in 0..deck.seeds.len() {
                if table.seat_mask & (1 << i) == 0 {
                    deck.seeds[i] = [0; 32];
                    deck.seed_owners[i] = Pubkey::default();
                }
            }
            deck.seed_mask &= table.seat_mask;
            table.hand_no = table.hand_no.checked_add(1).ok_or(PokerError::MathOverflow)?;
            table.dealt_mask = table.seat_mask;
            table.hand_state = HAND_SHUFFLING;
            deck.hand_no = table.hand_no;
        }
        HAND_SHUFFLING => require!(now.saturating_sub(table.vrf_requested_ts) >= VRF_RETRY_SECS, PokerError::VrfPending),
        _ => return err!(PokerError::HandInProgress),
    }
    table.vrf_requested_ts = now;
    table.vrf_nonce = table.vrf_nonce.checked_add(1).ok_or(PokerError::MathOverflow)?;
    let (table_key, hand_no, dealt_mask, nonce) = (table.key(), table.hand_no, table.dealt_mask, table.vrf_nonce);

    let mut metas = vec![
        SerializableAccountMeta { pubkey: table_key, is_signer: false, is_writable: true },
        SerializableAccountMeta { pubkey: ctx.accounts.deck.key(), is_signer: false, is_writable: true },
        SerializableAccountMeta { pubkey: ctx.accounts.ledger.key(), is_signer: false, is_writable: true },
    ];
    for seat in deal::seats_in(dealt_mask) {
        let (hand, _) = Pubkey::find_program_address(&[HAND_SEED, table_key.as_ref(), &[seat]], &crate::ID);
        metas.push(SerializableAccountMeta { pubkey: hand, is_signer: false, is_writable: true });
    }
    let ix = create_request_randomness_ix(RequestRandomnessParams {
        payer: ctx.accounts.payer.key(),
        oracle_queue: ctx.accounts.oracle_queue.key(),
        callback_program_id: crate::ID,
        callback_discriminator: crate::instruction::Deal::DISCRIMINATOR.to_vec(),
        caller_seed: hashv(&[table_key.as_ref(), &hand_no.to_le_bytes(), &nonce.to_le_bytes()]).to_bytes(),
        accounts_metas: Some(metas),
        // The VRF program appends these bytes to the callback data: `deal`'s `nonce` argument.
        callback_args: Some(nonce.to_le_bytes().to_vec()),
    });
    ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
    emit!(HandStarted { table: table_key, hand_no });
    Ok(())
}

// ---------------------------------------------------------------------------------------- abort

#[derive(Accounts)]
pub struct AbortHand<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
}

/// Anyone may abandon a hand whose randomness never came, after `VRF_ABORT_SECS`, so a VRF outage
/// can't keep players from leaving. Nothing was dealt. Outstanding requests become invalid; the
/// committed seeds stay for the next attempt.
pub fn abort_hand(ctx: Context<AbortHand>) -> Result<()> {
    let table = &mut ctx.accounts.table;
    require!(table.hand_state == HAND_SHUFFLING, PokerError::HandNotDealt);
    let now = Clock::get()?.unix_timestamp;
    require!(now.saturating_sub(table.vrf_requested_ts) >= VRF_ABORT_SECS, PokerError::TooEarlyToAbort);
    table.vrf_nonce = table.vrf_nonce.checked_add(1).ok_or(PokerError::MathOverflow)?;
    table.hand_state = HAND_IDLE;
    table.dealt_mask = 0;
    emit!(HandAborted { table: table.key(), hand_no: table.hand_no });
    Ok(())
}

// ---------------------------------------------------------------------------------------- deal

/// Only the VRF program can call this: `#[vrf_callback]` requires its identity PDA for this program
/// as a signer. Remaining accounts: the hands of the dealt seats, ascending, as `start_hand` listed.
#[vrf_callback]
#[derive(Accounts)]
pub struct Deal<'info> {
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [DECK_SEED, table.key().as_ref()], bump, has_one = table)]
    pub deck: Box<Account<'info, Deck>>,
    #[account(mut, seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
}

/// Shuffles and deals. Accepted only for the latest request (`nonce`) of a hand that's still
/// shuffling, so randomness can't be replayed, swapped or chosen between two requests.
pub fn deal<'info>(ctx: Context<'info, Deal<'info>>, randomness: [u8; 32], nonce: u64) -> Result<()> {
    let table = &mut ctx.accounts.table;
    require!(table.hand_state == HAND_SHUFFLING && nonce == table.vrf_nonce, PokerError::StaleRandomness);
    let table_key = table.key();
    let deck = &mut ctx.accounts.deck;
    require!(deck.hand_no == table.hand_no, PokerError::StaleRandomness);

    let entropy = deal::entropy_of(&randomness);
    let seed = deal::shuffle_seed(&table_key, table.hand_no, &entropy, deck.seed_mask, &deck.seeds);
    let cards = deal::shuffle(seed);
    let button = if table.hand_no == 1 { deal::first_button(seed, table.dealt_mask) } else { deal::next_button(table.button, table.dealt_mask) };
    let holes = deal::hole_cards(&cards, &deal::deal_order(button, table.dealt_mask));
    deck.entropy = entropy;
    deck.shuffle_seed = seed;
    deck.cards = cards;

    let seats = deal::seats_in(table.dealt_mask);
    require!(ctx.remaining_accounts.len() == seats.len(), PokerError::StaleRandomness);
    for (info, &seat) in ctx.remaining_accounts.iter().zip(seats.iter()) {
        require!(info.is_writable && *info.owner == crate::ID, PokerError::StaleRandomness);
        let mut hand = {
            let data = info.try_borrow_data()?;
            Hand::try_deserialize(&mut &data[..])?
        };
        require!(hand.table == table_key && hand.seat == seat, PokerError::StaleRandomness);
        hand.hand_no = table.hand_no;
        hand.cards = holes[seat as usize];
        write(info, &hand)?;
    }

    let ledger = &mut ctx.accounts.ledger;
    ledger.salt = deal::salt_of(&randomness);
    table.ledger_hash = ledger.fingerprint()?;
    table.ledger_seq = table.ledger_seq.checked_add(1).ok_or(PokerError::MathOverflow)?;
    table.last_activity_ts = Clock::get()?.unix_timestamp;
    table.button = button;
    table.hand_state = HAND_DEALT;
    emit!(HandDealt { table: table_key, hand_no: table.hand_no, button });
    Ok(())
}

// ---------------------------------------------------------------------------------------- end

#[derive(Accounts)]
pub struct EndHand<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [DECK_SEED, table.key().as_ref()], bump, has_one = table)]
    pub deck: Box<Account<'info, Deck>>,
    #[account(seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(mut, seeds = [RECORD_SEED, table.key().as_ref()], bump, has_one = table)]
    pub record: Box<Account<'info, HandRecord>>,
}

/// M4 stand-in for M5's showdown: a seated player or the creator ends the dealt hand. Its seeds,
/// entropy, shuffle seed and deck go into the public record, and the deck is cleared for the next
/// hand. The VRF output itself (and so the ledger salt) isn't published.
pub fn end_hand(ctx: Context<EndHand>) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let table = &mut ctx.accounts.table;
    require!(table.hand_state == HAND_DEALT, PokerError::HandNotDealt);
    require!(ctx.accounts.ledger.seat_of(&signer).is_some() || signer == table.creator, PokerError::NotSeated);
    let deck = &mut ctx.accounts.deck;
    let record = &mut ctx.accounts.record;
    record.hand_no = table.hand_no;
    record.button = table.button;
    record.dealt_mask = table.dealt_mask;
    record.seed_mask = deck.seed_mask;
    record.seeds = deck.seeds;
    record.entropy = deck.entropy;
    record.shuffle_seed = deck.shuffle_seed;
    record.cards = deck.cards;
    deck.seed_mask = 0;
    deck.seeds = Default::default();
    deck.seed_owners = Default::default();
    deck.entropy = [0; 32];
    deck.shuffle_seed = [0; 32];
    deck.cards = [NO_CARD; 52];
    table.hand_state = HAND_IDLE;
    emit!(HandEnded { table: table.key(), hand_no: table.hand_no });
    Ok(())
}

#[event]
pub struct HandStarted {
    pub table: Pubkey,
    pub hand_no: u64,
}

#[event]
pub struct HandDealt {
    pub table: Pubkey,
    pub hand_no: u64,
    pub button: u8,
}

#[event]
pub struct HandAborted {
    pub table: Pubkey,
    pub hand_no: u64,
}

#[event]
pub struct HandEnded {
    pub table: Pubkey,
    pub hand_no: u64,
}
