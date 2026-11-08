/**
 * Port of Economy/PlayFabLeaderboardBridge.cs: pushes the free-play statistics to PlayFab (legacy player stats +
 * Progression entity stats) and reads global / friend boards in pages of FreePlayLeaderboardMath.PageSize, falling
 * back from the legacy board to the entity leaderboard when the legacy one is empty.
 */
import { FreePlayLeaderboardMath, LeaderboardKind } from '@nomad/engine/leaderboards/freePlayLeaderboardMath';
import { PokerClientIdentity } from '../identity';
import { FreePlayLeaderboard, type LeaderboardEntry, type LeaderboardSnapshot } from '../leaderboards/freePlayLeaderboard';
import { errorReport } from './client';
import { isClientLoggedIn, playFab } from './runtime';

const PageSize = FreePlayLeaderboardMath.PageSize;

interface PlayerLeaderboardEntry {
  PlayFabId?: string;
  DisplayName?: string;
  StatValue?: number;
  Position?: number;
}
interface EntityRanking {
  Entity?: { Id?: string; Type?: string };
  DisplayName?: string;
  Rank?: number;
  Scores?: string[];
}
interface EntityLeaderboard {
  Rankings?: EntityRanking[];
  EntryCount?: number;
}
interface LocalStanding {
  rank: number;
  score: number;
  hasScore: boolean;
}

const scoreKind = (kind: LeaderboardKind): LeaderboardKind => (kind === LeaderboardKind.FriendsWeekly ? LeaderboardKind.WeeklyEarnings : kind);

export const PlayFabLeaderboardBridge = {
  attach(): void {
    FreePlayLeaderboard.localDisplayName = PokerClientIdentity.playerName || 'You';
    FreePlayLeaderboard.submitOverride = PlayFabLeaderboardBridge.submit;
    FreePlayLeaderboard.fetchOverride = fetchAsync;
    PlayFabLeaderboardBridge.submit();
  },

  detach(): void {
    FreePlayLeaderboard.submitOverride = null;
    FreePlayLeaderboard.fetchOverride = null;
  },

  submit(): void {
    if (!isClientLoggedIn()) return;
    const stats = [
      { StatisticName: FreePlayLeaderboardMath.WeeklyEarnings, Value: FreePlayLeaderboard.weeklyEarnings },
      { StatisticName: FreePlayLeaderboardMath.WeeklyHandsWon, Value: FreePlayLeaderboard.weeklyHandsWon },
      { StatisticName: FreePlayLeaderboardMath.SeasonEarnings, Value: FreePlayLeaderboard.seasonEarnings },
      { StatisticName: FreePlayLeaderboardMath.HandsWon, Value: FreePlayLeaderboard.handsWon },
    ];
    const c = playFab()!;
    void c.client('UpdatePlayerStatistics', { Statistics: stats }).then((r) => {
      if (r.error) console.warn(`[Leaderboard] UpdatePlayerStatistics: ${errorReport(r.error)}`);
    });
    // Newer titles rank the entity statistic, not the legacy player statistic.
    void c.entity('Statistic/UpdateStatistics', {
      Statistics: stats.map((s) => ({ Name: s.StatisticName, Scores: [String(s.Value)] })),
    }).then((r) => {
      if (r.error) console.warn(`[Leaderboard] UpdateStatistics: ${errorReport(r.error)}`);
    });
  },
};

async function fetchAsync(kind: LeaderboardKind, pageIndex: number): Promise<LeaderboardSnapshot | null> {
  if (!isClientLoggedIn()) return null;
  if (pageIndex < 0) pageIndex = 0;
  const statistic = kind === LeaderboardKind.FriendsWeekly ? FreePlayLeaderboardMath.WeeklyEarnings : FreePlayLeaderboard.statisticName(kind);
  const start = pageIndex * PageSize;

  let snap = await fetchPageAsync(kind, statistic, start, pageIndex);
  if (!snap || snap.rows.length === 0) {
    let modern: LeaderboardSnapshot | null = null;
    try {
      modern = await fetchProgressionPageAsync(kind, statistic, start, pageIndex);
    } catch (e) {
      console.warn('[Leaderboard] Entity leaderboard skipped', e);
    }
    if (modern && (!snap || modern.rows.length > 0)) snap = modern;
  }

  if (!snap) {
    return {
      kind, title: FreePlayLeaderboard.titleFor(kind), status: 'PlayFab ranks are unavailable.',
      localRank: 0, localScore: FreePlayLeaderboard.localScore(scoreKind(kind)),
      pageIndex, pageSize: PageSize, hasMore: false, rows: [],
    };
  }

  let standing = await fetchLocalStandingAsync(statistic);
  if (standing.rank <= 0) {
    try {
      const modern = await fetchProgressionStandingAsync(statistic);
      if (modern.rank > 0) standing = modern;
    } catch (e) {
      console.warn('[Leaderboard] Entity rank skipped', e);
    }
  }
  if (standing.rank > 0) snap.localRank = standing.rank;
  if (standing.hasScore) snap.localScore = standing.score;
  return snap;
}

async function fetchPageAsync(kind: LeaderboardKind, statistic: string, startPosition: number, pageIndex: number): Promise<LeaderboardSnapshot | null> {
  const c = playFab()!;
  const body = { StatisticName: statistic, StartPosition: startPosition, MaxResultsCount: PageSize, ProfileConstraints: { ShowDisplayName: true } };
  if (kind === LeaderboardKind.FriendsWeekly) {
    const r = await c.client<{ Leaderboard?: PlayerLeaderboardEntry[] }>('GetFriendLeaderboard', body);
    if (r.error) {
      console.warn(`[Leaderboard] Friends: ${errorReport(r.error)}`);
      return {
        kind, title: FreePlayLeaderboard.titleFor(kind), status: 'Friends ranks unlock once you add PlayFab friends.',
        localRank: 0, localScore: FreePlayLeaderboard.localScore(LeaderboardKind.WeeklyEarnings),
        pageIndex, pageSize: PageSize, hasMore: false, rows: [],
      };
    }
    return fromEntries(kind, r.data.Leaderboard, pageIndex, 'Friends · play with them to appear here.');
  }
  const r = await c.client<{ Leaderboard?: PlayerLeaderboardEntry[] }>('GetLeaderboard', body);
  if (r.error) {
    console.warn(`[Leaderboard] GetLeaderboard: ${errorReport(r.error)}`);
    return null;
  }
  return fromEntries(kind, r.data.Leaderboard, pageIndex, '');
}

async function fetchProgressionPageAsync(kind: LeaderboardKind, statistic: string, startPosition: number, pageIndex: number): Promise<LeaderboardSnapshot | null> {
  const c = playFab()!;
  if (kind === LeaderboardKind.FriendsWeekly) {
    const r = await c.entity<EntityLeaderboard>('Leaderboard/GetFriendLeaderboardForEntity', { LeaderboardName: statistic });
    if (r.error) {
      console.warn(`[Leaderboard] Entity friends: ${errorReport(r.error)}`);
      return null;
    }
    return fromEntityRankings(kind, r.data, pageIndex, 'Friends · play with them to appear here.');
  }
  const r = await c.entity<EntityLeaderboard>('Leaderboard/GetLeaderboard', { LeaderboardName: statistic, PageSize, StartingPosition: startPosition + 1 });
  if (r.error) {
    console.warn(`[Leaderboard] Entity leaderboard: ${errorReport(r.error)}`);
    return null;
  }
  return fromEntityRankings(kind, r.data, pageIndex, '');
}

async function fetchLocalStandingAsync(statistic: string): Promise<LocalStanding> {
  const standing: LocalStanding = { rank: 0, score: 0, hasScore: false };
  const r = await playFab()!.client<{ Leaderboard?: PlayerLeaderboardEntry[] }>('GetLeaderboardAroundPlayer', {
    StatisticName: statistic, MaxResultsCount: 1, ProfileConstraints: { ShowDisplayName: true },
  });
  if (r.error) return standing;
  const localId = PokerClientIdentity.playFabId;
  for (const e of r.data.Leaderboard ?? []) {
    if (!e || !localId || e.PlayFabId !== localId) continue;
    standing.rank = (e.Position ?? 0) + 1;
    standing.score = e.StatValue ?? 0;
    standing.hasScore = true;
    break;
  }
  return standing;
}

async function fetchProgressionStandingAsync(statistic: string): Promise<LocalStanding> {
  const standing: LocalStanding = { rank: 0, score: 0, hasScore: false };
  const r = await playFab()!.entity<EntityLeaderboard>('Leaderboard/GetLeaderboardAroundEntity', { LeaderboardName: statistic, MaxSurroundingEntries: 0 });
  if (r.error) return standing;
  const board = r.data.Rankings ?? [];
  for (let i = 0; i < board.length; i++) {
    const e = board[i];
    if (!e || !isLocalEntity(e.Entity)) continue;
    standing.rank = (e.Rank ?? 0) > 0 ? e.Rank! : i + 1;
    standing.score = parseScore(e.Scores);
    standing.hasScore = true;
    break;
  }
  return standing;
}

function emptyStatusFor(rows: number, emptyStatus: string, pageIndex: number): string {
  if (rows > 0) return 'Free-play only · not SOL tables';
  if (emptyStatus) return emptyStatus;
  return pageIndex > 0 ? 'No more ranks on this page.' : 'No scores yet — play a free-play hand.';
}

function fromEntityRankings(kind: LeaderboardKind, result: EntityLeaderboard | null, pageIndex: number, emptyStatus: string): LeaderboardSnapshot {
  const rows: LeaderboardEntry[] = [];
  let localRank = 0;
  const board = result?.Rankings ?? [];
  for (let i = 0; i < board.length; i++) {
    const e = board[i];
    if (!e) continue;
    const isLocal = isLocalEntity(e.Entity);
    const rank = (e.Rank ?? 0) > 0 ? e.Rank! : pageIndex * PageSize + i + 1;
    if (isLocal) localRank = rank;
    rows.push({ rank, displayName: e.DisplayName || 'Player', score: parseScore(e.Scores), isLocal });
  }
  const total = result ? result.EntryCount ?? 0 : rows.length;
  const hasMore = total > (pageIndex + 1) * PageSize || rows.length >= PageSize;
  return {
    kind, title: FreePlayLeaderboard.titleFor(kind), status: emptyStatusFor(rows.length, emptyStatus, pageIndex),
    localRank, localScore: FreePlayLeaderboard.localScore(scoreKind(kind)),
    pageIndex, pageSize: PageSize, hasMore: hasMore && rows.length > 0, rows,
  };
}

function fromEntries(kind: LeaderboardKind, board: PlayerLeaderboardEntry[] | undefined, pageIndex: number, emptyStatus: string): LeaderboardSnapshot {
  const rows: LeaderboardEntry[] = [];
  let localRank = 0;
  const localId = PokerClientIdentity.playFabId;
  for (const e of board ?? []) {
    if (!e) continue;
    const isLocal = !!localId && e.PlayFabId === localId;
    const pos = e.Position ?? 0;
    if (isLocal) localRank = pos + 1;
    rows.push({ rank: pos + 1, displayName: e.DisplayName || 'Player', score: e.StatValue ?? 0, isLocal });
  }
  return {
    kind, title: FreePlayLeaderboard.titleFor(kind), status: emptyStatusFor(rows.length, emptyStatus, pageIndex),
    localRank, localScore: FreePlayLeaderboard.localScore(scoreKind(kind)),
    pageIndex, pageSize: PageSize, hasMore: rows.length >= PageSize, rows,
  };
}

function isLocalEntity(entity: { Id?: string } | undefined): boolean {
  if (!entity || !entity.Id) return false;
  const entityId = playFab()?.entityId;
  if (entityId && entity.Id === entityId) return true;
  return entity.Id === PokerClientIdentity.playFabId;
}

function parseScore(scores: string[] | undefined): number {
  if (!scores || scores.length === 0) return 0;
  const s = scores[0]!.trim();
  return /^[+-]?\d+$/.test(s) ? FreePlayLeaderboardMath.clampScore(Number(s)) : 0;
}
