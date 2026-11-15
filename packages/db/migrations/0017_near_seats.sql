-- NEAR money tables: each seated NEAR account's stack after its last settled hand, so a table that dies mid-session
-- (redeploy, eviction, crash) can pay the stacks back through the escrow when it next opens (apps/game-server
-- nearChipLedger.ts). A row is written at buy-in and after every hand, and deleted at cash-out.
CREATE TABLE near_seats (
  room        TEXT    NOT NULL,
  account     TEXT    NOT NULL,
  player_id   TEXT    NOT NULL,
  stack       INTEGER NOT NULL,
  hand_number INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (room, account)
);
