//! Nomad Poker escrow: holds players' stakes for human tables, hosted tables and tournaments.
//!
//! The table server deals and runs the games off-chain at normal speed and is trusted to report results (it is the
//! "operator"). This contract holds the money and makes sure that:
//! - a player only ever withdraws idle funds, never money bought in to a table or entered in a tournament;
//! - a table never pays out more than it took in after the rake;
//! - each table result is recorded once, however often the operator retries;
//! - every step logs a `nomad-escrow` event, so anyone can audit the money flow.
//!
//! Money is NEAR in yoctoNEAR. Chips are whole numbers worth `chip_yocto` each (0.001 NEAR by default); table
//! limits are in chips, buy-ins must be a whole number of chips.
//!
//! The contract pays for its own storage, like the table spike.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

mod tables;
mod tournaments;
#[cfg(test)]
mod tests;

pub use tables::{CashOutView, SeatView, TableConfig, TableView};
pub use tournaments::{TournamentStatus, TournamentView};

/// 5% of every buy-in.
pub const DEFAULT_RAKE_BPS: u32 = 500;
/// 5% of every tournament's entries.
pub const DEFAULT_TOURNAMENT_FEE_BPS: u32 = 500;
/// The owner can never set a fee above 20%.
pub const MAX_FEE_BPS: u32 = 2_000;
/// 1 chip = 0.001 NEAR.
pub const DEFAULT_CHIP_YOCTO: u128 = 1_000_000_000_000_000_000_000;
const PAYOUT_CALLBACK_GAS: Gas = Gas::from_tgas(5);

uint::construct_uint! {
    struct U256(4);
}

/// a * b / c, rounded down, with a 256-bit product so it can never overflow.
pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    (U256::from(a) * U256::from(b) / U256::from(c)).as_u128()
}

/// `bps` basis points of `amount`, rounded down.
pub fn bps_of(amount: u128, bps: u32) -> u128 {
    mul_div(amount, bps as u128, 10_000)
}

pub(crate) fn event(name: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "nomad-escrow", "version": "1.0.0", "event": name, "data": [data] })));
}

/// Table and tournament ids: 1 to 64 characters of a-z, 0-9, `-`, `_` and `.`, so they can share a key with an
/// account id after a `:`.
pub(crate) fn check_id(id: &str) {
    require!(
        !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.".contains(&b)),
        "ids are 1 to 64 characters of a-z, 0-9, '-', '_' and '.'"
    );
}

#[derive(BorshStorageKey)]
#[near]
enum Prefix {
    Balances,
    Tables,
    Seats,
    CashOuts,
    Tournaments,
}

/// Running totals. At every moment
/// `balances + at_tables + in_tournaments + platform_earnings == deposited - withdrawn`.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Totals {
    pub deposited: u128,
    /// Sent out to players and the platform (including transfers still in flight; a failed one is added back).
    pub withdrawn: u128,
    /// Idle game balances.
    pub balances: u128,
    /// Bought in to tables after rake, not yet paid out.
    pub at_tables: u128,
    /// Tournament entry fees and host prizes not yet paid out or refunded.
    pub in_tournaments: u128,
    /// Platform earnings not yet claimed.
    pub platform_earnings: u128,
    /// Platform earnings ever taken: rake, tournament fees and table remainders.
    pub platform_earned: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TotalsView {
    pub deposited: U128,
    pub withdrawn: U128,
    pub balances: U128,
    pub at_tables: U128,
    pub in_tournaments: U128,
    pub platform_earnings: U128,
    pub platform_earned: U128,
}

impl From<&Totals> for TotalsView {
    fn from(t: &Totals) -> Self {
        TotalsView {
            deposited: U128(t.deposited),
            withdrawn: U128(t.withdrawn),
            balances: U128(t.balances),
            at_tables: U128(t.at_tables),
            in_tournaments: U128(t.in_tournaments),
            platform_earnings: U128(t.platform_earnings),
            platform_earned: U128(t.platform_earned),
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ConfigView {
    pub owner: AccountId,
    pub operator: AccountId,
    pub rake_bps: u32,
    pub tournament_fee_bps: u32,
    pub chip_yocto: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Escrow {
    pub(crate) owner: AccountId,
    /// The table server: the only account that records table and tournament results.
    pub(crate) operator: AccountId,
    pub(crate) rake_bps: u32,
    pub(crate) tournament_fee_bps: u32,
    pub(crate) chip_yocto: u128,
    pub(crate) balances: LookupMap<AccountId, u128>,
    pub(crate) tables: LookupMap<String, tables::Table>,
    /// `{table_id}:{player}` -> what that player has bought in and not yet cashed out.
    pub(crate) seats: LookupMap<String, tables::Seat>,
    /// `{table_id}:{key}` -> the cash-out recorded under that idempotency key.
    pub(crate) cash_outs: LookupMap<String, tables::CashOut>,
    pub(crate) tournaments: LookupMap<String, tournaments::Tournament>,
    pub(crate) totals: Totals,
}

#[near]
impl Escrow {
    #[init]
    pub fn new(operator: AccountId) -> Self {
        Self {
            owner: env::predecessor_account_id(),
            operator,
            rake_bps: DEFAULT_RAKE_BPS,
            tournament_fee_bps: DEFAULT_TOURNAMENT_FEE_BPS,
            chip_yocto: DEFAULT_CHIP_YOCTO,
            balances: LookupMap::new(Prefix::Balances),
            tables: LookupMap::new(Prefix::Tables),
            seats: LookupMap::new(Prefix::Seats),
            cash_outs: LookupMap::new(Prefix::CashOuts),
            tournaments: LookupMap::new(Prefix::Tournaments),
            totals: Totals::default(),
        }
    }

    // ------------------------------------------------------------------------------------------------- owner

    pub(crate) fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    pub(crate) fn assert_operator(&self) {
        require!(env::predecessor_account_id() == self.operator, "operator only");
    }

    pub fn set_operator(&mut self, operator: AccountId) {
        self.assert_owner();
        event("operator_set", json!({ "old": self.operator, "new": operator }));
        self.operator = operator;
    }

    pub fn set_owner(&mut self, owner: AccountId) {
        self.assert_owner();
        event("owner_set", json!({ "old": self.owner, "new": owner }));
        self.owner = owner;
    }

    /// Fees in basis points (500 = 5%), at most 20%. A change applies to later buy-ins and settlements.
    pub fn set_fees(&mut self, rake_bps: Option<u32>, tournament_fee_bps: Option<u32>) {
        self.assert_owner();
        if let Some(b) = rake_bps {
            require!(b <= MAX_FEE_BPS, "fee above 20%");
            self.rake_bps = b;
        }
        if let Some(b) = tournament_fee_bps {
            require!(b <= MAX_FEE_BPS, "fee above 20%");
            self.tournament_fee_bps = b;
        }
        event("fees_set", json!({ "rake_bps": self.rake_bps, "tournament_fee_bps": self.tournament_fee_bps }));
    }

    /// Pays unclaimed platform earnings (all of them by default) to the owner.
    pub fn claim_platform_earnings(&mut self, amount: Option<U128>) -> Promise {
        self.assert_owner();
        let amount = amount.map(|a| a.0).unwrap_or(self.totals.platform_earnings);
        require!(amount > 0 && amount <= self.totals.platform_earnings, "more than the unclaimed platform earnings");
        self.totals.platform_earnings -= amount;
        self.totals.withdrawn += amount;
        let to = self.owner.clone();
        event("platform_earnings_claimed", json!({ "account": to, "amount": U128(amount) }));
        Promise::new(to.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(PAYOUT_CALLBACK_GAS).on_payout(to, U128(amount), true))
    }

    // ---------------------------------------------------------------------------------------- game balance

    pub(crate) fn balance_of(&self, who: &AccountId) -> u128 {
        self.balances.get(who).copied().unwrap_or(0)
    }

    pub(crate) fn credit(&mut self, who: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        *self.balances.entry(who.clone()).or_insert(0) += amount;
        self.totals.balances += amount;
    }

    pub(crate) fn debit(&mut self, who: &AccountId, amount: u128) {
        let have = self.balance_of(who);
        require!(amount <= have, "not enough idle game balance");
        if amount == have {
            self.balances.remove(who);
        } else {
            self.balances.insert(who.clone(), have - amount);
        }
        self.totals.balances -= amount;
    }

    /// Adds the attached deposit to the caller's game balance and returns it.
    pub(crate) fn take_deposit(&mut self) -> u128 {
        let amount = env::attached_deposit().as_yoctonear();
        if amount > 0 {
            let who = env::predecessor_account_id();
            self.credit(&who, amount);
            self.totals.deposited += amount;
            event("deposited", json!({ "account": who, "amount": U128(amount), "balance": U128(self.balance_of(&who)) }));
        }
        amount
    }

    /// Takes `amount` (by default the attached deposit) from the caller: the attached deposit first goes to their
    /// game balance, then the amount comes out of it. Anything attached beyond the amount stays as game balance.
    pub(crate) fn fund(&mut self, amount: Option<U128>) -> u128 {
        let attached = self.take_deposit();
        let amount = amount.map(|a| a.0).unwrap_or(attached);
        self.debit(&env::predecessor_account_id(), amount);
        amount
    }

    /// Adds the attached NEAR to the caller's game balance. Returns the new balance.
    #[payable]
    pub fn deposit(&mut self) -> U128 {
        require!(env::attached_deposit().as_yoctonear() > 0, "attach NEAR to deposit");
        self.take_deposit();
        U128(self.balance_of(&env::predecessor_account_id()))
    }

    /// Withdraws idle game balance. Money at a table or in a tournament stays put.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        let who = env::predecessor_account_id();
        require!(amount.0 > 0, "nothing to withdraw");
        self.debit(&who, amount.0);
        self.totals.withdrawn += amount.0;
        event("withdrawn", json!({ "account": who, "amount": amount, "balance": U128(self.balance_of(&who)) }));
        Promise::new(who.clone())
            .transfer(NearToken::from_yoctonear(amount.0))
            .then(Self::ext(env::current_account_id()).with_static_gas(PAYOUT_CALLBACK_GAS).on_payout(who, amount, false))
    }

    /// Puts the money back if a withdrawal or earnings claim failed to arrive.
    #[private]
    pub fn on_payout(&mut self, account: AccountId, amount: U128, platform: bool, #[callback_result] result: Result<(), PromiseError>) -> bool {
        if result.is_ok() {
            return true;
        }
        self.totals.withdrawn -= amount.0;
        if platform {
            self.totals.platform_earnings += amount.0;
        } else {
            self.credit(&account, amount.0);
        }
        event("payout_failed", json!({ "account": account, "amount": amount, "platform": platform }));
        false
    }

    // ------------------------------------------------------------------------------------------------- views

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            operator: self.operator.clone(),
            rake_bps: self.rake_bps,
            tournament_fee_bps: self.tournament_fee_bps,
            chip_yocto: U128(self.chip_yocto),
        }
    }

    /// Idle game balance: what `withdraw` can take.
    pub fn get_balance(&self, account: AccountId) -> U128 {
        U128(self.balance_of(&account))
    }

    pub fn get_platform_earnings(&self) -> U128 {
        U128(self.totals.platform_earnings)
    }

    pub fn get_totals(&self) -> TotalsView {
        TotalsView::from(&self.totals)
    }
}
