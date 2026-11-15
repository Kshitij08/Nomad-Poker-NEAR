//! Nomad Poker test dealer. Runs on OutLayer inside Intel TDX.
//!
//! Four actions, each one run:
//!   session   many agent hands in one run (see `play`), stacks carried over, one proof for all of them.
//!   play      a whole hand between agents in one run: draws the deck seed from OutLayer's verifiable randomness,
//!             deals, lets each agent act from its profile, and returns the randomness proof and the actions.
//!             Nothing leaves the run before the hand is over, so there is nothing to peek at mid-hand.
//!   deal      for hands played street by street: seals the seed in encrypted storage and returns a commitment to
//!             the deck plus each player's two hole cards encrypted to that player's key.
//!   showdown  returns the randomness proof of a dealt hand.
//!   strategy_key  the X25519 public key pros seal private strategies to (made once, kept in worker storage).
//!
//! NEAR-AI agents: a session seat whose profile carries a `private` block (the pro's sealed strategy text) gets this
//! session's profile from a private model on NEAR AI Cloud, asked once per session with the NEAR_AI_API_KEY secret.
//! The signed reply goes out with the session (`near_ai`), so the table can check the model chose what was played.
//!
//! The table contract re-deals and replays from the proof, so the dealer is never believed about cards, actions'
//! legality or winners.
//!
//! Every action is repeatable: asking again for the same hand with the same request returns the same answer, built
//! from the sealed proof. A late or lost answer therefore costs a retry, not the hand.
//!
//! Sealed state is kept per caller (the contract that asked), so calling this project directly cannot reveal a
//! table's deck: a direct caller only ever reads hands it started itself.

use outlayer::{env, storage, vrf};
use poker_core::profile::{AnyProfile, Profile};
use poker_core::{self as core, agent, game};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use wasi_http_client::Client;

#[derive(Deserialize)]
struct Input {
    action: String,
    hand_id: String,
    /// deal: each player's X25519 public key, hex.
    #[serde(default)]
    players: Vec<String>,
    /// play, session: one stack and one strategy profile per seat (v2, or the first `{tight, aggro}`), plus the
    /// button and blinds.
    #[serde(default)]
    stacks: Vec<u64>,
    #[serde(default)]
    profiles: Vec<serde_json::Value>,
    /// session: `"vrf"` seats the listed stacks and profiles in the order the session's randomness gives
    /// (poker_core::session::seat_order); the table contract applies the same order when it settles.
    #[serde(default)]
    seating: Option<String>,
    #[serde(default)]
    button: usize,
    #[serde(default)]
    sb: u64,
    #[serde(default)]
    bb: u64,
    /// session: how many hands to play.
    #[serde(default)]
    hands: usize,
}

/// What stays in sealed storage for a hand.
#[derive(Serialize, Deserialize)]
struct Sealed {
    alpha: String,
    signature_hex: String,
    players: usize,
    /// Hash of the request that started the hand; a repeat must match it.
    request: String,
}

#[derive(Serialize)]
struct Hole {
    /// One-time X25519 public key for this player and hand, hex.
    eph: String,
    /// The two cards, ChaCha20-Poly1305 sealed, hex.
    ct: String,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Output {
    Play { ok: bool, hand_id: String, alpha: String, signature_hex: String, actions: String },
    /// A session also carries the attestation: OutLayer's VRF signature over `act-<digest>` (see
    /// poker_core::session::attest_digest), made in this run, binding the actions to the deck proof and request.
    Session {
        ok: bool,
        hand_id: String,
        alpha: String,
        signature_hex: String,
        actions: String,
        attest_alpha: String,
        attest_signature_hex: String,
        /// NEAR-AI seats: the model's signed reply that chose each one's profile for this session.
        near_ai: Vec<NearAiProof>,
        near_ai_errors: Vec<NearAiError>,
    },
    Key { ok: bool, strategy_public_key: String },
    Deal { ok: bool, hand_id: String, commit: String, holes: Vec<Hole> },
    Showdown { ok: bool, hand_id: String, alpha: String, signature_hex: String, players: usize },
    Error { ok: bool, error: String },
}

fn caller() -> String {
    env::predecessor_account_id().or_else(env::signer_account_id).unwrap_or_else(|| "direct".into())
}

fn key(kind: &str, hand_id: &str) -> String {
    format!("{kind}:{}:{}", caller(), hand_id)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn seed_of(s: &Sealed) -> Result<[u8; 32], String> {
    let sig = hex::decode(&s.signature_hex).map_err(|_| "sealed proof is not hex")?;
    Ok(core::seed_from_signature(&sig))
}

/// The sealed proof for a hand: the stored one if this hand was already started with the same request, else a new
/// draw from the verifiable randomness.
fn sealed_for(kind: &str, hand_id: &str, players: usize, request: String) -> Result<Sealed, String> {
    let k = key(kind, hand_id);
    if let Some(bytes) = storage::get_worker(&k).map_err(|e| e.to_string())? {
        let s: Sealed = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if s.request != request {
            return Err("this hand was already started with a different request".into());
        }
        return Ok(s);
    }
    let (_, signature_hex, alpha) = vrf::random_bytes(&format!("{kind}-{hand_id}"))?;
    let s = Sealed { alpha, signature_hex, players, request };
    storage::set_worker(&k, &serde_json::to_vec(&s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(s)
}

/// The profiles as v2, each checked; refuses the request if any is out of range. A NEAR-AI seat's entry also
/// carries a `private` block; its v2 numbers are the fallback if the model cannot be asked.
fn profiles_of(input: &Input) -> Result<Vec<Profile>, String> {
    if input.profiles.len() != input.stacks.len() {
        return Err("one profile per stack".into());
    }
    input
        .profiles
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let p: AnyProfile = serde_json::from_value(v.clone()).map_err(|_| format!("profile {i}: not a strategy profile"))?;
            let p = p.into_v2();
            p.validate().map_err(|e| format!("profile {i}: {e}"))?;
            Ok(p)
        })
        .collect()
}

/// A fingerprint of a request, so a repeat for the same hand must ask for exactly the same thing.
fn fingerprint(rules: &game::Rules, input: &Input) -> String {
    let profiles = serde_json::to_string(&input.profiles).unwrap_or_default();
    let text = format!("{:?}|{}|{}|{:?}", rules, profiles, input.hands, input.seating);
    hex::encode(core::commit(&core::seed_from_signature(text.as_bytes())))
}

fn play(input: Input) -> Result<Output, String> {
    let n = input.stacks.len();
    let profiles = profiles_of(&input)?;
    let rules = game::Rules { stacks: input.stacks.clone(), button: input.button, sb: input.sb, bb: input.bb };
    let hand = game::Hand::new(&rules)?;
    let request = fingerprint(&rules, &input);

    let s = sealed_for("play", &input.hand_id, n, request)?;
    let seed = seed_of(&s)?;
    let d = core::deal(&seed, n);
    let acts = agent::play(&profiles, &seed, hand, &d);
    Ok(Output::Play { ok: true, hand_id: input.hand_id, alpha: s.alpha, signature_hex: s.signature_hex, actions: game::format_actions(&acts) })
}

// ------------------------------------------------------------------------------------------------ NEAR-AI agents

const STRATEGY_KEY: &str = "strategy-x25519-v1";
const NEAR_AI_API: &str = "https://cloud-api.near.ai/v1";
/// OutLayer stops a job at 60 s; model calls stop being started after this much of it.
const NEAR_AI_BUDGET: Duration = Duration::from_secs(35);

/// The dealer's X25519 secret for private strategies: made once from fresh randomness and kept in worker-private
/// storage, which every version of this project shares and nobody outside the sealed runtime can read.
fn strategy_secret(create: bool) -> Result<[u8; 32], String> {
    if let Some(b) = storage::get_worker(STRATEGY_KEY).map_err(|e| e.to_string())? {
        return b.try_into().map_err(|_| "stored strategy key is not 32 bytes".to_string());
    }
    if !create {
        return Err("the dealer has no strategy key yet (call action strategy_key once)".into());
    }
    let mut fresh = [0u8; 32];
    getrandom::fill(&mut fresh).map_err(|e| e.to_string())?;
    let (vrf_bytes, _, _) = vrf::random_bytes("strategy-key")?;
    let sk = core::commit(&core::seed_from_signature(&[fresh.as_slice(), vrf_bytes.as_slice()].concat()));
    storage::set_worker(STRATEGY_KEY, &sk).map_err(|e| e.to_string())?;
    Ok(sk)
}

fn strategy_key() -> Result<Output, String> {
    let sk = strategy_secret(true)?;
    Ok(Output::Key { ok: true, strategy_public_key: hex::encode(core::seal::public_key(sk)) })
}

/// What a NEAR-AI seat's `private` block holds (written by the table contract).
#[derive(Deserialize)]
struct Private {
    agent_id: String,
    model: String,
    /// The pro's strategy text sealed to the dealer's key (hex).
    eph: String,
    ct: String,
    #[serde(default)]
    sessions: u32,
    #[serde(default)]
    hands: u64,
    #[serde(default)]
    net_chips: i64,
}

/// One model decision, as published with the session.
#[derive(Serialize, Clone)]
struct NearAiProof {
    /// The listed seat (the order the table opened the session with).
    seat: usize,
    agent_id: String,
    model: String,
    chat_id: String,
    /// The completion's raw response body: the profile numbers, nothing private.
    response: String,
    signature_text: String,
    signature: String,
    signing_address: String,
    profile: Profile,
}

#[derive(Serialize)]
struct NearAiError {
    seat: usize,
    agent_id: String,
    error: String,
}

fn http_err(e: impl std::fmt::Display) -> String {
    format!("NEAR AI: {e}")
}

fn ask_model(key: &str, p: &Private, session_id: &str, strategy: &str) -> Result<(String, Vec<u8>, String, String, String), String> {
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let stats = core::nearai::Stats { sessions: p.sessions, hands: p.hands, net_chips: p.net_chips };
    let body = core::nearai::request_body(&p.model, strategy, &stats, session_id, &hex::encode(nonce));
    let resp = Client::new()
        .post(&format!("{NEAR_AI_API}/chat/completions"))
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .header("Accept-Encoding", "identity")
        .connect_timeout(Duration::from_secs(10))
        .body(body.as_bytes())
        .send()
        .map_err(http_err)?;
    let status = resp.status();
    let raw = resp.body().map_err(http_err)?;
    if status != 200 {
        return Err(format!("NEAR AI answered HTTP {status}"));
    }
    let chat_id = serde_json::from_slice::<serde_json::Value>(&raw).ok().and_then(|v| v["id"].as_str().map(String::from)).ok_or("NEAR AI: no chat id")?;
    // The signature is made in the model's TEE; it can lag the reply by a moment.
    for attempt in 0..6 {
        let r = Client::new()
            .get(&format!("{NEAR_AI_API}/signature/{chat_id}?model={}&signing_algo=ecdsa", p.model.replace('/', "%2F")))
            .header("Authorization", format!("Bearer {key}"))
            .header("Accept", "application/json")
            .connect_timeout(Duration::from_secs(10))
            .send()
            .map_err(http_err)?;
        let ok = r.status() == 200;
        let v: serde_json::Value = serde_json::from_slice(&r.body().map_err(http_err)?).unwrap_or_default();
        if ok {
            if let (Some(t), Some(s), Some(a)) = (v["text"].as_str(), v["signature"].as_str(), v["signing_address"].as_str()) {
                return Ok((chat_id, raw, t.to_string(), s.to_string(), a.to_string()));
            }
        }
        std::thread::sleep(Duration::from_millis(500 * (attempt + 1)));
    }
    Err("NEAR AI: no signature for the reply".into())
}

/// For each NEAR-AI seat: open its private strategy, ask its model for this session's profile, keep the signed
/// reply. A seat whose model cannot be asked in time plays its fallback profile and is listed in the errors.
fn near_ai_profiles(input: &Input, profiles: &mut [Profile]) -> (Vec<NearAiProof>, Vec<NearAiError>) {
    let started = Instant::now();
    let (mut proofs, mut errors) = (vec![], vec![]);
    let key = std::env::var("NEAR_AI_API_KEY").unwrap_or_default();
    for (seat, v) in input.profiles.iter().enumerate() {
        let Some(block) = v.get("private") else { continue };
        let agent_id = block.get("agent_id").and_then(|a| a.as_str()).unwrap_or("").to_string();
        let result = (|| -> Result<NearAiProof, String> {
            let p: Private = serde_json::from_value(block.clone()).map_err(|_| "unreadable private block")?;
            if key.is_empty() {
                return Err("the dealer has no NEAR_AI_API_KEY secret".into());
            }
            if started.elapsed() > NEAR_AI_BUDGET {
                return Err("out of time for model calls in this run".into());
            }
            let sk = strategy_secret(false)?;
            let eph: [u8; 32] = hex::decode(&p.eph).ok().and_then(|b| b.try_into().ok()).ok_or("bad eph")?;
            let ct = hex::decode(&p.ct).map_err(|_| "bad ciphertext")?;
            let text = core::seal::open_strategy(sk, eph, &ct, p.agent_id.as_bytes()).ok_or("the private strategy does not open with the dealer's key")?;
            let text = String::from_utf8(text).map_err(|_| "the private strategy is not text")?;
            let (chat_id, raw, signature_text, signature, signing_address) = ask_model(&key, &p, &input.hand_id, &text)?;
            let profile = core::nearai::profile_from_response(&raw)?;
            core::nearai::check_signature_text(&signature_text, &p.model, &hex::encode(core::sha256(&raw)))?;
            let response = String::from_utf8(raw).map_err(|_| "the model's response is not text")?;
            Ok(NearAiProof { seat, agent_id: p.agent_id, model: p.model, chat_id, response, signature_text, signature, signing_address, profile })
        })();
        match result {
            Ok(proof) => {
                profiles[seat] = proof.profile.clone();
                proofs.push(proof);
            }
            Err(error) => errors.push(NearAiError { seat, agent_id, error }),
        }
    }
    (proofs, errors)
}

/// Many hands in one run: one randomness proof, one hand seed per hand derived from it. With `"seating": "vrf"`
/// the agents are seated in the order the proof gives, not the order they were listed. NEAR-AI seats get this
/// session's profile from their private model first.
fn session(input: Input) -> Result<Output, String> {
    let n = input.stacks.len();
    let mut profiles = profiles_of(&input)?;
    let listed = game::Rules { stacks: input.stacks.clone(), button: input.button, sb: input.sb, bb: input.bb };
    core::session::check(&listed, input.hands)?;
    let vrf_seating = match input.seating.as_deref() {
        None => false,
        Some("vrf") => true,
        Some(other) => return Err(format!("unknown seating {other}")),
    };
    let request = fingerprint(&listed, &input);

    let s = sealed_for("session", &input.hand_id, n, request)?;
    let seed = seed_of(&s)?;
    let (near_ai, near_ai_errors) = near_ai_profiles(&input, &mut profiles);
    let (start, seated) = if vrf_seating {
        let order = core::session::seat_order(&seed, n);
        (game::Rules { stacks: core::session::seat(&listed.stacks, &order), ..listed.clone() }, core::session::seat(&profiles, &order))
    } else {
        (listed.clone(), profiles.clone())
    };
    let actions = agent::play_session(&seated, &seed, &start, input.hands)?;
    // Attest the actions and the profiles actually played: a relayer that changes any of them has no matching signature.
    let digest = core::session::attest_digest(&input.hand_id, &s.signature_hex, &listed, input.hands, input.seating.as_deref(), &profiles, &actions);
    let (_, attest_signature_hex, attest_alpha) = vrf::random_bytes(&core::session::attest_label(&digest))?;
    Ok(Output::Session { ok: true, hand_id: input.hand_id, alpha: s.alpha, signature_hex: s.signature_hex, actions, attest_alpha, attest_signature_hex, near_ai, near_ai_errors })
}

fn deal(input: Input) -> Result<Output, String> {
    let n = input.players.len();
    if !(2..=core::MAX_PLAYERS).contains(&n) {
        return Err("2 to 9 players".into());
    }
    let mut pks = Vec::with_capacity(n);
    for p in &input.players {
        let bytes = hex::decode(p).map_err(|_| "player key is not hex")?;
        let pk: [u8; 32] = bytes.try_into().map_err(|_| "player key must be 32 bytes")?;
        pks.push(pk);
    }
    let request = hex::encode(core::commit(&core::seed_from_signature(input.players.join(",").as_bytes())));

    let s = sealed_for("deal", &input.hand_id, n, request)?;
    let seed = seed_of(&s)?;
    let d = core::deal(&seed, n);
    let holes = pks
        .into_iter()
        .enumerate()
        .map(|(seat, pk)| {
            let sealed = core::seal::seal_hole(&seed, seat, pk, d.holes[seat]);
            Hole { eph: hex::encode(sealed.eph), ct: hex::encode(sealed.ct) }
        })
        .collect();
    Ok(Output::Deal { ok: true, hand_id: input.hand_id, commit: hex::encode(core::commit(&seed)), holes })
}

fn showdown(input: Input) -> Result<Output, String> {
    let bytes = storage::get_worker(&key("deal", &input.hand_id)).map_err(|e| e.to_string())?.ok_or("no such hand for this caller")?;
    let s: Sealed = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(Output::Showdown { ok: true, hand_id: input.hand_id, alpha: s.alpha, signature_hex: s.signature_hex, players: s.players })
}

fn run() -> Result<Output, String> {
    let input: Input = env::input_json().map_err(|e| format!("bad input: {e}"))?.ok_or("no input")?;
    if !valid_id(&input.hand_id) {
        return Err("hand_id: 1 to 40 of a-z, 0-9, -".into());
    }
    match input.action.as_str() {
        "play" => play(input),
        "session" => session(input),
        "deal" => deal(input),
        "showdown" => showdown(input),
        "strategy_key" => strategy_key(),
        _ => Err("unknown action".into()),
    }
}

fn main() {
    let out = run().unwrap_or_else(|error| Output::Error { ok: false, error });
    env::output_json(&out).ok();
}
