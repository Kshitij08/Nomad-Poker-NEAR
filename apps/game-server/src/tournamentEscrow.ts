import { escrowJob, escrowPlacings, escrowWork, markEscrow, type EscrowJob, type EscrowStatus, type EscrowTournament } from '@nomad/db/tournaments';
import type { LogFn } from './roomHost';

/**
 * NEAR tournaments on the escrow (near/escrow, tournament id = the D1 id): once one ends in D1, this server, as the
 * escrow's operator, pays it out there: `settle_tournament` with the NEAR accounts in finishing order for a finished
 * one, `cancel_tournament` (refunding every entry and the host's prize) for one cancelled or aborted. The tournament
 * room does it as soon as it posts the result; the minute cron sweeps whatever is left (a failed call, a cancel at the
 * start, an abort). Every step reads the escrow first, so repeating it is harmless, and is logged.
 */

/** What this needs of NearOperator (a fake in tests). */
export interface EscrowOperator {
  view<T>(contractId: string, method: string, args: Record<string, unknown>): Promise<T>;
  call<T = unknown>(contractId: string, method: string, args: Record<string, unknown>, opts?: { deposit?: bigint; tgas?: bigint }): Promise<T>;
}
export interface TournamentEscrowLink {
  operator: EscrowOperator;
  escrow: string;
}

async function run(db: D1Database, near: TournamentEscrowLink, job: EscrowJob, log: LogFn): Promise<EscrowStatus> {
  const { id } = job;
  const e = await near.operator.view<EscrowTournament | null>(near.escrow, 'get_tournament', { tournament_id: id });
  if (!e) {
    await markEscrow(db, id, 'none');
    log('info', `[near tournament ${id}] not on the escrow: nothing to settle or refund`);
    return 'none';
  }
  if (e.status === 'Settled' || e.status === 'Cancelled') {
    const done = e.status === 'Settled' ? 'settled' : 'refunded';
    await markEscrow(db, id, done);
    log('info', `[near tournament ${id}] already ${done} on the escrow`);
    return done;
  }
  if (job.status === 'finished') {
    // The roster here and the escrow's players should be the same accounts; settle only with ones the escrow has, and
    // make up its minimum (the top two) from its other players if a roster change never reached this record.
    const placings = (await escrowPlacings(db, id)).filter((a) => e.players.includes(a));
    for (const p of e.players) if (placings.length < Math.min(2, e.players.length) && !placings.includes(p)) placings.push(p);
    const first = await near.operator.call<boolean>(near.escrow, 'settle_tournament', { tournament_id: id, placings }, { tgas: 100n });
    await markEscrow(db, id, 'settled');
    log('info', `[near tournament ${id}] settled on the escrow${first === false ? ' (already)' : ''}: ${placings.join(', ')}`);
    return 'settled';
  }
  await near.operator.call(near.escrow, 'cancel_tournament', { tournament_id: id }, { tgas: 100n });
  await markEscrow(db, id, 'refunded');
  log('info', `[near tournament ${id}] ${job.status} here: cancelled on the escrow, ${e.players.length} entr${e.players.length === 1 ? 'y' : 'ies'} and the host's prize refunded`);
  return 'refunded';
}

/** Settles or refunds one tournament on the escrow if it ended here; null if there is nothing to do. Never throws. */
export async function syncTournamentEscrow(db: D1Database, near: TournamentEscrowLink, id: string, log: LogFn): Promise<EscrowStatus | null> {
  try {
    const job = await escrowJob(db, id);
    return job ? await run(db, near, job, log) : null;
  } catch (e) {
    log('warn', `[near tournament ${id}] escrow step failed (the cron retries): ${(e as Error).message}`);
    return null;
  }
}

/** The cron's pass over every NEAR tournament that ended here but not yet on the escrow. */
export async function sweepTournamentEscrow(db: D1Database, near: TournamentEscrowLink, log: LogFn): Promise<number> {
  let done = 0;
  for (const job of await escrowWork(db)) {
    try {
      await run(db, near, job, log);
      done++;
    } catch (e) {
      log('warn', `[near tournament ${job.id}] escrow step failed (next minute retries): ${(e as Error).message}`);
    }
  }
  return done;
}
