import { sessionPlayer } from '@nomad/db/accounts';
import {
  activeAgent, agentHands, agentHistory, agentProgress, agentResult, agentRow, completeAgent, ownedAgent, queuedAgents,
  requestAgentStop, staleAgents, startAgent, type AgentRow, type AgentStartInput,
} from '@nomad/db/agents';
import { strategyForAgent } from '@nomad/db/strategies';
import { ApiError } from '@nomad/db/util';
import { StakeCatalog } from '@nomad/engine/stakes/stakes';
import { AgentStopReasons } from '@nomad/engine/agents';
import { StakeSessionNames } from '@nomad/table-server/sessions';
import type { Env } from './env';

/**
 * The owner's Agent routes (Bearer: the Nomad session token), the same calls Unity's AgentDeployService made to the
 * backend's /api/agent/*, answered in the same wire shapes:
 *
 *   POST /v1/agents/start   AgentStartRequest           → { session, status: 'ready', kind: 'agent', strategyId }
 *   GET  /v1/agents/progress?session=                   → AgentDeploymentProgress
 *   POST /v1/agents/stop    { session }                 → AgentDeploymentProgress
 *   GET  /v1/agents/result?session=                     → AgentDeploymentSummary | null (still playing)
 *   GET  /v1/agents/active                              → { active: { deploymentId, bankroll } | null }
 *   GET  /v1/agents/history?limit=&offset=              → AgentSessionHistory
 *   GET  /v1/agents/hands?deploymentId=&limit=&offset=  → AgentHandHistory
 *
 * Where an Agent plays: the Quick Play table for its stake, or the first overflow table with room. A table that can't
 * take it now leaves it queued; the minute sweep tries again.
 */

type Json = (body: unknown, status?: number) => Response;
const MAX_TABLES_TRIED = 8;

const table = (env: Env, session: string) => env.TABLES.get(env.TABLES.idFromName(session));

export async function agentRoute(request: Request, env: Env, url: URL, json: Json): Promise<Response | null> {
  if (!url.pathname.startsWith('/v1/agents/')) return null;
  const route = url.pathname.slice('/v1/agents/'.length);
  try {
    const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    const who = token ? await sessionPlayer(env.DB, token) : null;
    if (!who) return json({ error: 'Sign in to use Agents.', code: 'unauthorized' }, 401);
    const owner = who.player.id;
    const q = (k: string) => url.searchParams.get(k) ?? '';

    if (route === 'start' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as AgentStartInput;
      const strategy = body.strategyId ? await strategyForAgent(env.DB, String(body.strategyId), owner) : null;
      const row = await startAgent(env.DB, owner, body, { strategy });
      await placeAgent(env, row);
      return json({ session: row.id, status: 'ready', kind: 'agent', strategyId: row.strategy_id });
    }
    if (route === 'progress' && request.method === 'GET') {
      return json(await agentProgress(env.DB, await ownedAgent(env.DB, q('session'), owner)));
    }
    if (route === 'stop' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { session?: string };
      let row = await ownedAgent(env.DB, String(body.session ?? ''), owner);
      if (row.phase === 'queued') {
        // Completes only if it is still queued; a table that seated it meanwhile keeps it, and we stop it there instead.
        row = (await completeAgent(env.DB, row.id, { stopReason: AgentStopReasons.OwnerStop, endingStack: row.bankroll, handsPlayed: 0, from: 'queued' })) ?? row;
      }
      if (row.phase === 'playing') {
        await requestAgentStop(env.DB, row.id);
        if (row.room) await table(env, row.room).fetch(`https://table/agents/stop?session=${encodeURIComponent(row.room)}&id=${encodeURIComponent(row.id)}`, { method: 'POST' });
      }
      return json(await agentProgress(env.DB, (await agentRow(env.DB, row.id))!));
    }
    if (route === 'result' && request.method === 'GET') {
      return json(agentResult(await ownedAgent(env.DB, q('session'), owner)));
    }
    if (route === 'active' && request.method === 'GET') {
      const a = await activeAgent(env.DB, owner);
      return json({ active: a ? { deploymentId: a.id, bankroll: a.bankroll } : null });
    }
    if (route === 'history' && request.method === 'GET') {
      return json(await agentHistory(env.DB, owner, Number(q('limit')) || 20, Number(q('offset')) || 0));
    }
    if (route === 'hands' && request.method === 'GET') {
      const row = await ownedAgent(env.DB, q('deploymentId'), owner);
      return json(await agentHands(env.DB, row.id, Number(q('limit')) || 100, Number(q('offset')) || 0));
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message, code: e.code }, e.status);
    console.error('[agents]', e);
    return json({ error: 'Something went wrong. Try again.', code: 'internal' }, 500);
  }
}

/** Seats a queued Agent at the first table for its stake that takes it. The room name, or null (still queued). */
export async function placeAgent(env: Env, row: AgentRow): Promise<string | null> {
  const stake = StakeCatalog.isKnown(row.stake) ? row.stake : StakeCatalog.DefaultMinBuyIn;
  const names = [StakeSessionNames.primary(false, stake)];
  for (let n = 2; names.length < MAX_TABLES_TRIED; n++) names.push(StakeSessionNames.overflow(false, stake, n));
  for (const name of names) {
    try {
      const res = await table(env, name).fetch(`https://table/agents/seat?session=${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify(row) });
      const r = (await res.json()) as { seated: boolean };
      if (r.seated) return name;
    } catch (e) {
      console.warn(`[agents] ${name} could not take ${row.id}: ${(e as Error).message}`);
    }
  }
  return null;
}

/**
 * The minute sweep: Agents still queued get another try at a seat; Agents whose table has gone quiet are asked about,
 * and if their room no longer has them (it was evicted or crashed), they end with their last checkpointed stack.
 */
export async function sweepAgents(env: Env, now = Date.now()): Promise<{ placed: number; recovered: number }> {
  let placed = 0;
  let recovered = 0;
  for (const row of await queuedAgents(env.DB, 15_000, now)) if (await placeAgent(env, row)) placed++;
  for (const row of await staleAgents(env.DB, now)) {
    let holds = false;
    if (row.room) {
      try {
        const res = await table(env, row.room).fetch(`https://table/agents/holds?session=${encodeURIComponent(row.room)}&id=${encodeURIComponent(row.id)}`);
        holds = ((await res.json()) as { holds: boolean }).holds;
      } catch {
        holds = true; // can't tell: keep it (paying a live stack twice is the worse mistake)
      }
    }
    if (holds) continue;
    await completeAgent(env.DB, row.id, { stopReason: 'server_lost', endingStack: row.stack, phase: 'failed', from: 'playing', room: row.room }, now);
    console.warn(`[agents] ${row.id} lost with ${row.room}; paid back its checkpoint ${row.stack}.`);
    recovered++;
  }
  return { placed, recovered };
}
