-- Hosted round-format tournaments (design doc v0.5, architecture doc phase 2).
--
-- The backend is the only thing that moves tournament chips. Every move is a money_moves row with a
-- deterministic idempotency key, written in the same transaction as the record change it pays for,
-- then executed against PlayFab. A crash between the two is recovered by the money worker re-running
-- the pending row with the same key, which PlayFab deduplicates.
--
-- migrate.ts re-applies every file on every boot, so everything here must be safe to run again.

CREATE TABLE IF NOT EXISTS pf_players (
    playfab_id TEXT PRIMARY KEY,
    title_player_account_id TEXT NOT NULL,
    display_name TEXT,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tournaments (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    host_playfab_id TEXT NOT NULL REFERENCES pf_players(playfab_id),
    currency TEXT NOT NULL DEFAULT 'CH' CHECK (currency IN ('CH')),
    entry_fee BIGINT NOT NULL DEFAULT 0 CHECK (entry_fee >= 0),
    -- The host prize promised at creation. What has actually been taken from the host (and so what is
    -- paid out or refunded) is the sum of their completed debits in money_moves.
    host_prize BIGINT NOT NULL DEFAULT 0 CHECK (host_prize >= 0),
    platform_fee_bps INT NOT NULL DEFAULT 0 CHECK (platform_fee_bps BETWEEN 0 AND 10000),
    visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
    join_code TEXT NOT NULL UNIQUE,
    session_name TEXT NOT NULL UNIQUE,
    starts_at TIMESTAMPTZ NOT NULL,
    speed TEXT NOT NULL CHECK (speed IN ('turbo', 'regular', 'slow')),
    max_players INT NOT NULL CHECK (max_players BETWEEN 2 AND 30),
    status TEXT NOT NULL CHECK (status IN (
        'funding', 'funding_failed', 'registering', 'locked', 'running',
        'finished', 'cancelled', 'aborted'
    )),
    server_state TEXT NOT NULL DEFAULT 'none'
        CHECK (server_state IN ('none', 'queued', 'claimed', 'ready')),
    server_claimed_at TIMESTAMPTZ,
    server_ready_at TIMESTAMPTZ,
    server_error TEXT,
    locked_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    cancel_reason TEXT,
    last_heartbeat_at TIMESTAMPTZ,
    progress_seq BIGINT NOT NULL DEFAULT 0,
    last_progress JSONB,
    result JSONB,
    result_hash TEXT,
    prize_raise_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tournaments_listing
    ON tournaments(status, starts_at) WHERE visibility = 'public';
CREATE INDEX IF NOT EXISTS idx_tournaments_due
    ON tournaments(starts_at) WHERE status IN ('funding', 'registering', 'locked', 'running');
CREATE INDEX IF NOT EXISTS idx_tournaments_host
    ON tournaments(host_playfab_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tournament_entries (
    id BIGSERIAL PRIMARY KEY,
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    playfab_id TEXT NOT NULL REFERENCES pf_players(playfab_id),
    display_name TEXT NOT NULL,
    -- paying:      entry fee debit in flight, holds a seat
    -- registered:  in (paid or free)
    -- playing:     roster frozen at the start time
    -- finished:    result recorded (place, prize)
    -- unregistered / removed / cancelled / excluded / rejected: out; any paid fee is refunded via money_moves
    status TEXT NOT NULL CHECK (status IN (
        'paying', 'registered', 'playing', 'finished',
        'unregistered', 'removed', 'cancelled', 'excluded', 'rejected'
    )),
    attempt INT NOT NULL DEFAULT 1,
    paid_amount BIGINT NOT NULL DEFAULT 0,
    place INT,
    round_reached INT,
    prize BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tournament_id, playfab_id)
);

CREATE INDEX IF NOT EXISTS idx_tournament_entries_player
    ON tournament_entries(playfab_id, created_at DESC);

CREATE TABLE IF NOT EXISTS money_moves (
    id BIGSERIAL PRIMARY KEY,
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    entry_id BIGINT REFERENCES tournament_entries(id) ON DELETE CASCADE,
    playfab_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (
        'host_prize_debit', 'prize_raise_debit', 'entry_debit', 'refund', 'payout'
    )),
    amount BIGINT NOT NULL CHECK (amount > 0),
    -- A refund's key is its debit's key + ':refund', so nothing is ever refunded twice.
    idempotency_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed')),
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    done_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_money_moves_pending
    ON money_moves(next_attempt_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_money_moves_tournament
    ON money_moves(tournament_id, kind);
