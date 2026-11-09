-- Escrow (SOL) tables were removed from the new stack on 9 Nov 2026: SOL play is the private tables (PER, apps/per),
-- as in the Unity game. Every escrow table had been paid out and closed on chain; this drops their record.
DROP TABLE IF EXISTS escrow_tables;
