import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import { FakePlayFab } from "../src/services/playfab.js";
import { createTournamentApiRouter, createTournamentInternalRouter } from "../src/tournaments/routes.js";
import { TournamentService } from "../src/tournaments/service.js";

/** The routes over real HTTP: sign-in, auth, JSON shapes and error codes. Needs TEST_DATABASE_URL. */
const url = process.env.TEST_DATABASE_URL;

describe("tournament HTTP routes", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  let pool: pg.Pool;
  let server: ReturnType<express.Express["listen"]>;
  let base: string;

  async function call(method: string, route: string, body?: unknown, token?: string) {
    const res = await fetch(base + route, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  }

  async function signIn(id: string) {
    const r = await call("POST", "/api/auth/playfab", { sessionTicket: `fake:${id}:${id}` });
    assert.equal(r.status, 200);
    return r.json.token as string;
  }

  before(async () => {
    process.env.JWT_SECRET ??= "test-secret-for-tournament-routes";
    pool = new pg.Pool({ connectionString: url });
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      await pool.query(fs.readFileSync(path.join(dir, file), "utf8"));
    }
    await pool.query(`TRUNCATE money_moves, tournament_entries, tournaments, pf_players CASCADE`);

    const service = new TournamentService(pool, new FakePlayFab(), { minLeadMs: 10 * 60_000 });
    const app = express();
    app.use(express.json());
    app.use("/api", createTournamentApiRouter(service));
    app.use("/internal/tournaments", createTournamentInternalRouter(service));
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.close();
    await pool.end();
  });

  test("sign in, host, register, see it in my list", async () => {
    assert.equal((await call("POST", "/api/auth/playfab", { sessionTicket: "nope" })).status, 401);

    const host = await signIn("host");
    const startsAtUnix = Math.floor(Date.now() / 1000) + 3600;
    assert.equal((await call("POST", "/api/tournaments", { name: "No auth", startsAtUnix })).status, 401);

    const created = await call("POST", "/api/tournaments", { name: "Web", entryFee: 250, hostPrize: 1000, startsAtUnix }, host);
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const t = created.json.tournament;
    assert.equal(t.status, "registering");
    assert.equal(typeof created.json.serverNowUnix, "number");

    const listed = await call("GET", "/api/tournaments");
    assert.ok(Array.isArray(listed.json.tournaments), "lists are wrapped in an object for JsonUtility");
    assert.equal(listed.json.tournaments[0].id, t.id);
    assert.equal(listed.json.tournaments[0].sessionName, "", "anonymous readers never see the session");

    const player = await signIn("p1");
    const joined = await call("POST", `/api/tournaments/${t.id}/register`, {}, player);
    assert.equal(joined.json.tournament.myStatus, "registered");
    assert.equal(joined.json.tournament.players, 1);

    const byCode = await call("GET", `/api/tournaments/code/${t.joinCode}`, undefined, player);
    assert.equal(byCode.json.tournament.myStatus, "registered");

    const mine = await call("GET", "/api/me/tournaments", undefined, player);
    assert.equal(mine.json.entries.length, 1);
    assert.equal(mine.json.hosted.length, 0);
  });

  test("errors come back as JSON with a code", async () => {
    const r = await call("GET", "/api/tournaments/not-a-uuid");
    assert.equal(r.status, 404);
    assert.equal(r.json.code, "not_found");
    const bad = await call("GET", "/api/tournaments/code/0O1I");
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, "bad_code");
  });

  test("the server's claim is empty until a tournament is due", async () => {
    const r = await call("POST", "/internal/tournaments/claim-spawn", {});
    assert.equal(r.status, 200);
    assert.equal(r.json.found, false);
  });
});
