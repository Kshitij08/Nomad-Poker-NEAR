// Coins Agents' bankroll on the server (review A2/H2) against a real Postgres (PGlite, in-process) and the fake
// PlayFab: sign-in on the Agent routes, the bankroll taken before queueing, the stack paid back once when it ends,
// retries, stop-while-queued, orphaned debits, old unfunded deployments, and a copied strategy's fee.
import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import express from "express";
import type { Pool } from "pg";
import { createApiRouter } from "../src/api/routes.js";
import { signPlayFabToken } from "../src/auth/jwt.js";
import { createInternalRouter } from "../src/internalRoutes.js";
import { AgentMoneyService, debitKey } from "../src/services/agentMoney.js";
import { FakePlayFab } from "../src/services/playfab.js";

process.env.JWT_SECRET ??= "test-secret-for-agent-routes-0123456789";
const here = path.dirname(fileURLToPath(import.meta.url));

function poolOver(db: PGlite): Pool {
  const query = async (text: string, params?: unknown[]) => {
    const r = await db.query(text, params as any[]);
    return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
  };
  return { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
}

let db: PGlite, pool: Pool, playfab: FakePlayFab, money: AgentMoneyService, now: Date;
let server: ReturnType<express.Express["listen"]>, base: string;

before(async () => {
  db = new PGlite();
  for (const f of ["003_agent_deployments.sql", "004_tournaments.sql", "005_strategies.sql", "006_agent_hand_replays.sql", "007_agent_money.sql", "008_agent_rooms.sql"])
    await db.exec(fs.readFileSync(path.join(here, "..", "migrations", f), "utf8"));
  await db.exec(fs.readFileSync(path.join(here, "..", "migrations", "007_agent_money.sql"), "utf8")); // re-run: a no-op
  pool = poolOver(db);
  playfab = new FakePlayFab();
  now = new Date("2026-10-19T12:00:00Z");
  money = new AgentMoneyService(pool, playfab, () => now);
  await pool.query(
    `INSERT INTO pf_players (playfab_id, title_player_account_id, display_name) VALUES ('alice', 'TPA-alice', 'Alice'), ('bob', 'TPA-bob', 'Bob')`);
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRouter(pool, undefined, money));
  app.use("/internal", createInternalRouter(pool, undefined, money));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

async function call(method: string, route: string, body?: unknown, as?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (as) headers.Authorization = "Bearer " + (await signPlayFabToken(as));
  const res = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

const start = (session: string, as: string | undefined, bankroll = 5000, ownerId = as) =>
  call("POST", "/api/agent/start", { session, ownerId, bankroll, stake: 1000, maxHands: 10 }, as);

async function deploymentRow(id: string) {
  return (await pool.query(`SELECT * FROM agent_deployments WHERE deployment_id = $1`, [id])).rows[0];
}

test("start: needs the owner's sign-in, and refuses another account's ownerId", async () => {
  assert.equal((await start("AGNTAAAA0001", undefined, 5000, "alice")).status, 401);
  assert.equal((await start("AGNTAAAA0001", "bob", 5000, "alice")).status, 403);
  assert.equal(await deploymentRow("AGNTAAAA0001"), undefined);
  assert.equal(playfab.balanceOf("alice"), 10_000);
});

test("start: a bankroll over the balance is refused, nothing queued, nothing taken", async () => {
  const r = await start("AGNTAAAA0002", "alice", 50_000);
  assert.equal(r.status, 402);
  assert.equal(r.json.code, "insufficient_coins");
  assert.equal(await deploymentRow("AGNTAAAA0002"), undefined);
  assert.equal(playfab.balanceOf("alice"), 10_000);
});

test("the bankroll leaves the owner's Coins at start, and the ending stack comes back once", async () => {
  const r = await start("AGNTAAAA0003", "alice", 5000);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(playfab.balanceOf("alice"), 5000);
  assert.equal((await deploymentRow("AGNTAAAA0003")).funded, true);
  // Owner routes read only with the owner's token.
  assert.equal((await call("GET", "/api/agent/progress?session=AGNTAAAA0003&ownerId=alice")).status, 401);
  assert.equal((await call("GET", "/api/agent/progress?session=AGNTAAAA0003", undefined, "bob")).status, 403);
  assert.equal((await call("GET", "/api/agent/progress?session=AGNTAAAA0003", undefined, "alice")).status, 200);
  // The game server reports the end: 7,250 left.
  await pool.query(`UPDATE agent_deployments SET phase = 'playing', assigned_table = 't1' WHERE deployment_id = 'AGNTAAAA0003'`);
  const done = await call("POST", "/internal/agent/complete", { session: "AGNTAAAA0003", SessionName: "t1", EndingStack: 7250, NetPnl: 2250, HandsPlayed: 10 });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(playfab.balanceOf("alice"), 12_250);
  // Reading the result again (and the worker) pays nothing more.
  const result = await call("GET", "/api/agent/result?session=AGNTAAAA0003", undefined, "alice");
  assert.equal(result.status, 200);
  assert.equal(result.json.ServerSettled, true);
  assert.deepEqual(result.json.Coins, { taken: 5000, returned: 7250, returnPending: 0 });
  await money.runDue();
  assert.equal(playfab.balanceOf("alice"), 12_250);
});

test("a credit PlayFab refuses for now stays pending and the worker pays it later", async () => {
  await start("AGNTAAAA0004", "bob", 2000);
  assert.equal(playfab.balanceOf("bob"), 8000);
  await pool.query(`UPDATE agent_deployments SET phase = 'playing', assigned_table = 't2' WHERE deployment_id = 'AGNTAAAA0004'`);
  playfab.failNext(1, "ServiceUnavailable", false);
  await call("POST", "/internal/agent/complete", { session: "AGNTAAAA0004", SessionName: "t2", EndingStack: 1500, NetPnl: -500 });
  assert.equal(playfab.balanceOf("bob"), 8000);
  now = new Date(now.getTime() + 60_000);
  await money.runDue();
  assert.equal(playfab.balanceOf("bob"), 9500);
});

test("stopping an Agent that's still queued gives the whole bankroll back", async () => {
  await start("AGNTAAAA0005", "alice", 1000);
  const before = playfab.balanceOf("alice");
  const stop = await call("POST", "/api/agent/stop", { session: "AGNTAAAA0005" }, "alice");
  assert.equal(stop.status, 200);
  await money.runDue();
  assert.equal(playfab.balanceOf("alice"), before + 1000);
});

test("a debit that landed for a deployment that never got queued is refunded by the worker", async () => {
  const before = playfab.balanceOf("bob");
  await money.fund("AGNTORPHAN01", "bob", 700); // as if the process died before queueing
  assert.equal(playfab.balanceOf("bob"), before - 700);
  await money.runDue();
  assert.equal(playfab.balanceOf("bob"), before - 700); // too soon
  now = new Date(now.getTime() + 11 * 60_000);
  await money.runDue();
  assert.equal(playfab.balanceOf("bob"), before);
  await money.runDue();
  assert.equal(playfab.balanceOf("bob"), before); // once
});

test("deployments from before the server ledger (unfunded) are never paid back by the backend", async () => {
  await pool.query(
    `INSERT INTO agent_deployments (deployment_id, owner_id, bankroll, max_hands, max_runtime_seconds, stake, stack, phase)
     VALUES ('AGNTOLD00001', 'alice', 5000, 10, 600, 1000, 9000, 'completed')`);
  const before = playfab.balanceOf("alice");
  assert.equal(await money.settle("AGNTOLD00001"), 0);
  await money.runDue();
  assert.equal(playfab.balanceOf("alice"), before);
});

test("a copied strategy's session waits for its fee, then returns the stack minus the 8% + 2%", async () => {
  await pool.query(`INSERT INTO strategies (strategy_id, creator_id, name, profile) VALUES ('11111111-1111-1111-1111-111111111111', 'bob', 'Shark', '{}'::jsonb)`)
    .catch(async () => pool.query(`INSERT INTO strategies (strategy_id, creator_id, name, profile, version) VALUES ('11111111-1111-1111-1111-111111111111', 'bob', 'Shark', '{}'::jsonb, 1)`));
  await start("AGNTAAAA0006", "alice", 1000);
  const before = playfab.balanceOf("alice");
  await pool.query(
    `UPDATE agent_deployments SET strategy_id = '11111111-1111-1111-1111-111111111111', copier_verified = TRUE, phase = 'completed', stack = 3000
      WHERE deployment_id = 'AGNTAAAA0006'`);
  assert.equal(await money.settle("AGNTAAAA0006"), null); // the fee isn't settled yet
  assert.equal(playfab.balanceOf("alice"), before);
  await pool.query(
    `INSERT INTO copy_fees (deployment_id, strategy_id, copier_id, creator_id, session_pnl, fee_base, creator_fee, platform_fee, creator_paid)
     VALUES ('AGNTAAAA0006', '11111111-1111-1111-1111-111111111111', 'alice', 'bob', 2000, 2000, 160, 40, TRUE)`);
  assert.equal(await money.settle("AGNTAAAA0006"), 2800);
  assert.equal(playfab.balanceOf("alice"), before + 2800);
  assert.ok((await pool.query(`SELECT 1 FROM agent_money WHERE idempotency_key = $1`, [debitKey("AGNTAAAA0006")])).rows[0]);
});
