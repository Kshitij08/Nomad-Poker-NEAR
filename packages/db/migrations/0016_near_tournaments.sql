-- NEAR tournaments: the stakes sit in the escrow contract (near/escrow, tournament id = tournaments.id), not the ledger.
-- D1 keeps the record, roster and clock as for coins tournaments but posts no ledger entries for a 'near' one.
--
-- escrow_status ('' for coins):
--   pending   created here; the host's wallet has not created it on the escrow yet (or the API has not seen it): hidden
--   open      the escrow holds it (checked by the API with a view); players register on the escrow, then here
--   settled   the game server's operator paid the winners (settle_tournament)
--   refunded  the operator cancelled it on the escrow, refunding every entry and the host's prize (or the host did)
--   none      it ended before the escrow ever had it: nothing to settle or refund
ALTER TABLE tournaments ADD COLUMN currency TEXT NOT NULL DEFAULT 'coins' CHECK (currency IN ('coins', 'near'));
ALTER TABLE tournaments ADD COLUMN escrow_status TEXT NOT NULL DEFAULT '' CHECK (escrow_status IN ('', 'pending', 'open', 'settled', 'refunded', 'none'));
CREATE INDEX tournaments_escrow ON tournaments (escrow_status, status) WHERE currency = 'near';
