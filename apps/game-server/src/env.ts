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
  /** Spawns, overflow lookups and Agent starts per address. Optional so tests can leave it out. */
  HTTP_LIMITER?: RateLimit;
  /** Cloudflare Realtime TURN key (id + secret): short-lived relay credentials for table voice (/v1/voice/ice). */
  TURN_KEY_ID?: string;
  TURN_KEY_TOKEN?: string;
  /** Operator alerts (src/alerts.ts): Email Service binding, sender and the owner's inbox (a secret). Production only. */
  ALERT_EMAIL?: SendEmail;
  ALERT_FROM?: string;
  ALERT_TO?: string;
}
