import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPoker } from "../src/poker.mjs";
import { SessionFeeder, MemoryStore } from "../src/feeder.mjs";
import { FakeDealer, FakeTable } from "./fakes.mjs";
import { AUTOPILOT, DAREDEVIL, GUARDIAN, TRAPPER } from "../src/profiles.mjs";

const poker = await loadPoker();
// Three v2 playstyles and one first-generation {tight, aggro} profile, which still plays.
const seats = [
  { profile: AUTOPILOT, stack: 300 },
  { profile: DAREDEVIL, stack: 300 },
  { profile: { tight: 5, aggro: 90 }, stack: 300 },
  { profile: { ...GUARDIAN, position_weight: 60 }, stack: 300 },
];

function feeder(opts = {}) {
  const dealer = new FakeDealer(poker, opts.dealer);
  const table = new FakeTable(poker);
  const f = new SessionFeeder({ tableId: "t1", seats, hands: 20, dealer, table, poker, retryMs: 5, pace: () => opts.paceMs ?? 2, ...opts.feeder });
  const log = [];
  for (const ev of ["fetching", "ready", "session", "session-end", "retry", "hand"]) f.on(ev, (e) => log.push({ ev, at: Date.now(), ...e }));
  return { f, dealer, table, log };
}

test("replays a real testnet session exactly as the contract recorded it", () => {
  const out = poker.replay({
    signature_hex: "ff04dc3edd38f88bd0cfb1db6ed12d5964295577d0466de71ae640c6d9a0712e370e02f5ffd40cfad173933b270e854852ec87fdb34dd8e99393784ccf210801",
    stacks: [300, 300, 300, 300], button: 0, sb: 1, bb: 2, hands: 20,
    actions: "f,f,f;f,f,c,c,r2,f;r4,f,c,c,c,r6,f,r19,c,r25,c,r50,r162,c;f,r4,c,f,c,c,r5,c,r10,c;f,f,f;f,f,c,c,c,r2,f;c,c,f,c,c,r3,c,f,r6,c,r12,c;f,c,c,c,c,c,r3,f,f;r4,f,f,c,r4,f;c,c,c,c,c,c,c,r4,f,f,f;r4,f,c,f,c,r5,c,r10,c,r20,c;r4,f,r9,f,c,c,c,r10,f;f,c,f,c,c,c,c,c,c,c;c,f,c,r5,c,c,c,c,c,r7,c,c,r18,c,c;f,r4,f,r9,f;f,f,c,r4,c,c,c,c,c,r4,c;f,f,f;c,f,r5,f,c,r6,c,r12,c,r24,c;f,f,f;f,f,f",
  });
  assert.deepEqual(out.stacks, [557, 287, 191, 165]);
  assert.equal(out.hands.length, 20);
  assert.equal(out.hands[0].holes.length, 4);
  assert.throws(() => poker.replay({ signature_hex: "00", stacks: [100, 100], button: 0, sb: 1, bb: 2, hands: 5, actions: "f" }));
});

test("fetches the next session while the current one plays back", async () => {
  // Playback of one session (20 hands x 10 ms) outlasts a dealer call (30 ms).
  const { f, dealer, log } = feeder({ dealer: { delayMs: 30 }, paceMs: 10 });
  await f.run({ sessions: 3 });
  const sessions = log.filter((e) => e.ev === "session");
  const ends = log.filter((e) => e.ev === "session-end");
  assert.equal(sessions.length, 3);
  // Session n+1 was asked for before session n finished playing.
  for (let n = 0; n < 2; n++) assert.ok(dealer.calls[n + 1].at < ends[n].at, `session ${n + 1} requested during playback of ${n}`);
  // Only the first session made playback wait.
  assert.ok(sessions[0].stallMs >= 25);
  for (const s of sessions.slice(1)) assert.ok(s.stallMs < 5, `stall ${s.stallMs}`);
});

test("chains stacks and button from one session to the next, with rebuys", async () => {
  const { f, dealer, log } = feeder({ feeder: { hands: 60 } });
  await f.run({ sessions: 4 });
  const ready = log.filter((e) => e.ev === "ready");
  for (let n = 1; n < ready.length; n++) {
    const prev = ready[n - 1];
    const expected = prev.endStacks.map((s, i) => (s > 0 ? s : seats[i].stack));
    assert.deepEqual(dealer.calls[n].input.stacks, expected);
    assert.equal(dealer.calls[n].input.button, (prev.hands.at(-1).button + 1) % seats.length);
  }
  // Inside a session a busted seat sits out: no button, no result, and the session goes on while two have chips.
  for (const s of ready) {
    for (const h of s.hands) {
      h.stacks_before.forEach((stack, i) => {
        if (stack === 0) {
          assert.equal(h.deltas[i], 0);
          assert.notEqual(h.button, i);
        }
      });
    }
    const left = s.endStacks.filter((x) => x > 0).length;
    assert.ok(s.hands.length === 60 || left === 1, `${s.id}: ${s.hands.length} hands, ${left} players left`);
  }
  // Within a session chips are only moved; across sessions only rebuys add any.
  for (const s of ready) assert.equal(s.endStacks.reduce((a, b) => a + b), s.startStacks.reduce((a, b) => a + b));
});

test("a slow dealer shows up as a stall, not a failure", async () => {
  const { f, log } = feeder({ dealer: { delayMs: 60 }, paceMs: 0 });
  await f.run({ sessions: 3 });
  const stalls = log.filter((e) => e.ev === "session").map((e) => e.stallMs);
  assert.ok(stalls.every((s) => s >= 40), `stalls ${stalls}`);
});

test("retries a failed dealer call with the identical request", async () => {
  const { f, dealer, log } = feeder({ dealer: { failFirst: 2 } });
  await f.run({ sessions: 1 });
  assert.equal(log.filter((e) => e.ev === "retry").length, 2);
  assert.equal(dealer.calls.length, 3);
  assert.deepEqual(dealer.calls[2].input, dealer.calls[0].input);
});

test("backed tables buy in fresh each session and send the dealer the contract's request", async () => {
  const backed = { seats: [0, 1, 2, 3].map((i) => ({ backer: `backer${i}.near`, agent_id: `agent-${i}` })), buyIn: 100 };
  const { f, dealer, table, log } = feeder({ feeder: { backed, hands: 10 } });
  backed.seats.forEach((s, i) => (table.agents[s.agent_id] = { profile: seats[i].profile, owner: `pro${i}.near` }));
  await f.run({ sessions: 3 });
  const ready = log.filter((e) => e.ev === "ready");
  assert.equal(ready.length, 3);
  for (const [n, call] of dealer.calls.entries()) {
    // Every session starts from the buy-in, whatever the last one ended with.
    assert.deepEqual(call.input.stacks, [100, 100, 100, 100]);
    // The dealer gets exactly the request the contract recorded: its profiles, seated from the randomness.
    assert.deepEqual(call.input.profiles, seats.map((s) => s.profile));
    assert.equal(call.input.seating, "vrf");
    // Payouts come by table position: the seat order the proof gave.
    const order = ready[n].seatOrder;
    assert.deepEqual([...order].sort(), [0, 1, 2, 3]);
    assert.deepEqual(ready[n].payouts.seats.map((p) => p.agent_id), order.map((i) => `agent-${i}`));
  }
  // Over several sessions the agents do not always sit in the listed order.
  assert.ok(ready.some((r) => r.seatOrder.join() !== "0,1,2,3"));
});

test("a backed table of one pro's agents is refused, not retried", async () => {
  const backed = { seats: [0, 1].map((i) => ({ backer: null, agent_id: `agent-${i}` })), buyIn: 100 };
  const { f, dealer, table, log } = feeder({ feeder: { backed, hands: 5 } });
  backed.seats.forEach((s, i) => (table.agents[s.agent_id] = { profile: seats[i].profile, owner: "pro.near" }));
  await assert.rejects(f.run({ sessions: 1 }), /self-play/);
  assert.equal(log.filter((e) => e.ev === "retry").length, 0);
  assert.equal(dealer.calls.length, 0);
});

test("the WebAssembly build plays exactly what native poker-core plays", () => {
  // poker-wasm's golden session (simulates_a_seated_v2_session_that_replays): same order, same 406-byte action text.
  const golden = {
    signature_hex: "ff04dc3edd38f88bd0cfb1db6ed12d5964295577d0466de71ae640c6d9a0712e370e02f5ffd40cfad173933b270e854852ec87fdb34dd8e99393784ccf210801",
    stacks: [100, 100, 100, 100], button: 0, sb: 1, bb: 2, hands: 25, seating: "vrf",
    profiles: [
      { tight: 10, aggro: 80 },
      { fold_below: 22, raise_above: 52, aggression: 75, bluff_chance: 8, raise_size: 90, position_weight: 50 },
      { fold_below: 35, raise_above: 58, aggression: 45, bluff_chance: 3, raise_size: 60, streets: [AUTOPILOT.streets[0], AUTOPILOT.streets[1], null, null] },
      { fold_below: 40, raise_above: 60, aggression: 25, bluff_chance: 2, raise_size: 45 },
    ],
  };
  const out = poker.simulateSeated(golden);
  assert.deepEqual(out.seat_order, [3, 1, 0, 2]);
  assert.equal(out.actions.length, 406);
  assert.ok(out.actions.startsWith("f,f,c,r6,f;f,f,r8,f;f,f,c,c,c,r4,f;"));
  assert.deepEqual(poker.seatOrder(golden.signature_hex, 4), [3, 1, 0, 2]);
  // Out-of-range strategy numbers are refused, as the contract refuses them.
  assert.throws(() => poker.simulate({ ...golden, profiles: [...golden.profiles.slice(0, 3), { ...TRAPPER, aggression: 99 }] }), /profile 3/);
});

test("resumes the chain from its store after a restart", async () => {
  const store = new MemoryStore();
  const a = feeder({ feeder: { store } });
  await a.f.run({ sessions: 2 });
  const saved = await store.load();
  assert.equal(saved.index, 2);
  const b = feeder({ feeder: { store } });
  await b.f.run({ sessions: 1 });
  assert.equal(b.dealer.calls[0].input.hand_id, "t1-2");
  assert.deepEqual(b.dealer.calls[0].input.stacks, saved.stacks);
});
