//! Rollup: a hand's randomness. Players commit hidden seeds, anyone starts the hand (a VRF request),
//! the VRF callback shuffles and deals into each player's private hand, and the hand's shuffle
//! inputs and deck are published in the table's public `HandRecord` when it ends.
//!
//! M4 has no betting yet: `end_hand` stands in for M5's showdown, so a seated player (or the
//! creator) ends the hand by hand. M5 replaces that with the engine.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{vrf, vrf_callback};
use ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE;
use ephemeral_rollups_sdk::vrf::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;
use solana_sha256_hasher::hashv;

use crate::deal::{self, NO_CARD};
use crate::errors::PokerError;
use crate::private::write;
use crate::table::{
    Deck, Hand, HandRecord, Ledger, Table, DECK_SEED, HAND_DEALT, HAND_IDLE, HAND_SEED, HAND_SHUFFLING, LEDGER_SEED,
    RECORD_SEED, STATUS_OPEN, TABLE_SEED, VRF_RETRY_SECS,
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
    deck.seed_mask |= 1 << seat;
    Ok(())
}

// ---------------------------------------------------------------------------------------- start

#[vrf]
#[derive(Accounts)]
pub struct StartHand<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [DECK_SEED, table.key().as_ref()], bump, has_one = table)]
    pub deck: Box<Account<'info, Deck>>,
    /// CHECK: the ledger PDA; only its address is passed on to the callback.
    #[account(seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: MagicBlock's ephemeral VRF queue (the one that serves the rollup).
    #[account(mut, address = DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
}

/// Anyone may start the next hand once two or more players are seated: it requests randomness, and
/// the VRF program calls `deal` with it. If that callback hasn't come after `VRF_RETRY_SECS`, anyone
/// may call this again to re-request for the same hand.
pub fn start_hand(ctx: Context<StartHand>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let table = &mut ctx.accounts.table;
    require!(table.status == STATUS_OPEN, PokerError::TableNotOpen);
    match table.hand_state {
        HAND_IDLE => {
            require!(table.seated() >= 2, PokerError::NotEnoughPlayers);
            table.hand_no = table.hand_no.checked_add(1).ok_or(PokerError::MathOverflow)?;
            table.dealt_mask = table.seat_mask;
            table.hand_state = HAND_SHUFFLING;
            let deck = &mut ctx.accounts.deck;
            deck.hand_no = table.hand_no;
            // Seeds of seats that emptied since they were committed don't count.
            for seat in 0..deck.seeds.len() {
                if table.dealt_mask & (1 << seat) == 0 {
                    deck.seeds[seat] = [0; 32];
                }
            }
            deck.seed_mask &= table.dealt_mask;
        }
        HAND_SHUFFLING => require!(now.saturating_sub(table.vrf_requested_ts) >= VRF_RETRY_SECS, PokerError::VrfPending),
        _ => return err!(PokerError::HandInProgress),
    }
    table.vrf_requested_ts = now;
    let (table_key, hand_no, dealt_mask) = (table.key(), table.hand_no, table.dealt_mask);

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
        caller_seed: hashv(&[table_key.as_ref(), &hand_no.to_le_bytes(), &now.to_le_bytes()]).to_bytes(),
        accounts_metas: Some(metas),
        ..Default::default()
    });
    ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
    emit!(HandStarted { table: table_key, hand_no });
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

/// Shuffles and deals. Accepted once per hand: a second or late callback finds the hand no longer
/// shuffling and is rejected, so randomness can't be replayed or swapped after the deal.
pub fn deal<'info>(ctx: Context<'info, Deal<'info>>, randomness: [u8; 32]) -> Result<()> {
    let table = &mut ctx.accounts.table;
    require!(table.hand_state == HAND_SHUFFLING, PokerError::StaleRandomness);
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
/// hand. The VRF output itself (and so the ledger salt) is never published.
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
pub struct HandEnded {
    pub table: Pubkey,
    pub hand_no: u64,
}
