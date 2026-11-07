/**
 * Daily / weekly free-play missions: kinds, catalog, board state and progress rules. Ports of
 * Core/Retention/MissionKind.cs, MissionCatalog.cs and MissionProgressState.cs, plus the board's PlayerPrefs string
 * format from Game/Retention/PlayerProgression.cs (SerializeBoard / DeserializeBoard).
 */
import { RewardGrant, RewardKind } from '../../app/services';

export enum MissionKind {
  PlayHands = 0,
  WinHands = 1,
  PlayTables = 2,
  WinPairOrBetter = 3,
  /** Seated at a free-play table with at least one confirmed friend. */
  PlayWithFriend = 4,
  /** Weekly hand counter (advanced alongside PlayHands). */
  WeeklyHands = 5,
  WinTwoPairOrBetter = 6,
}

export interface MissionDef {
  readonly id: string;
  readonly title: string;
  readonly kind: MissionKind;
  readonly target: number;
  readonly weekly: boolean;
  readonly rewards: readonly RewardGrant[];
}

export function missionDef(id: string, title: string, kind: MissionKind, target: number, weekly: boolean, ...rewards: RewardGrant[]): MissionDef {
  return Object.freeze({ id, title: title ?? '', kind, target: target < 1 ? 1 : target, weekly, rewards: Object.freeze(rewards) });
}

/** MissionDef.RewardPreview: "+500 Coins, +50 XP" (amounts unformatted, as the C# StringBuilder appends a long). */
export function rewardPreview(def: MissionDef): string {
  if (!def.rewards.length) return '';
  return def.rewards
    .map((r) => {
      let suffix: string;
      switch (r.kind) {
        case RewardKind.Coins: suffix = ' Coins'; break;
        case RewardKind.Gems: suffix = r.amount === 1 ? ' Gem' : ' Gems'; break;
        case RewardKind.Xp: suffix = ' XP'; break;
        case RewardKind.StreakToken: suffix = ' Tokens'; break;
        default: suffix = r.itemId ? ' ' + r.itemId : '';
      }
      return '+' + r.amount + suffix;
    })
    .join(', ');
}

export const MissionCatalog = {
  Daily: Object.freeze([
    missionDef('daily_warmup_10', 'Shuffle Up — play 10 hands', MissionKind.PlayHands, 10, false,
      RewardGrant.coins(500, 'mission'), RewardGrant.xp(50, 'mission')),
    missionDef('daily_hot_hand_3', 'Hot Hand — win 3 hands', MissionKind.WinHands, 3, false,
      RewardGrant.coins(750, 'mission'), RewardGrant.xp(75, 'mission')),
    missionDef('daily_table_tour_2', 'Table Hopper — play 2 tables', MissionKind.PlayTables, 2, false,
      RewardGrant.coins(400, 'mission'), RewardGrant.xp(40, 'mission')),
    missionDef('daily_pair_power', 'Pair Power — win with a pair or better', MissionKind.WinPairOrBetter, 1, false,
      RewardGrant.coins(300, 'mission'), RewardGrant.xp(30, 'mission'), RewardGrant.gems(1, 'mission')),
    missionDef('daily_buddy', 'Buddy System — play with a friend', MissionKind.PlayWithFriend, 1, false,
      RewardGrant.coins(1000, 'mission'), RewardGrant.xp(100, 'mission')),
  ]) as readonly MissionDef[],

  Weekly: Object.freeze([
    missionDef('weekly_grinder_40', 'Weekly Grinder — complete 40 hands', MissionKind.WeeklyHands, 40, true,
      RewardGrant.coins(2500, 'mission'), RewardGrant.xp(200, 'mission'), RewardGrant.gems(2, 'mission')),
    missionDef('weekly_collector_12', 'Cash Collector — win 12 hands', MissionKind.WinHands, 12, true,
      RewardGrant.coins(3000, 'mission'), RewardGrant.xp(250, 'mission'), RewardGrant.gems(3, 'mission')),
    missionDef('weekly_two_pair_3', 'Two Pair Club — win with two pair+ (3×)', MissionKind.WinTwoPairOrBetter, 3, true,
      RewardGrant.coins(2000, 'mission'), RewardGrant.xp(150, 'mission'), RewardGrant.gems(2, 'mission')),
  ]) as readonly MissionDef[],

  get All(): MissionDef[] {
    return [...MissionCatalog.Daily, ...MissionCatalog.Weekly];
  },

  tryGet(id: string): MissionDef | undefined {
    return MissionCatalog.Daily.find((d) => d.id === id) ?? MissionCatalog.Weekly.find((d) => d.id === id);
  },
};

export interface MissionSlotState {
  id: string;
  progress: number;
  claimed: boolean;
}

/** Persisted mission board: resets daily (UTC) and weekly (7-day buckets from the epoch). */
export interface MissionBoardState {
  dayNumber: number;
  weekNumber: number;
  slots: MissionSlotState[];
  /** Session names already counted toward PlayTables today. */
  tablesToday: string[];
}

export const newBoard = (): MissionBoardState => ({ dayNumber: 0, weekNumber: 0, slots: [], tablesToday: [] });

export const MissionProgressMath = {
  /** C# integer division (truncates toward zero; negatives clamp to 0 first). */
  weekFromDay: (utcDay: number): number => (utcDay < 0 ? 0 : Math.trunc(utcDay / 7)),

  /** Resets daily/weekly slots when the UTC day or week rolls. Mutates and returns `state`. */
  ensureFresh(state: MissionBoardState | null | undefined, todayDay: number): MissionBoardState {
    const s = state ?? newBoard();
    s.slots ??= [];
    s.tablesToday ??= [];
    const week = MissionProgressMath.weekFromDay(todayDay);
    const dayChanged = s.dayNumber !== todayDay;
    const weekChanged = s.weekNumber !== week;
    const empty = s.slots.length === 0;
    if (!dayChanged && !weekChanged && !empty && s.slots.length === MissionCatalog.Daily.length + MissionCatalog.Weekly.length) return s;

    const prev = new Map<string, MissionSlotState>();
    for (const slot of s.slots) if (slot && slot.id) prev.set(slot.id, slot);
    if (dayChanged) s.tablesToday.length = 0;
    s.dayNumber = todayDay;
    s.weekNumber = week;
    s.slots.length = 0;
    for (const def of MissionCatalog.Daily) {
      const old = prev.get(def.id);
      const reset = dayChanged || empty;
      s.slots.push({ id: def.id, progress: reset ? 0 : (old?.progress ?? 0), claimed: reset ? false : (old?.claimed ?? false) });
    }
    for (const def of MissionCatalog.Weekly) {
      const old = prev.get(def.id);
      const reset = weekChanged || empty;
      s.slots.push({ id: def.id, progress: reset ? 0 : (old?.progress ?? 0), claimed: reset ? false : (old?.claimed ?? false) });
    }
    return s;
  },

  find(state: MissionBoardState | null | undefined, id: string): MissionSlotState | null {
    return state?.slots?.find((x) => x && x.id === id) ?? null;
  },

  /** Adds progress for matching kinds. Returns true if any slot changed. */
  advance(state: MissionBoardState | null | undefined, kind: MissionKind, amount: number, todayDay: number): boolean {
    if (!state || amount <= 0) return false;
    MissionProgressMath.ensureFresh(state, todayDay);
    let changed = false;
    for (const slot of state.slots) {
      if (!slot || slot.claimed) continue;
      const def = MissionCatalog.tryGet(slot.id);
      if (!def || def.kind !== kind) continue;
      const before = slot.progress;
      slot.progress = Math.min(def.target, slot.progress + amount);
      if (slot.progress !== before) changed = true;
    }
    return changed;
  },

  /** C# TryClaim(out rewards): the rewards, or null when the slot cannot be claimed. */
  tryClaim(state: MissionBoardState | null | undefined, id: string, todayDay: number): readonly RewardGrant[] | null {
    if (!state) return null;
    MissionProgressMath.ensureFresh(state, todayDay);
    const slot = MissionProgressMath.find(state, id);
    if (!slot || slot.claimed) return null;
    const def = MissionCatalog.tryGet(id);
    if (!def || slot.progress < def.target) return null;
    slot.claimed = true;
    return def.rewards;
  },

  tryCountTable(state: MissionBoardState | null | undefined, sessionName: string, todayDay: number): boolean {
    if (!state || !sessionName) return false;
    MissionProgressMath.ensureFresh(state, todayDay);
    if (state.tablesToday.includes(sessionName)) return false;
    state.tablesToday.push(sessionName);
    return MissionProgressMath.advance(state, MissionKind.PlayTables, 1, todayDay);
  },
};

// ---- PlayerProgression's PlayerPrefs format: "day|week|id:progress:claimed,...|table,table" ----------------------

export function serializeBoard(board: MissionBoardState | null): string {
  if (!board) return '';
  let s = `${board.dayNumber}|${board.weekNumber}|`;
  board.slots?.forEach((slot, i) => {
    if (!slot) return;
    if (i > 0) s += ',';
    s += `${slot.id}:${slot.progress}:${slot.claimed ? 1 : 0}`;
  });
  s += '|';
  s += (board.tablesToday ?? []).join(',');
  return s;
}

/** C# int.TryParse: digits with an optional sign, else 0. */
const tryParseInt = (v: string | undefined): number => (v !== undefined && /^\s*[+-]?\d+\s*$/.test(v) ? Number.parseInt(v, 10) | 0 : 0);

export function deserializeBoard(packed: string | null | undefined): MissionBoardState {
  const board = newBoard();
  if (!packed) return board;
  const parts = packed.split('|');
  if (parts.length < 2) return board;
  board.dayNumber = tryParseInt(parts[0]);
  board.weekNumber = tryParseInt(parts[1]);
  if (parts.length >= 3 && parts[2]) {
    for (const entry of parts[2].split(',')) {
      const bits = entry.split(':');
      if (bits.length < 3) continue;
      board.slots.push({ id: bits[0]!, progress: tryParseInt(bits[1]), claimed: bits[2] === '1' });
    }
  }
  if (parts.length >= 4 && parts[3]) {
    for (const t of parts[3].split(',')) if (t && !board.tablesToday.includes(t)) board.tablesToday.push(t);
  }
  return board;
}
