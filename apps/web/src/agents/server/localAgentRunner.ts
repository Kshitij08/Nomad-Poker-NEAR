/**
 * Headless Agent tables: the Agent side of a public Quick Play dedicated server (PokerServerGame's agent loop,
 * TuneQuickPlayBots' filler pack, BustOutSeats, AgentFarmLink's claim / progress / control loop) driven synchronously,
 * with no rendering and no waits. A `LocalAgentRunner` keeps one table per stake, claims queued Agents from an
 * AgentFarm, and deals hands on a schedule (with catch-up after the process was away, so an AFK Agent "kept playing").
 *
 * No browser APIs: the browser's local backend ticks it once a second; a Node table server can run it as is for
 * Agent-only tables, or embed AgentTableHost in its own tables (see README.md).
 */
import { StakeCatalog, type StakeTier } from '../../core/stakes/stakes';
import { PokerEngine } from '../../core/engine/pokerEngine';
import { SeededRandom, DotNetRandom } from '../../core/cards/random';
import { HeuristicBot } from '../../core/bots/heuristicBot';
import { positionOf, type BotContext, type IPokerBot } from '../../core/bots/botContext';
import { QuickPlayFreeBots } from '../../core/bots/quickPlayFreeBots';
import { AgentSessionHost, newAgentSummary, AgentStopReasons, type AgentSession } from '../../core/agents';
import { AgentTableHost, agentPlayerId, type AgentReporter } from './agentTableHost';
import type { AgentFarm, DeploymentRow } from './agentFarm';
import { configOfRow } from './agentFarm';

const f = Math.fround;

export interface HeadlessAgentTableOptions {
  farm: AgentFarm;
  name: string;
  stake: StakeTier;
  seatCount?: number;
  /** Fixed seed (tests): engine deck, bots and filler rolls replay. Null: random. */
  seed?: number | null;
  /** Seconds (float) since some start: the Agents' runtime clock. */
  clock: () => number;
  /** Unix seconds for records. */
  unixClock: () => number;
}

/** One Quick Play table that only Agents and filler bots sit at. */
export class HeadlessAgentTable {
  readonly engine: PokerEngine;
  readonly host: AgentTableHost;
  readonly name: string;
  readonly stake: StakeTier;
  readonly seatCount: number;
  private readonly bots = new Map<number, IPokerBot>();
  private readonly usedBotNames = new Set<string>();
  private readonly rng: DotNetRandom;
  private botLabel = 1;
  /** When this table deals its next hand (unix seconds; set by the runner). */
  nextHandAt = 0;

  constructor(private readonly opts: HeadlessAgentTableOptions) {
    this.name = opts.name;
    this.stake = opts.stake;
    this.seatCount = opts.seatCount ?? 7;
    const seed = opts.seed ?? Math.floor(Math.random() * 0x7fffffff);
    this.rng = new DotNetRandom(seed);
    this.engine = new PokerEngine(
      { seatCount: this.seatCount, smallBlind: this.stake.smallBlind, bigBlind: this.stake.bigBlind, startingStack: this.stake.startingStack },
      new SeededRandom(seed),
    );
    const farm = opts.farm;
    const reporter: AgentReporter = {
      reportHand: (hand, replayJson) => farm.upsertHand(hand, replayJson, this.name),
      reportComplete: (summary, table) => {
        // AgentCompleteReporter: a "settling" progress, then the authoritative result.
        farm.updateProgress({
          session: summary.DeploymentId ?? '', AssignedTable: summary.SessionName ?? table, phase: 'settling',
          HandsPlayed: summary.HandsPlayed, Stack: summary.EndingStack, NetPnl: summary.NetPnl,
          RuntimeSeconds: summary.RuntimeSeconds, Wins: summary.Wins, Losses: summary.Losses, Showdowns: summary.Showdowns,
        }, table);
        farm.complete(summary, table);
      },
    };
    this.host = new AgentTableHost({
      engine: this.engine, seatCount: this.seatCount, tableName: () => this.name, reporter,
      clock: opts.clock, unixClock: opts.unixClock,
      botSeed: (seat) => (opts.seed != null ? opts.seed + seat * 101 : null),
      startingStack: this.stake.startingStack,
    });
    this.engine.onEvent((e) => this.host.observe(e));
  }

  /** No Agent here or on the way. */
  get idle(): boolean {
    return this.host.agentsSeated === 0;
  }

  private get seats() {
    return this.engine.table.seats;
  }

  private isBotSeat(seat: number): boolean {
    const p = this.seats[seat]!;
    return p.isOccupied && p.isBot && !p.isAgent;
  }

  /** Empty chairs plus filler bots' chairs: where claimed Agents could sit. */
  private seatsForAgents(): number {
    let n = 0;
    for (let s = 0; s < this.seatCount; s++) if (!this.seats[s]!.isOccupied || this.isBotSeat(s)) n++;
    return n;
  }

  private firstFreeSeat(): number {
    for (let s = 0; s < this.seatCount; s++) if (!this.seats[s]!.isOccupied) return s;
    return -1;
  }

  private poorestBotSeat(): number {
    let best = -1;
    for (let s = 0; s < this.seatCount; s++)
      if (this.isBotSeat(s) && (best < 0 || this.seats[s]!.stack < this.seats[best]!.stack)) best = s;
    return best;
  }

  private seatedCount(): number {
    return this.seats.filter((p) => p.isOccupied).length;
  }

  private botCount(): number {
    let n = 0;
    for (let s = 0; s < this.seatCount; s++) if (this.isBotSeat(s)) n++;
    return n;
  }

  private dropBot(seat: number): void {
    this.usedBotNames.delete(this.seats[seat]!.name ?? '');
    this.engine.vacateSeat(seat);
    this.bots.delete(seat);
  }

  /** TakeQuickPlayBotName: a random unused name from the list. */
  private takeBotName(): string {
    const names = QuickPlayFreeBots.Names;
    const start = this.rng.next(names.length);
    for (let i = 0; i < names.length; i++) {
      const name = names[(start + i) % names.length]!;
      if (!this.usedBotNames.has(name)) {
        this.usedBotNames.add(name);
        return name;
      }
    }
    return `Bot ${this.botLabel++}`;
  }

  /** RollFillerBuyIn: between the stake's min buy-in and its full stack, rounded to a whole big blind. */
  private rollFillerBuyIn(): number {
    const min = this.stake.minBuyIn;
    let max = this.stake.startingStack > 0 ? this.stake.startingStack : this.stake.minBuyIn;
    if (max < min) max = min;
    let pick = min + this.rng.next(max - min + 1);
    const bb = this.stake.bigBlind;
    if (bb > 1) pick = Math.min(max, Math.max(min, Math.floor(pick / bb) * bb));
    return pick;
  }

  private seatBot(seat: number): void {
    this.engine.seatPlayer(seat, `bot${seat}`, this.takeBotName(), true, this.rollFillerBuyIn());
    this.bots.set(seat, new HeuristicBot(this.opts.seed != null ? this.opts.seed + seat * 101 : this.rng.next()));
  }

  /** TuneQuickPlayBots: a lone Agent gets the filler pack; one chair always stays free for a joiner. */
  private tuneBots(): void {
    const occupancyCap = Math.max(2, this.seatCount - 1);
    const principals = this.host.agents.sessions.length;
    if (principals === 0) {
      for (let s = 0; s < this.seatCount; s++) if (this.isBotSeat(s)) this.dropBot(s); // RemoveBotsIfNoHumans
      return;
    }
    if (principals === 1) {
      const existing = this.botCount();
      const want = Math.min(QuickPlayFreeBots.rollCount(this.rng.next(100)), occupancyCap - principals, QuickPlayFreeBots.MaxBots);
      for (let i = existing; i < want; i++) {
        if (this.seatedCount() >= occupancyCap) break;
        const seat = this.firstFreeSeat();
        if (seat < 0) break;
        this.seatBot(seat);
      }
    }
    while (this.seatedCount() > occupancyCap) {
      const seat = this.poorestBotSeat();
      if (seat < 0) break;
      this.dropBot(seat);
    }
  }

  private vacateAgent(seat: number, playerId: string): void {
    if (seat < 0 || seat >= this.seatCount) return;
    const p = this.seats[seat]!;
    if (p.isOccupied && p.isAgent && p.id === playerId) {
      this.engine.vacateSeat(seat);
      this.bots.delete(seat);
    }
  }

  /** Seats a farm deployment that was already playing (the process restarted): its stack and totals carry on. */
  adopt(row: DeploymentRow): AgentSession | null {
    const config = configOfRow(row);
    if (!this.host.trySeatSharedAgent(config)) return null;
    let session: AgentSession | null = null;
    for (const a of this.host.activatePending(() => this.allocateSeat(), undefined, () => row.stack)) {
      this.bots.set(a.seat, a.bot);
      session = a.session;
    }
    if (!session) {
      this.host.cancelPending(row.deploymentId);
      return null;
    }
    session.handsPlayed = row.handsPlayed;
    session.wins = row.wins;
    session.losses = row.losses;
    session.showdowns = row.showdowns;
    session.lastStack = row.stack;
    if (row.stopRequested) session.requestOwnerStop();
    // Hand numbers go on from the last recorded one (the backend keys hands on deployment + number).
    this.engine.table.handNumber = Math.max(this.engine.table.handNumber, this.opts.farm.lastHandNumber(row.deploymentId));
    session.startedRealtime = f(this.opts.clock() - (this.opts.unixClock() - row.updatedUnix) - row.runtimeSeconds);
    this.tuneBots();
    return session;
  }

  private allocateSeat(): number {
    const free = this.firstFreeSeat();
    if (free >= 0) return free;
    const bot = this.poorestBotSeat();
    if (bot >= 0) this.dropBot(bot); // bump a filler bot: Agents play each other and whoever else is here
    return bot;
  }

  /** One AgentFarmLink.SyncLoop pass: progress + control for each Agent and claim, then try to claim another. */
  syncFarm(): void {
    const farm = this.opts.farm;
    for (const agent of [...this.host.agents.sessions]) {
      farm.updateProgress(this.host.progressBody(agent), this.name);
      const control = safe(() => farm.control(agent.deploymentId, this.name));
      if (control && (!control.validClaim || control.stopRequested)) agent.requestOwnerStop();
    }
    if (this.host.canAcceptSharedAgent(this.seatsForAgents())) {
      const config = farm.claim(this.name, this.stake.minBuyIn, { agents: this.host.agentsSeated, cap: AgentSessionHost.maxAgentsPerTable(this.seatCount) });
      if (config && !this.host.trySeatSharedAgent(config)) farm.release(config.DeploymentId ?? '', this.name);
    }
    // Claims wait for the next hand boundary; between hands here that is now. A stop before sitting returns the bankroll.
    for (const id of this.pendingIds()) {
      const control = safe(() => farm.control(id, this.name));
      if (control && !control.validClaim) this.host.cancelPending(id);
      else if (control?.stopRequested && this.host.cancelPending(id)) {
        const row = farm.row(id);
        if (row)
          farm.complete(newAgentSummary({
            DeploymentId: id, OwnerPlayFabId: row.ownerId, StrategyPreset: row.profile, StrategyVersion: row.strategyVersion,
            StopReason: AgentStopReasons.OwnerStop, StartingBankroll: row.bankroll, EndingStack: row.bankroll, SessionName: this.name,
            CompletedUnix: this.opts.unixClock(),
          }), this.name);
      }
    }
    for (const a of this.host.activatePending(() => this.allocateSeat())) this.bots.set(a.seat, a.bot);
    this.tuneBots();
  }

  private pendingIds(): string[] {
    return this.opts.farm.deployments.filter((r) => this.host.isPending(r.deploymentId)).map((r) => r.deploymentId);
  }

  /** Deals and plays one hand to the end (the dedicated GameLoop body). False when no hand could be dealt. */
  playHand(): boolean {
    for (const a of this.host.activatePending(() => this.allocateSeat())) this.bots.set(a.seat, a.bot);
    this.tuneBots();
    if (this.engine.countFundedPlayers() < 2) return false;
    this.host.beginHand();
    for (const s of this.host.haltForOwners()) this.vacateAgent(s.seat, s.playerId);
    if (this.engine.countFundedPlayers() < 2 || this.host.agents.sessions.length === 0) {
      this.tuneBots();
      return false;
    }

    this.engine.startHand();
    let guard = 0;
    while (this.engine.handInProgress && guard++ < 1000) {
      const seat = this.engine.awaitingActionSeat;
      const t = this.engine.table;
      const p = t.seats[seat]!;
      const ctx: BotContext = {
        seatIndex: seat, holeCards: p.holeCards, community: t.community, round: t.round, pot: t.pot, myStack: p.stack,
        myCurrentBet: p.currentBet, bigBlind: t.bigBlind, opponentsInHand: this.engine.countInHand() - 1,
        position: positionOf(t.buttonSeat, seat, t.seatCount), legal: this.engine.currentLegalActions!,
      };
      const bot = this.bots.get(seat) ?? new HeuristicBot(this.rng.next());
      this.engine.submitAction(seat, bot.decide(ctx));
    }

    this.host.completeHand();
    for (const s of this.host.evaluateAfterHand()) this.vacateAgent(s.seat, s.playerId);
    // BustOutSeats: busted fillers leave; the pack refills around the Agents.
    for (let s = 0; s < this.seatCount; s++) if (this.isBotSeat(s) && this.seats[s]!.stack <= 0) this.dropBot(s);
    this.tuneBots();
    return true;
  }

  /** The table is shutting down: every Agent is reported with what it has. */
  haltAll(): void {
    for (const s of this.host.haltAll()) this.vacateAgent(s.seat, s.playerId);
  }

  agentSeatOf(deploymentId: string): number {
    const s = this.host.agents.byDeployment(deploymentId);
    return s && this.seats[s.seat]?.id === agentPlayerId(deploymentId) ? s.seat : -1;
  }
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export interface LocalAgentRunnerOptions {
  farm: AgentFarm;
  /** Seconds between hands at an Agent table (a real Quick Play hand with its animations takes about this long). */
  handSeconds?: number;
  /** Hands dealt per table per tick at most (catch-up after the process was away is spread over ticks). */
  maxHandsPerTick?: number;
  /** Catch-up is capped at this many hands per table (older time is simply skipped). */
  maxCatchUpHands?: number;
  /** Unix seconds (may be fractional). */
  now?: () => number;
  seatCount?: number;
  seed?: number | null;
}

/** Runs the farm's Agents on headless tables, one per stake (more when a table fills). */
export class LocalAgentRunner {
  private readonly tables: HeadlessAgentTable[] = [];
  private readonly now: () => number;
  private readonly epoch: number;
  /** Simulated unix time: the hand being dealt (catch-up deals at the times the hands would have been dealt). */
  private simNow: number;
  private tableCounter = 1;
  private adopted = false;

  constructor(private readonly opts: LocalAgentRunnerOptions) {
    this.now = opts.now ?? (() => Date.now() / 1000);
    this.epoch = this.now();
    this.simNow = this.epoch;
  }

  get handSeconds(): number {
    return Math.max(0.5, this.opts.handSeconds ?? 12);
  }

  get activeTables(): readonly HeadlessAgentTable[] {
    return this.tables;
  }

  private newTable(stake: StakeTier): HeadlessAgentTable {
    const seed = this.opts.seed != null ? this.opts.seed + this.tableCounter * 7919 : null;
    const t = new HeadlessAgentTable({
      farm: this.opts.farm,
      name: `QP${stake.minBuyIn}-${this.tableCounter++}`,
      stake,
      seatCount: this.opts.seatCount ?? 7,
      seed,
      clock: () => this.simNow - this.epoch,
      unixClock: () => Math.floor(this.simNow),
    });
    t.nextHandAt = this.simNow + this.handSeconds;
    this.tables.push(t);
    return t;
  }

  /** Deployments a previous run left playing come back to a table with their stacks (instead of failing as lost). */
  private adoptRunning(): void {
    this.adopted = true;
    const real = this.now();
    for (const row of this.opts.farm.deployments) {
      if (row.phase !== 'seated' && row.phase !== 'playing' && row.phase !== 'stop_requested' && row.phase !== 'settling') continue;
      const lastSeen = row.updatedUnix;
      const t = this.newTable(StakeCatalog.get(row.stake));
      row.assignedTable = t.name; // the farm's own row: this table holds the claim now
      if (!t.adopt(row)) continue;
      const cap = (this.opts.maxCatchUpHands ?? 200) * this.handSeconds;
      t.nextHandAt = Math.max(lastSeen + this.handSeconds, real - cap);
    }
  }

  /** One pass: sync with the farm, claim queued Agents, deal the hands that are due. Returns true when anything changed. */
  tick(): boolean {
    const real = this.now();
    this.simNow = real;
    if (!this.adopted) this.adoptRunning();
    let changed = false;
    // A table for every stake with queued Agents and no table that can take them.
    for (const row of this.opts.farm.deployments) {
      if (row.phase !== 'queued') continue;
      const stake = StakeCatalog.get(row.stake);
      if (!this.tables.some((t) => t.stake.minBuyIn === stake.minBuyIn && t.host.canAcceptSharedAgent(7))) this.newTable(stake);
    }
    for (const t of this.tables) {
      const before = t.host.agentsSeated;
      t.syncFarm();
      if (t.host.agentsSeated !== before) changed = true;
      let dealt = 0;
      const max = this.opts.maxHandsPerTick ?? 25;
      while (!t.idle && t.nextHandAt <= real && dealt < max) {
        this.simNow = t.nextHandAt;
        if (t.playHand()) changed = true;
        t.nextHandAt += this.handSeconds;
        dealt++;
        t.syncFarm();
      }
      this.simNow = real;
      if (dealt > 0) t.syncFarm();
    }
    for (let i = this.tables.length - 1; i >= 0; i--) if (this.tables[i]!.idle) this.tables.splice(i, 1);
    return changed;
  }

  /**
   * Forgets its tables without reporting anything (another process took over the farm: it adopts the running Agents).
   * The next tick adopts again.
   */
  reset(): void {
    this.tables.length = 0;
    this.adopted = false;
  }

  /** Shutting down for good (not a page reload): report every Agent. */
  haltAll(): void {
    for (const t of this.tables) t.haltAll();
    this.tables.length = 0;
  }
}
