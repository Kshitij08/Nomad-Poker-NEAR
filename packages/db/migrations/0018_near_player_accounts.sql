-- NEAR accounts the API made for players ("Create my NEAR account", apps/api/src/nearAccounts.ts) and the delegate
-- actions it relayed for them (gasless calls paid by the sponsor). One app-made account per player.

CREATE TABLE near_accounts (
  account_id TEXT    PRIMARY KEY,                 -- <id>.<sponsor>, e.g. k3j9x2ab1q.players.nomad-poker.testnet
  player_id  TEXT    NOT NULL UNIQUE REFERENCES players (id) ON DELETE CASCADE,
  public_key TEXT    NOT NULL,                    -- the browser's key, "ed25519:<base58>" (its only full-access key)
  funded     TEXT    NOT NULL,                    -- yoctoNEAR the sponsor sent with the account
  tx_hash    TEXT,                                -- the creating transaction; null while it is in flight
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX near_accounts_created ON near_accounts (created_at);

CREATE TABLE near_relays (
  hash        TEXT    PRIMARY KEY,                -- base58 of the delegate action's NEP-366 hash: each is relayed once
  player_id   TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  account_id  TEXT    NOT NULL,
  receiver_id TEXT    NOT NULL,
  methods     TEXT    NOT NULL,                   -- comma-separated method names
  deposit     TEXT    NOT NULL,                   -- yoctoNEAR attached in total
  status      TEXT    NOT NULL CHECK (status IN ('pending', 'ok', 'failed')),
  tx_hash     TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX near_relays_player ON near_relays (player_id, created_at);
