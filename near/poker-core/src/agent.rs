//! The agent that plays a hand from a strategy [`Profile`]. It runs inside the sealed dealer, so only its actions are
//! ever seen; the table contract replays those actions for legality and never re-derives the decisions.
//!
//! This is the Nomad app's "smart" agent brain (`HeuristicBot.decideV2` with `BotProfile.effective` in
//! `packages/engine/src/bots`): Monte-Carlo equity against random hands, mapped to a heads-up equivalent, compared
//! with pot odds and the profile's thresholds, with stack-to-pot aware sizing. Differences from the engine, because a
//! decision here must be a pure function of (profile, seed, state) that every build computes identically:
//!
//! - Random draws come from SplitMix64 seeded with SHA-256 of the hand seed and the action's index, not System.Random.
//! - Arithmetic is f64 with only +, -, *, / and floor (IEEE-exact on every target, wasm included); `pow` is computed
//!   from series rather than the platform's libm.
//! - Profile numbers are exact hundredths rather than float32.

use super::game::{Act, Hand};
use super::profile::Numbers;
pub use super::profile::Profile;
use super::{sha, Card, Deal};

/// Monte-Carlo runouts per decision (the engine's `HeuristicBot.EquityIterations`).
pub const EQUITY_ITERATIONS: u32 = 240;

const POSITION_SHIFT_FOLD: f64 = 0.08;
const POSITION_SHIFT_RAISE: f64 = 0.06;
const POSITION_SHIFT_BLUFF: f64 = 0.75;

/// SplitMix64: a small, fast generator; seeded per decision from SHA-256, so a repeated run draws the same numbers.
struct Rng(u64);

impl Rng {
    fn new(seed: &[u8; 32], step: u32) -> Self {
        let h = sha(&[b"nomad-agent-v2:", seed, &step.to_le_bytes()]);
        Rng(u64::from_le_bytes(h[..8].try_into().unwrap()))
    }
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in [0, 1), 53 bits.
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

const LN2: f64 = std::f64::consts::LN_2;

/// Natural log for x > 0 from the atanh series, after scaling into [1, 2).
fn ln(x: f64) -> f64 {
    let (mut m, mut k) = (x, 0i32);
    while m >= 2.0 {
        m /= 2.0;
        k += 1;
    }
    while m < 1.0 {
        m *= 2.0;
        k -= 1;
    }
    let t = (m - 1.0) / (m + 1.0);
    let t2 = t * t;
    let (mut term, mut sum) = (t, 0.0);
    for i in 0..30 {
        sum += term / (2 * i + 1) as f64;
        term *= t2;
    }
    2.0 * sum + k as f64 * LN2
}

/// e^y from a Taylor series on y reduced into [0, ln 2).
fn exp(y: f64) -> f64 {
    let n = (y / LN2).floor();
    let r = y - n * LN2;
    let (mut term, mut sum) = (1.0, 1.0);
    for i in 1..25 {
        term *= r / i as f64;
        sum += term;
    }
    let mut out = sum;
    let mut k = n as i64;
    while k > 0 {
        out *= 2.0;
        k -= 1;
    }
    while k < 0 {
        out /= 2.0;
        k += 1;
    }
    out
}

fn pow(x: f64, y: f64) -> f64 {
    if x <= 1e-12 {
        0.0
    } else {
        exp(y * ln(x))
    }
}

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

/// C#'s Math.Round (banker's rounding).
fn round_half_even(x: f64) -> f64 {
    let f = x.floor();
    let d = x - f;
    if d > 0.5 || (d == 0.5 && (f / 2.0).floor() * 2.0 != f) {
        f + 1.0
    } else {
        f
    }
}

/// Comparable value of the best five of seven cards (the engine's `Equity.handValue`): higher wins, equal ties.
fn hand_value(cards: &[Card; 7]) -> u32 {
    let mut counts = [0u8; 15];
    let mut suits = [0u32; 4];
    let mut mask = 0u32;
    for c in cards {
        let r = (c / 4) as usize + 2;
        counts[r] += 1;
        suits[(c % 4) as usize] |= 1 << r;
        mask |= 1 << r;
    }
    let value = |cat: u32, r: [u32; 5]| ((((cat * 16 + r[0]) * 16 + r[1]) * 16 + r[2]) * 16 + r[3]) * 16 + r[4];
    let top = |m: u32, skip1: u32, skip2: u32, count: usize| {
        let mut k = [0u32; 5];
        let mut got = 0;
        let mut r = 14;
        while r >= 2 && got < count {
            if m & (1 << r) != 0 && r != skip1 && r != skip2 {
                k[got] = r;
                got += 1;
            }
            r -= 1;
        }
        k
    };
    let straight_top = |mut m: u32| {
        if m & (1 << 14) != 0 {
            m |= 2;
        }
        (5..=14u32).rev().find(|t| (m >> (t - 4)) & 31 == 31).unwrap_or(0)
    };
    for s in suits {
        if s.count_ones() < 5 {
            continue;
        }
        let sf = straight_top(s);
        if sf != 0 {
            return value(8, [sf, 0, 0, 0, 0]);
        }
        return value(5, top(s, 0, 0, 5));
    }
    let (mut quad, mut trip1, mut trip2, mut pair1, mut pair2) = (0u32, 0u32, 0u32, 0u32, 0u32);
    for r in (2..=14u32).rev() {
        match counts[r as usize] {
            4 => quad = r,
            3 if trip1 == 0 => trip1 = r,
            3 if trip2 == 0 => trip2 = r,
            2 if pair1 == 0 => pair1 = r,
            2 if pair2 == 0 => pair2 = r,
            _ => {}
        }
    }
    if quad != 0 {
        return value(7, [quad, top(mask, quad, 0, 1)[0], 0, 0, 0]);
    }
    if trip1 != 0 && trip2 != 0 {
        return value(6, [trip1, trip2.max(pair1), 0, 0, 0]);
    }
    if trip1 != 0 && pair1 != 0 {
        return value(6, [trip1, pair1, 0, 0, 0]);
    }
    let st = straight_top(mask);
    if st != 0 {
        return value(4, [st, 0, 0, 0, 0]);
    }
    if trip1 != 0 {
        let k = top(mask, trip1, 0, 2);
        return value(3, [trip1, k[0], k[1], 0, 0]);
    }
    if pair2 != 0 {
        return value(2, [pair1, pair2, top(mask, pair1, pair2, 1)[0], 0, 0]);
    }
    if pair1 != 0 {
        let k = top(mask, pair1, 0, 3);
        return value(1, [pair1, k[0], k[1], k[2], 0]);
    }
    value(0, top(mask, 0, 0, 5))
}

/// Share of the pot this hand wins against `opponents` random hands over random runouts.
fn equity(hole: [Card; 2], board: &[Card], opponents: usize, rng: &mut Rng, iterations: u32) -> f64 {
    let n = opponents.clamp(1, 8);
    let mut used = [false; 52];
    used[hole[0] as usize] = true;
    used[hole[1] as usize] = true;
    for c in board {
        used[*c as usize] = true;
    }
    let mut deck: Vec<Card> = (0..52u8).filter(|c| !used[*c as usize]).collect();
    let fill = 5 - board.len();
    let need = fill + 2 * n;
    let mut won = 0.0;
    let (mut mine, mut theirs) = ([0u8; 7], [0u8; 7]);
    for _ in 0..iterations {
        for i in 0..need {
            let j = i + rng.below(deck.len() - i);
            deck.swap(i, j);
        }
        for i in 0..5 {
            let c = if i < board.len() { board[i] } else { deck[i - board.len()] };
            mine[i] = c;
            theirs[i] = c;
        }
        mine[5] = hole[0];
        mine[6] = hole[1];
        let me = hand_value(&mine);
        let mut ties = 0;
        let mut beaten = false;
        for o in 0..n {
            theirs[5] = deck[fill + 2 * o];
            theirs[6] = deck[fill + 2 * o + 1];
            let v = hand_value(&theirs);
            if v > me {
                beaten = true;
                break;
            }
            if v == me {
                ties += 1;
            }
        }
        if !beaten {
            won += 1.0 / (ties + 1) as f64;
        }
    }
    won / iterations as f64
}

const EQUITY_QUANTILES: [[f64; 21]; 7] = [
    [0.326, 0.349, 0.374, 0.392, 0.408, 0.420, 0.434, 0.453, 0.469, 0.481, 0.500, 0.511, 0.523, 0.536, 0.551, 0.571, 0.579, 0.600, 0.620, 0.653, 0.854],
    [0.197, 0.221, 0.233, 0.247, 0.258, 0.266, 0.283, 0.288, 0.300, 0.309, 0.320, 0.334, 0.342, 0.359, 0.369, 0.383, 0.400, 0.413, 0.442, 0.472, 0.732],
    [0.142, 0.154, 0.169, 0.179, 0.188, 0.196, 0.206, 0.212, 0.218, 0.230, 0.236, 0.249, 0.255, 0.265, 0.276, 0.291, 0.306, 0.323, 0.342, 0.373, 0.637],
    [0.103, 0.119, 0.129, 0.137, 0.148, 0.154, 0.162, 0.167, 0.172, 0.181, 0.187, 0.198, 0.203, 0.211, 0.219, 0.227, 0.247, 0.262, 0.280, 0.309, 0.561],
    [0.088, 0.096, 0.105, 0.113, 0.120, 0.126, 0.130, 0.138, 0.145, 0.151, 0.154, 0.166, 0.168, 0.174, 0.185, 0.191, 0.207, 0.220, 0.234, 0.268, 0.490],
    [0.071, 0.077, 0.088, 0.095, 0.101, 0.107, 0.112, 0.118, 0.122, 0.126, 0.133, 0.141, 0.145, 0.149, 0.160, 0.165, 0.183, 0.191, 0.204, 0.233, 0.445],
    [0.061, 0.068, 0.076, 0.083, 0.087, 0.090, 0.097, 0.100, 0.107, 0.111, 0.117, 0.123, 0.126, 0.133, 0.139, 0.145, 0.161, 0.169, 0.178, 0.211, 0.388],
];

/// Equity against n opponents mapped to the heads-up equity at the same percentile of starting hands.
fn heads_up_equivalent(eq: f64, n: usize) -> f64 {
    let n = n.clamp(1, 7);
    if n == 1 {
        return eq;
    }
    let q = &EQUITY_QUANTILES[n - 1];
    let h = &EQUITY_QUANTILES[0];
    let last = q.len() - 1;
    if eq <= q[0] {
        return h[0] * eq / q[0];
    }
    if eq >= q[last] {
        return h[last] + (1.0 - h[last]) * (eq - q[last]) / (1.0 - q[last]).max(1e-9);
    }
    let mut i = 1;
    while q[i] < eq {
        i += 1;
    }
    let t = if q[i] > q[i - 1] { (eq - q[i - 1]) / (q[i] - q[i - 1]) } else { 0.0 };
    h[i - 1] + t * (h[i] - h[i - 1])
}

/// The five numbers as fractions, after the street override and the position shift.
#[derive(Clone, Copy, Debug)]
struct Effective {
    fold_below: f64,
    raise_above: f64,
    aggression: f64,
    bluff_chance: f64,
    raise_size: f64,
}

/// `BotProfile.effective`: the street's numbers, shifted by how late the seat acts (-1 first .. +1 button).
fn effective(p: &Profile, street: u8, lateness: f64) -> Effective {
    let n: Numbers = p.street(street);
    let h = |v: u8| v as f64 / 100.0;
    let mut e = Effective { fold_below: h(n.fold_below), raise_above: h(n.raise_above), aggression: h(n.aggression), bluff_chance: h(n.bluff_chance), raise_size: h(n.raise_size) };
    let w = p.position_weight.min(100) as f64 / 100.0 * lateness;
    if w != 0.0 {
        e.fold_below = (e.fold_below - POSITION_SHIFT_FOLD * w).clamp(0.05, 0.60);
        e.raise_above = (e.raise_above - POSITION_SHIFT_RAISE * w).clamp(0.40, 0.95);
        e.bluff_chance = (e.bluff_chance * (1.0 + POSITION_SHIFT_BLUFF * w)).clamp(0.0, 0.40);
    }
    e
}

/// `BotProfile.lateness`: `position` is seats before the button (0 = button), counting every seat.
fn lateness(position: usize, opponents: usize) -> f64 {
    let n = opponents.max(1);
    1.0 - (2 * position.min(n)) as f64 / n as f64
}

/// How often it bets or raises a hand at or above `raise_above`: `aggression` at the threshold, always at the nuts.
fn value_rate(p: &Effective, h: f64) -> f64 {
    p.aggression + (1.0 - p.aggression) * clamp01((h - p.raise_above) / (1.0 - p.raise_above).max(0.05))
}

/// The seat to act decides. `seed` is the hand's secret seed and `step` the action's index in the hand; together
/// they fix every random draw, so a repeated run plays the same hand.
pub fn decide(p: &Profile, seed: &[u8; 32], step: u32, h: &Hand, d: &Deal) -> Act {
    let seat = h.to_act().expect("a seat to act");
    let mut rng = Rng::new(seed, step);
    let n_seats = h.seats();
    let opponents = (0..n_seats).filter(|i| *i != seat && !h.folded[*i]).count();
    let position = (h.button() + n_seats - seat) % n_seats;
    let street = h.street;
    let e = effective(p, street, lateness(position, opponents));

    let board = &d.board[..h.board_len()];
    let n = opponents.max(1);
    let eq = equity(d.holes[seat], board, n, &mut rng, EQUITY_ITERATIONS);
    let hu = clamp01(heads_up_equivalent(eq, n) + (rng.unit() - 0.5) * 0.04);
    let tc = h.to_call(seat);
    let pot = h.pot() as f64;
    let call = tc as f64;
    let spr = (h.stack[seat] as f64 - call) / (pot + call).max(1.0);
    let range = h.raise_range();
    let bb = h.big_blind();

    // A legal "raise to" around the minimum plus a share of the pot, jittered and snapped to a whole big blind.
    let wager = |fraction: f64, rng: &mut Rng| -> u64 {
        let (min, max) = range.expect("a raise is allowed");
        let fraction = fraction * (1.0 + (rng.unit() - 0.5) * 0.24);
        let mut target = min + ((pot + call) * fraction).floor().max(0.0) as u64;
        if bb > 0 {
            let rounded = round_half_even(target as f64 / bb as f64) as u64 * bb;
            if rounded > 0 {
                target = rounded;
            }
        }
        target.clamp(min, max)
    };
    let size = |rng: &mut Rng| -> Act {
        let (_, max) = range.expect("a raise is allowed");
        if spr < 1.5 {
            return Act::RaiseTo(max);
        }
        let amount = wager(e.raise_size * if spr > 6.0 { 0.85 } else { 1.0 }, rng);
        // A wager that leaves under a third of the new pot behind might as well be all-in.
        if ((max - amount) as f64) < (pot + call + amount as f64) / 3.0 {
            return Act::RaiseTo(max);
        }
        Act::RaiseTo(amount)
    };

    if tc == 0 {
        if range.is_none() {
            return Act::Call;
        }
        if hu >= e.raise_above && (spr < 1.5 || rng.unit() < value_rate(&e, hu)) {
            return size(&mut rng);
        }
        let stab = e.bluff_chance + if n == 1 && street > 0 { 0.35 * e.aggression } else { 0.0 };
        let bluffable = if street < 3 { hu < e.raise_above } else { hu < e.fold_below + 0.1 };
        if bluffable && rng.unit() < stab {
            return size(&mut rng);
        }
        return Act::Call;
    }

    let pot_odds = call / (pot + call);
    let blind_only = street == 0 && h.bet[seat] + tc <= bb;
    let bet_ratio = call / (pot - call).max(1.0);
    let vs_range = if blind_only { eq } else { pow(eq, 1.3 + 0.7 * bet_ratio.min(1.5)) };
    let vs_range_hu = heads_up_equivalent(vs_range, n);
    let need = pot_odds + 0.5 * (e.fold_below - 0.3);

    if vs_range_hu >= e.raise_above {
        if range.is_some() && (spr < 1.5 || rng.unit() < value_rate(&e, vs_range_hu)) {
            return size(&mut rng);
        }
        return Act::Call;
    }
    if range.is_some() && spr > 2.0 && street < 3 && hu >= e.fold_below && rng.unit() < e.bluff_chance {
        return size(&mut rng);
    }
    if vs_range >= need {
        return Act::Call;
    }
    Act::Fold
}

/// Plays a whole hand between agents and returns the actions in order.
pub fn play(profiles: &[Profile], seed: &[u8; 32], mut h: Hand, d: &Deal) -> Vec<Act> {
    let mut acts = Vec::new();
    while let Some(seat) = h.to_act() {
        let a = decide(&profiles[seat], seed, acts.len() as u32, &h, d);
        h.apply(a).expect("the agent only makes legal moves");
        acts.push(a);
    }
    acts
}

/// Plays a session between agents and returns the action text, hands separated by `;`. `profiles` and
/// `start.stacks` are by table position (see [`super::session::seat`] for sessions seated from the randomness).
pub fn play_session(profiles: &[Profile], seed: &[u8; 32], start: &super::game::Rules, hands: usize) -> Result<String, String> {
    use super::{deal, game, session};
    session::check(start, hands)?;
    if profiles.len() != start.stacks.len() {
        return Err("one profile per stack".into());
    }
    let n = start.stacks.len();
    let mut stacks = start.stacks.clone();
    let mut button = None;
    let mut out = Vec::new();
    for k in 0..hands {
        if session::active(&stacks) < 2 {
            break;
        }
        let b = session::button_for(start, &stacks, button);
        button = Some(b);
        let rules = session::rules_for(start, &stacks, b);
        let hs = session::hand_seed(seed, k as u32);
        let d = deal(&hs, n);
        let acts = play(profiles, &hs, game::Hand::new(&rules)?, &d);
        let delta = game::replay(&rules, &acts)?.payouts(&d)?;
        for i in 0..n {
            stacks[i] = (stacks[i] as i64 + delta[i]) as u64;
        }
        out.push(game::format_actions(&acts));
    }
    Ok(out.join(";"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn math_matches_the_platform_closely() {
        for x in [1e-6, 0.01, 0.2, 0.5, 0.77, 1.0, 3.5, 1234.5] {
            assert!((ln(x) - x.ln()).abs() < 1e-12, "ln {x}");
        }
        for y in [-30.0, -3.2, -0.5, 0.0, 0.3, 2.0, 10.0] {
            assert!((exp(y) / y.exp() - 1.0).abs() < 1e-12, "exp {y}");
        }
        assert!((pow(0.4, 1.7) - 0.4f64.powf(1.7)).abs() < 1e-12);
        assert_eq!([0.5, 1.5, 2.5, -0.5, 2.4, 2.6].map(round_half_even), [0.0, 2.0, 2.0, -0.0, 2.0, 3.0]);
    }

    fn c(name: &str) -> Card {
        let b = name.as_bytes();
        let r = b"23456789TJQKA".iter().position(|x| *x == b[0]).unwrap() as u8;
        let s = b"cdhs".iter().position(|x| *x == b[1]).unwrap() as u8;
        r * 4 + s
    }

    #[test]
    fn hand_values_agree_with_the_showdown_ranking() {
        // The equity evaluator and the contract's rank_cards must order every hand the same way.
        let mut x: u64 = 3;
        let mut deck: Vec<u8> = (0..52).collect();
        for _ in 0..20_000 {
            for i in 0..14 {
                x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let j = i + (x >> 33) as usize % (52 - i);
                deck.swap(i, j);
            }
            let a: [u8; 7] = deck[..7].try_into().unwrap();
            let b: [u8; 7] = [deck[7], deck[8], a[2], a[3], a[4], a[5], a[6]];
            let ord_fast = hand_value(&a).cmp(&hand_value(&b));
            let ord_core = super::super::rank_cards(&a).cmp(&super::super::rank_cards(&b));
            assert_eq!(ord_fast, ord_core, "{a:?} vs {b:?}");
        }
    }

    #[test]
    fn equity_ranks_hands_sensibly() {
        let mut rng = Rng(1);
        let aces = equity([c("Ah"), c("Ad")], &[], 1, &mut rng, 2000);
        let junk = equity([c("7c"), c("2d")], &[], 1, &mut rng, 2000);
        assert!(aces > 0.8 && junk < 0.4, "aces {aces}, 72o {junk}");
        let nuts = equity([c("Ah"), c("Kh")], &[c("Qh"), c("Jh"), c("Th")], 3, &mut rng, 500);
        assert_eq!(nuts, 1.0);
    }

    #[test]
    fn position_and_streets_shift_the_numbers() {
        let mut p = Profile::preset("Guardian").unwrap();
        assert_eq!(effective(&p, 1, 1.0).fold_below, 0.40);
        p.position_weight = 100;
        let late = effective(&p, 1, 1.0);
        let early = effective(&p, 1, -1.0);
        assert!(late.fold_below < 0.40 && early.fold_below > 0.40);
        assert!(late.bluff_chance > early.bluff_chance);
        let a = Profile::preset("Autopilot").unwrap();
        assert_eq!(effective(&a, 0, 0.0).fold_below, 0.10);
        assert_eq!(effective(&a, 2, 0.0).fold_below, 0.50);
        assert_eq!(lateness(0, 3), 1.0);
        assert_eq!(lateness(3, 3), -1.0);
    }
}
