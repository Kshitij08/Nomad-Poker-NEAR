import { beforeEach, describe, expect, it } from 'vitest';
import { createPlayer, createSession, findPlayer } from '../accounts';
import { balances, entries } from '../ledger';
import {
  cancelTournament, createTournament, editTournament, isTournamentSessionName, listTournaments, markStarted, myTournaments, postResult,
  raisePrize, register, removePlayer, roster, tournamentByCode, tournamentTick, tournamentView, unregister, verifyEntrant,
  HEARTBEAT_TIMEOUT_MS, START_GRACE_MS, type TournamentRules,
} from '../tournaments';
import { D1Shim } from '../testing/d1Shim';
import type { PlayerRow } from '../types';

const T0 = Date.UTC(2026, 10, 9, 12);
const MIN = 60_000;
const RULES: TournamentRules = { minLeadMs: 10 * MIN, maxLeadMs: 14 * 86_400_000, maxActivePerHost: 2 };
const START = T0 + 30 * MIN;
let db: D1Database;
let host: PlayerRow;
let p: PlayerRow[];

const coins = async (x: PlayerRow) => (await balances(db, x.id)).coins;

beforeEach(async () => {
  db = await D1Shim.migrated();
  host = (await findPlayer(db, (await createPlayer(db, { displayName: 'Host' }, T0)).id))!;
  p = [];
  for (let i = 0; i < 8; i++) p.push((await findPlayer(db, (await createPlayer(db, { displayName: `P${i}` }, T0)).id))!);
});

async function hostOne(extra: Record<string, unknown> = {}) {
  const r = await createTournament(db, host.id, { name: 'Friday Night', entryFee: 500, hostPrize: 2000, maxPlayers: 8, speed: 'turbo', startsAtUnix: START / 1000, ...extra }, RULES, T0);
  return r.tournament;
}

describe('tournaments', () => {
  it('takes the host prize at creation and entry fees at registration, atomically', async () => {
    const t = await hostOne();
    expect(t).toMatchObject({ status: 'registering', hostPrize: 2000, entryFee: 500, players: 0, hostPlayFabId: host.friend_code, myStatus: '' });
    expect(t.joinCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(await coins(host)).toBe(8000);

    for (const x of p.slice(0, 3)) await register(db, x, t.id, T0 + MIN);
    const v = (await tournamentView(db, t.id, p[0]!.id, T0 + MIN)).tournament;
    expect(v).toMatchObject({ players: 3, myStatus: 'registered', prizePool: 3500, firstPrize: 2100, secondPrize: 1400, serverReady: false });
    expect(await coins(p[0]!)).toBe(9500);
    // Registering twice charges once.
    await register(db, p[0]!, t.id, T0 + MIN);
    expect(await coins(p[0]!)).toBe(9500);

    // Leave and come back: refund, then a new fee under a new key.
    await unregister(db, p[0]!.id, t.id, T0 + 2 * MIN);
    expect(await coins(p[0]!)).toBe(10_000);
    await register(db, p[0]!, t.id, T0 + 3 * MIN);
    expect((await entries(db, p[0]!.id, { limit: 4 })).entries.map((e) => [e.reason, e.delta])).toEqual([
      ['tournament:entry', -500], ['tournament:refund', 500], ['tournament:entry', -500], ['starter', 10_000],
    ]);

    // Nobody can register without the fee.
    const broke = (await findPlayer(db, (await createPlayer(db, { displayName: 'Broke' }, T0)).id))!;
    await db.prepare(`UPDATE balances SET amount = 100 WHERE player_id = ?1 AND currency = 'coins'`).bind(broke.id).run();
    await expect(register(db, broke, t.id, T0 + 3 * MIN)).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect((await tournamentView(db, t.id, broke.id, T0 + 3 * MIN)).tournament).toMatchObject({ players: 3, myStatus: '' });
  });

  it('refuses a full field, closed registration, host limits and bad start times', async () => {
    const t = await hostOne({ maxPlayers: 2 });
    await register(db, p[0]!, t.id, T0);
    await register(db, p[1]!, t.id, T0);
    await expect(register(db, p[2]!, t.id, T0)).rejects.toMatchObject({ status: 409, message: 'This tournament is full.' });
    expect(await coins(p[2]!)).toBe(10_000);
    await expect(register(db, p[2]!, t.id, START)).rejects.toMatchObject({ message: 'Registration is closed.' });
    await hostOne();
    await expect(hostOne()).rejects.toMatchObject({ status: 409 });
    await expect(createTournament(db, p[5]!.id, { name: 'Soon', startsAtUnix: (T0 + MIN) / 1000 }, RULES, T0)).rejects.toMatchObject({ status: 400 });
    await expect(createTournament(db, p[5]!.id, { name: 'Rich', hostPrize: 50_000, startsAtUnix: START / 1000 }, RULES, T0)).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect(await coins(p[5]!)).toBe(10_000);
  });

  it('raises the prize, edits before the freeze, finds private ones by code, and lists what is open', async () => {
    const t = await hostOne({ visibility: 'private' });
    expect((await raisePrize(db, host.id, t.id, 1000, T0)).tournament.hostPrize).toBe(3000);
    expect(await coins(host)).toBe(7000);
    await expect(raisePrize(db, p[0]!.id, t.id, 1000, T0)).rejects.toMatchObject({ status: 403 });
    expect((await editTournament(db, host.id, t.id, { name: 'Renamed', maxPlayers: 6 }, RULES, T0)).tournament).toMatchObject({ name: 'Renamed', maxPlayers: 6 });
    await expect(editTournament(db, host.id, t.id, { name: 'Late' }, RULES, START - MIN)).rejects.toMatchObject({ status: 409 });
    expect((await listTournaments(db, 'upcoming', 50, T0)).tournaments).toEqual([]); // private
    expect((await tournamentView(db, t.id, p[0]!.id, T0)).tournament.joinCode).toBe('');
    expect((await tournamentByCode(db, t.joinCode.toLowerCase(), p[0]!.id, T0)).tournament.id).toBe(t.id);
    const pub = await createTournament(db, host.id, { name: 'Open', startsAtUnix: START / 1000 }, RULES, T0);
    expect((await listTournaments(db, 'upcoming', 50, T0)).tournaments.map((x) => x.id)).toEqual([pub.tournament.id]);
    await register(db, p[0]!, t.id, T0);
    expect((await myTournaments(db, p[0]!.id, T0)).entries.map((x) => x.name)).toEqual(['Renamed']);
    expect((await myTournaments(db, host.id, T0)).hosted).toHaveLength(2);
  });

  it('host cancel and removal refund everyone', async () => {
    const t = await hostOne();
    for (const x of p.slice(0, 3)) await register(db, x, t.id, T0);
    await removePlayer(db, host.id, t.id, p[2]!.friend_code!, T0);
    expect(await coins(p[2]!)).toBe(10_000);
    await expect(register(db, p[2]!, t.id, T0)).rejects.toMatchObject({ status: 403 });
    await cancelTournament(db, host.id, t.id, T0);
    await cancelTournament(db, host.id, t.id, T0).catch(() => undefined);
    for (const x of [host, ...p.slice(0, 3)]) expect(await coins(x)).toBe(10_000);
    expect((await tournamentView(db, t.id, p[0]!.id, T0)).tournament).toMatchObject({ status: 'cancelled', myStatus: 'cancelled' });
  });

  it('runs end to end: the room opens near the start, locks, plays, and pays 1st and 2nd once', async () => {
    const t = await hostOne();
    for (const x of p) await register(db, x, t.id, T0);
    expect(isTournamentSessionName((await roster(db, t.id, T0)).sessionName)).toBe(true);

    // Rooms to open: none yet; then within 3 minutes of the start.
    expect((await tournamentTick(db, T0)).open).toEqual([]);
    const near = await tournamentTick(db, START - 2 * MIN);
    expect(near.open).toHaveLength(1);
    const v = (await tournamentView(db, t.id, p[0]!.id, START - 2 * MIN)).tournament;
    expect(v.serverReady).toBe(true);
    expect(v.sessionName).toBe(near.open[0]);
    expect((await tournamentView(db, t.id, null, START - 2 * MIN)).tournament.sessionName).toBe('');

    // The room verifies tickets: entrants play, the host watches, strangers are turned away.
    const tok = (await createSession(db, p[3]!.id, T0)).token;
    expect(await verifyEntrant(db, t.id, tok, T0)).toMatchObject({ ok: true, playFabId: p[3]!.friend_code, entrant: true, host: false });
    expect(await verifyEntrant(db, t.id, (await createSession(db, host.id, T0)).token, T0)).toMatchObject({ entrant: false, host: true });
    expect((await verifyEntrant(db, t.id, 'np_nope', T0)).ok).toBe(false);

    // At the start the roster freezes.
    const r = await roster(db, t.id, START);
    expect(r).toMatchObject({ status: 'locked', rosterFrozen: true, firstPrize: 3600, secondPrize: 2400 });
    expect(r.entrants.map((e) => e.displayName).sort()).toEqual(p.map((x) => x.display_name).sort());
    expect(await markStarted(db, t.id, START + 1000)).toBe(true);

    // P7 wins, P6 second, the rest in any order.
    const order = [...p].reverse().map((x) => r.entrants.find((e) => e.playFabId === x.friend_code)!);
    const result = { championId: order[0]!.playFabId, standings: order.map((e, i) => ({ playFabId: e.playFabId, place: i + 1, roundReached: i < 4 ? 3 : 1 })) };
    expect(await postResult(db, t.id, { ...result, championId: order[1]!.playFabId }, START + 10 * MIN)).toMatchObject({ status: 400 });
    expect(await postResult(db, t.id, result, START + 10 * MIN)).toEqual({ status: 200 });
    expect(await postResult(db, t.id, result, START + 11 * MIN)).toEqual({ status: 200 }); // same again: nothing more
    expect(await postResult(db, t.id, { ...result, standings: [...result.standings].reverse().map((s, i) => ({ ...s, place: i + 1 })), championId: order[7]!.playFabId }, START + 12 * MIN)).toMatchObject({ status: 409 });

    // Pool: 2000 + 8 × 500 = 6000 → 3600 / 2400.
    expect(await coins(p[7]!)).toBe(9500 + 3600);
    expect(await coins(p[6]!)).toBe(9500 + 2400);
    for (const x of p.slice(0, 6)) expect(await coins(x)).toBe(9500);
    expect(await coins(host)).toBe(8000);
    const champ = (await tournamentView(db, t.id, p[7]!.id, START + 12 * MIN)).tournament;
    expect(champ).toMatchObject({ status: 'finished', myStatus: 'finished', myPlace: 1, myPrize: 3600 });
    // Every coin accounted for: what came in went out.
    const total = await db.prepare(`SELECT sum(delta) AS s FROM ledger_entries WHERE ref = ?1`).bind(t.id).first<{ s: number }>();
    expect(total?.s).toBe(0);
  });

  it('cancels with fewer than 2 at the start, aborts a tournament nobody started or whose room went quiet', async () => {
    const lonely = await hostOne();
    await register(db, p[0]!, lonely.id, T0);
    const t2 = await createTournament(db, p[6]!.id, { name: 'Never', entryFee: 100, startsAtUnix: START / 1000 }, RULES, T0);
    await register(db, p[1]!, t2.tournament.id, T0);
    await register(db, p[2]!, t2.tournament.id, T0);
    const t3 = await createTournament(db, p[7]!.id, { name: 'Quiet', entryFee: 100, startsAtUnix: START / 1000 }, RULES, T0);
    await register(db, p[3]!, t3.tournament.id, T0);
    await register(db, p[4]!, t3.tournament.id, T0);

    let tick = await tournamentTick(db, START);
    expect(tick.ended).toEqual([lonely.id]);
    expect(await coins(p[0]!)).toBe(10_000);
    expect(await coins(host)).toBe(10_000);
    await markStarted(db, t3.tournament.id, START + 1000);

    tick = await tournamentTick(db, START + START_GRACE_MS + 1000);
    expect(tick.ended).toEqual([t2.tournament.id]);
    expect((await tournamentView(db, t2.tournament.id, null, START)).tournament.cancelReason).toBe('server_never_started');

    tick = await tournamentTick(db, START + 1000 + HEARTBEAT_TIMEOUT_MS + 1000);
    expect(tick.ended).toEqual([t3.tournament.id]);
    for (const x of p) expect(await coins(x)).toBe(10_000);
  });
});
