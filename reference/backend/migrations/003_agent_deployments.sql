-- Durable live shared-agent deployments and per-hand history.

CREATE TABLE IF NOT EXISTS agent_deployments (
    deployment_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    agent_name TEXT NOT NULL DEFAULT 'Agent',
    profile TEXT NOT NULL DEFAULT 'balanced',
    strategy_version TEXT NOT NULL DEFAULT 'v1',
    strategy_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    bankroll BIGINT NOT NULL,
    max_hands INT NOT NULL,
    max_runtime_seconds INT NOT NULL,
    stop_loss BIGINT NOT NULL DEFAULT 0,
    profit_target BIGINT NOT NULL DEFAULT 0,
    stake BIGINT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'queued'
        CHECK (phase IN (
            'queued', 'seated', 'playing', 'stop_requested',
            'settling', 'completed', 'failed'
        )),
    assigned_table TEXT,
    hands_played INT NOT NULL DEFAULT 0,
    wins INT NOT NULL DEFAULT 0,
    losses INT NOT NULL DEFAULT 0,
    showdowns INT NOT NULL DEFAULT 0,
    stack BIGINT NOT NULL,
    net_pnl BIGINT NOT NULL DEFAULT 0,
    runtime_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
    stop_requested BOOLEAN NOT NULL DEFAULT FALSE,
    stop_reason TEXT,
    result JSONB,
    claimed_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_hands (
    id BIGSERIAL PRIMARY KEY,
    deployment_id TEXT NOT NULL
        REFERENCES agent_deployments(deployment_id) ON DELETE CASCADE,
    hand_number INT NOT NULL,
    start_stack BIGINT NOT NULL,
    end_stack BIGINT NOT NULL,
    net_pnl BIGINT NOT NULL,
    hole_cards JSONB NOT NULL DEFAULT '[]'::jsonb,
    board_cards JSONB NOT NULL DEFAULT '[]'::jsonb,
    pot BIGINT NOT NULL DEFAULT 0,
    result TEXT NOT NULL,
    showdown BOOLEAN NOT NULL DEFAULT FALSE,
    public_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (deployment_id, hand_number)
);

CREATE INDEX IF NOT EXISTS idx_agent_deployments_queue
    ON agent_deployments(stake, created_at)
    WHERE phase = 'queued';
CREATE INDEX IF NOT EXISTS idx_agent_deployments_owner
    ON agent_deployments(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_hands_deployment
    ON agent_hands(deployment_id, hand_number DESC);
