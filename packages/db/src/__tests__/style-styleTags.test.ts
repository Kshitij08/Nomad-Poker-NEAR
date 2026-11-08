import assert from "node:assert/strict";
import { test } from "vitest";
import { handsPlayed, styleTags } from "../style/styleTags";

const n = (foldBelow: number, raiseAbove: number, aggression = 0.45, bluffChance = 0.03, raiseFractionOfPot = 0.6) =>
  ({ foldBelow, raiseAbove, aggression, bluffChance, raiseFractionOfPot });

test("hands played follows the measured table: Value raises and Folding both tighten", () => {
  assert.ok(Math.abs(handsPlayed(n(0.1, 0.5)) - 0.557) < 1e-6);
  assert.ok(handsPlayed(n(0.4, 0.62)) < handsPlayed(n(0.4, 0.52)));
  assert.ok(handsPlayed(n(0.55, 0.6)) < handsPlayed(n(0.1, 0.6)));
});

test("tags come from behaviour: a high foldBelow with loose raising isn't called Tight; no Pot odds tag", () => {
  // The old rule called this "Tight" (foldBelow .35) although it plays about 35% of hands.
  const t = styleTags({ ...n(0.35, 0.55), brain: 2 });
  assert.ok(!t.includes("Tight"));
  assert.ok(!t.includes("Pot odds"));
  assert.ok(styleTags({ ...n(0.5, 0.64), brain: 2 }).includes("Tight"));
  assert.ok(styleTags({ ...n(0.15, 0.5), brain: 2 }).includes("Loose"));
});

test("round settings, twins, bluffing and big bets are tagged", () => {
  const autopilot = { ...n(0.35, 0.58), brain: 2, streets: { preflop: n(0.1, 0.55, 0.6, 0.05), flop: n(0.5, 0.7, 0.45, 0) } };
  const t = styleTags(autopilot);
  assert.ok(t.includes("Before / after the flop"));
  assert.ok(t.includes("Loose")); // before the flop it plays loose
  assert.ok(styleTags(n(0.35, 0.58)).includes("Twin (plays like a person)")); // no brain 2: a twin
  assert.ok(styleTags({ ...n(0.22, 0.52, 0.75, 0.08, 0.9), brain: 2 }).includes("Bluffer"));
  assert.ok(styleTags({ ...n(0.22, 0.52, 0.75, 0.08, 0.9), brain: 2 }).includes("Big bets"));
});
