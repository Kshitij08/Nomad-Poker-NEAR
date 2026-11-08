-- Phase 1: players, sign-in identities, sessions, one-time sign-in challenges, and the play-money ledger.
-- Times are Unix milliseconds. Foreign keys are always enforced on D1.

CREATE TABLE players (
  id            TEXT    PRIMARY KEY,
  display_name  TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('guest', 'registered')),
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
) STRICT;

-- One row per way to sign in. A guest has none until it links one.
CREATE TABLE identities (
  provider   TEXT    NOT NULL CHECK (provider IN ('wallet', 'google', 'email')),
  subject    TEXT    NOT NULL,             -- wallet address, Google `sub`, or lower-cased email
  label      TEXT    NOT NULL,             -- what the player sees (address, Google email, email)
  player_id  TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
) STRICT;
CREATE INDEX identities_player ON identities (player_id);

-- Bearer sessions. Only the SHA-256 of the token is stored.
CREATE TABLE sessions (
  token_hash   TEXT    PRIMARY KEY,
  player_id    TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_player ON sessions (player_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);

-- Single-use sign-in challenges: wallet nonces and email link tokens (stored hashed).
CREATE TABLE auth_challenges (
  id         TEXT    PRIMARY KEY,
  kind       TEXT    NOT NULL CHECK (kind IN ('wallet', 'email')),
  subject    TEXT    NOT NULL,             -- wallet address or lower-cased email
  payload    TEXT    NOT NULL,             -- wallet: the message to sign; email: the return origin
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX auth_challenges_expiry ON auth_challenges (expires_at);

-- Current balances: derived from the ledger by the trigger below, never written directly.
CREATE TABLE balances (
  player_id  TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  currency   TEXT    NOT NULL CHECK (currency IN ('coins', 'gems', 'xp', 'streak_tokens')),
  amount     INTEGER NOT NULL CHECK (amount >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, currency)
) STRICT, WITHOUT ROWID;

-- The append-only play-money ledger. Every balance change is one row here.
CREATE TABLE ledger_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id       TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  currency        TEXT    NOT NULL CHECK (currency IN ('coins', 'gems', 'xp', 'streak_tokens')),
  delta           INTEGER NOT NULL CHECK (delta <> 0),
  reason          TEXT    NOT NULL,
  ref             TEXT,
  idempotency_key TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE (player_id, idempotency_key)
) STRICT;
CREATE INDEX ledger_player ON ledger_entries (player_id, id DESC);

-- Apply each entry to the balance in the same statement. A debit below zero breaks the CHECK on balances,
-- which aborts the INSERT too, so the ledger and balances can never disagree. (UPDATE first: an upsert would
-- CHECK the candidate row, the bare delta, before finding the existing balance.)
CREATE TRIGGER ledger_apply AFTER INSERT ON ledger_entries
BEGIN
  UPDATE balances SET amount = amount + NEW.delta, updated_at = NEW.created_at
  WHERE player_id = NEW.player_id AND currency = NEW.currency;
  INSERT INTO balances (player_id, currency, amount, updated_at)
  SELECT NEW.player_id, NEW.currency, NEW.delta, NEW.created_at
  WHERE NOT EXISTS (SELECT 1 FROM balances WHERE player_id = NEW.player_id AND currency = NEW.currency);
END;

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger entries are append-only');
END;
