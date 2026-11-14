-- NEAR sign-in: a 'near' identity (subject = the NEAR account id, e.g. alice.testnet) and 'near' sign-in challenges.
-- SQLite cannot change a CHECK constraint in place, so both tables are rebuilt with the wider lists and their rows kept.

CREATE TABLE identities_new (
  provider   TEXT    NOT NULL CHECK (provider IN ('wallet', 'google', 'email', 'near')),
  subject    TEXT    NOT NULL,             -- wallet address, Google `sub`, lower-cased email, or NEAR account id
  label      TEXT    NOT NULL,             -- what the player sees
  player_id  TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
) STRICT;
INSERT INTO identities_new (provider, subject, label, player_id, created_at)
  SELECT provider, subject, label, player_id, created_at FROM identities;
DROP TABLE identities;
ALTER TABLE identities_new RENAME TO identities;
CREATE INDEX identities_player ON identities (player_id);

CREATE TABLE auth_challenges_new (
  id         TEXT    PRIMARY KEY,
  kind       TEXT    NOT NULL CHECK (kind IN ('wallet', 'email', 'near')),
  subject    TEXT    NOT NULL,             -- wallet address, lower-cased email, or NEAR account id
  payload    TEXT    NOT NULL,             -- wallet: the message to sign; email: the return origin; near: the NEP-413 payload (JSON)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
INSERT INTO auth_challenges_new (id, kind, subject, payload, created_at, expires_at)
  SELECT id, kind, subject, payload, created_at, expires_at FROM auth_challenges;
DROP TABLE auth_challenges;
ALTER TABLE auth_challenges_new RENAME TO auth_challenges;
CREATE INDEX auth_challenges_expiry ON auth_challenges (expires_at);
