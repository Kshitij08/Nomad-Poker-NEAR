-- Gems are gone from the web game (nothing spends them). Every Gem a player holds is paid out as 250 Coins, through
-- the ledger like any other change: a Coins credit and a matching Gems debit per player, keyed so a re-run adds nothing.
-- New rewards already pay Coins instead (engine retention/levels.ts GEM_COINS, missions.ts).

INSERT INTO ledger_entries (player_id, currency, delta, reason, ref, idempotency_key, created_at)
SELECT player_id, 'coins', amount * 250, 'gems_to_coins', NULL, 'gems-to-coins:coins', CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM balances
WHERE currency = 'gems' AND amount > 0
ON CONFLICT (player_id, idempotency_key) DO NOTHING;

INSERT INTO ledger_entries (player_id, currency, delta, reason, ref, idempotency_key, created_at)
SELECT player_id, 'gems', -amount, 'gems_to_coins', NULL, 'gems-to-coins:gems', CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM balances
WHERE currency = 'gems' AND amount > 0
ON CONFLICT (player_id, idempotency_key) DO NOTHING;
