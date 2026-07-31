-- Poker escrow ledger schema

CREATE TABLE IF NOT EXISTS tables (
    table_id TEXT PRIMARY KEY,
    table_pda TEXT NOT NULL,
    vault_pda TEXT NOT NULL,
    host_pubkey TEXT NOT NULL,
    buy_in_lamports BIGINT NOT NULL,
    rake_bps INT NOT NULL,
    small_blind_chips BIGINT NOT NULL,
    big_blind_chips BIGINT NOT NULL,
    max_seats INT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS seats (
    id SERIAL PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES tables(table_id),
    player_pubkey TEXT NOT NULL,
    seat_pda TEXT NOT NULL,
    chips BIGINT NOT NULL DEFAULT 0,
    deposited_lamports BIGINT NOT NULL DEFAULT 0,
    rake_paid_lamports BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    UNIQUE (table_id, player_pubkey)
);

CREATE TABLE IF NOT EXISTS rounds (
    id SERIAL PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES tables(table_id),
    round_nonce BIGINT NOT NULL,
    pot_chips BIGINT,
    deltas JSONB NOT NULL,
    settle_sig TEXT,
    ended_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (table_id, round_nonce)
);

CREATE TABLE IF NOT EXISTS transactions (
    signature TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    table_id TEXT,
    player_pubkey TEXT,
    lamports BIGINT,
    chips_delta BIGINT,
    slot BIGINT,
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rake_events (
    id SERIAL PRIMARY KEY,
    signature TEXT NOT NULL,
    table_id TEXT NOT NULL,
    player_pubkey TEXT NOT NULL,
    rake_lamports BIGINT NOT NULL,
    rake_bps INT NOT NULL,
    collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS player_ledger (
    id SERIAL PRIMARY KEY,
    table_id TEXT NOT NULL,
    player_pubkey TEXT NOT NULL,
    chips BIGINT NOT NULL DEFAULT 0,
    net_deposited_lamports BIGINT NOT NULL DEFAULT 0,
    net_rake_paid_lamports BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (table_id, player_pubkey)
);

CREATE INDEX IF NOT EXISTS idx_transactions_table ON transactions(table_id);
CREATE INDEX IF NOT EXISTS idx_rake_events_table ON rake_events(table_id);
CREATE INDEX IF NOT EXISTS idx_seats_table ON seats(table_id);
