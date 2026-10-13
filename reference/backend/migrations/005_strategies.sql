-- Agents v2 (docs/AGENTS_V2.md): playstyle records, the copy-strategy marketplace and its profit share.

-- One row per decision a player made at a Coins table, written by the game server (it alone sees every hole card).
CREATE TABLE IF NOT EXISTS style_decisions (
    id BIGSERIAL PRIMARY KEY,
    player_id TEXT NOT NULL,              -- PlayFab id
    table_name TEXT NOT NULL,
    hand_no INT NOT NULL,
    street SMALLINT NOT NULL,             -- 0 preflop, 1 flop, 2 turn, 3 river
    position SMALLINT NOT NULL,           -- seats after the button (0 = button)
    opponents SMALLINT NOT NULL,          -- live opponents in the hand
    strength REAL NOT NULL,               -- HandStrength.Estimate minus 0.03 per extra opponent (what the bot sees)
    pot BIGINT NOT NULL,
    to_call BIGINT NOT NULL,
    min_raise_to BIGINT NOT NULL,
    big_blind BIGINT NOT NULL,
    stack BIGINT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('fold', 'check', 'call', 'bet', 'raise')),
    amount BIGINT NOT NULL DEFAULT 0,     -- bet / raise "to"
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS style_decisions_player ON style_decisions (player_id, id DESC);

-- One row per hand a player finished at a Coins table (outcome, for coaching).
CREATE TABLE IF NOT EXISTS style_hands (
    player_id TEXT NOT NULL,
    table_name TEXT NOT NULL,
    hand_no INT NOT NULL,
    position SMALLINT NOT NULL,
    big_blind BIGINT NOT NULL,
    net BIGINT NOT NULL,
    showdown BOOLEAN NOT NULL,
    won BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (player_id, table_name, hand_no)
);
CREATE INDEX IF NOT EXISTS style_hands_player ON style_hands (player_id, created_at DESC);

-- A published strategy: a frozen profile (never the creator's hands).
CREATE TABLE IF NOT EXISTS strategies (
    strategy_id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    creator_name TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    version INT NOT NULL DEFAULT 1,
    profile JSONB NOT NULL,
    source TEXT NOT NULL DEFAULT 'custom' CHECK (source IN ('custom', 'twin')),
    listed BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (creator_id, name, version)
);
CREATE INDEX IF NOT EXISTS strategies_listed ON strategies (listed, created_at DESC);

ALTER TABLE agent_deployments ADD COLUMN IF NOT EXISTS strategy_id TEXT REFERENCES strategies(strategy_id);
ALTER TABLE agent_deployments ADD COLUMN IF NOT EXISTS copier_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- Profit share high-water mark per copier and strategy: fees only on new profit above the previous peak.
CREATE TABLE IF NOT EXISTS copy_positions (
    copier_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL REFERENCES strategies(strategy_id),
    cumulative_pnl BIGINT NOT NULL DEFAULT 0,
    high_water BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (copier_id, strategy_id)
);

-- One settlement per finished copied session (idempotent on deployment_id).
CREATE TABLE IF NOT EXISTS copy_fees (
    deployment_id TEXT PRIMARY KEY REFERENCES agent_deployments(deployment_id),
    strategy_id TEXT NOT NULL REFERENCES strategies(strategy_id),
    copier_id TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    session_pnl BIGINT NOT NULL,
    fee_base BIGINT NOT NULL,
    creator_fee BIGINT NOT NULL,
    platform_fee BIGINT NOT NULL,
    creator_paid BOOLEAN NOT NULL DEFAULT FALSE,
    pay_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS copy_fees_creator ON copy_fees (creator_id, created_at DESC);
