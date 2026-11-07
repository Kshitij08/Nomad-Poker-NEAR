/**
 * The multiplayer tournament runner for the local WebSocket table server: TournamentServerGame (the shared port in
 * src/tournaments/runtime) behind the server's IPokerTableServer / TableNet contract (server/src/tableNet.ts). One
 * room = one tournament session; every table of the tournament runs inside it, and moving, waiting and watching are
 * only a change in which table's events a connection receives (PokerEventCodec payloads, OutOfBandSequence for the
 * tournament events and catch-ups).
 */
import { CryptoRandom } from '../../src/core/cards/random';
import { PokerEventCodec } from '../../src/core/events/pokerEventCodec';
import type { PlayerAction } from '../../src/core/actions/actions';
import { TEST_SCENE_TABLE_SETTINGS } from '../../src/core/orchestration/tableSettings';
import { TournamentServerGame } from '../../src/tournaments/runtime/tournamentServerGame';
import type { TournamentBackend, TournamentPacing } from '../../src/tournaments/runtime/wire';
import type { ServerClock } from '../src/clock';
import type { IPokerTableServer, PlayerRef, TableNet } from '../src/tableNet';

export interface TournamentTableServerOptions {
  clock: ServerClock;
  /** A hosted tournament's backend (TournamentBackendClient). Absent: a dev / practice tournament. */
  backend?: TournamentBackend | null;
  /** Dev tournament field size (TournamentLaunch.DevPlayers): starts once this many joined or bots filled in. */
  devPlayers?: number;
  /** Seconds a dev tournament waits for more people after the first (Unity: 10). */
  devFillWaitSeconds?: number;
  pacing?: Partial<TournamentPacing>;
  random?: () => number;
  log?: (message: string) => void;
  /** The tournament is over and its quit delay has passed (the room may close). */
  onQuit?: () => void;
}

export class TournamentTableServer implements IPokerTableServer {
  private game: TournamentServerGame | null = null;
  private net: TableNet | null = null;

  constructor(private readonly opts: TournamentTableServerOptions) {}

  activate(net: TableNet): void {
    this.net = net;
    const s = TEST_SCENE_TABLE_SETTINGS;
    const pacing: TournamentPacing = {
      turnTimer: s.turnTimer, dealDelay: s.dealDelay, dealSettleDelay: s.dealSettleDelay, actionDelay: s.actionDelay,
      showdownDelay: s.showdownDelay, betweenHands: s.betweenHands, ...this.opts.pacing,
    };
    const clock = this.opts.clock;
    this.game = new TournamentServerGame({
      transport: {
        sendEventTo: (player, sequence, event) => net.sendEventTo(player, PokerEventCodec.encode(event, sequence)),
        // Runner.Disconnect: the room closes that connection (TableNet.disconnect is optional so in-memory test nets still fit).
        disconnect: (player) => {
          this.opts.log?.(`[Tournament] Turned away player ${player}.`);
          net.disconnect?.(player);
        },
        quit: () => this.opts.onQuit?.(),
      },
      timing: {
        nowMs: () => clock.now() * 1000,
        wait: (seconds, signal) => clock.wait(seconds, signal),
        random: this.opts.random ?? Math.random,
        makeRandom: () => new CryptoRandom(),
      },
      pacing,
      backend: this.opts.backend ?? null,
      devPlayers: this.opts.devPlayers ?? 0,
      devFillWaitMs: (this.opts.devFillWaitSeconds ?? 10) * 1000,
      log: this.opts.log,
    });
    this.game.activate();
  }

  onHello(player: PlayerRef, playerName: string, token: string, sessionTicket: string, _buyInChips = 0): void {
    this.game?.onHello(player, playerName, token, sessionTicket);
  }
  onActionSubmitted(source: PlayerRef, seat: number, action: PlayerAction): void {
    this.game?.onActionSubmitted(source, seat, action);
  }
  onReaction(source: PlayerRef, reactionId: number): void {
    this.game?.onReaction(source, reactionId);
  }
  onAvatar(source: PlayerRef, avatar: number): void {
    this.game?.onAvatar(source, avatar);
  }
  onLeaveTable(source: PlayerRef): void {
    this.game?.onLeaveTable(source);
  }
  onPlayerLeft(player: PlayerRef): void {
    this.game?.onPlayerLeft(player);
  }
  onTournamentWatch(source: PlayerRef, tableId: number): void {
    this.game?.onWatchTable(source, tableId);
  }
  seatOf(player: PlayerRef): number {
    return this.game?.seatOfPlayer(player) ?? -1;
  }
  dispose(): void {
    this.game?.shutdown();
  }

  /** Rewards are paid by the claimRetentionGrant CloudScript, never by a table (TournamentServerGame.OnRetentionGrant). */
  onRetentionGrant(_player: PlayerRef, idempotencyKey: string): void {
    this.net?.broadcastRetentionGrantResult(idempotencyKey, false, -1);
  }

  // A tournament has no lobby, bots on demand or buy-ins (TournamentServerGame's no-ops).
  onVoiceState(): void {}
  onAddBot(): void {}
  onRemoveBot(): void {}
  onStartGame(): void {}
  onBuyIn(): void {}
}
