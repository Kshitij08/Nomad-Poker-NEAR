//! The backing vault: anyone funds a pro's agent and keeps 90% of what it wins.
//!
//! - A pro registers an agent (its strategy profile). The registering account receives the pro's share.
//! - A backer funds a position on an agent: a NEAR balance and a loss limit, one position per backer and agent.
//! - A backed session buys each seat in from its position. A seat can lose at most its buy-in, so a position is only
//!   seated if losing the whole buy-in keeps its total result within the loss limit.
//! - When the session settles, each seat cashes out. Fees are charged only on profit above the position's previous
//!   peak (a high-water mark): 8% to the pro, 2% to the platform, the rest back to the backer's balance.
//!
//! Money is NEAR in yoctoNEAR; chips convert at `chip_yocto` per chip.

use crate::pool::{self, pools, holdings};
use crate::strategy::{self, AgentView};
use crate::{sessions, SessionResult, Status, Table, TableExt};
use poker_core::profile::Profile;
use near_sdk::json_types::{I128, U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};
use poker_core::{self as core, game};

pub const DEFAULT_PRO_BPS: u32 = 800;
pub const DEFAULT_PLATFORM_BPS: u32 = 200;
/// 1 chip = 0.001 NEAR unless the owner changes it.
pub const DEFAULT_CHIP_YOCTO: u128 = 1_000_000_000_000_000_000_000;
pub const MIN_DEPOSIT: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR
/// A backed session the dealer never answered can be cancelled, returning buy-ins, after this long.
pub const CANCEL_AFTER_NS: u64 = 60 * 60 * 1_000_000_000;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct VaultConfig {
    pub chip_yocto: U128,
    pub pro_bps: u32,
    pub platform_bps: u32,
    /// Receives the platform's share.
    pub platform: AccountId,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Agent {
    pub id: String,
    /// The pro: registered the agent and receives the pro's share of profits.
    pub owner: AccountId,
    pub tight: u8,
    pub aggro: u8,
    pub sessions: u32,
    pub hands: u64,
    /// Chips won or lost over all backed sessions.
    pub net_chips: i64,
    pub created_at: U64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Position {
    /// Idle funds the backer can withdraw or put at a table.
    pub balance: u128,
    /// Funds bought in to a session that has not settled yet.
    pub at_table: u128,
    /// Total result before fees over all settled sessions.
    pub net: i128,
    /// The highest `net` reached; fees are charged only above it.
    pub high_water: i128,
    /// The most the position may lose in total.
    pub loss_limit: u128,
    pub deposited: u128,
    pub withdrawn: u128,
    pub fees_paid: u128,
    pub sessions: u32,
}

/// A position as views return it: amounts as strings, since yoctoNEAR does not fit a JavaScript number.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PositionView {
    pub balance: U128,
    pub at_table: U128,
    pub net: I128,
    pub high_water: I128,
    pub loss_limit: U128,
    pub deposited: U128,
    pub withdrawn: U128,
    pub fees_paid: U128,
    pub sessions: u32,
}

impl From<&Position> for PositionView {
    fn from(p: &Position) -> Self {
        PositionView {
            balance: U128(p.balance),
            at_table: U128(p.at_table),
            net: I128(p.net),
            high_water: I128(p.high_water),
            loss_limit: U128(p.loss_limit),
            deposited: U128(p.deposited),
            withdrawn: U128(p.withdrawn),
            fees_paid: U128(p.fees_paid),
            sessions: p.sessions,
        }
    }
}

/// A seat in a backed session.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct BackedSeat {
    /// The backer whose position buys the seat in; none for the agent's pool.
    #[serde(default)]
    pub backer: Option<AccountId>,
    pub agent_id: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct BackedSession {
    pub seats: Vec<BackedSeat>,
    pub buy_in_chips: u64,
    /// The chip value when the session opened; settlement uses the same.
    pub chip_yocto: U128,
}

/// One seat's settlement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Split {
    /// Cash-out minus buy-in.
    pub gross: i128,
    /// Profit above the previous peak.
    pub fee_base: u128,
    pub pro_fee: u128,
    pub platform_fee: u128,
    /// What goes back to the backer's balance: cash-out minus fees.
    pub to_backer: u128,
}

/// Can this position be seated with this buy-in?
pub fn can_seat(p: &Position, buy_in: u128) -> Result<(), String> {
    if p.balance < buy_in {
        return Err(format!("balance {} is below the buy-in {}", p.balance, buy_in));
    }
    if p.net - (buy_in as i128) < -(p.loss_limit as i128) {
        return Err("losing this buy-in could exceed the loss limit".into());
    }
    Ok(())
}

pub fn lock(p: &mut Position, buy_in: u128) {
    p.balance -= buy_in;
    p.at_table += buy_in;
}

pub fn unlock(p: &mut Position, buy_in: u128) {
    p.at_table -= buy_in;
    p.balance += buy_in;
}

/// Settles one seat. Fees are taken only on profit above the high-water mark, so a backer who lost 100 and then
/// won 100 back pays nothing. The fee base never exceeds the cash-out: the previous `net` was at or below the peak,
/// so profit above the peak is at most this session's gain.
pub fn settle(p: &mut Position, buy_in: u128, cash_out: u128, pro_bps: u32, platform_bps: u32) -> Split {
    let gross = cash_out as i128 - buy_in as i128;
    let net = p.net + gross;
    let fee_base = if net > p.high_water { (net - p.high_water) as u128 } else { 0 };
    let pro_fee = fee_base * pro_bps as u128 / 10_000;
    let platform_fee = fee_base * platform_bps as u128 / 10_000;
    let to_backer = cash_out - pro_fee - platform_fee;
    p.at_table -= buy_in;
    p.balance += to_backer;
    p.net = net;
    p.high_water = p.high_water.max(net);
    p.fees_paid += pro_fee + platform_fee;
    p.sessions += 1;
    Split { gross, fee_base, pro_fee, platform_fee, to_backer }
}

const CONFIG_KEY: &[u8] = b"c";

/// Read directly: `LazyOption::new(key, None)` caches None and never reads storage, so a config set before this
/// version was never applied (none was set on testnet).
fn stored_config() -> Option<VaultConfig> {
    env::storage_read(CONFIG_KEY).and_then(|b| near_sdk::borsh::from_slice::<VaultConfig>(&b).ok())
}
pub(crate) fn agents() -> LookupMap<String, Agent> {
    LookupMap::new(b"a")
}
fn positions() -> LookupMap<String, Position> {
    LookupMap::new(b"p")
}
fn earnings() -> LookupMap<AccountId, u128> {
    LookupMap::new(b"e")
}
fn backed() -> LookupMap<String, BackedSession> {
    LookupMap::new(b"b")
}

pub fn position_key(backer: &AccountId, agent_id: &str) -> String {
    format!("{backer}:{agent_id}")
}

fn valid_agent_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub(crate) fn event(name: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "nomad-vault", "version": "1.0.0", "event": name, "data": [data] })));
}

impl Table {
    fn vault_config(&self) -> VaultConfig {
        stored_config().unwrap_or(VaultConfig {
            chip_yocto: U128(DEFAULT_CHIP_YOCTO),
            pro_bps: DEFAULT_PRO_BPS,
            platform_bps: DEFAULT_PLATFORM_BPS,
            platform: self.owner.clone(),
        })
    }

    /// Pays out every backed seat of a session that just verified. Returns each seat's split, or None for a
    /// session without backing.
    /// `order`: the session was seated from its randomness; table position p is listed seat `order[p]`, and
    /// `r` is by table position. Payout seats are reported by table position.
    pub(crate) fn settle_backed(&mut self, session_id: &str, r: &SessionResult, order: Option<&[usize]>) -> Option<Value> {
        let mut all = backed();
        let mut b = all.remove(session_id)?;
        let mut vers = strategy::session_versions();
        let mut versions = vers.remove(session_id);
        vers.flush();
        if let Some(o) = order {
            b.seats = core::session::seat(&b.seats, o);
            versions = versions.map(|v| core::session::seat(&v, o));
        }
        let cfg = self.vault_config();
        let buy_in = b.buy_in_chips as u128 * b.chip_yocto.0;
        let mut pos = positions();
        let mut ags = agents();
        let mut earn = earnings();
        let mut pls = pools();
        let mut held = holdings();
        let mut transfers: Vec<(AccountId, u128)> = vec![];
        let mut seats = Vec::new();
        for (i, seat) in b.seats.iter().enumerate() {
            let cash_out = r.stacks[i] as u128 * b.chip_yocto.0;
            let mut pool_moves = Value::Null;
            let s = match &seat.backer {
                Some(backer) => {
                    let p = pos.get_mut(&position_key(backer, &seat.agent_id)).unwrap_or_else(|| env::panic_str("position missing"));
                    settle(p, buy_in, cash_out, cfg.pro_bps, cfg.platform_bps)
                }
                None => {
                    let pl = pls.get_mut(&seat.agent_id).unwrap_or_else(|| env::panic_str("pool missing"));
                    let s = pool::settle(pl, buy_in, cash_out, cfg.pro_bps, cfg.platform_bps);
                    // Joins and leaves queued during the session now happen at the settled value.
                    let (pay, log) = pool::apply_pending(pl, &seat.agent_id, &mut held);
                    transfers.extend(pay);
                    pool_moves = json!(log);
                    s
                }
            };
            let agent = ags.get_mut(&seat.agent_id).unwrap_or_else(|| env::panic_str("agent missing"));
            agent.sessions += 1;
            agent.hands += r.hands_played as u64;
            agent.net_chips += r.totals[i];
            strategy::count_session(agent, versions.as_ref().and_then(|v| v.get(i).copied()), r.hands_played);
            let pro = agent.owner.clone();
            if s.pro_fee > 0 {
                *earn.entry(pro.clone()).or_insert(0) += s.pro_fee;
            }
            if s.platform_fee > 0 {
                *earn.entry(cfg.platform.clone()).or_insert(0) += s.platform_fee;
            }
            seats.push(json!({
                "backer": seat.backer, "agent": seat.agent_id, "pro": pro,
                "buy_in": U128(buy_in), "cash_out": U128(cash_out),
                "pro_fee": U128(s.pro_fee), "platform_fee": U128(s.platform_fee), "to_backer": U128(s.to_backer),
                "pool_moves": pool_moves,
            }));
        }
        all.flush();
        pos.flush();
        ags.flush();
        earn.flush();
        pls.flush();
        held.flush();
        for (who, amount) in transfers {
            Promise::new(who).transfer(NearToken::from_yoctonear(amount)).detach();
        }
        let data = json!({ "session_id": session_id, "seats": seats });
        event("session_settled", data.clone());
        Some(data)
    }
}

#[near]
impl Table {
    pub fn set_vault_config(&mut self, chip_yocto: U128, pro_bps: u32, platform_bps: u32, platform: AccountId) {
        self.require_owner();
        require!(chip_yocto.0 > 0 && pro_bps + platform_bps <= 5_000, "bad config");
        env::storage_write(CONFIG_KEY, &near_sdk::borsh::to_vec(&VaultConfig { chip_yocto, pro_bps, platform_bps, platform }).unwrap());
    }

    pub fn get_vault_config(&self) -> VaultConfig {
        self.vault_config()
    }

    /// A pro lists an agent with its strategy: a v2 `profile` (the Nomad app's Strategy tab), or the first-generation
    /// `tight` and `aggro` (0 to 100), which play the v2 profile they map to. The registering account is the pro.
    pub fn register_agent(&mut self, agent_id: String, profile: Option<Profile>, tight: Option<u8>, aggro: Option<u8>) -> AgentView {
        require!(valid_agent_id(&agent_id), "agent id: 1 to 32 of a-z, 0-9, -");
        let profile = match (profile, tight, aggro) {
            (Some(p), _, _) => strategy::checked(p),
            (None, Some(t), Some(a)) => {
                require!(t <= 100 && a <= 100, "profile values are 0 to 100");
                Profile::from_legacy(t, a)
            }
            _ => env::panic_str("give a profile, or tight and aggro"),
        };
        let mut all = agents();
        require!(!all.contains_key(&agent_id), "agent id taken");
        let owner = env::predecessor_account_id();
        let (tight, aggro) = match (tight, aggro) {
            (Some(t), Some(a)) => (t, a),
            _ => profile.legacy_view(),
        };
        let a = Agent { id: agent_id.clone(), owner: owner.clone(), tight, aggro, sessions: 0, hands: 0, net_chips: 0, created_at: U64(env::block_timestamp()) };
        all.insert(agent_id.clone(), a.clone());
        all.flush();
        let x = strategy::AgentExt { profile_json: strategy::canonical(&profile), version: 1, version_sessions: 0, version_hands: 0, updated_at: env::block_timestamp(), pool_loss_limit_bps: None };
        strategy::save_ext(&agent_id, x.clone());
        crate::history::index_agent(&agent_id);
        event("agent_registered", json!({ "agent": agent_id, "pro": owner, "strategy_version": 1 }));
        strategy::agent_view(&a, &x)
    }

    /// The agent with its v2 profile and strategy version (and the nearest `tight`/`aggro` for older clients).
    pub fn get_agent(&self, agent_id: String) -> Option<AgentView> {
        agents().get(&agent_id).map(|a| strategy::agent_view(a, &strategy::ext_of(a)))
    }

    /// Back an agent: the attached NEAR goes into this account's position on it. `loss_limit` (yoctoNEAR) caps how
    /// much the position may lose in total; it is set on the first deposit and may be changed later.
    #[payable]
    pub fn back(&mut self, agent_id: String, loss_limit: Option<U128>) -> PositionView {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount >= MIN_DEPOSIT, "deposit at least 0.01 NEAR");
        let backer = env::predecessor_account_id();
        let agent = agents().get(&agent_id).cloned().unwrap_or_else(|| env::panic_str("no such agent"));
        strategy::require_listed(&agent, &backer);
        let mut all = positions();
        let p = all.entry(position_key(&backer, &agent_id)).or_default();
        p.balance += amount;
        p.deposited += amount;
        if let Some(l) = loss_limit {
            p.loss_limit = l.0;
        } else if p.loss_limit == 0 {
            p.loss_limit = amount;
        }
        let out = PositionView::from(&*p);
        all.flush();
        event("backed", json!({ "backer": backer, "agent": agent_id, "amount": U128(amount), "loss_limit": out.loss_limit }));
        out
    }

    pub fn set_loss_limit(&mut self, agent_id: String, loss_limit: U128) {
        let mut all = positions();
        let p = all.get_mut(&position_key(&env::predecessor_account_id(), &agent_id)).unwrap_or_else(|| env::panic_str("no position"));
        p.loss_limit = loss_limit.0;
        all.flush();
    }

    /// Withdraws idle funds from a position. Funds bought in to an unsettled session stay put.
    pub fn withdraw(&mut self, agent_id: String, amount: U128) -> Promise {
        let backer = env::predecessor_account_id();
        let mut all = positions();
        let p = all.get_mut(&position_key(&backer, &agent_id)).unwrap_or_else(|| env::panic_str("no position"));
        require!(amount.0 > 0 && amount.0 <= p.balance, "more than the idle balance");
        p.balance -= amount.0;
        p.withdrawn += amount.0;
        all.flush();
        event("withdrawn", json!({ "backer": backer, "agent": agent_id, "amount": amount }));
        Promise::new(backer).transfer(NearToken::from_yoctonear(amount.0))
    }

    pub fn get_position(&self, backer: AccountId, agent_id: String) -> Option<PositionView> {
        positions().get(&position_key(&backer, &agent_id)).map(PositionView::from)
    }

    /// Pays out this account's accumulated pro or platform share.
    pub fn claim_earnings(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let mut all = earnings();
        let amount = all.remove(&who).unwrap_or(0);
        require!(amount > 0, "nothing to claim");
        all.flush();
        event("earnings_claimed", json!({ "account": who, "amount": U128(amount) }));
        Promise::new(who).transfer(NearToken::from_yoctonear(amount))
    }

    pub fn get_earnings(&self, account: AccountId) -> U128 {
        U128(earnings().get(&account).copied().unwrap_or(0))
    }

    /// Opens a session in which every seat is an agent bought in from its backer's position or its pool. The owner
    /// or the operator (the feeder). Repeating the identical request is accepted and locks nothing more.
    ///
    /// No two seats may belong to the same pro. The listed order does not decide where agents sit: the dealer seats
    /// them from the session's randomness (`"seating": "vrf"`), and settlement applies the same order.
    pub fn open_backed_session(&mut self, session_id: String, seats: Vec<BackedSeat>, buy_in_chips: U64, button: u8, sb: U64, bb: U64, hands: u32) -> Value {
        self.require_operator();
        let n = seats.len();
        let ags = agents();
        let mut profiles = Vec::with_capacity(n);
        let mut versions = Vec::with_capacity(n);
        let mut pros: Vec<AccountId> = Vec::with_capacity(n);
        for (i, s) in seats.iter().enumerate() {
            require!(!seats[..i].iter().any(|t| t.agent_id == s.agent_id), "an agent can take only one seat");
            let a = ags.get(&s.agent_id).unwrap_or_else(|| env::panic_str(&format!("no agent {}", s.agent_id)));
            if pros.contains(&a.owner) {
                env::panic_str(&format!("self-play: {} and another seat both belong to {}", s.agent_id, a.owner));
            }
            pros.push(a.owner.clone());
            let x = strategy::ext_of(a);
            profiles.push(near_sdk::serde_json::from_str::<Value>(&x.profile_json).unwrap());
            versions.push(x.version);
        }
        let stacks = vec![buy_in_chips.0; n];
        let start = game::Rules { stacks: stacks.clone(), button: button as usize, sb: sb.0, bb: bb.0 };
        if let Err(e) = core::session::check(&start, hands as usize) {
            env::panic_str(&e);
        }
        let request = json!({ "action": "session", "hand_id": session_id, "stacks": stacks, "profiles": profiles, "button": button, "sb": sb.0, "bb": bb.0, "hands": hands, "seating": "vrf" });
        let request_text = request.to_string();

        let mut all = sessions();
        if let Some(s) = all.get(&session_id) {
            require!(s.status == Status::Pending, "session exists");
            require!(s.request == request_text, "a retry must repeat the same request");
            return request;
        }
        let cfg = self.vault_config();
        let buy_in = buy_in_chips.0 as u128 * cfg.chip_yocto.0;
        let mut pos = positions();
        let mut pls = pools();
        for s in &seats {
            match &s.backer {
                Some(backer) => {
                    let p = pos.get_mut(&position_key(backer, &s.agent_id)).unwrap_or_else(|| env::panic_str(&format!("{backer} has no position on {}", s.agent_id)));
                    if let Err(e) = can_seat(p, buy_in) {
                        env::panic_str(&format!("{backer} on {}: {e}", s.agent_id));
                    }
                    lock(p, buy_in);
                }
                None => {
                    let pl = pls.get_mut(&s.agent_id).unwrap_or_else(|| env::panic_str(&format!("{} has no pool", s.agent_id)));
                    if let Err(e) = pool::can_seat(pl, buy_in).and_then(|_| strategy::pool_loss_check(ags.get(&s.agent_id).unwrap(), pl)) {
                        env::panic_str(&format!("pool {}: {e}", s.agent_id));
                    }
                    pool::lock(pl, buy_in);
                }
            }
        }
        pls.flush();
        all.insert(session_id.clone(), crate::Session { status: Status::Pending, request: request_text, started_at: U64(env::block_timestamp()), result: None });
        let mut b = backed();
        b.insert(session_id.clone(), BackedSession { seats, buy_in_chips: buy_in_chips.0, chip_yocto: cfg.chip_yocto });
        let mut vers = strategy::session_versions();
        vers.insert(session_id.clone(), versions);
        vers.flush();
        all.flush();
        pos.flush();
        b.flush();
        event("session_opened", json!({ "session_id": session_id, "buy_in": U128(buy_in) }));
        request
    }

    pub fn get_backed_session(&self, session_id: String) -> Option<BackedSession> {
        backed().get(&session_id).cloned()
    }

    /// Returns the buy-ins of a backed session the dealer never answered. Only after `CANCEL_AFTER_NS`, so a
    /// session cannot be dropped soon after its result could be known.
    pub fn cancel_session(&mut self, session_id: String) {
        self.require_operator();
        let mut all = sessions();
        let s = all.get_mut(&session_id).unwrap_or_else(|| env::panic_str("no session"));
        require!(s.status == Status::Pending, "session is not pending");
        require!(env::block_timestamp() >= s.started_at.0 + CANCEL_AFTER_NS, "too early to cancel");
        s.status = Status::Done;
        let mut b = backed();
        if let Some(bs) = b.remove(&session_id) {
            let buy_in = bs.buy_in_chips as u128 * bs.chip_yocto.0;
            let mut pos = positions();
            let mut pls = pools();
            let mut held = holdings();
            for seat in &bs.seats {
                match &seat.backer {
                    Some(backer) => {
                        if let Some(p) = pos.get_mut(&position_key(backer, &seat.agent_id)) {
                            unlock(p, buy_in);
                        }
                    }
                    None => {
                        if let Some(pl) = pls.get_mut(&seat.agent_id) {
                            pool::unlock(pl, buy_in);
                            for (who, amount) in pool::apply_pending(pl, &seat.agent_id, &mut held).0 {
                                Promise::new(who).transfer(NearToken::from_yoctonear(amount)).detach();
                            }
                        }
                    }
                }
            }
            pos.flush();
            pls.flush();
            held.flush();
        }
        let mut vers = strategy::session_versions();
        vers.remove(&session_id);
        vers.flush();
        all.flush();
        b.flush();
        event("session_cancelled", json!({ "session_id": session_id }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    fn pos(balance: u128, loss_limit: u128) -> Position {
        Position { balance, loss_limit, deposited: balance, ..Default::default() }
    }

    #[test]
    fn profit_splits_90_8_2() {
        let mut p = pos(NEAR, NEAR);
        lock(&mut p, NEAR / 10);
        // Bought in 0.1, cashed out 0.2: profit 0.1.
        let s = settle(&mut p, NEAR / 10, NEAR / 5, 800, 200);
        assert_eq!(s.fee_base, NEAR / 10);
        assert_eq!(s.pro_fee, NEAR / 10 * 8 / 100);
        assert_eq!(s.platform_fee, NEAR / 10 * 2 / 100);
        // The backer keeps the buy-in back plus 90% of the profit.
        assert_eq!(s.to_backer, NEAR / 10 + NEAR / 10 * 90 / 100);
        assert_eq!(p.balance, NEAR - NEAR / 10 + s.to_backer);
        assert_eq!(p.at_table, 0);
    }

    #[test]
    fn losses_pay_no_fees_and_winning_back_pays_none_either() {
        let mut p = pos(NEAR, NEAR);
        lock(&mut p, NEAR / 10);
        let s = settle(&mut p, NEAR / 10, NEAR / 20, 800, 200); // lost 0.05
        assert_eq!((s.pro_fee, s.platform_fee), (0, 0));
        lock(&mut p, NEAR / 10);
        let s = settle(&mut p, NEAR / 10, NEAR / 10 + NEAR / 20, 800, 200); // won 0.05 back
        assert_eq!((s.pro_fee, s.platform_fee), (0, 0), "no fees until above the previous peak");
        assert_eq!(p.net, 0);
        lock(&mut p, NEAR / 10);
        let s = settle(&mut p, NEAR / 10, NEAR / 10 + NEAR / 50, 800, 200); // won 0.02 above the peak
        assert_eq!(s.fee_base, NEAR / 50);
    }

    #[test]
    fn the_loss_limit_and_balance_gate_seating() {
        let p = pos(NEAR, NEAR / 5);
        assert!(can_seat(&p, NEAR / 5).is_ok());
        assert!(can_seat(&p, NEAR / 4).is_err(), "losing 0.25 would exceed a 0.2 limit");
        let mut p = pos(NEAR, NEAR / 5);
        lock(&mut p, NEAR / 5);
        settle(&mut p, NEAR / 5, NEAR / 10, 800, 200); // lost 0.1 of the 0.2 limit
        assert!(can_seat(&p, NEAR / 10).is_ok());
        assert!(can_seat(&p, NEAR / 10 + 1).is_err());
        assert!(can_seat(&pos(NEAR / 10, NEAR), NEAR / 5).is_err(), "balance too low");
    }

    #[test]
    fn fees_never_exceed_the_cash_out() {
        // Many random sessions: money is only moved, and fees come only out of profit.
        let mut p = pos(1000 * NEAR, 1000 * NEAR);
        let mut paid_in = 1000 * NEAR;
        let mut fees = 0u128;
        let mut x: u64 = 7;
        for _ in 0..2000 {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let buy_in = NEAR / 10;
            let cash_out = (x >> 33) as u128 % (NEAR / 4); // 0 to 0.25
            lock(&mut p, buy_in);
            let s = settle(&mut p, buy_in, cash_out, 800, 200);
            assert!(s.pro_fee + s.platform_fee <= cash_out);
            fees += s.pro_fee + s.platform_fee;
            paid_in = (paid_in as i128 + s.gross) as u128;
        }
        assert_eq!(p.balance + fees, paid_in);
        assert_eq!(p.fees_paid, fees);
    }
}
