// Agents v2 phase 2 (docs/AGENTS_V2.md): the better brain. Old profiles play exactly as before; position, per-street
// numbers and brain 2 (equity, pot odds, stack-to-pot ratio) change play only when a profile asks for them; brain 2
// beats the classic brain heads-up. Run: node --import tsx test/brain.test.ts
import assert from "node:assert/strict";
import { category, clampProfile, decide, Decision, equity, Game, handValue, legal, PRESETS, Profile, strength } from "../src/agentBot";
import { match, seeded } from "./headsUp";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("PASS ", name); };
const c = (rank: string, suit: string) => "23456789TJQKA".indexOf(rank) + 13 * "cdhs".indexOf(suit);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** decide() exactly as it was before phase 2 (git 49368e9d), to prove old profiles play the same. */
function legacyDecide(p: Profile, hole: number[], board: number[], g: Game, opponents: number, rnd: () => number): Decision {
  const l = legal(g)!;
  let s = strength(hole, board);
  s -= 0.03 * Math.max(0, opponents - 1);
  s += (rnd() - 0.5) * 0.06;
  s = clamp(s, 0, 1);
  const toCall = l.callAmount;
  const size = (): bigint => {
    const potBasis = Number(g.pot + toCall);
    const fraction = p.raiseFractionOfPot * (1 + (rnd() - 0.5) * 0.24);
    let target = Number(l.minRaiseTo) + potBasis * fraction;
    const bb = Number(g.bigBlind);
    if (bb > 0) { const r = Math.round(target / bb) * bb; if (r > 0) target = r; }
    let t = BigInt(Math.floor(target));
    if (t < l.minRaiseTo) t = l.minRaiseTo;
    if (t > l.maxRaiseTo) t = l.maxRaiseTo;
    return t;
  };
  if (toCall <= 0n) {
    const valueBet = s >= p.raiseAbove && rnd() < p.aggression;
    const bluff = rnd() < p.bluffChance;
    if (l.canBet && (valueBet || bluff)) return { kind: "bet", amount: size() };
    return { kind: "check", amount: 0n };
  }
  const potOdds = Number(toCall) / Number(g.pot + toCall);
  if (s >= p.raiseAbove) {
    if (l.canRaise && rnd() < p.aggression) return { kind: "raise", amount: size() };
    if (l.canCall) return { kind: "call", amount: 0n };
  }
  if (l.canRaise && rnd() < p.bluffChance) return { kind: "raise", amount: size() };
  const worthCalling = s >= potOdds || s >= 0.5;
  if (worthCalling && l.canCall) return { kind: "call", amount: 0n };
  if (s < p.foldBelow) return { kind: "fold", amount: 0n };
  return l.canCall ? { kind: "call", amount: 0n } : { kind: "fold", amount: 0n };
}

/** A random legal spot: 2..6 seats, any street, a bet to face or not, the button anywhere. */
function randomSpot(r: () => number) {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 0; i < 7; i++) { const j = i + Math.floor(r() * (52 - i)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  const boardLen = [0, 3, 4, 5][Math.floor(r() * 4)];
  const seatCount = 2 + Math.floor(r() * 5);
  const seats = Array.from({ length: seatCount }, () => ({ status: 2, stack: BigInt(100 + Math.floor(r() * 3000)), currentBet: 0n }));
  const toAct = Math.floor(r() * seatCount);
  const highBet = r() < 0.4 ? 0n : BigInt(20 + Math.floor(r() * 600));
  seats[(toAct + 1) % seatCount].currentBet = highBet;
  const g: Game = {
    seatCount, seats, button: Math.floor(r() * seatCount), toAct, highBet, minRaise: 20n, pot: highBet + BigInt(30 + Math.floor(r() * 900)),
    runout: false, board: deck.slice(2, 2 + boardLen), boardLen, bigBlind: 20n, street: 0,
  };
  return { hole: deck.slice(0, 2), board: g.board, g, opponents: 1 + Math.floor(r() * (seatCount - 1)) };
}

const show = (d: Decision) => `${d.kind} ${d.amount}`;

t("old five-number profiles play exactly as before (same choices, same amounts, same random draws)", () => {
  const r = seeded(42);
  const profiles: Profile[] = [...Object.values(PRESETS)];
  for (let i = 0; i < 40; i++) profiles.push(clampProfile({ foldBelow: r(), raiseAbove: r(), aggression: r(), bluffChance: r() * 0.3, raiseFractionOfPot: r() * 1.3 }));
  for (let i = 0; i < 20000; i++) {
    const p = profiles[i % profiles.length];
    const s = randomSpot(r);
    let calls1 = 0, calls2 = 0;
    const seed = 1000 + i;
    const r1 = seeded(seed), r2 = seeded(seed);
    const a = legacyDecide(p, s.hole, s.board, s.g, s.opponents, () => (calls1++, r1()));
    const b = decide(p, s.hole, s.board, s.g, s.opponents, () => (calls2++, r2()));
    assert.equal(show(b), show(a), `spot ${i}`);
    assert.equal(calls2, calls1, `random draws at spot ${i}`);
  }
});

t("handValue: categories agree with category(), and kickers order hands within a category", () => {
  const r = seeded(7);
  for (let i = 0; i < 20000; i++) {
    const deck = Array.from({ length: 52 }, (_, k) => k);
    for (let k = 0; k < 7; k++) { const j = k + Math.floor(r() * (52 - k)); [deck[k], deck[j]] = [deck[j], deck[k]]; }
    const cards = deck.slice(0, 5 + (i % 3));
    assert.equal(Math.floor(handValue(cards) / 16 ** 5), category(cards).cat, cards.join(","));
  }
  const v = (s: string) => handValue(s.split(" ").map((x) => c(x[0], x[1])));
  assert.ok(v("As Ad Kc 7h 2s 3d 4c") > v("Ah Ac Qc 7h 2s 3d 4c"), "pair of aces, king kicker beats queen kicker");
  assert.ok(v("Ks Kd 7c 7h 2s") > v("Qs Qd Jc Jh As"), "two pair: kings up beats queens up");
  assert.ok(v("Ah 2d 3c 4h 5s") < v("2h 3d 4c 5h 6s"), "the wheel is the lowest straight");
  assert.ok(v("As Kd 9c 7h 5s 3d 2c") < v("Ad Kc 9h 7s 6d 4c 2h"), "high card: the fifth card decides");
  assert.equal(v("7s 7d 7c 4h 4s 4d 2c"), v("7h 7d 7c 4c 4s Ac 2c"), "full house from two sets of trips: sevens full of fours");
  assert.ok(v("2h 3h 4h 5h 6h Ah Kh") > v("Ah Kh Qh Jh 9h 2c 3c"), "a straight flush beats the ace-high flush in the same suit");
  assert.equal(v("9h 9d 9c 9s Ah 2d 3c"), v("9h 9d 9c 9s Ad Kd Kc"), "quads: only the best kicker counts");
});

t("equity: aces ~85% heads-up, 72o ~35%, a made flush on the river near 100% against one hand", () => {
  const r = seeded(3);
  const aa = equity([c("A", "s"), c("A", "h")], [], 1, r, 4000);
  const trash = equity([c("7", "s"), c("2", "h")], [], 1, r, 4000);
  const aaThree = equity([c("A", "s"), c("A", "h")], [], 3, r, 4000);
  assert.ok(Math.abs(aa - 0.85) < 0.03, `AA ${aa}`);
  assert.ok(Math.abs(trash - 0.35) < 0.03, `72o ${trash}`);
  assert.ok(Math.abs(aaThree - 0.64) < 0.04, `AA vs 3 ${aaThree}`);
  const nuts = equity([c("A", "h"), c("K", "h")], [c("2", "h"), c("7", "h"), c("9", "h"), c("J", "c"), c("3", "d")], 1, r, 2000);
  assert.ok(nuts > 0.97, `nut flush ${nuts}`);
});

const spot = (over: Partial<Game> = {}): Game => ({
  seatCount: 6, seats: Array.from({ length: 6 }, () => ({ status: 2, stack: 2000n, currentBet: 0n })), button: 0, toAct: 0,
  highBet: 0n, minRaise: 20n, pot: 30n, runout: false, board: [], boardLen: 0, bigBlind: 20n, street: 0, ...over,
});
/** Share of `trials` decisions that are of one of `kinds`. */
function rate(p: Profile, hole: number[], board: number[], g: Game, opponents: number, kinds: Decision["kind"][], trials = 3000) {
  const r = seeded(99);
  let hits = 0;
  for (let i = 0; i < trials; i++) if (kinds.includes(decide(p, hole, board, g, opponents, r).kind)) hits++;
  return hits / trials;
}

t("positionWeight: looser and more aggressive on the button than under the gun, and only when set", () => {
  const p: Profile = { ...PRESETS.balanced, positionWeight: 1 };
  const hole = [c("Q", "s"), c("6", "d")]; // a hand near the folding line (strength ~0.32)
  const facing = (button: number) => spot({ button, toAct: 3, highBet: 60n, pot: 90n, seats: spot().seats.map((s, i) => (i === 4 ? { ...s, currentBet: 60n } : s)) });
  // Button: seat 3 is the button (position 0). Early: the button three seats on (position 3 of 3 opponents).
  const foldLate = rate(p, hole, [], facing(3), 3, ["fold"]), foldEarly = rate(p, hole, [], facing(0), 3, ["fold"]);
  assert.ok(foldEarly > foldLate + 0.3, `fold early ${foldEarly} vs late ${foldLate}`);
  const betLate = rate(p, [c("9", "s"), c("4", "d")], [], spot({ button: 3, toAct: 3 }), 3, ["bet"]);
  const betEarly = rate(p, [c("9", "s"), c("4", "d")], [], spot({ button: 0, toAct: 3 }), 3, ["bet"]);
  assert.ok(betLate > betEarly * 1.8, `bluffs late ${betLate} vs early ${betEarly}`);
  // positionWeight 0: identical wherever the button is.
  assert.equal(rate(PRESETS.balanced, hole, [], facing(3), 3, ["fold"]), rate(PRESETS.balanced, hole, [], facing(0), 3, ["fold"]));
});

t("per-street numbers: a river override changes river play only", () => {
  const p: Profile = { ...PRESETS.balanced, streets: { river: { bluffChance: 0.25 } } };
  const hole = [c("9", "s"), c("4", "d")];
  const flop = [c("2", "c"), c("7", "h"), c("K", "d")], river = [...flop, c("J", "s"), c("3", "h")];
  assert.equal(rate(p, hole, flop, spot({ board: flop, boardLen: 3 }), 1, ["bet"]), rate(PRESETS.balanced, hole, flop, spot({ board: flop, boardLen: 3 }), 1, ["bet"]));
  const riverBluffs = rate(p, hole, river, spot({ board: river, boardLen: 5 }), 1, ["bet"]);
  assert.ok(riverBluffs > 0.2, `river bluffs ${riverBluffs}`);
});

t("clampProfile keeps valid v2 fields and drops broken ones", () => {
  const p = clampProfile({ ...PRESETS.balanced, positionWeight: 3, brain: 2, streets: { flop: { aggression: 2 }, turn: undefined } });
  assert.equal(p.positionWeight, 1);
  assert.equal(p.brain, 2);
  assert.deepEqual(p.streets, { flop: { ...PRESETS.balanced, aggression: 0.95 } });
  assert.deepEqual(Object.keys(clampProfile({ ...PRESETS.balanced, brain: 7, positionWeight: Number.NaN })).sort(), Object.keys(PRESETS.balanced).sort());
});

t("brain 2: folds bottom pair to an all-in the classic brain calls, and calls a fair bet with a flush draw", () => {
  const board = [c("K", "h"), c("9", "h"), c("3", "c")];
  const shove = spot({ seatCount: 2, seats: [{ status: 2, stack: 1800n, currentBet: 0n }, { status: 4, stack: 0n, currentBet: 1800n }], highBet: 1800n, pot: 2000n, board, boardLen: 3 });
  const bottomPair = [c("3", "s"), c("5", "d")];
  assert.equal(rate(PRESETS.balanced, bottomPair, board, shove, 1, ["call"]), 1, "classic calls it off");
  assert.ok(rate({ ...PRESETS.balanced, brain: 2 }, bottomPair, board, shove, 1, ["fold"], 300) > 0.95, "brain 2 folds");
  // A 60%-of-pot bet: the draw has the odds (about 45% equity against 27% pot odds), the classic brain's 0.17 doesn't.
  const small = spot({ seatCount: 2, seats: [{ status: 2, stack: 1900n, currentBet: 0n }, { status: 2, stack: 1780n, currentBet: 120n }], highBet: 120n, pot: 320n, board, boardLen: 3 });
  const draw = [c("Q", "h"), c("8", "h")];
  assert.ok(rate(PRESETS.balanced, draw, board, small, 1, ["fold"]) > 0.9, "classic folds a draw (no pair), bar its bluff-raises");
  assert.ok(rate({ ...PRESETS.balanced, brain: 2 }, draw, board, small, 1, ["call", "raise"], 300) > 0.95, "brain 2 continues");
});

t("brain 2 never makes an illegal move", () => {
  const r = seeded(5);
  for (let i = 0; i < 3000; i++) {
    const s = randomSpot(r);
    const l = legal(s.g)!;
    const d = decide({ ...PRESETS.aggressive, brain: 2, positionWeight: 0.7 }, s.hole, s.board, s.g, s.opponents, r);
    if (d.kind === "bet") assert.ok(l.canBet && d.amount >= l.minRaiseTo && d.amount <= l.maxRaiseTo, show(d));
    if (d.kind === "raise") assert.ok(l.canRaise && d.amount >= l.minRaiseTo && d.amount <= l.maxRaiseTo, show(d));
    if (d.kind === "check") assert.ok(l.canCheck);
    if (d.kind === "call") assert.ok(l.canCall);
  }
});

// Heads-up, duplicate format (each deal twice with the seats swapped), 100 big blinds deep, seeded.
const DEALS = Number(process.env.BRAIN_DEALS ?? 3000);
t(`brain 2 beats the classic brain heads-up with the same five numbers (${DEALS * 2} hands per preset)`, () => {
  for (const name of Object.keys(PRESETS)) {
    const r = match({ ...PRESETS[name], brain: 2 }, PRESETS[name], DEALS, 17);
    console.log(`      ${name}: brain 2 ${r.bbPer100 >= 0 ? "+" : ""}${r.bbPer100.toFixed(1)} bb/100 ± ${r.stdErr.toFixed(1)} over ${r.hands} hands`);
    assert.ok(r.bbPer100 > 2 * r.stdErr, `${name}: ${r.bbPer100} ± ${r.stdErr}`);
  }
});

t("brain 2 (Tactician numbers) beats every classic preset heads-up", () => {
  for (const name of Object.keys(PRESETS)) {
    const r = match({ ...PRESETS.balanced, brain: 2, positionWeight: 0.5 }, PRESETS[name], DEALS, 23);
    console.log(`      vs classic ${name}: ${r.bbPer100 >= 0 ? "+" : ""}${r.bbPer100.toFixed(1)} bb/100 ± ${r.stdErr.toFixed(1)}`);
    assert.ok(r.bbPer100 > 2 * r.stdErr, `vs ${name}: ${r.bbPer100} ± ${r.stdErr}`);
  }
});

console.log(`${n} passed`);
