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
}

export type AppEnv = {
  Bindings: Env;
  Variables: { player: PlayerRow; tokenHash: string };
};
