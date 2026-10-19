// One Agent per owner at a time (review 20 Oct): /agent/start refuses a second while one is running, and /agent/active
// lets a client that lost its note of the running Agent find it. Its own file: /agent/start allows 8 calls a minute.
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
    `INSERT INTO pf_players (playfab_id, title_player_account_id, display_name) VALUES ('alice', 'TPA-alice', 'Alice'), ('bob', 'TPA-bob', 'Bob'), ('carol', 'TPA-carol', 'Carol')`);
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


test("one Agent at a time: a second start is refused without taking Coins, and the client can find the running one", async () => {
  assert.equal((await call("GET", "/api/agent/active", undefined, "carol")).json.active, null);
  assert.equal((await start("AGNTCCCC0001", "carol", 3000)).status, 200);
  assert.equal(playfab.balanceOf("carol"), 7000);
  // The same start retried is fine (the client's retry); another one is refused and nothing is taken.
  assert.equal((await start("AGNTCCCC0001", "carol", 3000)).status, 200);
  const second = await start("AGNTCCCC0002", "carol", 3000);
  assert.equal(second.status, 409);
  assert.equal(second.json.code, "already_running");
  assert.equal(second.json.deploymentId, "AGNTCCCC0001");
  assert.equal(playfab.balanceOf("carol"), 7000);
  assert.equal(await deploymentRow("AGNTCCCC0002"), undefined);
  // A client that lost its note of the Agent finds it; only the owner can ask.
  const active = await call("GET", "/api/agent/active", undefined, "carol");
  assert.equal(active.json.active.deploymentId, "AGNTCCCC0001");
  assert.equal(active.json.active.bankroll, 3000);
  assert.equal((await call("GET", "/api/agent/active?ownerId=carol")).status, 401);
  // Once it ends there's none, and a new one can start.
  await pool.query(`UPDATE agent_deployments SET phase = 'playing', assigned_table = 't9' WHERE deployment_id = 'AGNTCCCC0001'`);
  await call("POST", "/internal/agent/complete", { session: "AGNTCCCC0001", SessionName: "t9", EndingStack: 3000, NetPnl: 0 });
  assert.equal((await call("GET", "/api/agent/active", undefined, "carol")).json.active, null);
  assert.equal((await start("AGNTCCCC0002", "carol", 3000)).status, 200);
});
