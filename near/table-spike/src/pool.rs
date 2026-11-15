//! Pooled backing: many backers share one pool per agent and own it through shares.
//!
//! - Joining mints shares at the pool's current value per share; leaving burns them and pays out at that value.
//! - While the pool has a session in play its value is unknown, so joins and leaves made then are queued and applied
//!   right after the session settles, at the new value. Nobody can trade the pool at a stale price.
//! - Fees are charged on gains above the pool's highest value per share (a high-water mark): 8% to the pro, 2% to
//!   the platform. The mark is per pool, not per backer: someone who joins after a drawdown is not charged on the
//!   recovery up to the old peak.
//! - A session stakes at most `max_buy_in_bps` of the pool's value (default 25%, at most 50%), so a pool can never
//!   be wiped out in one session.
//! - A pool sits in one session at a time.

use crate::vault::{agents, event, Split, MIN_DEPOSIT};
use crate::{Table, TableExt};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

/// Value per share is kept in units of 1e-9 yoctoNEAR so it fits in u128 even for large pools.
pub const PRICE_SCALE: u128 = 1_000_000_000;
pub const DEFAULT_MAX_BUY_IN_BPS: u32 = 2_500;
pub const MAX_BUY_IN_BPS_CAP: u32 = 5_000;
/// Below this value per share (a millionth of where it started) the pool takes no new money: minting shares at
/// a near-zero price would create absurd numbers of them. Its backers can still leave.
pub const MIN_PRICE: u128 = PRICE_SCALE / 1_000_000;
/// A pool worth less than this sits out.
pub const MIN_POOL_VALUE: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR

uint::construct_uint! {
    struct U256(4);
}

/// a * b / c without overflow: amounts and share counts are both up to ~1e27, so their product needs 256 bits.
pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    (U256::from(a) * U256::from(b) / U256::from(c)).as_u128()
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Pool {
    pub shares: u128,
    /// Idle funds.
    pub balance: u128,
    /// Bought in to the session in play.
    pub at_table: u128,
    /// Highest value per share after fees (scaled by PRICE_SCALE).
    pub hwm_price: u128,
    pub max_buy_in_bps: u32,
    pub fees_paid: u128,
    pub sessions: u32,
    /// Joins waiting for the session in play to settle: (account, yoctoNEAR held).
    pub pending_in: Vec<(AccountId, u128)>,
    /// Leaves waiting for the session in play to settle: (account, shares).
    pub pending_out: Vec<(AccountId, u128)>,
}

impl Default for Pool {
    fn default() -> Self {
        Pool { shares: 0, balance: 0, at_table: 0, hwm_price: PRICE_SCALE, max_buy_in_bps: DEFAULT_MAX_BUY_IN_BPS, fees_paid: 0, sessions: 0, pending_in: vec![], pending_out: vec![] }
    }
}

impl Pool {
    pub fn value(&self) -> u128 {
        self.balance + self.at_table
    }

    pub fn price(&self) -> u128 {
        if self.shares == 0 {
            PRICE_SCALE
        } else {
            mul_div(self.value(), PRICE_SCALE, self.shares)
        }
    }

    /// Whether new money may join at the current value.
    pub fn open_to_joins(&self) -> bool {
        self.shares == 0 || self.price() >= MIN_PRICE
    }

    pub fn in_play(&self) -> bool {
        self.at_table > 0
    }

    pub fn pending_out_of(&self, who: &AccountId) -> u128 {
        self.pending_out.iter().filter(|(a, _)| a == who).map(|(_, s)| s).sum()
    }

    pub fn pending_in_of(&self, who: &AccountId) -> u128 {
        self.pending_in.iter().filter(|(a, _)| a == who).map(|(_, s)| s).sum()
    }
}

/// Shares minted for `amount` at the pool's current value. The first deposit sets 1 share per yoctoNEAR.
pub fn mint(p: &mut Pool, amount: u128) -> u128 {
    let shares = if p.shares == 0 { amount } else { mul_div(amount, p.shares, p.value()) };
    p.shares += shares;
    p.balance += amount;
    shares
}

/// yoctoNEAR paid for `shares` at the pool's current value. Only while nothing is in play.
pub fn redeem(p: &mut Pool, shares: u128) -> u128 {
    assert!(!p.in_play() && shares <= p.shares);
    let amount = mul_div(shares, p.value(), p.shares);
    p.shares -= shares;
    p.balance -= amount;
    amount
}

pub fn can_seat(p: &Pool, buy_in: u128) -> Result<(), String> {
    if p.in_play() {
        return Err("the pool is already in a session".into());
    }
    if p.shares == 0 || p.value() < MIN_POOL_VALUE {
        return Err("the pool is empty or too small".into());
    }
    if buy_in * 10_000 > p.value() * p.max_buy_in_bps as u128 {
        return Err(format!("the buy-in is more than {}% of the pool", p.max_buy_in_bps / 100));
    }
    Ok(())
}

pub fn lock(p: &mut Pool, buy_in: u128) {
    p.balance -= buy_in;
    p.at_table += buy_in;
}

pub fn unlock(p: &mut Pool, buy_in: u128) {
    p.at_table -= buy_in;
    p.balance += buy_in;
}

/// Settles the pool's seat. Fees come only from this session's gain, and only from the part that lifts the value
/// per share above its previous peak.
pub fn settle(p: &mut Pool, buy_in: u128, cash_out: u128, pro_bps: u32, platform_bps: u32) -> Split {
    let gross = cash_out as i128 - buy_in as i128;
    p.at_table -= buy_in;
    let value_now = p.balance + cash_out;
    let price_now = mul_div(value_now, PRICE_SCALE, p.shares);
    let gain = cash_out.saturating_sub(buy_in);
    let fee_base = if price_now > p.hwm_price { gain.min(mul_div(price_now - p.hwm_price, p.shares, PRICE_SCALE)) } else { 0 };
    let pro_fee = fee_base * pro_bps as u128 / 10_000;
    let platform_fee = fee_base * platform_bps as u128 / 10_000;
    let to_backer = cash_out - pro_fee - platform_fee;
    p.balance += to_backer;
    p.hwm_price = p.hwm_price.max(p.price());
    p.fees_paid += pro_fee + platform_fee;
    p.sessions += 1;
    Split { gross, fee_base, pro_fee, platform_fee, to_backer }
}

pub(crate) fn pools() -> LookupMap<String, Pool> {
    LookupMap::new(b"o")
}

pub(crate) fn holdings() -> LookupMap<String, u128> {
    LookupMap::new(b"h")
}

pub fn holding_key(who: &AccountId, agent_id: &str) -> String {
    format!("{who}:{agent_id}")
}

/// Applies queued leaves, then queued joins, at the pool's settled value. Returns the payouts to send.
pub(crate) fn apply_pending(p: &mut Pool, agent_id: &str, held: &mut LookupMap<String, u128>) -> (Vec<(AccountId, u128)>, Vec<Value>) {
    let mut payouts = vec![];
    let mut log = vec![];
    for (who, shares) in std::mem::take(&mut p.pending_out) {
        let key = holding_key(&who, agent_id);
        let own = held.get(&key).copied().unwrap_or(0);
        let shares = shares.min(own);
        if shares == 0 {
            continue;
        }
        let amount = redeem(p, shares);
        held.insert(key, own - shares);
        log.push(json!({ "account": who, "left_shares": U128(shares), "paid": U128(amount) }));
        payouts.push((who, amount));
    }
    for (who, amount) in std::mem::take(&mut p.pending_in) {
        if !p.open_to_joins() {
            log.push(json!({ "account": who, "refunded": U128(amount), "reason": "the pool lost too much to take new money" }));
            payouts.push((who, amount));
            continue;
        }
        let shares = mint(p, amount);
        *held.entry(holding_key(&who, agent_id)).or_insert(0) += shares;
        log.push(json!({ "account": who, "joined": U128(amount), "shares": U128(shares) }));
    }
    (payouts, log)
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PoolView {
    pub shares: U128,
    pub balance: U128,
    pub at_table: U128,
    pub value: U128,
    /// yoctoNEAR per share, scaled by 1e9.
    pub price: U128,
    pub hwm_price: U128,
    pub max_buy_in_bps: u32,
    pub fees_paid: U128,
    pub sessions: u32,
    pub pending_in: U128,
    pub pending_out_shares: U128,
}

impl From<&Pool> for PoolView {
    fn from(p: &Pool) -> Self {
        PoolView {
            shares: U128(p.shares),
            balance: U128(p.balance),
            at_table: U128(p.at_table),
            value: U128(p.value()),
            price: U128(p.price()),
            hwm_price: U128(p.hwm_price),
            max_buy_in_bps: p.max_buy_in_bps,
            fees_paid: U128(p.fees_paid),
            sessions: p.sessions,
            pending_in: U128(p.pending_in.iter().map(|(_, a)| a).sum()),
            pending_out_shares: U128(p.pending_out.iter().map(|(_, s)| s).sum()),
        }
    }
}

#[near]
impl Table {
    /// Joins an agent's pool with the attached NEAR. Shares are minted now, or right after the pool's session in
    /// play settles.
    #[payable]
    pub fn join_pool(&mut self, agent_id: String) -> Value {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount >= MIN_DEPOSIT, "deposit at least 0.01 NEAR");
        let who = env::predecessor_account_id();
        let agent = agents().get(&agent_id).cloned().unwrap_or_else(|| env::panic_str("no such agent"));
        crate::strategy::require_listed(&agent, &who);
        let mut all = pools();
        let p = all.entry(agent_id.clone()).or_default();
        require!(p.open_to_joins(), "this pool lost too much to take new money; its backers can still leave");
        let out = if p.in_play() {
            p.pending_in.push((who.clone(), amount));
            json!({ "queued": true, "amount": U128(amount) })
        } else {
            let shares = mint(p, amount);
            let mut held = holdings();
            *held.entry(holding_key(&who, &agent_id)).or_insert(0) += shares;
            held.flush();
            json!({ "queued": false, "shares": U128(shares) })
        };
        all.flush();
        event("pool_joined", json!({ "account": who, "agent": agent_id, "amount": U128(amount), "result": out }));
        out
    }

    /// Leaves an agent's pool: pays out `shares` now, or right after the pool's session in play settles.
    pub fn leave_pool(&mut self, agent_id: String, shares: U128) -> Value {
        let who = env::predecessor_account_id();
        let key = holding_key(&who, &agent_id);
        let mut held = holdings();
        let own = held.get(&key).copied().unwrap_or(0);
        let mut all = pools();
        let p = all.get_mut(&agent_id).unwrap_or_else(|| env::panic_str("no pool"));
        require!(shares.0 > 0 && shares.0 + p.pending_out_of(&who) <= own, "more shares than you hold");
        let out = if p.in_play() {
            p.pending_out.push((who.clone(), shares.0));
            json!({ "queued": true, "shares": shares })
        } else {
            let amount = redeem(p, shares.0);
            held.insert(key, own - shares.0);
            Promise::new(who.clone()).transfer(NearToken::from_yoctonear(amount)).detach();
            json!({ "queued": false, "paid": U128(amount) })
        };
        all.flush();
        held.flush();
        event("pool_left", json!({ "account": who, "agent": agent_id, "shares": shares, "result": out }));
        out
    }

    /// The pro sets how much of the pool one session may stake (basis points, at most 50%).
    pub fn set_pool_risk(&mut self, agent_id: String, max_buy_in_bps: u32) {
        let agent = agents().get(&agent_id).cloned().unwrap_or_else(|| env::panic_str("no such agent"));
        require!(env::predecessor_account_id() == agent.owner, "only the agent's pro");
        require!(max_buy_in_bps > 0 && max_buy_in_bps <= MAX_BUY_IN_BPS_CAP, "1 to 5000 basis points");
        let mut all = pools();
        all.entry(agent_id).or_default().max_buy_in_bps = max_buy_in_bps;
        all.flush();
    }

    pub fn get_pool(&self, agent_id: String) -> Option<PoolView> {
        pools().get(&agent_id).map(PoolView::from)
    }

    /// An account's share of a pool: shares held, their value now, and anything queued.
    pub fn get_holding(&self, account: AccountId, agent_id: String) -> Value {
        let shares = holdings().get(&holding_key(&account, &agent_id)).copied().unwrap_or(0);
        let all = pools();
        let p = all.get(&agent_id);
        let value = p.filter(|p| p.shares > 0).map(|p| mul_div(shares, p.value(), p.shares)).unwrap_or(0);
        json!({
            "shares": U128(shares),
            "value": U128(value),
            "pending_in": U128(p.map(|p| p.pending_in_of(&account)).unwrap_or(0)),
            "pending_out_shares": U128(p.map(|p| p.pending_out_of(&account)).unwrap_or(0)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    #[test]
    fn shares_follow_value() {
        let mut p = Pool::default();
        assert_eq!(mint(&mut p, NEAR), NEAR);
        // The pool doubles in value: a second NEAR buys half as many shares.
        p.balance += NEAR;
        assert_eq!(mint(&mut p, NEAR), NEAR / 2);
        // Each share is now worth 2: redeeming the second backer's shares returns their NEAR.
        assert_eq!(redeem(&mut p, NEAR / 2), NEAR);
        assert_eq!(p.value(), 2 * NEAR);
    }

    #[test]
    fn fees_only_above_the_peak_and_never_more_than_the_gain() {
        let mut p = Pool::default();
        mint(&mut p, NEAR);
        // Lose 0.1, then win 0.1 back: no fees.
        lock(&mut p, NEAR / 4);
        assert_eq!(settle(&mut p, NEAR / 4, NEAR / 4 - NEAR / 10, 800, 200).fee_base, 0);
        lock(&mut p, NEAR / 4);
        assert_eq!(settle(&mut p, NEAR / 4, NEAR / 4 + NEAR / 10, 800, 200).fee_base, 0);
        // Win 0.05 more: fees on 0.05 only.
        lock(&mut p, NEAR / 4);
        let s = settle(&mut p, NEAR / 4, NEAR / 4 + NEAR / 20, 800, 200);
        assert!(s.fee_base <= NEAR / 20 && s.fee_base >= NEAR / 20 - 1);
        assert_eq!(s.pro_fee, s.fee_base * 8 / 100);
        assert_eq!(p.value(), NEAR + NEAR / 20 - s.pro_fee - s.platform_fee);
    }

    #[test]
    fn a_pool_that_lost_almost_everything_takes_no_new_money() {
        let mut p = Pool::default();
        mint(&mut p, NEAR);
        // Lose 25% per session until a share is worth under a millionth of its start.
        while p.price() >= MIN_PRICE {
            let buy_in = p.value() / 4;
            lock(&mut p, buy_in);
            settle(&mut p, buy_in, 0, 800, 200);
        }
        assert!(!p.open_to_joins());
        assert!(can_seat(&p, 1).is_err(), "and it is too small to sit");
        // Its backer can still take out what is left.
        let left = p.value();
        assert_eq!(redeem(&mut p, NEAR), left);
    }

    #[test]
    fn a_session_risks_at_most_the_cap_and_one_session_at_a_time() {
        let mut p = Pool::default();
        mint(&mut p, NEAR);
        assert!(can_seat(&p, NEAR / 4).is_ok());
        assert!(can_seat(&p, NEAR / 4 + 1).is_err());
        lock(&mut p, NEAR / 4);
        assert!(can_seat(&p, 1).is_err());
        assert!(can_seat(&Pool::default(), 1).is_err(), "an empty pool sits out");
    }

    #[test]
    fn money_is_conserved_over_many_sessions_with_joins_and_leaves() {
        let mut p = Pool::default();
        let mut held: std::collections::HashMap<u8, u128> = Default::default();
        let mut paid_in = 0i128;
        let mut fees = 0u128;
        let mut x: u64 = 11;
        // Uniform in 0..m for any m, from a 53-bit fraction.
        let mut rnd = |m: u128| {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((x >> 11) as f64 / (1u64 << 53) as f64 * m as f64) as u128
        };
        for round in 0..1500 {
            let who = (round % 5) as u8;
            if (rnd(3) == 0 || p.shares == 0) && p.open_to_joins() {
                let amount = NEAR / 10 + rnd(NEAR);
                let s = mint(&mut p, amount);
                *held.entry(who).or_default() += s;
                paid_in += amount as i128;
            } else if rnd(4) == 0 {
                let own = held.get(&who).copied().unwrap_or(0);
                if own > 0 {
                    let s = own / 2 + 1;
                    let amount = redeem(&mut p, s.min(own));
                    *held.get_mut(&who).unwrap() -= s.min(own);
                    paid_in -= amount as i128;
                }
            }
            if p.shares > 0 && p.value() > 0 {
                let buy_in = p.value() * p.max_buy_in_bps as u128 / 10_000;
                if can_seat(&p, buy_in).is_ok() {
                    lock(&mut p, buy_in);
                    // A fair game: on average the pool gets its stake back.
                    let cash_out = rnd(buy_in * 2 + 1);
                    let s = settle(&mut p, buy_in, cash_out, 800, 200);
                    assert!(s.pro_fee + s.platform_fee <= cash_out.saturating_sub(buy_in));
                    fees += s.pro_fee + s.platform_fee;
                    paid_in += cash_out as i128 - buy_in as i128;
                }
            }
            assert_eq!(held.values().sum::<u128>(), p.shares, "round {round}");
            assert_eq!(p.value() as i128 + fees as i128, paid_in, "round {round}");
        }
    }
}
