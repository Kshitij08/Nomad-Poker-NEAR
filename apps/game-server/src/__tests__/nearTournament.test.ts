/**
 * NEAR tournaments on the escrow: when the tournament room posts its result, the operator settles the escrow's
 * tournament with the winners' NEAR accounts; when one is cancelled or aborted, the cron's sweep refunds it there.
 * D1 is the node:sqlite stand-in; the operator is a fake with the escrow's tournament rules (near/escrow/src/tournaments.rs).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPlayer, findPlayer } from '@nomad/db/accounts';
import {
  confirmEscrow, createTournament, escrowCreateArgs, markStarted, register, roster, tournamentTick,
  type EscrowTournament, type TournamentEscrow,
} from '@nomad/db/tournaments';
import { D1Shim } from '@nomad/db/testing/d1Shim';
import type { PlayerRow } from '@nomad/db/types';
import { D1TournamentBackend } from '../tournamentHost';
import { sweepTournamentEscrow, syncTournamentEscrow, type EscrowOperator } from '../tournamentEscrow';

const T0 = Date.UTC(2026, 10, 9, 12);
const MIN = 60_000;
const START = T0 + 30 * MIN;
const ESCROW = 'nomad-escrow.testnet';
const RULES = { minLeadMs: 10 * MIN, maxLeadMs: 14 * 86_400_000, maxActivePerHost: 5 };
const logs: string[] = [];
const log = (level: string, m: string) => void logs.push(`${level} ${m}`);

/** The escrow's tournament records, seen by the API (views) and by the operator (views and calls). */
class FakeEscrow implements EscrowOperator, TournamentEscrow {
  t = new Map<string, EscrowTournament & { placings?: string[] }>();
  calls: string[] = [];
  failNext = false;
  async getTournament(id: string) {
    return this.t.get(id) ?? null;
  }
  async isRegistered(id: string, account: string) {
    return this.t.get(id)?.players.includes(account) ?? false;
  }
  async view<T>(contract: string, method: string, a: Record<string, unknown>): Promise<T> {
    expect(contract).toBe(ESCROW);
    if (method !== 'get_tournament') throw new Error('unknown view ' + method);
    return (this.t.get(String(a.tournament_id)) ?? null) as T;
  }
  async call<T>(contract: string, method: string, a: Record<string, unknown>): Promise<T> {
    expect(contract).toBe(ESCROW);
    const id = String(a.tournament_id);
    this.calls.push(`${method} ${id}${a.placings ? ' ' + (a.placings as string[]).join(',') : ''}`);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('NEAR RPC unreachable');
    }
    const t = this.t.get(id);
    if (!t) throw new Error('Smart contract panicked: no such tournament');
    if (method === 'settle_tournament') {
      const placings = a.placings as string[];
      if (t.status === 'Settled') return false as T;
      if (t.status !== 'Open') throw new Error('Smart contract panicked: the tournament was cancelled');
      if (placings.length < Math.min(2, t.players.length) || placings.some((p) => !t.players.includes(p))) throw new Error('Smart contract panicked: bad placings');
      t.status = 'Settled';
      t.placings = placings;
      return true as T;
    }
    if (method === 'cancel_tournament') {
      if (t.status !== 'Open') throw new Error('Smart contract panicked: the tournament is not open');
      t.status = 'Cancelled';
      return undefined as T;
    }
    throw new Error('unknown call ' + method);
  }
}

let db: D1Database;
let escrow: FakeEscrow;
let host: PlayerRow;
let players: PlayerRow[];
const accountOf = (x: PlayerRow) => `${x.display_name.toLowerCase()}.testnet`;

async function nearPlayer(name: string): Promise<PlayerRow> {
  const x = (await findPlayer(db, (await createPlayer(db, { displayName: name }, T0)).id))!;
  await db.prepare("INSERT INTO identities (provider, subject, label, player_id, created_at) VALUES ('near', ?1, ?1, ?2, ?3)").bind(accountOf(x), x.id, T0).run();
  return x;
}

/** Created here, on the escrow (the host's wallet), confirmed, and the given players registered on both. */
async function nearTournament(entrants: PlayerRow[], name = 'NEAR Cup') {
  const t = (await createTournament(db, host.id, { name, entryFee: 100, hostPrize: 200, maxPlayers: 8, startsAtUnix: START / 1000, currency: 'near' }, RULES, T0)).tournament;
  const row = (await db.prepare('SELECT * FROM tournaments WHERE id = ?1').bind(t.id).first())!;
  const a = escrowCreateArgs(row as never);
  escrow.t.set(t.id, { host: accountOf(host), entry_fee: a.entry_fee, max_players: a.max_players, starts_at: a.starts_at, prize: a.prize, private: false, players: [], status: 'Open' });
  await confirmEscrow(db, escrow, host.id, t.id, T0);
  for (const x of entrants) {
    escrow.t.get(t.id)!.players.push(accountOf(x));
    await register(db, x, t.id, T0, escrow);
  }
  return t;
}

const escrowStatus = async (id: string) => (await db.prepare('SELECT escrow_status FROM tournaments WHERE id = ?1').bind(id).first<{ escrow_status: string }>())?.escrow_status;

beforeEach(async () => {
  db = await D1Shim.migrated();
  escrow = new FakeEscrow();
  logs.length = 0;
  host = await nearPlayer('Host');
  players = [];
  for (let i = 0; i < 4; i++) players.push(await nearPlayer(`P${i}`));
});

describe('NEAR tournaments on the escrow', () => {
  it("settles when the room posts the result, with the winners' NEAR accounts in order, once", async () => {
    const t = await nearTournament(players);
    const r = await roster(db, t.id, START);
    expect(r.rosterFrozen).toBe(true);
    await markStarted(db, t.id, START + 1000);

    const backend = new D1TournamentBackend(db, t.id, log, { operator: escrow, escrow: ESCROW });
    const order = [players[3]!, players[1]!, players[0]!, players[2]!];
    const standings = order.map((x, i) => ({ playFabId: x.friend_code!, place: i + 1, roundReached: 1 }));
    expect(await backend.postResult(order[0]!.friend_code!, standings)).toBe(200);
    expect(escrow.calls).toEqual([`settle_tournament ${t.id} ${order.map(accountOf).join(',')}`]);
    expect(escrow.t.get(t.id)).toMatchObject({ status: 'Settled', placings: order.map(accountOf) });
    expect(await escrowStatus(t.id)).toBe('settled');

    // The room retrying its result, or the cron, does nothing more on the escrow.
    expect(await backend.postResult(order[0]!.friend_code!, standings)).toBe(200);
    expect(await sweepTournamentEscrow(db, { operator: escrow, escrow: ESCROW }, log)).toBe(0);
    expect(escrow.calls).toHaveLength(1);
    expect(logs.some((l) => l.includes('settled on the escrow'))).toBe(true);
  });

  it('a failed settle is retried by the cron; one already settled on the escrow is only marked', async () => {
    const t = await nearTournament(players.slice(0, 2));
    await roster(db, t.id, START);
    await markStarted(db, t.id, START + 1000);
    escrow.failNext = true;
    const backend = new D1TournamentBackend(db, t.id, log, { operator: escrow, escrow: ESCROW });
    const standings = [players[1]!, players[0]!].map((x, i) => ({ playFabId: x.friend_code!, place: i + 1, roundReached: 1 }));
    expect(await backend.postResult(players[1]!.friend_code!, standings)).toBe(200); // the result stands
    expect(await escrowStatus(t.id)).toBe('open');
    expect(logs.some((l) => l.startsWith('warn') && l.includes('cron retries'))).toBe(true);

    expect(await sweepTournamentEscrow(db, { operator: escrow, escrow: ESCROW }, log)).toBe(1);
    expect(escrow.t.get(t.id)).toMatchObject({ status: 'Settled', placings: [accountOf(players[1]!), accountOf(players[0]!)] });
    expect(await escrowStatus(t.id)).toBe('settled');
  });

  it('refunds on the escrow what the clock cancelled or aborted, and skips one the escrow never had', async () => {
    const lonely = await nearTournament([players[0]!], 'Lonely');
    const never = await nearTournament(players.slice(1, 3), 'Never');
    const ghost = (await createTournament(db, players[3]!.id, { name: 'Ghost', startsAtUnix: START / 1000, currency: 'near' }, RULES, T0)).tournament;

    // At the start: Lonely (1 player) and Ghost (never on the escrow, nobody in) are cancelled; Never locks but no room runs it.
    expect((await tournamentTick(db, START)).ended.sort()).toEqual([lonely.id, ghost.id].sort());
    const near = { operator: escrow, escrow: ESCROW };
    expect(await sweepTournamentEscrow(db, near, log)).toBe(2);
    expect(escrow.t.get(lonely.id)!.status).toBe('Cancelled');
    expect(await escrowStatus(lonely.id)).toBe('refunded');
    expect(await escrowStatus(ghost.id)).toBe('none');

    expect((await tournamentTick(db, START + 4 * MIN)).ended).toEqual([never.id]);
    expect(await syncTournamentEscrow(db, near, never.id, log)).toBe('refunded');
    expect(escrow.t.get(never.id)!.status).toBe('Cancelled');
    expect(await sweepTournamentEscrow(db, near, log)).toBe(0);
    expect(escrow.calls).toEqual([`cancel_tournament ${lonely.id}`, `cancel_tournament ${never.id}`]);
  });
});
