/**
 * Port of Economy/Contracts/IChipLedger.cs: everything an authoritative table may do to a player's chips. Two
 * implementations: TitleChipLedger (apps/web, PlayFab's rules over an emulated title, for the local server) and
 * D1ChipLedger (apps/game-server, the Nomad ledger in D1). Implementations never throw: every method resolves to a
 * result carrying its own failure.
 */

export interface LedgerResult {
  readonly success: boolean;
  /** For logs and the player-facing message; null on success. */
  readonly error: string | null;
  /** -1 when the operation did not establish one. */
  readonly balance: number;
}

export const LedgerResult = {
  ok: (balance = -1): LedgerResult => ({ success: true, error: null, balance }),
  fail: (error: string): LedgerResult => ({ success: false, error, balance: -1 }),
  /** The one outcome the UI explains rather than apologises for, and not worth retrying. */
  insufficientFunds: (balance: number): LedgerResult => ({ success: false, error: 'Not enough chips.', balance }),
};

/**
 * Everything the authoritative server is allowed to do to a player's chips (IChipLedger).
 *
 * NEAR stakes: a NEAR money ledger plugs in here (buy-in = escrow deposit, checkpoint = the escrow's view of the
 * stack, cash-out = escrow withdrawal), next to a PokerServerGame HandGate that opens and settles each hand in the
 * escrow. Such tables must run with deck commitments on (PokerServerGameOptions.deckCommitments, implied by a
 * handGate): the escrow records each hand's commitment before the deal and can check the seed reveal
 * (SettledHand.deck, verifyDeck in @nomad/engine/cards/deckCommitment) before paying out. Not built yet.
 */
export interface ChipLedger {
  /** The PlayFabId behind a session ticket, or null when it does not check out (or has expired). */
  authenticateAsync(sessionTicket: string): Promise<string | null>;
  /** Takes the buy-in and records the player as seated (lock first, then currency). */
  debitBuyInAsync(playFabId: string, tableId: string, seat: number, chips: number): Promise<LedgerResult>;
  /** Records the stack in front of the player (a set, not a delta; writes no currency). */
  checkpointAsync(playFabId: string, tableId: string, seat: number, stack: number, handNumber: number): Promise<LedgerResult>;
  /** Returns the stack and releases the lock — only for a lock held for THIS table. */
  creditCashOutAsync(playFabId: string, tableId: string, chips: number): Promise<LedgerResult>;
  /** Resolves a crash-left lock: "seated" pays the recorded stack back, anything else pays nothing. */
  reconcileAsync(playFabId: string): Promise<LedgerResult>;
  /** Chips outside play (daily spin, login rewards…), once per idempotency key. */
  grantAsync(playFabId: string, chips: number, reason: string, idempotencyKey: string): Promise<LedgerResult>;
  /** The player's balance, or -1 if it could not be read. */
  getBalanceAsync(playFabId: string): Promise<number>;
}
