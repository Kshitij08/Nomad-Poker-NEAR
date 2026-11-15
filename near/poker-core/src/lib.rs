//! The rules both sides must agree on: how a 32-byte seed becomes a shuffled deck, which cards go where, and which
//! hand wins. The dealer (OutLayer, sealed hardware) deals with it; the table contract (NEAR) re-runs it at showdown,
//! so a dealer that dealt anything else is caught on-chain.

use sha2::{Digest, Sha256};

/// 0..52. Rank = card / 4 (0 = Two .. 12 = Ace), suit = card % 4.
pub type Card = u8;

pub const MAX_PLAYERS: usize = 9;

fn sha(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// The deck seed is the hash of the randomness proof (an Ed25519 signature), as OutLayer's VRF defines its output.
pub fn seed_from_signature(signature: &[u8]) -> [u8; 32] {
    sha(&[signature])
}

/// What the table stores at deal time. It fixes the deck without revealing it.
pub fn commit(seed: &[u8; 32]) -> [u8; 32] {
    sha(&[b"nomad-deck-commit:", seed])
}

/// Bytes from SHA-256 in counter mode.
struct Stream<'a> {
    seed: &'a [u8; 32],
    block: [u8; 32],
    counter: u32,
    used: usize,
}

impl<'a> Stream<'a> {
    fn new(seed: &'a [u8; 32]) -> Self {
        Stream { seed, block: [0; 32], counter: 0, used: 32 }
    }
    fn byte(&mut self) -> u8 {
        if self.used == 32 {
            self.block = sha(&[b"nomad-shuffle:", self.seed, &self.counter.to_le_bytes()]);
            self.counter += 1;
            self.used = 0;
        }
        self.used += 1;
        self.block[self.used - 1]
    }
    /// Uniform in 0..n (n <= 52), by rejection, so no card position is favoured.
    fn below(&mut self, n: u8) -> u8 {
        let limit = 256 - (256 % n as u16);
        loop {
            let b = self.byte();
            if (b as u16) < limit {
                return b % n;
            }
        }
    }
}

/// Fisher-Yates over the 52 cards.
pub fn shuffle(seed: &[u8; 32]) -> [Card; 52] {
    let mut deck = [0u8; 52];
    for (i, c) in deck.iter_mut().enumerate() {
        *c = i as u8;
    }
    let mut s = Stream::new(seed);
    for i in (1..52usize).rev() {
        let j = s.below(i as u8 + 1) as usize;
        deck.swap(i, j);
    }
    deck
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Deal {
    pub holes: Vec<[Card; 2]>,
    pub board: [Card; 5],
}

/// Player i holds deck[2i] and deck[2i+1]; the board is the next five cards.
pub fn deal(seed: &[u8; 32], players: usize) -> Deal {
    assert!((2..=MAX_PLAYERS).contains(&players), "2 to 9 players");
    let deck = shuffle(seed);
    let holes = (0..players).map(|i| [deck[2 * i], deck[2 * i + 1]]).collect();
    let b = 2 * players;
    Deal { holes, board: [deck[b], deck[b + 1], deck[b + 2], deck[b + 3], deck[b + 4]] }
}

/// A five-card hand as one number: higher wins, equal ties.
fn rank5(cards: [Card; 5]) -> u32 {
    let mut ranks = [0u8; 5];
    for (i, c) in cards.iter().enumerate() {
        ranks[i] = c / 4;
    }
    ranks.sort_unstable_by(|a, b| b.cmp(a));
    let flush = cards.iter().all(|c| c % 4 == cards[0] % 4);
    let distinct = ranks.windows(2).all(|w| w[0] != w[1]);
    let wheel = ranks == [12, 3, 2, 1, 0];
    let straight = distinct && (ranks[0] - ranks[4] == 4 || wheel);
    let straight_high = if wheel { 3 } else { ranks[0] };

    // Ranks ordered by how many of each there are, then by rank.
    let mut counts = [0u8; 13];
    for r in ranks {
        counts[r as usize] += 1;
    }
    let mut groups: Vec<(u8, u8)> = (0..13u8).filter(|r| counts[*r as usize] > 0).map(|r| (counts[r as usize], r)).collect();
    groups.sort_unstable_by(|a, b| b.cmp(a));
    let shape: Vec<u8> = groups.iter().map(|g| g.0).collect();

    let (category, kickers): (u32, Vec<u8>) = if straight && flush {
        (8, vec![straight_high])
    } else if shape == [4, 1] {
        (7, groups.iter().map(|g| g.1).collect())
    } else if shape == [3, 2] {
        (6, groups.iter().map(|g| g.1).collect())
    } else if flush {
        (5, ranks.to_vec())
    } else if straight {
        (4, vec![straight_high])
    } else if shape == [3, 1, 1] {
        (3, groups.iter().map(|g| g.1).collect())
    } else if shape == [2, 2, 1] {
        (2, groups.iter().map(|g| g.1).collect())
    } else if shape == [2, 1, 1, 1] {
        (1, groups.iter().map(|g| g.1).collect())
    } else {
        (0, ranks.to_vec())
    };
    let mut score = category;
    for i in 0..5 {
        score = (score << 4) | *kickers.get(i).unwrap_or(&0) as u32;
    }
    score
}

/// The best five of five, six or seven cards.
pub fn rank_cards(cards: &[Card]) -> u32 {
    let n = cards.len();
    assert!((5..=7).contains(&n), "5 to 7 cards");
    let mut best = 0;
    for mask in 0u32..(1 << n) {
        if mask.count_ones() != 5 {
            continue;
        }
        let mut five = [0u8; 5];
        let mut k = 0;
        for (i, c) in cards.iter().enumerate() {
            if mask & (1 << i) != 0 {
                five[k] = *c;
                k += 1;
            }
        }
        best = best.max(rank5(five));
    }
    best
}

/// Hand category of a `rank_cards` score: 0 high card .. 8 straight flush.
pub fn category(score: u32) -> u32 {
    score >> 20
}

/// No-limit hold'em betting for one hand. The dealer plays it; the table contract replays the same actions to
/// check the result, so both must run exactly this code.
pub mod game {
    use super::{rank_cards, Deal};

    /// Raises allowed per street. Keeps a hand's action list short enough for one OutLayer answer.
    pub const MAX_RAISES: u8 = 4;

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct Rules {
        pub stacks: Vec<u64>,
        pub button: usize,
        pub sb: u64,
        pub bb: u64,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Act {
        Fold,
        /// Check when there is nothing to call.
        Call,
        /// Raise (or bet) so this seat's bet on the street totals this much.
        RaiseTo(u64),
    }

    #[derive(Clone, Debug)]
    pub struct Hand {
        n: usize,
        button: usize,
        bb: u64,
        pub stack: Vec<u64>,
        /// Chips each seat has put in over the whole hand.
        pub total: Vec<u64>,
        /// Chips each seat has put in on this street.
        pub bet: Vec<u64>,
        pub folded: Vec<bool>,
        acted: Vec<bool>,
        /// 0 preflop, 1 flop, 2 turn, 3 river.
        pub street: u8,
        pub current: u64,
        min_raise: u64,
        raises: u8,
        turn: Option<usize>,
        over: bool,
    }

    impl Hand {
        pub fn new(r: &Rules) -> Result<Self, String> {
            let n = r.stacks.len();
            if !(2..=super::MAX_PLAYERS).contains(&n) {
                return Err("2 to 9 players".into());
            }
            if r.sb == 0 || r.bb < r.sb || r.button >= n {
                return Err("bad blinds or button".into());
            }
            if r.stacks.iter().any(|s| *s > 1 << 50) {
                return Err("stack too large".into());
            }
            // A seat with no chips sits out: it is dealt nothing that matters, posts nothing and is never asked to act.
            let active = r.stacks.iter().filter(|s| **s > 0).count();
            if active < 2 {
                return Err("fewer than 2 players have chips".into());
            }
            if r.stacks[r.button] == 0 {
                return Err("the button seat has no chips".into());
            }
            let next = |from: usize| (1..=n).map(|k| (from + k) % n).find(|i| r.stacks[*i] > 0).expect("2 players have chips");
            let mut h = Hand {
                n,
                button: r.button,
                bb: r.bb,
                stack: r.stacks.clone(),
                total: vec![0; n],
                bet: vec![0; n],
                folded: r.stacks.iter().map(|s| *s == 0).collect(),
                acted: vec![false; n],
                street: 0,
                current: r.bb,
                min_raise: r.bb,
                raises: 0,
                turn: None,
                over: false,
            };
            // Blinds go to the next seats with chips. Heads-up the button posts the small blind and acts first before
            // the flop.
            let (sb_seat, bb_seat) = if active == 2 {
                (r.button, next(r.button))
            } else {
                let sb = next(r.button);
                (sb, next(sb))
            };
            h.pay(sb_seat, r.sb);
            h.pay(bb_seat, r.bb);
            h.turn = h.find_next(bb_seat);
            if h.turn.is_none() {
                h.advance();
            }
            Ok(h)
        }

        fn pay(&mut self, seat: usize, amount: u64) {
            let a = amount.min(self.stack[seat]);
            self.stack[seat] -= a;
            self.bet[seat] += a;
            self.total[seat] += a;
        }

        fn needs(&self, i: usize) -> bool {
            !self.folded[i] && self.stack[i] > 0 && (!self.acted[i] || self.bet[i] < self.current)
        }

        fn find_next(&self, from: usize) -> Option<usize> {
            (1..=self.n).map(|k| (from + k) % self.n).find(|i| self.needs(*i))
        }

        fn live(&self) -> usize {
            self.folded.iter().filter(|f| !**f).count()
        }

        /// Moves to the next street that still has betting, or ends the hand.
        fn advance(&mut self) {
            loop {
                if self.street == 3 {
                    self.over = true;
                    self.turn = None;
                    return;
                }
                self.street += 1;
                self.bet.iter_mut().for_each(|b| *b = 0);
                self.acted.iter_mut().for_each(|a| *a = false);
                self.current = 0;
                self.min_raise = self.bb;
                self.raises = 0;
                let can_act = (0..self.n).filter(|i| !self.folded[*i] && self.stack[*i] > 0).count();
                if can_act < 2 {
                    continue; // everyone left is all-in (or one player has chips): deal the rest out
                }
                self.turn = self.find_next(self.button);
                if self.turn.is_some() {
                    return;
                }
            }
        }

        pub fn to_act(&self) -> Option<usize> {
            self.turn
        }

        /// Seats at the table, including any sitting out.
        pub fn seats(&self) -> usize {
            self.n
        }

        pub fn button(&self) -> usize {
            self.button
        }

        pub fn big_blind(&self) -> u64 {
            self.bb
        }

        pub fn is_over(&self) -> bool {
            self.over
        }

        pub fn pot(&self) -> u64 {
            self.total.iter().sum()
        }

        pub fn to_call(&self, seat: usize) -> u64 {
            self.current.saturating_sub(self.bet[seat]).min(self.stack[seat])
        }

        /// Board cards the seat to act can see.
        pub fn board_len(&self) -> usize {
            [0, 3, 4, 5][self.street as usize]
        }

        /// The lowest and highest "raise to" the seat to act may make, if it may raise at all.
        pub fn raise_range(&self) -> Option<(u64, u64)> {
            let i = self.turn?;
            if self.raises >= MAX_RAISES {
                return None;
            }
            let max_to = self.bet[i] + self.stack[i];
            if max_to <= self.current {
                return None;
            }
            // Raising is pointless when nobody else can respond.
            if !(0..self.n).any(|j| j != i && !self.folded[j] && self.stack[j] > 0) {
                return None;
            }
            Some(((self.current + self.min_raise).min(max_to), max_to))
        }

        pub fn apply(&mut self, act: Act) -> Result<(), String> {
            let i = self.turn.ok_or("the hand is over")?;
            match act {
                Act::Fold => self.folded[i] = true,
                Act::Call => {
                    let owed = self.current.saturating_sub(self.bet[i]);
                    self.pay(i, owed);
                }
                Act::RaiseTo(x) => {
                    let (lo, hi) = self.raise_range().ok_or("no raise allowed here")?;
                    if x < lo || x > hi {
                        return Err(format!("raise to {x} is outside {lo}..{hi}"));
                    }
                    let add = x - self.bet[i];
                    self.pay(i, add);
                    self.min_raise = self.min_raise.max(x - self.current);
                    self.current = x;
                    self.raises += 1;
                    self.acted.iter_mut().for_each(|a| *a = false);
                }
            }
            self.acted[i] = true;
            if self.live() == 1 {
                self.over = true;
                self.turn = None;
                return Ok(());
            }
            self.turn = self.find_next(i);
            if self.turn.is_none() {
                self.advance();
            }
            Ok(())
        }

        /// Each seat's result for the finished hand (winnings minus chips put in). Always sums to zero.
        pub fn payouts(&self, d: &Deal) -> Result<Vec<i64>, String> {
            if !self.over {
                return Err("the hand is not over".into());
            }
            let n = self.n;
            let mut won = vec![0u64; n];
            if self.live() == 1 {
                let w = (0..n).find(|i| !self.folded[*i]).unwrap();
                won[w] = self.pot();
            } else {
                let score: Vec<u32> = (0..n)
                    .map(|i| if self.folded[i] { 0 } else { rank_cards(&[d.holes[i][0], d.holes[i][1], d.board[0], d.board[1], d.board[2], d.board[3], d.board[4]]) })
                    .collect();
                let mut levels: Vec<u64> = self.total.iter().copied().filter(|t| *t > 0).collect();
                levels.sort_unstable();
                levels.dedup();
                let mut prev = 0u64;
                for level in levels {
                    let pot: u64 = self.total.iter().map(|t| (*t).min(level) - (*t).min(prev)).sum();
                    prev = level;
                    let mut eligible: Vec<usize> = (0..n).filter(|i| !self.folded[*i] && self.total[*i] >= level).collect();
                    if eligible.is_empty() {
                        let top = (0..n).filter(|i| !self.folded[*i]).map(|i| self.total[i]).max().unwrap();
                        eligible = (0..n).filter(|i| !self.folded[*i] && self.total[*i] == top).collect();
                    }
                    let best = eligible.iter().map(|i| score[*i]).max().unwrap();
                    let winners: Vec<usize> = eligible.into_iter().filter(|i| score[*i] == best).collect();
                    let share = pot / winners.len() as u64;
                    let mut odd = pot % winners.len() as u64;
                    // Odd chips go to the winners nearest the button's left.
                    for k in 1..=n {
                        let seat = (self.button + k) % n;
                        if winners.contains(&seat) {
                            won[seat] += share + if odd > 0 { 1 } else { 0 };
                            odd = odd.saturating_sub(1);
                        }
                    }
                }
            }
            Ok((0..n).map(|i| won[i] as i64 - self.total[i] as i64).collect())
        }
    }

    /// Actions as text: `f` fold, `c` check or call, `r120` raise to 120, joined by commas, in the order played.
    pub fn format_actions(acts: &[Act]) -> String {
        acts.iter()
            .map(|a| match a {
                Act::Fold => "f".to_string(),
                Act::Call => "c".to_string(),
                Act::RaiseTo(x) => format!("r{x}"),
            })
            .collect::<Vec<_>>()
            .join(",")
    }

    pub fn parse_actions(text: &str) -> Result<Vec<Act>, String> {
        if text.is_empty() {
            return Ok(vec![]);
        }
        text.split(',')
            .map(|t| match t {
                "f" => Ok(Act::Fold),
                "c" => Ok(Act::Call),
                _ => t.strip_prefix('r').and_then(|x| x.parse().ok()).map(Act::RaiseTo).ok_or(format!("bad action {t}")),
            })
            .collect()
    }

    /// Plays the given actions from the start and returns the finished hand. Any illegal or missing action fails.
    pub fn replay(rules: &Rules, acts: &[Act]) -> Result<Hand, String> {
        let mut h = Hand::new(rules)?;
        for a in acts {
            h.apply(*a)?;
        }
        if !h.is_over() {
            return Err("the actions stop before the hand ends".into());
        }
        Ok(h)
    }
}

/// A session: many hands at one table from one randomness proof. Stacks carry over. A player who runs out of chips
/// sits out the rest of the session, and the button moves to the next seat that still has chips. The session ends
/// after the asked number of hands, or when only one player has chips left.
pub mod session {
    use super::game::{self, Rules};
    use super::{deal, sha};

    pub const MAX_HANDS: usize = 200;

    /// Each hand's deck seed comes from the session seed, so one proof fixes every hand.
    pub fn hand_seed(seed: &[u8; 32], k: u32) -> [u8; 32] {
        sha(&[b"nomad-session-hand:", seed, &k.to_le_bytes()])
    }

    /// Seating from the randomness: table position `p` is taken by listed seat `order[p]`. Sessions whose request
    /// says `"seating": "vrf"` use it, so whoever opens a session lists its agents but cannot choose where they sit.
    pub fn seat_order(seed: &[u8; 32], n: usize) -> Vec<usize> {
        let s = sha(&[b"nomad-seat-order:", seed]);
        let mut order: Vec<usize> = (0..n).collect();
        let mut stream = super::Stream::new(&s);
        for i in (1..n).rev() {
            let j = stream.below(i as u8 + 1) as usize;
            order.swap(i, j);
        }
        order
    }

    /// Listed items (profiles, stacks, seats) put in table-position order.
    pub fn seat<T: Clone>(listed: &[T], order: &[usize]) -> Vec<T> {
        order.iter().map(|i| listed[*i].clone()).collect()
    }

    /// What the dealer attests for a session: the session id, the deck proof's signature, the request as the table
    /// recorded it (listed stacks, button, blinds, hands, seating, each profile's playing numbers) and the actions.
    /// The dealer asks OutLayer's VRF to sign `act-<hex of this>` in the same run that played the session, so a
    /// relayer cannot change any action, even into another legal one, without a new signature from OutLayer.
    pub fn attest_digest(session_id: &str, signature_hex: &str, listed: &Rules, hands: usize, seating: Option<&str>, profiles: &[crate::profile::Profile], actions: &str) -> [u8; 32] {
        let mut parts: Vec<Vec<u8>> = vec![session_id.as_bytes().to_vec(), signature_hex.as_bytes().to_vec()];
        let mut nums = vec![];
        for s in &listed.stacks {
            nums.extend_from_slice(&s.to_le_bytes());
        }
        for v in [listed.button as u64, listed.sb, listed.bb, hands as u64] {
            nums.extend_from_slice(&v.to_le_bytes());
        }
        parts.push(nums);
        parts.push(seating.unwrap_or("").as_bytes().to_vec());
        for p in profiles {
            parts.push(p.canonical_bytes());
        }
        parts.push(actions.as_bytes().to_vec());
        // Each part is length-prefixed, so no two different requests hash the same bytes.
        let mut h = <sha2::Sha256 as sha2::Digest>::new();
        sha2::Digest::update(&mut h, b"nomad-attest-v1:");
        for p in &parts {
            sha2::Digest::update(&mut h, (p.len() as u32).to_le_bytes());
            sha2::Digest::update(&mut h, p);
        }
        sha2::Digest::finalize(h).into()
    }

    /// The VRF label the dealer signs for an attested session.
    pub fn attest_label(digest: &[u8; 32]) -> String {
        let mut s = String::from("act-");
        for b in digest {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }

    /// Players who still have chips.
    pub fn active(stacks: &[u64]) -> usize {
        stacks.iter().filter(|s| **s > 0).count()
    }

    fn next_active(stacks: &[u64], from: usize) -> usize {
        let n = stacks.len();
        (1..=n).map(|k| (from + k) % n).find(|i| stacks[*i] > 0).unwrap_or(from)
    }

    /// The button for a hand: the session's starting button for the first hand, then the next seat with chips after
    /// the previous hand's button.
    pub fn button_for(start: &Rules, stacks: &[u64], previous: Option<usize>) -> usize {
        match previous {
            None if stacks[start.button] > 0 => start.button,
            None => next_active(stacks, start.button),
            Some(b) => next_active(stacks, b),
        }
    }

    pub fn rules_for(start: &Rules, stacks: &[u64], button: usize) -> Rules {
        Rules { stacks: stacks.to_vec(), button, sb: start.sb, bb: start.bb }
    }

    pub fn check(start: &Rules, hands: usize) -> Result<(), String> {
        if hands == 0 || hands > MAX_HANDS {
            return Err(format!("1 to {MAX_HANDS} hands"));
        }
        game::Hand::new(start).map(|_| ())
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct HandRecord {
        pub button: usize,
        pub stacks_before: Vec<u64>,
        /// Each seat's result; 0 for a seat sitting out.
        pub deltas: Vec<i64>,
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct Outcome {
        pub hands: Vec<HandRecord>,
        pub stacks: Vec<u64>,
    }

    /// Replays a session from its action text (hands separated by `;`). Refuses a session that stops while two
    /// players still have chips, runs long, keeps playing after one player is left, or contains any illegal or
    /// missing action.
    pub fn replay(start: &Rules, seed: &[u8; 32], hands: usize, text: &str) -> Result<Outcome, String> {
        check(start, hands)?;
        let parts: Vec<&str> = text.split(';').collect();
        if parts.len() > hands {
            return Err("more hands than the session asked for".into());
        }
        let n = start.stacks.len();
        let mut stacks = start.stacks.clone();
        let mut button = None;
        let mut records = Vec::with_capacity(parts.len());
        for (k, part) in parts.iter().enumerate() {
            if active(&stacks) < 2 {
                return Err(format!("hand {k} was played after only one player had chips"));
            }
            let b = button_for(start, &stacks, button);
            button = Some(b);
            let rules = rules_for(start, &stacks, b);
            let hand = game::replay(&rules, &game::parse_actions(part)?).map_err(|e| format!("hand {k}: {e}"))?;
            let d = hand.payouts(&deal(&hand_seed(seed, k as u32), n))?;
            records.push(HandRecord { button: b, stacks_before: stacks.clone(), deltas: d.clone() });
            for i in 0..n {
                stacks[i] = (stacks[i] as i64 + d[i]) as u64;
            }
        }
        if parts.len() < hands && active(&stacks) >= 2 {
            return Err("the session stopped while two players still had chips".into());
        }
        Ok(Outcome { hands: records, stacks })
    }
}

pub mod profile;
#[cfg(feature = "agent")]
pub mod agent;

/// Seats with the best hand at showdown (more than one on a tie).
pub fn winners(d: &Deal) -> Vec<u8> {
    let scores: Vec<u32> = d
        .holes
        .iter()
        .map(|h| rank_cards(&[h[0], h[1], d.board[0], d.board[1], d.board[2], d.board[3], d.board[4]]))
        .collect();
    let top = *scores.iter().max().unwrap();
    (0..scores.len()).filter(|i| scores[*i] == top).map(|i| i as u8).collect()
}

/// Hole cards sealed for one player: only the holder of that player's X25519 secret key can open them.
#[cfg(feature = "seal")]
pub mod seal {
    use super::sha;
    use chacha20poly1305::{aead::Aead, ChaCha20Poly1305, KeyInit, Nonce};
    use x25519_dalek::{PublicKey, StaticSecret};

    pub struct Sealed {
        /// One-time X25519 public key for this player and hand.
        pub eph: [u8; 32],
        /// The two cards, ChaCha20-Poly1305 sealed (2 bytes + 16-byte tag).
        pub ct: Vec<u8>,
    }

    fn key(shared: &[u8; 32], eph: &[u8; 32], player_pk: &[u8; 32]) -> [u8; 32] {
        sha(&[b"nomad-hole-key:", shared, eph, player_pk])
    }

    /// The one-time key comes from the secret deck seed, so it is unpredictable without a second randomness call.
    /// Each key is used for one message, so the nonce is fixed at zero.
    pub fn seal_hole(seed: &[u8; 32], seat: usize, player_pk: [u8; 32], cards: [u8; 2]) -> Sealed {
        let eph_secret = StaticSecret::from(sha(&[b"nomad-eph:", seed, &[seat as u8]]));
        let eph = *PublicKey::from(&eph_secret).as_bytes();
        let shared = eph_secret.diffie_hellman(&PublicKey::from(player_pk));
        let cipher = ChaCha20Poly1305::new_from_slice(&key(shared.as_bytes(), &eph, &player_pk)).expect("32-byte key");
        let ct = cipher.encrypt(Nonce::from_slice(&[0u8; 12]), cards.as_ref()).expect("seal");
        Sealed { eph, ct }
    }

    pub fn open_hole(player_sk: [u8; 32], eph: [u8; 32], ct: &[u8]) -> Option<[u8; 2]> {
        let sk = StaticSecret::from(player_sk);
        let player_pk = *PublicKey::from(&sk).as_bytes();
        let shared = sk.diffie_hellman(&PublicKey::from(eph));
        let cipher = ChaCha20Poly1305::new_from_slice(&key(shared.as_bytes(), &eph, &player_pk)).ok()?;
        cipher.decrypt(Nonce::from_slice(&[0u8; 12]), ct).ok()?.try_into().ok()
    }
}

pub fn card_name(c: Card) -> String {
    let r = b"23456789TJQKA"[(c / 4) as usize] as char;
    let s = b"cdhs"[(c % 4) as usize] as char;
    format!("{r}{s}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(name: &str) -> Card {
        let b = name.as_bytes();
        let r = b"23456789TJQKA".iter().position(|x| *x == b[0]).unwrap() as u8;
        let s = b"cdhs".iter().position(|x| *x == b[1]).unwrap() as u8;
        r * 4 + s
    }
    fn r5(names: [&str; 5]) -> u32 {
        rank5([c(names[0]), c(names[1]), c(names[2]), c(names[3]), c(names[4])])
    }

    #[test]
    fn shuffle_is_a_permutation_and_repeatable() {
        let seed = [7u8; 32];
        let a = shuffle(&seed);
        let mut sorted = a;
        sorted.sort_unstable();
        assert_eq!(sorted.to_vec(), (0..52u8).collect::<Vec<_>>());
        assert_eq!(a, shuffle(&seed));
        assert_ne!(a, shuffle(&[8u8; 32]));
    }

    #[test]
    fn deal_uses_distinct_cards() {
        let d = deal(&[1u8; 32], 9);
        let mut all: Vec<u8> = d.holes.iter().flatten().copied().chain(d.board).collect();
        all.sort_unstable();
        all.dedup();
        assert_eq!(all.len(), 23);
    }

    #[test]
    fn categories_are_ordered() {
        let ladder = [
            r5(["As", "Kd", "9h", "5c", "3s"]), // high card
            r5(["As", "Ad", "9h", "5c", "3s"]), // pair
            r5(["As", "Ad", "9h", "9c", "3s"]), // two pair
            r5(["As", "Ad", "Ah", "5c", "3s"]), // trips
            r5(["5s", "4d", "3h", "2c", "As"]), // wheel
            r5(["6s", "5d", "4h", "3c", "2s"]), // six-high straight
            r5(["As", "Js", "9s", "5s", "3s"]), // flush
            r5(["As", "Ad", "Ah", "5c", "5s"]), // full house
            r5(["As", "Ad", "Ah", "Ac", "3s"]), // quads
            r5(["5s", "4s", "3s", "2s", "As"]), // straight flush (wheel)
            r5(["As", "Ks", "Qs", "Js", "Ts"]), // royal
        ];
        for w in ladder.windows(2) {
            assert!(w[0] < w[1]);
        }
    }

    #[test]
    fn kickers_break_ties() {
        assert!(r5(["As", "Ad", "Kh", "5c", "3s"]) > r5(["Ah", "Ac", "Qh", "5d", "3d"]));
        assert_eq!(r5(["As", "Ad", "Kh", "5c", "3s"]), r5(["Ah", "Ac", "Kd", "5d", "3d"]));
        assert!(r5(["Ks", "Kd", "2h", "2c", "3s"]) > r5(["Qs", "Qd", "Jh", "Jc", "As"]));
    }

    #[cfg(feature = "seal")]
    #[test]
    fn only_the_player_opens_their_cards() {
        use x25519_dalek::{PublicKey, StaticSecret};
        let seed = [9u8; 32];
        let d = deal(&seed, 2);
        let sk = [3u8; 32];
        let pk = *PublicKey::from(&StaticSecret::from(sk)).as_bytes();
        let s = seal::seal_hole(&seed, 0, pk, d.holes[0]);
        assert_eq!(seal::open_hole(sk, s.eph, &s.ct), Some(d.holes[0]));
        assert_eq!(seal::open_hole([4u8; 32], s.eph, &s.ct), None);
        let mut bad = s.ct.clone();
        bad[0] ^= 1;
        assert_eq!(seal::open_hole(sk, s.eph, &bad), None);
    }

    fn board(names: [&str; 5]) -> [Card; 5] {
        [c(names[0]), c(names[1]), c(names[2]), c(names[3]), c(names[4])]
    }

    #[test]
    fn heads_up_fold_and_checkdown() {
        use game::*;
        let rules = Rules { stacks: vec![100, 100], button: 0, sb: 1, bb: 2 };
        let d = Deal { holes: vec![[c("Ah"), c("Ad")], [c("7c"), c("2d")]], board: board(["Ks", "9s", "4h", "Jd", "3c"]) };
        // The button (small blind) folds: it loses the small blind.
        let h = replay(&rules, &[Act::Fold]).unwrap();
        assert_eq!(h.payouts(&d).unwrap(), vec![-1, 1]);
        // Call, check, then check every street: aces win the 4-chip pot.
        let acts = parse_actions("c,c,c,c,c,c,c,c").unwrap();
        let h = replay(&rules, &acts).unwrap();
        assert_eq!(h.payouts(&d).unwrap(), vec![2, -2]);
        // Too few actions, or an illegal one, is refused.
        assert!(replay(&rules, &parse_actions("c,c").unwrap()).is_err());
        assert!(replay(&rules, &[Act::RaiseTo(3)]).is_err()); // below the minimum raise to 4
        assert!(replay(&rules, &[Act::RaiseTo(101)]).is_err()); // more than the stack
    }

    #[test]
    fn empty_seats_sit_out() {
        use game::*;
        // The button must have chips, and at least two players must.
        assert!(Hand::new(&Rules { stacks: vec![0, 100, 100], button: 0, sb: 1, bb: 2 }).is_err());
        assert!(Hand::new(&Rules { stacks: vec![0, 0, 100], button: 2, sb: 1, bb: 2 }).is_err());
        // Seat 0 empty, two players left: heads-up rules, the button posts the small blind and acts first.
        let rules = Rules { stacks: vec![0, 100, 100], button: 1, sb: 1, bb: 2 };
        let h = Hand::new(&rules).unwrap();
        assert_eq!(h.total, vec![0, 1, 2]);
        assert_eq!(h.to_act(), Some(1));
        // Four seats, seat 2 empty, button 1: blinds skip seat 2, so seat 3 posts the small blind and seat 0 the big.
        let h = Hand::new(&Rules { stacks: vec![100, 100, 0, 100], button: 1, sb: 1, bb: 2 }).unwrap();
        assert_eq!(h.total, vec![2, 0, 0, 1]);
        assert_eq!(h.to_act(), Some(1));
        // The empty seat's cards play no part: aces win, seat 0 is unaffected.
        let d = Deal { holes: vec![[c("2c"), c("3d")], [c("Ah"), c("Ad")], [c("Kh"), c("Kd")]], board: board(["Ks", "9s", "4h", "Jd", "3c"]) };
        let h = replay(&rules, &parse_actions("c,c,c,c,c,c,c,c").unwrap()).unwrap();
        assert_eq!(h.payouts(&d).unwrap(), vec![0, -2, 2]);
    }

    #[test]
    fn a_session_continues_after_a_bust_and_ends_with_one_player() {
        // The first to act shoves and everyone calls, so players bust quickly.
        let start = game::Rules { stacks: vec![10, 100, 100], button: 0, sb: 1, bb: 2 };
        let n = 3;
        let mut continued = 0;
        for round in 0u32..300 {
            let seed = sha(&[b"bust", &round.to_le_bytes()]);
            let mut stacks = start.stacks.clone();
            let mut button = None;
            let mut texts = vec![];
            for k in 0..40usize {
                if session::active(&stacks) < 2 {
                    break;
                }
                let b = session::button_for(&start, &stacks, button);
                button = Some(b);
                let rules = session::rules_for(&start, &stacks, b);
                let d = deal(&session::hand_seed(&seed, k as u32), n);
                let mut h = game::Hand::new(&rules).unwrap();
                let mut acts = vec![];
                while h.to_act().is_some() {
                    let a = match h.raise_range() {
                        Some((_, hi)) if acts.is_empty() => game::Act::RaiseTo(hi),
                        _ => game::Act::Call,
                    };
                    h.apply(a).unwrap();
                    acts.push(a);
                }
                for (i, x) in h.payouts(&d).unwrap().iter().enumerate() {
                    stacks[i] = (stacks[i] as i64 + x) as u64;
                }
                texts.push(game::format_actions(&acts));
            }
            let out = session::replay(&start, &seed, 40, &texts.join(";")).unwrap();
            assert_eq!(out.stacks, stacks);
            assert_eq!(out.stacks.iter().sum::<u64>(), 210);
            assert!(out.hands.len() == 40 || session::active(&out.stacks) == 1);
            // Once a seat is out, the button never lands on it and the hands go on without it.
            if let Some(k) = out.hands.iter().position(|h| h.stacks_before[0] == 0) {
                continued += 1;
                for h in &out.hands[k..] {
                    assert_ne!(h.button, 0);
                    assert_eq!(h.deltas[0], 0);
                }
            }
            // Cutting a session short while two players still have chips is refused.
            if out.hands.len() > 1 && session::active(&out.hands[out.hands.len() - 1].stacks_before) >= 2 {
                let short = texts[..texts.len() - 1].join(";");
                let cut = session::replay(&start, &seed, 40, &short);
                assert!(cut.is_err() || session::active(&cut.unwrap().stacks) < 2);
            }
        }
        assert!(continued > 50, "seat 0 should often bust and the session go on: {continued}");
    }

    #[test]
    fn side_pots_pay_each_layer() {
        use game::*;
        // Seat 0 is short (30). Seats 1 and 2 have 100. Button 0, so seat 1 posts 1 and seat 2 posts 2; seat 0 acts first.
        let rules = Rules { stacks: vec![30, 100, 100], button: 0, sb: 1, bb: 2 };
        // Seat 0 has the best hand, seat 1 second, seat 2 third.
        let d = Deal { holes: vec![[c("Ah"), c("Ad")], [c("Kh"), c("Kd")], [c("Qh"), c("Qd")]], board: board(["2s", "7c", "9d", "Jc", "3s"]) };
        // Seat 0 all-in to 30, seat 1 re-raises all-in to 100, seat 2 calls.
        let h = replay(&rules, &[Act::RaiseTo(30), Act::RaiseTo(100), Act::Call]).unwrap();
        // Main pot 90 to seat 0 (+60). Side pot 140 to seat 1 (+40). Seat 2 loses 100.
        assert_eq!(h.payouts(&d).unwrap(), vec![60, 40, -100]);
    }

    #[test]
    fn actions_round_trip_as_text() {
        use game::*;
        let acts = vec![Act::RaiseTo(6), Act::Call, Act::Fold, Act::Call];
        assert_eq!(format_actions(&acts), "r6,c,f,c");
        assert_eq!(parse_actions("r6,c,f,c").unwrap(), acts);
        assert!(parse_actions("x").is_err());
    }

    /// A valid v2 profile drawn from seed bytes, sometimes with street overrides and a position weight.
    #[cfg(feature = "agent")]
    fn random_profile(seed: &[u8; 32], i: usize) -> profile::Profile {
        use profile::{Numbers, Profile, MAX, MIN};
        let pick = |k: usize| -> [u8; 5] { core::array::from_fn(|j| MIN[j] + seed[(k + j * 3) % 32] % (MAX[j] - MIN[j] + 1)) };
        let mut p = Profile::new(pick(i * 5));
        p.position_weight = seed[(i + 7) % 32] % 101;
        if seed[(i + 3) % 32] % 2 == 0 {
            p.streets = vec![Some(Numbers::new(pick(i + 1))), None, Some(Numbers::new(pick(i + 2))), None];
        }
        p.validate().unwrap();
        p
    }

    #[cfg(feature = "agent")]
    #[test]
    fn agents_always_finish_a_legal_hand_that_replays_the_same() {
        use agent::*;
        use game::*;
        use profile::Profile;
        let mut longest = 0;
        for round in 0u32..600 {
            let seed = sha(&[b"test", &round.to_le_bytes()]);
            let n = 2 + (seed[0] as usize % 8);
            let stacks: Vec<u64> = (0..n).map(|i| 20 + (seed[1 + i] as u64) * 3).collect();
            let profiles: Vec<Profile> = (0..n).map(|i| random_profile(&seed, i)).collect();
            let rules = Rules { stacks, button: seed[31] as usize % n, sb: 1, bb: 2 };
            let d = deal(&seed, n);
            let acts = play(&profiles, &seed, Hand::new(&rules).unwrap(), &d);
            longest = longest.max(format_actions(&acts).len());
            // The contract's path: replay the text and pay out.
            let h = replay(&rules, &parse_actions(&format_actions(&acts)).unwrap()).unwrap();
            let pay = h.payouts(&d).unwrap();
            assert_eq!(pay.iter().sum::<i64>(), 0, "round {round}");
            for i in 0..n {
                assert!(pay[i] >= -(rules.stacks[i] as i64), "round {round}: lost more than the stack");
            }
            // The same seed plays the same hand again.
            assert_eq!(acts, play(&profiles, &seed, Hand::new(&rules).unwrap(), &d));
        }
        // An OutLayer answer holds at most 900 bytes; the proof and ids take about 300.
        assert!(longest < 450, "longest action text: {longest}");
    }

    #[cfg(feature = "agent")]
    #[test]
    fn sessions_replay_and_refuse_tampering() {
        use agent::*;
        use game::*;
        use profile::Profile;
        let mut sizes = vec![];
        for round in 0u32..60 {
            let seed = sha(&[b"session", &round.to_le_bytes()]);
            let n = 2 + (seed[0] as usize % 5);
            let start = Rules { stacks: vec![200; n], button: 0, sb: 1, bb: 2 };
            let profiles: Vec<Profile> = (0..n).map(|i| if i % 2 == 0 { random_profile(&seed, i) } else { Profile::from_legacy(seed[1 + i] % 60, 30 + seed[10 + i] % 70) }).collect();
            let text = play_session(&profiles, &seed, &start, 50).unwrap();
            sizes.push(text.len());
            let out = session::replay(&start, &seed, 50, &text).unwrap();
            // Chips are only moved, never made.
            assert_eq!(out.stacks.iter().sum::<u64>(), 200 * n as u64);
            let played = out.hands.len();
            assert!(played == 50 || session::active(&out.stacks) < 2, "round {round}: stopped early");
            // A seat that sat out a hand neither won nor lost in it.
            for h in &out.hands {
                for i in 0..n {
                    if h.stacks_before[i] == 0 {
                        assert_eq!(h.deltas[i], 0);
                    }
                }
            }
            // Dropping the last hand is refused unless it is a legitimate early stop (never, here: we drop one).
            if played > 1 {
                let short = &text[..text.rfind(';').unwrap()];
                assert!(session::replay(&start, &seed, 50, short).is_err(), "round {round}");
            }
            // Asking for fewer hands than were played is refused.
            if played > 2 {
                assert!(session::replay(&start, &seed, played - 1, &text).is_err());
            }
        }
        sizes.sort_unstable();
        // Recorded for sizing the batch: median and worst action text for 50 hands.
        eprintln!("50-hand session text: median {} bytes, max {}", sizes[sizes.len() / 2], sizes[sizes.len() - 1]);
    }

    #[test]
    fn seating_from_the_seed_is_a_fair_permutation() {
        let mut first = [0u32; 4];
        for round in 0u32..4000 {
            let seed = sha(&[b"seat", &round.to_le_bytes()]);
            let order = session::seat_order(&seed, 4);
            let mut sorted = order.clone();
            sorted.sort_unstable();
            assert_eq!(sorted, vec![0, 1, 2, 3]);
            assert_eq!(order, session::seat_order(&seed, 4));
            first[order[0]] += 1;
        }
        // Each listed seat lands on table position 0 about a quarter of the time.
        assert!(first.iter().all(|c| (850..1150).contains(c)), "{first:?}");
        assert_eq!(session::seat(&["a", "b", "c"], &[2, 0, 1]), vec!["c", "a", "b"]);
    }

    #[cfg(feature = "agent")]
    #[test]
    fn styles_play_differently() {
        use profile::Profile;
        // Count raises and folds per style over many hands at a 4-handed table of that style.
        let stats = |p: Profile| {
            let (mut raises, mut folds, mut acts) = (0, 0, 0);
            for round in 0u32..120 {
                let seed = sha(&[b"style", &round.to_le_bytes()]);
                let rules = game::Rules { stacks: vec![200; 4], button: round as usize % 4, sb: 1, bb: 2 };
                let d = deal(&seed, 4);
                for a in agent::play(&vec![p.clone(); 4], &seed, game::Hand::new(&rules).unwrap(), &d) {
                    acts += 1;
                    match a {
                        game::Act::RaiseTo(_) => raises += 1,
                        game::Act::Fold => folds += 1,
                        _ => {}
                    }
                }
            }
            (raises as f64 / acts as f64, folds as f64 / acts as f64)
        };
        let (dare_r, _) = stats(Profile::preset("Daredevil").unwrap());
        let (trap_r, _) = stats(Profile::preset("Trapper").unwrap());
        let (_, guard_f) = stats(Profile::preset("Guardian").unwrap());
        let (_, loose_f) = stats(Profile::new([10, 45, 50, 5, 60]));
        assert!(dare_r > trap_r * 1.5, "daredevil raises {dare_r}, trapper {trap_r}");
        assert!(guard_f > loose_f, "guardian folds {guard_f}, loose {loose_f}");
    }

    #[test]
    fn best_five_of_seven_and_split_pots() {
        // The board is a royal flush: both players play it and split.
        let d = Deal { holes: vec![[c("2c"), c("3d")], [c("7h"), c("8c")]], board: [c("As"), c("Ks"), c("Qs"), c("Js"), c("Ts")] };
        assert_eq!(winners(&d), vec![0, 1]);
        // A flush from hole cards beats a pair.
        let d = Deal { holes: vec![[c("Ah"), c("Ad")], [c("9s"), c("2s")]], board: [c("Ks"), c("7s"), c("4s"), c("Jd"), c("3c")] };
        assert_eq!(winners(&d), vec![1]);
    }
}
