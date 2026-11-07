/**
 * 'private-tables': Per/Unity/PerLobbyPanel.cs — the private-tables lobby (tables listed by the private-tables
 * backend, each joinable from the player's game balance), built on ui/perUi.ts exactly as the C# builds it on PerUi.
 * Loaded lazily (it needs @solana/web3.js); opens 'private-host' (PerHostPanel), 'private-tourneys'
 * (PerTourneyPanel) and 'private-agent' (PerAgentPanel). Joining navigates to the table screen.
 *
 * Statics map: PerWallet.Address → per.gameWallet.address, PerWallet.ConnectAsync → solana.connect(),
 * PerGameWallet/PerEntry/PerWithdrawal/PerInvites/PerHostedTables/PerHost/PerBuyIn → the PerRuntime members.
 * A backend that isn't configured throws a clear Error from the service: it's shown as the status line.
 */
import { PublicKey } from '@solana/web3.js';
import type { AppContext } from '../../app/app';
import { PerTableAddresses, perConfigAddress } from '../per/addresses';
import { Hosted, type Stakes } from '../per/entry';
import { PER_MIN_BUY_IN } from '../per/money';
import type { PerRuntime } from '../per/service';
import { decode } from '../per/types';
import { WithdrawalPhase } from '../per/withdrawal';
import type { Status } from '../per/gameWallet';
import type { PanelFactory, PanelImpl } from './lazy';
import { closeScreen } from './lazy';
import { box, button, clear, column, copyText, errMsg, line, logStatus, PerCanvas, PerColor, short, text, type PerButton, type PerText } from './perUi';
import { w3 } from '../services';

/** JSON numbers from the backend may arrive as numbers or strings (u64s); (ulong)t["x"] in the C#. */
export const u64 = (v: unknown): bigint => {
  try {
    return typeof v === 'bigint' ? v : BigInt(typeof v === 'number' ? Math.trunc(v) : String(v ?? '0').trim() || '0');
  } catch {
    return 0n;
  }
};
const int = (v: unknown): number => Number(v ?? 0) | 0;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** Hosted tables read as gone once; a second read in a later refresh forgets them. */
const goneOnce = new Set<string>();
let openLobby: LobbyPanel | null = null;

// ---- PerEntry's hosted-table helpers (Per/Unity/PerEntry.cs) the TS PerEntry leaves to the UI

/** PerEntry.NewInviteLink: a new link code for the table's private list (play key, no wallet prompt). */
export async function newInviteLink(per: PerRuntime, table: PublicKey, status: Status): Promise<void> {
  const key = await per.gameWallet.playKey(status);
  const code = per.host.newInviteCode();
  status('Making a new invite link (no wallet prompt)…');
  for (const ix of per.host.setInvitesKeyedSteps(new PerTableAddresses(table), key, null, per.host.inviteCodeHash(table, code)))
    await per.gameWallet.sendAsKey(key, ix);
  per.invites.setHostCode(table, code);
}

/** PerEntry.CloseHosted: closes an empty hosted table with the host's play key (no wallet transaction). */
export async function closeHosted(per: PerRuntime, table: PublicKey, status: Status): Promise<void> {
  const key = await per.gameWallet.playKey(status);
  const config = decode.config(await per.gameWallet.l1.getAccount(perConfigAddress(), 'confirmed'));
  if (!config) throw new Error("couldn't read the program's config");
  status('Closing the table (no wallet prompt)…');
  const hasVault = await per.gameWallet.hasVault(key, key.wallet);
  await per.gameWallet.sendAsKey(key, per.host.closeKeyed(new PerTableAddresses(table), key, new PublicKey(config.devWallet), hasVault));
  status("Closed. Its rent can be reclaimed in a minute, once it's back on Solana.");
}

/** PerEntry.OpenHosted: opens a table handed to the rollup but not opened yet (harmless if it's open already). */
export async function openHosted(per: PerRuntime, table: PublicKey, status: Status): Promise<void> {
  const key = await per.gameWallet.playKey(status);
  status('Opening the table (no wallet prompt)…');
  await per.gameWallet.sendAsKey(key, per.host.open(new PerTableAddresses(table), key.key.publicKey));
  status('Open. It appears in the lobby within a minute.');
}

/** PerEntry.Join + the table scene: seat, then navigate. True once the table is opening. */
export async function joinAndGo(ctx: AppContext, per: PerRuntime, table: string | PublicKey, buyIn: bigint, status: Status, expect?: Stakes | null): Promise<boolean> {
  const params = await per.join(table, buyIn, status, expect);
  if (!params) return false;
  await ctx.router.navigate('table', params);
  return true;
}

class LobbyPanel implements PanelImpl {
  private readonly canvas: PerCanvas;
  private refreshGen = 0;
  private status!: PerText;
  private wallet!: PerText;
  private balance!: PerText;
  private readonly buyInButtons: PerButton[] = [];
  private list!: HTMLElement;
  private busy = false;
  private alive = true;

  constructor(
    private readonly ctx: AppContext,
    private readonly per: PerRuntime,
    private readonly root: HTMLElement,
  ) {
    openLobby = this;
    this.canvas = new PerCanvas(root, 'PerLobby');
    this.build(this.canvas.root);
    void this.refresh();
  }

  private get solana() {
    return w3(this.ctx).solana;
  }

  private build(root: HTMLElement): void {
    box(root, 'Dim', PerColor.Dim, [0, 0], [1, 1]);
    const panel = box(root, 'Panel', PerColor.Panel, [0.18, 0.1], [0.82, 0.9]);
    const col = column(panel, 'Column', [0, 0], [1, 1]);
    text(col, '<b>Private tables</b>  <size=60%>MagicBlock TEE rollup · devnet</size>', 40);
    text(col, 'Your cards are readable only by your own table key. Every hand can be verified when it ends.', 22).color = [1, 1, 1, 0.7];
    const walletRow = line(col, 64, PerColor.Row);
    this.wallet = text(walletRow, '', 24);
    button(walletRow, 'Connect wallet', () => void this.connectWallet(), PerColor.Accent, 240);
    // M9b: an invited player sends this address to the host.
    button(walletRow, 'Copy my wallet', () => this.copyWallet(), PerColor.Muted, 220);
    button(walletRow, 'Host a table', () => void this.host(), PerColor.Accent, 220);
    // M11: on-chain tournaments.
    button(walletRow, 'Tournaments', () => void this.ctx.router.push('private-tourneys'), PerColor.Accent, 220);
    // M12: an Agent plays private SOL tables for you.
    button(walletRow, 'Agent', () => void this.ctx.router.push('private-agent'), PerColor.Accent, 160);
    button(walletRow, 'Refresh', () => void this.refresh(), PerColor.Muted, 160);
    // M9: the game balance (a vault in the rollup). Deposits and withdrawals are the only wallet transactions.
    const balanceRow = line(col, 64, PerColor.Row);
    this.balance = text(balanceRow, '', 24);
    button(balanceRow, 'Deposit 0.01', () => void this.deposit(10_000_000n), PerColor.Accent, 190);
    button(balanceRow, 'Deposit 0.05', () => void this.deposit(50_000_000n), PerColor.Accent, 190);
    button(balanceRow, 'Withdraw all', () => void this.withdrawAll(), PerColor.Muted, 200);
    // M10: a lost or shared browser: cancel every play key this wallet authorized, everywhere.
    button(balanceRow, 'Cancel play keys', () => void this.revokeKeys(), PerColor.Muted, 230);
    // The buy-in for Join (and for the host's own seat on a new table): each table keeps it inside its limits.
    const buyInRow = line(col, 56, PerColor.Clear);
    text(buyInRow, 'Buy-in:', 24, 'Left', 0.4);
    this.per.buyIn.labels.forEach((l, k) => {
      this.buyInButtons.push(button(buyInRow, l, () => {
        this.per.buyIn.choice = k;
        this.paintBuyIn();
        void this.refresh();
      }, PerColor.Muted, 150));
    });
    this.paintBuyIn();
    // Above the list: a long list would push it out of the panel.
    this.status = text(col, '', 22);
    this.list = column(col, 'Tables', [0, 0], [1, 1], 8, 0);
    const bottom = line(col, 64, PerColor.Clear);
    text(bottom, '', 20);
    button(bottom, 'Close', () => this.close(), PerColor.Muted, 180);
  }

  private paintBuyIn(): void {
    this.buyInButtons.forEach((b, i) => (b.color = i === this.per.buyIn.choice ? PerColor.Accent : PerColor.Muted));
  }

  private async connectWallet(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    let connected = false;
    try {
      connected = await this.solana.connect();
      this.setStatus(connected ? '' : 'No wallet connected.');
    } catch (e) {
      this.setStatus(errMsg(e));
    } finally {
      this.busy = false;
      await this.refresh();
    }
    // M10: right after connecting, show the game balance (may ask the wallet to sign the play-key message once).
    if (connected && this.alive) await this.showBalance(true);
  }

  private async deposit(lamports: bigint): Promise<void> {
    if (this.busy) return;
    if (!(await this.ensureWallet())) return;
    this.busy = true;
    try {
      await this.per.deposit(lamports, (s) => this.setStatus(s));
      await this.per.http.delay(6000);
    } catch (e) {
      this.setStatus('Deposit failed: ' + errMsg(e));
      console.error(e);
    } finally {
      this.busy = false;
      await this.showBalance(true);
    }
  }

  private async withdrawAll(): Promise<void> {
    if (this.busy) return;
    if (!(await this.ensureWallet())) return;
    this.busy = true;
    const w = this.per.withdrawal;
    const st = (s: string) => this.setStatus(s);
    // The same background withdrawal as the Nomad menu's: one in progress is finished (or waited for), never sent twice.
    try {
      if (w.current === WithdrawalPhase.Ready) await w.finish(st);
      else if (w.current === WithdrawalPhase.OnTheWay) this.setStatus(`${this.per.format.sol(w.amount)} is on its way to Solana; tap Withdraw all again once it has arrived.`);
      else if ((await w.start(st)) > 0n) this.setStatus(`${this.per.format.sol(w.amount)} is on its way to Solana (about a minute); tap Withdraw all again to receive it.`);
      else if ((w.current as WithdrawalPhase) === WithdrawalPhase.Ready) await w.finish(st);
    } catch (e) {
      this.setStatus('Withdrawal failed: ' + errMsg(e));
      console.error(e);
    } finally {
      this.busy = false;
      await this.showBalance(true);
    }
  }

  private async revokeKeys(): Promise<void> {
    if (this.busy) return;
    if (!(await this.ensureWallet())) return;
    this.busy = true;
    try {
      await this.per.gameWallet.revokePlayKeys((s) => this.setStatus(s));
    } catch (e) {
      this.setStatus("Couldn't cancel the play keys: " + errMsg(e));
      console.error(e);
    } finally {
      this.busy = false;
      await this.showBalance(false);
    }
  }

  private async ensureWallet(): Promise<boolean> {
    if (this.solana.isConnected) return true;
    await this.connectWallet();
    return this.solana.isConnected;
  }

  /** The game balance. Without a play key on this browser yet, reading it would ask the wallet to sign, so that waits for a click (`ask`). */
  private async showBalance(ask: boolean): Promise<void> {
    const w = this.per.gameWallet.address;
    if (!this.alive) return;
    if (!w) {
      this.balance.text = 'Game balance: connect a wallet';
      return;
    }
    if (!ask && !this.per.gameWallet.hasPlayKey(w)) {
      this.balance.text = 'Game balance: <u>tap Deposit or Join to set up</u>';
      return;
    }
    this.balance.text = 'Game balance: …';
    try {
      const b = await this.per.balance((s) => this.setStatus(s));
      if (this.alive) this.balance.text = b === null ? 'Game balance: not opened yet (Deposit opens it)' : `Game balance: <b>${this.per.format.sol(b)}</b>`;
    } catch (e) {
      if (this.alive) this.balance.text = 'Game balance: couldn\'t read (' + errMsg(e) + ')';
    }
  }

  async refresh(): Promise<void> {
    if (!this.alive) return;
    const w = this.per.gameWallet.address;
    this.wallet.text = w === null ? 'Not connected' : short(w.toBase58());
    void this.showBalance(false);
    clear(this.list);
    text(this.list, 'Loading tables…', 22);
    const gen = ++this.refreshGen;
    let tables: Record<string, unknown>[] = [];
    let mine: Record<string, unknown>[] = [];
    let failed: string | null = null;
    try {
      tables = await this.per.listTables();
      mine = w ? await this.per.listTables(w.toBase58()) : [];
    } catch (e) {
      failed = errMsg(e);
    }
    if (!this.alive || gen !== this.refreshGen) return;
    const hostedRows = failed ? [] : await this.loadHosted(w, tables, mine);
    // Only the newest refresh draws, all at once after every read.
    if (!this.alive || gen !== this.refreshGen) return;
    clear(this.list);
    if (failed) this.setStatus(failed);
    if (hostedRows.length > 0) {
      text(this.list, '<b>Your tables</b>', 24);
      for (const draw of hostedRows) draw();
      text(this.list, '<b>Tables</b>', 24);
    }
    const linked = this.per.invites.linkedTable;
    if (linked && !failed && !tables.some((x) => str(x.address) === linked.toBase58()))
      this.setStatus(`The table in your invite link (${short(linked.toBase58())}) isn't open right now.`);
    let shown = 0;
    for (const t of tables) {
      // This client draws its seats and buys in a fixed amount: list only tables it can play.
      if (int(t.maxSeats) > 8) continue;
      const min = u64(t.minBuyIn), max = u64(t.maxBuyIn);
      if ((min > PER_MIN_BUY_IN ? min : PER_MIN_BUY_IN) > max) continue;
      const address = str(t.address);
      // Invite-only tables (M9c): they show to everyone and the buy-in decides. A link this browser opened is noted.
      const invite = t.inviteOnly === true;
      const mineTable = w !== null && w.toBase58() === str(t.creator);
      let haveLink = false;
      try {
        haveLink = invite && !mineTable && this.per.invites.joinCode(new PublicKey(address)) !== null;
      } catch {
        haveLink = false;
      }
      const row = line(this.list, 70, PerColor.Row);
      const sb = u64(t.smallBlind), bb = u64(t.bigBlind);
      const buyIn = this.per.buyIn.for(min, max, bb);
      const sol = this.per.format.sol;
      const tag = invite ? (mineTable ? '<color=#e0c27e>Invite-only · yours</color>   ·   ' : haveLink ? '<color=#5ed39b>Invited (link)</color>   ·   ' : '<color=#e0c27e>Invite-only</color>   ·   ') : '';
      text(row, `${tag}Blinds ${sol(sb)} / ${sol(bb)}   ·   ${int(t.seated)}/${int(t.maxSeats)} seated   ·   hand ${str(t.handNo)}   ·   ${short(address)}`, 24);
      // An invite-only table without a link here: joining works only if the host added this wallet.
      const joinLabel = invite && !haveLink && !mineTable ? 'Join if invited' : 'Join';
      button(row, `${joinLabel}  ${sol(buyIn)}`, () => void this.join(address, buyIn, { smallBlind: sb, bigBlind: bb, minBuyIn: min, maxBuyIn: max }), PerColor.Accent, 300);
      shown++;
    }
    if (shown === 0) text(this.list, 'No private tables are open right now.', 22);
  }

  // ---- M9b: hosting

  private copyWallet(): void {
    const w = this.solana.address;
    if (!w) return this.setStatus('Connect a wallet first.');
    copyText(w);
    this.setStatus('Your wallet address is copied. Send it to a host to get invited.');
  }

  private async host(): Promise<void> {
    if (this.busy) return;
    if (!(await this.ensureWallet())) return;
    void this.ctx.router.push('private-host', { onDone: () => this.alive && void this.refresh() });
  }

  /** "Your tables": hosted from this browser and (M9c) listed by the backend. Reads everything, returns the rows. */
  private async loadHosted(w: PublicKey | null, live: Record<string, unknown>[], mine: Record<string, unknown>[]): Promise<(() => void)[]> {
    const rows: (() => void)[] = [];
    if (!w) return rows;
    const per = this.per;
    const hosted = per.hostedTables.for(w);
    for (const m of mine.slice(0, 50)) {
      const idStr = str(m.tableId);
      if (!/^\d+$/.test(idStr)) continue;
      const mid = BigInt(idStr);
      let mk: PublicKey;
      try {
        mk = new PublicKey(str(m.address));
      } catch {
        continue;
      }
      // Only addresses this wallet's id really derives to (the backend is a hint, not an authority).
      if (!per.host.tableAddress(w, mid).equals(mk) || hosted.some((x) => x.table.equals(mk)) || per.hostedTables.isGone(w, mk)) continue;
      hosted.push({ table: mk, id: mid });
      per.hostedTables.add(w, mk, mid);
    }
    const sol = per.format.sol;
    for (const { table, id } of hosted) {
      const key = table.toBase58();
      const row = live.find((x) => str(x.address) === key) ?? null;
      let state: Hosted;
      let oldList: boolean;
      let openLimits: { min: bigint; max: bigint; bigBlind: bigint } | null = null;
      try {
        state = await per.entry.hostedState(table);
        // A table hosted before M9c may have a Solana invite list (no invite links there; its rent comes back).
        oldList = (state === Hosted.Gone || (row !== null && row.inviteOnly === true)) && (await per.gameWallet.l1.getAccount(per.host.invitesAddress(table), 'confirmed')) !== null;
        // Not in the lobby list yet: ask the rollup (the list lags new tables by up to a minute).
        if (state === Hosted.Open && row === null) openLimits = await per.entry.openInRollup(table);
      } catch (e) {
        console.warn(`[PerLobby] ${key}: ${errMsg(e)}`);
        continue; // one bad read doesn't empty the lobby
      }
      if (!this.alive) return rows;
      if (state === Hosted.Gone) {
        if (oldList) {
          rows.push(() => {
            const l = line(this.list, 70, PerColor.Row);
            text(l, `Reclaimed · its invite list still holds rent   ·   ${short(key)}`, 24);
            button(l, 'Reclaim list rent', () => void this.closeOldInvites(id), PerColor.Accent, 260);
          });
          continue;
        }
        // Gone twice in a row: forget it (one read can lag; M9c review).
        if (goneOnce.has(key)) per.hostedTables.markGone(w, table);
        else goneOnce.add(key);
        continue;
      }
      goneOnce.delete(key);
      const st = state;
      rows.push(() => {
        const l = line(this.list, 70, PerColor.Row);
        // Solana first: the lobby (the backend) can list a table for a minute after it closed.
        if (st === Hosted.Closed) {
          text(l, `Closed   ·   ${short(key)}`, 24);
          button(l, 'Reclaim rent', () => void this.reclaim(table, id), PerColor.Accent, 220);
        } else if (row !== null) {
          const seated = int(row.seated);
          text(l, `Open   ·   ${seated}/${int(row.maxSeats)} seated   ·   ${short(key)}`, 24);
          // Invite links need the private list (M9c); a table hosted before keeps its Solana list.
          if (row.inviteOnly === true && !oldList) {
            if (per.invites.hostCode(table) !== null) button(l, 'Copy invite link', () => this.copyInviteLink(table), PerColor.Accent, 240);
            button(l, 'New link', () => void this.newInviteLink(table), PerColor.Muted, 160);
          }
          const b = button(l, 'Close table', () => void this.closeHosted(table), seated === 0 ? PerColor.Warn : PerColor.Muted, 220);
          b.interactable = seated === 0;
        } else if (st === Hosted.Open && openLimits) {
          // Open, but the lobby list hasn't caught up: join from here.
          const buyIn = per.buyIn.for(openLimits.min, openLimits.max, openLimits.bigBlind);
          text(l, `Open   ·   ${short(key)}   ·   in the lobby list within a minute`, 24);
          button(l, `Join  ${sol(buyIn)}`, () => void this.join(key, buyIn), PerColor.Accent, 240);
        } else if (st === Hosted.Open) {
          // Handed to the rollup but not in the lobby: not opened yet (or the lobby lags). Opening is harmless.
          text(l, `Not open yet   ·   ${short(key)}`, 24);
          button(l, 'Open', () => void this.openHosted(table), PerColor.Accent, 160);
        } else text(l, `${st === Hosted.Closing ? 'Closing…' : 'Opening…'}   ·   ${short(key)}`, 24);
      });
    }
    return rows;
  }

  /** Copies the link this browser made for the table (inside the click, so the browser allows it). */
  private copyInviteLink(table: PublicKey): void {
    const code = this.per.invites.hostCode(table);
    if (!code) return;
    copyText(this.per.invites.link(table, code));
    this.setStatus('Invite link copied. Anyone who opens it can join. (A link made since on another device replaces it: then use New link.)');
  }

  private async closeOldInvites(id: bigint): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.setStatus('Approve closing the old invite list in your wallet (its rent comes back)…');
      const gw = this.per.gameWallet;
      await gw.l1.sendWithWallet([this.per.host.closeInvites(gw.address!, id)], gw.signer);
      this.setStatus('Invite list closed; its rent is back in your wallet.');
    } catch (e) {
      this.setStatus("Couldn't close it: " + errMsg(e));
      console.error(e);
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  private async guarded(fail: string, fn: (status: Status) => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await fn((s) => this.setStatus(s));
    } catch (e) {
      this.setStatus(fail + errMsg(e));
      console.error(e);
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  private newInviteLink(table: PublicKey): Promise<void> {
    return this.guarded("Couldn't make a link: ", async (st) => {
      await newInviteLink(this.per, table, st);
      this.setStatus('New invite link ready (older links no longer work). Click Copy invite link.');
    });
  }

  private openHosted(table: PublicKey): Promise<void> {
    return this.guarded("Couldn't open: ", (st) => openHosted(this.per, table, st));
  }

  private closeHosted(table: PublicKey): Promise<void> {
    return this.guarded("Couldn't close: ", (st) => closeHosted(this.per, table, st));
  }

  private reclaim(table: PublicKey, id: bigint): Promise<void> {
    return this.guarded("Couldn't reclaim: ", async (st) => {
      st("Approve reclaiming the table's rent in your wallet…");
      const gw = this.per.gameWallet;
      const wallet = gw.address!;
      const ixs = [this.per.host.reclaim(wallet, id)];
      // M9c: a table hosted before keeps an L1 invite list; its rent comes back too.
      if ((await gw.l1.getAccount(this.per.host.invitesAddress(table), 'confirmed')) !== null) ixs.push(this.per.host.closeInvites(wallet, id));
      await gw.l1.sendWithWallet(ixs, gw.signer);
      this.per.hostedTables.markGone(wallet, table);
      st('Rent reclaimed.');
    });
  }

  private async join(table: string, buyIn: bigint, shown: Stakes | null = null): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await joinAndGo(this.ctx, this.per, table, buyIn, (s) => this.setStatus(s), shown);
    } catch (e) {
      this.setStatus("Couldn't join: " + errMsg(e));
      console.error(e);
    } finally {
      this.busy = false;
    }
  }

  /** Shows a status line and logs it (the console is where a tester can see what happened). */
  private setStatus(s: string): void {
    if (this.alive) this.status.text = s;
    logStatus('PerLobby', s);
  }

  private close(): void {
    closeScreen(this.ctx, this.root);
  }

  unmount(): void {
    this.alive = false;
    if (openLobby === this) openLobby = null;
    this.canvas.dispose();
  }
}

export const lobbyPanel: PanelFactory<Record<string, never>> = (ctx, per, root) => new LobbyPanel(ctx, per, root);

/** Re-reads the open lobby (a sub-panel finished). */
export function refreshLobby(): void {
  void openLobby?.refresh();
}
