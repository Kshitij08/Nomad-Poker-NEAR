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

#[derive(Serialize, Debug, PartialEq)]
pub struct HandOut {
    pub index: usize,
    pub button: usize,
    pub stacks_before: Vec<u64>,
    pub holes: Vec<[String; 2]>,
    pub board: [String; 5],
    pub actions: String,
    pub deltas: Vec<i64>,
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
    // The same checks as the contract: a session it would refuse is refused here too.
    session::replay(&start, &seed, input.hands, &input.actions)?;

    let n = start.stacks.len();
    let mut stacks = start.stacks.clone();
    let mut hands = Vec::new();
    for (k, text) in input.actions.split(';').enumerate() {
        let rules = session::rules_for(&start, &stacks, k);
        let d = core::deal(&session::hand_seed(&seed, k as u32), n);
        let deltas = game::replay(&rules, &game::parse_actions(text)?)?.payouts(&d)?;
        let name = |c: &u8| core::card_name(*c);
        hands.push(HandOut {
            index: k,
            button: rules.button,
            stacks_before: stacks.clone(),
            holes: d.holes.iter().map(|h| [name(&h[0]), name(&h[1])]).collect(),
            board: d.board.map(|c| name(&c)),
            actions: text.to_string(),
            deltas: deltas.clone(),
        });
        for i in 0..n {
            stacks[i] = (stacks[i] as i64 + deltas[i]) as u64;
        }
    }
    Ok(Output { hands, stacks })
}

#[derive(Deserialize)]
pub struct SimInput {
    pub signature_hex: String,
    pub stacks: Vec<u64>,
    pub profiles: Vec<(u8, u8)>,
    pub button: usize,
    pub sb: u64,
    pub bb: u64,
    pub hands: usize,
}

/// Plays a session locally exactly as the dealer would for this proof. For tests and offline demos only: a real
/// session's proof comes from OutLayer's randomness inside the sealed dealer.
pub fn simulate(input: &SimInput) -> Result<String, String> {
    let sig = hex::decode(&input.signature_hex).map_err(|_| "signature is not hex")?;
    let seed = core::seed_from_signature(&sig);
    let start = game::Rules { stacks: input.stacks.clone(), button: input.button, sb: input.sb, bb: input.bb };
    let profiles: Vec<core::agent::Profile> = input.profiles.iter().map(|(t, a)| core::agent::Profile { tight: *t, aggro: *a }).collect();
    if profiles.len() != start.stacks.len() {
        return Err("one profile per stack".into());
    }
    core::agent::play_session(&profiles, &seed, &start, input.hands)
}

fn answer_sim(bytes: &[u8]) -> String {
    match serde_json::from_slice::<SimInput>(bytes).map_err(|e| format!("bad input: {e}")).and_then(|i| simulate(&i)) {
        Ok(actions) => serde_json::json!({ "ok": true, "actions": actions }).to_string(),
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
        assert_eq!(out.hands[1].stacks_before, out.hands[0].stacks_before.iter().zip(&out.hands[0].deltas).map(|(s, d)| (*s as i64 + d) as u64).collect::<Vec<_>>());
    }

    #[test]
    fn refuses_what_the_contract_refuses() {
        let bad = br#"{"signature_hex":"00","stacks":[100,100],"button":0,"sb":1,"bb":2,"hands":5,"actions":"f"}"#;
        assert!(answer(bad).contains("\"ok\":false"));
    }
}
