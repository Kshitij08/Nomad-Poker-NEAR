//! Prints one sealed hand as JSON, for checking that other clients (scripts/hand.mjs) open it the same way.
use poker_core::{card_name, deal, seal};
use x25519_dalek::{PublicKey, StaticSecret};

fn main() {
    let seed = [9u8; 32];
    let sk = [3u8; 32];
    let pk = *PublicKey::from(&StaticSecret::from(sk)).as_bytes();
    let d = deal(&seed, 2);
    let s = seal::seal_hole(&seed, 0, pk, d.holes[0]);
    println!(
        "{{\"sk\":\"{}\",\"eph\":\"{}\",\"ct\":\"{}\",\"cards\":[\"{}\",\"{}\"]}}",
        hex::encode(sk),
        hex::encode(s.eph),
        hex::encode(&s.ct),
        card_name(d.holes[0][0]),
        card_name(d.holes[0][1])
    );
}
