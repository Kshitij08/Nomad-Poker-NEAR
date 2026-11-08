-- Phase 7 fix: Agents' results at a table. Agents' chips move through their own ledger entries ('agent:<id>:…'), not
-- the table's seat locks, so a table's drift check needs them beside the bots':
--   drift = cash-outs + seated stacks − buy-ins + bot_net + agent_net   (zero when every chip is accounted for)
ALTER TABLE table_sessions ADD COLUMN agent_net INTEGER NOT NULL DEFAULT 0;

-- Tables that ran before this column: one with no human buy-in at all could only have had Agents, so the Agents
-- lost exactly what the bots won there.
UPDATE table_sessions SET agent_net = -bot_net
WHERE bot_net <> 0 AND NOT EXISTS (SELECT 1 FROM ledger_entries WHERE ref = table_sessions.id AND reason LIKE 'table:%');
