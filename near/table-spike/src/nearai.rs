//! NEAR-AI agents: a pro's strategy kept private, turned into each session's profile by a private model.
//!
//! - The pro seals plain-words instructions to the dealer's X25519 key in the browser (`set_private_strategy`); the
//!   contract stores only the ciphertext. Only the sealed dealer can open it.
//! - For each session, the dealer asks the agent's model on NEAR AI Cloud (in a TEE) once for that session's profile
//!   and plays it. The model's reply is signed in its TEE (EIP-191, secp256k1). The dealer returns the raw reply,
//!   the signature and the profile; `submit_session` checks that the signature recovers to an attested signing address
//!   of that model (`set_near_ai_signer`, checked off-chain against the model's TDX/GPU attestation), that it signs
//!   exactly this reply, and that the reply says exactly the profile the dealer played (the dealer's VRF attestation
//!   covers the played profiles too). The proofs are kept with the session record.
//!
//! Stored under its own keys (`y` private strategies, `z` signers, `k` the dealer's key), so this deploys in place.

use crate::strategy::{self, AgentExt};
use crate::vault::{agents, event, Agent};
use crate::{Table, TableExt};
use near_sdk::json_types::U64;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require};
use poker_core::nearai::{self as ai, MAX_STRATEGY_BYTES};
use poker_core::profile::Profile;

const KEY_KEY: &[u8] = b"k";

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PrivateStrategy {
    pub model: String,
    /// One-time X25519 key (hex) and the sealed text (hex, ChaCha20-Poly1305, aad = agent id).
    pub eph: String,
    pub ct: String,
    pub set_at: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PrivateStrategyView {
    pub model: String,
    /// Bytes of sealed text (the text itself stays private).
    pub sealed_bytes: u32,
    pub set_at: U64,
}

/// A model's decision as the dealer reports it and `submit_session` takes it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct NearAiProof {
    /// The listed seat (the order the session was opened with).
    pub seat: u32,
    pub agent_id: String,
    pub model: String,
    pub chat_id: String,
    /// The completion's raw response body (JSON text).
    pub response: String,
    /// `<model>:<sha256 of the request>:<sha256 of the response>`.
    pub signature_text: String,
    /// 65-byte EIP-191 signature, hex.
    pub signature: String,
    pub signing_address: String,
    pub profile: Profile,
}

pub(crate) fn privates() -> LookupMap<String, PrivateStrategy> {
    LookupMap::new(b"y")
}
fn signers() -> LookupMap<String, Vec<String>> {
    LookupMap::new(b"z")
}
/// Models that have at least one signer, in the order first added.
fn signer_models() -> Vec<String> {
    env::storage_read(b"z#").and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or_default()
}

pub fn private_view(agent_id: &str) -> Option<PrivateStrategyView> {
    privates().get(agent_id).map(|p| PrivateStrategyView { model: p.model.clone(), sealed_bytes: (p.ct.len() / 2) as u32, set_at: U64(p.set_at) })
}

/// The `private` block a NEAR-AI seat's profile carries in a session request (the dealer reads it).
pub fn private_block(a: &Agent) -> Option<Value> {
    privates().get(&a.id).map(|p| json!({ "agent_id": a.id, "model": p.model, "eph": p.eph, "ct": p.ct, "sessions": a.sessions, "hands": a.hands, "net_chips": a.net_chips }))
}

fn lower_hex(s: &str, bytes: usize) -> Option<Vec<u8>> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s).ok().filter(|b| b.len() == bytes)
}

/// The Ethereum address an EIP-191 signature over `text` recovers to (lowercase hex with 0x).
pub fn recover_address(text: &str, signature_hex: &str) -> Result<String, String> {
    let sig = lower_hex(signature_hex, 65).ok_or("the model's signature is not 65 bytes of hex")?;
    let v = match sig[64] {
        27 | 28 => sig[64] - 27,
        0 | 1 => sig[64],
        _ => return Err("the model's signature has a bad recovery id".into()),
    };
    let hash = env::keccak256(&ai::eip191_message(text));
    let pk = env::ecrecover(&hash, &sig[..64], v, false).ok_or("the model's signature does not recover")?;
    Ok(format!("0x{}", hex::encode(&env::keccak256(&pk)[12..])))
}

/// Checks one proof against the session request. Returns the listed seat and the profile it chose.
pub fn verify_proof(req: &Value, p: &NearAiProof) -> Result<(usize, Profile), String> {
    let seat = p.seat as usize;
    let block = req["profiles"].get(seat).and_then(|v| v.get("private")).ok_or(format!("seat {seat} is not a NEAR-AI seat"))?;
    if block["agent_id"].as_str() != Some(p.agent_id.as_str()) || block["model"].as_str() != Some(p.model.as_str()) {
        return Err(format!("seat {seat}: the proof is for another agent or model"));
    }
    let allowed = signers().get(&p.model).cloned().unwrap_or_default();
    let address = p.signing_address.to_lowercase();
    if !allowed.contains(&address) {
        return Err(format!("{} is not an attested signing address of {}", p.signing_address, p.model));
    }
    ai::check_signature_text(&p.signature_text, &p.model, &hex::encode(env::sha256(p.response.as_bytes())))?;
    if recover_address(&p.signature_text, &p.signature)? != address {
        return Err(format!("seat {seat}: the model's signature is not from {}", p.signing_address));
    }
    let chose = ai::profile_from_response(p.response.as_bytes())?;
    if chose != p.profile {
        return Err(format!("seat {seat}: the profile is not what the model's reply says"));
    }
    if p.chat_id.is_empty() || !p.response.contains(&p.chat_id) {
        return Err(format!("seat {seat}: the chat id is not this reply's"));
    }
    Ok((seat, chose))
}

/// Verifies every proof of a session; returns (listed seat, profile) for each. One proof per seat at most.
pub fn verify_proofs(req: &Value, proofs: &[NearAiProof]) -> Result<Vec<(usize, Profile)>, String> {
    let mut out: Vec<(usize, Profile)> = vec![];
    for p in proofs {
        let (seat, prof) = verify_proof(req, p)?;
        if out.iter().any(|(s, _)| *s == seat) {
            return Err(format!("two proofs for seat {seat}"));
        }
        out.push((seat, prof));
    }
    Ok(out)
}

impl Table {
    fn pro_agent(&self, agent_id: &str) -> Agent {
        let a = agents().get(agent_id).cloned().unwrap_or_else(|| env::panic_str("no such agent"));
        require!(env::predecessor_account_id() == a.owner, "only the agent's pro");
        a
    }
}

fn new_version(a: &Agent) -> u32 {
    let old = strategy::ext_of(a);
    let x = AgentExt { version: old.version + 1, version_sessions: 0, version_hands: 0, updated_at: env::block_timestamp(), ..old };
    let v = x.version;
    strategy::save_ext(&a.id, x);
    v
}

#[near]
impl Table {
    /// A pro makes their agent a NEAR-AI agent: `eph` and `ct` are the strategy text sealed in the browser to
    /// `get_strategy_key()` (see feeder/src/nearai.ts), `model` one with attested signers. The agent's v2 profile
    /// stays as its fallback. This is a new strategy version: the track record restarts.
    pub fn set_private_strategy(&mut self, agent_id: String, model: String, eph: String, ct: String) -> u32 {
        let a = self.pro_agent(&agent_id);
        require!(signers().get(&model).map_or(false, |s| !s.is_empty()), "that model has no attested signer on this table");
        require!(lower_hex(&eph, 32).is_some(), "eph: 32 bytes of hex");
        let n = hex::decode(&ct).map(|b| b.len()).unwrap_or(0);
        require!(n > 16 && n <= MAX_STRATEGY_BYTES + 16, format!("ct: sealed text of 1 to {MAX_STRATEGY_BYTES} bytes"));
        let mut all = privates();
        all.insert(agent_id.clone(), PrivateStrategy { model: model.clone(), eph: eph.to_lowercase(), ct: ct.to_lowercase(), set_at: env::block_timestamp() });
        all.flush();
        let v = new_version(&a);
        event("private_strategy_set", json!({ "agent": agent_id, "model": model, "strategy_version": v }));
        v
    }

    /// Back to the plain v2 profile (a new strategy version).
    pub fn clear_private_strategy(&mut self, agent_id: String) -> u32 {
        let a = self.pro_agent(&agent_id);
        let mut all = privates();
        require!(all.remove(&agent_id).is_some(), "the agent has no private strategy");
        all.flush();
        let v = new_version(&a);
        event("private_strategy_cleared", json!({ "agent": agent_id, "strategy_version": v }));
        v
    }

    pub fn get_private_strategy(&self, agent_id: String) -> Option<PrivateStrategyView> {
        private_view(&agent_id)
    }

    /// Owner only: the dealer's strategy key (from the dealer's `strategy_key` action), so browsers can read it here.
    pub fn set_strategy_key(&mut self, public_key_hex: String) {
        self.require_owner();
        require!(lower_hex(&public_key_hex, 32).is_some(), "32 bytes of hex");
        env::storage_write(KEY_KEY, public_key_hex.to_lowercase().as_bytes());
    }

    pub fn get_strategy_key(&self) -> Option<String> {
        env::storage_read(KEY_KEY).and_then(|b| String::from_utf8(b).ok())
    }

    /// Owner only: allow (or remove) a model's signing address, after checking its TEE attestation report binds it
    /// (scripts/verify-near-ai.ts --attest).
    pub fn set_near_ai_signer(&mut self, model: String, signing_address: String, allowed: bool) {
        self.require_owner();
        let address = signing_address.to_lowercase();
        require!(lower_hex(&address, 20).is_some() && address.starts_with("0x"), "signing_address: 0x and 20 bytes of hex");
        let mut all = signers();
        let mut list = all.get(&model).cloned().unwrap_or_default();
        list.retain(|a| *a != address);
        if allowed {
            list.push(address.clone());
        }
        all.insert(model.clone(), list);
        all.flush();
        let mut models = signer_models();
        if !models.contains(&model) {
            models.push(model.clone());
            env::storage_write(b"z#", &near_sdk::borsh::to_vec(&models).unwrap());
        }
        event("near_ai_signer_set", json!({ "model": model, "signing_address": address, "allowed": allowed }));
    }

    /// `[{ model, signing_addresses }]`.
    pub fn get_near_ai_signers(&self) -> Vec<Value> {
        let all = signers();
        signer_models().into_iter().map(|m| json!({ "model": m, "signing_addresses": all.get(&m).cloned().unwrap_or_default() })).collect()
    }
}
