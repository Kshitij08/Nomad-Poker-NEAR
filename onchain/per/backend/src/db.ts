// Postgres: the lobby index, the hand archive and the keeper's log. Migrations run at start-up.
import { Pool } from "pg";
import { config } from "./config";

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
];

export async function migrate() {
  for (const sql of MIGRATIONS) await pool.query(sql);
}

export async function event(table: string | null, action: string, ok: boolean, detail = "") {
  await pool.query("insert into keeper_events (table_address, action, ok, detail) values ($1, $2, $3, $4)", [table, action, ok, detail.slice(0, 500)]);
}
