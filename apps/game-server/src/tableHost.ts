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
import { NearChipLedger } from './nearChipLedger';
import type { NearOperator } from './nearOperator';
import type { DeckReveal } from '@nomad/engine/cards/deckCommitment';
import { isNearMoneyRoom } from './roomSpec';
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
  /**
   * Commit to every deck before the deal and reveal the seed after (PokerServerGameOptions.deckCommitments): the
   * commitment rides on HandStarted, the reveal lands in the R2 hand record. Off by default (Coins tables).
   */
  deckCommitments?: boolean;
  /** How long a failing bookkeeping write is retried (default BOOKKEEPING_RETRY_MS). */
  bookkeepingRetryMs?: number;
  /**
   * NEAR money tables (`poker-money-…` rooms): the escrow holds the stakes and this server is its operator. Such a table
   * seats players only (no bots or Agents), commits every deck, and keeps recent reveals for the Verify panel.
   */
  near?: { operator: Pick<NearOperator, 'view' | 'call'>; escrow: string };
}

/** How many settled hands' deck reveals a NEAR table keeps for GET …/hands/{n}/deck. */
export const KEPT_REVEALS = 200;

/** Ten minutes: long enough to ride out a D1 export or restart, short enough that a drain still finishes. */
export const BOOKKEEPING_RETRY_MS = 10 * 60_000;

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
  private readonly retryMs: number;
  /** A NEAR money table (escrow stakes). */
  readonly money: boolean;
  private readonly reveals = new Map<number, DeckReveal>();

  constructor(private readonly opts: TableHostOptions) {
    super(opts.spec);
    this.retryMs = opts.bookkeepingRetryMs ?? BOOKKEEPING_RETRY_MS;
    const room = opts.spec.name;
    this.money = isNearMoneyRoom(room) && !!opts.near;
    const ledger = this.money
      ? new NearChipLedger(opts.db, opts.near!.operator, opts.near!.escrow, room, opts.log)
      : new D1ChipLedger(opts.db, room, (lock) => this.stillSeated(lock), opts.log);
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
      deckCommitments: opts.deckCommitments,
      ...(this.money
        ? {
            tableId: room,
            exactBuyIn: true,
            handGate: {
              beforeDeal: async () => true,
              afterSettle: async (h: SettledHand) => {
                if (h.deck) {
                  this.reveals.set(h.handNumber, h.deck);
                  if (this.reveals.size > KEPT_REVEALS) this.reveals.delete(this.reveals.keys().next().value!);
                }
                return true;
              },
            },
          }
        : {}),
      onHandSettled: (h) => this.onHandSettled(h),
      agentHooks: this.agents,
      onEngineEvent: (e) => this.style.observe(e),
    });
    this.agents.bind(this.game);
    this.room = new RecordingRoom(opts.spec, this.game, opts.clock, opts.log, opts.recorder);
    this.game.activate(this.room);
    const tableId = this.game.tableId;
    // A NEAR table's id is its room name (the escrow's table), the same every time it opens: no D1 table session.
    if (tableId && !this.money) {
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
  override get seatedCount(): number {
    return this.game.seatedPlayers;
  }

  override get agentCount(): number {
    return this.game.agentCount;
  }

  override deckReveal(handNumber: number): DeckReveal | null {
    return this.reveals.get(handNumber) ?? null;
  }

  override seatAgent(row: AgentRow): Promise<boolean> {
    if (this.closed || this.draining || !this.game.isQuickPlay || this.money) return Promise.resolve(false);
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
    if (tableId && !this.money) this.queue(`close ${tableId}`, () => closeTableSession(this.opts.db, tableId));
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
      if (!this.money) this.queue(`hand ${h.handNumber}`, () => recordHand(this.opts.db, tableId, h.botDelta, h.agentDelta));
      // Suspended accounts leave at the hand boundary (a ban ends sessions; this ends a seat already taken).
      const humans = h.stacks.filter((s) => !s.bot && s.id.startsWith('p_')).map((s) => s.id);
      if (humans.length) {
        this.queue(`ban check hand ${h.handNumber}`, async () => {
          const r = await this.opts.db
            .prepare(`SELECT id FROM players WHERE banned_at IS NOT NULL AND id IN (${humans.map((_, i) => `?${i + 1}`).join(', ')})`)
            .bind(...humans)
            .all<{ id: string }>();
          for (const b of r.results) this.game.removePlayer(b.id, 'account suspended');
        });
      }
      // XP and missions for every Nomad player dealt in (the server counts; clients cannot claim hands).
      for (const s of h.stacks) {
        if (s.bot || !s.id.startsWith('p_')) continue;
        this.queue(`progress ${s.id} hand ${h.handNumber}`, async () => {
          await recordHandProgress(this.opts.db, s.id, { tableId, hand: h.handNumber, won: s.won, showdownCategory: s.showdownCategory, net: s.stack - s.startStack });
        });
      }
    }
  }

  /**
   * Runs D1 bookkeeping in order, off the game loop. A write is retried with backoff (0.5 s doubling to 15 s) for up to
   * BOOKKEEPING_RETRY_MS of real time before it is given up and logged: D1 can be unavailable for seconds (an export, a
   * restart), and a dropped house-result write shows up as table drift (load test, 9 Nov). Real-time waits, not the
   * table's clock, which runs faster in QA rooms.
   */
  private queue(label: string, fn: () => Promise<void>): void {
    this.bookkeeping = this.bookkeeping.then(async () => {
      const started = Date.now();
      for (let attempt = 1; ; attempt++) {
        try {
          await fn();
          if (attempt > 1) this.opts.log('warn', `[TableHost] ${label} written after ${attempt} tries (${Date.now() - started} ms)`);
          return;
        } catch (e) {
          if (Date.now() - started >= this.retryMs) {
            this.opts.log('error', `[TableHost] ${label} GAVE UP after ${attempt} tries over ${Date.now() - started} ms: ${(e as Error).message}`);
            return;
          }
          await new Promise((r) => setTimeout(r, Math.min(15_000, 500 * 2 ** (attempt - 1))));
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
