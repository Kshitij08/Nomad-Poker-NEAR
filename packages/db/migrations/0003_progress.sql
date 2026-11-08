-- Phase 3: retention decided on the server. XP, gems and streak shields are ledger currencies (balances); this is
-- the rest of a player's progress: the daily spin, the 7-day login track, the mission board and paid level rewards.

CREATE TABLE player_progress (
  player_id       TEXT    PRIMARY KEY REFERENCES players (id) ON DELETE CASCADE,
  last_spin_day   INTEGER NOT NULL DEFAULT 0,      -- UTC day number of the last spin (0 = never)
  last_spin_coins INTEGER NOT NULL DEFAULT 0,
  last_login_day  INTEGER NOT NULL DEFAULT 0,      -- UTC day of the last login-track claim
  streak_day      INTEGER NOT NULL DEFAULT 0,      -- 1..7 on the login track
  mission_board   TEXT    NOT NULL DEFAULT '',     -- JSON MissionBoardState (engine retention/missions)
  rewarded_level  INTEGER NOT NULL DEFAULT 1,      -- every level up to this one has been paid
  version         INTEGER NOT NULL DEFAULT 0,      -- optimistic lock for read-modify-write of the board
  updated_at      INTEGER NOT NULL
) STRICT;

-- Cosmetics a player owns (level rewards today).
CREATE TABLE owned_items (
  player_id  TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  item_id    TEXT    NOT NULL,
  source     TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, item_id)
) STRICT, WITHOUT ROWID;
