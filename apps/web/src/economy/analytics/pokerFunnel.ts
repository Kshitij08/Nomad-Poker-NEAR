/**
 * Port of Game/Analytics/PokerFunnel.cs: once-per-player funnel flags (same PlayerPrefs keys) and table-session
 * telemetry. The table/net modules call beginTable / recordHand / endTable (PokerClientGame does in Unity) and the
 * menu calls stakeSelected when StakeSelection changes; `ctx.services.telemetry.funnel` exposes this.
 */
import { PlayerPrefs } from '../../app/services';
import { FreePlayLeaderboardMath } from '@nomad/engine/leaderboards/freePlayLeaderboardMath';
import { PokerTelemetry } from './pokerTelemetry';

const FirstTableKey = 'Poker.Funnel.FirstTable';
const FirstHandKey = 'Poker.Funnel.FirstHand';
const FirstSessionKey = 'Poker.Funnel.FirstSession';
const SecondSessionKey = 'Poker.Funnel.SecondSession';
const SessionsKey = 'Poker.Funnel.SessionsCompleted';
const AccountCreatedKey = 'Poker.Funnel.AccountCreated';

const realtime = (): number => performance.now() / 1000;

let appStart = 0;
let appSessionSent = false;
let tableOpen = false;
let tableStart = 0;
let tableHands = 0;
let tableNet = 0;
let tableMinBuyIn = 0;

export const PokerFunnel = {
  /** RuntimeInitializeOnLoad(AfterSceneLoad): session_started once per app session; session_ended on page hide. */
  bootstrap(scene: string): void {
    appStart = realtime();
    if (!appSessionSent) {
      appSessionSent = true;
      PokerTelemetry.sessionStarted(scene, false);
    }
    addEventListener('pagehide', onQuitting, { once: true });
  },

  onAccountCreated(method: string): void {
    if (PlayerPrefs.getInt(AccountCreatedKey, 0) !== 0) return;
    PlayerPrefs.setInt(AccountCreatedKey, 1);
    PokerTelemetry.accountCreated(method);
  },

  beginTable(sessionName: string, minBuyIn: number, buyIn: number, moneyTable: boolean): void {
    PokerFunnel.endTable();
    tableOpen = true;
    tableStart = realtime();
    tableHands = 0;
    tableNet = 0;
    tableMinBuyIn = minBuyIn;
    PokerTelemetry.tableJoined(sessionName, minBuyIn, buyIn, moneyTable);
    if (PlayerPrefs.getInt(FirstTableKey, 0) === 0) {
      PlayerPrefs.setInt(FirstTableKey, 1);
      PokerTelemetry.firstTable(minBuyIn, sessionName);
    }
  },

  recordHand(netChips: number, won: boolean, minBuyIn: number): void {
    if (tableOpen) {
      tableHands++;
      tableNet = FreePlayLeaderboardMath.addClamped(tableNet, netChips);
    }
    PokerTelemetry.handPlayed(minBuyIn, netChips, won);
    if (PlayerPrefs.getInt(FirstHandKey, 0) === 0) {
      PlayerPrefs.setInt(FirstHandKey, 1);
      PokerTelemetry.firstHand(minBuyIn);
    }
  },

  endTable(): void {
    if (!tableOpen) return;
    tableOpen = false;
    const seconds = Math.max(0, Math.trunc(realtime() - tableStart));
    PokerTelemetry.tableSessionEnded(tableHands, seconds, tableNet, tableMinBuyIn);
    const completed = PlayerPrefs.getInt(SessionsKey, 0) + 1;
    PlayerPrefs.setInt(SessionsKey, completed);
    if (PlayerPrefs.getInt(FirstSessionKey, 0) === 0) {
      PlayerPrefs.setInt(FirstSessionKey, 1);
      PokerTelemetry.firstSessionCompleted(tableHands, seconds, tableNet);
    } else if (completed === 2 && PlayerPrefs.getInt(SecondSessionKey, 0) === 0) {
      PlayerPrefs.setInt(SecondSessionKey, 1);
      PokerTelemetry.secondSession(completed);
    }
    tableHands = 0;
    tableNet = 0;
  },

  /** StakeSelection.Changed → stake_selected. */
  stakeSelected(minBuyIn: number, buyInChips: number, autoMatch: boolean): void {
    PokerTelemetry.stakeSelected(minBuyIn, buyInChips, autoMatch);
  },
};

function onQuitting(): void {
  PokerFunnel.endTable();
  const seconds = Math.max(0, Math.trunc(realtime() - appStart));
  PokerTelemetry.sessionEnded(seconds, PlayerPrefs.getInt(SessionsKey, 0));
  PokerTelemetry.flush();
}
