-- Phase 4: social on the Nomad server (was friends.js CloudScript on PlayFab), profile, and leaderboards from hands.

-- A player's public Friend ID: 16 hex characters, shown as XXXX-XXXX-XXXX-XXXX (FriendCode). The internal id never
-- leaves the server in social payloads.
ALTER TABLE players ADD COLUMN friend_code TEXT;
ALTER TABLE players ADD COLUMN avatar INTEGER NOT NULL DEFAULT 0;   -- AvatarCatalog value (0 = none)
UPDATE players SET friend_code = upper(hex(randomblob(8))) WHERE friend_code IS NULL;
CREATE UNIQUE INDEX players_friend_code ON players (friend_code);
CREATE INDEX players_display_name ON players (display_name COLLATE NOCASE);

-- Both sides of every relationship, written together (PlayFab's one-way friend lists, tagged).
CREATE TABLE friendships (
  player_id  TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  friend_id  TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  relation   TEXT    NOT NULL CHECK (relation IN ('friend', 'pending_out', 'pending_in')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, friend_id)
) STRICT, WITHOUT ROWID;

-- Table invites waiting for an answer: one per sender per invitee, kept FriendInviteRules.TtlSeconds.
CREATE TABLE table_invites (
  to_player   TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  from_player TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  session     TEXT    NOT NULL,
  money       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (to_player, from_player)
) STRICT, WITHOUT ROWID;

-- One row per hand a Nomad player was dealt into, written by the game server (keyed, so a retry adds nothing).
-- Leaderboards are aggregates of this table: earnings = SUM(net), hands won = COUNT(won).
CREATE TABLE hand_results (
  player_id  TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  table_id   TEXT    NOT NULL,
  hand       INTEGER NOT NULL,
  net        INTEGER NOT NULL,     -- chips won (+) or lost (−) in the hand
  won        INTEGER NOT NULL,     -- 1 when the player won a pot
  week       INTEGER NOT NULL,     -- FreePlayLeaderboardMath.weekId (YYYYWW)
  season     INTEGER NOT NULL,     -- FreePlayLeaderboardMath.seasonId (YYYYMM)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, table_id, hand)
) STRICT, WITHOUT ROWID;
CREATE INDEX hand_results_week ON hand_results (week, player_id);
CREATE INDEX hand_results_season ON hand_results (season, player_id);
