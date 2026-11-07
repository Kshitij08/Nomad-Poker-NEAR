/**
 * One connection to the local table server — the NetworkRunner of the Unity client. Works with the browser's
 * WebSocket and Node 22's global WebSocket (the headless test clients). Binary frames are table events (C# codec
 * bytes); text frames are JSON control messages (see shared/protocol.ts).
 */
import { encodeMessage, type ClientMessage, type JoinFailReason, type ServerMessage } from './shared/protocol';
import { LOCAL_APP_VERSION } from './shared/sessions';

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

  constructor(readonly url: string) {}

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** Half the measured round trip (runner.GetPlayerRtt × 0.5), in seconds. */
  get oneWayLatency(): number {
    return Math.max(0, this.rttSeconds * 0.5);
  }

  open(timeoutMs = 5000): Promise<void> {
    if (this.isOpen) return Promise.resolve();
    this.closedByUs = false;
    return new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      // Dev builds name the local server; a deployed build just says multiplayer isn't available (no raw browser
      // errors such as the HTTPS page → ws:// "insecure WebSocket" refusal).
      const unavailable = (detail: string) =>
        new Error(import.meta.env.DEV ? `${detail} Start it with \`npm run server\` in web/.` : 'The multiplayer table server is not available right now.');
      try {
        ws = new WebSocket(this.url);
      } catch {
        reject(unavailable(`Could not open a connection to the table server at ${this.url}.`));
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(unavailable(`The table server at ${this.url} did not answer.`));
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
        reject(unavailable(`Could not reach the table server at ${this.url}.`));
      };
      ws.onclose = () => {
        clearTimeout(timer);
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
    await this.open();
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
    await this.open();
    const reply = this.await((m) => (m.t === 'roomReady' ? m : undefined), 8000);
    this.send({ t: 'spawnRoom', code, money });
    const r = await reply;
    if (!r) return 'The table server did not answer.';
    return r.error ?? null;
  }

  /** PokerPartyClient.RequestOverflowAsync. */
  async requestOverflow(money: boolean, failed: string, minBuyIn: number): Promise<{ session?: string; error?: string }> {
    await this.open();
    const reply = this.await((m) => (m.t === 'overflow' ? m : undefined), 8000);
    this.send({ t: 'requestOverflow', money, failed, minBuyIn });
    const r = await reply;
    return r ? { session: r.session, error: r.error } : { error: 'The table server did not answer.' };
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
