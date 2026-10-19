-- Coins Agents' bankroll on the server (review A2/H2): the backend takes the bankroll from the owner's PlayFab Coins
-- before the Agent is queued, and pays the ending stack (minus a copied strategy's profit share) back when it ends.
-- It used to be the client's own local note: nothing was charged, and the return was credited from nothing.
--
-- One row per Coins move, with a deterministic idempotency key (PlayFab dedupes on it), so a retry moves Coins once.
-- migrate.ts re-applies every file on every boot: everything here must be safe to run again.

CREATE TABLE IF NOT EXISTS agent_money (
    id BIGSERIAL PRIMARY KEY,
    deployment_id TEXT NOT NULL,
    playfab_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('bankroll_debit', 'return_credit', 'refund_credit')),
    amount BIGINT NOT NULL CHECK (amount > 0),
    idempotency_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed')),
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    done_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_money_due ON agent_money (next_attempt_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_agent_money_deployment ON agent_money (deployment_id);

-- Deployments whose bankroll the backend took. Older rows (the client-side era) stay FALSE and are never paid back
-- by the backend: nothing was taken for them.
ALTER TABLE agent_deployments ADD COLUMN IF NOT EXISTS funded BOOLEAN NOT NULL DEFAULT FALSE;
