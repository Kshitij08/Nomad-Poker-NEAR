//! Rollup: a hand's randomness. Every seated player commits a hidden seed, anyone starts the hand
//! (a VRF request), and the VRF callback shuffles and deals into each player's private hand. The
//! betting itself is in play.rs.
//!
//! Why every seat must commit: the VRF oracle's fulfillment transaction carries the VRF output,
//! and the platform's transaction visibility can't be fully relied on (M3). With a seed from every
//! dealt player, nobody short of all players together plus the oracle can compute the deck.
//!
//! A player who doesn't commit a seed within the seed window sits the next hand out.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{vrf, vrf_callback};
use ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE;
use ephemeral_rollups_sdk::vrf::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;
use solana_sha256_hasher::hashv;

use crate::constants::{CONFIG_SEED, CONFIG_VERSION};
use crate::dealing;
use crate::errors::PokerError;
use crate::private::write;
use crate::state::Config;
use crate::table::{
    abort_rule, deal_rule, start_rule, Deck, Hand, Ledger, StartKind, Table, DECK_SEED, HAND_DEALT, HAND_IDLE, HAND_SEED,
    HAND_SHUFFLING, LEDGER_SEED, SEED_WINDOW_SECS, STATUS_OPEN, TABLE_SEED,
};

// ---------------------------------------------------------------------------------------- seeds

#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct CommitSeed<'info> {
    /// The seat's wallet or its reader key.
    pub player: Signer<'info>,
    #[account(seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [DECK_SEED, table.key().as_ref()], bump, has_one = table)]
    pub deck: Box<Account<'info, Deck>>,
    /// The seat's private hand: proves the signer sits there without touching the ledger, so the
    /// transaction (and the seed in it) concerns no other player's readable accounts.
    #[account(seeds = [HAND_SEED, table.key().as_ref(), &[seat]], bump,
        constraint = hand.owner == player.key() || hand.reader == player.key() @ PokerError::NotSeated)]
    pub hand: Box<Account<'info, Hand>>,
}

/// A seated player's hidden seed for the next hand, kept in the private deck. Allowed only while
/// no hand is running, so it's fixed before the VRF output exists. Committing again replaces it.
pub fn commit_seed(ctx: Context<CommitSeed>, seat: u8, seed: [u8; 32]) -> Result<()> {
    require!(ctx.accounts.table.hand_state == HAND_IDLE, PokerError::HandInProgress);
    let deck = &mut ctx.accounts.deck;
    deck.seeds[seat as usize] = seed;
    // The seed belongs to the seat's occupant (its wallet), whichever of its keys signed.
    deck.seed_owners[seat as usize] = ctx.accounts.hand.owner;
    deck.seed_mask |= 1 << seat;
    Ok(())
}

/// M10: sit out. The seat's table key (or wallet) takes back a seed it already committed for the next hand and
/// marks the seat sitting out, so the next hands are dealt without it and nobody waits the seed window for it.
/// Between hands only. Committing a seed again sits the seat back in (start_hand clears the mark).
#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct SitOut<'info> {
    /// The seat's wallet or its reader key.
    pub player: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [DECK_SEED, table.key().as_ref()], bump, has_one = table)]
    pub deck: Box<Account<'info, Deck>>,
    #[account(mut, seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(seeds = [HAND_SEED, table.key().as_ref(), &[seat]], bump,
        constraint = hand.owner == player.key() || hand.reader == player.key() @ PokerError::NotSeated)]
    pub hand: Box<Account<'info, Hand>>,
}

pub fn sit_out(ctx: Context<SitOut>, seat: u8) -> Result<()> {
    require!(ctx.accounts.table.hand_state == HAND_IDLE, PokerError::HandInProgress);
    let i = seat as usize;
    require!(i < ctx.accounts.ledger.seats.len() && ctx.accounts.ledger.seats[i].player == ctx.accounts.hand.owner, PokerError::NotSeated);
    let deck = &mut ctx.accounts.deck;
    deck.seeds[i] = [0; 32];
    deck.seed_owners[i] = Pubkey::default();
    deck.seed_mask &= !(1u16 << seat);
    let ledger = &mut ctx.accounts.ledger;
    if !ledger.seats[i].sitting_out {
        ledger.seats[i].sitting_out = true;
        // The mark is part of the ledger, so its fingerprint on the table changes too (as start_hand does).
        let table = &mut ctx.accounts.table;
        table.ledger_hash = ledger.fingerprint()?;
        table.ledger_seq = table.ledger_seq.checked_add(1).ok_or(PokerError::MathOverflow)?;
    }
    Ok(())
}

/// M10: sit back in. Clears the seat's sitting-out mark at any time (a hand may be running), so the next hand
/// waits for its seed like everyone else's. Without it, a seat sitting out isn't waited for, and at a table of
/// three or more the others' seeds start the next hand before the returning seat's arrives.
#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct SitIn<'info> {
    /// The seat's wallet or its reader key.
    pub player: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(seeds = [HAND_SEED, table.key().as_ref(), &[seat]], bump,
        constraint = hand.owner == player.key() || hand.reader == player.key() @ PokerError::NotSeated)]
    pub hand: Box<Account<'info, Hand>>,
}

pub fn sit_in(ctx: Context<SitIn>, seat: u8) -> Result<()> {
    let i = seat as usize;
    require!(i < ctx.accounts.ledger.seats.len() && ctx.accounts.ledger.seats[i].player == ctx.accounts.hand.owner, PokerError::NotSeated);
    let ledger = &mut ctx.accounts.ledger;
    if ledger.seats[i].sitting_out {
        ledger.seats[i].sitting_out = false;
        let table = &mut ctx.accounts.table;
        table.ledger_hash = ledger.fingerprint()?;
        table.ledger_seq = table.ledger_seq.checked_add(1).ok_or(PokerError::MathOverflow)?;
    }
    Ok(())
}

/// M10: the host's Start round, pressed once per table: no hand starts before it, and after it hands keep
/// starting on their own. The first press restarts the seed window from now, so every seated player's game
/// has the full window to commit its seed once it sees it. Between hands only; pressing again changes nothing.
#[derive(Accounts)]
pub struct RequestStart<'info> {
    /// The host's wallet or their seat's table key (any seated player's, while the host holds no seat).
    pub player: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.creator.as_ref(), &table.table_id.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
}

pub fn request_start(ctx: Context<RequestStart>) -> Result<()> {
    let table = &mut ctx.accounts.table;
    require!(table.status == STATUS_OPEN, PokerError::TableNotOpen);
    require!(table.hand_state == HAND_IDLE, PokerError::HandInProgress);
    let ledger = &ctx.accounts.ledger;
    let seats: Vec<(Pubkey, Pubkey)> = dealing::seats_in(table.seat_mask)
        .into_iter()
        .filter(|&s| (s as usize) < ledger.seats.len())
        .map(|s| (ledger.seats[s as usize].player, ledger.seats[s as usize].reader))
        .collect();
    require!(crate::table::may_request_start(&table.creator, &ctx.accounts.player.key(), &seats), PokerError::NotHost);
    if table.start_requested_for == 0 {
        table.start_requested_for = table.hand_no.checked_add(1).ok_or(PokerError::MathOverflow)?;
        table.idle_since = Clock::get()?.unix_timestamp;
    }
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
    /// Who sits where, to check every seat's seed is its current occupant's; seats that miss the
    /// seed window are marked sitting out here.
    #[account(mut, seeds = [LEDGER_SEED, table.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    /// CHECK: MagicBlock's ephemeral VRF queue (the one that serves the rollup).
    #[account(mut, address = DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
}

/// Anyone may start the next hand, once the host started the table (M10: `request_start`) and two or more
/// seated players with chips have committed seeds:
/// straight away if every seated player with chips has, otherwise once `SEED_WINDOW_SECS` have
/// passed since the table became idle (those without a seed sit the hand out). It requests
/// randomness, and the VRF program calls `deal` with it. If that
/// callback hasn't come after `VRF_RETRY_SECS`, anyone may call this again; the new request
/// replaces the old one, which can then no longer deal.
pub fn start_hand(ctx: Context<StartHand>) -> Result<()> {
    require!(!ctx.accounts.config.paused, PokerError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let table = &mut ctx.accounts.table;
    require!(table.status == STATUS_OPEN, PokerError::TableNotOpen);
    match start_rule(table.hand_state, now, table.vrf_requested_ts)? {
        StartKind::NewHand => {
            // M10: only after the host pressed Start round (once per table). A tournament's table is
            // started by the program when it seats the round (M11).
            require!(table.start_requested_for != 0, PokerError::StartNotRequested);
            let tourney_table = table.kind == crate::tourney::KIND_TOURNEY;
            let deck = &mut ctx.accounts.deck;
            let ledger = &mut ctx.accounts.ledger;
            // Seats with chips that are waited for, and those whose current occupant committed a
            // seed. A seat sitting out isn't waited for, but plays again once it commits.
            let (mut funded, mut seeded) = (0u16, 0u16);
            for seat in dealing::seats_in(table.seat_mask) {
                let (i, bit) = (seat as usize, 1u16 << seat);
                let has_seed = deck.seed_mask & bit != 0 && deck.seed_owners[i] == ledger.seats[i].player;
                if ledger.seats[i].stack > 0 && (has_seed || !ledger.seats[i].sitting_out) {
                    funded |= bit;
                    if has_seed {
                        seeded |= bit;
                    }
                }
            }
            require!(funded.count_ones() >= 2, PokerError::NotEnoughPlayers);
            // Everyone with chips plays once they've all committed. Otherwise wait out the seed
            // window, then deal only the seats that committed (the rest sit this hand out).
            let dealt = if seeded == funded {
                funded
            } else {
                require!(now.saturating_sub(table.idle_since) >= SEED_WINDOW_SECS, PokerError::MissingSeeds);
                // M11: at a tournament table an absent player is still dealt (and blinded away); the deck
                // mixes the VRF with the seeds that did come. At a cash table they sit the hand out.
                if tourney_table { funded } else { seeded }
            };
            require!(dealt.count_ones() >= 2, PokerError::NotEnoughPlayers);
            // Who missed the window sits out until they commit again; who's dealt is back in.
            for seat in dealing::seats_in(table.seat_mask) {
                let i = seat as usize;
                if dealt & (1 << seat) != 0 {
                    ledger.seats[i].sitting_out = false;
                } else if funded & (1 << seat) != 0 {
                    ledger.seats[i].sitting_out = true;
                }
            }
            table.ledger_hash = ledger.fingerprint()?;
            table.ledger_seq = table.ledger_seq.checked_add(1).ok_or(PokerError::MathOverflow)?;
            // Only dealt seats' seeds count; the rest are dropped.
            for i in 0..deck.seeds.len() {
                if dealt & (1 << i) == 0 {
                    deck.seeds[i] = [0; 32];
                    deck.seed_owners[i] = Pubkey::default();
                }
            }
            deck.seed_mask &= dealt;
            table.hand_no = table.hand_no.checked_add(1).ok_or(PokerError::MathOverflow)?;
            table.dealt_mask = dealt;
            table.hand_state = HAND_SHUFFLING;
            table.shuffle_started_ts = now;
            deck.hand_no = table.hand_no;
        }
        StartKind::Retry => {}
    }
    table.vrf_requested_ts = now;
    table.vrf_nonce = table.vrf_nonce.checked_add(1).ok_or(PokerError::MathOverflow)?;
    let (table_key, hand_no, dealt_mask, nonce) = (table.key(), table.hand_no, table.dealt_mask, table.vrf_nonce);

    let mut metas = vec![
        SerializableAccountMeta { pubkey: table_key, is_signer: false, is_writable: true },
        SerializableAccountMeta { pubkey: ctx.accounts.deck.key(), is_signer: false, is_writable: true },
        SerializableAccountMeta { pubkey: ctx.accounts.ledger.key(), is_signer: false, is_writable: true },
    ];
    for seat in dealing::seats_in(dealt_mask) {
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

/// Anyone may abandon a hand whose randomness never came, `VRF_ABORT_SECS` after it started
/// shuffling, so a VRF outage can't keep players from leaving. Nothing was dealt, so the hand
/// number is given back (the next hand is still "hand 1" with a random button if this was the
/// first). Outstanding requests become invalid; the committed seeds stay for the next attempt.
pub fn abort_hand(ctx: Context<AbortHand>) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let now = Clock::get()?.unix_timestamp;
    abort_rule(table.hand_state, now, table.shuffle_started_ts)?;
    table.idle_since = now;
    table.vrf_nonce = table.vrf_nonce.checked_add(1).ok_or(PokerError::MathOverflow)?;
    table.hand_state = HAND_IDLE;
    table.dealt_mask = 0;
    table.hand_no = table.hand_no.saturating_sub(1);
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
    deal_rule(table.hand_state, nonce, table.vrf_nonce)?;
    let table_key = table.key();
    let deck = &mut ctx.accounts.deck;
    require!(deck.hand_no == table.hand_no, PokerError::StaleRandomness);

    let entropy = dealing::entropy_of(&randomness);
    let seed = dealing::shuffle_seed(&table_key, table.hand_no, &entropy, deck.seed_mask, &deck.seeds);
    let cards = dealing::shuffle(seed);
    let button = if table.hand_no == 1 { dealing::first_button(seed, table.dealt_mask) } else { dealing::next_button(table.button, table.dealt_mask) };
    let holes = dealing::hole_cards(&cards, &dealing::deal_order(button, table.dealt_mask));
    deck.entropy = entropy;
    deck.log_secret = dealing::log_secret_of(&randomness);
    deck.shuffle_seed = seed;
    deck.cards = cards;

    let seats = dealing::seats_in(table.dealt_mask);
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
    ledger.salt = dealing::salt_of(&randomness);
    table.ledger_hash = ledger.fingerprint()?;
    table.ledger_seq = table.ledger_seq.checked_add(1).ok_or(PokerError::MathOverflow)?;
    table.last_activity_ts = Clock::get()?.unix_timestamp;
    table.button = button;
    table.hand_state = HAND_DEALT;
    emit!(HandDealt { table: table_key, hand_no: table.hand_no, button });
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
