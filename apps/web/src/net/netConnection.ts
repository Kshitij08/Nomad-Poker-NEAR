/**
 * One connection to a table server — the NetworkRunner of the Unity client. Two servers speak this protocol:
 * - the local Node server (`ws://…`): one socket for everything; `join` / `spawnRoom` / `requestOverflow` ride it;
 * - the game server on Cloudflare (`https://…`): one socket per table (`/v1/tables/ws?session=`, a Durable
 *   Object each), and the session-layer requests are HTTP (`/v1/tables/spawn`, `/v1/tables/overflow`).
 * The rest is identical. Works with the browser's
 * WebSocket and Node 22's global WebSocket (the headless test clients). Binary frames are table events (C# codec
 * bytes); text frames are JSON control messages (see shared/protocol.ts).
 */
import { encodeMessage, type ClientMessage, type JoinFailReason, type ServerMessage } from '@nomad/table-server/protocol';
import { LOCAL_APP_VERSION } from '@nomad/table-server/sessions';

export interface JoinResult {
  ok: boolean;
  session?: string;
  player?: number;
  kind?: string;
  region?: string;
  properties?: Record<string, string>;
  reason?: JoinFailReason | 'Disconnected';
  message?: string;
}

type Listener<T> = (v: T) => void;

export class NetConnection {
  private ws: WebSocket | null = null;
  private readonly binaryListeners = new Set<Listener<Uint8Array>>();
  private readonly messageListeners = new Set<Listener<ServerMessage>>();
  private readonly closeListeners = new Set<Listener<string>>();
  private rttSeconds = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Session currently joined (the runner's SessionInfo.Name), or null. */
  session: string | null = null;
  player = 0;
  properties: Record<string, string> = {};
  kind = '';
  region = '';
  private closedByUs = false;
  /** Game-server mode: the https base; sockets open per session. */
  private readonly cloudBase: string | null;

  constructor(readonly url: string) {
    this.cloudBase = /^https?:\/\//i.test(url) ? url.replace(/\/+$/, '') : null;
  }

  /** True for the Cloudflare game server (per-table sockets, Nomad session tickets). */
  get isCloud(): boolean {
    return this.cloudBase !== null;
  }

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** Half the measured round trip (runner.GetPlayerRtt × 0.5), in seconds. */
  get oneWayLatency(): number {
    return Math.max(0, this.rttSeconds * 0.5);
  }

  /** Local server: opens the one socket. Game server: checks it answers (sockets open per table at join). */
  async open(timeoutMs = 5000): Promise<void> {
    if (this.cloudBase) return this.probeCloud(timeoutMs);
    return this.openSocket(this.url, timeoutMs);
  }

  private async probeCloud(timeoutMs: number): Promise<void> {
    try {
      const res = await fetch(`${this.cloudBase}/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return;
    } catch {
      /* fall through */
    }
    throw new Error(import.meta.env?.DEV ? `The game server at ${this.cloudBase} did not answer.` : 'The multiplayer table server is not available right now.');
  }

  private openSocket(url: string, timeoutMs = 5000): Promise<void> {
    if (this.isOpen) return Promise.resolve();
    this.closedByUs = false;
    return new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      // Dev builds name the local server; a deployed build just says multiplayer isn't available (no raw browser
      // errors such as the HTTPS page → ws:// "insecure WebSocket" refusal).
      const unavailable = (detail: string) =>
        new Error(import.meta.env?.DEV ? `${detail} Start it with \`npm run server\` in the repo root.` : 'The multiplayer table server is not available right now.');
      try {
        ws = new WebSocket(url);
      } catch {
        reject(unavailable(`Could not open a connection to the table server at ${url}.`));
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(unavailable(`The table server at ${url} did not answer.`));
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        this.startPing();
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(unavailable(`Could not reach the table server at ${url}.`));
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (this.ws !== ws) return; // a socket we replaced (game server: moving to another table's socket)
        this.stopPing();
        const reason = this.closedByUs ? 'closed' : 'lost';
        this.session = null;
        for (const fn of [...this.closeListeners]) fn(reason);
      };
      ws.onmessage = (ev: MessageEvent) => {
        const data = ev.data as unknown;
        if (typeof data === 'string') {
          let m: ServerMessage;
          try {
            m = JSON.parse(data) as ServerMessage;
          } catch {
            return;
          }
          if (m.t === 'pong') this.rttSeconds = Math.max(0, (now() - m.t0) / 1000);
          for (const fn of [...this.messageListeners]) fn(m);
        } else if (data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(data);
          for (const fn of [...this.binaryListeners]) fn(bytes);
        } else if (ArrayBuffer.isView(data)) {
          const v = data as ArrayBufferView;
          const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
          for (const fn of [...this.binaryListeners]) fn(bytes);
        }
      };
    });
  }

  send(m: ClientMessage): void {
    if (this.isOpen) this.ws!.send(encodeMessage(m));
  }

  onBinary(fn: Listener<Uint8Array>): () => void {
    this.binaryListeners.add(fn);
    return () => this.binaryListeners.delete(fn);
  }

  onMessage(fn: Listener<ServerMessage>): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  onClose(fn: Listener<string>): () => void {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  /** Waits for the first server message matching `pick` (or a close / timeout → null). */
  private await<T>(pick: (m: ServerMessage) => T | undefined, timeoutMs: number): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      const offMsg = this.onMessage((m) => {
        const v = pick(m);
        if (v === undefined) return;
        done(v);
      });
      const offClose = this.onClose(() => done(null));
      const timer = setTimeout(() => done(null), timeoutMs);
      function done(v: T | null) {
        clearTimeout(timer);
        offMsg();
        offClose();
        resolve(v);
      }
    });
  }

  /** NetworkRunner.StartGame(GameMode.Client, session). */
  async join(session: string, timeoutMs = 8000): Promise<JoinResult> {
    if (this.cloudBase) {
      // One socket per table: drop the previous table's socket quietly, open this one's.
      this.replaceSocket();
      try {
        await this.openSocket(`${this.cloudBase.replace(/^http/i, 'ws')}/v1/tables/ws?session=${encodeURIComponent(session)}`);
      } catch (e) {
        return { ok: false, reason: 'Disconnected', message: (e as Error).message };
      }
    } else await this.open();
    const reply = this.await<JoinResult>((m) => {
      if (m.t === 'joined') return { ok: true, session: m.session, player: m.player, kind: m.kind, region: m.region, properties: m.properties };
      if (m.t === 'joinFailed') return { ok: false, reason: m.reason, message: m.message };
      return undefined;
    }, timeoutMs);
    this.send({ t: 'join', session, appVersion: LOCAL_APP_VERSION });
    const r = (await reply) ?? { ok: false, reason: 'Disconnected' as const, message: 'The table server did not answer.' };
    if (r.ok) {
      this.session = r.session!;
      this.player = r.player!;
      this.properties = r.properties ?? {};
      this.kind = r.kind ?? '';
      this.region = r.region ?? '';
    }
    return r;
  }

  /** PokerPartyClient.EnsureDedicatedRoomAsync: null on success, else the error to show. */
  async spawnRoom(code: string, money = false): Promise<string | null> {
    if (this.cloudBase) {
      const r = await this.post<{ code?: string; error?: string }>('/v1/tables/spawn', { code, money });
      return r ? (r.error ?? null) : 'The table server did not answer.';
    }
    await this.open();
    const reply = this.await((m) => (m.t === 'roomReady' ? m : undefined), 8000);
    this.send({ t: 'spawnRoom', code, money });
    const r = await reply;
    if (!r) return 'The table server did not answer.';
    return r.error ?? null;
  }

  /** PokerPartyClient.RequestOverflowAsync. */
  async requestOverflow(money: boolean, failed: string, minBuyIn: number): Promise<{ session?: string; error?: string }> {
    if (this.cloudBase) {
      const r = await this.post<{ session?: string; error?: string }>('/v1/tables/overflow', { money, failed, minBuyIn });
      return r ?? { error: 'The table server did not answer.' };
    }
    await this.open();
    const reply = this.await((m) => (m.t === 'overflow' ? m : undefined), 8000);
    this.send({ t: 'requestOverflow', money, failed, minBuyIn });
    const r = await reply;
    return r ? { session: r.session, error: r.error } : { error: 'The table server did not answer.' };
  }

  private async post<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const res = await fetch(this.cloudBase + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  /** Closes the current socket without reporting a lost connection (it is being replaced). */
  private replaceSocket(): void {
    const old = this.ws;
    this.ws = null;
    this.stopPing();
    this.session = null;
    try {
      old?.close();
    } catch {
      /* ignore */
    }
  }

  /** Runner.Shutdown(): leaves the session (and closes the socket). */
  close(): void {
    this.closedByUs = true;
    this.stopPing();
    this.session = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private startPing(): void {
    this.stopPing();
    const ping = () => this.send({ t: 'ping', t0: now() });
    ping();
    this.pingTimer = setInterval(ping, 2000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
