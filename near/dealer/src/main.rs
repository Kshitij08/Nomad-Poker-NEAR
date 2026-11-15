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
    profiles: Vec<AnyProfile>,
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

/// The profiles as v2, each checked; refuses the request if any is out of range.
fn profiles_of(input: &Input) -> Result<Vec<Profile>, String> {
    if input.profiles.len() != input.stacks.len() {
        return Err("one profile per stack".into());
    }
    input
        .profiles
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let p = p.clone().into_v2();
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

/// Many hands in one run: one randomness proof, one hand seed per hand derived from it. With `"seating": "vrf"`
/// the agents are seated in the order the proof gives, not the order they were listed.
fn session(input: Input) -> Result<Output, String> {
    let n = input.stacks.len();
    let profiles = profiles_of(&input)?;
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
    let (start, profiles) = if vrf_seating {
        let order = core::session::seat_order(&seed, n);
        (game::Rules { stacks: core::session::seat(&listed.stacks, &order), ..listed }, core::session::seat(&profiles, &order))
    } else {
        (listed, profiles)
    };
    let actions = agent::play_session(&profiles, &seed, &start, input.hands)?;
    Ok(Output::Play { ok: true, hand_id: input.hand_id, alpha: s.alpha, signature_hex: s.signature_hex, actions })
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
        _ => Err("unknown action".into()),
    }
}

fn main() {
    let out = run().unwrap_or_else(|error| Output::Error { ok: false, error });
    env::output_json(&out).ok();
}
