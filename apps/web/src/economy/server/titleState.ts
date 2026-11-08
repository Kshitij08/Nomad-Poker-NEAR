/**
 * The data of an emulated PlayFab title: accounts, friend lists, user data, statistics, Economy v2 chip stacks and
 * Entity Objects (with ProfileVersion for compare-and-set). Plain JSON, no browser APIs, so the in-browser local
 * title (economy/playfab/localTitle.ts), the offline chip ledger (chipLedger.ts) and the CloudScript ports
 * (cloudScript.ts) can all share it — the same way the real ledger and CloudScript share one title.
 */
import { FreePlayLeaderboardMath } from '@nomad/engine/leaderboards/freePlayLeaderboardMath';

export interface DataRecord {
  Value: string;
  LastUpdated: string;
}

export interface FriendLink {
  tags: string[];
}

export interface StatValue {
  value: number;
  /** Reset bucket the value belongs to (WeekId for weekly stats, SeasonId for season stats, 0 = lifetime). */
  period: number;
  updated: number;
}

export interface TitlePlayer {
  id: string; // 16 upper-case hex, the PlayFabId (master account)
  entityId: string; // title_player_account id (different from the PlayFabId, as on the real title)
  customIds: string[];
  email: string | null;
  password: string | null;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  created: number;
  lastLogin: number | null;
  userData: Record<string, DataRecord>;
  readOnlyData: Record<string, DataRecord>;
  friends: Record<string, FriendLink>;
  stats: Record<string, StatValue>;
  /** Economy v2 chips stack; null = the player has no stack at all (never welcomed, never paid). */
  chips: number | null;
  /** Idempotency ids v2 has already applied for this player. */
  appliedIdempotency: string[];
  /** Entity Objects (SeatLock, ChipGrants…), and the entity's ProfileVersion. */
  objects: Record<string, unknown>;
  profileVersion: number;
  /** Not a real PlayFab field: marks the demo players seeded for offline testing. */
  demo?: boolean;
}

export interface TitleState {
  version: 1;
  players: Record<string, TitlePlayer>;
  sessions: Record<string, { playFabId: string; expires: number }>;
  entityTokens: Record<string, { playFabId: string; expires: number }>;
}

/** A state plus how to persist it after a write (localStorage for the browser title, nothing for a server). */
export interface TitleStateHandle {
  readonly state: TitleState;
  save(): void;
}

export function emptyTitleState(): TitleState {
  return { version: 1, players: {}, sessions: {}, entityTokens: {} };
}

export function memoryTitle(state: TitleState = emptyTitleState()): TitleStateHandle {
  return { state, save: () => {} };
}

const HEX = '0123456789ABCDEF';
export function randomHex(len: number, rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < len; i++) s += HEX[Math.floor(rand() * 16)];
  return s;
}

export function createPlayer(state: TitleState, init: Partial<TitlePlayer> = {}): TitlePlayer {
  let id = init.id ?? randomHex(16);
  while (state.players[id]) id = randomHex(16);
  const p: TitlePlayer = {
    id,
    entityId: init.entityId ?? randomHex(16),
    customIds: init.customIds ?? [],
    email: init.email ?? null,
    password: init.password ?? null,
    username: init.username ?? null,
    displayName: init.displayName ?? null,
    avatarUrl: init.avatarUrl ?? null,
    created: init.created ?? Date.now(),
    lastLogin: init.lastLogin ?? null,
    userData: init.userData ?? {},
    readOnlyData: init.readOnlyData ?? {},
    friends: init.friends ?? {},
    stats: init.stats ?? {},
    chips: init.chips ?? null,
    appliedIdempotency: init.appliedIdempotency ?? [],
    objects: init.objects ?? {},
    profileVersion: init.profileVersion ?? 0,
    demo: init.demo,
  };
  state.players[id] = p;
  return p;
}

export function playerByEntity(state: TitleState, entityId: string): TitlePlayer | null {
  for (const p of Object.values(state.players)) if (p.entityId === entityId) return p;
  return null;
}

// ---- Statistics: reset periods as configured in Game Manager (FreePlayLeaderboard.cs docs) -------------

export function statPeriod(name: string, now: number): number {
  if (name === FreePlayLeaderboardMath.WeeklyEarnings || name === FreePlayLeaderboardMath.WeeklyHandsWon) {
    return FreePlayLeaderboardMath.weekId(now);
  }
  if (name === FreePlayLeaderboardMath.SeasonEarnings) return FreePlayLeaderboardMath.seasonId(now);
  return 0;
}

/** The player's live value for a statistic, or null when unset / reset since it was written. */
export function statOf(p: TitlePlayer, name: string, now: number): number | null {
  const s = p.stats[name];
  if (!s || s.period !== statPeriod(name, now)) return null;
  return s.value;
}

/** PlayFab "Last" aggregation: the posted value replaces the stored one. */
export function setStat(p: TitlePlayer, name: string, value: number, now: number): void {
  p.stats[name] = { value: FreePlayLeaderboardMath.clampScore(value), period: statPeriod(name, now), updated: now };
}

/** Ranked rows (descending value; ties keep the earlier writer first, as PlayFab does). */
export function rankedBoard(state: TitleState, name: string, now: number, ids?: ReadonlySet<string>): { player: TitlePlayer; value: number }[] {
  const rows: { player: TitlePlayer; value: number; updated: number }[] = [];
  for (const p of Object.values(state.players)) {
    if (ids && !ids.has(p.id)) continue;
    const v = statOf(p, name, now);
    if (v === null) continue;
    rows.push({ player: p, value: v, updated: p.stats[name]!.updated });
  }
  rows.sort((a, b) => b.value - a.value || a.updated - b.updated);
  return rows;
}

// ---- Entity Objects --------------------------------------------------------------------------------------

/** SetObjects with optional ExpectedProfileVersion. False = EntityProfileVersionMismatch. null value deletes. */
export function setObject(p: TitlePlayer, name: string, value: unknown, expectedVersion: number | null): boolean {
  if (expectedVersion !== null && expectedVersion !== p.profileVersion) return false;
  if (value === null || value === undefined) delete p.objects[name];
  else p.objects[name] = JSON.parse(JSON.stringify(value));
  p.profileVersion++;
  return true;
}

/** Economy v2 AddInventoryItems / SubtractInventoryItems with IdempotencyId. Returns false on overdraft. */
export function moveChips(p: TitlePlayer, delta: number, idempotencyId: string | null): boolean {
  if (idempotencyId && p.appliedIdempotency.includes(idempotencyId)) return true; // already applied: v2 no-ops
  const current = p.chips ?? 0;
  if (current + delta < 0) return false; // v2 refuses an overdraft (InsufficientFunds)
  p.chips = current + delta;
  if (idempotencyId) {
    p.appliedIdempotency.push(idempotencyId);
    if (p.appliedIdempotency.length > 500) p.appliedIdempotency.splice(0, p.appliedIdempotency.length - 500);
  }
  return true;
}
