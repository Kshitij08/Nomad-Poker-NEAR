-- The PER service's data (lobby index, hand archive, keeper log, SOL Agents and strategies, payouts, host credits),
-- ported from the Railway service's Postgres migrations (Poker/per/backend) to SQLite for D1, in their final shape.
-- Timestamps are ISO 8601 text (UTC, milliseconds), so they compare in order as text. Booleans are 0/1.
-- The container's query shim (container/src/db.ts) converts types back to what the Postgres driver returned.

CREATE TABLE tables (
  address          TEXT    PRIMARY KEY,
  table_id         TEXT    NOT NULL,
  creator          TEXT    NOT NULL,
  status           INTEGER NOT NULL,
  max_seats        INTEGER NOT NULL,
  seated           INTEGER NOT NULL,
  invite_only      INTEGER NOT NULL,
  small_blind      INTEGER NOT NULL,
  big_blind        INTEGER NOT NULL,
  min_buy_in       INTEGER NOT NULL,
  max_buy_in       INTEGER NOT NULL,
  hand_no          INTEGER NOT NULL,
  hand_state       INTEGER NOT NULL,
  ledger_seq       INTEGER NOT NULL,
  last_commit_ts   INTEGER NOT NULL,
  first_seen       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  delegated        INTEGER NOT NULL DEFAULT 0,
  last_commit_mark TEXT,
  idle_since       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX tables_creator ON tables (creator, first_seen DESC);
CREATE INDEX tables_lobby ON tables (status, delegated, updated_at DESC);

CREATE TABLE hands (
  table_address  TEXT    NOT NULL REFERENCES tables (address),
  hand_no        INTEGER NOT NULL,
  record         TEXT    NOT NULL,          -- JSON
  verified       INTEGER NOT NULL,
  problems       TEXT    NOT NULL,          -- JSON
  log_status     TEXT    NOT NULL DEFAULT 'pending',
  log_enc        BLOB,
  log_verified   INTEGER,
  archived_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  record_hash    TEXT,
  button_checked INTEGER,
  PRIMARY KEY (table_address, hand_no)
);

CREATE TABLE hands_superseded (
  table_address  TEXT    NOT NULL,
  hand_no        INTEGER NOT NULL,
  record         TEXT    NOT NULL,
  verified       INTEGER NOT NULL,
  problems       TEXT    NOT NULL,
  log_status     TEXT    NOT NULL DEFAULT 'pending',
  log_enc        BLOB,
  log_verified   INTEGER,
  archived_at    TEXT    NOT NULL,
  record_hash    TEXT,
  button_checked INTEGER,
  superseded_at  TEXT
);

CREATE TABLE keeper_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  table_address TEXT,
  action        TEXT    NOT NULL,
  ok            INTEGER NOT NULL,
  detail        TEXT
);
CREATE INDEX keeper_events_at ON keeper_events (at DESC);
CREATE INDEX keeper_events_table ON keeper_events (table_address, action, id DESC);

CREATE TABLE keeper_spend (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  kind          TEXT    NOT NULL,
  who           TEXT    NOT NULL,
  ref           TEXT    NOT NULL,
  ok            INTEGER,
  table_address TEXT,
  detail        TEXT
);
CREATE INDEX keeper_spend_kind_at ON keeper_spend (kind, at DESC);

CREATE TABLE agents (
  wallet       TEXT    PRIMARY KEY,
  agent_pub    TEXT    NOT NULL,
  agent_secret BLOB    NOT NULL,
  settings     TEXT    NOT NULL,            -- JSON
  status       TEXT    NOT NULL,
  detail       TEXT    NOT NULL DEFAULT '',
  until        INTEGER NOT NULL,
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE agent_sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet         TEXT    NOT NULL,
  agent_pub      TEXT    NOT NULL,
  table_address  TEXT    NOT NULL,
  seat           INTEGER NOT NULL,
  reader_secret  BLOB    NOT NULL,
  buy_in         INTEGER NOT NULL,
  stack          INTEGER NOT NULL,
  cash_out       INTEGER,
  hands          INTEGER NOT NULL DEFAULT 0,
  last_hand      INTEGER NOT NULL DEFAULT 0,
  started_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at       TEXT,
  end_reason     TEXT,
  strategy_id    TEXT,
  fee_net_before INTEGER,
  fee_high_water INTEGER,
  creator_fee    INTEGER,
  platform_fee   INTEGER
);
CREATE INDEX agent_sessions_wallet ON agent_sessions (wallet, id DESC);
CREATE UNIQUE INDEX agent_sessions_one_open ON agent_sessions (wallet) WHERE ended_at IS NULL;
CREATE INDEX agent_sessions_strategy ON agent_sessions (strategy_id) WHERE strategy_id IS NOT NULL;

CREATE TABLE agent_hands (
  session_id  INTEGER NOT NULL,
  hand_no     INTEGER NOT NULL,
  stack_after INTEGER NOT NULL,
  at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (session_id, hand_no)
);

CREATE TABLE sol_strategies (
  strategy_id  TEXT    PRIMARY KEY,
  creator      TEXT    NOT NULL,
  creator_name TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  version      INTEGER NOT NULL,
  profile      TEXT    NOT NULL,            -- JSON
  listed       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX sol_strategies_creator ON sol_strategies (creator, created_at DESC);

CREATE TABLE host_credits (
  wallet     TEXT    PRIMARY KEY,
  used       INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE vault_payouts (
  wallet            TEXT    PRIMARY KEY,
  expected          INTEGER NOT NULL,
  paid              INTEGER NOT NULL DEFAULT 0,
  landed            INTEGER NOT NULL DEFAULT 0,
  registered_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  landed_changed_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_paid_at      TEXT,
  done              INTEGER NOT NULL DEFAULT 0,
  last_checked_at   TEXT
);

-- One keeper and one Agent runner at a time: the instance holding the lease runs them (a deploy can overlap the old
-- and new container for a moment). Renewed every few seconds; another instance takes over once it lapses.
CREATE TABLE leases (
  name       TEXT    PRIMARY KEY,
  holder     TEXT    NOT NULL,
  expires_at INTEGER NOT NULL             -- Unix ms
);
