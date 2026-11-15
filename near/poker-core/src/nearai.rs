//! NEAR-AI agents: the request the sealed dealer sends to a private model on NEAR AI Cloud, and how its reply
//! becomes a session's profile. The dealer and the table contract run the same parsing, so the contract can check
//! that the profile the dealer played is exactly what the model's signed reply says.
//!
//! NEAR AI Cloud signs every completion inside the model's TEE: `text = "<model>:<sha256(request bytes)>:<sha256(
//! response bytes)>"`, signed EIP-191 (secp256k1) by the model's `signing_address`, which the model's attestation
//! report binds to its Intel TDX / NVIDIA quote. The request holds the private strategy, so only its hash is public;
//! the response holds only the profile numbers and is published with the session.

use crate::profile::{Profile, MAX, MIN};
use serde_json::{json, Value};

pub const DEFAULT_MODEL: &str = "Qwen/Qwen3.6-35B-A3B-FP8";
/// Private strategies are short instructions, not documents.
pub const MAX_STRATEGY_BYTES: usize = 1000;

const SYSTEM: &str = "You set a poker agent's playing style for its next session of no-limit hold'em against other agents. \
Follow the owner's private instructions, adjusted by the agent's public results if they say to. \
Reply with one JSON object and nothing else, with these integer fields: \
fold_below (10-55: higher folds more often when facing a bet), \
raise_above (45-90: hand strength needed to bet or raise; lower plays more hands), \
aggression (10-95: how often a good hand raises instead of calling), \
bluff_chance (0-25: how often it bets a weak hand), \
raise_size (30-120: bet size as a percentage of the pot), \
position_weight (0-100: how much it loosens up in late position).";

/// The agent's public record, which the model may use (for example "tighten up after a losing run").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stats {
    pub sessions: u32,
    pub hands: u64,
    pub net_chips: i64,
}

/// The exact request body the dealer sends. `nonce` is fresh per call, so the request hash in the public signature
/// cannot be matched against guessed strategies.
pub fn request_body(model: &str, strategy: &str, stats: &Stats, session_id: &str, nonce_hex: &str) -> String {
    let user = format!(
        "Private instructions from the agent's owner:\n{strategy}\n\nPublic results so far: {} sessions, {} hands, {} chips net.\nSession {session_id}, nonce {nonce_hex}.",
        stats.sessions, stats.hands, stats.net_chips
    );
    json!({
        "model": model,
        "messages": [{ "role": "system", "content": SYSTEM }, { "role": "user", "content": user }],
        "max_tokens": 120,
        "temperature": 0.2,
        "chat_template_kwargs": { "enable_thinking": false },
    })
    .to_string()
}

fn strip_fences(s: &str) -> &str {
    let t = s.trim();
    let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).unwrap_or(t);
    t.strip_suffix("```").unwrap_or(t).trim()
}

/// The profile a completion's raw response body chooses. Refuses a reply that carries reasoning text (it could
/// repeat the private strategy, and the response is published) or that is not one JSON object with the five numbers.
/// Numbers are rounded and clamped into range; a reply in fractions (all five main numbers at most 1.2) is scaled
/// by 100.
pub fn profile_from_response(response: &[u8]) -> Result<Profile, String> {
    let v: Value = serde_json::from_slice(response).map_err(|_| "the model's response is not JSON")?;
    let msg = &v["choices"][0]["message"];
    for k in ["reasoning_content", "reasoning"] {
        if msg.get(k).map_or(false, |r| r.as_str().map_or(!r.is_null(), |s| !s.trim().is_empty())) {
            return Err("the model's reply includes reasoning text, which would be published".into());
        }
    }
    let content = msg["content"].as_str().ok_or("the model's reply has no content")?;
    let o: Value = serde_json::from_str(strip_fences(content)).map_err(|_| "the model's reply is not one JSON object")?;
    let names = ["fold_below", "raise_above", "aggression", "bluff_chance", "raise_size"];
    let mut nums = [0f64; 5];
    for (i, n) in names.iter().enumerate() {
        nums[i] = o.get(*n).and_then(Value::as_f64).ok_or(format!("the model's reply has no {n}"))?;
    }
    let mut pw = o.get("position_weight").and_then(Value::as_f64).unwrap_or(0.0);
    if nums.iter().all(|x| *x <= 1.2) {
        nums.iter_mut().for_each(|x| *x *= 100.0);
        if pw <= 1.0 {
            pw *= 100.0;
        }
    }
    let fit = |x: f64, lo: u8, hi: u8| -> u8 { (x.round().max(lo as f64).min(hi as f64)) as u8 };
    let main: [u8; 5] = core::array::from_fn(|i| fit(nums[i], MIN[i], MAX[i]));
    let mut p = Profile::new(main);
    p.position_weight = fit(pw, 0, 100);
    p.style = Some("NEAR AI".into());
    Ok(p)
}

/// Checks that a signature text is for this model and this response, and returns the request hash it names.
pub fn check_signature_text(text: &str, model: &str, response_sha256_hex: &str) -> Result<String, String> {
    let mut parts = text.rsplitn(3, ':');
    let (resp, req, m) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if m != model {
        return Err(format!("the signature is for model {m}, not {model}"));
    }
    if req.len() != 64 || !req.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("the signature text has no request hash".into());
    }
    if resp != response_sha256_hex {
        return Err("the signature is for another response".into());
    }
    Ok(req.to_string())
}

/// The bytes an EIP-191 `personal_sign` signature covers (hash them with keccak-256).
pub fn eip191_message(text: &str) -> Vec<u8> {
    let mut m = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    m.extend_from_slice(text.as_bytes());
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(content: &str) -> Vec<u8> {
        json!({ "id": "x", "choices": [{ "message": { "role": "assistant", "content": content } }] }).to_string().into_bytes()
    }

    #[test]
    fn replies_become_profiles() {
        let p = profile_from_response(&reply(r#"{"fold_below":35,"raise_above":58,"aggression":55,"bluff_chance":3,"raise_size":60,"position_weight":20}"#)).unwrap();
        assert_eq!((p.main().as_array(), p.position_weight), ([35, 58, 55, 3, 60], 20));
        p.validate().unwrap();
        // Fenced, fractional and out-of-range replies are normalized the same way everywhere.
        let p = profile_from_response(&reply("```json\n{\"fold_below\":0.3,\"raise_above\":0.6,\"aggression\":0.5,\"bluff_chance\":0.02,\"raise_size\":0.8}\n```")).unwrap();
        assert_eq!(p.main().as_array(), [30, 60, 50, 2, 80]);
        let p = profile_from_response(&reply(r#"{"fold_below":99,"raise_above":5,"aggression":50,"bluff_chance":90,"raise_size":500}"#)).unwrap();
        assert_eq!(p.main().as_array(), [55, 45, 50, 25, 120]);
        assert!(profile_from_response(&reply("I would play tight.")).is_err());
        assert!(profile_from_response(&reply(r#"{"fold_below":35}"#)).is_err());
        let with_reasoning = json!({ "choices": [{ "message": { "content": "{}", "reasoning_content": "the owner said..." } }] }).to_string();
        assert!(profile_from_response(with_reasoning.as_bytes()).unwrap_err().contains("reasoning"));
    }

    #[test]
    fn signature_texts_name_the_model_and_response() {
        let req = "a".repeat(64);
        let text = format!("{DEFAULT_MODEL}:{req}:{}", "b".repeat(64));
        assert_eq!(check_signature_text(&text, DEFAULT_MODEL, &"b".repeat(64)).unwrap(), req);
        assert!(check_signature_text(&text, "other/model", &"b".repeat(64)).is_err());
        assert!(check_signature_text(&text, DEFAULT_MODEL, &"c".repeat(64)).is_err());
        assert!(request_body(DEFAULT_MODEL, "play tight", &Stats { sessions: 1, hands: 2, net_chips: -3 }, "s1", "00").contains("enable_thinking"));
    }
}
