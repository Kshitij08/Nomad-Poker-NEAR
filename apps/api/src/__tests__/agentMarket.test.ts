import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import type { Env } from '../env';
import { base64Decode } from '../near';
import { AGENT_MARKET_WEBHOOK, handleEvent, MarketClient, signMarketBody, verifyMarketSignature, type MarketEvent } from '../agentMarket';
import { formatNear, parseBrief, scout, type ScoutCard, type ScoutSessionRecord, type ScoutSessionSummary, type TableView } from '../agentMarketScout';

const SECRET = 'whsec-test-0123456789abcdef0123456789abcdef';
const TOKEN = 'aat_0123456789abcdef0123456789abcdef';
const RPC = 'https://rpc.test.near';
const MARKET = 'https://market.test';
const TABLE = 'table.nomad-poker.testnet';
const NEAR = 10n ** 24n;
const cfg = { contract: TABLE, appUrl: 'https://nomad-poker-near.vercel.app', explorer: 'https://testnet.nearblocks.io' };

// ---------- a table contract as its views answer (near/table-spike) ----------

const cards: ScoutCard[] = [
  {
    agent: { id: 'nomad-a', owner: 'pro.nomad-poker.testnet', tight: 70, aggro: 75, sessions: 4, hands: 120, net_chips: 340 },
    pool: { shares: String(10n * NEAR), value: String(12n * NEAR), price: '1200000000', hwm_price: '1250000000', at_table: '0', max_buy_in_bps: 2500, sessions: 4 },
  },
  {
    agent: { id: 'nomad-b', owner: 'pro.nomad-poker.testnet', tight: 20, aggro: 30, sessions: 3, hands: 90, net_chips: -150 },
    pool: { shares: String(5n * NEAR), value: String(4n * NEAR), price: '800000000', hwm_price: '1000000000', at_table: String(NEAR), max_buy_in_bps: 2500, sessions: 3 },
  },
  { agent: { id: 'nomad-c', owner: 'pro.nomad-poker.testnet', tight: 40, aggro: 50, sessions: 0, hands: 0, net_chips: 0 }, pool: null },
];
const recent: ScoutSessionSummary[] = [
  { session_id: 'sess-2', settled_at: '1763190000000000000', hands: 30, agents: ['nomad-a', 'nomad-b'], end_stacks: [1300, 700] },
  { session_id: 'sess-1', settled_at: '1763100000000000000', hands: 30, agents: ['nomad-a'], end_stacks: [1100, 900] },
];
const seat = (agent: string, buyIn: bigint, cashOut: bigint) => ({ backer: null, agent, pro: 'pro.nomad-poker.testnet', buy_in: String(buyIn), cash_out: String(cashOut), pro_fee: '0', platform_fee: '0', to_backer: String(cashOut) });
const records: Record<string, ScoutSessionRecord> = {
  'sess-2': { session_id: 'sess-2', settled_at: recent[0]!.settled_at, hands: 30, bb: 20, stacks: [1000, 1000], end_stacks: [1300, 700], payouts: { seats: [seat('nomad-a', NEAR, (13n * NEAR) / 10n), seat('nomad-b', NEAR, (7n * NEAR) / 10n)] } },
  'sess-1': { session_id: 'sess-1', settled_at: recent[1]!.settled_at, hands: 30, bb: 20, stacks: [1000, 1000], end_stacks: [1100, 900], payouts: { seats: [seat('nomad-a', NEAR, (11n * NEAR) / 10n)] } },
};

function tableAnswer(method: string, args: Record<string, unknown>): unknown {
  if (method === 'list_agents') return cards;
  if (method === 'recent_sessions') return recent;
  if (method === 'get_session_record') return records[String(args.session_id)] ?? null;
  throw new Error('unexpected view ' + method);
}
const fakeView: TableView = async <T>(m: string, a: Record<string, unknown>) => tableAnswer(m, a) as T;

// ---------- the brief and the report ----------

describe('parseBrief', () => {
  const ids = ['nomad-a', 'nomad-b', 'nomad-a2'];
  it('picks named agents, longest id first', () => {
    expect(parseBrief('Scout NOMAD-B for me', ids)).toEqual({ kind: 'agents', ids: ['nomad-b'] });
    expect(parseBrief('how is nomad-a2 doing?', ids)).toEqual({ kind: 'agents', ids: ['nomad-a2'] });
    expect(parseBrief('compare nomad-a and nomad-b', ids)).toEqual({ kind: 'agents', ids: ['nomad-a', 'nomad-b'] });
  });
  it('reads style words, else asks for the field', () => {
    expect(parseBrief('I want a tight aggressive pro', ids)).toEqual({ kind: 'style', plays: 'tight', bets: 'aggressive' });
    expect(parseBrief('a loose passive player', ids)).toEqual({ kind: 'style', plays: 'loose', bets: 'passive' });
    expect(parseBrief('who should I back?', ids)).toEqual({ kind: 'top' });
  });
});

describe('scout', () => {
  it('reports a named agent from the contract: record, pool, sessions with results, how to back and verify', async () => {
    const r = await scout('Scout nomad-a', fakeView, cfg);
    expect(r.agents).toEqual(['nomad-a']);
    const md = r.markdown;
    expect(md).toContain('## `nomad-a`: Tight, aggressive');
    expect(md).toContain('| Backed sessions settled | 4 |');
    expect(md).toContain('| Net chips over all sessions | +340 |');
    expect(md).toContain('| Pool value | 12 NEAR |');
    expect(md).toContain('| Pool change since it opened | +20.00% |');
    expect(md).toMatch(/\| `sess-2` \| .* \| 30 \| 1 NEAR \| 1\.3 NEAR \| \+0\.3 NEAR \|/);
    expect(md).toMatch(/\| `sess-1` \| .* \| 1 NEAR \| 1\.1 NEAR \| \+0\.1 NEAR \|/);
    expect(md).toContain('**Agents > Sessions**');
    expect(md).toContain(`near call ${TABLE} join_pool '{"agent_id":"nomad-a"}'`);
    expect(md).toContain('NEAR **testnet**');
  });

  it('shows losses and an empty pool honestly', async () => {
    const b = (await scout('nomad-b', fakeView, cfg)).markdown;
    expect(b).toContain('| Pool change since it opened | -20.00% |');
    expect(b).toContain('-0.3 NEAR |');
    expect(b).toContain('a session is in play');
    const c = (await scout('nomad-c', fakeView, cfg)).markdown;
    expect(c).toContain('| Pool | no backers yet |');
    expect(c).toContain('No settled session of `nomad-c`');
  });

  it('ranks by style or the whole field, and details the best match', async () => {
    const style = await scout('a loose, passive pro please', fakeView, cfg);
    expect(style.agents).toEqual(['nomad-b']);
    expect(style.markdown).toContain('You asked for a loose, passive pro');
    const top = await scout('', fakeView, cfg);
    expect(top.agents).toEqual(['nomad-a']);
    expect(top.markdown.indexOf('`nomad-a`')).toBeLessThan(top.markdown.indexOf('`nomad-b`'));
  });

  it('formats yoctoNEAR', () => {
    expect(formatNear(String((15n * NEAR) / 10n))).toBe('1.5');
    expect(formatNear(-(3n * NEAR) / 10n)).toBe('-0.3');
    expect(formatNear(0n)).toBe('0');
  });
});

// ---------- signature ----------

describe('verifyMarketSignature', () => {
  const body = '{"event":"webhook.ping","agent_id":"a","delivery_id":"test-1","test":true}';
  it('accepts the documented scheme and refuses tampering, other secrets and stale timestamps', async () => {
    const ts = '1763200000';
    const sig = await signMarketBody(SECRET, ts, body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await verifyMarketSignature(SECRET, ts, sig, body, 1763200010)).toBe('ok');
    expect(await verifyMarketSignature(SECRET, ts, sig, body.replace('a"', 'b"'), 1763200010)).toBe('bad');
    expect(await verifyMarketSignature('other-secret-0123456789abcdef0123', ts, sig, body, 1763200010)).toBe('bad');
    expect(await verifyMarketSignature(SECRET, ts, sig, body, 1763200000 + 301)).toBe('stale');
    expect(await verifyMarketSignature(SECRET, undefined, sig, body)).toBe('missing');
  });

  it('matches an HMAC computed independently (node:crypto)', async () => {
    const { createHmac } = await import('node:crypto');
    const ts = '1763200000';
    const expected = 'sha256=' + createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
    expect(await signMarketBody(SECRET, ts, body)).toBe(expected);
  });
});

// ---------- the route, end to end through the API app ----------

type Call = { method: string; path: string; body: unknown; auth: string | null };
let calls: Call[];
let rpcDown: boolean;
let messages: { body: string; origin: string; senderAgentId: string | null }[];

beforeEach(() => {
  calls = [];
  rpcDown = false;
  messages = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === RPC) {
      if (rpcDown) return new Response('down', { status: 502 });
      const { params } = JSON.parse(String(init?.body));
      if (params.account_id !== TABLE) throw new Error('unexpected contract ' + params.account_id);
      const args = JSON.parse(new TextDecoder().decode(base64Decode(params.args_base64)!));
      const result = [...new TextEncoder().encode(JSON.stringify(tableAnswer(params.method_name, args)))];
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { result, logs: [] } }));
    }
    if (url.startsWith(MARKET)) {
      const path = url.slice(MARKET.length);
      const method = init?.method ?? 'GET';
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init?.headers).get('authorization') });
      if (method === 'GET' && path.endsWith('/messages')) return new Response(JSON.stringify({ messages, total: messages.length, workerActivity: {} }));
      if (method === 'GET' && path.startsWith('/v1/jobs/')) return new Response(JSON.stringify({ jobId: 'job-1', title: 'Scout a pro', description: 'Tell me about nomad-a' }));
      return new Response(JSON.stringify({ assignmentId: 'asg-1', status: 'submitted' }));
    }
    throw new Error('unexpected fetch ' + url);
  });
});
afterEach(() => vi.unstubAllGlobals());

const app = createApp();
const env = (over: Partial<Env> = {}): Env =>
  ({ STAGE: 'test', ALLOWED_ORIGINS: 'http://localhost:5180', NEAR_RPC_URL: RPC, AGENT_MARKET_WEBHOOK_SECRET: SECRET, AGENT_MARKET_TOKEN: TOKEN, AGENT_MARKET_API: MARKET, ...over }) as Env;

async function deliver(payload: object, e: Env = env(), opts: { ts?: string; secret?: string; delivery?: string } = {}) {
  const raw = JSON.stringify(payload);
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  return app.request(
    AGENT_MARKET_WEBHOOK,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-market-event': String((payload as { event: string }).event),
        'x-market-delivery': opts.delivery ?? 'del-1',
        'x-market-timestamp': ts,
        'x-market-signature': await signMarketBody(opts.secret ?? SECRET, ts, raw),
      },
      body: raw,
    },
    e,
  );
}

/** A `hire.created` as webhooks.md documents it. */
const hireCreated = {
  event: 'hire.created',
  job_id: 'job-1',
  assignment_id: 'asg-1',
  bid_id: null,
  hire_id: 'hire-1',
  title: 'Scout a Nomad Poker pro',
  description: "What's nomad-a's record? Should I back it?",
  tags: ['poker'],
  amount: '0',
  token: 'USDC',
  sla_seconds: 3600,
  sla_deadline_at: '2026-11-15T12:00:00Z',
  attachments: [],
};

describe('POST /v1/agent-market/webhook', () => {
  it('answers 503 until the secret is set, 401 on a bad or stale signature', async () => {
    expect((await deliver(hireCreated, env({ AGENT_MARKET_WEBHOOK_SECRET: undefined }))).status).toBe(503);
    expect((await deliver(hireCreated, env(), { secret: 'wrong-secret-0123456789abcdef0123456789' })).status).toBe(401);
    expect((await deliver(hireCreated, env(), { ts: String(Math.floor(Date.now() / 1000) - 3600) })).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('answers a ping with 200 and does nothing else', async () => {
    const res = await deliver({ event: 'webhook.ping', agent_id: 'agent-uuid', delivery_id: 'test-1', test: true }, env(), { delivery: 'test-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, event: 'webhook.ping' });
    expect(calls).toEqual([]);
  });

  it('on hire.created reads the chain and submits the report as Markdown with the aat_ token', async () => {
    const res = await deliver(hireCreated);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const [submit] = calls;
    expect(submit).toMatchObject({ method: 'POST', path: '/v1/assignments/asg-1/submit', auth: `Bearer ${TOKEN}` });
    const md = (submit!.body as { deliverableMarkdown: string }).deliverableMarkdown;
    expect(md).toContain('## `nomad-a`: Tight, aggressive');
    expect(md).toContain('| Pool change since it opened | +20.00% |');
  });

  it('gives the hire back (refunded) when the chain cannot be read, rather than deliver a guess', async () => {
    rpcDown = true;
    expect((await deliver(hireCreated)).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/assignments/asg-1/decline', body: { reason: 'failed' } });
  });

  it('on hire.changes_requested re-reads the job and the buyer note, then resubmits', async () => {
    messages = [
      { body: 'Now do nomad-b instead', origin: 'direct', senderAgentId: null },
      { body: 'older', origin: 'direct', senderAgentId: null },
    ];
    expect((await deliver({ event: 'hire.changes_requested', job_id: 'job-1', assignment_id: 'asg-1' })).status).toBe(200);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/jobs/job-1', 'GET /v1/assignments/asg-1/messages', 'POST /v1/assignments/asg-1/submit']);
    const md = (calls[2]!.body as { deliverableMarkdown: string }).deliverableMarkdown;
    expect(md).toContain('## `nomad-b`');
    expect(md).toContain('## `nomad-a`');
  });

  it('on message.created answers the buyer on the thread, skipping its own and platform messages', async () => {
    messages = [
      { body: 'Report delivered', origin: 'direct', senderAgentId: 'agent-uuid' },
      { body: 'Note', origin: 'platform', senderAgentId: null },
      { body: 'And a loose passive one?', origin: 'mcp', senderAgentId: null },
    ];
    expect((await deliver({ event: 'message.created', job_id: 'job-1', assignment_id: 'asg-1' }, env(), { delivery: 'del-9' })).status).toBe(200);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/assignments/asg-1/messages', 'POST /v1/assignments/asg-1/messages']);
    expect(calls[1]!.body).toMatchObject({ clientRequestId: 'scout-del-9' });
    expect((calls[1]!.body as { body: string }).body).toContain('You asked for a loose, passive pro');
  });

  it('acknowledges the other events without acting, unknown ones included', async () => {
    for (const ev of [
      { event: 'hire.accepted', job_id: 'job-1', assignment_id: 'asg-1' },
      { event: 'hire.refunded', job_id: 'job-1', assignment_id: 'asg-1', amount: '0', token: 'USDC', reason: 'buyer_cancelled' },
      { event: 'hire.disputed', job_id: 'job-1', assignment_id: 'asg-1', dispute_id: 'd', reason: 'x', opened_by_party: 'requester', bond_amount: '1', bond_token: 'USDC' },
      { event: 'hire.dispute_resolved', job_id: 'job-1', assignment_id: 'asg-1', dispute_id: 'd', ruling: 'worker_wins', confidence: 'high', rationale: null, worker_bps: null, bond_outcome: 'none' },
      { event: 'quote.requested', job_id: 'job-2', title: 't', description: 'd', tags: [], attachments: [], budget_cap: null, token: 'USDC', quote_deadline_at: '2026-11-16T00:00:00Z' },
      { event: 'agent.suspended', agent_id: 'a', reason: 'policy', disposition: 'drain' },
      { event: 'payout.paid' },
    ]) {
      expect((await deliver(ev)).status).toBe(200);
    }
    expect(calls).toEqual([]);
  });

  it('a redo ruling resubmits', async () => {
    const out = await handleEvent(
      { event: 'hire.dispute_resolved', job_id: 'job-1', assignment_id: 'asg-1', ruling: 'redo' } as MarketEvent,
      'del-2',
      { market: new MarketClient(MARKET, TOKEN), view: fakeView, scoutConfig: cfg },
    );
    expect(out).toMatchObject({ action: 'submitted', assignmentId: 'asg-1', agents: ['nomad-a'] });
  });

  it('acknowledges but delivers nothing without the aat_ token', async () => {
    expect((await deliver(hireCreated, env({ AGENT_MARKET_TOKEN: undefined }))).status).toBe(200);
    expect(calls).toEqual([]);
  });
});
