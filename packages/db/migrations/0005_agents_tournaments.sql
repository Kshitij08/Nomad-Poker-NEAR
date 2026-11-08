-- Phase 5: Agents play inside the game server, tournaments are run by it, and the strategies market, coach and twin
-- read what the tables record. Every chip that moves goes through ledger_entries (no separate money queue): the
-- money statement sits in the same D1 batch as the state change it pays for.

-- ---- Agents --------------------------------------------------------------------------------------------------------

-- One Agent session. The bankroll leaves the owner's balance in the batch that inserts the row (key
-- 'agent:<id>:bankroll'); the ending stack comes back in the batch that completes it ('agent:<id>:return').
CREATE TABLE agent_deployments (
  id               TEXT    PRIMARY KEY,                    -- the session code the client generated
  owner_id         TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  agent_name       TEXT    NOT NULL,
  profile          TEXT    NOT NULL,                       -- preset name (balanced, guardian, …)
  strategy_version TEXT    NOT NULL,
  strategy_id      TEXT,                                   -- a copied market strategy
  strategy         TEXT    NOT NULL,                       -- JSON: the numbers the Agent plays with
  bankroll         INTEGER NOT NULL CHECK (bankroll > 0),
  stake            INTEGER NOT NULL,                       -- the table's minimum buy-in
  max_hands        INTEGER NOT NULL,
  max_runtime      INTEGER NOT NULL,                       -- seconds
  stop_loss        INTEGER NOT NULL DEFAULT 0,
  profit_target    INTEGER NOT NULL DEFAULT 0,
  phase            TEXT    NOT NULL CHECK (phase IN ('queued', 'playing', 'completed', 'failed')),
  stop_requested   INTEGER NOT NULL DEFAULT 0,
  stop_reason      TEXT    NOT NULL DEFAULT '',
  room             TEXT,                                   -- the table's Durable Object, once seated
  hands_played     INTEGER NOT NULL DEFAULT 0,
  stack            INTEGER NOT NULL,                       -- checkpoint after every hand
  net_pnl          INTEGER NOT NULL DEFAULT 0,
  runtime_seconds  INTEGER NOT NULL DEFAULT 0,
  wins             INTEGER NOT NULL DEFAULT 0,
  losses           INTEGER NOT NULL DEFAULT 0,
  showdowns        INTEGER NOT NULL DEFAULT 0,
  returned         INTEGER NOT NULL DEFAULT 0,             -- chips paid back to the owner (stack minus any copy fee)
  copy_fee         TEXT,                                   -- JSON CopyFee once settled, for copied strategies
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  completed_at     INTEGER
) STRICT;
-- One Agent at a time per owner, enforced by the database.
CREATE UNIQUE INDEX agent_deployments_one_active ON agent_deployments (owner_id) WHERE phase IN ('queued', 'playing');
CREATE INDEX agent_deployments_owner ON agent_deployments (owner_id, created_at DESC);
CREATE INDEX agent_deployments_active ON agent_deployments (phase, updated_at) WHERE phase IN ('queued', 'playing');
CREATE INDEX agent_deployments_strategy ON agent_deployments (strategy_id) WHERE strategy_id IS NOT NULL;

-- Every hand an Agent played: the record the history screen shows, and its privacy-filtered replay.
CREATE TABLE agent_hands (
  deployment_id TEXT    NOT NULL REFERENCES agent_deployments (id) ON DELETE CASCADE,
  hand_number   INTEGER NOT NULL,
  net           INTEGER NOT NULL,
  record        TEXT    NOT NULL,                          -- JSON AgentHandRecord (ReplayJson left empty)
  replay        TEXT,                                      -- AgentHandReplay JSON, ≤ 30 KB
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (deployment_id, hand_number)
) STRICT, WITHOUT ROWID;

-- ---- Tournaments -----------------------------------------------------------------------------------------------------

-- Lifecycle: registering → locked (roster frozen at the start time) → running (the game server started it) → finished.
-- Off the main line: cancelled (host, or fewer than 2 players at the start) and aborted (never started, or the server
-- went quiet). Both refund every entry and the host's prize. The host's prize is taken when the tournament is created
-- (no 'funding' state: the debit and the insert are one batch).
CREATE TABLE tournaments (
  id                TEXT    PRIMARY KEY,
  name              TEXT    NOT NULL,
  host_id           TEXT    NOT NULL REFERENCES players (id),
  entry_fee         INTEGER NOT NULL CHECK (entry_fee >= 0),
  host_prize        INTEGER NOT NULL CHECK (host_prize >= 0),   -- everything the host has put in (raises included)
  prize_raises      INTEGER NOT NULL DEFAULT 0,
  visibility        TEXT    NOT NULL CHECK (visibility IN ('public', 'private')),
  join_code         TEXT    NOT NULL UNIQUE,
  session_name      TEXT    NOT NULL UNIQUE,                    -- TRN… : the game server room
  starts_at         INTEGER NOT NULL,                           -- ms
  speed             TEXT    NOT NULL CHECK (speed IN ('turbo', 'regular', 'slow')),
  max_players       INTEGER NOT NULL CHECK (max_players BETWEEN 2 AND 30),
  status            TEXT    NOT NULL CHECK (status IN ('registering', 'locked', 'running', 'finished', 'cancelled', 'aborted')),
  cancel_reason     TEXT    NOT NULL DEFAULT '',
  locked_at         INTEGER,
  started_at        INTEGER,
  last_heartbeat_at INTEGER,
  progress_seq      INTEGER NOT NULL DEFAULT 0,
  last_progress     TEXT,
  finished_at       INTEGER,
  result            TEXT,                                       -- JSON { championId, standings, payout }
  result_hash       TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
) STRICT;
CREATE INDEX tournaments_status ON tournaments (status, starts_at);
CREATE INDEX tournaments_host ON tournaments (host_id, starts_at DESC);

-- One row per player per tournament. Registering again after leaving bumps `attempt`, so each entry fee and its
-- refund have their own ledger keys ('trn:<id>:entry:<attempt>', 'trn:<id>:refund:<attempt>').
CREATE TABLE tournament_entries (
  tournament_id TEXT    NOT NULL REFERENCES tournaments (id) ON DELETE CASCADE,
  player_id     TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  display_name  TEXT    NOT NULL,
  status        TEXT    NOT NULL CHECK (status IN ('registered', 'playing', 'finished', 'unregistered', 'removed', 'cancelled')),
  attempt       INTEGER NOT NULL DEFAULT 1,
  paid_amount   INTEGER NOT NULL DEFAULT 0,
  place         INTEGER NOT NULL DEFAULT 0,
  round_reached INTEGER NOT NULL DEFAULT 0,
  prize         INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (tournament_id, player_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX tournament_entries_player ON tournament_entries (player_id, created_at DESC);

-- ---- Play style, the strategies market and its profit share ----------------------------------------------------------

-- One row per decision a Nomad player made at a Coins table, written by the game server (it alone sees hole cards).
CREATE TABLE style_decisions (
  id           INTEGER PRIMARY KEY,
  player_id    TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  table_name   TEXT    NOT NULL,
  hand_no      INTEGER NOT NULL,
  street       INTEGER NOT NULL,                 -- 0 preflop … 3 river
  position     INTEGER NOT NULL,                 -- seats before the button (0 = button)
  opponents    INTEGER NOT NULL,
  strength     REAL    NOT NULL,                 -- HandStrength.Estimate minus 0.03 per extra opponent
  pot          INTEGER NOT NULL,
  to_call      INTEGER NOT NULL,
  min_raise_to INTEGER NOT NULL,
  big_blind    INTEGER NOT NULL,
  stack        INTEGER NOT NULL,
  action       TEXT    NOT NULL CHECK (action IN ('fold', 'check', 'call', 'bet', 'raise')),
  amount       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX style_decisions_player ON style_decisions (player_id, id DESC);

-- One row per hand a Nomad player finished at a Coins table (outcomes, for the coach).
CREATE TABLE style_hands (
  player_id  TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  table_name TEXT    NOT NULL,
  hand_no    INTEGER NOT NULL,
  position   INTEGER NOT NULL,
  big_blind  INTEGER NOT NULL,
  net        INTEGER NOT NULL,
  showdown   INTEGER NOT NULL,
  won        INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, table_name, hand_no)
) STRICT, WITHOUT ROWID;
CREATE INDEX style_hands_player ON style_hands (player_id, created_at DESC);

-- A published strategy: a frozen profile (never the creator's hands).
CREATE TABLE strategies (
  id           TEXT    PRIMARY KEY,
  creator_id   TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  creator_name TEXT    NOT NULL DEFAULT '',
  name         TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  version      INTEGER NOT NULL DEFAULT 1,
  profile      TEXT    NOT NULL,                 -- JSON Profile
  source       TEXT    NOT NULL DEFAULT 'custom' CHECK (source IN ('custom', 'twin')),
  listed       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  UNIQUE (creator_id, name, version)
) STRICT;
CREATE INDEX strategies_listed ON strategies (listed, created_at DESC);

-- Profit share high-water mark per copier and strategy: fees only on new profit above the previous peak.
CREATE TABLE copy_positions (
  copier_id      TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  strategy_id    TEXT    NOT NULL REFERENCES strategies (id) ON DELETE CASCADE,
  cumulative_pnl INTEGER NOT NULL DEFAULT 0,
  high_water     INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (copier_id, strategy_id)
) STRICT, WITHOUT ROWID;

-- One settlement per finished copied session. The creator's share is a ledger credit in the same batch
-- ('copyfee:<deployment>'); the platform share is simply not paid back.
CREATE TABLE copy_fees (
  deployment_id TEXT    PRIMARY KEY REFERENCES agent_deployments (id) ON DELETE CASCADE,
  strategy_id   TEXT    NOT NULL REFERENCES strategies (id) ON DELETE CASCADE,
  copier_id     TEXT    NOT NULL,
  creator_id    TEXT    NOT NULL,
  session_pnl   INTEGER NOT NULL,
  fee_base      INTEGER NOT NULL,
  creator_fee   INTEGER NOT NULL,
  platform_fee  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX copy_fees_creator ON copy_fees (creator_id, created_at DESC);
