import type { PlayerAction } from '../../core/actions/actions';
import { HeuristicBot } from '../../core/bots/heuristicBot';
import type { IPokerBot } from '../../core/bots/botContext';
import { AvatarCatalog } from '../../core/social/avatarCatalog';
import {
  MAX_TOURNAMENT_TABLES, TournamentDirector, TournamentPhase, TournamentPlayerState, TournamentRewards, TournamentSpeed,
  TournamentViewReason, blindLevelToString, speedFromString, tournamentResult, tournamentView,
  type PlayersEliminatedCommand, type TableClosedCommand, type TableOpenedCommand, type TournamentCommand,
  type TournamentFinishedCommand, type TournamentStatusEvent, type TournamentTableLine, type TournamentViewEvent,
} from '../../core/tournament';
import { TournamentTableRunner, type TableRunnerHost } from './tournamentTableRunner';
import {
  OUT_OF_BAND, type PlayerRef, type RuntimeTiming, type TournamentBackend, type TournamentPacing, type TournamentRoster,
  type TournamentTransport, type WireEvent,
} from './wire';

const STATUS_INTERVAL_SECONDS = 1;
const PROGRESS_INTERVAL_SECONDS = 15;
const ROSTER_POLL_SECONDS = 5;
const QUIT_AFTER_FINISH_SECONDS = 120;
const QUIT_AFTER_CANCEL_SECONDS = 60;
const STEP_SECONDS = 0.05;

/** TournamentServerGame.BotNames. */
export const BOT_NAMES: readonly string[] = [
  'Ace', 'Blaze', 'Copper', 'Dusty', 'Echo', 'Flint', 'Ginger', 'Hazel', 'Indigo', 'Jade',
  'Kit', 'Luna', 'Moss', 'Nova', 'Onyx', 'Pike', 'Quill', 'Rusty', 'Sable', 'Tango',
  'Umber', 'Vega', 'Willow', 'Xeno', 'Yara', 'Zeke', 'Birch', 'Cleo', 'Drift',
];

/** TournamentLaunch.DevLevelMs: practice and dev tournaments use one-minute levels. */
export const DEV_LEVEL_MS = 60_000;

/** TournamentLaunch.SessionPrefix: tournament sessions are named TRN + 10 characters. */
export const TOURNAMENT_SESSION_PREFIX = 'TRN';
export const isTournamentSession = (session: string | null | undefined): boolean => !!session && session.startsWith(TOURNAMENT_SESSION_PREFIX);

export interface TournamentServerConfig {
  transport: TournamentTransport;
  timing: RuntimeTiming;
  pacing: TournamentPacing;
  /** Hosted tournament: the backend that holds its roster. Absent = an offline dev / practice tournament. */
  backend?: TournamentBackend | null;
  /** Dev / practice: the field size; bots fill whatever people don't (TournamentLaunch.DevPlayers). */
  devPlayers?: number;
  /** Practice: the host plays too ("Practice tournament" rather than "Dev tournament"). */
  practiceHost?: boolean;
  /** How long a dev tournament waits for more people after the first (default 10 s, DevFillWaitMs). */
  devFillWaitMs?: number;
  /** Dev / practice: the tournament's name and prizes (default "Practice tournament" / "Dev tournament", no prize). */
  name?: string;
  firstPrize?: number;
  secondPrize?: number;
  /** Seeds for the practice bots (Unity: Environment.TickCount). */
  botSeed?: number;
  log?: (message: string) => void;
}

interface Entrant {
  id: string;
  name: string;
  player: PlayerRef;
  hasPlayer: boolean;
  connected: boolean;
  avatar: number;
  tableId: number;
  seat: number;
  round: number;
  eliminated: boolean;
  /** Practice tournaments only: a bot holding a seat nobody else took. */
  bot: IPokerBot | null;
}

/**
 * The authority for one hosted tournament: every table of it. Port of Net/Tournament/TournamentServerGame.cs.
 *
 * It reads the roster from the backend (or, in a dev / practice run, takes whoever connects and fills the field with
 * bots), starts the TournamentDirector at the start time, runs each table through a TournamentTableRunner, and sends
 * the final standings back. Moving between tables, waiting and watching are all just a change in which table's events
 * a player receives — nobody reconnects. Absent players keep their seat and are blinded off.
 */
export class TournamentServerGame implements TableRunnerHost {
  readonly timing: RuntimeTiming;
  readonly pacing: TournamentPacing;
  private readonly abort = new AbortController();
  private readonly transport: TournamentTransport;
  private readonly backend: TournamentBackend | null;
  private readonly dev: boolean;
  private readonly devPlayers: number;
  private readonly log: (m: string) => void;

  private readonly entrants = new Map<string, Entrant>();
  private readonly entrantOrder: string[] = [];
  private readonly byPlayer = new Map<PlayerRef, string>();
  private readonly watching = new Map<PlayerRef, number>();
  private readonly spectators = new Set<PlayerRef>();
  private readonly tables = new Map<number, TournamentTableRunner>();
  private readonly clockStart: number;

  private director: TournamentDirector | null = null;
  private finished: TournamentFinishedCommand | null = null;
  private _phase = TournamentPhase.BeforeStart;
  private name = 'Tournament';
  private hostId: string | null = null;
  private speed = TournamentSpeed.Regular;
  private startsAtMs = -1;
  private firstPrize = 0;
  private secondPrize = 0;
  private progressSeq = 0;
  private botSeed: number;

  constructor(private readonly config: TournamentServerConfig) {
    this.transport = config.transport;
    this.timing = config.timing;
    this.pacing = config.pacing;
    this.backend = config.backend ?? null;
    this.devPlayers = config.devPlayers ?? 0;
    this.dev = !this.backend && this.devPlayers >= 2;
    this.log = config.log ?? ((m) => console.log(m));
    this.botSeed = config.botSeed ?? Date.now() & 0x7fffffff;
    this.clockStart = this.timing.nowMs();
    if (!this.dev && !this.backend) throw new Error('A tournament server needs a backend, or devPlayers >= 2 for a practice run.');
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }
  get phase(): TournamentPhase {
    return this._phase;
  }
  /** NowMs: milliseconds since this server started. */
  get nowMs(): number {
    return this.timing.nowMs() - this.clockStart;
  }

  /** IPokerTableServer.Activate: starts the tournament's life and the status loop. */
  activate(): void {
    this.log(this.dev
      ? `[Tournament] Offline dev tournament: starts when ${this.devPlayers} players have joined.`
      : '[Tournament] Hosting a backend tournament.');
    void this.run().catch((ex) => this.log(`[Tournament] run failed: ${(ex as Error).stack ?? ex}`));
    void this.statusLoop();
  }

  /** Stops every loop (scene unload / server shutdown). */
  shutdown(): void {
    this.abort.abort();
  }

  private wait(seconds: number): Promise<void> {
    return this.timing.wait(seconds, this.abort.signal);
  }
  private get stopped(): boolean {
    return this.abort.signal.aborted;
  }

  // ---- The tournament's life ------------------------------------------------------------

  private async run(): Promise<void> {
    if (this.dev) {
      // Waits for the first player, gives others a few seconds to join, then fills the field with bots. Real
      // tournaments never have bots; this exists so one person can play one.
      this.name = this.config.name || (this.config.practiceHost ? 'Practice tournament' : 'Dev tournament');
      this.firstPrize = this.config.firstPrize ?? 0;
      this.secondPrize = this.config.secondPrize ?? 0;
      this.speed = TournamentSpeed.Turbo;
      this.startsAtMs = -1;
      while (this.entrants.size === 0) {
        if (this.stopped) return;
        await this.wait(STEP_SECONDS);
      }
      this.startsAtMs = this.nowMs + (this.config.devFillWaitMs ?? 10_000);
      while (this.nowMs < this.startsAtMs && this.entrants.size < this.devPlayers) {
        if (this.stopped) return;
        await this.wait(STEP_SECONDS);
      }
      for (let i = 0; this.entrants.size < this.devPlayers; i++) this.addBot(i);
      this.startsAtMs = this.nowMs + 3_000;
      while (this.nowMs < this.startsAtMs) {
        if (this.stopped) return;
        await this.wait(STEP_SECONDS);
      }
    } else {
      const backend = this.backend!;
      // Players connect from about 3 minutes before the start; the roster freezes at the start time.
      for (;;) {
        if (this.stopped) return;
        const roster = await backend.getRoster();
        if (roster) {
          this.applyRoster(roster);
          if (roster.status === 'cancelled' || roster.status === 'aborted' || roster.status === 'funding_failed') {
            this.endCancelled(`The tournament was ${roster.status}.`);
            return;
          }
          if (roster.status === 'finished') {
            this.endCancelled('This tournament has already finished.');
            return;
          }
          if (roster.rosterFrozen) break;
        }
        await this.wait(ROSTER_POLL_SECONDS);
      }
      for (let attempt = 0; ; attempt++) {
        if (this.stopped) return;
        if (await backend.started()) break;
        if (attempt >= 20) {
          this.endCancelled("Couldn't reach the tournament service to start.");
          return;
        }
        await this.wait(3);
      }
    }

    this.startTournament();
    let nextProgress = 0;
    while (this._phase === TournamentPhase.Running && !this.stopped) {
      this.step();
      if (!this.dev && this.timing.nowMs() >= nextProgress) {
        nextProgress = this.timing.nowMs() + PROGRESS_INTERVAL_SECONDS * 1000;
        const snapshot = this.director!.snapshot(this.nowMs);
        void this.backend!.progress(++this.progressSeq, snapshot.playersRemaining, snapshot.tables.filter((t) => !t.isClosed).length, 'running');
      }
      await this.wait(STEP_SECONDS);
    }
  }

  private applyRoster(roster: TournamentRoster): void {
    if (roster.name) this.name = roster.name;
    if (roster.hostPlayFabId) this.hostId = roster.hostPlayFabId;
    this.speed = speedFromString(roster.speed);
    this.startsAtMs = this.nowMs + Math.max(0, roster.startsAtUnix - roster.serverNowUnix) * 1000;
    this.firstPrize = roster.firstPrize;
    this.secondPrize = roster.secondPrize;

    const listed = new Set<string>();
    for (const e of roster.entrants ?? []) {
      if (!e.playFabId) continue;
      listed.add(e.playFabId);
      const entrant = this.entrants.get(e.playFabId);
      if (!entrant) this.addEntrant(e.playFabId, e.displayName);
      else if (e.displayName) entrant.name = e.displayName;
    }

    // Players who left the tournament before the start no longer play. Only players and the host may watch, so
    // they are shown out — unless they are the host.
    for (const id of this.entrantOrder.filter((x) => !listed.has(x))) {
      const gone = this.entrants.get(id)!;
      this.entrants.delete(id);
      this.entrantOrder.splice(this.entrantOrder.indexOf(id), 1);
      if (!gone.connected) continue;
      this.byPlayer.delete(gone.player);
      if (id === this.hostId) this.spectate(gone.player);
      else this.turnAway(gone.player, `${gone.name} left before the start`);
    }
  }

  private startTournament(): void {
    this.director = new TournamentDirector([...this.entrantOrder], this.speed, this.timing.makeRandom(), this.dev ? DEV_LEVEL_MS : 0);
    this._phase = TournamentPhase.Running;
    this.log(`[Tournament] '${this.name}' starting: ${this.entrantOrder.length} players, format ${this.director.format}, speed ${TournamentSpeed[this.speed]}.`);
    this.apply(this.director.start(this.nowMs));
  }

  private step(): void {
    const d = this.director!;
    this.apply(d.tick(this.nowMs));
    for (const runner of [...this.tables.values()]) {
      if (runner.closed || runner.handRunning || !d.canDeal(runner.tableId, this.nowMs)) continue;
      const blinds = d.blindsForNextHand(runner.tableId, this.nowMs);
      runner.handRunning = true;
      void runner.playHand(blinds, (r, results) => this.onHandDone(r, results)).catch((ex) => {
        this.log(`[Tournament] Table ${runner.tableId} hand failed: ${(ex as Error).stack ?? ex}`);
      });
    }
  }

  private onHandDone(runner: TournamentTableRunner, results: Parameters<TournamentDirector['reportHand']>[1]): void {
    try {
      this.apply(this.director!.reportHand(runner.tableId, results, this.nowMs));
    } catch (ex) {
      this.log(`[Tournament] Table ${runner.tableId} hand report rejected: ${(ex as Error).message}`);
    }
    if (!runner.closed) runner.broadcastRoster();
  }

  private apply(commands: readonly TournamentCommand[]): void {
    for (const command of commands) {
      switch (command.kind) {
        case 'TableOpened': this.openTable(command); break;
        case 'PlayersEliminated': this.eliminate(command); break;
        case 'TableClosed': this.closeTable(command); break;
        case 'TournamentFinished': this.finish(command); break;
        case 'TournamentCancelled': this.endCancelled(command.reason); break;
        case 'SpeedUpStarted': this.log(`[Tournament] Table ${command.tableId} now plays fast levels.`); break;
        case 'BlindsUp': this.log(`[Tournament] Table ${command.tableId} → ${blindLevelToString(command.blinds)}.`); break;
        case 'HighCardDraw':
          this.log(`[Tournament] Table ${command.tableId} high-card draw: ` + command.cards.map((c) => `${this.nameOf(c.entrantId)} ${c.card.short}`).join(', '));
          break;
      }
    }
  }

  private openTable(opened: TableOpenedCommand): void {
    const runner = new TournamentTableRunner(this, opened);
    this.tables.set(opened.tableId, runner);
    for (const seat of opened.seats) {
      const entrant = this.entrants.get(seat.entrantId)!;
      entrant.tableId = opened.tableId;
      entrant.seat = seat.seat;
      entrant.round = opened.round;
      if (!entrant.connected) continue;
      this.watching.delete(entrant.player);
      this.sendView(entrant.player, this.seatedView(runner, entrant, opened.round === 1 ? TournamentViewReason.Seated : TournamentViewReason.Moved));
      runner.sendCatchUpTo(entrant.player);
    }
    this.log(`[Tournament] Table ${opened.tableId} (round ${opened.round}${opened.isFinal ? ', final' : ''}) opens with ${opened.seats.length} players.`);
  }

  private eliminate(eliminated: PlayersEliminatedCommand): void {
    const runner = this.tables.get(eliminated.tableId);
    for (const id of eliminated.entrantIds) {
      const entrant = this.entrants.get(id)!;
      entrant.eliminated = true;
      entrant.round = eliminated.round;
      entrant.tableId = -1;
      entrant.seat = -1;
      runner?.remove(id);
      if (!entrant.connected) continue;

      this.sendTo(entrant.player, tournamentResult({
        finished: false,
        yourRound: eliminated.round,
        entrants: this.entrantOrder.length,
        xpEarned: TournamentRewards.playerXp(eliminated.round - 1, false),
        firstPrize: this.firstPrize,
        secondPrize: this.secondPrize,
      }));

      // Out, but welcome to stay and watch the table they went out at.
      if (runner && !runner.closed) this.watch(entrant.player, runner);
    }
  }

  private closeTable(closed: TableClosedCommand): void {
    const runner = this.tables.get(closed.tableId);
    if (!runner) return;
    runner.closed = true;
    this.tables.delete(closed.tableId);

    for (const id of closed.survivors) {
      const entrant = this.entrants.get(id)!;
      entrant.tableId = -1;
      entrant.seat = -1;
      entrant.round = runner.round + 1;
      if (entrant.connected) this.sendView(entrant.player, tournamentView(TournamentViewReason.Waiting));
    }
    for (const [watcher, tableId] of [...this.watching]) {
      if (tableId !== closed.tableId) continue;
      this.watching.delete(watcher);
      this.sendView(watcher, tournamentView(TournamentViewReason.Waiting));
    }
  }

  private finish(finished: TournamentFinishedCommand): void {
    this.finished = finished;
    this._phase = TournamentPhase.Finished;

    const byPlace = new Map(finished.standings.map((s) => [s.entrantId, s]));
    const championName = this.nameOf(finished.championId);
    const runnerUp = finished.standings.find((s) => s.place === 2)?.entrantId ?? null;
    this.log(`[Tournament] '${this.name}' won by ${championName}.`);

    for (const player of this.connectedPlayers()) {
      const result = tournamentResult({
        finished: true,
        entrants: this.entrantOrder.length,
        championName,
        runnerUpName: runnerUp !== null ? this.nameOf(runnerUp) : '',
        firstPrize: this.firstPrize,
        secondPrize: this.secondPrize,
      });
      const id = this.byPlayer.get(player);
      const standing = id !== undefined ? byPlace.get(id) : undefined;
      if (standing) {
        result.yourPlace = standing.place;
        result.yourRound = standing.roundReached;
        result.youWon = standing.isChampion;
        result.yourPrize = standing.place === 1 ? this.firstPrize : standing.place === 2 ? this.secondPrize : 0;
        // Everyone else was paid their XP when they went out; only the champion is still owed it.
        result.xpEarned = standing.isChampion ? TournamentRewards.playerXp(standing.roundReached - 1, true) : 0;
      }
      this.sendTo(player, result);
    }

    this.broadcastStatus();
    if (!this.dev) void this.postResult(finished);
    void this.quitLater(QUIT_AFTER_FINISH_SECONDS);
  }

  private async postResult(finished: TournamentFinishedCommand): Promise<void> {
    const standings = finished.standings.map((s) => ({ playFabId: s.entrantId, place: s.place, roundReached: s.roundReached }));
    let wait = 2;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (this.stopped) return;
      const status = await this.backend!.postResult(finished.championId, standings);
      if (status === 200) {
        this.log('[Tournament] Result recorded; prizes are being paid.');
        return;
      }
      if (status === 409 || status === 400) {
        this.log(`[Tournament] Backend refused the result (${status}). Needs a look.`);
        return;
      }
      await this.wait(wait);
      wait = Math.min(wait * 2, 60);
    }
    this.log('[Tournament] Gave up posting the result. The backend will abort and refund once heartbeats stop.');
  }

  private endCancelled(reason: string): void {
    if (this._phase === TournamentPhase.Cancelled) return;
    this._phase = TournamentPhase.Cancelled;
    this.log(`[Tournament] Over without a result: ${reason}`);
    this.broadcastStatus();
    void this.quitLater(QUIT_AFTER_CANCEL_SECONDS);
  }

  private async quitLater(seconds: number): Promise<void> {
    await this.wait(seconds);
    if (this.stopped) return;
    this.log('[Tournament] Done — shutting the server down.');
    this.transport.quit?.();
  }

  // ---- Who is who --------------------------------------------------------------------------

  private addBot(index: number): void {
    const bot = this.addEntrant(`bot-${index}`, BOT_NAMES[index % BOT_NAMES.length]!);
    bot.bot = new HeuristicBot(((this.botSeed + index * 7919) | 0) & 0x7fffffff);
    this.log(`[Tournament] Bot ${bot.name} takes a seat.`);
  }

  private addEntrant(id: string, name: string): Entrant {
    const entrant: Entrant = {
      id, name: cleanName(name, id), player: -1, hasPlayer: false, connected: false, avatar: AvatarCatalog.None,
      tableId: -1, seat: -1, round: 1, eliminated: false, bot: null,
    };
    this.entrants.set(id, entrant);
    this.entrantOrder.push(id);
    return entrant;
  }

  /**
   * A connection introduced itself. Dev / practice runs take the token as the player's id; hosted ones verify the
   * PlayFab session ticket with the backend.
   */
  onHello(player: PlayerRef, playerName: string, token: string, sessionTicket: string): void {
    if (this.dev) {
      let id = token && token.trim() ? token.trim() : `dev-${player}`;
      // Two windows on one machine share the device token: while the first is connected, a second one is a
      // different player, not a reconnect.
      const existing = this.entrants.get(id);
      if (existing && existing.connected && existing.player !== player) id = `${id}#${player}`;
      if (!this.entrants.has(id)) {
        if (this._phase !== TournamentPhase.BeforeStart || this.entrants.size >= this.devPlayers) {
          this.spectate(player);
          return;
        }
        this.addEntrant(id, playerName);
      }
      this.bind(player, id, playerName);
      return;
    }
    void this.verifyAndBind(player, playerName, sessionTicket);
  }

  private async verifyAndBind(player: PlayerRef, playerName: string, sessionTicket: string): Promise<void> {
    if (!sessionTicket || !sessionTicket.trim()) {
      this.turnAway(player, `${playerName} isn't signed in`);
      return;
    }
    const who = await this.backend!.verify(sessionTicket);
    if (!who || !who.ok || !who.playFabId) {
      this.turnAway(player, `${playerName}'s sign-in didn't verify (${who?.error})`);
      return;
    }
    const canPlay = who.entrant && (this.entrants.has(who.playFabId) || this._phase === TournamentPhase.BeforeStart);
    if (canPlay) {
      if (!this.entrants.has(who.playFabId)) this.addEntrant(who.playFabId, who.displayName);
      this.bind(player, who.playFabId, who.displayName);
    } else if (who.host) {
      // The host may always watch their own tournament, playing in it or not.
      this.hostId = who.playFabId;
      this.log(`[Tournament] The host, ${who.displayName}, is watching.`);
      this.spectate(player);
    } else {
      this.turnAway(player, `${who.displayName} isn't in this tournament`);
    }
  }

  private bind(player: PlayerRef, id: string, name: string): void {
    const entrant = this.entrants.get(id)!;
    if (entrant.hasPlayer && entrant.player !== player) {
      // The same player on a second device or after a reconnect: the newest connection plays.
      this.byPlayer.delete(entrant.player);
      this.watching.delete(entrant.player);
    }
    entrant.player = player;
    entrant.hasPlayer = true;
    entrant.connected = true;
    if (name && name.trim()) entrant.name = cleanName(name, id);
    this.byPlayer.set(player, id);
    this.spectators.delete(player);
    this.log(`[Tournament] ${entrant.name} is here.`);
    this.sendViewFor(entrant);
    this.sendStatus(player);
  }

  private sendViewFor(entrant: Entrant): void {
    const player = entrant.player;
    const runner = entrant.tableId >= 0 ? this.tables.get(entrant.tableId) : undefined;
    if (runner) {
      this.sendView(player, this.seatedView(runner, entrant, TournamentViewReason.Seated));
      runner.sendCatchUpTo(player);
    } else if (entrant.eliminated) {
      this.sendView(player, tournamentView(TournamentViewReason.Waiting));
    } else {
      this.sendView(player, tournamentView(this._phase === TournamentPhase.BeforeStart ? TournamentViewReason.BeforeStart : TournamentViewReason.Waiting));
    }
  }

  private seatedView(runner: TournamentTableRunner, entrant: Entrant, reason: TournamentViewReason): TournamentViewEvent {
    return tournamentView(reason, {
      tableId: runner.tableId, round: runner.round, isFinal: runner.isFinal, yourSeat: entrant.seat,
      countdownSeconds: Math.max(0, Math.trunc((runner.dealAtMs - this.nowMs) / 1000)),
    });
  }

  /** Only players and the host may be here. Anyone else is disconnected. */
  private turnAway(player: PlayerRef, why: string): void {
    this.log(`[Tournament] Turning away a connection: ${why}.`);
    this.watching.delete(player);
    this.spectators.delete(player);
    this.transport.disconnect(player);
  }

  private spectate(player: PlayerRef): void {
    this.spectators.add(player);
    const table = [...this.tables.values()].filter((t) => !t.closed).sort((a, b) => a.tableId - b.tableId)[0];
    if (table) this.watch(player, table);
    else this.sendView(player, tournamentView(this._phase === TournamentPhase.BeforeStart ? TournamentViewReason.BeforeStart : TournamentViewReason.Waiting));
    this.sendStatus(player);
  }

  private watch(player: PlayerRef, runner: TournamentTableRunner): void {
    this.watching.set(player, runner.tableId);
    this.sendView(player, tournamentView(TournamentViewReason.Watching, {
      tableId: runner.tableId, round: runner.round, isFinal: runner.isFinal, yourSeat: -1,
      countdownSeconds: Math.max(0, Math.trunc((runner.dealAtMs - this.nowMs) / 1000)),
    }));
    runner.sendCatchUpTo(player);
  }

  /** A player who isn't seated picks a table to watch (or -1 to stop watching). */
  onWatchTable(player: PlayerRef, tableId: number): void {
    const id = this.byPlayer.get(player);
    if (id !== undefined) {
      const entrant = this.entrants.get(id)!;
      if (!entrant.eliminated && entrant.tableId >= 0) return; // playing: their own table only
    }
    const runner = tableId >= 0 ? this.tables.get(tableId) : undefined;
    if (runner && !runner.closed) {
      this.watch(player, runner);
      return;
    }
    this.watching.delete(player);
    this.sendView(player, tournamentView(this._phase === TournamentPhase.BeforeStart ? TournamentViewReason.BeforeStart : TournamentViewReason.Waiting));
  }

  // ---- Queries for the table runners ------------------------------------------------------

  nameOf(entrantId: string): string {
    return this.entrants.get(entrantId)?.name ?? entrantId;
  }
  avatarOf(entrantId: string): number {
    return this.entrants.get(entrantId)?.avatar ?? AvatarCatalog.None;
  }
  isConnected(entrantId: string): boolean {
    const e = this.entrants.get(entrantId);
    return !!e && (e.connected || e.bot !== null);
  }
  botFor(entrantId: string): IPokerBot | null {
    return this.entrants.get(entrantId)?.bot ?? null;
  }
  seatAt(player: PlayerRef, tableId: number): number {
    const id = this.byPlayer.get(player);
    if (id === undefined) return -1;
    const e = this.entrants.get(id)!;
    return !e.eliminated && e.tableId === tableId ? e.seat : -1;
  }
  /** The seat this connection plays at its current table, or -1 (chat / voice attribution). */
  seatOfPlayer(player: PlayerRef): number {
    const id = this.byPlayer.get(player);
    const e = id !== undefined ? this.entrants.get(id) : undefined;
    return e && !e.eliminated && e.tableId >= 0 ? e.seat : -1;
  }
  recipientsOf(tableId: number): PlayerRef[] {
    const list: PlayerRef[] = [];
    for (const e of this.entrants.values()) if (!e.eliminated && e.tableId === tableId && e.connected && e.hasPlayer) list.push(e.player);
    for (const [player, t] of this.watching) if (t === tableId && !list.includes(player)) list.push(player);
    return list;
  }
  send(player: PlayerRef, sequence: number, event: WireEvent): void {
    this.transport.sendEventTo(player, sequence, event);
  }

  private connectedPlayers(): PlayerRef[] {
    const list: PlayerRef[] = [];
    for (const e of this.entrants.values()) if (e.connected && e.hasPlayer) list.push(e.player);
    for (const p of this.spectators) list.push(p);
    return list;
  }

  // ---- Status for the HUD ----------------------------------------------------------------

  private async statusLoop(): Promise<void> {
    while (!this.stopped) {
      this.broadcastStatus();
      await this.wait(STATUS_INTERVAL_SECONDS);
    }
  }

  private broadcastStatus(): void {
    for (const player of this.connectedPlayers()) this.sendStatus(player);
  }

  private sendStatus(player: PlayerRef): void {
    this.sendTo(player, this.buildStatus(player));
  }

  /** BuildStatus: the tournament as one player sees it. */
  buildStatus(player: PlayerRef): TournamentStatusEvent {
    const now = this.nowMs;
    const status: TournamentStatusEvent = {
      type: 'TournamentStatus',
      name: this.name,
      phase: this._phase,
      myState: TournamentPlayerState.Spectator,
      myTableId: -1,
      entrants: this.entrantOrder.length,
      playersRemaining: this.entrantOrder.length,
      startsInSeconds: this.startsAtMs < 0 ? 0 : Math.max(0, Math.trunc((this.startsAtMs - now) / 1000)),
      firstPrize: this.firstPrize,
      secondPrize: this.secondPrize,
      tables: [],
    };

    if (this.director) {
      const snapshot = this.director.snapshot(now);
      status.playersRemaining = snapshot.playersRemaining;
      status.tables = snapshot.tables.slice(0, MAX_TOURNAMENT_TABLES).map((t): TournamentTableLine => ({
        tableId: t.tableId,
        round: t.round,
        isFinal: t.isFinal,
        isClosed: t.isClosed,
        isDealing: t.isDealing,
        isSpedUp: t.isSpedUp,
        playersLeft: t.playersLeft,
        level: t.blinds.level,
        smallBlind: t.blinds.smallBlind,
        bigBlind: t.blinds.bigBlind,
        secondsToNextLevel: Math.trunc(t.msToNextLevel / 1000),
        dealInSeconds: t.isDealing ? 0 : Math.max(0, Math.trunc((t.dealAtMs - now) / 1000)),
      }));
    }

    const id = this.byPlayer.get(player);
    const e = id !== undefined ? this.entrants.get(id) : undefined;
    if (e) {
      status.myTableId = e.tableId;
      status.myState = this.finished && this.finished.championId === id ? TournamentPlayerState.Champion
        : e.eliminated ? TournamentPlayerState.Eliminated
          : e.tableId >= 0 ? TournamentPlayerState.Seated
            : TournamentPlayerState.Waiting;
    }
    return status;
  }

  private sendView(player: PlayerRef, view: TournamentViewEvent): void {
    this.sendTo(player, view);
  }

  private sendTo(player: PlayerRef, e: WireEvent): void {
    this.transport.sendEventTo(player, OUT_OF_BAND, e);
  }

  // ---- IPokerTableServer -----------------------------------------------------------------

  onPlayerLeft(player: PlayerRef): void {
    const id = this.byPlayer.get(player);
    if (id !== undefined) {
      const entrant = this.entrants.get(id)!;
      if (entrant.player === player) {
        entrant.connected = false;
        this.log(`[Tournament] ${entrant.name} disconnected — their seat plays on, check/fold.`);
      }
      this.byPlayer.delete(player);
    }
    this.watching.delete(player);
    this.spectators.delete(player);
  }

  onActionSubmitted(source: PlayerRef, seat: number, action: PlayerAction): void {
    const id = this.byPlayer.get(source);
    if (id === undefined) return;
    const entrant = this.entrants.get(id)!;
    const runner = this.tables.get(entrant.tableId);
    if (entrant.eliminated || entrant.seat !== seat || !runner) {
      this.log(`[Tournament] Ignored an action from ${entrant.name} for seat ${seat}.`);
      return;
    }
    runner.deliver(seat, action);
  }

  /** There is no leaving a tournament: the seat stays and is blinded off until the player is back. */
  onLeaveTable(source: PlayerRef): void {
    const id = this.byPlayer.get(source);
    if (id !== undefined) this.entrants.get(id)!.connected = false;
  }

  onReaction(source: PlayerRef, reactionId: number): void {
    const id = this.byPlayer.get(source);
    if (id === undefined) return;
    const entrant = this.entrants.get(id)!;
    const runner = this.tables.get(entrant.tableId);
    if (!entrant.eliminated && runner) runner.replicateReaction(entrant.seat, reactionId);
  }

  onAvatar(source: PlayerRef, avatar: number): void {
    const id = this.byPlayer.get(source);
    if (id !== undefined && AvatarCatalog.isValid(avatar)) this.entrants.get(id)!.avatar = avatar;
  }
}

/** TournamentServerGame.CleanName: trimmed, at most 20 characters, or "Player abcd" from the id. */
export function cleanName(name: string | null | undefined, id: string): string {
  const trimmed = name?.trim();
  if (!trimmed) return `Player ${id.substring(Math.max(0, id.length - 4))}`;
  return trimmed.length > 20 ? trimmed.substring(0, 20) : trimmed;
}
