// Postgres: the lobby index, the hand archive and the keeper's log. Migrations run at start-up.
import { Pool } from "pg";
import { config } from "./config";
import { AGENT_MIGRATIONS } from "./agents";
import { SOL_STRATEGY_MIGRATIONS } from "./solStrategies";
import { HOST_FEE_MIGRATIONS } from "./hostFees";

export const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });

const MIGRATIONS: string[] = [
  `create table if not exists tables (
     address text primary key,
     table_id text not null,
     creator text not null,
     status smallint not null,
     max_seats smallint not null,
     seated smallint not null,
     invite_only boolean not null,
     small_blind bigint not null,
     big_blind bigint not null,
     min_buy_in bigint not null,
     max_buy_in bigint not null,
     hand_no bigint not null,
     hand_state smallint not null,
     ledger_seq bigint not null,
     last_commit_ts bigint not null,
     first_seen timestamptz not null default now(),
     updated_at timestamptz not null default now()
   )`,
  `create table if not exists hands (
     table_address text not null references tables(address),
     hand_no bigint not null,
     record jsonb not null,
     verified boolean not null,
     problems jsonb not null,
     log_status text not null default 'pending',
     log_enc bytea,
     log_verified boolean,
     archived_at timestamptz not null default now(),
     primary key (table_address, hand_no)
   )`,
  `create table if not exists keeper_events (
     id bigserial primary key,
     at timestamptz not null default now(),
     table_address text,
     action text not null,
     ok boolean not null,
     detail text
   )`,
  `create index if not exists keeper_events_at on keeper_events (at desc)`,
  // A table is live only while delegated to the rollup. One taken back through the escape hatch
  // leaves a stale "open" copy in the rollup that nobody can play or commit.
  `alter table tables add column if not exists delegated boolean not null default false`,
  // M7 review: commit state per table, record hash, whether the button rule could be checked
  // (the previous hand was archived), and rolled-back hands (a rollback replays hand numbers).
  `alter table tables add column if not exists last_commit_mark text`,
  `alter table hands add column if not exists record_hash text`,
  `alter table hands add column if not exists button_checked boolean`,
  `create table if not exists hands_superseded (like hands)`,
  `alter table hands_superseded add column if not exists superseded_at timestamptz`,
  `create index if not exists keeper_events_table on keeper_events (table_address, action, id desc)`,
  // M9c: "Your tables" on any device (GET /tables?creator=).
  `create index if not exists tables_creator on tables (creator, first_seen desc)`,
  // M12 playtest: the lobby hides tables nothing has happened at for an hour (abandoned test seats kept them open).
  `alter table tables add column if not exists idle_since bigint not null default 0`,
  // Deep review #4/#5: what the keeper pays for at others' request (hosted tables, free tournaments' tables),
  // every attempt including failed ones, so the hourly caps hold across restarts and two instances.
  `create table if not exists keeper_spend (
     id bigserial primary key,
     at timestamptz not null default now(),
     kind text not null,
     who text not null,
     ref text not null,
     ok boolean,
     table_address text,
     detail text
   )`,
  `create index if not exists keeper_spend_kind_at on keeper_spend (kind, at desc)`,
];

// An idle client's error (e.g. the database restarting) must not crash the service.
pool.on("error", (e) => console.error("postgres pool error:", e.message));

export async function migrate() {
  for (const sql of [...MIGRATIONS, ...AGENT_MIGRATIONS, ...SOL_STRATEGY_MIGRATIONS, ...HOST_FEE_MIGRATIONS]) await pool.query(sql);
}

/** Admits one keeper-paid attempt of `kind` for `who` (a wallet or host) if fewer than `perWho` of theirs and
 *  `total` of everyone's were made in the last hour, and records it. The count and the insert run under one
 *  transaction lock, so two instances can't both pass the last free slot. Returns its id, or null at a cap. */
export async function admitSpend(kind: string, who: string, ref: string, perWho: number, total: number): Promise<number | null> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select pg_advisory_xact_lock(424214)");
    const n = (await c.query(
      "select count(*) filter (where who = $2)::int as mine, count(*)::int as everyone from keeper_spend where kind = $1 and at > now() - interval '1 hour'", [kind, who])).rows[0];
    // total <= 0: no cap for everyone (only the per-wallet one).
    if (n.mine >= perWho || (total > 0 && n.everyone >= total)) { await c.query("rollback"); return null; }
    const id = Number((await c.query("insert into keeper_spend (kind, who, ref) values ($1, $2, $3) returning id", [kind, who, ref])).rows[0].id);
    await c.query("commit");
    return id;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally { c.release(); }
}

export async function settleSpend(id: number, ok: boolean, table: string | null, detail = "") {
  await pool.query("update keeper_spend set ok = $2, table_address = $3, detail = $4 where id = $1", [id, ok, table, detail.slice(0, 500)]);
}

export async function event(table: string | null, action: string, ok: boolean, detail = "") {
  await pool.query("insert into keeper_events (table_address, action, ok, detail) values ($1, $2, $3, $4)", [table, action, ok, detail.slice(0, 500)]);
}
