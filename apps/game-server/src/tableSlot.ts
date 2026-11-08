import type { RoomSpec } from '@nomad/table-server/rooms';
import { isQaRoom, roomSpecFor } from './roomSpec';
import type { HostSocket, LogFn, TableHost } from './tableHost';

export interface TableSlotDeps {
  /** The session (room) name this slot serves: its Durable Object name. */
  session: string;
  /** Was this party room spawned? (persisted by the Durable Object) */
  isSpawned(): Promise<boolean>;
  qaRooms: boolean;
  /** Time scale for qa rooms. */
  qaSpeed: number;
  createHost(spec: RoomSpec, speed: number): TableHost;
  log: LogFn;
}

/**
 * Everything one table's Durable Object does, minus the Durable Object: sockets that arrive before the table exists,
 * opening the table on the first `join`, idle close, drain, and the questions other tables ask. Runtime-neutral, so
 * the Node tests run the same code behind a stand-in Worker.
 */
export class TableSlot {
  private host: TableHost | null = null;
  private opening: Promise<TableHost | { reason: string; message: string }> | null = null;
  private readonly attached = new Map<HostSocket, TableHost>();

  constructor(private readonly deps: TableSlotDeps) {}

  get session(): string {
    return this.deps.session;
  }

  get live(): TableHost | null {
    return this.host && !this.host.isClosed ? this.host : null;
  }

  occupancy(): { open: boolean; players: number; full: boolean } {
    const h = this.live;
    return { open: !!h, players: h?.playerCount ?? 0, full: h?.isFull ?? false };
  }

  holds(playerId: string, tableId: string): boolean {
    return this.live?.holds(playerId, tableId) ?? false;
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

  private open(): Promise<TableHost | { reason: string; message: string }> {
    const live = this.live;
    if (live) return Promise.resolve(live);
    this.opening ??= (async () => {
      try {
        const spec = roomSpecFor(this.deps.session, { spawned: await this.deps.isSpawned(), qaRooms: this.deps.qaRooms });
        if (!spec.ok) return { reason: spec.reason, message: spec.message };
        const speed = isQaRoom(this.deps.session) ? Math.max(1, this.deps.qaSpeed) : 1;
        this.host = this.deps.createHost(spec.spec, speed);
        this.deps.log('info', `opened (${spec.spec.kind}${speed > 1 ? `, ${speed}x` : ''}), table ${this.host.game.tableId}`);
        return this.host;
      } finally {
        this.opening = null;
      }
    })();
    return this.opening;
  }
}
