/** The backend's tournament record as the game reads it. Port of TournamentApiClient.TournamentInfo and its helpers. */
export interface TournamentInfo {
  id: string;
  name: string;
  hostPlayFabId: string;
  hostName: string;
  entryFee: number;
  hostPrize: number;
  prizePool: number;
  firstPrize: number;
  secondPrize: number;
  /** "public" | "private" */
  visibility: string;
  joinCode: string;
  startsAtUnix: number;
  /** "turbo" | "regular" | "slow" */
  speed: string;
  maxPlayers: number;
  players: number;
  /** "cancelled" | "single" | "two_tables" | "four_tables" */
  format: string;
  /** registering | funding | locked | running | finished | paid | cancelled | aborted | funding_failed */
  status: string;
  cancelReason: string;
  /** registered | paying | playing | finished | unregistered | cancelled | rejected | removed | "" */
  myStatus: string;
  myPlace: number;
  myPrize: number;
  serverReady: boolean;
  sessionName: string;
}

export interface ListResult {
  serverNowUnix: number;
  tournaments: TournamentInfo[];
}

export interface MineResult {
  serverNowUnix: number;
  entries: TournamentInfo[];
  hosted: TournamentInfo[];
}

export interface CreateRequest {
  name: string;
  hostPrize: number;
  entryFee: number;
  maxPlayers: number;
  speed: string;
  visibility: string;
  startsAtUnix: number;
}

export const defaultCreateRequest = (): CreateRequest => ({
  name: '', hostPrize: 0, entryFee: 0, maxPlayers: 30, speed: 'regular', visibility: 'public', startsAtUnix: 0,
});

/** Reply<T>: every call resolves; failures carry words a player can read. */
export interface Reply<T> {
  value: T | null;
  error: string | null;
  code: string | null;
}
export const ok = <T>(value: T): Reply<T> => ({ value, error: null, code: null });
export const fail = <T>(error: string, code: string | null = null): Reply<T> => ({ value: null, error, code });
export const isOk = <T>(r: Reply<T>): r is Reply<T> & { value: T } => r.error === null;

export const DEMO_PREFIX = 'demo-';
/** TournamentDemoData.Me: "you" as the host of a demo tournament. */
export const DEMO_ME = 'demo-you';

export const isDemo = (t: TournamentInfo | null | undefined): boolean => !!t && !!t.id && t.id.startsWith(DEMO_PREFIX);
export const isRegistered = (t: TournamentInfo): boolean => t.myStatus === 'registered' || t.myStatus === 'paying' || t.myStatus === 'playing';
export const isOpen = (t: TournamentInfo): boolean => t.status === 'registering' || t.status === 'funding';
export const isLive = (t: TournamentInfo): boolean => t.status === 'registering' || t.status === 'locked' || t.status === 'running';
/** IsMine: hosted by the current player (or by "you" in a demo tournament). */
export const isMine = (t: TournamentInfo, currentPlayerId: string): boolean =>
  !!t.hostPlayFabId && (t.hostPlayFabId === currentPlayerId || (isDemo(t) && t.hostPlayFabId === DEMO_ME));
