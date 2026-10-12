import assert from "node:assert/strict";
import { test } from "node:test";
import { idempotencyIdFor } from "../src/services/playfab.js";
import { computePayout } from "../src/tournaments/payout.js";
import { formatFor } from "../src/tournaments/service.js";

// The same cases as PayoutCalculatorTests (Assets/Scripts/Tests/TournamentRulesTests.cs).
test("host prize splits 60/40, 2nd rounded down", () => {
  for (const [prize, first, second] of [
    [0, 0, 0],
    [1000, 600, 400],
    [1001, 601, 400],
    [10000, 6000, 4000],
    [1, 1, 0],
  ]) {
    const p = computePayout(prize, 0, 0);
    assert.equal(p.first, first, `first for ${prize}`);
    assert.equal(p.second, second, `second for ${prize}`);
  }
});

test("entries add to the pool", () => {
  assert.deepEqual(computePayout(10000, 500, 20), { pool: 20000, fee: 0, first: 12000, second: 8000 });
});

test("a fee comes off entries only", () => {
  const p = computePayout(10000, 500, 20, 1000);
  assert.equal(p.fee, 1000);
  assert.equal(p.first + p.second, 19000);
  assert.equal(p.second, 7600);
});

test("prizes and fee always add up to the pool", () => {
  let seed = 7;
  const next = (max: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % max;
  for (let i = 0; i < 2000; i++) {
    const p = computePayout(next(1_000_000), next(10_000), next(31), next(10_001));
    assert.equal(p.first + p.second + p.fee, p.pool);
    assert.ok(p.first >= p.second && p.second >= 0);
  }
});

test("bad input throws", () => {
  assert.throws(() => computePayout(-1, 0, 0));
  assert.throws(() => computePayout(0, 0, 0, 10_001));
  assert.throws(() => computePayout(1.5, 0, 0));
});

test("format follows the player count, like RoundPlanner", () => {
  assert.equal(formatFor(1), "cancelled");
  assert.equal(formatFor(2), "single");
  assert.equal(formatFor(7), "single");
  assert.equal(formatFor(8), "two_tables");
  assert.equal(formatFor(15), "two_tables");
  assert.equal(formatFor(16), "four_tables");
});

test("idempotency ids are stable GUIDs, one per key", () => {
  const a = idempotencyIdFor("trn:x:entry:p:1:debit");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(a, idempotencyIdFor("trn:x:entry:p:1:debit"));
  assert.notEqual(a, idempotencyIdFor("trn:x:entry:p:1:debit:refund"));
});
