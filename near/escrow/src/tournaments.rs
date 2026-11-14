//! Tournaments.
//!
//! - A host creates one with a name, entry fee, player cap, start time, an optional prize the host adds, and
//!   optionally a private code (stored as its SHA-256; players register with the code itself).
//! - Players register by paying the entry fee (attached deposit and/or game balance). Before the start they may
//!   leave for a full refund, and the host may cancel, refunding every entry and returning the prize.
//! - After the start the operator settles it with the final placings. The platform takes 5% of the entries; the
//!   rest plus the host's prize is the pool: 1st gets 60%, 2nd 40% (1st gets it all if only one player entered).
//!   Settlement is idempotent: the same placings again do nothing; different placings are refused.
//! - The operator may also cancel a tournament that has not been settled (for example if it never ran).

use crate::{bps_of, check_id, event, mul_div, Escrow, EscrowExt};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

pub const MAX_PLAYERS: u32 = 200;
pub const FIRST_BPS: u32 = 6_000;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum TournamentStatus {
    Open,
    Settled,
    Cancelled,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Tournament {
    pub host: AccountId,
    pub name: String,
    pub entry_fee: u128,
    pub max_players: u32,
    pub starts_at: u64,
    pub prize: u128,
    /// Lowercase hex SHA-256 of the private code.
    pub code_hash: Option<String>,
    pub players: Vec<AccountId>,
    pub status: TournamentStatus,
    pub placings: Vec<AccountId>,
    pub fee: u128,
    pub payouts: Vec<(AccountId, u128)>,
    pub created_at: u64,
}

impl Tournament {
    /// Entries plus prize: what the contract holds for this tournament while it is open.
    pub fn held(&self) -> u128 {
        self.entry_fee * self.players.len() as u128 + self.prize
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TournamentView {
    pub tournament_id: String,
    pub host: AccountId,
    pub name: String,
    pub entry_fee: U128,
    pub max_players: u32,
    pub starts_at: U64,
    pub started: bool,
    pub prize: U128,
    pub private: bool,
    pub players: Vec<AccountId>,
    pub status: TournamentStatus,
    /// Held for this tournament now: entries plus prize while open, zero once settled or cancelled.
    pub held: U128,
    /// Settled: final placings, the platform fee and what each winner got.
    pub placings: Vec<AccountId>,
    pub fee: U128,
    pub payouts: Vec<(AccountId, U128)>,
}

impl Escrow {
    fn tournament(&self, id: &str) -> Tournament {
        self.tournaments.get(id).cloned().unwrap_or_else(|| env::panic_str("no such tournament"))
    }

    fn refund_all(&mut self, t: &Tournament) {
        for p in &t.players {
            self.credit(p, t.entry_fee);
        }
        self.credit(&t.host, t.prize);
        self.totals.in_tournaments -= t.held();
    }
}

#[near]
impl Escrow {
    /// Creates a tournament. The host's prize is `prize` yoctoNEAR from the attached deposit and game balance (by
    /// default exactly the attached deposit). `code_hash`: lowercase hex SHA-256 of a private code, if any.
    #[payable]
    pub fn create_tournament(
        &mut self,
        tournament_id: String,
        name: String,
        entry_fee: U128,
        max_players: u32,
        starts_at: U64,
        code_hash: Option<String>,
        prize: Option<U128>,
    ) {
        check_id(&tournament_id);
        require!(!self.tournaments.contains_key(&tournament_id), "tournament id taken");
        require!(!name.trim().is_empty() && name.len() <= 64, "the name is 1 to 64 characters");
        require!((2..=MAX_PLAYERS).contains(&max_players), "max players: 2 to 200");
        require!(starts_at.0 > env::block_timestamp(), "the start time has passed");
        if let Some(h) = &code_hash {
            require!(h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "code_hash: 64 lowercase hex characters");
        }
        let host = env::predecessor_account_id();
        let prize = self.fund(prize);
        self.totals.in_tournaments += prize;
        event(
            "tournament_created",
            json!({
                "tournament": tournament_id, "host": host, "name": name, "entry_fee": entry_fee, "max_players": max_players,
                "starts_at": starts_at, "prize": U128(prize), "private": code_hash.is_some(),
            }),
        );
        let t = Tournament {
            host,
            name,
            entry_fee: entry_fee.0,
            max_players,
            starts_at: starts_at.0,
            prize,
            code_hash,
            players: vec![],
            status: TournamentStatus::Open,
            placings: vec![],
            fee: 0,
            payouts: vec![],
            created_at: env::block_timestamp(),
        };
        self.tournaments.insert(tournament_id, t);
    }

    /// Registers the caller, paying the entry fee from the attached deposit and game balance. Anything attached beyond
    /// the fee stays in the caller's game balance.
    #[payable]
    pub fn register(&mut self, tournament_id: String, code: Option<String>) {
        let who = env::predecessor_account_id();
        let mut t = self.tournament(&tournament_id);
        require!(t.status == TournamentStatus::Open, "the tournament is not open");
        require!(env::block_timestamp() < t.starts_at, "the tournament has started");
        require!((t.players.len() as u32) < t.max_players, "the tournament is full");
        require!(!t.players.contains(&who), "already registered");
        if let Some(h) = &t.code_hash {
            let ok = code.map(|c| hex::encode(env::sha256(c.as_bytes())) == *h).unwrap_or(false);
            require!(ok, "wrong or missing code for this private tournament");
        }
        self.fund(Some(U128(t.entry_fee)));
        t.players.push(who.clone());
        self.totals.in_tournaments += t.entry_fee;
        event(
            "registered",
            json!({ "tournament": tournament_id, "player": who, "entry_fee": U128(t.entry_fee), "players": t.players.len() }),
        );
        self.tournaments.insert(tournament_id, t);
    }

    /// Leaves before the start; the entry fee goes back to the game balance.
    pub fn leave(&mut self, tournament_id: String) {
        let who = env::predecessor_account_id();
        let mut t = self.tournament(&tournament_id);
        require!(t.status == TournamentStatus::Open, "the tournament is not open");
        require!(env::block_timestamp() < t.starts_at, "the tournament has started");
        let i = t.players.iter().position(|p| *p == who).unwrap_or_else(|| env::panic_str("not registered"));
        t.players.remove(i);
        self.totals.in_tournaments -= t.entry_fee;
        self.credit(&who, t.entry_fee);
        event("left", json!({ "tournament": tournament_id, "player": who, "refund": U128(t.entry_fee) }));
        self.tournaments.insert(tournament_id, t);
    }

    /// The host cancels before the start, or the operator any time before settlement. Every entry fee is refunded
    /// and the prize goes back to the host, all to game balances.
    pub fn cancel_tournament(&mut self, tournament_id: String) {
        let who = env::predecessor_account_id();
        let mut t = self.tournament(&tournament_id);
        require!(t.status == TournamentStatus::Open, "the tournament is not open");
        if who != self.operator {
            require!(who == t.host, "host or operator only");
            require!(env::block_timestamp() < t.starts_at, "the tournament has started; only the operator can cancel it now");
        }
        self.refund_all(&t);
        t.status = TournamentStatus::Cancelled;
        event(
            "tournament_cancelled",
            json!({ "tournament": tournament_id, "by": who, "refunded": t.players, "entry_fee": U128(t.entry_fee), "prize": U128(t.prize) }),
        );
        self.tournaments.insert(tournament_id, t);
    }

    /// The operator settles a started tournament with its final placings (best first; at least the top two, or
    /// the only player). Returns false if it was already settled with these placings.
    pub fn settle_tournament(&mut self, tournament_id: String, placings: Vec<AccountId>) -> bool {
        self.assert_operator();
        let mut t = self.tournament(&tournament_id);
        if t.status == TournamentStatus::Settled {
            require!(t.placings == placings, "already settled with different placings");
            return false;
        }
        require!(t.status == TournamentStatus::Open, "the tournament was cancelled");
        require!(env::block_timestamp() >= t.starts_at, "the tournament has not started");
        let n = t.players.len();
        require!(placings.len() >= n.min(2) && placings.len() <= n, "placings: at least the top two, at most every player");
        for (i, p) in placings.iter().enumerate() {
            require!(t.players.contains(p), "a placed account is not registered");
            require!(!placings[..i].contains(p), "an account is placed twice");
        }

        let entries = t.entry_fee * n as u128;
        let fee = bps_of(entries, self.tournament_fee_bps);
        let pool = entries - fee + t.prize;
        let mut payouts: Vec<(AccountId, u128)> = vec![];
        match n {
            // Nobody entered: the prize goes back to the host.
            0 => payouts.push((t.host.clone(), pool)),
            1 => payouts.push((placings[0].clone(), pool)),
            _ => {
                let first = mul_div(pool, FIRST_BPS as u128, 10_000);
                payouts.push((placings[0].clone(), first));
                payouts.push((placings[1].clone(), pool - first));
            }
        }
        self.totals.in_tournaments -= t.held();
        self.totals.platform_earnings += fee;
        self.totals.platform_earned += fee;
        for (who, amount) in &payouts {
            self.credit(who, *amount);
        }
        event(
            "tournament_settled",
            json!({
                "tournament": tournament_id, "placings": placings, "entries": U128(entries), "fee": U128(fee),
                "prize": U128(t.prize), "pool": U128(pool),
                "payouts": payouts.iter().map(|(a, v)| json!({ "account": a, "amount": U128(*v) })).collect::<Vec<_>>(),
            }),
        );
        t.status = TournamentStatus::Settled;
        t.placings = placings;
        t.fee = fee;
        t.payouts = payouts;
        self.tournaments.insert(tournament_id, t);
        true
    }

    pub fn get_tournament(&self, tournament_id: String) -> Option<TournamentView> {
        self.tournaments.get(&tournament_id).map(|t| TournamentView {
            tournament_id: tournament_id.clone(),
            host: t.host.clone(),
            name: t.name.clone(),
            entry_fee: U128(t.entry_fee),
            max_players: t.max_players,
            starts_at: U64(t.starts_at),
            started: env::block_timestamp() >= t.starts_at,
            prize: U128(t.prize),
            private: t.code_hash.is_some(),
            players: t.players.clone(),
            status: t.status.clone(),
            held: U128(if t.status == TournamentStatus::Open { t.held() } else { 0 }),
            placings: t.placings.clone(),
            fee: U128(t.fee),
            payouts: t.payouts.iter().map(|(a, v)| (a.clone(), U128(*v))).collect(),
        })
    }

    pub fn is_registered(&self, tournament_id: String, account: AccountId) -> bool {
        self.tournaments.get(&tournament_id).map(|t| t.players.contains(&account)).unwrap_or(false)
    }
}
