/**
 * 'private-host': Per/Unity/PerHostPanel.cs — "Host a table" over the private-tables lobby. Stake level, seats,
 * invite-only with invitees and an invite link; one wallet transaction creates the table and hands it to the rollup,
 * the play key opens it and sets its private invite list, then the host is seated (navigates to the table).
 * Params: { onDone?: () => void } (the lobby's refresh, called on close).
 */
import { PublicKey } from '@solana/web3.js';
import type { AppContext } from '../../app/app';
import { PerTableAddresses } from '../per/addresses';
import type { PerRuntime } from '../per/service';
import type { TableParams } from '../per/types';
import { joinAndGo } from './lobby';
import { closeScreen, type PanelFactory, type PanelImpl } from './lazy';
import { ask, box, button, column, errMsg, line, logStatus, PerCanvas, PerColor, text, type PerButton, type PerText } from './perUi';
import { w3 } from '../services';

export interface HostParams {
  onDone?: () => void;
}

class HostPanel implements PanelImpl {
  private readonly canvas: PerCanvas;
  private stake = 0;
  private seats = 6;
  private inviteOnly = false;
  private busy = false;
  private alive = true;
  private readonly invitees: PublicKey[] = [];
  private status!: PerText;
  private invitesText!: PerText;
  private readonly stakeButtons: PerButton[] = [];
  private readonly seatButtons: PerButton[] = [];
  private inviteButton!: PerButton;

  constructor(
    private readonly ctx: AppContext,
    private readonly per: PerRuntime,
    private readonly root: HTMLElement,
    private readonly params: HostParams,
  ) {
    this.canvas = new PerCanvas(root, 'PerHost');
    this.build(this.canvas.root);
  }

  private build(root: HTMLElement): void {
    const H = this.per.host;
    box(root, 'Dim', PerColor.Dim, [0, 0], [1, 1]);
    const panel = box(root, 'Panel', PerColor.Panel, [0.25, 0.12], [0.75, 0.88]);
    const col = column(panel, 'Column', [0, 0], [1, 1]);
    text(col, '<b>Host a table</b>', 38);
    text(col, 'You pay about 0.03 SOL to open it; about 0.013 SOL comes back when you close it and reclaim the rent. A table left empty for 6 hours is closed automatically. The 5% buy-in rake goes to the game, as on every table. Invite-only tables get an invite link (Your tables); you can also invite wallets by address.', 21).color = [1, 1, 1, 0.7];

    text(col, 'Blinds (buy-in 10 to 100 big blinds)', 24);
    const stakes = line(col, 64, PerColor.Clear);
    H.STAKES.forEach((s, k) => this.stakeButtons.push(button(stakes, s.label, () => ((this.stake = k), this.paint()), PerColor.Muted, 280)));
    text(col, 'Seats', 24);
    const seats = line(col, 64, PerColor.Clear);
    for (let n = H.MIN_SEATS; n <= H.MAX_SEATS; n++) {
      const k = n;
      this.seatButtons.push(button(seats, String(n), () => ((this.seats = k), this.paint()), PerColor.Muted, 90));
    }
    const inv = line(col, 64, PerColor.Clear);
    this.inviteButton = button(inv, 'Invite-only', () => ((this.inviteOnly = !this.inviteOnly), this.paint()), PerColor.Muted, 220);
    button(inv, 'Invitees…', () => this.editInvitees(), PerColor.Muted, 200);
    this.invitesText = text(inv, '', 21);

    this.status = text(col, '', 22);
    const bottom = line(col, 64, PerColor.Clear);
    text(bottom, '', 20);
    button(bottom, 'Cancel', () => this.close(), PerColor.Muted, 180);
    button(bottom, 'Create table', () => void this.create(), PerColor.Accent, 240);
    this.paint();
  }

  private paint(): void {
    this.stakeButtons.forEach((b, i) => (b.color = i === this.stake ? PerColor.Accent : PerColor.Muted));
    this.seatButtons.forEach((b, i) => (b.color = this.per.host.MIN_SEATS + i === this.seats ? PerColor.Accent : PerColor.Muted));
    this.inviteButton.color = this.inviteOnly ? PerColor.Accent : PerColor.Muted;
    this.invitesText.text = !this.inviteOnly ? 'Anyone can join' : this.invitees.length === 0 ? 'You + whoever has the link' : `You + ${this.invitees.length} wallets + the link`;
  }

  /** Invitees' addresses from the browser's prompt (comma / space / newline separated); invalid ones are reported. */
  private editInvitees(): void {
    const current = this.invitees.map((k) => k.toBase58()).join(', ');
    const maxInvites = this.per.host.MAX_INVITES;
    const input = ask(`Wallet addresses to invite (up to ${maxInvites - 1} besides you), separated by commas or spaces. Players can copy theirs from the Private tables screen.`, current);
    if (input === null || input === '\u0001') return; // cancelled: keep the list
    this.invitees.length = 0;
    let bad = 0;
    for (const raw of input.split(/[,\s;]+/).filter((s) => s.length > 0)) {
      try {
        const k = new PublicKey(raw.trim());
        if (!PublicKey.isOnCurve(k.toBytes()) || this.invitees.some((x) => x.equals(k))) {
          bad++;
          continue;
        }
        if (this.invitees.length < maxInvites - 1) this.invitees.push(k);
        else bad++;
      } catch {
        bad++;
      }
    }
    if (this.invitees.length > 0) this.inviteOnly = true;
    this.setStatus(bad > 0 ? `${bad} entr${bad === 1 ? "y wasn't a" : "ies weren't"} wallet address${bad === 1 ? '' : 'es'} and ${bad === 1 ? 'was' : 'were'} skipped.` : '');
    this.paint();
  }

  private async create(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await hostSolTable(this.ctx, this.per, { stake: this.stake, seats: this.seats, inviteOnly: this.inviteOnly, invitees: this.invitees }, (s) => this.setStatus(s));
    } catch (e) {
      this.setStatus("Couldn't host: " + errMsg(e));
      console.error(e);
    } finally {
      this.busy = false;
    }
  }

  private setStatus(s: string): void {
    if (this.alive) this.status.text = s;
    logStatus('PerHost', s);
  }

  private close(): void {
    this.params.onDone?.();
    closeScreen(this.ctx, this.root);
  }

  unmount(): void {
    this.alive = false;
    this.canvas.dispose();
  }
}

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
  st('Opening the table in the private rollup (no wallet prompt)…');
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
  if (last) throw new Error("the table was created but couldn't be opened yet; use Open in Your tables (" + errMsg(last) + ')');
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

export const hostPanel: PanelFactory<HostParams> = (ctx, per, root, params) => new HostPanel(ctx, per, root, params);
