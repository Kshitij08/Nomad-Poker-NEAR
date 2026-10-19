-- Table types for Coins Agents (review 20 Oct, phase 3): each session's filler bots are one type (mixed, tight, loose,
-- wild), picked in turn per owner when it is queued, so strategies are ranked across different tables instead of one.
-- migrate.ts re-applies every file on every boot: everything here must be safe to run again.

ALTER TABLE agent_deployments ADD COLUMN IF NOT EXISTS room TEXT NOT NULL DEFAULT 'mixed';
