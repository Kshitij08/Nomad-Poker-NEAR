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
  nearChallenge: '/v1/auth/near/challenge',
  nearVerify: '/v1/auth/near/verify',
  google: '/v1/auth/google',
  emailStart: '/v1/auth/email/start',
  emailVerify: '/v1/auth/email/verify',
  signOut: '/v1/auth/sign-out',
  me: '/v1/me',
  ledger: '/v1/ledger',
} as const;

// ---- Players and identities ---------------------------------------------------------------------

export type PlayerKind = 'guest' | 'registered';
export type IdentityProvider = 'wallet' | 'google' | 'email' | 'near';

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
  /** Their own uploaded picture's key (SocialRoutes.pictures + `/<key>.webp`), or null for the avatar. */
  picture: string | null;
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

/** NEAR sign-in (NEP-413 signed message): ask for a challenge for a NEAR account. */
export interface NearChallengeRequest {
  /** A NEAR account id, e.g. alice.testnet. */
  accountId: string;
}

/** What the wallet signs with NEP-413 `signMessage`: the message, the recipient and the nonce, exactly as given. */
export interface NearChallengeResponse {
  message: string;
  recipient: string;
  /** 32 random bytes, base64. Also identifies the challenge. */
  nonce: string;
  expiresAt: string;
}

export interface NearVerifyRequest {
  accountId: string;
  /** The key that signed, "ed25519:<base58>". It must be a full-access key of the account. */
  publicKey: string;
  /** The NEP-413 signature, base64 (64 bytes). */
  signature: string;
  nonce: string;
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
  | 'internal'
  // NEAR tournaments: sign in with NEAR first; the escrow doesn't have the tournament (or it differs); the wallet
  // hasn't paid the entry yet; the wallet hasn't left yet.
  | 'near_required'
  | 'escrow_missing'
  | 'escrow_mismatch'
  | 'escrow_unpaid'
  | 'escrow_registered';

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
  /** POST (raw image body, ≤ 200 KB webp / png / jpeg) sets your picture; DELETE removes it. */
  picture: '/v1/me/picture',
  /** + `/<key>.webp`: a player's uploaded picture (public, cached forever: a new upload is a new key). */
  pictures: '/v1/pictures',
  /** `?q=` (2+ characters): players whose display name starts with it, for Add friend. */
  search: '/v1/players/search',
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
  /** GET `/v1/tournaments/<id>`; POST `/v1/tournaments/<id>/<action>`: edit | raise-prize | cancel | remove | register | unregister | confirm-escrow (NEAR). */
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

/**
 * Support tools (Phase 7). The caller's session must belong to a player listed in admin_users (an operator adds them in
 * D1). `support` may look up, read and ban; `admin` may also adjust balances. Every action lands in the audit log.
 */
export const AdminRoutes = {
  /** GET — the signed-in admin: `{ player_id, role }` (404 for anyone else, like every admin route). */
  me: '/v1/admin/me',
  /** GET `?q=` — players by internal id, Friend ID or name prefix. */
  players: '/v1/admin/players',
  /** GET `/v1/admin/players/<id>`; POST `/v1/admin/players/<id>/adjust` `{ currency, delta, reason, requestId }`, `/ban` `{ reason }`, `/unban`. */
  player: '/v1/admin/players',
  /** GET `?before=&limit=` — every admin action, newest first. */
  audit: '/v1/admin/audit',
  /** GET `?since=<ms>` — the ledger reconciliation report (every money invariant; `ok` when all hold). */
  reconcile: '/v1/admin/reconcile',
  /** GET `?since=<ms>` — integrity leads: chip dumping pairs, marathon accounts, robotic timing, win-rate outliers. */
  integrity: '/v1/admin/integrity',
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
  /** Their uploaded picture's key, or null. */
  picture?: string | null;
}

/** One Add-friend suggestion (GET SocialRoutes.search). */
export interface PlayerSearchResult {
  /** Their Friend ID. */
  id: string;
  name: string;
  avatar: number;
  /** Your relation to them, null when none. */
  relation: FriendRelationName | null;
  online: boolean;
  picture?: string | null;
}

export interface PlayerSearchResponse {
  players: PlayerSearchResult[];
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
  /** Agents board: the Agent's owner and the hands it played this week. */
  ownerName?: string;
  hands?: number;
  /** The player's (or the Agent owner's) uploaded picture key. */
  picture?: string | null;
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

// ---- Shop (Phase 3) -------------------------------------------------------------------------------

/**
 * The shop. The server owns prices and effects; a client only names an item. Coins purchases debit the ledger;
 * SOL purchases (devnet) quote an intent the player pays with a transfer carrying the intent id as its memo, which
 * the server checks on chain before applying the item.
 */
export const ShopRoutes = {
  /** GET — the catalogue, what the caller owns and their running boost. */
  catalog: '/v1/shop',
  /** POST `{ itemId, requestId }` — buy with Coins. Retrying the same requestId changes nothing. */
  buy: '/v1/shop/buy',
  /** POST `{ itemId }` — quote a SOL purchase (devnet): amount, treasury, memo. */
  solIntent: '/v1/shop/sol/intent',
  /** POST `{ intentId, signature }` — the transfer landed: check it on chain and apply the item. */
  solConfirm: '/v1/shop/sol/confirm',
} as const;

export type ShopCategoryName = 'xp' | 'skins' | 'coins';

/** What an item does. */
export type ShopEffect =
  | { kind: 'xp'; amount: number }
  /** XP up to the start of the next level. */
  | { kind: 'level_up' }
  /** 2× XP from hands for this many hours (stacks: extends a running boost). */
  | { kind: 'xp_boost'; hours: number }
  /** A card back from one of the room themes, worn at every table (theme id, e.g. 'Neon_City'). */
  | { kind: 'card_back'; theme: string }
  /** Coins (chips) credited to the ledger. Sold for devnet SOL in On-chain mode only. */
  | { kind: 'coins'; amount: number };

export interface ShopItemInfo {
  id: string;
  category: ShopCategoryName;
  name: string;
  blurb: string;
  /** Coins price, or null when not sold for Coins. */
  priceCoins: number | null;
  /** Devnet SOL price in lamports, or null when not sold for SOL. */
  priceLamports: number | null;
  effect: ShopEffect;
  /** One-time items (card backs) can be bought once; the rest any number of times. */
  oneTime: boolean;
  ribbon?: string;
}

export interface ShopCatalogResponse {
  items: ShopItemInfo[];
  /** Item ids the caller owns (one-time items). */
  owned: string[];
  /** When the caller's 2× XP boost ends (ISO), or null. */
  xpBoostUntil: string | null;
  /** Whether SOL purchases are open on this server (devnet RPC and treasury configured). */
  solEnabled: boolean;
}

export interface ShopBuyRequest {
  itemId: string;
  /** Client-made id for this purchase; a retry with the same id is a no-op. */
  requestId: string;
}

export interface ShopBuyResponse {
  itemId: string;
  balances: Balances;
  owned: string[];
  xpBoostUntil: string | null;
  /** Levels paid by an XP item (level rewards are paid as XP crosses them). */
  levelsPaid: number[];
}

export interface ShopSolIntentRequest {
  itemId: string;
}

export interface ShopSolIntentResponse {
  intentId: string;
  lamports: number;
  /** Devnet address to pay. */
  treasury: string;
  /** The memo the transfer must carry (the intent id). */
  memo: string;
  expiresAt: string;
}

export interface ShopSolConfirmRequest {
  intentId: string;
  signature: string;
}

const LAMPORTS_PER_SOL_ = 1_000_000_000;
const sol = (n: number) => Math.round(n * LAMPORTS_PER_SOL_);

const deck = (theme: string, name: string, coins: number, solPrice: number, ribbon?: string): ShopItemInfo => ({
  id: `deck:${theme}`,
  category: 'skins',
  name,
  blurb: 'Card back · worn at every table',
  priceCoins: coins,
  priceLamports: sol(solPrice),
  effect: { kind: 'card_back', theme },
  oneTime: true,
  ...(ribbon ? { ribbon } : {}),
});

const coinPack = (id: string, amount: number, solPrice: number, ribbon?: string): ShopItemInfo => ({
  id,
  category: 'coins',
  name: `${amount.toLocaleString('en-US')} Coins`,
  blurb: 'Coins added to your balance',
  priceCoins: null,
  priceLamports: sol(solPrice),
  effect: { kind: 'coins', amount },
  oneTime: false,
  ...(ribbon ? { ribbon } : {}),
});

/**
 * The shop catalogue (prices and effects). The API sells from this list; the web shows it (the server's copy when
 * online). Theme ids are the room themes (apps/web src/theming THEMES). Room themes themselves are not sold.
 */
export const SHOP_ITEMS: readonly ShopItemInfo[] = [
  { id: 'xp-boost-1h', category: 'xp', name: 'XP boost · 1 h', blurb: '2× XP from every hand for 1 hour', priceCoins: 2_000, priceLamports: sol(0.002), effect: { kind: 'xp_boost', hours: 1 }, oneTime: false },
  { id: 'xp-boost-24h', category: 'xp', name: 'XP boost · 24 h', blurb: '2× XP from every hand for 24 hours', priceCoins: 12_000, priceLamports: sol(0.01), effect: { kind: 'xp_boost', hours: 24 }, oneTime: false, ribbon: 'POPULAR' },
  { id: 'xp-pack', category: 'xp', name: 'XP pack', blurb: '+5,000 XP now', priceCoins: 8_000, priceLamports: sol(0.006), effect: { kind: 'xp', amount: 5_000 }, oneTime: false },
  { id: 'xp-level', category: 'xp', name: 'Level up', blurb: 'Jump to the start of your next level', priceCoins: 25_000, priceLamports: sol(0.02), effect: { kind: 'level_up' }, oneTime: false },
  deck('Default', 'Solana deck', 8_000, 0.006, 'HOT'),
  deck('Neon_City', 'Neon City deck', 10_000, 0.008, 'NEW'),
  deck('Forest', 'Forest deck', 6_000, 0.004),
  deck('Desert', 'Desert deck', 6_000, 0.004),
  deck('Town', 'Town deck', 6_000, 0.004),
  // Coins (chip) packs: SOL only (On-chain mode, devnet). Demo mode shows real-money packs as "Coming soon".
  coinPack('coins-5k', 5_000, 0.005),
  coinPack('coins-25k', 25_000, 0.02, 'HOT'),
  coinPack('coins-60k', 60_000, 0.04),
  coinPack('coins-150k', 150_000, 0.075, 'BEST VALUE'),
];

