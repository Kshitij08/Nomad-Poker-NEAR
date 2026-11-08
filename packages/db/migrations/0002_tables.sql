-- Phase 2: tables run on the server (one Durable Object per table) and move chips through the ledger.

-- One seat lock per player, across every table: it is what stops the same chips sitting at two tables. Written in
-- the same batch as the buy-in debit, removed in the same batch as the cash-out credit.
CREATE TABLE seat_locks (
  player_id   TEXT    PRIMARY KEY REFERENCES players (id) ON DELETE CASCADE,
  lock_id     TEXT    NOT NULL UNIQUE,     -- names this buy-in: ledger keys are 'buyin:<lock_id>' / 'cashout:<lock_id>'
  table_id    TEXT    NOT NULL,            -- the table session (fresh each time a table opens)
  room        TEXT    NOT NULL,            -- the Durable Object hosting it, asked before recovering a stranded stack
  seat        INTEGER NOT NULL,
  buy_in      INTEGER NOT NULL CHECK (buy_in > 0),
  stack       INTEGER NOT NULL CHECK (stack >= 0),   -- the last checkpoint (after every hand)
  hand_number INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX seat_locks_table ON seat_locks (table_id);

-- One row per table session: what the house (the bots) won or lost there. With every human cashed out,
-- (sum of that table's buy-ins and cash-outs in the ledger) + bot_net = 0; anything else is drift.
CREATE TABLE table_sessions (
  id         TEXT    PRIMARY KEY,          -- the table id the seat locks and ledger refs use
  room       TEXT    NOT NULL,
  stake      INTEGER NOT NULL,             -- the minimum buy-in
  opened_at  INTEGER NOT NULL,
  closed_at  INTEGER,
  hands      INTEGER NOT NULL DEFAULT 0,
  bot_net    INTEGER NOT NULL DEFAULT 0    -- chips the bots won (+) or lost (−) across the session
) STRICT;
CREATE INDEX table_sessions_open ON table_sessions (closed_at);
