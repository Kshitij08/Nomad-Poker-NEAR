-- Phase 3 shop: purchases paid in Coins (ledger) or devnet SOL (a verified transfer), and their lasting effects.
-- Prices and effects live in packages/db/src/shop.ts; nothing here takes an amount from a client.

-- One row per completed purchase, keyed by the client's request id (Coins) or the SOL intent id, so a retried
-- request applies its effects once.
CREATE TABLE shop_purchases (
  player_id  TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  request_id TEXT    NOT NULL,
  item_id    TEXT    NOT NULL,
  paid_with  TEXT    NOT NULL CHECK (paid_with IN ('coins', 'sol')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, request_id)
) STRICT, WITHOUT ROWID;

-- Timed boosts: 2× XP from hands until this time (Unix ms).
CREATE TABLE shop_boosts (
  player_id TEXT    PRIMARY KEY REFERENCES players (id) ON DELETE CASCADE,
  xp_until  INTEGER NOT NULL
) STRICT;

-- SOL purchases: the server quotes an intent (price, treasury, memo = intent id); the player's devnet transfer must
-- carry that memo. A signature can settle one intent only.
CREATE TABLE shop_sol_intents (
  id         TEXT    PRIMARY KEY,
  player_id  TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  item_id    TEXT    NOT NULL,
  lamports   INTEGER NOT NULL CHECK (lamports > 0),
  treasury   TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  signature  TEXT    UNIQUE,
  done_at    INTEGER
) STRICT;
CREATE INDEX shop_sol_intents_player ON shop_sol_intents (player_id, created_at DESC);
