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
mod pool;
mod vault;
pub use pool::PoolView;
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

/// Checks a session: the proof gives the session seed, and every hand is re-dealt from it and replayed.
pub fn verify_session(vrf_pubkey: &[u8; 32], session_id: &str, start: &game::Rules, hands: usize, alpha: &str, signature_hex: &str, actions: &str) -> Result<SessionResult, String> {
    let seed = seed_from_proof(vrf_pubkey, "session", session_id, alpha, signature_hex)?;
    let out = core::session::replay(start, &seed, hands, actions)?;
    let totals = (0..start.stacks.len()).map(|i| out.stacks[i] as i64 - start.stacks[i] as i64).collect();
    Ok(SessionResult { hands_played: out.hands.len() as u32, stacks: out.stacks, totals, actions: actions.to_string() })
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
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.vrf_pubkey = Self::parse_key(&vrf_pubkey_hex);
    }

    pub fn set_project(&mut self, project_id: String) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
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
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(profiles.len() == stacks.len(), "one profile per stack");
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
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(profiles.len() == stacks.len(), "one profile per stack");
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
    pub fn submit_session(&mut self, session_id: String, alpha: String, signature_hex: String, actions: String) -> Value {
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
        let verified = verify_session(&self.vrf_pubkey, &session_id, &start, num("hands") as usize, &alpha, &signature_hex, &actions);
        let r = match verified {
            Ok(r) => {
                s.status = Status::Done;
                s.result = Some(r.clone());
                r
            }
            Err(error) => return json!({ "ok": false, "error": error }),
        };
        let request = s.request.clone();
        all.flush();
        // Backed sessions pay out each seat's position in the same transaction.
        let payouts = self.settle_backed(&session_id, &r);
        history::record_session(&session_id, &request, &alpha, &signature_hex, &actions, &r.stacks, &payouts);
        json!({ "ok": true, "hands_played": r.hands_played, "stacks": r.stacks, "totals": r.totals, "payouts": payouts })
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
        let profiles: Vec<agent::Profile> = (0..n).map(|i| agent::Profile { tight: 20 + 10 * i as u8, aggro: 70 - 10 * i as u8 }).collect();
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
        let profiles = [agent::Profile { tight: 10, aggro: 80 }, agent::Profile { tight: 30, aggro: 60 }, agent::Profile { tight: 5, aggro: 90 }];
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

    /// A table with four agents from one pro, each backed with 1 NEAR by a different backer.
    fn backed_table() -> (Table, Vec<BackedSeat>, [u8; 32]) {
        let f = fixture("session", "v1");
        as_who("table.near", 0, 1);
        let mut t = Table::new(acct("outlayer.near"), "pro.near/dealer".into(), hex::encode(f.pk));
        let profiles = [(10u8, 80u8), (30, 60), (5, 90), (40, 50)];
        let mut seats = vec![];
        for (i, (tight, aggro)) in profiles.iter().enumerate() {
            as_who("pro.near", 0, 1);
            t.register_agent(format!("agent-{i}"), *tight, *aggro);
            let backer = format!("backer{i}.near");
            as_who(&backer, NEAR, 1);
            t.back(format!("agent-{i}"), Some(U128(NEAR / 2)));
            seats.push(BackedSeat { backer: Some(acct(&backer)), agent_id: format!("agent-{i}") });
        }
        (t, seats, f.pk)
    }

    fn total_held(t: &Table, seats: &[BackedSeat]) -> u128 {
        let positions: u128 = seats.iter().map(|s| { let p = t.get_position(s.backer.clone().unwrap(), s.agent_id.clone()).unwrap(); p.balance.0 + p.at_table.0 }).sum();
        positions + t.get_earnings(acct("pro.near")).0 + t.get_earnings(acct("table.near")).0
    }

    fn session_text(id: &str, buy_in: u64, hands: usize) -> (Fixture, String) {
        let f = fixture("session", id);
        let start = game::Rules { stacks: vec![buy_in; 4], button: 0, sb: 1, bb: 2 };
        let profiles = [(10u8, 80u8), (30, 60), (5, 90), (40, 50)].map(|(tight, aggro)| agent::Profile { tight, aggro });
        let text = agent::play_session(&profiles, &f.seed, &start, hands).unwrap();
        (f, text)
    }

    #[test]
    fn a_backed_session_pays_each_backer_pro_and_platform_and_conserves_money() {
        let (mut t, seats, _) = backed_table();
        assert_eq!(total_held(&t, &seats), 4 * NEAR);
        as_who("table.near", 0, 2);
        t.open_backed_session("v1".into(), seats.clone(), U64(300), 0, U64(1), U64(2), 30);
        // 300 chips at 0.001 NEAR = 0.3 NEAR locked per seat.
        let p0 = t.get_position(seats[0].backer.clone().unwrap(), "agent-0".into()).unwrap();
        assert_eq!((p0.balance.0, p0.at_table.0), (NEAR - 3 * NEAR / 10, 3 * NEAR / 10));
        // Repeating the identical open locks nothing more.
        t.open_backed_session("v1".into(), seats.clone(), U64(300), 0, U64(1), U64(2), 30);
        assert_eq!(t.get_position(seats[0].backer.clone().unwrap(), "agent-0".into()).unwrap().at_table.0, 3 * NEAR / 10);

        let (f, text) = session_text("v1", 300, 30);
        let out = t.submit_session("v1".into(), f.alpha.clone(), f.sig_hex.clone(), text);
        assert_eq!(out["ok"], true, "{out}");
        // Nothing is created or lost: what backers deposited is now in positions or fee earnings.
        assert_eq!(total_held(&t, &seats), 4 * NEAR);
        let stacks: Vec<u64> = out["stacks"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).collect();
        let mut pro_fees = 0u128;
        for (i, s) in seats.iter().enumerate() {
            let p = t.get_position(s.backer.clone().unwrap(), s.agent_id.clone()).unwrap();
            assert_eq!(p.at_table.0, 0);
            let profit = (stacks[i] as u128 * NEAR / 1000).saturating_sub(3 * NEAR / 10);
            assert_eq!(p.fees_paid.0, profit * 8 / 100 + profit * 2 / 100, "seat {i}");
            pro_fees += profit * 8 / 100;
        }
        assert_eq!(t.get_earnings(acct("pro.near")).0, pro_fees);
        assert_eq!(t.get_agent("agent-0".into()).unwrap().sessions, 1);
        // Settled once only.
        assert_eq!(t.submit_session("v1".into(), f.alpha, f.sig_hex, "f".into())["ok"], false);
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
    #[should_panic(expected = "owner only")]
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
        let out = t.submit_session("p1".into(), f.alpha, f.sig_hex, text);
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
        let fees = t.get_earnings(acct("pro.near")).0 + t.get_earnings(acct("table.near")).0;
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
        as_who("pro.near", 0, 3);
        t.set_pool_risk("agent-0".into(), 5000);
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
        t.submit_session("v1".into(), f.alpha.clone(), f.sig_hex.clone(), text.clone());
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
        assert_eq!(recent[0]["agents"], json!(["agent-0", "agent-1", "agent-2", "agent-3"]));
    }
}
