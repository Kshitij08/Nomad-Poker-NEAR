import type { AgentRow } from '@nomad/db/agents';
import type { RoomSpec } from '@nomad/table-server/rooms';
import { isQaRoom, qaSpeed, roomSpecFor } from './roomSpec';
import type { HostSocket, LogFn, RoomHost } from './roomHost';

export interface TableSlotDeps {
  /** The session (room) name this slot serves: its Durable Object name. */
  session: string;
  /** Was this party room spawned? (persisted by the Durable Object) */
  isSpawned(): Promise<boolean>;
  qaRooms: boolean;
  /** Time scale for qa rooms. */
  qaSpeed: number;
  /** Builds what the room hosts: a cash table, or a tournament (which looks its record up first, hence async). */
  createHost(spec: RoomSpec, speed: number): RoomHost | Promise<RoomHost>;
  log: LogFn;
}

/**
 * Everything one table's Durable Object does, minus the Durable Object: sockets that arrive before the table exists,
 * opening the table on the first `join`, idle close, drain, and the questions other tables ask. Runtime-neutral, so
 * the Node tests run the same code behind a stand-in Worker.
 */
export class TableSlot {
  private host: RoomHost | null = null;
  private opening: Promise<RoomHost | { reason: string; message: string }> | null = null;
  private readonly attached = new Map<HostSocket, RoomHost>();

  constructor(private readonly deps: TableSlotDeps) {}

  get session(): string {
    return this.deps.session;
  }

  get live(): RoomHost | null {
    return this.host && !this.host.isClosed ? this.host : null;
  }

  occupancy(): { open: boolean; players: number; full: boolean } {
    const h = this.live;
    return { open: !!h, players: h?.playerCount ?? 0, full: h?.isFull ?? false };
  }

  holds(playerId: string, tableId: string): boolean {
    return this.live?.holds(playerId, tableId) ?? false;
  }

  /** Seats a queued Agent here, opening the table if it isn't running (an Agent keeps a Quick Play table alive). */
  async seatAgent(row: AgentRow): Promise<{ seated: boolean; reason?: string }> {
    const opened = await this.open();
    if ('reason' in opened) return { seated: false, reason: opened.message };
    return { seated: await opened.seatAgent(row) };
  }

  stopAgent(deploymentId: string): boolean {
    return this.live?.agents?.stop(deploymentId) ?? false;
  }

  holdsAgent(deploymentId: string): boolean {
    return this.live?.agents?.holds(deploymentId) ?? false;
  }

  /** Something here needs the object kept awake (players connected, or Agents playing). */
  get busy(): boolean {
    return this.live?.keepAwake ?? false;
  }

  /** Opens the room without a socket (the cron opening a tournament room before its start). */
  async ensureOpen(): Promise<{ ok: boolean; message?: string }> {
    const opened = await this.open();
    return 'reason' in opened ? { ok: false, message: opened.message } : { ok: true };
  }

  /** Keeps Agent rows fresh while the table runs (the stale-Agent sweep leaves them alone). */
  touchAgents(): void {
    this.live?.agents?.touch();
  }

  /** A text frame from a socket. Before the table exists only `ping` and `join` mean anything. */
  async message(sock: HostSocket, text: string): Promise<void> {
    let host = this.attached.get(sock) ?? null;
    if (!host || host.isClosed) {
      let m: { t?: string; t0?: number } | null = null;
      try {
        m = JSON.parse(text);
      } catch {
        return;
      }
      if (m?.t === 'ping') return sock.send(JSON.stringify({ t: 'pong', t0: m.t0 ?? 0 }));
      if (m?.t !== 'join') return;
      const opened = await this.open();
      if ('reason' in opened) return sock.send(JSON.stringify({ t: 'joinFailed', reason: opened.reason, message: opened.message }));
      host = opened;
      host.connect(sock);
      this.attached.set(sock, host);
    }
    host.message(sock, text);
  }

  disconnect(sock: HostSocket): void {
    const host = this.attached.get(sock);
    this.attached.delete(sock);
    host?.disconnect(sock);
  }

  /** Closes the table once it has idled empty long enough. True when it closed. */
  async sweepIdle(): Promise<boolean> {
    const h = this.live;
    if (!h || !h.idleExpired()) return false;
    await h.close('idle');
    this.host = null;
    return true;
  }

  async drain(): Promise<void> {
    const h = this.live;
    if (h) await h.drain();
    this.host = null;
  }

  private open(): Promise<RoomHost | { reason: string; message: string }> {
    const live = this.live;
    if (live) return Promise.resolve(live);
    this.opening ??= (async () => {
      try {
        const spec = roomSpecFor(this.deps.session, { spawned: await this.deps.isSpawned(), qaRooms: this.deps.qaRooms });
        if (!spec.ok) return { reason: spec.reason, message: spec.message };
        const speed = isQaRoom(this.deps.session) ? qaSpeed(this.deps.session, this.deps.qaSpeed) : 1;
        try {
          this.host = await this.deps.createHost(spec.spec, speed);
        } catch (e) {
          return { reason: 'GameNotFound', message: (e as Error).message };
        }
        this.deps.log('info', `opened (${spec.spec.kind}${speed > 1 ? `, ${speed}x` : ''}), ${this.host.label}`);
        return this.host;
      } finally {
        this.opening = null;
      }
    })();
    return this.opening;
  }
}
