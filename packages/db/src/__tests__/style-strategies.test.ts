import assert from "node:assert/strict";
import { test } from "vitest";
import { coach } from "../style/coach";
import { settleCopy } from "../style/fees";
import { clampProfile, effective, lateness, PRESETS, type Profile } from "../style/profile";
import { fitTwin, matchRate, type Decision } from "../style/style";

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

/** HeuristicBot.Decide (Assets/Scripts/Bots/HeuristicBot.cs), classic brain, without the per-decision strength noise. */
function bot(profile: Profile, s: number, toCall: number, pot: number, street: number, late: number, rnd: () => number): Decision["action"] {
  const p = effective(profile, street, late);
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
    const street = i % 4, position = i % 6, opponents = 1 + (i % 5);
    const action = bot(p, strength, toCall, pot, street, lateness(position, opponents), rnd);
    const minRaiseTo = toCall * 2 || 20;
    const size = effective(p, street, 0).raiseFractionOfPot;
    const amount = action === "bet" || action === "raise" ? Math.round(minRaiseTo + (pot + toCall) * size) : 0;
    out.push({ street, position, opponents, strength, pot, toCall, minRaiseTo, bigBlind: 20, action, amount });
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

test("a profile without position or streets fits without them", () => {
  const twin = fitTwin(simulate(PRESETS.guardian, 4000));
  assert.ok((twin.profile.positionWeight ?? 0) <= 0.2, `positionWeight ${twin.profile.positionWeight}`);
  assert.equal(twin.profile.streets, undefined);
});

test("the twin recovers positionWeight, and it raises the match rate", () => {
  const truth: Profile = { ...PRESETS.tactician, positionWeight: 0.8 };
  const ds = simulate(truth, 6000, 21);
  const twin = fitTwin(ds);
  assert.ok(Math.abs((twin.profile.positionWeight ?? 0) - 0.8) <= 0.25, `positionWeight ${twin.profile.positionWeight}`);
  assert.ok(Math.abs(twin.profile.foldBelow - truth.foldBelow) < 0.05, `foldBelow ${twin.profile.foldBelow}`);
  const { positionWeight: _, ...flat } = twin.profile;
  assert.ok(matchRate(twin.profile, ds) > matchRate(flat, ds), `${matchRate(twin.profile, ds)} vs ${matchRate(flat, ds)}`);
});

test("the twin finds a street the player plays differently", () => {
  const truth: Profile = { ...PRESETS.tactician, streets: { river: { ...PRESETS.tactician, bluffChance: 0.2, foldBelow: 0.45 } } };
  const twin = fitTwin(simulate(truth, 8000, 33));
  const river = twin.profile.streets?.river;
  assert.ok(river, "a river profile");
  assert.ok(Math.abs(river!.bluffChance - 0.2) < 0.04, `river bluff ${river!.bluffChance}`);
  assert.ok(Math.abs(river!.foldBelow - 0.45) < 0.06, `river foldBelow ${river!.foldBelow}`);
  assert.ok(Math.abs(twin.profile.bluffChance - 0.07) < 0.02, `overall bluff ${twin.profile.bluffChance}`);
  assert.equal(twin.profile.streets?.flop, undefined);
});

test("profiles keep the optional v2 fields, and a profile without them stays five numbers", () => {
  const p = clampProfile({ ...PRESETS.tactician, positionWeight: 2, brain: 2, streets: { turn: { aggression: 0.9 } as any } });
  assert.equal(p.positionWeight, 1);
  assert.equal(p.brain, 2);
  assert.deepEqual(p.streets?.turn, { ...PRESETS.tactician, aggression: 0.9 });
  assert.deepEqual(Object.keys(clampProfile(PRESETS.guardian)).sort(), Object.keys(PRESETS.guardian).sort());
  assert.throws(() => clampProfile({ ...PRESETS.tactician, positionWeight: "lots" as any }));
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
