// Settings from the environment. Secrets (the keeper and auditor keys, the archive key, the admin
// token) exist only as Railway variables; nothing here has a default for them.
import { Keypair } from "@solana/web3.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

/** A Solana secret key given as a JSON byte array (the format of a solana-keygen file). */
function keypair(name: string): Keypair {
  try { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(required(name)))); }
  catch { throw new Error(`${name} is not a valid secret key (expected a JSON byte array)`); }
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required("DATABASE_URL"),
  l1Url: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  teeUrl: process.env.TEE_URL ?? "https://devnet-tee.magicblock.app",
  /** Signs `tick`, `commit_table` and `open_log` only. It holds no game authority and no funds. */
  keeper: keypair("KEEPER_SECRET_KEY"),
  /** The config's auditor: reads finished hands' action logs, which are archived encrypted. */
  auditor: keypair("AUDITOR_SECRET_KEY"),
  /** 32 bytes, hex: AES-256-GCM key for archived action logs (they hold the bets). */
  archiveKey: Buffer.from(required("ARCHIVE_KEY_HEX"), "hex"),
  /** Bearer token for the audit routes. */
  adminToken: required("ADMIN_TOKEN"),
  keeperIntervalMs: Number(process.env.KEEPER_INTERVAL_MS ?? 2_000),
  discoverEveryMs: Number(process.env.DISCOVER_EVERY_MS ?? 30_000),
  /** Matches the program's COMMIT_EVERY_SECS: an outsider may commit a table once per 15 minutes. */
  commitEverySecs: Number(process.env.COMMIT_EVERY_SECS ?? 900),
  keeperEnabled: process.env.KEEPER_ENABLED !== "false",
  /** M9b: close tables left empty and idle for the config's escape delay. */
  closeAbandoned: process.env.CLOSE_ABANDONED !== "false",
  /** M10 feature flag: the game shows private tables only while this is on (`PRIVATE_TABLES=false` hides them). */
  privateTables: process.env.PRIVATE_TABLES !== "false",
};

if (config.archiveKey.length !== 32) throw new Error("ARCHIVE_KEY_HEX must be 32 bytes of hex");
