/**
 * Port of Game/Analytics/PokerFunnel.cs: first table / first hand / sessions milestones, kept in PlayerPrefs under the
 * same keys. PokerTelemetry has no web backend: events are logged with console.debug (no network).
 */
import { PlayerPrefs } from '../app/services';

const FIRST_TABLE = 'Poker.Funnel.FirstTable';
const FIRST_HAND = 'Poker.Funnel.FirstHand';
const FIRST_SESSION = 'Poker.Funnel.FirstSession';
const SECOND_SESSION = 'Poker.Funnel.SecondSession';
const SESSIONS = 'Poker.Funnel.SessionsCompleted';
const ACCOUNT_CREATED = 'Poker.Funnel.AccountCreated';

const appStart = performance.now();
let tableOpen = false;
let tableStart = 0;
let tableHands = 0;
let tableNet = 0;
let tableMinBuyIn = 0;

const telemetry = (event: string, data: Record<string, unknown> = {}) => console.debug('[telemetry]', event, data);
const INT_MAX = 2147483647;
const addClamped = (a: number, b: number) => Math.max(-INT_MAX - 1, Math.min(INT_MAX, a + b));

export const PokerFunnel = {
  sessionStarted(): void {
    telemetry('session_started', { scene: 'menu' });
  },
  onAccountCreated(method: string): void {
    if (PlayerPrefs.getInt(ACCOUNT_CREATED, 0) !== 0) return;
    PlayerPrefs.setInt(ACCOUNT_CREATED, 1);
    telemetry('account_created', { method });
  },
  beginTable(sessionName: string, minBuyIn: number, buyIn: number, moneyTable: boolean): void {
    PokerFunnel.endTable();
    tableOpen = true;
    tableStart = performance.now();
    tableHands = 0;
    tableNet = 0;
    tableMinBuyIn = minBuyIn;
    telemetry('table_joined', { sessionName, minBuyIn, buyIn, moneyTable });
    if (PlayerPrefs.getInt(FIRST_TABLE, 0) === 0) {
      PlayerPrefs.setInt(FIRST_TABLE, 1);
      telemetry('first_table', { minBuyIn, sessionName });
    }
  },
  recordHand(netChips: number, won: boolean, minBuyIn: number): void {
    if (tableOpen) {
      tableHands++;
      tableNet = addClamped(tableNet, netChips);
    }
    telemetry('hand_played', { minBuyIn, netChips, won });
    if (PlayerPrefs.getInt(FIRST_HAND, 0) === 0) {
      PlayerPrefs.setInt(FIRST_HAND, 1);
      telemetry('first_hand', { minBuyIn });
    }
  },
  endTable(): void {
    if (!tableOpen) return;
    tableOpen = false;
    const seconds = Math.max(0, Math.floor((performance.now() - tableStart) / 1000));
    telemetry('table_session_ended', { hands: tableHands, seconds, net: tableNet, minBuyIn: tableMinBuyIn });
    const completed = PlayerPrefs.getInt(SESSIONS, 0) + 1;
    PlayerPrefs.setInt(SESSIONS, completed);
    if (PlayerPrefs.getInt(FIRST_SESSION, 0) === 0) {
      PlayerPrefs.setInt(FIRST_SESSION, 1);
      telemetry('first_session_completed', { hands: tableHands, seconds, net: tableNet });
    } else if (completed === 2 && PlayerPrefs.getInt(SECOND_SESSION, 0) === 0) {
      PlayerPrefs.setInt(SECOND_SESSION, 1);
      telemetry('second_session', { completed });
    }
    tableHands = 0;
    tableNet = 0;
  },
  stakeSelected(minBuyIn: number, buyIn: number, autoMatch: boolean): void {
    telemetry('stake_selected', { minBuyIn, buyIn, autoMatch });
  },
  /** Application.quitting. */
  quitting(): void {
    PokerFunnel.endTable();
    telemetry('session_ended', { seconds: Math.floor((performance.now() - appStart) / 1000), sessions: PlayerPrefs.getInt(SESSIONS, 0) });
  },
};
