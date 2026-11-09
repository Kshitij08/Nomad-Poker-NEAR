-- Ledger entries by what they belong to (a table session, an Agent deployment, a tournament). The reconciliation's
-- table check sums each table's buy-ins and cash-outs by `ref`; without this index every table scanned the whole
-- ledger: on staging, 392 tables x 120k entries = 94 million rows read, 16 s, and the database refused everyone
-- else's queries meanwhile (load test, 9 Nov). The per-table audit, the Agent and tournament checks use it too.
CREATE INDEX IF NOT EXISTS ledger_ref ON ledger_entries (ref, currency);
