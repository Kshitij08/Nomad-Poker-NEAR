//! Cash tables: house tables the operator opens, and hosted tables anyone opens for their friends.
//!
//! - A player buys in from their game balance or an attached deposit. The rake (5% by default) goes to platform
//!   earnings; the rest is locked for that player at that table.
//! - When a player leaves, the operator cashes them out with whatever their stack is worth, under an idempotency key.
//!   A retry with the same key does nothing. A player who already cashed out cannot be cashed out again until they
//!   buy in again.
//! - A table never pays out more than it locked: `paid <= locked` always.
//! - The operator, or the host of a hosted table, closes a table. Once it is closed and nobody is seated, it is
//!   finalised: whatever was locked and not paid out (the remainder) goes to platform earnings and is reported.
//! - If the operator has done nothing on a table (open, cash out, close) for `reclaim_after` (24 hours by default),
//!   a seated player may `reclaim` their seat's locked amount to their game balance, capped by what the table can
//!   still pay. Their seat is removed, as if the operator had cashed them out.

use crate::{bps_of, check_id, event, Escrow, EscrowExt, NS_PER_SEC};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

pub const MAX_SEATS: u8 = 10;
pub const MAX_INVITES: usize = 100;
pub const MAX_KEY_LEN: usize = 128;

/// Limits in chips.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct TableConfig {
    pub small_blind: u64,
    pub big_blind: u64,
    /// A new seat buys in at least this much.
    pub min_buy_in: u64,
    /// A seat's buy-ins (top-ups included) add up to at most this much.
    pub max_buy_in: u64,
    pub seats: u8,
}

impl TableConfig {
    fn check(&self) {
        require!(self.small_blind > 0 && self.small_blind <= self.big_blind, "blinds: 0 < small blind <= big blind");
        require!(self.big_blind <= self.min_buy_in && self.min_buy_in <= self.max_buy_in, "buy-in: big blind <= min buy-in <= max buy-in");
        require!(self.seats >= 2 && self.seats <= MAX_SEATS, "seats: 2 to 10");
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Table {
    /// None for a house table opened by the operator.
    pub host: Option<AccountId>,
    pub config: TableConfig,
    /// Only these accounts (and the host) may buy in. None: anyone may.
    pub invites: Option<Vec<AccountId>>,
    pub closed: bool,
    pub finalized: bool,
    pub seated: u32,
    /// Everything bought in, before rake.
    pub bought_in: u128,
    pub rake: u128,
    /// Bought in after rake: the most this table may ever pay out.
    pub locked: u128,
    pub paid: u128,
    /// Sent to platform earnings when the table was finalised.
    pub remainder: u128,
    pub buy_ins: u32,
    pub cash_outs: u32,
    /// Seats removed by `reclaim` (their payouts are counted in `paid`).
    pub reclaims: u32,
    pub created_at: u64,
    /// The last time the operator opened, cashed out at or closed this table (creation for a hosted table).
    pub last_operator_at: u64,
}

impl Table {
    pub fn outstanding(&self) -> u128 {
        self.locked - self.paid - self.remainder
    }

    fn may_join(&self, who: &AccountId) -> bool {
        match &self.invites {
            None => true,
            Some(list) => self.host.as_ref() == Some(who) || list.contains(who),
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Seat {
    /// Bought in since the player sat down, before rake.
    pub bought_in: u128,
    /// After rake.
    pub locked: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct CashOut {
    pub player: AccountId,
    pub amount: u128,
    pub at: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TableView {
    pub table_id: String,
    pub host: Option<AccountId>,
    pub config: TableConfig,
    pub invite_only: bool,
    pub closed: bool,
    pub finalized: bool,
    pub seated: u32,
    pub bought_in: U128,
    pub rake: U128,
    pub locked: U128,
    pub paid: U128,
    /// Locked and not yet paid out: the most the table can still pay.
    pub outstanding: U128,
    pub remainder: U128,
    pub buy_ins: u32,
    pub cash_outs: u32,
    pub reclaims: u32,
    pub created_at: U64,
    pub last_operator_at: U64,
    /// From this time (nanoseconds) seated players may `reclaim`, unless the operator acts on the table first.
    pub reclaimable_at: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SeatView {
    pub bought_in: U128,
    pub locked: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CashOutView {
    pub player: AccountId,
    pub amount: U128,
    pub at: U64,
}

pub(crate) fn seat_key(table_id: &str, player: &AccountId) -> String {
    format!("{table_id}:{player}")
}

fn check_invites(invites: &Option<Vec<AccountId>>) {
    if let Some(list) = invites {
        require!(list.len() <= MAX_INVITES, "at most 100 invites");
    }
}

impl Escrow {
    fn table(&self, table_id: &str) -> Table {
        self.tables.get(table_id).cloned().unwrap_or_else(|| env::panic_str("no such table"))
    }

    fn add_table(&mut self, table_id: String, host: Option<AccountId>, config: TableConfig, invites: Option<Vec<AccountId>>) {
        check_id(&table_id);
        config.check();
        check_invites(&invites);
        require!(!self.tables.contains_key(&table_id), "table id taken");
        event(
            "table_created",
            json!({ "table": table_id, "host": host, "config": config, "invites": invites }),
        );
        let t = Table {
            host,
            config,
            invites,
            closed: false,
            finalized: false,
            seated: 0,
            bought_in: 0,
            rake: 0,
            locked: 0,
            paid: 0,
            remainder: 0,
            buy_ins: 0,
            cash_outs: 0,
            reclaims: 0,
            created_at: env::block_timestamp(),
            last_operator_at: env::block_timestamp(),
        };
        self.tables.insert(table_id, t);
    }

    /// Closed and empty: the remainder goes to platform earnings.
    fn finalize(&mut self, table_id: &str, t: &mut Table) {
        let remainder = t.outstanding();
        t.remainder = remainder;
        t.finalized = true;
        self.totals.at_tables -= remainder;
        self.totals.platform_earnings += remainder;
        self.totals.platform_earned += remainder;
        event(
            "table_finalized",
            json!({ "table": table_id, "locked": U128(t.locked), "paid": U128(t.paid), "remainder": U128(remainder) }),
        );
    }
}

#[near]
impl Escrow {
    /// The operator opens a house table.
    pub fn open_table(&mut self, table_id: String, config: TableConfig) {
        self.assert_operator();
        self.add_table(table_id, None, config, None);
    }

    /// Anyone hosts a table. With `invites`, only those accounts and the host may buy in.
    pub fn create_hosted_table(&mut self, table_id: String, config: TableConfig, invites: Option<Vec<AccountId>>) {
        self.add_table(table_id, Some(env::predecessor_account_id()), config, invites);
    }

    /// The host replaces the invite list (None opens the table to anyone). Players already seated keep their seats.
    pub fn set_invites(&mut self, table_id: String, invites: Option<Vec<AccountId>>) {
        let mut t = self.table(&table_id);
        require!(t.host.as_ref() == Some(&env::predecessor_account_id()), "host only");
        check_invites(&invites);
        event("invites_set", json!({ "table": table_id, "invites": invites }));
        t.invites = invites;
        self.tables.insert(table_id, t);
    }

    /// Buys in (or tops up) at a table: `amount` yoctoNEAR, a whole number of chips, from the attached deposit and
    /// the game balance (by default exactly the attached deposit). Returns what is now locked for the player there.
    #[payable]
    pub fn buy_in(&mut self, table_id: String, amount: Option<U128>) -> U128 {
        let who = env::predecessor_account_id();
        let mut t = self.table(&table_id);
        require!(!t.closed, "the table is closed");
        require!(t.may_join(&who), "this table is invite-only");
        let amount = self.fund(amount);
        require!(amount > 0 && amount % self.chip_yocto == 0, "the buy-in must be a whole number of chips");
        let key = seat_key(&table_id, &who);
        let mut seat = self.seats.get(&key).cloned();
        let new_seat = seat.is_none();
        if new_seat {
            require!(t.seated < t.config.seats as u32, "the table is full");
            require!(amount >= t.config.min_buy_in as u128 * self.chip_yocto, "below the table's minimum buy-in");
        }
        let s = seat.get_or_insert_with(Seat::default);
        require!(s.bought_in + amount <= t.config.max_buy_in as u128 * self.chip_yocto, "above the table's maximum buy-in");

        let rake = bps_of(amount, self.rake_bps);
        let locked = amount - rake;
        s.bought_in += amount;
        s.locked += locked;
        if new_seat {
            t.seated += 1;
        }
        t.bought_in += amount;
        t.rake += rake;
        t.locked += locked;
        t.buy_ins += 1;
        self.totals.at_tables += locked;
        self.totals.platform_earnings += rake;
        self.totals.platform_earned += rake;
        event(
            "buy_in",
            json!({
                "table": table_id, "player": who, "amount": U128(amount), "rake": U128(rake), "locked": U128(locked),
                "seat_locked": U128(s.locked), "table_locked": U128(t.locked),
            }),
        );
        let seat_locked = s.locked;
        self.seats.insert(key, seat.unwrap());
        self.tables.insert(table_id, t);
        U128(seat_locked)
    }

    /// The operator pays a leaving player `amount` (their stack, which may be more or less than they bought in) to
    /// their game balance. `key` makes it idempotent: a retry with the same key and details does nothing and
    /// returns false. Refused if the player is not seated or the table would pay out more than it locked.
    pub fn cash_out(&mut self, table_id: String, player: AccountId, amount: U128, key: String) -> bool {
        self.assert_operator();
        require!(!key.is_empty() && key.len() <= MAX_KEY_LEN, "the key is 1 to 128 characters");
        let key_id = format!("{table_id}:{key}");
        if let Some(done) = self.cash_outs.get(&key_id) {
            require!(done.player == player && done.amount == amount.0, "this key was used for a different cash-out");
            return false;
        }
        let mut t = self.table(&table_id);
        require!(!t.finalized, "the table is finalised");
        let seat = self.seats.remove(&seat_key(&table_id, &player)).unwrap_or_else(|| env::panic_str("the player is not seated at this table"));
        require!(t.paid + amount.0 <= t.locked, "pays out more than the table took in");
        t.paid += amount.0;
        t.seated -= 1;
        t.cash_outs += 1;
        t.last_operator_at = env::block_timestamp();
        self.totals.at_tables -= amount.0;
        self.credit(&player, amount.0);
        self.cash_outs.insert(key_id, CashOut { player: player.clone(), amount: amount.0, at: env::block_timestamp() });
        event(
            "cash_out",
            json!({
                "table": table_id, "player": player, "amount": amount, "key": key,
                "seat_bought_in": U128(seat.bought_in), "seat_locked": U128(seat.locked), "table_outstanding": U128(t.outstanding()),
            }),
        );
        if t.closed && t.seated == 0 {
            self.finalize(&table_id, &mut t);
        }
        self.tables.insert(table_id, t);
        true
    }

    /// The operator, or the host of a hosted table, closes it to new buy-ins. Seated players are still cashed out by
    /// the operator; the table is finalised once the last one leaves (at once if nobody is seated).
    pub fn close_table(&mut self, table_id: String) {
        let mut t = self.table(&table_id);
        let who = env::predecessor_account_id();
        require!(who == self.operator || t.host.as_ref() == Some(&who), "operator or host only");
        require!(!t.closed, "already closed");
        t.closed = true;
        if who == self.operator {
            t.last_operator_at = env::block_timestamp();
        }
        event(
            "table_closed",
            json!({ "table": table_id, "by": who, "seated": t.seated, "outstanding": U128(t.outstanding()) }),
        );
        if t.seated == 0 {
            self.finalize(&table_id, &mut t);
        }
        self.tables.insert(table_id, t);
    }

    /// A seated player takes their seat's locked amount back to their game balance once the operator has done
    /// nothing on the table for `reclaim_after`. Capped by what the table can still pay, so it never pays out more
    /// than it locked. The seat is removed. Returns the amount reclaimed.
    pub fn reclaim(&mut self, table_id: String) -> U128 {
        let who = env::predecessor_account_id();
        let mut t = self.table(&table_id);
        let idle = env::block_timestamp().saturating_sub(t.last_operator_at);
        require!(idle >= self.reclaim_after_ns, "the operator is still active at this table");
        let seat = self.seats.remove(&seat_key(&table_id, &who)).unwrap_or_else(|| env::panic_str("you are not seated at this table"));
        let amount = seat.locked.min(t.outstanding());
        t.paid += amount;
        t.seated -= 1;
        t.reclaims += 1;
        self.totals.at_tables -= amount;
        self.credit(&who, amount);
        event(
            "reclaimed",
            json!({
                "table": table_id, "player": who, "amount": U128(amount), "seat_bought_in": U128(seat.bought_in),
                "seat_locked": U128(seat.locked), "operator_idle_secs": idle / NS_PER_SEC, "table_outstanding": U128(t.outstanding()),
            }),
        );
        if t.closed && t.seated == 0 {
            self.finalize(&table_id, &mut t);
        }
        self.tables.insert(table_id, t);
        U128(amount)
    }

    pub fn get_table(&self, table_id: String) -> Option<TableView> {
        self.tables.get(&table_id).map(|t| TableView {
            table_id: table_id.clone(),
            host: t.host.clone(),
            config: t.config.clone(),
            invite_only: t.invites.is_some(),
            closed: t.closed,
            finalized: t.finalized,
            seated: t.seated,
            bought_in: U128(t.bought_in),
            rake: U128(t.rake),
            locked: U128(t.locked),
            paid: U128(t.paid),
            outstanding: U128(t.outstanding()),
            remainder: U128(t.remainder),
            buy_ins: t.buy_ins,
            cash_outs: t.cash_outs,
            reclaims: t.reclaims,
            created_at: U64(t.created_at),
            last_operator_at: U64(t.last_operator_at),
            reclaimable_at: U64(t.last_operator_at.saturating_add(self.reclaim_after_ns)),
        })
    }

    pub fn get_invites(&self, table_id: String) -> Option<Vec<AccountId>> {
        self.tables.get(&table_id).and_then(|t| t.invites.clone())
    }

    /// Whether `account` may buy in to the table (ignoring seats and limits).
    pub fn may_join(&self, table_id: String, account: AccountId) -> bool {
        self.tables.get(&table_id).map(|t| !t.closed && t.may_join(&account)).unwrap_or(false)
    }

    pub fn get_seat(&self, table_id: String, player: AccountId) -> Option<SeatView> {
        self.seats.get(&seat_key(&table_id, &player)).map(|s| SeatView { bought_in: U128(s.bought_in), locked: U128(s.locked) })
    }

    pub fn get_cash_out(&self, table_id: String, key: String) -> Option<CashOutView> {
        self.cash_outs.get(&format!("{table_id}:{key}")).map(|c| CashOutView { player: c.player.clone(), amount: U128(c.amount), at: U64(c.at) })
    }
}
