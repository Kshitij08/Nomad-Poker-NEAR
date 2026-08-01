import { beginRound, settleRound, type BeginRoundRequest, type SettlementRequest } from "./settlement.js";

/**
 * Game-server hand lifecycle. Poker betting stays off-chain; the authoritative
 * game server calls these before/after each hand with chip deltas from the engine.
 */
export async function startHand(request: BeginRoundRequest): Promise<string> {
  return beginRound(request);
}

export async function endHand(request: SettlementRequest): Promise<string> {
  return settleRound(request);
}

export type HandDelta = SettlementRequest["deltas"][number];

/**
 * Build a zero-sum settlement payload from engine chip changes.
 * `chipChanges` maps player pubkey → signed chip delta (winner positive, losers negative).
 */
export function buildSettlementRequest(params: {
  tableId: number[];
  tablePda: string;
  vaultPda: string;
  nonce: number;
  chipsInPlay: number;
  potChips?: number;
  chipChanges: Record<string, { chipDelta: number; seatPda: string }>;
}): SettlementRequest {
  const deltas = Object.entries(params.chipChanges).map(([player, value]) => ({
    player,
    chipDelta: value.chipDelta,
    seatPda: value.seatPda,
  }));

  return {
    tableId: params.tableId,
    tablePda: params.tablePda,
    vaultPda: params.vaultPda,
    nonce: params.nonce,
    potChips: params.potChips,
    chipsInPlay: params.chipsInPlay,
    deltas,
  };
}
