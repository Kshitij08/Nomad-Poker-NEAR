/**
 * The table's chip economy: a port of Net/Economy/ChipTableSession.cs over the economy module's offline ledger
 * (src/economy/server/chipLedger.ts — PlayFabChipLedger's rules over an emulated title), plus the local stand-in for
 * PlayFab session tickets.
 *
 * Unity verifies a PlayFab session ticket at hello and debits the buy-in from the PlayFab balance. Locally there is
 * no PlayFab: the browser keeps its own wallet. So a client presents a *local ticket* — `local:<playerId>:<coins>` —
 * and this server keeps a title of its own in memory: the first hello creates the account, and whenever the player
 * holds no seat anywhere the server adopts the coins the client says it has (it is the browser's wallet that persists
 * between sessions). Every chip that then moves at a table goes through the real ledger protocol (seat lock, buy-in
 * debit, checkpoints, cash-out credit, reconcile) and the new balance is pushed back to the client, exactly as the
 * dedicated server pushes the PlayFab balance. Local only — never expose this server.
 */
import { TitleChipLedger } from '../../src/economy/server/chipLedger';
import { createPlayer, memoryTitle, type TitleStateHandle } from '../../src/economy/server/titleState';
import type { ChipLedger } from '@nomad/table-server/ledger';
import type { LogFn, TableEconomy } from '@nomad/table-server/chipTableSession';

export { LedgerResult, type ChipLedger } from '@nomad/table-server/ledger';
export { ChipTableSession, type ChipStakeTier, type LogFn, type TableEconomy } from '@nomad/table-server/chipTableSession';

/** The server-side title and the local ticket authority every table on this server shares. */
export class LocalEconomy implements TableEconomy {
  readonly title: TitleStateHandle = memoryTitle();
  readonly ledger: ChipLedger;
  /** The balance each player's browser was last told (walletBalance push / hello). */
  private readonly lastSynced = new Map<string, number>();

  /** Record that the client was just told `balance` (the server's sendWalletBalance). */
  noteSynced(playFabId: string, balance: number): void {
    if (playFabId && balance >= 0) this.lastSynced.set(playFabId, balance);
  }

  constructor(log: LogFn) {
    this.ledger = new TitleChipLedger(this.title, { log });
  }

  /**
   * Turns a client's local ticket into a session ticket the ledger can authenticate. Null when malformed.
   * `local:<playerId>:<coins>` — playerId is the client's PlayFab id / guest id; coins its wallet balance.
   */
  adoptTicket(ticket: string): string | null {
    const m = /^local:([A-Za-z0-9_\-.]{1,64}):(-?\d{1,15})$/.exec(ticket ?? '');
    if (!m) return null;
    const id = m[1]!;
    const coins = Math.max(0, Number(m[2]));
    const state = this.title.state;
    let p = state.players[id];
    if (!p) {
      p = createPlayer(state, { id, chips: coins, objects: { ChipGrants: { keys: [], welcomed: true } } });
      this.lastSynced.set(id, coins);
    } else if (!p.objects['SeatLock']) {
      // Not seated anywhere: apply what the browser's wallet did since we last told it its balance (offline grants,
      // spends) — but keep anything this server credited that the browser never heard about (a cash-out after the
      // tab closed). The browser adopts the result at its next buy-in push.
      const last = this.lastSynced.get(id) ?? coins;
      p.chips = Math.max(0, (p.chips ?? 0) + (coins - last));
      this.lastSynced.set(id, p.chips);
    }
    const session = `S-${id}`;
    state.sessions[session] = { playFabId: id, expires: Date.now() + 24 * 3600 * 1000 };
    this.title.save();
    return session;
  }
}
