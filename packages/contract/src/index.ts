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
