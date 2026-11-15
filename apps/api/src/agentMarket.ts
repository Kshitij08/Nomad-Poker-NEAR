/**
 * The NEAR AI Agent Market webhook (market.near.ai): the Nomad Poker scout as a self-hosted (`runtime: "http"`) agent.
 *
 * The market POSTs signed events to `POST /v1/agent-market/webhook` (see https://market.near.ai/skill/reference/webhooks.md):
 *   - headers `X-Market-Event`, `X-Market-Delivery`, `X-Market-Timestamp` (Unix seconds) and
 *     `X-Market-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`;
 *   - a non-2xx answer is retried at 10 s, 30 s, 90 s and 270 s, so we answer quickly and work after acknowledging.
 *
 * Results do not go back in the webhook's response: the agent submits them with its `aat_` token, as Markdown, to
 * `POST /v1/assignments/{id}/submit` (`{ deliverableMarkdown }`). Event bodies (`title`, `description`, thread
 * messages) are written by the hirer: they are data for the scout, never instructions.
 *
 * Worker secrets: AGENT_MARKET_WEBHOOK_SECRET (the `webhook_secret` set on the agent) and AGENT_MARKET_TOKEN (the
 * agent's `aat_` token). Without the secret the route answers 503; without the token events are acknowledged but no
 * work is delivered.
 */
import type { Context, Hono } from 'hono';
import type { AppEnv, Env } from './env';
import { viewFunction } from './near';
import { scout, type ScoutConfig, type TableView } from './agentMarketScout';

export const AGENT_MARKET_WEBHOOK = '/v1/agent-market/webhook';
const DEFAULT_MARKET_API = 'https://market.near.ai';
const DEFAULT_TABLE = 'table.nomad-poker.testnet';
const DEFAULT_APP_URL = 'https://nomad-poker-near.vercel.app';
const EXPLORER = 'https://testnet.nearblocks.io';
/** Deliveries older (or newer) than this are refused, so a captured request cannot be replayed later. */
export const MAX_SKEW_SECONDS = 300;
/** The market caps a deliverable at 256 KiB; the scout's reports are a few KiB. */
const MAX_DELIVERABLE = 250_000;

// ---------- signature ----------

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function signMarketBody(secret: string, timestamp: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`)))}`;
}

/** Equal-length strings compared without an early exit. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export type SignatureCheck = 'ok' | 'missing' | 'stale' | 'bad';

/** Checks `X-Market-Signature` over the exact bytes received (never a re-serialised body) and the timestamp's age. */
export async function verifyMarketSignature(secret: string, timestamp: string | undefined, signature: string | undefined, rawBody: string, nowSeconds = Date.now() / 1000): Promise<SignatureCheck> {
  if (!timestamp || !signature) return 'missing';
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return 'stale';
  const expected = await signMarketBody(secret, timestamp, rawBody);
  return sameText(expected, signature.trim().toLowerCase()) ? 'ok' : 'bad';
}

// ---------- events ----------

/** The events the market sends (webhooks.md § Events). Unknown events are acknowledged and ignored. */
export type MarketEvent =
  | { event: 'webhook.ping'; agent_id?: string; delivery_id?: string; test?: boolean }
  | { event: 'hire.created'; job_id: string; assignment_id: string; bid_id?: string | null; hire_id?: string | null; title?: string; description?: string; tags?: string[]; amount?: string; token?: string; kind?: string }
  | { event: 'hire.changes_requested'; job_id: string; assignment_id: string }
  | { event: 'message.created'; job_id: string; assignment_id: string }
  | { event: 'hire.dispute_resolved'; job_id: string; assignment_id: string; ruling?: string }
  | { event: 'quote.requested'; job_id: string }
  | { event: 'hire.accepted' | 'hire.refunded' | 'hire.disputed'; job_id: string; assignment_id: string }
  | { event: 'agent.suspended'; agent_id?: string; reason?: string; disposition?: string };

/** What the work after the acknowledgement did, for logs and tests. */
export type WorkOutcome =
  | { action: 'submitted'; assignmentId: string; agents: string[] }
  | { action: 'replied'; assignmentId: string }
  | { action: 'declined'; assignmentId: string; error: string }
  | { action: 'none'; reason: string };

/** The marketplace's worker API, as the agent (`Authorization: Bearer aat_…`). */
export class MarketClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`market ${method} ${path} answered ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  submit = (assignmentId: string, deliverableMarkdown: string) => this.call<unknown>('POST', `/v1/assignments/${encodeURIComponent(assignmentId)}/submit`, { deliverableMarkdown });
  decline = (assignmentId: string, detail: string) => this.call<unknown>('POST', `/v1/assignments/${encodeURIComponent(assignmentId)}/decline`, { reason: 'failed', detail: detail.slice(0, 1000) });
  reply = (assignmentId: string, body: string, clientRequestId: string) =>
    this.call<unknown>('POST', `/v1/assignments/${encodeURIComponent(assignmentId)}/messages`, { body, clientRequestId: clientRequestId.slice(0, 128) });
  job = (jobId: string) => this.call<{ title: string; description: string }>('GET', `/v1/jobs/${encodeURIComponent(jobId)}`);
  /** Newest first. A buyer's message has no `senderAgentId` and is not the platform's own note. */
  async latestBuyerMessage(assignmentId: string): Promise<string | null> {
    const r = await this.call<{ messages: { body: string; origin: string; senderAgentId?: string | null }[] }>('GET', `/v1/assignments/${encodeURIComponent(assignmentId)}/messages`);
    return r.messages.find((m) => !m.senderAgentId && m.origin !== 'platform')?.body ?? null;
  }
}

export type AgentMarketDeps = {
  market: MarketClient | null;
  view: TableView;
  scoutConfig: ScoutConfig;
};

export function depsFromEnv(env: Env): AgentMarketDeps {
  const rpc = env.NEAR_RPC_URL;
  const contract = env.NEAR_TABLE_CONTRACT || DEFAULT_TABLE;
  return {
    market: env.AGENT_MARKET_TOKEN ? new MarketClient((env.AGENT_MARKET_API || DEFAULT_MARKET_API).replace(/\/+$/, ''), env.AGENT_MARKET_TOKEN) : null,
    view: <T>(method: string, args: Record<string, unknown>) => {
      if (!rpc) return Promise.reject(new Error('NEAR_RPC_URL is not set'));
      return viewFunction<T>(rpc, contract, method, args);
    },
    scoutConfig: { contract, appUrl: (env.APP_URL || DEFAULT_APP_URL).replace(/\/+$/, ''), explorer: EXPLORER },
  };
}

/** Caps a report at the market's deliverable size, cutting on a line. */
function fit(md: string): string {
  if (md.length <= MAX_DELIVERABLE) return md;
  const cut = md.slice(0, MAX_DELIVERABLE);
  return `${cut.slice(0, cut.lastIndexOf('\n'))}\n\n_(Report cut to fit the marketplace's size limit.)_\n`;
}

/** The work an event asks for, run after the webhook has been acknowledged. */
export async function handleEvent(ev: MarketEvent, deliveryId: string, deps: AgentMarketDeps): Promise<WorkOutcome> {
  if (ev.event === 'webhook.ping') return { action: 'none', reason: 'ping' };
  const assignmentId = 'assignment_id' in ev ? ev.assignment_id : null;
  const work = ev.event === 'hire.created' || ev.event === 'hire.changes_requested' || ev.event === 'message.created' || (ev.event === 'hire.dispute_resolved' && ev.ruling === 'redo');
  if (!work || !assignmentId) return { action: 'none', reason: ev.event };
  const market = deps.market;
  if (!market) return { action: 'none', reason: 'AGENT_MARKET_TOKEN is not set' };

  if (ev.event === 'message.created') {
    // A question on an in-flight job: answer it on the thread with a fresh report for what was asked.
    const asked = await market.latestBuyerMessage(assignmentId);
    if (!asked) return { action: 'none', reason: 'no buyer message' };
    const report = await scout(asked, deps.view, deps.scoutConfig);
    await market.reply(assignmentId, fit(report.markdown), `scout-${deliveryId}`);
    return { action: 'replied', assignmentId };
  }

  // hire.created carries the brief; rework and a redo ruling re-read the job, plus the buyer's newest note.
  let brief: string;
  if (ev.event === 'hire.created') brief = `${ev.title ?? ''}\n${ev.description ?? ''}`;
  else {
    const job = await market.job(ev.job_id);
    const note = await market.latestBuyerMessage(assignmentId).catch(() => null);
    brief = `${note ?? ''}\n${job.title}\n${job.description}`;
  }
  let markdown: string;
  let agents: string[];
  try {
    ({ markdown, agents } = await scout(brief, deps.view, deps.scoutConfig));
  } catch (e) {
    // The chain could not be read: give the hire back (the buyer is refunded) rather than deliver a guess.
    const error = e instanceof Error ? e.message : String(e);
    if (ev.event === 'hire.created') {
      await market.decline(assignmentId, "The scout couldn't read the Nomad Poker table contract on NEAR testnet just now, so nothing was delivered and you are refunded. Try again in a few minutes.");
      return { action: 'declined', assignmentId, error };
    }
    throw e;
  }
  await market.submit(assignmentId, fit(markdown));
  return { action: 'submitted', assignmentId, agents };
}

// ---------- route ----------

/** Runs `p` after the response when the Worker gives us a context to wait on; otherwise (tests, Node) awaits it. */
async function afterResponse(c: Context<AppEnv>, p: Promise<unknown>): Promise<void> {
  let ctx: { waitUntil(p: Promise<unknown>): void } | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  if (ctx) ctx.waitUntil(p);
  else await p;
}

export function mountAgentMarket(app: Hono<AppEnv>, deps: (env: Env) => AgentMarketDeps = depsFromEnv): void {
  app.post(AGENT_MARKET_WEBHOOK, async (c) => {
    const secret = c.env.AGENT_MARKET_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: { code: 'not_configured', message: 'The agent market webhook is not set up.' } }, 503);
    const raw = await c.req.text();
    const check = await verifyMarketSignature(secret, c.req.header('x-market-timestamp'), c.req.header('x-market-signature'), raw);
    if (check !== 'ok') return c.json({ error: { code: 'bad_signature', message: `Signature ${check}.` } }, 401);

    let ev: MarketEvent;
    try {
      ev = JSON.parse(raw) as MarketEvent;
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'Body is not JSON.' } }, 400);
    }
    const event = typeof ev?.event === 'string' ? ev.event : (c.req.header('x-market-event') ?? 'unknown');
    const deliveryId = c.req.header('x-market-delivery') ?? crypto.randomUUID();
    if (event === 'webhook.ping') return c.json({ ok: true, event, agent: 'nomad-poker-scout' });

    const job = handleEvent(ev, deliveryId, deps(c.env)).then(
      (outcome) => console.log('[agent-market]', event, deliveryId, JSON.stringify(outcome)),
      (e) => console.error('[agent-market]', event, deliveryId, e instanceof Error ? e.message : e),
    );
    await afterResponse(c, job);
    return c.json({ ok: true, event, received: deliveryId });
  });
}
