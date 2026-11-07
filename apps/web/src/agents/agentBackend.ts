/**
 * Where the client's Agent calls go. Unity's AgentDeployService talks to the Railway backend's /api/agent/* routes; the
 * web port defaults to `LocalAgentBackend` (Unity's AgentLocalEditorBackend idea, taken all the way): the farm and its
 * tables run in this tab, the Agent plays real hands against filler bots with its own strategy, and everything is saved
 * in localStorage so a reload (or a closed tab) carries on. `HttpAgentBackend` is the faithful port of the real calls;
 * it is only used when explicitly configured (`?agentBackend=<url>`), never by default.
 */
import type {
  AgentDeploymentProgress, AgentDeploymentSummary, AgentHandHistory, AgentSessionHistory,
} from '../core/agents';
import { AgentFarm, AgentFarmError, type AgentMoney, type AgentStartRequest } from './server/agentFarm';
import { LocalAgentRunner } from './server/localAgentRunner';

/** The start response (PartyResponse): an error with no status means nothing was queued. */
export interface AgentStartResponse {
  session?: string;
  status?: string;
  kind?: string;
  error?: string;
}

export interface AgentBackend {
  readonly kind: 'local' | 'http';
  /** The signed-in player's token for the agent routes (TournamentApiClient.SignInTokenAsync); null = signed out. */
  signInToken(): Promise<string | null>;
  start(req: AgentStartRequest): Promise<AgentStartResponse>;
  /** Null: unreachable / unknown. */
  progress(session: string, ownerId: string): Promise<AgentDeploymentProgress | null>;
  /** Null on success (the progress after the stop, when known, is returned too); else a player-facing error. */
  stop(session: string, ownerId: string): Promise<{ error: string | null; progress: AgentDeploymentProgress | null }>;
  result(session: string, ownerId: string): Promise<AgentDeploymentSummary | null>;
  active(ownerId: string): Promise<{ deploymentId: string; bankroll: number } | null>;
  history(ownerId: string, limit: number, offset: number): Promise<AgentSessionHistory | null>;
  hands(ownerId: string, deploymentId: string, limit: number, offset: number): Promise<AgentHandHistory | null>;
  /** Releases timers. */
  dispose(): void;
}

// ---- local ---------------------------------------------------------------------------------------------------------

export const LOCAL_FARM_KEY = 'web.agents.farm';

export interface LocalAgentBackendOptions {
  money: AgentMoney | null;
  load(): string | null;
  save(json: string): void;
  handSeconds?: number;
  /** Called after the farm changed (a hand was played, an Agent sat or left): the service refreshes its progress. */
  onChanged?: () => void;
  /** Tick interval in ms (default 1000). 0 = never tick on a timer (tests call tick()). */
  tickMs?: number;
  now?: () => number;
  seed?: number | null;
  /**
   * Who runs the tables when several copies share the storage (two tabs, a hot-reloaded module): a lease
   * ({ id, until } JSON) only the holder renews. Omitted: this copy always runs them (tests, a single process).
   */
  lease?: { get(): string | null; set(value: string): void };
  /** This copy is on screen: it takes the tables from a backgrounded holder (whose timers the browser throttles). */
  visible?: () => boolean;
}

/** The lease is held this long without a renewal (a backgrounded tab still ticks about once a second). */
const LEASE_SECONDS = 5;

export class LocalAgentBackend implements AgentBackend {
  readonly kind = 'local' as const;
  readonly farm: AgentFarm;
  readonly runner: LocalAgentRunner;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The snapshot this copy last loaded or saved: storage is the truth, reloaded whenever it differs. */
  private lastJson: string | null = null;
  private leader = false;
  private readonly id = Math.random().toString(36).slice(2);
  private readonly now: () => number;

  constructor(private readonly opts: LocalAgentBackendOptions) {
    const now = (this.now = opts.now ?? (() => Date.now() / 1000));
    this.farm = AgentFarm.restore(opts.load(), {
      now: () => Math.floor(now()),
      money: opts.money,
      joinWaitSeconds: 0, // one player's farm: no other Agents to wait for
      maxHandsKept: 200,
      maxSessionsKept: 30,
    });
    this.lastJson = opts.load();
    this.runner = new LocalAgentRunner({ farm: this.farm, handSeconds: opts.handSeconds, now, seed: opts.seed });
    const ms = opts.tickMs ?? 1000;
    if (ms > 0) this.timer = setInterval(() => this.tick(), ms);
  }

  /** One pass: the lease holder runs the tables; every copy picks up what the others saved. */
  tick(): void {
    const reloaded = this.sync();
    let changed = reloaded;
    const leader = this.holdLease();
    if (leader !== this.leader) {
      this.leader = leader;
      if (!leader) this.runner.reset(); // another copy runs the tables now; it adopts the Agents
    }
    if (leader) {
      try {
        changed = this.runner.tick() || changed;
      } catch (e) {
        console.warn('[agents] local farm tick failed: ' + String(e));
      }
      this.save();
    }
    if (changed) this.opts.onChanged?.();
  }

  /** Reloads the farm when the storage holds a snapshot this copy didn't write. True when it did. */
  private sync(): boolean {
    let json: string | null;
    try {
      json = this.opts.load();
    } catch {
      return false;
    }
    if (json === this.lastJson) return false;
    this.farm.load(json);
    this.lastJson = json;
    return true;
  }

  private holdLease(): boolean {
    const lease = this.opts.lease;
    if (!lease) return true;
    const now = this.now();
    try {
      const visible = this.opts.visible?.() ?? false;
      const cur = JSON.parse(lease.get() ?? 'null') as { id: string; until: number; visible?: boolean } | null;
      if (cur && cur.id !== this.id && cur.until > now && !(visible && !cur.visible)) return false;
      lease.set(JSON.stringify({ id: this.id, until: now + LEASE_SECONDS, visible }));
      return true;
    } catch {
      return true;
    }
  }

  /** Load the latest, change, save: every owner call is a read-modify-write of the storage. */
  private edit<T>(fn: () => T): T {
    this.sync();
    try {
      return fn();
    } finally {
      this.save();
    }
  }

  private save(): void {
    try {
      const json = this.farm.snapshot();
      if (json === this.lastJson) return;
      this.opts.save(json);
      this.lastJson = json;
    } catch {
      /* storage full / blocked: keep playing in memory */
    }
  }

  async signInToken(): Promise<string | null> {
    return 'local';
  }

  async start(req: AgentStartRequest): Promise<AgentStartResponse> {
    try {
      const r = this.edit(() => this.farm.start(req, req.ownerId));
      this.tick(); // claim it right away: "Looking for a table" → seated
      return r;
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  async progress(session: string, ownerId: string): Promise<AgentDeploymentProgress | null> {
    this.sync();
    return wrap(() => this.farm.progress(session, ownerId));
  }

  async stop(session: string, ownerId: string): Promise<{ error: string | null; progress: AgentDeploymentProgress | null }> {
    try {
      const progress = this.edit(() => this.farm.stop(session, ownerId));
      return { error: null, progress };
    } catch (e) {
      return { error: e instanceof AgentFarmError ? e.message : 'Could not reach the agent table.', progress: null };
    }
  }

  async result(session: string, ownerId: string): Promise<AgentDeploymentSummary | null> {
    this.sync();
    return wrap(() => this.farm.result(session, ownerId));
  }

  async active(ownerId: string): Promise<{ deploymentId: string; bankroll: number } | null> {
    this.sync();
    return wrap(() => this.farm.active(ownerId));
  }

  async history(ownerId: string, limit: number, offset: number): Promise<AgentSessionHistory | null> {
    this.sync();
    return wrap(() => this.farm.history(ownerId, limit, offset));
  }

  async hands(ownerId: string, deploymentId: string, limit: number, offset: number): Promise<AgentHandHistory | null> {
    this.sync();
    return wrap(() => this.farm.hands(ownerId, deploymentId, limit, offset));
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.leader) this.save();
    if (this.leader && this.opts.lease) this.opts.lease.set('null'); // hand the tables over at once
  }
}

function wrap<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

// ---- http (the real backend; off unless configured) -------------------------------------------------------------------

/** The backend's error message ({"error": "..."}), not its raw JSON (AgentDeployService.ErrorOf). */
async function errorOf(res: Response, fallback: string): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return fallback;
    try {
      const e = JSON.parse(text) as { error?: string };
      if (e?.error) return e.error;
    } catch {
      /* not JSON */
    }
    return text;
  } catch {
    return fallback;
  }
}

export class HttpAgentBackend implements AgentBackend {
  readonly kind = 'http' as const;

  constructor(private readonly baseUrl: string, private readonly token: () => Promise<string | null>) {}

  signInToken(): Promise<string | null> {
    return this.token();
  }

  private url(path: string, q: Record<string, string | number> = {}): string {
    const qs = Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
    return `${this.baseUrl.replace(/\/+$/, '')}${path}${qs ? '?' + qs : ''}`;
  }

  private async headers(json = false): Promise<Record<string, string>> {
    const h: Record<string, string> = {};
    if (json) h['Content-Type'] = 'application/json';
    const t = await this.token();
    if (t) h.Authorization = 'Bearer ' + t;
    return h;
  }

  private async get<T>(path: string, q: Record<string, string | number>): Promise<T | null> {
    try {
      const res = await fetch(this.url(path, q), { headers: await this.headers(), signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  async start(req: AgentStartRequest): Promise<AgentStartResponse> {
    try {
      const res = await fetch(this.url('/api/agent/start'), {
        method: 'POST', headers: await this.headers(true), body: JSON.stringify(req), signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { error: await errorOf(res, 'Could not reach the Agent service.') };
      try {
        return (await res.json()) as AgentStartResponse;
      } catch {
        return { error: 'Bad agent start response.' };
      }
    } catch {
      return { error: 'Could not reach the Agent service.' };
    }
  }

  progress(session: string, ownerId: string): Promise<AgentDeploymentProgress | null> {
    return this.get('/api/agent/progress', { session, ownerId });
  }

  async stop(session: string, ownerId: string): Promise<{ error: string | null; progress: AgentDeploymentProgress | null }> {
    try {
      const res = await fetch(this.url('/api/agent/stop'), {
        method: 'POST', headers: await this.headers(true), body: JSON.stringify({ session, ownerId }), signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { error: await errorOf(res, 'Could not reach the agent table.'), progress: null };
      let progress: AgentDeploymentProgress | null = null;
      try {
        progress = (await res.json()) as AgentDeploymentProgress;
      } catch {
        /* keep the previous snapshot */
      }
      return { error: null, progress };
    } catch {
      return { error: 'Could not reach the agent table.', progress: null };
    }
  }

  result(session: string, ownerId: string): Promise<AgentDeploymentSummary | null> {
    return this.get('/api/agent/result', { session, ownerId });
  }

  async active(ownerId: string): Promise<{ deploymentId: string; bankroll: number } | null> {
    const r = await this.get<{ active: { deploymentId: string; bankroll: number } | null }>('/api/agent/active', { ownerId });
    return r?.active ?? null;
  }

  history(ownerId: string, limit: number, offset: number): Promise<AgentSessionHistory | null> {
    return this.get('/api/agent/history', { ownerId, limit: Math.max(1, Math.min(limit, 100)), offset: Math.max(0, offset) });
  }

  hands(ownerId: string, deploymentId: string, limit: number, offset: number): Promise<AgentHandHistory | null> {
    if (!deploymentId.trim()) return Promise.resolve(null);
    return this.get('/api/agent/hands', { ownerId, deploymentId, limit: Math.max(1, Math.min(limit, 100)), offset: Math.max(0, offset) });
  }

  dispose(): void {}
}
