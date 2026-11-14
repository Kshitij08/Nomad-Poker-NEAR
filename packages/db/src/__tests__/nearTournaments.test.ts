import { beforeEach, describe, expect, it } from 'vitest';
import { createPlayer, findPlayer } from '../accounts';
import { balances } from '../ledger';
import {
  cancelTournament, confirmEscrow, createTournament, editTournament, escrowCreateArgs, escrowPlacings, escrowWork, listTournaments, markEscrow,
  markStarted, postResult, raisePrize, register, removePlayer, roster, tournamentByCode, tournamentTick, tournamentView, unregister,
  type EscrowTournament, type TournamentEscrow, type TournamentRules,
} from '../tournaments';
import { D1Shim } from '../testing/d1Shim';
import type { PlayerRow } from '../types';

const T0 = Date.UTC(2026, 10, 9, 12);
const MIN = 60_000;
const RULES: TournamentRules = { minLeadMs: 10 * MIN, maxLeadMs: 14 * 86_400_000, maxActivePerHost: 2 };
const START = T0 + 30 * MIN;
const CHIP = 10n ** 21n;

/** The escrow's tournament records as the API sees them through views (near/escrow/src/tournaments.rs). */
class FakeEscrow implements TournamentEscrow {
  t = new Map<string, EscrowTournament>();
  create(id: string, host: string, args: ReturnType<typeof escrowCreateArgs>, priv = false) {
    this.t.set(id, { host, entry_fee: args.entry_fee, max_players: args.max_players, starts_at: args.starts_at, prize: args.prize, private: priv, players: [], status: 'Open' });
  }
  async getTournament(id: string) {
    return this.t.get(id) ?? null;
  }
  async isRegistered(id: string, account: string) {
    return this.t.get(id)?.players.includes(account) ?? false;
  }
}

let db: D1Database;
let escrow: FakeEscrow;
let host: PlayerRow;
let p: PlayerRow[];
const account = (x: PlayerRow) => `${x.display_name.toLowerCase()}.testnet`;

async function nearPlayer(name: string): Promise<PlayerRow> {
  const x = (await findPlayer(db, (await createPlayer(db, { displayName: name }, T0)).id))!;
  await db.prepare("INSERT INTO identities (provider, subject, label, player_id, created_at) VALUES ('near', ?1, ?1, ?2, ?3)").bind(`${name.toLowerCase()}.testnet`, x.id, T0).run();
  return x;
}

beforeEach(async () => {
  db = await D1Shim.migrated();
  escrow = new FakeEscrow();
  host = await nearPlayer('Host');
  p = [];
  for (let i = 0; i < 4; i++) p.push(await nearPlayer(`P${i}`));
});

/** The host creates it here, their wallet creates it on the escrow, and the API confirms. */
async function hostNear(extra: Record<string, unknown> = {}) {
  const created = (await createTournament(db, host.id, { name: 'NEAR Night', entryFee: 100, hostPrize: 200, maxPlayers: 8, startsAtUnix: START / 1000, currency: 'near', ...extra }, RULES, T0)).tournament;
  const row = (await db.prepare('SELECT * FROM tournaments WHERE id = ?1').bind(created.id).first())!;
  escrow.create(created.id, account(host), escrowCreateArgs(row as never), extra.visibility === 'private');
  return created;
}

describe('NEAR tournaments', () => {
  it('stay hidden until the escrow has them, as created here', async () => {
    const t = (await createTournament(db, host.id, { name: 'NEAR Night', entryFee: 100, hostPrize: 200, maxPlayers: 8, startsAtUnix: START / 1000, currency: 'near' }, RULES, T0)).tournament;
    expect(t).toMatchObject({ currency: 'near', escrowReady: false, entryFee: 100, hostPrize: 200 });
    expect((await listTournaments(db, 'upcoming', 50, T0)).tournaments).toEqual([]);
    await expect(tournamentByCode(db, t.joinCode, p[0]!.id, T0)).rejects.toMatchObject({ status: 404 });
    await expect(register(db, p[0]!, t.id, T0, escrow)).rejects.toMatchObject({ status: 404 });
    await expect(confirmEscrow(db, escrow, host.id, t.id, T0)).rejects.toMatchObject({ code: 'escrow_missing' });

    const row = (await db.prepare('SELECT * FROM tournaments WHERE id = ?1').bind(t.id).first())!;
    const args = escrowCreateArgs(row as never);
    expect(args).toMatchObject({ tournament_id: t.id, entry_fee: String(100n * CHIP), prize: String(200n * CHIP), starts_at: String(BigInt(START) * 1_000_000n), max_players: 8 });
    escrow.create(t.id, account(host), { ...args, prize: String(100n * CHIP) });
    await expect(confirmEscrow(db, escrow, host.id, t.id, T0)).rejects.toMatchObject({ code: 'escrow_mismatch' });
    escrow.create(t.id, 'someone.testnet', args);
    await expect(confirmEscrow(db, escrow, host.id, t.id, T0)).rejects.toMatchObject({ code: 'escrow_mismatch' });
    escrow.create(t.id, account(host), args);
    await expect(confirmEscrow(db, escrow, p[0]!.id, t.id, T0)).rejects.toMatchObject({ status: 403 });
    expect((await confirmEscrow(db, escrow, host.id, t.id, T0)).tournament.escrowReady).toBe(true);
    expect((await listTournaments(db, 'upcoming', 50, T0)).tournaments.map((x) => x.id)).toEqual([t.id]);
    // No coins moved.
    expect((await balances(db, host.id)).coins).toBe(10_000);
  });

  it('needs a NEAR sign-in to host or enter', async () => {
    const plain = (await findPlayer(db, (await createPlayer(db, { displayName: 'Plain' }, T0)).id))!;
    await expect(createTournament(db, plain.id, { name: 'x', startsAtUnix: START / 1000, currency: 'near' }, RULES, T0)).rejects.toMatchObject({ code: 'near_required' });
    const t = await hostNear();
    await confirmEscrow(db, escrow, host.id, t.id, T0);
    await expect(register(db, plain, t.id, T0, escrow)).rejects.toMatchObject({ code: 'near_required' });
  });

  it('registers only players the escrow has, and lets them leave only once the escrow let them go', async () => {
    const t = await hostNear();
    await confirmEscrow(db, escrow, host.id, t.id, T0);
    await expect(register(db, p[0]!, t.id, T0, escrow)).rejects.toMatchObject({ code: 'escrow_unpaid' });
    escrow.t.get(t.id)!.players.push(account(p[0]!), account(p[1]!));
    expect((await register(db, p[0]!, t.id, T0, escrow)).tournament).toMatchObject({ myStatus: 'registered', players: 1 });
    await register(db, p[1]!, t.id, T0, escrow);
    // 5% of entries to the escrow: pool 200 + 200 − 10 = 390.
    expect((await tournamentView(db, t.id, p[0]!.id, T0)).tournament).toMatchObject({ players: 2, prizePool: 390, secondPrize: 156, firstPrize: 234 });
    expect((await balances(db, p[0]!.id)).coins).toBe(10_000);

    await expect(unregister(db, p[0]!.id, t.id, T0, escrow)).rejects.toMatchObject({ code: 'escrow_registered' });
    escrow.t.get(t.id)!.players = [account(p[1]!)];
    expect((await unregister(db, p[0]!.id, t.id, T0, escrow)).tournament).toMatchObject({ myStatus: 'unregistered', players: 1 });
    // A paid registration that lands just after the start still counts until the roster locks.
    escrow.t.get(t.id)!.players.push(account(p[2]!));
    expect((await register(db, p[2]!, t.id, START + 1000, escrow)).tournament.myStatus).toBe('registered');

    await expect(raisePrize(db, host.id, t.id, 10, T0)).rejects.toMatchObject({ status: 409 });
    await expect(removePlayer(db, host.id, t.id, p[1]!.friend_code!, T0)).rejects.toMatchObject({ status: 409 });
    await expect(editTournament(db, host.id, t.id, { entryFee: 5 }, RULES, T0)).rejects.toMatchObject({ status: 409 });
    expect((await editTournament(db, host.id, t.id, { name: 'Renamed', speed: 'turbo' }, RULES, T0)).tournament.name).toBe('Renamed');
  });

  it('a finished one records places and hands the escrow its placings; no ledger entries', async () => {
    const t = await hostNear();
    await confirmEscrow(db, escrow, host.id, t.id, T0);
    for (const x of p) {
      escrow.t.get(t.id)!.players.push(account(x));
      await register(db, x, t.id, T0, escrow);
    }
    const r = await roster(db, t.id, START);
    expect(r).toMatchObject({ status: 'locked', firstPrize: 348, secondPrize: 232 }); // 200 + 400 − 20 = 580
    await markStarted(db, t.id, START + 1000);
    const order = [p[2]!, p[0]!, p[3]!, p[1]!];
    const standings = order.map((x, i) => ({ playFabId: x.friend_code!, place: i + 1, roundReached: 1 }));
    expect(await escrowWork(db)).toEqual([]);
    expect(await postResult(db, t.id, { championId: p[2]!.friend_code!, standings }, START + 5 * MIN)).toEqual({ status: 200 });
    expect(await escrowPlacings(db, t.id)).toEqual(order.map(account));
    expect(await escrowWork(db)).toEqual([{ id: t.id, status: 'finished', escrowStatus: 'open' }]);
    expect((await tournamentView(db, t.id, p[2]!.id, START + 5 * MIN)).tournament).toMatchObject({ myPlace: 1, myPrize: 348 });
    const ledger = await db.prepare('SELECT count(*) AS n FROM ledger_entries WHERE ref = ?1').bind(t.id).first<{ n: number }>();
    expect(ledger?.n).toBe(0);
    await markEscrow(db, t.id, 'settled', START + 6 * MIN);
    expect(await escrowWork(db)).toEqual([]);
  });

  it('cancelled or aborted ones are left for the operator to refund on the escrow', async () => {
    const t = await hostNear();
    await confirmEscrow(db, escrow, host.id, t.id, T0);
    escrow.t.get(t.id)!.players.push(account(p[0]!));
    await register(db, p[0]!, t.id, T0, escrow);
    // The host cancels here without cancelling on the escrow first: the operator has to refund.
    await cancelTournament(db, host.id, t.id, T0, escrow);
    expect(await escrowWork(db)).toEqual([{ id: t.id, status: 'cancelled', escrowStatus: 'open' }]);
    expect((await balances(db, p[0]!.id)).coins).toBe(10_000);

    // The host's wallet cancelled first: nothing left to do.
    const t2 = await hostNear({ name: 'Two' });
    await confirmEscrow(db, escrow, host.id, t2.id, T0);
    escrow.t.get(t2.id)!.status = 'Cancelled';
    await cancelTournament(db, host.id, t2.id, T0, escrow);
    expect((await escrowWork(db)).map((j) => j.id)).toEqual([t.id]);

    // One the host never put on the escrow ends at the start with nobody in; the operator checks and finds nothing.
    await markEscrow(db, t.id, 'refunded', T0);
    const t3 = (await createTournament(db, p[3]!.id, { name: 'Ghost', startsAtUnix: START / 1000, currency: 'near' }, RULES, T0)).tournament;
    expect((await tournamentTick(db, START)).ended).toEqual([t3.id]);
    expect(await escrowWork(db)).toEqual([{ id: t3.id, status: 'cancelled', escrowStatus: 'pending' }]);
  });
});
