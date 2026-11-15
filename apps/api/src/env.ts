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
  /** Optional: the coach adds a short note written by Claude. Unset: the computed report only. */
  ANTHROPIC_API_KEY?: string;
  COACH_MODEL?: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { player: PlayerRow; tokenHash: string; adminRole?: 'support' | 'admin' };
};
