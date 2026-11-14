/**
 * NEAR tournaments on the escrow (near/escrow, README › Escrow): the escrow's tournament id is the Nomad tournament's
 * id. The host's wallet creates it (`create_tournament`, the prize attached) and can cancel it before the start;
 * players' wallets `register` (the entry fee attached; a private one needs its code) and `leave`. Each wallet step is
 * followed by the matching Nomad API call, which checks the escrow and updates the roster. Refunds and prizes go to the
 * player's game balance on the escrow (withdraw from the NEAR tables screen).
 */
import type { TournamentInfo } from '../tournaments/api/tournamentInfo';
import { formatNear } from './backing';
import { CHIP_YOCTO, ESCROW_CONTRACT } from './escrow';
import { nearCall } from './wallet';

export const isNearTournament = (x: Pick<TournamentInfo, 'currency'> | null | undefined): boolean => x?.currency === 'near';

/** Chips (0.001 NEAR) as NEAR text, e.g. 50 → "0.05". */
export const chipsNear = (chips: number): string => formatNear(BigInt(chips) * CHIP_YOCTO);

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The host's wallet puts the tournament (as the API created it) on the escrow, paying the prize. */
export async function escrowCreate(x: TournamentInfo): Promise<void> {
  const prize = BigInt(x.hostPrize) * CHIP_YOCTO;
  await nearCall(ESCROW_CONTRACT, 'create_tournament', {
    tournament_id: x.id,
    name: x.name,
    entry_fee: String(BigInt(x.entryFee) * CHIP_YOCTO),
    max_players: x.maxPlayers,
    starts_at: String(BigInt(x.startsAtUnix) * 10n ** 9n),
    code_hash: x.visibility === 'private' && x.joinCode ? await sha256Hex(x.joinCode) : null,
    prize: String(prize),
  }, prize);
}

/** The player's wallet pays the entry fee to the escrow. */
export async function escrowRegister(x: TournamentInfo): Promise<void> {
  await nearCall(ESCROW_CONTRACT, 'register', { tournament_id: x.id, code: x.visibility === 'private' && x.joinCode ? x.joinCode : null }, BigInt(x.entryFee) * CHIP_YOCTO);
}

/** The player's wallet leaves before the start; the fee goes back to their escrow game balance. */
export async function escrowLeave(id: string): Promise<void> {
  await nearCall(ESCROW_CONTRACT, 'leave', { tournament_id: id });
}

/** The host's wallet cancels before the start, refunding every entry and the prize to game balances. */
export async function escrowCancel(id: string): Promise<void> {
  await nearCall(ESCROW_CONTRACT, 'cancel_tournament', { tournament_id: id });
}

/** Wallet errors that mean the escrow has already done this step (a retry after the API call failed). */
export const alreadyDone = (e: unknown): boolean => /already registered|not registered|tournament id taken|is not open/i.test(String((e as Error)?.message ?? e));
