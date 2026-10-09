import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { FakePlayFab } from "../src/services/playfab.js";
import { TournamentError, TournamentService } from "../src/tournaments/service.js";

/**
 * Whole tournament flows against a real Postgres with the in-memory PlayFab and a hand-driven clock.
 * Needs TEST_DATABASE_URL pointing at a throwaway database — every test truncates the tournament tables.
 * Never point it at a real one.
 */
const url = process.env.TEST_DATABASE_URL;
const MIN = 60_000;

describe("tournaments", { skip: url ? false : "set TEST_DATABASE_URL to run" }, () => {
  let pool: pg.Pool;
  let playfab: FakePlayFab;
  let service: TournamentService;
  let now: Date;

  const T0 = new Date("2026-10-10T12:00:00Z");
  const at = (minutesFromT0: number) => new Date(T0.getTime() + minutesFromT0 * MIN);
  const startIn = (minutes: number) => ({ startsAtUnix: Math.floor((now.getTime() + minutes * MIN) / 1000) });

  async function signIn(id: string) {
    await service.authenticate(`fake:${id}:${id.toUpperCase()}`);
    return { playFabId: id };
  }

  async function expectError(promise: Promise<unknown>, status: number, code: string) {
    await assert.rejects(promise, (err: any) => {
      assert.ok(err instanceof TournamentError, `expected TournamentError, got ${err}`);
      assert.equal(err.status, status);
      assert.equal(err.code, code);
      return true;
    });
  }

  async function moves(tournamentId: string) {
    return (
      await pool.query(`SELECT kind, amount::int, state, idempotency_key FROM money_moves WHERE tournament_id = $1 ORDER BY id`, [tournamentId])
    ).rows;
  }

  before(async () => {
    pool = new pg.Pool({ connectionString: url });
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      await pool.query(fs.readFileSync(path.join(dir, file), "utf8"));
    }
    // Twice: the migrator re-runs every file on boot, so they must all be idempotent.
    await pool.query(fs.readFileSync(path.join(dir, "004_tournaments.sql"), "utf8"));
  });

  after(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE money_moves, tournament_entries, tournaments, pf_players CASCADE`);
    now = T0;
    playfab = new FakePlayFab();
    service = new TournamentService(pool, playfab, { clock: () => now, minLeadMs: 10 * MIN });
  });

  test("creating takes the host's prize and opens registration", async () => {
    const host = await signIn("host");
    const { tournament } = await service.create(host, { name: "Friday", hostPrize: 2000, entryFee: 0, ...startIn(60) });
    assert.equal(tournament.status, "registering");
    assert.equal(tournament.firstPrize, 1200);
    assert.equal(tournament.secondPrize, 800);
    assert.match(tournament.joinCode, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(playfab.balanceOf("host"), 8000);
  });

  test("a host who can't afford the prize gets a clear refusal and keeps their chips", async () => {
    const host = await signIn("host");
    await expectError(service.create(host, { name: "Big", hostPrize: 50_000, ...startIn(60) }), 402, "insufficient_chips");
    assert.equal(playfab.balanceOf("host"), 10_000);
  });

  test("start time, limits and validation", async () => {
    const host = await signIn("host");
    await expectError(service.create(host, { name: "Soon", ...startIn(5) }), 400, "too_soon");
    await expectError(service.create(host, { name: "", ...startIn(60) }), 400, "bad_request");
    await expectError(service.create(host, { name: "X", maxPlayers: 31, ...startIn(60) }), 400, "bad_request");
    await service.create(host, { name: "A", ...startIn(60) });
    await service.create(host, { name: "B", ...startIn(60) });
    await expectError(service.create(host, { name: "C", ...startIn(60) }), 409, "host_limit");
  });

  test("register, full, unregister with refund, register again pays again", async () => {
    const host = await signIn("host");
    const { tournament } = await service.create(host, { name: "Paid", entryFee: 500, maxPlayers: 2, ...startIn(60) });
    const a = await signIn("a");
    const b = await signIn("b");
    const c = await signIn("c");

    assert.equal((await service.register(a, tournament.id)).tournament.myStatus, "registered");
    await service.register(a, tournament.id);   // twice is fine, charged once
    await service.register(b, tournament.id);
    assert.equal(playfab.balanceOf("a"), 9500);
    await expectError(service.register(c, tournament.id), 409, "full");

    await service.unregister(a, tournament.id);
    assert.equal(playfab.balanceOf("a"), 10_000);
    const again = await service.register(a, tournament.id);
    assert.equal(again.tournament.myStatus, "registered");
    assert.equal(playfab.balanceOf("a"), 9500, "the second entry is a new payment, not deduplicated away");
    assert.equal(again.tournament.players, 2);
  });

  test("not enough chips to enter: rejected, nothing taken", async () => {
    const host = await signIn("host");
    const { tournament } = await service.create(host, { name: "Steep", entryFee: 20_000, ...startIn(60) });
    const a = await signIn("a");
    await expectError(service.register(a, tournament.id), 402, "insufficient_chips");
    assert.equal(playfab.balanceOf("a"), 10_000);
    assert.equal((await service.get(tournament.id, a)).tournament.myStatus, "rejected");
  });

  test("the host can remove a player, who is refunded and can't come back", async () => {
    const host = await signIn("host");
    const { tournament } = await service.create(host, { name: "Club", entryFee: 300, ...startIn(60) });
    const a = await signIn("a");
    await service.register(a, tournament.id);
    await expectError(service.remove(a, tournament.id, "a"), 403, "not_host");
    await service.remove(host, tournament.id, "a");
    assert.equal(playfab.balanceOf("a"), 10_000);
    await expectError(service.register(a, tournament.id), 403, "removed");
  });

  test("a private code is only shown to the host and its players", async () => {
    const host = await signIn("host");
    const { tournament } = await service.create(host, { name: "Secret", visibility: "private", ...startIn(60) });
    const stranger = await signIn("s");
    assert.equal((await service.get(tournament.id, stranger)).tournament.joinCode, "");
    assert.equal((await service.list("upcoming")).tournaments.length, 0, "private ones are never listed");
    const byCode = await service.getByCode(tournament.joinCode.toLowerCase(), stranger);
    assert.equal(byCode.tournament.id, tournament.id);
  });

  test("full run: spawn, lock, start, result, prizes paid once", async () => {
    const host = await signIn("host");
    const { tournament } = await service.create(host, {
      name: "Main", hostPrize: 1000, entryFee: 500, ...startIn(30),
    });
    const players = await Promise.all(["a", "b", "c"].map(signIn));
    for (const p of players) await service.register(p, tournament.id);

    now = at(26);
    await service.tick();
    assert.equal((await service.claimSpawn()).found, false, "not yet: servers are asked for 3 minutes ahead");
    now = at(27);
    await service.tick();
    const claim = await service.claimSpawn();
    assert.equal(claim.found, true);
    assert.equal(claim.tournamentId, tournament.id);
    assert.equal((await service.claimSpawn()).found, false, "claimed once");
    await service.ready(tournament.id, true, "");

    const mine = await service.mine(players[0]);
    assert.equal(mine.entries[0].serverReady, true);
    assert.match(mine.entries[0].sessionName, /^TRN[A-Z2-7]{10}$/);
    const outsider = await signIn("z");
    assert.equal((await service.get(tournament.id, outsider)).tournament.sessionName, "", "only players learn the session");
    const hostView = (await service.mine(host)).hosted[0];
    assert.equal(hostView.serverReady, true, "the host may watch without registering");
    assert.equal(hostView.sessionName, mine.entries[0].sessionName);

    now = at(30);
    await service.tick();
    const roster = await service.roster(tournament.id);
    assert.equal(roster.status, "locked");
    assert.equal(roster.rosterFrozen, true);
    assert.deepEqual(roster.entrants.map((e) => e.playFabId).sort(), ["a", "b", "c"]);
    await expectError(service.register(outsider, tournament.id), 409, "not_open");

    await service.started(tournament.id);
    now = at(32);
    await service.progress(tournament.id, 1, { tables: 1 });
    await service.tick();

    const result = {
      championId: "b",
      standings: [
        { playFabId: "b", place: 1, roundReached: 1 },
        { playFabId: "c", place: 2, roundReached: 1 },
        { playFabId: "a", place: 3, roundReached: 1 },
      ],
    };
    await service.result(tournament.id, result);
    // Pool = 1,000 host prize + 3 × 500 = 2,500 → 1,500 / 1,000.
    assert.equal(playfab.balanceOf("b"), 10_000 - 500 + 1500);
    assert.equal(playfab.balanceOf("c"), 10_000 - 500 + 1000);
    assert.equal(playfab.balanceOf("a"), 9500);

    await service.result(tournament.id, result);   // the server retrying
    assert.equal(playfab.balanceOf("b"), 11_000, "paid once");
    await expectError(
      service.result(tournament.id, { ...result, championId: "c", standings: [
        { playFabId: "c", place: 1, roundReached: 1 }, { playFabId: "b", place: 2, roundReached: 1 },
        { playFabId: "a", place: 3, roundReached: 1 }] }),
      409, "result_conflict");

    const done = (await service.get(tournament.id, players[1])).tournament;
    assert.equal(done.status, "finished");
    assert.equal(done.myPlace, 1);
    assert.equal(done.myPrize, 1500);
  });

  test("bad results are refused", async () => {
    const host = await signIn("host");
    const { tournament } = await service.create(host, { name: "Strict", ...startIn(30) });
    for (const id of ["a", "b"]) await service.register(await signIn(id), tournament.id);
    now = at(30);
    await service.tick();
    await service.started(tournament.id);
    await expectError(service.result(tournament.id, { championId: "a", standings: [
      { playFabId: "a", place: 1, roundReached: 1 }] }), 400, "bad_result");
    await expectError(service.result(tournament.id, { championId: "b", standings: [
      { playFabId: "a", place: 1, roundReached: 1 }, { playFabId: "b", place: 2, roundReached: 1 }] }), 400, "bad_result");
    await expectError(service.result(tournament.id, { championId: "a", standings: [
      { playFabId: "a", place: 1, roundReached: 1 }, { playFabId: "x", place: 2, roundReached: 1 }] }), 400, "bad_result");
  });

  test("host cancels: every entry and the prize come back", async () => {
    const host = await signIn("host");
    const { tournament } = await service.create(host, { name: "Oops", hostPrize: 3000, entryFee: 200, ...startIn(60) });
    for (const id of ["a", "b"]) await service.register(await signIn(id), tournament.id);
    await service.cancel(host, tournament.id);
    for (const id of ["host", "a", "b"]) assert.equal(playfab.balanceOf(id), 10_000, id);
    assert.equal((await service.get(tournament.id, host)).tournament.status, "cancelled");
    await service.cancel(host, tournament.id).catch(() => {});   // a second cancel changes nothing
    assert.equal(playfab.balanceOf("host"), 10_000);
  });

  test("only one player at the start time: cancelled and refunded", async () => {
    const host = await signIn("host");
    const { tournament } = await service.create(host, { name: "Lonely", hostPrize: 500, entryFee: 100, ...startIn(30) });
    await service.register(await signIn("a"), tournament.id);
    now = at(30);
    await service.tick();
    const t = (await service.get(tournament.id, host)).tournament;
    assert.equal(t.status, "cancelled");
    assert.equal(t.cancelReason, "not_enough_players");
    assert.equal(playfab.balanceOf("a"), 10_000);
    assert.equal(playfab.balanceOf("host"), 10_000);
  });

  test("a server that never starts, or goes quiet, aborts with refunds", async () => {
    const host = await signIn("host");
    const first = (await service.create(host, { name: "Ghost", entryFee: 100, ...startIn(30) })).tournament;
    const second = (await service.create(host, { name: "Quiet", entryFee: 100, ...startIn(30) })).tournament;
    for (const id of ["a", "b"]) {
      const p = await signIn(id);
      await service.register(p, first.id);
      await service.register(p, second.id);
    }
    now = at(30);
    await service.tick();
    await service.started(second.id);
    now = at(32);
    await service.progress(second.id, 1, { tables: 2 });

    now = at(34);
    await service.tick();
    assert.equal((await service.get(first.id, null)).tournament.status, "aborted");
    assert.equal((await service.get(second.id, null)).tournament.status, "running", "heartbeat is fresh");

    now = at(36);
    await service.tick();
    const quiet = (await service.get(second.id, null)).tournament;
    assert.equal(quiet.status, "aborted");
    assert.equal(quiet.cancelReason, "server_lost");
    assert.equal(playfab.balanceOf("a"), 10_000);
  });

  test("PlayFab hiccup: the entry waits, then the worker finishes it", async () => {
    const host = await signIn("host");
    const { tournament } = await service.create(host, { name: "Flaky", entryFee: 400, ...startIn(60) });
    const a = await signIn("a");
    playfab.failNext(1);
    assert.equal((await service.register(a, tournament.id)).tournament.myStatus, "paying");
    await expectError(service.unregister(a, tournament.id), 409, "payment_pending");

    now = new Date(now.getTime() + 60_000);
    await service.tick();
    assert.equal((await service.get(tournament.id, a)).tournament.myStatus, "registered");
    assert.equal(playfab.balanceOf("a"), 9600);
  });

  test("a payment that clears after the start is refunded, not counted", async () => {
    const host = await signIn("host");
    const { tournament } = await service.create(host, { name: "Late", entryFee: 400, ...startIn(30) });
    for (const id of ["a", "b"]) await service.register(await signIn(id), tournament.id);
    const late = await signIn("late");
    playfab.failNext(1);
    await service.register(late, tournament.id);

    now = at(30);
    playfab.failNext(1);   // still failing when the lock runs
    await service.tick();
    assert.deepEqual((await service.roster(tournament.id)).entrants.map((e) => e.playFabId).sort(), ["a", "b"]);

    now = at(40);
    await service.tick();   // the debit finally lands — and is handed straight back
    assert.equal((await service.get(tournament.id, late)).tournament.myStatus, "excluded");
    assert.equal(playfab.balanceOf("late"), 10_000);
    const keys = (await moves(tournament.id)).filter((m) => m.idempotency_key.includes(":late:"));
    assert.deepEqual(keys.map((m) => `${m.kind}:${m.state}`), ["entry_debit:done", "refund:done"]);
  });

  test("raising the prize is paid for first and counts in the payout", async () => {
    const host = await signIn("host");
    const { tournament } = await service.create(host, { name: "Grow", hostPrize: 1000, ...startIn(30) });
    await service.raisePrize(host, tournament.id, 1500);
    assert.equal((await service.get(tournament.id, host)).tournament.hostPrize, 2500);
    assert.equal(playfab.balanceOf("host"), 7500);
    await expectError(service.raisePrize(host, tournament.id, 9000), 402, "insufficient_chips");
    assert.equal((await service.get(tournament.id, host)).tournament.hostPrize, 2500);

    for (const id of ["a", "b"]) await service.register(await signIn(id), tournament.id);
    now = at(30);
    await service.tick();
    await service.started(tournament.id);
    await service.result(tournament.id, { championId: "a", standings: [
      { playFabId: "a", place: 1, roundReached: 1 }, { playFabId: "b", place: 2, roundReached: 1 }] });
    assert.equal(playfab.balanceOf("a"), 10_000 + 1500);
    assert.equal(playfab.balanceOf("b"), 10_000 + 1000);
  });

  test("the tournament server can check who a joiner is", async () => {
    const host = await signIn("host");
    const { tournament } = await service.create(host, { name: "Door", ...startIn(60) });
    await service.register(await signIn("a"), tournament.id);
    const inside = await service.verify(tournament.id, "fake:a:Alice");
    assert.equal(inside.playFabId, "a");
    assert.equal(inside.entrant, true);
    assert.equal(inside.host, false);
    const stranger = await service.verify(tournament.id, "fake:z:Zed");
    assert.equal(stranger.entrant, false);
    assert.equal(stranger.host, false, "a stranger is turned away by the server");
    const hostCheck = await service.verify(tournament.id, "fake:host:Host");
    assert.equal(hostCheck.entrant, false);
    assert.equal(hostCheck.host, true, "the host is let in to watch");
    await expectError(service.verify(tournament.id, "garbage"), 401, "invalid_ticket");
  });

  test("a refused sign-in is a 401, not a crash", async () => {
    await expectError(service.authenticate("not-a-ticket"), 401, "invalid_ticket");
  });
});
