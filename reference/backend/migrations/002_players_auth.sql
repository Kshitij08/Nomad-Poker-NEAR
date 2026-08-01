-- Player profiles + SIWS auth nonces (wallet pubkey is the identity key)

CREATE TABLE IF NOT EXISTS players (
    pubkey TEXT PRIMARY KEY,
    display_name TEXT,
    email TEXT,
    marketing_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_nonces (
    pubkey TEXT NOT NULL,
    nonce TEXT NOT NULL,
    message TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (pubkey, nonce)
);

CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires ON auth_nonces(expires_at);
CREATE INDEX IF NOT EXISTS idx_players_email ON players(email)
    WHERE email IS NOT NULL;
