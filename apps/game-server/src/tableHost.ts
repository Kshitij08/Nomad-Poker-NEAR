import { recordHand as recordHandProgress } from '@nomad/db/progress';
import { closeTableSession, openTableSession, recordHand, type SeatLockRow } from '@nomad/db/seatLocks';
import type { ServerClock } from '@nomad/table-server/clock';
import { PokerServerGame, type SettledHand } from '@nomad/table-server/pokerServerGame';
import { encodeMessage, type ClientMessage, type ServerMessage } from '@nomad/table-server/protocol';
import { Room, type Peer, type RoomSpec } from '@nomad/table-server/rooms';
import { ChainTableMode, LOCAL_APP_VERSION } from '@nomad/table-server/sessions';
import { PLAYER_NONE, type IPokerTableServer } from '@nomad/table-server/tableNet';
import type { TableSettings } from '@nomad/engine/orchestration/tableSettings';
import { BettingRound } from '@nomad/engine/state/state';
import { D1ChipLedger, d1TableEconomy } from './d1ChipLedger';
import type { HandRecorder } from './handRecorder';
import { canonicalSession } from './roomSpec';

export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

/** One client socket, whatever the runtime (a Durable Object WebSocket, a `ws` socket in tests). */
export interface HostSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface TableHostOptions {
  spec: RoomSpec;
  db: D1Database;
  clock: ServerClock;
  log: LogFn;
  /** Is this lock's seat still held by a live table (another room's Durable Object)? */
  stillSeatedElsewhere: (lock: SeatLockRow) => Promise<boolean>;
  recorder?: HandRecorder;
  tableSettings?: Partial<TableSettings>;
  random?: () => number;
  disconnectGrace?: number;
}

/** A Room that also hands every event it sends to the hand recorder. */
class RecordingRoom extends Room {
  constructor(spec: RoomSpec, server: IPokerTableServer, clock: ServerClock, log: LogFn, private readonly recorder?: HandRecorder) {
    super(spec, server, clock, log);
  }
  override broadcastEvent(payload: Uint8Array): void {
    this.recorder?.event(0, payload);
    super.broadcastEvent(payload);
  }
  override sendEventTo(player: number, payload: Uint8Array): void {
    this.recorder?.event(player, payload);
    super.sendEventTo(player, payload);
  }
}

/**
 * One table: the Room (connections, chat, voice signalling) around PokerServerGame, with its chips on the D1 ledger.
 * Runtime-neutral, so the Durable Object and the Node tests host the same thing.
 */
export class TableHost {
  readonly room: Room;
  readonly game: PokerServerGame;
  private readonly peers = new Map<HostSocket, Peer>();
  private nextPeer = 1;
  private draining = false;
  private closed = false;
  /** D1 bookkeeping (table session row, house totals) runs in order, with retries, off the game loop. */
  private bookkeeping: Promise<void> = Promise.resolve();

  constructor(private readonly opts: TableHostOptions) {
    const room = opts.spec.name;
    const ledger = new D1ChipLedger(opts.db, room, (lock) => this.stillSeated(lock), opts.log);
    this.game = new PokerServerGame({
      clock: opts.clock,
      log: opts.log,
      economy: d1TableEconomy(ledger),
      settings: opts.tableSettings,
      random: opts.random,
      disconnectGrace: opts.disconnectGrace,
      onHandSettled: (h) => this.onHandSettled(h),
    });
    this.room = new RecordingRoom(opts.spec, this.game, opts.clock, opts.log, opts.recorder);
    this.game.activate(this.room);
    const tableId = this.game.tableId;
    if (tableId) {
      const stake = Number(opts.spec.properties[ChainTableMode.StakeProperty]) || 0;
      this.queue(`open ${tableId}`, () => openTableSession(opts.db, { id: tableId, room, stake }));
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get playerCount(): number {
    return this.room.players.size;
  }

  get isFull(): boolean {
    return this.room.isFull;
  }

  /** True while this table holds `playerId`'s seat for table session `tableId`. */
  holds(playerId: string, tableId: string): boolean {
    return !this.closed && this.game.tableId === tableId && this.game.holdsSeatFor(playerId);
  }

  /** Between hands: no betting round running and nothing in the pot. */
  get betweenHands(): boolean {
    const t = this.game.pokerEngine?.table;
    return !t || (t.round === BettingRound.None && t.pot === 0);
  }

  idleExpired(): boolean {
    return this.room.idleExpired();
  }

  // ---- Sockets ---------------------------------------------------------------------------------

  connect(sock: HostSocket): void {
    const peer: Peer = {
      id: this.nextPeer++,
      room: null,
      player: PLAYER_NONE,
      sendBinary: (bytes) => sock.send(bytes),
      sendJson: (msg: ServerMessage) => sock.send(encodeMessage(msg)),
      close: () => sock.close(1000, 'closed'),
    };
    this.peers.set(sock, peer);
  }

  message(sock: HostSocket, text: string): void {
    const peer = this.peers.get(sock);
    if (!peer) return;
    let m: ClientMessage;
    try {
      m = JSON.parse(text) as ClientMessage;
    } catch {
      return;
    }
    if (!m || typeof m !== 'object' || typeof (m as { t?: unknown }).t !== 'string') return;
    switch (m.t) {
      case 'ping':
        peer.sendJson({ t: 'pong', t0: m.t0 });
        return;
      case 'join':
        this.join(peer, m.session, m.appVersion);
        return;
      case 'spawnRoom':
      case 'requestOverflow':
        // Session-layer requests are HTTP on the game server (POST /v1/tables/spawn, /overflow).
        return;
      default:
        if (peer.room) peer.room.handle(peer, m);
    }
  }

  disconnect(sock: HostSocket): void {
    const peer = this.peers.get(sock);
    this.peers.delete(sock);
    if (peer?.room) peer.room.remove(peer);
  }

  private join(peer: Peer, session: string, appVersion: string): void {
    const fail = (reason: 'GameIsFull' | 'GameNotFound' | 'GameClosed', message: string) => peer.sendJson({ t: 'joinFailed', reason, message });
    if (appVersion && appVersion !== LOCAL_APP_VERSION) return fail('GameNotFound', `No session '${session}' in universe '${appVersion}'.`);
    if (canonicalSession(session) !== this.opts.spec.name) return fail('GameNotFound', `This connection is for '${this.opts.spec.name}'.`);
    if (this.closed || this.draining) return fail('GameClosed', 'This table is closing; try again in a moment.');
    if (peer.room) return; // already joined on this socket
    if (this.room.isFull) return fail('GameIsFull', `Session '${session}' is full.`);
    this.room.admit(peer);
    peer.sendJson({
      t: 'joined',
      session: this.room.sessionName,
      player: peer.player,
      kind: this.opts.spec.kind,
      region: ChainTableMode.DedicatedRegion,
      properties: { ...this.opts.spec.properties },
    });
  }

  // ---- Lifecycle -------------------------------------------------------------------------------

  /** Stop taking players, let the current hand finish (up to `maxSeconds`), then pay everyone out and close. */
  async drain(reason = 'server restarting', maxSeconds = 90): Promise<void> {
    if (this.closed) return;
    this.draining = true;
    const deadline = this.opts.clock.now() + maxSeconds;
    while (!this.betweenHands && this.opts.clock.now() < deadline) await this.opts.clock.wait(0.25);
    await this.close(reason);
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const tableId = this.game.tableId;
    this.room.close(reason); // disposes the game: every seated player is cashed out
    if (tableId) this.queue(`close ${tableId}`, () => closeTableSession(this.opts.db, tableId));
    await Promise.all([this.bookkeeping, this.opts.recorder?.flush()]);
  }

  /** Resolves when the queued D1 bookkeeping has been written (tests, drain). */
  settled(): Promise<void> {
    return this.bookkeeping;
  }

  private onHandSettled(h: SettledHand): void {
    this.opts.recorder?.settled(h);
    if (h.tableId) {
      const tableId = h.tableId;
      this.queue(`hand ${h.handNumber}`, () => recordHand(this.opts.db, tableId, h.botDelta));
      // XP and missions for every Nomad player dealt in (the server counts; clients cannot claim hands).
      for (const s of h.stacks) {
        if (s.bot || !s.id.startsWith('p_')) continue;
        this.queue(`progress ${s.id} hand ${h.handNumber}`, async () => {
          await recordHandProgress(this.opts.db, s.id, { tableId, hand: h.handNumber, won: s.won, showdownCategory: s.showdownCategory, net: s.stack - s.startStack });
        });
      }
    }
  }

  private queue(label: string, fn: () => Promise<void>): void {
    this.bookkeeping = this.bookkeeping.then(async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await fn();
          return;
        } catch (e) {
          if (attempt >= 4) {
            this.opts.log('error', `[TableHost] ${label} failed after ${attempt} tries: ${(e as Error).message}`);
            return;
          }
          await this.opts.clock.wait(0.5 * attempt);
        }
      }
    });
  }

  private async stillSeated(lock: SeatLockRow): Promise<boolean> {
    if (lock.room === this.opts.spec.name) return this.holds(lock.player_id, lock.table_id);
    try {
      return await this.opts.stillSeatedElsewhere(lock);
    } catch (e) {
      // Can't tell: keep the lock (refusing a buy-in beats paying a live stack twice).
      this.opts.log('warn', `[TableHost] could not ask ${lock.room} about ${lock.player_id}: ${(e as Error).message}`);
      return true;
    }
  }
}
