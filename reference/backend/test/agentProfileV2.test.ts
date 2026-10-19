import assert from "node:assert/strict";
import { test } from "node:test";
import { agentProfileV2 } from "../src/api/routes.js";

test("agent v2 fields: clamped position, brain 2 or classic, at most four rounds, numbers only", () => {
  const p = agentProfileV2({
    positionWeight: 3,
    brain: "2",
    streets: [
      { HasValue: true, FoldBelow: 0.4, RaiseAbove: "0.8", Aggression: 0.5, BluffChance: "lots", RaiseFractionOfPot: 0.6 },
      {}, {}, {}, { HasValue: true },
    ],
  });
  assert.equal(p.positionWeight, 1);
  assert.equal(p.brain, 2);
  assert.equal(p.streets.length, 4);
  assert.deepEqual(p.streets[0], { HasValue: true, FoldBelow: 0.4, RaiseAbove: 0.8, Aggression: 0.5, BluffChance: 0, RaiseFractionOfPot: 0.6 });
  assert.equal((p.streets[1] as any).HasValue, false);
});

test("agent v2 fields are optional: an old client plays classic with no rounds", () => {
  assert.deepEqual(agentProfileV2({}), { positionWeight: 0, brain: 0, streets: [] });
  assert.deepEqual(agentProfileV2({ positionWeight: -1, brain: 7, streets: "x" }), { positionWeight: 0, brain: 0, streets: [] });
});
