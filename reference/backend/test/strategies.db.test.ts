// The marketplace's SQL against a real Postgres (PGlite, in-process): publish, copy, settle the profit share once,
// pay the creator, high-water mark across sessions, track record, twin and coaching from recorded decisions.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { FakePlayFab } from "../src/services/playfab.js";
import { StrategyError, StrategyService } from "../src/strategies/service.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Just enough of pg.Pool for the service: query, and connect() for transactions (PGlite is one connection). */
function poolOver(db: PGlite): Pool {
  const query = async (text: string, params?: unknown[]) => {
    const r = await db.query(text, params as any[]);
    return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
  };
  return { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
}

let db: PGlite, pool: Pool, playfab: FakePlayFab, svc: StrategyService;
let now = new Date("2026-10-20T12:00:00Z");
const days = (n: number) => { now = new Date(now.getTime() + n * 86_400_000); };

before(async () => {
  db = new PGlite();
  for (const f of ["003_agent_deployments.sql", "004_tournaments.sql", "005_strategies.sql"])
    await db.exec(fs.readFileSync(path.join(here, "..", "migrations", f), "utf8"));
  pool = poolOver(db);
  playfab = new FakePlayFab();
  svc = new StrategyService(pool, playfab, () => now);
  await pool.query(`INSERT INTO pf_players (playfab_id, title_player_account_id, display_name) VALUES ('creator', 'TPA-creator', 'Ace'), ('copier', 'TPA-copier', 'Bo')`);
});

async function deployment(id: string, owner: string, netPnl: number, hands = 100) {
  await pool.query(
    `INSERT INTO agent_deployments (deployment_id, owner_id, bankroll, max_hands, max_runtime_seconds, stake, stack, phase, net_pnl, hands_played)
     VALUES ($1, $2, 5000, 100, 3600, 1000, $3, 'completed', $4, $5)`, [id, owner, 5000 + netPnl, netPnl, hands]);
}

test("publish a custom strategy; bad input is refused", async () => {
  const s = await svc.publish("creator", { name: "Night Owl", description: "patient", profile: { foldBelow: 0.36, raiseAbove: 0.7, aggression: 0.6, bluffChance: 0.05, raiseFractionOfPot: 0.7 } });
  assert.equal(s.creatorName, "Ace");
  assert.equal(s.version, 1);
  assert.deepEqual(s.fees, { creatorPercent: 8, platformPercent: 2 });
  await assert.rejects(svc.publish("creator", { name: "x" }), StrategyError);
  await assert.rejects(svc.publish("creator", { name: "Broken", profile: { foldBelow: "a" } }), StrategyError);
  await assert.rejects(svc.publish("creator", { name: "From twin", fromTwin: true }), /Play a few more hands/);
});

/** A deployment's hands: `count` hands alternating +win/-loss Coins around `perHand` (big blind 50 at stake 1,000). */
async function hands(deploymentId: string, count: number, perHand: number, spread = 500) {
  await pool.query(
    `INSERT INTO agent_hands (deployment_id, hand_number, start_stack, end_stack, net_pnl, result)
     SELECT $1, g, 0, 0, CASE WHEN g % 2 = 0 THEN $2::bigint + $4::bigint ELSE $2::bigint - $4::bigint END, 'x' FROM generate_series(1, $3) g`,
    [deploymentId, perHand, count, spread]);
}

test("a new strategy can't be copied until 2,000 hands, 7 days and a record that beats Autopilot", async () => {
  const [s] = (await svc.creatorDashboard("creator")).strategies;
  assert.equal(s.qualified, false);
  await deployment("dep-x", "copier", 0);
  await assert.rejects(svc.attachCopy("dep-x", "copier", s.strategyId), /can't be copied yet/);
  // The creator's own Agent: 2,000 hands at +5 big blinds a hand (+500 per 100, Autopilot is +386).
  await deployment("dep-0", "creator", 200, 2000);
  await svc.attachCopy("dep-0", "creator", s.strategyId);
  await hands("dep-0", 2000, 250);
  assert.equal((await svc.list("top")).length, 0); // too young
  const [promising] = await svc.list("new"); // New and promising shows it, not yet copyable
  assert.equal(promising.strategyId, s.strategyId);
  assert.equal(promising.qualified, false);
  assert.equal(promising.record.bb100, 500);
  days(8);
  const [listed] = await svc.list("top");
  assert.equal(listed.strategyId, s.strategyId);
  assert.equal(listed.qualified, true);
  assert.equal(listed.record.vsHouse, 500 - 386);
  assert.ok(listed.record.score > 0);
});

test("a record that doesn't beat Autopilot by more than its margin isn't copyable; stakes don't decide the ranking", async () => {
  const weak = await svc.publish("bob", { name: "Plodder", profile: { foldBelow: 0.5, raiseAbove: 0.64, aggression: 0.2, bluffChance: 0, raiseFractionOfPot: 0.4 } });
  await deployment("dep-weak", "bob", 0, 2000);
  await svc.attachCopy("dep-weak", "bob", weak.strategyId);
  await hands("dep-weak", 2000, 150); // +3 bb a hand: +300 per 100, under Autopilot's +386
  days(8);
  const w = await svc.get(weak.strategyId);
  assert.equal(w.qualified, false);
  assert.equal(w.record.bb100, 300);
  assert.ok(!(await svc.list("top")).some((x) => x.strategyId === weak.strategyId));
});

test("a copied session settles once: 8% to the creator (paid into Coins), 2% to us", async () => {
  const [s] = (await svc.list("top")).filter((x) => x.name === "Night Owl");
  await deployment("dep-1", "copier", 1000);
  await svc.attachCopy("dep-1", "copier", s.strategyId);
  const fee = await svc.settle("dep-1");
  assert.equal(Number(fee.creator_fee), 80);
  assert.equal(Number(fee.platform_fee), 20);
  const again = await svc.settle("dep-1"); // idempotent
  assert.equal(again.deployment_id, "dep-1");
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n, bool_and(creator_paid) AS paid FROM copy_fees`);
  assert.deepEqual(rows[0], { n: 1, paid: true });
  assert.equal(playfab.balanceOf("creator"), 10_000 + 80); // FakePlayFab starts every account at 10,000
  assert.deepEqual(await svc.feeFor("dep-1"), { strategyId: s.strategyId, sessionPnl: 1000, creatorFee: 80, platformFee: 20, feeBase: 1000 });
});

test("high-water mark across sessions; losses and own strategies pay nothing", async () => {
  const [s] = (await svc.list("top")).filter((x) => x.name === "Night Owl");
  await deployment("dep-2", "copier", -600);
  await svc.attachCopy("dep-2", "copier", s.strategyId);
  assert.equal(Number((await svc.settle("dep-2")).creator_fee), 0);
  await deployment("dep-3", "copier", 800); // back to +1200 cumulative: only 200 above the 1000 peak
  await svc.attachCopy("dep-3", "copier", s.strategyId);
  const f3 = await svc.settle("dep-3");
  assert.equal(Number(f3.fee_base), 200);
  assert.equal(Number(f3.creator_fee), 16);
  await deployment("dep-own", "creator", 5000);
  await svc.attachCopy("dep-own", "creator", s.strategyId);
  assert.equal(await svc.settle("dep-own"), null);
  assert.deepEqual(await svc.feeFor("dep-own"), { strategyId: s.strategyId, sessionPnl: 5000, creatorFee: 0, platformFee: 0, feeBase: 0 });
});

test("track record counts every hand its Agents played; the dashboard shows what copiers earned", async () => {
  const [s] = (await svc.list("top")).filter((x) => x.name === "Night Owl");
  assert.equal(s.record.sessions, 5);
  assert.equal(s.record.copiers, 2);
  assert.equal(s.record.hands, 2000);
  assert.equal(s.record.net, 2000 * 250);
  const dash = await svc.creatorDashboard("creator");
  assert.equal(dash.earned, 96);
  assert.equal(dash.paid, 96);
});

test("a strategy that plays like a listed one is refused; a different style is accepted and gets its own style lane", async () => {
  // Night Owl v1: .36 / .70 / .60 / .05 / .70. A copy with tiny changes plays the same.
  await assert.rejects(
    svc.publish("bob", { name: "Owl Clone", profile: { foldBelow: 0.37, raiseAbove: 0.7, aggression: 0.62, bluffChance: 0.05, raiseFractionOfPot: 0.72 } }),
    /plays like "Night Owl"/);
  const loose = await svc.publish("bob", { name: "Wild Thing", profile: { foldBelow: 0.15, raiseAbove: 0.5, aggression: 0.85, bluffChance: 0.06, raiseFractionOfPot: 0.95 } });
  assert.notEqual(loose.style, (await svc.list("top"))[0].style);
  await deployment("dep-wild", "bob", 0, 2000);
  await svc.attachCopy("dep-wild", "bob", loose.strategyId);
  await hands("dep-wild", 2000, 300);
  days(8);
  const lanes = await svc.list("styles");
  assert.equal(new Set(lanes.map((x) => x.style)).size, lanes.length); // one per style
  assert.ok(lanes.some((x) => x.strategyId === loose.strategyId));
  assert.equal((await svc.list("top", 30, loose.style))[0].strategyId, loose.strategyId);
  const detail = await svc.get(loose.strategyId);
  assert.ok(Array.isArray(detail.similar));
});

test("a new version replaces the old one and must prove itself before it's listed", async () => {
  const v2 = await svc.publish("creator", { name: "Night Owl", profile: { foldBelow: 0.3, raiseAbove: 0.66, aggression: 0.5, bluffChance: 0.07, raiseFractionOfPot: 0.6 } });
  assert.equal(v2.version, 2);
  assert.equal((await svc.list("top")).filter((x) => x.name === "Night Owl").length, 0); // v1 unlisted, v2 unproven
  await deployment("dep-v2", "creator", 50, 2000);
  await svc.attachCopy("dep-v2", "creator", v2.strategyId);
  await hands("dep-v2", 2000, 250);
  days(8);
  const listed = (await svc.list("top")).filter((x) => x.name === "Night Owl");
  assert.deepEqual(listed.map((x) => x.version), [2]);
});

test("recorded decisions build the twin and the coaching report", async () => {
  const decisions = [];
  for (let i = 0; i < 400; i++) {
    const strength = (i * 37 % 100) / 100;
    const toCall = i % 3 ? 40 : 0;
    const action = strength >= 0.7 ? (toCall ? "raise" : "bet") : toCall ? (strength < 0.3 ? "fold" : "call") : "check";
    decisions.push({ playerId: "creator", table: "t1", handNo: Math.floor(i / 4), street: i % 4, position: i % 6, opponents: 2, strength, pot: 100, toCall, minRaiseTo: 80, bigBlind: 10, stack: 2000, action, amount: action === "bet" || action === "raise" ? 150 : 0 });
  }
  decisions.push({ playerId: "creator", table: "t1", handNo: 1, street: 0, action: "dance" }); // skipped
  assert.equal(await svc.recordDecisions(decisions), 400);
  const hands = Array.from({ length: 60 }, (_, i) => ({ playerId: "creator", table: "t1", handNo: i, position: i % 6, bigBlind: 10, net: i % 2 ? 40 : -25, showdown: i % 4 === 0, won: i % 8 === 0 }));
  assert.equal(await svc.recordHands(hands.slice(0, 50)) + await svc.recordHands(hands.slice(50)), 60); // at most 50 per call
  const twin = await svc.twin("creator");
  assert.equal(twin.decisions, 400);
  assert.ok(twin.confidence > 0.7);
  assert.ok(Math.abs(twin.profile.raiseAbove - 0.7) < 0.03, `raiseAbove ${twin.profile.raiseAbove}`);
  const report = await svc.coach("creator");
  assert.equal(report.hands, 60);
  assert.equal(report.note, null); // no ANTHROPIC_API_KEY in tests
  const fromTwin = await svc.publish("creator", { name: "My Twin", fromTwin: true });
  assert.equal(fromTwin.source, "twin");
});
