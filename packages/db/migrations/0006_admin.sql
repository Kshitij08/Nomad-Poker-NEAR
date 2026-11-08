-- Phase 7: support tools. Admins are ordinary player accounts listed here (added by an operator with a D1 query, never
-- from the API); every admin action is written to admin_audit. A banned player's sessions stop working and sign-in
-- refuses them.

CREATE TABLE admin_users (
  player_id TEXT    PRIMARY KEY REFERENCES players (id) ON DELETE CASCADE,
  role      TEXT    NOT NULL CHECK (role IN ('support', 'admin')),   -- support: read + ban; admin: also balance adjustments
  added_at  INTEGER NOT NULL,
  note      TEXT    NOT NULL DEFAULT ''
) STRICT, WITHOUT ROWID;

CREATE TABLE admin_audit (
  id         INTEGER PRIMARY KEY,
  admin_id   TEXT    NOT NULL,
  action     TEXT    NOT NULL,          -- adjust | ban | unban | view
  target_id  TEXT,                      -- the player acted on
  details    TEXT    NOT NULL,          -- JSON: amounts, reasons, ledger entry ids
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX admin_audit_target ON admin_audit (target_id, id DESC);
CREATE INDEX admin_audit_time ON admin_audit (created_at DESC);

ALTER TABLE players ADD COLUMN banned_at INTEGER;
ALTER TABLE players ADD COLUMN ban_reason TEXT;
