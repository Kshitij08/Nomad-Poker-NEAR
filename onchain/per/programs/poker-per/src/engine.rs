//! Texas Hold'em cash-game rules, ported from the game's C# `Poker.Core` (`PokerEngine`,
//! `HandEvaluator`, `SidePotCalculator`, `LegalActions`) so on-chain tables play exactly like the
//! existing game. Golden vectors produced by that C# code (`per/golden`) are replayed against this
//! module in the tests below; any rule change must be made in both places.
//!
//! Pure and allocation-light. `Game` is the betting state the program keeps in the private ledger
//! (readable by the seated players). Hole cards and the board aren't part of it: they're private
//! until revealed, so the caller passes them in (`Cards`) whenever the engine may need them.
//!
//! Deliberate differences from the C# engine, both outside the betting rules:
//! - the button is chosen by the caller (M4: random for a table's first hand, then rotating);
//! - which cards go to whom is decided by the caller (M4's dealing order and the board positions).

use anchor_lang::prelude::*;

use crate::constants::MAX_SEATS;

const N: usize = MAX_SEATS as usize;
pub const NONE: u8 = u8::MAX;

// Seat status (C# PlayerStatus).
pub const EMPTY: u8 = 0;
pub const SITTING_OUT: u8 = 1;
pub const ACTIVE: u8 = 2;
pub const FOLDED: u8 = 3;
pub const ALL_IN: u8 = 4;
pub const BUSTED: u8 = 5;

// Streets (C# BettingRound).
pub const NO_STREET: u8 = 0;
pub const PREFLOP: u8 = 1;
pub const FLOP: u8 = 2;
pub const TURN: u8 = 3;
pub const RIVER: u8 = 4;
/// The hand is over (C# `BettingRound.Showdown` after `EndHand`).
pub const DONE: u8 = 5;

// Action kinds (C# ActionType order).
pub const FOLD: u8 = 0;
pub const CHECK: u8 = 1;
pub const CALL: u8 = 2;
pub const BET: u8 = 3;
pub const RAISE: u8 = 4;
pub const ALL_IN_ACTION: u8 = 5;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Debug)]
pub struct GameSeat {
    pub status: u8,
    /// Chips behind (not yet committed this hand).
    pub stack: u64,
    /// Committed in the current betting round.
    pub current_bet: u64,
    /// Committed across the whole hand (drives side pots).
    pub total: u64,
    pub has_acted: bool,
}

impl GameSeat {
    pub fn in_hand(&self) -> bool {
        self.status == ACTIVE || self.status == ALL_IN
    }
    pub fn can_act(&self) -> bool {
        self.status == ACTIVE && self.stack > 0
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Debug)]
pub struct Game {
    pub seat_count: u8,
    pub small_blind: u64,
    pub big_blind: u64,
    pub seats: [GameSeat; N],
    pub button: u8,
    pub sb_seat: u8,
    pub bb_seat: u8,
    /// Reference seat for turn order (C# `CurrentSeat`).
    pub current_seat: u8,
    /// Seat whose decision is awaited, or NONE.
    pub to_act: u8,
    pub street: u8,
    pub high_bet: u64,
    pub min_raise: u64,
    pub pot: u64,
    /// Every remaining opponent is all-in or folded: no more betting, the board runs out.
    pub runout: bool,
    pub board: [u8; 5],
    pub board_len: u8,
}

/// Private cards the engine may need: hole cards (for showdown) and the five board cards (dealt
/// street by street). Cards are 0..52 as in M4 and the C# `Card.Index`.
#[derive(Clone, Copy, Debug)]
pub struct Cards {
    pub holes: [[u8; 2]; N],
    pub board: [u8; 5],
}

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Legal {
    pub can_fold: bool,
    pub can_check: bool,
    pub can_call: bool,
    pub call_amount: u64,
    pub can_bet: bool,
    pub can_raise: bool,
    pub min_raise_to: u64,
    pub max_raise_to: u64,
    pub can_all_in: bool,
}

/// Chips paid out when a hand ends, in the order the C# engine announces them.
pub type Awards = Vec<(u8, u64)>;

#[derive(Debug, PartialEq)]
pub enum EngineError {
    NotYourTurn,
    Illegal,
    HandOver,
    NeedTwoPlayers,
}

impl Game {
    /// Starts a hand (C# `ResetForNewHand` + blinds + first actor). `stacks[i]` is `Some` for a seat
    /// dealt in (it must hold chips), `None` for a seat that isn't. `button` must be a dealt seat.
    pub fn start(seat_count: u8, small_blind: u64, big_blind: u64, stacks: [Option<u64>; N], button: u8, cards: &Cards) -> core::result::Result<(Game, Awards), EngineError> {
        let mut g = Game { seat_count, small_blind, big_blind, button, to_act: NONE, min_raise: big_blind, street: PREFLOP, ..Default::default() };
        for i in 0..N {
            g.seats[i] = match stacks[i] {
                Some(s) if s > 0 && i < seat_count as usize => GameSeat { status: ACTIVE, stack: s, ..Default::default() },
                _ => GameSeat::default(),
            };
        }
        let funded = g.seats.iter().filter(|s| s.status == ACTIVE).count();
        if funded < 2 || !g.funded(button) {
            return Err(EngineError::NeedTwoPlayers);
        }
        if funded == 2 {
            g.sb_seat = button;
            g.bb_seat = g.next_funded(button);
        } else {
            g.sb_seat = g.next_funded(button);
            g.bb_seat = g.next_funded(g.sb_seat);
        }
        g.post_blind(g.sb_seat, small_blind);
        g.post_blind(g.bb_seat, big_blind);
        g.high_bet = big_blind;
        g.min_raise = big_blind;
        g.current_seat = g.bb_seat;
        let mut awards = Vec::new();
        g.advance(cards, &mut awards);
        Ok((g, awards))
    }

    pub fn is_over(&self) -> bool {
        self.street == DONE
    }

    /// What the awaited seat may do (C# `ComputeLegalActions`).
    pub fn legal(&self) -> Legal {
        if self.to_act == NONE {
            return Legal::default();
        }
        let p = &self.seats[self.to_act as usize];
        let to_call = self.high_bet.saturating_sub(p.current_bet);
        let call_amount = to_call.min(p.stack);
        let max_raise_to = p.current_bet + p.stack;
        let opponents_can_act = !self.runout && self.count_can_act() > 1;
        let can_check = to_call == 0;
        let can_call = to_call > 0 && p.stack > 0;
        let (mut can_bet, mut can_raise, mut min_raise_to) = (false, false, 0);
        if to_call == 0 {
            if p.stack > 0 && opponents_can_act {
                can_bet = true;
                min_raise_to = (p.current_bet + self.min_raise).min(max_raise_to);
            }
        } else if p.stack > to_call && opponents_can_act {
            can_raise = true;
            min_raise_to = (self.high_bet + self.min_raise).min(max_raise_to);
        }
        let mut can_all_in = p.stack > 0 && (to_call > 0 || opponents_can_act);
        if to_call > 0 && p.stack > to_call && !opponents_can_act {
            can_all_in = false; // leftover chips would be an uncallable raise
        }
        Legal { can_fold: true, can_check, can_call, call_amount, can_bet, can_raise, min_raise_to, max_raise_to, can_all_in }
    }

    /// Applies the awaited seat's action and runs the hand forward (C# `SubmitAction`). For BET and
    /// RAISE, `amount` is the total the seat's bet becomes this round. Returns the payouts if the
    /// hand ended.
    pub fn act(&mut self, seat: u8, kind: u8, amount: u64, cards: &Cards) -> core::result::Result<Awards, EngineError> {
        if self.is_over() {
            return Err(EngineError::HandOver);
        }
        if seat != self.to_act {
            return Err(EngineError::NotYourTurn);
        }
        let legal = self.legal();
        let i = seat as usize;
        match kind {
            FOLD => {
                self.seats[i].status = FOLDED;
                self.seats[i].has_acted = true;
            }
            CHECK => {
                if !legal.can_check {
                    return Err(EngineError::Illegal);
                }
                self.seats[i].has_acted = true;
            }
            CALL => {
                if !legal.can_call {
                    return Err(EngineError::Illegal);
                }
                self.commit(i, legal.call_amount);
                self.seats[i].has_acted = true;
                if self.seats[i].stack == 0 {
                    self.seats[i].status = ALL_IN;
                }
            }
            BET | RAISE => {
                let allowed = if kind == BET { legal.can_bet } else { legal.can_raise };
                if !allowed || amount < legal.min_raise_to || amount > legal.max_raise_to {
                    return Err(EngineError::Illegal);
                }
                self.wager(i, amount);
            }
            ALL_IN_ACTION => {
                if !legal.can_all_in {
                    return Err(EngineError::Illegal);
                }
                let to = self.seats[i].current_bet + self.seats[i].stack;
                self.wager(i, to);
            }
            _ => return Err(EngineError::Illegal),
        }
        self.current_seat = seat;
        self.to_act = NONE;
        let mut awards = Vec::new();
        self.advance(cards, &mut awards);
        Ok(awards)
    }

    /// The action a timed-out seat gets: check if it can, otherwise fold.
    pub fn timeout_action(&self) -> u8 {
        if self.legal().can_check { CHECK } else { FOLD }
    }

    // ---- core loop (C# Advance) ------------------------------------------------------------

    fn advance(&mut self, cards: &Cards, awards: &mut Awards) {
        loop {
            if self.count_in_hand() <= 1 {
                self.end_uncontested(awards);
                return;
            }
            if self.should_run_out() {
                self.runout = true;
                if !self.advance_street(cards, awards) {
                    return;
                }
                continue;
            }
            if let Some(next) = self.find_next_actor(self.current_seat) {
                self.current_seat = next;
                self.to_act = next;
                return;
            }
            if !self.advance_street(cards, awards) {
                return;
            }
        }
    }

    fn find_next_actor(&self, from: u8) -> Option<u8> {
        let n = self.seat_count as usize;
        (1..=n).map(|i| ((from as usize + i) % n) as u8).find(|&s| self.needs_to_act(s))
    }

    fn needs_to_act(&self, seat: u8) -> bool {
        let p = &self.seats[seat as usize];
        if !p.can_act() {
            return false;
        }
        if p.current_bet < self.high_bet {
            return true;
        }
        if self.runout || self.count_can_act() <= 1 {
            return false;
        }
        !p.has_acted
    }

    fn should_run_out(&self) -> bool {
        if self.seats[..self.seat_count as usize].iter().any(|p| p.can_act() && p.current_bet < self.high_bet) {
            return false;
        }
        self.runout || self.count_can_act() <= 1
    }

    fn advance_street(&mut self, cards: &Cards, awards: &mut Awards) -> bool {
        match self.street {
            PREFLOP => self.deal_community(3, FLOP, cards),
            FLOP => self.deal_community(1, TURN, cards),
            TURN => self.deal_community(1, RIVER, cards),
            RIVER => {
                self.showdown(cards, awards);
                return false;
            }
            _ => return false,
        }
        true
    }

    fn deal_community(&mut self, count: u8, street: u8, cards: &Cards) {
        for _ in 0..count {
            self.board[self.board_len as usize] = cards.board[self.board_len as usize];
            self.board_len += 1;
        }
        self.street = street;
        for p in self.seats.iter_mut() {
            p.current_bet = 0;
            if p.status == ACTIVE {
                p.has_acted = false;
            }
        }
        self.high_bet = 0;
        self.min_raise = self.big_blind;
        self.current_seat = self.button;
    }

    // ---- helpers ------------------------------------------------------------------------------

    fn funded(&self, seat: u8) -> bool {
        let p = &self.seats[seat as usize];
        p.status != EMPTY && p.status != BUSTED && p.stack > 0
    }

    fn next_funded(&self, seat: u8) -> u8 {
        let n = self.seat_count as usize;
        (1..=n).map(|i| ((seat as usize + i) % n) as u8).find(|&s| self.funded(s)).unwrap_or(NONE)
    }

    fn count_in_hand(&self) -> usize {
        self.seats.iter().filter(|p| p.in_hand()).count()
    }

    fn count_can_act(&self) -> usize {
        self.seats.iter().filter(|p| p.can_act()).count()
    }

    fn post_blind(&mut self, seat: u8, amount: u64) {
        let i = seat as usize;
        let post = amount.min(self.seats[i].stack);
        self.commit(i, post);
        if self.seats[i].stack == 0 {
            self.seats[i].status = ALL_IN;
        }
    }

    fn wager(&mut self, i: usize, total_to: u64) {
        let delta = total_to.saturating_sub(self.seats[i].current_bet).min(self.seats[i].stack);
        self.commit(i, delta);
        if self.seats[i].current_bet > self.high_bet {
            let raise = self.seats[i].current_bet - self.high_bet;
            if raise >= self.min_raise {
                self.min_raise = raise; // only a full raise re-sets the minimum
            }
            self.high_bet = self.seats[i].current_bet;
        }
        self.seats[i].has_acted = true;
        if self.seats[i].stack == 0 {
            self.seats[i].status = ALL_IN;
        }
    }

    fn commit(&mut self, i: usize, amount: u64) {
        if amount == 0 {
            return;
        }
        let p = &mut self.seats[i];
        p.stack -= amount;
        p.current_bet += amount;
        p.total += amount;
        self.pot += amount;
        if p.stack == 0 && p.status == ACTIVE {
            p.status = ALL_IN;
        }
    }

    // ---- resolution ---------------------------------------------------------------------------

    fn end_uncontested(&mut self, awards: &mut Awards) {
        if let Some(w) = self.seats.iter().position(|p| p.in_hand()) {
            let amount = self.pot;
            self.pot = 0;
            self.seats[w].stack += amount;
            awards.push((w as u8, amount));
        }
        self.end_hand();
    }

    fn showdown(&mut self, cards: &Cards, awards: &mut Awards) {
        let mut values = [None; N];
        for (i, p) in self.seats.iter().enumerate() {
            if p.in_hand() {
                let mut seven = [0u8; 7];
                seven[..2].copy_from_slice(&cards.holes[i]);
                seven[2..].copy_from_slice(&self.board);
                values[i] = Some(evaluate(&seven));
            }
        }
        for pot in side_pots(&self.seats[..self.seat_count as usize]) {
            self.award_pot(&pot, &values, awards);
        }
        self.pot = 0;
        self.end_hand();
    }

    fn award_pot(&mut self, pot: &Pot, values: &[Option<HandValue>; N], awards: &mut Awards) {
        let mut best: Option<HandValue> = None;
        for &s in pot.eligible.iter() {
            if let (true, Some(v)) = (self.seats[s as usize].in_hand(), values[s as usize]) {
                if best.map_or(true, |b| v > b) {
                    best = Some(v);
                }
            }
        }
        let mut winners: Vec<u8> = match best {
            Some(b) => pot.eligible.iter().copied().filter(|&s| self.seats[s as usize].in_hand() && values[s as usize] == Some(b)).collect(),
            None => pot.eligible.clone(), // refund
        };
        if winners.is_empty() {
            return;
        }
        let share = pot.amount / winners.len() as u64;
        let mut remainder = pot.amount - share * winners.len() as u64;
        // Odd chips go to the first winner to the left of the button.
        let n = self.seat_count as usize;
        let order = |s: u8| (s as usize + 2 * n - self.button as usize - 1) % n;
        winners.sort_by_key(|&s| order(s));
        for s in winners {
            let mut award = share;
            if remainder > 0 {
                award += 1;
                remainder -= 1;
            }
            self.seats[s as usize].stack += award;
            awards.push((s, award));
        }
    }

    fn end_hand(&mut self) {
        self.to_act = NONE;
        self.street = DONE;
        for p in self.seats.iter_mut() {
            if p.status != EMPTY && p.stack == 0 {
                p.status = BUSTED;
            }
        }
    }
}

// ---- side pots (C# SidePotCalculator) --------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct Pot {
    pub amount: u64,
    pub eligible: Vec<u8>,
}

/// Main pot plus side pots, layered by each distinct contribution level. Folded players' chips stay
/// in the pots they reached but they can't win; a layer only folded players reached is refunded.
pub fn side_pots(seats: &[GameSeat]) -> Vec<Pot> {
    let mut levels: Vec<u64> = seats.iter().map(|p| p.total).filter(|&t| t > 0).collect();
    levels.sort_unstable();
    levels.dedup();
    let mut pots = Vec::new();
    let mut prev = 0;
    for level in levels {
        let layer = level - prev;
        let mut pot = Pot { amount: 0, eligible: Vec::new() };
        let mut refund = Vec::new();
        for (i, p) in seats.iter().enumerate() {
            if p.total < level {
                continue;
            }
            pot.amount += layer;
            refund.push(i as u8);
            if p.in_hand() {
                pot.eligible.push(i as u8);
            }
        }
        if pot.amount > 0 {
            if pot.eligible.is_empty() {
                pot.eligible = refund;
            }
            pots.push(pot);
        }
        prev = level;
    }
    pots
}

// ---- hand evaluation (C# HandEvaluator) -------------------------------------------------------

/// Category (0 high card .. 8 straight flush) then up to five tiebreak ranks (2..14), most
/// significant first. Comparing two values compares hands; equal values split the pot.
pub type HandValue = [u8; 6];

const HIGH_CARD: u8 = 0;
const PAIR: u8 = 1;
const TWO_PAIR: u8 = 2;
const TRIPS: u8 = 3;
const STRAIGHT: u8 = 4;
const FLUSH: u8 = 5;
const FULL_HOUSE: u8 = 6;
const QUADS: u8 = 7;
const STRAIGHT_FLUSH: u8 = 8;

fn rank(card: u8) -> usize {
    (card % 13) as usize + 2
}

/// Best five-card hand out of 5 to 7 cards (every combination, as the C# engine does).
pub fn evaluate(cards: &[u8]) -> HandValue {
    let n = cards.len();
    assert!((5..=7).contains(&n));
    let mut best = [0u8; 6];
    let mut first = true;
    for a in 0..n - 4 {
        for b in a + 1..n - 3 {
            for c in b + 1..n - 2 {
                for d in c + 1..n - 1 {
                    for e in d + 1..n {
                        let v = evaluate5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
                        if first || v > best {
                            best = v;
                            first = false;
                        }
                    }
                }
            }
        }
    }
    best
}

fn evaluate5(cards: [u8; 5]) -> HandValue {
    let mut ranks = [0u8; 15];
    let mut suits = [0u8; 4];
    for c in cards {
        ranks[rank(c)] += 1;
        suits[(c / 13) as usize] += 1;
    }
    let flush = suits.iter().any(|&s| s == 5);
    let straight = straight_high(&ranks);
    // Distinct ranks grouped, sorted by count desc then rank desc.
    let mut groups: [(u8, u8); 5] = [(0, 0); 5]; // (count, rank)
    let mut g = 0;
    for r in (2..=14).rev() {
        if ranks[r] > 0 {
            groups[g] = (ranks[r], r as u8);
            g += 1;
        }
    }
    groups[..g].sort_by(|x, y| y.cmp(x));
    let r = |i: usize| if i < g { groups[i].1 } else { 0 };
    let (c0, c1) = (groups[0].0, if g > 1 { groups[1].0 } else { 0 });
    if straight != 0 && flush {
        return [STRAIGHT_FLUSH, straight, 0, 0, 0, 0];
    }
    if c0 == 4 {
        return [QUADS, r(0), r(1), 0, 0, 0];
    }
    if c0 == 3 && c1 == 2 {
        return [FULL_HOUSE, r(0), r(1), 0, 0, 0];
    }
    if flush {
        return [FLUSH, r(0), r(1), r(2), r(3), r(4)];
    }
    if straight != 0 {
        return [STRAIGHT, straight, 0, 0, 0, 0];
    }
    if c0 == 3 {
        return [TRIPS, r(0), r(1), r(2), 0, 0];
    }
    if c0 == 2 && c1 == 2 {
        return [TWO_PAIR, r(0), r(1), r(2), 0, 0];
    }
    if c0 == 2 {
        return [PAIR, r(0), r(1), r(2), r(3), 0];
    }
    [HIGH_CARD, r(0), r(1), r(2), r(3), r(4)]
}

/// Highest card of five in a row, 5 for the A-2-3-4-5 wheel, 0 for none.
fn straight_high(ranks: &[u8; 15]) -> u8 {
    for high in (6..=14).rev() {
        if (high - 4..=high).all(|r| ranks[r] > 0) {
            return high as u8;
        }
    }
    if ranks[14] > 0 && (2..=5).all(|r| ranks[r] > 0) {
        return 5;
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn golden(name: &str) -> Value {
        let path = format!("{}/tests/golden/{name}", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn evaluator_matches_csharp() {
        let cases = golden("eval.json");
        let mut n = 0;
        for c in cases.as_array().unwrap() {
            let cards: Vec<u8> = c[0].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect();
            let want: Vec<u8> = c[1].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect();
            assert_eq!(evaluate(&cards).to_vec(), want, "cards {cards:?}");
            n += 1;
        }
        println!("GOLDEN eval cases={n} all match");
    }

    #[test]
    fn side_pots_match_csharp() {
        let cases = golden("pots.json");
        let mut n = 0;
        for c in cases.as_array().unwrap() {
            let seats: Vec<GameSeat> = c["seats"].as_array().unwrap().iter().map(|s| {
                let status = match s[0].as_u64().unwrap() { 0 => EMPTY, 2 => ACTIVE, 3 => FOLDED, 4 => ALL_IN, x => x as u8 };
                GameSeat { status, total: s[1].as_u64().unwrap(), ..Default::default() }
            }).collect();
            let want: Vec<Pot> = c["pots"].as_array().unwrap().iter().map(|p| Pot {
                amount: p[0].as_u64().unwrap(),
                eligible: p[1].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect(),
            }).collect();
            assert_eq!(side_pots(&seats), want, "case {n}");
            n += 1;
        }
        println!("GOLDEN pot cases={n} all match");
    }

    #[test]
    fn whole_hands_match_csharp() {
        let hands = golden("hands.json");
        let (mut n, mut steps) = (0, 0);
        for h in hands.as_array().unwrap() {
            let seat_count = h["seatCount"].as_u64().unwrap() as u8;
            let before: Vec<i64> = h["before"].as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect();
            let mut stacks = [None; N];
            for (i, b) in before.iter().enumerate() {
                if *b > 0 {
                    stacks[i] = Some(*b as u64);
                }
            }
            let mut cards = Cards { holes: [[0; 2]; N], board: [0; 5] };
            for (i, hc) in h["holes"].as_array().unwrap().iter().enumerate() {
                if let Some(a) = hc.as_array() {
                    cards.holes[i] = [a[0].as_u64().unwrap() as u8, a[1].as_u64().unwrap() as u8];
                }
            }
            for (i, c) in h["board"].as_array().unwrap().iter().enumerate() {
                cards.board[i] = c.as_u64().unwrap() as u8;
            }
            let button = h["button"].as_u64().unwrap() as u8;
            let (mut g, mut awards) = Game::start(seat_count, h["sb"].as_u64().unwrap(), h["bb"].as_u64().unwrap(), stacks, button, &cards).unwrap();
            assert_eq!((g.sb_seat as u64, g.bb_seat as u64), (h["sbSeat"].as_u64().unwrap(), h["bbSeat"].as_u64().unwrap()), "hand {n} blinds");
            for st in h["steps"].as_array().unwrap() {
                let v: Vec<i64> = st.as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect();
                assert_eq!(g.to_act as i64, v[0], "hand {n} step {steps}: who acts");
                let want = Legal {
                    can_fold: v[1] == 1, can_check: v[2] == 1, can_call: v[3] == 1, call_amount: v[4] as u64, can_bet: v[5] == 1,
                    can_raise: v[6] == 1, min_raise_to: v[7] as u64, max_raise_to: v[8] as u64, can_all_in: v[9] == 1,
                };
                assert_eq!(g.legal(), want, "hand {n} step {steps}: legal actions");
                awards = g.act(v[0] as u8, v[10] as u8, v[11] as u64, &cards).unwrap();
                steps += 1;
            }
            assert!(g.is_over(), "hand {n} should be over");
            let want_awards: Vec<(u8, u64)> = h["awards"].as_array().unwrap().iter().map(|a| (a[0].as_u64().unwrap() as u8, a[1].as_u64().unwrap())).collect();
            assert_eq!(awards, want_awards, "hand {n}: awards");
            for (i, a) in h["after"].as_array().unwrap().iter().enumerate() {
                if before[i] > 0 {
                    assert_eq!(g.seats[i].stack as i64, a.as_i64().unwrap(), "hand {n} seat {i}: final stack");
                }
            }
            assert_eq!(g.board_len as usize, h["board"].as_array().unwrap().len(), "hand {n}: board dealt");
            n += 1;
        }
        println!("GOLDEN hands={n} actions={steps} all match");
    }
}
