-- Phase 6: SOL tables on the poker-escrow program (devnet). The escrow is the ledger for their money; this only
-- records which on-chain tables the game server opened, so a sweep can settle, pay out and close any it left behind.

CREATE TABLE escrow_tables (
  table_id    TEXT    PRIMARY KEY,         -- the on-chain table id (also the table session id the game uses)
  room        TEXT    NOT NULL,            -- the Durable Object that hosts it
  authority   TEXT    NOT NULL,            -- the settlement key that created it (base58)
  buy_in      INTEGER NOT NULL,            -- lamports
  state       TEXT    NOT NULL CHECK (state IN ('creating', 'open', 'closing', 'closed', 'failed')),
  hands       INTEGER NOT NULL DEFAULT 0,  -- rounds settled
  last_error  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX escrow_tables_state ON escrow_tables (state, updated_at);
