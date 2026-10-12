use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::constants::MAX_SEATS;
use crate::engine::Game;
use crate::errors::PokerError;

pub const TABLE_SEED: &[u8] = b"table";
pub const LEDGER_SEED: &[u8] = b"ledger";
pub const DECK_SEED: &[u8] = b"deck";
pub const HAND_SEED: &[u8] = b"hand";
pub const INVITES_SEED: &[u8] = b"invites";
pub const PRIVATE_INVITES_SEED: &[u8] = b"invites_p";
pub const RECORD_SEED: &[u8] = b"record";
pub const LOG_SEED: &[u8] = b"log";
pub const TABLE_VERSION: u8 = 2;
/// M4 and M5 took 60 of the original 96 reserved bytes for the hand fields. M6 added
/// `last_record`, which grew the account: tables created before M6 can't be read by this layout
/// (only `reclaim_table` handles them), so none may be open when this build is deployed.
pub const TABLE_RESERVED: usize = 10;
pub const MAX_INVITES: usize = 16;

/// Created on L1, not yet live in the rollup.
pub const STATUS_CREATED: u8 = 0;
/// Live (or returned to L1 by the escape hatch with players still owed money).
pub const STATUS_OPEN: u8 = 1;
/// Closed empty by the creator.
pub const STATUS_CLOSED: u8 = 2;

/// No hand running: seeds can be committed and players can leave.
pub const HAND_IDLE: u8 = 0;
/// VRF requested; waiting for the callback to shuffle and deal.
pub const HAND_SHUFFLING: u8 = 1;
/// Cards dealt; `begin_hand` posts the blinds next.
pub const HAND_DEALT: u8 = 2;
/// Betting under way (play.rs).
pub const HAND_PLAYING: u8 = 3;
/// If the VRF callback hasn't arrived after this long, anyone may request again.
pub const VRF_RETRY_SECS: i64 = 20;
/// If it still hasn't arrived this long after the hand started shuffling (retries don't reset this),
/// anyone may abandon the hand, so players can leave.
pub const VRF_ABORT_SECS: i64 = 300;

/// Seconds a player has to act; after that anyone may check-or-fold for them (`timeout`).
pub const TURN_SECS: i64 = 15;
/// Seconds after a hand ends during which every seated player with chips must commit a seed before
/// the next hand can start. After that, seats without a seed sit the next hand out.
pub const SEED_WINDOW_SECS: i64 = 20;
/// Actions kept in a hand's log (8 KB). The hash chain covers every action even past this.
pub const LOG_CAPACITY: usize = 512;
/// A hand that ends at least this long after the table's last commit commits it to L1 (keeps the
/// L1 copy fresh for the escape hatch, whose idle delay is an hour by default).
pub const COMMIT_EVERY_SECS: i64 = 900;

/// What `start_hand` does in a given state.
#[derive(Debug, PartialEq)]
pub enum StartKind {
    /// A new hand: needs seeds, bumps the hand number.
    NewHand,
    /// Re-request randomness for the hand that's already shuffling.
    Retry,
}

pub fn start_rule(hand_state: u8, now: i64, vrf_requested_ts: i64) -> Result<StartKind> {
    match hand_state {
        HAND_IDLE => Ok(StartKind::NewHand),
        HAND_SHUFFLING => {
            require!(now.saturating_sub(vrf_requested_ts) >= VRF_RETRY_SECS, PokerError::VrfPending);
            Ok(StartKind::Retry)
        }
        _ => err!(PokerError::HandInProgress),
    }
}

/// M10: who may ask for the next hand to start: the host (the creator's wallet, or the table key of a seat
/// the creator holds), or, while the creator holds no seat, any seated player (so a table whose host left
/// isn't stuck). `seats` are the ledger's (player, reader) pairs of taken seats.
pub fn may_request_start(creator: &Pubkey, signer: &Pubkey, seats: &[(Pubkey, Pubkey)]) -> bool {
    if signer == creator {
        return true;
    }
    let creator_seated = seats.iter().any(|(player, _)| player == creator);
    seats.iter().any(|(player, reader)| (player == signer || reader == signer) && (player == creator || !creator_seated))
}

/// `abort_hand` is allowed only while shuffling, `VRF_ABORT_SECS` after the hand *started*
/// shuffling, so repeated retries can't postpone it.
pub fn abort_rule(hand_state: u8, now: i64, shuffle_started_ts: i64) -> Result<()> {
    require!(hand_state == HAND_SHUFFLING, PokerError::NotShuffling);
    require!(now.saturating_sub(shuffle_started_ts) >= VRF_ABORT_SECS, PokerError::TooEarlyToAbort);
    Ok(())
}

/// The VRF callback deals only for the latest request of a hand that's still shuffling.
pub fn deal_rule(hand_state: u8, nonce: u64, current_nonce: u64) -> Result<()> {
    require!(hand_state == HAND_SHUFFLING && nonce == current_nonce, PokerError::StaleRandomness);
    Ok(())
}

/// The only token tables accept for now: wrapped SOL. The stake cap is denominated in it.
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// Lamports the creator puts on the table PDA at creation. The table sponsors the rent of its
/// rollup-only accounts (ledger, deck, 9 hands) and their permissions inside the rollup.
pub const TABLE_SPONSOR_LAMPORTS: u64 = 3_000_000;

/// One seat. An empty seat has `player == Pubkey::default()`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Debug)]
pub struct Seat {
    pub player: Pubkey,
    /// Key that may read the ledger and this seat's hand in the TEE. It is a separate key chosen by
    /// the player's client, so permission lists (which MagicBlock's RPC shows to anyone) never name
    /// the wallet.
    pub reader: Pubkey,
    /// Chips the player has at the table, in the table token's base units.
    pub stack: u64,
    /// Everything this player has put in at this seat (before rake), for the audit trail.
    pub deposited: u64,
    /// Missed a hand by not committing a seed: no longer waited for. Committing a seed brings the
    /// seat back from the next hand on.
    pub sitting_out: bool,
}

impl Seat {
    pub fn is_empty(&self) -> bool {
        self.player == Pubkey::default()
    }
}

/// The public part of a table. Delegated to the TEE rollup and committed to L1, so everything here
/// becomes public on L1. Who sits where, stacks and money totals live in the private `Ledger`;
/// only its fingerprint is here. Fixed layout, no `Option` (M1 lesson).
#[account]
#[derive(InitSpace)]
pub struct Table {
    pub version: u8,
    pub bump: u8,
    pub status: u8,
    pub max_seats: u8,
    /// Bit i set = seat i taken. Lets a new player pick a free seat without reading the ledger.
    pub seat_mask: u16,
    pub invite_only: bool,
    pub table_id: u64,
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub small_blind: u64,
    pub big_blind: u64,
    pub min_buy_in: u64,
    pub max_buy_in: u64,
    /// Copied from config at creation, so later rake changes don't affect open tables.
    pub rake_bps: u16,
    /// Rollup clock at the last money move; used by the escape-hatch rule.
    pub last_activity_ts: i64,
    /// sha256 of the ledger after the last money move, and how many moves there have been.
    /// Players' clients keep their own seat record and can check it against this.
    pub ledger_hash: [u8; 32],
    pub ledger_seq: u64,
    /// Hands started at this table (the current one, if one is running).
    pub hand_no: u64,
    /// HAND_IDLE, HAND_SHUFFLING or HAND_DEALT.
    pub hand_state: u8,
    /// Dealer button of the current or last hand (meaningless while `hand_no == 0`).
    pub button: u8,
    /// Seats dealt into the current hand.
    pub dealt_mask: u16,
    /// Rollup clock when randomness was last requested.
    pub vrf_requested_ts: i64,
    /// Bumped on every randomness request (and abort). The callback must echo the current value,
    /// so only the latest request can deal.
    pub vrf_nonce: u64,
    /// Rollup clock when the current hand started shuffling (the abort deadline counts from here).
    pub shuffle_started_ts: i64,
    /// While a hand is played: when the awaited player's turn runs out.
    pub turn_deadline: i64,
    /// When the table last became idle (opened, or a hand ended or was aborted); the seed window
    /// counts from here. Sitting down doesn't move it, so nobody can stall hands by re-seating.
    pub idle_since: i64,
    /// Rollup clock at the table's last commit to L1.
    pub last_commit_ts: i64,
    /// The last finished hand's public record (all zero before the first). Copied here at the end
    /// of every hand so each commit of the table publishes the latest hand on L1; the backend
    /// archives every hand from the rollup's `HandRecord`.
    pub last_record: HandRecord,
    /// M10: `ledger_seq` and `hand_no` at the last commit. Anyone but the creator may commit only after one of
    /// them changed, so outsiders can't make an idle table pay a commit every 15 minutes (review L4). Taken
    /// from the reserved bytes, so the account keeps its size and older tables read zeros.
    pub committed_ledger_seq: u64,
    pub committed_hand_no: u64,
    /// M10: the first hand the host started (`hand_no + 1` when they first pressed Start round; 0 = not yet).
    /// No hand starts before that; after it, hands keep starting as before. Taken from the reserved bytes
    /// (the account keeps its size).
    pub start_requested_for: u64,
    /// M11: KIND_CASH (0, every table before M11) or KIND_TOURNEY: a tournament's table, created by the
    /// program with the tournament as its creator. It holds chips, never money: no buy-in, cash-out or
    /// rake there. Taken from the reserved bytes (the account keeps its size).
    pub kind: u8,
    /// M11 review M2: at a tournament table, set when a hand ends and cleared by `tourney_sync` (blinds,
    /// eliminations, the end of the table's round); the next hand starts only after the sync.
    pub needs_sync: u8,
    pub reserved: [u8; TABLE_RESERVED],
}

impl Table {
    pub fn seated(&self) -> u32 {
        self.seat_mask.count_ones()
    }
    pub fn seat_taken(&self, i: usize) -> bool {
        self.seat_mask & (1 << i) != 0
    }
}

/// The private part of a table: seats, stacks and money. Rollup-only (never committed, never on
/// L1); readable only by the players seated at the table.
#[account]
#[derive(InitSpace)]
pub struct Ledger {
    pub table: Pubkey,
    pub seats: [Seat; MAX_SEATS as usize],
    /// What the table owes: sum of stacks + unpaid rake.
    pub escrow_owed: u64,
    pub rake_accrued: u64,
    /// Escrow token balance seen right after the last money move.
    pub escrow_balance: u64,
    pub total_deposited: u64,
    pub total_paid_out: u64,
    pub total_rake_collected: u64,
    /// Secret salt, refreshed from the VRF every hand, so the public fingerprint can't be guessed
    /// from likely wallets and amounts. All zeros until the first hand is dealt.
    pub salt: [u8; 32],
    /// The current (or last) hand's betting state. Seat stacks above are the stacks between hands;
    /// during a hand the live stacks are in `game` and are written back when it ends.
    pub game: Game,
}

/// One action in a hand's log (16 bytes, zero-copy).
#[zero_copy]
#[derive(Default, PartialEq, Debug)]
pub struct LogEntry {
    /// The seat's total chips committed this hand after the action.
    pub committed: u64,
    pub street: u8,
    pub seat: u8,
    /// engine action kind (FOLD..ALL_IN), or LOG_SMALL_BLIND / LOG_BIG_BLIND; LOG_TIMEOUT is or-ed
    /// in when the program acted for a player whose time ran out.
    pub kind: u8,
    pub pad: [u8; 5],
}

pub const LOG_SMALL_BLIND: u8 = 6;
pub const LOG_BIG_BLIND: u8 = 7;
pub const LOG_TIMEOUT: u8 = 0x80;

/// A hand's action log: rollup-only, readable by the players dealt into the current hand (set by
/// `begin_hand`), and once that hand is over also by the config's auditor (`open_log`). Holds the
/// entries (up to LOG_CAPACITY) and a hash chain over all of them: it starts at sha256(table, hand
/// number, secret) and becomes sha256(previous, street, seat, kind, committed) per action. The
/// secret comes from the hand's VRF output; without it a short hand's bets could be found by
/// trying every likely log against the public hash (M6 review). The final hash is published in the hand record, so each player can check the log
/// they were shown. Zero-copy: read in place, never copied onto the stack.
#[account(zero_copy)]
pub struct HandLog {
    pub table: Pubkey,
    pub hand_no: u64,
    pub hash: [u8; 32],
    /// The hand's log secret (first link of the hash chain); readers need it to check the hash.
    pub secret: [u8; 32],
    pub len: u32,
    /// How many of `readers` are set.
    pub readers_len: u8,
    pub pad: [u8; 3],
    /// The reader keys of the players dealt into this hand, as set by `begin_hand`.
    pub readers: [Pubkey; MAX_SEATS as usize],
    /// The auditor this hand's log was opened to (default = not yet), so `open_log` runs once.
    pub audited_by: Pubkey,
    pub entries: [LogEntry; LOG_CAPACITY],
}

impl HandLog {
    pub fn reset(&mut self, table: &Pubkey, hand_no: u64, secret: &[u8; 32]) {
        self.hand_no = hand_no;
        self.secret = *secret;
        self.audited_by = Pubkey::default();
        // Clear the previous hand's entries: this hand's readers may not have played it.
        let used = (self.len as usize).min(LOG_CAPACITY);
        for e in self.entries[..used].iter_mut() {
            *e = LogEntry::default();
        }
        self.len = 0;
        self.hash = log_start(table, hand_no, secret);
    }

    pub fn push(&mut self, street: u8, seat: u8, kind: u8, committed: u64) {
        self.hash = log_step(&self.hash, street, seat, kind, committed);
        if (self.len as usize) < LOG_CAPACITY {
            self.entries[self.len as usize] = LogEntry { committed, street, seat, kind, pad: [0; 5] };
        }
        self.len = self.len.saturating_add(1);
    }
}

pub fn log_start(table: &Pubkey, hand_no: u64, secret: &[u8; 32]) -> [u8; 32] {
    hashv(&[table.as_ref(), &hand_no.to_le_bytes(), secret]).to_bytes()
}

pub fn log_step(prev: &[u8; 32], street: u8, seat: u8, kind: u8, committed: u64) -> [u8; 32] {
    hashv(&[prev, &[street, seat, kind], &committed.to_le_bytes()]).to_bytes()
}

impl Ledger {
    pub fn seat_of(&self, player: &Pubkey) -> Option<usize> {
        self.seats.iter().position(|s| !s.is_empty() && s.player == *player)
    }

    /// Sum of stacks + unpaid rake. Must always equal `escrow_owed`.
    pub fn computed_owed(&self) -> Option<u64> {
        self.seats.iter().try_fold(self.rake_accrued, |acc, s| acc.checked_add(s.stack))
    }

    /// Reader keys of the occupied seats: the ledger's permission members.
    pub fn readers(&self) -> Vec<Pubkey> {
        self.seats.iter().filter(|s| !s.is_empty()).map(|s| s.reader).collect()
    }

    pub fn fingerprint(&self) -> Result<[u8; 32]> {
        let mut bytes = Vec::with_capacity(8 + Ledger::INIT_SPACE);
        self.try_serialize(&mut bytes)?;
        Ok(hashv(&[&bytes]).to_bytes())
    }
}

/// The current hand's shuffle inputs and deck. Rollup-only and readable by nobody. Seeds are for the
/// next hand while the table is idle; `end_hand` copies everything public into the `HandRecord`.
#[account]
#[derive(InitSpace)]
pub struct Deck {
    pub table: Pubkey,
    pub hand_no: u64,
    /// Bit i set = seat i committed a seed.
    pub seed_mask: u16,
    pub seeds: [[u8; 32]; MAX_SEATS as usize],
    /// Who committed each seed. A seed counts only while its committer still holds the seat.
    pub seed_owners: [Pubkey; MAX_SEATS as usize],
    /// Public stand-in for the VRF output (see dealing.rs).
    pub entropy: [u8; 32],
    pub shuffle_seed: [u8; 32],
    pub cards: [u8; 52],
    /// The hand's log secret (see `dealing::log_secret_of`), handed to the log by `begin_hand`.
    pub log_secret: [u8; 32],
}

/// The last finished hand, readable by anyone so anyone can recompute its deck (tests/verifier.ts).
/// Rollup-only and overwritten each hand; a copy goes into the table (`last_record`), so each
/// commit publishes the latest hand on Solana.
#[account]
#[derive(InitSpace)]
pub struct HandRecord {
    pub table: Pubkey,
    pub hand_no: u64,
    pub button: u8,
    pub dealt_mask: u16,
    pub seed_mask: u16,
    pub seeds: [[u8; 32]; MAX_SEATS as usize],
    pub entropy: [u8; 32],
    pub shuffle_seed: [u8; 32],
    pub cards: [u8; 52],
    /// Board cards reached (0, 3, 4 or 5); every card in the deck is public after the hand anyway.
    pub board_len: u8,
    /// Final hash of the hand's action log (see `HandLog`). Bets themselves stay private.
    pub log_hash: [u8; 32],
    /// Actions in the hand (the log may hold fewer, see LOG_CAPACITY).
    pub log_len: u32,
}

/// One seat's hole cards. Rollup-only and readable only by the seat's current owner. Created when a
/// player sits and closed when they leave.
#[account]
#[derive(InitSpace)]
pub struct Hand {
    pub table: Pubkey,
    pub seat: u8,
    pub owner: Pubkey,
    pub hand_no: u64,
    pub cards: [u8; 2],
    /// The seat's reader key (M8): it may commit the seat's seeds, as it may act, so a client plays
    /// without a wallet prompt per hand.
    pub reader: Pubkey,
}

/// Invite list for an invite-only table. Lives on L1 (not delegated); the rollup reads a copy.
/// Stores sha256(table || wallet), not wallets, so the public account doesn't say who's invited.
#[account]
#[derive(InitSpace)]
pub struct Invites {
    pub table: Pubkey,
    pub count: u8,
    pub hashes: [[u8; 32]; MAX_INVITES],
}

pub fn invite_hash(table: &Pubkey, wallet: &Pubkey) -> [u8; 32] {
    hashv(&[table.as_ref(), wallet.as_ref()]).to_bytes()
}

impl Invites {
    pub fn contains(&self, table: &Pubkey, wallet: &Pubkey) -> bool {
        let h = invite_hash(table, wallet);
        self.hashes[..self.count as usize].iter().any(|x| *x == h)
    }
}

/// M9c: the invite list of an invite-only table, kept private in the rollup instead of on L1. It is a
/// rollup-only account with no readers (only the program sees it), set by the creator's play key, and
/// every transaction touching it is withheld by the TEE. So nobody can check who's invited, and it
/// costs the host no L1 rent. Holds 16-byte truncated wallet hashes (a play-key transaction has room
/// for 16 of them, not 16 full hashes) and the hash of the table's invite-link code, if any.
#[account]
#[derive(InitSpace)]
pub struct PrivateInvites {
    pub table: Pubkey,
    pub count: u8,
    pub hashes: [[u8; 16]; MAX_INVITES],
    /// sha256(table || code) of the invite link's secret code; all zeros = no link.
    pub code_hash: [u8; 32],
}

pub fn private_invite_hash(table: &Pubkey, wallet: &Pubkey) -> [u8; 16] {
    let h = invite_hash(table, wallet);
    let mut out = [0u8; 16];
    out.copy_from_slice(&h[..16]);
    out
}

pub fn invite_code_hash(table: &Pubkey, code: &[u8; 16]) -> [u8; 32] {
    hashv(&[b"invite-code", table.as_ref(), code.as_ref()]).to_bytes()
}

impl PrivateInvites {
    pub fn admits(&self, table: &Pubkey, wallet: &Pubkey, code: Option<&[u8; 16]>) -> bool {
        let h = private_invite_hash(table, wallet);
        let listed = self.hashes[..(self.count as usize).min(MAX_INVITES)].iter().any(|x| *x == h);
        let by_code = match code {
            Some(c) => self.code_hash != [0; 32] && invite_code_hash(table, c) == self.code_hash,
            None => false,
        };
        listed || by_code
    }
}

/// Whether `wallet` may sit at an invite-only table. `invites` is the table's private invite list
/// (M9c) or, for tables hosted before it, the L1 list; anything else admits nobody.
pub fn invite_admits(invites: &AccountInfo, table: &Pubkey, wallet: &Pubkey, code: Option<&[u8; 16]>) -> Result<bool> {
    if invites.owner != &crate::ID || invites.data_is_empty() {
        return Ok(false);
    }
    let data = invites.try_borrow_data()?;
    if *invites.key == Pubkey::find_program_address(&[PRIVATE_INVITES_SEED, table.as_ref()], &crate::ID).0 {
        let inv = PrivateInvites::try_deserialize(&mut &data[..])?;
        Ok(inv.table == *table && inv.admits(table, wallet, code))
    } else if *invites.key == Pubkey::find_program_address(&[INVITES_SEED, table.as_ref()], &crate::ID).0 {
        let inv = Invites::try_deserialize(&mut &data[..])?;
        Ok(inv.contains(table, wallet))
    } else {
        Ok(false)
    }
}

/// Rake on a buy-in, rounded up so small or split buy-ins can't avoid it.
pub fn rake_for(amount: u64, rake_bps: u16) -> Result<u64> {
    let r = (amount as u128)
        .checked_mul(rake_bps as u128)
        .ok_or(PokerError::MathOverflow)?
        .div_ceil(10_000u128);
    Ok(r as u64)
}

/// Who may hand a table to the TEE: the creator for a new table; anyone for a table that came
/// back to L1 still open (so a creator can't strand players by pulling the table out); nobody
/// for a closed table.
pub fn may_delegate(status: u8, signer_is_creator: bool) -> Result<()> {
    match status {
        STATUS_CREATED => require!(signer_is_creator, PokerError::NotCreator),
        STATUS_OPEN => {}
        _ => return err!(PokerError::TableNotOpen),
    }
    Ok(())
}

/// The emergency undelegation rule, applied to the table's L1 copy (its last commit). Only "idle
/// long enough" counts: the copy can't prove a table is empty, because nothing is committed
/// between delegation and the next commit. Delegation stamps `last_activity_ts`, and M5 must commit
/// live tables more often than `idle_secs`.
/// A timestamp from the future can only come from a misbehaving validator, so it counts as idle
/// rather than letting that validator block the escape hatch forever.
pub fn may_request_escape(last_activity_ts: i64, now: i64, idle_secs: i64) -> Result<()> {
    let from_future = last_activity_ts > now;
    require!(from_future || now.saturating_sub(last_activity_ts) >= idle_secs, PokerError::TableActive);
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct TableParams {
    pub small_blind: u64,
    pub big_blind: u64,
    pub min_buy_in: u64,
    pub max_buy_in: u64,
    pub max_seats: u8,
    pub invite_only: bool,
}

/// Table settings must be sane and inside the program-wide stake cap.
pub fn check_table_params(p: &TableParams, config_max_buy_in: u64) -> Result<()> {
    require!(p.small_blind > 0 && p.small_blind <= p.big_blind, PokerError::InvalidBlinds);
    let ten_bb = p.big_blind.checked_mul(10).ok_or(PokerError::MathOverflow)?;
    require!(p.min_buy_in >= ten_bb && p.min_buy_in <= p.max_buy_in, PokerError::InvalidBuyInRange);
    require!(p.max_buy_in <= config_max_buy_in, PokerError::AboveStakeCap);
    require!(p.max_seats >= crate::constants::MIN_SEATS && p.max_seats <= MAX_SEATS, PokerError::InvalidSeatCount);
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn request_start_host_only_unless_host_unseated() {
        use anchor_lang::prelude::Pubkey;
        let (host, host_key, p, p_key, out) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        let both = [(host, host_key), (p, p_key)];
        assert!(super::may_request_start(&host, &host, &both));
        assert!(super::may_request_start(&host, &host_key, &both));
        assert!(!super::may_request_start(&host, &p, &both));
        assert!(!super::may_request_start(&host, &p_key, &both));
        assert!(!super::may_request_start(&host, &out, &both));
        let no_host = [(p, p_key)];
        assert!(super::may_request_start(&host, &host, &no_host));
        assert!(super::may_request_start(&host, &p_key, &no_host));
        assert!(!super::may_request_start(&host, &out, &no_host));
    }

    use super::*;

    fn params() -> TableParams {
        TableParams { small_blind: 1, big_blind: 2, min_buy_in: 20, max_buy_in: 200, max_seats: 6, invite_only: false }
    }

    #[test]
    fn table_params() {
        assert!(check_table_params(&params(), 1_000).is_ok());
        assert!(check_table_params(&TableParams { small_blind: 0, ..params() }, 1_000).is_err());
        assert!(check_table_params(&TableParams { small_blind: 3, ..params() }, 1_000).is_err());
        assert!(check_table_params(&TableParams { min_buy_in: 19, ..params() }, 1_000).is_err());
        assert!(check_table_params(&TableParams { min_buy_in: 201, ..params() }, 1_000).is_err());
        assert!(check_table_params(&params(), 199).is_err());
        assert!(check_table_params(&TableParams { max_seats: 1, ..params() }, 1_000).is_err());
        assert!(check_table_params(&TableParams { max_seats: 10, ..params() }, 1_000).is_err());
    }

    #[test]
    fn rake_rounds_up_and_handles_large_amounts() {
        assert_eq!(rake_for(10_000, 500).unwrap(), 500);
        assert_eq!(rake_for(19, 500).unwrap(), 1);
        assert_eq!(rake_for(10_001, 500).unwrap(), 501);
        assert_eq!(rake_for(u64::MAX, 1_000).unwrap(), u64::MAX / 10 + 1);
        assert_eq!(rake_for(123, 0).unwrap(), 0);
    }

    #[test]
    fn delegation_and_escape_rules() {
        assert!(may_delegate(STATUS_CREATED, true).is_ok());
        assert!(may_delegate(STATUS_CREATED, false).is_err());
        assert!(may_delegate(STATUS_OPEN, false).is_ok());
        assert!(may_delegate(STATUS_CLOSED, true).is_err());
        assert!(may_request_escape(1_000, 1_000 + 3_599, 3_600).is_err());
        assert!(may_request_escape(1_000, 1_000 + 3_600, 3_600).is_ok());
        assert!(may_request_escape(1_000, 1_000 + 60, 60).is_ok());
        assert!(may_request_escape(1_000, 999, 60).is_ok(), "a stamp from the future can't block the hatch");
        assert!(may_request_escape(i64::MAX, 1_000, 60).is_ok());
        assert!(may_request_escape(i64::MIN, 1_000, 60).is_ok());
    }

    #[test]
    fn ledger_seats_owed_and_fingerprint() {
        let mut l = Ledger {
            table: Pubkey::new_unique(), seats: [Seat::default(); MAX_SEATS as usize], escrow_owed: 0, rake_accrued: 5,
            escrow_balance: 0, total_deposited: 0, total_paid_out: 0, total_rake_collected: 0, salt: [0; 32],
            game: Game::default(),
        };
        let a = Pubkey::new_unique();
        let r = Pubkey::new_unique();
        l.seats[3] = Seat { player: a, reader: r, stack: 10, deposited: 10, sitting_out: false };
        assert_eq!(l.seat_of(&a), Some(3));
        assert_eq!(l.readers(), vec![r], "permission members are reader keys, never wallets");
        assert_eq!(l.computed_owed(), Some(15));
        let f1 = l.fingerprint().unwrap();
        l.seats[3].stack = 11;
        let f2 = l.fingerprint().unwrap();
        assert_ne!(f1, f2, "any change moves the fingerprint");
        l.salt = [1; 32];
        assert_ne!(f2, l.fingerprint().unwrap(), "the salt is part of the fingerprint");
    }

    #[test]
    fn table_status_offset() {
        // reclaim_table reads the status at a fixed offset; keep it in step with the layout.
        let mut t = Table::deserialize(&mut &vec![0u8; Table::INIT_SPACE][..]).unwrap();
        t.status = STATUS_CLOSED;
        t.version = 9;
        t.bump = 8;
        let mut bytes = Vec::new();
        t.try_serialize(&mut bytes).unwrap();
        assert_eq!(&bytes[8..11], &[9, 8, STATUS_CLOSED]);
    }

    #[test]
    fn action_log_hash_chain() {
        let t = Pubkey::new_unique();
        let chain_with = |change: Option<u64>, hand: u64, secret: [u8; 32]| {
            let mut h = log_start(&t, hand, &secret);
            for i in 0..(LOG_CAPACITY as u64 + 5) {
                h = log_step(&h, 1, (i % 9) as u8, 2, if Some(i) == change { 99 } else { i });
            }
            h
        };
        let chain = |change: Option<u64>, hand: u64| chain_with(change, hand, [7; 32]);
        assert_eq!(chain(None, 1), chain(None, 1));
        assert_ne!(chain(None, 1), chain(Some(3), 1), "changing any entry changes the final hash");
        assert_ne!(chain(None, 1), chain(None, 2), "the chain is bound to the hand number");
        assert_ne!(chain(None, 1), chain_with(None, 1, [8; 32]), "and to the hand's secret");
        assert_eq!(std::mem::size_of::<LogEntry>(), 16);
    }

    #[test]
    fn hand_state_machine() {
        // start: idle -> new hand; shuffling -> retry only after VRF_RETRY_SECS; dealt -> refused
        assert_eq!(start_rule(HAND_IDLE, 100, 0).unwrap(), StartKind::NewHand);
        assert!(start_rule(HAND_SHUFFLING, 100 + VRF_RETRY_SECS - 1, 100).is_err());
        assert_eq!(start_rule(HAND_SHUFFLING, 100 + VRF_RETRY_SECS, 100).unwrap(), StartKind::Retry);
        assert!(start_rule(HAND_DEALT, 1_000, 0).is_err());
        // abort counts from the shuffle start, so a retry 1 s before the deadline doesn't postpone it
        let started = 1_000;
        let last_retry = started + VRF_ABORT_SECS - 1;
        assert!(abort_rule(HAND_SHUFFLING, started + VRF_ABORT_SECS - 1, started).is_err());
        assert!(abort_rule(HAND_SHUFFLING, last_retry + 1, started).is_ok(), "retries don't reset the abort deadline");
        assert!(abort_rule(HAND_IDLE, i64::MAX, 0).is_err());
        assert!(abort_rule(HAND_DEALT, i64::MAX, 0).is_err());
        // deal: only the latest request, only while shuffling
        assert!(deal_rule(HAND_SHUFFLING, 7, 7).is_ok());
        assert!(deal_rule(HAND_SHUFFLING, 6, 7).is_err(), "a superseded request can't deal");
        assert!(deal_rule(HAND_IDLE, 7, 7).is_err(), "a late callback after an abort can't deal");
        assert!(deal_rule(HAND_DEALT, 7, 7).is_err(), "a replay after the deal can't deal");
    }

    #[test]
    fn seat_mask_and_invites() {
        let mut t_mask: u16 = 0;
        t_mask |= 1 << 2;
        t_mask |= 1 << 8;
        assert_eq!(t_mask.count_ones(), 2);
        let table = Pubkey::new_unique();
        let (a, b) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut inv = Invites { table, count: 1, hashes: [[0; 32]; MAX_INVITES] };
        inv.hashes[0] = invite_hash(&table, &a);
        assert!(inv.contains(&table, &a));
        assert!(!inv.contains(&table, &b));
        assert!(!inv.contains(&Pubkey::new_unique(), &a), "a hash is bound to its table");
    }

    #[test]
    fn private_invites_and_codes() {
        let table = Pubkey::new_unique();
        let (a, b) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut inv = PrivateInvites { table, count: 1, hashes: [[0; 16]; MAX_INVITES], code_hash: [0; 32] };
        inv.hashes[0] = private_invite_hash(&table, &a);
        assert!(inv.admits(&table, &a, None));
        assert!(!inv.admits(&table, &b, None));
        assert!(!inv.admits(&table, &b, Some(&[0; 16])), "no link set: no code works, not even zeros");
        let code = [7u8; 16];
        inv.code_hash = invite_code_hash(&table, &code);
        assert!(inv.admits(&table, &b, Some(&code)));
        assert!(!inv.admits(&table, &b, Some(&[8u8; 16])));
        assert!(!inv.admits(&Pubkey::new_unique(), &b, Some(&code)), "a code is bound to its table");
        inv.count = 0;
        assert!(!inv.admits(&table, &a, None), "only the first `count` hashes count");
    }
}
