//! Agents v2: strategy profiles, listing rules, pool loss limits and the operator role.
//!
//! - **Profiles.** An agent plays a v2 strategy (`poker_core::profile::Profile`, the Nomad app's Strategy tab). Agents
//!   registered with `{tight, aggro}` play the v2 profile those map to. Changing the strategy (`update_agent`) starts
//!   a new strategy version.
//! - **Listing.** New backers may join an agent's pool (or open a position on it) only once the current strategy
//!   version has a track record: `min_sessions` settled sessions and `min_hands` hands. The pro may always fund their
//!   own agent, which is how a track record starts.
//! - **Loss limit.** A pool takes no new sessions once its value per share is `loss_limit_bps` below its high-water
//!   mark. The owner sets the default; a pro may set a tighter one for their agent. This is on top of the per-session
//!   risk cap (`max_buy_in_bps`, 25% by default).
//! - **Operator.** The owner may name an operator (the feeder) that can open and cancel sessions but cannot call any
//!   owner-only method, so the feeder never needs the owner's full-access key.
//!
//! Everything here lives under its own storage keys (`g`, `x`, `w`), so this version deploys over the previous one
//! without migrating any existing state.

use crate::pool::{pools, Pool, PRICE_SCALE};
use crate::vault::{agents, event, Agent};
use crate::{Table, TableExt};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId};
use poker_core::profile::Profile;

pub const DEFAULT_MIN_SESSIONS: u32 = 3;
pub const DEFAULT_MIN_HANDS: u64 = 50;
pub const DEFAULT_POOL_LOSS_LIMIT_BPS: u32 = 5_000;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Rules {
    /// May open and cancel sessions (the feeder). Not the owner: owner-only methods refuse it.
    pub operator: Option<AccountId>,
    /// Track record a strategy version needs before new backers may join.
    pub min_sessions: u32,
    pub min_hands: u64,
    /// Default pool loss limit: no new sessions once the value per share is this far below its peak (basis points).
    pub pool_loss_limit_bps: u32,
}

impl Default for Rules {
    fn default() -> Self {
        Rules { operator: None, min_sessions: DEFAULT_MIN_SESSIONS, min_hands: DEFAULT_MIN_HANDS, pool_loss_limit_bps: DEFAULT_POOL_LOSS_LIMIT_BPS }
    }
}

/// What v2 adds to an agent, stored beside the original record.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentExt {
    /// The strategy as canonical JSON (validated).
    pub profile_json: String,
    /// Starts at 1; every `update_agent` adds one.
    pub version: u32,
    /// Settled sessions and hands under the current version.
    pub version_sessions: u32,
    pub version_hands: u64,
    pub updated_at: u64,
    /// The pro's own pool loss limit, if tighter than the default.
    pub pool_loss_limit_bps: Option<u32>,
}

impl AgentExt {
    pub fn profile(&self) -> Profile {
        near_sdk::serde_json::from_str(&self.profile_json).unwrap_or_else(|_| env::panic_str("stored profile unreadable"))
    }
}

const RULES_KEY: &[u8] = b"g";

fn save_rules(r: &Rules) {
    env::storage_write(RULES_KEY, &near_sdk::borsh::to_vec(r).unwrap());
}
fn ext_store() -> LookupMap<String, AgentExt> {
    LookupMap::new(b"x")
}
/// The strategy version each listed seat played a session under, so only sessions of the current version count.
pub(crate) fn session_versions() -> LookupMap<String, Vec<u32>> {
    LookupMap::new(b"w")
}

pub fn rules() -> Rules {
    // Read the key directly: `LazyOption::new(key, None)` caches None and never reads storage.
    env::storage_read(RULES_KEY).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or_default()
}

/// An agent's v2 data. Agents registered before v2 play the profile their `{tight, aggro}` map to, as strategy
/// version 1 with every session so far counting toward its track record.
pub fn ext_of(a: &Agent) -> AgentExt {
    ext_store().get(&a.id).cloned().unwrap_or_else(|| AgentExt {
        profile_json: canonical(&Profile::from_legacy(a.tight, a.aggro)),
        version: 1,
        version_sessions: a.sessions,
        version_hands: a.hands,
        updated_at: a.created_at.0,
        pool_loss_limit_bps: None,
    })
}

pub fn canonical(p: &Profile) -> String {
    near_sdk::serde_json::to_string(&p.clone().normalized()).unwrap()
}

pub fn checked(profile: Profile) -> Profile {
    if let Err(e) = profile.validate() {
        env::panic_str(&format!("profile: {e}"));
    }
    profile.normalized()
}

pub(crate) fn save_ext(agent_id: &str, x: AgentExt) {
    let mut all = ext_store();
    all.insert(agent_id.to_string(), x);
    all.flush();
}

/// Adds a settled session to an agent's track record, if it was played under the current strategy version.
pub(crate) fn count_session(a: &Agent, played_version: Option<u32>, hands: u32) {
    let mut x = ext_of(a);
    if played_version.map_or(true, |v| v == x.version) {
        x.version_sessions += 1;
        x.version_hands += hands as u64;
        save_ext(&a.id, x);
    } else if !ext_store().contains_key(&a.id) {
        save_ext(&a.id, x);
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ListingView {
    pub agent_id: String,
    pub strategy_version: u32,
    /// Settled sessions and hands under the current strategy version.
    pub sessions: u32,
    pub hands: U64,
    pub min_sessions: u32,
    pub min_hands: U64,
    /// The current strategy has its track record.
    pub qualified: bool,
    /// New backers may join now: qualified, and the pool (if any) still takes new money.
    pub open_to_backers: bool,
}

pub fn listing_of(a: &Agent, x: &AgentExt, r: &Rules, pool: Option<&Pool>) -> ListingView {
    let qualified = x.version_sessions >= r.min_sessions && x.version_hands >= r.min_hands;
    ListingView {
        agent_id: a.id.clone(),
        strategy_version: x.version,
        sessions: x.version_sessions,
        hands: U64(x.version_hands),
        min_sessions: r.min_sessions,
        min_hands: U64(r.min_hands),
        qualified,
        open_to_backers: qualified && pool.map_or(true, |p| p.open_to_joins()),
    }
}

/// Refuses a backer other than the agent's pro until the current strategy has its track record.
pub fn require_listed(a: &Agent, who: &AccountId) {
    if *who == a.owner {
        return;
    }
    let l = listing_of(a, &ext_of(a), &rules(), None);
    if !l.qualified {
        env::panic_str(&format!(
            "{} is not open to backers yet: strategy v{} has {} of {} sessions and {} of {} hands",
            a.id, l.strategy_version, l.sessions, l.min_sessions, l.hands.0, l.min_hands.0
        ));
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PoolLimitsView {
    /// The limit that applies: the pro's own if set (never looser than the default), else the default.
    pub loss_limit_bps: u32,
    pub pro_loss_limit_bps: Option<u32>,
    pub default_loss_limit_bps: u32,
    /// How far the value per share is below its high-water mark, in basis points.
    pub drawdown_bps: u32,
    pub price: U128,
    pub hwm_price: U128,
    /// Per-session risk cap.
    pub max_buy_in_bps: u32,
    /// Whether the pool may be seated in a new session as far as the loss limit is concerned.
    pub accepts_sessions: bool,
}

pub fn effective_loss_limit(x: &AgentExt, r: &Rules) -> u32 {
    x.pool_loss_limit_bps.map_or(r.pool_loss_limit_bps, |p| p.min(r.pool_loss_limit_bps))
}

pub fn drawdown_bps(p: &Pool) -> u32 {
    let price = p.price();
    if p.shares == 0 || price >= p.hwm_price {
        0
    } else {
        ((p.hwm_price - price) * 10_000 / p.hwm_price) as u32
    }
}

/// The loss-limit check for seating a pool.
pub fn pool_loss_check(a: &Agent, p: &Pool) -> Result<(), String> {
    let limit = effective_loss_limit(&ext_of(a), &rules());
    let dd = drawdown_bps(p);
    if dd >= limit {
        return Err(format!("the pool is {}.{:02}% below its high-water mark, past its loss limit of {}.{:02}%", dd / 100, dd % 100, limit / 100, limit % 100));
    }
    Ok(())
}

#[near(serializers = [json])]
pub struct AgentView {
    pub id: String,
    pub owner: AccountId,
    /// The nearest first-generation numbers, for clients written before v2.
    pub tight: u8,
    pub aggro: u8,
    pub sessions: u32,
    pub hands: u64,
    pub net_chips: i64,
    pub created_at: U64,
    pub profile: Profile,
    pub strategy_version: u32,
}

pub fn agent_view(a: &Agent, x: &AgentExt) -> AgentView {
    AgentView {
        id: a.id.clone(),
        owner: a.owner.clone(),
        tight: a.tight,
        aggro: a.aggro,
        sessions: a.sessions,
        hands: a.hands,
        net_chips: a.net_chips,
        created_at: a.created_at,
        profile: x.profile(),
        strategy_version: x.version,
    }
}

impl Table {
    pub(crate) fn require_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    /// The owner or the operator (the feeder).
    pub(crate) fn require_operator(&self) {
        let who = env::predecessor_account_id();
        require!(who == self.owner || rules().operator.as_ref() == Some(&who), "owner or operator only");
    }

    fn agent_of_pro(&self, agent_id: &str) -> Agent {
        let a = agents().get(agent_id).cloned().unwrap_or_else(|| env::panic_str("no such agent"));
        require!(env::predecessor_account_id() == a.owner, "only the agent's pro");
        a
    }
}

#[near]
impl Table {
    /// A pro changes their agent's strategy. This starts a new strategy version: its track record restarts, so new
    /// backers wait until it qualifies again (existing backers stay and may leave as usual).
    pub fn update_agent(&mut self, agent_id: String, profile: Profile) -> AgentView {
        let mut a = self.agent_of_pro(&agent_id);
        let profile = checked(profile);
        let old = ext_of(&a);
        require!(canonical(&profile) != old.profile_json, "that is already the agent's strategy");
        let x = AgentExt { profile_json: canonical(&profile), version: old.version + 1, version_sessions: 0, version_hands: 0, updated_at: env::block_timestamp(), pool_loss_limit_bps: old.pool_loss_limit_bps };
        (a.tight, a.aggro) = profile.legacy_view();
        let mut all = agents();
        all.insert(agent_id.clone(), a.clone());
        all.flush();
        save_ext(&agent_id, x.clone());
        event("agent_updated", json!({ "agent": agent_id, "strategy_version": x.version }));
        agent_view(&a, &x)
    }

    /// A pro hands an agent (and its future pro share) to another account.
    pub fn transfer_agent(&mut self, agent_id: String, new_owner: AccountId) {
        let mut a = self.agent_of_pro(&agent_id);
        let from = a.owner.clone();
        a.owner = new_owner.clone();
        let mut all = agents();
        all.insert(agent_id.clone(), a);
        all.flush();
        event("agent_transferred", json!({ "agent": agent_id, "from": from, "to": new_owner }));
    }

    /// A pro sets a tighter pool loss limit for their agent (basis points, at most the default), or clears it.
    pub fn set_pool_loss_limit(&mut self, agent_id: String, loss_limit_bps: Option<u32>) {
        let a = self.agent_of_pro(&agent_id);
        let r = rules();
        if let Some(bps) = loss_limit_bps {
            require!(bps > 0 && bps <= r.pool_loss_limit_bps, format!("1 to {} basis points (the default; a pro may only tighten it)", r.pool_loss_limit_bps));
        }
        let mut x = ext_of(&a);
        x.pool_loss_limit_bps = loss_limit_bps;
        save_ext(&agent_id, x);
        event("pool_loss_limit_set", json!({ "agent": agent_id, "loss_limit_bps": loss_limit_bps }));
    }

    /// Owner only: names (or removes) the operator that may open and cancel sessions.
    pub fn set_operator(&mut self, operator: Option<AccountId>) {
        self.require_owner();
        let mut r = rules();
        r.operator = operator.clone();
        save_rules(&r);
        event("operator_set", json!({ "operator": operator }));
    }

    /// Owner only: the track record a strategy version needs before new backers may join.
    pub fn set_listing_rules(&mut self, min_sessions: u32, min_hands: U64) {
        self.require_owner();
        let mut r = rules();
        r.min_sessions = min_sessions;
        r.min_hands = min_hands.0;
        save_rules(&r);
    }

    /// Owner only: the default pool loss limit (basis points below the high-water mark, 1 to 10000).
    pub fn set_default_pool_loss_limit(&mut self, loss_limit_bps: u32) {
        self.require_owner();
        require!(loss_limit_bps > 0 && loss_limit_bps <= 10_000, "1 to 10000 basis points");
        let mut r = rules();
        r.pool_loss_limit_bps = loss_limit_bps;
        save_rules(&r);
    }

    pub fn get_rules(&self) -> Rules {
        rules()
    }

    pub fn get_profile(&self, agent_id: String) -> Option<Profile> {
        agents().get(&agent_id).map(|a| ext_of(a).profile())
    }

    pub fn get_listing(&self, agent_id: String) -> Option<ListingView> {
        let a = agents().get(&agent_id).cloned()?;
        let pls = pools();
        Some(listing_of(&a, &ext_of(&a), &rules(), pls.get(&agent_id)))
    }

    pub fn get_pool_limits(&self, agent_id: String) -> Option<PoolLimitsView> {
        let a = agents().get(&agent_id).cloned()?;
        let pls = pools();
        let p = pls.get(&agent_id).cloned().unwrap_or_default();
        Some(pool_limits_of(&a, &p))
    }
}

pub fn pool_limits_of(a: &Agent, p: &Pool) -> PoolLimitsView {
    let x = ext_of(a);
    let r = rules();
    let limit = effective_loss_limit(&x, &r);
    let dd = drawdown_bps(p);
    PoolLimitsView {
        loss_limit_bps: limit,
        pro_loss_limit_bps: x.pool_loss_limit_bps,
        default_loss_limit_bps: r.pool_loss_limit_bps,
        drawdown_bps: dd,
        price: U128(if p.shares == 0 { PRICE_SCALE } else { p.price() }),
        hwm_price: U128(p.hwm_price),
        max_buy_in_bps: p.max_buy_in_bps,
        accepts_sessions: dd < limit,
    }
}
