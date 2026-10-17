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

before(async () => {
  db = new PGlite();
  for (const f of ["003_agent_deployments.sql", "004_tournaments.sql", "005_strategies.sql"])
    await db.exec(fs.readFileSync(path.join(here, "..", "migrations", f), "utf8"));
  pool = poolOver(db);
  playfab = new FakePlayFab();
  svc = new StrategyService(pool, playfab);
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

test("an unproven strategy isn't listed or copyable; the creator's own sessions qualify it", async () => {
  assert.equal((await svc.list("new")).length, 0);
  const [s] = (await svc.creatorDashboard("creator")).strategies;
  assert.equal(s.qualified, false);
  await deployment("dep-x", "copier", 0);
  await assert.rejects(svc.attachCopy("dep-x", "copier", s.strategyId), /isn't listed yet/);
  await deployment("dep-0", "creator", 200, 120); // the creator's own Agent: 120 hands, +200
  await svc.attachCopy("dep-0", "creator", s.strategyId);
  const [listed] = await svc.list("new");
  assert.equal(listed.strategyId, s.strategyId);
  assert.equal(listed.qualified, true);
});

test("a copied session settles once: 8% to the creator (paid into Coins), 2% to us", async () => {
  const [s] = await svc.list("new");
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
  const [s] = await svc.list("new");
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

test("track record and creator dashboard come from the settled sessions", async () => {
  const [s] = await svc.list("top");
  assert.equal(s.record.sessions, 5);
  assert.equal(s.record.copiers, 2);
  assert.equal(s.record.net, 200 + 1000 - 600 + 800 + 5000);
  const dash = await svc.creatorDashboard("creator");
  assert.equal(dash.earned, 96);
  assert.equal(dash.paid, 96);
});

test("a new version replaces the old one and must prove itself before it's listed", async () => {
  const v2 = await svc.publish("creator", { name: "Night Owl", profile: { foldBelow: 0.3, raiseAbove: 0.66, aggression: 0.5, bluffChance: 0.07, raiseFractionOfPot: 0.6 } });
  assert.equal(v2.version, 2);
  assert.equal((await svc.list("new")).filter((x) => x.name === "Night Owl").length, 0); // v1 unlisted, v2 unproven
  await deployment("dep-v2", "creator", 50, 100);
  await svc.attachCopy("dep-v2", "creator", v2.strategyId);
  const listed = (await svc.list("new")).filter((x) => x.name === "Night Owl");
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
