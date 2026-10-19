// Agent hand replays against a real Postgres (PGlite, in-process): the store, the internal report route (size cap,
// not-an-object), the owner's list and single-hand routes, and hands recorded before replays existed.
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
import { createInternalRouter } from "../src/internalRoutes.js";
import { AgentDeploymentService } from "../src/services/agentDeployments.js";
import { parseReplay, REPLAY_MAX_BYTES } from "../src/services/agentReplay.js";
import { signPlayFabToken } from "../src/auth/jwt.js";

process.env.JWT_SECRET ??= "test-secret-for-agent-routes-0123456789";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Just enough of pg.Pool for the service: query, and connect() for transactions (PGlite is one connection). */
function poolOver(db: PGlite): Pool {
  const query = async (text: string, params?: unknown[]) => {
    const r = await db.query(text, params as any[]);
    return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
  };
  return { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
}

let db: PGlite, pool: Pool, svc: AgentDeploymentService;
let server: ReturnType<express.Express["listen"]>, base: string;

const replay = {
  v: 1,
  hand: 1,
  sb: 50,
  bb: 100,
  button: 0,
  agentSeat: 0,
  seats: [
    { seat: 0, name: "Agent", stack: 5000, agent: true, bot: false, cards: ["As", "Kh"], end: 5200, net: 200 },
    { seat: 1, name: "Bot Ada", stack: 5000, agent: false, bot: true, end: 4800, net: -200 },
  ],
  steps: [
    { t: "street", street: "Preflop", board: [] },
    { t: "blind", seat: 1, a: "small_blind", amt: 50, pot: 50, stack: 4950 },
    { t: "act", seat: 0, a: "Raise", amt: 200, pot: 250, stack: 4800 },
    { t: "act", seat: 1, a: "Fold", amt: 50, pot: 250, stack: 4950 },
    { t: "award", seat: 0, amt: 250, pot: 0, stack: 5050, desc: "Uncontested" },
  ],
};

async function deployment(id: string, owner: string, table = "poker-agent-1") {
  await pool.query(
    `INSERT INTO agent_deployments (deployment_id, owner_id, bankroll, max_hands, max_runtime_seconds, stake, stack, phase, assigned_table)
     VALUES ($1, $2, 5000, 100, 3600, 100, 5000, 'playing', $3)`,
    [id, owner, table]
  );
}

function handBody(deploymentId: string, handNumber: number, extra: Record<string, unknown> = {}) {
  return {
    session: deploymentId,
    DeploymentId: deploymentId,
    AssignedTable: "poker-agent-1",
    HandNumber: handNumber,
    StartingStack: 5000,
    EndingStack: 5200,
    NetPnl: 200,
    HoleCards: "As Kh",
    BoardCards: "",
    Pot: 250,
    Result: "win",
    Showdown: false,
    PublicActionsJson: "[]",
    CompletedUnix: 1_760_000_000,
    ...extra,
  };
}

/** Owner routes need the owner's sign-in token: signed here for the ownerId the request names. */
async function call(method: string, route: string, body?: unknown) {
  const owner = new URL(base + route).searchParams.get("ownerId");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (owner && route.startsWith("/api/")) headers.Authorization = "Bearer " + (await signPlayFabToken(owner));
  const res = await fetch(base + route, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

before(async () => {
  db = new PGlite();
  for (const f of ["003_agent_deployments.sql", "006_agent_hand_replays.sql", "008_agent_rooms.sql"])
    await db.exec(fs.readFileSync(path.join(here, "..", "migrations", f), "utf8"));
  // Re-running a migration is how every deploy starts: it must be a no-op.
  await db.exec(fs.readFileSync(path.join(here, "..", "migrations", "006_agent_hand_replays.sql"), "utf8"));
  pool = poolOver(db);
  svc = new AgentDeploymentService(pool);
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use("/api", createApiRouter(pool));
  app.use("/internal", createInternalRouter(pool));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

test("parseReplay: objects and JSON-object strings pass; arrays, junk and oversize are dropped", () => {
  assert.deepEqual(parseReplay(undefined), { replay: null });
  assert.deepEqual(parseReplay(""), { replay: null });
  assert.deepEqual(parseReplay(JSON.stringify(replay)).replay, replay);
  assert.deepEqual(parseReplay(replay).replay, replay);
  assert.equal(parseReplay("[1,2]").dropped, "invalid");
  assert.equal(parseReplay("{not json").dropped, "invalid");
  assert.equal(parseReplay(42).dropped, "invalid");
  const big = JSON.stringify({ pad: "x".repeat(REPLAY_MAX_BYTES) });
  assert.equal(parseReplay(big).dropped, "too_large");
  assert.equal(parseReplay({ pad: "x".repeat(REPLAY_MAX_BYTES) }).dropped, "too_large");
  // Just under the cap is kept.
  const fits = JSON.stringify({ pad: "x".repeat(REPLAY_MAX_BYTES - 20) });
  assert.ok(Buffer.byteLength(fits) <= REPLAY_MAX_BYTES);
  assert.ok(parseReplay(fits).replay);
});

test("store: a hand with a replay round-trips; the live RecentHands leave the replay text out", async () => {
  await deployment("dep-r1", "owner-1");
  await svc.upsertHand("dep-r1", {
    handNumber: 1, startStack: 5000, endStack: 5200, netPnl: 200, holeCards: "As Kh", boardCards: "",
    pot: 250, result: "win", showdown: false, publicActions: [], replay,
  });
  const [h] = await svc.hands("owner-1", "dep-r1", 20, 0);
  assert.equal(h.HasReplay, true);
  assert.deepEqual(JSON.parse(h.ReplayJson), replay);
  const [recent] = await svc.recentHands("dep-r1", 10);
  assert.equal(recent.HasReplay, true);
  assert.equal(recent.ReplayJson, "");
  // A retry of the same hand without its replay keeps the stored one.
  await svc.upsertHand("dep-r1", {
    handNumber: 1, startStack: 5000, endStack: 5200, netPnl: 200, holeCards: "As Kh", boardCards: "",
    pot: 250, result: "win", showdown: false, publicActions: [], replay: null,
  });
  const one = await svc.hand("owner-1", "dep-r1", 1);
  assert.deepEqual(JSON.parse(one!.ReplayJson), replay);
});

test("route: the server's hand report stores ReplayJson; the owner lists and fetches it", async () => {
  await deployment("dep-r2", "owner-2");
  const posted = await call("POST", "/internal/agent/hand", handBody("dep-r2", 1, { ReplayJson: JSON.stringify(replay) }));
  assert.equal(posted.status, 200, JSON.stringify(posted.json));
  assert.equal(posted.json.ReplayStored, true);
  assert.equal(posted.json.HandsPlayed, 1);

  const listed = await call("GET", "/api/agent/hands?ownerId=owner-2&deploymentId=dep-r2&limit=20&offset=0");
  assert.equal(listed.status, 200);
  assert.equal(listed.json.Total, 1);
  assert.equal(listed.json.Hands[0].HasReplay, true);
  assert.deepEqual(JSON.parse(listed.json.Hands[0].ReplayJson), replay);

  const one = await call("GET", "/api/agent/hand?ownerId=owner-2&deploymentId=dep-r2&handNumber=1");
  assert.equal(one.status, 200);
  assert.equal(one.json.Hand.HandNumber, 1);
  assert.deepEqual(JSON.parse(one.json.Hand.ReplayJson), replay);

  // Owner check, missing hand, bad input.
  assert.equal((await call("GET", "/api/agent/hand?ownerId=someone-else&deploymentId=dep-r2&handNumber=1")).status, 403);
  assert.equal((await call("GET", "/api/agent/hands?ownerId=someone-else&deploymentId=dep-r2")).status, 403);
  assert.equal((await call("GET", "/api/agent/hand?ownerId=owner-2&deploymentId=dep-r2&handNumber=9")).status, 404);
  assert.equal((await call("GET", "/api/agent/hand?ownerId=owner-2&deploymentId=dep-r2&handNumber=0")).status, 400);
  assert.equal((await call("GET", "/api/agent/hand?ownerId=owner-2&deploymentId=nope&handNumber=1")).status, 404);
});

test("route: an oversized or non-object replay is dropped but the hand is still recorded", async () => {
  await deployment("dep-r3", "owner-3");
  const big = JSON.stringify({ ...replay, pad: "x".repeat(REPLAY_MAX_BYTES) });
  const tooBig = await call("POST", "/internal/agent/hand", handBody("dep-r3", 1, { ReplayJson: big }));
  assert.equal(tooBig.status, 200, JSON.stringify(tooBig.json));
  assert.equal(tooBig.json.ReplayStored, false);
  assert.equal(tooBig.json.ReplayDropped, "too_large");

  const notObject = await call("POST", "/internal/agent/hand", handBody("dep-r3", 2, { ReplayJson: "[1,2,3]" }));
  assert.equal(notObject.status, 200);
  assert.equal(notObject.json.ReplayDropped, "invalid");

  const listed = await call("GET", "/api/agent/hands?ownerId=owner-3&deploymentId=dep-r3");
  assert.equal(listed.json.Total, 2, "both hands count towards the session");
  for (const h of listed.json.Hands) {
    assert.equal(h.HasReplay, false);
    assert.equal(h.ReplayJson, "");
  }
});

test("hands recorded before replays existed still list, with their old summary fields", async () => {
  await deployment("dep-old", "owner-4");
  // As the pre-006 server wrote them: no replay_json column value at all.
  await pool.query(
    `INSERT INTO agent_hands (deployment_id, hand_number, start_stack, end_stack, net_pnl, hole_cards, board_cards, pot, result, showdown, public_actions)
     VALUES ('dep-old', 7, 5000, 4700, -300, '"Qs Qd"', '"2c 7h 9d Ts Jc"', 600, 'loss', TRUE, '[{"seat":0,"action":"Call","amount":300}]')`
  );
  const old = await call("POST", "/internal/agent/hand", handBody("dep-old", 8)); // a report with no ReplayJson
  assert.equal(old.status, 200);
  assert.equal(old.json.ReplayStored, false);
  assert.equal(old.json.ReplayDropped, "");

  const listed = await call("GET", "/api/agent/hands?ownerId=owner-4&deploymentId=dep-old");
  assert.equal(listed.status, 200);
  const seven = listed.json.Hands.find((h: any) => h.HandNumber === 7);
  assert.equal(seven.HasReplay, false);
  assert.equal(seven.ReplayJson, "");
  assert.equal(seven.HoleCards, "Qs Qd");
  assert.equal(seven.BoardCards, "2c 7h 9d Ts Jc");
  assert.equal(seven.NetPnl, -300);
  assert.equal(seven.Showdown, true);
  assert.deepEqual(JSON.parse(seven.PublicActionsJson), [{ seat: 0, action: "Call", amount: 300 }]);
  const one = await call("GET", "/api/agent/hand?ownerId=owner-4&deploymentId=dep-old&handNumber=7");
  assert.equal(one.json.Hand.HasReplay, false);
});
