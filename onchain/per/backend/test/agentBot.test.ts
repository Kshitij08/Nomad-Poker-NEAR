// M12b: the Agent's bot (agentBot.ts), against hand-made positions. Run: node --import tsx test/agentBot.test.ts
import assert from "node:assert/strict";
import { category, decide, legal, preflop, PRESETS, clampProfile, Game, headsUpEquivalent } from "../src/agentBot";

// Cards: rank = c % 13 (0 = two .. 12 = ace), suit = c / 13.
const c = (rank: string, suit: string) => "23456789TJQKA".indexOf(rank) + 13 * "cdhs".indexOf(suit);
let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("PASS ", name); };

t("categories: high card .. straight flush, wheel straights", () => {
  assert.equal(category([c("A", "s"), c("K", "d"), c("7", "c"), c("4", "h"), c("2", "s")]).cat, 0);
  assert.equal(category([c("A", "s"), c("A", "d"), c("7", "c"), c("4", "h"), c("2", "s")]).cat, 1);
  assert.equal(category([c("A", "s"), c("A", "d"), c("7", "c"), c("7", "h"), c("2", "s")]).cat, 2);
  assert.equal(category([c("7", "s"), c("7", "d"), c("7", "c"), c("4", "h"), c("2", "s")]).cat, 3);
  assert.deepEqual(category([c("A", "s"), c("2", "d"), c("3", "c"), c("4", "h"), c("5", "s"), c("K", "c")]), { cat: 4, top: 5 });
  assert.equal(category([c("A", "s"), c("9", "s"), c("7", "s"), c("4", "s"), c("2", "s")]).cat, 5);
  assert.equal(category([c("7", "s"), c("7", "d"), c("7", "c"), c("4", "h"), c("4", "s")]).cat, 6);
  assert.equal(category([c("7", "s"), c("7", "d"), c("7", "c"), c("7", "h"), c("4", "s")]).cat, 7);
  assert.deepEqual(category([c("9", "h"), c("T", "h"), c("J", "h"), c("Q", "h"), c("K", "h"), c("2", "c"), c("3", "d")]), { cat: 8, top: 13 });
});
t("preflop: aces 1.0, deuces 0.5, 72 offsuit weak", () => {
  assert.equal(preflop(c("A", "s"), c("A", "h")), 1);
  assert.equal(preflop(c("2", "s"), c("2", "h")), 0.5);
  assert.ok(preflop(c("7", "s"), c("2", "h")) < 0.2);
});
const seat = (status: number, stack: bigint, bet: bigint) => ({ status, stack, currentBet: bet });
const game = (over: Partial<Game>): Game => ({
  seatCount: 3, seats: [seat(2, 1000n, 0n), seat(2, 1000n, 0n), seat(2, 1000n, 0n)], toAct: 0, highBet: 0n, minRaise: 20n, pot: 30n, runout: false, board: [], boardLen: 0, bigBlind: 20n, street: 1, ...over,
});
t("legal: facing a bet, call / raise; no bet to face, check / bet", () => {
  const facing = legal(game({ highBet: 20n }))!;
  assert.equal(facing.canCheck, false); assert.equal(facing.canCall, true); assert.equal(facing.callAmount, 20n); assert.equal(facing.canRaise, true); assert.equal(facing.minRaiseTo, 40n);
  const open = legal(game({}))!;
  assert.equal(open.canCheck, true); assert.equal(open.canBet, true);
  const short = legal(game({ highBet: 2000n, seats: [seat(2, 500n, 0n), seat(2, 1000n, 2000n), seat(3, 0n, 0n)] }))!;
  assert.equal(short.callAmount, 500n); assert.equal(short.canRaise, false);
});
t("decide: aces raise or call; 72o folds to a big bet; never an illegal amount", () => {
  const rnd = () => 0.01; // always "rolls" aggressive/bluffy
  const aces = decide(PRESETS.aggressive, [c("A", "s"), c("A", "h")], [], game({ highBet: 20n }), 2, rnd);
  assert.ok(aces.kind === "raise" && aces.amount >= 40n && aces.amount <= 1000n, JSON.stringify(aces, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  const trash = decide(PRESETS.conservative, [c("7", "s"), c("2", "h")], [], game({ highBet: 800n, pot: 830n }), 2, () => 0.99);
  assert.equal(trash.kind, "fold");
  for (let i = 0; i < 2000; i++) {
    const g = game({ highBet: BigInt(Math.floor(Math.random() * 300)), pot: BigInt(30 + Math.floor(Math.random() * 500)) });
    const d = decide(PRESETS.balanced, [Math.floor(Math.random() * 26), 26 + Math.floor(Math.random() * 26)], [], g, 2);
    const l = legal(g)!;
    if (d.kind === "bet") assert.ok(l.canBet && d.amount >= l.minRaiseTo && d.amount <= l.maxRaiseTo);
    if (d.kind === "raise") assert.ok(l.canRaise && d.amount >= l.minRaiseTo && d.amount <= l.maxRaiseTo);
    if (d.kind === "check") assert.ok(l.canCheck);
    if (d.kind === "call") assert.ok(l.canCall);
  }
});
t("custom profiles are clamped to the legal range", () => {
  const p = clampProfile({ foldBelow: 5, raiseAbove: -1, aggression: 2, bluffChance: 1, raiseFractionOfPot: 9 });
  assert.deepEqual(p, { foldBelow: 0.55, raiseAbove: 0.45, aggression: 0.95, bluffChance: 0.25, raiseFractionOfPot: 1.2 });
});
t("table size: an equity against n opponents maps to the heads-up equity at the same percentile of hands", () => {
  assert.equal(headsUpEquivalent(0.4, 1), 0.4);
  // The median starting hand against 4 opponents (0.187) is the heads-up median (0.500); aces stay the best.
  assert.ok(Math.abs(headsUpEquivalent(0.187, 4) - 0.5) < 1e-9);
  assert.ok(Math.abs(headsUpEquivalent(0.561, 4) - 0.854) < 1e-9);
  let prev = -1;
  for (let k = 0; k <= 100; k++) { const h = headsUpEquivalent(k / 100, 7); assert.ok(h >= prev - 1e-12 && h >= 0 && h <= 1); prev = h; }
  assert.equal(headsUpEquivalent(1, 7), 1);
});
console.log(`${n} passed`);
