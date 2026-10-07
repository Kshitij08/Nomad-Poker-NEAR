//! Shuffle and deal: pure functions shared by the VRF callback and its unit tests. The off-chain
//! verifier (`per/tests/verifier.ts`) reimplements exactly this, so anything changed here must
//! change there too (bump the domain version).
//!
//! Inputs to a hand's deck:
//! - the VRF output, which never leaves the program. Two values are derived from it: the public
//!   `entropy` and the ledger's secret `salt`. The VRF program checks the oracle's proof on-chain
//!   before it calls us, so the output is genuine; publishing only a hash of it keeps the salt secret;
//! - each seated player's hidden seed, committed before the VRF request, so neither the oracle nor
//!   any single player can know or steer the deck.
//!
//! Cards are 0..52: rank = card % 13 (0 = deuce .. 12 = ace), suit = card / 13 (clubs, diamonds,
//! hearts, spades).

use anchor_lang::prelude::Pubkey;
use solana_sha256_hasher::hashv;

use crate::constants::MAX_SEATS;

pub const SHUFFLE_DOMAIN: &[u8] = b"poker-per/shuffle/v1";
pub const ENTROPY_DOMAIN: &[u8] = b"poker-per/entropy/v1";
pub const SALT_DOMAIN: &[u8] = b"poker-per/salt/v1";
pub const BUTTON_DOMAIN: &[u8] = b"poker-per/button/v1";
pub const DECK_SIZE: usize = 52;
/// Marks "no card" in a hand or an unused deck.
pub const NO_CARD: u8 = u8::MAX;
const SEATS: usize = MAX_SEATS as usize;

/// The public stand-in for the VRF output, published in the hand record.
pub fn entropy_of(vrf_output: &[u8; 32]) -> [u8; 32] {
    hashv(&[ENTROPY_DOMAIN, vrf_output]).to_bytes()
}

/// The ledger's fingerprint salt for the next hand. Never published.
pub fn salt_of(vrf_output: &[u8; 32]) -> [u8; 32] {
    hashv(&[SALT_DOMAIN, vrf_output]).to_bytes()
}

/// The deck's seed: binds the table, the hand number, the entropy and every committed seed (seats
/// without one contribute zeros; `seed_mask` says which seats committed).
pub fn shuffle_seed(table: &Pubkey, hand_no: u64, entropy: &[u8; 32], seed_mask: u16, seeds: &[[u8; 32]; SEATS]) -> [u8; 32] {
    let mut parts: Vec<&[u8]> = Vec::with_capacity(5 + SEATS);
    let hand = hand_no.to_le_bytes();
    let mask = seed_mask.to_le_bytes();
    parts.extend_from_slice(&[SHUFFLE_DOMAIN, table.as_ref(), &hand, entropy, &mask]);
    for s in seeds.iter() {
        parts.push(s);
    }
    hashv(&parts).to_bytes()
}

/// Deterministic random stream: block k = sha256(seed || k as u32 LE), read as four u64 LE.
pub struct Stream {
    seed: [u8; 32],
    counter: u32,
    block: [u8; 32],
    used: usize,
}

impl Stream {
    pub fn new(seed: [u8; 32]) -> Self {
        Stream { seed, counter: 0, block: [0; 32], used: 32 }
    }

    pub fn next_u64(&mut self) -> u64 {
        if self.used == 32 {
            self.block = hashv(&[&self.seed, &self.counter.to_le_bytes()]).to_bytes();
            self.counter += 1;
            self.used = 0;
        }
        let v = u64::from_le_bytes(self.block[self.used..self.used + 8].try_into().unwrap());
        self.used += 8;
        v
    }

    /// Uniform in 0..n with no modulo bias: draws falling in the incomplete top range are rejected.
    pub fn below(&mut self, n: u64) -> u64 {
        assert!(n > 0);
        let zone = (u64::MAX / n) * n;
        loop {
            let x = self.next_u64();
            if x < zone {
                return x % n;
            }
        }
    }
}

/// Fisher–Yates (Durstenfeld) over 0..52.
pub fn shuffle(seed: [u8; 32]) -> [u8; DECK_SIZE] {
    let mut cards: [u8; DECK_SIZE] = core::array::from_fn(|i| i as u8);
    let mut s = Stream::new(seed);
    for i in (1..DECK_SIZE).rev() {
        let j = s.below(i as u64 + 1) as usize;
        cards.swap(i, j);
    }
    cards
}

/// Seats in `mask`, ascending.
pub fn seats_in(mask: u16) -> Vec<u8> {
    (0..SEATS as u8).filter(|i| mask & (1 << i) != 0).collect()
}

/// The first hand's dealer button: a uniformly chosen seat among those dealt in.
pub fn first_button(seed: [u8; 32], mask: u16) -> u8 {
    let seats = seats_in(mask);
    let mut s = Stream::new(hashv(&[BUTTON_DOMAIN, &seed]).to_bytes());
    seats[s.below(seats.len() as u64) as usize]
}

/// Later hands: the next seat dealt in after the previous button, wrapping round the table.
pub fn next_button(prev: u8, mask: u16) -> u8 {
    for step in 1..=SEATS as u8 {
        let seat = (prev + step) % SEATS as u8;
        if mask & (1 << seat) != 0 {
            return seat;
        }
    }
    prev
}

/// Dealing order: the seat after the button first, then round the table.
pub fn deal_order(button: u8, mask: u16) -> Vec<u8> {
    let mut order = Vec::new();
    for step in 1..=SEATS as u8 {
        let seat = (button + step) % SEATS as u8;
        if mask & (1 << seat) != 0 {
            order.push(seat);
        }
    }
    order
}

/// Hole cards per seat, dealt one at a time round the table twice, like a live dealer: the k-th seat
/// in the order gets deck[k] and deck[k + n]. The board comes from the cards after these (M5).
pub fn hole_cards(deck: &[u8; DECK_SIZE], order: &[u8]) -> [[u8; 2]; SEATS] {
    let mut out = [[NO_CARD; 2]; SEATS];
    let n = order.len();
    for (k, &seat) in order.iter().enumerate() {
        out[seat as usize] = [deck[k], deck[k + n]];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(i: u64) -> [u8; 32] {
        hashv(&[b"test-seed", &i.to_le_bytes()]).to_bytes()
    }

    #[test]
    fn shuffle_is_a_permutation_and_deterministic() {
        let d = shuffle(seed(1));
        let mut seen = [false; DECK_SIZE];
        for c in d {
            assert!(!seen[c as usize]);
            seen[c as usize] = true;
        }
        assert_eq!(d, shuffle(seed(1)));
        assert_ne!(d, shuffle(seed(2)));
    }

    /// Fixed vector, also checked by the TypeScript verifier (tests/verifier.ts).
    #[test]
    fn known_vector() {
        let table = Pubkey::new_from_array([7; 32]);
        let mut seeds = [[0u8; 32]; SEATS];
        seeds[0] = [1; 32];
        seeds[3] = [2; 32];
        let s = shuffle_seed(&table, 5, &entropy_of(&[9; 32]), 0b1001, &seeds);
        let d = shuffle(s);
        println!("VECTOR seed={} deck={:?} button={}", hex(&s), d, first_button(s, 0b1001));
        assert_eq!(hex(&s), KNOWN_SEED);
        assert_eq!(d[..8], KNOWN_DECK_PREFIX);
    }
    const KNOWN_SEED: &str = "d12346b4bf0787f377276f2df1ed63464de16f3a0352a6a3e956f59b299fc540";
    const KNOWN_DECK_PREFIX: [u8; 8] = [14, 22, 24, 23, 15, 17, 13, 49];

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// Every card should land in every position equally often. 10,000 shuffles, 52 x 52 cells,
    /// chi-square with 51 x 51 = 2,601 degrees of freedom: mean 2,601, standard deviation about 72.
    #[test]
    fn chi_square_positions_10k() {
        const N: u64 = 10_000;
        let mut counts = vec![[0u32; DECK_SIZE]; DECK_SIZE];
        for i in 0..N {
            for (pos, c) in shuffle(seed(i)).iter().enumerate() {
                counts[*c as usize][pos] += 1;
            }
        }
        let expected = N as f64 / DECK_SIZE as f64;
        let chi: f64 = counts.iter().flatten().map(|&o| (o as f64 - expected).powi(2) / expected).sum();
        let dof = 51.0 * 51.0;
        let z = (chi - dof) / (2.0 * dof).sqrt();
        println!("CHI2 shuffles={N} chi2={chi:.1} dof={dof} z={z:.2}");
        assert!(z.abs() < 4.0, "chi-square z-score {z:.2} out of range");
    }

    #[test]
    fn button_is_uniform_and_only_on_dealt_seats() {
        let mask: u16 = 0b1_0010_0101; // seats 0, 2, 5, 8
        let mut hits = [0u32; SEATS];
        for i in 0..8_000 {
            hits[first_button(seed(i), mask) as usize] += 1;
        }
        for s in 0..SEATS {
            if mask & (1 << s) == 0 {
                assert_eq!(hits[s], 0);
            } else {
                assert!((1_800..2_200).contains(&hits[s]), "seat {s}: {}", hits[s]);
            }
        }
        println!("BUTTON hits={hits:?}");
    }

    #[test]
    fn below_has_no_modulo_bias_at_the_edge() {
        // n just above 2^63: half of all u64 values would be biased by a plain modulo.
        let n = (1u64 << 63) + 1;
        let mut s = Stream::new(seed(42));
        let mut high = 0;
        for _ in 0..4_000 {
            if s.below(n) >= n / 2 {
                high += 1;
            }
        }
        assert!((1_850..2_150).contains(&high), "high half {high}");
    }

    #[test]
    fn dealing_order_and_buttons() {
        let mask: u16 = 0b0_0100_1011; // seats 0, 1, 3, 6
        assert_eq!(deal_order(3, mask), vec![6, 0, 1, 3]);
        assert_eq!(next_button(3, mask), 6);
        assert_eq!(next_button(6, mask), 0);
        let deck: [u8; DECK_SIZE] = core::array::from_fn(|i| i as u8);
        let h = hole_cards(&deck, &deal_order(3, mask));
        assert_eq!(h[6], [0, 4]);
        assert_eq!(h[3], [3, 7]);
        assert_eq!(h[2], [NO_CARD; 2]);
    }

    #[test]
    fn every_input_moves_the_seed() {
        let t = Pubkey::new_unique();
        let seeds = [[0u8; 32]; SEATS];
        let base = shuffle_seed(&t, 1, &[1; 32], 0, &seeds);
        assert_ne!(base, shuffle_seed(&Pubkey::new_unique(), 1, &[1; 32], 0, &seeds));
        assert_ne!(base, shuffle_seed(&t, 2, &[1; 32], 0, &seeds));
        assert_ne!(base, shuffle_seed(&t, 1, &[2; 32], 0, &seeds));
        let mut s2 = seeds;
        s2[4] = [1; 32];
        assert_ne!(base, shuffle_seed(&t, 1, &[1; 32], 1 << 4, &s2));
        assert_ne!(entropy_of(&[1; 32]), salt_of(&[1; 32]), "the published entropy never reveals the salt");
    }
}
