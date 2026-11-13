/**
 * Hosting a private SOL table (Per/Unity/PerHostPanel.cs): one wallet transaction creates the table and hands it to
 * the rollup, the play key opens it and sets its private invite list, then the host is seated (navigates to the
 * table). The form is the Redesign v2 "Host a SOL table" page (src/ui2/screens/play.ts).
 */
import type { PublicKey } from '@solana/web3.js';
import type { AppContext } from '../../app/app';
import { PerTableAddresses } from '../per/addresses';
import type { PerRuntime } from '../per/service';
import type { TableParams } from '../per/types';
import { joinAndGo } from './lobby';
import { errMsg } from './perUi';
import { w3 } from '../services';

/** Options for hosting a private SOL table (also the Redesign v2 "Host a SOL table" page). */
export interface HostTableOptions {
  /** Stake level (per.host.STAKES index). */
  stake: number;
  seats: number;
  inviteOnly: boolean;
  invitees: PublicKey[];
}

/**
 * Creates the table (one wallet approval), opens it in the rollup, sets the invite list when invite-only, then seats
 * the host. Throws on failure; `st` reports progress.
 */
export async function hostSolTable(ctx: AppContext, per: PerRuntime, o: HostTableOptions, st: (s: string) => void): Promise<void> {
  const H = per.host;
  if (!(await w3(ctx).solana.connect())) throw new Error('Connect a wallet first.');
  const wallet = per.gameWallet.address!;
  // Leftovers at close go to the host's game balance, so a host needs one (M9c).
  await per.gameWallet.ensureVault(st, 'no table was created');
  const key = await per.gameWallet.playKey(st);
  const { label, small, big } = H.STAKES[o.stake]!;
  const p: TableParams = { smallBlind: small, bigBlind: big, minBuyIn: H.minBuyIn(o.stake), maxBuyIn: H.maxBuyIn(o.stake), maxSeats: o.seats, inviteOnly: o.inviteOnly };
  const id = H.newTableId();
  const table = H.tableAddress(wallet, id);
  st(`Approve creating the table (${label}, ${o.seats} seats) in your wallet…`);
  await per.gameWallet.l1.sendWithWallet(H.createAndDelegate(wallet, id, p), per.gameWallet.signer);
  per.hostedTables.add(wallet, table, id);
  st('Opening the table (no wallet prompt)…');
  const t = new PerTableAddresses(table);
  let last: unknown = null;
  for (let i = 0; i < 10; i++) {
    await per.http.delay(3000); // the rollup picks up the handed-over table within seconds
    try {
      await per.gameWallet.sendAsKey(key, H.open(t, key.key.publicKey));
      last = null;
      break;
    } catch (e) {
      last = e;
    }
  }
  if (last) {
    console.warn('[PerHost] open: ' + errMsg(last));
    throw new Error("Your table was created but isn't open yet. Open it from Your tables in a minute.");
  }
  if (o.inviteOnly) {
    // The private list (M9c): the host is always on it, plus an invite link. Play key: no prompt, no rent.
    const list = [wallet];
    for (const k of o.invitees) if (!k.equals(wallet) && list.length < H.MAX_INVITES) list.push(k);
    const code = H.newInviteCode();
    st(`Setting the invite list (${list.length - 1} wallets, plus you) and the invite link (no wallet prompt)…`);
    for (const ix of H.setInvitesKeyedSteps(t, key, list, H.inviteCodeHash(table, code))) {
      // Retried: a table this new can still be settling in the rollup (M9c review).
      for (let i = 0; ; i++) {
        try {
          await per.gameWallet.sendAsKey(key, ix);
          break;
        } catch (e) {
          if (i >= 4) throw e;
          console.warn('[PerHost] invite list: ' + errMsg(e));
          await per.http.delay(3000);
        }
      }
    }
    per.invites.setHostCode(table, code);
  }
  // M10: take the host straight to their table (buy-in from the game balance, the lobby's choice, no prompt).
  const buyIn = per.buyIn.for(p.minBuyIn, p.maxBuyIn, p.bigBlind);
  st(`Table open. Seating you (${per.format.sol(buyIn)} from your game balance, the lobby's buy-in choice; no wallet prompt)…`);
  const shown = { smallBlind: p.smallBlind, bigBlind: p.bigBlind, minBuyIn: p.minBuyIn, maxBuyIn: p.maxBuyIn };
  if (await joinAndGo(ctx, per, table, buyIn, st, shown)) return;
  console.warn("[PerHost] the table is open but the host wasn't seated");
}

