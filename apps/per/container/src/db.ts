// The PER service's data now lives in D1 (apps/per/migrations), reached through the Worker that runs this container:
// each query is an HTTP request to the D1 bridge (an outbound handler in the Worker, so the container holds no
// database credential). `pool.query(sql, params)` keeps the node-postgres shape the service was written against:
// the Postgres-only SQL it uses is translated to SQLite, and results come back with the types the Postgres driver
// returned (bigint columns as strings, booleans, Date timestamps, parsed JSON, Buffer blobs).
import { config } from "./config";

type Row = Record<string, any>;
export type QueryResult = { rows: any[]; rowCount: number };

/** Columns whose Postgres type was bigint (the driver returned strings), boolean, timestamptz, jsonb or bytea. */
const BIGINT = new Set(["small_blind", "big_blind", "min_buy_in", "max_buy_in", "hand_no", "ledger_seq", "last_commit_ts", "until", "id", "buy_in",
  "stack", "cash_out", "last_hand", "session_id", "stack_after", "fee_net_before", "fee_high_water", "creator_fee", "platform_fee", "used",
  "expected", "paid", "landed", "idle_since"]);
const BOOLEAN = new Set(["invite_only", "verified", "log_verified", "button_checked", "delegated", "listed", "done", "ok"]);
const TIMESTAMP = new Set(["first_seen", "updated_at", "archived_at", "at", "started_at", "ended_at", "created_at", "registered_at",
  "landed_changed_at", "last_paid_at", "last_checked_at", "superseded_at", "first"]);
const JSONB = new Set(["record", "problems", "settings", "profile"]);

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Postgres → SQLite for the forms this service uses. Exported for the tests. */
export function toSqlite(sql: string): string {
  return sql
    .replace(/now\(\)\s*-\s*interval\s*'(\d+)\s+(\w+)'/gi, (_m, n, unit) => `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${n} ${unit}')`)
    .replace(/extract\(epoch from now\(\)\)/gi, "unixepoch()")
    .replace(/now\(\)/gi, NOW)
    .replace(/\)::float8?\b/gi, ") * 1.0")
    .replace(/(\w+(?:\.\w+)?)::float8?\b/gi, (_m, e) => `(${e} * 1.0)`)
    .replace(/::(?:int|integer|bigint|smallint|text|numeric)\b/gi, "")
    .replace(/\bgreatest\(/gi, "max(")
    .replace(/\bleast\(/gi, "min(")
    .replace(/(\w+(?:\.\w+)?)->>'(\w+)'/g, (_m, col, key) => `json_extract(${col}, '$.${key}')`)
    .replace(/\$(\d+)/g, "?$1");
}

function encodeParam(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") v = v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { $b: Buffer.from(v).toString("base64") };
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  // The service passes amounts as decimal strings (Postgres coerced them). SQLite compares a text parameter as larger
  // than any number when no column affinity applies (`used + $2 <= $3`), so integers that fit exactly go as numbers;
  // larger ones (u64 ids) stay text, and text columns store either as text.
  if (typeof v === "string" && /^-?\d{1,16}$/.test(v) && Number.isSafeInteger(Number(v))) return Number(v);
  return v;
}

function decodeRow(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) {
    if (v !== null && typeof v === "object" && typeof (v as any).$b === "string") out[k] = Buffer.from((v as any).$b, "base64");
    else if (v === null) out[k] = null;
    else if (BIGINT.has(k)) out[k] = String(v);
    else if (BOOLEAN.has(k)) out[k] = v === 1 || v === true || v === "1";
    else if (TIMESTAMP.has(k) && typeof v === "string") out[k] = new Date(v);
    else if (JSONB.has(k) && typeof v === "string") { try { out[k] = JSON.parse(v); } catch { out[k] = v; } }
    else out[k] = v;
  }
  return out;
}

async function query(sql: string, params: unknown[] = []): Promise<QueryResult> {
  const res = await fetch(config.d1BridgeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql: toSqlite(sql), params: params.map(encodeParam) }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => null)) as { rows?: Row[]; changes?: number; error?: string } | null;
  if (!res.ok || !body || body.error) throw new Error(`d1: ${body?.error ?? `HTTP ${res.status}`}`);
  const rows = (body.rows ?? []).map(decodeRow);
  return { rows, rowCount: rows.length || body.changes || 0 };
}

export const pool = { query };

/** The schema is D1's migrations (apps/per/migrations), applied before deploy; here only a reachability check. */
export async function migrate() {
  await query("select 1 as ok");
}

/** Admits one keeper-paid attempt of `kind` for `who` (a wallet or host) if fewer than `perWho` of theirs and
 *  `total` of everyone's were made in the last hour, and records it, in one statement (SQLite writes are serial, so
 *  two callers can't both pass the last free slot). Returns its id, or null at a cap. total <= 0: no cap for all. */
export async function admitSpend(kind: string, who: string, ref: string, perWho: number, total: number): Promise<number | null> {
  const r = await query(
    `insert into keeper_spend (kind, who, ref)
     select $1, $2, $3
      where (select count(*) from keeper_spend where kind = $1 and who = $2 and at > now() - interval '1 hour') < $4
        and ($5 <= 0 or (select count(*) from keeper_spend where kind = $1 and at > now() - interval '1 hour') < $5)
     returning id`, [kind, who, ref, perWho, total]);
  return r.rows.length ? Number(r.rows[0].id) : null;
}

export async function settleSpend(id: number, ok: boolean, table: string | null, detail = "") {
  await query("update keeper_spend set ok = $2, table_address = $3, detail = $4 where id = $1", [id, ok, table, detail.slice(0, 500)]);
}

export async function event(table: string | null, action: string, ok: boolean, detail = "") {
  await query("insert into keeper_events (table_address, action, ok, detail) values ($1, $2, $3, $4)", [table, action, ok, detail.slice(0, 500)]);
}

/** Takes or renews the lease `name` for `holder` for `ms`; true while this holder has it. */
export async function holdLease(name: string, holder: string, ms: number): Promise<boolean> {
  const now = Date.now();
  const r = await query(
    `insert into leases (name, holder, expires_at) values ($1, $2, $3)
     on conflict (name) do update set holder = $2, expires_at = $3 where leases.holder = $2 or leases.expires_at < $4
     returning holder`, [name, holder, now + ms, now]);
  return r.rows.length > 0 && r.rows[0].holder === holder;
}

