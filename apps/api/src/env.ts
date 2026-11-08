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

  /** 'development' | 'staging' | 'production'. */
  STAGE: string;
  /** Comma-separated origins allowed to call the API from a browser (CORS) and to receive email links. */
  ALLOWED_ORIGINS: string;
  /** Shown in the wallet sign-in message; SOL tables are devnet-only for now. */
  WALLET_CHAIN_ID: string;
  /** Comma-separated Google OAuth client ids (web, Android, iOS). Unset: Google sign-in answers not_configured. */
  GOOGLE_CLIENT_IDS?: string;
  /** '1' on staging only: email sign-in returns the link instead of mailing it (no mail provider yet). */
  EMAIL_DEV_ECHO?: string;
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
  Variables: { player: PlayerRow; tokenHash: string };
};
