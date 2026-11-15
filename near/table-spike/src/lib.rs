//! Nomad Poker test table. It proves that a NEAR contract can have a hand dealt and played in sealed hardware
//! (OutLayer) and then check the dealer instead of trusting it.
//!
//! One-call agent hand:
//!   play_hand(hand_id, stacks, profiles, ..) -> OutLayer "play" -> on_play verifies the randomness proof,
//!   re-deals the hand, replays every action under the betting rules and records each seat's result.
//!
//! Street-by-street hand (for human players later):
//!   deal(hand_id, players)  -> OutLayer "deal"     -> on_deal stores the deck commitment
//!   showdown(hand_id)       -> OutLayer "showdown" -> on_showdown verifies the proof against the commitment
//!
//! A late or lost answer from OutLayer leaves the hand open: calling again with the same request retries it, and
//! the dealer returns the same hand. No chips move here; the vault comes later.

use near_sdk::json_types::U64;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};
use poker_core::{self as core, game};

mod history;
pub mod nearai;
pub mod strategy;
mod pool;
mod vault;
pub use pool::PoolView;
pub use strategy::{AgentView, ListingView, PoolLimitsView, Rules};
pub use vault::{Agent, BackedSeat, BackedSession, Position, PositionView, VaultConfig};

const OUTLAYER_GAS: Gas = Gas::from_tgas(100);
const DEAL_CALLBACK_GAS: Gas = Gas::from_tgas(15);
const VERIFY_CALLBACK_GAS: Gas = Gas::from_tgas(80);

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    /// Asked the dealer; no accepted answer yet. The same request may be sent again.
    Pending,
    /// Dealt street by street; waiting for showdown.
    Dealt,
    Done,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct HandResult {
    pub board: Vec<String>,
    pub holes: Vec<Vec<String>>,
    /// Seats with the best hand among all dealt (street-by-street hands), or seats that finished ahead (agent hands).
    pub winners: Vec<u8>,
    /// Agent hands: the actions in order, and each seat's chips won or lost.
    pub actions: Option<String>,
    pub deltas: Option<Vec<i64>>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Hand {
    pub players: u8,
    pub status: Status,
    /// The request sent to the dealer, as JSON. A retry must match it.
    pub request: String,
    /// SHA-256 commitment to the deck seed, hex (street-by-street hands).
    pub commit: Option<String>,
    pub started_at: U64,
    pub result: Option<HandResult>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct SessionResult {
    pub hands_played: u32,
    /// Each seat's stack at the end of the session.
    pub stacks: Vec<u64>,
    /// Each seat's total chips won or lost over the session.
    pub totals: Vec<i64>,
    /// Every hand's actions, separated by `;`, so anyone can replay the session.
    pub actions: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Session {
    pub status: Status,
    /// The request sent to the dealer, as JSON.
    pub request: String,
    pub started_at: U64,
    pub result: Option<SessionResult>,
}

/// Sessions are kept under their own storage prefix rather than in the contract's state struct, so this version
/// deploys over the earlier one without a migration.
pub(crate) fn sessions() -> LookupMap<String, Session> {
    LookupMap::new(b"s")
}

/// Checks a session: the proof gives the session seed, and every hand is re-dealt from it and replayed. With
/// `vrf_seating` the listed stacks are first put in the seat order the seed gives; the result is by table position.
pub fn verify_session(vrf_pubkey: &[u8; 32], session_id: &str, start: &game::Rules, hands: usize, alpha: &str, signature_hex: &str, actions: &str) -> Result<SessionResult, String> {
    verify_seated_session(vrf_pubkey, session_id, start, hands, alpha, signature_hex, actions, false).map(|(r, _)| r)
}

pub fn verify_seated_session(vrf_pubkey: &[u8; 32], session_id: &str, start: &game::Rules, hands: usize, alpha: &str, signature_hex: &str, actions: &str, vrf_seating: bool) -> Result<(SessionResult, Option<Vec<usize>>), String> {
    let seed = seed_from_proof(vrf_pubkey, "session", session_id, alpha, signature_hex)?;
    let order = vrf_seating.then(|| core::session::seat_order(&seed, start.stacks.len()));
    let seated;
    let start = match &order {
        Some(o) => {
            seated = game::Rules { stacks: core::session::seat(&start.stacks, o), ..start.clone() };
            &seated
        }
        None => start,
    };
    let out = core::session::replay(start, &seed, hands, actions)?;
    let totals = (0..start.stacks.len()).map(|i| out.stacks[i] as i64 - start.stacks[i] as i64).collect();
    Ok((SessionResult { hands_played: out.hands.len() as u32, stacks: out.stacks, totals, actions: actions.to_string() }, order))
}

/// Checks the dealer's attestation of a session: OutLayer's VRF key signed `act-<digest>` for exactly these actions,
/// this deck proof and this request, under the same account as the deck proof.
/// `played`: NEAR-AI seats whose profile came from their model this session (listed seat, profile).
pub fn verify_attestation(vrf_pubkey: &[u8; 32], session_id: &str, alpha: &str, signature_hex: &str, req: &Value, actions: &str, attest_alpha: &str, attest_signature_hex: &str, played: &[(usize, core::profile::Profile)]) -> Result<(), String> {
    let deck: Vec<&str> = alpha.split(':').collect();
    let att: Vec<&str> = attest_alpha.split(':').collect();
    if deck.len() != 4 || att.len() != 4 || att[0] != "vrf" || att[2] != deck[2] {
        return Err("the attestation is not from the dealer's run".into());
    }
    let num = |k: &str| req.get(k).and_then(Value::as_u64).unwrap_or(0);
    let listed = game::Rules {
        stacks: req.get("stacks").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default(),
        button: num("button") as usize,
        sb: num("sb"),
        bb: num("bb"),
    };
    let mut profiles = vec![];
    for p in req.get("profiles").and_then(Value::as_array).cloned().unwrap_or_default() {
        let any: core::profile::AnyProfile = near_sdk::serde_json::from_value(p).map_err(|_| "a recorded profile is unreadable")?;
        profiles.push(any.into_v2());
    }
    for (seat, p) in played {
        if let Some(slot) = profiles.get_mut(*seat) {
            *slot = p.clone();
        }
    }
    let digest = core::session::attest_digest(session_id, signature_hex, &listed, num("hands") as usize, req.get("seating").and_then(Value::as_str), &profiles, actions);
    if att[3] != core::session::attest_label(&digest) {
        return Err("the attestation does not match these actions".into());
    }
    let sig: [u8; 64] = hex::decode(attest_signature_hex).ok().and_then(|b| b.try_into().ok()).ok_or("the attestation is not a 64-byte signature")?;
    if !env::ed25519_verify(&sig, attest_alpha.as_bytes(), vrf_pubkey) {
        return Err("the attestation is not signed by OutLayer's randomness key".into());
    }
    Ok(())
}

/// Refuses a request profile that is neither a valid v2 profile nor a `{tight, aggro}` one.
fn check_profiles(profiles: &[Value]) {
    for (i, p) in profiles.iter().enumerate() {
        let parsed: Result<core::profile::AnyProfile, _> = near_sdk::serde_json::from_value(p.clone());
        match parsed.map(|p| p.into_v2()) {
            Ok(p) => {
                if let Err(e) = p.validate() {
                    env::panic_str(&format!("profile {i}: {e}"));
                }
            }
            Err(_) => env::panic_str(&format!("profile {i}: not a strategy profile")),
        }
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Table {
    pub(crate) owner: AccountId,
    outlayer: AccountId,
    project_id: String,
    vrf_pubkey: [u8; 32],
    hands: LookupMap<String, Hand>,
}

/// Checks that `signature_hex` is OutLayer's randomness proof for `{kind}-{hand_id}` and returns the deck seed.
fn seed_from_proof(vrf_pubkey: &[u8; 32], kind: &str, hand_id: &str, alpha: &str, signature_hex: &str) -> Result<[u8; 32], String> {
    if !alpha.starts_with("vrf:") || alpha.rsplit(':').next() != Some(&format!("{kind}-{hand_id}")) {
        return Err("the proof is for another request".into());
    }
    let sig: [u8; 64] = hex::decode(signature_hex).ok().and_then(|b| b.try_into().ok()).ok_or("the proof is not a 64-byte signature")?;
    if !env::ed25519_verify(&sig, alpha.as_bytes(), vrf_pubkey) {
        return Err("the proof is not signed by OutLayer's randomness key".into());
    }
    Ok(core::seed_from_signature(&sig))
}

fn names(d: &core::Deal) -> (Vec<String>, Vec<Vec<String>>) {
    (d.board.iter().map(|c| core::card_name(*c)).collect(), d.holes.iter().map(|h| h.iter().map(|c| core::card_name(*c)).collect()).collect())
}

/// Checks a showdown of a street-by-street hand. The proof must open the stored commitment; the cards and winners
/// come from re-running the shuffle.
pub fn verify_showdown(vrf_pubkey: &[u8; 32], hand_id: &str, commit_hex: &str, players: usize, alpha: &str, signature_hex: &str) -> Result<HandResult, String> {
    let seed = seed_from_proof(vrf_pubkey, "deal", hand_id, alpha, signature_hex)?;
    if hex::encode(core::commit(&seed)) != commit_hex {
        return Err("the proof does not open this hand's commitment".into());
    }
    let d = core::deal(&seed, players);
    let (board, holes) = names(&d);
    Ok(HandResult { board, holes, winners: core::winners(&d), actions: None, deltas: None })
}

/// Checks a one-call agent hand. The cards come from the proof; the actions the dealer reported are replayed under
/// the betting rules, so an illegal action, a missing one or a wrong payout cannot be recorded.
pub fn verify_play(vrf_pubkey: &[u8; 32], hand_id: &str, rules: &game::Rules, alpha: &str, signature_hex: &str, actions: &str) -> Result<HandResult, String> {
    let seed = seed_from_proof(vrf_pubkey, "play", hand_id, alpha, signature_hex)?;
    let d = core::deal(&seed, rules.stacks.len());
    let hand = game::replay(rules, &game::parse_actions(actions)?)?;
    let deltas = hand.payouts(&d)?;
    let (board, holes) = names(&d);
    let winners = (0..deltas.len()).filter(|i| deltas[*i] > 0).map(|i| i as u8).collect();
    Ok(HandResult { board, holes, winners, actions: Some(actions.to_string()), deltas: Some(deltas) })
}

#[near]
impl Table {
    #[init]
    pub fn new(outlayer: AccountId, project_id: String, vrf_pubkey_hex: String) -> Self {
        Self { owner: env::predecessor_account_id(), outlayer, project_id, vrf_pubkey: Self::parse_key(&vrf_pubkey_hex), hands: LookupMap::new(b"h") }
    }

    fn parse_key(hex_key: &str) -> [u8; 32] {
        hex::decode(hex_key).ok().and_then(|b| b.try_into().ok()).unwrap_or_else(|| env::panic_str("vrf key: 32 bytes of hex"))
    }

    pub fn set_vrf_pubkey(&mut self, vrf_pubkey_hex: String) {
        self.require_owner();
        self.vrf_pubkey = Self::parse_key(&vrf_pubkey_hex);
    }

    pub fn set_project(&mut self, project_id: String) {
        self.require_owner();
        self.project_id = project_id;
    }

    /// Records a new hand as pending, or accepts a retry of a pending hand with the same request.
    fn open(&mut self, hand_id: &str, players: usize, request: &Value) {
        let request = request.to_string();
        match self.hands.get(hand_id) {
            None => {
                self.hands.insert(
                    hand_id.to_string(),
                    Hand { players: players as u8, status: Status::Pending, request, commit: None, started_at: U64(env::block_timestamp()), result: None },
                );
            }
            Some(h) => {
                require!(h.status == Status::Pending, "hand exists");
                require!(h.request == request, "a retry must repeat the same request");
            }
        }
    }

    fn ask_dealer(&self, input: &Value, deposit: NearToken) -> Promise {
        let args = json!({
            "source": { "Project": { "project_id": self.project_id, "version_key": null } },
            "input_data": input.to_string(),
            "resource_limits": { "max_instructions": 2_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": 30 },
            "response_format": "Json",
        });
        Promise::new(self.outlayer.clone()).function_call("request_execution".to_string(), args.to_string().into_bytes(), deposit, OUTLAYER_GAS)
    }

    /// Plays a whole hand between agents in one dealer run. `profiles` are `{tight, aggro}` per seat (0 to 100).
    /// The attached NEAR pays OutLayer; what is not used comes back.
    #[payable]
    pub fn play_hand(&mut self, hand_id: String, stacks: Vec<U64>, profiles: Vec<Value>, button: u8, sb: U64, bb: U64) -> Promise {
        require!(profiles.len() == stacks.len(), "one profile per stack");
        check_profiles(&profiles);
        let stacks: Vec<u64> = stacks.iter().map(|s| s.0).collect();
        let rules = game::Rules { stacks: stacks.clone(), button: button as usize, sb: sb.0, bb: bb.0 };
        if let Err(e) = game::Hand::new(&rules) {
            env::panic_str(&e);
        }
        let request = json!({ "action": "play", "hand_id": hand_id, "stacks": stacks, "profiles": profiles, "button": button, "sb": sb.0, "bb": bb.0 });
        self.open(&hand_id, stacks.len(), &request);
        self.ask_dealer(&request, env::attached_deposit())
            .then(Self::ext(env::current_account_id()).with_static_gas(VERIFY_CALLBACK_GAS).on_play(hand_id))
    }

    /// Opens an agent hand without asking the dealer on-chain. The game server then fetches the dealer's answer
    /// over HTTPS and sends it to `submit_play`. Owner only: until the dealer signs its answers, the account that
    /// relays them could ask for a hand more than once under different ids and keep the one it prefers.
    pub fn open_play(&mut self, hand_id: String, stacks: Vec<U64>, profiles: Vec<Value>, button: u8, sb: U64, bb: U64) {
        self.require_operator();
        require!(profiles.len() == stacks.len(), "one profile per stack");
        check_profiles(&profiles);
        let stacks: Vec<u64> = stacks.iter().map(|s| s.0).collect();
        let rules = game::Rules { stacks: stacks.clone(), button: button as usize, sb: sb.0, bb: bb.0 };
        if let Err(e) = game::Hand::new(&rules) {
            env::panic_str(&e);
        }
        let request = json!({ "action": "play", "hand_id": hand_id, "stacks": stacks, "profiles": profiles, "button": button, "sb": sb.0, "bb": bb.0 });
        self.open(&hand_id, stacks.len(), &request);
    }

    /// Opens a session of agent hands. The game server fetches the dealer's answer over HTTPS and sends it to
    /// `submit_session`. Owner only, for the same reason as `open_play`.
    pub fn open_session(&mut self, session_id: String, stacks: Vec<U64>, profiles: Vec<Value>, button: u8, sb: U64, bb: U64, hands: u32) {
        self.require_operator();
        require!(profiles.len() == stacks.len(), "one profile per stack");
        check_profiles(&profiles);
        let stacks: Vec<u64> = stacks.iter().map(|s| s.0).collect();
        let start = game::Rules { stacks: stacks.clone(), button: button as usize, sb: sb.0, bb: bb.0 };
        if let Err(e) = core::session::check(&start, hands as usize) {
            env::panic_str(&e);
        }
        let request = json!({ "action": "session", "hand_id": session_id, "stacks": stacks, "profiles": profiles, "button": button, "sb": sb.0, "bb": bb.0, "hands": hands }).to_string();
        let mut all = sessions();
        match all.get(&session_id) {
            None => {
                all.insert(session_id, Session { status: Status::Pending, request, started_at: U64(env::block_timestamp()), result: None });
            }
            Some(s) => {
                require!(s.status == Status::Pending, "session exists");
                require!(s.request == request, "a retry must repeat the same request");
            }
        }
        all.flush();
    }

    /// Settles a session from the dealer's answer. Anyone may send it; a wrong answer changes nothing.
    ///
    /// Sessions opened by `open_backed_session` are attested (`"attest": "v1"` in the request): the dealer's answer
    /// carries `attest_alpha` and `attest_signature_hex`, OutLayer's VRF signature over a digest of the actions, the
    /// deck proof and the request. Without a matching attestation such a session is refused, so a relayer cannot
    /// change an action even into another legal one.
    ///
    /// `near_ai`: for NEAR-AI seats, the model's signed reply that chose the profile the dealer played (see nearai.rs).
    pub fn submit_session(&mut self, session_id: String, alpha: String, signature_hex: String, actions: String, attest_alpha: Option<String>, attest_signature_hex: Option<String>, near_ai: Option<Vec<nearai::NearAiProof>>) -> Value {
        let mut all = sessions();
        let s = all.get_mut(&session_id).unwrap_or_else(|| env::panic_str("no session"));
        if s.status != Status::Pending {
            return json!({ "ok": false, "error": "session is not pending" });
        }
        let req: Value = near_sdk::serde_json::from_str(&s.request).unwrap_or(Value::Null);
        let num = |k: &str| req.get(k).and_then(Value::as_u64).unwrap_or(0);
        let start = game::Rules {
            stacks: req.get("stacks").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default(),
            button: num("button") as usize,
            sb: num("sb"),
            bb: num("bb"),
        };
        let vrf_seating = req.get("seating").and_then(Value::as_str) == Some("vrf");
        // The deck proof and the betting rules first, then (for attested sessions) the dealer's signature over the
        // actions; nothing changes unless both pass.
        let verified = verify_seated_session(&self.vrf_pubkey, &session_id, &start, num("hands") as usize, &alpha, &signature_hex, &actions, vrf_seating).and_then(|v| {
            let played = nearai::verify_proofs(&req, near_ai.as_deref().unwrap_or(&[]))?;
            if req.get("attest").and_then(Value::as_str) != Some("v1") {
                if !played.is_empty() {
                    return Err("model proofs need an attested session".into());
                }
                return Ok(v);
            }
            match (&attest_alpha, &attest_signature_hex) {
                (Some(a), Some(sig)) => verify_attestation(&self.vrf_pubkey, &session_id, &alpha, &signature_hex, &req, &actions, a, sig, &played).map(|_| v),
                _ => Err("this session needs the dealer's attestation (attest_alpha, attest_signature_hex)".into()),
            }
        });
        let (r, order) = match verified {
            Ok((r, order)) => {
                s.status = Status::Done;
                s.result = Some(r.clone());
                (r, order)
            }
            Err(error) => return json!({ "ok": false, "error": error }),
        };
        let request = s.request.clone();
        all.flush();
        // Backed sessions pay out each seat's position in the same transaction.
        let payouts = self.settle_backed(&session_id, &r, order.as_deref());
        history::record_session(&session_id, &request, &alpha, &signature_hex, &actions, &r.stacks, &payouts, order.as_deref(), near_ai.as_deref().unwrap_or(&[]));
        json!({ "ok": true, "hands_played": r.hands_played, "stacks": r.stacks, "totals": r.totals, "payouts": payouts, "seat_order": order })
    }

    pub fn get_session(&self, session_id: String) -> Option<Session> {
        sessions().get(&session_id).cloned()
    }

    #[private]
    pub fn on_play(&mut self, hand_id: String, #[callback_result] result: Result<Value, PromiseError>) -> Value {
        let out = result.unwrap_or(Value::Null);
        let text = |k: &str| out.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        if out.get("ok").and_then(Value::as_bool) != Some(true) {
            return json!({ "ok": false, "error": "no answer from the dealer in time; call again to retry", "dealer": out });
        }
        self.settle_play(hand_id, text("alpha"), text("signature_hex"), text("actions"))
    }

    /// The same check as the play callback, open to anyone holding the dealer's answer (for example one fetched
    /// over HTTPS). A wrong answer changes nothing.
    pub fn submit_play(&mut self, hand_id: String, alpha: String, signature_hex: String, actions: String) -> Value {
        self.settle_play(hand_id, alpha, signature_hex, actions)
    }

    fn settle_play(&mut self, hand_id: String, alpha: String, signature_hex: String, actions: String) -> Value {
        let key = self.vrf_pubkey;
        let hand = self.hands.get_mut(&hand_id).unwrap_or_else(|| env::panic_str("no hand"));
        if hand.status != Status::Pending {
            return json!({ "ok": false, "error": "hand is not pending" });
        }
        let req: Value = near_sdk::serde_json::from_str(&hand.request).unwrap_or(Value::Null);
        if req.get("action").and_then(Value::as_str) != Some("play") {
            return json!({ "ok": false, "error": "not an agent hand" });
        }
        let num = |k: &str| req.get(k).and_then(Value::as_u64).unwrap_or(0);
        let rules = game::Rules {
            stacks: req.get("stacks").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default(),
            button: num("button") as usize,
            sb: num("sb"),
            bb: num("bb"),
        };
        match verify_play(&key, &hand_id, &rules, &alpha, &signature_hex, &actions) {
            Ok(r) => {
                hand.status = Status::Done;
                hand.result = Some(r.clone());
                json!({ "ok": true, "board": r.board, "holes": r.holes, "actions": r.actions, "deltas": r.deltas, "winners": r.winners })
            }
            Err(error) => json!({ "ok": false, "error": error }),
        }
    }

    /// Starts a street-by-street hand. `players` are X25519 public keys (hex); each gets its hole cards encrypted
    /// to that key.
    #[payable]
    pub fn deal(&mut self, hand_id: String, players: Vec<String>) -> Promise {
        require!((2..=core::MAX_PLAYERS).contains(&players.len()), "2 to 9 players");
        let request = json!({ "action": "deal", "hand_id": hand_id, "players": players });
        self.open(&hand_id, players.len(), &request);
        self.ask_dealer(&request, env::attached_deposit())
            .then(Self::ext(env::current_account_id()).with_static_gas(DEAL_CALLBACK_GAS).on_deal(hand_id))
    }

    #[private]
    pub fn on_deal(&mut self, hand_id: String, #[callback_result] result: Result<Value, PromiseError>) -> Value {
        let out = result.unwrap_or(Value::Null);
        let commit = out.get("commit").and_then(Value::as_str).filter(|c| c.len() == 64);
        match (out.get("ok").and_then(Value::as_bool), commit) {
            (Some(true), Some(commit)) => {
                let hand = self.hands.get_mut(&hand_id).unwrap_or_else(|| env::panic_str("no hand"));
                if hand.status == Status::Pending {
                    hand.commit = Some(commit.to_string());
                    hand.status = Status::Dealt;
                }
                out
            }
            _ => json!({ "ok": false, "error": "no answer from the dealer in time; call again to retry", "dealer": out }),
        }
    }

    /// Ends a street-by-street hand: fetches the randomness proof from the dealer and verifies it.
    #[payable]
    pub fn showdown(&mut self, hand_id: String) -> Promise {
        let hand = self.hands.get(&hand_id).unwrap_or_else(|| env::panic_str("no hand"));
        require!(hand.status == Status::Dealt, "hand is not live");
        self.ask_dealer(&json!({ "action": "showdown", "hand_id": hand_id }), env::attached_deposit())
            .then(Self::ext(env::current_account_id()).with_static_gas(VERIFY_CALLBACK_GAS).on_showdown(hand_id))
    }

    #[private]
    pub fn on_showdown(&mut self, hand_id: String, #[callback_result] result: Result<Value, PromiseError>) -> Value {
        let out = result.unwrap_or(Value::Null);
        let text = |k: &str| out.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        self.settle_showdown(hand_id, text("alpha"), text("signature_hex"))
    }

    /// The same check as the showdown callback, open to anyone holding a proof. A wrong proof changes nothing.
    pub fn submit_proof(&mut self, hand_id: String, alpha: String, signature_hex: String) -> Value {
        self.settle_showdown(hand_id, alpha, signature_hex)
    }

    fn settle_showdown(&mut self, hand_id: String, alpha: String, signature_hex: String) -> Value {
        let key = self.vrf_pubkey;
        let hand = self.hands.get_mut(&hand_id).unwrap_or_else(|| env::panic_str("no hand"));
        if hand.status != Status::Dealt {
            return json!({ "ok": false, "error": "hand is not live" });
        }
        let commit = hand.commit.clone().unwrap_or_default();
        match verify_showdown(&key, &hand_id, &commit, hand.players as usize, &alpha, &signature_hex) {
            Ok(r) => {
                hand.status = Status::Done;
                hand.result = Some(r.clone());
                json!({ "ok": true, "board": r.board, "holes": r.holes, "winners": r.winners })
            }
            Err(error) => json!({ "ok": false, "error": error }),
        }
    }

    pub fn get_hand(&self, hand_id: String) -> Option<Hand> {
        self.hands.get(&hand_id).cloned()
    }

    pub fn config(&self) -> Value {
        json!({ "owner": self.owner, "outlayer": self.outlayer, "project_id": self.project_id, "vrf_pubkey_hex": hex::encode(self.vrf_pubkey) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use poker_core::agent;

    struct Fixture {
        pk: [u8; 32],
        alpha: String,
        sig_hex: String,
        seed: [u8; 32],
        commit: String,
    }

    fn fixture(kind: &str, hand_id: &str) -> Fixture {
        let sk = SigningKey::from_bytes(&[42u8; 32]);
        let alpha = format!("vrf:98321:table.testnet:{kind}-{hand_id}");
        let sig = sk.sign(alpha.as_bytes()).to_bytes();
        let seed = core::seed_from_signature(&sig);
        Fixture { pk: sk.verifying_key().to_bytes(), alpha, sig_hex: hex::encode(sig), seed, commit: hex::encode(core::commit(&seed)) }
    }

    #[test]
    fn a_true_proof_gives_the_hand() {
        let f = fixture("deal", "h1");
        let r = verify_showdown(&f.pk, "h1", &f.commit, 3, &f.alpha, &f.sig_hex).unwrap();
        assert_eq!(r.holes.len(), 3);
        assert_eq!(r.board.len(), 5);
        assert!(!r.winners.is_empty());
        assert_eq!(r, verify_showdown(&f.pk, "h1", &f.commit, 3, &f.alpha, &f.sig_hex).unwrap());
    }

    #[test]
    fn a_changed_proof_is_refused() {
        let f = fixture("deal", "h1");
        let mut bad = f.sig_hex.clone().into_bytes();
        bad[0] = if bad[0] == b'0' { b'1' } else { b'0' };
        let bad = String::from_utf8(bad).unwrap();
        assert!(verify_showdown(&f.pk, "h1", &f.commit, 3, &f.alpha, &bad).is_err());
    }

    #[test]
    fn a_proof_from_another_key_is_refused() {
        let f = fixture("deal", "h1");
        let other = SigningKey::from_bytes(&[7u8; 32]);
        let sig = other.sign(f.alpha.as_bytes()).to_bytes();
        let commit = hex::encode(core::commit(&core::seed_from_signature(&sig)));
        let e = verify_showdown(&f.pk, "h1", &commit, 3, &f.alpha, &hex::encode(sig)).unwrap_err();
        assert!(e.contains("not signed"));
    }

    #[test]
    fn a_proof_for_another_hand_or_kind_is_refused() {
        let f = fixture("deal", "h2");
        assert!(verify_showdown(&f.pk, "h1", &f.commit, 3, &f.alpha, &f.sig_hex).unwrap_err().contains("another request"));
        // A street-by-street proof cannot settle an agent hand of the same id.
        let rules = game::Rules { stacks: vec![100, 100], button: 0, sb: 1, bb: 2 };
        assert!(verify_play(&f.pk, "h2", &rules, &f.alpha, &f.sig_hex, "f").unwrap_err().contains("another request"));
    }

    #[test]
    fn a_valid_proof_that_does_not_open_the_commitment_is_refused() {
        let sk = SigningKey::from_bytes(&[42u8; 32]);
        let f = fixture("deal", "h1");
        let alpha2 = "vrf:98322:table.testnet:deal-h1";
        let sig2 = sk.sign(alpha2.as_bytes()).to_bytes();
        let e = verify_showdown(&f.pk, "h1", &f.commit, 3, alpha2, &hex::encode(sig2)).unwrap_err();
        assert!(e.contains("commitment"));
    }

    fn agent_hand(f: &Fixture, rules: &game::Rules) -> String {
        let n = rules.stacks.len();
        let profiles: Vec<agent::Profile> = (0..n).map(|i| agent::Profile::from_legacy(20 + 10 * i as u8, 70 - 10 * i as u8)).collect();
        let d = core::deal(&f.seed, n);
        game::format_actions(&agent::play(&profiles, &f.seed, game::Hand::new(rules).unwrap(), &d))
    }

    #[test]
    fn an_agent_hand_replays_to_the_same_result() {
        let f = fixture("play", "a1");
        let rules = game::Rules { stacks: vec![200, 200, 200, 200], button: 1, sb: 1, bb: 2 };
        let actions = agent_hand(&f, &rules);
        let r = verify_play(&f.pk, "a1", &rules, &f.alpha, &f.sig_hex, &actions).unwrap();
        let deltas = r.deltas.unwrap();
        assert_eq!(deltas.len(), 4);
        assert_eq!(deltas.iter().sum::<i64>(), 0);
        assert_eq!(r.actions.as_deref(), Some(actions.as_str()));
    }

    #[test]
    fn a_session_replays_and_tampering_is_refused() {
        let f = fixture("session", "s1");
        let start = game::Rules { stacks: vec![300, 300, 300], button: 0, sb: 1, bb: 2 };
        let profiles = [agent::Profile::from_legacy(10, 80), agent::Profile::preset("Daredevil").unwrap(), agent::Profile::preset("Autopilot").unwrap()];
        let text = agent::play_session(&profiles, &f.seed, &start, 40).unwrap();
        let r = verify_session(&f.pk, "s1", &start, 40, &f.alpha, &f.sig_hex, &text).unwrap();
        assert_eq!(r.totals.iter().sum::<i64>(), 0);
        assert_eq!(r.stacks.iter().sum::<u64>(), 900);
        assert!(r.hands_played == 40 || core::session::active(&r.stacks) < 2);
        // A single-hand proof cannot settle a session, and a session cannot be cut short.
        let p = fixture("play", "s1");
        assert!(verify_session(&p.pk, "s1", &start, 40, &p.alpha, &p.sig_hex, &text).unwrap_err().contains("another request"));
        if r.hands_played > 1 {
            let short = &text[..text.rfind(';').unwrap()];
            assert!(verify_session(&f.pk, "s1", &start, 40, &f.alpha, &f.sig_hex, short).is_err());
        }
    }

    #[test]
    fn a_seated_session_replays_in_the_seed_s_seat_order() {
        let f = fixture("session", "s2");
        // Unequal stacks make the seat order matter to the replay.
        let start = game::Rules { stacks: vec![100, 200, 300, 400], button: 0, sb: 1, bb: 2 };
        let order = core::session::seat_order(&f.seed, 4);
        let seated = game::Rules { stacks: core::session::seat(&start.stacks, &order), ..start.clone() };
        let profiles = vec![agent::Profile::preset("Guardian").unwrap(); 4];
        let text = agent::play_session(&profiles, &f.seed, &seated, 20).unwrap();
        let (r, o) = verify_seated_session(&f.pk, "s2", &start, 20, &f.alpha, &f.sig_hex, &text, true).unwrap();
        assert_eq!(o, Some(order.clone()));
        assert_eq!(r.stacks.iter().sum::<u64>(), 1000);
        // The same actions read in the listed order are a different session: refused or a different result.
        if order != vec![0, 1, 2, 3] {
            let plain = verify_seated_session(&f.pk, "s2", &start, 20, &f.alpha, &f.sig_hex, &text, false);
            assert!(plain.map(|(p, _)| p.stacks != r.stacks || p.totals != r.totals).unwrap_or(true));
        }
    }

    #[test]
    fn changed_actions_are_refused_or_change_nothing_silently() {
        let f = fixture("play", "a1");
        let rules = game::Rules { stacks: vec![200, 200, 200, 200], button: 1, sb: 1, bb: 2 };
        let actions = agent_hand(&f, &rules);
        // Cutting the hand short is refused.
        let cut = &actions[..actions.rfind(',').unwrap_or(0)];
        assert!(verify_play(&f.pk, "a1", &rules, &f.alpha, &f.sig_hex, cut).is_err());
        // An illegal raise is refused.
        assert!(verify_play(&f.pk, "a1", &rules, &f.alpha, &f.sig_hex, "r3").is_err());
        // An extra action after the hand ended is refused.
        assert!(verify_play(&f.pk, "a1", &rules, &f.alpha, &f.sig_hex, &format!("{actions},c")).is_err());
    }

    // ---------------------------------------------------------------------------------------- backing vault flow

    use near_sdk::json_types::U128;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    const LEGACY: [(u8, u8); 4] = [(10, 80), (30, 60), (5, 90), (40, 50)];

    fn as_who(who: &str, deposit: u128, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("table.near".parse().unwrap())
            .predecessor_account_id(who.parse().unwrap())
            .signer_account_id(who.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(ts)
            .build());
    }

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    /// A table with four agents from four pros (`pro{i}.near`), each backed with 1 NEAR by a different backer. The
    /// listing rules are off here (no track record needed); the listing tests turn them on.
    fn backed_table() -> (Table, Vec<BackedSeat>, [u8; 32]) {
        let f = fixture("session", "v1");
        as_who("table.near", 0, 1);
        let mut t = Table::new(acct("outlayer.near"), "pro.near/dealer".into(), hex::encode(f.pk));
        t.set_listing_rules(0, U64(0));
        let mut seats = vec![];
        for (i, (tight, aggro)) in LEGACY.iter().enumerate() {
            as_who(&format!("pro{i}.near"), 0, 1);
            t.register_agent(format!("agent-{i}"), None, Some(*tight), Some(*aggro));
            let backer = format!("backer{i}.near");
            as_who(&backer, NEAR, 1);
            t.back(format!("agent-{i}"), Some(U128(NEAR / 2)));
            seats.push(BackedSeat { backer: Some(acct(&backer)), agent_id: format!("agent-{i}") });
        }
        (t, seats, f.pk)
    }

    fn pro_earnings(t: &Table) -> u128 {
        (0..4).map(|i| t.get_earnings(acct(&format!("pro{i}.near"))).0).sum()
    }

    fn total_held(t: &Table, seats: &[BackedSeat]) -> u128 {
        let positions: u128 = seats.iter().map(|s| { let p = t.get_position(s.backer.clone().unwrap(), s.agent_id.clone()).unwrap(); p.balance.0 + p.at_table.0 }).sum();
        positions + pro_earnings(t) + t.get_earnings(acct("table.near")).0
    }

    /// What the dealer plays for a backed session of agent-0..3 (listed in that order): the agents' profiles, seated
    /// in the order the session's seed gives.
    fn seated_text(f: &Fixture, profiles: &[agent::Profile], buy_in: u64, hands: usize) -> String {
        let order = core::session::seat_order(&f.seed, profiles.len());
        let start = game::Rules { stacks: vec![buy_in; profiles.len()], button: 0, sb: 1, bb: 2 };
        agent::play_session(&core::session::seat(profiles, &order), &f.seed, &start, hands).unwrap()
    }

    /// The dealer's attestation for a pending session's actions, as the test VRF key would sign it in that run.
    fn attestation(t: &Table, id: &str, f: &Fixture, text: &str) -> (String, String) {
        attestation_played(t, id, f, text, &[])
    }

    fn attestation_played(t: &Table, id: &str, f: &Fixture, text: &str, played: &[(usize, agent::Profile)]) -> (String, String) {
        let req: Value = near_sdk::serde_json::from_str(&t.get_session(id.into()).unwrap().request).unwrap();
        let num = |k: &str| req[k].as_u64().unwrap_or(0);
        let listed = game::Rules { stacks: req["stacks"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).collect(), button: num("button") as usize, sb: num("sb"), bb: num("bb") };
        let mut profiles: Vec<agent::Profile> = req["profiles"].as_array().unwrap().iter().map(|p| near_sdk::serde_json::from_value::<core::profile::AnyProfile>(p.clone()).unwrap().into_v2()).collect();
        for (seat, p) in played {
            profiles[*seat] = p.clone();
        }
        let digest = core::session::attest_digest(id, &f.sig_hex, &listed, num("hands") as usize, req["seating"].as_str(), &profiles, text);
        let alpha = format!("vrf:98399:table.testnet:{}", core::session::attest_label(&digest));
        let sig = SigningKey::from_bytes(&[42u8; 32]).sign(alpha.as_bytes()).to_bytes();
        (alpha, hex::encode(sig))
    }

    /// Settles a session as the feeder does: the dealer's answer with its attestation.
    fn submit(t: &mut Table, id: &str, f: &Fixture, text: &str) -> Value {
        let (a, s) = if t.get_session(id.into()).map_or(false, |s| s.status == Status::Pending) { attestation(t, id, f, text) } else { (String::new(), String::new()) };
        t.submit_session(id.into(), f.alpha.clone(), f.sig_hex.clone(), text.into(), Some(a), Some(s), None)
    }

    #[test]
    fn an_attested_session_refuses_any_other_actions() {
        let (mut t, seats, _) = backed_table();
        as_who("table.near", 0, 2);
        assert_eq!(t.open_backed_session("at".into(), seats, U64(100), 0, U64(1), U64(2), 20)["attest"], "v1");
        let (f, text) = session_text("at", 100, 20);
        let (a, s) = attestation(&t, "at", &f, &text);
        let try_submit = |t: &mut Table, actions: &str, a: Option<String>, s: Option<String>| t.submit_session("at".into(), f.alpha.clone(), f.sig_hex.clone(), actions.into(), a, s, None);
        // No attestation.
        let out = try_submit(&mut t, &text, None, None);
        assert!(out["error"].as_str().unwrap().contains("needs the dealer's attestation"), "{out}");
        // An illegal edit fails the replay; a legal edit (another action that still replays) fails the attestation.
        let out = try_submit(&mut t, &format!("{text},c"), Some(a.clone()), Some(s.clone()));
        assert!(out["error"].as_str().is_some() && out["ok"] == false, "{out}");
        let listed = game::Rules { stacks: vec![100; 4], button: 0, sb: 1, bb: 2 };
        let hands: Vec<Vec<String>> = text.split(';').map(|h| h.split(',').map(String::from).collect()).collect();
        let mut legal = None;
        'search: for (hi, h) in hands.iter().enumerate() {
            for (ai, act) in h.iter().enumerate() {
                for alt in ["c", "f", "r4", "r6"] {
                    if alt == act {
                        continue;
                    }
                    let mut edited = hands.clone();
                    edited[hi][ai] = alt.to_string();
                    let cand = edited.iter().map(|h| h.join(",")).collect::<Vec<_>>().join(";");
                    if verify_seated_session(&f.pk, "at", &listed, 20, &f.alpha, &f.sig_hex, &cand, true).is_ok() {
                        legal = Some(cand);
                        break 'search;
                    }
                }
            }
        }
        let legal = legal.expect("some single action can be changed legally");
        let out = try_submit(&mut t, &legal, Some(a.clone()), Some(s.clone()));
        assert!(out["error"].as_str().unwrap().contains("does not match"), "{out}");
        // An attestation from another account's run, or signed by another key.
        let other = a.replace(":table.testnet:", ":mallory.testnet:");
        assert!(try_submit(&mut t, &text, Some(other), Some(s.clone()))["error"].as_str().unwrap().contains("not from the dealer's run"));
        let forged = hex::encode(SigningKey::from_bytes(&[7u8; 32]).sign(a.as_bytes()).to_bytes());
        assert!(try_submit(&mut t, &text, Some(a.clone()), Some(forged))["error"].as_str().unwrap().contains("not signed"));
        assert_eq!(t.get_session("at".into()).unwrap().status, Status::Pending);
        // The real answer settles.
        assert_eq!(try_submit(&mut t, &text, Some(a), Some(s))["ok"], true);
    }

    fn session_text(id: &str, buy_in: u64, hands: usize) -> (Fixture, String) {
        let f = fixture("session", id);
        let profiles: Vec<agent::Profile> = LEGACY.iter().map(|(t, a)| agent::Profile::from_legacy(*t, *a)).collect();
        let text = seated_text(&f, &profiles, buy_in, hands);
        (f, text)
    }

    #[test]
    fn a_backed_session_pays_each_backer_pro_and_platform_and_conserves_money() {
        let (mut t, seats, _) = backed_table();
        assert_eq!(total_held(&t, &seats), 4 * NEAR);
        as_who("table.near", 0, 2);
        let req = t.open_backed_session("v1".into(), seats.clone(), U64(300), 0, U64(1), U64(2), 30);
        assert_eq!(req["seating"], "vrf");
        // 300 chips at 0.001 NEAR = 0.3 NEAR locked per seat.
        let p0 = t.get_position(seats[0].backer.clone().unwrap(), "agent-0".into()).unwrap();
        assert_eq!((p0.balance.0, p0.at_table.0), (NEAR - 3 * NEAR / 10, 3 * NEAR / 10));
        // Repeating the identical open locks nothing more.
        t.open_backed_session("v1".into(), seats.clone(), U64(300), 0, U64(1), U64(2), 30);
        assert_eq!(t.get_position(seats[0].backer.clone().unwrap(), "agent-0".into()).unwrap().at_table.0, 3 * NEAR / 10);

        let (f, text) = session_text("v1", 300, 30);
        let out = submit(&mut t, "v1", &f, &text);
        assert_eq!(out["ok"], true, "{out}");
        // Nothing is created or lost: what backers deposited is now in positions or fee earnings.
        assert_eq!(total_held(&t, &seats), 4 * NEAR);
        let stacks: Vec<u64> = out["stacks"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).collect();
        let order: Vec<usize> = out["seat_order"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize).collect();
        assert_eq!(order, core::session::seat_order(&f.seed, 4));
        let mut pro_fees = 0u128;
        for (pos, listed) in order.iter().enumerate() {
            let s = &seats[*listed];
            // Payouts are reported by table position.
            assert_eq!(out["payouts"]["seats"][pos]["agent"], s.agent_id);
            let p = t.get_position(s.backer.clone().unwrap(), s.agent_id.clone()).unwrap();
            assert_eq!(p.at_table.0, 0);
            let profit = (stacks[pos] as u128 * NEAR / 1000).saturating_sub(3 * NEAR / 10);
            assert_eq!(p.fees_paid.0, profit * 8 / 100 + profit * 2 / 100, "seat {pos}");
            assert_eq!(t.get_earnings(acct(&format!("pro{listed}.near"))).0, profit * 8 / 100);
            pro_fees += profit * 8 / 100;
        }
        assert_eq!(pro_earnings(&t), pro_fees);
        assert_eq!(t.get_agent("agent-0".into()).unwrap().sessions, 1);
        // Settled once only.
        assert_eq!(submit(&mut t, "v1", &f, "f")["ok"], false);
    }

    #[test]
    #[should_panic(expected = "loss limit")]
    fn a_seat_beyond_the_loss_limit_is_refused() {
        let (mut t, seats, _) = backed_table();
        // Limits are 0.5 NEAR; a 0.6 NEAR buy-in could lose more than that.
        as_who("table.near", 0, 2);
        t.open_backed_session("v1".into(), seats, U64(600), 0, U64(1), U64(2), 30);
    }

    #[test]
    #[should_panic(expected = "more than the idle balance")]
    fn funds_at_a_table_cannot_be_withdrawn() {
        let (mut t, seats, _) = backed_table();
        as_who("table.near", 0, 2);
        t.open_backed_session("v1".into(), seats, U64(300), 0, U64(1), U64(2), 30);
        as_who("backer0.near", 0, 3);
        let _ = t.withdraw("agent-0".into(), U128(NEAR - 3 * NEAR / 10 + 1));
    }

    #[test]
    #[should_panic(expected = "owner or operator only")]
    fn only_the_server_opens_backed_sessions() {
        let (mut t, seats, _) = backed_table();
        as_who("backer0.near", 0, 2);
        t.open_backed_session("v1".into(), seats, U64(300), 0, U64(1), U64(2), 30);
    }

    #[test]
    fn an_unanswered_session_can_be_cancelled_only_after_an_hour() {
        let (mut t, seats, _) = backed_table();
        as_who("table.near", 0, 10);
        t.open_backed_session("v1".into(), seats.clone(), U64(300), 0, U64(1), U64(2), 30);
        as_who("table.near", 0, 10 + 59 * 60 * 1_000_000_000);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.cancel_session("v1".into()))).is_err());
        as_who("table.near", 0, 10 + 61 * 60 * 1_000_000_000);
        t.cancel_session("v1".into());
        let p = t.get_position(seats[0].backer.clone().unwrap(), "agent-0".into()).unwrap();
        assert_eq!((p.balance.0, p.at_table.0), (NEAR, 0));
        assert_eq!(total_held(&t, &seats), 4 * NEAR);
    }

    #[test]
    fn an_agent_takes_one_seat_and_unknown_agents_are_refused() {
        let (mut t, seats, _) = backed_table();
        as_who("table.near", 0, 2);
        let twice = vec![seats[0].clone(), seats[0].clone()];
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.open_backed_session("v1".into(), twice, U64(100), 0, U64(1), U64(2), 10))).is_err());
        let ghost = vec![seats[0].clone(), BackedSeat { backer: Some(acct("backer1.near")), agent_id: "nobody".into() }];
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.open_backed_session("v2".into(), ghost, U64(100), 0, U64(1), U64(2), 10))).is_err());
    }

    // ---------------------------------------------------------------------------------------- pooled backing

    #[test]
    fn a_mixed_session_settles_pools_and_positions_and_applies_queued_joins_and_leaves() {
        let (mut t, seats, _) = backed_table();
        let mut deposits = 4 * NEAR; // the four positions from backed_table
        for (who, agent, amount) in [("alice.near", "agent-0", NEAR), ("bob.near", "agent-0", NEAR / 2), ("alice.near", "agent-1", 3 * NEAR / 2)] {
            as_who(who, amount, 1);
            assert_eq!(t.join_pool(agent.into())["queued"], false);
            deposits += amount;
        }
        let pooled = vec![
            BackedSeat { backer: None, agent_id: "agent-0".into() },
            BackedSeat { backer: None, agent_id: "agent-1".into() },
            seats[2].clone(),
            seats[3].clone(),
        ];
        as_who("table.near", 0, 2);
        t.open_backed_session("p1".into(), pooled, U64(300), 0, U64(1), U64(2), 30);
        assert_eq!(t.get_pool("agent-0".into()).unwrap().at_table.0, 3 * NEAR / 10);

        // While the session is in play, a join and a leave are queued rather than priced now.
        as_who("carol.near", 4 * NEAR / 10, 3);
        assert_eq!(t.join_pool("agent-0".into())["queued"], true);
        deposits += 4 * NEAR / 10;
        let alice_shares: u128 = t.get_holding(acct("alice.near"), "agent-0".into())["shares"].as_str().unwrap().parse().unwrap();
        as_who("alice.near", 0, 3);
        assert_eq!(t.leave_pool("agent-0".into(), U128(alice_shares / 2))["queued"], true);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.leave_pool("agent-0".into(), U128(alice_shares / 2 + 1)))).is_err(), "cannot queue more than held");

        let (f, text) = session_text("p1", 300, 30);
        as_who("anyone.near", 0, 4);
        let out = submit(&mut t, "p1", &f, &text);
        assert_eq!(out["ok"], true, "{out}");

        let mut paid_out = 0u128;
        for seat in out["payouts"]["seats"].as_array().unwrap() {
            for m in seat["pool_moves"].as_array().into_iter().flatten() {
                if let Some(p) = m["paid"].as_str() {
                    paid_out += p.parse::<u128>().unwrap();
                }
            }
        }
        assert!(paid_out > 0, "alice's queued leave was paid");
        let pool0 = t.get_pool("agent-0".into()).unwrap();
        assert_eq!((pool0.at_table.0, pool0.pending_in.0, pool0.pending_out_shares.0), (0, 0, 0));
        // Carol joined at the settled value: her shares are worth what she paid, give or take rounding.
        let carol: u128 = t.get_holding(acct("carol.near"), "agent-0".into())["value"].as_str().unwrap().parse().unwrap();
        assert!(4 * NEAR / 10 - carol < 1_000_000, "carol's holding is worth {carol}");

        // Every yoctoNEAR deposited is in a position, a pool, fee earnings, or was paid out to alice.
        let pools_value: u128 = ["agent-0", "agent-1"].iter().map(|a| t.get_pool(a.to_string()).unwrap().value.0).sum();
        let positions: u128 = (0..4)
            .map(|i| t.get_position(acct(&format!("backer{i}.near")), format!("agent-{i}")).unwrap())
            .map(|p| p.balance.0 + p.at_table.0)
            .sum();
        let fees = pro_earnings(&t) + t.get_earnings(acct("table.near")).0;
        assert_eq!(positions + pools_value + fees + paid_out, deposits);
    }

    #[test]
    fn a_pool_stakes_at_most_its_risk_cap() {
        let (mut t, _, _) = backed_table();
        as_who("alice.near", NEAR, 1);
        t.join_pool("agent-0".into());
        as_who("alice.near", NEAR, 1);
        t.join_pool("agent-1".into());
        as_who("table.near", 0, 2);
        // 0.3 NEAR is more than 25% of a 1 NEAR pool.
        let seats = vec![BackedSeat { backer: None, agent_id: "agent-0".into() }, BackedSeat { backer: None, agent_id: "agent-1".into() }];
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.open_backed_session("p1".into(), seats.clone(), U64(300), 0, U64(1), U64(2), 10)));
        assert!(r.is_err());
        // The pro may raise the cap to 50%; nobody else may.
        as_who("alice.near", 0, 3);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.set_pool_risk("agent-0".into(), 5000))).is_err());
        as_who("pro0.near", 0, 3);
        t.set_pool_risk("agent-0".into(), 5000);
        as_who("pro1.near", 0, 3);
        t.set_pool_risk("agent-1".into(), 5000);
        as_who("table.near", 0, 4);
        t.open_backed_session("p1".into(), seats, U64(300), 0, U64(1), U64(2), 10);
    }

    #[test]
    fn leaving_an_idle_pool_pays_at_once() {
        let (mut t, _, _) = backed_table();
        as_who("alice.near", NEAR, 1);
        let shares: u128 = t.join_pool("agent-0".into())["shares"].as_str().unwrap().parse().unwrap();
        as_who("alice.near", 0, 2);
        let out = t.leave_pool("agent-0".into(), U128(shares));
        assert_eq!(out["paid"], U128(NEAR).0.to_string());
        assert_eq!(t.get_pool("agent-0".into()).unwrap().value.0, 0);
    }

    #[test]
    fn settled_sessions_and_agents_can_be_listed_and_replayed() {
        let (mut t, seats, _) = backed_table();
        let cards = t.list_agents(None, None);
        assert_eq!(cards.iter().map(|c| c.agent.id.clone()).collect::<Vec<_>>(), vec!["agent-0", "agent-1", "agent-2", "agent-3"]);
        assert!(cards[0].pool.is_none());
        as_who("table.near", 0, 2);
        t.open_backed_session("v1".into(), seats, U64(300), 0, U64(1), U64(2), 30);
        let (f, text) = session_text("v1", 300, 30);
        submit(&mut t, "v1", &f, &text);
        let rec = t.get_session_record("v1".into()).unwrap();
        assert_eq!(rec["signature_hex"], f.sig_hex);
        assert_eq!(rec["actions"], text);
        assert_eq!(rec["stacks"], json!([300, 300, 300, 300]));
        assert_eq!(rec["payouts"]["seats"].as_array().unwrap().len(), 4);
        // The record is enough to replay: re-deal from the proof and get the contract's result.
        let start = game::Rules { stacks: vec![300; 4], button: 0, sb: 1, bb: 2 };
        let seed = core::seed_from_signature(&hex::decode(rec["signature_hex"].as_str().unwrap()).unwrap());
        let out = core::session::replay(&start, &seed, 30, rec["actions"].as_str().unwrap()).unwrap();
        assert_eq!(json!(out.stacks), rec["end_stacks"]);
        let recent = t.recent_sessions(None);
        assert_eq!(recent.len(), 1);
        let order = core::session::seat_order(&f.seed, 4);
        assert_eq!(recent[0]["agents"], json!(order.iter().map(|i| format!("agent-{i}")).collect::<Vec<_>>()));
        assert_eq!(rec["seat_order"], json!(order));
    }

    // ---------------------------------------------------------------------------------------- agents v2

    fn panics<R>(f: impl FnOnce() -> R) -> String {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        match r {
            Ok(_) => String::new(),
            Err(e) => e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "panicked".into()),
        }
    }

    fn pool_seats(ids: &[&str]) -> Vec<BackedSeat> {
        ids.iter().map(|a| BackedSeat { backer: None, agent_id: a.to_string() }).collect()
    }

    #[test]
    fn v2_profiles_register_update_and_show_in_views() {
        let (mut t, _, _) = backed_table();
        as_who("pro9.near", 0, 5);
        let dare = agent::Profile::preset("Daredevil").unwrap();
        let v = t.register_agent("dare".into(), Some(dare.clone()), None, None);
        assert_eq!((v.strategy_version, v.profile.clone()), (1, dare.clone()));
        // The first-generation numbers are filled in for older clients.
        assert_eq!((v.tight, v.aggro), dare.legacy_view());
        // A legacy agent shows the v2 profile it plays.
        assert_eq!(t.get_profile("agent-0".into()).unwrap(), agent::Profile::from_legacy(10, 80));
        // Bad values are refused with the field's name.
        let mut bad = dare.clone();
        bad.aggression = 99;
        assert!(panics(|| t.register_agent("bad".into(), Some(bad.clone()), None, None)).contains("aggression"));
        assert!(panics(|| t.register_agent("none".into(), None, None, None)).contains("give a profile"));
        // Only the pro updates; the same strategy again is refused; an update is a new version.
        as_who("pro0.near", 0, 6);
        assert!(panics(|| t.update_agent("dare".into(), agent::Profile::preset("Guardian").unwrap())).contains("only the agent's pro"));
        as_who("pro9.near", 0, 6);
        assert!(panics(|| t.update_agent("dare".into(), dare.clone())).contains("already"));
        let auto = agent::Profile::preset("Autopilot").unwrap();
        let v = t.update_agent("dare".into(), auto.clone());
        assert_eq!((v.strategy_version, v.profile), (2, auto));
        let card = t.list_agents(None, None).into_iter().find(|c| c.agent.id == "dare").unwrap();
        assert_eq!(card.listing.strategy_version, 2);
        assert_eq!(card.limits.loss_limit_bps, strategy::DEFAULT_POOL_LOSS_LIMIT_BPS);
        // JSON shapes: a profile round-trips, and {tight, aggro} still parses for open_session.
        let json_profile = near_sdk::serde_json::to_value(&v.strategy_version).unwrap();
        assert_eq!(json_profile, json!(2));
        let p: core::profile::AnyProfile = near_sdk::serde_json::from_value(json!({ "tight": 10, "aggro": 80 })).unwrap();
        assert_eq!(p.into_v2(), agent::Profile::from_legacy(10, 80));
        let p: core::profile::AnyProfile = near_sdk::serde_json::from_value(json!({ "fold_below": 40, "raise_above": 60, "aggression": 25, "bluff_chance": 2, "raise_size": 45 })).unwrap();
        assert_eq!(p.into_v2(), agent::Profile::new([40, 60, 25, 2, 45]));
    }

    #[test]
    fn a_session_cannot_seat_two_agents_of_one_pro() {
        let (mut t, mut seats, _) = backed_table();
        as_who("pro0.near", 0, 2);
        t.register_agent("agent-0b".into(), Some(agent::Profile::preset("Trapper").unwrap()), None, None);
        as_who("backer9.near", NEAR, 2);
        t.back("agent-0b".into(), Some(U128(NEAR)));
        seats[1] = BackedSeat { backer: Some(acct("backer9.near")), agent_id: "agent-0b".into() };
        as_who("table.near", 0, 3);
        let e = panics(|| t.open_backed_session("sp".into(), seats.clone(), U64(100), 0, U64(1), U64(2), 10));
        assert!(e.contains("self-play") && e.contains("pro0.near"), "{e}");
        // Handing the agent to another pro makes the table legal.
        as_who("pro0.near", 0, 4);
        t.transfer_agent("agent-0b".into(), acct("pro7.near"));
        as_who("table.near", 0, 5);
        t.open_backed_session("sp".into(), seats, U64(100), 0, U64(1), U64(2), 10);
    }

    #[test]
    fn the_operator_opens_sessions_but_no_owner_method() {
        let (mut t, seats, _) = backed_table();
        as_who("feeder.near", 0, 2);
        assert!(panics(|| t.open_backed_session("o1".into(), seats.clone(), U64(100), 0, U64(1), U64(2), 10)).contains("owner or operator only"));
        as_who("table.near", 0, 2);
        t.set_operator(Some(acct("feeder.near")));
        assert_eq!(t.get_rules().operator, Some(acct("feeder.near")));
        as_who("feeder.near", 0, 3);
        t.open_backed_session("o1".into(), seats.clone(), U64(100), 0, U64(1), U64(2), 10);
        t.open_session("o2".into(), vec![U64(100), U64(100)], vec![json!({ "tight": 10, "aggro": 80 }), json!(agent::Profile::preset("Guardian").unwrap())], 0, U64(1), U64(2), 5);
        assert!(panics(|| t.open_session("o3".into(), vec![U64(100), U64(100)], vec![json!({ "fold_below": 1 }), json!({ "tight": 1, "aggro": 1 })], 0, U64(1), U64(2), 5)).contains("profile 0"));
        // Every owner-only method refuses the operator.
        let owner_only: Vec<Box<dyn Fn(&mut Table)>> = vec![
            Box::new(|t| t.set_operator(Some(acct("feeder.near")))),
            Box::new(|t| t.set_listing_rules(0, U64(0))),
            Box::new(|t| t.set_default_pool_loss_limit(10_000)),
            Box::new(|t| t.set_vault_config(U128(1), 800, 200, acct("feeder.near"))),
            Box::new(|t| t.set_project("x/y".into())),
            Box::new(|t| t.set_vrf_pubkey(hex::encode([1u8; 32]))),
            Box::new(|t| t.index_agents(vec![])),
        ];
        for f in owner_only {
            assert!(panics(|| f(&mut t)).contains("owner only"));
        }
        // It cannot cancel early or move anyone's money either.
        assert!(panics(|| t.cancel_session("o1".into())).contains("too early"));
        assert!(panics(|| t.withdraw("agent-0".into(), U128(1))).contains("no position"));
        assert!(panics(|| t.claim_earnings()).contains("nothing to claim"));
        // The owner can remove it.
        as_who("table.near", 0, 4);
        t.set_operator(None);
        as_who("feeder.near", 0, 5);
        assert!(panics(|| t.open_session("o4".into(), vec![U64(100), U64(100)], vec![json!({ "tight": 1, "aggro": 1 }); 2], 0, U64(1), U64(2), 5)).contains("owner or operator only"));
    }

    #[test]
    fn backers_wait_for_a_track_record_and_a_strategy_change_restarts_it() {
        let (mut t, seats, _) = backed_table();
        as_who("table.near", 0, 1);
        t.set_listing_rules(1, U64(10));
        // The pro may always fund their own agent; a stranger may not until it qualifies.
        as_who("pro0.near", NEAR, 2);
        t.join_pool("agent-0".into());
        as_who("alice.near", NEAR, 2);
        let e = panics(|| t.join_pool("agent-1".into()));
        assert!(e.contains("not open to backers yet") && e.contains("0 of 1 sessions"), "{e}");
        assert!(panics(|| t.back("agent-1".into(), None)).contains("not open to backers yet"));
        assert!(!t.get_listing("agent-1".into()).unwrap().qualified);
        // One settled session of 30 hands qualifies all four.
        as_who("table.near", 0, 3);
        t.open_backed_session("q1".into(), seats.clone(), U64(100), 0, U64(1), U64(2), 30);
        let (f, text) = session_text("q1", 100, 30);
        assert_eq!(submit(&mut t, "q1", &f, &text)["ok"], true);
        let l = t.get_listing("agent-1".into()).unwrap();
        assert!(l.qualified && l.open_to_backers && l.sessions == 1, "{l:?}");
        as_who("alice.near", NEAR, 4);
        t.join_pool("agent-1".into());
        // A new strategy starts over.
        as_who("pro1.near", 0, 5);
        t.update_agent("agent-1".into(), agent::Profile::preset("Daredevil").unwrap());
        let l = t.get_listing("agent-1".into()).unwrap();
        assert_eq!((l.strategy_version, l.sessions, l.qualified), (2, 0, false));
        as_who("bob.near", NEAR, 6);
        assert!(panics(|| t.join_pool("agent-1".into())).contains("strategy v2 has 0 of 1 sessions"));
        // A session opened before the change does not count toward the new version.
        as_who("table.near", 0, 7);
        t.open_backed_session("q2".into(), seats.clone(), U64(100), 0, U64(1), U64(2), 30);
        as_who("pro1.near", 0, 8);
        t.update_agent("agent-1".into(), agent::Profile::preset("Guardian").unwrap());
        let f = fixture("session", "q2");
        let profiles: Vec<agent::Profile> = vec![agent::Profile::from_legacy(10, 80), agent::Profile::preset("Daredevil").unwrap(), agent::Profile::from_legacy(5, 90), agent::Profile::from_legacy(40, 50)];
        let text = seated_text(&f, &profiles, 100, 30);
        assert_eq!(submit(&mut t, "q2", &f, &text)["ok"], true);
        assert_eq!(t.get_listing("agent-1".into()).unwrap().sessions, 0);
        assert_eq!(t.get_listing("agent-2".into()).unwrap().sessions, 2);
    }

    #[test]
    fn a_pool_past_its_loss_limit_takes_no_new_sessions() {
        let (mut t, _, _) = backed_table();
        for (who, agent) in [("pro0.near", "agent-0"), ("pro1.near", "agent-1")] {
            as_who(who, NEAR, 2);
            t.join_pool(agent.into());
        }
        // The default may be set by the owner only; a pro may only tighten it.
        as_who("pro0.near", 0, 2);
        assert!(panics(|| t.set_default_pool_loss_limit(100)).contains("owner only"));
        assert!(panics(|| t.set_pool_loss_limit("agent-0".into(), Some(6000))).contains("only tighten"));
        assert!(panics(|| t.set_pool_loss_limit("agent-1".into(), Some(100))).contains("only the agent's pro"));
        // Play sessions until agent-0's pool is down at least 1%, then a 1% limit refuses the next session.
        let mut k = 0;
        while t.get_pool_limits("agent-0".into()).unwrap().drawdown_bps < 100 && k < 40 {
            let id = format!("l{k}");
            as_who("table.near", 0, 10 + k);
            t.open_backed_session(id.clone(), pool_seats(&["agent-0", "agent-1"]), U64(100), 0, U64(1), U64(2), 20);
            let f = fixture("session", &id);
            let profiles = vec![agent::Profile::from_legacy(10, 80), agent::Profile::from_legacy(30, 60)];
            let text = seated_text(&f, &profiles, 100, 20);
            assert_eq!(submit(&mut t, &id, &f, &text)["ok"], true);
            k += 1;
        }
        let lim = t.get_pool_limits("agent-0".into()).unwrap();
        assert!(lim.drawdown_bps >= 100, "agent-0 never lost 1% in {k} sessions: {lim:?}");
        assert!(lim.accepts_sessions);
        as_who("pro0.near", 0, 100);
        t.set_pool_loss_limit("agent-0".into(), Some(100));
        let lim = t.get_pool_limits("agent-0".into()).unwrap();
        assert_eq!((lim.loss_limit_bps, lim.pro_loss_limit_bps, lim.accepts_sessions), (100, Some(100), false));
        as_who("table.near", 0, 101);
        let e = panics(|| t.open_backed_session("lx".into(), pool_seats(&["agent-0", "agent-1"]), U64(10), 0, U64(1), U64(2), 5));
        assert!(e.contains("past its loss limit"), "{e}");
        // The owner's default applies too, and the tighter of the two wins.
        as_who("pro0.near", 0, 102);
        t.set_pool_loss_limit("agent-0".into(), None);
        as_who("table.near", 0, 103);
        t.set_default_pool_loss_limit(100);
        assert!(panics(|| t.open_backed_session("ly".into(), pool_seats(&["agent-0", "agent-1"]), U64(10), 0, U64(1), U64(2), 5)).contains("past its loss limit"));
        // Its backers can still leave.
        as_who("pro0.near", 0, 104);
        let shares = t.get_pool("agent-0".into()).unwrap().shares;
        assert!(t.leave_pool("agent-0".into(), shares)["paid"].as_str().is_some());
    }

    // ---------------------------------------------------------------------------------------- NEAR-AI agents

    const MODEL: &str = "Qwen/Qwen3.6-35B-A3B-FP8";

    /// A stand-in for the model's TEE key: signs EIP-191 like NEAR AI Cloud. Returns (address, sign fn).
    fn model_key(seed: u8) -> (String, impl Fn(&str) -> String) {
        let sk = k256::ecdsa::SigningKey::from_bytes(&[seed; 32].into()).unwrap();
        let pk = sk.verifying_key().to_encoded_point(false);
        let address = format!("0x{}", hex::encode(&env::keccak256(&pk.as_bytes()[1..])[12..]));
        let sign = move |text: &str| {
            let hash = env::keccak256(&core::nearai::eip191_message(text));
            let (sig, rec) = sk.sign_prehash_recoverable(&hash).unwrap();
            let mut b = sig.to_bytes().to_vec();
            b.push(27 + rec.to_byte());
            format!("0x{}", hex::encode(b))
        };
        (address, sign)
    }

    fn model_reply(chat_id: &str, content: &str) -> String {
        json!({ "id": chat_id, "object": "chat.completion", "model": MODEL, "choices": [{ "index": 0, "message": { "role": "assistant", "content": content }, "finish_reason": "stop" }] }).to_string()
    }

    #[test]
    fn a_near_ai_agent_plays_the_profile_its_model_signed() {
        let (mut t, seats, _) = backed_table();
        let (address, sign) = model_key(9);
        let dealer_sk = [3u8; 32];
        as_who("table.near", 0, 2);
        t.set_strategy_key(hex::encode(core::seal::public_key(dealer_sk)));
        // A model needs an attested signer before a pro can choose it.
        as_who("pro1.near", 0, 2);
        let sealed = core::seal::seal_strategy([4u8; 32], core::seal::public_key(dealer_sk), b"Bluff more when the table is passive.", b"agent-1");
        assert!(panics(|| t.set_private_strategy("agent-1".into(), MODEL.into(), hex::encode(sealed.eph), hex::encode(&sealed.ct))).contains("no attested signer"));
        as_who("table.near", 0, 2);
        t.set_near_ai_signer(MODEL.into(), address.to_uppercase().replace("0X", "0x"), true);
        as_who("pro0.near", 0, 2);
        assert!(panics(|| t.set_private_strategy("agent-1".into(), MODEL.into(), hex::encode(sealed.eph), hex::encode(&sealed.ct))).contains("only the agent's pro"));
        as_who("pro1.near", 0, 2);
        assert_eq!(t.set_private_strategy("agent-1".into(), MODEL.into(), hex::encode(sealed.eph), hex::encode(&sealed.ct)), 2, "a new strategy version");
        let view = t.get_agent("agent-1".into()).unwrap().private_strategy.unwrap();
        assert_eq!((view.model.as_str(), view.sealed_bytes as usize), (MODEL, sealed.ct.len()));

        // The request carries the sealed text, which only the dealer opens.
        as_who("table.near", 0, 3);
        let req = t.open_backed_session("ai1".into(), seats.clone(), U64(100), 0, U64(1), U64(2), 20);
        let block = &req["profiles"][1]["private"];
        assert_eq!(block["agent_id"], "agent-1");
        let text = core::seal::open_strategy(dealer_sk, hex::decode(block["eph"].as_str().unwrap()).unwrap().try_into().unwrap(), &hex::decode(block["ct"].as_str().unwrap()).unwrap(), b"agent-1").unwrap();
        assert_eq!(text, b"Bluff more when the table is passive.");
        assert!(!req.to_string().contains("Bluff"), "the strategy never appears in the clear");

        // The dealer asks the model; the model's signed reply chooses agent-1's profile; the dealer plays it.
        let response = model_reply("chat-42", r#"{"fold_below":25,"raise_above":50,"aggression":70,"bluff_chance":15,"raise_size":80,"position_weight":30}"#);
        let chosen = core::nearai::profile_from_response(response.as_bytes()).unwrap();
        let sig_text = format!("{MODEL}:{}:{}", "a".repeat(64), hex::encode(env::sha256(response.as_bytes())));
        let proof = nearai::NearAiProof { seat: 1, agent_id: "agent-1".into(), model: MODEL.into(), chat_id: "chat-42".into(), response: response.clone(), signature_text: sig_text.clone(), signature: sign(&sig_text), signing_address: address.clone(), profile: chosen.clone() };
        let f = fixture("session", "ai1");
        let mut listed: Vec<agent::Profile> = LEGACY.iter().map(|(t, a)| agent::Profile::from_legacy(*t, *a)).collect();
        listed[1] = chosen.clone();
        let actions = seated_text(&f, &listed, 100, 20);
        let (a, s) = attestation_played(&t, "ai1", &f, &actions, &[(1, chosen.clone())]);
        let sub = |t: &mut Table, proofs: Option<Vec<nearai::NearAiProof>>| t.submit_session("ai1".into(), f.alpha.clone(), f.sig_hex.clone(), actions.clone(), Some(a.clone()), Some(s.clone()), proofs);
        let err = |v: Value| v["error"].as_str().unwrap_or("").to_string();

        // Dropping the proof (claiming the fallback was played) breaks the dealer's attestation.
        assert!(err(sub(&mut t, None)).contains("attestation does not match"));
        // A reply edited after signing, a profile that is not the reply's, a signer that is not attested, a forged signature.
        let mut edited = proof.clone();
        edited.response = edited.response.replace("\\\"aggression\\\":70", "\\\"aggression\\\":95");
        edited.profile = core::nearai::profile_from_response(edited.response.as_bytes()).unwrap();
        assert!(err(sub(&mut t, Some(vec![edited]))).contains("another response"));
        let mut other = proof.clone();
        other.profile.aggression = 95;
        assert!(err(sub(&mut t, Some(vec![other]))).contains("not what the model's reply says"));
        let (stranger_addr, stranger_sign) = model_key(10);
        let mut unlisted = proof.clone();
        unlisted.signing_address = stranger_addr.clone();
        unlisted.signature = stranger_sign(&sig_text);
        assert!(err(sub(&mut t, Some(vec![unlisted]))).contains("not an attested signing address"));
        let mut forged = proof.clone();
        forged.signature = stranger_sign(&sig_text);
        assert!(err(sub(&mut t, Some(vec![forged]))).contains("not from"));
        let mut wrong_seat = proof.clone();
        wrong_seat.seat = 2;
        assert!(err(sub(&mut t, Some(vec![wrong_seat]))).contains("not a NEAR-AI seat"));
        assert_eq!(t.get_session("ai1".into()).unwrap().status, Status::Pending);

        // The true proof settles, and the record keeps it for anyone to check.
        let out = sub(&mut t, Some(vec![proof.clone()]));
        assert_eq!(out["ok"], true, "{out}");
        let rec = t.get_session_record("ai1".into()).unwrap();
        assert_eq!(rec["near_ai"][0]["signature"], proof.signature);
        assert_eq!(rec["near_ai"][0]["profile"]["aggression"], 70);
        assert_eq!(nearai::recover_address(rec["near_ai"][0]["signature_text"].as_str().unwrap(), rec["near_ai"][0]["signature"].as_str().unwrap()).unwrap(), address);
        assert_eq!(t.get_near_ai_signers()[0]["signing_addresses"][0], address);
        // Back to a plain profile is another new version.
        as_who("pro1.near", 0, 5);
        assert_eq!(t.clear_private_strategy("agent-1".into()), 3);
        assert!(t.get_agent("agent-1".into()).unwrap().private_strategy.is_none());
    }
}
