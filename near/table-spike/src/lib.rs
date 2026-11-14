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
fn sessions() -> LookupMap<String, Session> {
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
    owner: AccountId,
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
        let out = match verify_session(&self.vrf_pubkey, &session_id, &start, num("hands") as usize, &alpha, &signature_hex, &actions) {
            Ok(r) => {
                s.status = Status::Done;
                s.result = Some(r.clone());
                json!({ "ok": true, "hands_played": r.hands_played, "stacks": r.stacks, "totals": r.totals })
            }
            Err(error) => json!({ "ok": false, "error": error }),
        };
        all.flush();
        out
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
}
