//! Session replay for JavaScript, built from the same poker-core the table contract runs, so a server or client
//! shows exactly the hands the contract settled.
//!
//! `simulate_session` plays a session locally from a given proof, for tests and offline demos.
//!
//! It does not verify the randomness proof (the contract does that); it only turns a settled session's proof and
//! actions into per-hand detail for playback.
//!
//! ABI (no bindings generator): the host calls `alloc(len)`, writes UTF-8 JSON there, calls
//! `replay_session(ptr, len)`, which returns `(out_ptr << 32) | out_len`, reads the JSON answer, then frees both
//! buffers with `dealloc(ptr, len)`.

use poker_core::profile::{AnyProfile, Profile};
use poker_core::{self as core, game, session};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct Input {
    pub signature_hex: String,
    pub stacks: Vec<u64>,
    pub button: usize,
    pub sb: u64,
    pub bb: u64,
    pub hands: usize,
    pub actions: String,
}

/// One action as played, for showing a hand step by step.
#[derive(Serialize, Debug, PartialEq)]
pub struct Step {
    pub seat: usize,
    /// `f`, `c` (check or call) or `r<to>`.
    pub act: String,
    /// 0 preflop, 1 flop, 2 turn, 3 river.
    pub street: u8,
    /// Chips the seat put in with this action.
    pub put_in: u64,
    /// The pot after this action.
    pub pot: u64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct HandOut {
    pub index: usize,
    pub button: usize,
    pub stacks_before: Vec<u64>,
    pub holes: Vec<[String; 2]>,
    pub board: [String; 5],
    pub actions: String,
    pub deltas: Vec<i64>,
    /// The blinds as posted, then every action in order.
    pub blinds: Vec<u64>,
    pub steps: Vec<Step>,
}

/// Plays a hand's actions again, recording who acted, on which street, and the pot.
fn steps_of(rules: &game::Rules, text: &str) -> Result<(Vec<u64>, Vec<Step>), String> {
    let mut h = game::Hand::new(rules)?;
    let blinds = h.total.clone();
    let mut steps = vec![];
    for a in game::parse_actions(text)? {
        let seat = h.to_act().ok_or("an action after the hand ended")?;
        let street = h.street;
        let before = h.total[seat];
        h.apply(a)?;
        steps.push(Step { seat, act: game::format_actions(&[a]), street, put_in: h.total[seat] - before, pot: h.pot() });
    }
    Ok((blinds, steps))
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Output {
    pub hands: Vec<HandOut>,
    pub stacks: Vec<u64>,
}

pub fn replay(input: &Input) -> Result<Output, String> {
    let sig = hex::decode(&input.signature_hex).map_err(|_| "signature is not hex")?;
    let seed = core::seed_from_signature(&sig);
    let start = game::Rules { stacks: input.stacks.clone(), button: input.button, sb: input.sb, bb: input.bb };
    // The same replay as the contract: a session it would refuse is refused here too.
    let out = session::replay(&start, &seed, input.hands, &input.actions)?;

    let n = start.stacks.len();
    let texts: Vec<&str> = input.actions.split(';').collect();
    let name = |c: &u8| core::card_name(*c);
    let hands = out
        .hands
        .iter()
        .enumerate()
        .map(|(k, rec)| {
            let d = core::deal(&session::hand_seed(&seed, k as u32), n);
            let (blinds, steps) = steps_of(&session::rules_for(&start, &rec.stacks_before, rec.button), texts[k]).unwrap_or_default();
            HandOut {
                index: k,
                button: rec.button,
                stacks_before: rec.stacks_before.clone(),
                holes: d.holes.iter().map(|h| [name(&h[0]), name(&h[1])]).collect(),
                board: d.board.map(|c| name(&c)),
                actions: texts[k].to_string(),
                deltas: rec.deltas.clone(),
                blinds,
                steps,
            }
        })
        .collect();
    Ok(Output { hands, stacks: out.stacks })
}

#[derive(Deserialize)]
pub struct SimInput {
    pub signature_hex: String,
    pub stacks: Vec<u64>,
    /// v2 strategy profiles, or first-generation `{tight, aggro}` ones.
    pub profiles: Vec<AnyProfile>,
    pub button: usize,
    pub sb: u64,
    pub bb: u64,
    pub hands: usize,
    /// `"vrf"`: seat the listed stacks and profiles in the order the proof gives, as the dealer does.
    #[serde(default)]
    pub seating: Option<String>,
}

/// Table position p is listed seat `order[p]`.
pub fn seat_order(signature_hex: &str, n: usize) -> Result<Vec<usize>, String> {
    let sig = hex::decode(signature_hex).map_err(|_| "signature is not hex")?;
    Ok(session::seat_order(&core::seed_from_signature(&sig), n))
}

/// Plays a session locally exactly as the dealer would for this proof. For tests and offline demos only: a real
/// session's proof comes from OutLayer's randomness inside the sealed dealer. Returns the actions and, for a seated
/// session, the seat order.
pub fn simulate(input: &SimInput) -> Result<(String, Option<Vec<usize>>), String> {
    let sig = hex::decode(&input.signature_hex).map_err(|_| "signature is not hex")?;
    let seed = core::seed_from_signature(&sig);
    let mut start = game::Rules { stacks: input.stacks.clone(), button: input.button, sb: input.sb, bb: input.bb };
    let mut profiles: Vec<Profile> = Vec::with_capacity(input.profiles.len());
    for (i, p) in input.profiles.iter().enumerate() {
        let p = p.clone().into_v2();
        p.validate().map_err(|e| format!("profile {i}: {e}"))?;
        profiles.push(p);
    }
    if profiles.len() != start.stacks.len() {
        return Err("one profile per stack".into());
    }
    let order = match input.seating.as_deref() {
        None => None,
        Some("vrf") => Some(session::seat_order(&seed, profiles.len())),
        Some(other) => return Err(format!("unknown seating {other}")),
    };
    if let Some(o) = &order {
        start.stacks = session::seat(&start.stacks, o);
        profiles = session::seat(&profiles, o);
    }
    Ok((core::agent::play_session(&profiles, &seed, &start, input.hands)?, order))
}

fn answer_sim(bytes: &[u8]) -> String {
    match serde_json::from_slice::<SimInput>(bytes).map_err(|e| format!("bad input: {e}")).and_then(|i| simulate(&i)) {
        Ok((actions, order)) => serde_json::json!({ "ok": true, "actions": actions, "seat_order": order }).to_string(),
        Err(error) => serde_json::json!({ "ok": false, "error": error }).to_string(),
    }
}

#[derive(Deserialize)]
struct OrderInput {
    signature_hex: String,
    n: usize,
}

fn answer_order(bytes: &[u8]) -> String {
    match serde_json::from_slice::<OrderInput>(bytes).map_err(|e| format!("bad input: {e}")).and_then(|i| seat_order(&i.signature_hex, i.n)) {
        Ok(order) => serde_json::json!({ "ok": true, "seat_order": order }).to_string(),
        Err(error) => serde_json::json!({ "ok": false, "error": error }).to_string(),
    }
}

fn answer(bytes: &[u8]) -> String {
    let result = serde_json::from_slice::<Input>(bytes).map_err(|e| format!("bad input: {e}")).and_then(|i| replay(&i));
    match result {
        Ok(out) => serde_json::json!({ "ok": true, "hands": out.hands, "stacks": out.stacks }).to_string(),
        Err(error) => serde_json::json!({ "ok": false, "error": error }).to_string(),
    }
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` and `len` must come from `alloc(len)` or from `replay_session`'s answer.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn replay_session(ptr: *const u8, len: usize) -> u64 {
    let out = answer(std::slice::from_raw_parts(ptr, len)).into_bytes();
    let out_len = out.len();
    let out_ptr = alloc(out_len);
    std::ptr::copy_nonoverlapping(out.as_ptr(), out_ptr, out_len);
    ((out_ptr as u64) << 32) | out_len as u64
}

/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn simulate_session(ptr: *const u8, len: usize) -> u64 {
    let out = answer_sim(std::slice::from_raw_parts(ptr, len)).into_bytes();
    let out_len = out.len();
    let out_ptr = alloc(out_len);
    std::ptr::copy_nonoverlapping(out.as_ptr(), out_ptr, out_len);
    ((out_ptr as u64) << 32) | out_len as u64
}

/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn seat_order_of(ptr: *const u8, len: usize) -> u64 {
    let out = answer_order(std::slice::from_raw_parts(ptr, len)).into_bytes();
    let out_len = out.len();
    let out_ptr = alloc(out_len);
    std::ptr::copy_nonoverlapping(out.as_ptr(), out_ptr, out_len);
    ((out_ptr as u64) << 32) | out_len as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replays_a_settled_testnet_session() {
        // Session s20 as settled on table.nomad-poker.testnet: the contract recorded stacks 557, 287, 191, 165.
        let input = Input {
            signature_hex: "ff04dc3edd38f88bd0cfb1db6ed12d5964295577d0466de71ae640c6d9a0712e370e02f5ffd40cfad173933b270e854852ec87fdb34dd8e99393784ccf210801".into(),
            stacks: vec![300, 300, 300, 300],
            button: 0,
            sb: 1,
            bb: 2,
            hands: 20,
            actions: "f,f,f;f,f,c,c,r2,f;r4,f,c,c,c,r6,f,r19,c,r25,c,r50,r162,c;f,r4,c,f,c,c,r5,c,r10,c;f,f,f;f,f,c,c,c,r2,f;c,c,f,c,c,r3,c,f,r6,c,r12,c;f,c,c,c,c,c,r3,f,f;r4,f,f,c,r4,f;c,c,c,c,c,c,c,r4,f,f,f;r4,f,c,f,c,r5,c,r10,c,r20,c;r4,f,r9,f,c,c,c,r10,f;f,c,f,c,c,c,c,c,c,c;c,f,c,r5,c,c,c,c,c,r7,c,c,r18,c,c;f,r4,f,r9,f;f,f,c,r4,c,c,c,c,c,r4,c;f,f,f;c,f,r5,f,c,r6,c,r12,c,r24,c;f,f,f;f,f,f".into(),
        };
        let out = replay(&input).unwrap();
        assert_eq!(out.stacks, vec![557, 287, 191, 165]);
        assert_eq!(out.hands.len(), 20);
        assert_eq!(out.hands[1].button, 1);
        // Steps cover every action, and the last pot equals what was put in.
        for h in &out.hands {
            assert_eq!(h.steps.len(), h.actions.split(',').filter(|a| !a.is_empty()).count());
            let put: u64 = h.blinds.iter().sum::<u64>() + h.steps.iter().map(|s| s.put_in).sum::<u64>();
            assert_eq!(h.steps.last().map(|s| s.pot).unwrap_or(put), put);
        }
        assert_eq!(out.hands[1].stacks_before, out.hands[0].stacks_before.iter().zip(&out.hands[0].deltas).map(|(s, d)| (*s as i64 + d) as u64).collect::<Vec<_>>());
    }

    #[test]
    fn refuses_what_the_contract_refuses() {
        let bad = br#"{"signature_hex":"00","stacks":[100,100],"button":0,"sb":1,"bb":2,"hands":5,"actions":"f"}"#;
        assert!(answer(bad).contains("\"ok\":false"));
    }

    /// The golden session: the same input must give the same actions natively and in WebAssembly (the feeder test
    /// checks the wasm build against GOLDEN_ACTIONS_LEN and GOLDEN_PREFIX).
    pub fn golden() -> SimInput {
        serde_json::from_str(r#"{"signature_hex":"ff04dc3edd38f88bd0cfb1db6ed12d5964295577d0466de71ae640c6d9a0712e370e02f5ffd40cfad173933b270e854852ec87fdb34dd8e99393784ccf210801","stacks":[100,100,100,100],"button":0,"sb":1,"bb":2,"hands":25,"seating":"vrf","profiles":[{"tight":10,"aggro":80},{"fold_below":22,"raise_above":52,"aggression":75,"bluff_chance":8,"raise_size":90,"position_weight":50},{"fold_below":35,"raise_above":58,"aggression":45,"bluff_chance":3,"raise_size":60,"streets":[{"fold_below":10,"raise_above":55,"aggression":60,"bluff_chance":5,"raise_size":60},{"fold_below":50,"raise_above":70,"aggression":45,"bluff_chance":0,"raise_size":50},null,null]},{"fold_below":40,"raise_above":60,"aggression":25,"bluff_chance":2,"raise_size":45}]}"#).unwrap()
    }

    #[test]
    fn simulates_a_seated_v2_session_that_replays() {
        let input = golden();
        let (actions, order) = simulate(&input).unwrap();
        let order = order.unwrap();
        assert_eq!(order, seat_order(&input.signature_hex, 4).unwrap());
        // Equal stacks: the replay needs no reordering, and it accepts what the dealer would play.
        let out = replay(&Input { signature_hex: input.signature_hex.clone(), stacks: input.stacks.clone(), button: 0, sb: 1, bb: 2, hands: 25, actions: actions.clone() }).unwrap();
        assert_eq!(out.stacks.iter().sum::<u64>(), 400);
        assert_eq!((order.clone(), actions.len()), (vec![3, 1, 0, 2], 406));
        assert!(actions.starts_with("f,f,c,r6,f;f,f,r8,f;f,f,c,c,c,r4,f;"));
        assert_eq!(simulate(&input).unwrap().0, actions);
        let bad = br#"{"signature_hex":"00","stacks":[100,100],"button":0,"sb":1,"bb":2,"hands":5,"profiles":[{"tight":1,"aggro":1},{"fold_below":0,"raise_above":60,"aggression":25,"bluff_chance":2,"raise_size":45}]}"#;
        assert!(answer_sim(bad).contains("profile 1"));
    }
}
