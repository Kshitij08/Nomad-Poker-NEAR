//! What a client needs to list agents and replay settled sessions on its own.
//!
//! Each settled session keeps its randomness proof, the request it was played under, its actions and payouts, so a
//! browser can re-deal and replay every hand with poker-core (via WebAssembly) and show exactly what the contract
//! verified. Sessions settled before this module existed have no record here.

use crate::pool::{pools, PoolView};
use crate::vault::{agents, Agent};
use crate::{Table, TableExt};
use near_sdk::json_types::U64;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require};

/// An append-only list kept outside the contract's state struct: a length under its own key plus one entry per
/// index. (A `store::Vector` keeps its length in the state struct, so it cannot be rebuilt from a prefix.)
struct List {
    len_key: &'static [u8],
    items: LookupMap<u32, String>,
}

impl List {
    fn new(prefix: &'static [u8], len_key: &'static [u8]) -> Self {
        List { len_key, items: LookupMap::new(prefix) }
    }
    fn len(&self) -> u32 {
        env::storage_read(self.len_key).and_then(|b| b.try_into().ok()).map(u32::from_le_bytes).unwrap_or(0)
    }
    fn get(&self, i: u32) -> Option<&String> {
        self.items.get(&i)
    }
    fn push(&mut self, v: String) {
        let n = self.len();
        self.items.insert(n, v);
        self.items.flush();
        env::storage_write(self.len_key, &(n + 1).to_le_bytes());
    }
    fn contains(&self, v: &str) -> bool {
        (0..self.len()).any(|i| self.get(i).map(|x| x == v).unwrap_or(false))
    }
}

fn agent_index() -> List {
    List::new(b"l", b"l#")
}

fn recent() -> List {
    List::new(b"r", b"r#")
}

fn records() -> LookupMap<String, String> {
    LookupMap::new(b"m")
}

pub(crate) fn index_agent(agent_id: &str) {
    agent_index().push(agent_id.to_string());
}

/// Keeps a settled session's replay record and adds it to the recent list.
pub(crate) fn record_session(session_id: &str, request: &str, alpha: &str, signature_hex: &str, actions: &str, stacks: &[u64], payouts: &Option<Value>) {
    let req: Value = near_sdk::serde_json::from_str(request).unwrap_or(Value::Null);
    let rec = json!({
        "session_id": session_id,
        "settled_at": U64(env::block_timestamp()),
        "stacks": req["stacks"],
        "profiles": req["profiles"],
        "button": req["button"],
        "sb": req["sb"],
        "bb": req["bb"],
        "hands": req["hands"],
        "alpha": alpha,
        "signature_hex": signature_hex,
        "actions": actions,
        "end_stacks": stacks,
        "payouts": payouts,
    });
    let mut all = records();
    all.insert(session_id.to_string(), rec.to_string());
    all.flush();
    recent().push(session_id.to_string());
}

#[near(serializers = [json])]
pub struct AgentCard {
    pub agent: Agent,
    pub pool: Option<PoolView>,
}

#[near]
impl Table {
    /// Agents in the order they registered, each with its pool if it has one.
    pub fn list_agents(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<AgentCard> {
        let idx = agent_index();
        let ags = agents();
        let pls = pools();
        let from = from_index.unwrap_or(0);
        let to = (from + limit.unwrap_or(50).min(100)).min(idx.len());
        (from..to)
            .filter_map(|i| idx.get(i))
            .filter_map(|id| ags.get(id).map(|a| AgentCard { agent: a.clone(), pool: pls.get(id).map(PoolView::from) }))
            .collect()
    }

    pub fn agent_count(&self) -> u32 {
        agent_index().len()
    }

    /// Adds agents registered before the index existed. Owner only; skips ids already listed.
    pub fn index_agents(&mut self, agent_ids: Vec<String>) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        let mut idx = agent_index();
        let ags = agents();
        for id in agent_ids {
            if ags.contains_key(&id) && !idx.contains(&id) {
                idx.push(id);
            }
        }
    }

    /// Everything needed to replay a settled session: its proof, rules, actions and payouts.
    pub fn get_session_record(&self, session_id: String) -> Option<Value> {
        records().get(&session_id).and_then(|s| near_sdk::serde_json::from_str(s).ok())
    }

    /// The most recently settled sessions, newest first.
    pub fn recent_sessions(&self, limit: Option<u32>) -> Vec<Value> {
        let r = recent();
        let all = records();
        let n = r.len();
        let take = limit.unwrap_or(10).min(50).min(n);
        (0..take)
            .filter_map(|k| r.get(n - 1 - k))
            .filter_map(|id| all.get(id))
            .filter_map(|s| near_sdk::serde_json::from_str::<Value>(s).ok())
            .map(|v| {
                let agents: Vec<Value> = v["payouts"]["seats"].as_array().map(|seats| seats.iter().map(|s| s["agent"].clone()).collect()).unwrap_or_default();
                json!({ "session_id": v["session_id"], "settled_at": v["settled_at"], "hands": v["actions"].as_str().map(|a| a.split(';').count()).unwrap_or(0), "agents": agents, "end_stacks": v["end_stacks"] })
            })
            .collect()
    }
}
