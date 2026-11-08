/**
 * The authoritative half of a cash table — port of Assets/Scripts/Net/PokerServerGame.cs (the dedicated Fusion
 * server's table) on the shared rules engine in @nomad/engine (packages/engine). It owns the one PokerEngine, seats players and bots, and
 * pumps the engine's event stream out over the TableNet. Hole cards are filtered per recipient here, before anything
 * touches the wire.
 *
 * Seating follows the C#: the table opens in Lobby; Quick Play sits on hello and auto-starts with filler bots for a
 * lone player (one chair always kept free); private rooms (party codes) spectate on hello, sit on Join Table, and wait
 * for the owner's Start. Seats only change at a hand boundary. Dropped players fold at once and keep the seat for the
 * disconnect grace; leaving goes immediately (or at the boundary). Buy-ins and cash-outs go through the chip ledger.
 *
 * Coroutines → async functions on a ServerClock (scaled in tests). Unity-only pieces not ported: StyleRecorder
 * ("My Twin" telemetry) and AgentReplay JSON (left to AgentHooks).
 */
import { ActionType, PlayerAction, type LegalActions } from '@nomad/engine/actions/actions';
import { HeuristicBot } from '@nomad/engine/bots/heuristicBot';
import { positionOf, type BotContext } from '@nomad/engine/bots/botContext';
import { QuickPlayFreeBots } from '@nomad/engine/bots/quickPlayFreeBots';
import { CryptoRandom, SeededRandom, type IRandom } from '@nomad/engine/cards/random';
import { PokerEngine } from '@nomad/engine/engine/pokerEngine';
import {
  TablePhase, type ActionRequestedEvent, type EngineEvent, type HandStartedEvent, type HoleCardsDealtEvent, type PokerEvent, type SeatSnapshot,
} from '@nomad/engine/events/pokerEvent';
import { HIDDEN_CARD, PokerEventCodec, pokerTokenHash, type WireEvent } from '@nomad/engine/events/pokerEventCodec';
import { ActionRouter, BotActionProvider, type ActionRequest, type IActionProvider } from '@nomad/engine/orchestration/actionProviders';
import type { TableSettings } from '@nomad/engine/orchestration/tableSettings';
import { AvatarCatalog } from '@nomad/engine/social/avatarCatalog';
import { StakeCatalog, type StakeTier } from '@nomad/engine/stakes/stakes';
import { BettingRound, PlayerStatus } from '@nomad/engine/state/state';
import { PokerChatRateLimiter } from './chat';
import { ChainTableMode } from './sessions';
import {
  AgentStopReasons, maxAgentsPerTable, newAgentSession, type AgentDeploymentConfig, type AgentHooks, type AgentSession,
} from './agents';
import type { ServerClock } from './clock';
import { ChipTableSession, type LogFn, type TableEconomy } from './chipTableSession';
import { PLAYER_NONE, type IPokerTableServer, type PlayerRef, type TableNet } from './tableNet';

/** PokerServerGame's serialized TableSettings in Test.unity (seat count 8, 5 bots, 4 s settle, 3 s between hands, 20 s turns). */
export const SERVER_TABLE_SETTINGS: TableSettings = {
  seatCount: 8,
  startingStack: 5000,
  smallBlind: 25,
  bigBlind: 50,
  playerName: 'You',
  botCount: 5,
  useFixedSeed: false,
  seed: 12345,
  botThinkMin: 0.6,
  botThinkMax: 1.4,
  dealDelay: 0.12,
  dealSettleDelay: 4,
  actionDelay: 0.4,
  showdownDelay: 2,
  betweenHands: 3,
  turnTimer: 20,
};

export interface PokerServerGameOptions {
  clock: ServerClock;
  log?: LogFn;
  settings?: Partial<TableSettings>;
  /** Seats that must be filled before the owner can start (Test.unity: 2). */
  minPlayersToStart?: number;
  /** How long a dropped player keeps their seat (Test.unity: 20 s; a dedicated server caps it at 5 s). */
  disconnectGrace?: number;
  /** GameMode.Server (every table is dedicated-hosted): caps the drop grace at 5 s. Default true. */
  dedicated?: boolean;
  /** The chip ledger. Null → this process is not the economy authority: everyone spectates (as the Editor without a key). */
  economy: TableEconomy | null;
  /** UnityEngine.Random (bot names, filler counts, buy-ins). Default Math.random. */
  random?: () => number;
  /** Deck RNG override (tests). Default CryptoRandom, or SeededRandom(seed) with useFixedSeed. */
  deckRandom?: IRandom;
  agentHooks?: AgentHooks;
  /**
   * After each chip hand passes the conservation check (before the checkpoints): the bots' (house's) and humans' net
   * for the hand and every seated stack. Hosts record it (game server: house totals in D1, hand batches in R2).
   */
  onHandSettled?: (hand: SettledHand) => void;
  /** Every engine event as the server processes it, before anything is filtered for players (hosts' recorders). */
  onEngineEvent?: (e: EngineEvent) => void;
}

export interface SettledHand {
  tableId: string | null;
  handNumber: number;
  /** Chips the bots won (+) or lost (−) this hand: the house's side of the humans' result. */
  botDelta: number;
  humanDelta: number;
  /** Everyone dealt into the hand: final stack, whether they won a pot, and their showdown hand (HandCategory). */
  stacks: { id: string; seat: number; startStack: number; stack: number; bot: boolean; won: boolean; showdownCategory: number | null }[];
}

class SeatOccupant {
  player: PlayerRef = PLAYER_NONE; // PLAYER_NONE while disconnected
  name = '';
  token = ''; // stable across reconnects
  tokenHash = '0';
  dealtIn = false; // false while waiting for the next hand to be seated in the engine
  leaving = false; // going for good: fold on sight, release at the next boundary
  disconnectedAt = 0; // clock.now() of the drop; 0 when connected
  playFabId: string | null = null; // the engine seat id: what the ledger keys on
  funded = false; // the buy-in has been taken
  buyInChips = 0;
  requestedBuyIn = 0;
  avatar = AvatarCatalog.None;

  get connected(): boolean {
    return this.player !== PLAYER_NONE;
  }

  /** Dropped rather than merely absent: only a real disconnect arms the grace timer. */
  get dropped(): boolean {
    return !this.connected && this.disconnectedAt > 0;
  }
}

/** RemoteActionProvider: a remote human's seat "decides" by waiting for their action RPC. */
export class RemoteActionProvider implements IActionProvider {
  private pending: ((a: PlayerAction) => void) | null = null;

  requestAction(_request: ActionRequest, submit: (a: PlayerAction) => void, signal: AbortSignal): void {
    this.pending = submit;
    signal.addEventListener('abort', () => this.cancel(), { once: true });
  }

  /** Called from the submit RPC. Ignores stray submissions when no action is awaited. */
  deliver(action: PlayerAction): void {
    const pending = this.pending;
    this.pending = null;
    pending?.(action);
  }

  /** The server turn timer expired; the pending request is abandoned. */
  cancel(): void {
    this.pending = null;
  }
}

const ReactionBurst = 4;
const ReactionRefillSeconds = 1.5;
const VoiceStateBurst = 6;
const VoiceStateRefillSeconds = 0.5;
const PendingBuyInWaitSeconds = 30;

export class PokerServerGame implements IPokerTableServer {
  readonly settings: TableSettings;
  private readonly minPlayersToStart: number;
  private readonly disconnectGrace: number;
  private readonly clock: ServerClock;
  private readonly log: LogFn;
  private readonly random: () => number;

  private net!: TableNet;
  private engine!: PokerEngine;
  private router!: ActionRouter;
  private readonly events: EngineEvent[] = [];
  private eventWaiter: (() => void) | null = null;
  private sequence = 0;
  private phase = TablePhase.Lobby;
  private botLabel = 1;
  private readonly usedBotNames = new Set<string>();
  private ownerTokenHash = '0';
  private autoStart = false;
  private gameLoopRunning = false;
  private pendingAutoStart = false;
  private disposed = false;
  private stopUpdate: (() => void) | null = null;

  private readonly reactionLimiters = new Map<PlayerRef, PokerChatRateLimiter>();
  private readonly voiceLimiters = new Map<PlayerRef, PokerChatRateLimiter>();
  private readonly avatarLimiters = new Map<PlayerRef, PokerChatRateLimiter>();
  private readonly voiceBySeat = new Map<number, { talking: boolean; muted: boolean }>();
  private renderBudget = 0;
  private economy: ChipTableSession | null = null;
  private readonly stacksAtHandStart = new Map<string, number>();
  /** This hand's pot winners and showdown categories, by seat (for onHandSettled). */
  private readonly handWinners = new Set<number>();
  private readonly handShowdown = new Map<number, number>();

  private readonly verifiedPlayers = new Map<PlayerRef, string>();
  private readonly avatarsByPlayer = new Map<PlayerRef, number>();
  private readonly humans = new Map<number, SeatOccupant>();
  private readonly remoteProviders = new Map<number, RemoteActionProvider>();
  private readonly pendingBots = new Set<number>();
  private readonly pendingBotNames = new Map<number, string>();
  private readonly pendingVacate = new Set<number>();
  private settleOpen = false;
  /** Players who pressed Leave: their client credits its stack itself (ApplyOptimisticCashOutCredit). */
  private readonly leftOnPurpose = new Set<string>();

  // Agents (AgentSessionHost, per table here).
  readonly agents: AgentSession[] = [];
  private readonly pendingAgents: AgentDeploymentConfig[] = [];
  private agentHandActions: string[] = [];
  private agentBoardCards = '';

  constructor(private readonly opts: PokerServerGameOptions) {
    this.settings = { ...SERVER_TABLE_SETTINGS, ...opts.settings };
    this.minPlayersToStart = Math.max(2, opts.minPlayersToStart ?? 2);
    this.disconnectGrace = opts.disconnectGrace ?? 20;
    this.clock = opts.clock;
    this.log = opts.log ?? ((level, m) => console[level === 'info' ? 'log' : level](m));
    this.random = opts.random ?? Math.random;
  }

  // ---- Public surface (hooks for tournaments, agents, tests) -------------------------------------

  get isChipTable(): boolean {
    return this.economy !== null;
  }

  /** The chip session's table id (fresh per table session), or null on a table with no ledger. */
  get tableId(): string | null {
    return this.economy?.tableId ?? null;
  }

  /** True while this table holds a seat for `playerId` (seated, or dropped within the grace). */
  holdsSeatFor(playerId: string): boolean {
    return this.holdsSeat(playerId);
  }

  get tablePhase(): TablePhase {
    return this.phase;
  }

  get isQuickPlay(): boolean {
    return this.autoStart;
  }

  /** Owned agents seated here or waiting for a hand boundary to sit. */
  get agentCount(): number {
    return this.agents.length + this.pendingAgents.length;
  }

  /** Is this deployment seated here, or about to be? */
  hostsAgent(deploymentId: string): boolean {
    return this.agents.some((a) => a.deploymentId === deploymentId && a.active) || this.pendingAgents.some((p) => p.deploymentId === deploymentId);
  }

  get pokerEngine(): PokerEngine {
    return this.engine;
  }

  get seatCount(): number {
    return this.settings.seatCount;
  }

  /** How many humans hold a seat (connected, or inside the grace). */
  get humanCount(): number {
    let n = 0;
    for (const o of this.humans.values()) if (!o.leaving) n++;
    return n;
  }

  private get seatsLocked(): boolean {
    return this.engine.handInProgress || this.settleOpen;
  }

  private get isPrivatePlay(): boolean {
    return ChainTableMode.isPrivateSession(this.net.sessionName, this.net.properties[ChainTableMode.KindProperty]);
  }

  private resolveStake(): StakeTier {
    return ChainTableMode.resolveStake(this.net.sessionName, this.net.properties[ChainTableMode.StakeProperty] ?? null);
  }

  // ---- Activation ----------------------------------------------------------------------------

  activate(net: TableNet): void {
    this.net = net;
    this.autoStart = this.isQuickPlaySession();
    this.economy = this.createLedgerSession();

    if (this.economy) {
      this.economy.onHalted(() => this.onEconomyHalted());
      // Local ticket sync: a player who left on purpose already shows the stack back in their wallet, so the
      // browser now holds the post-cash-out balance even if it never hears the push (the socket closes 0.75 s later).
      this.economy.onPaid = (id, balance) => {
        if (this.leftOnPurpose.delete(id)) this.opts.economy?.noteSynced?.(id, balance);
      };
      this.settings.smallBlind = this.economy.stakes.smallBlind;
      this.settings.bigBlind = this.economy.stakes.bigBlind;
    } else this.applyFreePlayStake();

    // Private rooms ignore the stake ladder. 5/10 makes a 500–1,000 buy-in 50–100 big blinds.
    if (this.isPrivatePlay) {
      this.settings.smallBlind = ChainTableMode.PrivateSmallBlind;
      this.settings.bigBlind = ChainTableMode.PrivateBigBlind;
      this.settings.startingStack = ChainTableMode.PrivateMaxBuyIn;
    }

    this.buildEngine();

    this.log('info', this.economy
      ? this.isPrivatePlay
        ? `[PokerServer] Private table ${this.economy.tableId} open — buy-in ${ChainTableMode.PrivateMaxBuyIn} Coins, blinds ${this.settings.smallBlind}/${this.settings.bigBlind}.`
        : `[PokerServer] Chip table ${this.economy.tableId} open — ${this.economy.stakes.displayName}, buy-in ${this.economy.stakes.buyInChips}, blinds ${this.economy.stakes.smallBlind}/${this.economy.stakes.bigBlind}${this.autoStart ? ', auto-start' : ''}.`
      : `[PokerServer] Table open with NO chip ledger — nothing will be charged or paid out. (${this.autoStart ? 'Quick Play / agent auto-start' : 'private — owner starts'}.)`);

    this.broadcastRoster();
    this.broadcastLobby();
    if (this.economy) this.broadcastEconomy();
    this.stopUpdate = this.clock.every(0.1, () => this.update());
  }

  private createLedgerSession(): ChipTableSession | null {
    const local = this.opts.economy;
    if (!local) {
      this.log('warn', '[PokerServer] No Coins ledger — players can spectate only (no free-play seating).');
      return null;
    }
    const stake = this.resolveStake();
    this.settings.startingStack = stake.startingStack > 0 ? stake.startingStack : this.settings.startingStack;
    return new ChipTableSession(
      local.ledger,
      { id: 'st' + stake.minBuyIn, displayName: stake.displayName, buyInChips: stake.minBuyIn, smallBlind: stake.smallBlind, bigBlind: stake.bigBlind },
      this.clock,
      this.log,
    );
  }

  private applyFreePlayStake(): void {
    const stake = this.resolveStake();
    this.settings.smallBlind = stake.smallBlind;
    this.settings.bigBlind = stake.bigBlind;
    this.settings.startingStack = stake.startingStack;
  }

  private buildEngine(): void {
    const s = this.settings;
    // Cash tables shuffle with a secure generator (a clock-seeded System.Random let a player search the seed).
    const rng: IRandom = this.opts.deckRandom ?? (s.useFixedSeed ? new SeededRandom(s.seed) : new CryptoRandom());
    this.engine = new PokerEngine({ seatCount: s.seatCount, smallBlind: s.smallBlind, bigBlind: s.bigBlind, startingStack: s.startingStack }, rng);
    this.engine.onEvent((e) => {
      this.events.push(e);
      const w = this.eventWaiter;
      this.eventWaiter = null;
      w?.();
    });
    this.router = new ActionRouter();
  }

  /** Quick Play pools / overflow and `kind=quick` sessions auto-start; private rooms do not. */
  private isQuickPlaySession(): boolean {
    const name = this.net.sessionName;
    if (name && (ChainTableMode.isQuickPlayPoolSession(name) || ChainTableMode.isQuickPlayOverflowSession(name))) return true;
    return this.net.properties[ChainTableMode.KindProperty] === ChainTableMode.KindQuick;
  }

  // ---- Connection lifecycle (PokerTableNet RPCs) ----------------------------------------------

  onHello(player: PlayerRef, playerName: string, token: string, sessionTicket: string, buyInChips = 0): void {
    if (!this.economy) {
      this.log('warn', `[PokerServer] ${playerName} hello on a table with no Coins ledger; spectating.`);
      this.spectateJoiner(player);
      return;
    }
    if (!sessionTicket || !sessionTicket.trim()) {
      this.log('warn', `[PokerServer] ${playerName} joined without a session ticket; spectating.`);
      this.spectateJoiner(player);
      return;
    }
    this.run(this.helloRoutine(player, playerName, token, sessionTicket, buyInChips));
  }

  private async helloRoutine(player: PlayerRef, playerName: string, token: string, sessionTicket: string, buyInChips: number): Promise<void> {
    const economy = this.economy!;
    // Local stand-in for PlayFab: the client's local ticket becomes a session this server's ledger knows.
    const session = this.opts.economy?.adoptTicket(sessionTicket) ?? null;
    const playFabId = session ? await economy.authenticate(session) : null;
    if (this.disposed) return;
    if (!playFabId) {
      this.log('warn', `[PokerServer] ${playerName}'s session ticket did not verify; spectating.`);
      this.spectateJoiner(player);
      return;
    }

    // Clear a crash-left seat lock BEFORE seating — but not when walking back into a seat THIS table still holds.
    if (!this.holdsSeat(playFabId)) {
      const reconciled = await economy.reconcile(playFabId);
      if (!reconciled) this.log('warn', `[PokerServer] Could not reconcile ${playFabId}'s previous seat; their buy-in may be refused.`);
    }
    // (Not in the C#: the connection may have gone while the ledger answered — don't seat a ghost.)
    if (this.disposed || !this.net.activePlayers().includes(player)) return;

    this.verifiedPlayers.set(player, playFabId);
    this.announceEconomy();
    this.seatVerified(player, playerName, token, playFabId, buyInChips);
  }

  /** Old clients' table-paid retention grants are refused; the CloudScript pays them. */
  onRetentionGrant(_player: PlayerRef, idempotencyKey: string): void {
    this.net?.broadcastRetentionGrantResult(idempotencyKey, false, -1);
  }

  private seatVerified(player: PlayerRef, playerName: string, token: string, playFabId: string | null, buyInChips = 0): void {
    if (!playerName || !playerName.trim()) playerName = `Player ${player}`;
    if (!token || !token.trim()) token = `player-${player}`;

    // Reconnect: a known player reclaims their seat — only when its owner is actually gone. The PlayFabId wins.
    let tokenHash = pokerTokenHash(token);
    for (const [seat, occ] of this.humans) {
      const same = playFabId ? occ.playFabId === playFabId : occ.token ? occ.token === token : occ.tokenHash === tokenHash;
      if (!same) continue;

      if (occ.connected) {
        if (playFabId) {
          // The same ACCOUNT twice — one player in two tabs. The ledger holds one lock; a second seat is unpaid for.
          this.log('warn', `[PokerServer] ${playerName} already holds seat ${seat}; the duplicate connection spectates.`);
          this.spectateJoiner(player);
          return;
        }
        token = `${token}#${player}`;
        tokenHash = pokerTokenHash(token);
        this.log('warn', `[PokerServer] ${playerName} presented seat ${seat}'s token while that player is still connected; seating them separately.`);
        break;
      }

      occ.player = player;
      occ.name = playerName;
      const avatarBack = this.avatarsByPlayer.get(player);
      if (avatarBack !== undefined) occ.avatar = avatarBack;
      occ.token = token;
      occ.tokenHash = tokenHash;
      // Back inside the grace window: cancel the pending release entirely.
      occ.disconnectedAt = 0;
      occ.leaving = false;
      this.pendingVacate.delete(seat);

      if (this.ownerTokenHash === '0') this.ownerTokenHash = tokenHash;
      this.net.sendSeatAssignment(player, seat);
      this.broadcastRoster();
      this.broadcastLobby();
      this.sendHandViewCatchUp(player);
      this.log('info', `[PokerServer] ${playerName} reconnected to seat ${seat}.`);
      return;
    }

    // Quick Play sits on hello; party rooms wait for Join Table so the newcomer can see who is sitting.
    if (!this.isQuickPlay) {
      this.spectateJoiner(player);
      return;
    }
    this.claimSeat(player, playerName, token, tokenHash, 'joined', playFabId, buyInChips);
  }

  private claimSeat(player: PlayerRef, playerName: string, token: string, tokenHash: string, verb: string, playFabId: string | null = null, buyInChips = 0): void {
    // Never at the same table as their own Agent: they watch instead.
    if (this.hasAgentOf(playFabId)) {
      this.log('warn', `[PokerServer] ${playerName} ${verb} but their own Agent plays here; spectating.`);
      this.spectateJoiner(player);
      return;
    }

    const seat = this.allocateSeatForHuman();
    if (seat < 0) {
      this.log('warn', `[PokerServer] ${playerName} ${verb} but the table is full of players.`);
      this.spectateJoiner(player);
      return;
    }

    const stack = this.resolveBuyInChips(buyInChips);
    const occ = new SeatOccupant();
    occ.player = player;
    occ.name = playerName;
    occ.token = token;
    occ.tokenHash = tokenHash;
    occ.playFabId = playFabId;
    occ.requestedBuyIn = stack;
    occ.avatar = this.avatarsByPlayer.get(player) ?? AvatarCatalog.None;
    if (!this.economy) {
      this.log('warn', `[PokerServer] ${playerName} ${verb} refused — no Coins ledger on this host.`);
      this.spectateJoiner(player);
      return;
    }

    this.humans.set(seat, occ);
    if (this.ownerTokenHash === '0') this.ownerTokenHash = tokenHash; // first human to arrive owns the table
    this.net.sendSeatAssignment(player, seat);

    this.log('info', `[PokerServer] ${playerName} ${verb} seat ${seat}; taking buy-in ${stack}.`);
    this.run(this.buyInRoutine(seat, occ, stack));

    this.tuneQuickPlayBots(false);
    this.broadcastRoster();
    this.broadcastLobby();
    this.sendHandViewCatchUp(player);
  }

  private resolveBuyInChips(requested: number): number {
    if (this.isPrivatePlay) return ChainTableMode.clampPrivateBuyIn(requested);
    let min = this.settings.bigBlind > 0 ? this.settings.bigBlind * 20 : 50;
    const stake = this.resolveStake();
    if (stake.minBuyIn > 0) min = stake.minBuyIn;
    let max = stake.startingStack > 0 ? stake.startingStack : this.settings.startingStack;
    if (max < min) max = min;
    if (requested <= 0) return max;
    if (requested < min) return min;
    if (requested > max) return max;
    return requested;
  }

  /** Takes the buy-in for a claimed chair, and deals the player in once it lands. A refusal releases the chair. */
  private async buyInRoutine(seat: number, occ: SeatOccupant, chips: number): Promise<void> {
    const result = await this.economy!.buyIn(occ.playFabId!, seat, chips);
    if (this.disposed) {
      if (result.success) this.economy?.fireAndForgetCashOut(occ.playFabId!, chips);
      return;
    }

    // The chair changed hands while we waited: undo the ledger call or the chips are stranded.
    if (this.humans.get(seat) !== occ) {
      if (result.success) {
        this.log('warn', `[PokerServer] ${occ.name} left seat ${seat} while buying in; returning the buy-in.`);
        if (!this.seatsLocked) this.economy!.fireAndForgetCashOut(occ.playFabId!, chips);
        else this.economy!.queueCashOut(occ.playFabId!, chips);
      }
      return;
    }

    if (!result.success) {
      this.log('warn', `[PokerServer] ${occ.name} could not buy in: ${result.error}`);
      if (occ.connected) {
        this.net.sendSeatAssignment(occ.player, -1);
        this.spectateJoiner(occ.player);
      }
      if (this.seatsLocked) this.pendingVacate.add(seat);
      else this.releaseSeat(seat);
      this.broadcastRoster();
      this.broadcastLobby();
      return;
    }

    occ.funded = true;
    occ.buyInChips = chips;
    // Only at a real boundary; otherwise ApplyPendingSeatChanges deals them in at the top of the next hand.
    if (!this.seatsLocked) this.seatHuman(seat, occ);

    this.log('info', `[PokerServer] ${occ.name} bought into seat ${seat} for ${occ.buyInChips} chips (balance ${result.balance}).`);
    if (occ.connected && result.balance >= 0) this.pushBalance(occ.player, occ.playFabId!, result.balance);
    this.broadcastRoster();
    this.broadcastLobby();
  }

  /** A seatless player buying in (busted, left, or watching): the same act as arriving. */
  onBuyIn(source: PlayerRef, playerName: string, token: string, buyInChips = 0): void {
    const seat = this.seatOf(source);
    if (seat >= 0) {
      this.log('warn', `[PokerServer] Buy-in ignored: ${source} already holds seat ${seat}.`);
      return;
    }
    if (!playerName || !playerName.trim()) playerName = `Player ${source}`;
    if (!token || !token.trim()) token = `player-${source}`;

    // Identity was proved at hello and is remembered for this connection.
    const playFabId = this.verifiedPlayers.get(source) ?? null;
    if (this.economy && !playFabId) {
      this.log('warn', `[PokerServer] Rebuy from ${source} with no verified identity; spectating.`);
      this.spectateJoiner(source);
      return;
    }
    this.claimSeat(source, playerName, token, pokerTokenHash(token), 'bought in', playFabId, buyInChips);
  }

  /** A connection dropped: fold the hand now, keep the seat for the grace, release it if nobody returns. */
  onPlayerLeft(player: PlayerRef): void {
    this.reactionLimiters.delete(player);
    this.voiceLimiters.delete(player);
    this.avatarLimiters.delete(player);
    this.avatarsByPlayer.delete(player);
    this.verifiedPlayers.delete(player);

    const seat = this.seatOf(player);
    if (seat < 0) return;
    const occ = this.humans.get(seat)!;
    this.clearVoiceState(seat);

    occ.player = PLAYER_NONE;
    occ.disconnectedAt = Math.max(1e-6, this.clock.now());
    this.foldNowIfAwaiting(seat);
    this.log('info', `[PokerServer] ${occ.name} dropped from seat ${seat}; holding it for ${this.dropGrace.toFixed(0)}s.`);

    if (occ.tokenHash === this.ownerTokenHash) this.promoteOwner();
    this.broadcastRoster();
    this.broadcastLobby();
  }

  /** Leaving on purpose: no grace — fold, and the seat goes as soon as it safely can. */
  onLeaveTable(source: PlayerRef): void {
    const seat = this.seatOf(source);
    if (seat < 0) return;
    const occ = this.humans.get(seat)!;
    occ.leaving = true;
    if (occ.playFabId && occ.funded) this.leftOnPurpose.add(occ.playFabId);
    this.foldNowIfAwaiting(seat);
    // They stay connected (leaving a table is not leaving the session): tell them the seat is gone right away.
    this.net.sendSeatAssignment(source, -1);

    if (this.seatsLocked) this.pendingVacate.add(seat);
    else this.releaseSeat(seat);
    this.log('info', `[PokerServer] ${occ.name} left seat ${seat}${this.seatsLocked ? ' (seat clears after this hand).' : '.'}`);

    if (occ.tokenHash === this.ownerTokenHash) this.promoteOwner();
    this.removeBotsIfNoHumans();
    this.broadcastRoster();
    this.broadcastLobby();
  }

  private foldNowIfAwaiting(seat: number): void {
    if (!this.engine.handInProgress || this.engine.awaitingActionSeat !== seat) return;
    this.remoteProviders.get(seat)?.deliver(PlayerAction.fold());
  }

  /** Fully removes a human seat. Never while a hand runs — queue pendingVacate instead. */
  private releaseSeat(seat: number): void {
    const occ = this.humans.get(seat);
    if (occ && this.economy && occ.playFabId && occ.funded) {
      const chips = this.chipsOwed(seat, occ);
      if (!this.seatsLocked) this.run(this.cashOutAndNotify(occ.player, occ.playFabId, chips));
      else this.economy.queueCashOut(occ.playFabId, chips);
    }
    this.clearVoiceState(seat);
    this.humans.delete(seat);
    this.remoteProviders.delete(seat);
    this.pendingVacate.delete(seat);
    this.forgetBotName(this.engine.table.seats[seat]!.name);
    this.engine.vacateSeat(seat);
    this.router.remove(seat);
  }

  /** A joiner still waiting for the next hand was never put in the engine: their chips are the buy-in, untouched. */
  private chipsOwed(seat: number, occ: SeatOccupant): number {
    if (!occ.dealtIn) return occ.buyInChips;
    const p = this.engine.table.seats[seat]!;
    return p.isOccupied ? p.stack : 0;
  }

  private get dropGrace(): number {
    return this.opts.dedicated === false ? this.disconnectGrace : Math.min(this.disconnectGrace, 5);
  }

  private sweepDisconnected(): void {
    if (this.humans.size === 0) return;
    let expired: number[] | null = null;
    for (const [seat, occ] of this.humans) {
      if (occ.leaving && !this.seatsLocked) {
        (expired ??= []).push(seat);
        continue;
      }
      if (!occ.dropped || occ.leaving) continue;
      if (this.clock.now() - occ.disconnectedAt < this.dropGrace) continue;
      occ.leaving = true;
      (expired ??= []).push(seat);
    }
    if (!expired) return;
    for (const seat of expired) {
      const occ = this.humans.get(seat);
      if (!occ) continue;
      this.log('info', `[PokerServer] ${occ.name} did not return; releasing seat ${seat}.`);
      if (this.seatsLocked) this.pendingVacate.add(seat);
      else this.releaseSeat(seat);
    }
    this.removeBotsIfNoHumans();
    this.broadcastRoster();
    this.broadcastLobby();
  }

  private update(): void {
    if (this.disposed) return;
    if (this.engine) this.sweepDisconnected();
    this.tryActivatePendingAgent();
    if (this.agents.some((a) => a.ownerStopRequested) && !this.gameLoopRunning) this.tryHaltAgentsForOwners();
  }

  /** OnDestroy: best-effort payout for every funded seat. Anything that does not land is covered by the seat lock. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopUpdate?.();
    const w = this.eventWaiter;
    this.eventWaiter = null;
    w?.();
    for (const agent of [...this.agents]) this.stopAgent(agent, AgentStopReasons.Halted);
    if (this.economy && !this.economy.isHalted) {
      this.economy.fireAndForgetPendingCashOuts();
      for (const [seat, occ] of this.humans) {
        if (!occ.funded || !occ.playFabId) continue;
        this.economy.fireAndForgetCashOut(occ.playFabId, this.chipsOwed(seat, occ));
      }
    }
  }

  onActionSubmitted(source: PlayerRef, seat: number, action: PlayerAction): void {
    const occ = this.humans.get(seat);
    if (!occ || occ.player !== source) {
      this.log('warn', `[PokerServer] Rejected action from ${source} for seat ${seat} (not their seat).`);
      return;
    }
    this.remoteProviders.get(seat)?.deliver(action);
  }

  /** A reaction, attributed by the authority (never over someone else's seat), throttled and dropped when over. */
  onReaction(source: PlayerRef, reactionId: number): void {
    const seat = this.seatOf(source);
    if (seat < 0) return;
    if (!this.limiter(this.reactionLimiters, source, ReactionBurst, ReactionRefillSeconds).tryConsume(this.clock.now())) return;
    this.replicate({ type: 'Reaction', seat, reactionId: reactionId & 0xff });
  }

  /** A client reporting its own microphone; unchanged reports cost nothing, changes are rate limited. */
  onVoiceState(source: PlayerRef, talking: boolean, muted: boolean): void {
    const seat = this.seatOf(source);
    if (seat < 0) return;
    const last = this.voiceBySeat.get(seat);
    if (last && last.talking === talking && last.muted === muted) return;
    if (!this.limiter(this.voiceLimiters, source, VoiceStateBurst, VoiceStateRefillSeconds).tryConsume(this.clock.now())) return;
    this.voiceBySeat.set(seat, { talking, muted });
    this.replicate({ type: 'VoiceState', seat, isTalking: talking, isMuted: muted });
  }

  /** A player's profile picture: remembered per connection, put on their seat; the broadcast is throttled. */
  onAvatar(source: PlayerRef, avatar: number): void {
    avatar &= 0xff;
    if (this.avatarsByPlayer.get(source) === avatar) return;
    this.avatarsByPlayer.set(source, avatar);
    const seat = this.seatOf(source);
    if (seat < 0) return;
    this.humans.get(seat)!.avatar = avatar;
    if (!this.limiter(this.avatarLimiters, source, 3, 1.5).tryConsume(this.clock.now())) return;
    this.broadcastRoster();
  }

  private limiter(map: Map<PlayerRef, PokerChatRateLimiter>, player: PlayerRef, burst: number, refill: number): PokerChatRateLimiter {
    let l = map.get(player);
    if (!l) map.set(player, (l = new PokerChatRateLimiter(burst, refill)));
    return l;
  }

  private clearVoiceState(seat: number): void {
    if (!this.voiceBySeat.delete(seat)) return;
    this.replicate({ type: 'VoiceState', seat, isTalking: false, isMuted: false });
  }

  // ---- Lobby commands (owner only) -------------------------------------------------------------

  onAddBot(source: PlayerRef): void {
    if (!this.requireOwner(source, 'add a bot')) return;
    const seat = this.firstFreeSeat();
    if (seat < 0) {
      this.log('warn', '[PokerServer] Add bot ignored: no free seat.');
      return;
    }
    if (this.seatsLocked) {
      this.pendingBots.add(seat);
      this.pendingBotNames.set(seat, this.takeQuickPlayBotName());
    } else this.seatBot(seat);
    this.broadcastRoster();
    this.broadcastLobby();
  }

  onRemoveBot(source: PlayerRef, seat: number): void {
    if (!this.requireOwner(source, 'remove a bot')) return;
    if (seat < 0) seat = this.lastBotSeat();
    if (seat < 0 || seat >= this.settings.seatCount || !this.isBotSeat(seat)) {
      this.log('warn', `[PokerServer] Remove bot ignored: seat ${seat} holds no bot.`);
      return;
    }
    if (!this.pendingBots.delete(seat)) {
      if (this.seatsLocked) this.pendingVacate.add(seat);
      else {
        this.forgetBotName(this.engine.table.seats[seat]!.name);
        this.engine.vacateSeat(seat);
        this.router.remove(seat);
      }
    } else this.forgetQueuedBotName(seat);
    this.broadcastRoster();
    this.broadcastLobby();
  }

  /** Bots are only there for humans: with nobody left, drop every filler bot (owned agents keep the table alive). */
  private removeBotsIfNoHumans(): void {
    if (this.anyHumanRemaining()) return;
    if (this.anyAgentRemaining()) return;
    for (const name of this.pendingBotNames.values()) this.forgetBotName(name);
    this.pendingBotNames.clear();
    this.pendingBots.clear();
    let changed = false;
    for (let seat = 0; seat < this.settings.seatCount; seat++) {
      const p = this.engine.table.seats[seat]!;
      const botHere = p.isOccupied && p.isBot && !p.isAgent && !this.humans.has(seat);
      if (!botHere) continue;
      changed = true;
      if (this.seatsLocked) {
        this.pendingVacate.add(seat);
        continue;
      }
      this.forgetBotName(p.name);
      this.engine.vacateSeat(seat);
      this.router.remove(seat);
      this.pendingVacate.delete(seat);
    }
    if (changed) this.log('info', '[PokerServer] No humans left — removed bots.');
  }

  private anyHumanRemaining(): boolean {
    for (const occ of this.humans.values()) {
      if (occ.leaving) continue;
      if (occ.connected || occ.dropped) return true;
    }
    return false;
  }

  private anyAgentRemaining(): boolean {
    if (this.agents.length > 0) return true;
    for (const p of this.engine.table.seats) if (p.isOccupied && p.isAgent) return true;
    return false;
  }

  onStartGame(source: PlayerRef): void {
    if (this.autoStart) {
      this.log('info', '[PokerServer] Start ignored: Quick Play auto-starts.');
      return;
    }
    if (!this.requireOwner(source, 'start the game')) return;
    if (!this.tryBeginPlay(true)) return;
    this.startRunning();
  }

  /** Quick Play only: starts on the next tick when the table is waiting and enough seats are ready. */
  private tryAutoStart(): void {
    if (!this.autoStart || this.gameLoopRunning || this.phase === TablePhase.Playing) return;
    if (this.pendingAutoStart) return;
    this.pendingAutoStart = true;
    void this.clock.frame().then(() => {
      this.pendingAutoStart = false;
      if (this.disposed) return;
      if (!this.autoStart || this.gameLoopRunning || this.phase === TablePhase.Playing) return;
      if (this.economy?.isHalted) return;
      if (!this.anyHumanRemaining() && !this.anyAgentRemaining()) return;
      if (!this.tryBeginPlay(false)) return;
      this.startRunning();
    });
  }

  private tryBeginPlay(logFailures: boolean): boolean {
    if (this.gameLoopRunning || this.phase === TablePhase.Playing) {
      if (logFailures) this.log('warn', '[PokerServer] Start ignored: already playing.');
      return false;
    }
    // Filler bots count as funded on sitting; without this the first hand would race the human's debit.
    if (this.hasPendingBuyIn()) {
      if (logFailures) this.log('warn', '[PokerServer] Start ignored: a buy-in is still in flight.');
      return false;
    }
    const seated = this.seatedCount();
    if (seated < this.minPlayersToStart) {
      if (logFailures) this.log('warn', `[PokerServer] Start ignored: ${seated}/${this.minPlayersToStart} seats filled.`);
      return false;
    }
    if (this.economy) {
      if (this.economy.isHalted) {
        if (logFailures) this.log('warn', '[PokerServer] Start ignored: the chip ledger halted this table.');
        return false;
      }
      const funded = this.fundedSeatCount();
      if (funded < this.minPlayersToStart) {
        if (logFailures) this.log('warn', `[PokerServer] Start ignored: ${funded}/${this.minPlayersToStart} funded seats.`);
        return false;
      }
    } else if (this.phase === TablePhase.GameOver && !this.isQuickPlay) this.rebuyEveryone();
    return true;
  }

  private hasPendingBuyIn(): boolean {
    for (const [seat, occ] of this.humans) {
      if (occ.leaving || this.pendingVacate.has(seat)) continue;
      if (!occ.funded) return true;
    }
    return false;
  }

  private async waitForPendingBuyIns(): Promise<void> {
    if (!this.hasPendingBuyIn()) return;
    const deadline = this.clock.now() + PendingBuyInWaitSeconds;
    this.log('info', '[PokerServer] Holding the deal for an in-flight buy-in.');
    while (this.hasPendingBuyIn() && this.clock.now() < deadline && !this.disposed) await this.clock.wait(0.05);
    if (this.hasPendingBuyIn()) this.log('warn', '[PokerServer] Timed out waiting for buy-in; dealing without the pending joiner.');
  }

  private startRunning(): void {
    const seated = this.seatedCount();
    this.phase = TablePhase.Playing;
    this.gameLoopRunning = true;
    this.broadcastLobby();
    this.log('info', `[PokerServer] ${this.autoStart ? 'Quick Play auto-started' : 'Owner started'} with ${seated} players.`);
    void this.gameLoop();
  }

  private requireOwner(source: PlayerRef, what: string): boolean {
    if (this.isOwner(source)) return true;
    this.log('warn', `[PokerServer] Rejected request to ${what} from ${source} (not the table owner).`);
    return false;
  }

  // ---- Seating ----------------------------------------------------------------------------------

  private seatHuman(seat: number, occ: SeatOccupant): void {
    if (this.engine.table.seats[seat]!.isOccupied) {
      this.engine.vacateSeat(seat); // a bot yielding its seat to a real player
      this.router.remove(seat);
    }
    this.engine.seatPlayer(seat, occ.playFabId ?? occ.token, occ.name, false, occ.buyInChips);
    let provider = this.remoteProviders.get(seat);
    if (!provider) this.remoteProviders.set(seat, (provider = new RemoteActionProvider()));
    this.router.set(seat, provider);
    occ.dealtIn = true;
  }

  /** A filler bot: a fresh personality, a random buy-in in [table min, table max]. */
  private seatBot(seat: number, name: string | null = null, stack = -1): void {
    if (!name) name = this.takeQuickPlayBotName();
    else this.usedBotNames.add(name);
    const buyIn = stack >= 0 ? stack : this.rollFillerBuyIn();
    this.engine.seatPlayer(seat, `bot${seat}`, name, true, buyIn);
    const botSeed = this.settings.useFixedSeed ? this.settings.seed + seat * 101 : null;
    this.router.set(seat, new BotActionProvider(new HeuristicBot(botSeed), this.settings.botThinkMin, this.settings.botThinkMax, this.clock.wait, this.random));
  }

  private rollFillerBuyIn(): number {
    if (this.isPrivatePlay) return ChainTableMode.PrivateMaxBuyIn;
    const stake = this.resolveStake();
    const min = stake.minBuyIn;
    let max = stake.startingStack > 0 ? stake.startingStack : stake.minBuyIn;
    if (max < min) max = min;
    let pick: number;
    if (this.settings.useFixedSeed) {
      const salt = this.botCount() + 1;
      const span = max - min + 1;
      pick = min + (Math.abs(this.settings.seed * 1103515245 + salt * 12345) % span);
    } else pick = this.randomRange(min, max + 1);
    const bb = stake.bigBlind > 0 ? stake.bigBlind : this.settings.bigBlind;
    if (bb > 1) {
      let rounded = Math.floor(pick / bb) * bb;
      if (rounded < min) rounded = min;
      if (rounded > max) rounded = max;
      pick = rounded;
    }
    return pick;
  }

  /** UnityEngine.Random.Range(int min, int maxExclusive). */
  private randomRange(min: number, maxExclusive: number): number {
    if (maxExclusive <= min) return min;
    return min + Math.floor(this.random() * (maxExclusive - min));
  }

  /** Busting is not a state a seat sits in: the seat goes back to the pool and its player spectates. */
  private bustOutSeats(): void {
    let busted: number[] | null = null;
    for (let seat = 0; seat < this.settings.seatCount; seat++) {
      const p = this.engine.table.seats[seat]!;
      if (!p.isOccupied || p.stack > 0) continue;
      const claim = this.humans.get(seat);
      if (claim && !claim.dealtIn) continue; // the bot a joiner is about to replace
      (busted ??= []).push(seat);
    }
    if (!busted) return;
    let ownerBustedOut = false;
    for (const seat of busted) {
      const occ = this.humans.get(seat);
      if (occ) {
        if (occ.connected) this.net.sendSeatAssignment(occ.player, -1);
        if (occ.tokenHash === this.ownerTokenHash) ownerBustedOut = true;
        this.log('info', `[PokerServer] ${occ.name} busted out of seat ${seat}; now spectating.`);
      } else this.log('info', `[PokerServer] ${this.engine.table.seats[seat]!.name} busted out; seat ${seat} is free.`);
      this.releaseSeat(seat);
    }
    if (ownerBustedOut) this.promoteOwner();
    this.broadcastRoster();
    this.broadcastLobby();
  }

  /** Every queued seat change, between hands: vacations, then bots, then humans. */
  private applyPendingSeatChanges(): void {
    this.removeBotsIfNoHumans();
    let changed = this.pendingVacate.size > 0 || this.pendingBots.size > 0;
    if (this.pendingVacate.size > 0) {
      const vacating = [...this.pendingVacate];
      this.pendingVacate.clear();
      for (const seat of vacating) this.releaseSeat(seat);
    }
    for (const seat of this.pendingBots) {
      const queued = this.pendingBotNames.get(seat) ?? null;
      this.pendingBotNames.delete(seat);
      this.seatBot(seat, queued);
    }
    this.pendingBots.clear();
    for (const [seat, occ] of this.humans) {
      if (occ.dealtIn || !occ.funded) continue;
      this.seatHuman(seat, occ);
      changed = true;
      this.log('info', `[PokerServer] ${occ.name} dealt in at seat ${seat}.`);
    }
    changed = this.tuneQuickPlayBots(false) || changed;
    if (changed) {
      this.broadcastRoster();
      this.broadcastLobby();
    }
  }

  private allocateSeatForHuman(): number {
    const free = this.firstFreeSeat();
    if (free >= 0) return free;
    for (let seat = 0; seat < this.settings.seatCount; seat++)
      if (!this.isClaimed(seat) && this.engine.table.seats[seat]!.isBot && !this.pendingVacate.has(seat)) return seat; // bots yield
    return -1;
  }

  private firstFreeSeat(): number {
    for (let seat = 0; seat < this.settings.seatCount; seat++)
      if (!this.isClaimed(seat) && (!this.engine.table.seats[seat]!.isOccupied || this.pendingVacate.has(seat))) return seat;
    return -1;
  }

  private isClaimed(seat: number): boolean {
    return this.humans.has(seat) || this.pendingBots.has(seat);
  }

  private isBotSeat(seat: number): boolean {
    if (this.pendingBots.has(seat)) return true;
    if (this.humans.has(seat) || this.pendingVacate.has(seat)) return false;
    const p = this.engine.table.seats[seat]!;
    return p.isBot && !p.isAgent;
  }

  private lastBotSeat(): number {
    for (let seat = this.settings.seatCount - 1; seat >= 0; seat--) if (this.isBotSeat(seat)) return seat;
    return -1;
  }

  private seatedCount(): number {
    let n = 0;
    for (let seat = 0; seat < this.settings.seatCount; seat++) {
      if (this.pendingVacate.has(seat)) continue;
      if (this.isClaimed(seat) || this.engine.table.seats[seat]!.isOccupied) n++;
    }
    return n;
  }

  private tuneQuickPlayBots(broadcast: boolean): boolean {
    if (!this.isQuickPlay) return false;
    let changed = this.fillQuickPlayBotsIfLonely();
    changed = this.reserveEmptySeatForJoiner() || changed;
    if (changed && broadcast) {
      this.broadcastRoster();
      this.broadcastLobby();
    }
    return changed;
  }

  private fillQuickPlayBotsIfLonely(): boolean {
    if (this.seatsLocked) return false;
    if (this.activePrincipalCount() !== 1) return false; // one human or one agent: fill with the default pack
    const existing = this.botCount();
    let want = QuickPlayFreeBots.rollCount(this.randomRange(0, 100));
    const cap = this.occupancyCap - this.activeHumanCount() - this.activeAgentCount();
    want = Math.min(want, cap, QuickPlayFreeBots.MaxBots);
    if (want <= existing) return false;
    let seated = 0;
    for (let i = existing; i < want; i++) {
      if (this.seatedCount() >= this.occupancyCap) break;
      const seat = this.firstFreeSeat();
      if (seat < 0) break;
      this.seatBot(seat);
      seated++;
    }
    if (seated > 0) this.log('info', `[PokerServer] Quick Play free: seated ${seated} filler bot(s) for the lone principal.`);
    return seated > 0;
  }

  /** One chair always stays empty so a joiner can sit without waiting for a bust. */
  private get occupancyCap(): number {
    return Math.max(2, this.settings.seatCount - 1);
  }

  private reserveEmptySeatForJoiner(): boolean {
    if (this.seatsLocked) return false;
    let changed = false;
    while (this.seatedCount() > this.occupancyCap) {
      const seat = this.poorestBotSeat();
      if (seat < 0) break;
      this.dropBot(seat);
      changed = true;
    }
    if (changed) this.log('info', '[PokerServer] Quick Play free: dropped the poorest bot to keep a seat open.');
    return changed;
  }

  private activeHumanCount(): number {
    let n = 0;
    for (const [seat, occ] of this.humans) if (!occ.leaving && !this.pendingVacate.has(seat)) n++;
    return n;
  }

  private activePrincipalCount(): number {
    return this.activeHumanCount() + this.activeAgentCount();
  }

  private activeAgentCount(): number {
    let n = 0;
    for (let seat = 0; seat < this.settings.seatCount; seat++) {
      if (this.pendingVacate.has(seat)) continue;
      const p = this.engine.table.seats[seat]!;
      if (p.isOccupied && p.isAgent) n++;
    }
    return n;
  }

  private botCount(): number {
    let n = 0;
    for (let seat = 0; seat < this.settings.seatCount; seat++) {
      if (this.pendingVacate.has(seat)) continue;
      if (this.isBotSeat(seat)) n++;
    }
    return n;
  }

  private poorestBotSeat(): number {
    let poorest = -1;
    let poorestStack = Number.MAX_SAFE_INTEGER;
    for (let seat = 0; seat < this.settings.seatCount; seat++) {
      if (!this.isBotSeat(seat) || this.pendingVacate.has(seat)) continue;
      const stack = this.pendingBots.has(seat) ? this.settings.startingStack : this.engine.table.seats[seat]!.stack;
      if (stack >= poorestStack) continue;
      poorestStack = stack;
      poorest = seat;
    }
    return poorest;
  }

  private dropBot(seat: number): void {
    if (this.pendingBots.delete(seat)) {
      this.forgetQueuedBotName(seat);
      return;
    }
    if (this.seatsLocked) {
      this.pendingVacate.add(seat);
      return;
    }
    this.forgetBotName(this.engine.table.seats[seat]!.name);
    this.engine.vacateSeat(seat);
    this.router.remove(seat);
    this.pendingVacate.delete(seat);
  }

  private takeQuickPlayBotName(): string {
    const names: readonly string[] = QuickPlayFreeBots.Names;
    if (names.length === 0) return `Bot ${this.botLabel++}`;
    const start = this.randomRange(0, names.length);
    for (let i = 0; i < names.length; i++) {
      const name = names[(start + i) % names.length]!;
      if (!this.usedBotNames.has(name)) {
        this.usedBotNames.add(name);
        return name;
      }
    }
    return `Bot ${this.botLabel++}`;
  }

  private forgetBotName(name: string | null): void {
    if (name) this.usedBotNames.delete(name);
  }

  private forgetQueuedBotName(seat: number): void {
    const name = this.pendingBotNames.get(seat);
    if (name === undefined) return;
    this.pendingBotNames.delete(seat);
    this.forgetBotName(name);
  }

  /** Private-room restart: fresh stacks so the owner can start another game. */
  private rebuyEveryone(): void {
    for (let seat = 0; seat < this.settings.seatCount; seat++) {
      const p = this.engine.table.seats[seat]!;
      if (!p.isOccupied) continue;
      this.engine.seatPlayer(seat, p.id!, p.name!, p.isBot, this.settings.startingStack);
    }
  }

  // ---- Agents (AgentSessionHost seam) ---------------------------------------------------------

  /** Room for one more agent: every seat but one, each taking an empty chair or a filler bot's. */
  get canAcceptSharedAgent(): boolean {
    return !!this.engine && this.isQuickPlay
      && this.agents.length + this.pendingAgents.length < maxAgentsPerTable(this.settings.seatCount)
      && this.seatsForAgents() > this.pendingAgents.length;
  }

  private seatsForAgents(): number {
    let n = 0;
    for (let seat = 0; seat < this.settings.seatCount; seat++) {
      if (this.pendingVacate.has(seat) || this.humans.has(seat)) continue;
      const p = this.engine.table.seats[seat]!;
      if (!p.isOccupied && !this.isClaimed(seat)) n++;
      else if (this.isBotSeat(seat)) n++;
    }
    return n;
  }

  /** Claims a seat for an owned agent (seated now between hands, else at the next boundary). */
  trySeatSharedAgent(config: AgentDeploymentConfig): boolean {
    if (!config || !this.isQuickPlay || !this.canAcceptSharedAgent) return false;
    if (this.agents.some((a) => a.deploymentId === config.deploymentId) || this.pendingAgents.some((p) => p.deploymentId === config.deploymentId)) return false;
    if (this.ownerSeatedHere(config.ownerPlayFabId) || this.hasAgentOf(config.ownerPlayFabId)) return false;
    if (this.pendingAgents.some((p) => sameOwner(p.ownerPlayFabId, config.ownerPlayFabId))) return false;
    this.pendingAgents.push(config);
    this.tryActivatePendingAgent();
    return true;
  }

  cancelPendingSharedAgent(deploymentId: string): boolean {
    const i = this.pendingAgents.findIndex((p) => p.deploymentId === deploymentId);
    if (i < 0) return false;
    this.pendingAgents.splice(i, 1);
    return true;
  }

  /** The owner asked their agent to stop: between hands it goes now, mid-hand at the boundary. */
  requestAgentStop(deploymentId: string): void {
    const agent = this.agents.find((a) => a.deploymentId === deploymentId);
    if (!agent) return;
    agent.ownerStopRequested = true;
    if (!this.gameLoopRunning) this.tryHaltAgentsForOwners();
  }

  private hasAgentOf(playFabId: string | null): boolean {
    return !!playFabId && this.agents.some((a) => sameOwner(a.config.ownerPlayFabId, playFabId));
  }

  private ownerSeatedHere(ownerPlayFabId: string): boolean {
    for (const occ of this.humans.values()) if (sameOwner(occ.playFabId, ownerPlayFabId)) return true;
    return false;
  }

  private tryActivatePendingAgent(): void {
    if (this.pendingAgents.length === 0 || !this.engine || this.seatsLocked) return;
    let seated = false;
    for (const config of [...this.pendingAgents]) {
      if (this.ownerSeatedHere(config.ownerPlayFabId)) continue;
      const seat = this.allocateSeatForAgent();
      if (seat < 0) break;
      if (this.engine.table.seats[seat]!.isOccupied && this.isBotSeat(seat)) {
        this.log('info', `[PokerServer] Bumping filler bot at seat ${seat} for AFK agent.`);
        this.dropBot(seat);
      }
      this.pendingAgents.splice(this.pendingAgents.indexOf(config), 1);
      this.seatAgent(seat, newAgentSession(config));
      seated = true;
    }
    if (!seated) return;
    this.tuneQuickPlayBots(false);
    this.broadcastRoster();
    this.broadcastLobby();
    this.tryAutoStart();
  }

  private allocateSeatForAgent(): number {
    const free = this.firstFreeSeat();
    return free >= 0 ? free : this.poorestBotSeat();
  }

  private seatAgent(seat: number, agent: AgentSession): void {
    const c = agent.config;
    const botSeed = this.settings.useFixedSeed ? this.settings.seed + seat * 101 : null;
    const bot = c.profile ? new HeuristicBot(c.profile, botSeed) : new HeuristicBot(botSeed);
    const name = c.agentName || 'Agent';
    const stack = c.bankroll > 0 ? c.bankroll : this.settings.startingStack;
    this.engine.seatPlayer(seat, `agent-${c.deploymentId}`, name, true, stack, true);
    this.router.set(seat, new BotActionProvider(bot, this.settings.botThinkMin, this.settings.botThinkMax, this.clock.wait, this.random));
    agent.seat = seat;
    agent.lastStack = stack;
    this.agents.push(agent);
    this.log('info', `[PokerServer] Seated AFK agent '${name}' at seat ${seat} stack=${stack} preset=${c.strategyPreset ?? ''}.`);
  }

  private currentAgentStack(agent: AgentSession): number {
    const seat = agent.seat;
    if (this.engine && seat >= 0 && seat < this.settings.seatCount && this.engine.table.seats[seat]!.isOccupied) return this.engine.table.seats[seat]!.stack;
    return agent.lastStack;
  }

  private stopAgent(agent: AgentSession, reason: string): void {
    const stack = this.currentAgentStack(agent);
    agent.active = false;
    agent.lastStack = stack;
    this.opts.agentHooks?.stopped?.(agent, reason, stack, this.net?.sessionName ?? '');
    const seat = agent.seat;
    if (this.engine && seat >= 0 && seat < this.settings.seatCount) {
      const p = this.engine.table.seats[seat]!;
      if (p.isOccupied && p.isAgent && p.id === `agent-${agent.deploymentId}`) {
        if (this.seatsLocked) this.pendingVacate.add(seat);
        else {
          this.forgetBotName(p.name);
          this.engine.vacateSeat(seat);
          this.router.remove(seat);
        }
      }
    }
    const i = this.agents.indexOf(agent);
    if (i >= 0) this.agents.splice(i, 1);
    if (this.disposed) return;
    this.removeBotsIfNoHumans();
    this.tuneQuickPlayBots(false);
    this.broadcastRoster();
    this.broadcastLobby();
  }

  private evaluateAgentLimitsAfterHand(): void {
    for (const agent of [...this.agents]) {
      if (!agent.inHand) continue;
      agent.inHand = false;
      const stack = this.currentAgentStack(agent);
      agent.lastStack = stack;
      const reason = this.opts.agentHooks?.evaluateAfterHand?.(agent, stack) ?? null;
      if (reason) this.stopAgent(agent, reason);
    }
  }

  private tryHaltAgentsForOwners(): boolean {
    let any = false;
    for (const agent of [...this.agents]) {
      if (!agent.ownerStopRequested) continue;
      this.stopAgent(agent, AgentStopReasons.OwnerStop);
      any = true;
    }
    return any;
  }

  private beginAgentHandTelemetry(): void {
    this.agentHandActions = [];
    this.agentBoardCards = '';
    for (const agent of this.agents) {
      agent.inHand = true;
      agent.handStartingStack = this.currentAgentStack(agent);
      agent.handPotWon = 0;
      agent.holeCards = '';
      agent.wentToShowdown = false;
    }
  }

  private completeAgentHandTelemetry(): void {
    for (const agent of this.agents) {
      if (!agent.active || !agent.inHand) continue;
      const ending = this.currentAgentStack(agent);
      const net = ending - agent.handStartingStack;
      agent.handsPlayed++;
      this.opts.agentHooks?.handComplete?.(agent, {
        deploymentId: agent.deploymentId,
        assignedTable: this.net.sessionName,
        handNumber: this.engine.table.handNumber,
        startingStack: agent.handStartingStack,
        endingStack: ending,
        netPnl: net,
        holeCards: agent.holeCards,
        boardCards: this.agentBoardCards,
        pot: agent.handPotWon,
        result: net > 0 ? 'win' : net < 0 ? 'loss' : 'push',
        showdown: agent.wentToShowdown,
        publicActionsJson: '[' + this.agentHandActions.join(',') + ']',
        completedUnix: Math.floor(Date.now() / 1000),
      });
    }
  }

  private agentAt(seat: number): AgentSession | undefined {
    return this.agents.find((a) => a.seat === seat);
  }

  // ---- Engine pump (mirrors PokerGameController.GameLoop) ----------------------------------------

  private async gameLoop(): Promise<void> {
    try {
      await this.runGameLoop();
    } catch (ex) {
      this.log('error', `[PokerServer] Game loop aborted: ${(ex as Error)?.stack ?? ex}`);
      this.gameLoopRunning = false;
      if (this.phase === TablePhase.Playing) this.phase = TablePhase.GameOver;
      if (!this.disposed) {
        this.broadcastRoster();
        this.broadcastLobby();
      }
    }
  }

  private async runGameLoop(): Promise<void> {
    while (this.phase === TablePhase.Playing && !this.disposed) {
      // Drop leftovers (GameOver / ActionRequested) from the last pump BEFORE seating anyone.
      this.drainStaleEvents();
      this.bustOutSeats();
      this.applyPendingSeatChanges();
      if (this.engine.countFundedPlayers() < 2) break;

      if (this.economy) {
        await this.economy.flushCashOuts();
        if (this.economy.isHalted) break;
        if (this.engine.countFundedPlayers() < 2) break;
      }

      // A joiner who claimed between hands may still be mid-debit: hold the deal so they sit this hand.
      if (this.hasPendingBuyIn()) {
        await this.waitForPendingBuyIns();
        this.applyPendingSeatChanges();
        if (this.engine.countFundedPlayers() < 2) break;
      }

      this.captureStacksAtHandStart();
      this.beginAgentHandTelemetry();
      if (this.engine.countFundedPlayers() < 2) break;
      if (this.tryHaltAgentsForOwners() && this.engine.countFundedPlayers() < 2) break;
      if (this.disposed) break;

      this.renderBudget = 0;
      this.engine.startHand();
      await this.processEventsUntilHandEnds();
      if (this.disposed) break;

      // Settle even when the hand ended the game: chips moved.
      this.settleOpen = true;
      await this.settleChipHand();
      this.closeSettle();

      this.completeAgentHandTelemetry();
      this.evaluateAgentLimitsAfterHand();

      this.bustOutSeats();
      this.applyPendingSeatChanges();
      if (this.agents.length > 0) this.tuneQuickPlayBots(true);

      if (this.phase !== TablePhase.Playing) break;

      // The showdown and pot award are still playing out on the clients.
      await this.settleRender();
      this.broadcastRoster();
      this.broadcastLobby();
      await this.clock.wait(this.settings.betweenHands);
    }

    this.closeSettle();
    if (this.disposed) return;
    this.applyPendingSeatChanges();
    if (this.economy) await this.economy.flushCashOuts();

    this.gameLoopRunning = false;
    this.phase = TablePhase.GameOver;
    this.broadcastRoster();
    this.broadcastLobby();
    this.log('info', '[PokerServer] Game over; table back in lobby control.');
  }

  private captureStacksAtHandStart(): void {
    this.stacksAtHandStart.clear();
    for (const p of this.engine.table.seats) {
      if (!p.isOccupied || !p.id) continue;
      this.stacksAtHandStart.set(p.id, p.stack);
    }
  }

  /**
   * Closes out a finished hand: the conservation INVARIANT (asserted — halts the table), the HOUSE DELTA (logged), and
   * a checkpoint of every funded human's stack.
   */
  private async settleChipHand(): Promise<void> {
    if (this.stacksAtHandStart.size === 0) return;
    let humanDelta = 0;
    let botDelta = 0;
    for (const [id, start] of this.stacksAtHandStart) {
      const diff = this.stackOfPlayer(id) - start;
      if (isBotId(id)) botDelta += diff;
      else humanDelta += diff;
    }
    const residual = this.engine.table.pot;
    if (humanDelta + botDelta + residual !== 0) {
      const report: string[] = [];
      for (const [id, start] of this.stacksAtHandStart)
        report.push(`\n  ${id}: ${start} -> ${this.stackOfPlayer(id)}${this.seatOfPlayer(id) >= 0 ? '' : '  (NO SEAT — vacated before the read)'}`);
      const off = humanDelta + botDelta + residual;
      this.stacksAtHandStart.clear();
      this.log('error', `[PokerServer] Chip conservation broken: off by ${off}. Humans ${humanDelta}, bots ${botDelta}, engine pot still holds ${residual}.${report.join('')}`);
      this.economy?.halt(`chips are not conserved (off by ${off}) — see the seat breakdown above`);
      return;
    }
    try {
      this.opts.onHandSettled?.({
        tableId: this.economy?.tableId ?? null,
        handNumber: this.engine.table.handNumber,
        botDelta,
        humanDelta,
        stacks: [...this.stacksAtHandStart.keys()].map((id) => {
          const seat = this.seatOfPlayer(id);
          return { id, seat, startStack: this.stacksAtHandStart.get(id) ?? 0, stack: this.stackOfPlayer(id), bot: isBotId(id), won: this.handWinners.has(seat), showdownCategory: this.handShowdown.get(seat) ?? null };
        }),
      });
    } catch (e) {
      this.log('error', `[PokerServer] onHandSettled failed: ${(e as Error)?.message ?? e}`);
    }
    if (botDelta !== 0)
      this.log('info', `[Economy] house delta ${-botDelta > 0 ? '+' : ''}${-botDelta} (table ${this.economy?.tableId ?? 'legacy-free'}, hand ${this.engine.table.handNumber})`);
    this.stacksAtHandStart.clear();
    if (!this.economy) return;
    for (const [seat, occ] of this.humans) {
      if (!occ.funded || !occ.playFabId) continue;
      const p = this.engine.table.seats[seat]!;
      if (!occ.dealtIn || !p.isOccupied) continue;
      await this.economy.checkpoint(occ.playFabId, seat, p.stack, this.engine.table.handNumber);
    }
  }

  private closeSettle(): void {
    this.settleOpen = false;
  }

  private stackOfPlayer(id: string): number {
    const seat = this.seatOfPlayer(id);
    return seat >= 0 ? this.engine.table.seats[seat]!.stack : 0;
  }

  private seatOfPlayer(id: string): number {
    for (let seat = 0; seat < this.settings.seatCount; seat++) {
      const p = this.engine.table.seats[seat]!;
      if (p.isOccupied && p.id === id) return seat;
    }
    return -1;
  }

  private async cashOutAndNotify(player: PlayerRef, playFabId: string, chips: number): Promise<void> {
    if (!this.economy) return;
    const result = await this.economy.cashOutNow(playFabId, chips);
    if (result.success && result.balance >= 0 && this.net && player !== PLAYER_NONE) this.pushBalance(player, playFabId, result.balance);
    else if (!result.success) this.log('warn', `[PokerServer] Cash-out for ${playFabId} (${chips} chips) failed: ${result.error}`);
  }

  /** SendWalletBalance, remembering what this player's browser now believes (local ticket sync). */
  private pushBalance(player: PlayerRef, playFabId: string, balance: number): void {
    this.net.sendWalletBalance(player, balance);
    this.opts.economy?.noteSynced?.(playFabId, balance);
  }

  private onEconomyHalted(): void {
    this.phase = TablePhase.GameOver;
    this.broadcastEconomy();
    this.broadcastRoster();
    this.broadcastLobby();
  }

  /** Funded humans plus filler bots (bots count as ready the moment they sit). */
  private fundedSeatCount(): number {
    let n = 0;
    for (const [seat, occ] of this.humans) if (occ.funded && !occ.leaving && !this.pendingVacate.has(seat)) n++;
    return n + this.botCount();
  }

  private broadcastEconomy(): void {
    if (!this.economy || !this.net) return;
    this.replicate({
      type: 'TableEconomy',
      tableId: this.economy.tableId,
      buyInChips: this.isPrivatePlay ? ChainTableMode.PrivateMaxBuyIn : this.economy.stakes.buyInChips,
      smallBlind: this.settings.smallBlind,
      bigBlind: this.settings.bigBlind,
      halted: this.economy.isHalted,
    });
  }

  /** Re-announced to all (a single-recipient send would burn a sequence number everyone else never sees). */
  private announceEconomy(): void {
    this.broadcastEconomy();
  }

  private drainStaleEvents(): void {
    if (this.events.length === 0) return;
    this.log('warn', `[PokerServer] Dropping ${this.events.length} leftover event(s) from the last game.`);
    this.events.length = 0;
  }

  private nextEvent(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.eventWaiter = resolve;
    });
  }

  private async processEventsUntilHandEnds(): Promise<void> {
    let handEnded = false;
    while (!handEnded && !this.disposed) {
      const e = this.events.shift();
      if (!e) {
        await Promise.race([this.nextEvent(), this.clock.wait(0.25)]);
        continue;
      }
      for (const agent of this.agents) this.observeAgent(agent, e);
      if (this.opts.onEngineEvent) {
        try {
          this.opts.onEngineEvent(e);
        } catch (ex) {
          this.log('warn', `[PokerServer] engine event observer failed: ${(ex as Error)?.message ?? ex}`);
        }
      }
      switch (e.type) {
        case 'HandStarted':
          this.handWinners.clear();
          this.handShowdown.clear();
          this.replicate(e);
          break;
        case 'ActionRequested':
          await this.onActionRequested(e);
          break;
        case 'HoleCardsDealt': {
          const agent = this.agentAt(e.seat);
          if (agent) agent.holeCards = `${e.card0.short} ${e.card1.short}`;
          this.replicateHoleCards(e);
          this.renderBudget += this.settings.dealDelay;
          break;
        }
        case 'BlindPosted':
          if (this.agents.length > 0) this.agentHandActions.push(JSON.stringify({ seat: e.seat, action: e.isSmallBlind ? 'small_blind' : 'big_blind', amount: e.amount }));
          this.replicate(e);
          this.renderBudget += this.settings.dealDelay;
          break;
        case 'BettingRoundChanged':
          this.replicate(e);
          // Preflop this is what the client settles on; post-flop the settle is counted at CommunityDealt.
          if (e.round === BettingRound.Preflop) this.renderBudget += this.settings.dealSettleDelay;
          break;
        case 'CommunityDealt':
          if (this.agents.length > 0) this.agentBoardCards = e.board.map((c) => c.short).join(' ');
          this.replicate(e);
          this.renderBudget += this.settings.dealSettleDelay;
          break;
        case 'PlayerActed':
          if (this.agents.length > 0) this.agentHandActions.push(JSON.stringify({ seat: e.seat, action: ActionType[e.action], amount: e.amount }));
          this.replicate(e);
          this.renderBudget += this.settings.actionDelay;
          break;
        case 'Showdown':
          for (const entry of e.entries) this.handShowdown.set(entry.seat, entry.value.category);
          for (const entry of e.entries) {
            const shown = this.agentAt(entry.seat);
            if (shown) shown.wentToShowdown = true;
          }
          this.replicate(e);
          this.renderBudget += this.settings.showdownDelay;
          break;
        case 'PotAwarded': {
          if (e.amount > 0) this.handWinners.add(e.seat);
          const winner = this.agentAt(e.seat);
          if (winner) winner.handPotWon += e.amount;
          this.replicate(e);
          this.renderBudget += this.settings.showdownDelay;
          break;
        }
        case 'HandEnded':
          this.replicate(e);
          handEnded = true;
          break;
        case 'GameOver':
          // A GameOver arriving while a hand is live is leftover from the previous game.
          if (this.engine.handInProgress) {
            this.log('warn', '[PokerServer] Dropped stale GameOver during a live hand.');
            break;
          }
          this.replicate(e);
          this.phase = TablePhase.GameOver;
          handEnded = true;
          break;
      }
    }
  }

  private observeAgent(agent: AgentSession, e: EngineEvent): void {
    try {
      this.opts.agentHooks?.observe?.(agent, e);
    } catch (ex) {
      this.log('warn', `[AgentSession] Hand replay recording failed: ${(ex as Error)?.message ?? ex}`);
    }
  }

  /** Holds the table until the clients have finished animating what was last replicated. */
  private async settleRender(): Promise<void> {
    if (this.renderBudget > 0) await this.clock.wait(this.renderBudget);
    this.renderBudget = 0;
  }

  private async onActionRequested(e: ActionRequestedEvent): Promise<void> {
    // Betting opens — and the turn clock starts — only once the cards have landed on the clients.
    await this.settleRender();
    if (this.disposed) return;
    this.replicateTurnStarted(e);

    const request = this.buildRequest(e);
    let submitted = false;
    let wake: () => void = () => {};
    const answered = new Promise<void>((r) => (wake = r));
    const submit = (a: PlayerAction) => {
      if (submitted) return; // first response wins (the provider, or the timeout)
      // Counted only once the engine takes it: an illegal action is refused and the turn clock plays on.
      try {
        this.engine.submitAction(e.seat, a);
        submitted = true;
        wake();
      } catch (ex) {
        this.log('warn', `[PokerServer] Seat ${e.seat}: refused ${ActionType[a.type]} ${a.amount} (${(ex as Error)?.message ?? ex}).`);
      }
    };

    const provider = this.router.get(e.seat);
    // Only a seat whose engine occupant IS the human counts as absent.
    const occ = this.humans.get(e.seat);
    const seatAbandoned = !!occ && occ.dealtIn && (occ.leaving || !occ.connected);

    if (seatAbandoned) submit(PlayerAction.fold());
    else if (!provider) submit(timeoutAction(request.legal));
    else {
      const turn = new AbortController();
      const deadline = new AbortController();
      void provider.requestAction(request, submit, turn.signal);
      await Promise.race([answered, this.clock.wait(this.settings.turnTimer, deadline.signal)]);
      deadline.abort();
      if (!submitted && !this.disposed) {
        turn.abort();
        submit(timeoutAction(request.legal));
      } else turn.abort();
    }
  }

  private buildRequest(e: ActionRequestedEvent): ActionRequest {
    const t = this.engine.table;
    const p = t.seats[e.seat]!;
    const context: BotContext = {
      seatIndex: e.seat,
      holeCards: p.holeCards,
      community: t.community,
      round: t.round,
      pot: t.pot,
      myStack: p.stack,
      myCurrentBet: p.currentBet,
      bigBlind: t.bigBlind,
      opponentsInHand: this.engine.countInHand() - 1,
      position: positionOf(t.buttonSeat, e.seat, t.seatCount),
      legal: e.legal,
    };
    return { seat: e.seat, legal: e.legal, context };
  }

  // ---- Replication ----------------------------------------------------------------------------

  private replicate(e: WireEvent): void {
    if (!PokerEventCodec.canEncode(e)) {
      this.log('warn', `[PokerServer] Not replicating ${e.type}.`);
      return;
    }
    if (!this.net) return;
    this.stampAvatars(e);
    this.net.broadcastEvent(PokerEventCodec.encode(e, this.sequence++));
  }

  /** Every seat list that leaves the server gets the profile pictures here (matched on name too). */
  private stampAvatars(e: WireEvent | PokerEvent): void {
    const seats = e.type === 'TableRoster' || e.type === 'HandStarted' ? e.seats : null;
    if (!seats) return;
    for (let seat = 0; seat < seats.length; seat++) {
      const snap = seats[seat];
      if (!snap || !snap.isOccupied) continue;
      const occ = this.humans.get(seat);
      if (occ && occ.name === snap.name) snap.avatar = occ.avatar;
    }
  }

  /** A late joiner only sees events from now on: replay the public hand onto that peer alone, out of band. */
  private sendHandViewCatchUp(player: PlayerRef): void {
    if (!this.net || !this.engine.handInProgress) return;
    const table = this.engine.table;
    const seats: SeatSnapshot[] = [];
    for (let seat = 0; seat < this.settings.seatCount; seat++) {
      const occ = this.humans.get(seat);
      if (occ && !occ.dealtIn) {
        seats.push(this.pendingClaimSnapshot(occ));
        continue;
      }
      const p = table.seats[seat]!;
      seats.push(snapshot({ name: p.name, stack: p.stack, isOccupied: p.isOccupied, isBusted: p.status === PlayerStatus.Busted, isBot: p.isBot, isAgent: p.isAgent }));
    }
    this.sendCatchUp(player, {
      type: 'HandStarted', handNumber: table.handNumber, buttonSeat: table.buttonSeat, smallBlindSeat: table.smallBlindSeat, bigBlindSeat: table.bigBlindSeat, seats,
    } satisfies HandStartedEvent);

    const recipientSeat = this.seatOf(player);
    const recipient = recipientSeat >= 0 ? this.humans.get(recipientSeat) : undefined;
    const recipientDealtIn = !!recipient && recipient.dealtIn;

    for (let seat = 0; seat < table.seatCount; seat++) {
      const p = table.seats[seat]!;
      if (p.holeCards.length < 2) continue;
      const pending = this.humans.get(seat);
      if (pending && !pending.dealtIn) continue;
      const mine = seat === recipientSeat && recipientDealtIn;
      this.sendCatchUp(player, { type: 'HoleCardsDealt', seat, card0: mine ? p.holeCards[0]! : HIDDEN_CARD, card1: mine ? p.holeCards[1]! : HIDDEN_CARD });
    }

    this.sendCatchUp(player, { type: 'BettingRoundChanged', round: table.round });
    if (table.community.length > 0) {
      const board = [...table.community];
      this.sendCatchUp(player, { type: 'CommunityDealt', round: table.round, newCards: board, board });
    }

    let potPainted = false;
    for (let seat = 0; seat < table.seatCount; seat++) {
      const p = table.seats[seat]!;
      if (!p.isOccupied) continue;
      const pendingAct = this.humans.get(seat);
      if (pendingAct && !pendingAct.dealtIn) continue;
      if (p.status === PlayerStatus.Folded) {
        this.sendCatchUp(player, { type: 'PlayerActed', seat, action: ActionType.Fold, amount: p.currentBet, stackAfter: p.stack, potAfter: table.pot });
        potPainted = true;
      } else if (p.currentBet > 0 || p.status === PlayerStatus.AllIn) {
        this.sendCatchUp(player, { type: 'PlayerActed', seat, action: p.status === PlayerStatus.AllIn ? ActionType.AllIn : ActionType.Bet, amount: p.currentBet, stackAfter: p.stack, potAfter: table.pot });
        potPainted = true;
      }
    }
    if (!potPainted && table.pot > 0) {
      const potSeat = table.buttonSeat >= 0 ? table.buttonSeat : 0;
      const p = table.seats[potSeat]!;
      this.sendCatchUp(player, { type: 'BlindPosted', seat: potSeat, amount: p.currentBet, isSmallBlind: false, stackAfter: p.stack, potAfter: table.pot });
    }

    const acting = this.engine.awaitingActionSeat;
    if (acting >= 0) {
      const forYou = acting === recipientSeat && recipientDealtIn;
      this.sendCatchUp(player, { type: 'TurnStarted', seat: acting, forYou, turnSeconds: this.settings.turnTimer, legal: forYou ? this.engine.currentLegalActions : NO_LEGAL });
    }
  }

  private sendCatchUp(player: PlayerRef, e: WireEvent): void {
    this.stampAvatars(e);
    this.net.sendEventTo(player, PokerEventCodec.encode(e, PokerEventCodec.OutOfBandSequence));
  }

  /** The one per-recipient event: the seat's owner gets the real cards, everyone else "two cards were dealt". */
  private replicateHoleCards(e: HoleCardsDealtEvent): void {
    const seq = this.sequence++;
    const hidden = PokerEventCodec.encode({ type: 'HoleCardsDealt', seat: e.seat, card0: HIDDEN_CARD, card1: HIDDEN_CARD }, seq);
    let real: Uint8Array | null = null;
    for (const player of this.net.activePlayers()) {
      if (this.seatOf(player) === e.seat) this.net.sendEventTo(player, (real ??= PokerEventCodec.encode(e, seq)));
      else this.net.sendEventTo(player, hidden);
    }
  }

  /** Turn indicator for everyone; the legal actions only for the seat that must act. */
  private replicateTurnStarted(e: ActionRequestedEvent): void {
    const seq = this.sequence++;
    const forOthers = PokerEventCodec.encode({ type: 'TurnStarted', seat: e.seat, forYou: false, turnSeconds: this.settings.turnTimer, legal: NO_LEGAL }, seq);
    let forActor: Uint8Array | null = null;
    for (const player of this.net.activePlayers()) {
      if (this.seatOf(player) === e.seat)
        this.net.sendEventTo(player, (forActor ??= PokerEventCodec.encode({ type: 'TurnStarted', seat: e.seat, forYou: true, turnSeconds: this.settings.turnTimer, legal: e.legal }, seq)));
      else this.net.sendEventTo(player, forOthers);
    }
  }

  /** A claimed chair not in the engine yet: shown as occupied so every client paints the HUD. */
  private pendingClaimSnapshot(occ: SeatOccupant): SeatSnapshot {
    return snapshot({ name: occ.name, stack: occ.buyInChips, isOccupied: true, isPendingNextHand: true });
  }

  /** A newcomer in the room without a chair: they see who is sitting; Join Table claims a seat. */
  private spectateJoiner(player: PlayerRef): void {
    if (this.economy) this.announceEconomy();
    this.net.sendSeatAssignment(player, -1);
    this.broadcastRoster();
    this.broadcastLobby();
    this.sendHandViewCatchUp(player);
  }

  private broadcastRoster(): void {
    if (!this.net || !this.engine) return;
    const seats: SeatSnapshot[] = [];
    for (let seat = 0; seat < this.settings.seatCount; seat++) {
      const p = this.engine.table.seats[seat]!;
      const occ = this.humans.get(seat);
      if (occ && !occ.dealtIn) {
        seats.push(this.pendingClaimSnapshot(occ));
        continue;
      }
      if (this.pendingBots.has(seat)) {
        seats.push(snapshot({ name: this.pendingBotNames.get(seat) ?? 'Bot', stack: this.settings.startingStack, isOccupied: true, isBot: !this.isQuickPlay, isPendingNextHand: true }));
        continue;
      }
      const leaving = this.pendingVacate.has(seat) || (!!occ && (occ.leaving || occ.dropped));
      seats.push(snapshot({
        name: p.name, stack: p.stack, isOccupied: p.isOccupied, isBusted: p.status === PlayerStatus.Busted,
        isBot: p.isBot && !this.isQuickPlay, isAgent: p.isAgent, isLeaving: leaving,
      }));
    }
    this.replicate({ type: 'TableRoster', seats });
  }

  /** Per-recipient lobby state (ownership, "you're in next hand") under one shared sequence number. */
  private broadcastLobby(): void {
    if (!this.net || !this.engine || this.disposed) return;
    // Seat filler bots before the lobby payload so a lone Quick Play player is not told "waiting for 2".
    if (this.isQuickPlay && this.tuneQuickPlayBots(false)) this.broadcastRoster();
    const seq = this.sequence++;
    const seated = this.seatedCount();
    const ready = this.fundedSeatCount();
    const seatAvailable = this.allocateSeatForHuman() >= 0;
    for (const player of this.net.activePlayers()) {
      const seat = this.seatOf(player);
      const occ = seat >= 0 ? this.humans.get(seat) : undefined;
      const pending = !!occ && !occ.dealtIn;
      this.net.sendEventTo(player, PokerEventCodec.encode({
        type: 'LobbyState',
        phase: this.phase,
        youAreOwner: this.isOwner(player),
        youJoinNextHand: pending,
        youCanBuyIn: seat < 0 && seatAvailable,
        autoStart: this.autoStart,
        seatedCount: seated,
        minToStart: this.minPlayersToStart,
        seatCount: this.settings.seatCount,
        readyCount: ready,
      }, seq));
    }
    this.tryAutoStart();
  }

  // ---- Helpers ----------------------------------------------------------------------------------

  seatOf(player: PlayerRef): number {
    if (player === PLAYER_NONE) return -1;
    for (const [seat, occ] of this.humans) if (occ.player === player) return seat;
    return -1;
  }

  private holdsSeat(playFabId: string): boolean {
    for (const occ of this.humans.values()) if (occ.playFabId === playFabId) return true;
    return false;
  }

  private isOwner(player: PlayerRef): boolean {
    if (this.ownerTokenHash === '0') return false;
    const seat = this.seatOf(player);
    return seat >= 0 && this.humans.get(seat)!.tokenHash === this.ownerTokenHash;
  }

  /** Hands ownership to the longest-seated connected human when the owner is gone. */
  private promoteOwner(): void {
    for (const occ of this.humans.values()) if (occ.tokenHash === this.ownerTokenHash && occ.connected) return;
    for (let seat = 0; seat < this.settings.seatCount; seat++) {
      const occ = this.humans.get(seat);
      if (occ && occ.connected) {
        this.ownerTokenHash = occ.tokenHash;
        this.log('info', `[PokerServer] ${occ.name} (seat ${seat}) is now the table owner.`);
        return;
      }
    }
    this.ownerTokenHash = '0';
  }

  /** StartCoroutine: run an async routine, logging anything that escapes. */
  private run(p: Promise<void>): void {
    p.catch((ex) => this.log('error', `[PokerServer] Routine failed: ${(ex as Error)?.stack ?? ex}`));
  }
}

const NO_LEGAL: LegalActions = Object.freeze({
  canFold: false, canCheck: false, canCall: false, callAmount: 0, canBet: false, canRaise: false, minRaiseTo: 0, maxRaiseTo: 0, canAllIn: false,
});

function timeoutAction(legal: LegalActions): PlayerAction {
  return legal.canCheck ? PlayerAction.check() : PlayerAction.fold();
}

/** Bots are seated with a synthetic id ("bot3"), which separates house chips from real ones. */
function isBotId(id: string): boolean {
  return !!id && id.startsWith('bot');
}

function sameOwner(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function snapshot(o: Partial<SeatSnapshot>): SeatSnapshot {
  return {
    name: null, stack: 0, isOccupied: false, isBusted: false, isBot: false, isAgent: false, isPendingNextHand: false, isLeaving: false, avatar: 0, ...o,
  };
}

/** Exposed for the tournament porter: the Test.unity stake ladder default. */
export const DEFAULT_STAKE = StakeCatalog.Default;
