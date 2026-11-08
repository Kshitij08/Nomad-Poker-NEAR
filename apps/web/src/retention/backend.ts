import type { LoginClaimResponse, MissionClaimResponse, ProgressSnapshot, SpinResponse } from '@nomad/contract';

/**
 * Where retention lives when a Nomad server is configured: the server decides every reward (it rolls the spin, reads
 * the streak, counts the hands that move missions and XP, pays level-ups). The retention classes read its snapshot
 * instead of PlayerPrefs, and their claim actions call it. Implemented by the account module (NomadProgress).
 */
export interface RetentionBackend {
  /** The last state the server sent, or null before the first load. */
  readonly snapshot: ProgressSnapshot | null;
  /** Each returns null when the server could not be reached (the snapshot is left as it was). */
  spin(): Promise<SpinResponse | null>;
  claimLogin(): Promise<LoginClaimResponse | null>;
  claimMission(id: string): Promise<MissionClaimResponse | null>;
}
