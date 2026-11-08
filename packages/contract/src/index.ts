/**
 * The Nomad Poker API contract (v1), shared by the web app and the API Worker.
 *
 * Auth: every sign-in route returns a `SessionResponse`. The client keeps `token` and sends it as
 * `Authorization: Bearer <token>`. Tokens are opaque and stored hashed on the server; they last 30 days.
 * Sending a guest's token to a wallet / Google / email sign-in links that identity to the guest (keeping its
 * balance) unless the identity already belongs to another player, in which case you are signed in to that player.
 *
 * Errors: non-2xx responses carry `ApiErrorBody`.
 */

export const API_PREFIX = '/v1';

export const Routes = {
  health: '/v1/health',
  guest: '/v1/auth/guest',
  walletChallenge: '/v1/auth/wallet/challenge',
  walletVerify: '/v1/auth/wallet/verify',
  google: '/v1/auth/google',
  emailStart: '/v1/auth/email/start',
  emailVerify: '/v1/auth/email/verify',
  signOut: '/v1/auth/sign-out',
  me: '/v1/me',
  ledger: '/v1/ledger',
} as const;

// ---- Players and identities ---------------------------------------------------------------------

export type PlayerKind = 'guest' | 'registered';
export type IdentityProvider = 'wallet' | 'google' | 'email';

export interface PlayerProfile {
  id: string;
  displayName: string;
  kind: PlayerKind;
  /** ISO 8601. */
  createdAt: string;
  /** Public Friend ID (16 hex characters; show with FriendCode.format). */
  friendCode: string;
  /** AvatarCatalog value, 0 = none. */
  avatar: number;
}

export interface LinkedIdentity {
  provider: IdentityProvider;
  /** Wallet address, Google account email (or id when hidden), or email address. */
  label: string;
  linkedAt: string;
}

// ---- Money --------------------------------------------------------------------------------------

/** Play-money currencies kept in the ledger. SOL never touches this ledger (devnet escrow only). */
export type Currency = 'coins' | 'gems' | 'xp' | 'streak_tokens';
export const CURRENCIES: readonly Currency[] = ['coins', 'gems', 'xp', 'streak_tokens'];

export type Balances = Record<Currency, number>;

/** What a new player starts with (LocalVirtualWallet.DefaultStartingCoins). */
export const STARTER_GRANT: Readonly<Partial<Balances>> = { coins: 10_000 };

export interface LedgerEntry {
  id: number;
  currency: Currency;
  /** Positive = credit, negative = debit. Whole units. */
  delta: number;
  /** Machine-readable cause: 'starter', 'table:buy_in', 'table:cash_out', 'reward:login', ... */
  reason: string;
  /** Optional reference (table id, hand id, reward id). */
  ref: string | null;
  createdAt: string;
}

// ---- Requests and responses ---------------------------------------------------------------------

export interface SessionResponse {
  token: string;
  expiresAt: string;
  player: PlayerProfile;
  /** True when this call created the player. */
  created: boolean;
  /** True when this call linked a new identity to the player who sent the request. */
  linked: boolean;
}

export interface GuestRequest {
  displayName?: string;
}

export interface WalletChallengeRequest {
  /** Base58 Solana public key. */
  address: string;
}

export interface WalletChallengeResponse {
  nonce: string;
  /** The exact text the wallet must sign (Sign In With Solana style). */
  message: string;
  expiresAt: string;
}

export interface WalletVerifyRequest {
  address: string;
  nonce: string;
  /** Base58 ed25519 signature of the UTF-8 `message` from the challenge. */
  signature: string;
}

export interface GoogleSignInRequest {
  /** A Google ID token (JWT) from Google Identity Services / the native SDK. */
  idToken: string;
}

export interface EmailStartRequest {
  email: string;
  /** Where the link should land: an allowed app origin. Defaults to the request's Origin. */
  returnTo?: string;
}

export interface EmailStartResponse {
  sent: boolean;
  /** Staging only (no mail provider yet): the sign-in link, so tests and testers can follow it. */
  devLink?: string;
}

export interface EmailVerifyRequest {
  token: string;
}

export interface MeResponse {
  player: PlayerProfile;
  identities: LinkedIdentity[];
  balances: Balances;
}

export interface LedgerResponse {
  balances: Balances;
  /** Newest first. */
  entries: LedgerEntry[];
  /** Pass as `?before=` to get the next (older) page; absent on the last page. */
  nextBefore?: number;
}

export interface HealthResponse {
  ok: true;
  stage: string;
  version: string;
}

// ---- Errors -------------------------------------------------------------------------------------

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'expired'
  | 'insufficient_funds'
  | 'not_configured'
  | 'rate_limited'
  | 'internal';

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string };
}

/** The wallet sign-in message. The server builds it; exported so tests and clients can show / check it. */
export function walletSignInMessage(p: {
  domain: string;
  address: string;
  uri: string;
  chainId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}): string {
  return [
    `${p.domain} wants you to sign in with your Solana account:`,
    p.address,
    '',
    'Sign in to Nomad Poker.',
    '',
    `URI: ${p.uri}`,
    'Version: 1',
    `Chain ID: ${p.chainId}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt}`,
    `Expiration Time: ${p.expiresAt}`,
  ].join('\n');
}

// ---- Progress and rewards (Phase 3: the server decides every reward) -----------------------------

export const ProgressRoutes = {
  progress: '/v1/progress',
  spin: '/v1/rewards/spin',
  login: '/v1/rewards/login',
  missionClaim: '/v1/missions/claim',
} as const;

export interface MissionSlot {
  id: string;
  progress: number;
  claimed: boolean;
}

/** Everything the retention screens paint, as the server sees it. */
export interface ProgressSnapshot {
  balances: Balances;
  /** Cosmetics owned (level rewards). */
  items: string[];
  /** UTC day number (days since 1970-01-01) the server evaluated this at. */
  today: number;
  level: number;
  /** Highest level whose rewards have been paid. */
  rewardedLevel: number;
  spin: { canSpin: boolean; lastSpinDay: number; lastSpinCoins: number };
  login: {
    lastLoginDay: number;
    streakDay: number;
    /** The claim available now (LoginStreakMath.preview). */
    canClaim: boolean;
    day: number;
    tokensAfter: number;
    tokenConsumed: boolean;
    reset: boolean;
    error: string;
  };
  missions: { dayNumber: number; weekNumber: number; slots: MissionSlot[] };
}

export interface SpinResponse {
  awarded: boolean;
  coins: number;
  label: string;
  error: string;
  progress: ProgressSnapshot;
}

export interface LoginClaimResponse {
  claimed: boolean;
  day: number;
  tokenConsumed: boolean;
  reset: boolean;
  error: string;
  progress: ProgressSnapshot;
}

export interface MissionClaimRequest {
  id: string;
}

export interface MissionClaimResponse {
  ok: boolean;
  message: string;
  progress: ProgressSnapshot;
}

// ---- Social, profile and leaderboards (Phase 4: was friends.js CloudScript on PlayFab) -------------

export const SocialRoutes = {
  /** Friends, waiting invites, and presence. Also counts as "online" for this player. */
  social: '/v1/social',
  request: '/v1/friends/request',
  accept: '/v1/friends/accept',
  remove: '/v1/friends/remove',
  invite: '/v1/invites/send',
  dismiss: '/v1/invites/dismiss',
  profile: '/v1/me/profile',
  /** + `/<kind>?page=` (LeaderboardKind number). */
  leaderboards: '/v1/leaderboards',
} as const;

/**
 * Tournaments (Phase 5). Every answer about one tournament is `{ serverNowUnix, tournament }` (TournamentInfo in the
 * web client); lists are `{ serverNowUnix, tournaments }` and mine is `{ serverNowUnix, entries, hosted }`.
 * The tournament itself runs on the game server (a TRN… room), which also pays the prizes.
 */
export const TournamentRoutes = {
  /** GET `?filter=upcoming|running|finished&limit=` (public tournaments); POST creates one. */
  list: '/v1/tournaments',
  /** GET `/v1/tournaments/code/<code>`: a tournament by its 6-letter join code. */
  byCode: '/v1/tournaments/code',
  /** GET `/v1/tournaments/<id>`; POST `/v1/tournaments/<id>/<action>`: edit | raise-prize | cancel | remove | register | unregister. */
  one: '/v1/tournaments',
  /** GET: the signed-in player's entries and hosted tournaments. */
  mine: '/v1/me/tournaments',
} as const;

/**
 * The copy-strategy marketplace, My Twin and the coach (Phase 5). Agent sessions themselves are on the game server
 * (`/v1/agents/*`), which seats them at its tables.
 */
export const StrategyRoutes = {
  /** GET `?sort=top|styles|new|popular&limit=&style=`; POST publishes `{ name, description?, fromTwin?, profile? }`. */
  strategies: '/v1/strategies',
  /** GET: the creator's dashboard (their strategies, earned and paid). */
  mine: '/v1/strategies/mine',
  /** GET `/v1/strategies/<id>`; POST `/v1/strategies/<id>/unlist`. */
  one: '/v1/strategies',
  twin: '/v1/style/twin',
  coach: '/v1/style/coach',
} as const;

export type FriendRelationName = 'friend' | 'pending_out' | 'pending_in';

/** The friends.js error codes, kept so the client's wording carries over. */
export type SocialErrorCode =
  | 'invalid_id'
  | 'self'
  | 'not_found'
  | 'not_found_name'
  | 'ambiguous_name'
  | 'already_friends'
  | 'already_requested'
  | 'no_request'
  | 'not_friends'
  | 'invalid_session';

export interface FriendInfo {
  /** Their Friend ID (16 hex characters). */
  id: string;
  name: string;
  relation: FriendRelationName;
  /** Last activity, epoch ms. */
  lastSeen: number;
  avatar: number;
  /** Active in the last two minutes. */
  online: boolean;
  /** The table (session) they are seated at; friends only. */
  table: string | null;
}

export interface TableInviteInfo {
  fromId: string;
  fromName: string;
  session: string;
  money: boolean;
  /** Server time, unix seconds. */
  sentAtUnix: number;
}

export interface SocialResponse {
  friendCode: string;
  friends: FriendInfo[];
  invites: TableInviteInfo[];
  /** Server time, unix seconds (invites are aged on this clock). */
  serverTime: number;
}

export interface SocialActionResult {
  ok: boolean;
  relation?: FriendRelationName;
  error?: SocialErrorCode;
}

export interface ProfileUpdateRequest {
  displayName?: string;
  avatar?: number;
}

export interface LeaderboardRowInfo {
  rank: number;
  displayName: string;
  score: number;
  isLocal: boolean;
}

export interface LeaderboardPage {
  kind: number;
  /** Period the board covers: YYYYWW for weekly boards, YYYYMM for the season, 0 for all time. */
  period: number;
  localRank: number;
  localScore: number;
  pageIndex: number;
  pageSize: number;
  hasMore: boolean;
  rows: LeaderboardRowInfo[];
}
