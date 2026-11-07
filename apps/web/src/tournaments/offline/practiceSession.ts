import { CryptoRandom } from '../../core/cards/random';
import { TEST_SCENE_TABLE_SETTINGS } from '../../core/orchestration/tableSettings';
import { ticker, type Linkable, type Tween } from '../../anim/tween';
import { tickerWait } from '../../table/tableView';
import type { TableSessionFactory } from '../../table/tableScreen';
import { RewardGrant } from '../../app/services';
import { tournamentClientState } from '../clientState';
import { TournamentTableClient } from '../client/tournamentTableClient';
import { TournamentServerGame } from '../runtime/tournamentServerGame';
import type { PlayerRef, RuntimeTiming, TournamentPacing, TournamentTransport } from '../runtime/wire';

/** The practice presets of Tools > Poker > Tournament (TournamentPracticeMenu): one table, two tables, four tables. */
export const PRACTICE_FIELDS = [5, 8, 16] as const;

/** Practice runs' session name (Unity: TRNDEV… for an Editor-hosted dev tournament). */
export const PRACTICE_SESSION = 'TRNPRACTICE';

const LOCAL_PLAYER: PlayerRef = 1;

/** Milliseconds on the animation ticker, so ?speed=N and ?paused=1 + __poker.step() drive the tournament too. */
export class TickerClock implements Tween {
  readonly duration = Number.POSITIVE_INFINITY;
  done = false;
  private ms = 0;
  constructor() {
    ticker.add(this);
  }
  get nowMs(): number {
    return this.ms;
  }
  step(dt: number): number {
    this.ms += dt * 1000;
    return 0;
  }
  kill(): void {
    this.done = true;
  }
  onComplete(): Tween {
    return this;
  }
  setLink(_target: Linkable): Tween {
    return this;
  }
}

/** The pacing the table scene's TableSettings gives the tournament server (and the client mirrors). */
export function scenePacing(): TournamentPacing {
  const s = TEST_SCENE_TABLE_SETTINGS;
  return {
    turnTimer: s.turnTimer, dealDelay: s.dealDelay, dealSettleDelay: s.dealSettleDelay, actionDelay: s.actionDelay,
    showdownDelay: s.showdownDelay, betweenHands: s.betweenHands,
  };
}

export interface PracticeOptions {
  /** Field size, you included (2..30). Bots fill the rest. */
  players: number;
  playerName?: string;
  /** The tournament's name and prizes (a demo tournament launched from the menu keeps its own). */
  name?: string;
  firstPrize?: number;
  secondPrize?: number;
  /** Seconds to wait for "other players" before bots sit (Unity waits 10 s for builds to join; nobody can here). */
  fillWaitSeconds?: number;
}

/**
 * The offline practice tournament (Tools > Poker > Tournament > Practice): this browser hosts a TournamentServerGame
 * in dev mode — you play, bots take the other seats, one-minute levels — and a TournamentTableClient mirrors your
 * table onto the felt through an in-memory transport. Every table plays real hands in real time, exactly as the
 * hosted server would; nothing touches a network.
 */
export function practiceTournamentSession(options: PracticeOptions): TableSessionFactory {
  return (host) => {
    const clock = new TickerClock();
    const pacing = scenePacing();
    const timing: RuntimeTiming = {
      nowMs: () => clock.nowMs,
      wait: (seconds, signal) => tickerWait(seconds, signal),
      random: Math.random,
      makeRandom: () => new CryptoRandom(),
    };
    let client: TournamentTableClient | null = null;
    const transport: TournamentTransport = {
      sendEventTo: (player, sequence, event) => {
        if (player === LOCAL_PLAYER) client?.receive(sequence, event);
      },
      disconnect: () => {},
    };
    const server = new TournamentServerGame({
      transport, timing, pacing,
      devPlayers: Math.max(2, Math.min(30, options.players)),
      practiceHost: true,
      name: options.name,
      firstPrize: options.firstPrize,
      secondPrize: options.secondPrize,
      devFillWaitMs: (options.fillWaitSeconds ?? 0) * 1000,
      log: (m) => console.info(m),
    });
    client = new TournamentTableClient(host.view, host.audio, tournamentClientState, {
      session: PRACTICE_SESSION,
      pacing,
      wait: tickerWait,
      now: () => clock.nowMs / 1000,
      submitAction: (seat, action) => server.onActionSubmitted(LOCAL_PLAYER, seat, action),
      grantXp: (xp) => host.ctx.services.wallet?.grant(RewardGrant.xp(xp, 'tournament')),
    });
    const name = options.playerName ?? host.ctx.services.account?.displayName ?? 'You';

    return {
      start: () => {
        client!.start();
        tournamentClientState.watchHandler = (tableId) => server.onWatchTable(LOCAL_PLAYER, tableId);
        tournamentClientState.leaveHandler = () => host.leave();
        server.activate();
        server.onHello(LOCAL_PLAYER, name, 'practice-you', '');
        (window as unknown as Record<string, unknown>).__tournament = server;
      },
      stop: () => {
        server.shutdown();
        client!.stop();
        clock.kill();
        tournamentClientState.clear();
      },
    };
  };
}
