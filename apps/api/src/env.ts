import type { PlayerRow } from '@nomad/db/types';

export type { PlayerRow };

/** The Worker's bindings (declared in cloudflare.config.ts). */
export interface Env {
  /** Players, identities, sessions, challenges, ledger (migrations/). */
  DB: D1Database;
  /** Hand histories (written from Phase 2). */
  HANDS: R2Bucket;
  /** Per-IP limit on sign-in routes. Optional so local tests can leave it out. */
  AUTH_LIMITER?: RateLimit;
  /** Per-session limit on writes outside sign-in. Optional so local tests can leave it out. */
  WRITE_LIMITER?: RateLimit;

  /** 'development' | 'staging' | 'production'. */
  STAGE: string;
  /** Comma-separated origins allowed to call the API from a browser (CORS) and to receive email links. */
  ALLOWED_ORIGINS: string;
  /**
   * NEAR JSON-RPC the API checks sign-in keys against (testnet in this fork). Unset: NEAR sign-in answers
   * not_configured.
   */
  NEAR_RPC_URL?: string;
  /**
   * The escrow contract holding NEAR tournament stakes (e.g. nomad-escrow.testnet); the API reads it over NEAR_RPC_URL to
   * check a tournament was created there and who registered. Unset (or no NEAR_RPC_URL): NEAR tournaments are off.
   */
  NEAR_ESCROW?: string;
  /** The table / vault contract (table.nomad-poker.testnet): the relayer also calls it for app-made accounts. */
  NEAR_TABLE_CONTRACT?: string;
  /**
   * NEAR accounts made for players and gasless moves (src/nearAccounts.ts): the sponsor account that creates
   * `<id>.<sponsor>` accounts and pays the relayed transactions, and its key ("ed25519:<base58>", a secret). Either
   * unset: those routes answer not_configured and players connect a wallet.
   */
  NEAR_SPONSOR_ID?: string;
  NEAR_SPONSOR_KEY?: string;
  /** yoctoNEAR a new account gets (default 0.1 NEAR, never more than 0.5). */
  NEAR_NEW_ACCOUNT_YOCTO?: string;
  /** New accounts a day across all players (default 50). */
  NEAR_NEW_ACCOUNTS_PER_DAY?: string;
  /** Comma-separated Google OAuth client ids (web, Android, iOS). Unset: Google sign-in answers not_configured. */
  GOOGLE_CLIENT_IDS?: string;
  /** '1' on staging and dev: email sign-in returns the link instead of mailing it. */
  EMAIL_DEV_ECHO?: string;
  /** Cloudflare Email Service (send_email binding): mails the sign-in links. Unset: email sign-in is not_configured. */
  EMAIL?: SendEmail;
  /** The sender for those mails, e.g. "Nomad Poker <no-reply@nomadpoker.fun>" (must be on an onboarded domain). */
  EMAIL_FROM?: string;
  /** Server secret the daily spin's roll is derived from (HMAC of player and day). */
  SPIN_SECRET?: string;
  /** Earliest a new tournament may start, in seconds (default 600; staging shortens it for test runs). */
  TOURNAMENT_MIN_LEAD_SECONDS?: string;
  /** What a market strategy needs before others may copy it (defaults: 2000 hands, 7 days). */
  LISTING_MIN_HANDS?: string;
  LISTING_MIN_DAYS?: string;
  /** Optional: the coach adds a short note written by a private model on NEAR AI Cloud. Unset: the computed report only. */
  NEAR_AI_API_KEY?: string;
  /** The NEAR AI model for the coach note (default Qwen/Qwen3.6-35B-A3B-FP8, a private TEE model). */
  COACH_MODEL?: string;
  /**
   * NEAR AI Agent Market (agentMarket.ts): the `webhook_secret` set on the listed agent (HMAC of its hire callbacks)
   * and the agent's `aat_` token it delivers results with. Unset secret: the webhook answers 503.
   */
  AGENT_MARKET_WEBHOOK_SECRET?: string;
  AGENT_MARKET_TOKEN?: string;
  /** Defaults: https://market.near.ai, table.nomad-poker.testnet, https://nomad-poker-near.vercel.app. */
  AGENT_MARKET_API?: string;
  APP_URL?: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { player: PlayerRow; tokenHash: string; adminRole?: 'support' | 'admin' };
};
