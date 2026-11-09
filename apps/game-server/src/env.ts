import type { TableRoom } from './tableRoom';

/** The game server's bindings (cloudflare.config.ts). */
export interface Env {
  /** The shared Nomad database: sessions, ledger, seat locks, table sessions. */
  DB: D1Database;
  /** Hand histories. */
  HANDS: R2Bucket;
  /** One Durable Object per table, named by session. */
  TABLES: DurableObjectNamespace<TableRoom>;

  STAGE: string;
  /** Comma-separated web origins allowed to open table sockets and call the HTTP routes. */
  ALLOWED_ORIGINS: string;
  /** '1': also accept sockets with no Origin header (headless test clients). Staging only. */
  ALLOW_NO_ORIGIN?: string;
  /** '1': `qa-…` rooms exist (test harness tables). Staging only. */
  QA_ROOMS?: string;
  /** Time scale for `qa-…` rooms (e.g. '20': hands run 20× faster). */
  QA_ROOM_SPEED?: string;
  /** Bearer token for POST /v1/admin/drain (a secret). */
  DRAIN_TOKEN?: string;
  /** '1': SOL tables (`poker-money…`) open on the escrow program. Needs ESCROW_AUTHORITY_SECRET. */
  MONEY_TABLES?: string;
  /** The game server's devnet settlement key (base58 64-byte secret; a secret, from .secrets.<stage>.json). */
  ESCROW_AUTHORITY_SECRET?: string;
  /** Devnet JSON-RPC for the escrow (a secret; default https://api.devnet.solana.com, which refuses Workers). Mainnet is refused. */
  SOLANA_RPC_URL?: string;
  /** Spawns, overflow lookups and Agent starts per address. Optional so tests can leave it out. */
  HTTP_LIMITER?: RateLimit;
}
