import assert from "node:assert/strict";
import { test } from "node:test";
import { coach } from "../src/strategies/coach.js";
import { settleCopy } from "../src/strategies/fees.js";
import { clampProfile, PRESETS, type Profile } from "../src/strategies/profile.js";
import { fitTwin, matchRate, type Decision } from "../src/strategies/style.js";

// ------------------------------------------------------------------ fees

test("profit share: 8% creator, 2% platform, nothing on a loss", () => {
  const s = settleCopy({ cumulativePnl: 0, highWater: 0 }, 1000);
  assert.deepEqual([s.feeBase, s.creatorFee, s.platformFee, s.copierKeeps], [1000, 80, 20, 900]);
  const l = settleCopy({ cumulativePnl: 0, highWater: 0 }, -500);
  assert.deepEqual([l.feeBase, l.creatorFee, l.platformFee, l.copierKeeps], [0, 0, 0, -500]);
});

test("high-water mark: winning back a loss is free, only new profit pays", () => {
  let pos = { cumulativePnl: 0, highWater: 0 };
  const a = settleCopy(pos, 1000); pos = a.next;          // +1000: fees on 1000
  const b = settleCopy(pos, -400); pos = b.next;          // 600, peak 1000
  const c = settleCopy(pos, 400); pos = c.next;           // back to 1000: no fee
  const d = settleCopy(pos, 250); pos = d.next;           // 1250: fees on 250
  assert.deepEqual([a.feeBase, b.feeBase, c.feeBase, d.feeBase], [1000, 0, 0, 250]);
  assert.deepEqual(pos, { cumulativePnl: 1250, highWater: 1250 });
});

test("fees never exceed the session's profit and always add up", () => {
  let seed = 11;
  const next = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  let pos = { cumulativePnl: 0, highWater: 0 };
  for (let i = 0; i < 5000; i++) {
    const pnl = next(20_001) - 10_000;
    const s = settleCopy(pos, pnl);
    assert.ok(s.creatorFee >= 0 && s.platformFee >= 0);
    assert.ok(s.creatorFee + s.platformFee <= Math.max(0, pnl));
    assert.equal(s.copierKeeps + s.creatorFee + s.platformFee, pnl);
    assert.ok(s.next.highWater >= pos.highWater);
    pos = s.next;
  }
});

test("profiles reject non-numbers and clamp to the bot's limits", () => {
  assert.throws(() => clampProfile({ ...PRESETS.tactician, aggression: Number.NaN }));
  assert.equal(clampProfile({ ...PRESETS.tactician, bluffChance: 0.9 }).bluffChance, 0.25);
});

// ------------------------------------------------------------------ twin

/** HeuristicBot.Decide (Assets/Scripts/Bots/HeuristicBot.cs), without the per-decision strength noise. */
function bot(p: Profile, s: number, toCall: number, pot: number, rnd: () => number): Decision["action"] {
  if (toCall <= 0) return (s >= p.raiseAbove && rnd() < p.aggression) || rnd() < p.bluffChance ? "bet" : "check";
  if (s >= p.raiseAbove) return rnd() < p.aggression ? "raise" : "call";
  if (rnd() < p.bluffChance) return "raise";
  if (s >= toCall / (pot + toCall) || s >= 0.5) return "call";
  return s < p.foldBelow ? "fold" : "call";
}

function simulate(p: Profile, n: number, seed = 5): Decision[] {
  let x = seed;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out: Decision[] = [];
  for (let i = 0; i < n; i++) {
    const strength = rnd(), pot = 100 + Math.floor(rnd() * 900);
    const toCall = rnd() < 0.4 ? 0 : Math.floor(pot * (0.2 + rnd() * 0.8));
    const action = bot(p, strength, toCall, pot, rnd);
    const minRaiseTo = toCall * 2 || 20;
    const amount = action === "bet" || action === "raise" ? Math.round(minRaiseTo + (pot + toCall) * p.raiseFractionOfPot) : 0;
    out.push({ street: i % 4, position: i % 6, opponents: 2, strength, pot, toCall, minRaiseTo, bigBlind: 20, action, amount });
  }
  return out;
}

test("the twin recovers the profile that produced the decisions", () => {
  for (const name of ["guardian", "daredevil"]) {
    const truth = PRESETS[name];
    const twin = fitTwin(simulate(truth, 4000));
    assert.ok(twin.confidence > 0.95);
    assert.ok(Math.abs(twin.profile.raiseAbove - truth.raiseAbove) < 0.05, `${name} raiseAbove ${twin.profile.raiseAbove}`);
    assert.ok(Math.abs(twin.profile.aggression - truth.aggression) < 0.08, `${name} aggression ${twin.profile.aggression}`);
    assert.ok(Math.abs(twin.profile.bluffChance - truth.bluffChance) < 0.03, `${name} bluff ${twin.profile.bluffChance}`);
    assert.ok(Math.abs(twin.profile.foldBelow - truth.foldBelow) < 0.05, `${name} foldBelow ${twin.profile.foldBelow}`);
    assert.ok(Math.abs(twin.profile.raiseFractionOfPot - truth.raiseFractionOfPot) < 0.05, `${name} size ${twin.profile.raiseFractionOfPot}`);
    assert.ok((twin.matchRate ?? 0) > 0.75, `${name} match ${twin.matchRate}`);
  }
});

test("with few decisions the twin stays close to the prior", () => {
  const twin = fitTwin(simulate(PRESETS.daredevil, 15));
  assert.ok(twin.confidence < 0.15);
  assert.ok(Math.abs(twin.profile.raiseAbove - PRESETS.tactician.raiseAbove) < 0.03);
  assert.equal(twin.matchRate, null);
});

test("a fitted twin matches its own player better than a different preset does", () => {
  const ds = simulate(PRESETS.daredevil, 3000, 9);
  const twin = fitTwin(ds);
  assert.ok(matchRate(twin.profile, ds) > matchRate(PRESETS.guardian, ds));
});

// ------------------------------------------------------------------ coaching

test("coaching finds loose calls and reports what works", () => {
  const ds: Decision[] = [];
  for (let i = 0; i < 30; i++) ds.push({ street: 1, position: 3, opponents: 2, strength: 0.15, pot: 100, toCall: 80, minRaiseTo: 160, bigBlind: 10, action: "call", amount: 0 });
  for (let i = 0; i < 20; i++) ds.push({ street: 2, position: 0, opponents: 1, strength: 0.9, pot: 200, toCall: 0, minRaiseTo: 20, bigBlind: 10, action: "bet", amount: 150 });
  const hands = Array.from({ length: 40 }, (_, i) => ({ table: "t", handNo: i, position: i % 6, bigBlind: 10, net: i % 2 ? 50 : -30, showdown: i % 3 === 0, won: i % 6 === 0 }));
  const r = coach(ds, hands);
  assert.equal(r.notWorking[0].id, "loose_calls");
  assert.ok(r.notWorking[0].cost === 30 * 80);
  assert.ok(r.working.some((w) => w.includes("strong hands")));
  assert.ok(r.summary.includes("Try next"));
});
