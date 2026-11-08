import { recordHand as recordHandProgress } from '@nomad/db/progress';
import { closeTableSession, openTableSession, recordHand, type SeatLockRow } from '@nomad/db/seatLocks';
import type { ServerClock } from '@nomad/table-server/clock';
import { PokerServerGame, type SettledHand } from '@nomad/table-server/pokerServerGame';
import { Room, type RoomSpec } from '@nomad/table-server/rooms';
import { ChainTableMode } from '@nomad/table-server/sessions';
import type { IPokerTableServer } from '@nomad/table-server/tableNet';
import type { TableSettings } from '@nomad/engine/orchestration/tableSettings';
import { BettingRound } from '@nomad/engine/state/state';
import type { AgentRow } from '@nomad/db/agents';
import { recordDecisions, recordStyleHands } from '@nomad/db/strategies';
import { AgentDesk } from './agentDesk';
import { StyleRecorder } from './styleRecorder';
import { D1ChipLedger, d1TableEconomy } from './d1ChipLedger';
import type { HandRecorder } from './handRecorder';
import { RoomHost, type LogFn } from './roomHost';

export type { HostSocket, LogFn } from './roomHost';

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
export class TableHost extends RoomHost {
  readonly room: Room;
  readonly game: PokerServerGame;
  /** The owned Agents playing here (seated by the game server, not claimed from a farm). */
  override readonly agents: AgentDesk;
  /** Decisions and outcomes of the Nomad players here (My Twin, the coach). */
  private readonly style: StyleRecorder;
  /** D1 bookkeeping (table session row, house totals) runs in order, with retries, off the game loop. */
  private bookkeeping: Promise<void> = Promise.resolve();

  constructor(private readonly opts: TableHostOptions) {
    super(opts.spec);
    const room = opts.spec.name;
    const ledger = new D1ChipLedger(opts.db, room, (lock) => this.stillSeated(lock), opts.log);
    this.agents = new AgentDesk({
      db: opts.db,
      room,
      log: opts.log,
      clock: () => opts.clock.now(),
      queue: (label, fn) => this.queue(label, fn),
      blinds: () => {
        const t = this.game.pokerEngine?.table;
        return { small: t?.smallBlind ?? 0, big: t?.bigBlind ?? 0 };
      },
    });
    this.style = new StyleRecorder(
      {
        seatCount: () => this.game.seatCount,
        bigBlind: () => this.game.pokerEngine?.table?.bigBlind ?? 0,
        playerAt: (seat) => this.game.pokerEngine?.table?.seats[seat]?.id ?? null,
        isBotAt: (seat) => !!this.game.pokerEngine?.table?.seats[seat]?.isBot,
      },
      room,
    );
    this.game = new PokerServerGame({
      clock: opts.clock,
      log: opts.log,
      economy: d1TableEconomy(ledger),
      settings: opts.tableSettings,
      random: opts.random,
      disconnectGrace: opts.disconnectGrace,
      onHandSettled: (h) => this.onHandSettled(h),
      agentHooks: this.agents,
      onEngineEvent: (e) => this.style.observe(e),
    });
    this.agents.bind(this.game);
    this.room = new RecordingRoom(opts.spec, this.game, opts.clock, opts.log, opts.recorder);
    this.game.activate(this.room);
    const tableId = this.game.tableId;
    if (tableId) {
      const stake = Number(opts.spec.properties[ChainTableMode.StakeProperty]) || 0;
      this.queue(`open ${tableId}`, () => openTableSession(opts.db, { id: tableId, room, stake }));
    }
  }

  get label(): string {
    return `table ${this.game.tableId}`;
  }

  get keepAwake(): boolean {
    return !this.closed && (this.playerCount > 0 || this.agentCount > 0);
  }

  /** True while this table holds `playerId`'s seat for table session `tableId`. */
  override holds(playerId: string, tableId: string): boolean {
    return !this.closed && this.game.tableId === tableId && this.game.holdsSeatFor(playerId);
  }

  /** Between hands: no betting round running and nothing in the pot. */
  get betweenHands(): boolean {
    const t = this.game.pokerEngine?.table;
    return !t || (t.round === BettingRound.None && t.pot === 0);
  }

  /** Empty long enough to close: no players connected and no Agents playing. */
  idleExpired(): boolean {
    return this.game.agentCount === 0 && this.room.idleExpired();
  }

  /** Owned Agents seated here or waiting for a seat. */
  override get agentCount(): number {
    return this.game.agentCount;
  }

  override seatAgent(row: AgentRow): Promise<boolean> {
    if (this.closed || this.draining || !this.game.isQuickPlay) return Promise.resolve(false);
    return this.agents.seat(row);
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
    const decisions = this.style.takeDecisions();
    const styleHands = this.style.handsOf(h);
    if (decisions.length || styleHands.length) {
      this.queue(`style hand ${h.handNumber}`, async () => {
        if (decisions.length) await recordDecisions(this.opts.db, decisions);
        if (styleHands.length) await recordStyleHands(this.opts.db, styleHands);
      });
    }
    if (h.tableId) {
      const tableId = h.tableId;
      this.queue(`hand ${h.handNumber}`, () => recordHand(this.opts.db, tableId, h.botDelta, h.agentDelta));
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
